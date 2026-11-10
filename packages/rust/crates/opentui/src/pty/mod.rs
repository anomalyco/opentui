//! Programs running on pseudo-terminals, for a [`TerminalView`](crate::widget::TerminalView) or your own use.
//!
//! [`Pty::spawn`] starts a [`Command`] on a new pseudo-terminal: on Unix, in a new session whose controlling terminal
//! it is; on Windows, attached to a pseudoconsole (ConPTY, Windows 10 1809 or later). Background threads move bytes
//! between the terminal and the program, so nothing here blocks the UI thread: output and the exit status arrive on
//! the UI thread through the app's [`AppProxy`], and input waits in a queue for a thread to write it.
//!
//! ```no_run
//! use opentui::prelude::*;
//! use opentui::pty::{self, Pty};
//!
//! # let app = App::new(AppOptions::default())?;
//! let mut command = pty::shell();
//! command.arg("-c").arg("echo hello");
//! let process = Pty::spawn(&app, command, 80, 24)?
//!     .on_output(|_cx, bytes| print!("{}", String::from_utf8_lossy(bytes)))
//!     .on_exit(|cx, status| {
//!         println!("exited with {status}");
//!         cx.quit();
//!     });
//! process.write(b"input for the program")?;
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

use crate::app::{App, AppInner, AppProxy, Cx, ProxyError};
use crate::widget::Callbacks;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::io;
use std::process::{Command, ExitStatus};
use std::rc::{Rc, Weak};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Duration;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as os;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as os;

/// Output waiting for the UI thread. Reading stops while it is full, so a program that writes faster than the UI
/// draws waits for it.
const OUTPUT_MAX: usize = 256 * 1024;
/// Input waiting for the program. [`Pty::write`] fails beyond it.
const INPUT_MAX: usize = 4 << 20;
/// After the program exits, its last output may still be on its way: read until the terminal closes or stays quiet
/// this long, then report the exit.
const EXIT_QUIET: Duration = Duration::from_millis(50);
/// How soon to retry a task the app's full queue rejected.
const POST_RETRY: Duration = Duration::from_millis(10);

/// The user's shell: `$SHELL`, or `/bin/sh` when it is unset. On Windows, `%COMSPEC%`, or `cmd.exe`.
pub fn shell() -> Command {
    let (variable, fallback) = if cfg!(windows) { ("COMSPEC", "cmd.exe") } else { ("SHELL", "/bin/sh") };
    let shell = std::env::var_os(variable).filter(|shell| !shell.is_empty());
    Command::new(shell.unwrap_or_else(|| fallback.into()))
}

#[derive(Default)]
struct State {
    output: Vec<u8>,
    /// A delivery task is queued on the UI thread.
    posted: bool,
    input: Vec<u8>,
    /// The program's status, once reaped.
    status: Option<ExitStatus>,
    /// The status for the UI thread, set after the last output.
    exit: Option<ExitStatus>,
    /// The I/O threads have ended; input goes nowhere.
    finished: bool,
    shutdown: bool,
    /// Output bytes read so far, and whether the terminal closed, for a reader thread that cannot time the quiet
    /// period itself.
    #[cfg(windows)]
    received: u64,
    #[cfg(windows)]
    closed: bool,
}

struct Shared {
    state: Mutex<State>,
    /// Tells the I/O threads that the state changed: new input, room for output, or shutdown.
    changed: os::Notify,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        // No code panics while holding the lock, so a poisoned state is still consistent.
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn notify(&self) {
        self.changed.notify();
    }
}

thread_local! {
    static PTYS: RefCell<HashMap<u64, Weak<PtyInner>>> = RefCell::new(HashMap::new());
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

struct PtyInner {
    id: u64,
    app: Weak<AppInner>,
    process: os::Process,
    shared: std::sync::Arc<Shared>,
    threads: RefCell<Vec<JoinHandle<()>>>,
    size: Cell<(u16, u16)>,
    exit: Cell<Option<ExitStatus>>,
    on_output: Callbacks<[u8]>,
    on_exit: Callbacks<ExitStatus>,
}

impl Drop for PtyInner {
    fn drop(&mut self) {
        let _ = PTYS.try_with(|ptys| ptys.try_borrow_mut().map(|mut ptys| ptys.remove(&self.id)));
        self.shared.lock().shutdown = true;
        self.shared.notify();
        // As a terminal window closing does: the program's terminal goes away, which ends a program that does not
        // detach from it.
        self.process.close(&self.shared);
        for thread in self.threads.get_mut().drain(..) {
            let _ = thread.join();
        }
    }
}

/// A program running on a pseudo-terminal. Cloning is cheap and shares the program.
///
/// Dropping the last handle stops the I/O threads, closes the terminal, and hangs up the program (on Unix, its
/// process group). On Unix the program is reaped when it exits, even after that. On Windows a program still running
/// five seconds later is ended, as Windows does after a console window closes.
#[derive(Clone)]
pub struct Pty(Rc<PtyInner>);

impl std::fmt::Debug for Pty {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Pty").field("pid", &self.pid()).field("size", &self.0.size.get()).finish()
    }
}

impl Pty {
    /// Starts `command` on a new `cols` by `rows` pseudo-terminal.
    ///
    /// On Unix the program becomes a session leader with the terminal as its stdin, stdout, stderr, and controlling
    /// terminal. On Windows it gets a pseudoconsole; the command's program, arguments, environment, and working
    /// directory apply, but not its stdio settings, and a cleared environment still inherits this process's
    /// variables. `TERM` defaults to `xterm-256color` and `COLORTERM` to `truecolor` unless the command sets them.
    /// Register [`Self::on_output`] and [`Self::on_exit`] right away: nothing is delivered before the UI thread's next
    /// turn.
    pub fn spawn(app: &App, mut command: Command, cols: u16, rows: u16) -> io::Result<Self> {
        for (name, value) in [("TERM", "xterm-256color"), ("COLORTERM", "truecolor")] {
            if !command.get_envs().any(|(key, _)| key == name) {
                command.env(name, value);
            }
        }
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let (process, shared, threads) = os::spawn(command, cols, rows, app.proxy(), id)?;
        let inner = Rc::new(PtyInner {
            id,
            app: Rc::downgrade(app.inner()),
            process,
            shared,
            threads: RefCell::new(threads),
            size: Cell::new((cols, rows)),
            exit: Cell::new(None),
            on_output: Callbacks::default(),
            on_exit: Callbacks::default(),
        });
        PTYS.with(|ptys| ptys.borrow_mut().insert(id, Rc::downgrade(&inner)));
        Ok(Self(inner))
    }

    /// Handles program output on the UI thread.
    pub fn on_output(&self, mut handler: impl FnMut(&mut Cx<'_>, &[u8]) + 'static) -> Self {
        self.0.on_output.add(move |cx, bytes: &[u8]| handler(cx, bytes));
        self.clone()
    }

    /// Called once, after the last output, when the program exits.
    pub fn on_exit(&self, mut handler: impl FnMut(&mut Cx<'_>, ExitStatus) + 'static) -> Self {
        self.0.on_exit.add(move |cx, status: &ExitStatus| handler(cx, *status));
        self.clone()
    }

    /// Queues bytes for the program's input. Fails with [`io::ErrorKind::BrokenPipe`] once the program exited or the
    /// app ended, and with [`io::ErrorKind::WouldBlock`] when 4 MiB of input is already waiting.
    pub fn write(&self, bytes: &[u8]) -> io::Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        queue_input(&self.0.shared, bytes)
    }

    /// Changes the terminal size; the program gets `SIGWINCH` on Unix and a window size event on Windows.
    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        self.0.process.resize(cols, rows)?;
        self.0.size.set((cols, rows));
        Ok(())
    }

    /// The terminal size in columns and rows.
    pub fn size(&self) -> (u16, u16) {
        self.0.size.get()
    }

    /// The program's process ID. On Unix it leads its own process group.
    pub fn pid(&self) -> u32 {
        self.0.process.pid()
    }

    /// Sends a signal, such as `libc::SIGINT`, to the program's process group. Does nothing once it exited.
    ///
    /// Windows has no signals: there `SIGINT` (2) types Ctrl+C into the terminal, `SIGTERM` (15) and `SIGKILL` (9)
    /// end the program as [`Self::kill`] does, and other numbers fail with [`io::ErrorKind::Unsupported`]. A program
    /// ignores Ctrl+C when it inherits that setting, as programs started from a service or a non-interactive SSH
    /// session do.
    pub fn signal(&self, signal: i32) -> io::Result<()> {
        self.0.process.signal(&self.0.shared, signal)
    }

    /// Kills the program: its process group with `SIGKILL` on Unix, the process with `TerminateProcess` on Windows.
    pub fn kill(&self) -> io::Result<()> {
        self.0.process.kill(&self.0.shared)
    }

    /// The exit status, once [`Self::on_exit`] handlers heard about it.
    pub fn exit_status(&self) -> Option<ExitStatus> {
        self.0.exit.get()
    }

    /// Whether the program runs, as far as the UI thread has heard.
    pub fn is_running(&self) -> bool {
        self.exit_status().is_none()
    }
}

/// Adds bytes to the queue an I/O thread writes to the program.
fn queue_input(shared: &Shared, bytes: &[u8]) -> io::Result<()> {
    {
        let mut state = shared.lock();
        if state.finished || state.status.is_some() {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        if state.input.len() + bytes.len() > INPUT_MAX {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        state.input.extend_from_slice(bytes);
    }
    shared.notify();
    Ok(())
}

/// Drops the handlers of an app's programs when it ends, breaking cycles through captured handles.
pub(crate) fn teardown(app: &App) {
    let ptys: Vec<Rc<PtyInner>> =
        PTYS.with(|ptys| ptys.borrow().values().filter_map(Weak::upgrade).collect::<Vec<_>>());
    for pty in ptys.iter().filter(|pty| std::ptr::eq(pty.app.as_ptr(), Rc::as_ptr(app.inner()))) {
        pty.on_output.clear();
        pty.on_exit.clear();
    }
}

/// Runs on the UI thread: hands queued output, then the exit, to the program's handlers.
fn deliver(id: u64, app: &App) {
    let Some(pty) = PTYS.with(|ptys| ptys.borrow().get(&id).and_then(Weak::upgrade)) else { return };
    let (output, exit, resume) = {
        let mut state = pty.shared.lock();
        state.posted = false;
        let resume = state.output.len() >= OUTPUT_MAX;
        (std::mem::take(&mut state.output), state.exit.take(), resume)
    };
    if resume {
        pty.shared.notify();
    }
    if !output.is_empty() {
        pty.on_output.emit(&mut Cx::new(app), &output);
    }
    if let Some(status) = exit {
        pty.exit.set(Some(status));
        pty.on_exit.emit(&mut Cx::new(app), &status);
    }
}

/// Queues a delivery task for program `id` on the UI thread.
fn post(proxy: &AppProxy, id: u64) -> Result<(), ProxyError> {
    proxy.post(move |cx| deliver(id, cx.app()))
}

/// Ends the I/O. With a status, the UI thread hears about the exit after the output read so far.
fn finish(shared: &Shared, proxy: &AppProxy, id: u64, status: Option<ExitStatus>) {
    let post_exit = {
        let mut state = shared.lock();
        state.finished = true;
        state.input.clear();
        state.exit = status;
        status.is_some() && !std::mem::replace(&mut state.posted, true)
    };
    if post_exit {
        // A full queue still takes the task on a later try; give up only when the app has ended.
        while let Err(ProxyError::Full) = post(proxy, id) {
            if shared.lock().shutdown {
                return;
            }
            std::thread::sleep(POST_RETRY);
        }
    }
}
