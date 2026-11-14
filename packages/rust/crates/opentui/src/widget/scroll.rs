use super::{Behavior, Callbacks, Container, Element, Slider, View, Widget, build, keymap_methods};
use crate::app::{App, Cx, TimerId};
use crate::input::{KeyEvent, Keymap, Modifiers, MouseButton, MouseEvent, MouseEventKind};
use crate::layout::{Align, FlexDirection, Justify, LayoutMode, LayoutProperty, Length, Overflow, Wrap};
use crate::native::{ArrowDirection, ArrowOptions, NodeKind, Observation, SliderOptions};
use crate::style::Color;
use std::cell::{Cell, OnceCell, RefCell};
use std::collections::VecDeque;
use std::rc::{Rc, Weak};
use std::time::{Duration, Instant};

/// Scrollbar visibility changes allowed per frame, so wrapping content cannot make the layout oscillate.
const TOGGLES_PER_FRAME: u8 = 2;

/// Core's auto-scroll while drag-selecting: how close to an edge it starts, in cells, and rows per second within
/// one, two, and three cells of the edge.
const AUTO_SCROLL_EDGE: f64 = 3.0;
const AUTO_SCROLL_SPEEDS: [f64; 3] = [72.0, 36.0, 6.0];

/// Core's arrow buttons: a press scrolls half a view; holding it scrolls a fifth of a view every 200 ms after 500 ms.
const ARROW_DELAY: Duration = Duration::from_millis(500);
const ARROW_REPEAT: Duration = Duration::from_millis(200);

/// What a key does in a scrolling widget: a [`ScrollBox`] or a [`Code`](super::Code) view. Bind keys to actions
/// with `bind`, or run one with `perform`.
///
/// Actions along an axis the widget does not scroll do nothing, so the key passes on to its ancestors.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ScrollAction {
    /// Up a fifth of the view in a scroll box, or one line in a code view.
    Up,
    Down,
    Left,
    Right,
    /// Up half the view in a scroll box, or a view less one line in a code view.
    PageUp,
    PageDown,
    Top,
    Bottom,
}

/// An edge a sticky [`ScrollBox`] starts at and follows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ScrollEdge {
    Top,
    Bottom,
    Left,
    Right,
}

/// What moved a [`ScrollBox`] last, as [`ScrollBox::on_scroll`] reports it. A scroll that the next frame's layout
/// applies again, such as a key's move to the end of content that grows meanwhile, keeps its cause.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ScrollCause {
    Wheel,
    /// A key, or [`ScrollBox::perform`].
    Key,
    /// A scrollbar, its arrows, or a selection drag near an edge.
    Pointer,
    /// [`ScrollBox::scroll_to`] and the other scrolls the program asks for.
    Program,
    /// A size change: a sticky box following its edge, or the offset clamped to a smaller range.
    Layout,
}

/// A move of a [`ScrollBox`], from [`ScrollBox::on_scroll`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollEvent {
    /// The new [`ScrollBox::scroll_position`].
    pub position: (f64, f64),
    pub cause: ScrollCause,
}

/// Turns mouse wheel steps into scrolled cells for a [`ScrollBox`].
pub trait ScrollAcceleration {
    /// The cells to scroll for a wheel step at `now`. Fractions add up across steps.
    fn tick(&mut self, now: Instant) -> f64;

    /// Forgets the current burst of steps, as keyboard scrolling does.
    fn reset(&mut self);
}

/// One cell per wheel step, the default.
#[derive(Clone, Copy, Debug, Default)]
pub struct LinearScroll;

impl ScrollAcceleration for LinearScroll {
    fn tick(&mut self, _now: Instant) -> f64 {
        1.0
    }

    fn reset(&mut self) {}
}

/// Core's macOS-style acceleration: quick bursts of wheel steps scroll further, slow ones stay precise.
///
/// The average interval of the last three steps sets a multiplier of `1 + amplitude * (e^(v / tau) - 1)`, where `v`
/// is 100 ms over the interval, capped at `max_multiplier`. A pause of 150 ms starts over; steps closer than 6 ms
/// count as one, since some terminals send several per wheel notch.
#[derive(Clone, Debug)]
pub struct MacOsScroll {
    pub amplitude: f64,
    pub tau: f64,
    pub max_multiplier: f64,
    last: Option<Instant>,
    intervals: VecDeque<f64>,
}

impl Default for MacOsScroll {
    fn default() -> Self {
        Self::new(0.8, 3.0, 6.0)
    }
}

impl MacOsScroll {
    /// Acceleration with Core's curve and these parameters; `default()` uses Core's values: 0.8, 3, and 6.
    pub fn new(amplitude: f64, tau: f64, max_multiplier: f64) -> Self {
        Self { amplitude, tau, max_multiplier, last: None, intervals: VecDeque::new() }
    }
}

impl ScrollAcceleration for MacOsScroll {
    fn tick(&mut self, now: Instant) -> f64 {
        let interval = self.last.map(|last| now.saturating_duration_since(last).as_secs_f64() * 1000.0);
        let Some(interval) = interval.filter(|&interval| interval <= 150.0) else {
            self.last = Some(now);
            self.intervals.clear();
            return 1.0;
        };
        if interval < 6.0 {
            return 1.0;
        }
        self.last = Some(now);
        self.intervals.push_back(interval);
        if self.intervals.len() > 3 {
            self.intervals.pop_front();
        }
        let average = self.intervals.iter().sum::<f64>() / self.intervals.len() as f64;
        let velocity = 100.0 / average;
        (1.0 + self.amplitude * ((velocity / self.tau).exp() - 1.0)).min(self.max_multiplier)
    }

    fn reset(&mut self) {
        self.last = None;
        self.intervals.clear();
    }
}

/// An arrow button at one end of a scrollbar.
pub(crate) struct ArrowInner {
    element: Element,
    scroll: Weak<ScrollInner>,
    /// The scroll direction, in views.
    direction: (f64, f64),
}

impl Behavior for ArrowInner {
    fn element(&self) -> &Element {
        &self.element
    }

    fn mouse(&self, cx: &mut Cx<'_>, event: &MouseEvent) -> bool {
        let Some(scroll) = self.scroll.upgrade() else { return false };
        match event.kind {
            MouseEventKind::Down(MouseButton::Left) => scroll.press_arrow(cx, self.direction),
            MouseEventKind::Up(MouseButton::Left) => scroll.release_arrow(cx),
            _ => return false,
        }
        cx.prevent_default();
        true
    }
}

pub(crate) struct ScrollInner {
    element: Element,
    this: RefCell<Weak<ScrollInner>>,
    wrapper: View,
    viewport: View,
    content: View,
    vertical: Slider,
    horizontal: Slider,
    vertical_bar: View,
    horizontal_bar: View,
    arrows: RefCell<Vec<Rc<ArrowInner>>>,
    scroll: Cell<(f64, f64)>,
    axes: Cell<(bool, bool)>,
    scrollbars: Cell<bool>,
    /// The vertical scrollbar shows even when the content fits.
    vertical_always: Cell<bool>,
    sticky: Cell<bool>,
    /// The edge a sticky box follows on each axis, x then y.
    edges: Cell<(Option<ScrollEdge>, Option<ScrollEdge>)>,
    /// Whether the last explicit scroll on each axis left it following its edge.
    stuck: Cell<(bool, bool)>,
    toggles: Cell<(u64, u8)>,
    keymap: RefCell<Keymap<ScrollAction>>,
    acceleration: RefCell<Box<dyn ScrollAcceleration>>,
    /// Fractions of a cell left over from accelerated wheel steps and auto-scrolling.
    wheel: Cell<(f64, f64)>,
    auto_scroll: Cell<Option<(u16, u16)>>,
    arrow_timer: Cell<Option<TimerId>>,
    /// The position per axis the program asked for, unclamped, and the frame count then. The next frame applies it
    /// again, since it was clamped to limits from the frame before, which may predate content added since. Infinity
    /// stands for the end.
    requested: Cell<Option<(Targets, u64)>>,
    /// Made by the first [`ScrollBox::on_scroll`], so a box without scroll handlers keeps only the empty cell.
    listeners: OnceCell<Box<Listeners>>,
}

struct Listeners {
    handlers: Callbacks<ScrollEvent>,
    /// The position the handlers last heard, and the cause of the latest move since.
    reported: Cell<(f64, f64)>,
    cause: Cell<ScrollCause>,
    /// Whether the app's list of moved boxes holds this box.
    queued: Cell<bool>,
}

/// Unclamped positions a request aims for along x and y, or `None` for an axis it leaves alone.
type Targets = (Option<f64>, Option<f64>);

impl ScrollInner {
    fn limits(&self) -> (f64, f64) {
        let (content, viewport) = (self.content.rect(), self.viewport.rect());
        (
            f64::from(content.width - viewport.width).max(0.0).floor(),
            f64::from(content.height - viewport.height).max(0.0).floor(),
        )
    }

    /// Moves the content without changing which edges a sticky box follows. Returns whether it moved.
    fn apply(&self, x: f64, y: f64) -> bool {
        let (max_x, max_y) = self.limits();
        let (scroll_x, scroll_y) = self.axes.get();
        let x = if scroll_x { x.clamp(0.0, max_x).round() } else { 0.0 };
        let y = if scroll_y { y.clamp(0.0, max_y).round() } else { 0.0 };
        if (x, y) == self.scroll.get() {
            return false;
        }
        self.scroll.set((x, y));
        self.content.translate(-x, -y);
        let (vertical, horizontal) = (self.vertical.options(), self.horizontal.options());
        self.vertical.set_options(SliderOptions { value: y, ..vertical });
        self.horizontal.set_options(SliderOptions { value: x, ..horizontal });
        true
    }

    /// Queues the box for the app's next scroll report, while it has scroll handlers.
    fn moved(&self, cause: ScrollCause) {
        let Some(listeners) = self.listeners.get() else { return };
        listeners.cause.set(cause);
        if !listeners.queued.replace(true)
            && let Some(app) = self.element.app()
        {
            app.queue_scroll(self.this.borrow().clone());
        }
    }

    /// Runs the scroll handlers if the box moved since they last heard. The app calls this for queued boxes before a
    /// frame and after it; the box's own layout calls it during the frame, which may queue the box once more.
    pub(crate) fn report(&self, cx: &mut Cx<'_>) {
        let Some(listeners) = self.listeners.get() else { return };
        listeners.queued.set(false);
        let position = self.scroll.get();
        if listeners.reported.replace(position) == position {
            return;
        }
        listeners.handlers.emit(cx, &ScrollEvent { position, cause: listeners.cause.get() });
    }

    /// Whether the content's own resize, which refreshes again, comes later in this layout round: until it does, the
    /// content reports the size of its last resize, not the solved one.
    fn content_resize_due(&self) -> bool {
        let seen = self.content.rect();
        let solved = self.content.element().query(|node| node.layout(Observation::Yoga)).unwrap_or_default();
        // A reported size is at least one cell.
        (solved.width.max(1.0), solved.height.max(1.0)) != (seen.width, seen.height)
    }

    /// Scrolls, then follows the edges the view reached.
    fn scroll_to(&self, x: f64, y: f64, cause: ScrollCause) {
        self.requested.set(None);
        if self.apply(x, y) {
            self.moved(cause);
        }
        self.follow_reached_edges((true, true));
    }

    /// Scrolls for the program, and again once the next frame's layout is known. A NaN position is ignored.
    ///
    /// A relative move adds to the target of a request no frame has applied yet, as Core's does, so moves before a
    /// frame add up and clamp once. A target at or past the end is the end, so moves past the end do not add up,
    /// while moves past the start do. A zero move keeps that axis's target. `relative` is per axis, x then y.
    fn request(&self, (x, y): (f64, f64), (relative_x, relative_y): (bool, bool), cause: ScrollCause) {
        if x.is_nan() || y.is_nan() {
            return;
        }
        let frame = self.element.app().map_or(0, |app| app.frame_number());
        let pending = self.requested.get().filter(|&(_, at)| at == frame).map_or((None, None), |(target, _)| target);
        let (content, (max_x, max_y), (offset_x, offset_y)) = (self.content.rect(), self.limits(), self.scroll.get());
        let aim = |value: f64, relative: bool, pending: Option<f64>, offset: f64, max: f64, extent: f32| {
            let base = pending.map_or(offset, |target| if target == f64::INFINITY { max } else { target });
            if relative && value == 0.0 {
                return (base, pending);
            }
            let position = if relative { base + value } else { value };
            let end = position > 0.0 && position >= max && extent > 0.0;
            (position, Some(if end { f64::INFINITY } else { position.round() }))
        };
        let (x, target_x) = aim(x, relative_x, pending.0, offset_x, max_x, content.width);
        let (y, target_y) = aim(y, relative_y, pending.1, offset_y, max_y, content.height);
        // The next frame's layout applies the target with this cause.
        if let Some(listeners) = self.listeners.get() {
            listeners.cause.set(cause);
        }
        if self.apply(x, y) {
            self.moved(cause);
        }
        self.follow_reached_edges((target_x.is_some(), target_y.is_some()));
        // An axis the scroll left following keeps no target: the next frame follows its edge, as Core's does.
        let ((edge_x, edge_y), (stuck_x, stuck_y)) = (self.edges.get(), self.stuck.get());
        let keep = |target: Option<f64>, edge: Option<ScrollEdge>, stuck: bool| {
            target.filter(|_| !(stuck && edge.is_some() && self.sticky.get()))
        };
        self.requested.set(Some(((keep(target_x, edge_x, stuck_x), keep(target_y, edge_y, stuck_y)), frame)));
    }

    /// As the native scroll node does: an axis follows its edge once at it, or while its range is at most one cell.
    /// Only the axes an explicit scroll set change.
    fn follow_reached_edges(&self, (set_x, set_y): (bool, bool)) {
        let ((max_x, max_y), (x, y), (edge_x, edge_y)) = (self.limits(), self.scroll.get(), self.edges.get());
        let reached = |set: bool, stuck: bool, edge: Option<ScrollEdge>, offset: f64, max: f64| match edge {
            _ if !set => stuck,
            _ if max <= 1.0 => true,
            Some(ScrollEdge::Top | ScrollEdge::Left) => offset <= 0.0,
            _ => offset >= max,
        };
        let (stuck_x, stuck_y) = self.stuck.get();
        self.stuck.set((reached(set_x, stuck_x, edge_x, x, max_x), reached(set_y, stuck_y, edge_y, y, max_y)));
    }

    fn scroll_by(&self, dx: f64, dy: f64, cause: ScrollCause) {
        let (x, y) = self.scroll.get();
        self.scroll_to(x + dx, y + dy, cause);
    }

    /// Shows or hides each scrollbar with `show`, as the options call for at the last layout's sizes.
    fn show_bars(&self, show: impl Fn(&View, bool)) {
        let (content, viewport) = (self.content.rect(), self.viewport.rect());
        let ((scroll_x, scroll_y), shown) = (self.axes.get(), self.scrollbars.get());
        let overflow = content.height > viewport.height || self.vertical_always.get();
        show(&self.vertical_bar, shown && scroll_y && overflow);
        show(&self.horizontal_bar, shown && scroll_x && content.width > viewport.width);
    }

    /// Shows the scrollbars new options call for: at once between frames, and within the per-frame toggle limit while
    /// a frame lays out, where a handler that sets options on resize could otherwise make the layout oscillate.
    fn options_changed(&self) {
        match self.element.app().filter(|app| app.frame_number() != app.painted_frames()) {
            Some(app) => self.show_bars(|bar, visible| self.toggle(&app, bar, visible)),
            None => self.show_bars(|bar, visible| drop(bar.visible(visible))),
        }
    }

    /// Refreshes scroll limits, scrollbars, and sticky scrolling after layout changed a size, and reports a move.
    fn refresh(&self, cx: &mut Cx<'_>) {
        let app = cx.app();
        let viewport = self.viewport.rect();
        let (max_x, max_y) = self.limits();
        let ((x, y), (edge_x, edge_y), (stuck_x, stuck_y)) = (self.scroll.get(), self.edges.get(), self.stuck.get());
        let follow = |edge: Option<ScrollEdge>, stuck: bool, offset: f64, max: f64| match edge {
            Some(ScrollEdge::Top | ScrollEdge::Left) if stuck && self.sticky.get() => 0.0,
            Some(_) if stuck && self.sticky.get() => max,
            _ => offset,
        };
        let (mut x, mut y) = (follow(edge_x, stuck_x, x, max_x), follow(edge_y, stuck_y, y, max_y));
        // Only the first frame after a request applies it; every resize in that frame may move the limits.
        let requested = self.requested.get().filter(|&(_, frame)| app.frame_number() == frame + 1);
        if let Some(((requested_x, requested_y), _)) = requested {
            (x, y) = (requested_x.unwrap_or(x), requested_y.unwrap_or(y));
        }
        let bar = |slider: &Slider, max: f64, value: f64, size: f32| {
            let options = slider.options();
            slider.set_options(SliderOptions {
                min: 0.0,
                max,
                value: value.clamp(0.0, max),
                viewport_size: f64::from(size).max(1.0),
                ..options
            });
        };
        bar(&self.vertical, max_y, y, viewport.height);
        bar(&self.horizontal, max_x, x, viewport.width);
        self.show_bars(|bar, visible| self.toggle(app, bar, visible));
        // Re-apply even if unchanged: the limits may have moved under the current position.
        let before = self.scroll.replace((f64::NAN, f64::NAN));
        self.apply(x, y);
        if let Some(((requested_x, requested_y), _)) = requested {
            self.follow_reached_edges((requested_x.is_some(), requested_y.is_some()));
        }
        let Some(listeners) = self.listeners.get() else { return };
        if self.scroll.get() != before {
            self.moved(if requested.is_some() { listeners.cause.get() } else { ScrollCause::Layout });
        }
        if !self.content_resize_due() {
            self.report(cx);
        }
    }

    fn toggle(&self, app: &App, bar: &View, visible: bool) {
        if bar.is_visible() == visible {
            return;
        }
        let frame = app.frame_number();
        let (last, count) = self.toggles.get();
        let count = if last == frame { count } else { 0 };
        if count >= TOGGLES_PER_FRAME && !visible {
            return;
        }
        self.toggles.set((frame, count + 1));
        bar.visible(visible);
    }

    /// Runs an action. Returns `false` for a direction along an axis that does not scroll.
    fn run(&self, action: ScrollAction) -> bool {
        let viewport = self.viewport.rect();
        let (step_y, step_x) =
            ((f64::from(viewport.height) / 5.0).max(1.0), (f64::from(viewport.width) / 5.0).max(1.0));
        let half = (f64::from(viewport.height) / 2.0).max(1.0);
        let (scroll_x, scroll_y) = self.axes.get();
        // Core moves by the content's height for Home and End, so they add up with other keys before a frame.
        let content = f64::from(self.content.rect().height);
        let delta = match action {
            ScrollAction::Up | ScrollAction::Down if !scroll_y => return false,
            ScrollAction::Left | ScrollAction::Right if !scroll_x => return false,
            ScrollAction::Up => (0.0, -step_y),
            ScrollAction::Down => (0.0, step_y),
            ScrollAction::Left => (-step_x, 0.0),
            ScrollAction::Right => (step_x, 0.0),
            ScrollAction::PageUp => (0.0, -half),
            ScrollAction::PageDown => (0.0, half),
            ScrollAction::Top => (0.0, -content),
            ScrollAction::Bottom => (0.0, content),
        };
        self.request(delta, (true, true), ScrollCause::Key);
        self.acceleration.borrow_mut().reset();
        self.wheel.set((0.0, 0.0));
        true
    }

    /// Scrolls whole cells of an accumulated fractional distance. Returns whether the view moved.
    fn scroll_fraction(&self, dx: f64, dy: f64, cause: ScrollCause) -> bool {
        let (x, y) = self.wheel.get();
        let (x, y) = (x + dx, y + dy);
        let (whole_x, whole_y) = (x.trunc(), y.trunc());
        self.wheel.set((x - whole_x, y - whole_y));
        let before = self.scroll.get();
        if whole_x != 0.0 || whole_y != 0.0 {
            self.scroll_by(whole_x, whole_y, cause);
        }
        self.scroll.get() != before
    }

    /// The direction and speed of auto-scrolling for a pointer during a selection drag, as Core computes them.
    fn auto_scroll_step(&self, (x, y): (u16, u16)) -> (f64, f64, f64) {
        let rect = self.element.rect();
        let (x, y) = (f64::from(x) - rect.screen_x.floor(), f64::from(y) - rect.screen_y.floor());
        let (left, right) = (x, f64::from(rect.width) - x);
        let (top, bottom) = (y, f64::from(rect.height) - y);
        let (scroll_x, scroll_y) = self.axes.get();
        let (max_x, max_y) = self.limits();
        let (position_x, position_y) = self.scroll.get();
        let direction = |enabled: bool, near: f64, far: f64, position: f64, max: f64| match () {
            _ if !enabled => 0.0,
            _ if near <= AUTO_SCROLL_EDGE && position > 0.0 => -1.0,
            _ if near <= AUTO_SCROLL_EDGE => 0.0,
            _ if far <= AUTO_SCROLL_EDGE && position < max => 1.0,
            _ => 0.0,
        };
        let closest = left.min(right).min(top).min(bottom);
        let speed = if closest <= 1.0 {
            AUTO_SCROLL_SPEEDS[0]
        } else if closest <= 2.0 {
            AUTO_SCROLL_SPEEDS[1]
        } else {
            AUTO_SCROLL_SPEEDS[2]
        };
        (
            direction(scroll_x, left, right, position_x, max_x),
            direction(scroll_y, top, bottom, position_y, max_y),
            speed,
        )
    }

    /// Follows a selection drag's pointer: near an edge, scrolls every frame until the pointer leaves it.
    fn drag_selection(&self, cx: &mut Cx<'_>, pointer: (u16, u16)) {
        let (dx, dy, _) = self.auto_scroll_step(pointer);
        let running = self.auto_scroll.replace(Some(pointer)).is_some();
        if running || (dx == 0.0 && dy == 0.0) {
            if dx == 0.0 && dy == 0.0 {
                self.auto_scroll.set(None);
            }
            return;
        }
        let this = self.this.borrow().clone();
        cx.animate(move |cx, elapsed| {
            let Some(inner) = this.upgrade() else { return false };
            let Some(pointer) = inner.auto_scroll.get().filter(|_| cx.selection_dragging()) else {
                inner.auto_scroll.set(None);
                return false;
            };
            // Selection drags go to the widget under the pointer, so one that left the box is followed here.
            let pointer = cx.pointer().unwrap_or(pointer);
            let (dx, dy, speed) = inner.auto_scroll_step(pointer);
            if dx == 0.0 && dy == 0.0 {
                inner.auto_scroll.set(None);
                return false;
            }
            let distance = speed * elapsed.as_secs_f64();
            if inner.scroll_fraction(dx * distance, dy * distance, ScrollCause::Pointer) {
                cx.refresh_selection();
            }
            true
        });
    }

    fn arrow_step(&self, (dx, dy): (f64, f64), share: f64) {
        let viewport = self.viewport.rect();
        let (dx, dy) = (dx * f64::from(viewport.width) * share, dy * f64::from(viewport.height) * share);
        let step = |delta: f64| if delta == 0.0 { 0.0 } else { delta.abs().max(1.0).copysign(delta) };
        self.request((step(dx), step(dy)), (true, true), ScrollCause::Pointer);
    }

    fn press_arrow(&self, cx: &mut Cx<'_>, direction: (f64, f64)) {
        self.release_arrow(cx);
        self.arrow_step(direction, 0.5);
        let this = self.this.borrow().clone();
        let timer = cx.set_timeout(ARROW_DELAY, move |cx| {
            let Some(inner) = this.upgrade() else { return };
            if !inner.arrow_held(cx, direction) {
                inner.arrow_timer.set(None);
                return;
            }
            inner.arrow_step(direction, 0.5);
            let this = Rc::downgrade(&inner);
            let repeat = cx.set_interval(ARROW_REPEAT, move |cx| {
                let Some(inner) = this.upgrade() else { return };
                if inner.arrow_held(cx, direction) {
                    inner.arrow_step(direction, 0.2);
                } else {
                    inner.release_arrow(cx);
                }
            });
            inner.arrow_timer.set(Some(repeat));
        });
        self.arrow_timer.set(Some(timer));
    }

    /// Whether the arrow for a direction still holds the pointer: a release elsewhere, or hiding the arrow, ends a
    /// hold.
    fn arrow_held(&self, cx: &Cx<'_>, direction: (f64, f64)) -> bool {
        self.arrows.borrow().iter().any(|arrow| arrow.direction == direction && cx.captures(&arrow.element))
    }

    fn release_arrow(&self, cx: &mut Cx<'_>) {
        if let Some(timer) = self.arrow_timer.take() {
            cx.cancel_timer(timer);
        }
    }
}

impl Behavior for ScrollInner {
    fn element(&self) -> &Element {
        &self.element
    }

    fn key(&self, _cx: &mut Cx<'_>, key: &KeyEvent) -> bool {
        let action = self.keymap.borrow().get(key);
        action.is_some_and(|action| self.run(action))
    }

    fn mouse(&self, cx: &mut Cx<'_>, event: &MouseEvent) -> bool {
        let shift = event.modifiers.contains(Modifiers::SHIFT);
        let (dx, dy) = match (event.kind, shift) {
            (MouseEventKind::ScrollUp, false) | (MouseEventKind::ScrollLeft, true) => (0.0, -1.0),
            (MouseEventKind::ScrollDown, false) | (MouseEventKind::ScrollRight, true) => (0.0, 1.0),
            (MouseEventKind::ScrollLeft, false) | (MouseEventKind::ScrollUp, true) => (-1.0, 0.0),
            (MouseEventKind::ScrollRight, false) | (MouseEventKind::ScrollDown, true) => (1.0, 0.0),
            (MouseEventKind::Drag(MouseButton::Left), _) if cx.selection_dragging() => {
                self.drag_selection(cx, (event.x, event.y));
                return false;
            }
            (MouseEventKind::Up(_), _) => {
                self.auto_scroll.set(None);
                return false;
            }
            _ => return false,
        };
        let multiplier = self.acceleration.borrow_mut().tick(cx.now());
        // An unmoved inner scroll area lets an outer one scroll instead.
        self.scroll_fraction(dx * multiplier, dy * multiplier, ScrollCause::Wheel)
    }

    fn teardown(&self) {
        self.arrows.borrow_mut().clear();
        if let Some(listeners) = self.listeners.get() {
            listeners.handlers.clear();
        }
    }
}

/// A scrollable area. Children added to it scroll inside a clipped viewport.
///
/// Scrolls with the mouse wheel (Shift for horizontal), the scrollbars, and, while it or a descendant has focus, the
/// arrow keys, h/j/k/l, Page Up/Down, and Home/End; [`Self::bind`] changes the keys. Dragging a text selection near
/// an edge scrolls toward it. Children outside the viewport are not painted.
///
/// As in Core, a scroll box without a height is as tall as its content, and shrinks to fit its parent; give it a
/// maximum height to scroll past a size, or a grow factor to fill the space it is given whatever its content.
///
/// Children go in an inner content view. The layout methods that arrange children act on that view:
/// [`Widget::row`], [`Widget::column`], [`Widget::direction`], [`Widget::justify`], [`Widget::align_items`],
/// [`Widget::align_content`], [`Widget::flex_wrap`], [`Widget::layout_mode`], and [`Widget::gap`]. The others size and
/// place the scroll box itself.
///
/// ```no_run
/// # use opentui::prelude::*;
/// # let app = App::new(AppOptions::default())?;
/// let log = ScrollBox::new(&app).sticky(true).grow(1.0);
/// for line in 0..100 {
///     log.add(&Text::new(&app, format!("line {line}")));
/// }
/// app.root().add(&log);
/// # Ok::<(), opentui::Error>(())
/// ```
#[derive(Clone)]
pub struct ScrollBox(Rc<ScrollInner>);

impl Widget for ScrollBox {
    fn element(&self) -> &Element {
        &self.0.element
    }

    fn direction(&self, direction: FlexDirection) -> Self {
        self.0.content.direction(direction);
        self.clone()
    }

    fn justify(&self, justify: Justify) -> Self {
        self.0.content.justify(justify);
        self.clone()
    }

    fn align_items(&self, align: Align) -> Self {
        self.0.content.align_items(align);
        self.clone()
    }

    fn align_content(&self, align: Align) -> Self {
        self.0.content.align_content(align);
        self.clone()
    }

    fn flex_wrap(&self, wrap: Wrap) -> Self {
        self.0.content.flex_wrap(wrap);
        self.clone()
    }

    fn layout_mode(&self, mode: LayoutMode) -> Self {
        self.0.content.layout_mode(mode);
        self.clone()
    }

    fn gap(&self, gap: impl Into<Length>) -> Self {
        self.0.content.gap(gap);
        self.clone()
    }
}

impl Container for ScrollBox {
    fn content(&self) -> &Element {
        self.0.content.element()
    }
}

impl std::fmt::Debug for ScrollBox {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_tuple("ScrollBox").field(&self.0.element.id()).finish()
    }
}

impl ScrollBox {
    pub fn new(app: &App) -> Self {
        let zero = Length::Cells(0.0);
        let full = Length::percent(100.0);
        // As in Core, the viewport starts from its content's size and shrinks to the space the box gets, so a box
        // without a height or a grow factor is as tall as its content, up to its maximum height.
        let wrapper = View::new(app).column().grow(1.0).basis(Length::Auto).min_width(zero).min_height(zero);
        let viewport = View::new(app)
            .column()
            .grow(1.0)
            .basis(Length::Auto)
            .min_width(zero)
            .min_height(zero)
            .overflow(Overflow::Hidden);
        let content =
            View::new(app).align_self(Align::Start).shrink(0.0).min_width(full).max_width(full).min_height(full);
        let vertical = Slider::new(app).vertical().focusable(false).grow(1.0);
        let horizontal = Slider::new(app).horizontal().focusable(false).grow(1.0);
        let vertical_bar = View::new(app).column().width(1).shrink(0.0).visible(false);
        let horizontal_bar = View::new(app).row().height(1).shrink(0.0).visible(false);
        let inner = build(app, NodeKind::Box, |element| ScrollInner {
            element,
            this: RefCell::new(Weak::new()),
            wrapper,
            viewport,
            content,
            vertical,
            horizontal,
            vertical_bar,
            horizontal_bar,
            arrows: RefCell::new(Vec::new()),
            scroll: Cell::new((0.0, 0.0)),
            axes: Cell::new((false, true)),
            scrollbars: Cell::new(true),
            vertical_always: Cell::new(false),
            sticky: Cell::new(false),
            edges: Cell::new((None, Some(ScrollEdge::Bottom))),
            stuck: Cell::new((true, true)),
            toggles: Cell::new((0, 0)),
            keymap: RefCell::new(Self::default_keymap()),
            acceleration: RefCell::new(Box::new(LinearScroll)),
            wheel: Cell::new((0.0, 0.0)),
            auto_scroll: Cell::new(None),
            arrow_timer: Cell::new(None),
            requested: Cell::new(None),
            listeners: OnceCell::new(),
        });
        *inner.this.borrow_mut() = Rc::downgrade(&inner);
        let element = &inner.element;
        element.set_layout(LayoutProperty::FlexDirection(FlexDirection::Row));
        element.set_layout(LayoutProperty::AlignItems(Align::Stretch));
        element.set_focusable(true);
        element.insert(inner.wrapper.element(), None);
        inner.wrapper.element().insert(inner.viewport.element(), None);
        inner.viewport.element().insert(inner.content.element(), None);
        inner.wrapper.element().insert(inner.horizontal_bar.element(), None);
        element.insert(inner.vertical_bar.element(), None);
        let theme = app.theme();
        let arrow = |direction: ArrowDirection, step: (f64, f64)| {
            let arrow = build(app, NodeKind::Arrow, |element| ArrowInner {
                element,
                scroll: Rc::downgrade(&inner),
                direction: step,
            });
            let options = ArrowOptions { direction, fg: theme.thumb, bg: theme.track, ..Default::default() };
            arrow.element.apply(|node| node.set_arrow(&options, None));
            arrow.element.set_layout(LayoutProperty::FixedWidth(Length::Cells(1.0)));
            arrow.element.set_layout(LayoutProperty::FixedHeight(Length::Cells(1.0)));
            arrow.element.set_layout(LayoutProperty::FlexShrink(0.0));
            arrow.element.set_visible(false);
            arrow
        };
        let arrows = [
            arrow(ArrowDirection::Up, (0.0, -1.0)),
            arrow(ArrowDirection::Down, (0.0, 1.0)),
            arrow(ArrowDirection::Left, (-1.0, 0.0)),
            arrow(ArrowDirection::Right, (1.0, 0.0)),
        ];
        let (vertical_bar, horizontal_bar) = (inner.vertical_bar.element(), inner.horizontal_bar.element());
        vertical_bar.insert(&arrows[0].element, None);
        vertical_bar.insert(inner.vertical.element(), None);
        vertical_bar.insert(&arrows[1].element, None);
        horizontal_bar.insert(&arrows[2].element, None);
        horizontal_bar.insert(inner.horizontal.element(), None);
        horizontal_bar.insert(&arrows[3].element, None);
        *inner.arrows.borrow_mut() = arrows.into();
        // Only paint children that overlap the viewport.
        if let (Some(content), Some(viewport)) = (inner.content.element().node(), inner.viewport.element().node()) {
            app.report(content.set_viewport(Some(viewport)));
        }

        let weak: Weak<ScrollInner> = Rc::downgrade(&inner);
        let refresh = move |cx: &mut Cx<'_>, _: &crate::layout::Rect| {
            if let Some(inner) = weak.upgrade() {
                inner.refresh(cx);
            }
        };
        inner.viewport.on_resize(refresh.clone());
        inner.content.on_resize(refresh);
        let weak = Rc::downgrade(&inner);
        inner.vertical.on_change(move |_cx, value| {
            if let Some(inner) = weak.upgrade() {
                inner.scroll_to(inner.scroll.get().0, value, ScrollCause::Pointer);
            }
        });
        let weak = Rc::downgrade(&inner);
        inner.horizontal.on_change(move |_cx, value| {
            if let Some(inner) = weak.upgrade() {
                inner.scroll_to(value, inner.scroll.get().1, ScrollCause::Pointer);
            }
        });
        Self(inner)
    }

    /// The key bindings a new scroll box starts with.
    pub fn default_keymap() -> Keymap<ScrollAction> {
        use ScrollAction as A;
        Keymap::new()
            .bind("up", A::Up)
            .bind("k", A::Up)
            .bind("down", A::Down)
            .bind("j", A::Down)
            .bind("left", A::Left)
            .bind("h", A::Left)
            .bind("right", A::Right)
            .bind("l", A::Right)
            .bind("pageup", A::PageUp)
            .bind("pagedown", A::PageDown)
            .bind("home", A::Top)
            .bind("end", A::Bottom)
    }

    keymap_methods!(ScrollAction);

    /// Runs an action as its key would.
    pub fn perform(&self, action: ScrollAction) -> Self {
        self.0.run(action);
        self.clone()
    }

    /// Which axes scroll. Vertical only by default; a non-scrolling axis fits content to the viewport.
    pub fn axes(&self, horizontal: bool, vertical: bool) -> Self {
        self.0.axes.set((horizontal, vertical));
        let full = Length::percent(100.0);
        let content = self.0.content.element();
        content.set_layout(LayoutProperty::MaxWidth(if horizontal { Length::Undefined } else { full }));
        content.set_layout(LayoutProperty::MaxHeight(if vertical { Length::Undefined } else { full }));
        self.clone()
    }

    /// Keeps the view at its [`Self::sticky_start`] edge as content changes, as Core's sticky scrolling does: at the
    /// edge, new content scrolls into view; scrolled away from it, the view stays put; scrolling back to the edge
    /// follows it again, and so does any scroll while the content overflows by at most one cell. A sticky box follows
    /// the bottom unless [`Self::sticky_start`] says otherwise.
    pub fn sticky(&self, sticky: bool) -> Self {
        self.0.sticky.set(sticky);
        self.clone()
    }

    /// Moves the view to an edge, which a [`Self::sticky`] box then follows on that axis instead of the opposite edge.
    pub fn sticky_start(&self, edge: ScrollEdge) -> Self {
        let (edge_x, edge_y) = self.0.edges.get();
        // The other axis moves by zero, which leaves its position, target, and follow alone.
        let (edges, position, relative) = match edge {
            ScrollEdge::Top => ((edge_x, Some(edge)), (0.0, 0.0), (true, false)),
            ScrollEdge::Bottom => ((edge_x, Some(edge)), (0.0, f64::MAX), (true, false)),
            ScrollEdge::Left => ((Some(edge), edge_y), (0.0, 0.0), (false, true)),
            ScrollEdge::Right => ((Some(edge), edge_y), (f64::MAX, 0.0), (false, true)),
        };
        self.0.edges.set(edges);
        self.0.request(position, relative, ScrollCause::Program);
        self.clone()
    }

    /// How wheel steps turn into scrolled cells: [`LinearScroll`] by default, or [`MacOsScroll`].
    pub fn scroll_acceleration(&self, acceleration: impl ScrollAcceleration + 'static) -> Self {
        *self.0.acceleration.borrow_mut() = Box::new(acceleration);
        self.0.wheel.set((0.0, 0.0));
        self.clone()
    }

    /// Shows scrollbars when content overflows. On by default.
    pub fn scrollbars(&self, show: bool) -> Self {
        self.0.scrollbars.set(show);
        self.0.options_changed();
        self.clone()
    }

    /// Shows the vertical scrollbar even when the content fits, as Core's `verticalScrollbarOptions.visible: true`
    /// does; its thumb then fills the track. Off by default.
    pub fn vertical_scrollbar_always(&self, always: bool) -> Self {
        self.0.vertical_always.set(always);
        self.0.options_changed();
        self.clone()
    }

    /// Shows arrow buttons at the ends of the scrollbars. A click scrolls half a view; holding repeats. Off by
    /// default.
    pub fn scrollbar_arrows(&self, show: bool) -> Self {
        for arrow in self.0.arrows.borrow().iter() {
            arrow.element.set_visible(show);
        }
        self.clone()
    }

    /// Thumb and track colors of both scrollbars and their arrows.
    pub fn scrollbar_colors(&self, thumb: Color, track: Color) -> Self {
        self.0.vertical.colors(thumb, track);
        self.0.horizontal.colors(thumb, track);
        for arrow in self.0.arrows.borrow().iter() {
            let direction = match arrow.direction {
                (_, y) if y < 0.0 => ArrowDirection::Up,
                (_, y) if y > 0.0 => ArrowDirection::Down,
                (x, _) if x < 0.0 => ArrowDirection::Left,
                _ => ArrowDirection::Right,
            };
            let options = ArrowOptions { direction, fg: thumb, bg: track, ..Default::default() };
            arrow.element.apply(|node| node.set_arrow(&options, None));
        }
        self.clone()
    }

    /// The content's padding, inside the scrolled area.
    pub fn content_padding(&self, padding: impl Into<Length>) -> Self {
        self.0.content.padding(padding);
        self.clone()
    }

    /// Space between children, as [`Widget::gap`] sets it.
    pub fn content_gap(&self, gap: impl Into<Length>) -> Self {
        self.0.content.gap(gap);
        self.clone()
    }

    /// The scroll position: columns and rows scrolled past.
    pub fn scroll_position(&self) -> (f64, f64) {
        self.0.scroll.get()
    }

    /// Called when the box moves, at most once per move and never when it did not move, before a frame paints it.
    /// Moves made between frames (by the wheel, keys, scrollbars, the program, or tasks deferred to the frame) are
    /// reported together at the start of the next frame, before its layout, with the cause of the last one. Moves the
    /// frame's layout makes (a sticky box following its edge, a clamp, a scroll applied again to new content) are
    /// reported during that layout, before the resize handlers of later widgets run (see [`Widget::on_resize`]), so
    /// the last event before those handlers carries the position the frame paints. A move a handler makes during the
    /// frame is reported then, if the box's layout runs after it, or after the frame paints.
    ///
    /// Core reports moves through its scrollbars' `onChange`, one axis each, without a cause.
    pub fn on_scroll(&self, handler: impl FnMut(&mut Cx<'_>, &ScrollEvent) + 'static) -> Self {
        let listeners = self.0.listeners.get_or_init(|| {
            Box::new(Listeners {
                handlers: Callbacks::default(),
                reported: Cell::new(self.0.scroll.get()),
                cause: Cell::new(ScrollCause::Program),
                queued: Cell::new(false),
            })
        });
        listeners.handlers.add(handler);
        self.clone()
    }

    /// Scrolls to a position, clamped to the content. Content added since the last frame counts: the next frame
    /// scrolls to the position again once its layout is known. A NaN position is ignored.
    pub fn scroll_to(&self, x: f64, y: f64) -> Self {
        self.0.request((x, y), (false, false), ScrollCause::Program);
        self.clone()
    }

    /// Scrolls by a distance, as [`Self::scroll_to`] does. Moves made before the next frame add up and clamp once,
    /// as Core's do: two moves of 5 from the top of a range of 6 land at 6, and a move of 3 back lands at 3.
    /// Moving at or past the end stops at the end, so a move back from there starts at the end.
    pub fn scroll_by(&self, dx: f64, dy: f64) -> Self {
        self.0.request((dx, dy), (true, true), ScrollCause::Program);
        self.clone()
    }

    /// Scrolls to the end of the content, including content added since the last frame.
    pub fn scroll_to_bottom(&self) -> Self {
        self.0.request((0.0, f64::INFINITY), (true, true), ScrollCause::Program);
        self.clone()
    }

    /// Scrolls the least distance that brings `child` fully into view, using the latest frame's layout.
    pub fn scroll_into_view(&self, child: &impl Widget) -> Self {
        fn delta(start: f64, end: f64, view_start: f64, view_end: f64) -> f64 {
            let (size, view) = (end - start, view_end - view_start);
            match (start < view_start, end > view_end) {
                (true, true) | (false, false) => 0.0,
                (true, false) if size < view => start - view_start,
                (false, true) if size > view => start - view_start,
                _ => end - view_end,
            }
        }
        let (child, viewport) = (child.rect(), self.0.viewport.rect());
        let dy = delta(
            child.screen_y,
            child.screen_y + f64::from(child.height),
            viewport.screen_y,
            viewport.screen_y + f64::from(viewport.height),
        );
        let dx = delta(
            child.screen_x,
            child.screen_x + f64::from(child.width),
            viewport.screen_x,
            viewport.screen_x + f64::from(viewport.width),
        );
        self.0.scroll_by(dx, dy, ScrollCause::Program);
        self.clone()
    }

    /// The inner view children attach to, for styling the content area.
    pub fn content_view(&self) -> &View {
        &self.0.content
    }

    /// The wrapper around the viewport and horizontal scrollbar.
    pub fn wrapper_view(&self) -> &View {
        &self.0.wrapper
    }
}
