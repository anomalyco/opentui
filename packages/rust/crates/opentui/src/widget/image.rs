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

    /// Forces a protocol, for example [`ImageProtocol::Blocks`] for terminals that misreport graphics support.
    pub fn protocol(&self, protocol: ImageProtocol) -> Self {
        self.0.protocol.set(protocol);
        self.0.publish();
        self.clone()
    }
}
