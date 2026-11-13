//! The application: one scene, its event loop, focus, timers, and messages from other threads.
//!
//! ```no_run
//! use opentui::prelude::*;
//!
//! fn main() -> opentui::Result<()> {
//!     let app = App::new(AppOptions::default())?;
//!     let status = Text::new(&app, "Pick a task").fg(app.theme().muted);
//!     let list = Select::new(&app).options(["Build", "Test", "Ship"]).grow(1.0);
//!     app.root().add(&View::new(&app).border(BorderStyle::Rounded).title(" Tasks ").padding(1).grow(1.0).child(&list));
//!     app.root().add(&status);
//!     list.on_select(move |_cx, _index, option| {
//!         status.set_text(format!("Selected {}", option.name));
//!     });
//!     app.on_key(|cx, key| {
//!         if key.matches("q") {
//!             cx.quit();
//!         }
//!     });
//!     list.focus();
//!     app.run()
//! }
//! ```

mod clipboard;
mod headless;
mod palette;
mod post;
mod proxy;
mod selection;
#[cfg(feature = "tokio")]
mod tasks;
mod timer;

pub use crate::native::Corner;
pub use headless::{HeadlessOptions, HeadlessWrite};
pub use proxy::{AppProxy, PROXY_CAPACITY, ProxyError};

#[cfg(feature = "tokio")]
pub use tasks::TaskHandle;
pub use timer::TimerId;

use crate::error::{Error, Result, Status};
use crate::host::{Host, HostOptions};
use crate::input::{Event, KeyCode, KeyEvent, MouseButton, MouseEvent, MouseEventKind};
use crate::native::{
    Context, Control, CursorUpdate, Draft, FrameOptions, HostRequest, MousePointer, ProgramStatus, Pump, Remote,
    RenderOutcome, RendererState, Session, WidthMethod,
};
use crate::post::{Area, PostState};
use crate::remote::RemoteTerminal;
use crate::term::{QueryPort, TerminalPalette};
use crate::theme::{Theme, ThemeMode};
use crate::widget::{AnyWidget, Behavior, Callbacks, Element, Painter, View, Widget};
use std::any::{Any, TypeId};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, VecDeque};
use std::ops::Deref;
use std::rc::{Rc, Weak};
use std::sync::Arc;
use std::time::{Duration, Instant};

thread_local! {
    /// More environment the terminal of a headless app made on this thread reports
    /// ([`crate::testing::TestApp::with_hyperlinks`]).
    pub(crate) static HEADLESS_ENVIRONMENT: RefCell<Vec<(&'static str, &'static str)>> = const { RefCell::new(Vec::new()) };
}

/// How an [`App`] runs.
#[derive(Clone, Debug)]
#[must_use]
pub struct AppOptions {
    /// Native limits, terminal modes, and forwarded environment.
    pub host: HostOptions,
    /// The colors widgets start with. With [`Self::light_theme`] set, this is the theme for dark backgrounds.
    pub theme: Theme,
    /// Replaces [`Self::theme`] when the terminal has a light background: [`App::new`] asks the terminal for its
    /// colors, waiting at most a quarter second. `Some(Theme::light())` by default; `None` always uses
    /// [`Self::theme`]. [`Self::with_theme`] sets one theme for every terminal.
    pub light_theme: Option<Theme>,
    /// Palette entries [`App::new`] asks the terminal for, with its default and cursor colors (up to 256; 0, the
    /// default, asks for none). [`App::palette`] returns them, and native code uses them to pick palette colors on
    /// terminals without true color.
    pub palette_size: u16,
    /// The most frames per second. Input is handled as it arrives; only painting is capped. Zero counts as one.
    pub max_fps: u32,
    /// Ctrl+C ends the app unless a handler consumes it.
    pub exit_on_ctrl_c: bool,
    /// Ctrl+Z suspends the app to the shell unless a handler consumes it. Off by default on Windows, which has no job
    /// control, so Ctrl+Z reaches handlers there. A [remote](App::remote) app never suspends.
    pub suspend_on_ctrl_z: bool,
    /// Tab and Shift+Tab move focus unless a handler consumes them.
    pub tab_focus: bool,
    /// A left click focuses the nearest focusable widget under the pointer, as Core's `autoFocus` does. A terminal
    /// focuses on a left press either way.
    pub focus_on_click: bool,
    /// Copy text selected with the mouse to the clipboard when the button is released, as
    /// [`App::copy_to_clipboard`] does. An [`App::on_selection`] handler can skip the copy with
    /// [`Cx::prevent_default`].
    pub copy_on_select: bool,
    /// While the app runs, send what the process writes to stderr (such as `eprintln!`) to the
    /// [console](crate::console) instead of the screen, then write it to the real stderr once the terminal is
    /// restored. Off by default. A [remote](App::remote) app ignores it: its process's stderr is not its screen.
    pub capture_stderr: bool,
    /// The terminal window title while the app runs; [`App::set_title`] changes it.
    pub title: Option<String>,
}

impl Default for AppOptions {
    /// Core's defaults: mouse motion tracking for hover, 60 frames per second, and the usual shortcuts.
    fn default() -> Self {
        let mut host = HostOptions::default();
        host.terminal.mouse = crate::native::MouseTracking::Motion;
        Self {
            host,
            theme: Theme::dark(),
            light_theme: Some(Theme::light()),
            palette_size: 0,
            max_fps: 60,
            exit_on_ctrl_c: true,
            suspend_on_ctrl_z: cfg!(unix),
            tab_focus: true,
            focus_on_click: true,
            copy_on_select: true,
            capture_stderr: false,
            title: None,
        }
    }
}

impl AppOptions {
    /// Uses `theme` whatever the terminal's background.
    pub fn with_theme(mut self, theme: Theme) -> Self {
        self.theme = theme;
        self.light_theme = None;
        self
    }

    /// Uses `dark` or `light`, depending on the terminal's background.
    pub fn with_themes(mut self, dark: Theme, light: Theme) -> Self {
        self.theme = dark;
        self.light_theme = Some(light);
        self
    }

    /// Sets the terminal window title while the app runs.
    pub fn with_title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }
}

/// Frame statistics for the debug overlay.
#[derive(Clone, Copy)]
struct FrameStats {
    corner: Option<Corner>,
    /// The corner the overlay last showed in, for toggling it back.
    last_corner: Corner,
    /// The start of the current one-second window, frames painted in it, and the last full window's count.
    window: Option<Instant>,
    frames: u32,
    fps: u32,
}

/// Event flow for one event: handlers can stop it from reaching later handlers or skip built-in behavior.
///
/// `Cx` dereferences to the [`App`], so app methods such as [`App::quit`] work directly on it.
pub struct Cx<'a> {
    app: &'a App,
    stopped: bool,
    prevented: bool,
}

impl<'a> Cx<'a> {
    pub(crate) fn new(app: &'a App) -> Self {
        Self { app, stopped: false, prevented: false }
    }

    pub fn app(&self) -> &'a App {
        self.app
    }

    /// Stops the event from reaching later handlers and ancestors.
    pub fn stop_propagation(&mut self) {
        self.stopped = true;
    }

    /// Skips built-in behavior for this event, such as an input inserting a typed character or Tab moving focus.
    /// Handlers still run.
    pub fn prevent_default(&mut self) {
        self.prevented = true;
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped
    }

    pub fn is_default_prevented(&self) -> bool {
        self.prevented
    }
}

impl Deref for Cx<'_> {
    type Target = App;

    fn deref(&self) -> &App {
        self.app
    }
}

enum Clock {
    Real(Instant),
    Manual { start: Instant, now: Cell<Instant> },
}

impl Clock {
    fn now(&self) -> Instant {
        match self {
            Self::Real(_) => Instant::now(),
            Self::Manual { now, .. } => now.get(),
        }
    }

    fn start(&self) -> Instant {
        match self {
            Self::Real(start) | Self::Manual { start, .. } => *start,
        }
    }
}

/// A frame that was not drawn because its output, without image uploads, is larger than one frame of Session
/// output. See [`App::on_frame_dropped`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameDropped {
    /// The frame's encoded size in bytes.
    pub bytes: u32,
    /// The most bytes one frame can write: [`Session::write_limit`].
    pub limit: u64,
}

/// Identifies a handler that an `App::on_*` method added, for [`App::remove_handler`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct HandlerId(u64);

impl HandlerId {
    /// An id no other handler in the process has.
    pub(crate) fn next() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        Self(NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
    }
}

#[derive(Default)]
struct AppHandlers {
    key_capture: Callbacks<KeyEvent>,
    key: Callbacks<KeyEvent>,
    paste: Callbacks<str>,
    mouse: Callbacks<MouseEvent>,
    resize: Callbacks<(u16, u16)>,
    terminal_focus: Callbacks<bool>,
    selection: Callbacks<str>,
    theme_mode: Callbacks<ThemeMode>,
    color_scheme: Callbacks<()>,
    palette: Callbacks<TerminalPalette>,
    frame_dropped: Callbacks<FrameDropped>,
}

/// Handlers for one message type. Shared, so delivering a message holds no borrow of the map while they run.
type MessageHandlers = Rc<Callbacks<dyn Any>>;
type Deferred = Box<dyn FnOnce(&mut Cx<'_>)>;

type AnimationStep = Box<dyn FnMut(&mut Cx<'_>, Duration) -> bool>;

/// A drag in progress: the widget it started on, kept alive so a source removed mid-drag still ends it, and the
/// widgets under the pointer it has entered.
type DragState = (Rc<dyn Behavior>, Vec<Weak<dyn Behavior>>);

struct Animation {
    last: Instant,
    step: AnimationStep,
}

pub(crate) struct AppInner {
    session: Session,
    options: AppOptions,
    /// The theme new widgets read, from [`AppOptions`] until [`App::set_theme`] changes it.
    theme: Cell<Theme>,
    /// Whether the app runs on a remote terminal, which waits here until [`App::run`].
    remote: bool,
    remote_terminal: RefCell<Option<RemoteTerminal>>,
    /// A detached app's parent Session, whose terminal state it copies before it measures text.
    parent: std::cell::OnceCell<Session>,
    root: RefCell<Option<View>>,
    registry: RefCell<HashMap<u32, Weak<dyn Behavior>>>,
    next_num: Cell<u32>,
    focus: RefCell<Option<Weak<dyn Behavior>>>,
    hover: RefCell<Vec<Weak<dyn Behavior>>>,
    capture: RefCell<Option<Weak<dyn Behavior>>>,
    selection: RefCell<Option<selection::TextSelection>>,
    drag: RefCell<Option<DragState>>,
    last_click: Cell<Option<selection::Click>>,
    pointer: Cell<Option<(u16, u16)>>,
    dirty: Cell<bool>,
    quit: Cell<bool>,
    suspend: Cell<bool>,
    release: RefCell<Option<Deferred>>,
    in_frame: Cell<bool>,
    frame: Cell<u64>,
    error: RefCell<Option<Error>>,
    clock: Clock,
    timers: RefCell<timer::Timers>,
    animations: RefCell<Vec<Animation>>,
    timelines: RefCell<Vec<Weak<crate::animation::TimelineInner>>>,
    deferred: RefCell<VecDeque<Deferred>>,
    handlers: AppHandlers,
    messages: RefCell<HashMap<TypeId, MessageHandlers>>,
    proxy: Arc<proxy::Shared>,
    size: Cell<(u16, u16)>,
    title: RefCell<Option<String>>,
    terminal_active: Cell<bool>,
    theme_mode: Cell<Option<ThemeMode>>,
    palette: RefCell<Option<TerminalPalette>>,
    palette_epoch: Cell<u32>,
    palette_refresh: RefCell<Option<palette::Refresh>>,
    stats: Cell<FrameStats>,
    /// The renderer's dropped frame count already reported, and whether a frame was dropped since the last drawn
    /// one.
    dropped_frames: Cell<u32>,
    drop_retried: Cell<bool>,
    /// The pointer shape the hovered widgets ask for, and the one last sent to the terminal.
    mouse_pointer: Cell<(MousePointer, Option<MousePointer>)>,
    clipboard: RefCell<clipboard::HostClipboard>,
    /// Set for an app from [`App::headless`].
    headless: std::cell::OnceCell<headless::HeadlessState>,
    pub(crate) console: RefCell<crate::console::ConsoleState>,
    console_id: Cell<u64>,
    next_filter: Cell<u64>,
    /// Filtered widgets the current frame paints, with their areas, in paint order.
    filter_areas: RefCell<Vec<(Rc<dyn Behavior>, Area)>>,
    post: RefCell<PostState>,
    #[cfg(feature = "tokio")]
    tasks: RefCell<HashMap<u64, tasks::Completion>>,
    #[cfg(feature = "tokio")]
    next_task: Cell<u64>,
    #[cfg(feature = "tokio")]
    runtime: RefCell<tasks::Runtime>,
}

impl Drop for AppInner {
    /// Stops messages for an app that never ran, so they reach the live ones.
    fn drop(&mut self) {
        crate::console::unregister(self.console_id.get());
    }
}

impl AppInner {
    pub(crate) fn allocate_num(&self) -> u32 {
        let num = self.next_num.get();
        self.next_num.set(num.checked_add(1).expect("widget numbers exhausted"));
        num
    }

    pub(crate) fn register(&self, num: u32, widget: Weak<dyn Behavior>) {
        self.registry.borrow_mut().insert(num, widget);
    }

    pub(crate) fn unregister(&self, num: u32) {
        if let Ok(mut registry) = self.registry.try_borrow_mut() {
            registry.remove(&num);
        }
    }

    pub(crate) fn next_filter_id(&self) -> u64 {
        let id = self.next_filter.get();
        self.next_filter.set(id + 1);
        id
    }

    /// Remembers a timeline so teardown can drop its handlers.
    pub(crate) fn register_timeline(&self, timeline: Weak<crate::animation::TimelineInner>) {
        let mut timelines = self.timelines.borrow_mut();
        timelines.retain(|timeline| timeline.strong_count() > 0);
        timelines.push(timeline);
    }
}

/// Deferred notifications and timers per turn; more wait for the next turn.
const TURN_WORK_MAX: usize = 4096;

/// How long [`App::new`] and [`App::remote`] wait for the terminal to report its colors.
const COLOR_QUERY_WAIT: Duration = Duration::from_millis(250);

/// Whether `options` need the terminal's colors: to pick a light theme, or for the palette.
fn wants_colors(options: &AppOptions) -> bool {
    options.palette_size > 0 || options.light_theme.is_some()
}

/// Asks the terminal for the palette `options` wants, or else only for its colors. One round trip answers both
/// questions; the palette query includes the theme colors.
fn ask_terminal(options: &AppOptions, port: &mut impl QueryPort) -> (Option<ThemeMode>, Option<TerminalPalette>) {
    if options.palette_size > 0 {
        let palette = crate::term::palette_on(port, options.palette_size, COLOR_QUERY_WAIT).ok();
        (palette.as_ref().and_then(TerminalPalette::mode), palette)
    } else {
        (crate::term::colors_on(port, COLOR_QUERY_WAIT).ok().and_then(|colors| colors.mode()), None)
    }
}

/// Switches to the light theme for a light background.
fn apply_theme_mode(options: &mut AppOptions, mode: Option<ThemeMode>) {
    if let (Some(ThemeMode::Light), Some(light)) = (mode, options.light_theme) {
        options.theme = light;
    }
}

/// A terminal application: one native scene, its widgets, and its event loop.
///
/// `App` is a cheap [`Clone`] handle. It is single-threaded; use [`App::proxy`] to reach it from other threads.
#[derive(Clone)]
pub struct App(Rc<AppInner>);

impl std::fmt::Debug for App {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("App").field("size", &self.0.size.get()).finish_non_exhaustive()
    }
}

impl App {
    /// Creates an app sized to the terminal. The terminal is set up for the app only in [`Self::run`].
    ///
    /// To choose between [`AppOptions::theme`] and [`AppOptions::light_theme`], or to read the palette
    /// [`AppOptions::palette_size`] asks for, it first asks the terminal for its colors: it puts the terminal in raw
    /// mode for up to a quarter second, and input typed meanwhile is lost. [`AppOptions::with_theme`] with no palette
    /// skips that.
    pub fn new(mut options: AppOptions) -> Result<Self> {
        let port = if wants_colors(&options) { crate::term::LocalPort::open().ok().flatten() } else { None };
        // Dropping the port restores the terminal.
        let (mode, palette) = port.map_or((None, None), |mut port| ask_terminal(&options, &mut port));
        apply_theme_mode(&mut options, mode);
        let session = Host::new_session(&options.host)?;
        Ok(Self::with_session(session, options, Clock::Real(Instant::now()), None)?.detected(mode, palette))
    }

    /// Creates an app for a [remote terminal](crate::remote), such as an SSH client's, sized to it. Like
    /// [`Self::new`], it first asks the terminal for its colors, over the connection. [`Self::run`] then runs on the
    /// remote terminal and never touches the local one, signals, or stderr, so each thread of a process can run its
    /// own remote app.
    pub fn remote(mut terminal: RemoteTerminal, mut options: AppOptions) -> Result<Self> {
        let (mode, palette) = if wants_colors(&options) { ask_terminal(&options, &mut terminal) } else { (None, None) };
        apply_theme_mode(&mut options, mode);
        let session = Host::new_remote_session(&terminal, &options.host)?;
        let app = Self::with_session(session, options, Clock::Real(Instant::now()), Some(terminal))?;
        Ok(app.detected(mode, palette))
    }

    fn detected(self, mode: Option<ThemeMode>, palette: Option<TerminalPalette>) -> Self {
        self.0.theme_mode.set(mode);
        *self.0.palette.borrow_mut() = palette;
        self
    }

    /// Whether the app runs on a remote terminal, from [`Self::remote`].
    pub fn is_remote(&self) -> bool {
        self.0.remote
    }

    /// The terminal's colors, when [`AppOptions::palette_size`] asked for them and the terminal answered.
    pub fn palette(&self) -> Option<TerminalPalette> {
        self.0.palette.borrow().clone()
    }

    /// Creates an app without a terminal that runs in real time. [`Self::run`] runs its event loop: timers fire,
    /// [`AppProxy`] tasks run, and frames are painted as on a terminal, and each frame's cells go to
    /// [`Self::on_headless_frame`] handlers. Clipboard copies, notifications, and title changes go to
    /// [`Self::on_headless_write`] handlers. Input comes from the proxy: tasks call [`Self::dispatch`],
    /// [`Self::resize`], and [`Self::capture`]. See [`HeadlessOptions`].
    pub fn headless(options: HeadlessOptions) -> Result<Self> {
        let session = Self::headless_session(options.width, options.height, &options.app)?;
        let app = Self::with_session(session, options.app, Clock::Real(Instant::now()), None)?;
        let _ = app.0.headless.set(headless::HeadlessState::default());
        Ok(app)
    }

    /// An app without a terminal, with a manual clock, for tests. See [`crate::testing::TestApp`].
    pub(crate) fn manual(width: u16, height: u16, options: AppOptions) -> Result<Self> {
        let session = Self::headless_session(width, height, &options)?;
        let start = Instant::now();
        Self::with_session(session, options, Clock::Manual { start, now: Cell::new(start) }, None)
    }

    fn headless_session(width: u16, height: u16, options: &AppOptions) -> Result<Session> {
        let context = Context::new(options.host.context)?;
        let session = Session::new(&context, options.host.session)?;
        let mut environment = vec![("TERM", "xterm-256color"), ("COLORTERM", "truecolor")];
        HEADLESS_ENVIRONMENT.with_borrow(|extra| environment.extend_from_slice(extra));
        session.attach_renderer(u32::from(width.max(1)), u32::from(height.max(1)), Remote::Remote, &environment)?;
        Ok(session)
    }

    /// An app on a detached Session that never runs, for painting widgets offscreen, with a manual clock.
    pub(crate) fn detached(session: Session, parent: Session, options: AppOptions) -> Result<Self> {
        let start = Instant::now();
        let app = Self::with_session(session, options, Clock::Manual { start, now: Cell::new(start) }, None)?;
        let _ = app.0.parent.set(parent);
        Ok(app)
    }

    fn with_session(
        session: Session,
        options: AppOptions,
        clock: Clock,
        remote_terminal: Option<RemoteTerminal>,
    ) -> Result<Self> {
        let renderer = session.renderer_state()?;
        let title = options.title.clone();
        let remote = remote_terminal.is_some();
        let app = Self(Rc::new(AppInner {
            session,
            theme: Cell::new(options.theme),
            options,
            remote,
            remote_terminal: RefCell::new(remote_terminal),
            parent: std::cell::OnceCell::new(),
            root: RefCell::new(None),
            registry: RefCell::new(HashMap::new()),
            next_num: Cell::new(1),
            focus: RefCell::new(None),
            hover: RefCell::new(Vec::new()),
            capture: RefCell::new(None),
            selection: RefCell::new(None),
            drag: RefCell::new(None),
            last_click: Cell::new(None),
            pointer: Cell::new(None),
            dirty: Cell::new(true),
            quit: Cell::new(false),
            suspend: Cell::new(false),
            release: RefCell::new(None),
            in_frame: Cell::new(false),
            frame: Cell::new(0),
            error: RefCell::new(None),
            clock,
            timers: RefCell::new(timer::Timers::default()),
            animations: RefCell::new(Vec::new()),
            timelines: RefCell::new(Vec::new()),
            deferred: RefCell::new(VecDeque::new()),
            handlers: AppHandlers::default(),
            messages: RefCell::new(HashMap::new()),
            proxy: Arc::new(proxy::Shared::default()),
            size: Cell::new((renderer.width as u16, renderer.height as u16)),
            title: RefCell::new(title),
            terminal_active: Cell::new(false),
            theme_mode: Cell::new(None),
            palette: RefCell::new(None),
            palette_epoch: Cell::new(0),
            palette_refresh: RefCell::new(None),
            stats: Cell::new(FrameStats {
                corner: None,
                last_corner: Corner::default(),
                window: None,
                frames: 0,
                fps: 0,
            }),
            dropped_frames: Cell::new(0),
            drop_retried: Cell::new(false),
            mouse_pointer: Cell::new((MousePointer::DEFAULT, None)),
            clipboard: RefCell::new(clipboard::HostClipboard::default()),
            headless: std::cell::OnceCell::new(),
            console: RefCell::new(crate::console::ConsoleState::default()),
            console_id: Cell::new(0),
            next_filter: Cell::new(1),
            filter_areas: RefCell::new(Vec::new()),
            post: RefCell::new(PostState::default()),
            #[cfg(feature = "tokio")]
            tasks: RefCell::new(HashMap::new()),
            #[cfg(feature = "tokio")]
            next_task: Cell::new(1),
            #[cfg(feature = "tokio")]
            runtime: RefCell::new(tasks::Runtime::default()),
        }));
        let root = View::root(&app);
        root.element().update_paint(|paint| paint.background = app.theme().background);
        *app.0.root.borrow_mut() = Some(root);
        app.0.console_id.set(crate::console::register(app.proxy(), !remote));
        app.check()?;
        Ok(app)
    }

    pub(crate) fn from_inner(inner: Rc<AppInner>) -> Self {
        Self(inner)
    }

    pub(crate) fn inner(&self) -> &Rc<AppInner> {
        &self.0
    }

    /// The top of the widget tree. It fills the terminal and lays out children in a column.
    pub fn root(&self) -> View {
        self.0.root.borrow().clone().expect("the root exists for the app's lifetime")
    }

    /// The colors widgets start with: [`AppOptions::theme`], or [`AppOptions::light_theme`] on a light terminal,
    /// until [`Self::set_theme`] changes them.
    pub fn theme(&self) -> Theme {
        self.0.theme.get()
    }

    /// Changes the theme widgets created from now on start with, and the screen background behind them, including
    /// the root's. Existing widgets keep their colors: rebuild or recolor them, for example from
    /// [`Self::on_theme_mode`].
    pub fn set_theme(&self, theme: Theme) {
        self.0.theme.set(theme);
        self.root().element().update_paint(|paint| paint.background = theme.background);
        self.request_redraw();
    }

    pub(crate) fn console_id(&self) -> u64 {
        self.0.console_id.get()
    }

    /// Whether the terminal has a dark or light background, once it has said so.
    pub fn theme_mode(&self) -> Option<ThemeMode> {
        self.0.theme_mode.get()
    }

    pub fn options(&self) -> &AppOptions {
        &self.0.options
    }

    /// The native Session, for features this crate does not wrap.
    pub fn session(&self) -> &Session {
        &self.0.session
    }

    /// The Session. A detached app first copies its parent's terminal state, so a text node made now measures as the
    /// parent draws. Not while a frame runs, which native code rejects; `Scrollback` copies before each frame.
    pub(crate) fn synced_session(&self) -> &Session {
        if !self.0.in_frame.get()
            && let Some(parent) = self.0.parent.get()
        {
            let _ = self.0.session.sync_detached(parent);
        }
        &self.0.session
    }

    /// The terminal size in cells.
    pub fn size(&self) -> (u16, u16) {
        self.0.size.get()
    }

    /// How the terminal measures text, detected from its environment and, once the app runs, its replies. Pass it to
    /// native owners of text, such as [`Buffer::new`](crate::native::Buffer::new), so their text lines up with the
    /// app's.
    pub fn width_method(&self) -> WidthMethod {
        // Native draws NoZwj as Unicode, as Core reads it.
        match self.synced_session().capabilities().map(|capabilities| capabilities.width_method) {
            Ok(WidthMethod::NoZwj) | Err(_) => WidthMethod::Unicode,
            Ok(method) => method,
        }
    }

    /// Frames painted so far.
    pub fn frame_number(&self) -> u64 {
        self.0.frame.get()
    }

    /// Frames finished so far: [`Self::frame_number`] counts the frame being painted from its start.
    pub(crate) fn painted_frames(&self) -> u64 {
        self.0.frame.get() - u64::from(self.0.in_frame.get())
    }

    /// The app's clock. Tests advance it manually.
    pub fn now(&self) -> Instant {
        self.0.clock.now()
    }

    fn now_ns(&self) -> u64 {
        u64::try_from(self.now().saturating_duration_since(self.0.clock.start()).as_nanos()).unwrap_or(u64::MAX).max(1)
    }

    /// Records the first failure; the event loop ends with it at the end of the turn.
    pub(crate) fn report<T>(&self, result: Result<T>) -> Option<T> {
        match result {
            Ok(value) => Some(value),
            Err(error) => {
                let mut slot = self.0.error.borrow_mut();
                if slot.is_none() {
                    *slot = Some(error);
                }
                None
            }
        }
    }

    /// Whether the terminal shows OSC 8 hyperlinks, as far as it has reported.
    pub(crate) fn hyperlinks(&self) -> bool {
        let capabilities = self.synced_session().capabilities();
        capabilities.is_ok_and(|capabilities| capabilities.flags.contains(crate::native::CapabilityFlags::HYPERLINKS))
    }

    /// Returns and clears the first failure recorded since the last check.
    pub(crate) fn check(&self) -> Result<()> {
        self.0.error.borrow_mut().take().map_or(Ok(()), Err)
    }

    /// Schedules a frame. Widgets do this when they change.
    pub fn request_redraw(&self) {
        if !self.0.in_frame.get() {
            self.0.dirty.set(true);
        }
    }

    /// Ends the event loop after the current turn.
    pub fn quit(&self) {
        self.0.quit.set(true);
    }

    /// Ends the event loop after the current turn; [`Self::run`] returns `error` once the terminal is restored.
    pub fn fail(&self, error: impl Into<Error>) {
        self.report::<()>(Err(error.into()));
    }

    pub fn is_quitting(&self) -> bool {
        self.0.quit.get()
    }

    /// Restores the terminal and stops the process, as Ctrl+Z does, after the current turn. Does nothing on Windows,
    /// which has no job control, or for a remote app.
    pub fn suspend(&self) {
        self.0.suspend.set(true);
    }

    /// Restores the terminal after the current turn, runs `task` while another program owns it (an external editor,
    /// for example), and sets the terminal up again when `task` returns. The event loop waits for `task`, and input the
    /// terminal sent meanwhile is dropped. Without a running local terminal (a test, a remote app), `task` runs after
    /// the current event with the terminal untouched. A second call before the first runs replaces it.
    pub fn release_terminal(&self, task: impl FnOnce(&mut Cx<'_>) + 'static) {
        if !self.0.terminal_active.get() {
            self.defer(task);
            return;
        }
        *self.0.release.borrow_mut() = Some(Box::new(task));
    }

    /// Shows native frame statistics (frame and render times, frames per second, cells updated) in a corner of
    /// the screen, or hides them with `None`.
    pub fn set_debug_overlay(&self, corner: Option<Corner>) {
        let mut stats = self.0.stats.get();
        stats.corner = corner;
        stats.last_corner = corner.unwrap_or(stats.last_corner);
        self.0.stats.set(stats);
        self.report(self.0.session.set_debug_overlay(corner.is_some(), corner.unwrap_or_default()));
        self.request_redraw();
    }

    /// Shows the debug overlay in its last corner, or hides it.
    pub fn toggle_debug_overlay(&self) {
        let stats = self.0.stats.get();
        self.set_debug_overlay(if stats.corner.is_some() { None } else { Some(stats.last_corner) });
    }

    pub fn debug_overlay(&self) -> Option<Corner> {
        self.0.stats.get().corner
    }

    /// Sets the terminal window title. A running [headless](Self::headless) app hands it to its
    /// [`Self::on_headless_write`] handlers.
    pub fn set_title(&self, title: &str) {
        *self.0.title.borrow_mut() = Some(title.to_owned());
        if self.headless_write(HeadlessWrite::Title(title.to_owned())) {
            return;
        }
        if self.0.terminal_active.get() {
            self.report(self.0.session.control(Control::Title(title)));
        }
    }

    /// Sends an OSC 7501 program status report, such as whether the app works or waits for the user. Returns `false`
    /// without a running terminal, as in tests, or when output is backed up; terminals without the protocol ignore
    /// the report. A report native code rejects, such as an id with a space, ends the event loop with the error.
    pub fn set_program_status(&self, status: ProgramStatus<'_>) -> bool {
        if !self.0.terminal_active.get() {
            return false;
        }
        let Err(error) = self.0.session.control(Control::ProgramStatus(status)) else {
            return true;
        };
        if !matches!(error.status(), Some(Status::InvalidPhase | Status::OutputBackpressure)) {
            self.report::<()>(Err(error));
        }
        false
    }

    /// Sends a desktop notification through the terminal. Returns `false` when the terminal lacks support. A running
    /// [headless](Self::headless) app hands it to its [`Self::on_headless_write`] handlers and returns `true`.
    pub fn notify(&self, message: &str, title: Option<&str>) -> bool {
        if self.is_headless() {
            let (message, title) = (message.to_owned(), title.map(str::to_owned));
            return self.headless_write(HeadlessWrite::Notification { message, title });
        }
        self.0.terminal_active.get() && self.report(self.0.session.notify(message, title)).unwrap_or(false)
    }

    /// Runs `task` after the current event finishes, before the next frame.
    pub fn defer(&self, task: impl FnOnce(&mut Cx<'_>) + 'static) {
        self.0.deferred.borrow_mut().push_back(Box::new(task));
    }

    /// A handle for sending work to this app from other threads.
    pub fn proxy(&self) -> AppProxy {
        AppProxy { shared: Arc::clone(&self.0.proxy) }
    }

    // Handlers.

    /// Handles keys that no focused widget consumed. Runs after the focused widget and its ancestors.
    pub fn on_key(&self, handler: impl FnMut(&mut Cx<'_>, &KeyEvent) + 'static) -> HandlerId {
        self.0.handlers.key.add(handler)
    }

    /// Handles keys before any widget sees them, for global shortcuts that must win over text input.
    pub fn on_key_capture(&self, handler: impl FnMut(&mut Cx<'_>, &KeyEvent) + 'static) -> HandlerId {
        self.0.handlers.key_capture.add(handler)
    }

    pub fn on_paste(&self, mut handler: impl FnMut(&mut Cx<'_>, &str) + 'static) -> HandlerId {
        self.0.handlers.paste.add(move |cx, text: &str| handler(cx, text))
    }

    /// Handles mouse events no widget consumed.
    pub fn on_mouse(&self, handler: impl FnMut(&mut Cx<'_>, &MouseEvent) + 'static) -> HandlerId {
        self.0.handlers.mouse.add(handler)
    }

    /// Called after the terminal changes size, with the new width and height.
    pub fn on_resize(&self, mut handler: impl FnMut(&mut Cx<'_>, u16, u16) + 'static) -> HandlerId {
        self.0.handlers.resize.add(move |cx, &(width, height): &(u16, u16)| handler(cx, width, height))
    }

    /// Called when the terminal window gains or loses focus, if the terminal reports it.
    pub fn on_terminal_focus(&self, mut handler: impl FnMut(&mut Cx<'_>, bool) + 'static) -> HandlerId {
        self.0.handlers.terminal_focus.add(move |cx, focused: &bool| handler(cx, *focused))
    }

    /// Called when the terminal reports a background of the other brightness, such as when the system switches
    /// between dark and light mode. Widgets keep their colors: call [`Self::set_theme`] here, then rebuild or recolor
    /// them.
    pub fn on_theme_mode(&self, mut handler: impl FnMut(&mut Cx<'_>, ThemeMode) + 'static) -> HandlerId {
        self.0.handlers.theme_mode.add(move |cx, mode: &ThemeMode| handler(cx, *mode))
    }

    /// Called when a frame is too large to draw, as Core's `frame:dropped` event is: its output without image
    /// uploads is larger than [`HostOptions::session`]'s queue takes in one frame. The screen keeps the last frame
    /// drawn. Each content is reported once and not drawn again until it changes; a smaller screen, less color, or a
    /// larger `max_bytes` draws it.
    pub fn on_frame_dropped(&self, mut handler: impl FnMut(&mut Cx<'_>, FrameDropped) + 'static) -> HandlerId {
        self.0.handlers.frame_dropped.add(move |cx, dropped: &FrameDropped| handler(cx, *dropped))
    }

    /// Handles messages of type `M` sent with [`AppProxy::send`]. Every handler for `M` gets each message.
    pub fn on_message<M: 'static>(&self, mut handler: impl FnMut(&mut Cx<'_>, &M) + 'static) -> HandlerId {
        self.0.messages.borrow_mut().entry(TypeId::of::<M>()).or_default().add(move |cx, message: &dyn Any| {
            if let Some(message) = message.downcast_ref::<M>() {
                handler(cx, message);
            }
        })
    }

    /// Removes a handler that an `on_*` method added. A handler removed while its event is being handled does not
    /// run for the rest of that event. Returns whether the handler was registered.
    pub fn remove_handler(&self, id: HandlerId) -> bool {
        let handlers = &self.0.handlers;
        handlers.key_capture.remove(id)
            || handlers.key.remove(id)
            || handlers.paste.remove(id)
            || handlers.mouse.remove(id)
            || handlers.resize.remove(id)
            || handlers.terminal_focus.remove(id)
            || handlers.selection.remove(id)
            || handlers.theme_mode.remove(id)
            || handlers.color_scheme.remove(id)
            || handlers.palette.remove(id)
            || handlers.frame_dropped.remove(id)
            || self.0.messages.borrow().values().any(|messages| messages.remove(id))
            || self.0.headless.get().is_some_and(|headless| headless.remove(id))
    }

    /// Calls the handlers for the message's type. Messages without one are dropped.
    pub(crate) fn deliver(&self, message: Box<dyn Any>) {
        let handlers = self.0.messages.borrow().get(&(*message).type_id()).cloned();
        if let Some(handlers) = handlers {
            handlers.emit(&mut Cx::new(self), &*message);
        }
    }

    // Timers and animation.

    /// Runs `callback` once after `delay`. A delay too long to represent never fires.
    pub fn set_timeout(&self, delay: Duration, callback: impl FnOnce(&mut Cx<'_>) + 'static) -> TimerId {
        let due = timer::after(self.now(), delay);
        let mut callback = Some(callback);
        let callback = move |cx: &mut Cx<'_>| {
            if let Some(callback) = callback.take() {
                callback(cx);
            }
        };
        self.0.timers.borrow_mut().add(due, None, Rc::new(RefCell::new(callback)))
    }

    /// Runs `callback` every `interval`, starting one interval from now. Intervals under a millisecond count as one.
    /// Ticks missed while the loop was busy are skipped, not run in a burst; in tests,
    /// [`TestApp::advance`](crate::testing::TestApp::advance) runs every tick it passes.
    pub fn set_interval(&self, interval: Duration, callback: impl FnMut(&mut Cx<'_>) + 'static) -> TimerId {
        let due = timer::after(self.now(), interval);
        self.0.timers.borrow_mut().add(due, Some(interval), Rc::new(RefCell::new(callback)))
    }

    /// Cancels a timer. Returns whether it was still scheduled.
    pub fn cancel_timer(&self, timer: TimerId) -> bool {
        self.0.timers.borrow_mut().cancel(timer)
    }

    /// Calls `step` before every frame with the time since its previous call, until it returns `false`. Frames run
    /// at up to [`AppOptions::max_fps`] while any animation is active. [`Timeline`](crate::animation::Timeline)
    /// builds eased tweens on this.
    pub fn animate(&self, step: impl FnMut(&mut Cx<'_>, Duration) -> bool + 'static) {
        self.0.animations.borrow_mut().push(Animation { last: self.now(), step: Box::new(step) });
        self.0.dirty.set(true);
    }

    // Focus.

    /// Gives keyboard focus to `widget` if it is focusable and visible.
    pub fn focus(&self, widget: &impl Widget) {
        if widget.element().is_focusable()
            && let Some(behavior) = widget.element().behavior()
        {
            self.set_focus(Some(behavior));
        }
    }

    /// Removes keyboard focus from every widget.
    pub fn blur(&self) {
        self.set_focus(None);
    }

    pub fn focused(&self) -> Option<AnyWidget> {
        self.focused_behavior().map(AnyWidget)
    }

    fn focused_behavior(&self) -> Option<Rc<dyn Behavior>> {
        self.0.focus.borrow().as_ref()?.upgrade()
    }

    /// Moves focus to the next focusable widget in tree order, wrapping around.
    pub fn focus_next(&self) {
        self.step_focus(true);
    }

    pub fn focus_previous(&self) {
        self.step_focus(false);
    }

    fn step_focus(&self, forward: bool) {
        let order = self.focus_order();
        if order.is_empty() {
            return;
        }
        let current = self.focused_behavior().map(|focused| focused.element().id());
        let position = current.and_then(|id| order.iter().position(|widget| widget.element().id() == id));
        let next = match (position, forward) {
            (None, true) => 0,
            (None, false) => order.len() - 1,
            (Some(index), true) => (index + 1) % order.len(),
            (Some(index), false) => (index + order.len() - 1) % order.len(),
        };
        self.set_focus(Some(Rc::clone(&order[next])));
    }

    fn focus_order(&self) -> Vec<Rc<dyn Behavior>> {
        fn visit(widget: Rc<dyn Behavior>, order: &mut Vec<Rc<dyn Behavior>>) {
            let element = widget.element();
            if !element.is_visible() {
                return;
            }
            let children = element.child_behaviors();
            if element.is_focusable() {
                order.push(widget);
            }
            for child in children {
                visit(child, order);
            }
        }
        let mut order = Vec::new();
        if let Some(root) = self.root().element().behavior() {
            visit(root, &mut order);
        }
        order
    }

    fn set_focus(&self, next: Option<Rc<dyn Behavior>>) {
        let previous = self.focused_behavior();
        if previous.as_ref().map(|widget| widget.element().id()) == next.as_ref().map(|widget| widget.element().id()) {
            return;
        }
        if let Some(previous) = &previous {
            previous.element().apply(|node| node.set_focus(false));
        }
        *self.0.focus.borrow_mut() = next.as_ref().map(Rc::downgrade);
        if let Some(next) = &next {
            next.element().apply(|node| node.set_focus(true));
        }
        // Notify after the current event, so a focus handler never runs inside another widget's handler. Each widget
        // gets its own event flow: one widget's handler cannot stop another's notification.
        self.defer(move |cx| {
            let app = cx.app();
            for (widget, focused) in [(previous, false), (next, true)] {
                if let Some(widget) = widget {
                    widget.focus_changed(&mut Cx::new(app), focused);
                    widget.element().handlers.focus.emit(&mut Cx::new(app), &focused);
                }
            }
        });
    }

    /// Clears focus, pointer capture, hover, and selection that a removed or hidden subtree held.
    pub(crate) fn subtree_removed(&self, element: &Element) {
        if self.focused_behavior().is_some_and(|focused| focused.element().is_within(element)) {
            self.set_focus(None);
        }
        let captured = self.0.capture.borrow().as_ref().and_then(Weak::upgrade);
        if captured.is_some_and(|captured| captured.element().is_within(element)) {
            *self.0.capture.borrow_mut() = None;
        }
        self.selection_subtree_removed(element);
    }

    pub(crate) fn subtree_hidden(&self, element: &Element) {
        self.subtree_removed(element);
    }

    /// Whether the widget with this element holds the pointer capture, as it does while a button pressed on it is
    /// down.
    pub(crate) fn captures(&self, element: &Element) -> bool {
        let captured = self.0.capture.borrow().as_ref().and_then(Weak::upgrade);
        captured.is_some_and(|captured| std::ptr::eq(captured.element(), element))
    }

    // Dispatch.

    fn lookup(&self, num: u32) -> Option<Rc<dyn Behavior>> {
        self.0.registry.borrow().get(&num)?.upgrade()
    }

    /// The widget presented at a cell in the last completed frame.
    pub fn widget_at(&self, x: u16, y: u16) -> Option<AnyWidget> {
        self.hit(x, y).map(AnyWidget)
    }

    fn hit(&self, x: u16, y: u16) -> Option<Rc<dyn Behavior>> {
        let num = self.report(self.0.session.hit_test(i32::from(x), i32::from(y)))??;
        self.lookup(num)
    }

    /// The widget and its ancestors, nearest first.
    fn path(widget: Rc<dyn Behavior>) -> Vec<Rc<dyn Behavior>> {
        let mut path = vec![widget];
        while let Some(parent) = path.last().and_then(|widget| widget.element().parent_behavior()) {
            path.push(parent);
        }
        path
    }

    /// Handles one input or host event.
    pub fn dispatch(&self, event: Event) {
        match event {
            Event::Key(key) => self.dispatch_key(&key),
            Event::Paste(text) => self.dispatch_paste(&text),
            Event::Mouse(mouse) => self.dispatch_mouse(&mouse),
            Event::Focus(focused) => self.0.handlers.terminal_focus.emit(&mut Cx::new(self), &focused),
            Event::Resize { width, height } => {
                self.0.size.set((width, height));
                self.request_redraw();
                self.0.handlers.resize.emit(&mut Cx::new(self), &(width, height));
            }
            Event::Resumed => self.request_redraw(),
            Event::ThemeMode(mode) => {
                if self.0.theme_mode.replace(Some(mode)) != Some(mode) {
                    self.0.handlers.theme_mode.emit(&mut Cx::new(self), &mode);
                }
            }
            Event::ColorScheme => self.0.handlers.color_scheme.emit(&mut Cx::new(self), &()),
            Event::Color(color) => self.palette_color(color),
            Event::Wake => self.drain_proxy(),
            Event::Terminate => self.quit(),
        }
        self.drain_deferred();
    }

    fn dispatch_key(&self, key: &KeyEvent) {
        let mut cx = Cx::new(self);
        self.0.handlers.key_capture.emit(&mut cx, key);
        if !cx.stopped
            && let Some(target) = self.focused_behavior()
        {
            for widget in Self::path(target) {
                widget.element().handlers.key.emit(&mut cx, key);
                if cx.stopped {
                    break;
                }
                if !cx.prevented && widget.key(&mut cx, key) {
                    cx.stopped = true;
                }
                if cx.stopped {
                    break;
                }
            }
        }
        if !cx.stopped {
            self.0.handlers.key.emit(&mut cx, key);
        }
        if !cx.stopped && !cx.prevented {
            self.default_key(key);
        }
    }

    fn default_key(&self, key: &KeyEvent) {
        let options = &self.0.options;
        if options.tab_focus && key.matches("tab") {
            self.focus_next();
        } else if options.tab_focus && key.matches("shift+tab") {
            self.focus_previous();
        } else if options.exit_on_ctrl_c && key.matches("ctrl+c") {
            self.quit();
        } else if options.suspend_on_ctrl_z && key.matches("ctrl+z") {
            self.suspend();
        }
    }

    fn dispatch_paste(&self, text: &str) {
        let mut cx = Cx::new(self);
        if let Some(target) = self.focused_behavior() {
            for widget in Self::path(target) {
                widget.element().handlers.paste.emit(&mut cx, text);
                if !cx.stopped && !cx.prevented && widget.paste(&mut cx, text) {
                    cx.stopped = true;
                }
                if cx.stopped {
                    return;
                }
            }
        }
        self.0.handlers.paste.emit(&mut cx, text);
    }

    fn dispatch_mouse(&self, event: &MouseEvent) {
        self.0.pointer.set(Some((event.x, event.y)));
        let hit = self.hit(event.x, event.y);
        let captured = self.0.capture.borrow().as_ref().and_then(Weak::upgrade);
        let scroll = matches!(
            event.kind,
            MouseEventKind::ScrollUp
                | MouseEventKind::ScrollDown
                | MouseEventKind::ScrollLeft
                | MouseEventKind::ScrollRight
        );
        if event.kind == MouseEventKind::Down(MouseButton::Left) {
            self.drag_and_drop(event, None, None, false);
        }
        let selecting = self.selection_mouse(event, hit.as_ref());
        let target = match event.kind {
            // As in Core, a selection drag goes to the widget under the pointer, so scroll boxes it passes over can
            // follow it. Its release still reaches the pressed widget.
            MouseEventKind::Drag(MouseButton::Left) if selecting => hit.clone(),
            MouseEventKind::Drag(_) | MouseEventKind::Up(_) => captured.clone().or_else(|| hit.clone()),
            _ if scroll => hit.clone().or_else(|| self.focused_behavior()),
            _ => hit.clone(),
        };
        if !scroll && captured.is_none() {
            self.update_hover(hit.clone());
        }
        if let MouseEventKind::Down(_) = event.kind {
            *self.0.capture.borrow_mut() = target.as_ref().map(Rc::downgrade);
        }
        let mut cx = Cx::new(self);
        if let Some(target) = &target {
            for widget in Self::path(Rc::clone(target)) {
                widget.element().handlers.mouse.emit(&mut cx, event);
                if !cx.stopped && !cx.prevented && widget.mouse(&mut cx, event) {
                    cx.stopped = true;
                }
                if cx.stopped {
                    break;
                }
            }
        }
        if !cx.stopped {
            self.0.handlers.mouse.emit(&mut cx, event);
        }
        let prevented = cx.prevented;
        // A left press that starts no selection ends the current one, unless a handler prevented it.
        if event.kind == MouseEventKind::Down(MouseButton::Left) && !prevented && !selecting {
            self.clear_selection();
        }
        if event.kind == MouseEventKind::Down(MouseButton::Left)
            && !prevented
            && self.0.options.focus_on_click
            && let Some(target) = target
        {
            // Handlers may have detached the target; only a widget still in the tree takes focus.
            let path = Self::path(target);
            let root = self.root().id();
            if path.last().is_some_and(|top| top.element().id() == root)
                && let Some(focusable) = path.into_iter().find(|widget| widget.element().is_focusable())
            {
                self.set_focus(Some(focusable));
            }
        }
        // A left press ended the old drag before its handlers; a drag they started is the new gesture's.
        if event.kind != MouseEventKind::Down(MouseButton::Left) {
            self.drag_and_drop(event, captured.as_ref(), hit.as_ref(), selecting);
        }
        if let MouseEventKind::Up(_) = event.kind {
            *self.0.capture.borrow_mut() = None;
            self.finish_selection_drag(event, hit.as_ref());
            self.update_hover(hit);
        }
    }

    /// Tracks a left-button drag from the captured widget: drag-over changes for the widgets under the pointer, then a
    /// drop where it ends. A press during a drag means the drag's release was lost: the press ends it, before its own
    /// handlers run and without a drop.
    fn drag_and_drop(
        &self,
        event: &MouseEvent,
        captured: Option<&Rc<dyn Behavior>>,
        hit: Option<&Rc<dyn Behavior>>,
        selecting: bool,
    ) {
        let ids = |path: &[Rc<dyn Behavior>]| path.iter().map(|widget| widget.element().id()).collect::<Vec<_>>();
        match event.kind {
            MouseEventKind::Drag(MouseButton::Left) if !selecting && !self.selection_dragging() => {
                let Some(source) = captured else { return };
                let previous = match self.0.drag.borrow_mut().take() {
                    Some((dragged, over)) if dragged.element().id() == source.element().id() => {
                        over.iter().filter_map(Weak::upgrade).collect()
                    }
                    _ => Vec::new(),
                };
                // The source and its ancestors are under the pointer from the start; they get no drag-over.
                let source_path = ids(&Self::path(Rc::clone(source)));
                let next: Vec<Rc<dyn Behavior>> = hit
                    .map(|hit| Self::path(Rc::clone(hit)))
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|widget| !source_path.contains(&widget.element().id()))
                    .collect();
                let (previous_ids, next_ids) = (ids(&previous), ids(&next));
                *self.0.drag.borrow_mut() = Some((Rc::clone(source), next.iter().map(Rc::downgrade).collect()));
                let source = AnyWidget(Rc::clone(source));
                for widget in previous.iter().filter(|widget| !next_ids.contains(&widget.element().id())) {
                    widget.element().handlers.drag_over.emit(&mut Cx::new(self), &(source.clone(), false));
                }
                for widget in next.iter().rev().filter(|widget| !previous_ids.contains(&widget.element().id())) {
                    widget.element().handlers.drag_over.emit(&mut Cx::new(self), &(source.clone(), true));
                }
            }
            MouseEventKind::Down(MouseButton::Left) | MouseEventKind::Up(MouseButton::Left) => {
                let Some((source, over)) = self.0.drag.borrow_mut().take() else { return };
                let dragged = AnyWidget(Rc::clone(&source));
                for widget in over.iter().filter_map(Weak::upgrade) {
                    widget.element().handlers.drag_over.emit(&mut Cx::new(self), &(dragged.clone(), false));
                }
                let Some(hit) = hit.filter(|hit| !hit.element().is_within(source.element())) else { return };
                let mut cx = Cx::new(self);
                for widget in Self::path(Rc::clone(hit)) {
                    widget.element().handlers.drop.emit(&mut cx, &(dragged.clone(), *event));
                    if cx.stopped {
                        break;
                    }
                }
            }
            _ => {}
        }
    }

    /// Sends hover changes for the pointer's new target: leave to widgets no longer under it, enter to new ones.
    fn update_hover(&self, target: Option<Rc<dyn Behavior>>) {
        let next = target.map(Self::path).unwrap_or_default();
        let previous: Vec<Rc<dyn Behavior>> =
            std::mem::take(&mut *self.0.hover.borrow_mut()).iter().filter_map(Weak::upgrade).collect();
        let ids = |path: &[Rc<dyn Behavior>]| path.iter().map(|widget| widget.element().id()).collect::<Vec<_>>();
        let (previous_ids, next_ids) = (ids(&previous), ids(&next));
        *self.0.hover.borrow_mut() = next.iter().map(Rc::downgrade).collect();
        // Enter and leave do not bubble: each widget's notification has its own event flow.
        for widget in previous.iter().filter(|widget| !next_ids.contains(&widget.element().id())) {
            widget.element().handlers.hover.emit(&mut Cx::new(self), &false);
        }
        for widget in next.iter().rev().filter(|widget| !previous_ids.contains(&widget.element().id())) {
            widget.element().handlers.hover.emit(&mut Cx::new(self), &true);
        }
        self.refresh_pointer();
    }

    /// The pointer shape for the hovered widgets: the innermost one's, or the default.
    pub fn mouse_pointer(&self) -> MousePointer {
        self.0.mouse_pointer.get().0
    }

    /// Recomputes the pointer shape from the hovered widgets and sends it when it changed.
    pub(crate) fn refresh_pointer(&self) {
        let hovered: Vec<Rc<dyn Behavior>> = self.0.hover.borrow().iter().filter_map(Weak::upgrade).collect();
        let wanted = hovered.iter().find_map(|widget| widget.element().pointer.get()).unwrap_or(MousePointer::DEFAULT);
        let (_, sent) = self.0.mouse_pointer.get();
        let send = self.0.terminal_active.get() && sent != Some(wanted);
        if send {
            let update = CursorUpdate { mouse_pointer: Some(wanted), ..Default::default() };
            self.report(self.0.session.control(Control::Cursor(update)));
            // Native code sends the shape with the next frame, which is only the shape when no cell changed.
            self.request_redraw();
        }
        self.0.mouse_pointer.set((wanted, if send { Some(wanted) } else { sent }));
    }

    /// Runs after a frame is committed, as Core's renderer handles a dropped frame. Native code counts a frame too
    /// large to write once it wrote every cell, and does not encode that content again until it changes. A smaller
    /// frame that is too large is not counted: it is tried once more, as the full repaint native code then forces.
    fn committed(&self, outcome: RenderOutcome) -> Result<()> {
        if outcome.accepted() {
            self.0.drop_retried.set(false);
            return Ok(());
        }
        if outcome != RenderOutcome::Failed {
            return Ok(());
        }
        let renderer = self.0.session.renderer_state()?;
        if renderer.dropped_frame_bytes == 0 {
            return Ok(());
        }
        let counted = self.0.dropped_frames.replace(renderer.dropped_frames) != renderer.dropped_frames;
        let retried = self.0.drop_retried.replace(true);
        if !counted && !retried {
            self.request_redraw();
        }
        if counted {
            let dropped = FrameDropped { bytes: renderer.dropped_frame_bytes, limit: self.0.session.write_limit()? };
            self.0.handlers.frame_dropped.emit(&mut Cx::new(self), &dropped);
        }
        Ok(())
    }

    /// Runs once a frame's output is complete. Image uploads that did not fit it go out in the next frames.
    fn presented(&self, renderer: RendererState) {
        self.recheck_hover();
        if renderer.image_uploads_pending > 0 {
            self.request_redraw();
        }
    }

    /// Re-targets hover after a frame moved widgets under a still pointer.
    fn recheck_hover(&self) {
        if self.0.capture.borrow().is_some() {
            return;
        }
        if let Some((x, y)) = self.0.pointer.get() {
            let hit = self.hit(x, y);
            self.update_hover(hit);
        }
    }

    pub(crate) fn drain_deferred(&self) {
        for _ in 0..TURN_WORK_MAX {
            let Some(task) = self.0.deferred.borrow_mut().pop_front() else { return };
            task(&mut Cx::new(self));
        }
    }

    pub(crate) fn drain_proxy(&self) {
        for task in self.0.proxy.take() {
            task(&mut Cx::new(self));
        }
        self.drain_deferred();
    }

    pub(crate) fn fire_timers(&self) {
        let now = self.now();
        for _ in 0..TURN_WORK_MAX {
            let Some(callback) = self.0.timers.borrow_mut().take_due(now) else { break };
            if let Ok(mut callback) = callback.try_borrow_mut() {
                callback(&mut Cx::new(self));
            }
            self.drain_deferred();
        }
    }

    pub(crate) fn next_timer(&self) -> Option<Instant> {
        self.0.timers.borrow().next_due()
    }

    /// Whether the turn asked to quit, fail, suspend, or release the terminal, which the top of the event loop does.
    fn ends_turn(&self) -> bool {
        self.0.quit.get()
            || self.0.suspend.get()
            || self.0.release.borrow().is_some()
            || self.0.error.borrow().is_some()
    }

    fn wants_frame(&self) -> bool {
        self.0.dirty.get() || !self.0.animations.borrow().is_empty()
    }

    fn run_animations(&self) {
        let now = self.now();
        let mut animations = std::mem::take(&mut *self.0.animations.borrow_mut());
        animations.retain_mut(|animation| {
            let elapsed = now.saturating_duration_since(animation.last);
            animation.last = now;
            (animation.step)(&mut Cx::new(self), elapsed)
        });
        // Animations started during this pass were pushed to the emptied list.
        let mut current = self.0.animations.borrow_mut();
        animations.append(&mut current);
        *current = animations;
    }

    // Frames.

    /// Paints a frame, running widget hooks.
    pub(crate) fn paint(&self) -> Result<Draft> {
        self.paint_with(false)
    }

    /// Paints a frame; with `preserve_unwritten`, cells nothing paints stay empty, for offscreen snapshots.
    pub(crate) fn paint_with(&self, preserve_unwritten: bool) -> Result<Draft> {
        let started = Instant::now();
        self.run_animations();
        self.drain_deferred();
        let callbacks = started.elapsed();
        self.check()?;
        self.0.dirty.set(false);
        self.0.frame.set(self.0.frame.get() + 1);
        let options = FrameOptions { background: self.theme().background, preserve_unwritten, ..Default::default() };
        self.0.filter_areas.borrow_mut().clear();
        self.0.in_frame.set(true);
        let draft = self.0.session.frame(&options, |request| self.host_request(request));
        self.0.in_frame.set(false);
        crate::native::resume_measure_panic();
        self.check()?;
        let draft = draft?;
        self.post_process(&draft)?;
        self.record_frame_stats(started, callbacks);
        Ok(draft)
    }

    /// Counts frames per second and, while the debug overlay shows, reports this frame's timings.
    fn record_frame_stats(&self, started: Instant, callbacks: Duration) {
        let mut stats = self.0.stats.get();
        let now = self.now();
        let since = stats.window.map(|window| now.saturating_duration_since(window));
        match since {
            Some(since) if since < Duration::from_secs(1) => stats.frames += 1,
            // A window that just ended gives the rate; after a longer pause, the app painted nothing for a while.
            Some(since) if since < Duration::from_secs(2) => {
                (stats.fps, stats.window, stats.frames) = (stats.frames, Some(now), 1);
            }
            _ => (stats.fps, stats.window, stats.frames) = (0, Some(now), 1),
        }
        self.0.stats.set(stats);
        if stats.corner.is_some() {
            let milliseconds = |duration: Duration| duration.as_secs_f64() * 1000.0;
            self.report(self.0.session.update_stats(
                milliseconds(started.elapsed()),
                stats.fps,
                milliseconds(callbacks),
            ));
        }
    }

    fn host_request(&self, request: HostRequest<'_>) -> Result<()> {
        match request {
            HostRequest::Update { num, .. } => {
                if let Some(widget) = self.lookup(num) {
                    widget.update(&mut Cx::new(self));
                }
            }
            HostRequest::Resize { num, width, height, .. } => {
                if let Some(widget) = self.lookup(num) {
                    let mut cx = Cx::new(self);
                    widget.resized(&mut cx, width, height);
                    let rect = widget.element().rect();
                    widget.element().handlers.resize.emit(&mut cx, &rect);
                }
            }
            HostRequest::LayoutChanged { .. } | HostRequest::Scroll { .. } => {}
            HostRequest::Record { slots, recorder } => {
                let (context, width_method) = (self.0.session.context().clone(), self.width_method());
                for slot in slots {
                    if let Some(widget) = self.lookup(slot.num) {
                        if widget.element().has_filters() {
                            self.filtered_slot(&widget, slot);
                        }
                        let hooks = widget.element().own_hooks();
                        let mut painter = Painter::new(recorder, slot, hooks, &context, width_method);
                        widget.paint(&mut painter);
                        painter.finish()?;
                    }
                }
            }
        }
        self.check()
    }

    // Running.

    /// Takes over the terminal and runs the event loop until [`Self::quit`], a terminating signal, or an error.
    /// Restores the terminal in every case, then tears down handlers and widgets.
    ///
    /// A [remote](Self::remote) app ends the same way when its transport asks it to or its client disconnects, and
    /// runs only once: the remote terminal is gone afterwards.
    ///
    /// A [headless](Self::headless) app runs the same loop without a terminal or signals, waking for timers, frames,
    /// and [`AppProxy`] tasks.
    pub fn run(self) -> Result<()> {
        if self.is_headless() {
            return self.run_headless();
        }
        let mut captured = Vec::new();
        let (session, options) = (self.0.session.clone(), self.0.options.host.clone());
        let remote_terminal = self.0.remote_terminal.borrow_mut().take();
        let host = match remote_terminal {
            Some(terminal) => Host::attach_remote(session, terminal, options),
            None if self.0.remote => Err(Error::Usage("a remote app runs only once")),
            None => Host::attach(session, options),
        };
        let result = host.and_then(|mut host| {
            let capture = if self.0.options.capture_stderr && !self.0.remote {
                crate::term::StderrCapture::start(|line| crate::console::log(crate::console::LogLevel::Error, line))
                    .ok()
            } else {
                None
            };
            let result = self.event_loop(&mut host);
            self.0.terminal_active.set(false);
            self.close_clipboard();
            self.0.proxy.close();
            let closed = host.shutdown();
            if let Some(capture) = capture {
                captured = capture.stop();
            }
            result.and(closed)
        });
        if !captured.is_empty() {
            use std::io::Write;
            let _ = std::io::stderr().write_all(&captured);
        }
        self.teardown();
        result
    }

    fn event_loop(&self, host: &mut Host) -> Result<()> {
        self.0.terminal_active.set(true);
        self.0.size.set(host.size());
        self.0.proxy.set_waker(Some(host.waker()));
        let title = self.0.title.borrow().clone();
        if let Some(title) = title {
            self.report(self.0.session.control(Control::Title(&title)));
        }
        let palette = self.0.palette.borrow().clone();
        if let Some(palette) = palette {
            self.publish_palette(&palette);
        }
        self.request_redraw();
        let interval = Duration::from_secs(1) / self.0.options.max_fps.max(1);
        let mut last_frame: Option<Instant> = None;
        let mut presenting = false;
        let mut events = Vec::new();
        loop {
            // Events from the last poll, or read at a resume. As in Core, a suspend or release drops the rest of the
            // read's input; signals and resizes after it still count.
            for event in events.drain(..) {
                let held = self.0.suspend.get() || self.0.release.borrow().is_some();
                if self.0.quit.get() || held && !matches!(event, Event::Resize { .. } | Event::Terminate) {
                    continue;
                }
                self.dispatch(event);
            }
            self.drain_proxy();
            self.fire_timers();
            let clipboard = self.pump_clipboard();
            self.check()?;
            if self.0.quit.get() {
                return Ok(());
            }
            if self.0.suspend.take() {
                host.suspend(&mut events)?;
                continue;
            }
            let release = self.0.release.borrow_mut().take();
            if let Some(task) = release {
                host.release(&mut events, || task(&mut Cx::new(self)))?;
                self.drain_deferred();
                continue;
            }
            let now = Instant::now();
            // The frame cap's next slot, while a frame is wanted.
            let earliest =
                (self.wants_frame() || host.wants_frame()).then(|| last_frame.map_or(now, |last| last + interval));
            let mut framed = false;
            if earliest.is_some_and(|earliest| now >= earliest) && host.can_render()? {
                let draft = self.paint()?;
                let outcome = host.present(draft)?;
                self.committed(outcome)?;
                last_frame = Some(now);
                presenting = outcome.accepted();
                framed = true;
            }
            if presenting {
                let renderer = self.0.session.renderer_state()?;
                if !renderer.frame_pending {
                    presenting = false;
                    self.presented(renderer);
                    framed = true;
                }
            }
            // Tasks a frame deferred run now, so the deadline sees the timers and frames that it and they asked for, and
            // the loop does not sleep on a quit they asked for.
            let wants = if framed {
                self.drain_deferred();
                if self.ends_turn() {
                    continue;
                }
                self.wants_frame() || host.wants_frame()
            } else {
                earliest.is_some()
            };
            let mut deadline = match (self.next_timer(), clipboard) {
                (Some(timer), Some(clipboard)) => Some(timer.min(clipboard)),
                (timer, clipboard) => timer.or(clipboard),
            };
            if wants {
                // The frame cap applies, or output is still draining: check back shortly. A terminal that stopped
                // taking output wakes the host itself when it takes more.
                let retry = match earliest {
                    Some(earliest) if now < earliest => Some(earliest),
                    _ if host.output_blocked() => None,
                    _ => Some(now + Duration::from_millis(2)),
                };
                if let Some(retry) = retry {
                    deadline = Some(deadline.map_or(retry, |deadline| deadline.min(retry)));
                }
            }
            host.poll(deadline, &mut events)?;
        }
    }

    /// Breaks reference cycles that handlers create, so every widget and native node is released.
    pub(crate) fn teardown(&self) {
        let handlers = &self.0.handlers;
        handlers.key_capture.clear();
        handlers.key.clear();
        handlers.paste.clear();
        handlers.mouse.clear();
        handlers.resize.clear();
        handlers.terminal_focus.clear();
        handlers.selection.clear();
        handlers.theme_mode.clear();
        handlers.color_scheme.clear();
        handlers.palette.clear();
        handlers.frame_dropped.clear();
        if let Some(headless) = self.0.headless.get() {
            headless.clear();
        }
        self.0.messages.borrow_mut().clear();
        self.0.timers.borrow_mut().clear();
        self.0.animations.borrow_mut().clear();
        self.0.filter_areas.borrow_mut().clear();
        let timelines = std::mem::take(&mut *self.0.timelines.borrow_mut());
        for timeline in timelines.iter().filter_map(Weak::upgrade) {
            timeline.teardown();
        }
        self.0.deferred.borrow_mut().clear();
        self.0.proxy.close();
        #[cfg(feature = "tokio")]
        {
            self.0.tasks.borrow_mut().clear();
            *self.0.runtime.borrow_mut() = tasks::Runtime::default();
        }
        self.close_clipboard();
        crate::console::unregister(self.0.console_id.get());
        let console = std::mem::take(&mut *self.0.console.borrow_mut());
        drop(console);
        *self.0.focus.borrow_mut() = None;
        *self.0.capture.borrow_mut() = None;
        *self.0.selection.borrow_mut() = None;
        *self.0.drag.borrow_mut() = None;
        self.0.hover.borrow_mut().clear();
        let live: Vec<Rc<dyn Behavior>> = self.0.registry.borrow().values().filter_map(Weak::upgrade).collect();
        for widget in &live {
            widget.teardown();
            widget.element().teardown();
        }
        crate::pty::teardown(self);
    }

    // Headless driving for tests.

    /// Paints and presents a frame without a terminal, completing its output so hit tests see it. Then copies the
    /// presented cells when `capture` is set.
    pub(crate) fn present_headless(&self, capture: bool) -> Result<Option<crate::native::Capture>> {
        let outcome = self.paint()?.commit(false)?;
        self.committed(outcome)?;
        let mut scratch = vec![0u8; 64 * 1024];
        for _ in 0..4096 {
            match self.0.session.pump(self.now_ns(), 64)? {
                Pump::OutputPending => {
                    if let Some(ticket) = self.0.session.read_output(&mut scratch)? {
                        self.0.session.complete_output(ticket, true)?;
                    }
                }
                Pump::Again => {}
                Pump::Idle | Pump::Closed | Pump::WaitUntil(_) => break,
            }
        }
        let capture = if capture { Some(self.0.session.capture_presented()?) } else { None };
        self.presented(self.0.session.renderer_state()?);
        self.drain_deferred();
        self.check()?;
        Ok(capture)
    }

    pub(crate) fn advance_clock(&self, by: Duration) {
        if let Clock::Manual { now, .. } = &self.0.clock {
            now.set(now.get() + by);
        }
    }

    pub(crate) fn needs_frame(&self) -> bool {
        self.wants_frame()
    }

    pub(crate) fn set_size(&self, width: u16, height: u16) -> Result<()> {
        self.0.session.resize(u32::from(width), u32::from(height))?;
        self.dispatch(Event::Resize { width, height });
        Ok(())
    }
}

impl KeyEvent {
    /// The text a press of this key types, if it types any: printable characters without Ctrl, Alt, Super, Hyper,
    /// or Meta.
    pub fn text(&self) -> Option<char> {
        use crate::input::{KeyEventKind, Modifiers};
        let blocking = Modifiers::CTRL | Modifiers::ALT | Modifiers::SUPER | Modifiers::HYPER | Modifiers::META;
        match self.code {
            KeyCode::Char(character)
                if self.kind != KeyEventKind::Release
                    && self.modifiers.bits() & blocking.bits() == 0
                    && !character.is_control() =>
            {
                Some(character)
            }
            _ => None,
        }
    }
}
