use super::{Behavior, Container, Element, build, handle};
use crate::app::App;
use crate::native::NodeKind;
use crate::style::{Alignment, BorderStyle, Color, Sides};
use std::cell::Cell;
use std::rc::Rc;

pub(crate) struct ViewInner {
    element: Element,
    /// Whether [`View::border_color`] set the border color, which a border then keeps instead of the theme's.
    border_color_set: Cell<bool>,
}

impl Behavior for ViewInner {
    fn element(&self) -> &Element {
        &self.element
    }
}

/// A flexbox container with an optional border, titles, and background.
///
/// ```no_run
/// # use opentui::prelude::*;
/// # let app = App::new(AppOptions::default())?;
/// let panel = View::new(&app)
///     .border(BorderStyle::Rounded)
///     .title(" Details ")
///     .padding_x(1)
///     .row()
///     .gap(2)
///     .child(&Text::new(&app, "left"))
///     .child(&Text::new(&app, "right"));
/// app.root().add(&panel);
/// # Ok::<(), opentui::Error>(())
/// ```
#[derive(Clone)]
pub struct View(Rc<ViewInner>);

handle!(View, ViewInner);

impl Container for View {}

impl View {
    pub fn new(app: &App) -> Self {
        Self(build(app, NodeKind::Box, |element| ViewInner { element, border_color_set: Cell::new(false) }))
    }

    pub(crate) fn root(app: &App) -> Self {
        Self(build(app, NodeKind::Root, |element| ViewInner { element, border_color_set: Cell::new(false) }))
    }

    /// Draws a border on all four sides, in the theme's border color unless set with [`Self::border_color`].
    pub fn border(&self, style: BorderStyle) -> Self {
        let color = self.border_color_or_theme();
        self.0.element.update_paint(|paint| {
            paint.border_color = color.unwrap_or(paint.border_color);
            paint.border = Sides::ALL;
            paint.border_style = style;
        });
        self.clone()
    }

    /// Draws the border with your own single-cell glyphs, in [`BorderStyle::chars`] order, instead of the border
    /// style's; `None` goes back to the style's.
    pub fn border_chars(&self, chars: Option<[char; 11]>) -> Self {
        self.0.element.update_titles(|titles| titles.border_chars = chars);
        self.clone()
    }

    /// Chooses which sides draw a border.
    pub fn border_sides(&self, sides: Sides) -> Self {
        let color = self.border_color_or_theme();
        self.0.element.update_paint(|paint| {
            paint.border_color = color.unwrap_or(paint.border_color);
            paint.border = sides;
        });
        self.clone()
    }

    /// The border color, before or after the border is set; the theme's border color by default.
    pub fn border_color(&self, color: Color) -> Self {
        self.0.border_color_set.set(true);
        self.0.element.update_paint(|paint| paint.border_color = color);
        self.clone()
    }

    /// The border style of each side in `sides`, over the style [`Self::border`] set; `None` lets them take that
    /// style again. It draws no side: [`Self::border`] and [`Self::border_sides`] choose which sides draw.
    ///
    /// Where sides of unlike styles meet, the corner takes Unicode's mixed single/double or light/heavy glyph
    /// (rounded lines are light), otherwise the top or bottom side's corner. Glyphs from [`Self::border_chars`] win.
    ///
    /// ```no_run
    /// # use opentui::prelude::*;
    /// # let app = App::new(AppOptions::default())?;
    /// // ╒══════╕
    /// // │      │
    /// // └──────┘
    /// let panel = View::new(&app).border(BorderStyle::Single).border_style_for(Sides::TOP, Some(BorderStyle::Double));
    /// # Ok::<(), opentui::Error>(())
    /// ```
    pub fn border_style_for(&self, sides: Sides, style: Option<BorderStyle>) -> Self {
        self.0.element.update_box_sides(|box_sides| box_sides.style(sides, style));
        self.clone()
    }

    /// The border color of each side in `sides`, over [`Self::border_color`]; `None` lets them take that color
    /// again. A corner takes its top or bottom side's color; a title without [`Self::title_color`] takes its own
    /// side's. While focused, [`Self::focus_border_color`] colors every side.
    pub fn border_color_for(&self, sides: Sides, color: Option<Color>) -> Self {
        self.0.element.update_box_sides(|box_sides| box_sides.color(sides, color));
        self.clone()
    }

    /// The border color while this view or a descendant has focus. Makes the view track focus.
    pub fn focus_border_color(&self, color: Color) -> Self {
        self.0.element.update_paint(|paint| {
            paint.focusable = true;
            paint.focused_border_color = color;
        });
        self.clone()
    }

    /// Highlights the border in the theme's focus color while a descendant has focus.
    pub fn highlight_focus(&self) -> Self {
        let color = self.0.element.app().map_or(Color::rgb(0, 170, 255), |app| app.theme().focus);
        self.focus_border_color(color)
    }

    /// Fills the view's area with a background color.
    pub fn bg(&self, color: Color) -> Self {
        self.0.element.update_paint(|paint| {
            paint.fill = true;
            paint.background = color;
        });
        self.clone()
    }

    /// A single-row title on the top border.
    pub fn title(&self, title: impl Into<String>) -> Self {
        let title = title.into();
        self.0.element.update_titles(|titles| titles.title = title);
        self.clone()
    }

    pub fn title_alignment(&self, alignment: Alignment) -> Self {
        self.0.element.update_titles(|titles| titles.title_alignment = alignment);
        self.clone()
    }

    /// A single-row title on the bottom border.
    pub fn bottom_title(&self, title: impl Into<String>) -> Self {
        let title = title.into();
        self.0.element.update_titles(|titles| titles.bottom_title = title);
        self.clone()
    }

    pub fn bottom_title_alignment(&self, alignment: Alignment) -> Self {
        self.0.element.update_titles(|titles| titles.bottom_title_alignment = alignment);
        self.clone()
    }

    /// The titles' color; the border color by default.
    pub fn title_color(&self, color: Color) -> Self {
        self.0.element.update_titles(|titles| titles.title_color = Some(color));
        self.clone()
    }

    /// The theme's border color, unless [`Self::border_color`] chose one.
    fn border_color_or_theme(&self) -> Option<Color> {
        if self.0.border_color_set.get() {
            return None;
        }
        Some(self.0.element.app().map_or(Color::rgb(255, 255, 255), |app| app.theme().border))
    }
}
