use super::WidthMethod;
use crate::error::{Error, Result, Status, check, cleanup};
use crate::sys;
use std::{ptr::NonNull, rc::Rc};

/// Resource limits for a [`Context`]. Native code has no defaults; both limits must be positive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContextOptions {
    /// The initial number of native object slots, shared by Sessions, nodes, buffers, and leases. A full table
    /// doubles, up to 4,194,304 slots or this capacity, whichever is larger.
    pub object_capacity: u32,
    /// The largest renderer or buffer, in terminal cells.
    pub render_cells_max: u32,
}

impl Default for ContextOptions {
    fn default() -> Self {
        Self { object_capacity: 16_384, render_cells_max: 512 * 512 }
    }
}

/// The native resource owner.
///
/// Cloning shares the same Context. Every resource keeps its Context alive, so drop order never matters. A Context
/// and everything created from it stay on the creating thread: none of these types are `Send` or `Sync`.
///
/// Dropping the last clone destroys the native Context. While a [`ClipboardService`](super::ClipboardService) has
/// platform calls in progress, that blocks for up to two seconds until they return. A Context still busy after that
/// leaks, with a warning on stderr, because the calls' worker threads may still use its memory.
#[derive(Clone)]
pub struct Context(Rc<ContextInner>);

struct ContextInner {
    pointer: NonNull<sys::ot_context>,
}

impl Drop for ContextInner {
    fn drop(&mut self) {
        // A host clipboard service makes destruction busy until its worker threads finish.
        for _ in 0..400 {
            let status = unsafe { sys::ot_context_destroy(self.pointer.as_ptr()) };
            if status != sys::OT_CONTEXT_BUSY {
                return cleanup("ot_context_destroy", status);
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        // A hung platform call must not take the process down. Only this thread may destroy the Context, and leaking
        // it frees nothing the workers use.
        eprintln!("opentui: native cleanup leaked a busy Context: host clipboard calls did not return");
    }
}

/// One native diagnostic message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub level: DiagnosticLevel,
    pub message: String,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiagnosticLevel {
    Error,
    Warning,
    Info,
    Debug,
}

impl Context {
    pub fn new(options: ContextOptions) -> Result<Self> {
        let version = unsafe { sys::ot_context_abi_version() };
        if version != sys::OT_CONTEXT_ABI_VERSION {
            return Err(Error::Native { operation: "ot_context_abi_version", status: Status::UnsupportedVersion });
        }
        let raw = sys::ot_context_options {
            object_capacity: options.object_capacity,
            render_cells_max: options.render_cells_max,
            ..Default::default()
        };
        let mut pointer = std::ptr::null_mut();
        check("ot_context_create", unsafe { sys::ot_context_create(&raw, &mut pointer) })?;
        let pointer = NonNull::new(pointer).expect("successful ot_context_create returned NULL");
        Ok(Self(Rc::new(ContextInner { pointer })))
    }

    /// The raw pointer, for calls this crate does not wrap. It stays valid while any clone of this Context lives.
    pub fn as_raw(&self) -> *mut sys::ot_context {
        self.0.pointer.as_ptr()
    }

    /// The status of the most recent failed call on this Context, if any.
    pub fn last_error(&self) -> Result<Option<Status>> {
        let mut error = sys::ot_context_error::default();
        check("ot_context_get_last_error", unsafe { sys::ot_context_get_last_error(self.as_raw(), &mut error) })?;
        Ok((error.status != sys::OT_OK).then(|| Status::from_code(error.status)))
    }

    /// Removes and returns queued native diagnostics, oldest first.
    pub fn drain_diagnostics(&self) -> Result<Vec<Diagnostic>> {
        const BATCH: usize = 8;
        let mut diagnostics = Vec::new();
        let mut records: Vec<sys::ot_diagnostic> = vec![Default::default(); BATCH];
        loop {
            let mut drain = sys::ot_diagnostic_drain::default();
            check("ot_context_drain_diagnostics", unsafe {
                sys::ot_context_drain_diagnostics(self.as_raw(), records.as_mut_ptr(), BATCH as u32, &mut drain)
            })?;
            for record in &records[..drain.count as usize] {
                let length = (record.message_len as usize).min(record.message.len());
                diagnostics.push(Diagnostic {
                    level: match record.level {
                        0 => DiagnosticLevel::Error,
                        1 => DiagnosticLevel::Warning,
                        2 => DiagnosticLevel::Info,
                        _ => DiagnosticLevel::Debug,
                    },
                    message: String::from_utf8_lossy(&record.message[..length]).into_owned(),
                    truncated: record.flags & sys::OT_DIAGNOSTIC_TRUNCATED != 0,
                });
            }
            if drain.remaining == 0 || drain.count == 0 {
                return Ok(diagnostics);
            }
        }
    }

    /// The display width of one row of text in terminal cells, as native drawing measures it. `width_method` is
    /// normally [`Capabilities::width_method`](super::Capabilities::width_method). Uses one object slot during the
    /// call.
    pub fn text_width(&self, text: &str, width_method: WidthMethod) -> Result<u32> {
        if text.is_ascii() && text.bytes().all(|byte| (0x20..0x7f).contains(&byte)) {
            return Ok(text.len() as u32);
        }
        let length = crate::error::count("ot_unicode_create", text.len())?;
        let resource = super::resource::Resource::create(
            self,
            "ot_unicode_create",
            ("ot_unicode_destroy", sys::ot_unicode_destroy),
            |context, handle| unsafe {
                sys::ot_unicode_create(context, text.as_ptr(), length, width_method.raw(), handle)
            },
        )?;
        let (context, handle) = resource.raw();
        let mut total = 0;
        check("ot_unicode_get", unsafe { sys::ot_unicode_get(context, handle, std::ptr::null_mut(), 0, &mut total) })?;
        let mut glyphs = vec![sys::ot_unicode_char::default(); total as usize];
        check("ot_unicode_get", unsafe {
            sys::ot_unicode_get(context, handle, glyphs.as_mut_ptr(), total, &mut total)
        })?;
        Ok(glyphs.iter().take(total as usize).map(|glyph| glyph.width).sum())
    }

    /// The URL of an interned hyperlink, as stored in rendered cells.
    pub fn link_url(&self, link_id: u32) -> Result<String> {
        let mut length = 0;
        check("ot_context_get_link_url", unsafe {
            sys::ot_context_get_link_url(self.as_raw(), link_id, std::ptr::null_mut(), 0, &mut length)
        })?;
        let mut bytes = vec![0; length as usize];
        check("ot_context_get_link_url", unsafe {
            sys::ot_context_get_link_url(self.as_raw(), link_id, bytes.as_mut_ptr(), length, &mut length)
        })?;
        bytes.truncate(length as usize);
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }
}
