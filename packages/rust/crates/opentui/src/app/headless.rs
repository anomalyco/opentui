//! Headless apps: [`App::headless`] and its frame and write handlers.

use super::{App, Cx, HandlerId};
use crate::error::{Error, Result};
use crate::native::Capture;
use crate::widget::Callbacks;
use std::cell::{Cell, RefCell};
use std::time::Instant;

/// How [`App::headless`] sets up an app without a terminal that runs in real time: each frame's cells, and what it
/// would write to the terminal, go to handlers instead. A test harness or a remote driver runs it, as OpenCode's
/// `OPENCODE_DRIVE` endpoint does.
///
/// ```
/// use opentui::app::{HeadlessOptions, HeadlessWrite};
/// use opentui::prelude::*;
/// use std::time::Duration;
///
/// let app = App::headless(HeadlessOptions { width: 20, height: 2, ..HeadlessOptions::default() })?;
/// app.root().add(&Text::new(&app, "hello"));
/// app.on_headless_write(|_cx, write| {
///     if let HeadlessWrite::Clipboard(text) = write {
///         println!("copied {text}");
///     }
/// });
/// app.on_headless_frame(|_cx, frame| println!("{}", frame.row(0).trim_end()));
/// // Another thread drives the running app through its proxy, as a driver answering requests does.
/// let proxy = app.proxy();
/// std::thread::spawn(move || {
///     std::thread::sleep(Duration::from_millis(10));
///     let _ = proxy.post(|cx| {
///         let frame = cx.capture().expect("a frame");
///         cx.copy_to_clipboard(frame.row(0).trim_end());
///         cx.quit();
///     });
/// });
/// app.run()
/// # ; Ok::<(), opentui::Error>(())
/// ```
#[derive(Clone, Debug)]
#[must_use]
pub struct HeadlessOptions {
    /// The screen size in cells. Zero counts as one.
    pub width: u16,
    pub height: u16,
    /// Everything else, as for [`App::new`]. With no terminal to ask, [`AppOptions::theme`](super::AppOptions::theme)
    /// is always used and [`AppOptions::palette_size`](super::AppOptions::palette_size) gets no answer.
    pub app: super::AppOptions,
}

impl Default for HeadlessOptions {
    /// 100 by 40 cells, the size OpenCode's drive mode uses, with default app options.
    fn default() -> Self {
        Self { width: 100, height: 40, app: super::AppOptions::default() }
    }
}

/// What a running headless app would have written to a terminal, for [`App::on_headless_write`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HeadlessWrite {
    /// [`App::copy_to_clipboard`] text.
    Clipboard(String),
    /// An [`App::notify`] desktop notification.
    Notification { message: String, title: Option<String> },
    /// The window title: [`AppOptions::title`](super::AppOptions::title) when the app starts, then each
    /// [`App::set_title`].
    Title(String),
}

#[derive(Default)]
pub(super) struct HeadlessState {
    running: Cell<bool>,
    writes: Callbacks<HeadlessWrite>,
    frames: Callbacks<Capture>,
    last: RefCell<Option<Capture>>,
}

impl HeadlessState {
    pub(super) fn remove(&self, id: HandlerId) -> bool {
        self.writes.remove(id) || self.frames.remove(id)
    }

    pub(super) fn clear(&self) {
        self.writes.clear();
        self.frames.clear();
    }
}

impl App {
    /// Whether the app came from [`Self::headless`].
    pub fn is_headless(&self) -> bool {
        self.0.headless.get().is_some()
    }

    fn headless_state(&self) -> Result<&HeadlessState> {
        self.0.headless.get().ok_or(Error::Usage("the app is not headless"))
    }

    /// Calls `handler` with each write a running [headless](Self::headless) app would have sent to its terminal. A
    /// headless app that is not running drops them, as an app does before its terminal is set up.
    pub fn on_headless_write(&self, handler: impl FnMut(&mut Cx<'_>, &HeadlessWrite) + 'static) -> HandlerId {
        self.headless_state().map_or_else(|_| HandlerId::next(), |state| state.writes.add(handler))
    }

    /// Calls `handler` with the cells of each frame a [headless](Self::headless) app presents, from its event loop or
    /// from [`Self::capture`].
    pub fn on_headless_frame(&self, handler: impl FnMut(&mut Cx<'_>, &Capture) + 'static) -> HandlerId {
        self.headless_state().map_or_else(|_| HandlerId::next(), |state| state.frames.add(handler))
    }

    /// The cells of the last frame a [headless](Self::headless) app presented, or `None` before the first frame and
    /// for an app on a terminal.
    pub fn last_frame(&self) -> Option<Capture> {
        self.0.headless.get()?.last.borrow().clone()
    }

    /// Paints and presents a frame now, as Core's `renderOnce` does, and returns its cells. Runs timers and tasks
    /// that are due first. Only for a [headless](Self::headless) app.
    pub fn capture(&self) -> Result<Capture> {
        self.headless_state()?;
        self.fire_timers();
        self.drain_deferred();
        self.headless_frame()
    }

    /// Resizes a [headless](Self::headless) app's screen, as a terminal window resize does: resize handlers run and
    /// the next frame lays out at the new size. Zero counts as one.
    pub fn resize(&self, width: u16, height: u16) -> Result<()> {
        self.headless_state()?;
        self.set_size(width.max(1), height.max(1))
    }

    /// Hands a terminal write to the headless handlers. Returns whether the app runs headless, so the write went
    /// somewhere.
    pub(super) fn headless_write(&self, write: HeadlessWrite) -> bool {
        let Some(state) = self.0.headless.get().filter(|state| state.running.get()) else { return false };
        state.writes.emit(&mut Cx::new(self), &write);
        true
    }

    fn headless_frame(&self) -> Result<Capture> {
        let state = self.headless_state()?;
        let capture = self.present_headless(true)?.expect("a requested capture");
        *state.last.borrow_mut() = Some(capture.clone());
        state.frames.emit(&mut Cx::new(self), &capture);
        self.drain_deferred();
        self.check()?;
        Ok(capture)
    }

    /// [`Self::run`] for a headless app: the terminal loop on the real clock, with proxy wakeups as its only input.
    pub(super) fn run_headless(self) -> Result<()> {
        let result = self.headless_loop();
        if let Some(state) = self.0.headless.get() {
            state.running.set(false);
        }
        self.0.proxy.close();
        self.teardown();
        result
    }

    fn headless_loop(&self) -> Result<()> {
        let wake = crate::term::WakePipe::new()?;
        self.0.proxy.set_waker(Some(wake.waker()));
        self.headless_state()?.running.set(true);
        let title = self.0.title.borrow().clone();
        if let Some(title) = title {
            self.headless_write(HeadlessWrite::Title(title));
        }
        self.request_redraw();
        let interval = self.frame_interval();
        let mut last_frame: Option<Instant> = None;
        loop {
            self.drain_proxy();
            self.fire_timers();
            self.check()?;
            if self.0.quit.get() {
                return Ok(());
            }
            // No terminal to give back: a release task already ran deferred, and there is nothing to suspend.
            self.0.suspend.set(false);
            let now = Instant::now();
            let mut deadline = self.next_timer();
            if self.wants_frame() {
                let earliest = last_frame.map_or(now, |last| last + interval);
                if now >= earliest {
                    self.headless_frame()?;
                    last_frame = Some(now);
                    // The frame, and the tasks it deferred, can arm timers or quit.
                    deadline = self.next_timer();
                    if self.ends_turn() {
                        continue;
                    }
                }
                if self.wants_frame() {
                    let retry = last_frame.map_or(now, |last| last + interval).max(now);
                    deadline = Some(deadline.map_or(retry, |deadline| deadline.min(retry)));
                }
            }
            let timeout = deadline.map(|deadline| deadline.saturating_duration_since(Instant::now()));
            crate::term::wait_wakes([&wake], timeout)?;
            wake.drain();
        }
    }
}
