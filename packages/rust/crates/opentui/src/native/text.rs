use super::editor::{EditorInfo, LayerRun, SyntaxStyle, Viewport};
use super::resource::{Resource, read_string};
use super::{Context, Node, WidthMethod, WrapMode};
use crate::error::{Result, check, count};
use crate::style::{EncodedSpans, Span, Style};
use crate::sys;
use std::cell::RefCell;
use std::rc::Rc;

/// Text buffer counts. Widths count display columns.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TextBufferInfo {
    pub content_epoch: u64,
    pub byte_count: u32,
    /// Sum of unwrapped line widths, excluding line separators.
    pub width_total: u32,
    pub line_count: u32,
    pub tab_width: u32,
}

/// One wrapped line of a text view.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VisualLine {
    pub start_column: u32,
    pub width: u32,
    /// The zero-based logical line this row belongs to.
    pub source_line: u32,
    /// Zero for a line's first row, then one more for each wrapped row.
    pub wrap_index: u32,
}

/// The size of a text view's content at a wrap width, from [`TextView::measure`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TextMeasure {
    /// Lines after wrapping.
    pub line_count: u32,
    /// The widest line after wrapping, in display columns.
    pub width_max: u32,
}

/// Shared, read-only styled text. Views of it wrap and scroll independently.
#[derive(Clone)]
pub struct TextBuffer(Rc<Resource>, Rc<RefCell<Option<SyntaxStyle>>>);

impl TextBuffer {
    /// `width_method` is normally the Session's detected method, such as
    /// [`App::width_method`](crate::App::width_method).
    pub fn new(context: &Context, width_method: WidthMethod) -> Result<Self> {
        let options = sys::ot_edit_buffer_options { width_method: width_method.raw(), ..Default::default() };
        let resource = Resource::create(
            context,
            "ot_text_buffer_create",
            ("ot_text_buffer_destroy", sys::ot_text_buffer_destroy),
            |context, handle| unsafe { sys::ot_text_buffer_create(context, &options, handle) },
        )?;
        Ok(Self(Rc::new(resource), Rc::default()))
    }

    pub fn context(&self) -> &Context {
        self.0.context()
    }

    fn raw(&self) -> (*mut sys::ot_context, *const sys::ot_handle) {
        self.0.raw()
    }

    pub fn set_text(&self, text: &str) -> Result<()> {
        let length = count("ot_text_buffer_set_text", text.len())?;
        let (context, handle) = self.raw();
        check("ot_text_buffer_set_text", unsafe {
            sys::ot_text_buffer_set_text(context, handle, text.as_ptr(), length)
        })
    }

    /// Appends text with the default style.
    pub fn append(&self, text: &str) -> Result<()> {
        let length = count("ot_text_buffer_append", text.len())?;
        let (context, handle) = self.raw();
        check("ot_text_buffer_append", unsafe { sys::ot_text_buffer_append(context, handle, text.as_ptr(), length) })
    }

    /// Removes all text. Without `reset`, highlights stay, and those of [`Self::set_spans`] lose their links; `reset`
    /// also drops styles and highlights.
    pub fn clear(&self, reset: bool) -> Result<()> {
        let (context, handle) = self.raw();
        check("ot_text_buffer_clear", unsafe { sys::ot_text_buffer_clear(context, handle, u32::from(reset)) })
    }

    /// Replaces the text with styled spans. Links become OSC 8 hyperlinks.
    pub fn set_spans(&self, spans: &[Span<'_>]) -> Result<()> {
        const OPERATION: &str = "ot_text_buffer_set_styled_text";
        let encoded = EncodedSpans::new(spans);
        let (bytes, chunks, urls) = (
            count(OPERATION, encoded.bytes.len())?,
            count(OPERATION, encoded.chunks.len())?,
            count(OPERATION, encoded.urls.len())?,
        );
        let (context, handle) = self.raw();
        check(OPERATION, unsafe {
            sys::ot_text_buffer_set_styled_text(
                context,
                handle,
                encoded.bytes.as_ptr(),
                bytes,
                encoded.chunks.as_ptr(),
                chunks,
                encoded.urls.as_ptr(),
                urls,
            )
        })
    }

    /// Uses `style` as the table layer runs' group sets and highlights' style ids resolve against, or none. The
    /// buffer keeps the table alive while it is bound.
    pub fn set_syntax_style(&self, style: Option<&SyntaxStyle>) -> Result<()> {
        let handle_of = style.map(SyntaxStyle::handle);
        let (context, handle) = self.raw();
        check("ot_text_buffer_set_syntax_style", unsafe {
            sys::ot_text_buffer_set_syntax_style(context, handle, handle_of.as_ref().map_or(std::ptr::null(), |s| s))
        })?;
        *self.1.borrow_mut() = style.cloned();
        Ok(())
    }

    /// Replaces layer `layer_id` inside `range` with `runs`, as [`EditBuffer::set_layer`](super::EditBuffer::set_layer)
    /// does: bytes count one per line break, as [`Self::text`] returns them. Appending keeps the layers; replacing or
    /// clearing the text empties them. [`Code`](crate::widget::Code) sets layer 1 for filetype syntax.
    pub fn set_layer(&self, layer_id: u32, range: std::ops::Range<u32>, runs: &[LayerRun]) -> Result<()> {
        let length = count("ot_text_buffer_set_layer", runs.len())?;
        let (context, handle) = self.raw();
        check("ot_text_buffer_set_layer", unsafe {
            sys::ot_text_buffer_set_layer(context, handle, layer_id, range.start, range.end, runs.as_ptr(), length)
        })
    }

    pub fn text(&self) -> Result<String> {
        let (context, handle) = self.raw();
        read_string("ot_text_buffer_get_text", |bytes, capacity, length| unsafe {
            sys::ot_text_buffer_get_text(context, handle, bytes, capacity, length)
        })
    }

    pub fn info(&self) -> Result<TextBufferInfo> {
        let mut raw = sys::ot_text_buffer_info::default();
        let (context, handle) = self.raw();
        check("ot_text_buffer_get_info", unsafe { sys::ot_text_buffer_get_info(context, handle, &mut raw) })?;
        Ok(TextBufferInfo {
            content_epoch: raw.content_epoch,
            byte_count: raw.byte_count,
            width_total: raw.text_length,
            line_count: raw.line_count,
            tab_width: raw.tab_width,
        })
    }

    /// Colors and attributes for text without its own style.
    pub fn set_defaults(&self, style: Style) -> Result<()> {
        let mut raw = sys::ot_editor_style {
            attributes: u32::from(style.attributes.bits()),
            flags: sys::OT_EDITOR_STYLE_ATTRIBUTES,
            ..Default::default()
        };
        if let Some(color) = style.fg {
            raw.flags |= sys::OT_EDITOR_STYLE_FOREGROUND;
            raw.foreground = color.to_raw();
        }
        if let Some(color) = style.bg {
            raw.flags |= sys::OT_EDITOR_STYLE_BACKGROUND;
            raw.background = color.to_raw();
        }
        let mask = sys::OT_EDITOR_STYLE_FOREGROUND | sys::OT_EDITOR_STYLE_BACKGROUND | sys::OT_EDITOR_STYLE_ATTRIBUTES;
        let (context, handle) = self.raw();
        check("ot_text_buffer_set_defaults", unsafe { sys::ot_text_buffer_set_defaults(context, handle, mask, &raw) })
    }

    pub fn set_tab_width(&self, width: u32) -> Result<()> {
        let (context, handle) = self.raw();
        check("ot_text_buffer_set_tab_width", unsafe { sys::ot_text_buffer_set_tab_width(context, handle, width) })
    }
}

/// A wrapped, scrollable view of a [`TextBuffer`]. It keeps its buffer alive.
#[derive(Clone)]
pub struct TextView(Rc<TextViewOwner>);

struct TextViewOwner {
    // The view must be destroyed before its buffer.
    view: Resource,
    buffer: TextBuffer,
}

impl TextView {
    pub fn new(buffer: &TextBuffer) -> Result<Self> {
        let source = buffer.0.handle();
        let view = Resource::create(
            buffer.context(),
            "ot_text_buffer_view_create",
            ("ot_text_buffer_view_destroy", sys::ot_text_buffer_view_destroy),
            |context, handle| unsafe { sys::ot_text_buffer_view_create(context, &source, handle) },
        )?;
        Ok(Self(Rc::new(TextViewOwner { view, buffer: buffer.clone() })))
    }

    pub fn buffer(&self) -> &TextBuffer {
        &self.0.buffer
    }

    pub(crate) fn handle(&self) -> sys::ot_handle {
        self.0.view.handle()
    }

    fn raw(&self) -> (*mut sys::ot_context, *const sys::ot_handle) {
        self.0.view.raw()
    }

    /// Moves the viewport. A bound scene node sets the size from its layout each frame and keeps the position.
    pub fn set_viewport(&self, viewport: Viewport) -> Result<()> {
        let raw = sys::ot_editor_viewport {
            x: viewport.x,
            y: viewport.y,
            width: viewport.width,
            height: viewport.height,
            ..Default::default()
        };
        let (context, handle) = self.raw();
        check("ot_text_buffer_view_set_viewport", unsafe {
            sys::ot_text_buffer_view_set_viewport(context, handle, &raw, 0)
        })
    }

    fn command(&self, command: u32, argument: u32) -> Result<()> {
        let (context, handle) = self.raw();
        check("ot_text_buffer_view_command", unsafe {
            sys::ot_text_buffer_view_command(context, handle, command, argument)
        })
    }

    pub fn set_wrap(&self, wrap: WrapMode) -> Result<()> {
        self.command(sys::OT_TEXT_VIEW_WRAP_MODE, wrap.raw())
    }

    pub fn set_tab_indicator(&self, indicator: Option<char>) -> Result<()> {
        self.command(sys::OT_TEXT_VIEW_TAB_INDICATOR, indicator.map_or(0, u32::from))
    }

    pub fn info(&self) -> Result<EditorInfo> {
        let mut raw = sys::ot_editor_view_info::default();
        let (context, handle) = self.raw();
        check("ot_text_buffer_view_get_info", unsafe { sys::ot_text_buffer_view_get_info(context, handle, &mut raw) })?;
        Ok(EditorInfo {
            virtual_line_count: raw.virtual_line_count,
            total_virtual_line_count: raw.total_virtual_line_count,
            selection: (raw.selection_present != 0).then_some((raw.selection_start, raw.selection_end)),
        })
    }

    /// Wrapped lines of the viewport, from its row `first`, up to `limit` of them. Row 0 is the first visible row.
    pub fn lines(&self, first: u32, limit: u32) -> Result<Vec<VisualLine>> {
        let mut measure = sys::ot_editor_measure::default();
        let (context, handle) = self.raw();
        // Ask for the count first, so a large `limit` allocates no more than the lines there are.
        check("ot_text_buffer_view_get_lines", unsafe {
            sys::ot_text_buffer_view_get_lines(context, handle, 0, first, std::ptr::null_mut(), 0, &mut measure)
        })?;
        let capacity = measure.line_count.saturating_sub(first).min(limit);
        if capacity == 0 {
            return Ok(Vec::new());
        }
        let mut lines = vec![sys::ot_scene_text_line::default(); capacity as usize];
        check("ot_text_buffer_view_get_lines", unsafe {
            sys::ot_text_buffer_view_get_lines(context, handle, 0, first, lines.as_mut_ptr(), capacity, &mut measure)
        })?;
        lines.truncate(measure.line_count.saturating_sub(first).min(capacity) as usize);
        Ok(lines
            .iter()
            .map(|line| VisualLine {
                start_column: line.start_cols,
                width: line.width_cols,
                source_line: line.source_line,
                wrap_index: line.wrap_index,
            })
            .collect())
    }

    /// Measures the content as if the view wrapped at `width` display columns, with the view's wrap mode, without
    /// changing the viewport. A width of zero measures unwrapped lines. Allowed inside a [`Measure`](super::Measure)
    /// callback.
    pub fn measure(&self, width: u32) -> Result<TextMeasure> {
        let mut raw = sys::ot_editor_measure::default();
        let (context, handle) = self.raw();
        // Native measurement ignores the height; it only has to be in range.
        check("ot_text_buffer_view_measure", unsafe {
            sys::ot_text_buffer_view_measure(context, handle, width, i32::MAX as u32, &mut raw)
        })?;
        Ok(TextMeasure { line_count: raw.line_count, width_max: raw.width_cols_max })
    }

    pub fn selected_text(&self) -> Result<String> {
        let (context, handle) = self.raw();
        read_string("ot_text_buffer_view_get_selected_text", |bytes, capacity, length| unsafe {
            sys::ot_text_buffer_view_get_selected_text(context, handle, bytes, capacity, length)
        })
    }

    fn select(&self, raw: sys::ot_editor_selection) -> Result<bool> {
        let (context, handle) = self.raw();
        let mut changed = 0;
        check("ot_text_buffer_view_select", unsafe {
            sys::ot_text_buffer_view_select(context, handle, &raw, &mut changed)
        })?;
        Ok(changed != 0)
    }

    /// Starts (`extend == false`) or extends a selection between two viewport-local cells, as a mouse drag does.
    /// Returns whether the selection changed.
    pub fn select_local(
        &self,
        anchor: (i32, i32),
        focus: (i32, i32),
        extend: bool,
        unit: super::SelectionUnit,
        colors: super::SelectionColors,
    ) -> Result<bool> {
        let operation = if extend { sys::OT_EDITOR_SELECT_LOCAL_UPDATE } else { sys::OT_EDITOR_SELECT_LOCAL };
        self.select(sys::ot_editor_selection {
            behavior: unit.raw(),
            anchor_x: anchor.0,
            anchor_y: anchor.1,
            focus_x: focus.0,
            focus_y: focus.1,
            ..colors.editor_selection(operation)
        })
    }

    pub fn clear_selection(&self) -> Result<()> {
        self.select(sys::ot_editor_selection { operation: sys::OT_EDITOR_SELECT_RESET, ..Default::default() })?;
        self.select(sys::ot_editor_selection { operation: sys::OT_EDITOR_SELECT_LOCAL_RESET, ..Default::default() })
            .map(drop)
    }

    /// Selected document offsets, start inclusive and end exclusive.
    pub fn selection(&self) -> Result<Option<(u32, u32)>> {
        Ok(self.info()?.selection.filter(|(start, end)| start != end))
    }
}

impl Node {
    /// Binds a text view to a [`NodeKind::TextView`](super::NodeKind::TextView) node, or unbinds it. The node paints
    /// the view, sizes its viewport, and measures from its content.
    pub fn set_text_view(&self, view: Option<&TextView>) -> Result<()> {
        let view = view.map(TextView::handle);
        check("ot_scene_set_text_view", unsafe {
            sys::ot_scene_set_text_view(
                self.context_raw(),
                &self.handle(),
                view.as_ref().map_or(std::ptr::null(), |v| v),
            )
        })
    }
}

/// How an image fills its node.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum ImageFit {
    /// Scale to fit inside, keeping the aspect ratio.
    #[default]
    Contain,
    /// Scale to cover the node, keeping the aspect ratio and cropping.
    Cover,
    /// Stretch to the node.
    Fill,
}

impl ImageFit {
    pub(crate) const fn raw(self) -> u32 {
        match self {
            Self::Contain => sys::OT_IMAGE_FIT,
            Self::Cover => sys::OT_IMAGE_COVER,
            Self::Fill => sys::OT_IMAGE_FILL,
        }
    }
}

/// How a terminal shows an image.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum ImageProtocol {
    /// The best protocol the terminal supports.
    #[default]
    Auto,
    Kitty,
    Sixel,
    /// Unicode half blocks: works everywhere at low resolution.
    Blocks,
}

/// Decoded image metadata.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ImageInfo {
    pub width: u32,
    pub height: u32,
    pub has_alpha: bool,
}

/// A decoded image owned by a Context.
#[derive(Clone)]
pub struct Image(Rc<Resource>);

impl Image {
    /// Decodes PNG, JPEG, WebP, or GIF bytes (at most 64 MiB, 16384 pixels per side).
    pub fn decode(context: &Context, bytes: &[u8]) -> Result<Self> {
        let resource = Resource::create(
            context,
            "ot_image_decode",
            ("ot_image_destroy", sys::ot_image_destroy),
            |context, handle| unsafe { sys::ot_image_decode(context, bytes.as_ptr(), bytes.len() as u64, handle) },
        )?;
        Ok(Self(Rc::new(resource)))
    }

    /// Wraps straight-alpha RGBA8 pixels, `width * height * 4` bytes in rows without padding.
    pub fn from_rgba(context: &Context, width: u32, height: u32, pixels: &[u8]) -> Result<Self> {
        let stride = width.checked_mul(4).ok_or(crate::Error::Native {
            operation: "ot_image_create_pixels",
            status: crate::Status::InvalidArgument,
        })?;
        let resource = Resource::create(
            context,
            "ot_image_create_pixels",
            ("ot_image_destroy", sys::ot_image_destroy),
            |context, handle| unsafe {
                sys::ot_image_create_pixels(
                    context,
                    pixels.as_ptr(),
                    pixels.len() as u64,
                    width,
                    height,
                    stride,
                    sys::OT_IMAGE_RGBA8,
                    sys::OT_IMAGE_ALPHA_STRAIGHT,
                    handle,
                )
            },
        )?;
        Ok(Self(Rc::new(resource)))
    }

    pub fn info(&self) -> Result<ImageInfo> {
        let mut raw = sys::ot_image_info::default();
        let (context, handle) = self.0.raw();
        check("ot_image_get_info", unsafe { sys::ot_image_get_info(context, handle, &mut raw) })?;
        Ok(ImageInfo { width: raw.width, height: raw.height, has_alpha: raw.has_alpha != 0 })
    }

    pub(crate) fn handle(&self) -> sys::ot_handle {
        self.0.handle()
    }
}

impl Node {
    /// Shows an image in an [`NodeKind::Image`](super::NodeKind::Image) node, or clears it with `None`.
    pub fn set_image(&self, image: Option<&Image>, fit: ImageFit, protocol: ImageProtocol) -> Result<()> {
        let image = image.map(Image::handle);
        let protocol = match protocol {
            ImageProtocol::Auto => sys::OT_IMAGE_PROTOCOL_AUTO,
            ImageProtocol::Kitty => sys::OT_IMAGE_PROTOCOL_KITTY,
            ImageProtocol::Sixel => sys::OT_IMAGE_PROTOCOL_SIXEL,
            ImageProtocol::Blocks => sys::OT_IMAGE_PROTOCOL_BLOCKS,
        };
        check("ot_scene_set_image", unsafe {
            sys::ot_scene_set_image(
                self.context_raw(),
                &self.handle(),
                image.as_ref().map_or(std::ptr::null(), |i| i),
                fit.raw(),
                protocol,
                std::ptr::null(),
            )
        })
    }
}
