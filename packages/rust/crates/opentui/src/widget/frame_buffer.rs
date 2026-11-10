use super::{Behavior, Element, build, handle};
use crate::app::{App, Cx};
use crate::error::Result;
use crate::layout::{LayoutProperty, Length};
use crate::native::{Buffer, NodeKind};
use std::rc::Rc;

pub(crate) struct FrameBufferInner {
    element: Element,
    buffer: Option<Buffer>,
}

impl Behavior for FrameBufferInner {
    fn element(&self) -> &Element {
        &self.element
    }

    fn resized(&self, cx: &mut Cx<'_>, width: u32, height: u32) {
        if let Some(buffer) = &self.buffer
            && width > 0
            && height > 0
            && buffer.size() != (width, height)
        {
            cx.report(buffer.resize(width, height));
        }
    }
}

/// A grid of cells you draw into yourself, for games, charts, and other free-form drawing. Core calls it
/// `FrameBufferRenderable`.
///
/// Native code shows the cells where the widget is laid out each frame; nothing is redrawn unless you draw. The
/// buffer follows the widget's size, and a new size clears it, so redraw from
/// [`Widget::on_resize`](super::Widget::on_resize) when the size can change.
///
/// ```no_run
/// # use opentui::prelude::*;
/// # use opentui::widget::FrameBuffer;
/// # let app = App::new(AppOptions::default())?;
/// let canvas = FrameBuffer::new(&app, 20, 5);
/// canvas.draw(|buffer| {
///     buffer.clear(Color::BLACK)?;
///     buffer.text(2, 2, "drawn by hand", Style::new().fg(Color::GREEN))
/// });
/// app.root().add(&canvas);
/// # Ok::<(), opentui::Error>(())
/// ```
#[derive(Clone)]
pub struct FrameBuffer(Rc<FrameBufferInner>);

handle!(FrameBuffer, FrameBufferInner);

impl FrameBuffer {
    /// A `width` by `height` buffer of blank cells; the widget takes that size unless its layout says otherwise.
    pub fn new(app: &App, width: u16, height: u16) -> Self {
        Self::create(app, width, height, false)
    }

    /// Like [`Self::new`], but cells blend over what is below by their alpha, so a transparent background shows the
    /// widgets under it. Core calls this `respectAlpha`.
    pub fn with_alpha(app: &App, width: u16, height: u16) -> Self {
        Self::create(app, width, height, true)
    }

    fn create(app: &App, width: u16, height: u16, alpha: bool) -> Self {
        let (context, method) = (app.session().context(), app.width_method());
        let (cells_x, cells_y) = (u32::from(width.max(1)), u32::from(height.max(1)));
        let buffer = app.report(if alpha {
            Buffer::with_alpha(context, cells_x, cells_y, method)
        } else {
            Buffer::new(context, cells_x, cells_y, method)
        });
        let inner = build(app, NodeKind::Custom, |element| FrameBufferInner { element, buffer });
        inner.element.set_layout(LayoutProperty::Width(Length::Cells(f32::from(width))));
        inner.element.set_layout(LayoutProperty::Height(Length::Cells(f32::from(height))));
        inner.element.add_hooks(crate::native::Hooks::RESIZE);
        if let Some(buffer) = inner.buffer.clone() {
            inner.element.apply(move |node| node.set_surface(Some(&buffer)));
        }
        Self(inner)
    }

    /// The buffer, for drawing outside [`Self::draw`]; call [`App::request_redraw`] afterwards. `None` when native
    /// code could not create it, an error the app reports.
    pub fn buffer(&self) -> Option<Buffer> {
        self.0.buffer.clone()
    }

    /// Draws into the buffer and schedules a frame. The app reports a drawing error.
    pub fn draw(&self, draw: impl FnOnce(&Buffer) -> Result<()>) -> Self {
        if let (Some(buffer), Some(app)) = (&self.0.buffer, self.0.element.app()) {
            app.report(draw(buffer));
            app.request_redraw();
        }
        self.clone()
    }
}
