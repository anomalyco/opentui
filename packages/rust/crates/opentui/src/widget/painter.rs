use crate::error::{Error, Result};
use crate::native::{BoxSpec, Buffer, GridSpec, Hooks, PaintCell, PaintSlot, Phase, Recorder, TextView, WidthMethod};
use crate::post::ColorMatrix;
use crate::style::{Color, Style};

/// Records drawing for one widget during a frame.
///
/// Coordinates are local cells: `(0, 0)` is the widget's top-left corner. Drawing is clipped to the widget and its
/// ancestors' clips. Native code measures and draws glyphs; text that does not fit is cut off.
pub struct Painter<'a> {
    recorder: &'a mut Recorder,
    slot: &'a PaintSlot,
    /// The paint hooks the widget registered itself, which pick its phase.
    hooks: Hooks,
    width_method: WidthMethod,
    context: &'a crate::native::Context,
    /// The innermost [`Self::clip`] rectangle, in local cells.
    clip: Option<(i32, i32, u32, u32)>,
    started: bool,
    error: Option<Error>,
}

impl<'a> Painter<'a> {
    pub(crate) fn new(
        recorder: &'a mut Recorder,
        slot: &'a PaintSlot,
        hooks: Hooks,
        context: &'a crate::native::Context,
        width_method: WidthMethod,
    ) -> Self {
        Self { recorder, slot, hooks, width_method, context, clip: None, started: false, error: None }
    }

    pub(crate) fn finish(self) -> Result<()> {
        self.error.map_or(Ok(()), Err)
    }

    /// The widget's size in cells.
    pub fn size(&self) -> (u32, u32) {
        (self.slot.paint.width.max(0.0) as u32, self.slot.paint.height.max(0.0) as u32)
    }

    pub fn width(&self) -> u32 {
        self.size().0
    }

    pub fn height(&self) -> u32 {
        self.size().1
    }

    /// The part of the widget that drawing can reach, as local `(x, y, width, height)`: its area cut by its
    /// ancestors' clips, such as a scroll box's viewport. Drawing outside it is discarded, so large widgets can skip
    /// it.
    pub fn visible_rect(&self) -> (i32, i32, u32, u32) {
        let (left, top) = self.origin();
        let (width, height) = self.size();
        let (x, y, clip_width, clip_height) = self.slot.clip;
        let span = |start: i32, length: u32, origin: i32, size: u32| {
            let from = (i64::from(start) - i64::from(origin)).max(0);
            let to = (i64::from(start) + i64::from(length) - i64::from(origin)).min(i64::from(size));
            (from as i32, (to - from).max(0) as u32)
        };
        let ((x, width), (y, height)) = (span(x, clip_width, left, width), span(y, clip_height, top, height));
        (x, y, width, height)
    }

    /// The display width of `text` in cells, as native drawing measures it.
    pub fn text_width(&self, text: &str) -> u32 {
        self.context.text_width(text, self.width_method).unwrap_or(text.chars().count() as u32)
    }

    /// The widget's top-left screen cell.
    pub(crate) fn origin(&self) -> (i32, i32) {
        (self.slot.paint.screen_x.floor() as i32, self.slot.paint.screen_y.floor() as i32)
    }

    fn record(&mut self, command: impl FnOnce(&mut Recorder, (i32, i32)) -> Result<()>) {
        if self.error.is_some() {
            return;
        }
        let origin = self.origin();
        let result = (|| {
            if !self.started {
                // Native paint order: before the body, the body, then after. Use the latest phase the widget itself
                // registered; a filter's observing hook must not move the widget's drawing.
                let own = Hooks::from_bits(self.hooks.bits() & self.slot.hooks.bits());
                let hooks = if own.is_empty() { self.slot.hooks } else { own };
                let phase = if hooks.contains(Hooks::RENDER_AFTER) {
                    Phase::After
                } else if hooks.contains(Hooks::RENDER_SELF) {
                    Phase::Body
                } else {
                    Phase::Before
                };
                self.recorder.begin(self.slot.index, phase)?;
                let (width, height) = self.size();
                self.recorder.push_clip(origin.0, origin.1, width, height)?;
                self.started = true;
            }
            command(self.recorder, origin)
        })();
        if let Err(error) = result {
            self.error = Some(error);
        }
    }

    /// Draws one row of text. A missing foreground uses the terminal's default; a missing background keeps the
    /// cells' existing background.
    pub fn text(&mut self, x: i32, y: i32, text: &str, style: Style) {
        if text.is_empty() {
            return;
        }
        self.record(|recorder, (left, top)| recorder.text(left + x, top + y, text, style));
    }

    pub fn fill(&mut self, x: i32, y: i32, width: u32, height: u32, color: Color) {
        if width == 0 || height == 0 {
            return;
        }
        self.record(|recorder, (left, top)| recorder.fill(left + x, top + y, width, height, color));
    }

    /// Draws one single-cell character.
    pub fn cell(&mut self, x: i32, y: i32, character: char, style: Style) {
        self.record(|recorder, (left, top)| recorder.cell(left + x, top + y, character, style, true));
    }

    /// Draws cells in rows of `width` from a local position, each as [`Self::cell`] draws it. One record holds the
    /// whole run, so prefer it over a loop of [`Self::cell`]; a widget that keeps its [`PaintCell`]s records them
    /// with one copy. A zero `width` draws nothing.
    ///
    /// ```no_run
    /// use opentui::prelude::*;
    ///
    /// /// Cells built when the content changes, and recorded again on every frame.
    /// struct Canvas {
    ///     width: u32,
    ///     cells: Vec<PaintCell>,
    /// }
    ///
    /// impl Canvas {
    ///     fn new(text: &str) -> Self {
    ///         let cells: Vec<_> = text.chars().map(|character| PaintCell::new(character, Style::new().bold())).collect();
    ///         Self { width: cells.len() as u32, cells }
    ///     }
    /// }
    ///
    /// impl Component for Canvas {
    ///     fn paint(&self, painter: &mut Painter<'_>) {
    ///         painter.cells(0, 0, self.width, &self.cells);
    ///     }
    /// }
    /// ```
    pub fn cells(&mut self, x: i32, y: i32, width: u32, cells: &[PaintCell]) {
        if width == 0 {
            return;
        }
        self.record(|recorder, (left, top)| recorder.cells(left + x, top + y, width, cells));
    }

    pub fn draw_box(&mut self, x: i32, y: i32, width: u32, height: u32, spec: &BoxSpec<'_>) {
        self.record(|recorder, (left, top)| recorder.draw_box(left + x, top + y, width, height, spec));
    }

    /// Draws table grid lines along column and row boundaries, with junctions where they meet. See
    /// [`Recorder::grid`] for the offsets.
    pub fn grid(&mut self, columns: &[i32], rows: &[i32], spec: &GridSpec) {
        self.record(|recorder, (left, top)| {
            let columns: Vec<i32> = columns.iter().map(|x| left + x).collect();
            let rows: Vec<i32> = rows.iter().map(|y| top + y).collect();
            recorder.grid(&columns, &rows, spec)
        });
    }

    /// Draws a text view's visible lines, with its selection, from a top-left cell. Its viewport sets the size.
    pub fn text_view(&mut self, view: &TextView, x: i32, y: i32) {
        self.record(|recorder, (left, top)| recorder.text_view(view, left + x, top + y));
    }

    /// Copies an offscreen [`Buffer`]'s cells with its top-left cell at a local position. The buffer is read when the
    /// frame paints, after every widget recorded its drawing.
    pub fn draw_buffer(&mut self, buffer: &Buffer, x: i32, y: i32) {
        self.record(|recorder, (left, top)| recorder.draw_buffer(buffer, left + x, top + y));
    }

    /// Restricts the drawing that `draw` records to a rectangle.
    pub fn clip(&mut self, x: i32, y: i32, width: u32, height: u32, draw: impl FnOnce(&mut Self)) {
        self.record(|recorder, (left, top)| recorder.push_clip(left + x, top + y, width, height));
        let outer = self.clip;
        self.clip = Some(match outer {
            Some(clip) => intersect(clip, (x, y, width, height)),
            None => (x, y, width, height),
        });
        draw(self);
        self.clip = outer;
        self.record(|recorder, _| recorder.pop_clip());
    }

    /// Transforms the colors already painted in a rectangle, at this point in paint order: what the widget's
    /// ancestors, earlier siblings, and own body drew, and what this painter drew before, but not what paints later,
    /// such as the widget's children. Native code applies it. The rectangle is cut to [`Self::visible_rect`] and any
    /// enclosing [`Self::clip`]; the widget's opacity does not apply.
    ///
    /// ```no_run
    /// use opentui::prelude::*;
    ///
    /// /// Dims everything painted under it, such as the page behind a dialog.
    /// struct Scrim;
    ///
    /// impl Component for Scrim {
    ///     fn paint(&self, painter: &mut Painter<'_>) {
    ///         let (width, height) = painter.size();
    ///         painter.color_matrix(0, 0, width, height, &ColorMatrix::gain(0.4));
    ///     }
    /// }
    /// ```
    pub fn color_matrix(&mut self, x: i32, y: i32, width: u32, height: u32, matrix: &ColorMatrix) {
        let mut reach = self.visible_rect();
        if let Some(clip) = self.clip {
            reach = intersect(reach, clip);
        }
        let (x, y, width, height) = intersect(reach, (x, y, width, height));
        if width == 0 || height == 0 {
            return;
        }
        self.record(|recorder, (left, top)| {
            let mut mask = Vec::with_capacity(width as usize * height as usize * 3);
            for row in 0..height as i32 {
                for column in 0..width as i32 {
                    mask.extend_from_slice(&[(left + x + column) as f32, (top + y + row) as f32, 1.0]);
                }
            }
            recorder.color_matrix(matrix, Some(&mask))
        });
    }
}

/// The overlap of two rectangles, or an empty one at the first's corner.
fn intersect(a: (i32, i32, u32, u32), b: (i32, i32, u32, u32)) -> (i32, i32, u32, u32) {
    let left = i64::from(a.0).max(i64::from(b.0));
    let top = i64::from(a.1).max(i64::from(b.1));
    let right = (i64::from(a.0) + i64::from(a.2)).min(i64::from(b.0) + i64::from(b.2));
    let bottom = (i64::from(a.1) + i64::from(a.3)).min(i64::from(b.1) + i64::from(b.3));
    if right <= left || bottom <= top {
        return (a.0, a.1, 0, 0);
    }
    (left as i32, top as i32, (right - left) as u32, (bottom - top) as u32)
}
