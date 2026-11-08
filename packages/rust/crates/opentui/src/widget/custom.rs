use super::{Behavior, Container, Element, Painter, build};
use crate::app::{App, Cx};
use crate::input::{KeyEvent, MouseEvent};
use crate::native::{Constraint, Hooks, Measure, NodeKind};
use std::cell::RefCell;
use std::rc::Rc;

/// Behavior for a widget you paint yourself. Wrap it in [`Custom`] to place it in the tree.
///
/// The widget is a box: it lays out like a [`View`](super::View), can have children, and paints them over what
/// [`Self::paint`] draws.
///
/// ```no_run
/// use opentui::prelude::*;
///
/// struct Meter {
///     level: f32,
/// }
///
/// impl Component for Meter {
///     fn paint(&self, painter: &mut Painter<'_>) {
///         let filled = (painter.width() as f32 * self.level) as u32;
///         painter.fill(0, 0, filled, 1, Color::GREEN);
///         painter.text(0, 0, &format!("{:.0}%", self.level * 100.0), Style::new().fg(Color::BLACK));
///     }
///
///     fn key(&mut self, _cx: &mut Cx<'_>, key: &KeyEvent) -> bool {
///         let step = if key.matches("right") { 0.1 } else if key.matches("left") { -0.1 } else { return false };
///         self.level = (self.level + step).clamp(0.0, 1.0);
///         true
///     }
/// }
///
/// # fn build(app: &App) {
/// let meter = Custom::new(app, Meter { level: 0.5 }).height(1).grow(1.0).focusable(true);
/// meter.update(|meter| meter.level = 0.75);
/// # }
/// ```
pub trait Component: 'static {
    /// Records drawing. Coordinates are local to the widget.
    fn paint(&self, painter: &mut Painter<'_>);

    /// Handles a key while the widget or a descendant has focus. Returns whether it consumed the key; the widget
    /// repaints after a consumed key.
    fn key(&mut self, _cx: &mut Cx<'_>, _key: &KeyEvent) -> bool {
        false
    }

    fn paste(&mut self, _cx: &mut Cx<'_>, _text: &str) -> bool {
        false
    }

    /// Handles a mouse event. `local` is the pointer relative to the widget's top-left cell; it can be negative or
    /// past the edges while dragging. The widget repaints after a consumed event.
    fn mouse(&mut self, _cx: &mut Cx<'_>, _event: &MouseEvent, _local: (i32, i32)) -> bool {
        false
    }

    fn focus_changed(&mut self, _cx: &mut Cx<'_>, _focused: bool) {}

    /// The widget's size for the space layout offers, for widgets made with [`Custom::measured`]. Runs inside native
    /// layout, so it must not change other widgets.
    fn measure(&self, width: Constraint, height: Constraint) -> (f32, f32) {
        (width.apply(0.0), height.apply(0.0))
    }
}

pub(crate) struct CustomInner<T: Component> {
    element: Element,
    component: RefCell<T>,
    measured: bool,
}

impl<T: Component> Measure for CustomInner<T> {
    fn measure(&self, width: Constraint, height: Constraint) -> (f32, f32) {
        self.component.try_borrow().map_or((0.0, 0.0), |component| component.measure(width, height))
    }
}

impl<T: Component> CustomInner<T> {
    fn handled(&self, consumed: bool) -> bool {
        if consumed {
            self.element.app().inspect(App::request_redraw);
        }
        consumed
    }
}

impl<T: Component> Behavior for CustomInner<T> {
    fn element(&self) -> &Element {
        &self.element
    }

    fn key(&self, cx: &mut Cx<'_>, key: &KeyEvent) -> bool {
        let consumed = self.component.try_borrow_mut().is_ok_and(|mut component| component.key(cx, key));
        self.handled(consumed)
    }

    fn paste(&self, cx: &mut Cx<'_>, text: &str) -> bool {
        let consumed = self.component.try_borrow_mut().is_ok_and(|mut component| component.paste(cx, text));
        self.handled(consumed)
    }

    fn mouse(&self, cx: &mut Cx<'_>, event: &MouseEvent) -> bool {
        let rect = self.element.rect();
        let local =
            (i32::from(event.x) - rect.screen_x.floor() as i32, i32::from(event.y) - rect.screen_y.floor() as i32);
        let consumed = self.component.try_borrow_mut().is_ok_and(|mut component| component.mouse(cx, event, local));
        self.handled(consumed)
    }

    fn focus_changed(&self, cx: &mut Cx<'_>, focused: bool) {
        if let Ok(mut component) = self.component.try_borrow_mut() {
            component.focus_changed(cx, focused);
        }
        self.element.app().inspect(App::request_redraw);
    }

    fn paint(&self, painter: &mut Painter<'_>) {
        if let Ok(component) = self.component.try_borrow() {
            component.paint(painter);
        }
    }
}

/// A widget painted by a [`Component`].
pub struct Custom<T: Component>(Rc<CustomInner<T>>);

impl<T: Component> Clone for Custom<T> {
    fn clone(&self) -> Self {
        Self(Rc::clone(&self.0))
    }
}

impl<T: Component> super::Widget for Custom<T> {
    fn element(&self) -> &Element {
        &self.0.element
    }
}

impl<T: Component> Container for Custom<T> {}

impl<T: Component> std::fmt::Debug for Custom<T> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_tuple("Custom").field(&self.0.element.id()).finish()
    }
}

impl<T: Component> Custom<T> {
    pub fn new(app: &App, component: T) -> Self {
        Self::create(app, component, false)
    }

    /// A widget sized by [`Component::measure`] when its width or height is not set. It cannot have children.
    pub fn measured(app: &App, component: T) -> Self {
        Self::create(app, component, true)
    }

    fn create(app: &App, component: T, measured: bool) -> Self {
        let custom = Self(build(app, NodeKind::Box, |element| CustomInner {
            element,
            component: RefCell::new(component),
            measured,
        }));
        custom.0.element.add_hooks(Hooks::RENDER_AFTER);
        if measured {
            let weak = Rc::downgrade(&custom.0);
            let measurer: std::rc::Weak<dyn Measure> = weak;
            custom.0.element.apply(|node| node.set_measure(Some(measurer)));
        }
        custom
    }

    /// Reads the component.
    ///
    /// # Panics
    ///
    /// Panics if called while [`Self::update`] or one of the component's own event methods runs on this widget.
    pub fn with<R>(&self, read: impl FnOnce(&T) -> R) -> R {
        read(&self.0.component.borrow())
    }

    /// Changes the component and repaints the widget. A measured widget is measured again.
    ///
    /// # Panics
    ///
    /// Panics if called while the component is in use on this widget: from inside [`Self::with`] or another
    /// `update`, or from a handler that runs during one of the component's own methods, such as
    /// [`Component::key`].
    pub fn update<R>(&self, change: impl FnOnce(&mut T) -> R) -> R {
        let result = change(&mut self.0.component.borrow_mut());
        if self.0.measured {
            self.0.element.apply(|node| node.mark_dirty());
        }
        self.0.element.app().inspect(App::request_redraw);
        result
    }
}
