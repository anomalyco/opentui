//! Thread-affine Rust owners for OpenTUI's checked C ABI.
//!
//! Native code owns the scene, layout, and output queue. The host chooses the
//! clock, work budget, terminal environment, and transport. No JavaScript runtime
//! or rendering worker is involved. This example binds a subset of `opentui.h`.

pub mod ffi;

use std::{marker::PhantomData, ptr::NonNull, rc::Rc};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub struct Error {
    pub operation: &'static str,
    pub status: i32,
}

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{} returned {}", self.operation, self.status)
    }
}

impl std::error::Error for Error {}

fn check(operation: &'static str, status: i32) -> Result<()> {
    if status == ffi::OT_OK {
        Ok(())
    } else {
        Err(Error { operation, status })
    }
}

fn count(length: usize) -> Result<u32> {
    length.try_into().map_err(|_| Error {
        operation: "length exceeds the C ABI's u32 byte/count range",
        status: ffi::OT_INVALID_ARGUMENT,
    })
}

fn cleanup(operation: &'static str, status: i32) {
    if let Err(error) = check(operation, status) {
        eprintln!("native cleanup failed: {error:?}");
        std::process::abort();
    }
}

/// Owns native resources on the creating thread; neither `Send` nor `Sync`.
pub struct Context {
    pointer: NonNull<ffi::ot_context>,
    // The C Context, and every borrowing owner, must stay on its creating thread.
    owner_thread: PhantomData<Rc<()>>,
}

impl Context {
    /// Both resource limits must be explicit. Record defaults set only ABI metadata.
    pub fn new(options: ffi::ot_context_options) -> Result<Self> {
        let mut pointer = std::ptr::null_mut();
        check("ot_context_create", unsafe { ffi::ot_context_create(&options, &mut pointer) })?;
        Ok(Self {
            pointer: NonNull::new(pointer).expect("successful Context creation returned NULL"),
            owner_thread: PhantomData,
        })
    }

    fn ptr(&self) -> *mut ffi::ot_context {
        self.pointer.as_ptr()
    }

    pub fn last_error(&self) -> Result<i32> {
        let mut error = ffi::ot_context_error::default();
        check("ot_context_get_last_error", unsafe { ffi::ot_context_get_last_error(self.ptr(), &mut error) })?;
        Ok(error.status)
    }
}

impl Drop for Context {
    fn drop(&mut self) {
        cleanup("ot_context_destroy", unsafe { ffi::ot_context_destroy(self.ptr()) });
    }
}

/// Owns an output queue and optional renderer, borrowing its Context until drop.
///
/// Graceful shutdown requires [`Self::close`], pumping, and output completion.
/// Drop cancels outstanding work instead of delivering terminal restoration.
pub struct Session<'context> {
    context: &'context Context,
    handle: ffi::ot_handle,
}

impl<'context> Session<'context> {
    pub fn new(context: &'context Context, options: ffi::ot_session_options) -> Result<Self> {
        let mut handle = ffi::ot_handle::default();
        check("ot_session_create", unsafe { ffi::ot_session_create(context.ptr(), &options, &mut handle) })?;
        Ok(Self { context, handle })
    }

    /// Attaches a renderer without setting up the terminal or reading process env.
    /// Dimensions count terminal cells. Environment strings are copied during the call.
    pub fn attach_renderer(&self, width: u32, height: u32, remote_mode: u32, entries: &[(&str, &str)]) -> Result<()> {
        // Bound serialization before allocation using the C ABI's admission limits.
        if entries.len() > ffi::OT_SESSION_ENV_ENTRIES_MAX as usize {
            return Err(Error {
                operation: "renderer environment exceeds C ABI entry limit",
                status: ffi::OT_INVALID_ARGUMENT,
            });
        }
        let byte_count = entries.iter().try_fold(0usize, |total, (key, value)| {
            total.checked_add(8)?.checked_add(key.len())?.checked_add(value.len())
        });
        let byte_count = byte_count.filter(|&size| size <= ffi::OT_SESSION_ENV_BYTES_MAX as usize);
        let byte_count = byte_count.ok_or(Error {
            operation: "renderer environment exceeds C ABI limits",
            status: ffi::OT_INVALID_ARGUMENT,
        })?;
        let mut environment = Vec::with_capacity(byte_count);
        for (key, value) in entries {
            environment.extend_from_slice(&count(key.len())?.to_le_bytes());
            environment.extend_from_slice(&count(value.len())?.to_le_bytes());
            environment.extend_from_slice(key.as_bytes());
            environment.extend_from_slice(value.as_bytes());
        }
        let renderer = ffi::ot_session_renderer_env_options {
            width,
            height,
            remote_mode,
            entry_count: count(entries.len())?,
            byte_count: count(environment.len())?,
            ..Default::default()
        };
        check("ot_session_attach_renderer_with_env", unsafe {
            ffi::ot_session_attach_renderer_with_env(self.context.ptr(), &self.handle, &renderer, environment.as_ptr())
        })
    }

    pub fn setup_terminal(&self, options: &ffi::ot_session_terminal_options) -> Result<()> {
        check("ot_session_setup_terminal", unsafe {
            ffi::ot_session_setup_terminal(self.context.ptr(), &self.handle, options)
        })
    }

    /// Copies all bytes into the bounded native queue, or rejects the whole write.
    pub fn write(&self, bytes: &[u8]) -> Result<()> {
        check("ot_session_write", unsafe {
            ffi::ot_session_write(self.context.ptr(), &self.handle, bytes.as_ptr(), count(bytes.len())?)
        })
    }

    /// Copies output without acknowledging delivery. At most one ticket may be outstanding.
    pub fn read_output(&self, bytes: &mut [u8]) -> Result<ffi::ot_output_ticket> {
        let mut ticket = ffi::ot_output_ticket::default();
        check("ot_session_read_output", unsafe {
            ffi::ot_session_read_output(
                self.context.ptr(),
                &self.handle,
                bytes.as_mut_ptr(),
                count(bytes.len())?,
                &mut ticket,
            )
        })?;
        Ok(ticket)
    }

    /// Acknowledges a ticket only after transport delivery, or marks delivery failed.
    pub fn complete_output(&self, ticket: &ffi::ot_output_ticket, success: bool) -> Result<()> {
        check("ot_session_complete_output", unsafe {
            ffi::ot_session_complete_output(self.context.ptr(), &self.handle, ticket, u32::from(success))
        })
    }

    /// Advances bounded native work using the host's monotonic nanosecond clock.
    /// The host handles returned deadlines and output requests; this never sleeps.
    pub fn pump(&self, now_ns: u64, work_budget: u32) -> Result<ffi::ot_session_pump_result> {
        let mut result = ffi::ot_session_pump_result::default();
        check("ot_session_pump", unsafe {
            ffi::ot_session_pump(self.context.ptr(), &self.handle, now_ns, work_budget, &mut result)
        })?;
        Ok(result)
    }

    pub fn resize(&self, width: u32, height: u32) -> Result<()> {
        check("ot_session_resize_renderer", unsafe {
            ffi::ot_session_resize_renderer(self.context.ptr(), &self.handle, width, height)
        })
    }

    /// Paints built-in scene nodes without presenting output.
    pub fn paint(&self, background: [u16; 4], use_mouse: bool, excluded_hit_num: u32) -> Result<()> {
        check("ot_scene_paint", unsafe {
            ffi::ot_scene_paint(
                self.context.ptr(),
                &self.handle,
                background.as_ptr(),
                u32::from(use_mouse),
                excluded_hit_num,
            )
        })
    }

    /// Encodes the painted frame. Pending output must be delivered and completed
    /// before native code publishes frame statistics and hit results.
    pub fn render(&self, force: bool) -> Result<u32> {
        let mut result = 0;
        check("ot_session_render", unsafe {
            ffi::ot_session_render(self.context.ptr(), &self.handle, u32::from(force), &mut result)
        })?;
        Ok(result)
    }

    pub fn renderer_state(&self) -> Result<ffi::ot_session_renderer_state> {
        let mut state = ffi::ot_session_renderer_state::default();
        check("ot_session_get_renderer_state", unsafe {
            ffi::ot_session_get_renderer_state(self.context.ptr(), &self.handle, &mut state)
        })?;
        Ok(state)
    }

    /// Returns the presented node number at terminal-cell coordinates, or zero.
    pub fn hit_test(&self, x: i32, y: i32) -> Result<u32> {
        let mut num = 0;
        check("ot_scene_hit_test", unsafe {
            ffi::ot_scene_hit_test(self.context.ptr(), &self.handle, x, y, &mut num)
        })?;
        Ok(num)
    }

    pub fn terminal_state(&self) -> Result<u32> {
        let mut state = 0;
        check("ot_session_get_terminal_state", unsafe {
            ffi::ot_session_get_terminal_state(self.context.ptr(), &self.handle, &mut state)
        })?;
        Ok(state)
    }

    pub fn state(&self) -> Result<u32> {
        let mut state = 0;
        check("ot_session_get_state", unsafe {
            ffi::ot_session_get_state(self.context.ptr(), &self.handle, &mut state)
        })?;
        Ok(state)
    }

    pub fn close(&self) -> Result<()> {
        check("ot_session_close", unsafe { ffi::ot_session_close(self.context.ptr(), &self.handle) })
    }

    pub fn cancel(&self) -> Result<()> {
        check("ot_session_cancel", unsafe { ffi::ot_session_cancel(self.context.ptr(), &self.handle) })
    }
}

impl Drop for Session<'_> {
    fn drop(&mut self) {
        let status = unsafe { ffi::ot_session_destroy(self.context.ptr(), &self.handle) };
        if status == ffi::OT_CONTEXT_BUSY {
            // Drop cannot deliver bytes or wait for terminal restoration. Explicit
            // close + pump is the graceful path; cancellation is only a fallback.
            cleanup("ot_session_cancel", unsafe { ffi::ot_session_cancel(self.context.ptr(), &self.handle) });
            cleanup("ot_session_destroy", unsafe { ffi::ot_session_destroy(self.context.ptr(), &self.handle) });
        } else {
            cleanup("ot_session_destroy", status);
        }
    }
}

/// Owns one native scene node. Drop detaches it but does not destroy other nodes.
/// Parent/child topology remains native; the Rust owner only borrows its Session.
pub struct Node<'session, 'context> {
    session: &'session Session<'context>,
    handle: ffi::ot_handle,
}

impl<'session, 'context> Node<'session, 'context> {
    pub fn new(session: &'session Session<'context>, kind: u32, num: u32) -> Result<Self> {
        let mut handle = ffi::ot_handle::default();
        check("ot_scene_create_node", unsafe {
            ffi::ot_scene_create_node(session.context.ptr(), &session.handle, kind, num, &mut handle)
        })?;
        Ok(Self { session, handle })
    }

    pub fn mount(&self, parent: &Node<'_, '_>) -> Result<()> {
        self.mount_at(parent, 0)
    }

    pub fn mount_at(&self, parent: &Node<'_, '_>, index: u32) -> Result<()> {
        check("ot_scene_move_node", unsafe {
            ffi::ot_scene_move_node(self.session.context.ptr(), &self.handle, &parent.handle, index)
        })
    }

    pub fn set_style(&self, group: u32, kind: u32, edge: u32, unit: u32, value: f32, flags: u32) -> Result<()> {
        check("ot_scene_set_style", unsafe {
            ffi::ot_scene_set_style(self.session.context.ptr(), &self.handle, group, kind, edge, unit, value, flags)
        })
    }

    pub fn set_paint(&self, options: &ffi::ot_scene_paint_options) -> Result<()> {
        check("ot_scene_set_paint", unsafe {
            ffi::ot_scene_set_paint(self.session.context.ptr(), &self.handle, options)
        })
    }

    /// Copies UTF-8 text. Byte lengths are not display-cell widths.
    pub fn set_text(&self, bytes: &[u8]) -> Result<()> {
        check("ot_scene_set_text", unsafe {
            ffi::ot_scene_set_text(self.session.context.ptr(), &self.handle, bytes.as_ptr(), count(bytes.len())?)
        })
    }

    /// Copies text, styles, and URL bytes; rejected replacements preserve accepted content.
    pub fn set_styled_text_with_links(
        &self,
        bytes: &[u8],
        chunks: &[ffi::ot_scene_linked_text_chunk],
        urls: &[u8],
    ) -> Result<()> {
        check("ot_scene_set_styled_text_with_links", unsafe {
            ffi::ot_scene_set_styled_text_with_links(
                self.session.context.ptr(),
                &self.handle,
                bytes.as_ptr(),
                count(bytes.len())?,
                chunks.as_ptr(),
                count(chunks.len())?,
                urls.as_ptr(),
                count(urls.len())?,
            )
        })
    }

    pub fn text(&self) -> Result<Vec<u8>> {
        let mut length = 0;
        check("ot_scene_get_text(size)", unsafe {
            ffi::ot_scene_get_text(self.session.context.ptr(), &self.handle, std::ptr::null_mut(), 0, &mut length)
        })?;
        let mut bytes = vec![0; length as usize];
        check("ot_scene_get_text(copy)", unsafe {
            ffi::ot_scene_get_text(self.session.context.ptr(), &self.handle, bytes.as_mut_ptr(), length, &mut length)
        })?;
        bytes.truncate(length as usize);
        Ok(bytes)
    }
}

impl Drop for Node<'_, '_> {
    fn drop(&mut self) {
        cleanup("ot_scene_destroy_node", unsafe {
            ffi::ot_scene_destroy_node(self.session.context.ptr(), &self.handle)
        });
    }
}

#[cfg(test)]
mod tests;
