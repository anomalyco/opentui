//! The local terminal: raw mode, size, signals, and wakeups, on Unix (Linux and macOS) and Windows.
//!
//! Native code renders and encodes output; this module only configures the terminal and turns OS notifications into
//! things one wait in the event loop can watch: file descriptors and `poll` on Unix, handles and
//! `WaitForMultipleObjects` on Windows.

use crate::style::Color;
use crate::theme::ThemeMode;
use std::io;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(unix)]
pub(crate) mod unix;
#[cfg(unix)]
use unix as os;
#[cfg(windows)]
pub(crate) mod windows;
#[cfg(windows)]
use windows as os;

pub use os::{Signals, Terminal, Waker, read, size, stop_process};
pub(crate) use os::{WakePipe, restore_stderr, wait, wait_wakes, wait_writable};

/// A process signal the host reacts to. Windows reports console control events and window size changes as these;
/// it has no job control, so it never reports [`Signal::Suspend`] or [`Signal::Continue`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    Resize,
    Interrupt,
    Terminate,
    Hangup,
    Suspend,
    Continue,
}

/// What [`wait`] found ready.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Ready {
    pub signals: bool,
    pub wake: bool,
    pub input: bool,
}

/// The terminal's default colors, as it reports them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TerminalColors {
    pub foreground: Option<Color>,
    pub background: Option<Color>,
}

impl TerminalColors {
    /// Dark or light, from the background color.
    pub fn mode(&self) -> Option<ThemeMode> {
        self.background.map(ThemeMode::from_background)
    }
}

/// Asks the terminal for its default foreground and background colors (OSC 10 and 11) and waits up to `timeout` for
/// the answer.
///
/// A device attributes query follows the color queries; every terminal answers it, so the wait usually lasts one
/// round trip, and colors a terminal does not report stay `None`. Returns `Ok(None)` when stdin or stdout is not a
/// terminal. Call it while nothing else reads the terminal, such as before [`App::run`](crate::App::run): keys
/// typed meanwhile are discarded. [`App::new`](crate::App::new) calls it when
/// [`AppOptions::light_theme`](crate::AppOptions::light_theme) is set.
pub fn query_colors(timeout: Duration) -> io::Result<Option<TerminalColors>> {
    let Some(mut port) = LocalPort::open()? else { return Ok(None) };
    colors_on(&mut port, timeout).map(Some)
}

/// [`query_colors`] over any port.
pub(crate) fn colors_on(port: &mut impl QueryPort, timeout: Duration) -> io::Result<TerminalColors> {
    use crate::input::{ThemeColor, theme_color};
    let mut colors = TerminalColors::default();
    query(port, b"\x1b]10;?\x07\x1b]11;?\x07", timeout, |reply| match theme_color(reply) {
        Some(ThemeColor::Foreground(color)) => colors.foreground = Some(color),
        Some(ThemeColor::Background(color)) => colors.background = Some(color),
        None => {}
    })?;
    Ok(colors)
}

/// The colors a terminal reports: its palette, default foreground and background, and cursor.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TerminalPalette {
    /// Palette entries from index 0; `None` for an entry the terminal did not report.
    pub colors: Vec<Option<Color>>,
    pub foreground: Option<Color>,
    pub background: Option<Color>,
    pub cursor: Option<Color>,
}

impl TerminalPalette {
    /// Dark or light, from the background color.
    pub fn mode(&self) -> Option<ThemeMode> {
        self.background.map(ThemeMode::from_background)
    }
}

/// Asks the terminal for its first `size` palette colors (OSC 4, at most 256) and its default and cursor colors
/// (OSC 10, 11, 12), with the same rules as [`query_colors`]. Core asks the same questions with `getPalette`.
pub fn query_palette(size: u16, timeout: Duration) -> io::Result<Option<TerminalPalette>> {
    let Some(mut port) = LocalPort::open()? else { return Ok(None) };
    palette_on(&mut port, size, timeout).map(Some)
}

/// [`query_palette`] over any port.
pub(crate) fn palette_on(port: &mut impl QueryPort, size: u16, timeout: Duration) -> io::Result<TerminalPalette> {
    use crate::input::{OscColor, osc_color};
    let size = size.min(256);
    let mut request: Vec<u8> = (0..size).flat_map(|index| format!("\x1b]4;{index};?\x07").into_bytes()).collect();
    request.extend_from_slice(b"\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07");
    let mut palette = TerminalPalette { colors: vec![None; usize::from(size)], ..Default::default() };
    query(port, &request, timeout, |reply| match osc_color(reply) {
        Some(OscColor::Palette(index, color)) => {
            if let Some(slot) = palette.colors.get_mut(usize::from(index)) {
                *slot = Some(color);
            }
        }
        Some(OscColor::Foreground(color)) => palette.foreground = Some(color),
        Some(OscColor::Background(color)) => palette.background = Some(color),
        Some(OscColor::Cursor(color)) => palette.cursor = Some(color),
        None => {}
    })?;
    Ok(palette)
}

/// Where a terminal query goes: the local terminal, or a [`RemoteTerminal`](crate::remote::RemoteTerminal).
pub(crate) trait QueryPort {
    /// Writes all of `bytes`, giving up at `deadline`; `None` never gives up.
    fn write_all(&mut self, bytes: &[u8], deadline: Option<Instant>) -> io::Result<()>;
    /// Waits up to `timeout` for input. Returns whether there is some.
    fn wait_input(&mut self, timeout: Duration) -> io::Result<bool>;
    /// Reads available input. Returns `Ok(None)` when nothing is ready and `Ok(Some(0))` at end of input.
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<Option<usize>>;
}

/// The local terminal in raw mode for queries; dropping it restores the terminal.
pub(crate) struct LocalPort {
    _terminal: Terminal,
}

impl LocalPort {
    /// Enters raw mode. Returns `None` when stdin or stdout is not a terminal.
    pub(crate) fn open() -> io::Result<Option<Self>> {
        match Terminal::open() {
            Ok(terminal) => Ok(Some(Self { _terminal: terminal })),
            Err(error) if os::is_not_terminal(&error) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

impl QueryPort for LocalPort {
    fn write_all(&mut self, bytes: &[u8], deadline: Option<Instant>) -> io::Result<()> {
        os::write_all(bytes, deadline)
    }

    fn wait_input(&mut self, timeout: Duration) -> io::Result<bool> {
        os::wait_input(timeout)
    }

    fn read(&mut self, bytes: &mut [u8]) -> io::Result<Option<usize>> {
        read(bytes)
    }
}

/// Writes `request` followed by a device attributes query, then hands each reply to `on_reply` until the terminal
/// answers that query or `timeout` passes. Other input is discarded.
fn query(
    port: &mut impl QueryPort,
    request: &[u8],
    timeout: Duration,
    mut on_reply: impl FnMut(&[u8]),
) -> io::Result<()> {
    use crate::input::{Expectations, Input, Parser, is_device_attributes};
    // No Session exists yet. A reply split across reads waits for its rest instead of being cut short.
    let (mut parser, mut inputs) = (Parser::standalone().map_err(io::Error::other)?, Vec::new());
    parser.set_expectations(Expectations::REPLIES, Instant::now(), &mut inputs).map_err(io::Error::other)?;
    // A timeout too long to represent never passes.
    let deadline = Instant::now().checked_add(timeout);
    port.write_all(request, deadline)?;
    port.write_all(b"\x1b[c", deadline)?;
    let mut bytes = [0u8; 4096];
    loop {
        let left = deadline.map_or(Duration::MAX, |deadline| deadline.saturating_duration_since(Instant::now()));
        if left.is_zero() {
            return Ok(());
        }
        if !port.wait_input(left)? {
            continue;
        }
        match port.read(&mut bytes)? {
            Some(0) => return Ok(()),
            Some(count) => parser.feed(&bytes[..count], Instant::now(), &mut inputs).map_err(io::Error::other)?,
            None => continue,
        }
        for input in inputs.drain(..) {
            let Input::Reply(reply) = input else { continue };
            if is_device_attributes(&reply) {
                return Ok(());
            }
            on_reply(&reply);
        }
    }
}

/// Captured stderr text kept for writing to the real stderr afterwards, at most this many bytes.
const STDERR_KEEP_MAX: usize = 1 << 20;

/// The reading end of the pipe stderr goes to while captured.
trait CapturePipe: Send + Sync + 'static {
    /// Waits until the pipe holds bytes or reaches end of file.
    fn wait(&self) -> io::Result<()>;
    /// Reads what the pipe holds without waiting. Returns the count, `Ok(0)` at end of file, or `WouldBlock`.
    fn read_now(&self, bytes: &mut [u8]) -> io::Result<usize>;
}

/// Redirects the process's stderr into a pipe while the terminal is in use, so stray writes cannot corrupt the
/// screen. A thread hands each line to a callback; [`Self::stop`] puts the real stderr back and returns what was
/// written, up to 1 MiB.
pub(crate) struct StderrCapture {
    pipe: Arc<dyn CapturePipe>,
    state: Arc<Mutex<CaptureState>>,
}

/// What the capture thread and [`StderrCapture::stop`] share. Reads from the pipe happen only under its lock, so
/// `stop` sees every byte read so far and drains the rest itself.
#[derive(Default)]
struct CaptureState {
    kept: Vec<u8>,
    stopped: bool,
}

impl CaptureState {
    fn keep(&mut self, chunk: &[u8]) {
        let room = STDERR_KEEP_MAX.saturating_sub(self.kept.len());
        self.kept.extend_from_slice(&chunk[..chunk.len().min(room)]);
    }
}

impl StderrCapture {
    pub fn start(mut on_line: impl FnMut(String) + Send + 'static) -> io::Result<Self> {
        let pipe: Arc<dyn CapturePipe> = Arc::new(os::redirect_stderr()?);
        let state = Arc::new(Mutex::new(CaptureState::default()));
        let (reader, shared) = (Arc::clone(&pipe), Arc::clone(&state));
        // The thread ends at `stop`, or when every write end closes.
        std::thread::Builder::new().name("opentui-stderr".into()).spawn(move || {
            let mut bytes = [0u8; 4096];
            let mut line = Vec::new();
            loop {
                if reader.wait().is_err() {
                    break;
                }
                let count = {
                    let Ok(mut state) = shared.lock() else { return };
                    match reader.read_now(&mut bytes) {
                        Ok(0) => break,
                        // Children that inherited the pipe can still write after `stop`; their text is dropped
                        // rather than left to fill the pipe and block them.
                        Ok(_) if state.stopped => continue,
                        Ok(count) => {
                            state.keep(&bytes[..count]);
                            count
                        }
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
                        Err(_) => break,
                    }
                };
                for &byte in &bytes[..count] {
                    if byte == b'\n' {
                        let mut text = std::mem::take(&mut line);
                        // Windows programs end lines with CRLF.
                        if text.last() == Some(&b'\r') {
                            text.pop();
                        }
                        let text = String::from_utf8_lossy(&text).into_owned();
                        if shared.lock().is_ok_and(|state| !state.stopped) {
                            on_line(text);
                        }
                    } else if line.len() < STDERR_KEEP_MAX {
                        line.push(byte);
                    }
                }
            }
            if !line.is_empty() && shared.lock().is_ok_and(|state| !state.stopped) {
                on_line(String::from_utf8_lossy(&line).into_owned());
            }
        })?;
        Ok(Self { pipe, state })
    }

    /// Puts the real stderr back and returns the text written meanwhile. Lines still unread are kept but no longer
    /// reach the callback.
    pub fn stop(self) -> Vec<u8> {
        restore_stderr();
        let Ok(mut state) = self.state.lock() else { return Vec::new() };
        state.stopped = true;
        let mut bytes = [0u8; 4096];
        while let Ok(count @ 1..) = self.pipe.read_now(&mut bytes) {
            state.keep(&bytes[..count]);
        }
        std::mem::take(&mut state.kept)
    }
}

impl Drop for StderrCapture {
    fn drop(&mut self) {
        restore_stderr();
        if let Ok(mut state) = self.state.lock() {
            state.stopped = true;
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Serializes tests that redirect the process's stderr.
    pub(crate) static STDERR_LOCK: Mutex<()> = Mutex::new(());

    /// Writes straight to the process's stderr: the test harness captures `eprintln!`, not the descriptor or handle.
    pub(crate) use super::os::tests::write_stderr;

    // Expected: `StderrCapture::stop` returns everything written to stderr before it was called, so `App::run` can
    // write all of it to the real stderr afterwards.
    // Actual: `stop` restored the descriptor and took the kept bytes at once, without draining the pipe, so text
    // still in the pipe (here, because the reader is busy with an earlier line) was lost; the reader later handed it
    // to the console of an app that was gone.
    #[test]
    fn stderr_capture_stop_loses_text_the_reader_has_not_read_yet() {
        use std::sync::mpsc;
        let _guard = STDERR_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let (lines_tx, lines_rx) = mpsc::channel();
        let mut first = true;
        let capture = StderrCapture::start(move |line| {
            if std::mem::take(&mut first) {
                let _ = entered_tx.send(());
                // A slow line handler, as a busy console might be.
                let _ = release_rx.recv_timeout(Duration::from_secs(5));
            }
            let _ = lines_tx.send(line);
        })
        .expect("start capturing stderr");
        write_stderr(b"capture-first\n");
        entered_rx.recv_timeout(Duration::from_secs(5)).expect("the reader saw the first line");
        write_stderr(b"capture-second\n");
        let kept = capture.stop();
        let _ = release_tx.send(());
        let kept = String::from_utf8_lossy(&kept);
        assert!(kept.contains("capture-first"), "{kept:?}");
        assert!(kept.contains("capture-second"), "{kept:?}");
        // Lines read after `stop` no longer reach the callback.
        assert_eq!(lines_rx.recv_timeout(Duration::from_secs(5)).as_deref(), Ok("capture-first"));
        assert!(lines_rx.recv_timeout(Duration::from_millis(50)).is_err());
    }
}
