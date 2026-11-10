//! A terminal at the other end of a connection, such as an SSH channel.
//!
//! An app normally runs on its own process's terminal. A [`RemoteTerminal`] stands in for a terminal that a transport
//! reaches instead. The transport holds the matching [`RemoteLink`]: it passes the client's input and window size to
//! the app and sends the app's output to the client. The app and the transport run on separate threads, and the link
//! calls a function the transport supplies whenever there is output to send or room for more input.
//!
//! [`App::remote`](crate::App::remote) runs an app on a remote terminal, and
//! [`Host::start_remote`](crate::host::Host::start_remote) a lower-level host. A remote app never touches the local
//! terminal, signals, or stderr, so one process can run many, one per thread. The `opentui-ssh` crate serves apps
//! over SSH this way.
//!
//! ```no_run
//! use opentui::prelude::*;
//! use opentui::remote::{RemoteOptions, RemoteTerminal};
//! use std::sync::mpsc;
//!
//! fn main() -> opentui::Result<()> {
//!     let (wake, woken) = mpsc::channel();
//!     let (terminal, link) = RemoteTerminal::new(RemoteOptions::default(), move || {
//!         let _ = wake.send(());
//!     })?;
//!     let app_thread = std::thread::spawn(move || -> opentui::Result<()> {
//!         let app = App::remote(terminal, AppOptions::default())?;
//!         app.root().add(&Text::new(&app, "Hello from the other end"));
//!         app.run()
//!     });
//!     // The transport: pass the client's bytes to `link.send_input` and its window size to `link.resize`, and send
//!     // what `link.take_output` returns to the client, until the app quits. One wake can stand for more output than
//!     // one call takes, so take all of it before waiting for the next wake.
//!     while !link.is_finished() {
//!         let _ = woken.recv();
//!         loop {
//!             let output = link.take_output(64 * 1024);
//!             if output.is_empty() {
//!                 break;
//!             }
//!             // ... send `output` to the client ...
//!         }
//!     }
//!     app_thread.join().expect("the app thread panicked")
//! }
//! ```

use crate::term::{QueryPort, WakePipe, Waker, wait_wakes};
use std::collections::VecDeque;
use std::io;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

/// The most client input a remote terminal holds for the app.
pub const INPUT_BYTES_MAX: usize = 256 * 1024;
/// The most app output a remote terminal holds for the transport.
pub const OUTPUT_BYTES_MAX: usize = 256 * 1024;

/// What a [`RemoteTerminal`] starts with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteOptions {
    /// The client's terminal size in cells. A zero dimension counts as 80 columns or 24 rows.
    pub width: u16,
    pub height: u16,
    /// Terminal hints for the renderer, such as `TERM` and `COLORTERM` from the client. A remote app never uses the
    /// process's own environment.
    pub environment: Vec<(String, String)>,
}

impl Default for RemoteOptions {
    /// 80 by 24 cells and `TERM=xterm-256color`.
    fn default() -> Self {
        Self { width: 80, height: 24, environment: vec![("TERM".into(), "xterm-256color".into())] }
    }
}

/// When `timeout` from now ends; `None` when that is too far off to represent, which counts as never.
fn deadline(timeout: Duration) -> Option<Instant> {
    Instant::now().checked_add(timeout)
}

/// What is left until `deadline`, for a wait; `None` waits indefinitely.
fn remaining(deadline: Option<Instant>) -> Option<Duration> {
    deadline.map(|deadline| deadline.saturating_duration_since(Instant::now()))
}

fn size_or_default((width, height): (u16, u16)) -> (u16, u16) {
    (if width == 0 { 80 } else { width }, if height == 0 { 24 } else { height })
}

#[derive(Default)]
struct State {
    input: VecDeque<u8>,
    output: VecDeque<u8>,
    size: (u16, u16),
    resized: bool,
    /// The transport asked the app to end.
    terminate: bool,
    /// The client is gone.
    disconnected: bool,
    /// The app is done with the terminal.
    finished: bool,
    /// The app's output did not fit; the transport wakes it after taking some.
    app_waiting: bool,
    /// The transport's input did not fit; the app wakes it after reading some.
    transport_waiting: bool,
    /// The app's [`HostOptions::close_bound`](crate::host::HostOptions::close_bound).
    close_bound: Duration,
}

impl State {
    /// Whether reading input returns something: bytes, or the end of input.
    fn readable(&self) -> bool {
        !self.input.is_empty() || self.disconnected
    }
}

struct Shared {
    state: Mutex<State>,
    app: Waker,
    transport: Box<dyn Fn() + Send + Sync>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn wake_transport(&self) {
        (self.transport)();
    }
}

/// The app's side of a remote terminal. See the [module documentation](self).
pub struct RemoteTerminal {
    shared: Arc<Shared>,
    wake: WakePipe,
    environment: Vec<(String, String)>,
}

impl std::fmt::Debug for RemoteTerminal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("RemoteTerminal").field("size", &self.size()).finish_non_exhaustive()
    }
}

impl RemoteTerminal {
    /// Creates a remote terminal and the link its transport uses.
    ///
    /// `wake_transport` runs whenever the transport has something to do: output to send, room for input that did not
    /// fit before, or the app finishing. It runs on the app's thread, so it must return quickly and must not panic;
    /// waking a task, as `tokio::sync::Notify::notify_one` does, is typical.
    ///
    /// It runs once per change, not until the transport catches up: one write of output wakes the transport once,
    /// however much it queued. After a wake, call [`RemoteLink::take_output`] until it returns nothing, and offer
    /// held-back input again; otherwise output can wait forever for a wake that already came.
    pub fn new(
        options: RemoteOptions,
        wake_transport: impl Fn() + Send + Sync + 'static,
    ) -> io::Result<(Self, RemoteLink)> {
        let wake = WakePipe::new()?;
        let state = State {
            size: size_or_default((options.width, options.height)),
            close_bound: crate::host::HostOptions::default().close_bound(),
            ..Default::default()
        };
        let shared =
            Arc::new(Shared { state: Mutex::new(state), app: wake.waker(), transport: Box::new(wake_transport) });
        let terminal = Self { shared: Arc::clone(&shared), wake, environment: options.environment };
        Ok((terminal, RemoteLink { shared }))
    }

    /// The client's terminal size in cells, as last reported.
    pub fn size(&self) -> (u16, u16) {
        self.shared.lock().size
    }

    /// The terminal hints from [`RemoteOptions::environment`].
    pub fn environment(&self) -> &[(String, String)] {
        &self.environment
    }

    /// Writes bytes straight to the client outside any app, such as a message before an app starts or instead of
    /// one. Waits up to `timeout` for room, then fails with [`io::ErrorKind::TimedOut`], having written part of
    /// `bytes`. Bytes for a client that is gone are discarded.
    pub fn write(&self, bytes: &[u8], timeout: Duration) -> io::Result<()> {
        self.write_all(bytes, deadline(timeout))
    }

    fn write_all(&self, mut bytes: &[u8], deadline: Option<Instant>) -> io::Result<()> {
        while !bytes.is_empty() {
            bytes = &bytes[self.write_output(bytes)..];
            if !bytes.is_empty() && !self.wait_room_until(deadline) {
                return Err(io::ErrorKind::TimedOut.into());
            }
        }
        Ok(())
    }

    /// What the app waits on: the transport sets it after input, a resize, a request to end, or room for output.
    pub(crate) fn wake_pipe(&self) -> &WakePipe {
        &self.wake
    }

    /// Copies unread input into `bytes`. Returns `None` when there is none, and `Some(0)`, on every call, once the
    /// client is gone and all input sent before it left has been read.
    pub(crate) fn read_input(&self, bytes: &mut [u8]) -> Option<usize> {
        let (count, wake) = {
            let mut state = self.shared.lock();
            if state.input.is_empty() {
                return state.disconnected.then_some(0);
            }
            let count = bytes.len().min(state.input.len());
            for (slot, byte) in bytes.iter_mut().zip(state.input.drain(..count)) {
                *slot = byte;
            }
            (count, std::mem::take(&mut state.transport_waiting))
        };
        if wake {
            self.shared.wake_transport();
        }
        Some(count)
    }

    /// Queues output for the transport, as much as fits. Returns the count accepted, zero when the buffer is full.
    /// Output for a client that is gone is discarded and counts as accepted.
    pub(crate) fn write_output(&self, bytes: &[u8]) -> usize {
        let count = {
            let mut state = self.shared.lock();
            if state.disconnected {
                return bytes.len();
            }
            let count = bytes.len().min(OUTPUT_BYTES_MAX.saturating_sub(state.output.len()));
            state.output.extend(&bytes[..count]);
            state.app_waiting |= count < bytes.len();
            count
        };
        if count > 0 {
            self.shared.wake_transport();
        }
        count
    }

    /// Whether output fits, or the client is gone. When it does not fit, the transport wakes the app after taking
    /// some.
    pub(crate) fn has_room(&self) -> bool {
        let mut state = self.shared.lock();
        let room = state.disconnected || state.output.len() < OUTPUT_BYTES_MAX;
        state.app_waiting |= !room;
        room
    }

    /// Waits up to `timeout` for room for output. Returns whether there is room.
    pub(crate) fn wait_room(&self, timeout: Duration) -> bool {
        self.wait_room_until(deadline(timeout))
    }

    fn wait_room_until(&self, deadline: Option<Instant>) -> bool {
        loop {
            self.wake.drain();
            if self.has_room() {
                return true;
            }
            let left = remaining(deadline);
            if left.is_some_and(|left| left.is_zero()) || wait_wakes([&self.wake], left).is_err() {
                return false;
            }
        }
    }

    /// Whether reading input returns something: bytes, or the end of input.
    pub(crate) fn readable(&self) -> bool {
        self.shared.lock().readable()
    }

    /// Whether the client resized its terminal or the transport asked the app to end, since the last calls to
    /// [`Self::take_resize`] and [`Self::take_terminate`].
    pub(crate) fn has_events(&self) -> bool {
        let state = self.shared.lock();
        state.resized || state.terminate
    }

    /// The new size, if the client reported one since the last call.
    pub(crate) fn take_resize(&self) -> Option<(u16, u16)> {
        let mut state = self.shared.lock();
        std::mem::take(&mut state.resized).then_some(state.size)
    }

    /// Whether the transport asked the app to end since the last call.
    pub(crate) fn take_terminate(&self) -> bool {
        std::mem::take(&mut self.shared.lock().terminate)
    }

    pub(crate) fn set_close_bound(&self, bound: Duration) {
        self.shared.lock().close_bound = bound;
    }
}

impl Drop for RemoteTerminal {
    fn drop(&mut self) {
        {
            let mut state = self.shared.lock();
            state.finished = true;
            state.input.clear();
        }
        self.shared.wake_transport();
    }
}

impl QueryPort for RemoteTerminal {
    fn write_all(&mut self, bytes: &[u8], deadline: Option<Instant>) -> io::Result<()> {
        RemoteTerminal::write_all(self, bytes, deadline)
    }

    fn wait_input(&mut self, timeout: Duration) -> io::Result<bool> {
        let deadline = deadline(timeout);
        loop {
            self.wake.drain();
            if self.readable() {
                return Ok(true);
            }
            let left = remaining(deadline);
            if left.is_some_and(|left| left.is_zero()) {
                return Ok(false);
            }
            wait_wakes([&self.wake], left)?;
        }
    }

    fn read(&mut self, bytes: &mut [u8]) -> io::Result<Option<usize>> {
        Ok(self.read_input(bytes))
    }
}

/// The transport's side of a remote terminal: it passes the client's input and window size to the app and takes the
/// app's output. Clones share the link, and any thread can use it. See the [module documentation](self).
#[derive(Clone)]
pub struct RemoteLink {
    shared: Arc<Shared>,
}

impl std::fmt::Debug for RemoteLink {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("RemoteLink").field("finished", &self.is_finished()).finish_non_exhaustive()
    }
}

impl RemoteLink {
    /// Passes client input to the app, as much as fits: the app holds at most [`INPUT_BYTES_MAX`] unread bytes.
    /// Returns the count accepted. Fewer than `bytes.len()` means the app is behind; offer the rest after the next
    /// wake. Input for an app that has finished, or after [`Self::disconnect`], is discarded and counts as accepted.
    pub fn send_input(&self, bytes: &[u8]) -> usize {
        let count = {
            let mut state = self.shared.lock();
            if state.finished || state.disconnected {
                return bytes.len();
            }
            let count = bytes.len().min(INPUT_BYTES_MAX.saturating_sub(state.input.len()));
            state.input.extend(&bytes[..count]);
            state.transport_waiting |= count < bytes.len();
            count
        };
        if count > 0 {
            self.shared.app.wake();
        }
        count
    }

    /// Removes and returns up to `max` bytes of the app's output, oldest first. Empty when there is none.
    pub fn take_output(&self, max: usize) -> Vec<u8> {
        let (output, wake) = {
            let mut state = self.shared.lock();
            let count = max.min(state.output.len());
            let output: Vec<u8> = state.output.drain(..count).collect();
            (output, count > 0 && std::mem::take(&mut state.app_waiting))
        };
        if wake {
            self.shared.app.wake();
        }
        output
    }

    /// Tells the app the client's terminal changed size. A zero dimension counts as 80 columns or 24 rows.
    pub fn resize(&self, width: u16, height: u16) {
        {
            let mut state = self.shared.lock();
            state.size = size_or_default((width, height));
            state.resized = true;
        }
        self.shared.app.wake();
    }

    /// Asks the app to end, as a terminating signal asks a local app: it sees
    /// [`Event::Terminate`](crate::input::Event::Terminate), restores the client's terminal, and finishes. Output
    /// keeps flowing until then.
    pub fn terminate(&self) {
        self.shared.lock().terminate = true;
        self.shared.app.wake();
    }

    /// Tells the app the client is gone. Once the app reads the input sent before, its input ends and it sees
    /// [`Event::Terminate`](crate::input::Event::Terminate). Output is discarded from now on.
    pub fn disconnect(&self) {
        {
            let mut state = self.shared.lock();
            state.disconnected = true;
            state.output.clear();
        }
        self.shared.app.wake();
    }

    /// How long the app may take to restore the client's terminal once asked to end: the
    /// [`HostOptions::close_bound`](crate::host::HostOptions::close_bound) of the app the terminal runs, or of the
    /// default options until one starts. A transport that gives up on an ending app should wait at least this long,
    /// so that a slow client still gets its terminal back.
    pub fn close_bound(&self) -> Duration {
        self.shared.lock().close_bound
    }

    /// Whether the app is done with the terminal, because its [`RemoteTerminal`] was dropped, and all of its output
    /// has been taken.
    pub fn is_finished(&self) -> bool {
        let state = self.shared.lock();
        state.finished && state.output.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn pair() -> (RemoteTerminal, RemoteLink, Arc<AtomicUsize>) {
        let wakes = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&wakes);
        let (terminal, link) =
            RemoteTerminal::new(RemoteOptions { width: 0, height: 0, environment: Vec::new() }, move || {
                counter.fetch_add(1, Ordering::SeqCst);
            })
            .expect("create a remote terminal");
        (terminal, link, wakes)
    }

    #[test]
    fn zero_sizes_count_as_80_by_24() {
        let (terminal, link, _) = pair();
        assert_eq!(terminal.size(), (80, 24));
        link.resize(100, 0);
        assert_eq!(terminal.take_resize(), Some((100, 24)));
        assert_eq!(terminal.take_resize(), None);
    }

    #[test]
    fn input_is_bounded_and_reading_wakes_a_waiting_transport() {
        let (terminal, link, wakes) = pair();
        let bytes = vec![b'x'; INPUT_BYTES_MAX + 10];
        assert_eq!(link.send_input(&bytes), INPUT_BYTES_MAX);
        assert!(terminal.wake_pipe().drain(), "input wakes the app");
        assert!(terminal.readable());
        let mut buffer = vec![0; 4096];
        assert_eq!(terminal.read_input(&mut buffer), Some(4096));
        assert_eq!(wakes.load(Ordering::SeqCst), 1, "the transport waits for room");
        assert_eq!(link.send_input(&bytes[INPUT_BYTES_MAX..]), 10);
        // Reading again wakes nobody: the transport is no longer waiting.
        assert_eq!(terminal.read_input(&mut buffer), Some(4096));
        assert_eq!(wakes.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn output_is_bounded_and_taking_wakes_a_waiting_app() {
        let (terminal, link, wakes) = pair();
        let bytes = vec![b'y'; OUTPUT_BYTES_MAX + 5];
        assert_eq!(terminal.write_output(&bytes), OUTPUT_BYTES_MAX);
        assert_eq!(wakes.load(Ordering::SeqCst), 1, "output wakes the transport");
        assert_eq!(terminal.write_output(&bytes), 0);
        assert!(!terminal.has_room());
        assert!(!terminal.wake_pipe().drain());
        assert_eq!(link.take_output(10).len(), 10);
        assert!(terminal.wake_pipe().drain(), "room wakes the app");
        assert!(terminal.wait_room(Duration::ZERO));
        assert_eq!(link.take_output(usize::MAX).len(), OUTPUT_BYTES_MAX - 10);
        assert!(link.take_output(10).is_empty());
    }

    #[test]
    fn a_full_buffer_without_a_short_write_still_wakes_the_app() {
        let (terminal, link, _) = pair();
        assert_eq!(terminal.write_output(&vec![0; OUTPUT_BYTES_MAX]), OUTPUT_BYTES_MAX);
        let waiter = std::thread::spawn(move || (terminal.wait_room(Duration::from_secs(5)), terminal));
        std::thread::sleep(Duration::from_millis(20));
        link.take_output(1);
        let (room, _terminal) = waiter.join().expect("the waiting thread");
        assert!(room);
    }

    #[test]
    fn disconnecting_ends_input_for_good_and_discards_output() {
        let (terminal, link, _) = pair();
        link.send_input(b"ab");
        terminal.write_output(b"frame");
        link.disconnect();
        assert!(link.take_output(100).is_empty());
        assert_eq!(terminal.write_output(b"more"), 4);
        assert!(link.take_output(100).is_empty());
        let mut buffer = [0; 8];
        assert_eq!(terminal.read_input(&mut buffer), Some(2), "input sent before the disconnect still arrives");
        // Every later read sees the end, so a reader that consumed it once, such as a color query, hides it from
        // nobody after it.
        assert_eq!(terminal.read_input(&mut buffer), Some(0));
        assert_eq!(terminal.read_input(&mut buffer), Some(0));
        assert!(terminal.readable());
        assert!(!terminal.has_events());
        assert_eq!(link.send_input(b"late"), 4);
        assert_eq!(terminal.read_input(&mut buffer), Some(0));
    }

    #[test]
    fn the_link_finishes_once_the_terminal_drops_and_output_is_taken() {
        let (terminal, link, wakes) = pair();
        terminal.write_output(b"bye");
        link.terminate();
        assert!(terminal.has_events());
        assert!(terminal.take_terminate());
        assert!(!terminal.take_terminate());
        drop(terminal);
        assert_eq!(wakes.load(Ordering::SeqCst), 2);
        assert!(!link.is_finished());
        assert_eq!(link.take_output(100), b"bye");
        assert!(link.is_finished());
        assert_eq!(link.send_input(b"ignored"), 7);
    }
}
