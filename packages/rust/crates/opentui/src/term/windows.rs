//! The Windows backend: console modes with virtual terminal input and output, input records, console control
//! events, and event objects that one `WaitForMultipleObjects` waits on. Needs Windows 10 1809 or later.
//!
//! In virtual terminal input mode the console turns keys and mouse reports into the same escape sequences a Unix
//! terminal sends, one key record per character, so the shared parser reads them unchanged.

use super::{CapturePipe, Ready, Signal};
use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, IntoRawHandle, OwnedHandle};
use std::ptr::{null, null_mut};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{CloseHandle, ERROR_BROKEN_PIPE, HANDLE, WAIT_FAILED, WAIT_OBJECT_0};
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows_sys::Win32::System::Console::{
    CONSOLE_MODE, CONSOLE_SCREEN_BUFFER_INFO, CTRL_BREAK_EVENT, CTRL_C_EVENT, CTRL_CLOSE_EVENT, CTRL_LOGOFF_EVENT,
    CTRL_SHUTDOWN_EVENT, DISABLE_NEWLINE_AUTO_RETURN, ENABLE_ECHO_INPUT, ENABLE_EXTENDED_FLAGS, ENABLE_LINE_INPUT,
    ENABLE_MOUSE_INPUT, ENABLE_PROCESSED_INPUT, ENABLE_PROCESSED_OUTPUT, ENABLE_QUICK_EDIT_MODE,
    ENABLE_VIRTUAL_TERMINAL_INPUT, ENABLE_VIRTUAL_TERMINAL_PROCESSING, ENABLE_WINDOW_INPUT, GetConsoleMode,
    GetConsoleScreenBufferInfo, GetNumberOfConsoleInputEvents, GetStdHandle, INPUT_RECORD, KEY_EVENT,
    ReadConsoleInputW, STD_ERROR_HANDLE, STD_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, SetConsoleCtrlHandler,
    SetConsoleMode, SetStdHandle, WINDOW_BUFFER_SIZE_EVENT,
};
use windows_sys::Win32::System::Pipes::{CreatePipe, PeekNamedPipe};
use windows_sys::Win32::System::Threading::{
    CreateEventW, INFINITE, ResetEvent, SetEvent, Sleep, WaitForMultipleObjects, WaitForSingleObject,
};
use windows_sys::core::BOOL;

fn check(result: BOOL) -> io::Result<()> {
    if result == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
}

fn std_handle(which: STD_HANDLE) -> HANDLE {
    unsafe { GetStdHandle(which) }
}

fn console_mode(handle: HANDLE) -> io::Result<CONSOLE_MODE> {
    let mut mode = 0;
    check(unsafe { GetConsoleMode(handle, &mut mode) })?;
    Ok(mode)
}

/// Milliseconds for a Windows wait, rounded up; `INFINITE` for `None`.
pub(crate) fn millis(timeout: Option<Duration>) -> u32 {
    timeout.map_or(INFINITE, |timeout| timeout.as_nanos().div_ceil(1_000_000).min(u128::from(INFINITE - 1)) as u32)
}

/// A new manual-reset event, initially unset.
pub(crate) fn event() -> io::Result<OwnedHandle> {
    let handle = unsafe { CreateEventW(null(), 1, 0, null()) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the handle is new and owned by nothing else.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

/// Whether a waitable handle is signaled now. Consumes nothing from a manual-reset event or console input.
pub(crate) fn is_set(handle: HANDLE) -> bool {
    unsafe { WaitForSingleObject(handle, 0) == WAIT_OBJECT_0 }
}

/// The terminal size in cells: the console window, not its scrollback. Reports 80x24 for a zero dimension.
pub fn size() -> io::Result<(u16, u16)> {
    let mut info: CONSOLE_SCREEN_BUFFER_INFO = unsafe { std::mem::zeroed() };
    check(unsafe { GetConsoleScreenBufferInfo(std_handle(STD_OUTPUT_HANDLE), &mut info) })?;
    let window = info.srWindow;
    let width = u16::try_from(i32::from(window.Right) - i32::from(window.Left) + 1).unwrap_or(0);
    let height = u16::try_from(i32::from(window.Bottom) - i32::from(window.Top) + 1).unwrap_or(0);
    Ok((if width == 0 { 80 } else { width }, if height == 0 { 24 } else { height }))
}

fn not_a_terminal() -> io::Error {
    io::Error::new(io::ErrorKind::Unsupported, "stdin and stdout are not a console")
}

/// Whether `error` came from [`Terminal::open`] finding no console.
pub(super) fn is_not_terminal(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::Unsupported
}

/// Raw mode on the console, restored on drop.
///
/// Input gets virtual terminal sequences and window size events, without line editing, echo, Ctrl+C handling, or
/// Quick Edit selection, so Ctrl+C arrives as a key and the mouse reaches the app. Output interprets escape
/// sequences and defers wrapping at the last column, as xterm does.
pub struct Terminal {
    input_mode: CONSOLE_MODE,
    output_mode: CONSOLE_MODE,
    raw: bool,
}

impl Terminal {
    /// Saves the console modes and enters raw mode. Fails unless stdin and stdout are consoles.
    pub fn open() -> io::Result<Self> {
        let input_mode = console_mode(std_handle(STD_INPUT_HANDLE)).map_err(|_| not_a_terminal())?;
        let output_mode = console_mode(std_handle(STD_OUTPUT_HANDLE)).map_err(|_| not_a_terminal())?;
        let mut terminal = Self { input_mode, output_mode, raw: false };
        terminal.enter_raw()?;
        Ok(terminal)
    }

    pub fn enter_raw(&mut self) -> io::Result<()> {
        let cleared = ENABLE_LINE_INPUT
            | ENABLE_ECHO_INPUT
            | ENABLE_PROCESSED_INPUT
            | ENABLE_MOUSE_INPUT
            | ENABLE_QUICK_EDIT_MODE;
        let input =
            (self.input_mode & !cleared) | ENABLE_VIRTUAL_TERMINAL_INPUT | ENABLE_WINDOW_INPUT | ENABLE_EXTENDED_FLAGS;
        check(unsafe { SetConsoleMode(std_handle(STD_INPUT_HANDLE), input) })?;
        self.raw = true;
        let output = self.output_mode
            | ENABLE_PROCESSED_OUTPUT
            | ENABLE_VIRTUAL_TERMINAL_PROCESSING
            | DISABLE_NEWLINE_AUTO_RETURN;
        check(unsafe { SetConsoleMode(std_handle(STD_OUTPUT_HANDLE), output) })
    }

    /// Restores the saved console modes, even out of raw mode: a program the console was handed to may have changed
    /// them.
    pub fn leave_raw(&mut self) -> io::Result<()> {
        self.raw = false;
        let input = check(unsafe { SetConsoleMode(std_handle(STD_INPUT_HANDLE), self.input_mode) });
        let output = check(unsafe { SetConsoleMode(std_handle(STD_OUTPUT_HANDLE), self.output_mode) });
        input.and(output)
    }

    pub fn is_raw(&self) -> bool {
        self.raw
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.leave_raw();
    }
}

/// Input records read at a time.
const RECORDS_MAX: usize = 256;

/// A high surrogate that ended the last read, waiting for its low half; zero for none.
static PENDING_SURROGATE: AtomicU32 = AtomicU32::new(0);

/// Reads available console input as bytes: the virtual terminal sequences the console produces, in UTF-8. Window
/// size changes become [`Signal::Resize`]. Returns `Ok(None)` when no input is ready; console input never ends.
pub fn read(bytes: &mut [u8]) -> io::Result<Option<usize>> {
    let input = std_handle(STD_INPUT_HANDLE);
    let mut available = 0;
    check(unsafe { GetNumberOfConsoleInputEvents(input, &mut available) })?;
    if available == 0 {
        return Ok(None);
    }
    let mut records = [INPUT_RECORD::default(); RECORDS_MAX];
    let mut count = 0;
    check(unsafe { ReadConsoleInputW(input, records.as_mut_ptr(), available.min(RECORDS_MAX as u32), &mut count) })?;
    let written = decode_records(&records[..count as usize], bytes);
    Ok((written > 0).then_some(written))
}

/// Turns input records into UTF-8 in `bytes` and returns the length. Characters past the room `bytes` has are
/// dropped; with the host's buffer, only a key repeat count in the hundreds could reach that.
fn decode_records(records: &[INPUT_RECORD], bytes: &mut [u8]) -> usize {
    // A UTF-16 unit takes at most three bytes of UTF-8.
    let room = bytes.len() / 3;
    let mut units = Vec::with_capacity(records.len().min(room));
    let pending = PENDING_SURROGATE.swap(0, Ordering::Relaxed);
    if pending != 0 && room > 0 {
        units.push(pending as u16);
    }
    for record in records {
        match u32::from(record.EventType) {
            KEY_EVENT => {
                // SAFETY: the event type says which union member is set.
                let key = unsafe { record.Event.KeyEvent };
                let unit = unsafe { key.uChar.UnicodeChar };
                // Translated sequences arrive as characters without a key code, NUL included; a zero character
                // with a key code is a key with no text, such as Shift alone.
                if key.bKeyDown == 0 || (unit == 0 && key.wVirtualKeyCode != 0) {
                    continue;
                }
                let repeat = usize::from(key.wRepeatCount.max(1)).min(room - units.len());
                units.extend(std::iter::repeat_n(unit, repeat));
            }
            WINDOW_BUFFER_SIZE_EVENT => notify(Signal::Resize),
            _ => {}
        }
    }
    if let Some(&last) = units.last()
        && (0xD800..0xDC00).contains(&last)
    {
        units.pop();
        PENDING_SURROGATE.store(u32::from(last), Ordering::Relaxed);
    }
    let mut written = 0;
    for character in char::decode_utf16(units) {
        written += character.unwrap_or(char::REPLACEMENT_CHARACTER).encode_utf8(&mut bytes[written..]).len();
    }
    written
}

/// Waits up to `timeout` for console input.
pub(super) fn wait_input(timeout: Duration) -> io::Result<bool> {
    match unsafe { WaitForSingleObject(std_handle(STD_INPUT_HANDLE), millis(Some(timeout))) } {
        WAIT_FAILED => Err(io::Error::last_os_error()),
        result => Ok(result == WAIT_OBJECT_0),
    }
}

/// Writes all of `bytes` to the console. Console writes block until done, so `deadline` does not apply.
pub(super) fn write_all(mut bytes: &[u8], _deadline: Option<Instant>) -> io::Result<()> {
    while !bytes.is_empty() {
        let mut written = 0;
        let length = u32::try_from(bytes.len()).unwrap_or(u32::MAX);
        check(unsafe { WriteFile(std_handle(STD_OUTPUT_HANDLE), bytes.as_ptr(), length, &mut written, null_mut()) })?;
        bytes = &bytes[written as usize..];
    }
    Ok(())
}

/// Waits for a signal, a wakeup, or console input when `input` is set. Console writes block until done, so with
/// `output` set the wait only ends early to try again. `None` waits indefinitely.
pub(crate) fn wait(
    signals: &Signals,
    wake: &WakePipe,
    input: bool,
    output: bool,
    timeout: Option<Duration>,
) -> io::Result<Ready> {
    let console = std_handle(STD_INPUT_HANDLE);
    let handles = [signals.event, wake.handle(), console];
    let count = if input { 3 } else { 2 };
    let soon = Duration::from_millis(1);
    let timeout = if output { Some(timeout.map_or(soon, |timeout| timeout.min(soon))) } else { timeout };
    if unsafe { WaitForMultipleObjects(count, handles.as_ptr(), 0, millis(timeout)) } == WAIT_FAILED {
        return Err(io::Error::last_os_error());
    }
    // The call names only the first ready handle; look at each.
    Ok(Ready { signals: is_set(signals.event), wake: is_set(wake.handle()), input: input && is_set(console) })
}

/// Waits until one of `pipes` is woken, or for `timeout`, and reports which were. `None` waits indefinitely.
pub(crate) fn wait_wakes<const N: usize>(pipes: [&WakePipe; N], timeout: Option<Duration>) -> io::Result<[bool; N]> {
    let handles = pipes.map(WakePipe::handle);
    if unsafe { WaitForMultipleObjects(N as u32, handles.as_ptr(), 0, millis(timeout)) } == WAIT_FAILED {
        return Err(io::Error::last_os_error());
    }
    Ok(handles.map(is_set))
}

/// Console writes never report a full buffer, so there is nothing to wait for; pauses a moment so a retry loop
/// does not spin.
pub(crate) fn wait_writable(timeout: Duration) -> bool {
    unsafe { Sleep(millis(Some(timeout.min(Duration::from_millis(1))))) };
    true
}

/// The real stderr while a [`StderrCapture`](super::StderrCapture) redirects it, so the panic hook can restore it
/// first, and the pipe's writing end that replaced it.
static CAPTURED: AtomicBool = AtomicBool::new(false);
static SAVED_STDERR: AtomicUsize = AtomicUsize::new(0);
static CAPTURE_WRITE: AtomicUsize = AtomicUsize::new(0);

/// The reading end of the pipe stderr goes to.
pub(super) struct StderrPipe(OwnedHandle);

impl StderrPipe {
    fn available(&self) -> io::Result<u32> {
        let mut available = 0;
        check(unsafe { PeekNamedPipe(self.0.as_raw_handle(), null_mut(), 0, null_mut(), &mut available, null_mut()) })?;
        Ok(available)
    }
}

impl CapturePipe for StderrPipe {
    fn wait(&self) -> io::Result<()> {
        // A zero-byte read returns once the pipe holds data or every writer is gone, and consumes nothing.
        let mut buffer = [0u8; 1];
        let mut read = 0;
        unsafe { ReadFile(self.0.as_raw_handle(), buffer.as_mut_ptr(), 0, &mut read, null_mut()) };
        // Should it return with nothing to read, pause rather than spin.
        if matches!(self.available(), Ok(0)) {
            unsafe { Sleep(10) };
        }
        Ok(())
    }

    fn read_now(&self, bytes: &mut [u8]) -> io::Result<usize> {
        match self.available() {
            Err(error) if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) => Ok(0),
            Err(error) => Err(error),
            Ok(0) => Err(io::ErrorKind::WouldBlock.into()),
            Ok(available) => {
                let length = available.min(u32::try_from(bytes.len()).unwrap_or(u32::MAX));
                let mut read = 0;
                check(unsafe { ReadFile(self.0.as_raw_handle(), bytes.as_mut_ptr(), length, &mut read, null_mut()) })?;
                Ok(read as usize)
            }
        }
    }
}

/// A pipe whose handles this process's children do not inherit.
fn pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
    let (mut read, mut write) = (null_mut(), null_mut());
    check(unsafe { CreatePipe(&mut read, &mut write, null(), 0) })?;
    // SAFETY: the call returned two new handles that nothing else owns.
    Ok(unsafe { (OwnedHandle::from_raw_handle(read), OwnedHandle::from_raw_handle(write)) })
}

/// Makes a new pipe the process's standard error handle and returns its reading end. Rust's and Zig's standard
/// libraries look the handle up on each write; a C runtime's descriptor 2 keeps the old one.
pub(super) fn redirect_stderr() -> io::Result<StderrPipe> {
    let (read, write) = pipe()?;
    let saved = std_handle(STD_ERROR_HANDLE);
    check(unsafe { SetStdHandle(STD_ERROR_HANDLE, write.as_raw_handle()) })?;
    SAVED_STDERR.store(saved as usize, Ordering::SeqCst);
    CAPTURE_WRITE.store(write.into_raw_handle() as usize, Ordering::SeqCst);
    CAPTURED.store(true, Ordering::SeqCst);
    Ok(StderrPipe(read))
}

/// Puts back a stderr that a [`StderrCapture`](super::StderrCapture) redirected, and closes the pipe's writing end
/// so its reader sees the end. Safe to call from a panic hook, and more than once.
pub(crate) fn restore_stderr() {
    if CAPTURED.swap(false, Ordering::SeqCst) {
        unsafe {
            SetStdHandle(STD_ERROR_HANDLE, SAVED_STDERR.load(Ordering::SeqCst) as HANDLE);
            CloseHandle(CAPTURE_WRITE.swap(0, Ordering::SeqCst) as HANDLE);
        }
    }
}

/// The signals [`Signals::drain`] reports, in the order of their bits in `PENDING`.
const SIGNALS: [Signal; 4] = [Signal::Resize, Signal::Interrupt, Signal::Terminate, Signal::Hangup];

/// Signals that arrived since the last drain, one bit each.
static PENDING: AtomicU32 = AtomicU32::new(0);
/// The event that reports pending signals. Process-wide and never closed, because the console control handler runs
/// on a thread of its own and may use it at any time.
static SIGNAL_EVENT: AtomicUsize = AtomicUsize::new(0);
static INSTALLED: AtomicBool = AtomicBool::new(false);

fn signal_event() -> io::Result<HANDLE> {
    let current = SIGNAL_EVENT.load(Ordering::Acquire);
    if current != 0 {
        return Ok(current as HANDLE);
    }
    let created = event()?.into_raw_handle() as usize;
    match SIGNAL_EVENT.compare_exchange(0, created, Ordering::AcqRel, Ordering::Acquire) {
        Ok(_) => Ok(created as HANDLE),
        Err(existing) => {
            unsafe { CloseHandle(created as HANDLE) };
            Ok(existing as HANDLE)
        }
    }
}

fn notify(signal: Signal) {
    let bit = SIGNALS.iter().position(|known| *known == signal).map_or(0, |index| 1 << index);
    PENDING.fetch_or(bit, Ordering::AcqRel);
    if let Ok(event) = signal_event() {
        unsafe { SetEvent(event) };
    }
}

/// How long a console close, logoff, or shutdown waits for the event loop. Windows ends the process once the
/// handler returns, and allows a close about five seconds.
const CLOSE_GRACE_MS: u32 = 4000;

unsafe extern "system" fn on_control(kind: u32) -> BOOL {
    let signal = match kind {
        CTRL_C_EVENT | CTRL_BREAK_EVENT => Signal::Interrupt,
        CTRL_CLOSE_EVENT => Signal::Hangup,
        CTRL_LOGOFF_EVENT | CTRL_SHUTDOWN_EVENT => Signal::Terminate,
        _ => return 0,
    };
    notify(signal);
    if signal != Signal::Interrupt {
        // The process exits during this wait once the app has restored the terminal.
        unsafe { Sleep(CLOSE_GRACE_MS) };
    }
    1
}

/// Delivers [`Signal`]s from console control events (Ctrl+Break, closing the console, logoff, and shutdown) and
/// window size changes. Only one instance may exist at a time; dropping it removes the control handler.
pub struct Signals {
    event: HANDLE,
}

impl Signals {
    pub fn install() -> io::Result<Self> {
        let event = signal_event()?;
        if INSTALLED.swap(true, Ordering::AcqRel) {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, "terminal signal handlers are already installed"));
        }
        if let Err(error) = check(unsafe { SetConsoleCtrlHandler(Some(on_control), 1) }) {
            INSTALLED.store(false, Ordering::Release);
            return Err(error);
        }
        Ok(Self { event })
    }

    /// Removes and returns the signals received since the last call.
    pub fn drain(&self, out: &mut Vec<Signal>) {
        // Reset first: a signal that arrives after the swap sets the event again.
        unsafe { ResetEvent(self.event) };
        let bits = PENDING.swap(0, Ordering::AcqRel);
        out.extend(SIGNALS.iter().enumerate().filter(|(index, _)| bits & (1 << index) != 0).map(|(_, signal)| *signal));
    }
}

impl Drop for Signals {
    fn drop(&mut self) {
        unsafe { SetConsoleCtrlHandler(Some(on_control), 0) };
        INSTALLED.store(false, Ordering::Release);
    }
}

/// Windows has no job control.
pub fn stop_process() -> io::Result<()> {
    Err(io::ErrorKind::Unsupported.into())
}

#[derive(Debug)]
struct Wake {
    event: OwnedHandle,
    pending: AtomicBool,
}

/// The event loop's wakeup event, which [`Waker`]s set from any thread.
pub(crate) struct WakePipe(Arc<Wake>);

impl WakePipe {
    pub fn new() -> io::Result<Self> {
        Ok(Self(Arc::new(Wake { event: event()?, pending: AtomicBool::new(false) })))
    }

    pub fn handle(&self) -> HANDLE {
        self.0.event.as_raw_handle()
    }

    pub fn waker(&self) -> Waker {
        Waker(Arc::clone(&self.0))
    }

    /// Clears pending wakeups. Returns whether there were any.
    pub fn drain(&self) -> bool {
        // Reset first: a wakeup after the swap sets the event again.
        unsafe { ResetEvent(self.handle()) };
        self.0.pending.swap(false, Ordering::AcqRel)
    }
}

/// Wakes a waiting event loop from any thread. Wakeups coalesce.
#[derive(Clone, Debug)]
pub struct Waker(Arc<Wake>);

impl Waker {
    pub fn wake(&self) {
        if !self.0.pending.swap(true, Ordering::AcqRel) {
            unsafe { SetEvent(self.0.event.as_raw_handle()) };
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use windows_sys::Win32::System::Console::{KEY_EVENT_RECORD, WINDOW_BUFFER_SIZE_RECORD};

    /// Writes straight to the process's standard error handle.
    pub(crate) fn write_stderr(bytes: &[u8]) {
        let mut rest = bytes;
        while !rest.is_empty() {
            let mut written = 0;
            let ok = unsafe {
                WriteFile(std_handle(STD_ERROR_HANDLE), rest.as_ptr(), rest.len() as u32, &mut written, null_mut())
            };
            assert!(ok != 0 && written > 0, "write to stderr failed");
            rest = &rest[written as usize..];
        }
    }

    fn key(down: bool, unit: u16, key_code: u16, repeat: u16) -> INPUT_RECORD {
        let mut record = INPUT_RECORD { EventType: KEY_EVENT as u16, ..Default::default() };
        let mut event = KEY_EVENT_RECORD {
            bKeyDown: BOOL::from(down),
            wRepeatCount: repeat,
            wVirtualKeyCode: key_code,
            ..Default::default()
        };
        event.uChar.UnicodeChar = unit;
        record.Event.KeyEvent = event;
        record
    }

    /// Serializes tests that decode records, which share the pending surrogate.
    static DECODE: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn decode(records: &[INPUT_RECORD]) -> Vec<u8> {
        let mut bytes = [0u8; 256];
        let length = decode_records(records, &mut bytes);
        bytes[..length].to_vec()
    }

    #[test]
    fn input_records_become_utf8_sequences() {
        let _guard = DECODE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let text: Vec<INPUT_RECORD> = "\x1b[Aé".encode_utf16().map(|unit| key(true, unit, 0, 1)).collect();
        assert_eq!(decode(&text), "\x1b[Aé".as_bytes());
        // Key releases, keys without text, and repeats.
        assert_eq!(
            decode(&[key(false, 'a' as u16, 0x41, 1), key(true, 0, 0x10, 1), key(true, 'x' as u16, 0, 3)]),
            b"xxx"
        );
        // NUL, as Ctrl+Space translates, has no key code.
        assert_eq!(decode(&[key(true, 0, 0, 1)]), b"\0");
        // A surrogate pair split across two reads.
        let pair: Vec<u16> = "😀".encode_utf16().collect();
        let (high, low) = (pair[0], pair[1]);
        assert_eq!(decode(&[key(true, 'a' as u16, 0, 1), key(true, high, 0, 1)]), b"a");
        assert_eq!(decode(&[key(true, low, 0, 1)]), "😀".as_bytes());
        // A lone low surrogate is replaced.
        assert_eq!(decode(&[key(true, low, 0, 1)]), "\u{fffd}".as_bytes());
    }

    #[test]
    fn size_records_raise_resize_and_signals_drain_once() -> io::Result<()> {
        let _guard = DECODE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let signals = Signals::install()?;
        assert_eq!(Signals::install().err().map(|error| error.kind()), Some(io::ErrorKind::AlreadyExists));
        let mut drained = Vec::new();
        signals.drain(&mut drained);
        let size = INPUT_RECORD {
            EventType: WINDOW_BUFFER_SIZE_EVENT as u16,
            Event: windows_sys::Win32::System::Console::INPUT_RECORD_0 {
                WindowBufferSizeEvent: WINDOW_BUFFER_SIZE_RECORD::default(),
            },
        };
        assert!(decode(&[size]).is_empty());
        notify(Signal::Hangup);
        assert!(is_set(signals.event));
        let mut received = Vec::new();
        signals.drain(&mut received);
        assert_eq!(received, [Signal::Resize, Signal::Hangup]);
        assert!(!is_set(signals.event));
        Ok(())
    }

    #[test]
    fn wakers_coalesce_across_threads() -> io::Result<()> {
        let pipe = WakePipe::new()?;
        assert!(!pipe.drain());
        let waker = pipe.waker();
        std::thread::spawn(move || (0..100_000).for_each(|_| waker.wake())).join().unwrap();
        assert!(is_set(pipe.handle()));
        assert!(pipe.drain());
        assert!(!pipe.drain());
        assert!(!is_set(pipe.handle()));
        Ok(())
    }
}
