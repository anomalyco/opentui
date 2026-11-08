use super::{Behavior, Callbacks, Element, build, handle, keymap_methods};
use crate::app::{App, Cx};
use crate::input::{KeyEvent, Keymap, MouseButton, MouseEvent, MouseEventKind};
use crate::native::{NodeKind, SliderOptions};
use crate::style::Color;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

/// What a key does in a [`Slider`]. Bind keys to actions with [`Slider::bind`], or run one with
/// [`Slider::perform`].
///
/// Arrow actions follow the slider's direction and do nothing across it, so Up and Down pass a horizontal slider by
/// to its ancestors.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SliderAction {
    /// One step toward the minimum, on a horizontal slider.
    Left,
    /// One step toward the maximum, on a horizontal slider.
    Right,
    /// One step toward the minimum, on a vertical slider.
    Up,
    /// One step toward the maximum, on a vertical slider.
    Down,
    /// Five steps toward the minimum.
    PageDecrease,
    /// Five steps toward the maximum.
    PageIncrease,
    Min,
    Max,
}

pub(crate) struct SliderInner {
    element: Element,
    options: Cell<SliderOptions>,
    step: Cell<Option<f64>>,
    /// While dragging: where in the thumb the drag started, in half cells.
    drag: Cell<Option<f64>>,
    on_change: Callbacks<f64>,
    keymap: RefCell<Keymap<SliderAction>>,
}

impl SliderInner {
    fn publish(&self) {
        let options = self.options.get();
        self.element.apply(|node| node.set_slider(&options));
    }

    /// Clamps and applies a value. Returns whether it changed.
    fn set(&self, value: f64) -> bool {
        let mut options = self.options.get();
        let value = if options.max >= options.min { value.clamp(options.min, options.max) } else { options.min };
        if value == options.value || !value.is_finite() {
            return false;
        }
        options.value = value;
        self.options.set(options);
        self.publish();
        true
    }

    fn set_and_notify(&self, cx: &mut Cx<'_>, value: f64) {
        if self.set(value) {
            self.on_change.emit(cx, &self.options.get().value);
        }
    }

    /// The track's start along the slider and its length, in cells, plus the pointer position along it.
    fn track(&self, event: &MouseEvent) -> (f64, f64) {
        let rect = self.element.rect();
        if self.options.get().vertical {
            (f64::from(event.y) - rect.screen_y.floor(), f64::from(rect.height))
        } else {
            (f64::from(event.x) - rect.screen_x.floor(), f64::from(rect.width))
        }
    }

    fn thumb(&self) -> (f64, f64) {
        self.element.query(|node| node.slider_thumb()).unwrap_or((0.0, 0.0))
    }

    fn value_at(&self, event: &MouseEvent, offset: f64) -> f64 {
        let (position, length) = self.track(event);
        let options = self.options.get();
        let (size, _) = self.thumb();
        let virtual_position = position.clamp(0.0, length) * 2.0;
        let max_start = (length * 2.0 - size).max(0.0);
        let start = (virtual_position - offset).clamp(0.0, max_start);
        let ratio = if max_start == 0.0 { 0.0 } else { start / max_start };
        options.min + ratio * (options.max - options.min)
    }

    /// Runs an action. Returns `false` for an arrow across the slider's direction.
    fn run(&self, cx: &mut Cx<'_>, action: SliderAction) -> bool {
        let options = self.options.get();
        let step = self.step_size();
        let value = match (action, options.vertical) {
            (SliderAction::Left, false) | (SliderAction::Up, true) => options.value - step,
            (SliderAction::Right, false) | (SliderAction::Down, true) => options.value + step,
            (SliderAction::Left | SliderAction::Right | SliderAction::Up | SliderAction::Down, _) => return false,
            (SliderAction::PageDecrease, _) => options.value - step * 5.0,
            (SliderAction::PageIncrease, _) => options.value + step * 5.0,
            (SliderAction::Min, _) => options.min,
            (SliderAction::Max, _) => options.max,
        };
        self.set_and_notify(cx, value);
        true
    }

    fn step_size(&self) -> f64 {
        let options = self.options.get();
        self.step.get().unwrap_or(((options.max - options.min) / 20.0).abs().max(f64::EPSILON))
    }
}

impl Behavior for SliderInner {
    fn element(&self) -> &Element {
        &self.element
    }

    fn teardown(&self) {
        self.on_change.clear();
    }

    fn key(&self, cx: &mut Cx<'_>, key: &KeyEvent) -> bool {
        let action = self.keymap.borrow().get(key);
        action.is_some_and(|action| self.run(cx, action))
    }

    fn mouse(&self, cx: &mut Cx<'_>, event: &MouseEvent) -> bool {
        match event.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                let (position, length) = self.track(event);
                let (size, start) = self.thumb();
                let virtual_position = position.clamp(0.0, length) * 2.0;
                if !(start..start + size.max(2.0)).contains(&virtual_position) {
                    // Jump so the pointer lands at the same spot of the thumb, then drag from there.
                    let options = self.options.get();
                    let ratio = if length == 0.0 { 0.0 } else { position.clamp(0.0, length) / length };
                    self.set_and_notify(cx, options.min + ratio * (options.max - options.min));
                }
                let (size, start) = self.thumb();
                self.drag.set(Some((virtual_position - start).clamp(0.0, size)));
                true
            }
            MouseEventKind::Drag(MouseButton::Left) | MouseEventKind::Up(MouseButton::Left) => {
                let Some(offset) = self.drag.get() else { return false };
                let value = self.value_at(event, offset);
                self.set_and_notify(cx, value);
                if matches!(event.kind, MouseEventKind::Up(_)) {
                    self.drag.set(None);
                }
                true
            }
            MouseEventKind::ScrollUp | MouseEventKind::ScrollLeft => {
                let value = self.options.get().value - self.step_size();
                self.set_and_notify(cx, value);
                true
            }
            MouseEventKind::ScrollDown | MouseEventKind::ScrollRight => {
                let value = self.options.get().value + self.step_size();
                self.set_and_notify(cx, value);
                true
            }
            _ => false,
        }
    }
}

/// A draggable value between a minimum and a maximum, drawn with half-cell precision.
///
/// Arrow keys step by a twentieth of the range unless [`Self::step`] says otherwise; Page Up/Down step five times
/// as far, and Home/End jump to the ends. [`Self::bind`] changes the keys.
///
/// ```no_run
/// # use opentui::prelude::*;
/// # let app = App::new(AppOptions::default())?;
/// let volume = Slider::new(&app).range(0.0, 100.0).set_value(40.0).width(20).height(1);
/// volume.on_change(|_cx, value| eprintln!("volume {value:.0}"));
/// # Ok::<(), opentui::Error>(())
/// ```
#[derive(Clone)]
pub struct Slider(Rc<SliderInner>);

handle!(Slider, SliderInner);

impl Slider {
    pub fn new(app: &App) -> Self {
        let theme = app.theme();
        let options = SliderOptions { fg: theme.thumb, bg: theme.track, ..Default::default() };
        let slider = Self(build(app, NodeKind::Slider, |element| SliderInner {
            element,
            options: Cell::new(options),
            step: Cell::new(None),
            drag: Cell::new(None),
            on_change: Callbacks::default(),
            keymap: RefCell::new(Self::default_keymap()),
        }));
        slider.0.element.set_focusable(true);
        slider.0.element.set_layout(crate::layout::LayoutProperty::FlexShrink(0.0));
        slider.0.publish();
        slider
    }

    /// The key bindings a new slider starts with.
    pub fn default_keymap() -> Keymap<SliderAction> {
        use SliderAction as A;
        Keymap::new()
            .bind("left", A::Left)
            .bind("right", A::Right)
            .bind("up", A::Up)
            .bind("down", A::Down)
            .bind("pageup", A::PageDecrease)
            .bind("pagedown", A::PageIncrease)
            .bind("home", A::Min)
            .bind("end", A::Max)
    }

    keymap_methods!(SliderAction);

    /// Runs an action as its key would, including change handlers.
    pub fn perform(&self, action: SliderAction) -> Self {
        if let Some(app) = self.0.element.app() {
            self.0.run(&mut Cx::new(&app), action);
        }
        self.clone()
    }

    fn update(&self, change: impl FnOnce(&mut SliderOptions)) -> Self {
        let mut options = self.0.options.get();
        change(&mut options);
        self.0.options.set(options);
        self.0.publish();
        self.clone()
    }

    pub fn vertical(&self) -> Self {
        self.update(|options| options.vertical = true)
    }

    pub fn horizontal(&self) -> Self {
        self.update(|options| options.vertical = false)
    }

    /// Sets the range, clamps the value into it, and resets [`Self::thumb_size`] to a tenth of the range, at least 1
    /// and at most the whole range. Reversed bounds are swapped; a range with a bound that is not finite is ignored.
    pub fn range(&self, min: f64, max: f64) -> Self {
        if !min.is_finite() || !max.is_finite() {
            return self.clone();
        }
        let (min, max) = if min <= max { (min, max) } else { (max, min) };
        self.update(|options| {
            options.min = min;
            options.max = max;
            options.value = options.value.clamp(min, max);
            options.viewport_size = ((max - min) * 0.1).max(1.0).min((max - min).max(0.01));
        })
    }

    /// Sets the value, clamped to the range. Does not call change handlers.
    pub fn set_value(&self, value: f64) -> Self {
        self.0.set(value);
        self.clone()
    }

    pub fn value(&self) -> f64 {
        self.0.options.get().value
    }

    /// The thumb's share of the range, in the range's units, like a scrollbar's visible size.
    pub fn thumb_size(&self, size: f64) -> Self {
        self.update(|options| options.viewport_size = size)
    }

    /// The keyboard and wheel step. A step that is not positive and finite is ignored.
    pub fn step(&self, step: f64) -> Self {
        if step.is_finite() && step > 0.0 {
            self.0.step.set(Some(step));
        }
        self.clone()
    }

    /// Thumb and track colors.
    pub fn colors(&self, thumb: Color, track: Color) -> Self {
        self.update(|options| (options.fg, options.bg) = (thumb, track))
    }

    /// Called when the user changes the value, with the new value.
    pub fn on_change(&self, mut handler: impl FnMut(&mut Cx<'_>, f64) + 'static) -> Self {
        self.0.on_change.add(move |cx, value: &f64| handler(cx, *value));
        self.clone()
    }

    pub(crate) fn options(&self) -> SliderOptions {
        self.0.options.get()
    }

    pub(crate) fn set_options(&self, options: SliderOptions) {
        if options != self.0.options.get() {
            self.0.options.set(options);
            self.0.publish();
        }
    }
}
