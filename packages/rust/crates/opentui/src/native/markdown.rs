//! The native Markdown engine (`ot_markdown_*`): a streamed document's blocks, each leaf's parser output, and the scene
//! text nodes it writes.
use super::resource::Resource;
use super::{Context, Node, SyntaxStyle};
use crate::error::{Result, check, count};
use crate::sys;
use std::ops::Range;

/// Options of a [`MarkdownDoc`]: `OT_MD_*` flags and the style its leaves resolve through.
pub(crate) struct MarkdownOptions<'a> {
    pub flags: u32,
    pub style: Option<&'a SyntaxStyle>,
}

impl MarkdownOptions<'_> {
    fn raw(&self) -> sys::ot_markdown_options {
        sys::ot_markdown_options {
            struct_size: std::mem::size_of::<sys::ot_markdown_options>() as u32,
            abi_version: sys::OT_CONTEXT_ABI_VERSION,
            flags: self.flags,
            syntax_style: self.style.map(SyntaxStyle::handle).unwrap_or_default(),
            ..Default::default()
        }
    }
}

/// What a call changed: blocks to read, and the first removed block, if any.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct MarkdownResult {
    pub changed: u32,
    pub committed: u32,
    pub removed_from: Option<u32>,
}

impl MarkdownResult {
    fn from_raw(raw: sys::ot_markdown_result) -> Self {
        Self {
            changed: raw.changed_block_count,
            committed: raw.committed_top_level_count,
            removed_from: (raw.removed_from_index != u32::MAX).then_some(raw.removed_from_index),
        }
    }
}

/// A block as the engine lists it: its preorder index (its id), parent, kind (`OT_MD_*`), flags (`OT_MD_BLOCK_*`),
/// source range, fence info range, and number (heading level, list start, column count or cell column).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MarkdownBlock {
    pub index: u32,
    pub parent: Option<u32>,
    pub kind: u32,
    pub flags: u32,
    pub source: Range<u32>,
    pub info: Range<u32>,
    pub number: u32,
}

impl MarkdownBlock {
    pub fn has(&self, flag: u32) -> bool {
        self.flags & flag != 0
    }
}

/// A leaf's parser output: display bytes, styled chunks resolved through the doc's style with links into `urls`, and
/// one `OT_MD_SPAN_*` word per chunk.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct MarkdownLeaf {
    pub bytes: Vec<u8>,
    pub chunks: Vec<sys::ot_styled_text_chunk>,
    pub spans: Vec<u32>,
    pub urls: Vec<u8>,
}

/// A streamed Markdown document of the native engine.
pub(crate) struct MarkdownDoc(Resource);

impl MarkdownDoc {
    pub fn new(context: &Context, options: &MarkdownOptions<'_>) -> Result<Self> {
        let raw = options.raw();
        let resource = Resource::create(
            context,
            "ot_markdown_create",
            ("ot_markdown_destroy", sys::ot_markdown_destroy),
            |context, handle| unsafe { sys::ot_markdown_create(context, &raw, handle) },
        )?;
        Ok(Self(resource))
    }

    fn call(
        &self,
        operation: &'static str,
        run: impl FnOnce(*mut sys::ot_context, *const sys::ot_handle, &mut sys::ot_markdown_result) -> sys::ot_status,
    ) -> Result<MarkdownResult> {
        let (context, handle) = self.0.raw();
        let mut raw = sys::ot_markdown_result::default();
        check(operation, run(context, handle, &mut raw))?;
        Ok(MarkdownResult::from_raw(raw))
    }

    pub fn set_options(&self, options: &MarkdownOptions<'_>) -> Result<MarkdownResult> {
        let raw = options.raw();
        self.call("ot_markdown_set_options", |context, handle, out| unsafe {
            sys::ot_markdown_set_options(context, handle, &raw, out)
        })
    }

    pub fn append(&self, text: &str) -> Result<MarkdownResult> {
        let length = count("ot_markdown_append", text.len())?;
        self.call("ot_markdown_append", |context, handle, out| unsafe {
            sys::ot_markdown_append(context, handle, text.as_ptr(), length, out)
        })
    }

    pub fn set(&self, text: &str) -> Result<MarkdownResult> {
        let length = count("ot_markdown_set", text.len())?;
        self.call("ot_markdown_set", |context, handle, out| unsafe {
            sys::ot_markdown_set(context, handle, text.as_ptr(), length, out)
        })
    }

    pub fn finish(&self) -> Result<MarkdownResult> {
        self.call("ot_markdown_finish", |context, handle, out| unsafe { sys::ot_markdown_finish(context, handle, out) })
    }

    /// The source, borrowed until the next mutating call on this doc.
    pub fn source(&self) -> Result<&str> {
        let (context, handle) = self.0.raw();
        let (mut bytes, mut length) = (std::ptr::null(), 0u32);
        check("ot_markdown_get_source", unsafe {
            sys::ot_markdown_get_source(context, handle, &mut bytes, &mut length)
        })?;
        if length == 0 {
            return Ok("");
        }
        // Appends and replaces take valid UTF-8 only; the bytes live until the next mutating call, which needs `&self`
        // of a caller that cannot hold this borrow (the widget's borrow guard).
        Ok(unsafe { std::str::from_utf8_unchecked(std::slice::from_raw_parts(bytes, length as usize)) })
    }

    /// The blocks changed since the last read, in document order (acknowledged).
    pub fn read_changes(&self) -> Result<Vec<MarkdownBlock>> {
        let (context, handle) = self.0.raw();
        let mut length = 0;
        check("ot_markdown_read_changes", unsafe {
            sys::ot_markdown_read_changes(context, handle, std::ptr::null_mut(), 0, &mut length)
        })?;
        if length == 0 {
            return Ok(Vec::new());
        }
        let mut blocks = vec![sys::ot_markdown_block::default(); length as usize];
        check("ot_markdown_read_changes", unsafe {
            sys::ot_markdown_read_changes(context, handle, blocks.as_mut_ptr(), length, &mut length)
        })?;
        Ok(blocks
            .iter()
            .map(|raw| MarkdownBlock {
                index: raw.index,
                parent: (raw.parent_index != u32::MAX).then_some(raw.parent_index),
                kind: u32::from(raw.kind),
                flags: u32::from(raw.flags),
                source: raw.source_start_byte..raw.source_end_byte,
                info: raw.info_start_byte..raw.info_end_byte,
                number: raw.number,
            })
            .collect())
    }

    /// Leaf `index`'s parser output (never a host's).
    pub fn read_leaf(&self, index: u32) -> Result<MarkdownLeaf> {
        const OPERATION: &str = "ot_markdown_read_leaf";
        let (context, handle) = self.0.raw();
        let (mut bytes, mut chunks, mut urls) = (0, 0, 0);
        check(OPERATION, unsafe {
            sys::ot_markdown_read_leaf(
                context,
                handle,
                index,
                std::ptr::null_mut(),
                0,
                &mut bytes,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
                &mut chunks,
                std::ptr::null_mut(),
                0,
                &mut urls,
            )
        })?;
        let mut leaf = MarkdownLeaf {
            bytes: vec![0; bytes as usize],
            chunks: vec![sys::ot_styled_text_chunk::default(); chunks as usize],
            spans: vec![0; chunks as usize],
            urls: vec![0; urls as usize],
        };
        if bytes + chunks + urls > 0 {
            check(OPERATION, unsafe {
                sys::ot_markdown_read_leaf(
                    context,
                    handle,
                    index,
                    leaf.bytes.as_mut_ptr(),
                    bytes,
                    &mut bytes,
                    leaf.chunks.as_mut_ptr(),
                    leaf.spans.as_mut_ptr(),
                    chunks,
                    &mut chunks,
                    leaf.urls.as_mut_ptr(),
                    urls,
                    &mut urls,
                )
            })?;
        }
        Ok(leaf)
    }

    /// Inline leaf `index`'s source, without container markers.
    pub fn read_source(&self, index: u32) -> Result<String> {
        let (context, handle) = self.0.raw();
        super::resource::read_string("ot_markdown_read_source", |bytes, capacity, length| unsafe {
            sys::ot_markdown_read_source(context, handle, index, bytes, capacity, length)
        })
    }

    /// Binds a scene text node to paragraph or heading `index`: it draws with the doc's style, and the doc writes it
    /// while the leaf is its to write.
    pub fn bind(&self, index: u32, node: &Node) -> Result<()> {
        let (context, handle) = self.0.raw();
        check("ot_markdown_bind", unsafe { sys::ot_markdown_bind(context, handle, index, &node.handle()) })
    }
}
