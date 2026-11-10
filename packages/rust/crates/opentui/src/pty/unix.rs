//! The Unix backend: a pseudo-terminal from `posix_openpt`, the program in a new session on it, an I/O thread that
//! polls the master, and a thread that reaps the program.

use super::{EXIT_QUIET, OUTPUT_MAX, POST_RETRY, Shared, State, finish, post};
use crate::app::{AppProxy, ProxyError};
use crate::term::unix::{poll, set_nonblocking};
use crate::term::{WakePipe, Waker};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

/// Wakes the I/O thread's poll.
pub(super) struct Notify(Waker);

impl Notify {
    pub(super) fn notify(&self) {
        self.0.wake();
    }
}

/// The program and the master end of its terminal.
pub(super) struct Process {
    pid: libc::pid_t,
    master: Arc<OwnedFd>,
}

impl Process {
    pub(super) fn pid(&self) -> u32 {
        self.pid as u32
    }

    pub(super) fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        set_size(self.master.as_raw_fd(), cols, rows)
    }

    /// Signals the program's process group, unless it was already reaped. The waiter reaps while holding the lock,
    /// so the process ID cannot have been reused.
    pub(super) fn signal(&self, shared: &Shared, signal: libc::c_int) -> io::Result<()> {
        let state = shared.lock();
        if state.status.is_some() {
            return Ok(());
        }
        check(unsafe { libc::kill(-self.pid, signal) }).map(drop)
    }

    pub(super) fn kill(&self, shared: &Shared) -> io::Result<()> {
        self.signal(shared, libc::SIGKILL)
    }

    /// Hangs up, and continues stopped jobs so they see it. Closing the master, when its last owner drops it, hangs
    /// up the terminal too.
    pub(super) fn close(&self, shared: &Shared) {
        let _ = self.signal(shared, libc::SIGHUP);
        let _ = self.signal(shared, libc::SIGCONT);
    }
}

/// Starts the program on a new terminal with its I/O thread and its reaper.
pub(super) fn spawn(
    mut command: Command,
    cols: u16,
    rows: u16,
    proxy: AppProxy,
    id: u64,
) -> io::Result<(Process, Arc<Shared>, Vec<JoinHandle<()>>)> {
    let (master, slave) = open_pty(cols, rows)?;
    command.stdin(Stdio::from(slave.try_clone()?)).stdout(Stdio::from(slave.try_clone()?)).stderr(slave);
    // SAFETY: the closure only makes async-signal-safe calls.
    unsafe {
        command.pre_exec(|| {
            check(libc::setsid())?;
            check(libc::ioctl(0, libc::TIOCSCTTY as _, 0))?;
            let mut signals: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut signals);
            libc::sigprocmask(libc::SIG_SETMASK, &signals, std::ptr::null_mut());
            // Descriptors other threads opened without close-on-exec stay out of the program. Older Linux
            // kernels lack close_range; nothing else depends on it.
            #[cfg(target_os = "linux")]
            libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, libc::CLOSE_RANGE_CLOEXEC);
            // macOS has no close_range: mark each descriptor the process may have.
            #[cfg(not(target_os = "linux"))]
            for fd in 3..libc::getdtablesize() {
                libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
            }
            Ok(())
        });
    }
    let child = command.spawn()?;
    // The command holds the parent's copies of the slave; the program must hold the only ones, so the terminal
    // hangs up when it exits.
    drop(command);
    let pid = child.id() as libc::pid_t;
    drop(child);

    // Without its threads the program cannot be served: kill it, and reap it unless a waiter will.
    let abandon = |error: io::Error, reap: bool| {
        unsafe { libc::kill(-pid, libc::SIGKILL) };
        if reap {
            unsafe { libc::waitpid(pid, std::ptr::null_mut(), 0) };
        }
        error
    };
    let wake = WakePipe::new().map_err(|error| abandon(error, true))?;
    let shared = Arc::new(Shared { state: Mutex::new(State::default()), changed: Notify(wake.waker()) });
    let master = Arc::new(master);
    let waiter = Arc::clone(&shared);
    std::thread::Builder::new()
        .name("opentui-pty-wait".into())
        .spawn(move || wait(pid, &waiter))
        .map_err(|error| abandon(error, true))?;
    let io = {
        let (master, shared) = (Arc::clone(&master), Arc::clone(&shared));
        std::thread::Builder::new()
            .name("opentui-pty".into())
            .spawn(move || Io { master, wake, shared, proxy, id }.run())
            .map_err(|error| abandon(error, false))?
    };
    Ok((Process { pid, master }, shared, vec![io]))
}

/// Waits for the program to exit, then reaps it while holding the state lock.
fn wait(pid: libc::pid_t, shared: &Shared) {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    loop {
        let result = unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOWAIT) };
        if result == 0 || io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            break;
        }
    }
    let mut state = shared.lock();
    let mut status = 0;
    // A failed wait, such as when the app ignores SIGCHLD, leaves a zero status.
    unsafe { libc::waitpid(pid, &mut status, 0) };
    state.status = Some(ExitStatus::from_raw(status));
    drop(state);
    shared.notify();
}

/// The I/O thread: reads output into the shared state, writes queued input, and reports the exit.
struct Io {
    master: Arc<OwnedFd>,
    wake: WakePipe,
    shared: Arc<Shared>,
    proxy: AppProxy,
    id: u64,
}

impl Io {
    fn run(self) {
        let fd = self.master.as_raw_fd();
        let mut bytes = vec![0u8; 64 * 1024];
        let mut closed = false;
        let mut quiet_since: Option<Instant> = None;
        let mut retry = false;
        loop {
            let (room, pending, status) = {
                let state = self.shared.lock();
                if state.shutdown {
                    return;
                }
                (state.output.len() < OUTPUT_MAX, !state.input.is_empty(), state.status)
            };
            if retry {
                match post(&self.proxy, self.id) {
                    Ok(()) => retry = false,
                    Err(ProxyError::Full) => {}
                    Err(ProxyError::Closed) => return finish(&self.shared, &self.proxy, self.id, None),
                }
            }
            let now = Instant::now();
            let mut timeout = retry.then_some(POST_RETRY);
            if let Some(status) = status {
                // Wait for the UI to take a full buffer before timing the quiet period.
                if !room {
                    quiet_since = None;
                }
                let quiet = *quiet_since.get_or_insert(now);
                let drained = room && now.duration_since(quiet) >= EXIT_QUIET;
                if closed || drained {
                    return finish(&self.shared, &self.proxy, self.id, Some(status));
                }
                let left = EXIT_QUIET.saturating_sub(now.duration_since(quiet));
                timeout = Some(timeout.map_or(left, |timeout| timeout.min(left)));
            }
            let mut events = 0;
            if room {
                events |= libc::POLLIN;
            }
            if pending {
                events |= libc::POLLOUT;
            }
            // A closed terminal reports a hangup on every poll; stop watching it.
            let watched = if closed || events == 0 { -1 } else { fd };
            let mut fds = [
                libc::pollfd { fd: self.wake.fd(), events: libc::POLLIN, revents: 0 },
                libc::pollfd { fd: watched, events, revents: 0 },
            ];
            if poll(&mut fds, timeout).is_err() {
                std::thread::sleep(POST_RETRY);
                continue;
            }
            if fds[0].revents != 0 {
                self.wake.drain();
            }
            let revents = fds[1].revents;
            if room && revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
                match read(fd, &mut bytes) {
                    Ok(Some(0)) | Err(_) => closed = true,
                    Ok(Some(count)) => {
                        quiet_since = None;
                        let post_output = {
                            let mut state = self.shared.lock();
                            state.output.extend_from_slice(&bytes[..count]);
                            !std::mem::replace(&mut state.posted, true)
                        };
                        if post_output {
                            match post(&self.proxy, self.id) {
                                Ok(()) => {}
                                Err(ProxyError::Full) => retry = true,
                                Err(ProxyError::Closed) => return finish(&self.shared, &self.proxy, self.id, None),
                            }
                        }
                    }
                    Ok(None) => {}
                }
            }
            if revents & libc::POLLOUT != 0 {
                let mut state = self.shared.lock();
                match write(fd, &state.input) {
                    Ok(count) => drop(state.input.drain(..count)),
                    // The terminal closed; nothing reads the input anymore.
                    Err(_) => state.input.clear(),
                }
            }
        }
    }
}

fn check(result: libc::c_int) -> io::Result<libc::c_int> {
    if result < 0 { Err(io::Error::last_os_error()) } else { Ok(result) }
}

/// Opens a pseudo-terminal pair, both ends close-on-exec, with UTF-8 line editing and the given size.
fn open_pty(cols: u16, rows: u16) -> io::Result<(OwnedFd, OwnedFd)> {
    let flags = libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC;
    // SAFETY: each descriptor is new and owned by nothing else.
    let master = unsafe { OwnedFd::from_raw_fd(check(libc::posix_openpt(flags))?) };
    check(unsafe { libc::grantpt(master.as_raw_fd()) })?;
    check(unsafe { libc::unlockpt(master.as_raw_fd()) })?;
    let name = slave_path(master.as_raw_fd())?;
    let slave = unsafe { OwnedFd::from_raw_fd(check(libc::open(name.as_ptr(), flags))?) };
    let mut termios: libc::termios = unsafe { std::mem::zeroed() };
    check(unsafe { libc::tcgetattr(slave.as_raw_fd(), &mut termios) })?;
    termios.c_iflag |= libc::IUTF8;
    check(unsafe { libc::tcsetattr(slave.as_raw_fd(), libc::TCSANOW, &termios) })?;
    set_size(master.as_raw_fd(), cols, rows)?;
    set_nonblocking(master.as_raw_fd(), true)?;
    Ok((master, slave))
}

/// The device path of the terminal a pseudo-terminal master controls, as a C string.
fn slave_path(master: RawFd) -> io::Result<[libc::c_char; 128]> {
    let mut name = [0 as libc::c_char; 128];
    #[cfg(target_os = "linux")]
    match unsafe { libc::ptsname_r(master, name.as_mut_ptr(), name.len()) } {
        0 => {}
        error => return Err(io::Error::from_raw_os_error(error)),
    }
    // What macOS's ptsname_r does, which the libc crate lacks. The ioctl writes at most 128 bytes.
    #[cfg(target_os = "macos")]
    check(unsafe { libc::ioctl(master, libc::TIOCPTYGNAME as _, name.as_mut_ptr()) })?;
    Ok(name)
}

fn set_size(fd: RawFd, cols: u16, rows: u16) -> io::Result<()> {
    let size = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
    check(unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &size) }).map(drop)
}

/// Reads what is available: `Ok(None)` when nothing is, `Ok(Some(0))` at end of file. A closed terminal reads as an
/// error (`EIO`).
fn read(fd: RawFd, bytes: &mut [u8]) -> io::Result<Option<usize>> {
    let count = unsafe { libc::read(fd, bytes.as_mut_ptr().cast(), bytes.len()) };
    if count >= 0 {
        return Ok(Some(count as usize));
    }
    let error = io::Error::last_os_error();
    match error.kind() {
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted => Ok(None),
        _ => Err(error),
    }
}

fn write(fd: RawFd, bytes: &[u8]) -> io::Result<usize> {
    let count = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
    if count >= 0 {
        return Ok(count as usize);
    }
    let error = io::Error::last_os_error();
    match error.kind() {
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted => Ok(0),
        _ => Err(error),
    }
}
