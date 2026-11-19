use super::{Behavior, Element, build, handle};
use crate::app::App;
use crate::error::Result;
use crate::native::{Image, ImageFit, ImageProtocol, NodeKind};
use std::cell::{Cell, RefCell};
use std::rc::Rc;

pub(crate) struct ImageInner {
    element: Element,
    image: RefCell<Option<Image>>,
    fit: Cell<ImageFit>,
    protocol: Cell<ImageProtocol>,
}

impl ImageInner {
    fn publish(&self) {
        let image = self.image.borrow().clone();
        let (fit, protocol) = (self.fit.get(), self.protocol.get());
        self.element.apply(|node| node.set_image(image.as_ref(), fit, protocol));
    }
}

impl Behavior for ImageInner {
    fn element(&self) -> &Element {
        &self.element
    }
}

/// A picture, drawn with the Kitty graphics protocol, Sixel, or half blocks, whichever the terminal supports best.
///
/// Give it a size; the image scales into it as [`Self::fit`] says.
///
/// ```no_run
/// # use opentui::prelude::*;
/// # use opentui::widget::ImageView;
/// # let app = App::new(AppOptions::default())?;
/// let logo = ImageView::new(&app).size(20, 10);
/// logo.load(&std::fs::read("logo.png")?)?;
/// # Ok::<(), Box<dyn std::error::Error>>(())
/// ```
#[derive(Clone)]
pub struct ImageView(Rc<ImageInner>);

handle!(ImageView, ImageInner);

impl ImageView {
    pub fn new(app: &App) -> Self {
        Self(build(app, NodeKind::Image, |element| ImageInner {
            element,
            image: RefCell::new(None),
            fit: Cell::new(ImageFit::Contain),
            protocol: Cell::new(ImageProtocol::Auto),
        }))
    }

    /// Decodes PNG, JPEG, WebP, or GIF bytes and shows the image.
    pub fn load(&self, bytes: &[u8]) -> Result<Self> {
        let context = self.0.element.app().map(|app| app.session().context().clone());
        let Some(context) = context else { return Ok(self.clone()) };
        let image = Image::decode(&context, bytes)?;
        Ok(self.image(Some(image)))
    }

    /// Shows a decoded image, or nothing.
    pub fn image(&self, image: Option<Image>) -> Self {
        *self.0.image.borrow_mut() = image;
        self.0.publish();
        self.clone()
    }

    pub fn fit(&self, fit: ImageFit) -> Self {
        self.0.fit.set(fit);
        self.0.publish();
        self.clone()
    }

    /// The terminal's cell aspect, which native paint fits the image with: the app Session's
    /// [`Session::cell_aspect`](crate::native::Session::cell_aspect), or 2 outside an app. Core's `cellAspectRatio`.
    pub fn cell_aspect(&self) -> f64 {
        self.0.element.app().map_or(2.0, |app| app.session().cell_aspect())
    }

    /// The size in cells the image takes in a `width` x `height` area whose cells are `cell_aspect` times as tall as
    /// they are wide ([`Self::cell_aspect`] for the terminal's), as Core's `ImageRenderable.getFittedSize` computes
    /// it: [`ImageFit::Contain`] keeps the aspect ratio inside the area, [`ImageFit::Cover`] keeps it while covering
    /// the area, so one side may be larger, and [`ImageFit::Fill`] takes the area. Each side is at least 1, and the
    /// size is not limited to the image's pixels. `(0, 0)` without an image or for an empty area.
    pub fn fitted_size(&self, width: u32, height: u32, cell_aspect: f64) -> (u32, u32) {
        let info = self.0.image.borrow().as_ref().and_then(|image| image.info().ok());
        let Some(info) = info.filter(|info| info.width > 0 && info.height > 0 && width > 0 && height > 0) else {
            return (0, 0);
        };
        let (width, height) = (f64::from(width), f64::from(height));
        let aspect = f64::from(info.width) / f64::from(info.height) * cell_aspect;
        let scale = match self.0.fit.get() {
            ImageFit::Fill => return (width as u32, height as u32),
            ImageFit::Contain => (width / aspect).min(height),
            ImageFit::Cover => (width / aspect).max(height),
        };
        ((aspect * scale).round().max(1.0) as u32, scale.round().max(1.0) as u32)
    }

    /// Forces a protocol, for example [`ImageProtocol::Blocks`] for terminals that misreport graphics support.
    pub fn protocol(&self, protocol: ImageProtocol) -> Self {
        self.0.protocol.set(protocol);
        self.0.publish();
        self.clone()
    }
}
