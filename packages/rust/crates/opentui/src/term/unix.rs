//! The Unix backend, for Linux and macOS: termios raw mode, signals and wakeups through self-pipes, and one `poll()`
//! the event loop waits in.

use super::{CapturePipe, Ready, Signal};
#[cfg(target_os = "linux")]
use libc::__errno_location as errno_location;
#[cfg(target_os = "macos")]
use libc::__error as errno_location;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::sync::Arc;
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::{Duration, Instant};

fn check(result: libc::c_int) -> io::Result<libc::c_int> {
    if result < 0 { Err(io::Error::last_os_error()) } else { Ok(result) }
}

/// Sets or clears a descriptor's `O_NONBLOCK` flag.
pub(crate) fn set_nonblocking(fd: RawFd, nonblocking: bool) -> io::Result<()> {
    let flags = check(unsafe { libc::fcntl(fd, libc::F_GETFL) })?;
    let flags = if nonblocking { flags | libc::O_NONBLOCK } else { flags & !libc::O_NONBLOCK };
    check(unsafe { libc::fcntl(fd, libc::F_SETFL, flags) }).map(drop)
}

fn retry(mut call: impl FnMut() -> libc::c_int) -> io::Result<libc::c_int> {
    loop {
        match check(call()) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => return result,
        }
    }
}

/// The terminal size in cells, from stdout. Reports 80x24 for a zero dimension.
pub fn size() -> io::Result<(u16, u16)> {
    let mut size: libc::winsize = unsafe { std::mem::zeroed() };
    check(unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut size) })?;
    Ok((if size.ws_col == 0 { 80 } else { size.ws_col }, if size.ws_row == 0 { 24 } else { size.ws_row }))
}

/// Raw mode on the controlling terminal, restored on drop.
///
/// Stdout becomes nonblocking so a stalled terminal cannot block the event loop. Stdin and stdout usually share one
/// open file description, so stdin is nonblocking too; [`read`] handles that.
pub struct Terminal {
    saved: libc::termios,
    output_flags: libc::c_int,
    raw: bool,
}

impl Terminal {
    /// Saves the terminal settings and enters raw mode. Fails unless stdin and stdout are terminals.
    pub fn open() -> io::Result<Self> {
        if unsafe { libc::isatty(libc::STDIN_FILENO) == 0 || libc::isatty(libc::STDOUT_FILENO) == 0 } {
            return Err(io::Error::from_raw_os_error(libc::ENOTTY));
        }
        let mut saved: libc::termios = unsafe { std::mem::zeroed() };
        check(unsafe { libc::tcgetattr(libc::STDIN_FILENO, &mut saved) })?;
        let output_flags = check(unsafe { libc::fcntl(libc::STDOUT_FILENO, libc::F_GETFL) })?;
        let mut terminal = Self { saved, output_flags, raw: false };
        terminal.enter_raw()?;
        Ok(terminal)
    }

    pub fn enter_raw(&mut self) -> io::Result<()> {
        let mut raw = self.saved;
        unsafe { libc::cfmakeraw(&mut raw) };
        retry(|| unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &raw) })?;
        self.raw = true;
        check(unsafe { libc::fcntl(libc::STDOUT_FILENO, libc::F_SETFL, self.output_flags | libc::O_NONBLOCK) })?;
        Ok(())
    }

    /// Restores the saved settings and file status flags.
    pub fn leave_raw(&mut self) -> io::Result<()> {
        if !std::mem::replace(&mut self.raw, false) {
            return Ok(());
        }
        let restored = retry(|| unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &self.saved) });
        let flags = check(unsafe { libc::fcntl(libc::STDOUT_FILENO, libc::F_SETFL, self.output_flags) });
        restored.and(flags).map(drop)
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

/// Whether `error` came from [`Terminal::open`] finding no terminal.
pub(super) fn is_not_terminal(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::ENOTTY)
}

/// Waits up to `timeout` for input on stdin.
pub(super) fn wait_input(timeout: Duration) -> io::Result<bool> {
    let mut fds = [libc::pollfd { fd: libc::STDIN_FILENO, events: libc::POLLIN, revents: 0 }];
    poll(&mut fds, Some(timeout))?;
    Ok(fds[0].revents != 0)
}

/// Writes all of `bytes` to the nonblocking stdout, giving up at `deadline`; `None` never gives up.
pub(super) fn write_all(mut bytes: &[u8], deadline: Option<Instant>) -> io::Result<()> {
    while !bytes.is_empty() {
        let count = unsafe { libc::write(libc::STDOUT_FILENO, bytes.as_ptr().cast(), bytes.len()) };
        if count >= 0 {
            bytes = &bytes[count as usize..];
            continue;
        }
        let error = io::Error::last_os_error();
        match error.kind() {
            io::ErrorKind::Interrupted => {}
            io::ErrorKind::WouldBlock => {
                let left =
                    deadline.map_or(Duration::MAX, |deadline| deadline.saturating_duration_since(Instant::now()));
                if !wait_writable(left) && deadline.is_some() {
                    return Err(io::ErrorKind::TimedOut.into());
                }
            }
            _ => return Err(error),
        }
    }
    Ok(())
}

/// The real stderr while a [`StderrCapture`](super::StderrCapture) redirects it, so the panic hook can restore it
/// first.
static SAVED_STDERR: AtomicI32 = AtomicI32::new(-1);

/// The nonblocking reading end of the pipe stderr goes to.
pub(super) struct StderrPipe(OwnedFd);

impl CapturePipe for StderrPipe {
    fn wait(&self) -> io::Result<()> {
        let mut fds = [libc::pollfd { fd: self.0.as_raw_fd(), events: libc::POLLIN, revents: 0 }];
        retry(|| unsafe { libc::poll(fds.as_mut_ptr(), 1, -1) }).map(drop)
    }

    fn read_now(&self, bytes: &mut [u8]) -> io::Result<usize> {
        loop {
            let count = unsafe { libc::read(self.0.as_raw_fd(), bytes.as_mut_ptr().cast(), bytes.len()) };
            if count >= 0 {
                return Ok(count as usize);
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
}

/// Points descriptor 2 at a new pipe and returns its reading end.
pub(super) fn redirect_stderr() -> io::Result<StderrPipe> {
    let saved = check(unsafe { libc::fcntl(libc::STDERR_FILENO, libc::F_DUPFD_CLOEXEC, 3) })?;
    let (read, write) = match pipe() {
        Ok(pipe) => pipe,
        Err(error) => {
            unsafe { libc::close(saved) };
            return Err(error);
        }
    };
    // Writers to stderr block as they would on a terminal; only the reading end polls.
    let blocking = set_nonblocking(write.as_raw_fd(), false);
    if let Err(error) = blocking.and_then(|()| check(unsafe { libc::dup2(write.as_raw_fd(), libc::STDERR_FILENO) })) {
        unsafe { libc::close(saved) };
        return Err(error);
    }
    drop(write);
    SAVED_STDERR.store(saved, Ordering::SeqCst);
    Ok(StderrPipe(read))
}

/// Puts back a stderr that a [`StderrCapture`](super::StderrCapture) redirected. Safe to call from a panic hook, and
/// more than once.
pub(crate) fn restore_stderr() {
    let saved = SAVED_STDERR.swap(-1, Ordering::SeqCst);
    if saved >= 0 {
        unsafe {
            libc::dup2(saved, libc::STDERR_FILENO);
            libc::close(saved);
        }
    }
}

/// Reads available input. Returns `Ok(None)` when nothing is ready and `Ok(Some(0))` at end of file.
pub fn read(bytes: &mut [u8]) -> io::Result<Option<usize>> {
    let count = unsafe { libc::read(libc::STDIN_FILENO, bytes.as_mut_ptr().cast(), bytes.len()) };
    if count >= 0 {
        return Ok(Some(count as usize));
    }
    let error = io::Error::last_os_error();
    match error.kind() {
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted => Ok(None),
        _ => Err(error),
    }
}

/// Polls descriptors, treating an interrupted call as a timeout. `None` waits indefinitely.
///
/// macOS's `poll` rejects some terminal devices, such as the `/dev/tty` that `xargs -o` makes stdin, so there
/// descriptors below `FD_SETSIZE` go through [`select`] instead.
pub(crate) fn poll(fds: &mut [libc::pollfd], timeout: Option<Duration>) -> io::Result<()> {
    let result = if cfg!(target_os = "macos") && fds.iter().all(|fd| fd.fd < libc::FD_SETSIZE as RawFd) {
        select(fds, timeout)
    } else {
        let milliseconds =
            timeout.map_or(-1, |timeout| timeout.as_nanos().div_ceil(1_000_000).min(i32::MAX as u128) as i32);
        check(unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, milliseconds) }).map(drop)
    };
    match result {
        Err(error) if error.kind() == io::ErrorKind::Interrupted => {
            fds.iter_mut().for_each(|fd| fd.revents = 0);
            Ok(())
        }
        result => result,
    }
}

/// [`poll`] through `select(2)`, for descriptors below `FD_SETSIZE`. Readiness comes back as `POLLIN` and `POLLOUT`
/// only; `select` reports a hangup or an error as readable.
fn select(fds: &mut [libc::pollfd], timeout: Option<Duration>) -> io::Result<()> {
    // SAFETY: an all-zero fd_set is an empty one.
    let (mut read, mut write): (libc::fd_set, libc::fd_set) = unsafe { std::mem::zeroed() };
    let mut count = 0;
    for fd in fds.iter().filter(|fd| fd.fd >= 0) {
        if fd.events & libc::POLLIN != 0 {
            unsafe { libc::FD_SET(fd.fd, &mut read) };
        }
        if fd.events & libc::POLLOUT != 0 {
            unsafe { libc::FD_SET(fd.fd, &mut write) };
        }
        count = count.max(fd.fd + 1);
    }
    // macOS rejects timeouts beyond 10^8 seconds.
    let mut time = timeout.map(|timeout| {
        let micros = timeout.as_nanos().div_ceil(1_000).min(100_000_000 * 1_000_000);
        libc::timeval { tv_sec: (micros / 1_000_000) as _, tv_usec: (micros % 1_000_000) as _ }
    });
    let time = time.as_mut().map_or(std::ptr::null_mut(), |time| time as *mut libc::timeval);
    check(unsafe { libc::select(count, &mut read, &mut write, std::ptr::null_mut(), time) })?;
    for fd in fds.iter_mut() {
        fd.revents = 0;
        if fd.fd >= 0 && unsafe { libc::FD_ISSET(fd.fd, &read) } {
            fd.revents |= libc::POLLIN;
        }
        if fd.fd >= 0 && unsafe { libc::FD_ISSET(fd.fd, &write) } {
            fd.revents |= libc::POLLOUT;
        }
    }
    Ok(())
}

/// Waits for a signal, a wakeup, input on stdin when `input` is set, or room on stdout when `output` is set.
/// `None` waits indefinitely.
pub(crate) fn wait(
    signals: &Signals,
    wake: &WakePipe,
    input: bool,
    output: bool,
    timeout: Option<Duration>,
) -> io::Result<Ready> {
    let watch = |fd, events, on: bool| libc::pollfd { fd: if on { fd } else { -1 }, events, revents: 0 };
    // A negative descriptor is ignored.
    let mut fds = [
        watch(signals.fd(), libc::POLLIN, true),
        watch(wake.fd(), libc::POLLIN, true),
        watch(libc::STDIN_FILENO, libc::POLLIN, input),
        watch(libc::STDOUT_FILENO, libc::POLLOUT, output),
    ];
    poll(&mut fds, timeout)?;
    Ok(Ready { signals: fds[0].revents != 0, wake: fds[1].revents != 0, input: fds[2].revents != 0 })
}

/// Waits until one of `pipes` is woken, or for `timeout`, and reports which were. `None` waits indefinitely.
pub(crate) fn wait_wakes<const N: usize>(pipes: [&WakePipe; N], timeout: Option<Duration>) -> io::Result<[bool; N]> {
    let mut fds = pipes.map(|pipe| libc::pollfd { fd: pipe.fd(), events: libc::POLLIN, revents: 0 });
    poll(&mut fds, timeout)?;
    Ok(fds.map(|fd| fd.revents != 0))
}

/// Waits until stdout accepts more bytes. Returns `false` on timeout.
pub(crate) fn wait_writable(timeout: Duration) -> bool {
    let mut fds = [libc::pollfd { fd: libc::STDOUT_FILENO, events: libc::POLLOUT, revents: 0 }];
    poll(&mut fds, Some(timeout)).is_ok() && fds[0].revents != 0
}

/// A pipe whose ends are both nonblocking and close-on-exec.
fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0; 2];
    #[cfg(target_os = "linux")]
    check(unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_NONBLOCK | libc::O_CLOEXEC) })?;
    #[cfg(not(target_os = "linux"))]
    check(unsafe { libc::pipe(fds.as_mut_ptr()) })?;
    // SAFETY: the call returned two new descriptors that nothing else owns.
    let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    // Without pipe2, a program another thread starts meanwhile can inherit the ends, as with the standard library's
    // own pipes on macOS.
    #[cfg(not(target_os = "linux"))]
    for fd in [&read, &write] {
        check(unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) })?;
        set_nonblocking(fd.as_raw_fd(), true)?;
    }
    Ok((read, write))
}

fn drain(fd: RawFd, mut each: impl FnMut(u8)) {
    let mut bytes = [0u8; 64];
    loop {
        let count = unsafe { libc::read(fd, bytes.as_mut_ptr().cast(), bytes.len()) };
        if count <= 0 {
            return;
        }
        bytes[..count as usize].iter().for_each(|&byte| each(byte));
    }
}

const SIGNALS: [(libc::c_int, Signal); 6] = [
    (libc::SIGWINCH, Signal::Resize),
    (libc::SIGINT, Signal::Interrupt),
    (libc::SIGTERM, Signal::Terminate),
    (libc::SIGHUP, Signal::Hangup),
    (libc::SIGTSTP, Signal::Suspend),
    (libc::SIGCONT, Signal::Continue),
];

static SIGNAL_PIPE: AtomicI32 = AtomicI32::new(-1);

extern "C" fn on_signal(signal: libc::c_int) {
    // Only async-signal-safe work here: one write, preserving errno.
    unsafe {
        let errno = *errno_location();
        let fd = SIGNAL_PIPE.load(Ordering::Relaxed);
        if fd >= 0 {
            let byte = signal as u8;
            libc::write(fd, (&byte as *const u8).cast(), 1);
        }
        *errno_location() = errno;
    }
}

fn install(signal: libc::c_int, handler: libc::sighandler_t) -> io::Result<libc::sigaction> {
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction = handler;
    action.sa_flags = libc::SA_RESTART;
    unsafe { libc::sigemptyset(&mut action.sa_mask) };
    let mut previous: libc::sigaction = unsafe { std::mem::zeroed() };
    check(unsafe { libc::sigaction(signal, &action, &mut previous) })?;
    Ok(previous)
}

/// Delivers [`Signal`]s through a pipe that the event loop polls. Only one instance may exist at a time; dropping it
/// restores the previous handlers.
pub struct Signals {
    read: OwnedFd,
    write: OwnedFd,
    previous: Vec<(libc::c_int, libc::sigaction)>,
}

impl Signals {
    pub fn install() -> io::Result<Self> {
        let (read, write) = pipe()?;
        if SIGNAL_PIPE.compare_exchange(-1, write.as_raw_fd(), Ordering::AcqRel, Ordering::Acquire).is_err() {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, "terminal signal handlers are already installed"));
        }
        let mut signals = Self { read, write, previous: Vec::new() };
        for (signal, _) in SIGNALS {
            let previous = install(signal, on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t)?;
            signals.previous.push((signal, previous));
        }
        Ok(signals)
    }

    pub fn fd(&self) -> RawFd {
        self.read.as_raw_fd()
    }

    /// Removes and returns the signals received since the last call.
    pub fn drain(&self, out: &mut Vec<Signal>) {
        drain(self.fd(), |byte| {
            if let Some((_, signal)) = SIGNALS.iter().find(|(number, _)| *number as u8 == byte) {
                out.push(*signal);
            }
        });
    }
}

impl Drop for Signals {
    fn drop(&mut self) {
        for (signal, previous) in self.previous.drain(..).rev() {
            unsafe { libc::sigaction(signal, &previous, std::ptr::null_mut()) };
        }
        let _ = SIGNAL_PIPE.compare_exchange(self.write.as_raw_fd(), -1, Ordering::AcqRel, Ordering::Acquire);
    }
}

/// Stops the process group for job control, as Ctrl-Z would, and returns after it continues. The group holds a wrapper
/// script that started the process, if any, and the children it started without a group of their own.
pub fn stop_process() -> io::Result<()> {
    let ours = install(libc::SIGTSTP, libc::SIG_DFL)?;
    // Blocked on this thread, the group's signal waits under the default action until another thread takes it or
    // unblocking delivers it here, so our handler never runs for it once that is back; a SIGCONT meanwhile discards it.
    // macOS stops the process inside kill when another thread takes it. Linux stops it later, so this thread queues its
    // own stop first, which unblocking delivers; not on macOS, where a SIGCONT discards a stop on one thread only.
    let mut tstp: libc::sigset_t = unsafe { std::mem::zeroed() };
    unsafe { libc::sigemptyset(&mut tstp) };
    unsafe { libc::sigaddset(&mut tstp, libc::SIGTSTP) };
    unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, &tstp, std::ptr::null_mut()) };
    #[cfg(target_os = "linux")]
    let _ = unsafe { libc::raise(libc::SIGTSTP) };
    let sent = check(unsafe { libc::kill(0, libc::SIGTSTP) });
    unsafe { libc::pthread_sigmask(libc::SIG_UNBLOCK, &tstp, std::ptr::null_mut()) };
    // Execution resumes here after SIGCONT.
    check(unsafe { libc::sigaction(libc::SIGTSTP, &ours, std::ptr::null_mut()) })?;
    sent.map(drop)
}

/// The read end of a wakeup pipe. The event loop polls it; [`Waker`]s write to it from any thread.
pub(crate) struct WakePipe {
    read: OwnedFd,
    write: Arc<OwnedFd>,
}

impl WakePipe {
    pub fn new() -> io::Result<Self> {
        let (read, write) = pipe()?;
        Ok(Self { read, write: Arc::new(write) })
    }

    pub fn fd(&self) -> RawFd {
        self.read.as_raw_fd()
    }

    pub fn waker(&self) -> Waker {
        Waker { write: Arc::clone(&self.write) }
    }

    /// Clears pending wakeups. Returns whether there were any.
    pub fn drain(&self) -> bool {
        let mut woken = false;
        drain(self.fd(), |_| woken = true);
        woken
    }
}

/// Wakes a waiting event loop from any thread. Wakeups coalesce.
#[derive(Clone, Debug)]
pub struct Waker {
    write: Arc<OwnedFd>,
}

impl Waker {
    pub fn wake(&self) {
        let byte = 1u8;
        // A full pipe already holds a pending wakeup.
        unsafe { libc::write(self.write.as_raw_fd(), (&byte as *const u8).cast(), 1) };
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn wakers_coalesce_across_threads() -> io::Result<()> {
        let pipe = WakePipe::new()?;
        assert!(!pipe.drain());
        let waker = pipe.waker();
        std::thread::spawn(move || (0..100_000).for_each(|_| waker.wake())).join().unwrap();
        let mut fds = [libc::pollfd { fd: pipe.fd(), events: libc::POLLIN, revents: 0 }];
        poll(&mut fds, Some(Duration::ZERO))?;
        assert_ne!(fds[0].revents & libc::POLLIN, 0);
        assert!(pipe.drain());
        assert!(!pipe.drain());
        Ok(())
    }

    /// The `select` path that macOS uses, run on every platform.
    #[test]
    fn select_reports_readiness_like_poll() -> io::Result<()> {
        let (read, write) = pipe()?;
        let fds = |write_fd| {
            [
                libc::pollfd { fd: read.as_raw_fd(), events: libc::POLLIN, revents: 0 },
                libc::pollfd { fd: write_fd, events: libc::POLLOUT, revents: 0 },
                libc::pollfd { fd: -1, events: libc::POLLIN, revents: libc::POLLIN },
            ]
        };
        let mut empty = fds(-1);
        let started = Instant::now();
        select(&mut empty, Some(Duration::from_millis(20)))?;
        assert!(started.elapsed() >= Duration::from_millis(20));
        assert_eq!(empty.map(|fd| fd.revents), [0, 0, 0]);

        let mut ready = fds(write.as_raw_fd());
        select(&mut ready, Some(Duration::ZERO))?;
        assert_eq!(ready.map(|fd| fd.revents), [0, libc::POLLOUT, 0]);
        assert_eq!(unsafe { libc::write(write.as_raw_fd(), b"x".as_ptr().cast(), 1) }, 1);
        select(&mut ready, None)?;
        assert_eq!(ready.map(|fd| fd.revents), [libc::POLLIN, libc::POLLOUT, 0]);

        // A pipe with no writers left reads as end of file, which select reports as readable.
        drain(read.as_raw_fd(), |_| {});
        drop(write);
        let mut closed = fds(-1);
        select(&mut closed, Some(Duration::from_secs(5)))?;
        assert_eq!(closed.map(|fd| fd.revents), [libc::POLLIN, 0, 0]);
        Ok(())
    }

    #[test]
    fn signals_arrive_through_the_pipe_and_handlers_restore() -> io::Result<()> {
        let signals = Signals::install()?;
        assert_eq!(Signals::install().err().map(|error| error.kind()), Some(io::ErrorKind::AlreadyExists));
        unsafe { libc::raise(libc::SIGWINCH) };
        unsafe { libc::raise(libc::SIGCONT) };
        let mut received = Vec::new();
        signals.drain(&mut received);
        assert_eq!(received, [Signal::Resize, Signal::Continue]);
        drop(signals);
        // The previous disposition for SIGWINCH is the default, which ignores it.
        unsafe { libc::raise(libc::SIGWINCH) };
        let again = Signals::install()?;
        let mut received = Vec::new();
        again.drain(&mut received);
        assert!(received.is_empty());
        Ok(())
    }

    /// Writes straight to file descriptor 2.
    pub(crate) fn write_stderr(bytes: &[u8]) {
        let mut rest = bytes;
        while !rest.is_empty() {
            let count = unsafe { libc::write(libc::STDERR_FILENO, rest.as_ptr().cast(), rest.len()) };
            assert!(count > 0, "write to stderr failed");
            rest = &rest[count as usize..];
        }
    }
}
