use super::resource::{Resource, read_string};
use super::{Context, MousePointer, Node, WidthMethod, WrapMode};
use crate::error::{Result, check, count};
use crate::native::CursorStyle;
use crate::style::{Color, EncodedSpans, Span, Style};
use crate::syntax::SyntaxTheme;
use crate::sys;
use std::cell::RefCell;
use std::collections::BTreeSet;
use std::ops::Range;
use std::rc::Rc;
use std::sync::Arc;

/// Default colors and attributes for text without a highlight. `None` fields stay unset.
fn encode_style(style: Style) -> sys::ot_editor_style {
    let mut raw = sys::ot_editor_style { attributes: u32::from(style.attributes.bits()), ..Default::default() };
    raw.flags |= sys::OT_EDITOR_STYLE_ATTRIBUTES;
    if let Some(color) = style.fg {
        raw.flags |= sys::OT_EDITOR_STYLE_FOREGROUND;
        raw.foreground = color.to_raw();
    }
    if let Some(color) = style.bg {
        raw.flags |= sys::OT_EDITOR_STYLE_BACKGROUND;
        raw.background = color.to_raw();
    }
    raw
}

#[cfg(test)]
thread_local! {
    /// `ot_edit_buffer_get_text` calls on this thread, for tests that count the work of an edit.
    pub(crate) static TEXT_READS: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    /// `ot_edit_buffer_get_marks` calls on this thread.
    pub(crate) static MARK_READS: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    /// Commands on this thread that apply the cursor rules around atomic marks.
    pub(crate) static RULE_CALLS: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

/// Counts a command that applies the cursor rules, for tests.
fn ruled() {
    #[cfg(test)]
    RULE_CALLS.with(|calls| calls.set(calls.get() + 1));
}

/// A style that supplies exactly its own attributes, as a registered name or a mark's style value.
fn encode_supplied(style: Style) -> sys::ot_editor_style {
    let mut raw = encode_style(style);
    raw.flags |= sys::OT_EDITOR_STYLE_ATTRIBUTE_MASK;
    raw.attributes |= raw.attributes << 16;
    raw
}

/// A named-style table for edit buffer highlights, which several buffers can share.
#[derive(Clone)]
pub struct SyntaxStyle(Rc<Resource>, Rc<RefCell<CapturePalette>>);

/// The syntax theme an editor last set on a table, and the capture names and whole lists registered from it.
#[derive(Default)]
struct CapturePalette {
    theme: Arc<SyntaxTheme>,
    names: BTreeSet<&'static str>,
    lists: BTreeSet<Vec<&'static str>>,
}

impl SyntaxStyle {
    pub fn new(context: &Context) -> Result<Self> {
        let resource = Resource::create(
            context,
            "ot_syntax_style_create",
            ("ot_syntax_style_destroy", sys::ot_syntax_style_destroy),
            |context, handle| unsafe { sys::ot_syntax_style_create(context, handle) },
        )?;
        Ok(Self(Rc::new(resource), Rc::default()))
    }

    /// Makes `theme` the table's capture palette, registering every capture name seen on the table again; the
    /// last theme set wins for all editors sharing the table. Returns whether the palette changed.
    pub(crate) fn set_capture_theme(&self, theme: &Arc<SyntaxTheme>) -> Result<bool> {
        if self.1.borrow().theme == *theme {
            return Ok(false);
        }
        self.1.borrow_mut().theme = theme.clone();
        self.1.borrow().names.iter().try_for_each(|name| self.register_capture(name).map(drop))?;
        self.1.borrow().lists.iter().try_for_each(|names| self.register_list(names).map(drop))?;
        Ok(true)
    }

    /// The style names a group set of the capture-name list `names` composes, registered with the palette:
    /// `opentui.<name>` for each, or, for a list past the group-set bounds, one name for the whole list with its
    /// merged style, so no style is lost.
    pub(crate) fn capture_group(&self, names: &[&'static str]) -> Result<Vec<String>> {
        let prefixed: Vec<String> = names.iter().map(|name| format!("opentui.{name}")).collect();
        let bytes = sys::OT_GROUP_SET_NAME_BYTE_COUNT_MAX as usize;
        if names.len() <= sys::OT_GROUP_SET_NAME_COUNT_MAX as usize && prefixed.iter().all(|name| name.len() <= bytes) {
            self.register_captures(names)?;
            return Ok(prefixed);
        }
        if !self.1.borrow().lists.contains(names) {
            self.register_list(names)?;
            self.1.borrow_mut().lists.insert(names.to_vec());
        }
        Ok(vec![list_name(names)])
    }

    fn register_list(&self, names: &[&'static str]) -> Result<u32> {
        let style = self.1.borrow().theme.merge(names.iter().copied());
        self.register(&list_name(names), style)
    }

    /// Registers the capture names the table has not seen as `opentui.<name>`, with its palette's style.
    pub(crate) fn register_captures(&self, names: &[&'static str]) -> Result<()> {
        for &name in names {
            if !self.1.borrow().names.contains(name) {
                self.register_capture(name)?;
                self.1.borrow_mut().names.insert(name);
            }
        }
        Ok(())
    }

    fn register_capture(&self, name: &str) -> Result<u32> {
        let style = self.1.borrow().theme.get(name).unwrap_or_default();
        self.register(&format!("opentui.{name}"), style)
    }

    pub(crate) fn handle(&self) -> sys::ot_handle {
        self.0.handle()
    }

    /// Defines or replaces a named style and returns its id for highlights. In a group set it adds its attributes to
    /// earlier names' (a [`Style`] has no attribute that says "off"), as [`Style::patch`] does.
    pub fn register(&self, name: &str, style: Style) -> Result<u32> {
        let raw = encode_supplied(style);
        let length = count("ot_syntax_style_register", name.len())?;
        let (context, handle) = self.0.raw();
        let mut id = 0;
        check("ot_syntax_style_register", unsafe {
            sys::ot_syntax_style_register(context, handle, name.as_ptr(), length, &raw, &mut id)
        })?;
        Ok(id)
    }

    /// The id of a registered name, or `None`.
    pub fn resolve(&self, name: &str) -> Result<Option<u32>> {
        let length = count("ot_syntax_style_resolve", name.len())?;
        let (context, handle) = self.0.raw();
        let mut id = 0;
        check("ot_syntax_style_resolve", unsafe {
            sys::ot_syntax_style_resolve(context, handle, name.as_ptr(), length, &mut id)
        })?;
        Ok((id != 0).then_some(id))
    }
}

/// The style name of a capture-name list past the group-set bounds: the same in every table.
fn list_name(names: &[&str]) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::hash::DefaultHasher::new();
    names.hash(&mut hasher);
    format!("opentui.~{:016x}", hasher.finish())
}

/// A highlight over a range of display columns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Highlight {
    pub start: u32,
    pub end: u32,
    /// An id from [`SyntaxStyle::register`]. Native code rejects ids with [`sys::OT_STYLE_RUN_FLAG`], which registered
    /// ids never have.
    pub style_id: u32,
    /// Higher priorities draw over lower ones, at most 255.
    pub priority: u8,
    /// A caller-chosen tag for removing groups of highlights, at most 65535.
    pub tag: u16,
}

impl Highlight {
    pub(crate) fn raw(self) -> sys::ot_edit_highlight {
        sys::ot_edit_highlight {
            start: self.start,
            end: self.end,
            style_id: self.style_id,
            priority: u32::from(self.priority),
            r#ref: u32::from(self.tag),
        }
    }
}

/// Edit buffer state. Columns and offsets count display cells, not bytes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EditInfo {
    /// Changes whenever the content changes.
    pub content_epoch: u64,
    pub byte_count: u32,
    pub line_count: u32,
    /// The primary cursor: zero-based row and display column.
    pub cursor: (u32, u32),
    /// Display cells from the document start, counting one cell per line break.
    pub cursor_offset: u32,
    pub can_undo: bool,
    pub can_redo: bool,
    pub tab_width: u32,
}

/// A position in an edit buffer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EditPosition {
    /// Zero-based logical line.
    pub row: u32,
    /// Display cells from the logical line start.
    pub col: u32,
    /// Display cells from the document start, counting one per newline.
    pub offset: u32,
}

/// A buffer edit or cursor movement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EditCommand {
    DeleteForward,
    Backspace,
    NewLine,
    DeleteLine,
    /// One cursor stop left, not one byte or necessarily one display cell.
    MoveLeft,
    /// One cursor stop right, not one byte or necessarily one display cell.
    MoveRight,
    /// One logical line up, using the desired cell column.
    MoveUp,
    /// One logical line down, using the desired cell column.
    MoveDown,
    /// Zero-based logical line.
    GotoLine(u32),
    /// Document display cells, counting one per newline.
    CursorOffset(u32),
    Clear,
    ClearHistory,
}

/// Where [`EditBuffer::position`] looks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EditQuery {
    Cursor,
    NextWord,
    PrevWord,
    EndOfLine,
    /// Document display cells, counting one per newline.
    Offset(u32),
    /// Zero-based logical line and display-cell column.
    Coords(u32, u32),
    /// Zero-based logical line.
    LineStart(u32),
}

/// Editable text with a cursor and undo history.
///
/// Control characters other than tab, CR, and LF stay in the text and show as notation: `^@` to `^_` and `^?` take
/// two cells, `<80>` to `<9f>` four.
#[derive(Clone)]
pub struct EditBuffer(Rc<Resource>);

impl EditBuffer {
    /// `width_method` is normally the Session's detected method, such as
    /// [`App::width_method`](crate::App::width_method).
    pub fn new(context: &Context, width_method: WidthMethod) -> Result<Self> {
        let options = sys::ot_edit_buffer_options { width_method: width_method.raw(), ..Default::default() };
        let resource = Resource::create(
            context,
            "ot_edit_buffer_create",
            ("ot_edit_buffer_destroy", sys::ot_edit_buffer_destroy),
            |context, handle| unsafe { sys::ot_edit_buffer_create(context, &options, handle) },
        )?;
        Ok(Self(Rc::new(resource)))
    }

    pub fn context(&self) -> &Context {
        self.0.context()
    }

    fn raw(&self) -> (*mut sys::ot_context, *const sys::ot_handle) {
        self.0.raw()
    }

    /// Replaces the text and moves the cursor to the start. `undoable` keeps history and adds an undo point.
    pub fn set_text(&self, text: &str, undoable: bool) -> Result<()> {
        let length = count("ot_edit_buffer_set_text", text.len())?;
        let (context, handle) = self.raw();
        check("ot_edit_buffer_set_text", unsafe {
            sys::ot_edit_buffer_set_text(context, handle, text.as_ptr(), length, u32::from(undoable))
        })
    }

    /// Inserts text at the cursor.
    pub fn insert(&self, text: &str) -> Result<()> {
        let length = count("ot_edit_buffer_insert_text", text.len())?;
        let (context, handle) = self.raw();
        check("ot_edit_buffer_insert_text", unsafe {
            sys::ot_edit_buffer_insert_text(context, handle, text.as_ptr(), length)
        })
    }

    /// Deletes a half-open range between (zero-based logical line, display-cell column) pairs.
    pub fn delete_range(&self, start: (u32, u32), end: (u32, u32)) -> Result<()> {
        let (context, handle) = self.raw();
        check("ot_edit_buffer_delete_range", unsafe {
            sys::ot_edit_buffer_delete_range(context, handle, start.0, start.1, end.0, end.1)
        })
    }

    /// Sets the cursor by zero-based logical row and display-cell column.
    pub fn set_cursor(&self, row: u32, col: u32) -> Result<()> {
        let (context, handle) = self.raw();
        check("ot_edit_buffer_set_cursor", unsafe { sys::ot_edit_buffer_set_cursor(context, handle, row, col) })
    }

    /// Returns UTF-8 text with LF line endings. `len()` and string slicing use bytes, not cursor cells.
    pub fn text(&self) -> Result<String> {
        let (context, handle) = self.raw();
        read_string("ot_edit_buffer_get_text", |bytes, capacity, length| unsafe {
            #[cfg(test)]
            TEXT_READS.with(|reads| reads.set(reads.get() + 1));
            sys::ot_edit_buffer_get_text(context, handle, bytes, capacity, length)
        })
    }

    /// Returns the cursor's logical line, cell column, and document cell offset (one per newline).
    pub fn info(&self) -> Result<EditInfo> {
        let mut raw = sys::ot_edit_buffer_info::default();
        let (context, handle) = self.raw();
        check("ot_edit_buffer_get_info", unsafe { sys::ot_edit_buffer_get_info(context, handle, &mut raw) })?;
        Ok(EditInfo {
            content_epoch: raw.content_epoch,
            byte_count: raw.byte_count,
            line_count: raw.line_count,
            cursor: (raw.cursor_row, raw.cursor_col),
            cursor_offset: raw.cursor_offset,
            can_undo: raw.can_undo != 0,
            can_redo: raw.can_redo != 0,
            tab_width: raw.tab_width,
        })
    }

    pub fn set_tab_width(&self, width: u32) -> Result<()> {
        let (context, handle) = self.raw();
        check("ot_edit_buffer_set_tab_width", unsafe { sys::ot_edit_buffer_set_tab_width(context, handle, width) })
    }

    pub fn command(&self, command: EditCommand) -> Result<()> {
        self.send(command, 0)
    }

    /// As [`command`](Self::command), with the cursor rules around atomic marks for Left, Right, Backspace and
    /// Delete: a mark is one unit, and a move ends outside every atomic mark. Other commands run as `command`.
    pub fn command_atomic(&self, command: EditCommand) -> Result<()> {
        ruled();
        self.send(command, sys::OT_EDIT_ATOMIC)
    }

    /// Moves a cursor that atomic marks surround to the outer edge of all of them: the end for `Greater`, the start for
    /// `Less`, or the nearer one.
    pub fn keep_outside(&self, toward: std::cmp::Ordering) -> Result<()> {
        let edge = match toward {
            std::cmp::Ordering::Equal => 0,
            std::cmp::Ordering::Greater => 1,
            std::cmp::Ordering::Less => 2,
        };
        ruled();
        let (context, handle) = self.raw();
        check("ot_edit_buffer_command", unsafe {
            sys::ot_edit_buffer_command(context, handle, sys::OT_EDIT_KEEP_OUTSIDE, edge)
        })
    }

    fn send(&self, command: EditCommand, atomic: u32) -> Result<()> {
        let (code, argument) = match command {
            EditCommand::DeleteForward => (sys::OT_EDIT_DELETE_FORWARD, atomic),
            EditCommand::Backspace => (sys::OT_EDIT_BACKSPACE, atomic),
            EditCommand::NewLine => (sys::OT_EDIT_NEW_LINE, 0),
            EditCommand::DeleteLine => (sys::OT_EDIT_DELETE_LINE, 0),
            EditCommand::MoveLeft => (sys::OT_EDIT_MOVE_LEFT, atomic),
            EditCommand::MoveRight => (sys::OT_EDIT_MOVE_RIGHT, atomic),
            EditCommand::MoveUp => (sys::OT_EDIT_MOVE_UP, 0),
            EditCommand::MoveDown => (sys::OT_EDIT_MOVE_DOWN, 0),
            EditCommand::GotoLine(line) => (sys::OT_EDIT_GOTO_LINE, line),
            EditCommand::CursorOffset(offset) => (sys::OT_EDIT_CURSOR_OFFSET, offset),
            EditCommand::Clear => (sys::OT_EDIT_CLEAR, 0),
            EditCommand::ClearHistory => (sys::OT_EDIT_CLEAR_HISTORY, 0),
        };
        let (context, handle) = self.raw();
        check("ot_edit_buffer_command", unsafe { sys::ot_edit_buffer_command(context, handle, code, argument) })
    }

    fn history(&self, redo: bool) -> Result<bool> {
        let mut bytes = [0u8; 64];
        let mut length = 0;
        let (context, handle) = self.raw();
        check("ot_edit_buffer_history", unsafe {
            sys::ot_edit_buffer_history(context, handle, u32::from(redo), bytes.as_mut_ptr(), 64, &mut length)
        })?;
        Ok(length != 0)
    }

    /// Undoes one step. Returns whether there was one.
    pub fn undo(&self) -> Result<bool> {
        self.history(false)
    }

    pub fn redo(&self) -> Result<bool> {
        self.history(true)
    }

    /// Queries a logical line, cell column, and document cell offset (one per newline), without moving the cursor.
    pub fn position(&self, query: EditQuery) -> Result<Option<EditPosition>> {
        let (code, a, b) = match query {
            EditQuery::Cursor => (sys::OT_EDIT_POSITION_CURSOR, 0, 0),
            EditQuery::NextWord => (sys::OT_EDIT_POSITION_NEXT_WORD, 0, 0),
            EditQuery::PrevWord => (sys::OT_EDIT_POSITION_PREV_WORD, 0, 0),
            EditQuery::EndOfLine => (sys::OT_EDIT_POSITION_EOL, 0, 0),
            EditQuery::Offset(offset) => (sys::OT_EDIT_POSITION_OFFSET, offset, 0),
            EditQuery::Coords(row, col) => (sys::OT_EDIT_POSITION_COORDS, row, col),
            EditQuery::LineStart(line) => (sys::OT_EDIT_POSITION_LINE_START, line, 0),
        };
        let mut raw = sys::ot_edit_position::default();
        let (context, handle) = self.raw();
        check("ot_edit_buffer_get_position", unsafe {
            sys::ot_edit_buffer_get_position(context, handle, code, a, b, &mut raw)
        })?;
        Ok((raw.valid != 0).then_some(EditPosition { row: raw.row, col: raw.col, offset: raw.offset }))
    }

    /// Converts a UTF-8 byte index in `text()` to document cells (one per newline). Rounds down within a grapheme
    /// and clamps at EOF. The index need not be a char boundary.
    pub fn byte_index_to_cell_offset(&self, index: usize) -> Result<u32> {
        self.convert_offset(sys::OT_EDIT_BYTE_TO_CELL, u32::try_from(index).unwrap_or(u32::MAX))
    }

    /// Converts document cells to a UTF-8 byte index in `text()`. Rounds down within a grapheme, past zero-width
    /// text at a tie, and clamps at EOF.
    pub fn cell_offset_to_byte_index(&self, offset: u32) -> Result<usize> {
        Ok(self.convert_offset(sys::OT_EDIT_CELL_TO_BYTE, offset)? as usize)
    }

    fn convert_offset(&self, conversion: u32, value: u32) -> Result<u32> {
        let (context, handle) = self.raw();
        let mut result = 0;
        check("ot_edit_buffer_convert_offset", unsafe {
            sys::ot_edit_buffer_convert_offset(context, handle, conversion, value, &mut result)
        })?;
        Ok(result)
    }

    /// Reads `start..end` in document display cells, counting one per newline. The resulting string uses UTF-8 bytes.
    pub fn range(&self, start: u32, end: u32) -> Result<String> {
        let (context, handle) = self.raw();
        read_string("ot_edit_buffer_get_range", |bytes, capacity, length| unsafe {
            sys::ot_edit_buffer_get_range(context, handle, 0, 0, start, 0, end, bytes, capacity, length)
        })
    }

    /// Sets the colors and attributes of unhighlighted text.
    pub fn set_defaults(&self, style: Style) -> Result<()> {
        let raw = encode_style(style);
        let mask = sys::OT_EDITOR_STYLE_FOREGROUND | sys::OT_EDITOR_STYLE_BACKGROUND | sys::OT_EDITOR_STYLE_ATTRIBUTES;
        let (context, handle) = self.raw();
        check("ot_edit_buffer_set_defaults", unsafe { sys::ot_edit_buffer_set_defaults(context, handle, mask, &raw) })
    }

    pub fn set_syntax_style(&self, style: Option<&SyntaxStyle>) -> Result<()> {
        let style = style.map(SyntaxStyle::handle);
        let (context, handle) = self.raw();
        check("ot_edit_buffer_set_syntax_style", unsafe {
            sys::ot_edit_buffer_set_syntax_style(context, handle, style.as_ref().map_or(std::ptr::null(), |s| s))
        })
    }

    /// Adds a highlight over a document range of display cells excluding newlines.
    pub fn highlight(&self, highlight: Highlight) -> Result<()> {
        let raw = highlight.raw();
        let (context, handle) = self.raw();
        check("ot_edit_buffer_highlight", unsafe {
            sys::ot_edit_buffer_highlight(context, handle, sys::OT_EDIT_HIGHLIGHT_ADD_RANGE, 0, &raw)
        })
    }

    pub fn remove_highlights(&self, tag: u16) -> Result<()> {
        let (context, handle) = self.raw();
        check("ot_edit_buffer_highlight", unsafe {
            sys::ot_edit_buffer_highlight(
                context,
                handle,
                sys::OT_EDIT_HIGHLIGHT_REMOVE_REF,
                u32::from(tag),
                std::ptr::null(),
            )
        })
    }

    /// Removes every highlight and empties every layer.
    pub fn clear_highlights(&self) -> Result<()> {
        let (context, handle) = self.raw();
        check("ot_edit_buffer_highlight", unsafe {
            sys::ot_edit_buffer_highlight(context, handle, sys::OT_EDIT_HIGHLIGHT_CLEAR_ALL, 0, std::ptr::null())
        })
    }

    /// Replaces layer `layer_id` inside `range` with `runs`. Both count UTF-8 bytes of [`Self::text`]; runs are sorted,
    /// disjoint, nonempty, and on character boundaries. Runs move with edits, and replacing the whole text empties
    /// the layer. Layers paint above highlights of priority 0 and below higher ones; a run without a link whose group
    /// set supplies no field (no fg, bg or attribute) paints as if absent. The editor widgets set layer 1 for filetype
    /// syntax; other layers on their buffers need another id.
    pub fn set_layer(&self, layer_id: u32, range: Range<u32>, runs: &[LayerRun]) -> Result<()> {
        let length = count("ot_edit_buffer_set_layer", runs.len())?;
        let (context, handle) = self.raw();
        check("ot_edit_buffer_set_layer", unsafe {
            sys::ot_edit_buffer_set_layer(context, handle, layer_id, range.start, range.end, runs.as_ptr(), length)
        })
    }

    /// Adds a mark over cursor offsets `range` and returns its id; a style paints by value at `priority`.
    pub(crate) fn add_mark(&self, range: Range<u32>, atomic: bool, style: Option<Style>, priority: u8) -> Result<u32> {
        let mut raw = sys::ot_edit_mark {
            start: range.start,
            end: range.end,
            priority: u32::from(priority),
            ..Default::default()
        };
        if atomic {
            raw.flags |= sys::OT_EDIT_MARK_ATOMIC;
        }
        if let Some(style) = style {
            raw.flags |= sys::OT_EDIT_MARK_STYLE_VALUE;
            raw.value = encode_supplied(style);
        }
        self.mark(sys::OT_EDIT_MARK_ADD, Some(&raw))
    }

    /// Removes mark `id`. Returns whether there was one.
    pub(crate) fn remove_mark(&self, id: u32) -> Result<bool> {
        let raw = sys::ot_edit_mark { id, ..Default::default() };
        Ok(self.mark(sys::OT_EDIT_MARK_REMOVE, Some(&raw))? != 0)
    }

    pub(crate) fn clear_marks(&self) -> Result<()> {
        self.mark(sys::OT_EDIT_MARK_CLEAR, None).map(drop)
    }

    fn mark(&self, operation: u32, raw: Option<&sys::ot_edit_mark>) -> Result<u32> {
        let mut id = 0;
        let out = if raw.is_some() { &mut id as *mut u32 } else { std::ptr::null_mut() };
        let (context, handle) = self.raw();
        check("ot_edit_buffer_mark", unsafe {
            sys::ot_edit_buffer_mark(context, handle, operation, raw.map_or(std::ptr::null(), |raw| raw), out)
        })?;
        Ok(id)
    }

    /// Every mark in (start, id) order, with its style value decoded.
    pub(crate) fn marks(&self) -> Result<Vec<(sys::ot_edit_mark, Option<Style>)>> {
        let (context, handle) = self.raw();
        let mut length = 0;
        let any = sys::OT_EDIT_MARK_ANY_KIND;
        #[cfg(test)]
        MARK_READS.with(|reads| reads.set(reads.get() + 1));
        check("ot_edit_buffer_get_marks", unsafe {
            sys::ot_edit_buffer_get_marks(context, handle, 0, any, std::ptr::null_mut(), 0, &mut length)
        })?;
        if length == 0 {
            return Ok(Vec::new());
        }
        let mut marks = vec![sys::ot_edit_mark::default(); length as usize];
        #[cfg(test)]
        MARK_READS.with(|reads| reads.set(reads.get() + 1));
        check("ot_edit_buffer_get_marks", unsafe {
            sys::ot_edit_buffer_get_marks(context, handle, 0, any, marks.as_mut_ptr(), length, &mut length)
        })?;
        Ok(marks
            .into_iter()
            .map(|mark| (mark, (mark.flags & sys::OT_EDIT_MARK_STYLE_VALUE != 0).then(|| decode_style(&mark.value))))
            .collect())
    }
}

/// A style value as `encode_supplied` wrote it.
fn decode_style(raw: &sys::ot_editor_style) -> Style {
    let color = |flag, words| (raw.flags & flag != 0).then(|| Color::from_raw(words));
    Style {
        fg: color(sys::OT_EDITOR_STYLE_FOREGROUND, raw.foreground),
        bg: color(sys::OT_EDITOR_STYLE_BACKGROUND, raw.background),
        attributes: crate::style::Attributes::from_bits(raw.attributes as u8),
    }
}

/// One run of a highlight layer: UTF-8 bytes `start_byte..end_byte`, painted with the group set `group_set`.
pub type LayerRun = sys::ot_highlight_run;

impl Context {
    /// The id of an ordered list of style names, for [`LayerRun`]s. Equal lists give equal ids on this Context. Paint
    /// composes the names against the buffer's style table, later names winning. A list holds at most
    /// [`OT_GROUP_SET_NAME_COUNT_MAX`](sys::OT_GROUP_SET_NAME_COUNT_MAX) (16) names of at most
    /// [`OT_GROUP_SET_NAME_BYTE_COUNT_MAX`](sys::OT_GROUP_SET_NAME_BYTE_COUNT_MAX) (64) bytes. Ids are never freed: a
    /// Context holds at most 4,096 lists and 64 KiB of names in them, so 2,621 one-name lists of 25 bytes. Past a
    /// bound, new lists fail with [`Status::ObjectLimit`](crate::Status::ObjectLimit).
    pub fn group_set(&self, names: &[&str]) -> Result<u32> {
        let mut ends = Vec::with_capacity(names.len());
        let mut pool = String::new();
        for name in names {
            pool.push_str(name);
            ends.push(count("ot_context_group_set", pool.len())?);
        }
        let (byte_count, name_count) =
            (count("ot_context_group_set", pool.len())?, count("ot_context_group_set", ends.len())?);
        let mut id = 0;
        check("ot_context_group_set", unsafe {
            sys::ot_context_group_set(self.as_raw(), pool.as_ptr(), byte_count, ends.as_ptr(), name_count, &mut id)
        })?;
        Ok(id)
    }
}

/// The visible region of an editor or text view, in display cells.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Viewport {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// A cursor position in an editor view.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EditorPosition {
    /// Row within the viewport's wrapped lines.
    pub visual_row: u32,
    /// Display cells from the viewport's left edge.
    pub visual_col: u32,
    /// Zero-based logical line.
    pub logical_row: u32,
    /// Display cells from the logical line start.
    pub logical_col: u32,
    /// Display cells from the document start, counting one per newline.
    pub offset: u32,
}

/// Where [`EditorView::position`] looks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EditorQuery {
    Cursor,
    NextWord,
    PrevWord,
    EndOfLine,
    VisualLineStart,
    VisualLineEnd,
}

/// How a mouse selection grows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SelectionUnit {
    #[default]
    Cell,
    Word,
    Line,
}

impl SelectionUnit {
    pub(crate) fn raw(self) -> u32 {
        match self {
            Self::Cell => sys::OT_SELECTION_CELL,
            Self::Word => sys::OT_SELECTION_WORD,
            Self::Line => sys::OT_SELECTION_LINE,
        }
    }
}

/// Selection colors. `None` keeps the text's own color.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SelectionColors {
    pub fg: Option<Color>,
    pub bg: Option<Color>,
}

impl SelectionColors {
    /// The editor and text views' selection record, whose flags are `OT_SCENE_TEXT_FOREGROUND` and `_BACKGROUND`.
    pub(super) fn editor_selection(self, operation: u32) -> sys::ot_editor_selection {
        let mut raw = sys::ot_editor_selection { operation, ..Default::default() };
        if let Some(color) = self.fg {
            raw.flags |= sys::OT_SCENE_TEXT_FOREGROUND;
            raw.foreground = color.to_raw();
        }
        if let Some(color) = self.bg {
            raw.flags |= sys::OT_SCENE_TEXT_BACKGROUND;
            raw.background = color.to_raw();
        }
        raw
    }
}

/// Editor view state.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EditorInfo {
    /// Wrapped lines inside the viewport.
    pub virtual_line_count: u32,
    /// All wrapped lines.
    pub total_virtual_line_count: u32,
    /// Selected document offsets, start inclusive and end exclusive.
    pub selection: Option<(u32, u32)>,
}

/// Cursor display for an editor node. The cursor shows only while the node has scene focus.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EditorOptions {
    pub show_cursor: bool,
    pub style: CursorStyle,
    pub blinking: bool,
    pub color: Color,
    /// The pointer shape native code sets on every frame the editor has focus, wherever the pointer is; `None`, the
    /// default as in Core, leaves it unchanged. [`crate::widget::Widget::mouse_pointer`] sets a shape for hovering.
    pub mouse_pointer: Option<MousePointer>,
}

impl Default for EditorOptions {
    fn default() -> Self {
        Self {
            show_cursor: true,
            style: CursorStyle::Block,
            blinking: true,
            color: Color::rgb(255, 255, 255),
            mouse_pointer: None,
        }
    }
}

/// A view of an [`EditBuffer`] with wrapping, scrolling, and selection. It keeps its buffer alive.
#[derive(Clone)]
pub struct EditorView(Rc<ViewOwner>);

struct ViewOwner {
    // Field order matters: the view must be destroyed before its buffer.
    view: Resource,
    buffer: EditBuffer,
}

impl EditorView {
    pub fn new(buffer: &EditBuffer, width: u32, height: u32) -> Result<Self> {
        let source = buffer.0.handle();
        let view = Resource::create(
            buffer.context(),
            "ot_editor_view_create",
            ("ot_editor_view_destroy", sys::ot_editor_view_destroy),
            |context, handle| unsafe { sys::ot_editor_view_create(context, &source, width, height, handle) },
        )?;
        Ok(Self(Rc::new(ViewOwner { view, buffer: buffer.clone() })))
    }

    pub fn buffer(&self) -> &EditBuffer {
        &self.0.buffer
    }

    pub(crate) fn handle(&self) -> sys::ot_handle {
        self.0.view.handle()
    }

    fn raw(&self) -> (*mut sys::ot_context, *const sys::ot_handle) {
        self.0.view.raw()
    }

    /// Moves the viewport. `move_cursor` keeps the cursor inside it.
    pub fn set_viewport(&self, viewport: Viewport, move_cursor: bool) -> Result<()> {
        let raw = sys::ot_editor_viewport {
            x: viewport.x,
            y: viewport.y,
            width: viewport.width,
            height: viewport.height,
            ..Default::default()
        };
        let (context, handle) = self.raw();
        check("ot_editor_view_set_viewport", unsafe {
            sys::ot_editor_view_set_viewport(context, handle, &raw, 0, u32::from(move_cursor))
        })
    }

    /// Edits and cursor moves do not lay out the text; they make a scroll to the cursor due, which this applies
    /// first. While a scroll is due, it can lay out the text and fail with out of memory.
    pub fn viewport(&self) -> Result<Viewport> {
        let mut raw = sys::ot_editor_viewport::default();
        let (context, handle) = self.raw();
        check("ot_editor_view_get_viewport", unsafe { sys::ot_editor_view_get_viewport(context, handle, &mut raw) })?;
        Ok(Viewport { x: raw.x, y: raw.y, width: raw.width, height: raw.height })
    }

    /// The fraction of the viewport kept between the cursor and the edge while scrolling.
    pub fn set_scroll_margin(&self, margin: f32) -> Result<()> {
        let (context, handle) = self.raw();
        check("ot_editor_view_set_scroll_margin", unsafe {
            sys::ot_editor_view_set_scroll_margin(context, handle, margin)
        })
    }

    fn command(&self, command: u32, argument: u32) -> Result<()> {
        let (context, handle) = self.raw();
        check("ot_editor_view_command", unsafe { sys::ot_editor_view_command(context, handle, command, argument) })
    }

    /// Moves the cursor one wrapped line up.
    /// Moves up one wrapped row.
    pub fn move_up(&self) -> Result<()> {
        self.command(sys::OT_EDITOR_MOVE_UP, 0)
    }

    /// Moves down one wrapped row.
    pub fn move_down(&self) -> Result<()> {
        self.command(sys::OT_EDITOR_MOVE_DOWN, 0)
    }

    /// Moves one wrapped line down or up; landing in an atomic mark leaves it by its nearer edge, as
    /// [`EditBuffer::command_atomic`] moves do.
    pub fn move_atomic(&self, down: bool) -> Result<()> {
        ruled();
        self.command(if down { sys::OT_EDITOR_MOVE_DOWN } else { sys::OT_EDITOR_MOVE_UP }, sys::OT_EDIT_ATOMIC)
    }

    /// Moves the cursor to the end of its wrapped line.
    pub fn goto_visual_line_end(&self) -> Result<()> {
        self.command(sys::OT_EDITOR_GOTO_LINE_END, 0)
    }

    pub fn delete_selection(&self) -> Result<()> {
        self.command(sys::OT_EDITOR_DELETE_SELECTION, 0)
    }

    /// Moves the cursor in document display cells, counting one per newline.
    pub fn set_cursor_offset(&self, offset: u32) -> Result<()> {
        self.command(sys::OT_EDITOR_CURSOR_OFFSET, offset)
    }

    pub fn set_wrap(&self, wrap: WrapMode) -> Result<()> {
        self.command(sys::OT_EDITOR_WRAP_MODE, wrap.raw())
    }

    pub fn set_tab_indicator(&self, indicator: Option<char>) -> Result<()> {
        self.command(sys::OT_EDITOR_TAB_INDICATOR, indicator.map_or(0, u32::from))
    }

    /// Replaces the selection with `text`, or inserts it at the cursor, as one undoable edit.
    pub fn replace_selection(&self, text: &str) -> Result<()> {
        let length = count("ot_editor_view_replace_selection", text.len())?;
        let (context, handle) = self.raw();
        let mut steps = 0;
        check("ot_editor_view_replace_selection", unsafe {
            sys::ot_editor_view_replace_selection(context, handle, text.as_ptr(), length, &mut steps)
        })
    }

    fn select(&self, raw: sys::ot_editor_selection) -> Result<bool> {
        let (context, handle) = self.raw();
        let mut changed = 0;
        check("ot_editor_view_select", unsafe { sys::ot_editor_view_select(context, handle, &raw, &mut changed) })?;
        Ok(changed != 0)
    }

    /// Selects `start..end` in document display cells, counting one per newline.
    pub fn select_range(&self, start: u32, end: u32, colors: SelectionColors) -> Result<()> {
        self.select(sys::ot_editor_selection { start, end, ..colors.editor_selection(sys::OT_EDITOR_SELECT_SET) })
            .map(drop)
    }

    /// Selects document cells (one per newline) and, in cell occupancy, includes the grapheme at the larger
    /// offset unless a line ends there.
    pub fn select_inclusive(&self, start: u32, end: u32, colors: SelectionColors) -> Result<()> {
        self.select(sys::ot_editor_selection { start, end, ..colors.editor_selection(sys::OT_EDITOR_SELECT_INCLUSIVE) })
            .map(drop)
    }

    /// Makes a word or line selection a cell one from its start to its last cell, and puts the cursor on that cell.
    pub fn convert_selection_to_cell(&self) -> Result<bool> {
        self.select(sys::ot_editor_selection { operation: sys::OT_EDITOR_SELECT_CELL, ..Default::default() })
    }

    pub fn clear_selection(&self) -> Result<()> {
        self.select(sys::ot_editor_selection { operation: sys::OT_EDITOR_SELECT_RESET, ..Default::default() })?;
        self.select(sys::ot_editor_selection { operation: sys::OT_EDITOR_SELECT_LOCAL_RESET, ..Default::default() })
            .map(drop)
    }

    /// Starts (`extend == false`) or extends a selection between two viewport-local cells, as a mouse drag does.
    /// `move_cursor` puts the cursor at `focus`. Returns whether the selection changed.
    pub fn select_local(
        &self,
        anchor: (i32, i32),
        focus: (i32, i32),
        extend: bool,
        unit: SelectionUnit,
        move_cursor: bool,
        colors: SelectionColors,
    ) -> Result<bool> {
        let operation = if extend { sys::OT_EDITOR_SELECT_LOCAL_UPDATE } else { sys::OT_EDITOR_SELECT_LOCAL };
        self.select(sys::ot_editor_selection {
            behavior: unit.raw(),
            anchor_x: anchor.0,
            anchor_y: anchor.1,
            focus_x: focus.0,
            focus_y: focus.1,
            update_cursor: u32::from(move_cursor),
            ..colors.editor_selection(operation)
        })
    }

    /// Reads the state. `follow_cursor` scrolls so the cursor is visible first, as a frame does; otherwise only a
    /// scroll that an earlier cursor change made due applies.
    pub fn info(&self, follow_cursor: bool) -> Result<EditorInfo> {
        let mut raw = sys::ot_editor_view_info::default();
        let (context, handle) = self.raw();
        check("ot_editor_view_get_info", unsafe {
            sys::ot_editor_view_get_info(context, handle, u32::from(follow_cursor), &mut raw)
        })?;
        Ok(EditorInfo {
            virtual_line_count: raw.virtual_line_count,
            total_virtual_line_count: raw.total_virtual_line_count,
            selection: (raw.selection_present != 0).then_some((raw.selection_start, raw.selection_end)),
        })
    }

    /// The viewport's wrapped lines, from its first visible row.
    pub fn lines(&self) -> Result<Vec<super::VisualLine>> {
        let (context, handle) = self.raw();
        let mut measure = sys::ot_editor_measure::default();
        check("ot_editor_view_get_lines", unsafe {
            sys::ot_editor_view_get_lines(context, handle, 0, std::ptr::null_mut(), 0, &mut measure)
        })?;
        let mut lines = vec![sys::ot_scene_text_line::default(); measure.line_count as usize];
        if lines.is_empty() {
            return Ok(Vec::new());
        }
        check("ot_editor_view_get_lines", unsafe {
            sys::ot_editor_view_get_lines(context, handle, 0, lines.as_mut_ptr(), lines.len() as u32, &mut measure)
        })?;
        lines.truncate(measure.line_count as usize);
        Ok(lines
            .iter()
            .map(|line| super::VisualLine {
                start_column: line.start_cols,
                width: line.width_cols,
                source_line: line.source_line,
                wrap_index: line.wrap_index,
            })
            .collect())
    }

    /// Half-open bounds in document display cells, counting one per newline, without preparing lines.
    pub fn selection(&self) -> Result<Option<(u32, u32)>> {
        let mut raw = sys::ot_editor_view_info::default();
        let (context, handle) = self.raw();
        check("ot_editor_view_get_selection", unsafe { sys::ot_editor_view_get_selection(context, handle, &mut raw) })?;
        Ok((raw.selection_present != 0).then_some((raw.selection_start, raw.selection_end)))
    }

    /// Returns the selected UTF-8 text; string slicing uses byte indices, not selection offsets.
    pub fn selected_text(&self) -> Result<String> {
        let (context, handle) = self.raw();
        read_string("ot_editor_view_get_selected_text", |bytes, capacity, length| unsafe {
            sys::ot_editor_view_get_selected_text(context, handle, bytes, capacity, length)
        })
    }

    /// Queries logical and viewport cell coordinates. The document offset counts one cell per newline.
    pub fn position(&self, query: EditorQuery) -> Result<EditorPosition> {
        let code = match query {
            EditorQuery::Cursor => sys::OT_EDITOR_POSITION_CURSOR,
            EditorQuery::NextWord => sys::OT_EDITOR_POSITION_NEXT_WORD,
            EditorQuery::PrevWord => sys::OT_EDITOR_POSITION_PREV_WORD,
            EditorQuery::EndOfLine => sys::OT_EDITOR_POSITION_EOL,
            EditorQuery::VisualLineStart => sys::OT_EDITOR_POSITION_VISUAL_SOL,
            EditorQuery::VisualLineEnd => sys::OT_EDITOR_POSITION_VISUAL_EOL,
        };
        let mut raw = sys::ot_editor_position::default();
        let (context, handle) = self.raw();
        check("ot_editor_view_get_position", unsafe {
            sys::ot_editor_view_get_position(context, handle, code, &mut raw)
        })?;
        Ok(EditorPosition {
            visual_row: raw.visual_row,
            visual_col: raw.visual_col,
            logical_row: raw.logical_row,
            logical_col: raw.logical_col,
            offset: raw.offset,
        })
    }

    /// Text shown while the buffer is empty. Links are not supported.
    pub fn set_placeholder(&self, spans: &[Span<'_>]) -> Result<()> {
        let mut encoded = EncodedSpans::new(spans);
        for chunk in &mut encoded.chunks {
            chunk.flags &= !sys::OT_SCENE_TEXT_LINK;
            (chunk.link_offset, chunk.link_byte_count) = (0, 0);
        }
        const OPERATION: &str = "ot_editor_view_set_placeholder";
        let (bytes, chunks) = (count(OPERATION, encoded.bytes.len())?, count(OPERATION, encoded.chunks.len())?);
        let (context, handle) = self.raw();
        check(OPERATION, unsafe {
            sys::ot_editor_view_set_placeholder(
                context,
                handle,
                encoded.bytes.as_ptr(),
                bytes,
                encoded.chunks.as_ptr(),
                chunks,
            )
        })
    }

    /// The (rows, widest row) the text needs at `width` by `height` cells.
    pub fn measure(&self, width: u32, height: u32) -> Result<(u32, u32)> {
        let mut raw = sys::ot_editor_measure::default();
        let (context, handle) = self.raw();
        check("ot_editor_view_measure", unsafe {
            sys::ot_editor_view_measure(context, handle, width, height, &mut raw)
        })?;
        Ok((raw.line_count, raw.width_cols_max))
    }
}

impl Node {
    /// Binds an editor view to an [`NodeKind::Editor`](super::NodeKind::Editor) node, or unbinds with `None`. The
    /// node paints the view, sizes its viewport, and measures from its content.
    pub fn set_editor_view(&self, view: Option<&EditorView>) -> Result<()> {
        let view = view.map(EditorView::handle);
        check("ot_scene_set_editor_view", unsafe {
            sys::ot_scene_set_editor_view(
                self.context_raw(),
                &self.handle(),
                view.as_ref().map_or(std::ptr::null(), |v| v),
            )
        })
    }

    pub fn set_editor_options(&self, options: &EditorOptions) -> Result<()> {
        let raw = sys::ot_scene_editor_options {
            show_cursor: u32::from(options.show_cursor),
            style: u32::from(options.style.raw()),
            blinking: u32::from(options.blinking),
            color: options.color.to_raw(),
            mouse_pointer: options.mouse_pointer.map_or(sys::OT_MOUSE_POINTER_UNCHANGED, MousePointer::raw),
            ..Default::default()
        };
        check("ot_scene_set_editor_options", unsafe {
            sys::ot_scene_set_editor_options(self.context_raw(), &self.handle(), &raw)
        })
    }
}
