//! The shared animation clock, Core's `renderer.onAnimationTick` (#1803). Due index `i` of a subscriber at `fps` is
//! at `i * 1000 / fps` ms from the app clock's start, so equal rates tick together. One app timer wakes the loop at
//! the earliest due time: the fastest rate's own, slower rates' at the end of their window, so they share its frames.
//! Every frame, whatever caused it, first runs each tick due within its window. A subscriber bound to a widget ticks
//! only while the widget is drawn, as Core's `Renderable.animationFps` does.

use super::{App, AppInner, Cx, HandlerId, TimerId};
use std::cell::RefCell;
use std::rc::{Rc, Weak};
use std::time::Duration;

/// Half an interval, in ms × fps: a tick runs on any frame from this far before its due time. Core widens it above
/// 500 fps to 1 ms × fps because its timers can fire 1 ms early; these fire on time.
const WINDOW: f64 = 500.0;

/// One call of an animation tick callback.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tick {
    /// Time since this subscriber's previous tick, or since it subscribed or resumed.
    pub elapsed: Duration,
    /// The due times this tick covers: 1, or more after a late frame. Animations advance by this count.
    pub ticks: u64,
}

type TickCallback = Rc<RefCell<dyn FnMut(&mut Cx<'_>, Tick)>>;

struct Ticker {
    id: HandlerId,
    fps: f64,
    /// The next due index.
    next: u64,
    /// The time of the last tick, in ms.
    last: f64,
    callback: TickCallback,
    /// The widget whose drawing gates the ticks, and the last frame that drew it.
    widget: Option<u32>,
    drawn: u64,
    /// Not drawn at a due time: out of the timer until the widget's next draw.
    parked: bool,
}

/// The subscribers, allocated on the first subscription and freed with the last.
#[derive(Default)]
pub(super) struct Ticks {
    tickers: Vec<Ticker>,
    timer: Option<TimerId>,
}

/// An animation on the shared clock, from [`App::on_animation_tick`] or
/// [`Widget::on_animation_tick`](crate::widget::Widget::on_animation_tick). Dropping it ends the animation; when it
/// was the last, the app stops waking for ticks.
#[must_use = "dropping the handle ends the animation"]
pub struct AnimationTick {
    app: Weak<AppInner>,
    id: HandlerId,
}

impl std::fmt::Debug for AnimationTick {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_tuple("AnimationTick").field(&self.id).finish()
    }
}

impl Drop for AnimationTick {
    fn drop(&mut self) {
        if let Some(inner) = self.app.upgrade() {
            App::from_inner(inner).end_ticks(|ticker| ticker.id == self.id);
        }
    }
}

impl AnimationTick {
    /// A handle for an app that has ended: it ticks never.
    pub(crate) fn ended() -> Self {
        Self { app: Weak::new(), id: HandlerId::next() }
    }
}

/// The last due index a frame at `time` reaches. A subscriber starts from the next one, so it never ticks in the
/// frame it joins.
fn reach(time: f64, fps: f64) -> u64 {
    ((time * fps + WINDOW) / 1000.0).floor() as u64
}

impl App {
    /// Calls `callback` `fps` times a second on a clock that all animations share, until the handle drops. Equal
    /// rates tick in the same frames, and slower rates tick in the fastest rate's frames, so several animations cost
    /// the frames of the fastest. A frame late for a due time covers it: [`Tick::ticks`] counts the due times. The
    /// callback runs before the frame paints, and a redraw it requests is that frame. With nothing subscribed the
    /// app sets no timer. [`Self::animate`] instead runs work on every frame: use it for rates at or above
    /// [`AppOptions::max_fps`](super::AppOptions::max_fps), which a tick timer would wake for about twice a frame.
    ///
    /// Panics unless `fps` is positive and finite.
    pub fn on_animation_tick(&self, fps: f64, callback: impl FnMut(&mut Cx<'_>, Tick) + 'static) -> AnimationTick {
        self.subscribe_tick(fps, None, callback)
    }

    pub(crate) fn subscribe_tick(
        &self,
        fps: f64,
        widget: Option<u32>,
        callback: impl FnMut(&mut Cx<'_>, Tick) + 'static,
    ) -> AnimationTick {
        assert!(fps > 0.0 && fps.is_finite(), "fps must be positive and finite, got {fps}");
        let time = self.tick_time();
        let id = HandlerId::next();
        let ticker = Ticker {
            id,
            fps,
            next: reach(time, fps) + 1,
            last: time,
            callback: Rc::new(RefCell::new(callback)),
            widget,
            // Subscribed while painting, the widget counts as drawn by this frame.
            drawn: self.0.frame.get(),
            parked: false,
        };
        self.0.animations.borrow_mut().ticks.get_or_insert_default().tickers.push(ticker);
        self.schedule_ticks();
        AnimationTick { app: Rc::downgrade(&self.0), id }
    }

    /// Ends the subscribers bound to a widget that drops.
    pub(crate) fn end_widget_ticks(&self, widget: u32) {
        self.end_ticks(|ticker| ticker.widget == Some(widget));
    }

    /// Ends the subscribers `ended` selects. They drop after the borrow: their callbacks may own other handles.
    fn end_ticks(&self, ended: impl FnMut(&mut Ticker) -> bool) {
        let removed: Vec<Ticker> = {
            let Ok(mut animations) = self.0.animations.try_borrow_mut() else { return };
            let Some(ticks) = animations.ticks.as_mut() else { return };
            ticks.tickers.extract_if(.., ended).collect()
        };
        if !removed.is_empty() {
            self.schedule_ticks();
        }
    }

    fn tick_time(&self) -> f64 {
        self.now().saturating_duration_since(self.0.clock.start()).as_secs_f64() * 1000.0
    }

    /// Arms one app timer at the earliest due time of the subscribers not parked, or frees the table when none is
    /// left.
    fn schedule_ticks(&self) {
        let (old, due) = {
            let mut animations = self.0.animations.borrow_mut();
            let Some(ticks) = animations.ticks.as_mut() else { return };
            let old = ticks.timer.take();
            let active = || ticks.tickers.iter().filter(|ticker| !ticker.parked);
            let fastest = active().map(|ticker| ticker.fps).fold(0.0, f64::max);
            let due = active()
                .map(|ticker| {
                    let late = if ticker.fps == fastest { 0.0 } else { WINDOW };
                    (ticker.next as f64 * 1000.0 + late) / ticker.fps
                })
                .fold(f64::INFINITY, f64::min);
            if ticks.tickers.is_empty() {
                animations.ticks = None;
            }
            (old, due)
        };
        if let Some(old) = old {
            self.cancel_timer(old);
        }
        if due == f64::INFINITY {
            return;
        }
        let delay = Duration::from_secs_f64((due - self.tick_time()).max(0.0) / 1000.0);
        let timer = self.set_timeout(delay, |cx| {
            if let Some(ticks) = cx.0.animations.borrow_mut().ticks.as_mut() {
                ticks.timer = None;
            }
            cx.request_redraw();
        });
        if let Some(ticks) = self.0.animations.borrow_mut().ticks.as_mut() {
            ticks.timer = Some(timer);
        }
    }

    /// Runs every tick due by this frame, before it paints, then re-arms the timer. A subscriber that joins during
    /// the pass waits for its first due time; one that ends during it does not run.
    pub(super) fn run_ticks(&self) {
        let ids: Vec<HandlerId> = match self.0.animations.borrow().ticks.as_ref() {
            Some(ticks) => ticks.tickers.iter().map(|ticker| ticker.id).collect(),
            None => return,
        };
        let (time, painted) = (self.tick_time(), self.0.frame.get());
        for id in ids {
            let due = {
                let mut animations = self.0.animations.borrow_mut();
                let ticker = animations.ticks.as_mut().and_then(|ticks| ticks.tickers.iter_mut().find(|t| t.id == id));
                ticker.and_then(|ticker| ticker.due(time, painted))
            };
            if let Some((callback, tick)) = due
                && let Ok(mut callback) = callback.try_borrow_mut()
            {
                callback(&mut Cx::new(self), tick);
            }
        }
        self.schedule_ticks();
    }

    /// A frame drew `widget`: its subscribers count the frame, and parked ones resume from their next due time.
    pub(super) fn mark_drawn(&self, widget: u32) {
        let resumed = {
            let mut animations = self.0.animations.borrow_mut();
            let Some(ticks) = animations.ticks.as_mut() else { return };
            let mut resumed = false;
            for ticker in ticks.tickers.iter_mut().filter(|ticker| ticker.widget == Some(widget)) {
                ticker.drawn = self.0.frame.get();
                if ticker.parked {
                    let time = self.tick_time();
                    ticker.parked = false;
                    ticker.next = reach(time, ticker.fps) + 1;
                    ticker.last = time;
                    resumed = true;
                }
            }
            resumed
        };
        if resumed {
            self.schedule_ticks();
        }
    }
}

impl Ticker {
    /// The callback and its tick when one is due at `time`, after `painted` frames. A widget the last frame did not
    /// draw parks instead.
    fn due(&mut self, time: f64, painted: u64) -> Option<(TickCallback, Tick)> {
        let reach = reach(time, self.fps);
        if self.parked || reach < self.next {
            return None;
        }
        if self.widget.is_some() && self.drawn < painted {
            self.parked = true;
            return None;
        }
        let tick = Tick {
            elapsed: Duration::from_secs_f64((time - self.last).max(0.0) / 1000.0),
            ticks: reach + 1 - self.next,
        };
        self.next = reach + 1;
        self.last = time;
        Some((Rc::clone(&self.callback), tick))
    }
}
