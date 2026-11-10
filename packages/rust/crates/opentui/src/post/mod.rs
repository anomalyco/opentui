//! Post-processing: color matrices, filters, and animated effects, ported from OpenTUI Core's `post/` modules.
//!
//! A [`Filter`] changes cells after native code paints a frame and before the frame is presented, as Core's
//! post-process functions do. Attach one to a widget with [`Widget::filter`](crate::widget::Widget::filter) to
//! change the widget's area, cut by its ancestors' clips, or to [`App::root`](crate::App::root) to change the whole
//! screen:
//!
//! ```no_run
//! use opentui::post::{CrtRollingBar, Scanlines, Vignette};
//! use opentui::prelude::*;
//!
//! # fn main() -> opentui::Result<()> {
//! let app = App::new(AppOptions::default())?;
//! let monitor = View::new(&app).border(BorderStyle::Rounded).grow(1.0);
//! monitor.filter(ColorMatrix::GREENSCALE).filter(Scanlines::default()).filter(Vignette::new(0.6));
//! app.root().add(&monitor).filter(CrtRollingBar::default());
//! app.run()
//! # }
//! ```
//!
//! Filters run on the finished frame, so a widget's filters also change whatever other widgets draw over its area,
//! such as a dialog. A widget's filters run after those of its descendants, and the root's run last. To change
//! colors at a point in paint order instead, use [`Painter::color_matrix`](crate::widget::Painter::color_matrix)
//! from a [`Component`](crate::widget::Component).
//!
//! Color matrices run in native code. Filters that read cells (chromatic aberration, ASCII art, bloom, flames,
//! rainbow text, distortion, and the vignette's grapheme handling) work on the frame's cells directly. Animated
//! effects keep frames coming through [`App::animate`](crate::App::animate) while they are attached.

mod effects;
mod filters;
mod matrix;
mod noise;

pub use effects::{Clouds, CrtRollingBar, Distortion, Flames, RainbowText, Vignette};
pub use filters::{AsciiArt, Bloom, ChromaticAberration, Noise, Scanlines};
pub use matrix::{Channels, ColorMatrix};

use crate::error::{Error, Result};
use crate::native::{Draft, Lease, Planes};
use crate::style::Color;
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

/// Post-processing for a frame: it changes the cells of a [`Surface`] after native code paints them.
///
/// Implement it for your own filters, or wrap a closure with [`from_fn`]. A shared `Rc<RefCell<F>>` is a filter too,
/// so the app can keep a handle and change parameters while the filter is attached:
///
/// ```no_run
/// use opentui::post::Vignette;
/// use opentui::prelude::*;
/// use std::{cell::RefCell, rc::Rc};
///
/// # let app = App::new(AppOptions::default())?;
/// let vignette = Rc::new(RefCell::new(Vignette::new(0.3)));
/// app.root().filter(vignette.clone());
/// // Later:
/// vignette.borrow_mut().strength = 0.8;
/// app.request_redraw();
/// # Ok::<(), opentui::Error>(())
/// ```
pub trait Filter: 'static {
    /// Changes the surface's cells. `elapsed` is the animation time since the filter's previous frame; it stays zero
    /// unless [`Self::animated`] is true.
    fn apply(&mut self, surface: &mut Surface<'_>, elapsed: Duration);

    /// Whether the filter changes over time. While an animated filter is attached, the app paints frames
    /// continuously, up to [`AppOptions::max_fps`](crate::AppOptions::max_fps), and passes their time to
    /// [`Self::apply`]. Read once, when the filter is attached.
    fn animated(&self) -> bool {
        false
    }
}

impl<F: Filter> Filter for Rc<RefCell<F>> {
    fn apply(&mut self, surface: &mut Surface<'_>, elapsed: Duration) {
        if let Ok(mut filter) = self.try_borrow_mut() {
            filter.apply(surface, elapsed);
        }
    }

    fn animated(&self) -> bool {
        self.try_borrow().is_ok_and(|filter| filter.animated())
    }
}

impl<F: Filter + ?Sized> Filter for Box<F> {
    fn apply(&mut self, surface: &mut Surface<'_>, elapsed: Duration) {
        (**self).apply(surface, elapsed);
    }

    fn animated(&self) -> bool {
        (**self).animated()
    }
}

/// A filter that calls a closure, made by [`from_fn`].
pub struct FromFn<F> {
    apply: F,
    animated: bool,
}

/// Makes a filter from a closure.
///
/// ```no_run
/// use opentui::post::from_fn;
/// use opentui::prelude::*;
///
/// # let app = App::new(AppOptions::default())?;
/// // Dim every other column.
/// app.root().filter(from_fn(|surface, _elapsed| {
///     surface.color_matrix_weighted(&ColorMatrix::gain(0.7), |x, _y| if x % 2 == 0 { 1.0 } else { 0.0 });
/// }));
/// # Ok::<(), opentui::Error>(())
/// ```
pub fn from_fn<F: FnMut(&mut Surface<'_>, Duration) + 'static>(apply: F) -> FromFn<F> {
    FromFn { apply, animated: false }
}

impl<F> FromFn<F> {
    /// Marks the filter as animated: frames keep coming while it is attached. See [`Filter::animated`].
    pub fn animated(self) -> Self {
        Self { animated: true, ..self }
    }
}

impl<F: FnMut(&mut Surface<'_>, Duration) + 'static> Filter for FromFn<F> {
    fn apply(&mut self, surface: &mut Surface<'_>, elapsed: Duration) {
        (self.apply)(surface, elapsed);
    }

    fn animated(&self) -> bool {
        self.animated
    }
}

impl<F> std::fmt::Debug for FromFn<F> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("FromFn").field("animated", &self.animated).finish_non_exhaustive()
    }
}

/// Names a filter attached with [`Widget::add_filter`](crate::widget::Widget::add_filter), for
/// [`Widget::remove_filter`](crate::widget::Widget::remove_filter).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct FilterId(pub(crate) u64);

/// One attached filter, with the animation time it has not consumed yet.
pub(crate) struct FilterCell {
    pub id: FilterId,
    pub filter: RefCell<Box<dyn Filter>>,
    pub elapsed: Cell<Duration>,
}

/// A rectangle of frame cells.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Area {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl Area {
    /// The cells of a signed rectangle that fall inside `bounds`.
    pub fn clipped(x: i64, y: i64, width: i64, height: i64, bounds: Area) -> Self {
        let left = x.max(i64::from(bounds.x));
        let top = y.max(i64::from(bounds.y));
        let right = (x + width).min(i64::from(bounds.x) + i64::from(bounds.width));
        let bottom = (y + height).min(i64::from(bounds.y) + i64::from(bounds.height));
        if right <= left || bottom <= top {
            return Self::default();
        }
        Self { x: left as u32, y: top as u32, width: (right - left) as u32, height: (bottom - top) as u32 }
    }

    pub fn is_empty(&self) -> bool {
        self.width == 0 || self.height == 0
    }

    fn cells(&self) -> usize {
        self.width as usize * self.height as usize
    }
}

/// Per-frame post-processing state the app keeps between frames, so filters reuse its buffers.
#[derive(Default)]
pub(crate) struct PostState {
    lease: Option<Lease>,
    mask: Vec<f32>,
    packed: Vec<u8>,
    error: Option<Error>,
}

impl PostState {
    /// Starts a frame, dropping a lease and error that a panicking filter may have left behind.
    pub fn begin(&mut self) {
        self.lease = None;
        self.error = None;
    }

    /// Releases the frame's cells and returns the first failure since [`Self::begin`].
    pub fn finish(&mut self) -> Result<()> {
        self.lease = None;
        self.error.take().map_or(Ok(()), Err)
    }
}

/// The cells one filter changes: a widget's painted area, or the whole screen.
///
/// Coordinates are local to the area: `(0, 0)` is its top-left cell. Color matrices run in native code; the cell
/// methods read and write the painted frame directly. Methods are infallible: a native failure ends the frame with
/// the error, which [`App::run`](crate::App::run) returns.
pub struct Surface<'a> {
    draft: &'a Draft,
    state: &'a mut PostState,
    area: Area,
    screen: (u32, u32),
}

/// The bytes of one cell for [`Draft::draw_packed`].
const PACKED_CELL: usize = 48;

impl<'a> Surface<'a> {
    pub(crate) fn new(draft: &'a Draft, state: &'a mut PostState, area: Area, screen: (u32, u32)) -> Self {
        Self { draft, state, area, screen }
    }

    /// The area's width in cells.
    pub fn width(&self) -> u32 {
        self.area.width
    }

    /// The area's height in cells.
    pub fn height(&self) -> u32 {
        self.area.height
    }

    /// The area's top-left cell on the screen.
    pub fn origin(&self) -> (u32, u32) {
        (self.area.x, self.area.y)
    }

    fn report(&mut self, result: Result<()>) {
        if let Err(error) = result
            && self.state.error.is_none()
        {
            self.state.error = Some(error);
        }
    }

    /// Transforms the colors of every cell in the area.
    ///
    /// ```
    /// use opentui::post::from_fn;
    /// use opentui::prelude::*;
    /// use opentui::testing::TestApp;
    ///
    /// let app = TestApp::new(4, 1);
    /// app.root().add(&Text::new(&app, "hi").fg(Color::rgb(200, 0, 0)));
    /// app.root().filter(from_fn(|surface, _| surface.color_matrix(&ColorMatrix::GRAYSCALE)));
    /// assert_eq!(app.render().cell(0, 0).unwrap().fg, Color::rgb(60, 60, 60));
    /// ```
    pub fn color_matrix(&mut self, matrix: &ColorMatrix) {
        if self.area.is_empty() {
            return;
        }
        let area = self.area;
        if area.x == 0 && area.y == 0 && (area.width, area.height) == self.screen {
            let result = self.draft.color_matrix(matrix, None);
            self.report(result);
        } else {
            self.color_matrix_weighted(matrix, |_, _| 1.0);
        }
    }

    /// Transforms the colors of the area's cells, each by the matrix's strength times its weight: 0 leaves a cell
    /// alone, 1 applies the matrix fully, and negative weights push colors the other way.
    pub fn color_matrix_weighted(&mut self, matrix: &ColorMatrix, mut weight: impl FnMut(u32, u32) -> f32) {
        let area = self.area;
        let mut mask = std::mem::take(&mut self.state.mask);
        mask.clear();
        for y in 0..area.height {
            for x in 0..area.width {
                let weight = weight(x, y);
                if weight != 0.0 {
                    mask.extend_from_slice(&[(area.x + x) as f32, (area.y + y) as f32, weight]);
                }
            }
        }
        let result = if mask.is_empty() { Ok(()) } else { self.draft.color_matrix(matrix, Some(&mask)) };
        self.state.mask = mask;
        self.report(result);
    }

    /// The frame's cells, leased on first use, with the area clipped to them.
    pub(crate) fn planes(&mut self) -> Option<(Planes<'_>, Area)> {
        if self.state.lease.is_none() {
            match self.draft.lease() {
                Ok(lease) => self.state.lease = Some(lease),
                Err(error) => {
                    self.report(Err(error));
                    return None;
                }
            }
        }
        let planes = self.state.lease.as_mut()?.planes();
        let bounds = Area { x: 0, y: 0, width: planes.width, height: planes.height };
        let area = self.area;
        let area =
            Area::clipped(i64::from(area.x), i64::from(area.y), i64::from(area.width), i64::from(area.height), bounds);
        Some((planes, area))
    }

    /// The plane index of a local cell, if it lies inside the area and the frame.
    fn index(&mut self, x: u32, y: u32) -> Option<(Planes<'_>, usize)> {
        // Clipping to the frame only moves the area's far edges, so local coordinates keep their origin.
        let (planes, area) = self.planes()?;
        if x >= area.width || y >= area.height {
            return None;
        }
        let index = (area.y + y) as usize * planes.width as usize + (area.x + x) as usize;
        Some((planes, index))
    }

    /// A cell's text color, or `None` outside the area.
    pub fn fg(&mut self, x: u32, y: u32) -> Option<Color> {
        let (planes, index) = self.index(x, y)?;
        Some(read_color(planes.fg, index))
    }

    /// A cell's background color, or `None` outside the area.
    pub fn bg(&mut self, x: u32, y: u32) -> Option<Color> {
        let (planes, index) = self.index(x, y)?;
        Some(read_color(planes.bg, index))
    }

    /// Sets a cell's text color. Outside the area, does nothing.
    pub fn set_fg(&mut self, x: u32, y: u32, color: Color) {
        if let Some((planes, index)) = self.index(x, y) {
            planes.fg[index * 4..index * 4 + 4].copy_from_slice(&color.to_raw());
        }
    }

    /// Sets a cell's background color. Outside the area, does nothing.
    pub fn set_bg(&mut self, x: u32, y: u32, color: Color) {
        if let Some((planes, index)) = self.index(x, y) {
            planes.bg[index * 4..index * 4 + 4].copy_from_slice(&color.to_raw());
        }
    }

    /// The character of a cell holding a plain character, such as ASCII text or a border glyph. `None` for the
    /// cells of pooled graphemes (see [`Self::is_grapheme`]), image cells, and cells outside the area.
    pub fn char(&mut self, x: u32, y: u32) -> Option<char> {
        let (planes, index) = self.index(x, y)?;
        let raw = planes.chars[index];
        if raw & CHAR_TYPE_MASK != 0 { None } else { char::from_u32(raw) }
    }

    /// Whether a cell holds part of a grapheme that native code keeps in its pool: text outside ASCII, such as an
    /// accented letter, a wide character, or an emoji, and the continuation cells of wide ones. A run of them should
    /// keep one style, or terminals may shape it differently.
    pub fn is_grapheme(&mut self, x: u32, y: u32) -> bool {
        self.index(x, y).is_some_and(|(planes, index)| is_cluster(planes.chars[index]))
    }

    /// Replaces every cell of the area with the character and colors `cell` returns for it, through native packed
    /// drawing, which releases any grapheme a cell held. Characters other than printable ASCII and single-width block
    /// and border glyphs draw as a full block. Attributes and links are cleared.
    pub fn draw_cells(&mut self, mut cell: impl FnMut(u32, u32) -> (char, Color, Color)) {
        let area = self.area;
        if area.is_empty() {
            return;
        }
        let mut packed = std::mem::take(&mut self.state.packed);
        packed.clear();
        packed.reserve(area.cells() * PACKED_CELL);
        for y in 0..area.height {
            for x in 0..area.width {
                let (character, fg, bg) = cell(x, y);
                for color in [bg, fg] {
                    for channel in [color.r, color.g, color.b, color.a] {
                        packed.extend_from_slice(&(f32::from(channel) / 255.0).to_ne_bytes());
                    }
                }
                packed.extend_from_slice(&u32::from(character).to_ne_bytes());
                packed.extend_from_slice(&[0; 12]);
            }
        }
        let result = self.draft.draw_packed(&packed, area.x as i32, area.y as i32, area.width, area.height);
        self.state.packed = packed;
        self.report(result);
    }
}

impl std::fmt::Debug for Surface<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Surface").field("area", &self.area).finish_non_exhaustive()
    }
}

/// The high bits that mark pooled graphemes (`10`), their continuation cells (`11`), and image cells (`01`).
const CHAR_TYPE_MASK: u32 = 0xc000_0000;

/// Whether a raw character names a pooled grapheme or one of its continuation cells.
pub(crate) fn is_cluster(raw: u32) -> bool {
    raw & 0x8000_0000 != 0
}

/// Whether a raw character is anything but a plain character.
pub(crate) fn is_pooled(raw: u32) -> bool {
    raw & CHAR_TYPE_MASK != 0
}

fn read_color(plane: &[u16], index: usize) -> Color {
    Color::from_raw(plane[index * 4..index * 4 + 4].try_into().expect("four color words"))
}

/// A color channel from 0 to 1, as Core reads raw planes.
pub(crate) fn channel(plane: &[u16], index: usize) -> f64 {
    f64::from(plane[index] & 0xff) / 255.0
}

/// Core's `toU8`: clamps a channel, scales it to a byte, and rounds half up.
pub(crate) fn to_u8(value: f64) -> u16 {
    let value = if value.is_finite() { value.clamp(0.0, 1.0) } else { 0.0 };
    js_round(value * 255.0) as u16
}

/// JavaScript's `Math.round`: halves round toward positive infinity.
pub(crate) fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// Core's `setRgb`: writes an RGB color into one cell of a plane, keeping its alpha.
pub(crate) fn set_rgb(plane: &mut [u16], index: usize, r: f64, g: f64, b: f64) {
    let base = index * 4;
    let alpha = plane[base + 3] & 0xff;
    plane[base] = to_u8(r);
    plane[base + 1] = to_u8(g);
    plane[base + 2] = to_u8(b);
    plane[base + 3] = alpha;
}
