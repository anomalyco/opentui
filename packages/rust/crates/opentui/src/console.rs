//! A debug console: an overlay that shows log messages from anywhere in the app, as Core's console does.
//!
//! Log from any thread with [`log`](fn@log), [`info`], [`warn`], [`error`], and [`debug`], or from the UI thread with
//! [`App::console`]. With the `log` feature, `init_logger` routes the `log` crate's macros here too, and
//! [`AppOptions::capture_stderr`](crate::AppOptions::capture_stderr) shows what the process writes to stderr. The
//! overlay stays hidden until shown:
//!
//! ```no_run
//! use opentui::prelude::*;
//!
//! # fn main() -> opentui::Result<()> {
//! let app = App::new(AppOptions::default())?;
//! app.on_key(|cx, key| {
//!     if key.matches("f11") {
//!         cx.console().toggle();
//!     }
//! });
//! std::thread::spawn(|| opentui::console::info("work finished"));
//! app.run()
//! # }
//! ```

use crate::app::{App, AppProxy, Cx};
use crate::layout::{Edge, LayoutProperty, Length};
use crate::style::{Color, Span, Style};
use crate::widget::{Code, Container, Text, View, Widget};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

/// How important a console message is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum LogLevel {
    Debug,
    #[default]
    Log,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    fn label(self) -> &'static str {
        match self {
            Self::Debug => "DEBUG",
            Self::Log => "LOG",
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
        }
    }
}

/// One console message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogEntry {
    pub time: SystemTime,
    pub level: LogLevel,
    pub message: String,
}

impl LogEntry {
    /// The entry as the console shows it: local time, level, and message, with later lines indented.
    pub fn format(&self) -> String {
        let seconds = self.time.duration_since(SystemTime::UNIX_EPOCH).unwrap_or(Duration::ZERO).as_secs();
        let mut local: libc::tm = unsafe { std::mem::zeroed() };
        let time = seconds as libc::time_t;
        #[cfg(unix)]
        unsafe {
            libc::localtime_r(&time, &mut local)
        };
        #[cfg(windows)]
        unsafe {
            libc::localtime_s(&mut local, &time)
        };
        let head = format!("{:02}:{:02}:{:02} {:<5} ", local.tm_hour, local.tm_min, local.tm_sec, self.level.label());
        let mut lines = self.message.lines();
        let mut text = format!("{head}{}", lines.next().unwrap_or_default());
        for line in lines {
            text.push_str("\n  ");
            text.push_str(line);
        }
        text
    }
}

/// Where the console overlay sits.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum ConsolePosition {
    Top,
    #[default]
    Bottom,
    Left,
    Right,
}

impl ConsolePosition {
    const ORDER: [Self; 4] = [Self::Top, Self::Right, Self::Bottom, Self::Left];

    fn step(self, forward: bool) -> Self {
        let index = Self::ORDER.iter().position(|&position| position == self).unwrap_or(0);
        Self::ORDER[(index + if forward { 1 } else { 3 }) % 4]
    }
}

/// Messages kept per app, and while no app exists, as Core keeps them.
const ENTRIES_MAX: usize = 2000;

struct Target {
    id: u64,
    proxy: AppProxy,
    queue: VecDeque<LogEntry>,
    waking: bool,
    /// Whether messages from threads without an app may come here. Remote apps take only their own: in a server
    /// running one app per client, another thread's messages would reach the wrong user.
    fallback: bool,
}

struct Sink {
    targets: Vec<Target>,
    /// Messages logged while no app was registered, for the next one.
    orphans: VecDeque<LogEntry>,
}

static SINK: Mutex<Sink> = Mutex::new(Sink { targets: Vec::new(), orphans: VecDeque::new() });
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

thread_local! {
    /// The apps registered on this thread, oldest first. Messages from this thread go to the newest.
    static LOCAL: std::cell::RefCell<Vec<u64>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn push(queue: &mut VecDeque<LogEntry>, entry: LogEntry) {
    if queue.len() >= ENTRIES_MAX {
        queue.pop_front();
    }
    queue.push_back(entry);
}

/// Asks the app to collect its queued messages, once per batch.
fn wake(target: &mut Target) {
    if target.waking || target.queue.is_empty() {
        return;
    }
    let id = target.id;
    target.waking = target.proxy.post(move |cx| deliver(id, cx)).is_ok();
}

fn deliver(id: u64, cx: &mut Cx<'_>) {
    let entries = {
        let Ok(mut sink) = SINK.lock() else { return };
        let Some(target) = sink.targets.iter_mut().find(|target| target.id == id) else { return };
        target.waking = false;
        std::mem::take(&mut target.queue)
    };
    cx.console().append(entries);
}

/// Adds a message to the console, from any thread. It goes to the app running on the calling thread, or else to
/// the most recently created one that is not [remote](crate::App::remote); before any such app exists, the 2,000
/// latest messages wait for the first. To reach one app from other threads when there may be several, use
/// [`Console::sender`].
pub fn log(level: LogLevel, message: impl Into<String>) {
    let local = LOCAL.try_with(|local| local.borrow().last().copied()).ok().flatten();
    log_to(local.unwrap_or(0), level, message.into());
}

/// Adds a message to the console of app `id`, or as [`log`] does when it is gone.
fn log_to(id: u64, level: LogLevel, message: String) {
    let entry = LogEntry { time: SystemTime::now(), level, message };
    let Ok(mut sink) = SINK.lock() else { return };
    let index = sink
        .targets
        .iter()
        .position(|target| target.id == id)
        .or_else(|| sink.targets.iter().rposition(|target| target.fallback));
    match index {
        Some(index) => {
            let target = &mut sink.targets[index];
            push(&mut target.queue, entry);
            wake(target);
        }
        None => push(&mut sink.orphans, entry),
    }
}

pub fn debug(message: impl Into<String>) {
    log(LogLevel::Debug, message);
}

pub fn info(message: impl Into<String>) {
    log(LogLevel::Info, message);
}

pub fn warn(message: impl Into<String>) {
    log(LogLevel::Warn, message);
}

pub fn error(message: impl Into<String>) {
    log(LogLevel::Error, message);
}

/// Sends messages to one app's console from any thread, from [`Console::sender`].
#[derive(Clone, Debug)]
pub struct ConsoleSender {
    id: u64,
}

impl ConsoleSender {
    pub fn log(&self, level: LogLevel, message: impl Into<String>) {
        log_to(self.id, level, message.into());
    }

    pub fn debug(&self, message: impl Into<String>) {
        self.log(LogLevel::Debug, message);
    }

    pub fn info(&self, message: impl Into<String>) {
        self.log(LogLevel::Info, message);
    }

    pub fn warn(&self, message: impl Into<String>) {
        self.log(LogLevel::Warn, message);
    }

    pub fn error(&self, message: impl Into<String>) {
        self.log(LogLevel::Error, message);
    }
}

/// Registers an app's proxy for messages, as a target for messages from other threads when `fallback` is set.
/// Returns the id to unregister with.
pub(crate) fn register(proxy: AppProxy, fallback: bool) -> u64 {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let _ = LOCAL.try_with(|local| local.borrow_mut().push(id));
    if let Ok(mut sink) = SINK.lock() {
        let queue = if fallback { std::mem::take(&mut sink.orphans) } else { VecDeque::new() };
        let mut target = Target { id, proxy, queue, waking: false, fallback };
        wake(&mut target);
        sink.targets.push(target);
    }
    id
}

pub(crate) fn unregister(id: u64) {
    if let Ok(mut sink) = SINK.lock() {
        sink.targets.retain(|target| target.id != id);
    }
    let _ = LOCAL.try_with(|local| local.borrow_mut().retain(|&local| local != id));
}

/// Colors for the console overlay. The defaults are Core's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConsoleColors {
    pub background: Color,
    pub title_bar: Color,
    pub title: Color,
    pub log: Color,
    pub debug: Color,
    pub info: Color,
    pub warn: Color,
    pub error: Color,
}

impl Default for ConsoleColors {
    fn default() -> Self {
        Self {
            background: Color::rgba(26, 26, 26, 178),
            title_bar: Color::rgba(13, 13, 13, 178),
            title: Color::rgb(255, 255, 255),
            log: Color::rgb(255, 255, 255),
            debug: Color::rgb(128, 128, 128),
            info: Color::rgb(0, 255, 255),
            warn: Color::rgb(255, 255, 0),
            error: Color::rgb(255, 0, 0),
        }
    }
}

impl ConsoleColors {
    fn level(&self, level: LogLevel) -> Color {
        match level {
            LogLevel::Debug => self.debug,
            LogLevel::Log => self.log,
            LogLevel::Info => self.info,
            LogLevel::Warn => self.warn,
            LogLevel::Error => self.error,
        }
    }
}

/// The overlay's widgets.
struct Overlay {
    frame: View,
    title: Text,
    body: Code,
}

/// An app's console: its messages and, once shown, the overlay.
pub(crate) struct ConsoleState {
    entries: VecDeque<LogEntry>,
    overlay: Option<Overlay>,
    position: ConsolePosition,
    size: f32,
    colors: ConsoleColors,
}

impl Default for ConsoleState {
    fn default() -> Self {
        Self {
            entries: VecDeque::new(),
            overlay: None,
            position: ConsolePosition::Bottom,
            size: 30.0,
            colors: ConsoleColors::default(),
        }
    }
}

/// An app's debug console, from [`App::console`]: a cheap handle.
///
/// The overlay docks to an edge (the bottom, by default) over everything else, takes 30% of the screen, and follows
/// new messages. While its text has focus, the arrow keys and Page Up/Down scroll, `+` and `-` resize it, Ctrl+P and
/// Ctrl+O move it to the previous or next edge, Ctrl+S saves the messages to a file, and Escape hides it.
#[derive(Clone)]
pub struct Console(pub(crate) App);

impl std::fmt::Debug for Console {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Console").field("visible", &self.is_visible()).finish_non_exhaustive()
    }
}

impl Console {
    fn state<R>(&self, read: impl FnOnce(&mut ConsoleState) -> R) -> R {
        read(&mut self.0.inner().console.borrow_mut())
    }

    /// Adds a message from the UI thread.
    pub fn log(&self, level: LogLevel, message: impl Into<String>) {
        self.append([LogEntry { time: SystemTime::now(), level, message: message.into() }]);
    }

    fn append(&self, entries: impl IntoIterator<Item = LogEntry>) {
        self.state(|state| {
            for entry in entries {
                push(&mut state.entries, entry);
            }
        });
        self.refresh();
    }

    /// A handle for logging to this console from other threads.
    pub fn sender(&self) -> ConsoleSender {
        ConsoleSender { id: self.0.console_id() }
    }

    /// Every message kept, oldest first.
    pub fn entries(&self) -> Vec<LogEntry> {
        self.state(|state| state.entries.iter().cloned().collect())
    }

    /// The messages as the console shows them, one per line.
    pub fn text(&self) -> String {
        self.state(|state| state.entries.iter().map(LogEntry::format).collect::<Vec<_>>().join("\n"))
    }

    pub fn clear(&self) {
        self.state(|state| state.entries.clear());
        self.refresh();
    }

    pub fn is_visible(&self) -> bool {
        self.state(|state| state.overlay.as_ref().is_some_and(|overlay| overlay.frame.is_visible()))
    }

    pub fn show(&self) {
        self.overlay().visible(true);
        self.0.root().add(&self.overlay());
        self.refresh();
    }

    pub fn hide(&self) {
        let frame = self.state(|state| state.overlay.as_ref().map(|overlay| overlay.frame.clone()));
        if let Some(frame) = frame {
            frame.visible(false);
        }
    }

    pub fn toggle(&self) {
        if self.is_visible() { self.hide() } else { self.show() }
    }

    /// Shows the console and gives its text keyboard focus.
    pub fn focus(&self) {
        self.show();
        let body = self.state(|state| state.overlay.as_ref().map(|overlay| overlay.body.clone()));
        if let Some(body) = body {
            body.focus();
        }
    }

    pub fn position(&self, position: ConsolePosition) -> Self {
        self.state(|state| state.position = position);
        self.place();
        self.clone()
    }

    /// The share of the screen the console takes, from 10% to 100%.
    pub fn size_percent(&self, percent: f32) -> Self {
        self.state(|state| state.size = percent.clamp(10.0, 100.0));
        self.place();
        self.clone()
    }

    pub fn colors(&self, colors: ConsoleColors) -> Self {
        self.state(|state| state.colors = colors);
        let overlay = self.state(|state| state.overlay.as_ref().map(|overlay| overlay.frame.clone()));
        if let Some(frame) = overlay {
            frame.bg(colors.background);
        }
        self.refresh();
        self.clone()
    }

    /// Writes the messages to a file.
    pub fn save(&self, path: impl AsRef<std::path::Path>) -> std::io::Result<()> {
        std::fs::write(path, self.text() + "\n")
    }

    /// The overlay, built on first use.
    fn overlay(&self) -> View {
        if let Some(frame) = self.state(|state| state.overlay.as_ref().map(|overlay| overlay.frame.clone())) {
            return frame;
        }
        let app = &self.0;
        let colors = self.state(|state| state.colors);
        let body = Code::new(app).follow(true).grow(1.0);
        let title = Text::new(app, "")
            .fg(colors.title)
            .bg(colors.title_bar)
            .wrap(crate::native::WrapMode::None)
            .truncate(true)
            .height(1)
            .shrink(0.0);
        let frame = View::new(app).absolute().z_index(i32::MAX).bg(colors.background).child(&title).child(&body);
        let console = self.clone();
        frame.on_key(move |cx, key| {
            let (position, size) = console.state(|state| (state.position, state.size));
            if key.matches("escape") {
                console.hide();
            } else if key.matches("+") || key.matches("=") {
                console.size_percent(size + 5.0);
            } else if key.matches("-") {
                console.size_percent(size - 5.0);
            } else if key.matches("ctrl+o") || key.matches("ctrl+p") {
                console.position(position.step(key.matches("ctrl+o")));
            } else if key.matches("ctrl+s") {
                let stamp = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs();
                let path = format!("opentui-console-{stamp}.log");
                match console.save(&path) {
                    Ok(()) => console.log(LogLevel::Info, format!("Saved the console to {path}")),
                    Err(error) => console.log(LogLevel::Error, format!("Could not save the console: {error}")),
                }
            } else {
                return;
            }
            cx.stop_propagation();
        });
        self.state(|state| state.overlay = Some(Overlay { frame: frame.clone(), title, body }));
        self.place();
        frame
    }

    /// Docks the overlay to its edge at its size.
    fn place(&self) {
        let Some((frame, position, size)) = self
            .state(|state| state.overlay.as_ref().map(|overlay| (overlay.frame.clone(), state.position, state.size)))
        else {
            return;
        };
        let (zero, unset, share) = (Length::Cells(0.0), Length::Undefined, Length::percent(size));
        let element = frame.element();
        let horizontal = matches!(position, ConsolePosition::Top | ConsolePosition::Bottom);
        for (edge, docked) in [
            (Edge::Top, position != ConsolePosition::Bottom),
            (Edge::Bottom, position != ConsolePosition::Top),
            (Edge::Left, position != ConsolePosition::Right),
            (Edge::Right, position != ConsolePosition::Left),
        ] {
            element.set_layout(LayoutProperty::Position(edge, if docked { zero } else { unset }));
        }
        element.set_layout(LayoutProperty::Width(if horizontal { Length::Auto } else { share }));
        element.set_layout(LayoutProperty::Height(if horizontal { share } else { Length::Auto }));
    }

    /// Shows the messages in the overlay, if it exists.
    fn refresh(&self) {
        let Some((title, body, colors, count)) = self.state(|state| {
            let overlay = state.overlay.as_ref()?;
            Some((overlay.title.clone(), overlay.body.clone(), state.colors, state.entries.len()))
        }) else {
            return;
        };
        let styled = self.state(|state| {
            let lines = state.entries.iter().enumerate().map(|(index, entry)| {
                let line = if index == 0 { entry.format() } else { format!("\n{}", entry.format()) };
                Span::styled(line, Style::new().fg(colors.level(entry.level)))
            });
            lines.collect()
        });
        body.set_spans(styled);
        title.set_text(format!(" Console ({count})  Esc hide  +/- size  Ctrl+O/P move  Ctrl+S save "));
    }
}

impl App {
    /// The app's debug console. See [the module](crate::console).
    pub fn console(&self) -> Console {
        Console(self.clone())
    }
}

/// Routes the `log` crate's records to the console of the running app, with their target as a prefix.
#[cfg(feature = "log")]
pub struct Logger {
    pub level: ::log::LevelFilter,
}

#[cfg(feature = "log")]
impl ::log::Log for Logger {
    fn enabled(&self, metadata: &::log::Metadata<'_>) -> bool {
        metadata.level() <= self.level
    }

    fn log(&self, record: &::log::Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let level = match record.level() {
            ::log::Level::Error => LogLevel::Error,
            ::log::Level::Warn => LogLevel::Warn,
            ::log::Level::Info => LogLevel::Info,
            ::log::Level::Debug | ::log::Level::Trace => LogLevel::Debug,
        };
        log(level, format!("{}: {}", record.target(), record.args()));
    }

    fn flush(&self) {}
}

/// Installs [`Logger`] as the `log` crate's logger, for records up to `level`.
#[cfg(feature = "log")]
pub fn init_logger(level: ::log::LevelFilter) -> Result<(), ::log::SetLoggerError> {
    ::log::set_boxed_logger(Box::new(Logger { level }))?;
    ::log::set_max_level(level);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, mpsc};

    #[test]
    fn messages_from_other_threads_never_reach_remote_apps() {
        let proxy = AppProxy { shared: Arc::default() };
        let queue = Arc::clone(&proxy.shared);
        let (id_tx, id_rx) = mpsc::channel();
        let (log_tx, log_rx) = mpsc::channel::<()>();
        // A remote app registers on its own thread, as each SSH session's app does.
        let owner = std::thread::spawn(move || {
            let id = register(proxy, false);
            id_tx.send(id).expect("send the id");
            log_rx.recv().expect("wait for the other thread's message");
            log(LogLevel::Info, "from the app's own thread");
        });
        let id = id_rx.recv().expect("the app registered");
        log(LogLevel::Info, "from a thread without an app");
        assert!(queue.take().is_empty(), "a message from another thread reached the remote app");
        log_tx.send(()).expect("let the app's thread log");
        owner.join().expect("the app's thread");
        assert_eq!(queue.take().len(), 1, "the app collects its own thread's message");
        unregister(id);
    }
}
