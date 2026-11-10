//! Animation timelines: values that move over time, with easing, delays, loops, and callbacks.
//!
//! A [`Timeline`] plays [`Tween`]s, callbacks, and other timelines at positions along it. A tween moves a value
//! between two ends over its duration, shaped by an [`Easing`], and hands each new value to its update handler,
//! which changes your widgets. Timelines advance before every frame through [`App::animate`]: they follow the app's
//! clock (the manual one in [`TestApp`](crate::testing::TestApp)), keep frames coming while they play, and stop
//! requesting frames once they pause or finish.
//!
//! ```no_run
//! use opentui::prelude::*;
//! use std::time::Duration;
//!
//! fn main() -> opentui::Result<()> {
//!     let app = App::new(AppOptions::default())?;
//!     let theme = app.theme();
//!     let title = Text::new(&app, "Hello");
//!     let card = View::new(&app).border(BorderStyle::Rounded).padding_x(1).child(&title);
//!     app.root().add(&card);
//!     // Fade the card in, then pulse the title between two colors until the app ends.
//!     Timeline::new(&app)
//!         .add(
//!             Duration::ZERO,
//!             Tween::new(0.0, 1.0).duration(Duration::from_millis(400)).ease(Easing::OutQuad).on_update(
//!                 move |_cx, opacity| {
//!                     card.opacity(opacity as f32);
//!                 },
//!             ),
//!         )
//!         .add(
//!             Duration::from_millis(400),
//!             Tween::new(theme.foreground, theme.accent)
//!                 .duration(Duration::from_millis(900))
//!                 .ease(Easing::InOutSine)
//!                 .alternate(true)
//!                 .forever()
//!                 .on_update(move |_cx, color| {
//!                     title.fg(color);
//!                 }),
//!         );
//!     app.on_key(|cx, key| {
//!         if key.matches("q") {
//!             cx.quit();
//!         }
//!     });
//!     app.run()
//! }
//! ```
//!
//! This is a port of OpenTUI Core's `Timeline`. Core animates numeric properties of JavaScript objects by name;
//! here a tween owns its two ends and reports values through [`Tween::on_update`].

use crate::app::{App, AppInner, Cx};
use crate::style::Color;
use crate::widget::Callbacks;
use std::cell::{Cell, RefCell};
use std::f64::consts::PI;
use std::fmt;
use std::rc::{Rc, Weak};
use std::time::Duration;

/// How a tween's progress through its duration maps to the share of the way between its ends: Core's easing
/// functions. `In` easings start slowly, `Out` easings end slowly, and `InOut` easings do both.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Easing {
    /// Constant speed.
    #[default]
    Linear,
    /// Quadratic: `t²`.
    InQuad,
    /// Quadratic, decelerating.
    OutQuad,
    /// Quadratic at both ends.
    InOutQuad,
    /// Exponential: almost still, then fast.
    InExpo,
    /// Exponential: fast, then almost still.
    OutExpo,
    /// A half sine wave: gentle at both ends.
    InOutSine,
    /// Bounces off the start before leaving it.
    InBounce,
    /// Bounces when it reaches the end, like a dropped ball.
    OutBounce,
    /// Overshoots the end and settles with a damped spring.
    OutElastic,
    /// A quarter circle, slow start.
    InCirc,
    /// A quarter circle, slow end.
    OutCirc,
    /// Circular at both ends.
    InOutCirc,
    /// Backs away from the end before moving toward it.
    InBack,
    /// Overshoots the end, then comes back.
    OutBack,
    /// Backs away at the start and overshoots at the end.
    InOutBack,
}

/// Core's overshoot for the back easings.
const BACK: f64 = 1.70158;

impl Easing {
    /// Every easing, in declaration order.
    pub const ALL: [Self; 16] = [
        Self::Linear,
        Self::InQuad,
        Self::OutQuad,
        Self::InOutQuad,
        Self::InExpo,
        Self::OutExpo,
        Self::InOutSine,
        Self::InBounce,
        Self::OutBounce,
        Self::OutElastic,
        Self::InCirc,
        Self::OutCirc,
        Self::InOutCirc,
        Self::InBack,
        Self::OutBack,
        Self::InOutBack,
    ];

    /// The eased share at progress `t`, which is clamped to 0 through 1. Returns exactly 0 at 0 and 1 at 1; in
    /// between, the back and elastic easings leave that range.
    pub fn apply(self, t: f64) -> f64 {
        if t.is_nan() || t <= 0.0 {
            return 0.0;
        }
        if t >= 1.0 {
            return 1.0;
        }
        match self {
            Self::Linear => t,
            Self::InQuad => t * t,
            Self::OutQuad => t * (2.0 - t),
            Self::InOutQuad => {
                if t < 0.5 {
                    2.0 * t * t
                } else {
                    -1.0 + (4.0 - 2.0 * t) * t
                }
            }
            Self::InExpo => 2f64.powf(10.0 * (t - 1.0)),
            Self::OutExpo => 1.0 - 2f64.powf(-10.0 * t),
            Self::InOutSine => -((PI * t).cos() - 1.0) / 2.0,
            Self::InBounce => 1.0 - bounce(1.0 - t),
            Self::OutBounce => bounce(t),
            Self::OutElastic => 2f64.powf(-10.0 * t) * ((t * 10.0 - 0.75) * (2.0 * PI / 3.0)).sin() + 1.0,
            Self::InCirc => 1.0 - (1.0 - t * t).sqrt(),
            Self::OutCirc => (1.0 - (t - 1.0) * (t - 1.0)).sqrt(),
            Self::InOutCirc => {
                let t = t * 2.0;
                if t < 1.0 {
                    -0.5 * ((1.0 - t * t).sqrt() - 1.0)
                } else {
                    let t = t - 2.0;
                    0.5 * ((1.0 - t * t).sqrt() + 1.0)
                }
            }
            Self::InBack => t * t * ((BACK + 1.0) * t - BACK),
            Self::OutBack => {
                let t = t - 1.0;
                t * t * ((BACK + 1.0) * t + BACK) + 1.0
            }
            Self::InOutBack => {
                let s = BACK * 1.525;
                let t = t * 2.0;
                if t < 1.0 {
                    0.5 * (t * t * ((s + 1.0) * t - s))
                } else {
                    let t = t - 2.0;
                    0.5 * (t * t * ((s + 1.0) * t + s) + 2.0)
                }
            }
        }
    }
}

fn bounce(t: f64) -> f64 {
    const N1: f64 = 7.5625;
    const D1: f64 = 2.75;
    if t < 1.0 / D1 {
        N1 * t * t
    } else if t < 2.0 / D1 {
        let t = t - 1.5 / D1;
        N1 * t * t + 0.75
    } else if t < 2.5 / D1 {
        let t = t - 2.25 / D1;
        N1 * t * t + 0.9375
    } else {
        let t = t - 2.625 / D1;
        N1 * t * t + 0.984375
    }
}

/// A value a [`Tween`] can move between two ends. Implemented for `f64`, `f32`, and [`Color`]; implement it for
/// your own types to tween them.
pub trait Interpolate: Clone {
    /// The value `t` of the way from `self` to `to`: `self` at 0 and `to` at 1. Eased `t` can fall outside 0
    /// through 1.
    fn interpolate(&self, to: &Self, t: f64) -> Self;
}

impl Interpolate for f64 {
    fn interpolate(&self, to: &Self, t: f64) -> Self {
        if t == 1.0 { *to } else { self + (to - self) * t }
    }
}

impl Interpolate for f32 {
    fn interpolate(&self, to: &Self, t: f64) -> Self {
        f64::from(*self).interpolate(&f64::from(*to), t) as f32
    }
}

impl Interpolate for Color {
    /// Mixes the RGBA snapshots, so colors in between are RGB. The ends keep their own intent, such as a palette
    /// slot or the terminal default.
    fn interpolate(&self, to: &Self, t: f64) -> Self {
        if t == 0.0 {
            return *self;
        }
        if t == 1.0 {
            return *to;
        }
        let mix = |from: u8, to: u8| f64::from(from).interpolate(&f64::from(to), t).round().clamp(0.0, 255.0) as u8;
        Color::rgba(mix(self.r, to.r), mix(self.g, to.g), mix(self.b, to.b), mix(self.a, to.a))
    }
}

/// Converts to whole nanoseconds, saturating at about 584 years.
fn nanos(duration: Duration) -> u64 {
    u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX)
}

#[derive(Clone, Copy, Debug)]
struct Timing {
    duration: u64,
    easing: Easing,
    /// Runs in all, at least 1; `None` repeats forever.
    loops: Option<u64>,
    loop_delay: u64,
    alternate: bool,
}

impl Timing {
    /// From the start to the end of the last run. The delay after the last run does not count.
    fn length(&self) -> u64 {
        match self.loops {
            _ if self.duration == 0 => 0,
            None => u64::MAX,
            Some(loops) => {
                self.duration.saturating_mul(loops).saturating_add(self.loop_delay.saturating_mul(loops - 1))
            }
        }
    }
}

type Handler = Box<dyn FnMut(&mut Cx<'_>)>;
type UpdateHandler<T> = Box<dyn FnMut(&mut Cx<'_>, T)>;

struct TweenTrack<T> {
    from: Option<T>,
    read_from: Option<Box<dyn FnOnce() -> T>>,
    to: T,
    on_start: Option<Handler>,
    on_update: Option<UpdateHandler<T>>,
    on_loop: Option<Handler>,
    on_complete: Option<Handler>,
}

impl<T> TweenTrack<T> {
    fn capture(&mut self) {
        if let Some(read) = self.read_from.take() {
            self.from = Some(read());
        }
    }
}

/// A tween's value and handlers, behind the timeline's type-erased items.
trait Track {
    fn begin(&mut self, cx: &mut Cx<'_>, notify: bool);
    fn update(&mut self, cx: &mut Cx<'_>, t: f64);
    fn looped(&mut self, cx: &mut Cx<'_>);
    fn complete(&mut self, cx: &mut Cx<'_>);
}

impl<T: Interpolate> Track for TweenTrack<T> {
    fn begin(&mut self, cx: &mut Cx<'_>, notify: bool) {
        self.capture();
        if notify && let Some(handler) = &mut self.on_start {
            handler(cx);
        }
    }

    fn update(&mut self, cx: &mut Cx<'_>, t: f64) {
        self.capture();
        let value = match &self.from {
            Some(from) => from.interpolate(&self.to, t),
            None => self.to.clone(),
        };
        if let Some(handler) = &mut self.on_update {
            handler(cx, value);
        }
    }

    fn looped(&mut self, cx: &mut Cx<'_>) {
        if let Some(handler) = &mut self.on_loop {
            handler(cx);
        }
    }

    fn complete(&mut self, cx: &mut Cx<'_>) {
        if let Some(handler) = &mut self.on_complete {
            handler(cx);
        }
    }
}

/// A value moving from one end to the other, for [`Timeline::add`] and [`Timeline::once`].
///
/// A tween lasts one second unless [`Self::duration`] says otherwise, eases linearly, and runs once. Its update
/// handler gets the value on every frame while it runs, including the exact end value when it finishes. Before
/// its start position and after it completes, the tween leaves the value alone.
///
/// ```no_run
/// # use opentui::prelude::*;
/// # use std::time::Duration;
/// # let app = App::new(AppOptions::default())?;
/// let level = Slider::new(&app).range(0.0, 100.0);
/// let fill = Tween::new(0.0, 100.0)
///     .duration(Duration::from_millis(600))
///     .ease(Easing::OutBounce)
///     .on_update(move |_cx, value| {
///         level.set_value(value);
///     });
/// Timeline::new(&app).add(Duration::ZERO, fill);
/// # Ok::<(), opentui::Error>(())
/// ```
#[must_use = "a tween does nothing until a timeline plays it"]
pub struct Tween<T = f64> {
    timing: Timing,
    track: TweenTrack<T>,
}

impl<T: fmt::Debug> fmt::Debug for Tween<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Tween")
            .field("from", &self.track.from)
            .field("to", &self.track.to)
            .field("duration", &Duration::from_nanos(self.timing.duration))
            .field("easing", &self.timing.easing)
            .field("loops", &self.timing.loops)
            .field("loop_delay", &Duration::from_nanos(self.timing.loop_delay))
            .field("alternate", &self.timing.alternate)
            .finish_non_exhaustive()
    }
}

impl<T: Interpolate + 'static> Tween<T> {
    /// Moves from `from` to `to`.
    pub fn new(from: T, to: T) -> Self {
        Self::with_start(Some(from), None, to)
    }

    /// Moves to `to` from whatever `current` returns when the tween starts, such as a widget's present value. The
    /// start is read once: later loops and restarts begin from the same value, as in Core.
    pub fn from_current(current: impl FnOnce() -> T + 'static, to: T) -> Self {
        Self::with_start(None, Some(Box::new(current)), to)
    }

    fn with_start(from: Option<T>, read_from: Option<Box<dyn FnOnce() -> T>>, to: T) -> Self {
        Self {
            timing: Timing {
                duration: nanos(Duration::from_secs(1)),
                easing: Easing::Linear,
                loops: Some(1),
                loop_delay: 0,
                alternate: false,
            },
            track: TweenTrack {
                from,
                read_from,
                to,
                on_start: None,
                on_update: None,
                on_loop: None,
                on_complete: None,
            },
        }
    }

    /// How long one run takes. A zero duration jumps to the end value when the tween starts.
    pub fn duration(mut self, duration: Duration) -> Self {
        self.timing.duration = nanos(duration);
        self
    }

    /// Shapes the motion. Linear by default.
    pub fn ease(mut self, easing: Easing) -> Self {
        self.timing.easing = easing;
        self
    }

    /// Runs `count` times in all, like Core's `loop: count`. 0 and 1 both run once.
    pub fn loops(mut self, count: u32) -> Self {
        self.timing.loops = Some(u64::from(count.max(1)));
        self
    }

    /// Runs again and again until the timeline pauses or ends, like Core's `loop: true`. A timeline without an
    /// explicit duration then never finishes.
    pub fn forever(mut self) -> Self {
        self.timing.loops = None;
        self
    }

    /// A pause between runs, holding the value where the run ended.
    pub fn loop_delay(mut self, delay: Duration) -> Self {
        self.timing.loop_delay = nanos(delay);
        self
    }

    /// Runs every second loop backward, from `to` to `from`: a yoyo.
    pub fn alternate(mut self, alternate: bool) -> Self {
        self.timing.alternate = alternate;
        self
    }

    /// Called when the timeline reaches the tween's start position. Replaces an earlier handler.
    pub fn on_start(mut self, handler: impl FnMut(&mut Cx<'_>) + 'static) -> Self {
        self.track.on_start = Some(Box::new(handler));
        self
    }

    /// Called on every frame while the tween runs, with its current value. Replaces an earlier handler.
    pub fn on_update(mut self, handler: impl FnMut(&mut Cx<'_>, T) + 'static) -> Self {
        self.track.on_update = Some(Box::new(handler));
        self
    }

    /// Called when a run ends and another follows, after the loop delay. If a frame skips several runs, it is
    /// called once. Replaces an earlier handler.
    pub fn on_loop(mut self, handler: impl FnMut(&mut Cx<'_>) + 'static) -> Self {
        self.track.on_loop = Some(Box::new(handler));
        self
    }

    /// Called once the last run ends, right after the final update. Replaces an earlier handler.
    pub fn on_complete(mut self, handler: impl FnMut(&mut Cx<'_>) + 'static) -> Self {
        self.track.on_complete = Some(Box::new(handler));
        self
    }
}

struct TweenItem {
    at: u64,
    timing: Timing,
    once: bool,
    started: bool,
    completed: bool,
    current_loop: u64,
    track: Rc<RefCell<dyn Track>>,
}

impl TweenItem {
    /// Core's `evaluateAnimation`, except that the last run completes when its animation ends whether or not the
    /// tween has a completion handler, and the delay after it is skipped.
    fn evaluate(&mut self, owner: &Rc<TimelineInner>, time: u64, frame: &mut Frame) {
        if time < self.at || self.completed {
            return;
        }
        let event = |event| Action::Track(Rc::clone(&self.track), event);
        if !self.started {
            self.started = true;
            frame.push(owner, event(TrackEvent::Begin(!frame.silent)));
        }
        let elapsed = time - self.at;
        let Timing { duration, easing, loops, loop_delay, alternate } = self.timing;
        let update = |progress: f64, reversed: bool| {
            let eased = easing.apply(progress);
            event(TrackEvent::Update(if reversed { 1.0 - eased } else { eased }))
        };
        let cycle = duration.saturating_add(loop_delay);
        let mut current = elapsed.checked_div(cycle).unwrap_or(0);
        let mut within = elapsed.checked_rem(cycle).unwrap_or(0);
        if duration > 0 && current > self.current_loop && loops.is_none_or(|loops| current < loops) {
            frame.notify(owner, event(TrackEvent::Loop));
        }
        self.current_loop = current;
        if elapsed >= self.timing.length() {
            let reversed = duration > 0 && alternate && loops.is_some_and(|loops| (loops - 1) % 2 == 1);
            frame.push(owner, update(1.0, reversed));
            self.completed = true;
            frame.notify(owner, event(TrackEvent::Complete));
            return;
        }
        // At a run's exact end, show that run's end rather than the next run's start.
        if within == 0 && elapsed > 0 {
            current -= 1;
            within = cycle;
        }
        let progress = if within >= duration { 1.0 } else { within as f64 / duration as f64 };
        frame.push(owner, update(progress, alternate && current % 2 == 1));
    }
}

type Callback = Rc<RefCell<dyn FnMut(&mut Cx<'_>)>>;

struct CallItem {
    at: u64,
    executed: bool,
    callback: Callback,
}

enum Item {
    Tween(TweenItem),
    Call(CallItem),
}

struct Child {
    at: u64,
    started: bool,
    timeline: Timeline,
}

struct State {
    /// `None` ends the timeline with its last item.
    duration: Option<u64>,
    looping: bool,
    playing: bool,
    complete: bool,
    /// Whether an [`App::animate`] step advances this timeline.
    driven: bool,
    time: u64,
    items: Vec<Item>,
    children: Vec<Child>,
    parent: Weak<TimelineInner>,
}

impl State {
    fn is_synced(&self) -> bool {
        self.parent.strong_count() > 0
    }

    /// Without a duration and with nothing on it, a timeline waits for items instead of finishing.
    fn is_idle(&self) -> bool {
        self.duration.is_none() && self.items.is_empty() && self.children.is_empty()
    }

    fn length(&self) -> u64 {
        if let Some(duration) = self.duration {
            return duration;
        }
        let items = self.items.iter().map(|item| match item {
            Item::Tween(tween) => tween.at.saturating_add(tween.timing.length()),
            Item::Call(call) => call.at,
        });
        let children = self
            .children
            .iter()
            .map(|child| child.at.saturating_add(child.timeline.0.state.try_borrow().map_or(0, |state| state.span())));
        items.chain(children).max().unwrap_or(0)
    }

    /// How long the timeline runs once started: a looping one runs forever.
    fn span(&self) -> u64 {
        if self.looping { u64::MAX } else { self.length() }
    }

    /// Rewinds to the start and resets every item; children rewind and wait to be reached again.
    fn reset(&mut self) {
        self.time = 0;
        self.complete = false;
        for item in &mut self.items {
            match item {
                Item::Tween(tween) => {
                    tween.started = false;
                    tween.completed = false;
                    tween.current_loop = 0;
                }
                Item::Call(call) => call.executed = false,
            }
        }
        for child in &mut self.children {
            child.started = false;
            if let Ok(mut state) = child.timeline.0.state.try_borrow_mut() {
                state.reset();
                state.pause();
            }
        }
    }

    fn play(&mut self) {
        if self.complete {
            self.reset();
        }
        self.playing = true;
        for child in self.children.iter().filter(|child| child.started) {
            if let Ok(mut state) = child.timeline.0.state.try_borrow_mut() {
                state.play();
            }
        }
    }

    fn pause(&mut self) {
        self.playing = false;
        for child in &self.children {
            if let Ok(mut state) = child.timeline.0.state.try_borrow_mut() {
                state.pause();
            }
        }
    }
}

/// Core's `Timeline.update`: advances children, then items, then wraps or finishes. Handlers run afterward, from
/// the frame's effects.
///
/// Unlike Core, a paused timeline starts no children: Core starts a synced child once the parent's time plus the
/// frame's delta reaches it, even while the parent is paused or was never played.
fn advance(owner: &Rc<TimelineInner>, state: &mut State, delta: u64, frame: &mut Frame) {
    if !state.playing || state.is_idle() {
        return;
    }
    let time = state.time.saturating_add(delta);
    for child in &mut state.children {
        if time < child.at {
            continue;
        }
        let inner = &child.timeline.0;
        let Ok(mut child_state) = inner.state.try_borrow_mut() else { continue };
        let child_delta = if child.started {
            delta
        } else {
            child.started = true;
            child_state.play();
            time - child.at
        };
        advance(inner, &mut child_state, child_delta, frame);
    }
    state.time = time;
    for item in &mut state.items {
        match item {
            Item::Tween(tween) => tween.evaluate(owner, time, frame),
            Item::Call(call) => {
                if !call.executed && time >= call.at {
                    call.executed = true;
                    frame.notify(owner, Action::Call(Rc::clone(&call.callback)));
                }
            }
        }
    }
    state.items.retain(|item| !matches!(item, Item::Tween(tween) if tween.once && tween.completed));
    let length = state.length();
    if time < length || state.is_idle() {
        return;
    }
    if state.looping {
        let overshoot = time % length.max(1);
        state.reset();
        if overshoot > 0 {
            advance(owner, state, overshoot, frame);
        }
    } else {
        state.time = length;
        state.playing = false;
        state.complete = true;
        frame.notify(owner, Action::Finished);
    }
}

enum Action {
    Track(Rc<RefCell<dyn Track>>, TrackEvent),
    Call(Callback),
    /// The owner's completion handlers.
    Finished,
}

enum TrackEvent {
    /// Reads a lazy start value, and calls the start handler when the flag is set.
    Begin(bool),
    Update(f64),
    Loop,
    Complete,
}

struct Effect {
    owner: Rc<TimelineInner>,
    /// A restart or seek of the owner since this effect was recorded makes it stale.
    epoch: u64,
    action: Action,
}

/// Handler calls recorded while advancing, made once no timeline state is borrowed, so handlers may change any
/// timeline.
struct Frame {
    /// Seeking: only values are delivered, without start, loop, completion, or callback notifications.
    silent: bool,
    effects: Vec<Effect>,
}

impl Frame {
    fn new(silent: bool) -> Self {
        Self { silent, effects: Vec::new() }
    }

    fn push(&mut self, owner: &Rc<TimelineInner>, action: Action) {
        self.effects.push(Effect { owner: Rc::clone(owner), epoch: owner.epoch.get(), action });
    }

    fn notify(&mut self, owner: &Rc<TimelineInner>, action: Action) {
        if !self.silent {
            self.push(owner, action);
        }
    }

    fn run(self, app: &App) {
        for Effect { owner, epoch, action } in self.effects {
            if owner.epoch.get() != epoch {
                continue;
            }
            let cx = &mut Cx::new(app);
            // A handler that is already running, as when it seeks its own timeline, is skipped.
            match action {
                Action::Track(track, event) => {
                    if let Ok(mut track) = track.try_borrow_mut() {
                        match event {
                            TrackEvent::Begin(notify) => track.begin(cx, notify),
                            TrackEvent::Update(t) => track.update(cx, t),
                            TrackEvent::Loop => track.looped(cx),
                            TrackEvent::Complete => track.complete(cx),
                        }
                    }
                }
                Action::Call(callback) => {
                    if let Ok(mut callback) = callback.try_borrow_mut() {
                        callback(cx);
                    }
                }
                Action::Finished => owner.on_complete.emit(cx, &()),
            }
        }
    }
}

pub(crate) struct TimelineInner {
    app: Weak<AppInner>,
    state: RefCell<State>,
    epoch: Cell<u64>,
    on_complete: Callbacks<()>,
    on_pause: Callbacks<()>,
}

impl TimelineInner {
    fn with<R>(&self, change: impl FnOnce(&mut State) -> R) -> Option<R> {
        self.state.try_borrow_mut().ok().map(|mut state| change(&mut state))
    }

    /// Makes effects recorded for this timeline and its children stale.
    fn bump(&self, state: &State) {
        self.epoch.set(self.epoch.get().wrapping_add(1));
        for child in &state.children {
            if let Ok(child_state) = child.timeline.0.state.try_borrow() {
                child.timeline.0.bump(&child_state);
            }
        }
    }

    /// Drops every item, child, and handler, breaking cycles through handlers that capture timelines.
    pub(crate) fn teardown(&self) {
        let taken = self.with(|state| {
            state.playing = false;
            state.driven = false;
            (std::mem::take(&mut state.items), std::mem::take(&mut state.children))
        });
        self.on_complete.clear();
        self.on_pause.clear();
        drop(taken);
    }
}

/// A sequence of tweens, callbacks, and child timelines, placed at positions along it and played over time.
///
/// `Timeline` is a cheap [`Clone`] handle. A new timeline plays at once, like Core's `createTimeline`, and keeps
/// playing until it reaches its end: its [`Self::duration`], or by default the end of its last item. A looping
/// timeline then starts over; otherwise it stops and calls its completion handlers. A timeline without a duration
/// and with nothing on it waits, requesting no frames, until you add something; [`Self::once`] on such a timeline
/// plays one-off animations as they come.
///
/// While a timeline plays, it advances before every frame through [`App::animate`] and keeps itself alive, so a
/// timeline you start and forget runs to its end and is then released. Handlers may capture the timeline and
/// widgets; the app breaks those cycles when it ends.
///
/// Handlers may control any timeline, including their own. A [`Self::restart`] or [`Self::seek`] from a handler
/// skips the handlers the rest of that frame would have called for the old position.
///
/// Differences from Core: positions and durations are [`Duration`]s; a timeline without an explicit duration ends
/// with its last item instead of after one second; a paused timeline starts no children; and pause handlers run only
/// when a playing timeline pauses.
#[derive(Clone)]
pub struct Timeline(Rc<TimelineInner>);

impl fmt::Debug for Timeline {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut debug = formatter.debug_struct("Timeline");
        if let Ok(state) = self.0.state.try_borrow() {
            debug
                .field("time", &Duration::from_nanos(state.time))
                .field("playing", &state.playing)
                .field("complete", &state.complete);
        }
        debug.finish_non_exhaustive()
    }
}

impl Timeline {
    /// Creates a timeline that plays from the next frame.
    pub fn new(app: &App) -> Self {
        let inner = Rc::new(TimelineInner {
            app: Rc::downgrade(app.inner()),
            state: RefCell::new(State {
                duration: None,
                looping: false,
                playing: true,
                complete: false,
                driven: false,
                time: 0,
                items: Vec::new(),
                children: Vec::new(),
                parent: Weak::new(),
            }),
            epoch: Cell::new(0),
            on_complete: Callbacks::default(),
            on_pause: Callbacks::default(),
        });
        app.inner().register_timeline(Rc::downgrade(&inner));
        let timeline = Self(inner);
        timeline.drive();
        timeline
    }

    fn app(&self) -> Option<App> {
        self.0.app.upgrade().map(App::from_inner)
    }

    /// Registers an animation step while the timeline plays on its own, not driven by a parent.
    fn drive(&self) {
        let Some(app) = self.app() else { return };
        let start = self.0.with(|state| {
            let start = state.playing && !state.driven && !state.is_synced() && !state.is_idle();
            state.driven |= start;
            start
        });
        if start == Some(true) {
            let timeline = self.clone();
            app.animate(move |cx, elapsed| timeline.step(cx, elapsed));
        }
    }

    fn step(&self, cx: &mut Cx<'_>, elapsed: Duration) -> bool {
        let mut frame = Frame::new(false);
        let advanced = self.0.with(|state| {
            if state.playing && !state.is_synced() {
                advance(&self.0, state, nanos(elapsed), &mut frame);
            }
        });
        if advanced.is_none() {
            return true;
        }
        frame.run(cx.app());
        self.0
            .with(|state| {
                state.driven = state.playing && !state.is_synced() && !state.is_idle();
                state.driven
            })
            .unwrap_or(true)
    }

    /// Ends the timeline at `duration`, cutting off items that run longer. Without it, the timeline ends when its
    /// last item does, and never when an item repeats forever.
    pub fn duration(&self, duration: Duration) -> Self {
        self.0.with(|state| state.duration = Some(nanos(duration)));
        self.drive();
        self.clone()
    }

    /// Starts over from the beginning whenever the timeline reaches its end, instead of finishing.
    pub fn looping(&self, looping: bool) -> Self {
        self.0.with(|state| state.looping = looping);
        self.clone()
    }

    /// Whether the timeline plays as soon as it is created, as it does by default. `autoplay(false)` right after
    /// [`Self::new`] keeps it paused until [`Self::play`], without calling pause handlers. Once the timeline has
    /// advanced or finished, this does nothing.
    pub fn autoplay(&self, autoplay: bool) -> Self {
        let play = self.0.with(|state| {
            let fresh = state.time == 0 && !state.complete;
            if fresh && autoplay {
                state.playing = true;
            } else if fresh {
                state.pause();
            }
            fresh && autoplay
        });
        if play == Some(true) {
            self.drive();
        }
        self.clone()
    }

    /// Plays `tween` from position `at`.
    pub fn add<T: Interpolate + 'static>(&self, at: Duration, tween: Tween<T>) -> Self {
        self.insert(Some(nanos(at)), tween)
    }

    /// Plays `tween` from the timeline's current position, then removes it, so a looping timeline does not repeat
    /// it. For one-off animations on a running timeline, like Core's `once`.
    pub fn once<T: Interpolate + 'static>(&self, tween: Tween<T>) -> Self {
        self.insert(None, tween)
    }

    fn insert<T: Interpolate + 'static>(&self, at: Option<u64>, tween: Tween<T>) -> Self {
        let Tween { timing, track } = tween;
        let track: Rc<RefCell<dyn Track>> = Rc::new(RefCell::new(track));
        self.0.with(|state| {
            state.items.push(Item::Tween(TweenItem {
                at: at.unwrap_or(state.time),
                timing,
                once: at.is_none(),
                started: false,
                completed: false,
                current_loop: 0,
                track,
            }))
        });
        self.drive();
        self.clone()
    }

    /// Calls `callback` when the timeline reaches position `at`, once per pass.
    pub fn call(&self, at: Duration, callback: impl FnMut(&mut Cx<'_>) + 'static) -> Self {
        let callback: Callback = Rc::new(RefCell::new(callback));
        self.0.with(|state| state.items.push(Item::Call(CallItem { at: nanos(at), executed: false, callback })));
        self.drive();
        self.clone()
    }

    /// Plays `child` as part of this timeline, starting when this one reaches position `at`. From then on `child`
    /// advances with this timeline: it pauses and resumes with it, and starts over when this timeline loops or
    /// restarts. `sync` pauses `child` until then, and moves it from any other parent.
    ///
    /// Does nothing when `child` is this timeline or contains it.
    pub fn sync(&self, at: Duration, child: &Timeline) -> Self {
        let mut ancestor = Some(Rc::clone(&self.0));
        while let Some(timeline) = ancestor {
            if Rc::ptr_eq(&timeline, &child.0) {
                return self.clone();
            }
            ancestor = timeline.state.try_borrow().ok().and_then(|state| state.parent.upgrade());
        }
        let previous = child.0.with(|state| {
            state.pause();
            std::mem::replace(&mut state.parent, Rc::downgrade(&self.0)).upgrade()
        });
        if let Some(previous) = previous.flatten() {
            previous.with(|state| state.children.retain(|entry| !Rc::ptr_eq(&entry.timeline.0, &child.0)));
        }
        self.0.with(|state| state.children.push(Child { at: nanos(at), started: false, timeline: child.clone() }));
        self.drive();
        self.clone()
    }

    /// Plays from the current position, or from the start after the timeline finished.
    pub fn play(&self) -> Self {
        if self.is_complete() {
            return self.restart();
        }
        self.0.with(State::play);
        self.drive();
        self.clone()
    }

    /// Stops at the current position. Calls pause handlers if the timeline was playing. Children pause too, without
    /// calling theirs.
    pub fn pause(&self) -> Self {
        let was_playing = self.0.with(|state| {
            let was_playing = state.playing;
            state.pause();
            was_playing
        });
        if was_playing == Some(true)
            && let Some(app) = self.app()
        {
            self.0.on_pause.emit(&mut Cx::new(&app), &());
        }
        self.clone()
    }

    /// Plays from the start. Items run again; values stay where they are until their tweens start.
    pub fn restart(&self) -> Self {
        self.0.with(|state| {
            state.reset();
            state.playing = true;
            self.0.bump(state);
        });
        self.drive();
        self.clone()
    }

    /// Jumps to position `time`, keeping the timeline playing or paused. Update handlers get the values at `time`
    /// at once; start, loop, completion, and [`Self::call`] handlers for the positions skipped are not called.
    /// Seeking to the end of a timeline that does not loop finishes it.
    pub fn seek(&self, time: Duration) -> Self {
        let mut frame = Frame::new(true);
        self.0.with(|state| {
            let playing = state.playing;
            state.reset();
            self.0.bump(state);
            state.playing = true;
            advance(&self.0, state, nanos(time), &mut frame);
            if !playing && state.playing {
                state.pause();
            }
        });
        if let Some(app) = self.app() {
            frame.run(&app);
        }
        self.drive();
        self.clone()
    }

    /// Called when the timeline reaches its end without looping.
    pub fn on_complete(&self, mut handler: impl FnMut(&mut Cx<'_>) + 'static) -> Self {
        self.0.on_complete.add(move |cx, _: &()| handler(cx));
        self.clone()
    }

    /// Called when [`Self::pause`] stops the playing timeline. Finishing does not count as pausing.
    pub fn on_pause(&self, mut handler: impl FnMut(&mut Cx<'_>) + 'static) -> Self {
        self.0.on_pause.add(move |cx, _: &()| handler(cx));
        self.clone()
    }

    /// Whether the timeline advances with each frame, or with its parent's.
    pub fn is_playing(&self) -> bool {
        self.0.state.try_borrow().is_ok_and(|state| state.playing)
    }

    /// Whether the timeline reached its end without looping, and has not been restarted since.
    pub fn is_complete(&self) -> bool {
        self.0.state.try_borrow().is_ok_and(|state| state.complete)
    }

    /// The position the timeline has reached.
    pub fn current_time(&self) -> Duration {
        self.0.state.try_borrow().map_or(Duration::ZERO, |state| Duration::from_nanos(state.time))
    }
}
