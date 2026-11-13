//! Extmarks: ranges of an editor's text that move with edits, kept by the native edit buffer.

use crate::native::SyntaxStyle;
use crate::style::Style;
use crate::sys;
use std::ops::Range;

/// Identifies an extmark within one editor.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ExtmarkId(pub(crate) u32);

/// How an extmark looks and behaves.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[must_use]
pub struct ExtmarkOptions {
    /// The cursor and deletions treat the range as one unit, as for a mention or a file reference in a prompt: the
    /// cursor jumps over it, Backspace at its end or Delete at its start removes all of it, and an edit inside it
    /// drops the mark. Core calls these virtual extmarks.
    pub atomic: bool,
    /// Drawn over the range's text.
    pub style: Option<Style>,
    /// Which style wins where marks overlap: the higher one, at most 254. Every mark draws over syntax highlighting.
    pub priority: u8,
}

impl ExtmarkOptions {
    pub fn atomic(mut self) -> Self {
        self.atomic = true;
        self
    }

    pub fn style(mut self, style: Style) -> Self {
        self.style = Some(style);
        self
    }

    pub fn priority(mut self, priority: u8) -> Self {
        self.priority = priority;
        self
    }
}

/// A range of an editor's text that moves as the text around it changes.
///
/// Offsets count as the cursor does: display columns, with one position per line break. Text inserted before the
/// range shifts it, text inserted inside grows it, and deleting all of its text removes it. Undo and redo bring back
/// the marks of the text they restore.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Extmark {
    pub id: ExtmarkId,
    pub start: u32,
    pub end: u32,
    pub options: ExtmarkOptions,
}

impl Extmark {
    pub fn range(&self) -> Range<u32> {
        self.start..self.end
    }

    /// Whether `offset` lies strictly inside the range, where an atomic mark's cursor may not rest.
    pub(crate) fn surrounds(&self, offset: u32) -> bool {
        self.start < offset && offset < self.end
    }

    /// A mark as native code keeps it. Marks paint one priority above the one asked for, over syntax layers at 0.
    pub(crate) fn from_native(raw: &sys::ot_edit_mark, style: Option<Style>) -> Self {
        let atomic = raw.flags & sys::OT_EDIT_MARK_ATOMIC != 0;
        let priority = (raw.priority as u8).saturating_sub(1);
        Self {
            id: ExtmarkId(raw.id),
            start: raw.start,
            end: raw.end,
            options: ExtmarkOptions { atomic, style, priority },
        }
    }
}

/// The atomic mark whose inside holds `offset`.
pub(crate) fn atomic_around(marks: &[Extmark], offset: u32) -> Option<Extmark> {
    marks.iter().find(|mark| mark.options.atomic && mark.surrounds(offset)).copied()
}

/// The atomic mark whose range holds `offset`, its start included, as Core's `findVirtualExtmarkContaining`.
pub(crate) fn atomic_containing(marks: &[Extmark], offset: u32) -> Option<Extmark> {
    marks.iter().find(|mark| mark.options.atomic && mark.range().contains(&offset)).copied()
}

/// The layer syntax highlighting sets; other layers should use others.
pub(crate) const SYNTAX_LAYER: u32 = 1;

/// The style table an editor's syntax highlights use, and the group sets registered in it.
#[derive(Default)]
pub(crate) struct Extmarks {
    /// The buffer's style table: the editor's own, or one set with `syntax_style`.
    pub syntax: Option<SyntaxStyle>,
    /// Group sets of capture-name lists; each name is registered in `syntax` from the table's palette.
    pub group_sets: crate::syntax::CaptureSets,
}
