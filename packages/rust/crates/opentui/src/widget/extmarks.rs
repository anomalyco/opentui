//! Extmarks: ranges of an editor's text that move with edits, as Core's `ExtmarksController` keeps them.

use crate::native::SyntaxStyle;
use crate::style::Style;
use std::collections::HashMap;
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
/// range shifts it, text inserted inside grows it, and deleting all of its text removes it.
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
}

/// One edit: at `offset`, `removed` positions were replaced by `inserted` positions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Change {
    pub offset: u32,
    pub removed: u32,
    pub inserted: u32,
}

/// Finds the edit that turned `before` into `after`. It starts no later than offset `limit`, where both cursors were
/// at or after, which places an insertion between repeated characters where it happened.
///
/// `measure` gives the cursor offset at the end of some text: its display columns as native code counts them,
/// grapheme clusters and tabs included, plus one per line break. Lines are measured from their starts, so a cluster
/// the edit changes is measured whole.
pub(crate) fn change(before: &str, after: &str, limit: u32, measure: &mut impl FnMut(&str) -> u32) -> Change {
    let common = before.char_indices().zip(after.chars()).find(|((_, old), new)| old != new);
    let prefix = common.map_or(before.len().min(after.len()), |((index, _), _)| index);
    let line = line_start(before, prefix);
    let base = measure(&before[..line]);
    let mut start = (prefix, base + measure(&before[line..prefix]));
    if start.1 > limit {
        start = boundary_at(before, prefix, limit, measure);
    }
    let (start, offset) = start;
    let suffix: usize = before[start..]
        .chars()
        .rev()
        .zip(after[start..].chars().rev())
        .take_while(|(old, new)| old == new)
        .map(|(old, _)| old.len_utf8())
        .sum();
    // Measuring from the line start keeps a cluster that the edit joins or splits together.
    let line = line_start(before, start);
    let lead = measure(&before[line..start]);
    Change {
        offset,
        removed: measure(&before[line..before.len() - suffix]).saturating_sub(lead),
        inserted: measure(&after[line..after.len() - suffix]).saturating_sub(lead),
    }
}

/// The byte index where the line holding byte `index` starts.
fn line_start(text: &str, index: usize) -> usize {
    text[..index].rfind('\n').map_or(0, |line_break| line_break + 1)
}

/// The first character boundary at or before byte `end` whose offset reaches `limit`, and its offset.
fn boundary_at(text: &str, mut end: usize, limit: u32, measure: &mut impl FnMut(&str) -> u32) -> (usize, u32) {
    let mut line = line_start(text, end);
    let mut base = measure(&text[..line]);
    while base > limit {
        let previous = line_start(text, line - 1);
        base -= measure(&text[previous..line]);
        (end, line) = (line - 1, previous);
    }
    let boundaries: Vec<usize> = text[line..end].char_indices().map(|(index, _)| line + index).chain([end]).collect();
    let index = boundaries.partition_point(|&boundary| base + measure(&text[line..boundary]) < limit);
    let boundary = boundaries[index.min(boundaries.len() - 1)];
    (boundary, base + measure(&text[line..boundary]))
}

/// Moves marks for an edit, as Core does: deletion first, then insertion. Returns the marks the edit removed:
/// those whose text it deleted, and atomic ones it cut into.
pub(crate) fn apply(marks: &mut Vec<Extmark>, change: Change) -> Vec<ExtmarkId> {
    let mut removed = Vec::new();
    marks.retain_mut(|mark| {
        let keep = deleted(mark, change.offset, change.offset + change.removed)
            && inserted(mark, change.offset, change.inserted);
        if !keep {
            removed.push(mark.id);
        }
        keep
    });
    removed
}

/// Moves a mark for deleted positions `start..end`. Returns whether it survives.
fn deleted(mark: &mut Extmark, start: u32, end: u32) -> bool {
    let length = end - start;
    if length == 0 || mark.end <= start {
        return true;
    }
    if mark.start >= end {
        mark.start -= length;
        mark.end -= length;
        return true;
    }
    if mark.start >= start && mark.end <= end || mark.options.atomic {
        return false;
    }
    if mark.start < start && mark.end > end {
        mark.end -= length;
    } else if mark.start < start {
        mark.end = start;
    } else {
        (mark.start, mark.end) = (start, mark.end - length);
    }
    true
}

/// Moves a mark for `length` positions inserted at `at`: text before or at its start shifts it, and text inside
/// grows it, or breaks an atomic one. Returns whether it survives.
fn inserted(mark: &mut Extmark, at: u32, length: u32) -> bool {
    if length == 0 || mark.end <= at {
        return true;
    }
    if mark.start >= at {
        mark.start += length;
        mark.end += length;
        return true;
    }
    if mark.options.atomic {
        return false;
    }
    mark.end += length;
    true
}

/// The highlight tag extmarks use and the layer syntax highlighting sets; other highlights and layers should use others.
pub(crate) const HIGHLIGHT_TAG: u16 = u16::MAX;
pub(crate) const SYNTAX_LAYER: u32 = 1;

/// An editor's extmarks, and the style table its extmark and syntax highlights use.
#[derive(Default)]
pub(crate) struct Extmarks {
    pub marks: Vec<Extmark>,
    pub next: u32,
    /// The buffer's style table: the editor's own, or one set with `syntax_style`.
    pub syntax: Option<SyntaxStyle>,
    /// Style ids registered in `syntax`, by style.
    pub styles: HashMap<Style, u32>,
    /// Group sets of capture-name lists; each name is registered in `syntax` from the table's palette.
    pub group_sets: crate::syntax::CaptureSets,
}

impl Extmarks {
    pub fn add(&mut self, range: Range<u32>, options: ExtmarkOptions) -> ExtmarkId {
        self.next += 1;
        let id = ExtmarkId(self.next);
        let (start, end) = (range.start.min(range.end), range.start.max(range.end));
        self.marks.push(Extmark { id, start, end, options });
        id
    }

    /// The atomic mark whose inside holds `offset`.
    pub fn atomic_around(&self, offset: u32) -> Option<Extmark> {
        self.marks.iter().find(|mark| mark.options.atomic && mark.surrounds(offset)).copied()
    }

    /// The atomic mark whose range holds `offset`, its start included, as Core's `findVirtualExtmarkContaining`.
    pub fn atomic_containing(&self, offset: u32) -> Option<Extmark> {
        self.marks.iter().find(|mark| mark.options.atomic && mark.range().contains(&offset)).copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mark(id: u32, range: Range<u32>, atomic: bool) -> Extmark {
        Extmark {
            id: ExtmarkId(id),
            start: range.start,
            end: range.end,
            options: ExtmarkOptions { atomic, ..Default::default() },
        }
    }

    /// Counts non-ASCII characters as two columns.
    fn measure(text: &str) -> u32 {
        text.chars().map(|character| if character.is_ascii() { 1 } else { 2 }).sum()
    }

    #[test]
    fn changes_are_placed_at_the_cursor_between_repeated_characters() {
        let find = |before: &str, after: &str, limit| change(before, after, limit, &mut measure);
        // Typing "@" before "@file" at offset 0.
        assert_eq!(find("@file", "@@file", 0), Change { offset: 0, removed: 0, inserted: 1 });
        // Without the limit, the diff would place it after the first "@".
        assert_eq!(find("@file", "@@file", u32::MAX), Change { offset: 1, removed: 0, inserted: 1 });
        // Backspace in "a|a" deletes the first "a".
        assert_eq!(find("aa", "a", 0), Change { offset: 0, removed: 1, inserted: 0 });
        assert_eq!(find("abc", "aXc", 1), Change { offset: 1, removed: 1, inserted: 1 });
        // Wide characters count their display width.
        assert_eq!(find("日本", "日x本", 2), Change { offset: 2, removed: 0, inserted: 1 });
        // Line breaks count one position, and the cursor may be lines before the end of the common text.
        assert_eq!(find("a\nbb", "a\nbbb", 2), Change { offset: 2, removed: 0, inserted: 1 });
        assert_eq!(find("a\na", "a\na\na", 1), Change { offset: 1, removed: 0, inserted: 2 });
    }

    #[test]
    fn marks_shift_grow_shrink_and_go() {
        let mut marks = vec![mark(1, 2..5, false), mark(2, 6..9, true), mark(3, 10..12, false)];
        // Insert two before everything.
        assert!(apply(&mut marks, Change { offset: 0, removed: 0, inserted: 2 }).is_empty());
        assert_eq!(marks.iter().map(Extmark::range).collect::<Vec<_>>(), [4..7, 8..11, 12..14]);
        // Insert inside the plain mark: it grows. Inside the atomic one: it goes.
        assert!(apply(&mut marks, Change { offset: 5, removed: 0, inserted: 1 }).is_empty());
        assert_eq!(apply(&mut marks, Change { offset: 10, removed: 0, inserted: 1 }), [ExtmarkId(2)]);
        assert_eq!(marks.iter().map(Extmark::range).collect::<Vec<_>>(), [4..8, 14..16]);
        // Deleting part of a plain mark shrinks it; deleting all of it removes it.
        assert!(apply(&mut marks, Change { offset: 6, removed: 4, inserted: 0 }).is_empty());
        assert_eq!(marks.iter().map(Extmark::range).collect::<Vec<_>>(), [4..6, 10..12]);
        assert_eq!(apply(&mut marks, Change { offset: 9, removed: 4, inserted: 0 }), [ExtmarkId(3)]);
        // Text typed right after a mark stays outside it.
        assert!(apply(&mut marks, Change { offset: 6, removed: 0, inserted: 3 }).is_empty());
        assert_eq!(marks.iter().map(Extmark::range).collect::<Vec<_>>(), vec![(4..6)]);
    }
}
