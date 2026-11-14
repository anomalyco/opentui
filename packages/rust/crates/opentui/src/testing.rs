//! Headless apps for tests: no terminal, a manual clock, and frame snapshots.
//!
//! ```
//! use opentui::prelude::*;
//! use opentui::testing::TestApp;
//!
//! let app = TestApp::new(20, 3);
//! let name = Input::new(&app).placeholder("name");
//! app.root().add(&name);
//! name.focus();
//! app.type_text("Ada");
//! assert_eq!(name.value(), "Ada");
//! assert_eq!(app.render().row(0).trim_end(), "Ada");
//! ```

use crate::app::{App, AppOptions};
use crate::error::Result;
use crate::input::{Event, Input, KeyCode, KeyEvent, Modifiers, MouseButton, MouseEvent, MouseEventKind, Parser};
pub use crate::native::{Capture, Cell};
use std::cell::RefCell;
use std::ops::Deref;
use std::time::{Duration, Instant};

/// An [`App`] without a terminal. It dereferences to the app, so widgets take `&app` as usual.
///
/// Input methods dispatch immediately. [`Self::render`] paints a frame, presents it so hit tests and hover see it,
/// and returns its cells. Native failures panic with the error, which suits tests; use [`Self::try_render`] to
/// inspect them instead. As in Core's test renderer, native code checks each frame that it skips or repaints only
/// in part against a full repaint, and fails the frame on a mismatch; [`Self::set_verify`] turns that check off.
pub struct TestApp {
    app: App,
    parser: RefCell<Parser>,
    /// When [`Self::idle`] last painted, for its frame slots.
    last_frame: std::cell::Cell<Option<Instant>>,
}

/// What [`TestApp::idle`] cost.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Idle {
    /// Frames painted.
    pub frames: u64,
    /// Times the loop woke from its sleep, for a timer or a frame slot.
    pub wakeups: u64,
}

impl Deref for TestApp {
    type Target = App;

    fn deref(&self) -> &App {
        &self.app
    }
}

impl Drop for TestApp {
    fn drop(&mut self) {
        self.app.teardown();
    }
}

impl TestApp {
    /// A `width` by `height` app with default options.
    pub fn new(width: u16, height: u16) -> Self {
        Self::with_options(width, height, AppOptions::default())
    }

    pub fn with_options(width: u16, height: u16, options: AppOptions) -> Self {
        let app = App::manual(width, height, options).unwrap_or_else(|error| panic!("headless app: {error}"));
        let parser = RefCell::new(Parser::new(app.session()));
        let app = Self { app, parser, last_frame: std::cell::Cell::new(None) };
        app.set_verify(true);
        app
    }

    /// A `width` by `height` app whose terminal shows hyperlinks (OSC 8), as most terminals do: widgets take the
    /// paths they take there, such as Markdown that native code writes itself.
    pub fn with_hyperlinks(width: u16, height: u16) -> Self {
        crate::app::HEADLESS_ENVIRONMENT.set(vec![("FORCE_HYPERLINK", "1")]);
        let app = Self::new(width, height);
        crate::app::HEADLESS_ENVIRONMENT.set(Vec::new());
        app
    }

    pub fn app(&self) -> &App {
        &self.app
    }

    fn settle(&self) {
        self.app.drain_proxy();
        self.app.fire_timers();
        self.app.pump_clipboard();
        self.app.drain_deferred();
    }

    /// Dispatches any event, then runs due timers and queued tasks.
    pub fn event(&self, event: Event) {
        self.app.dispatch(event);
        self.settle();
    }

    /// Presses a key named by a shortcut such as `"enter"`, `"ctrl+c"`, or `"shift+tab"`.
    pub fn press(&self, shortcut: &str) {
        let key = KeyEvent::from_shortcut(shortcut).unwrap_or_else(|| panic!("invalid shortcut {shortcut:?}"));
        self.key(key);
    }

    pub fn key(&self, key: KeyEvent) {
        self.event(Event::Key(key));
    }

    /// Types each character as a separate key press.
    pub fn type_text(&self, text: &str) {
        for character in text.chars() {
            let code = match character {
                '\n' | '\r' => KeyCode::Enter,
                '\t' => KeyCode::Tab,
                _ => KeyCode::Char(character),
            };
            self.key(KeyEvent::new(code, Modifiers::NONE));
        }
    }

    /// Delivers a bracketed paste.
    pub fn paste(&self, text: &str) {
        self.event(Event::Paste(text.to_owned()));
    }

    /// Parses raw terminal bytes, as if typed, and dispatches the events. A partial sequence at the end times out as
    /// it would in a terminal: a lone Escape counts as the Escape key.
    pub fn feed(&self, bytes: &[u8]) {
        let mut inputs = Vec::new();
        {
            let mut parser = self.parser.borrow_mut();
            parser
                .feed(bytes, self.app.now(), &mut inputs)
                // The app's clock stands still, so expire at the deadline, as Core's timer does.
                .and_then(|()| parser.deadline().map_or(Ok(()), |deadline| parser.expire(deadline, &mut inputs)))
                .unwrap_or_else(|error| panic!("parse input: {error}"));
        }
        for input in inputs {
            if let Input::Event(event) = input {
                self.event(event);
            }
        }
    }

    pub fn mouse(&self, kind: MouseEventKind, x: u16, y: u16) {
        self.event(Event::Mouse(MouseEvent { kind, x, y, modifiers: Modifiers::NONE }));
    }

    /// A left press and release at a cell. Hit testing uses the last rendered frame.
    pub fn click(&self, x: u16, y: u16) {
        self.mouse(MouseEventKind::Down(MouseButton::Left), x, y);
        self.mouse(MouseEventKind::Up(MouseButton::Left), x, y);
    }

    /// A left-button drag from one cell to another, one cell per step along each axis.
    pub fn drag(&self, from: (u16, u16), to: (u16, u16)) {
        self.mouse(MouseEventKind::Down(MouseButton::Left), from.0, from.1);
        let steps = from.0.abs_diff(to.0).max(from.1.abs_diff(to.1)).max(1);
        for step in 1..=steps {
            let along = |a: u16, b: u16| {
                (f64::from(a) + (f64::from(b) - f64::from(a)) * f64::from(step) / f64::from(steps)).round() as u16
            };
            self.mouse(MouseEventKind::Drag(MouseButton::Left), along(from.0, to.0), along(from.1, to.1));
        }
        self.mouse(MouseEventKind::Up(MouseButton::Left), to.0, to.1);
    }

    /// One wheel step at a cell.
    pub fn scroll(&self, x: u16, y: u16, down: bool) {
        self.mouse(if down { MouseEventKind::ScrollDown } else { MouseEventKind::ScrollUp }, x, y);
    }

    /// Moves the pointer without a pressed button.
    pub fn hover(&self, x: u16, y: u16) {
        self.mouse(MouseEventKind::Moved, x, y);
    }

    /// Resizes the terminal, as a window resize does.
    pub fn resize(&self, width: u16, height: u16) {
        self.app.set_size(width, height).unwrap_or_else(|error| panic!("resize: {error}"));
        self.settle();
    }

    /// Advances the manual clock, running timers and queued tasks as they come due on the way: an interval runs once
    /// for every tick it passes, as it would in real time.
    pub fn advance(&self, by: Duration) {
        let target = self.app.now() + by;
        self.settle();
        while let Some(due) = self.app.next_timer().filter(|&due| due > self.app.now() && due <= target) {
            self.app.advance_clock(due - self.app.now());
            self.settle();
        }
        self.app.advance_clock(target.saturating_duration_since(self.app.now()));
        self.settle();
    }

    /// Runs the event loop with no input for `by` on the manual clock, as [`App::run`] does: it sleeps until the next
    /// timer or, while a frame is wanted, the next frame slot at [`AppOptions::max_fps`], and paints. Returns what an
    /// animation costs an idle app: the frames painted and the times the loop woke.
    pub fn idle(&self, by: Duration) -> Idle {
        let end = self.app.now() + by;
        let mut idle = Idle::default();
        loop {
            self.settle();
            let now = self.app.now();
            let slot = |last: Option<Instant>| last.map_or(now, |last| (last + self.app.frame_interval()).max(now));
            if self.needs_frame() && slot(self.last_frame.get()) == now {
                self.present().unwrap_or_else(|error| panic!("idle frame: {error}"));
                self.last_frame.set(Some(now));
                idle.frames += 1;
            }
            let frame = self.needs_frame().then(|| slot(self.last_frame.get()));
            let next = self.app.next_timer().into_iter().chain(frame).min().filter(|&next| next <= end);
            self.app.advance_clock(next.unwrap_or(end).saturating_duration_since(now));
            if next.is_none() {
                return idle;
            }
            idle.wakeups += 1;
        }
    }

    /// Runs queued tasks from other threads until `condition` holds or `timeout` passes, in real time. Returns
    /// whether the condition held. For work that finishes on other threads, such as `App::spawn` tasks.
    pub fn wait_until(&self, timeout: Duration, mut condition: impl FnMut() -> bool) -> bool {
        // A timeout too long to represent never passes.
        let deadline = std::time::Instant::now().checked_add(timeout);
        loop {
            self.settle();
            if condition() {
                return true;
            }
            if deadline.is_some_and(|deadline| std::time::Instant::now() >= deadline) {
                return false;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    /// Whether a widget changed, or an animation runs, since the last frame.
    pub fn needs_frame(&self) -> bool {
        self.app.needs_frame()
    }

    /// Paints and presents a frame and returns its cells.
    pub fn render(&self) -> Capture {
        self.try_render().unwrap_or_else(|error| panic!("render: {error}"))
    }

    pub fn try_render(&self) -> Result<Capture> {
        self.settle();
        Ok(self.app.present_headless(true)?.expect("a requested capture"))
    }

    /// Paints and presents a frame without copying its cells, for timing the real frame path.
    pub fn present(&self) -> Result<()> {
        self.settle();
        self.app.present_headless(false).map(drop)
    }

    /// Turns the check of skipped and partly repainted frames off, or back on; it starts on. The check repaints such
    /// a frame in full into a scratch buffer, which an app never does, so it makes a still frame half again as slow.
    /// Timing probes turn it off. Cells and work counts are the same either way.
    pub fn set_verify(&self, verify: bool) {
        let flags = if verify { crate::sys::OT_SCENE_DEBUG_VERIFY } else { 0 };
        self.app.session().set_debug_flags(flags).unwrap_or_else(|error| panic!("set_verify: {error}"));
    }

    /// The text of a freshly rendered frame, one line per row, without trailing spaces.
    pub fn text(&self) -> String {
        self.render().text()
    }
}
