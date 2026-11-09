use super::{ClipboardSelection, Context, ImageProtocol};
use crate::error::{Error, Result, Status, check, cleanup, count};
use crate::style::Color;
use crate::sys;
use std::{any::Any, ffi::c_void, io, panic, rc::Rc};

/// Output queue limits for a [`Session`].
///
/// Native code allocates every chunk when the Session is created. A frame larger than the empty ordinary queue
/// cannot be presented, so size `max_bytes` for the largest screen you expect.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SessionOptions {
    /// Bytes per queue chunk.
    pub chunk_size: u32,
    /// Queued plus copied-but-uncompleted spans.
    pub span_capacity: u32,
    /// Total chunk storage. Must be a multiple of `chunk_size`.
    pub max_bytes: u64,
    /// Bytes reserved for terminal control packets, rounded up to whole chunks. Terminal setup needs at least
    /// [`sys::OT_SESSION_CONTROL_PACKET_BYTES`]; zero reserves nothing.
    pub control_capacity: u32,
}

impl Default for SessionOptions {
    /// Limits for an interactive terminal: 4 MiB in 64 KiB chunks, one of them reserved for control packets.
    fn default() -> Self {
        Self {
            chunk_size: 64 * 1024,
            span_capacity: 64,
            max_bytes: 4 * 1024 * 1024,
            control_capacity: sys::OT_SESSION_CONTROL_PACKET_BYTES,
        }
    }
}

/// Whether the renderer may trust the local terminal environment.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Remote {
    /// Detect remote sessions, such as SSH, and take only the color depth from forwarded hints for them: a `TERM`
    /// containing `256color`, a `COLORTERM` of `truecolor` or `24bit` (ignored inside GNU screen, which gets 256
    /// colors), and `OPENTUI_FORCE_TRUECOLOR` of `1` or `true`, which forces 24-bit color.
    #[default]
    Auto,
    Local,
    Remote,
}

/// Mouse reporting requested from the terminal.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MouseTracking {
    #[default]
    Off,
    /// Presses, releases, wheel, and drags.
    Buttons,
    /// Everything in `Buttons`, plus motion without a pressed button.
    Motion,
}

impl MouseTracking {
    fn control_argument(self) -> u32 {
        match self {
            Self::Off => 0,
            Self::Buttons => 1,
            Self::Motion => 2,
        }
    }
}

/// Kitty keyboard protocol flags. Native code enables them only when the terminal supports the protocol.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct KittyKeyboard(u32);

impl KittyKeyboard {
    pub const OFF: Self = Self(0);
    pub const DISAMBIGUATE: Self = Self(1);
    pub const EVENT_TYPES: Self = Self(2);
    pub const ALTERNATE_KEYS: Self = Self(4);
    pub const ALL_KEYS_AS_ESCAPES: Self = Self(8);
    pub const ASSOCIATED_TEXT: Self = Self(16);

    pub const fn bits(self) -> u32 {
        self.0
    }

    pub const fn from_bits(bits: u32) -> Self {
        Self(bits & 31)
    }

    pub const fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }
}

impl std::ops::BitOr for KittyKeyboard {
    type Output = Self;
    fn bitor(self, other: Self) -> Self {
        self.union(other)
    }
}

/// Terminal modes for [`Session::setup_terminal`].
///
/// The default turns every mode off. [`HostOptions::default`](crate::host::HostOptions) sets interactive modes
/// instead, so to change one of those, start from it:
///
/// ```
/// use opentui::host::HostOptions;
/// use opentui::native::{MouseTracking, TerminalOptions};
///
/// let terminal = TerminalOptions { mouse: MouseTracking::Motion, ..HostOptions::default().terminal };
/// assert!(terminal.alternate_screen);
/// ```
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TerminalOptions {
    pub alternate_screen: bool,
    pub mouse: MouseTracking,
    /// Clear the claimed surface on close and suspend.
    pub clear_on_close: bool,
    pub kitty_keyboard: KittyKeyboard,
    /// The app runs inside tmux, screen, or Zellij, between it and the link to a remote terminal. Native code then
    /// leaves remote frames out of synchronized output, whose wrapper the multiplexer does not pass on. A local
    /// [`Host`](crate::host::Host) sets it from `TMUX`, `STY`, or `ZELLIJ`, as Core does.
    pub host_multiplexer: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalState {
    Uninitialized,
    SettingUp,
    Active,
    Suspending,
    Suspended,
    Resuming,
    Closing,
    Restored,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionState {
    Open,
    Closing,
    Closed,
    Failed,
    Cancelled,
}

/// What the host should do after [`Session::pump`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pump {
    /// No work is ready.
    Idle,
    /// Pump again on a later turn.
    Again,
    /// Deliver output, then pump again.
    OutputPending,
    /// Pump again at this monotonic nanosecond time.
    WaitUntil(u64),
    /// Graceful shutdown finished.
    Closed,
}

impl Pump {
    fn from_raw(status: u32, deadline_ns: u64) -> Result<Self> {
        Ok(match status {
            sys::OT_PUMP_IDLE => Self::Idle,
            sys::OT_PUMP_AGAIN => Self::Again,
            sys::OT_PUMP_OUTPUT_PENDING => Self::OutputPending,
            sys::OT_PUMP_WAIT_UNTIL => Self::WaitUntil(deadline_ns),
            sys::OT_PUMP_CLOSED => Self::Closed,
            _ => return Err(Error::Native { operation: "ot_session_pump", status: Status::Unknown(status as i32) }),
        })
    }
}

/// A copy of queued output that the host must deliver, then complete exactly once.
#[must_use = "deliver the copied bytes, then pass the ticket to Session::complete_output"]
#[derive(Debug)]
pub struct OutputTicket {
    raw: sys::ot_output_ticket,
}

impl OutputTicket {
    pub fn len(&self) -> usize {
        self.raw.byte_count as usize
    }

    pub fn is_empty(&self) -> bool {
        self.raw.byte_count == 0
    }

    pub fn raw(&self) -> &sys::ot_output_ticket {
        &self.raw
    }
}

/// Cursor shape for [`CursorUpdate`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CursorStyle {
    Block,
    Line,
    Underline,
    #[default]
    Default,
}

impl CursorStyle {
    pub(crate) fn raw(self) -> u8 {
        match self {
            Self::Block => 0,
            Self::Line => 1,
            Self::Underline => 2,
            Self::Default => 3,
        }
    }
}

/// A mouse pointer shape, named after the CSS cursor values.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct MousePointer(u32);

impl MousePointer {
    pub const AUTO: Self = Self(sys::OT_MOUSE_POINTER_AUTO);
    pub const DEFAULT: Self = Self(sys::OT_MOUSE_POINTER_DEFAULT);
    pub const NONE: Self = Self(sys::OT_MOUSE_POINTER_NONE);
    pub const POINTER: Self = Self(sys::OT_MOUSE_POINTER_POINTER);
    pub const TEXT: Self = Self(sys::OT_MOUSE_POINTER_TEXT);
    pub const CROSSHAIR: Self = Self(sys::OT_MOUSE_POINTER_CROSSHAIR);
    pub const MOVE: Self = Self(sys::OT_MOUSE_POINTER_MOVE);
    pub const WAIT: Self = Self(sys::OT_MOUSE_POINTER_WAIT);
    pub const PROGRESS: Self = Self(sys::OT_MOUSE_POINTER_PROGRESS);
    pub const HELP: Self = Self(sys::OT_MOUSE_POINTER_HELP);
    pub const NOT_ALLOWED: Self = Self(sys::OT_MOUSE_POINTER_NOT_ALLOWED);
    pub const GRAB: Self = Self(sys::OT_MOUSE_POINTER_GRAB);
    pub const GRABBING: Self = Self(sys::OT_MOUSE_POINTER_GRABBING);
    pub const EW_RESIZE: Self = Self(sys::OT_MOUSE_POINTER_EW_RESIZE);
    pub const NS_RESIZE: Self = Self(sys::OT_MOUSE_POINTER_NS_RESIZE);

    /// Any `OT_MOUSE_POINTER_*` shape.
    pub const fn from_raw(raw: u32) -> Self {
        Self(raw)
    }

    pub const fn raw(self) -> u32 {
        self.0
    }
}

/// Where the terminal cursor sits and whether it shows. Native code updates these together.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CursorPosition {
    /// One-based column.
    pub x: i32,
    /// One-based row.
    pub y: i32,
    pub visible: bool,
}

/// A partial cursor update. `None` fields keep their current value. Takes effect with the next accepted frame.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CursorUpdate {
    pub position: Option<CursorPosition>,
    pub style: Option<CursorStyle>,
    pub blinking: Option<bool>,
    pub color: Option<Color>,
    pub mouse_pointer: Option<MousePointer>,
}

impl CursorUpdate {
    fn encode(&self) -> sys::ot_session_cursor_update {
        let mut raw = sys::ot_session_cursor_update::default();
        if let Some(position) = self.position {
            raw.fields |= sys::OT_CURSOR_POSITION;
            (raw.x, raw.y, raw.visible) = (position.x, position.y, u8::from(position.visible));
        }
        if let Some(style) = self.style {
            raw.fields |= sys::OT_CURSOR_STYLE;
            raw.style = style.raw();
        }
        if let Some(blinking) = self.blinking {
            raw.fields |= sys::OT_CURSOR_BLINKING;
            raw.blinking = u8::from(blinking);
        }
        if let Some(color) = self.color {
            raw.fields |= sys::OT_CURSOR_COLOR;
            raw.color = color.to_raw();
        }
        if let Some(pointer) = self.mouse_pointer {
            raw.fields |= sys::OT_CURSOR_MOUSE_POINTER;
            raw.mouse_pointer = pointer.0 as u8;
        }
        raw
    }
}

/// A terminal control request for [`Session::control`].
#[derive(Clone, Copy, Debug)]
pub enum Control<'a> {
    /// One complete capability reply read from the terminal, at most 4096 bytes.
    CapabilityResponse(&'a [u8]),
    /// Window title: UTF-8 without control characters, at most 4091 bytes.
    Title(&'a str),
    Mouse(MouseTracking),
    KittyKeyboard(KittyKeyboard),
    RestoreModes,
    QueryPixelResolution,
    QueryThemeColors,
    Cursor(CursorUpdate),
    ResetBackground,
    /// A bounded OSC palette query packet.
    PaletteQuery(&'a [u8]),
    /// One OSC 7501 Program Status Protocol report. Terminals without the protocol ignore it.
    ProgramStatus(ProgramStatus<'a>),
}

/// What a [`ProgramStatus`] report says the program is doing.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum ProgramState {
    #[default]
    Idle,
    Working,
    Done,
    /// Waiting for the user, optionally saying why.
    Blocked(Option<ProgramKind>),
    Error,
    /// Removes the record; the report may carry only an id.
    Clear,
}

/// Why a [`ProgramState::Blocked`] program waits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ProgramKind {
    Permission,
    Question,
    Auth,
}

/// One OSC 7501 record for [`Control::ProgramStatus`]. An empty string omits that key; an empty id addresses the
/// root record.
///
/// The id is at most 8 `/`-separated segments of 1 to 32 `[A-Za-z0-9_.+-]` bytes and 128 bytes in total; the app
/// name is at most 32 such bytes. The title (at most 192 bytes) and message (at most 2048 bytes) must not contain
/// control characters. Native code rejects anything else as an invalid argument.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct ProgramStatus<'a> {
    pub state: ProgramState,
    pub id: &'a str,
    pub app: &'a str,
    pub title: &'a str,
    pub message: &'a str,
    /// Percent done, 0 to 100, for [`ProgramState::Working`] or [`ProgramState::Blocked`].
    pub progress: Option<u8>,
}

impl ProgramStatus<'_> {
    /// The control payload: the fixed header followed by the id, app, title, and message bytes.
    fn encode(&self) -> Result<Vec<u8>> {
        const OPERATION: &str = "ot_session_control";
        let (state, kind) = match self.state {
            ProgramState::Idle => (sys::OT_PROGRAM_STATE_IDLE, 0),
            ProgramState::Working => (sys::OT_PROGRAM_STATE_WORKING, 0),
            ProgramState::Done => (sys::OT_PROGRAM_STATE_DONE, 0),
            ProgramState::Blocked(kind) => (
                sys::OT_PROGRAM_STATE_BLOCKED,
                match kind {
                    None => 0,
                    Some(ProgramKind::Permission) => sys::OT_PROGRAM_KIND_PERMISSION,
                    Some(ProgramKind::Question) => sys::OT_PROGRAM_KIND_QUESTION,
                    Some(ProgramKind::Auth) => sys::OT_PROGRAM_KIND_AUTH,
                },
            ),
            ProgramState::Error => (sys::OT_PROGRAM_STATE_ERROR, 0),
            ProgramState::Clear => (sys::OT_PROGRAM_STATE_CLEAR, 0),
        };
        let header = sys::ot_session_program_status {
            state,
            kind,
            fields: if self.progress.is_some() { sys::OT_PROGRAM_STATUS_PROGRESS } else { 0 },
            progress: self.progress.map_or(0, u32::from),
            id_len: count(OPERATION, self.id.len())?,
            app_len: count(OPERATION, self.app.len())?,
            title_len: count(OPERATION, self.title.len())?,
            message_len: count(OPERATION, self.message.len())?,
        };
        let mut payload = sys::bytes_of(&header).to_vec();
        for text in [self.id, self.app, self.title, self.message] {
            payload.extend_from_slice(text.as_bytes());
        }
        Ok(payload)
    }
}

/// Terminal features detected from the environment and capability replies.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct CapabilityFlags(u32);

impl CapabilityFlags {
    pub const KITTY_KEYBOARD: Self = Self(sys::OT_CAP_KITTY_KEYBOARD);
    pub const KITTY_GRAPHICS: Self = Self(sys::OT_CAP_KITTY_GRAPHICS);
    pub const RGB: Self = Self(sys::OT_CAP_RGB);
    pub const ANSI256: Self = Self(sys::OT_CAP_ANSI256);
    pub const SGR_PIXELS: Self = Self(sys::OT_CAP_SGR_PIXELS);
    pub const COLOR_SCHEME_UPDATES: Self = Self(sys::OT_CAP_COLOR_SCHEME_UPDATES);
    pub const EXPLICIT_WIDTH: Self = Self(sys::OT_CAP_EXPLICIT_WIDTH);
    pub const SCALED_TEXT: Self = Self(sys::OT_CAP_SCALED_TEXT);
    pub const SIXEL: Self = Self(sys::OT_CAP_SIXEL);
    pub const FOCUS_TRACKING: Self = Self(sys::OT_CAP_FOCUS_TRACKING);
    pub const SYNC: Self = Self(sys::OT_CAP_SYNC);
    pub const BRACKETED_PASTE: Self = Self(sys::OT_CAP_BRACKETED_PASTE);
    pub const HYPERLINKS: Self = Self(sys::OT_CAP_HYPERLINKS);
    pub const OSC52: Self = Self(sys::OT_CAP_OSC52);
    pub const NOTIFICATIONS: Self = Self(sys::OT_CAP_NOTIFICATIONS);
    pub const EXPLICIT_CURSOR_POSITIONING: Self = Self(sys::OT_CAP_EXPLICIT_CURSOR_POSITIONING);
    pub const REMOTE: Self = Self(sys::OT_CAP_REMOTE);
    /// The terminal answered the OSC 7501 query, so it shows [`Control::ProgramStatus`] reports.
    pub const PROGRAM_STATUS: Self = Self(sys::OT_CAP_PROGRAM_STATUS);

    pub const fn bits(self) -> u32 {
        self.0
    }

    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }
}

/// How native code measures text in terminal cells. Text lines up only when it measures the way the terminal does,
/// so pass the Session's detected method, [`Capabilities::width_method`], to the buffers that draw text.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum WidthMethod {
    /// Adds up the widths of the code points in each character, like `wcwidth(3)`, as tmux and terminals without
    /// grapheme support do.
    Wcwidth,
    /// Measures each character, a grapheme cluster, as a whole: an emoji sequence takes the cells of one emoji.
    #[default]
    Unicode,
    /// Like [`Self::Unicode`], but zero-width joiners do not join: each part of a joined emoji takes its own cells.
    NoZwj,
    /// Like [`Self::Unicode`], but a character with more than one visible code point is at least two cells wide, as
    /// in newer Ghostty.
    UnicodeWide,
}

impl WidthMethod {
    pub(crate) fn raw(self) -> u32 {
        match self {
            Self::Wcwidth => sys::OT_WIDTH_METHOD_WCWIDTH,
            Self::Unicode => sys::OT_WIDTH_METHOD_UNICODE,
            Self::NoZwj => sys::OT_WIDTH_METHOD_NO_ZWJ,
            Self::UnicodeWide => sys::OT_WIDTH_METHOD_UNICODE_WIDE,
        }
    }

    /// Native code reports only these four; a code from a newer library counts as [`Self::Unicode`], its default.
    fn from_raw(raw: u32) -> Self {
        match raw {
            sys::OT_WIDTH_METHOD_WCWIDTH => Self::Wcwidth,
            sys::OT_WIDTH_METHOD_NO_ZWJ => Self::NoZwj,
            sys::OT_WIDTH_METHOD_UNICODE_WIDE => Self::UnicodeWide,
            _ => Self::Unicode,
        }
    }
}

/// The terminal multiplexer the Session runs inside.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Multiplexer {
    #[default]
    None,
    Tmux,
    Zellij,
    /// GNU Screen.
    Screen,
    /// A multiplexer native code does not name.
    Unknown,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Capabilities {
    pub flags: CapabilityFlags,
    pub width_method: WidthMethod,
    pub multiplexer: Multiplexer,
    /// The protocol the `OPENTUI_IMAGE_PROTOCOL` environment entry forces, or [`ImageProtocol::Auto`] without one:
    /// images then use Kitty graphics or Sixel as [`Self::flags`] report support, and blocks otherwise or in tmux.
    pub image_protocol: ImageProtocol,
    /// OSC 52 clipboard support, when known.
    pub osc52: Option<bool>,
    /// Requested Kitty keyboard flags, not confirmation that the terminal enabled them.
    pub kitty_keyboard: KittyKeyboard,
    pub terminal_name: String,
    pub terminal_version: String,
    /// Whether the name and version came from an XTVERSION reply.
    pub from_xtversion: bool,
}

/// What the image transport did with a Kitty graphics reply.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KittyImageReply {
    /// Not an image transport reply; handle it like any other terminal reply.
    Ignored,
    Consumed,
    /// Consumed, and images must be sent again: paint a new frame.
    Retransmit,
}

/// Renderer dimensions and presentation counters.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RendererState {
    pub width: u32,
    pub height: u32,
    /// Completed presentations, not queued frames.
    pub frame_count: u64,
    pub frame_pending: bool,
    /// Presented Kitty and Sixel images whose upload a later frame still sends, because it did not fit the frame
    /// limit. Present another frame while this is nonzero; [`App`](crate::app::App) does.
    pub image_uploads_pending: u32,
    /// Frames whose output without image uploads was larger than the write limit, counting each content once.
    /// [`App::on_frame_dropped`](crate::app::App::on_frame_dropped) reports each.
    pub dropped_frames: u32,
    /// The size of the last frame when it was dropped (saturated), or 0 when it was not.
    pub dropped_frame_bytes: u32,
}

/// Renderer timing statistics, in milliseconds.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FrameStats {
    pub last_frame_time: f64,
    pub average_frame_time: f64,
    pub render_time: Option<f64>,
    pub stdout_write_time: Option<f64>,
    pub frame_count: u64,
    pub cells_updated: u32,
    pub average_cells_updated: u32,
}

/// A corner of the screen, for the debug overlay.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Corner {
    TopLeft,
    #[default]
    TopRight,
    BottomLeft,
    BottomRight,
}

/// An ordered output queue, terminal state, renderer, and scene within a [`Context`].
///
/// Cloning shares the same Session. Nodes keep their Session alive. Graceful shutdown is [`Self::close`], then
/// pumping and delivering output until [`Pump::Closed`]. Dropping the last clone cancels outstanding work instead:
/// it cannot restore a terminal.
#[derive(Clone)]
pub struct Session(Rc<SessionInner>);

struct SessionInner {
    context: Context,
    handle: sys::ot_handle,
}

impl Drop for SessionInner {
    fn drop(&mut self) {
        let context = self.context.as_raw();
        let status = unsafe { sys::ot_session_destroy(context, &self.handle) };
        if status == sys::OT_CONTEXT_BUSY {
            // Pending output or an unrestored terminal blocks destruction; cancellation is the fallback.
            cleanup("ot_session_cancel", unsafe { sys::ot_session_cancel(context, &self.handle) });
            cleanup("ot_session_destroy", unsafe { sys::ot_session_destroy(context, &self.handle) });
        } else {
            cleanup("ot_session_destroy", status);
        }
    }
}

struct Writer<'a> {
    write: &'a mut dyn FnMut(&[u8]) -> io::Result<usize>,
    error: Option<io::Error>,
    panic: Option<Box<dyn Any + Send>>,
}

unsafe extern "C" fn write_output(user_data: *mut c_void, bytes: *const u8, byte_count: u32) -> i64 {
    // SAFETY: drain_output passes a live Writer, and native code lends `bytes` for this call.
    let writer = unsafe { &mut *user_data.cast::<Writer<'_>>() };
    let bytes = unsafe { std::slice::from_raw_parts(bytes, byte_count as usize) };
    // A panic must not unwind through native frames.
    match panic::catch_unwind(panic::AssertUnwindSafe(|| (writer.write)(bytes))) {
        Ok(Ok(written)) => written.min(bytes.len()) as i64,
        Ok(Err(error)) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) => 0,
        Ok(Err(error)) => {
            writer.error = Some(error);
            -1
        }
        Err(payload) => {
            writer.panic = Some(payload);
            -1
        }
    }
}

impl Session {
    pub fn new(context: &Context, options: SessionOptions) -> Result<Self> {
        let raw = sys::ot_session_options {
            chunk_size: options.chunk_size,
            span_capacity: options.span_capacity,
            max_bytes: options.max_bytes,
            control_capacity: options.control_capacity,
            ..Default::default()
        };
        let mut handle = sys::ot_handle::default();
        check("ot_session_create", unsafe { sys::ot_session_create(context.as_raw(), &raw, &mut handle) })?;
        Ok(Self(Rc::new(SessionInner { context: context.clone(), handle })))
    }

    pub fn context(&self) -> &Context {
        &self.0.context
    }

    pub fn handle(&self) -> sys::ot_handle {
        self.0.handle
    }

    /// How many handles share this Session.
    pub(crate) fn references(&self) -> usize {
        Rc::strong_count(&self.0)
    }

    fn raw(&self) -> (*mut sys::ot_context, *const sys::ot_handle) {
        (self.0.context.as_raw(), &self.0.handle)
    }

    /// Attaches a renderer of `width` by `height` cells. No terminal output or setup happens yet.
    ///
    /// `environment` supplies terminal hints such as `TERM` and `COLORTERM`; native code never reads the process
    /// environment. The entries are copied during the call.
    pub fn attach_renderer(&self, width: u32, height: u32, remote: Remote, environment: &[(&str, &str)]) -> Result<()> {
        const OPERATION: &str = "ot_session_attach_renderer_with_env";
        // Check the ABI's admission limits before allocating the encoded environment.
        let invalid = Error::Native { operation: OPERATION, status: Status::InvalidArgument };
        if environment.len() > sys::OT_SESSION_ENV_ENTRIES_MAX as usize {
            return Err(invalid);
        }
        let byte_count = environment
            .iter()
            .try_fold(0usize, |total, (key, value)| total.checked_add(8 + key.len())?.checked_add(value.len()))
            .filter(|&total| total <= sys::OT_SESSION_ENV_BYTES_MAX as usize)
            .ok_or(invalid)?;
        let mut encoded = Vec::with_capacity(byte_count);
        for (key, value) in environment {
            encoded.extend_from_slice(&(key.len() as u32).to_le_bytes());
            encoded.extend_from_slice(&(value.len() as u32).to_le_bytes());
            encoded.extend_from_slice(key.as_bytes());
            encoded.extend_from_slice(value.as_bytes());
        }
        let options = sys::ot_session_renderer_env_options {
            width,
            height,
            remote_mode: match remote {
                Remote::Auto => sys::OT_SESSION_REMOTE_AUTO,
                Remote::Local => sys::OT_SESSION_REMOTE_LOCAL,
                Remote::Remote => sys::OT_SESSION_REMOTE_REMOTE,
            },
            entry_count: environment.len() as u32,
            byte_count: encoded.len() as u32,
            ..Default::default()
        };
        let (context, session) = self.raw();
        check(OPERATION, unsafe {
            sys::ot_session_attach_renderer_with_env(context, session, &options, encoded.as_ptr())
        })
    }

    /// Requests terminal setup. Pump and deliver output until [`TerminalState::Active`] before the first frame.
    pub fn setup_terminal(&self, options: TerminalOptions) -> Result<()> {
        let mut flags = 0;
        if options.alternate_screen {
            flags |= sys::OT_TERMINAL_ALTERNATE_SCREEN;
        }
        match options.mouse {
            MouseTracking::Off => {}
            MouseTracking::Buttons => flags |= sys::OT_TERMINAL_MOUSE,
            MouseTracking::Motion => flags |= sys::OT_TERMINAL_MOUSE | sys::OT_TERMINAL_MOUSE_MOVEMENT,
        }
        if options.clear_on_close {
            flags |= sys::OT_TERMINAL_CLEAR_ON_CLOSE;
        }
        if options.host_multiplexer {
            flags |= sys::OT_TERMINAL_HOST_MULTIPLEXER;
        }
        let raw = sys::ot_session_terminal_options {
            flags,
            kitty_keyboard_flags: options.kitty_keyboard.bits(),
            ..Default::default()
        };
        let (context, session) = self.raw();
        check("ot_session_setup_terminal", unsafe { sys::ot_session_setup_terminal(context, session, &raw) })
    }

    /// Requests suspension, for example before stopping the process on Ctrl-Z. Pump until suspended.
    pub fn suspend(&self) -> Result<()> {
        let (context, session) = self.raw();
        check("ot_session_suspend", unsafe { sys::ot_session_suspend(context, session) })
    }

    /// Requests resumption with the original setup options. Pump until active, then paint a new frame.
    pub fn resume(&self) -> Result<()> {
        let (context, session) = self.raw();
        check("ot_session_resume", unsafe { sys::ot_session_resume(context, session) })
    }

    pub fn terminal_state(&self) -> Result<TerminalState> {
        let mut phase = 0;
        let (context, session) = self.raw();
        check("ot_session_get_terminal_state", unsafe {
            sys::ot_session_get_terminal_state(context, session, &mut phase)
        })?;
        Ok(match phase {
            sys::OT_TERMINAL_UNINITIALIZED => TerminalState::Uninitialized,
            sys::OT_TERMINAL_SETTING_UP => TerminalState::SettingUp,
            sys::OT_TERMINAL_ACTIVE => TerminalState::Active,
            sys::OT_TERMINAL_SUSPENDING => TerminalState::Suspending,
            sys::OT_TERMINAL_SUSPENDED => TerminalState::Suspended,
            sys::OT_TERMINAL_RESUMING => TerminalState::Resuming,
            sys::OT_TERMINAL_CLOSING => TerminalState::Closing,
            sys::OT_TERMINAL_RESTORED => TerminalState::Restored,
            sys::OT_TERMINAL_CANCELLED => TerminalState::Cancelled,
            _ => TerminalState::Failed,
        })
    }

    pub fn control(&self, control: Control<'_>) -> Result<()> {
        let cursor;
        let status;
        let (kind, argument, bytes): (u32, u32, &[u8]) = match control {
            Control::CapabilityResponse(bytes) => (sys::OT_CONTROL_CAPABILITY_RESPONSE, 0, bytes),
            Control::Title(title) => (sys::OT_CONTROL_TITLE, 0, title.as_bytes()),
            Control::Mouse(mode) => (sys::OT_CONTROL_MOUSE, mode.control_argument(), &[]),
            Control::KittyKeyboard(flags) => (sys::OT_CONTROL_KITTY_KEYBOARD_FLAGS, flags.bits(), &[]),
            Control::RestoreModes => (sys::OT_CONTROL_RESTORE_MODES, 0, &[]),
            Control::QueryPixelResolution => (sys::OT_CONTROL_QUERY_PIXEL_RESOLUTION, 0, &[]),
            Control::QueryThemeColors => (sys::OT_CONTROL_QUERY_THEME_COLORS, 0, &[]),
            Control::Cursor(update) => {
                cursor = update.encode();
                (sys::OT_CONTROL_CURSOR, 0, sys::bytes_of(&cursor))
            }
            Control::ResetBackground => (sys::OT_CONTROL_RESET_BACKGROUND, 0, &[]),
            Control::PaletteQuery(bytes) => (sys::OT_CONTROL_PALETTE_QUERY, 0, bytes),
            Control::ProgramStatus(report) => {
                status = report.encode()?;
                (sys::OT_CONTROL_PROGRAM_STATUS, 0, &status)
            }
        };
        let options = sys::ot_session_control_options { kind, argument, ..Default::default() };
        let length = count("ot_session_control", bytes.len())?;
        let (context, session) = self.raw();
        check("ot_session_control", unsafe {
            sys::ot_session_control(context, session, &options, bytes.as_ptr(), length)
        })
    }

    pub fn capabilities(&self) -> Result<Capabilities> {
        let mut raw = sys::ot_session_capabilities::default();
        let (context, session) = self.raw();
        check("ot_session_get_capabilities", unsafe { sys::ot_session_get_capabilities(context, session, &mut raw) })?;
        let text = |bytes: &[u8], length: u32| {
            String::from_utf8_lossy(&bytes[..(length as usize).min(bytes.len())]).into_owned()
        };
        Ok(Capabilities {
            flags: CapabilityFlags(raw.flags),
            width_method: WidthMethod::from_raw(raw.width_method),
            multiplexer: match raw.multiplexer {
                0 => Multiplexer::None,
                1 => Multiplexer::Tmux,
                2 => Multiplexer::Zellij,
                3 => Multiplexer::Screen,
                _ => Multiplexer::Unknown,
            },
            image_protocol: match raw.image_protocol {
                sys::OT_IMAGE_PROTOCOL_KITTY => ImageProtocol::Kitty,
                sys::OT_IMAGE_PROTOCOL_SIXEL => ImageProtocol::Sixel,
                sys::OT_IMAGE_PROTOCOL_BLOCKS => ImageProtocol::Blocks,
                _ => ImageProtocol::Auto,
            },
            osc52: match raw.osc52_support {
                1 => Some(true),
                2 => Some(false),
                _ => None,
            },
            kitty_keyboard: KittyKeyboard::from_bits(raw.kitty_keyboard_flags),
            terminal_name: text(&raw.term_name, raw.term_name_len),
            terminal_version: text(&raw.term_version, raw.term_version_len),
            from_xtversion: raw.term_from_xtversion != 0,
        })
    }

    /// Offers a Kitty graphics reply (`ESC _ G ... ESC \`) to the image transport.
    pub fn process_kitty_image_reply(&self, reply: &[u8]) -> Result<KittyImageReply> {
        let mut result = 0;
        let length = count("ot_session_process_kitty_image_reply", reply.len())?;
        let (context, session) = self.raw();
        check("ot_session_process_kitty_image_reply", unsafe {
            sys::ot_session_process_kitty_image_reply(context, session, reply.as_ptr(), length, &mut result)
        })?;
        Ok(match result {
            0 => KittyImageReply::Ignored,
            1 => KittyImageReply::Consumed,
            _ => KittyImageReply::Retransmit,
        })
    }

    /// Parses terminal input that arrived at `now_ns` into `records` and `payload`, which the next call reuses.
    /// Returns the drain record: parse the bytes after `consumed` with another call. `now_ns` must not go backwards.
    pub(crate) fn input_feed(
        &self,
        bytes: &[u8],
        now_ns: u64,
        records: &mut [sys::ot_input_event],
        payload: &mut [u8],
    ) -> Result<sys::ot_input_drain> {
        const OPERATION: &str = "ot_session_input_feed";
        let mut drain = sys::ot_input_drain::default();
        let (length, capacity, payload_capacity) =
            (count(OPERATION, bytes.len())?, count(OPERATION, records.len())?, count(OPERATION, payload.len())?);
        let (context, session) = self.raw();
        check(OPERATION, unsafe {
            sys::ot_session_input_feed(
                context,
                session,
                bytes.as_ptr(),
                length,
                now_ns,
                records.as_mut_ptr(),
                capacity,
                payload.as_mut_ptr(),
                payload_capacity,
                &mut drain,
            )
        })?;
        Ok(drain)
    }

    /// Sets the `OT_INPUT_EXPECT_*` flags: the replies the host waits for.
    pub(crate) fn input_expect(&self, flags: u32) -> Result<()> {
        let (context, session) = self.raw();
        check("ot_session_input_expect", unsafe { sys::ot_session_input_expect(context, session, flags) })
    }

    /// Drops a partial input unit and the mouse button state. With `keep_reply`, a partial reply the host expects
    /// survives and waits for its rest without a deadline.
    pub(crate) fn input_reset(&self, keep_reply: bool) -> Result<()> {
        let flags = if keep_reply { sys::OT_INPUT_RESET_KEEP_REPLY } else { 0 };
        let (context, session) = self.raw();
        check("ot_session_input_reset", unsafe { sys::ot_session_input_reset(context, session, flags) })
    }

    /// Writes a clipboard selection through the terminal (OSC 52). Empty text clears it. Returns `false` when the
    /// terminal lacks support or output was rejected.
    pub fn set_clipboard(&self, selection: ClipboardSelection, text: &[u8]) -> Result<bool> {
        let mut written = 0;
        let length = count("ot_session_clipboard", text.len())?;
        let (context, session) = self.raw();
        check("ot_session_clipboard", unsafe {
            sys::ot_session_clipboard(context, session, selection.osc52_target(), text.as_ptr(), length, &mut written)
        })?;
        Ok(written != 0)
    }

    /// Sends a desktop notification. Returns `false` when the terminal lacks support or output was rejected.
    pub fn notify(&self, message: &str, title: Option<&str>) -> Result<bool> {
        let mut written = 0;
        let title = title.unwrap_or("");
        let (message_length, title_length) =
            (count("ot_session_notification", message.len())?, count("ot_session_notification", title.len())?);
        let (context, session) = self.raw();
        check("ot_session_notification", unsafe {
            sys::ot_session_notification(
                context,
                session,
                message.as_ptr(),
                message_length,
                title.as_ptr(),
                title_length,
                &mut written,
            )
        })?;
        Ok(written != 0)
    }

    /// Does bounded native work. `now_ns` is a monotonic host clock; samples must never go backwards.
    pub fn pump(&self, now_ns: u64, work_budget: u32) -> Result<Pump> {
        let mut result = sys::ot_session_pump_result::default();
        let (context, session) = self.raw();
        check("ot_session_pump", unsafe { sys::ot_session_pump(context, session, now_ns, work_budget, &mut result) })?;
        Pump::from_raw(result.status, result.deadline_ns)
    }

    /// Process-exit fallback: one restoration step without cursor-settle waits. Deliver output between calls.
    pub fn pump_exit(&self) -> Result<Pump> {
        let mut status = 0;
        let (context, session) = self.raw();
        check("ot_session_pump_exit", unsafe { sys::ot_session_pump_exit(context, session, &mut status) })?;
        Pump::from_raw(status, 0)
    }

    /// Copies all bytes into the queue, or rejects the whole write.
    pub fn write(&self, bytes: &[u8]) -> Result<()> {
        let length = count("ot_session_write", bytes.len())?;
        let (context, session) = self.raw();
        check("ot_session_write", unsafe { sys::ot_session_write(context, session, bytes.as_ptr(), length) })
    }

    /// The largest ordinary write an empty queue accepts.
    pub fn write_limit(&self) -> Result<u64> {
        let mut bytes = 0;
        let (context, session) = self.raw();
        check("ot_session_get_write_limit", unsafe { sys::ot_session_get_write_limit(context, session, &mut bytes) })?;
        Ok(bytes)
    }

    /// Copies queued output into `bytes`. Deliver all `ticket.len()` bytes, then complete the ticket. Only one ticket
    /// can be outstanding. Returns `None` when nothing is queued.
    pub fn read_output(&self, bytes: &mut [u8]) -> Result<Option<OutputTicket>> {
        let mut raw = sys::ot_output_ticket::default();
        let capacity = count("ot_session_read_output", bytes.len())?;
        let (context, session) = self.raw();
        check("ot_session_read_output", unsafe {
            sys::ot_session_read_output(context, session, bytes.as_mut_ptr(), capacity, &mut raw)
        })?;
        Ok((raw.byte_count > 0).then_some(OutputTicket { raw }))
    }

    /// Records delivery of a copied ticket, or a transport failure, which stops output without replay.
    pub fn complete_output(&self, ticket: OutputTicket, delivered: bool) -> Result<()> {
        let (context, session) = self.raw();
        check("ot_session_complete_output", unsafe {
            sys::ot_session_complete_output(context, session, &ticket.raw, u32::from(delivered))
        })
    }

    /// Writes queued bytes directly to process stdout. Returns the bytes written; zero means the queue is empty or a
    /// nonblocking stdout is full.
    pub fn drain_stdout(&self, max_bytes: u32) -> Result<u32> {
        let mut written = 0;
        let (context, session) = self.raw();
        check("ot_session_drain_stdout", unsafe {
            sys::ot_session_drain_stdout(context, session, max_bytes, &mut written)
        })?;
        Ok(written)
    }

    /// Passes queued bytes to `write`, which returns how many it delivered. `WouldBlock` and `Interrupted` count
    /// as backpressure; other errors stop the transport. Returns the bytes delivered.
    pub fn drain_output(&self, max_bytes: u32, mut write: impl FnMut(&[u8]) -> io::Result<usize>) -> Result<u32> {
        let mut writer = Writer { write: &mut write, error: None, panic: None };
        let mut written = 0;
        let (context, session) = self.raw();
        let status = unsafe {
            sys::ot_session_drain_output(
                context,
                session,
                max_bytes,
                &mut written,
                (&mut writer as *mut Writer<'_>).cast(),
                Some(write_output),
            )
        };
        if let Some(payload) = writer.panic {
            panic::resume_unwind(payload);
        }
        if let Some(error) = writer.error {
            return Err(Error::Io(error));
        }
        check("ot_session_drain_output", status)?;
        Ok(written)
    }

    /// Stops new writes. Keep pumping and delivering until [`Pump::Closed`] to restore the terminal.
    pub fn close(&self) -> Result<()> {
        let (context, session) = self.raw();
        check("ot_session_close", unsafe { sys::ot_session_close(context, session) })
    }

    /// For a close past its deadline: closes if needed, then discards the output queued before the close except a
    /// copy in flight. Terminal restoration still follows; keep pumping as after [`Self::close`].
    pub fn drop_output(&self) -> Result<()> {
        let (context, session) = self.raw();
        check("ot_session_drop_output", unsafe { sys::ot_session_drop_output(context, session) })
    }

    /// Discards pending output after the transport is gone. Does not restore the terminal.
    pub fn cancel(&self) -> Result<()> {
        let (context, session) = self.raw();
        check("ot_session_cancel", unsafe { sys::ot_session_cancel(context, session) })
    }

    pub fn state(&self) -> Result<SessionState> {
        let mut state = 0;
        let (context, session) = self.raw();
        check("ot_session_get_state", unsafe { sys::ot_session_get_state(context, session, &mut state) })?;
        Ok(match state {
            sys::OT_SESSION_OPEN => SessionState::Open,
            sys::OT_SESSION_CLOSING => SessionState::Closing,
            sys::OT_SESSION_CLOSED_STATE => SessionState::Closed,
            sys::OT_SESSION_CANCELLED_STATE => SessionState::Cancelled,
            _ => SessionState::Failed,
        })
    }

    pub fn resize(&self, width: u32, height: u32) -> Result<()> {
        let (context, session) = self.raw();
        check("ot_session_resize_renderer", unsafe { sys::ot_session_resize_renderer(context, session, width, height) })
    }

    pub fn renderer_state(&self) -> Result<RendererState> {
        let mut raw = sys::ot_session_renderer_state::default();
        let (context, session) = self.raw();
        check("ot_session_get_renderer_state", unsafe {
            sys::ot_session_get_renderer_state(context, session, &mut raw)
        })?;
        Ok(RendererState {
            width: raw.width,
            height: raw.height,
            frame_count: raw.frame_count,
            frame_pending: raw.frame_pending != 0,
            image_uploads_pending: raw.image_uploads_pending,
            dropped_frames: raw.dropped_frames,
            dropped_frame_bytes: raw.dropped_frame_bytes,
        })
    }

    /// The public number of the node presented at a cell, from the last completed scene presentation.
    pub fn hit_test(&self, x: i32, y: i32) -> Result<Option<u32>> {
        let mut num = 0;
        let (context, session) = self.raw();
        check("ot_scene_hit_test", unsafe { sys::ot_scene_hit_test(context, session, x, y, &mut num) })?;
        Ok((num != 0).then_some(num))
    }

    /// The hyperlink id stored in a presented cell; resolve it with [`Context::link_url`].
    pub fn link_id(&self, x: i32, y: i32) -> Result<Option<u32>> {
        let mut link = 0;
        let (context, session) = self.raw();
        check("ot_session_get_link_id", unsafe { sys::ot_session_get_link_id(context, session, x, y, &mut link) })?;
        Ok((link != 0).then_some(link))
    }

    pub fn stats(&self) -> Result<FrameStats> {
        let mut raw = sys::ot_scene_stats::default();
        let (context, session) = self.raw();
        check("ot_scene_get_stats", unsafe { sys::ot_scene_get_stats(context, session, &mut raw) })?;
        Ok(FrameStats {
            last_frame_time: raw.last_frame_time,
            average_frame_time: raw.average_frame_time,
            render_time: (raw.render_time_valid != 0).then_some(raw.render_time),
            stdout_write_time: (raw.stdout_write_time_valid != 0).then_some(raw.stdout_write_time),
            frame_count: raw.frame_count,
            cells_updated: raw.cells_updated,
            average_cells_updated: raw.average_cells_updated,
        })
    }

    /// Sets the `OT_SCENE_DEBUG_*` switches for tests. They persist for the session, which needs a root node and no
    /// frame in progress.
    pub(crate) fn set_debug_flags(&self, flags: u32) -> Result<()> {
        let (context, session) = self.raw();
        check("ot_scene_set_debug_flags", unsafe { sys::ot_scene_set_debug_flags(context, session, flags) })
    }

    /// Shows native frame statistics in a corner of the screen, or hides them.
    pub fn set_debug_overlay(&self, enabled: bool, corner: Corner) -> Result<()> {
        let corner = match corner {
            Corner::TopLeft => 0,
            Corner::TopRight => 1,
            Corner::BottomLeft => 2,
            Corner::BottomRight => 3,
        };
        let (context, session) = self.raw();
        check("ot_session_set_debug_overlay", unsafe {
            sys::ot_session_set_debug_overlay(context, session, u32::from(enabled), corner)
        })
    }

    /// Tells native code the terminal's palette and default colors, so it can choose palette colors for RGB ones on
    /// terminals without true color. `epoch` marks a new palette. Requires an active terminal.
    pub fn set_palette_state(
        &self,
        palette: &[Color],
        foreground: Option<Color>,
        background: Option<Color>,
        epoch: u32,
    ) -> Result<()> {
        let lanes = |color: Color| [u16::from(color.r), u16::from(color.g), u16::from(color.b), u16::from(color.a)];
        let palette: Vec<u16> = palette.iter().take(256).flat_map(|&color| lanes(color)).collect();
        let (foreground, background) = (foreground.map(lanes), background.map(lanes));
        let (context, session) = self.raw();
        check("ot_session_set_palette_state", unsafe {
            sys::ot_session_set_palette_state(
                context,
                session,
                palette.as_ptr(),
                (palette.len() / 4) as u32,
                foreground.as_ref().map_or(std::ptr::null(), |lanes| lanes.as_ptr()),
                background.as_ref().map_or(std::ptr::null(), |lanes| lanes.as_ptr()),
                epoch,
            )
        })
    }

    /// Host timings for the debug overlay: the whole frame and the host's callbacks, in milliseconds, and frames
    /// per second.
    pub fn update_stats(&self, frame_ms: f64, fps: u32, callback_ms: f64) -> Result<()> {
        let (context, session) = self.raw();
        check("ot_session_update_stats", unsafe {
            sys::ot_session_update_stats(context, session, frame_ms.max(0.0), fps, callback_ms.max(0.0))
        })
    }
}
