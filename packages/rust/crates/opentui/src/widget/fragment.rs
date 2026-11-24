use super::{Behavior, Container, Element, build, handle};
use crate::app::App;
use std::rc::Rc;

pub(crate) struct FragmentInner {
    element: Element,
}

impl Behavior for FragmentInner {
    fn element(&self) -> &Element {
        &self.element
    }
}

/// A run of siblings with no box of its own: its children lay out, paint, take focus and receive clicks as children
/// of the fragment's parent, at the fragment's position.
///
/// The parent holds the fragment as one child, so [`Container::insert`], [`Widget::detach`](super::Widget::detach)
/// and moving it to another parent take its whole run along. Fragments nest. Children added to a detached fragment
/// appear when it is attached. Keys, pastes and mouse events bubble from its children through its handlers to its
/// parent.
///
/// With no box, a fragment has no geometry: [`Widget::rect`](super::Widget::rect) is empty, and the layout, paint,
/// filter, [`visible`](super::Widget::visible), [`focusable`](super::Widget::focusable), `on_click` and `on_resize`
/// methods do nothing on it, nor does [`ScrollBox::scroll_into_view`](super::ScrollBox::scroll_into_view). Use its
/// children instead.
///
/// ```no_run
/// # use opentui::prelude::*;
/// # let app = App::new(AppOptions::default())?;
/// let extras = Fragment::new(&app).child(&Text::new(&app, "b")).child(&Text::new(&app, "c"));
/// let row = View::new(&app).row().child(&Text::new(&app, "a")).child(&extras).child(&Text::new(&app, "d"));
/// app.root().add(&row);
/// // Shows "abcd". Detaching the fragment removes "b" and "c" together.
/// extras.detach();
/// # Ok::<(), opentui::Error>(())
/// ```
#[derive(Clone)]
pub struct Fragment(Rc<FragmentInner>);

handle!(Fragment, FragmentInner);

impl Container for Fragment {}

impl Fragment {
    pub fn new(app: &App) -> Self {
        Self(build(app, None, |element| FragmentInner { element }))
    }
}
