//! The host clipboard: the system clipboard of the machine the process runs on, through Wayland or X11.
//!
//! Over SSH that is the server's clipboard, not the user's; [`Session::set_clipboard`](super::Session::set_clipboard)
//! reaches the user's clipboard through the terminal instead.

use super::Context;
use crate::error::{Error, Result};
use crate::sys;
use std::cell::{Cell, RefCell};
use std::time::Duration;

/// Which clipboard an operation uses.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum ClipboardSelection {
    /// The clipboard that copy and paste commands use.
    #[default]
    Clipboard,
    /// The primary selection: text selected anywhere, pasted with the middle button.
    Primary,
}

impl ClipboardSelection {
    fn raw(self) -> u8 {
        match self {
            Self::Clipboard => 0,
            Self::Primary => 1,
        }
    }

    /// The `ot_session_clipboard` target: 0 for OSC 52's `c` and 1 for `p`. Its `s` and `q` targets have no variant.
    pub(super) fn osc52_target(self) -> u32 {
        match self {
            Self::Clipboard => 0,
            Self::Primary => 1,
        }
    }
}

/// Limits for a [`ClipboardService`]. The defaults are Core's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClipboardOptions {
    /// Operations in progress at once.
    pub max_operations: u32,
    /// Transfers to other apps in progress at once, while this process owns the clipboard.
    pub max_provider_transfers: u32,
    pub max_image_pixels: u32,
    /// Bytes a read may use while converting the clipboard's data.
    pub max_conversion_bytes: u32,
}

impl Default for ClipboardOptions {
    fn default() -> Self {
        Self {
            max_operations: 16,
            max_provider_transfers: 16,
            max_image_pixels: 64 * 1024 * 1024,
            max_conversion_bytes: 512 * 1024 * 1024,
        }
    }
}

/// How a clipboard operation ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClipboardOutcome {
    /// A read found data in the first available type it asked for.
    Read {
        mime_type: String,
        data: Vec<u8>,
    },
    /// A read found nothing it asked for.
    Empty,
    Written,
    Cleared,
    /// No clipboard is reachable, such as without a display server.
    Unsupported,
    Cancelled,
    TimedOut,
    /// The data exceeded the read's byte limit.
    LimitExceeded,
    Failed {
        code: u32,
        message: String,
    },
}

/// One clipboard operation in progress, as [`ClipboardService`] returns it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ClipboardOperation(sys::ot_handle);

/// The Context's host clipboard service. A Context has at most one.
///
/// Operations advance only while the owner polls them: call [`Self::poll`] for each pending operation and
/// [`Self::drain`] about once a millisecond while any is pending, and every few milliseconds while `drain` reports
/// that other apps are reading data this process put on the clipboard.
///
/// Dropping the service blocks for up to two seconds while platform calls return, and dropping its Context then
/// waits up to two seconds more. If a call never returns, such as when the display server hangs, the Context leaks
/// with a warning on stderr instead of being destroyed.
pub struct ClipboardService {
    context: Context,
    options: ClipboardOptions,
    /// Operations that finished or were abandoned but that native code could not release yet.
    retired: RefCell<Vec<sys::ot_handle>>,
    active: Cell<bool>,
}

const START_ERRORS: [&str; 6] = [
    "",
    "opentui: the clipboard service is invalid",
    "opentui: the clipboard service is shutting down",
    "opentui: too many clipboard operations are in progress",
    "opentui: invalid clipboard operation",
    "opentui: out of memory for a clipboard operation",
];

const NO_HANDLE: sys::ot_handle = sys::ot_handle { context_id: 0, slot: 0, generation: 0 };

fn millis(timeout: Duration) -> u32 {
    u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX)
}

impl ClipboardService {
    /// Starts the service. Fails when the Context already has one.
    pub fn new(context: &Context, options: ClipboardOptions) -> Result<Self> {
        let created = unsafe {
            sys::ot_clipboard_service_create(
                context.as_raw(),
                options.max_operations,
                options.max_provider_transfers,
                std::ptr::null(),
                0,
            )
        };
        if created != 0 {
            return Err(Error::Usage("opentui: the Context already has a clipboard service, or it could not start"));
        }
        Ok(Self { context: context.clone(), options, retired: RefCell::new(Vec::new()), active: Cell::new(false) })
    }

    fn started(status: u8, handle: sys::ot_handle) -> Result<ClipboardOperation> {
        match status {
            0 => Ok(ClipboardOperation(handle)),
            status => Err(Error::Usage(START_ERRORS.get(usize::from(status)).copied().unwrap_or(START_ERRORS[1]))),
        }
    }

    /// Starts reading the first available of `mime_types`, such as `"text/plain"`, up to `max_bytes`.
    pub fn read(
        &self,
        mime_types: &[&str],
        selection: ClipboardSelection,
        max_bytes: u32,
        timeout: Duration,
    ) -> Result<ClipboardOperation> {
        if mime_types.is_empty() {
            return Err(Error::Usage("opentui: a clipboard read needs at least one type"));
        }
        let mut request = Vec::new();
        let count = u32::try_from(mime_types.len()).map_err(|_| Error::Usage("opentui: too many clipboard types"))?;
        request.extend_from_slice(&count.to_le_bytes());
        for mime_type in mime_types {
            let length =
                u32::try_from(mime_type.len()).map_err(|_| Error::Usage("opentui: clipboard type too long"))?;
            request.extend_from_slice(&length.to_le_bytes());
            request.extend_from_slice(mime_type.as_bytes());
        }
        let length = u32::try_from(request.len()).map_err(|_| Error::Usage("opentui: clipboard request too long"))?;
        let mut handle = NO_HANDLE;
        let status = unsafe {
            sys::ot_clipboard_read_operation_start(
                self.context.as_raw(),
                request.as_ptr(),
                length,
                selection.raw(),
                max_bytes,
                self.options.max_image_pixels,
                self.options.max_conversion_bytes,
                millis(timeout),
                &mut handle,
            )
        };
        Self::started(status, handle)
    }

    /// Starts putting text on the clipboard. The process then provides it to other apps until one replaces it.
    pub fn write_text(
        &self,
        text: &str,
        selection: ClipboardSelection,
        timeout: Duration,
    ) -> Result<ClipboardOperation> {
        let length = u32::try_from(text.len()).map_err(|_| Error::Usage("opentui: clipboard text too long"))?;
        let mut handle = NO_HANDLE;
        let status = unsafe {
            sys::ot_clipboard_write_operation_start(
                self.context.as_raw(),
                text.as_ptr(),
                length,
                selection.raw(),
                millis(timeout),
                &mut handle,
            )
        };
        Self::started(status, handle)
    }

    pub fn clear(&self, selection: ClipboardSelection, timeout: Duration) -> Result<ClipboardOperation> {
        let mut handle = NO_HANDLE;
        let status = unsafe {
            sys::ot_clipboard_clear_operation_start(
                self.context.as_raw(),
                selection.raw(),
                millis(timeout),
                &mut handle,
            )
        };
        Self::started(status, handle)
    }

    /// Advances an operation. Returns its outcome once it ends, after which the operation is released and must not
    /// be polled again; returns `None` while it is in progress.
    pub fn poll(&self, operation: ClipboardOperation) -> Option<ClipboardOutcome> {
        let context = self.context.as_raw();
        let handle = &operation.0;
        let outcome = match unsafe { sys::ot_clipboard_operation_poll(context, handle) } as u32 {
            sys::OT_CLIPBOARD_OPERATION_PENDING => return None,
            sys::OT_CLIPBOARD_OPERATION_READ => self.representation(handle),
            sys::OT_CLIPBOARD_OPERATION_EMPTY => ClipboardOutcome::Empty,
            sys::OT_CLIPBOARD_OPERATION_WRITTEN => ClipboardOutcome::Written,
            sys::OT_CLIPBOARD_OPERATION_CLEARED => ClipboardOutcome::Cleared,
            sys::OT_CLIPBOARD_OPERATION_UNSUPPORTED => ClipboardOutcome::Unsupported,
            sys::OT_CLIPBOARD_OPERATION_CANCELLED => ClipboardOutcome::Cancelled,
            sys::OT_CLIPBOARD_OPERATION_TIMED_OUT => ClipboardOutcome::TimedOut,
            sys::OT_CLIPBOARD_OPERATION_LIMIT_EXCEEDED => ClipboardOutcome::LimitExceeded,
            sys::OT_CLIPBOARD_OPERATION_FAILED => self.failure(handle),
            _ => ClipboardOutcome::Failed { code: 0, message: "the operation is invalid".to_owned() },
        };
        self.release(operation.0);
        Some(outcome)
    }

    /// Asks an operation to stop and releases it once native code allows; its outcome is no longer reported.
    pub fn cancel(&self, operation: ClipboardOperation) {
        unsafe { sys::ot_clipboard_operation_cancel(self.context.as_raw(), &operation.0) };
        self.release(operation.0);
    }

    fn release(&self, handle: sys::ot_handle) {
        let status = unsafe { sys::ot_clipboard_operation_destroy(self.context.as_raw(), &handle) };
        if u32::from(status) == sys::OT_CLIPBOARD_DESTROY_NOT_READY {
            self.retired.borrow_mut().push(handle);
        }
    }

    fn copy(
        &self,
        handle: &sys::ot_handle,
        length: unsafe extern "C" fn(*mut sys::ot_context, *const sys::ot_handle, *mut u32) -> u8,
        copy: unsafe extern "C" fn(*mut sys::ot_context, *const sys::ot_handle, *mut u8, u32) -> u8,
    ) -> Option<Vec<u8>> {
        let context = self.context.as_raw();
        let mut count = 0;
        if u32::from(unsafe { length(context, handle, &mut count) }) != sys::OT_CLIPBOARD_COPY_OK {
            return None;
        }
        let mut bytes = vec![0u8; count as usize];
        let status = unsafe { copy(context, handle, bytes.as_mut_ptr(), count) };
        (u32::from(status) == sys::OT_CLIPBOARD_COPY_OK).then_some(bytes)
    }

    fn representation(&self, handle: &sys::ot_handle) -> ClipboardOutcome {
        let mime = self.copy(
            handle,
            sys::ot_clipboard_operation_result_mime_length,
            sys::ot_clipboard_operation_result_mime_copy,
        );
        let data = self.copy(
            handle,
            sys::ot_clipboard_operation_result_data_length,
            sys::ot_clipboard_operation_result_data_copy,
        );
        match (mime, data) {
            (Some(mime), Some(data)) => {
                ClipboardOutcome::Read { mime_type: String::from_utf8_lossy(&mime).into_owned(), data }
            }
            _ => ClipboardOutcome::Failed { code: 0, message: "could not copy the clipboard data".to_owned() },
        }
    }

    fn failure(&self, handle: &sys::ot_handle) -> ClipboardOutcome {
        let mut code = 0;
        unsafe { sys::ot_clipboard_operation_result_error_code(self.context.as_raw(), handle, &mut code) };
        let message = self
            .copy(
                handle,
                sys::ot_clipboard_operation_result_diagnostic_length,
                sys::ot_clipboard_operation_result_diagnostic_copy,
            )
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default();
        ClipboardOutcome::Failed { code, message }
    }

    /// Runs queued service work and releases retired operations. Returns whether other apps are reading data this
    /// process provides, so the service needs another drain soon.
    pub fn drain(&self) -> bool {
        let active = unsafe { sys::ot_clipboard_service_drain(self.context.as_raw()) } == 1;
        let context = self.context.as_raw();
        self.retired.borrow_mut().retain(|handle| {
            u32::from(unsafe { sys::ot_clipboard_operation_destroy(context, handle) })
                == sys::OT_CLIPBOARD_DESTROY_NOT_READY
        });
        self.active.set(active);
        active
    }

    /// Whether the last [`Self::drain`] found transfers to other apps, or retired operations wait for release.
    pub fn needs_drain(&self) -> bool {
        self.active.get() || !self.retired.borrow().is_empty()
    }
}

impl Drop for ClipboardService {
    /// Shuts the service down, waiting up to two seconds for platform calls to return. A service still busy after
    /// that is left to the Context, whose destruction waits for it again and then leaks the Context.
    fn drop(&mut self) {
        let context = self.context.as_raw();
        unsafe { sys::ot_clipboard_service_begin_shutdown(context) };
        for _ in 0..2000 {
            self.retired.borrow_mut().retain(|handle| {
                u32::from(unsafe { sys::ot_clipboard_operation_destroy(context, handle) })
                    == sys::OT_CLIPBOARD_DESTROY_NOT_READY
            });
            let ready = u32::from(unsafe { sys::ot_clipboard_service_poll_shutdown(context) })
                == sys::OT_CLIPBOARD_SHUTDOWN_READY;
            if ready && self.retired.borrow().is_empty() {
                unsafe { sys::ot_clipboard_service_destroy(context) };
                return;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}
