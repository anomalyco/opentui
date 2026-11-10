//! The Windows backend: a pseudoconsole (ConPTY) on two pipes with the program attached to it, a thread that reads
//! its output, and a thread that writes input, posts output to the UI thread, and waits for the exit.
//!
//! A pseudoconsole keeps its output pipe open after the program exits, until it is closed, so the exit is reported
//! once output stays quiet.

use super::{EXIT_QUIET, OUTPUT_MAX, POST_RETRY, Shared, State, finish, post, queue_input};
use crate::app::{AppProxy, ProxyError};
use crate::term::windows::{event, is_set, millis};
use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString, c_void};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::ExitStatusExt;
use std::process::{Command, ExitStatus};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{CloseHandle, WAIT_FAILED, WAIT_OBJECT_0};
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows_sys::Win32::System::Console::{COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole};
use windows_sys::Win32::System::IO::CancelSynchronousIo;
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
    GetExitCodeProcess, InitializeProcThreadAttributeList, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION,
    ResetEvent, STARTF_USESTDHANDLES, STARTUPINFOEXW, SetEvent, TerminateProcess, UpdateProcThreadAttribute,
    WaitForMultipleObjects, WaitForSingleObject,
};
use windows_sys::core::{BOOL, HRESULT};

fn check(result: BOOL) -> io::Result<()> {
    if result == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
}

/// An HRESULT as an I/O error, keeping the Win32 error code an HRESULT may carry.
fn hresult(result: HRESULT) -> io::Result<()> {
    match result as u32 {
        0 => Ok(()),
        code if code & 0xFFFF_0000 == 0x8007_0000 => Err(io::Error::from_raw_os_error((code & 0xFFFF) as i32)),
        _ => Err(io::Error::from_raw_os_error(result)),
    }
}

fn coord(cols: u16, rows: u16) -> COORD {
    let clamp = |value: u16| i16::try_from(value).unwrap_or(i16::MAX);
    COORD { X: clamp(cols), Y: clamp(rows) }
}

/// Wakes the reader thread waiting for room, and the control thread waiting on its event.
pub(super) struct Notify {
    room: Condvar,
    event: OwnedHandle,
}

impl Notify {
    pub(super) fn notify(&self) {
        self.room.notify_all();
        unsafe { SetEvent(self.event.as_raw_handle()) };
    }
}

/// How long a program may run after its pseudoconsole closes. Windows allows the same after a console window
/// closes, then ends the program.
const CLOSE_GRACE: Duration = Duration::from_secs(5);

/// The program, its pseudoconsole, and the thread reading its output.
pub(super) struct Process {
    pid: u32,
    handle: Arc<OwnedHandle>,
    /// The pseudoconsole; zero once closed.
    console: AtomicIsize,
    reader: Mutex<Option<JoinHandle<()>>>,
}

impl Process {
    pub(super) fn pid(&self) -> u32 {
        self.pid
    }

    pub(super) fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        match self.console.load(Ordering::Acquire) {
            0 => Err(io::ErrorKind::BrokenPipe.into()),
            console => hresult(unsafe { ResizePseudoConsole(console, coord(cols, rows)) }),
        }
    }

    pub(super) fn signal(&self, shared: &Shared, signal: i32) -> io::Result<()> {
        if shared.lock().status.is_some() {
            return Ok(());
        }
        match signal {
            2 => queue_input(shared, b"\x03"),
            9 | 15 => self.terminate(),
            _ => Err(io::ErrorKind::Unsupported.into()),
        }
    }

    pub(super) fn kill(&self, shared: &Shared) -> io::Result<()> {
        if shared.lock().status.is_some() {
            return Ok(());
        }
        self.terminate()
    }

    fn terminate(&self) -> io::Result<()> {
        check(unsafe { TerminateProcess(self.handle.as_raw_handle(), 1) })
    }

    /// Closes the pseudoconsole, which sends the programs attached to it `CTRL_CLOSE_EVENT`, and stops the reader.
    pub(super) fn close(&self, _shared: &Shared) {
        let console = self.console.swap(0, Ordering::AcqRel);
        if console == 0 {
            return;
        }
        unsafe { ClosePseudoConsole(console) };
        // A program still starting can miss the event; end it after the grace period, as Windows would.
        if !is_set(self.handle.as_raw_handle()) {
            let handle = Arc::clone(&self.handle);
            let reaper = std::thread::Builder::new().name("opentui-pty-close".into()).spawn(move || {
                if !wait(&handle, CLOSE_GRACE) {
                    unsafe { TerminateProcess(handle.as_raw_handle(), 1) };
                }
            });
            if reaper.is_err() {
                let _ = self.terminate();
            }
        }
        // The pseudoconsole's host keeps the output pipe open while a program it serves runs, so the reader cannot
        // count on the pipe ending: cancel its read until it notices the shutdown.
        if let Some(reader) = self.reader.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take() {
            while !reader.is_finished() {
                unsafe { CancelSynchronousIo(reader.as_raw_handle()) };
                std::thread::sleep(Duration::from_millis(1));
            }
            let _ = reader.join();
        }
    }
}

/// Whether the process ends within `timeout`.
fn wait(handle: &OwnedHandle, timeout: Duration) -> bool {
    unsafe { WaitForSingleObject(handle.as_raw_handle(), millis(Some(timeout))) == WAIT_OBJECT_0 }
}

/// A pipe whose handles no child process inherits.
fn pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
    let (mut read, mut write) = (null_mut(), null_mut());
    check(unsafe { CreatePipe(&mut read, &mut write, null(), 0) })?;
    // SAFETY: the call returned two new handles that nothing else owns.
    Ok(unsafe { (OwnedHandle::from_raw_handle(read), OwnedHandle::from_raw_handle(write)) })
}

/// Starts the program on a new pseudoconsole with its reader and control threads.
pub(super) fn spawn(
    command: Command,
    cols: u16,
    rows: u16,
    proxy: AppProxy,
    id: u64,
) -> io::Result<(Process, Arc<Shared>, Vec<JoinHandle<()>>)> {
    let changed = Notify { room: Condvar::new(), event: event()? };
    let shared = Arc::new(Shared { state: Mutex::new(State::default()), changed });
    let (input_read, input) = pipe()?;
    let (output, output_write) = pipe()?;
    let mut console: HPCON = 0;
    hresult(unsafe {
        CreatePseudoConsole(
            coord(cols, rows),
            input_read.as_raw_handle(),
            output_write.as_raw_handle(),
            0,
            &mut console,
        )
    })?;
    // The pseudoconsole keeps its own copies of its ends.
    drop((input_read, output_write));
    let process = match start(&command, console) {
        Ok((handle, pid)) => {
            Process { pid, handle: Arc::new(handle), console: AtomicIsize::new(console), reader: Mutex::new(None) }
        }
        Err(error) => {
            unsafe { ClosePseudoConsole(console) };
            return Err(error);
        }
    };
    // Without its threads the program cannot be served: end it and its pseudoconsole, which stops a reader.
    let abandon = |error: io::Error| {
        let _ = process.terminate();
        process.close(&shared);
        error
    };
    let reader = {
        let shared = Arc::clone(&shared);
        std::thread::Builder::new()
            .name("opentui-pty-read".into())
            .spawn(move || read_output(&output, &shared))
            .map_err(abandon)?
    };
    *process.reader.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(reader);
    let control = Control { process: Arc::clone(&process.handle), input, shared: Arc::clone(&shared), proxy, id };
    let control =
        std::thread::Builder::new().name("opentui-pty".into()).spawn(move || control.run()).map_err(abandon)?;
    Ok((process, shared, vec![control]))
}

/// Creates the program's process attached to `console`. Returns its handle and ID.
fn start(command: &Command, console: HPCON) -> io::Result<(OwnedHandle, u32)> {
    let mut line = command_line(command);
    let environment = environment(command);
    let directory: Option<Vec<u16>> = command.get_current_dir().map(|directory| wide(directory.as_os_str()));
    let mut size = 0;
    // The first call only reports the size the list needs.
    unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size) };
    let mut storage = vec![0usize; size.div_ceil(size_of::<usize>())];
    let list = storage.as_mut_ptr().cast::<c_void>();
    check(unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut size) })?;
    let result = (|| {
        // The attribute's value is the pseudoconsole handle itself, not a pointer to it.
        check(unsafe {
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                console as *const c_void,
                size_of::<HPCON>(),
                null_mut(),
                null(),
            )
        })?;
        let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        // Empty standard handles make the program use the pseudoconsole's instead of this process's.
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.lpAttributeList = list;
        let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        check(unsafe {
            CreateProcessW(
                null(),
                line.as_mut_ptr(),
                null(),
                null(),
                0,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                environment.as_ptr().cast(),
                directory.as_ref().map_or(null(), |directory| directory.as_ptr()),
                &startup.StartupInfo,
                &mut info,
            )
        })?;
        unsafe { CloseHandle(info.hThread) };
        // SAFETY: the process handle is new and owned by nothing else.
        Ok((unsafe { OwnedHandle::from_raw_handle(info.hProcess) }, info.dwProcessId))
    })();
    unsafe { DeleteProcThreadAttributeList(list) };
    result
}

fn wide(text: &OsStr) -> Vec<u16> {
    text.encode_wide().chain([0]).collect()
}

/// The program and arguments as one command line, quoted as the C runtime splits it again.
fn command_line(command: &Command) -> Vec<u16> {
    let mut line = Vec::new();
    for (index, argument) in std::iter::once(command.get_program()).chain(command.get_args()).enumerate() {
        if index > 0 {
            line.push(u16::from(b' '));
        }
        quote(&mut line, argument);
    }
    line.push(0);
    line
}

/// Appends one argument: as it is when it needs no quotes, otherwise in quotes with backslashes doubled before a
/// quote, which is escaped.
fn quote(line: &mut Vec<u16>, argument: &OsStr) {
    let units: Vec<u16> = argument.encode_wide().collect();
    let special = |unit: &u16| [b' ', b'\t', b'\n', 0x0b, b'"'].iter().any(|byte| *unit == u16::from(*byte));
    if !units.is_empty() && !units.iter().any(special) {
        line.extend(units);
        return;
    }
    let (backslash, quotation) = (u16::from(b'\\'), u16::from(b'"'));
    line.push(quotation);
    let mut backslashes = 0;
    for unit in units {
        if unit == backslash {
            backslashes += 1;
            continue;
        }
        let escapes = if unit == quotation { backslashes * 2 + 1 } else { backslashes };
        line.extend(std::iter::repeat_n(backslash, escapes));
        backslashes = 0;
        line.push(unit);
    }
    line.extend(std::iter::repeat_n(backslash, backslashes * 2));
    line.push(quotation);
}

/// This process's environment with the command's changes, as a sorted block of `NAME=value` strings. Windows
/// variable names ignore case.
fn environment(command: &Command) -> Vec<u16> {
    let fold = |name: &OsStr| name.to_string_lossy().to_uppercase();
    let mut variables: BTreeMap<String, (OsString, OsString)> =
        std::env::vars_os().map(|(name, value)| (fold(&name), (name, value))).collect();
    for (name, value) in command.get_envs() {
        match value {
            Some(value) => variables.insert(fold(name), (name.to_owned(), value.to_owned())),
            None => variables.remove(&fold(name)),
        };
    }
    let mut block = Vec::new();
    for (name, value) in variables.values() {
        block.extend(name.encode_wide());
        block.push(u16::from(b'='));
        block.extend(value.encode_wide());
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    block
}

/// Reads the pseudoconsole's output into the shared state, waiting while the UI has a full buffer. After shutdown
/// it discards what it reads, so closing the pseudoconsole never waits on unread output.
fn read_output(output: &OwnedHandle, shared: &Shared) {
    let mut bytes = vec![0u8; 64 * 1024];
    loop {
        {
            let mut state = shared.lock();
            while state.output.len() >= OUTPUT_MAX && !state.shutdown {
                state = shared.changed.room.wait(state).unwrap_or_else(|poisoned| poisoned.into_inner());
            }
        }
        let mut count = 0;
        let length = bytes.len() as u32;
        let ok = unsafe { ReadFile(output.as_raw_handle(), bytes.as_mut_ptr(), length, &mut count, null_mut()) };
        {
            let mut state = shared.lock();
            if ok == 0 {
                state.closed = true;
            } else if !state.shutdown {
                state.output.extend_from_slice(&bytes[..count as usize]);
                state.received += u64::from(count);
            }
        }
        shared.notify();
        if ok == 0 {
            return;
        }
    }
}

/// The control thread: writes queued input, posts output to the UI thread, and reports the exit once output stays
/// quiet.
struct Control {
    process: Arc<OwnedHandle>,
    input: OwnedHandle,
    shared: Arc<Shared>,
    proxy: AppProxy,
    id: u64,
}

impl Control {
    fn run(self) {
        let event = self.shared.changed.event.as_raw_handle();
        let process = self.process.as_raw_handle();
        let mut status = None;
        let mut retry = false;
        let mut received = 0;
        let mut quiet_since = Instant::now();
        loop {
            // Reset before reading the state: a change after this sets the event again.
            unsafe { ResetEvent(event) };
            let (input, unposted, room, closed, now_received) = {
                let mut state = self.shared.lock();
                if state.shutdown {
                    return;
                }
                let unposted = !state.output.is_empty() && !std::mem::replace(&mut state.posted, true);
                let room = state.output.len() < OUTPUT_MAX;
                (std::mem::take(&mut state.input), unposted, room, state.closed, state.received)
            };
            // A failed write means the pseudoconsole closed; nothing reads the input anymore.
            let _ = self.write(&input);
            if unposted || retry {
                match post(&self.proxy, self.id) {
                    Ok(()) => retry = false,
                    Err(ProxyError::Full) => retry = true,
                    Err(ProxyError::Closed) => return finish(&self.shared, &self.proxy, self.id, None),
                }
            }
            let now = Instant::now();
            // Output read, or the UI still holding a full buffer, restarts the quiet period.
            if now_received != received || !room {
                received = now_received;
                quiet_since = now;
            }
            if status.is_none() && is_set(process) {
                let mut code = 0;
                unsafe { GetExitCodeProcess(process, &mut code) };
                status = Some(ExitStatus::from_raw(code));
                self.shared.lock().status = status;
                quiet_since = now;
            }
            let mut timeout = retry.then_some(POST_RETRY);
            if let Some(status) = status {
                let quiet = now.duration_since(quiet_since);
                if closed || (room && quiet >= EXIT_QUIET) {
                    return finish(&self.shared, &self.proxy, self.id, Some(status));
                }
                let left = EXIT_QUIET.saturating_sub(quiet);
                timeout = Some(timeout.map_or(left, |timeout| timeout.min(left)));
            }
            let handles = [event, process];
            let count = if status.is_none() { 2 } else { 1 };
            if unsafe { WaitForMultipleObjects(count, handles.as_ptr(), 0, millis(timeout)) } == WAIT_FAILED {
                std::thread::sleep(POST_RETRY);
            }
        }
    }

    fn write(&self, mut bytes: &[u8]) -> io::Result<()> {
        while !bytes.is_empty() {
            let mut written = 0;
            let length = u32::try_from(bytes.len()).unwrap_or(u32::MAX);
            check(unsafe { WriteFile(self.input.as_raw_handle(), bytes.as_ptr(), length, &mut written, null_mut()) })?;
            bytes = &bytes[written as usize..];
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(program: &str, arguments: &[&str]) -> String {
        let mut command = Command::new(program);
        command.args(arguments);
        let line = command_line(&command);
        String::from_utf16(&line[..line.len() - 1]).unwrap()
    }

    #[test]
    fn command_lines_quote_as_the_c_runtime_expects() {
        assert_eq!(line("cmd.exe", &["/c", "echo", "hi"]), "cmd.exe /c echo hi");
        assert_eq!(line(r"C:\Program Files\x.exe", &[""]), r#""C:\Program Files\x.exe" """#);
        assert_eq!(line("x", &["a b", r#"say "hi""#, r"dir\", r"dir\ x", r#"a\"b"#]), {
            r#"x "a b" "say \"hi\"" dir\ "dir\ x" "a\\\"b""#
        });
        assert_eq!(line("x", &[r"trailing\ ", r"end\\"]), r#"x "trailing\ " end\\"#);
    }

    #[test]
    fn environments_apply_changes_without_regard_to_case() {
        let mut command = Command::new("x");
        command.env("OPENTUI_PTY_TEST", "one").env("opentui_pty_test", "two").env_remove("PATH");
        let block = environment(&command);
        let text = String::from_utf16_lossy(&block);
        let entries: Vec<&str> = text.split('\0').filter(|entry| !entry.is_empty()).collect();
        let values = |wanted: &str| -> Vec<&str> {
            let pairs = entries.iter().filter_map(|entry| entry.split_once('='));
            pairs.filter(|(name, _)| name.eq_ignore_ascii_case(wanted)).map(|(_, value)| value).collect()
        };
        assert_eq!(values("OPENTUI_PTY_TEST"), ["two"], "{entries:?}");
        assert!(values("PATH").is_empty(), "{entries:?}");
        assert!(block.ends_with(&[0, 0]));
    }
}
