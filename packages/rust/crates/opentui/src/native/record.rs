use super::{Buffer, Node, TextView};
use crate::error::{Error, Result};
use crate::post::ColorMatrix;
use crate::style::{Alignment, BorderStyle, Color, Sides, Style};
use crate::sys::{self, Pod, bytes_of};

/// `ot_buffer_draw` records, shared by paint recordings and offscreen buffers.
pub(crate) mod records {
    use super::BoxSpec;
    use crate::error::{Error, Result};
    use crate::style::{Color, Style};
    use crate::sys;

    pub fn check_text(text: &[u8], bottom: &[u8]) -> Result<()> {
        let max = sys::OT_BUFFER_TEXT_BYTES_MAX as usize;
        if text.len() > max || bottom.len() > max {
            return Err(Error::Usage("drawn text exceeds OT_BUFFER_TEXT_BYTES_MAX"));
        }
        Ok(())
    }

    pub fn clear(background: Color) -> sys::ot_buffer_draw_clear {
        let mut record = sys::ot_buffer_draw_clear { background: background.to_raw(), ..Default::default() };
        record.header.operation = sys::OT_BUFFER_DRAW_CLEAR;
        record
    }

    pub fn fill(x: i32, y: i32, width: u32, height: u32, background: Color) -> sys::ot_buffer_draw_fill {
        let mut record =
            sys::ot_buffer_draw_fill { x, y, width, height, background: background.to_raw(), ..Default::default() };
        record.header.operation = sys::OT_BUFFER_DRAW_FILL;
        record
    }

    pub fn text(x: i32, y: i32, style: Style) -> sys::ot_buffer_draw_text_record {
        let mut record = sys::ot_buffer_draw_text_record {
            x,
            y,
            attributes: u32::from(style.attributes.bits()),
            foreground: style.fg.unwrap_or(Color::DEFAULT_FOREGROUND).to_raw(),
            background: style.bg.map_or([0; 4], Color::to_raw),
            ..Default::default()
        };
        record.header.operation = sys::OT_BUFFER_DRAW_TEXT;
        if style.bg.is_some() {
            record.header.flags = sys::OT_BUFFER_DRAW_HAS_BACKGROUND;
        }
        record
    }

    pub fn cell(x: i32, y: i32, character: char, style: Style, blend: bool) -> sys::ot_buffer_draw_cell {
        let mut record = sys::ot_buffer_draw_cell {
            x,
            y,
            character: u32::from(character),
            attributes: u32::from(style.attributes.bits()),
            foreground: style.fg.unwrap_or(Color::DEFAULT_FOREGROUND).to_raw(),
            background: style.bg.unwrap_or(Color::TRANSPARENT).to_raw(),
            ..Default::default()
        };
        record.header.operation = if blend { sys::OT_BUFFER_DRAW_CELL_BLEND } else { sys::OT_BUFFER_DRAW_CELL };
        record
    }

    pub fn draw_box(x: i32, y: i32, width: u32, height: u32, spec: &BoxSpec<'_>) -> sys::ot_buffer_draw_box {
        let packed = u32::from(spec.sides.bits())
            | (u32::from(spec.fill) << 4)
            | (spec.title_alignment.raw() << 5)
            | (spec.bottom_title_alignment.raw() << 7);
        let mut record = sys::ot_buffer_draw_box {
            x,
            y,
            width,
            height,
            packed_options: packed,
            foreground: spec.border_color.to_raw(),
            background: spec.background.to_raw(),
            title_color: spec.title_color.unwrap_or(spec.border_color).to_raw(),
            border_chars: spec.border_chars.unwrap_or(spec.style.chars()).map(u32::from),
            ..Default::default()
        };
        record.header.operation = sys::OT_BUFFER_DRAW_BOX;
        record
    }

    /// Copies a whole source buffer with its top-left cell at a position.
    pub fn compose(x: i32, y: i32) -> sys::ot_buffer_draw_compose {
        let mut record = sys::ot_buffer_draw_compose { x, y, ..Default::default() };
        record.header.operation = sys::OT_BUFFER_DRAW_COMPOSE;
        record
    }
}

/// One cell for [`Recorder::cells`], in the form native code reads, so a widget can keep a run of them and record it
/// again with one copy. It holds one `char`, as [`Recorder::cell`] does; a grapheme cluster of several code points
/// needs [`Recorder::text`].
#[repr(transparent)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PaintCell(sys::ot_scene_cell);

impl PaintCell {
    /// A character drawn as [`Recorder::cell`] draws it with `blend`.
    pub fn new(character: char, style: Style) -> Self {
        let record = records::cell(0, 0, character, style, true);
        Self(sys::ot_scene_cell {
            character: record.character,
            attributes: record.attributes,
            foreground: record.foreground,
            background: record.background,
        })
    }
}

/// A paint phase of one slot. Native code plays them around the node's own drawing, before its children.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Phase {
    /// Before the node's native body.
    Before,
    /// Replaces the node's native body.
    Body,
    /// After the body and native cursor maintenance.
    After,
}

impl Phase {
    const fn raw(self) -> u32 {
        match self {
            Self::Before => sys::OT_SCENE_RECORD_PHASE_BEFORE,
            Self::Body => sys::OT_SCENE_RECORD_PHASE_SELF,
            Self::After => sys::OT_SCENE_RECORD_PHASE_AFTER,
        }
    }
}

/// A bordered rectangle for [`Recorder::draw_box`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BoxSpec<'a> {
    pub sides: Sides,
    pub style: BorderStyle,
    /// Replaces the style's glyphs, in [`BorderStyle::chars`] order.
    pub border_chars: Option<[char; 11]>,
    pub border_color: Color,
    pub background: Color,
    pub fill: bool,
    pub title: &'a str,
    pub title_alignment: Alignment,
    pub bottom_title: &'a str,
    pub bottom_title_alignment: Alignment,
    /// The border color when `None`.
    pub title_color: Option<Color>,
}

impl Default for BoxSpec<'_> {
    fn default() -> Self {
        Self {
            sides: Sides::ALL,
            style: BorderStyle::Single,
            border_chars: None,
            border_color: Color::rgb(255, 255, 255),
            background: Color::TRANSPARENT,
            fill: false,
            title: "",
            title_alignment: Alignment::Left,
            bottom_title: "",
            bottom_title_alignment: Alignment::Left,
            title_color: None,
        }
    }
}

/// Table grid lines for [`Recorder::grid`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GridSpec {
    pub style: BorderStyle,
    /// Replaces the style's glyphs, in [`BorderStyle::chars`] order. Every glyph must be one cell wide.
    pub border_chars: Option<[char; 11]>,
    pub border_color: Color,
    pub background: Color,
    /// Draw the lines between columns and between rows.
    pub inner: bool,
    /// Draw the outer edge.
    pub outer: bool,
}

impl Default for GridSpec {
    fn default() -> Self {
        Self {
            style: BorderStyle::Single,
            border_chars: None,
            border_color: Color::rgb(255, 255, 255),
            background: Color::TRANSPARENT,
            inner: true,
            outer: true,
        }
    }
}

/// Records drawing commands for a paint hook.
///
/// Commands draw into the frame when native code paints the slot, inside the slot's clip and opacity. Coordinates
/// are absolute terminal cells. Resources named by a command are read at playback, not when recorded.
pub struct Recorder {
    // Native code requires an 8-byte aligned stream; every record is padded to a multiple of 8 bytes.
    words: Vec<u64>,
    last_slot: Option<(u32, Phase)>,
}

impl Recorder {
    pub(crate) fn new() -> Self {
        Self { words: Vec::new(), last_slot: None }
    }

    pub(crate) fn reset(&mut self) {
        self.words.clear();
        self.last_slot = None;
    }

    pub fn is_empty(&self) -> bool {
        self.words.is_empty()
    }

    pub(crate) fn bytes(&self) -> &[u8] {
        // SAFETY: u64 storage is fully initialized and every byte pattern is a valid u8.
        unsafe { std::slice::from_raw_parts(self.words.as_ptr().cast::<u8>(), self.words.len() * 8) }
    }

    /// Appends one record: `head` starts with an `ot_scene_record_header`, whose size this fills in.
    fn push(&mut self, head: &[u8], tails: &[&[u8]]) -> Result<()> {
        let length = head.len() + tails.iter().map(|tail| tail.len()).sum::<usize>();
        let padded = length.next_multiple_of(8);
        let total = self.words.len() * 8 + padded;
        if total > sys::OT_SCENE_RECORD_BYTES_MAX as usize {
            return Err(Error::Usage("paint recording exceeds OT_SCENE_RECORD_BYTES_MAX"));
        }
        let start = self.words.len();
        self.words.resize(start + padded / 8, 0);
        // SAFETY: the new words are initialized, and the byte view covers exactly them.
        let bytes = unsafe { std::slice::from_raw_parts_mut(self.words[start..].as_mut_ptr().cast::<u8>(), padded) };
        let mut offset = 0;
        for part in std::iter::once(head).chain(tails.iter().copied()) {
            bytes[offset..offset + part.len()].copy_from_slice(part);
            offset += part.len();
        }
        bytes[..4].copy_from_slice(&(padded as u32).to_ne_bytes());
        Ok(())
    }

    fn command<T: Pod>(&mut self, record: &T, tails: &[&[u8]]) -> Result<()> {
        if self.last_slot.is_none() {
            return Err(Error::Usage("paint commands must follow Recorder::begin"));
        }
        self.push(bytes_of(record), tails)
    }

    /// Starts the commands for one phase of one slot. Slots and phases must increase.
    pub fn begin(&mut self, slot: u32, phase: Phase) -> Result<()> {
        if self.last_slot.is_some_and(|last| last >= (slot, phase)) {
            return Err(Error::Usage("paint slots and phases must be recorded in increasing order"));
        }
        let record = sys::ot_scene_record_slot {
            header: sys::ot_scene_record_header { size: 0, operation: sys::OT_SCENE_RECORD_SLOT },
            slot,
            phase: phase.raw(),
        };
        self.push(bytes_of(&record), &[])?;
        self.last_slot = Some((slot, phase));
        Ok(())
    }

    fn draw<T: Pod>(&mut self, draw: &T, source: Option<&Buffer>, text: &[u8], bottom: &[u8]) -> Result<()> {
        records::check_text(text, bottom)?;
        let head = sys::ot_scene_record_draw {
            header: sys::ot_scene_record_header { size: 0, operation: sys::OT_SCENE_RECORD_DRAW },
            source: source.map_or(sys::ot_handle::default(), Buffer::handle),
            text_length: text.len() as u32,
            bottom_length: bottom.len() as u32,
        };
        self.command(&head, &[bytes_of(draw), text, bottom])
    }

    /// Fills a rectangle with a background color.
    pub fn fill(&mut self, x: i32, y: i32, width: u32, height: u32, background: Color) -> Result<()> {
        self.draw(&records::fill(x, y, width, height, background), None, &[], &[])
    }

    /// Draws one row of text. A missing foreground draws in the terminal's default color; a missing background keeps
    /// the background already under each glyph.
    pub fn text(&mut self, x: i32, y: i32, text: &str, style: Style) -> Result<()> {
        self.draw(&records::text(x, y, style), None, text.as_bytes(), &[])
    }

    /// Draws one single-cell character. `blend` composites translucent colors over the existing cell.
    pub fn cell(&mut self, x: i32, y: i32, character: char, style: Style, blend: bool) -> Result<()> {
        self.draw(&records::cell(x, y, character, style, blend), None, &[], &[])
    }

    /// Draws cells in rows of `width` from a position, each as [`Self::cell`] draws it with `blend`, in one record.
    pub fn cells(&mut self, x: i32, y: i32, width: u32, cells: &[PaintCell]) -> Result<()> {
        if width == 0 {
            return Err(Error::Usage("paint cells need a nonzero row width"));
        }
        let record = sys::ot_scene_record_cells {
            header: sys::ot_scene_record_header { size: 0, operation: sys::OT_SCENE_RECORD_CELLS },
            x,
            y,
            width,
            count: crate::error::count("ot_scene_record_cells", cells.len())?,
        };
        // SAFETY: PaintCell is a transparent ot_scene_cell, which has no padding and only integer fields.
        let bytes = unsafe { std::slice::from_raw_parts(cells.as_ptr().cast::<u8>(), size_of_val(cells)) };
        self.command(&record, &[bytes])
    }

    pub fn draw_box(&mut self, x: i32, y: i32, width: u32, height: u32, spec: &BoxSpec<'_>) -> Result<()> {
        let record = records::draw_box(x, y, width, height, spec);
        self.draw(&record, None, spec.title.as_bytes(), spec.bottom_title.as_bytes())
    }

    /// Copies an offscreen buffer's cells with its top-left cell at a position. Native code reads the buffer when it
    /// plays the recording, so drawing into it after recording, but before the frame paints, still shows.
    pub fn draw_buffer(&mut self, source: &Buffer, x: i32, y: i32) -> Result<()> {
        self.draw(&records::compose(x, y), Some(source), &[], &[])
    }

    fn stack(&mut self, operation: u32, x: i32, y: i32, width: u32, height: u32, opacity: f32) -> Result<()> {
        let record = sys::ot_scene_record_stack {
            header: sys::ot_scene_record_header { size: 0, operation: sys::OT_SCENE_RECORD_STACK },
            operation,
            x,
            y,
            width,
            height,
            opacity,
        };
        self.command(&record, &[])
    }

    /// Intersects the clip with a rectangle until the matching [`Self::pop_clip`] or the end of the phase.
    pub fn push_clip(&mut self, x: i32, y: i32, width: u32, height: u32) -> Result<()> {
        self.stack(sys::OT_BUFFER_STACK_PUSH_SCISSOR, x, y, width, height, 0.0)
    }

    pub fn pop_clip(&mut self) -> Result<()> {
        self.stack(sys::OT_BUFFER_STACK_POP_SCISSOR, 0, 0, 0, 0, 0.0)
    }

    /// Multiplies opacity until the matching [`Self::pop_opacity`] or the end of the phase.
    pub fn push_opacity(&mut self, opacity: f32) -> Result<()> {
        self.stack(sys::OT_BUFFER_STACK_PUSH_OPACITY, 0, 0, 0, 0, opacity)
    }

    pub fn pop_opacity(&mut self) -> Result<()> {
        self.stack(sys::OT_BUFFER_STACK_POP_OPACITY, 0, 0, 0, 0, 0.0)
    }

    /// Draws the native body of a text, box, slider, or arrow node as the node itself would paint it, with its
    /// top-left cell at a position, at the node's paint size, and with the current focus.
    pub fn scene_body(&mut self, node: &Node, x: i32, y: i32) -> Result<()> {
        let record = sys::ot_scene_record_view {
            header: sys::ot_scene_record_header { size: 0, operation: sys::OT_SCENE_RECORD_SCENE_BODY },
            source: node.handle(),
            x,
            y,
        };
        self.command(&record, &[])
    }

    /// Draws a text view's visible lines with their top-left cell at a position. The view's viewport sets how many
    /// rows and columns show; its selection is highlighted.
    pub fn text_view(&mut self, view: &TextView, x: i32, y: i32) -> Result<()> {
        let record = sys::ot_scene_record_view {
            header: sys::ot_scene_record_header { size: 0, operation: sys::OT_SCENE_RECORD_TEXT_VIEW },
            source: view.handle(),
            x,
            y,
        };
        self.command(&record, &[])
    }

    /// Transforms colors already painted when the slot plays. `mask` holds `(x, y, weight)` triples of absolute
    /// cells, each weight scaling the matrix's strength; `None` transforms every cell of the frame. Unlike other
    /// commands, this ignores the slot's clip and opacity.
    pub fn color_matrix(&mut self, matrix: &ColorMatrix, mask: Option<&[f32]>) -> Result<()> {
        let mask_count = match mask {
            Some(mask) => crate::error::count("ot_scene_record_color_matrix", mask.len())?,
            None => 0,
        };
        let record = sys::ot_scene_record_color_matrix {
            header: sys::ot_scene_record_header { size: 0, operation: sys::OT_SCENE_RECORD_COLOR_MATRIX },
            matrix: matrix.flat(),
            strength: matrix.strength,
            channel: matrix.channels.raw(),
            has_mask: u32::from(mask.is_some()),
            mask_count,
        };
        let floats: &[u8] = match mask {
            // SAFETY: f32 has no padding and every byte of it is initialized.
            Some(mask) => unsafe { std::slice::from_raw_parts(mask.as_ptr().cast::<u8>(), size_of_val(mask)) },
            None => &[],
        };
        self.command(&record, &[floats])
    }

    /// Draws table grid lines, with junctions where lines meet. `columns` and `rows` are the x and y cells of the
    /// boundary lines, outer edges included, each strictly increasing; a column or row lies between two neighbors.
    /// Without the outer edge, the first offset lies one cell before the first column or row, and the last offset is
    /// the last column's or row's final cell. Lines outside the target are skipped.
    pub fn grid(&mut self, columns: &[i32], rows: &[i32], spec: &GridSpec) -> Result<()> {
        const OPERATION: &str = "ot_scene_record_grid";
        let mut options = sys::ot_buffer_grid_options {
            foreground: spec.border_color.to_raw(),
            background: spec.background.to_raw(),
            border_chars: spec.border_chars.unwrap_or(spec.style.chars()).map(u32::from),
            ..Default::default()
        };
        if spec.inner {
            options.flags |= sys::OT_BUFFER_GRID_INNER;
        }
        if spec.outer {
            options.flags |= sys::OT_BUFFER_GRID_OUTER;
        }
        let record = sys::ot_scene_record_grid {
            header: sys::ot_scene_record_header { size: 0, operation: sys::OT_SCENE_RECORD_GRID },
            options,
            column_count: crate::error::count(OPERATION, columns.len())?,
            row_count: crate::error::count(OPERATION, rows.len())?,
        };
        let offsets: Vec<u8> = columns.iter().chain(rows).flat_map(|offset| offset.to_ne_bytes()).collect();
        self.command(&record, &[&offsets])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(recorder: &Recorder, offset: usize) -> u32 {
        u32::from_ne_bytes(recorder.bytes()[offset..offset + 4].try_into().unwrap())
    }

    #[test]
    fn records_are_padded_and_sized() -> Result<()> {
        let mut recorder = Recorder::new();
        assert!(matches!(recorder.fill(0, 0, 1, 1, Color::RED), Err(Error::Usage(_))));
        recorder.begin(0, Phase::Body)?;
        recorder.text(1, 2, "abc", Style::new())?;
        let bytes = recorder.bytes();
        assert_eq!(bytes.len() % 8, 0);
        assert_eq!(recorder.words.as_ptr() as usize % 8, 0);
        // SLOT record: 16 bytes.
        assert_eq!((word(&recorder, 0), word(&recorder, 4)), (16, sys::OT_SCENE_RECORD_SLOT));
        let draw = size_of::<sys::ot_scene_record_draw>() + size_of::<sys::ot_buffer_draw_text_record>() + 3;
        assert_eq!(word(&recorder, 16), draw.next_multiple_of(8) as u32);
        assert_eq!(word(&recorder, 20), sys::OT_SCENE_RECORD_DRAW);
        assert_eq!(bytes.len(), 16 + draw.next_multiple_of(8));
        // Native code rejects a run of cells without a row width, and with it the whole frame.
        assert!(matches!(recorder.cells(0, 0, 0, &[PaintCell::default()]), Err(Error::Usage(_))));
        assert_eq!(recorder.bytes().len(), 16 + draw.next_multiple_of(8));
        Ok(())
    }

    #[test]
    fn grid_records_carry_their_offsets() -> Result<()> {
        let mut recorder = Recorder::new();
        recorder.begin(0, Phase::After)?;
        recorder.grid(&[0, 2, 4], &[0, 7], &GridSpec { inner: false, ..GridSpec::default() })?;
        let head = size_of::<sys::ot_scene_record_grid>();
        assert_eq!(word(&recorder, 16), (head + 5 * 4).next_multiple_of(8) as u32);
        assert_eq!(word(&recorder, 20), sys::OT_SCENE_RECORD_GRID);
        // The options' flags, then the counts, then column and row offsets.
        assert_eq!(word(&recorder, 16 + 8 + 8), sys::OT_BUFFER_GRID_OUTER);
        assert_eq!((word(&recorder, 16 + head - 8), word(&recorder, 16 + head - 4)), (3, 2));
        assert_eq!((word(&recorder, 16 + head + 4), word(&recorder, 16 + head + 16)), (2, 7));
        Ok(())
    }

    #[test]
    fn color_matrix_records_carry_their_mask() -> Result<()> {
        let mut recorder = Recorder::new();
        recorder.begin(0, Phase::After)?;
        recorder.color_matrix(&ColorMatrix::INVERT.strength(0.5), Some(&[1.0, 2.0, 0.25]))?;
        let head = size_of::<sys::ot_scene_record_color_matrix>();
        assert_eq!(word(&recorder, 16), (head + 12).next_multiple_of(8) as u32);
        assert_eq!(word(&recorder, 20), sys::OT_SCENE_RECORD_COLOR_MATRIX);
        let float = |offset: usize| f32::from_bits(word(&recorder, offset));
        assert_eq!(float(16 + 8 + 12), 1.0, "the red row's alpha coefficient");
        assert_eq!(float(16 + 8 + 64), 0.5, "strength");
        assert_eq!((word(&recorder, 16 + 76), word(&recorder, 16 + 80), word(&recorder, 16 + 84)), (3, 1, 3));
        assert_eq!((float(16 + head), float(16 + head + 8)), (1.0, 0.25));
        recorder.color_matrix(&ColorMatrix::GRAYSCALE, None)?;
        let second = 16 + (head + 12).next_multiple_of(8);
        assert_eq!(word(&recorder, second), head as u32);
        assert_eq!(word(&recorder, second + 80), 0, "no mask");
        Ok(())
    }

    #[test]
    fn buffer_draws_name_their_source() -> Result<()> {
        let context = super::super::Context::new(super::super::ContextOptions::default())?;
        let buffer = Buffer::new(&context, 2, 1, super::super::WidthMethod::Unicode)?;
        let mut recorder = Recorder::new();
        recorder.begin(0, Phase::After)?;
        recorder.draw_buffer(&buffer, 3, 4)?;
        let head = size_of::<sys::ot_scene_record_draw>();
        assert_eq!(word(&recorder, 16 + 4), sys::OT_SCENE_RECORD_DRAW);
        assert_eq!(&recorder.bytes()[16 + 8..16 + 24], bytes_of(&buffer.handle()));
        assert_eq!(word(&recorder, 16 + head + 8), sys::OT_BUFFER_DRAW_COMPOSE);
        assert_eq!((word(&recorder, 16 + head + 16), word(&recorder, 16 + head + 20)), (3, 4));
        Ok(())
    }

    #[test]
    fn slots_and_phases_must_increase() -> Result<()> {
        let mut recorder = Recorder::new();
        recorder.begin(0, Phase::Before)?;
        recorder.begin(0, Phase::After)?;
        assert!(recorder.begin(0, Phase::Body).is_err());
        assert!(recorder.begin(0, Phase::After).is_err());
        recorder.begin(1, Phase::Before)?;
        recorder.reset();
        assert!(recorder.is_empty());
        recorder.begin(0, Phase::Before)?;
        Ok(())
    }

    #[test]
    fn oversized_text_is_rejected_before_recording() -> Result<()> {
        let mut recorder = Recorder::new();
        recorder.begin(0, Phase::Body)?;
        let before = recorder.bytes().len();
        let text = "x".repeat(sys::OT_BUFFER_TEXT_BYTES_MAX as usize + 1);
        assert!(recorder.text(0, 0, &text, Style::new()).is_err());
        assert_eq!(recorder.bytes().len(), before);
        Ok(())
    }
}
