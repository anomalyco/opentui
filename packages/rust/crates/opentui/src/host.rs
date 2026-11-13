//! A terminal host: one native Session driven by the local terminal or a [remote one](crate::remote).
//!
//! [`Host`] owns the loop's mechanics: raw mode, terminal setup and restoration, input parsing, capability replies,
//! signals, resizes, suspension, and output delivery. The caller owns the scene and decides when to paint.
//! [`Host::start`] takes over the local terminal; [`Host::start_remote`] drives a
//! [`RemoteTerminal`] instead, without raw mode, signals, or a panic hook.
//!
//! ```no_run
//! use opentui::host::{Host, HostOptions};
//! use opentui::input::Event;
//! use opentui::native::{Node, NodeKind};
//! use opentui::style::Color;
//!
//! fn main() -> opentui::Result<()> {
//!     let mut host = Host::start(HostOptions::default())?;
//!     let root = Node::new(host.session(), NodeKind::Root, 1)?;
//!     let text = Node::new(host.session(), NodeKind::Text, 2)?;
//!     text.insert_into(&root, 0)?;
//!     text.set_text("Hello from Rust. Press q to quit.")?;
//!     let mut dirty = true;
//!     let mut events = Vec::new();
//!     loop {
//!         if dirty && host.can_render()? {
//!             host.present(host.session().paint(Color::TRANSPARENT, true, 0)?)?;
//!             dirty = false;
//!         }
//!         host.poll(None, &mut events)?;
//!         for event in events.drain(..) {
//!             match event {
//!                 Event::Key(key) if key.matches("q") => return host.shutdown(),
//!                 Event::Terminate => return host.shutdown(),
//!                 Event::Resize { .. } | Event::Resumed => dirty = true,
//!                 _ => {}
//!             }
//!         }
//!     }
//! }
//! ```

use crate::error::{Error, Result};
use crate::input::{
    Event, Expectations, Input, OscColor, Parser, is_capability_response, is_color_scheme_notice, is_cursor_report,
    osc_color, pixel_resolution,
};
use crate::native::{
    Context, ContextOptions, Control, Draft, KittyImageReply, KittyKeyboard, MouseTracking, Pump, Remote,
    RenderOutcome, Session, SessionOptions, SessionState, TerminalOptions, TerminalState,
};
use crate::remote::RemoteTerminal;
use crate::split::{Drain, SplitFooter};
use crate::sys;
use crate::term::{self, Ready, Signal, Signals, Terminal, WakePipe, Waker};
use crate::theme::ThemeMode;
use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};
use std::time::{Duration, Instant};

/// Environment variables forwarded to the renderer by default. Native code never reads the process environment.
pub const FORWARDED_ENVIRONMENT: &[&str] = &[
    "TMPDIR",
    "SSH_CONNECTION",
    "SSH_CLIENT",
    "SSH_TTY",
    "MOSH_CONNECTION",
    "TMUX",
    "ZELLIJ",
    "ZELLIJ_SESSION_NAME",
    "ZELLIJ_PANE_ID",
    "TERM",
    "OPENTUI_GRAPHICS",
    "OPENTUI_IMAGE_PROTOCOL",
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "TERM_FEATURES",
    "VTE_VERSION",
    "XTERM_VERSION",
    "KONSOLE_VERSION",
    "FORCE_HYPERLINK",
    "ALACRITTY_SOCKET",
    "ALACRITTY_LOG",
    "COLORTERM",
    "OPENTUI_FORCE_TRUECOLOR",
    "TERMUX_VERSION",
    "VHS_RECORD",
    "OPENTUI_FORCE_WCWIDTH",
    "OPENTUI_FORCE_UNICODE",
    "OPENTUI_FORCE_NOZWJ",
    "OPENTUI_FORCE_EXPLICIT_WIDTH",
    "OPENTUI_NOTIFICATION_PROTOCOL",
    "OPENTUI_NOTIFICATIONS",
    "WT_SESSION",
    "STY",
    "WSL_DISTRO_NAME",
    "WSL_INTEROP",
];

const PUMP_BUDGET: u32 = 64;
const FLUSH_STEPS_MAX: usize = 1024;
const OUTPUT_BYTES_PER_DRAIN: u32 = 256 * 1024;
const READ_BYTES_MAX: usize = 64 * 1024;
/// Close timeouts a whole close or mode change may take, as Core's `NativeSession` caps its close.
const CLOSE_CAP_TIMEOUTS: u32 = 10;
/// How long a pixel size query waits for its reply before another may go out, as Core's reply backstop.
const PIXEL_REPLY_WINDOW: Duration = Duration::from_secs(5);
/// Pixel size queries that may go unanswered before no more go out, as Core's `PIXEL_QUERIES_MAX`.
const PIXEL_QUERIES_MAX: u8 = 4;

/// How a [`Host`] creates its Context and Session and sets up its terminal.
#[derive(Clone, Debug)]
pub struct HostOptions {
    pub context: ContextOptions,
    pub session: SessionOptions,
    /// The terminal modes. [`Self::default`] sets interactive ones, unlike [`TerminalOptions::default`], which turns
    /// every mode off; to change one, start from these: `TerminalOptions { mouse: MouseTracking::Motion,
    /// ..HostOptions::default().terminal }`.
    pub terminal: TerminalOptions,
    /// Whether the renderer may trust the local terminal environment. A [`RemoteTerminal`] is always remote.
    pub remote: Remote,
    /// Names of environment variables to forward to the renderer. A [`RemoteTerminal`] uses the environment it was
    /// created with instead.
    pub environment: Vec<&'static str>,
    /// How long after setup replies to its capability queries are expected. Until then a partial reply waits for its
    /// rest, and cursor position reports count as capability replies, including `CSI 1 ; N R`, which is otherwise a
    /// modified F3 key. A suspension ends the window, as in Core.
    pub capability_window: Duration,
    /// How long closing, or a terminal mode change at setup or suspension, may go without writing a byte; each takes
    /// at most ten times this in all. At either limit a close drops its queued frames and still restores the
    /// terminal, and fails only after another timeout without a byte written; a mode change fails. One second by
    /// default, as Core's `closeTimeoutMs`.
    pub close_timeout: Duration,
    /// Keep the renderer in a footer of this many rows at the bottom of the main screen, with scrollback written
    /// above it through the Session's [`SplitFooter`], as Core's `screenMode: "split-footer"` with captured output.
    /// `None`, the default, renders on the whole screen. The terminal then never uses the alternate screen.
    pub split_footer: Option<u16>,
}

impl Default for HostOptions {
    /// Alternate screen, button mouse tracking, and the Kitty keyboard flags Core enables by default.
    fn default() -> Self {
        Self {
            context: ContextOptions::default(),
            session: SessionOptions::default(),
            terminal: TerminalOptions {
                alternate_screen: true,
                mouse: MouseTracking::Buttons,
                clear_on_close: false,
                kitty_keyboard: KittyKeyboard::DISAMBIGUATE | KittyKeyboard::ALTERNATE_KEYS,
                host_multiplexer: false,
            },
            remote: Remote::Auto,
            environment: FORWARDED_ENVIRONMENT.to_vec(),
            capability_window: Duration::from_secs(5),
            close_timeout: Duration::from_secs(1),
            split_footer: None,
        }
    }
}

impl HostOptions {
    /// How long closing takes to restore the terminal: Core's cap of ten [close timeouts](Self::close_timeout) on the
    /// whole close, then one more, in which the close has dropped its queued frames and writes the restoration. A
    /// transport that asks a remote app to end waits this long for it: see
    /// [`RemoteLink::close_bound`](crate::remote::RemoteLink::close_bound).
    pub fn close_bound(&self) -> Duration {
        self.close_timeout.saturating_mul(CLOSE_CAP_TIMEOUTS + 1)
    }
}

/// Cumulative output delivery counters.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OutputStats {
    /// Bytes written to the terminal.
    pub bytes: u64,
    /// Successful writes to the terminal.
    pub writes: u64,
    /// Calls to [`Session::pump`].
    pub pumps: u64,
}

impl OutputStats {
    /// The counts accumulated since `earlier`.
    pub fn since(self, earlier: Self) -> Self {
        Self {
            bytes: self.bytes.saturating_sub(earlier.bytes),
            writes: self.writes.saturating_sub(earlier.writes),
            pumps: self.pumps.saturating_sub(earlier.pumps),
        }
    }
}

/// State the panic hook needs to restore the terminal before the panic message prints.
struct Restore {
    session: Session,
    terminal: RefCell<Terminal>,
    done: Cell<bool>,
}

impl Restore {
    /// Process-exit restoration: no cursor-settle waits, bounded work, and the terminal modes last.
    fn emergency(&self) {
        if self.done.replace(true) {
            return;
        }
        for _ in 0..FLUSH_STEPS_MAX {
            match self.session.pump_exit() {
                Ok(Pump::Again) => {}
                Ok(Pump::OutputPending) => match self.session.drain_stdout(OUTPUT_BYTES_PER_DRAIN) {
                    Ok(0) if !term::wait_writable(Duration::from_millis(100)) => break,
                    Ok(_) => {}
                    Err(_) => break,
                },
                // Closed, or native code is busy because the panic started inside a native call.
                _ => break,
            }
        }
        self.finish();
    }

    fn finish(&self) {
        self.done.set(true);
        if let Ok(mut terminal) = self.terminal.try_borrow_mut() {
            let _ = terminal.leave_raw();
        }
        // Drop queued mouse reports so the shell does not receive them.
        unsafe { sys::ot_terminal_flush_input() };
    }
}

thread_local! {
    static ACTIVE: RefCell<Option<Weak<Restore>>> = const { RefCell::new(None) };
}

fn install_panic_hook() {
    static HOOK: std::sync::Once = std::sync::Once::new();
    HOOK.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let active = ACTIVE.try_with(|active| active.try_borrow().ok().and_then(|weak| weak.as_ref()?.upgrade()));
            // A panic on the UI thread ends the app, so its message goes to the real stderr, not a console capture.
            // Other threads' panics leave the running app as it is.
            if let Ok(Some(restore)) = active {
                term::restore_stderr();
                restore.emergency();
            }
            previous(info);
        }));
    });
}

/// The terminal a [`Host`] drives.
enum Connection {
    /// The process's terminal: raw mode, signals, and the panic hook's restoration.
    Local {
        restore: Rc<Restore>,
        signals: Signals,
    },
    Remote(RemoteTerminal),
}

/// Restores a remote terminal without waiting for anything but room for output, as [`Restore::emergency`] does for
/// the local one.
fn restore_remote(session: &Session, terminal: &RemoteTerminal) {
    for _ in 0..FLUSH_STEPS_MAX {
        match session.pump_exit() {
            Ok(Pump::Again) => {}
            Ok(Pump::OutputPending) => {
                match session.drain_output(OUTPUT_BYTES_PER_DRAIN, |bytes| Ok(terminal.write_output(bytes))) {
                    Ok(0) if !terminal.wait_room(Duration::from_millis(100)) => break,
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            _ => break,
        }
    }
}

/// One native Session attached to the local terminal or a remote one.
pub struct Host {
    session: Session,
    connection: Connection,
    wake: WakePipe,
    parser: Parser,
    inputs: Vec<Input>,
    read_buffer: Vec<u8>,
    clock: Instant,
    size: (u16, u16),
    render_cells_max: u32,
    pending_resize: Option<(u16, u16)>,
    pump_deadline: Option<u64>,
    pump_again: bool,
    output_blocked: bool,
    force_next_frame: bool,
    /// The mode of the last background color the terminal reported.
    theme_mode: Option<ThemeMode>,
    input_closed: bool,
    /// When the capability window ends; `None` when one too long to represent never ends.
    capability_until: Option<Instant>,
    /// Whether the parser was last told to expect the capability window's replies.
    expecting_replies: bool,
    close_timeout: Duration,
    output: OutputStats,
    split: Option<SplitFooter>,
    /// Whether a query for the terminal's pixel size waits to be sent, as Core sends one at setup and after a resize.
    pixel_query_wanted: bool,
    /// Until when the reply to the last pixel size query is expected. As in Core, only one query waits at a time.
    pixel_reply_until: Option<Instant>,
    /// Pixel size queries not answered yet. Replies apply in arrival order, so a late one still answers its query.
    pixel_queries: u8,
    /// Whether the parser was last told to expect that reply.
    expecting_pixel_reply: bool,
}

/// A deadline that moves on whenever output reaches the terminal, within a cap of ten times its timeout.
struct Progress {
    timeout: Duration,
    bytes: u64,
    deadline: Instant,
    cap: Option<Instant>,
}

impl Progress {
    fn new(timeout: Duration, bytes: u64) -> Self {
        let now = Instant::now();
        Self { timeout, bytes, deadline: now + timeout, cap: Some(now + timeout * CLOSE_CAP_TIMEOUTS) }
    }

    /// Whether the deadline or the cap passed, given the bytes written so far.
    fn expired(&mut self, bytes: u64) -> bool {
        let now = Instant::now();
        if bytes != self.bytes {
            self.bytes = bytes;
            self.deadline = now + self.timeout;
        }
        now >= self.deadline || self.cap.is_some_and(|cap| now >= cap)
    }

    /// Gives one more timeout from now, without the cap.
    fn extend(&mut self) {
        self.deadline = Instant::now() + self.timeout;
        self.cap = None;
    }

    fn until(&self) -> Instant {
        self.cap.map_or(self.deadline, |cap| cap.min(self.deadline))
    }
}

impl Host {
    /// Enters raw mode, attaches a renderer at the terminal's size, and sets up the terminal. Restores the terminal
    /// if any step fails.
    pub fn start(options: HostOptions) -> Result<Self> {
        let session = Self::new_session(&options)?;
        Self::attach(session, options)
    }

    /// Creates a Context and Session with a renderer at the terminal's size, or 80x24 when stdout is not a terminal,
    /// without touching the terminal. [`Self::attach`] takes it over later and parses all its input: parse none first.
    pub fn new_session(options: &HostOptions) -> Result<Session> {
        let size = fit(term::size().unwrap_or((80, 24)), options.context.render_cells_max);
        let context = Context::new(options.context)?;
        let session = Session::new(&context, options.session)?;
        let environment: Vec<(&str, String)> =
            options.environment.iter().filter_map(|key| std::env::var(key).ok().map(|value| (*key, value))).collect();
        let entries: Vec<(&str, &str)> = environment.iter().map(|(key, value)| (*key, value.as_str())).collect();
        let renderer = renderer_size(size, options);
        session.attach_renderer(u32::from(renderer.0), u32::from(renderer.1), options.remote, &entries)?;
        split_footer(&session, size, options)?;
        Ok(session)
    }

    /// Takes over the local terminal for a Session with an attached renderer: enters raw mode, resizes the renderer to
    /// the terminal, sets up the terminal, and parses all its input. Only `terminal`, `capability_window`, and the
    /// Context's `render_cells_max` in `options` apply. Restores the terminal if any step fails.
    pub fn attach(session: Session, mut options: HostOptions) -> Result<Self> {
        // The process's own terminal is a multiplexer pane when one of these is set.
        options.terminal.host_multiplexer |=
            ["TMUX", "STY", "ZELLIJ"].iter().any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()));
        let size = fit(term::size()?, options.context.render_cells_max);
        fit_renderer(&session, size, &options)?;
        let terminal = Terminal::open()?;
        let signals = Signals::install()?;
        let restore =
            Rc::new(Restore { session: session.clone(), terminal: RefCell::new(terminal), done: Cell::new(false) });
        install_panic_hook();
        ACTIVE.with(|active| *active.borrow_mut() = Some(Rc::downgrade(&restore)));
        Self::assemble(session, Connection::Local { restore, signals }, size, options)
    }

    /// Attaches a renderer at a remote terminal's size, then sets up that terminal. The terminal's own environment
    /// replaces `options.environment`, and the renderer is always remote. Nothing touches the local terminal.
    pub fn start_remote(terminal: RemoteTerminal, options: HostOptions) -> Result<Self> {
        let session = Self::new_remote_session(&terminal, &options)?;
        Self::attach_remote(session, terminal, options)
    }

    /// Creates a Context and Session with a renderer at a remote terminal's size and with its environment, without
    /// writing to it. [`Self::attach_remote`] takes it over later and parses all its input: parse none first.
    pub fn new_remote_session(terminal: &RemoteTerminal, options: &HostOptions) -> Result<Session> {
        terminal.set_close_bound(options.close_bound());
        let size = fit(terminal.size(), options.context.render_cells_max);
        let context = Context::new(options.context)?;
        let session = Session::new(&context, options.session)?;
        let entries: Vec<(&str, &str)> =
            terminal.environment().iter().map(|(key, value)| (key.as_str(), value.as_str())).collect();
        let renderer = renderer_size(size, options);
        session.attach_renderer(u32::from(renderer.0), u32::from(renderer.1), Remote::Remote, &entries)?;
        split_footer(&session, size, options)?;
        Ok(session)
    }

    /// Takes over a remote terminal for a Session with an attached renderer, as [`Self::attach`] does the local one.
    /// Restores the remote terminal if any step fails.
    pub fn attach_remote(session: Session, terminal: RemoteTerminal, options: HostOptions) -> Result<Self> {
        terminal.set_close_bound(options.close_bound());
        let size = fit(terminal.size(), options.context.render_cells_max);
        fit_renderer(&session, size, &options)?;
        Self::assemble(session, Connection::Remote(terminal), size, options)
    }

    /// Builds the host and sets up its terminal. From here on, dropping the host restores the terminal.
    fn assemble(session: Session, connection: Connection, size: (u16, u16), mut options: HostOptions) -> Result<Self> {
        let split = split_footer(&session, size, &options)?;
        if split.is_some() {
            options.terminal.alternate_screen = false;
        }
        let mut host = Self {
            parser: Parser::new(&session),
            session,
            connection,
            wake: WakePipe::new()?,
            inputs: Vec::new(),
            read_buffer: vec![0; READ_BYTES_MAX],
            clock: Instant::now(),
            size,
            render_cells_max: options.context.render_cells_max,
            pending_resize: None,
            pump_deadline: None,
            pump_again: false,
            output_blocked: false,
            force_next_frame: true,
            theme_mode: None,
            input_closed: false,
            capability_until: None,
            expecting_replies: false,
            close_timeout: options.close_timeout,
            output: OutputStats::default(),
            split,
            pixel_query_wanted: true,
            pixel_reply_until: None,
            pixel_queries: 0,
            expecting_pixel_reply: false,
        };
        host.session.setup_terminal(options.terminal)?;
        let now = Instant::now();
        host.capability_until = now.checked_add(options.capability_window);
        host.expect_replies(now)?;
        host.drive_until(TerminalState::Active)?;
        if let Some(split) = &host.split {
            split.setup_done(Instant::now());
        }
        // Its reply is one of setup's: expected within the capability window.
        host.query_pixels(options.capability_window.min(PIXEL_REPLY_WINDOW))?;
        Ok(host)
    }

    pub fn session(&self) -> &Session {
        &self.session
    }

    pub fn context(&self) -> &Context {
        self.session.context()
    }

    /// The renderer size in cells: the terminal's, or with a [split footer](HostOptions::split_footer), the
    /// footer's.
    pub fn size(&self) -> (u16, u16) {
        self.split.as_ref().map_or(self.size, SplitFooter::renderer_size)
    }

    /// The split footer, when [`HostOptions::split_footer`] is set.
    pub fn split_footer(&self) -> Option<&SplitFooter> {
        self.split.as_ref()
    }

    /// Whether the host needs a frame painted for its own work: a forced repaint, such as after a capability reply
    /// that changes how images draw or a Kitty reply that asks to send them again, as Core's `requestRender` does, or
    /// scrollback snapshots that wait for one.
    pub fn wants_frame(&self) -> bool {
        self.force_next_frame || self.split.as_ref().is_some_and(SplitFooter::wants_frame)
    }

    /// A handle other threads can use to wake [`Self::poll`], which then reports [`Event::Wake`].
    pub fn waker(&self) -> Waker {
        self.wake.waker()
    }

    /// Output delivered since the host started.
    pub fn output_stats(&self) -> OutputStats {
        self.output
    }

    /// Makes the next presented frame repaint every cell.
    pub fn force_redraw(&mut self) {
        self.force_next_frame = true;
    }

    /// Whether a frame can be painted and presented now: the terminal is active, no resize is waiting, and the
    /// previous frame's output has been delivered.
    pub fn can_render(&self) -> Result<bool> {
        Ok(self.pending_resize.is_none()
            && !self.split.as_ref().is_some_and(|split| split.blocked(Instant::now()))
            && self.session.terminal_state()? == TerminalState::Active
            && !self.session.renderer_state()?.frame_pending)
    }

    /// Commits a painted frame and starts delivering it.
    pub fn present(&mut self, mut draft: Draft) -> Result<RenderOutcome> {
        let force = std::mem::take(&mut self.force_next_frame);
        let outcome = match &self.split {
            Some(split) => split.present(draft, force),
            None => draft.commit(force),
        };
        if !matches!(outcome, Ok(outcome) if outcome.accepted()) {
            self.force_next_frame |= force;
        }
        let outcome = outcome?;
        self.flush()?;
        Ok(outcome)
    }

    fn now_ns(&self) -> u64 {
        // Never zero, so an equal first sample is still a valid clock reading.
        u64::try_from(self.clock.elapsed().as_nanos()).unwrap_or(u64::MAX).max(1)
    }

    /// Pumps native work and delivers output until it is idle, waiting on a deadline, or stdout is full.
    fn flush(&mut self) -> Result<()> {
        self.pump_deadline = None;
        self.pump_again = false;
        self.output_blocked = false;
        for _ in 0..FLUSH_STEPS_MAX {
            self.output.pumps += 1;
            match self.session.pump(self.now_ns(), PUMP_BUDGET)? {
                Pump::Idle | Pump::Closed => return self.settle_split(),
                Pump::Again => {}
                Pump::WaitUntil(deadline) => {
                    self.pump_deadline = Some(deadline);
                    return self.settle_split();
                }
                Pump::OutputPending => match self.deliver()? {
                    0 => {
                        self.output_blocked = true;
                        return Ok(());
                    }
                    written => {
                        self.output.bytes += u64::from(written);
                        self.output.writes += 1;
                    }
                },
            }
        }
        self.pump_again = true;
        Ok(())
    }

    /// Completes the scrollback snapshots of a presented split frame.
    fn settle_split(&self) -> Result<()> {
        match &self.split {
            Some(split) if self.session.state()? == SessionState::Open => split.settle(),
            _ => Ok(()),
        }
    }

    /// Writes queued scrollback snapshots without a footer frame, before suspension or close, as Core does.
    fn drain_split(&mut self) -> Result<()> {
        let Some(split) = self.split.clone() else { return Ok(()) };
        let mut progress = Progress::new(self.close_timeout, self.output.bytes);
        loop {
            self.flush()?;
            match split.drain()? {
                Drain::Done => return Ok(()),
                Drain::Submitted => continue,
                Drain::Wait => {}
            }
            if progress.expired(self.output.bytes) {
                return Err(Error::Usage("scrollback output did not drain"));
            }
            self.wait_for_output(progress.until());
        }
    }

    /// Writes queued output to the terminal. Returns the bytes written; zero means the terminal is full.
    fn deliver(&self) -> Result<u32> {
        match &self.connection {
            Connection::Local { .. } => self.session.drain_stdout(OUTPUT_BYTES_PER_DRAIN),
            Connection::Remote(terminal) => {
                self.session.drain_output(OUTPUT_BYTES_PER_DRAIN, |bytes| Ok(terminal.write_output(bytes)))
            }
        }
    }

    /// Whether the terminal stopped taking output. [`Self::poll`] then also wakes once it takes more.
    pub(crate) fn output_blocked(&self) -> bool {
        self.output_blocked
    }

    /// Whether the host drives a [`RemoteTerminal`].
    pub fn is_remote(&self) -> bool {
        matches!(self.connection, Connection::Remote(_))
    }

    /// The earliest moment the host itself needs another turn.
    fn next_wakeup(&self, deadline: Option<Instant>) -> Option<Instant> {
        if self.pump_again {
            return Some(Instant::now());
        }
        let pump = self.pump_deadline.and_then(|deadline| self.clock.checked_add(Duration::from_nanos(deadline)));
        // The end of the capability window ends a partial reply that waits for it, even when it passed between polls.
        let window = self.capability_until.filter(|_| self.expecting_replies);
        let pixel = self.pixel_reply_until.filter(|_| self.expecting_pixel_reply);
        let seed = self.split.as_ref().and_then(SplitFooter::seed_deadline);
        [deadline, self.parser.deadline(), pump, window, pixel, seed].into_iter().flatten().min()
    }

    /// Tells the parser what the host waits for at `now`, then ends what may no longer wait, as Core does: during the
    /// capability window, replies to setup's queries, including cursor position reports, not modified F3 keys; then
    /// the reply to a pixel size query.
    fn expect_replies(&mut self, now: Instant) -> Result<()> {
        self.expecting_replies = self.capability_until.is_none_or(|until| now < until);
        self.expecting_pixel_reply = self.pixel_reply_until.is_some_and(|until| now < until);
        if !self.expecting_replies
            && let Some(split) = &self.split
        {
            split.replies_ended();
        }
        let expectations = if self.expecting_replies {
            Expectations::CURSOR_POSITION
        } else if self.expecting_pixel_reply {
            Expectations::REPLIES
        } else {
            Expectations::NONE
        };
        self.parser.set_expectations(expectations, now, &mut self.inputs)
    }

    /// Delivers output and waits for input, a signal, a wakeup, or `deadline`, then appends events in arrival order.
    /// `None` waits until something happens.
    pub fn poll(&mut self, deadline: Option<Instant>, events: &mut Vec<Event>) -> Result<()> {
        self.flush()?;
        let reported = events.len();
        self.apply_resize(events)?;
        // A footer height change reported here must not wait for input.
        let timeout = if events.len() > reported {
            Some(Duration::ZERO)
        } else {
            self.next_wakeup(deadline).map(|until| until.saturating_duration_since(Instant::now()))
        };
        let ready = self.wait(timeout)?;
        if ready.wake && self.wake.drain() {
            events.push(Event::Wake);
        }
        let now = Instant::now();
        self.expect_replies(now)?;
        if ready.input {
            self.read_input(now)?;
        }
        self.route(events);
        // Signals come after the input: a suspension reads stdin when it resumes, which makes `ready.input` stale.
        if ready.signals {
            self.handle_signals(events)?;
        }
        self.flush()?;
        self.apply_resize(events)?;
        self.query_pixels(PIXEL_REPLY_WINDOW)
    }

    /// Asks for the terminal's pixel size, and expects the reply for `window`, if a query is wanted, none waits for its
    /// reply, and fewer than [`PIXEL_QUERIES_MAX`] went unanswered. A query the Session refuses, such as one behind a
    /// full output queue or while the terminal is inactive, is tried again at the end of the next poll.
    fn query_pixels(&mut self, window: Duration) -> Result<()> {
        let now = Instant::now();
        if self.pixel_query_wanted
            && self.pixel_reply_until.is_none_or(|until| now >= until)
            && self.pixel_queries < PIXEL_QUERIES_MAX
            && self.session.control(Control::QueryPixelResolution).is_ok()
        {
            self.pixel_query_wanted = false;
            self.pixel_reply_until = Some(now + window);
            self.pixel_queries += 1;
            // Its window runs from now: send it now.
            self.flush()?;
        }
        Ok(())
    }

    /// Waits for the terminal, a wakeup, or `timeout`. A remote terminal reports `signals` and `input` on every turn;
    /// their handlers find out what changed.
    fn wait(&self, timeout: Option<Duration>) -> Result<Ready> {
        match &self.connection {
            Connection::Local { signals, .. } => {
                Ok(term::wait(signals, &self.wake, !self.input_closed, self.output_blocked, timeout)?)
            }
            Connection::Remote(terminal) => {
                // Once input has ended, the end stays readable; it is handled.
                let busy = (!self.input_closed && terminal.readable())
                    || terminal.has_events()
                    || (self.output_blocked && terminal.has_room());
                let timeout = if busy { Some(Duration::ZERO) } else { timeout };
                let [wake, remote] = term::wait_wakes([&self.wake, terminal.wake_pipe()], timeout)?;
                if remote {
                    terminal.wake_pipe().drain();
                }
                Ok(Ready { signals: true, wake, input: !self.input_closed })
            }
        }
    }

    /// Reads input once and parses it, or its end, as arriving at `now`. Returns whether there was any.
    fn read_input(&mut self, now: Instant) -> Result<bool> {
        let read = match &self.connection {
            Connection::Local { .. } => term::read(&mut self.read_buffer)?,
            Connection::Remote(terminal) => terminal.read_input(&mut self.read_buffer),
        };
        match read {
            Some(0) => {
                self.input_closed = true;
                self.inputs.push(Input::Event(Event::Terminate));
                Ok(false)
            }
            Some(count) => {
                self.parser.feed(&self.read_buffer[..count], now, &mut self.inputs)?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Passes parsed events on and handles terminal replies.
    fn route(&mut self, events: &mut Vec<Event>) {
        let mut inputs = std::mem::take(&mut self.inputs);
        for input in inputs.drain(..) {
            match input {
                Input::Event(event) => events.push(event),
                Input::Reply(reply) => self.route_reply(&reply, events),
            }
        }
        self.inputs = inputs;
    }

    fn route_reply(&mut self, reply: &[u8], events: &mut Vec<Event>) {
        // Native setup asks for the theme colors once; a color scheme change asks again.
        if is_color_scheme_notice(reply) {
            let _ = self.session.control(Control::QueryThemeColors);
            events.push(Event::ColorScheme);
            return;
        }
        if let Some(color) = osc_color(reply) {
            if let OscColor::Background(background) = color {
                let mode = ThemeMode::from_background(background);
                if self.theme_mode.replace(mode) != Some(mode) {
                    events.push(Event::ThemeMode(mode));
                }
            }
            events.push(Event::Color(color));
            return;
        }
        if self.pixel_queries > 0
            && let Some((width, height)) = pixel_resolution(reply)
        {
            self.pixel_queries -= 1;
            self.pixel_reply_until = None;
            let (columns, rows) = self.size;
            // After a resize the reply may describe the old size: the wanted query goes out at the end of the poll
            // instead, as Core asks again. A size of zero is no size.
            if !self.pixel_query_wanted
                && width > 0
                && self.session.set_image_resolution(columns.into(), rows.into(), width, height).is_ok()
            {
                self.force_next_frame = true;
            }
            return;
        }
        if reply.starts_with(b"\x1b_G") {
            match self.session.process_kitty_image_reply(reply) {
                Ok(KittyImageReply::Consumed) => return,
                Ok(KittyImageReply::Retransmit) => {
                    self.force_next_frame = true;
                    return;
                }
                Ok(KittyImageReply::Ignored) | Err(_) => {}
            }
        }
        if is_capability_response(reply) || (self.expecting_replies && is_cursor_report(reply)) {
            // A rejected reply is consumed without effect, as in Core.
            if self.session.control(Control::CapabilityResponse(reply)).is_ok() {
                self.force_next_frame = true;
                if is_cursor_report(reply)
                    && let Some(split) = &self.split
                {
                    let _ = split.cursor_reported();
                }
            }
        }
    }

    /// Handles signals, or a remote terminal's resizes and requests to end, which it reports the same way.
    fn handle_signals(&mut self, events: &mut Vec<Event>) -> Result<()> {
        let mut signals = Vec::new();
        match &self.connection {
            Connection::Local { signals: source, .. } => source.drain(&mut signals),
            Connection::Remote(terminal) => {
                if terminal.take_resize().is_some() {
                    signals.push(Signal::Resize);
                }
                if terminal.take_terminate() {
                    signals.push(Signal::Terminate);
                }
            }
        }
        for signal in signals {
            match signal {
                Signal::Resize => self.check_size()?,
                Signal::Interrupt | Signal::Terminate | Signal::Hangup => events.push(Event::Terminate),
                Signal::Suspend => self.suspend(events)?,
                Signal::Continue => {}
            }
        }
        Ok(())
    }

    fn check_size(&mut self) -> Result<()> {
        let size = match &self.connection {
            Connection::Local { .. } => term::size()?,
            Connection::Remote(terminal) => terminal.size(),
        };
        let size = fit(size, self.render_cells_max);
        if size != self.size || self.pending_resize.is_some() {
            self.pending_resize = Some(size);
        }
        Ok(())
    }

    /// Applies a waiting resize once no frame is pending.
    fn apply_resize(&mut self, events: &mut Vec<Event>) -> Result<()> {
        if let Some((width, height)) = self.split.as_ref().and_then(SplitFooter::take_resized) {
            self.force_next_frame = true;
            events.push(Event::Resize { width, height });
        }
        let Some((width, height)) = self.pending_resize else { return Ok(()) };
        let resized = match &self.split {
            Some(split) => split.resize(width, height),
            None => self.session.resize(u32::from(width), u32::from(height)).map(|()| Some((width, height))),
        };
        match resized {
            Ok(None) => Ok(()),
            Ok(Some((renderer_width, renderer_height))) => {
                self.pending_resize = None;
                self.size = (width, height);
                // As Core: the cell size may have changed too, so images go without one until the terminal answers.
                self.session.set_image_resolution(0, 0, 0, 0)?;
                self.pixel_query_wanted = true;
                self.force_next_frame = true;
                events.push(Event::Resize { width: renderer_width, height: renderer_height });
                Ok(())
            }
            Err(error) if matches!(error.status(), Some(crate::Status::OutputBusy | crate::Status::FrameBusy)) => {
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    /// Restores the terminal, stops the process as Ctrl-Z does, and sets the terminal up again after it continues.
    /// Reports [`Event::Resumed`]: paint a new frame. Does nothing on Windows, which has no job control, or for a
    /// remote terminal.
    pub fn suspend(&mut self, events: &mut Vec<Event>) -> Result<()> {
        if cfg!(windows) || !matches!(self.connection, Connection::Local { .. }) {
            return Ok(());
        }
        Ok(self.release(events, term::stop_process)??)
    }

    /// Restores the terminal, runs `task` while another program owns it, and sets the terminal up again after it
    /// returns. Reports [`Event::Resumed`]: paint a new frame. For a remote terminal, `task` runs with the terminal
    /// untouched.
    pub fn release<T>(&mut self, events: &mut Vec<Event>, task: impl FnOnce() -> T) -> Result<T> {
        let Connection::Local { restore, .. } = &self.connection else { return Ok(task()) };
        let restore = Rc::clone(restore);
        let suspended = Instant::now();
        // Core's renderer stops expecting capability replies when it suspends.
        self.capability_until = Some(suspended);
        self.expect_replies(suspended)?;
        self.drain_split()?;
        if let Some(split) = &self.split {
            split.suspended();
        }
        self.session.suspend()?;
        self.drive_until(TerminalState::Suspended)?;
        // As Core, restore errors don't stop the hand-over: conhost can apply a saved mode and still fail the call.
        let _ = restore.terminal.borrow_mut().leave_raw();
        // As Core does once a suspension settles: drop the input the terminal sent meanwhile, such as mouse reports from
        // before restoration turned them off, so the program that takes over does not read it.
        unsafe { sys::ot_terminal_flush_input() };
        let output = task();
        restore.terminal.borrow_mut().enter_raw()?;
        if let Some(split) = &self.split {
            split.before_resume()?;
        }
        self.session.resume()?;
        self.drive_until(TerminalState::Active)?;
        if let Some(split) = &self.split {
            split.resumed()?;
        }
        // As in Core, input time stands still while the terminal is released, so input that waited meanwhile can
        // complete what was partial at suspension. What is still partial after it is stale.
        while self.wait(Some(Duration::ZERO))?.input && self.read_input(suspended)? {}
        self.parser.resume()?;
        self.route(events);
        self.force_next_frame = true;
        self.check_size()?;
        events.push(Event::Resumed);
        Ok(output)
    }

    /// Pumps and delivers output until the terminal reaches `state`.
    fn drive_until(&mut self, state: TerminalState) -> Result<()> {
        let mut progress = Progress::new(self.close_timeout, self.output.bytes);
        loop {
            self.flush()?;
            let current = self.session.terminal_state()?;
            if current == state {
                return Ok(());
            }
            if matches!(current, TerminalState::Failed | TerminalState::Cancelled)
                || progress.expired(self.output.bytes)
            {
                return Err(Error::Usage("terminal did not finish its mode change"));
            }
            self.wait_for_output(progress.until());
        }
    }

    fn wait_for_output(&self, deadline: Instant) {
        let until = self.next_wakeup(Some(deadline)).unwrap_or(deadline);
        let timeout = until.saturating_duration_since(Instant::now()).max(Duration::from_millis(1));
        if self.output_blocked {
            match &self.connection {
                Connection::Local { .. } => term::wait_writable(timeout),
                Connection::Remote(terminal) => terminal.wait_room(timeout),
            };
        } else if !self.pump_again {
            std::thread::sleep(timeout.min(Duration::from_millis(10)));
        }
    }

    /// Restores the terminal and closes the Session gracefully.
    pub fn shutdown(mut self) -> Result<()> {
        let result = self.close();
        match (&self.connection, &result) {
            (Connection::Local { restore, .. }, Ok(())) => restore.finish(),
            (Connection::Local { restore, .. }, Err(_)) => restore.emergency(),
            (Connection::Remote(terminal), Err(_)) => restore_remote(&self.session, terminal),
            (Connection::Remote(_), Ok(())) => {}
        }
        result
    }

    fn close(&mut self) -> Result<()> {
        if self.session.state()? == SessionState::Open {
            if let Some(split) = self.split.clone()
                && self.session.terminal_state()? == TerminalState::Active
            {
                // As Core's destroy: queued scrollback goes out first. A footer change waiting for it follows.
                self.drain_split()?;
                split.apply_pending()?;
                self.flush()?;
            }
            self.session.close()?;
        }
        let mut progress = Progress::new(self.close_timeout, self.output.bytes);
        let mut late = false;
        loop {
            self.flush()?;
            // A late close restored the terminal too; only its queued frames are lost, as Core's renderer treats it.
            if self.session.state()? == SessionState::Closed {
                return Ok(());
            }
            if progress.expired(self.output.bytes) {
                if late {
                    return Err(Error::Usage("terminal restoration timed out"));
                }
                // On a slow link the restoration would wait behind every queued frame: drop them and restore.
                late = true;
                self.session.drop_output()?;
                progress.extend();
            }
            self.wait_for_output(progress.until());
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        match &self.connection {
            Connection::Local { restore, .. } => {
                restore.emergency();
                let _ = ACTIVE.try_with(|active| active.borrow_mut().take());
            }
            Connection::Remote(terminal) => restore_remote(&self.session, terminal),
        }
    }
}

/// The renderer size for a terminal of `size` cells: the footer's rows with a split footer.
fn renderer_size(size: (u16, u16), options: &HostOptions) -> (u16, u16) {
    match options.split_footer {
        Some(footer) => SplitFooter::renderer_size_for(size, footer),
        None => size,
    }
}

/// The Session's split footer for a terminal of `size` cells, created when `options` ask for one and it has none.
fn split_footer(session: &Session, size: (u16, u16), options: &HostOptions) -> Result<Option<SplitFooter>> {
    let Some(footer_height) = options.split_footer else { return Ok(None) };
    match SplitFooter::of(session) {
        Some(footer) => {
            footer.attached(size);
            Ok(Some(footer))
        }
        None => SplitFooter::new(session, size, footer_height).map(Some),
    }
}

/// Resizes the renderer to fit a terminal of `size` cells unless it already has that size.
fn fit_renderer(session: &Session, size: (u16, u16), options: &HostOptions) -> Result<()> {
    // A footer whose height changed since the Session was created keeps that height, as Core's renderer does.
    let (width, height) = match SplitFooter::of(session).filter(|_| options.split_footer.is_some()) {
        Some(footer) => SplitFooter::renderer_size_for(size, footer.footer_height()),
        None => renderer_size(size, options),
    };
    let renderer = session.renderer_state()?;
    if (renderer.width, renderer.height) != (u32::from(width), u32::from(height)) {
        session.resize(u32::from(width), u32::from(height))?;
    }
    Ok(())
}

/// Shrinks a terminal size so the renderer stays within the Context's cell limit.
fn fit((width, height): (u16, u16), cells_max: u32) -> (u16, u16) {
    let cells_max = cells_max.max(1);
    let width = u32::from(width.max(1)).min(cells_max);
    let height = u32::from(height.max(1)).min((cells_max / width).max(1));
    // Both values started as u16 and only shrank.
    (width as u16, height as u16)
}

#[cfg(test)]
mod tests {
    use super::{Host, HostOptions, fit, install_panic_hook};
    use crate::input::{ESCAPE_TIMEOUT, Event, KeyCode, KeyEvent, Modifiers};
    use crate::remote::{RemoteLink, RemoteOptions, RemoteTerminal};
    use crate::term::StderrCapture;
    use crate::term::tests::{STDERR_LOCK, write_stderr};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[test]
    fn sizes_fit_the_cell_limit() {
        assert_eq!(fit((80, 24), 512 * 512), (80, 24));
        assert_eq!(fit((1000, 1000), 512 * 512), (1000, 262));
        assert_eq!(fit((0, 0), 100), (1, 1));
        assert_eq!(fit((200, 10), 100), (100, 1));
    }

    // Expected: a partial reply that waits during the capability window ends when the window does, letting the
    // Escape held before it through, also when the window ends while the app is busy between polls, and before
    // the end of input that follows it. Actual: `poll` woke for the end of the window only while it lay ahead, so
    // after a busy spell the Escape came only with the next input; and `Event::Terminate` came before the Escape.
    #[test]
    fn a_capability_window_that_ends_between_polls_holds_input_until_more_arrives() {
        let escape = Event::Key(KeyEvent::new(KeyCode::Escape, Modifiers::NONE));
        // With no window, expectations never change, so `poll` itself ends a lone Escape before the end of input.
        for (input, window, late, end, expected) in [
            (b"\x1b\x1b[?62".as_slice(), 300, b"".as_slice(), (|_| {}) as fn(&RemoteLink), vec![escape.clone()]),
            (b"\x1b\x1b[?62", 300, b"", RemoteLink::disconnect, vec![escape.clone(), Event::Terminate]),
            (b"\x1b", 0, b"", RemoteLink::disconnect, vec![escape, Event::Terminate]),
            // Input that comes with a request to end is reported first; `poll` once handled signals before input.
            (b"", 0, b"a", RemoteLink::terminate, vec![Event::Key(KeyCode::Char('a').into()), Event::Terminate]),
        ] {
            let (terminal, link) = RemoteTerminal::new(RemoteOptions::default(), || {}).expect("create a terminal");
            let window = Duration::from_millis(window);
            let options = HostOptions { capability_window: window, ..HostOptions::default() };
            let mut host = Host::start_remote(terminal, options).expect("start the host");
            let mut events = Vec::new();
            link.send_input(input);
            // The reply waits past the parser's timeout, then the window ends while the app is busy.
            let settled = Instant::now() + window / 3;
            host.poll(Some(settled), &mut events).expect("read the input");
            while Instant::now() < settled {
                host.poll(Some(settled), &mut events).expect("poll in the window");
            }
            std::thread::sleep(window + ESCAPE_TIMEOUT);
            link.send_input(late);
            end(&link);
            let polled = Instant::now();
            host.poll(Some(polled + Duration::from_secs(2)), &mut events).expect("poll after the window");
            assert!(polled.elapsed() < Duration::from_secs(1), "poll waited past the window's end");
            assert_eq!(events, expected);
        }
        // In the window cursor reports reach native code, which takes the first as the cursor's position at setup and
        // the next two as the answers to its explicit-width probes.
        let (terminal, link) = RemoteTerminal::new(RemoteOptions::default(), || {}).expect("create a terminal");
        let mut host = Host::start_remote(terminal, HostOptions::default()).expect("start the host");
        link.send_input(b"\x1b[5;10R\x1b[2;2R\x1b[2;3R");
        host.poll(Some(Instant::now() + Duration::from_secs(1)), &mut Vec::new()).expect("read the replies");
        let flags = host.session().capabilities().expect("read the capabilities").flags;
        assert!(flags.contains(crate::native::CapabilityFlags::EXPLICIT_WIDTH), "{flags:?}");
    }

    // Expected, as in Core: a pixel size query is written when it is made, a reply without a size leaves no error, a
    // partial reply held for the query ends with its reply window, and no query goes out after four went unanswered.
    #[test]
    fn pixel_size_queries_end_their_wait_and_stop_when_unanswered() {
        let (terminal, link) = RemoteTerminal::new(RemoteOptions::default(), || {}).expect("create a terminal");
        let options = HostOptions { capability_window: Duration::ZERO, ..HostOptions::default() };
        let mut host = Host::start_remote(terminal, options).expect("start the host");
        let queried = || String::from_utf8_lossy(&link.take_output(usize::MAX)).contains("\x1b[14t");
        assert!(queried(), "setup left its query unwritten");
        link.send_input(b"\x1b[4;0;0t");
        host.poll(Some(Instant::now()), &mut Vec::new()).expect("read the reply");
        assert_eq!(host.context().last_error().expect("read the last error"), None);
        host.pixel_reply_until = Some(Instant::now() + Duration::from_millis(100));
        link.send_input(b"\x1b\x1b[4;700;");
        let (mut events, polled) = (Vec::new(), Instant::now());
        while events.is_empty() && polled.elapsed() < Duration::from_secs(2) {
            host.poll(Some(polled + Duration::from_secs(2)), &mut events).expect("poll in the window");
        }
        assert!(polled.elapsed() < Duration::from_secs(1), "poll waited past the reply window");
        assert_eq!(events, [Event::Key(KeyEvent::new(KeyCode::Escape, Modifiers::NONE))]);
        for (unanswered, width, query) in [(1, 100, true), (super::PIXEL_QUERIES_MAX, 120, false)] {
            host.pixel_queries = unanswered;
            host.pixel_reply_until = None;
            queried();
            link.resize(width, 30);
            host.poll(Some(Instant::now() + Duration::from_millis(50)), &mut events).expect("poll the resize");
            assert_eq!(queried(), query, "{unanswered} unanswered");
        }
    }

    // Expected: with `AppOptions::capture_stderr`, a panic on a worker thread leaves the capture in place: the UI
    // thread keeps the terminal, so stderr output must keep going to the console instead of over the screen.
    // Actual: the panic hook restored stderr for a panic on any thread, so after one worker panic every later
    // `eprintln!` was written over the running app's screen.
    #[test]
    fn a_worker_thread_panic_ends_stderr_capture_for_the_running_app() {
        let _guard = STDERR_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        install_panic_hook();
        let (line_tx, line_rx) = mpsc::channel();
        let capture = StderrCapture::start(move |line| {
            let _ = line_tx.send(line);
        })
        .expect("start capturing stderr");
        let _ = std::thread::spawn(|| panic!("a worker thread failed")).join();
        write_stderr(b"after-the-worker-panic\n");
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        let mut captured = false;
        while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
            match line_rx.recv_timeout(left) {
                Ok(line) if line.contains("after-the-worker-panic") => {
                    captured = true;
                    break;
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        drop(capture.stop());
        assert!(captured, "stderr written after a worker panic escaped the capture");
    }
}
