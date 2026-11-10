//! The app's use of the clipboard: copies to the terminal and the host, and host reads and pastes.

use super::{App, Cx};
use crate::native::{
    CapabilityFlags, ClipboardOperation, ClipboardOptions, ClipboardOutcome, ClipboardSelection, ClipboardService,
};
use std::time::{Duration, Instant};

/// Core's defaults for host clipboard operations.
const TIMEOUT: Duration = Duration::from_secs(1);
const READ_BYTES_MAX: u32 = 8 * 1024 * 1024;

/// Poll intervals: pending operations advance only while polled; transfers to other apps need fewer drains.
const OPERATION_POLL: Duration = Duration::from_millis(1);
const PROVIDER_POLL: Duration = Duration::from_millis(8);

type Done = Box<dyn FnOnce(&mut Cx<'_>, ClipboardOutcome)>;

#[derive(Default)]
pub(super) struct HostClipboard {
    service: Option<ClipboardService>,
    /// Set once creating the service failed, so it is not retried on every use.
    unavailable: bool,
    pending: Vec<(ClipboardOperation, Done)>,
}

impl App {
    /// Starts a host clipboard operation, creating the service on first use. Hands `done` back when there is no
    /// service or the operation cannot start.
    fn start_clipboard(
        &self,
        start: impl FnOnce(&ClipboardService) -> crate::Result<ClipboardOperation>,
        done: Done,
    ) -> Result<(), Done> {
        let mut clipboard = self.0.clipboard.borrow_mut();
        if clipboard.service.is_none() && !clipboard.unavailable {
            match ClipboardService::new(self.0.session.context(), ClipboardOptions::default()) {
                Ok(service) => clipboard.service = Some(service),
                Err(_) => clipboard.unavailable = true,
            }
        }
        match clipboard.service.as_ref().map(start) {
            Some(Ok(operation)) => {
                clipboard.pending.push((operation, done));
                Ok(())
            }
            _ => Err(done),
        }
    }

    /// Copies text to the user's clipboard through every destination available, as Core's `all-available` policy
    /// does: the terminal (OSC 52), which works over SSH and keeps the text after the app exits, and, when the
    /// session is local, the system clipboard too. Returns `false` when neither took the text, for empty text, or
    /// without a running terminal, as in tests. A system clipboard write is asynchronous: `true` means it started. A
    /// running [headless](App::headless) app hands the text to its [`App::on_headless_write`] handlers instead.
    pub fn copy_to_clipboard(&self, text: &str) -> bool {
        if self.is_headless() {
            return !text.is_empty() && self.headless_write(super::HeadlessWrite::Clipboard(text.to_owned()));
        }
        if !self.0.terminal_active.get() || text.is_empty() {
            return false;
        }
        let terminal =
            self.report(self.0.session.set_clipboard(ClipboardSelection::Clipboard, text.as_bytes())).unwrap_or(false);
        let host = self.copy_to_host_clipboard(text);
        terminal || host
    }

    /// Reads the system clipboard of the machine the app runs on as the first available of `mime_types`, such as
    /// `["image/png", "text/plain"]`, then calls `handler` on the UI thread with the outcome. A
    /// [`ClipboardOutcome::Read`] names the type it found.
    ///
    /// The handler gets [`ClipboardOutcome::Unsupported`] without a display server, without a running terminal, as
    /// in tests, and in a [remote](App::remote) app, since the system clipboard is the server's, not the user's; the
    /// user's terminal delivers their clipboard as a paste event instead. A local app run over SSH reads the
    /// server's clipboard too. A read waits at most a second and takes at most 8 MiB.
    pub fn read_clipboard_as(
        &self,
        mime_types: &[&str],
        handler: impl FnOnce(&mut Cx<'_>, ClipboardOutcome) + 'static,
    ) {
        let done: Done = Box::new(handler);
        let read = |service: &ClipboardService| {
            service.read(mime_types, ClipboardSelection::Clipboard, READ_BYTES_MAX, TIMEOUT)
        };
        let local = self.0.terminal_active.get() && !self.is_remote();
        let started = if local { self.start_clipboard(read, done) } else { Err(done) };
        if let Err(done) = started {
            self.defer(move |cx| done(cx, ClipboardOutcome::Unsupported));
        }
    }

    /// Reads text from the system clipboard, then calls `handler` on the UI thread. The handler gets `None` when the
    /// clipboard is empty, holds no text, or cannot be read; see [`Self::read_clipboard_as`].
    pub fn read_clipboard(&self, handler: impl FnOnce(&mut Cx<'_>, Option<String>) + 'static) {
        self.read_clipboard_as(&["text/plain"], move |cx, outcome| {
            let text = match outcome {
                ClipboardOutcome::Read { data, .. } => String::from_utf8(data).ok().filter(|text| !text.is_empty()),
                _ => None,
            };
            handler(cx, text);
        });
    }

    /// Reads the system clipboard and delivers its text to the focused widget as a paste. See
    /// [`Self::read_clipboard`] for when there is nothing to paste.
    pub fn paste_from_clipboard(&self) {
        self.read_clipboard(|cx, text| {
            if let Some(text) = text {
                cx.app().dispatch_paste(&text);
            }
        });
    }

    /// Puts text on the host clipboard when the session is local. Returns whether the write started.
    fn copy_to_host_clipboard(&self, text: &str) -> bool {
        let remote = self.is_remote()
            || self
                .report(self.0.session.capabilities())
                .is_none_or(|capabilities| capabilities.flags.contains(CapabilityFlags::REMOTE));
        if remote {
            return false;
        }
        let text = text.to_owned();
        let write = move |service: &ClipboardService| service.write_text(&text, ClipboardSelection::Clipboard, TIMEOUT);
        self.start_clipboard(write, Box::new(|_, _| {})).is_ok()
    }

    /// Advances host clipboard operations and runs the handlers of finished ones. Returns when it needs to run
    /// again, in real time.
    pub(crate) fn pump_clipboard(&self) -> Option<Instant> {
        let (finished, wait) = {
            let mut clipboard = self.0.clipboard.borrow_mut();
            let clipboard = &mut *clipboard;
            let service = clipboard.service.as_ref()?;
            service.drain();
            let mut finished = Vec::new();
            for (operation, done) in std::mem::take(&mut clipboard.pending) {
                match service.poll(operation) {
                    Some(outcome) => finished.push((done, outcome)),
                    None => clipboard.pending.push((operation, done)),
                }
            }
            let wait = if !clipboard.pending.is_empty() {
                Some(OPERATION_POLL)
            } else if service.needs_drain() {
                Some(PROVIDER_POLL)
            } else {
                None
            };
            (finished, wait)
        };
        for (done, outcome) in finished {
            done(&mut Cx::new(self), outcome);
        }
        self.drain_deferred();
        wait.and_then(|wait| Instant::now().checked_add(wait))
    }

    /// Cancels pending operations and shuts the service down.
    pub(super) fn close_clipboard(&self) {
        let clipboard = std::mem::take(&mut *self.0.clipboard.borrow_mut());
        if let Some(service) = &clipboard.service {
            for (operation, _) in &clipboard.pending {
                service.cancel(*operation);
            }
        }
    }
}
