//! Editing behavior shared by [`Input`](super::Input) and [`Textarea`](super::Textarea), ported from OpenTUI Core's
//! `EditBufferRenderable` and `Textarea` key bindings.

use super::extmarks::{self, Extmark, ExtmarkId, ExtmarkOptions, Extmarks};
use super::{Behavior, Callbacks, Element, SelectionUpdate, VisibleLines, build};
use crate::app::{App, Cx};
use crate::error::Result;
use crate::input::{KeyEvent, Keymap, MouseEvent, MouseEventKind};
use crate::native::{
    EditBuffer, EditCommand, EditQuery, EditorOptions, EditorQuery, EditorView, Highlight, Hooks, LayerRun, NodeKind,
    SelectionColors, SelectionUnit, SyntaxStyle, Viewport, WrapMode,
};
use crate::style::{Color, Span, Style};
use crate::syntax::{self, SyntaxTheme};
use std::cell::{Cell, RefCell};
use std::cmp::Ordering;
use std::rc::Rc;

/// What a key does in an [`Input`](super::Input) or [`Textarea`](super::Textarea). Bind keys to actions with
/// `bind`, or run one directly with `perform`.
///
/// Movement collapses a selection; the `Select` variants extend it from where it started. Lines are logical lines
/// (between line breaks); visual lines are the rows wrapping produces.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EditorAction {
    MoveLeft,
    MoveRight,
    MoveUp,
    MoveDown,
    SelectLeft,
    SelectRight,
    SelectUp,
    SelectDown,
    /// The start of the line, or the end of the previous line when already at the start.
    LineHome,
    /// The end of the line, or the start of the next line when already at the end.
    LineEnd,
    SelectLineHome,
    SelectLineEnd,
    VisualLineHome,
    VisualLineEnd,
    SelectVisualLineHome,
    SelectVisualLineEnd,
    BufferHome,
    BufferEnd,
    SelectBufferHome,
    SelectBufferEnd,
    DeleteLine,
    DeleteToLineEnd,
    DeleteToLineStart,
    Backspace,
    Delete,
    /// Inserts a line break. Does nothing in an [`Input`](super::Input).
    Newline,
    Undo,
    Redo,
    WordForward,
    WordBackward,
    SelectWordForward,
    SelectWordBackward,
    DeleteWordForward,
    DeleteWordBackward,
    SelectAll,
    /// Calls the widget's submit handlers with its text.
    Submit,
    /// Inserts the system clipboard's text, read with [`App::read_clipboard`]. Unbound by default: the terminal's own
    /// paste command already arrives as a paste, and reaches the user's clipboard over SSH too.
    Paste,
}

/// Adds the extmark methods to an editing widget whose only field is an `Rc<EditorCore>`.
macro_rules! extmark_methods {
    () => {
        /// Marks a range of the text so it moves with edits: a styled decoration, or with
        /// [`ExtmarkOptions::atomic`], a token the cursor and deletions treat as one unit, such as a mention. Offsets
        /// count as the cursor's do; see [`Extmark`]. Replacing the text with `set_text` or `set_value` removes all
        /// marks, and undoing an edit does not bring back marks it removed.
        pub fn add_extmark(&self, range: std::ops::Range<u32>, options: ExtmarkOptions) -> ExtmarkId {
            self.0.add_extmark(range, options)
        }

        /// Removes a mark, keeping its text. Returns whether it existed.
        pub fn remove_extmark(&self, id: ExtmarkId) -> bool {
            self.0.remove_extmark(id)
        }

        pub fn clear_extmarks(&self) -> Self {
            self.0.clear_extmarks();
            self.clone()
        }

        /// Every mark, in order of position.
        pub fn extmarks(&self) -> Vec<Extmark> {
            self.0.extmarks()
        }

        /// A mark by id, or `None` once an edit or a call removed it.
        pub fn extmark(&self, id: ExtmarkId) -> Option<Extmark> {
            self.0.extmarks().into_iter().find(|mark| mark.id == id)
        }

        /// The marks that cover `offset`: they start at or before it and end after it.
        pub fn extmarks_at(&self, offset: u32) -> Vec<Extmark> {
            self.0.extmarks().into_iter().filter(|mark| mark.start <= offset && offset < mark.end).collect()
        }

        /// Moves the cursor to a document offset, clearing the selection. An offset inside an atomic mark moves to
        /// its nearer edge.
        pub fn set_cursor_offset(&self, offset: u32) -> Self {
            self.0.set_cursor_offset(offset);
            self.clone()
        }
    };
}
pub(crate) use extmark_methods;

/// Adds the cursor and view options both editing widgets share, as Core's `EditBufferOptions` has them.
macro_rules! editor_methods {
    () => {
        /// The cursor's shape and whether it blinks, while the widget has focus.
        pub fn cursor_style(&self, style: crate::native::CursorStyle, blinking: bool) -> Self {
            self.0.update_cursor(|options| (options.style, options.blinking) = (style, blinking));
            self.clone()
        }

        /// The cursor's color, from the theme by default.
        pub fn cursor_color(&self, color: Color) -> Self {
            self.0.update_cursor(|options| options.color = color);
            self.clone()
        }

        /// Shows the cursor while the widget has focus. On by default.
        pub fn show_cursor(&self, show: bool) -> Self {
            self.0.update_cursor(|options| options.show_cursor = show);
            self.clone()
        }

        /// The share of the view kept between the cursor and the edge while scrolling, from 0 to 0.5; 0.2 by
        /// default.
        pub fn scroll_margin(&self, margin: f32) -> Self {
            self.0.report(self.0.view.set_scroll_margin(margin.clamp(0.0, 0.5)));
            self.clone()
        }

        /// Draws tabs as this character, or as blank space with `None`, the default.
        pub fn tab_indicator(&self, indicator: Option<char>) -> Self {
            self.0.report(self.0.view.set_tab_indicator(indicator));
            self.clone()
        }

        /// Called with the cursor's row and display column after a key, paste, click, or action moves it.
        pub fn on_cursor_change(&self, mut handler: impl FnMut(&mut Cx<'_>, u32, u32) + 'static) -> Self {
            self.0.on_cursor.add(move |cx, &(row, col): &(u32, u32)| handler(cx, row, col));
            self.clone()
        }

        /// Called after every edit with the new text: typing, pasting, [`Self::insert`], and
        /// [`Self::perform`]. Replacing the whole text does not call it.
        pub fn on_change(&self, mut handler: impl FnMut(&mut Cx<'_>, &str) + 'static) -> Self {
            self.0.on_change.add(move |cx, text: &str| handler(cx, text));
            self.clone()
        }

        /// Text shown while the widget is empty.
        pub fn placeholder(&self, text: impl AsRef<str>) -> Self {
            self.0.set_placeholder(text.as_ref());
            self.clone()
        }

        pub fn placeholder_color(&self, color: Color) -> Self {
            self.0.colors.borrow_mut().placeholder = color;
            self.0.apply_colors(self.is_focused());
            self.clone()
        }

        /// The longest text it may hold: in UTF-16 code units for an `Input`, as Core counts `maxLength`, 1000 by
        /// default; in characters (Unicode scalar values) for a `Textarea`, unlimited by default. Longer text is cut
        /// to fit, leaving out a character that does not fit whole.
        pub fn max_length(&self, max: usize) -> Self {
            self.0.max_length.set(max);
            let text = self.0.text();
            if self.0.length(&text) > max {
                self.0.set_text(&text);
            }
            self.clone()
        }

        /// Display cells per tab stop, rounded up to an even number from 2 through 254.
        pub fn tab_width(&self, width: u32) -> Self {
            self.0.report(self.0.buffer.set_tab_width(width));
            self.clone()
        }

        /// Text and background colors while unfocused.
        pub fn colors(&self, fg: Color, bg: Color) -> Self {
            {
                let mut colors = self.0.colors.borrow_mut();
                (colors.fg, colors.bg) = (fg, bg);
            }
            self.0.apply_colors(self.is_focused());
            self.clone()
        }

        /// Text and background colors while focused.
        pub fn focused_colors(&self, fg: Color, bg: Color) -> Self {
            {
                let mut colors = self.0.colors.borrow_mut();
                (colors.focused_fg, colors.focused_bg) = (fg, bg);
            }
            self.0.apply_colors(self.is_focused());
            self.clone()
        }

        pub fn selection_colors(&self, colors: SelectionColors) -> Self {
            self.0.colors.borrow_mut().selection = colors;
            self.clone()
        }

        /// The cursor as a document offset: display columns, with one position per line break. For plain ASCII on
        /// one line, this is the character index.
        pub fn cursor_offset(&self) -> u32 {
            self.0.report(self.0.buffer.info()).map_or(0, |info| info.cursor_offset)
        }

        /// The selected text, or an empty string.
        pub fn selected_text(&self) -> String {
            use super::Behavior;
            self.0.selected_text().unwrap_or_default()
        }
    };
}
pub(crate) use editor_methods;

/// Core's Textarea bindings.
pub(crate) fn textarea_keymap() -> Keymap<EditorAction> {
    crate::tables::TEXTAREA_SHORTCUTS.iter().copied().collect()
}

/// Core's Input bindings: the Textarea's, with Enter and line feed submitting.
pub(crate) fn input_keymap() -> Keymap<EditorAction> {
    textarea_keymap().bind("enter", EditorAction::Submit).bind("linefeed", EditorAction::Submit)
}

/// Removes escape sequences and control characters, which the buffer would show as notation two or four cells wide.
/// `keep_newlines` keeps tab, CR, and LF; otherwise line breaks become nothing and tabs stay.
pub(crate) fn sanitize(text: &str, keep_newlines: bool) -> String {
    let mut output = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            '\x1b' => match chars.next() {
                Some('[') => while chars.next().is_some_and(|next| !('\x40'..='\x7e').contains(&next)) {},
                Some(']' | 'P' | '_' | '^' | 'X') => {
                    while let Some(next) = chars.next() {
                        if next == '\x07' || (next == '\x1b' && chars.next_if_eq(&'\\').is_some()) {
                            break;
                        }
                    }
                }
                _ => {}
            },
            '\t' => output.push('\t'),
            '\n' | '\r' if keep_newlines => output.push(character),
            _ if character.is_control() => {}
            _ => output.push(character),
        }
    }
    output
}

pub(crate) struct Colors {
    pub fg: Color,
    pub bg: Color,
    pub focused_fg: Color,
    pub focused_bg: Color,
    pub placeholder: Color,
    pub selection: SelectionColors,
}

/// State shared by the editing widgets.
pub(crate) struct EditorCore {
    pub element: Element,
    pub buffer: EditBuffer,
    pub view: EditorView,
    pub single_line: bool,
    pub max_length: Cell<usize>,
    /// The document offset a keyboard selection started from.
    anchor: Cell<Option<u32>>,
    /// The side a mouse drag came from, which a cursor it left in an atomic mark leaves by once the selection goes.
    pointer_side: Cell<Ordering>,
    /// The unit a mouse selection grows by, until a keyboard selection extends it by cells.
    pointer_unit: Cell<SelectionUnit>,
    pub colors: RefCell<Colors>,
    placeholder: RefCell<String>,
    pub on_change: Callbacks<str>,
    pub on_submit: Callbacks<str>,
    pub keymap: RefCell<Keymap<EditorAction>>,
    extmarks: RefCell<Extmarks>,
    /// Set while an edit is tracked for extmarks, so nested edits are counted once.
    tracking: Cell<bool>,
    cursor_options: Cell<EditorOptions>,
    pub on_cursor: Callbacks<(u32, u32)>,
    filetype: RefCell<Option<String>>,
    syntax_theme: RefCell<SyntaxTheme>,
    /// The content epoch highlighted last, or `None` when the next frame highlights the text.
    highlighted: Cell<Option<u64>>,
}

impl EditorCore {
    pub fn build(app: &App, single_line: bool) -> Rc<Self> {
        let theme = app.theme();
        let session = app.session();
        let buffer = app.report(EditBuffer::new(session.context(), app.width_method()));
        let buffer = match buffer {
            Some(buffer) => buffer,
            // A Context too full for a buffer has failed already; the report ends the app this turn.
            None => panic!("opentui: failed to create an edit buffer: {:?}", app.check()),
        };
        let view = match app.report(EditorView::new(&buffer, 1, 1)) {
            Some(view) => view,
            None => panic!("opentui: failed to create an editor view: {:?}", app.check()),
        };
        let core = build(app, NodeKind::Editor, |element| Self {
            element,
            buffer,
            view,
            single_line,
            max_length: Cell::new(if single_line { 1000 } else { usize::MAX }),
            anchor: Cell::new(None),
            pointer_side: Cell::new(Ordering::Equal),
            pointer_unit: Cell::new(SelectionUnit::Cell),
            colors: RefCell::new(Colors {
                fg: theme.foreground,
                bg: theme.input_bg,
                focused_fg: theme.foreground,
                focused_bg: theme.input_focused_bg,
                placeholder: theme.muted,
                selection: SelectionColors { fg: Some(theme.selection_fg), bg: Some(theme.selection_bg) },
            }),
            placeholder: RefCell::new(String::new()),
            on_change: Callbacks::default(),
            on_submit: Callbacks::default(),
            keymap: RefCell::new(if single_line { input_keymap() } else { textarea_keymap() }),
            extmarks: RefCell::new(Extmarks::default()),
            tracking: Cell::new(false),
            cursor_options: Cell::new(EditorOptions { color: theme.cursor, ..Default::default() }),
            on_cursor: Callbacks::default(),
            filetype: RefCell::new(None),
            syntax_theme: RefCell::new(SyntaxTheme::from_theme(&theme)),
            highlighted: Cell::new(None),
        });
        core.element.set_focusable(true);
        core.element.pointer.set(Some(crate::native::MousePointer::TEXT));
        let view = core.view.clone();
        core.element.apply(|node| {
            node.set_editor_view(Some(&view))?;
            node.set_editor_options(&EditorOptions { color: theme.cursor, ..Default::default() })
        });
        core.report(core.view.set_scroll_margin(0.2));
        if single_line {
            core.report(core.view.set_wrap(WrapMode::None));
            core.element.set_layout(crate::layout::LayoutProperty::FixedHeight(1.into()));
        } else {
            core.report(core.view.set_wrap(WrapMode::Word));
        }
        core.apply_colors(false);
        core
    }

    pub fn report<T>(&self, result: Result<T>) -> Option<T> {
        match self.element.app() {
            Some(app) => {
                app.request_redraw();
                app.report(result)
            }
            None => result.ok(),
        }
    }

    pub fn apply_colors(&self, focused: bool) {
        let (fg, bg) = {
            let colors = self.colors.borrow();
            if focused { (colors.focused_fg, colors.focused_bg) } else { (colors.fg, colors.bg) }
        };
        self.report(self.buffer.set_defaults(Style::new().fg(fg).bg(bg)));
        self.element.update_paint(|paint| {
            paint.fill = true;
            paint.background = bg;
        });
        self.refresh_placeholder();
    }

    pub fn set_placeholder(&self, text: &str) {
        *self.placeholder.borrow_mut() = text.to_owned();
        self.refresh_placeholder();
    }

    fn refresh_placeholder(&self) {
        let color = self.colors.borrow().placeholder;
        let text = self.placeholder.borrow();
        let spans =
            if text.is_empty() { Vec::new() } else { vec![Span::styled(text.as_str(), Style::new().fg(color))] };
        self.report(self.view.set_placeholder(&spans));
    }

    pub fn text(&self) -> String {
        self.report(self.buffer.text()).unwrap_or_default()
    }

    fn epoch(&self) -> u64 {
        self.report(self.buffer.info()).map_or(0, |info| info.content_epoch)
    }

    fn cursor(&self) -> (u32, u32, u32) {
        self.report(self.buffer.info()).map_or((0, 0, 0), |info| (info.cursor.0, info.cursor.1, info.cursor_offset))
    }

    /// Replaces the text without undo history, then moves the cursor to the end.
    pub fn set_text(&self, text: &str) {
        // The replacement removes all current text.
        let text = self.limit(&sanitize(text, !self.single_line), usize::MAX);
        self.clear_selection_state();
        self.report(self.buffer.set_text(&text, false));
        self.goto_buffer_end();
        if !self.extmarks.borrow().marks.is_empty() {
            self.extmarks.borrow_mut().marks.clear();
            self.refresh_extmarks();
        }
    }

    /// The units `max_length` counts a character in: UTF-16 code units in an `Input`, one per character in a `Textarea`.
    fn units(&self, character: char) -> usize {
        if self.single_line { character.len_utf16() } else { 1 }
    }

    pub(crate) fn length(&self, text: &str) -> usize {
        text.chars().map(|character| self.units(character)).sum()
    }

    /// Cuts `text` so the document stays within the maximum length, given `removed` units being replaced.
    fn limit(&self, text: &str, removed: usize) -> String {
        let max = self.max_length.get();
        if max == usize::MAX {
            return text.to_owned();
        }
        let current = if text.is_empty() { 0 } else { self.length(&self.text()) };
        let mut room = max.saturating_sub(current.saturating_sub(removed));
        text.chars().take_while(|c| room.checked_sub(self.units(*c)).map(|left| room = left).is_some()).collect()
    }

    fn clear_selection_state(&self) {
        self.anchor.set(None);
        self.report(self.view.clear_selection());
    }

    fn selection(&self) -> Option<(u32, u32)> {
        self.report(self.view.selection()).flatten().filter(|(start, end)| start != end)
    }

    /// Inserts text at the cursor, replacing any selection.
    pub fn insert(&self, text: &str) {
        let text = sanitize(text, !self.single_line);
        let removed =
            self.selection().map_or(0, |_| self.length(&self.report(self.view.selected_text()).unwrap_or_default()));
        let text = self.limit(&text, removed);
        if text.is_empty() {
            return;
        }
        self.anchor.set(None);
        self.report(self.view.replace_selection(&text));
        self.report(self.view.clear_selection());
    }

    fn delete_selection(&self) -> bool {
        let selected = self.selection().is_some();
        if selected {
            self.report(self.view.delete_selection());
        }
        self.clear_selection_state();
        selected
    }

    /// Moves the cursor. With `select`, extends the selection from where it started; otherwise clears it.
    fn movement(&self, select: bool, collapse: Option<bool>, step: impl FnOnce(&Self)) {
        if select {
            // A keyboard selection belongs to this editor alone.
            if let Some(app) = self.element.app() {
                app.keep_selection_only(&self.element);
            }
            // Extend a keyboard selection from its anchor offset; with none, start at the cursor's cell. A mouse
            // selection keeps the anchor cell native pinned; as Core's, a word or line one becomes a cell one first.
            let cursor = self.cursor().2;
            let start = match (self.selection(), self.anchor.get()) {
                (Some((start, end)), Some(anchor)) if (start..=end).contains(&anchor) => Some(anchor),
                (Some(_), _) => None,
                (None, _) => Some(cursor),
            };
            if start.is_none() && self.pointer_unit.replace(SelectionUnit::Cell) != SelectionUnit::Cell {
                self.report(self.view.convert_selection_to_cell());
            }
            let before = self.cursor().2;
            step(self);
            self.keep_cursor_outside(self.cursor().2.cmp(&before));
            let cursor = self.cursor().2;
            self.anchor.set(start);
            let colors = self.colors.borrow().selection;
            match start {
                Some(start) if start == cursor => self.report(self.view.clear_selection()),
                Some(start) => self.report(self.view.select_inclusive(start, cursor, colors)),
                // A mouse selection's focus moves to the cursor's cell, in viewport-local cells.
                None => self.report(self.view.position(EditorQuery::Cursor)).and_then(|at| {
                    let focus = (at.visual_col as i32, at.visual_row as i32);
                    self.report(self.view.select_local((0, 0), focus, true, SelectionUnit::Cell, false, colors))
                        .map(drop)
                }),
            };
            return;
        }
        // Horizontal movement collapses a selection to its edge without taking another step.
        if let (Some(to_end), Some((start, end))) = (collapse, self.selection()) {
            self.clear_selection_state();
            self.report(self.buffer.command(EditCommand::CursorOffset(if to_end { end } else { start })));
            return;
        }
        self.clear_selection_state();
        let before = self.cursor().2;
        step(self);
        self.keep_cursor_outside(self.cursor().2.cmp(&before));
    }

    /// Moves the cursor one column, past atomic marks as Core moves past virtual ones (`extmarks.ts`): left from a
    /// mark's end goes to the start of the character before it, and right from at most its start goes to its end. A live
    /// selection moves one character, as Core's does.
    fn step_horizontal(&self, forward: bool) {
        let before = self.cursor().2;
        let marks = self.extmarks.borrow();
        let edge = if self.selection().is_some() {
            None
        } else if forward {
            marks.atomic_containing(before + 1).filter(|mark| before <= mark.start).map(|mark| mark.end)
        } else {
            before
                .checked_sub(1)
                .and_then(|target| marks.atomic_containing(target))
                .filter(|mark| before >= mark.end)
                .map(|mark| mark.start)
        };
        drop(marks);
        let command = match edge {
            Some(end) if forward => EditCommand::CursorOffset(end),
            Some(start) => return self.move_before(start),
            None if forward => EditCommand::MoveRight,
            None => EditCommand::MoveLeft,
        };
        self.report(self.buffer.command(command));
    }

    /// One unit step left from a mark's start, so a wide character or a tab before it is not split.
    fn move_before(&self, start: u32) {
        self.report(self.buffer.command(EditCommand::CursorOffset(start)));
        self.report(self.buffer.command(EditCommand::MoveLeft));
    }

    /// Moves the cursor one visual row. Landing in an atomic mark sends it to the nearer edge, as Core's: before the
    /// start, or the end. Moving down never goes back to or before where it started.
    fn step_vertical(&self, down: bool) {
        let before = self.cursor().2;
        self.report(if down { self.view.move_down() } else { self.view.move_up() });
        let after = self.cursor().2;
        let Some(mark) = self.extmarks.borrow().atomic_containing(after) else { return };
        if after - mark.start < mark.end - after {
            self.move_before(mark.start);
            if !down || self.cursor().2 > before {
                return;
            }
        }
        // Past later marks that overlap the end, so the cursor is not left inside one.
        self.report(self.buffer.command(EditCommand::CursorOffset(self.outside(mark.end, true))));
    }

    fn goto_buffer_end(&self) {
        let lines = self.report(self.buffer.info()).map_or(1, |info| info.line_count);
        self.report(self.buffer.command(EditCommand::GotoLine(lines.saturating_sub(1))));
        if let Some(Some(end)) = self.report(self.buffer.position(EditQuery::EndOfLine)) {
            self.report(self.buffer.set_cursor(end.row, end.col));
        }
    }

    fn end_of_line(&self) -> Option<(u32, u32)> {
        self.report(self.buffer.position(EditQuery::EndOfLine)).flatten().map(|end| (end.row, end.col))
    }

    fn line_home(&self) {
        let (row, col, _) = self.cursor();
        if col == 0 && row > 0 {
            self.report(self.buffer.set_cursor(row - 1, 0));
            if let Some(end) = self.end_of_line() {
                self.report(self.buffer.set_cursor(end.0, end.1));
            }
        } else {
            self.report(self.buffer.set_cursor(row, 0));
        }
    }

    fn line_end(&self) {
        let (row, col, _) = self.cursor();
        let lines = self.report(self.buffer.info()).map_or(1, |info| info.line_count);
        match self.end_of_line() {
            Some((_, end)) if col == end && row + 1 < lines => {
                self.report(self.buffer.set_cursor(row + 1, 0));
            }
            Some(end) => {
                self.report(self.buffer.set_cursor(end.0, end.1));
            }
            None => {}
        }
    }

    fn visual_line_home(&self) {
        if let Some(start) = self.report(self.view.position(EditorQuery::VisualLineStart)) {
            self.report(self.buffer.set_cursor(start.logical_row, start.logical_col));
        }
    }

    fn word(&self, forward: bool) -> Option<(u32, u32, u32)> {
        let query = if forward { EditQuery::NextWord } else { EditQuery::PrevWord };
        self.report(self.buffer.position(query)).flatten().map(|position| (position.row, position.col, position.offset))
    }

    fn goto_word(&self, forward: bool) {
        if let Some((_, _, offset)) = self.word(forward) {
            self.report(self.buffer.command(EditCommand::CursorOffset(offset)));
        }
    }

    pub fn run(&self, cx: &mut Cx<'_>, action: EditorAction) {
        use EditorAction as A;
        match action {
            A::MoveLeft => self.movement(false, Some(false), |s| s.step_horizontal(false)),
            A::MoveRight => self.movement(false, Some(true), |s| s.step_horizontal(true)),
            A::MoveUp => self.movement(false, None, |s| s.step_vertical(false)),
            A::MoveDown => self.movement(false, None, |s| s.step_vertical(true)),
            A::SelectLeft => self.movement(true, None, |s| s.step_horizontal(false)),
            A::SelectRight => self.movement(true, None, |s| s.step_horizontal(true)),
            A::SelectUp => self.movement(true, None, |s| {
                s.report(s.view.move_up());
            }),
            A::SelectDown => self.movement(true, None, |s| {
                s.report(s.view.move_down());
            }),
            A::LineHome => self.movement(false, Some(false), Self::line_home),
            A::LineEnd => self.movement(false, Some(true), Self::line_end),
            A::SelectLineHome => self.movement(true, None, Self::line_home),
            A::SelectLineEnd => self.movement(true, None, Self::line_end),
            A::VisualLineHome => self.movement(false, Some(false), Self::visual_line_home),
            A::VisualLineEnd => self.movement(false, Some(true), |s| {
                s.report(s.view.goto_visual_line_end());
            }),
            A::SelectVisualLineHome => self.movement(true, None, Self::visual_line_home),
            A::SelectVisualLineEnd => self.movement(true, None, |s| {
                s.report(s.view.goto_visual_line_end());
            }),
            A::BufferHome => self.movement(false, Some(false), |s| {
                s.report(s.buffer.set_cursor(0, 0));
            }),
            A::BufferEnd => self.movement(false, Some(true), Self::goto_buffer_end),
            A::SelectBufferHome => self.movement(true, None, |s| {
                s.report(s.buffer.set_cursor(0, 0));
            }),
            A::SelectBufferEnd => self.movement(true, None, Self::goto_buffer_end),
            A::SelectAll => {
                self.clear_selection_state();
                self.report(self.buffer.set_cursor(0, 0));
                self.movement(true, None, Self::goto_buffer_end);
            }
            A::WordForward => self.movement(false, Some(true), |s| s.goto_word(true)),
            A::WordBackward => self.movement(false, Some(false), |s| s.goto_word(false)),
            A::SelectWordForward => self.movement(true, None, |s| s.goto_word(true)),
            A::SelectWordBackward => self.movement(true, None, |s| s.goto_word(false)),
            A::Backspace => {
                if !self.delete_selection() && !self.delete_atomic(false) {
                    self.report(self.buffer.command(EditCommand::Backspace));
                }
            }
            A::Delete => {
                if !self.delete_selection() && !self.delete_atomic(true) {
                    self.report(self.buffer.command(EditCommand::DeleteForward));
                }
            }
            A::DeleteWordForward | A::DeleteWordBackward => {
                if !self.delete_selection() {
                    let (row, col, offset) = self.cursor();
                    let forward = action == A::DeleteWordForward;
                    if let Some((word_row, word_col, word_offset)) = self.word(forward) {
                        if forward && word_offset > offset {
                            self.report(self.buffer.delete_range((row, col), (word_row, word_col)));
                        } else if !forward && word_offset < offset {
                            self.report(self.buffer.delete_range((word_row, word_col), (row, col)));
                        }
                    }
                }
            }
            A::DeleteLine => {
                self.clear_selection_state();
                self.report(self.buffer.command(EditCommand::DeleteLine));
            }
            A::DeleteToLineEnd => {
                self.clear_selection_state();
                let (row, col, _) = self.cursor();
                if let Some(end) = self.end_of_line().filter(|end| end.1 > col) {
                    self.report(self.buffer.delete_range((row, col), end));
                }
            }
            A::DeleteToLineStart => {
                self.clear_selection_state();
                let (row, col, _) = self.cursor();
                if col > 0 {
                    self.report(self.buffer.delete_range((row, 0), (row, col)));
                } else if row > 0 {
                    self.report(self.buffer.command(EditCommand::Backspace));
                }
            }
            A::Newline => {
                if !self.single_line {
                    self.delete_selection();
                    self.report(self.buffer.command(EditCommand::NewLine));
                }
            }
            A::Undo => {
                self.clear_selection_state();
                self.report(self.buffer.undo());
            }
            A::Redo => {
                self.clear_selection_state();
                self.report(self.buffer.redo());
            }
            A::Submit => {
                let text = self.text();
                self.on_submit.emit(cx, &text);
            }
            A::Paste => {
                let editor = self.element.behavior_weak().clone();
                cx.read_clipboard(move |cx, text| {
                    if let (Some(text), Some(editor)) = (text, editor.upgrade()) {
                        editor.paste(cx, &text);
                    }
                });
            }
        }
    }

    /// Runs an action as its key would, then tells change handlers about any edit.
    pub fn perform(&self, action: EditorAction) {
        self.notifying(|cx| self.run(cx, action));
    }

    /// Inserts text as a paste does, then tells change handlers about it.
    pub fn insert_notifying(&self, text: &str) {
        self.notifying(|_| self.insert(text));
    }

    /// Runs an edit for the program, then tells change and cursor handlers what it changed.
    fn notifying(&self, edit: impl FnOnce(&mut Cx<'_>)) {
        if let Some(app) = self.element.app() {
            let mut cx = Cx::new(&app);
            let before = self.epoch();
            let (row, col, _) = self.cursor();
            self.tracked(|| edit(&mut cx));
            self.changed_since(&mut cx, before);
            self.cursor_moved_since(&mut cx, (row, col));
        }
    }

    /// Changes the cursor's look on the editor node.
    pub fn update_cursor(&self, change: impl FnOnce(&mut EditorOptions)) {
        let mut options = self.cursor_options.get();
        change(&mut options);
        self.cursor_options.set(options);
        self.element.apply(|node| node.set_editor_options(&options));
    }

    /// Tells cursor handlers when the cursor moved since `before`, a (row, column) position.
    fn cursor_moved_since(&self, cx: &mut Cx<'_>, before: (u32, u32)) {
        let (row, col, _) = self.cursor();
        if (row, col) != before && !self.on_cursor.is_empty() {
            self.on_cursor.emit(cx, &(row, col));
        }
    }

    // Extmarks.

    /// The cursor offset at the end of `text`: display columns as the buffer counts them, plus one per line break.
    fn measure(&self, text: &str) -> u32 {
        self.report(self.buffer.measure(text)).unwrap_or(0)
    }

    /// Runs an edit, then moves extmarks for whatever it changed and keeps the cursor out of atomic marks.
    pub fn tracked<R>(&self, edit: impl FnOnce() -> R) -> R {
        if self.tracking.get() || self.extmarks.borrow().marks.is_empty() {
            return edit();
        }
        // A press leaves the cursor on its cell for the handlers until the release; an edit before then starts at the
        // nearer edge.
        if self.selection().is_none() {
            self.keep_cursor_outside(Ordering::Equal);
        }
        self.tracking.set(true);
        let before = self.text();
        let cursor_before = self.cursor().2;
        let selection_before = self.selection().map_or(u32::MAX, |(start, _)| start);
        let result = edit();
        self.tracking.set(false);
        // A handler may have replaced the text and cleared the marks.
        if self.extmarks.borrow().marks.is_empty() {
            return result;
        }
        let after = self.text();
        if before != after {
            let limit = cursor_before.min(self.cursor().2).min(selection_before);
            let change = extmarks::change(&before, &after, limit, &mut |text| self.measure(text));
            extmarks::apply(&mut self.extmarks.borrow_mut().marks, change);
            self.refresh_extmarks();
        }
        self.keep_cursor_outside(self.cursor().2.cmp(&cursor_before));
        result
    }

    /// Moves a cursor inside atomic marks to the outer edge of the marks around it: toward the end for `Greater`, the
    /// start for `Less`, or the nearer one.
    fn keep_cursor_outside(&self, toward: Ordering) {
        let cursor = self.cursor().2;
        let (start, end) = (self.outside(cursor, false), self.outside(cursor, true));
        let to_end = match toward {
            Ordering::Less => false,
            Ordering::Greater => true,
            Ordering::Equal => end - cursor <= cursor - start,
        };
        if start != cursor {
            self.report(self.buffer.command(EditCommand::CursorOffset(if to_end { end } else { start })));
        }
    }

    /// The first offset from `offset` toward the end (`forward`) or the start that no atomic mark surrounds.
    fn outside(&self, mut offset: u32, forward: bool) -> u32 {
        let marks = self.extmarks.borrow();
        while let Some(mark) = marks.atomic_around(offset) {
            offset = if forward { mark.end } else { mark.start };
        }
        offset
    }

    /// Deletes a whole atomic mark that starts at the cursor (`forward`) or ends at it. Returns whether it did.
    fn delete_atomic(&self, forward: bool) -> bool {
        let cursor = self.cursor().2;
        let mark = self.extmarks.borrow().marks.iter().copied().find(|mark| {
            mark.options.atomic
                && mark.start < mark.end
                && if forward { mark.start == cursor } else { mark.end == cursor }
        });
        let Some(mark) = mark else { return false };
        let colors = self.colors.borrow().selection;
        self.report(self.view.select_range(mark.start, mark.end, colors));
        self.report(self.view.delete_selection());
        self.clear_selection_state();
        true
    }

    /// Redraws styled marks as highlights. Highlight offsets skip line breaks, unlike the cursor's.
    fn refresh_extmarks(&self) {
        let Some(app) = self.element.app() else { return };
        self.report(self.buffer.remove_highlights(extmarks::HIGHLIGHT_TAG));
        let styled: Vec<Extmark> =
            self.extmarks.borrow().marks.iter().filter(|mark| mark.options.style.is_some()).copied().collect();
        if styled.is_empty() {
            app.request_redraw();
            return;
        }
        // Each line break before an offset is one position the highlight's offset leaves out.
        let skip_breaks = |offset: u32| {
            let row = app.report(self.buffer.position(EditQuery::Offset(offset))).flatten().map_or(0, |at| at.row);
            offset.saturating_sub(row)
        };
        for mark in styled {
            let style = mark.options.style.expect("filtered to styled marks");
            let Some(style_id) = self.style_id(style) else { continue };
            let highlight = Highlight {
                start: skip_breaks(mark.start),
                end: skip_breaks(mark.end),
                style_id,
                // Above syntax highlights, at 0.
                priority: mark.options.priority.saturating_add(1),
                tag: extmarks::HIGHLIGHT_TAG,
            };
            self.report(self.buffer.highlight(highlight));
        }
        app.request_redraw();
    }

    /// The id of `style` in the buffer's style table, registering it on first use. Until `syntax_style` sets a table,
    /// the editor makes its own.
    fn style_id(&self, style: Style) -> Option<u32> {
        if let Some(&id) = self.extmarks.borrow().styles.get(&style) {
            return Some(id);
        }
        if self.extmarks.borrow().syntax.is_none() {
            let app = self.element.app()?;
            let table = app.report(SyntaxStyle::new(app.session().context()))?;
            self.report(self.buffer.set_syntax_style(Some(&table)));
            self.extmarks.borrow_mut().syntax = Some(table);
        }
        let mut extmarks = self.extmarks.borrow_mut();
        let id = self.report(extmarks.syntax.as_ref()?.register(&style_name(style), style))?;
        extmarks.styles.insert(style, id);
        Some(id)
    }

    /// The group set of `style`'s one name, registered in the buffer's style table. Past the Context's group-set
    /// bound there is none, and the style paints plain rather than ending the app.
    fn group_set(&self, style: Style) -> Option<u32> {
        if let Some(&id) = self.extmarks.borrow().group_sets.get(&style) {
            return Some(id);
        }
        self.style_id(style)?;
        let id = self.buffer.context().group_set(&[&style_name(style)]).ok()?;
        self.extmarks.borrow_mut().group_sets.insert(style, id);
        Some(id)
    }

    /// Uses `style` as the buffer's style table, registering extmark and syntax styles in it as needed.
    pub fn set_syntax_style(&self, style: &SyntaxStyle) {
        self.report(self.buffer.set_syntax_style(Some(style)));
        {
            let mut extmarks = self.extmarks.borrow_mut();
            extmarks.syntax = Some(style.clone());
            extmarks.styles.clear();
            extmarks.group_sets.clear();
        }
        self.refresh_extmarks();
        self.highlighted.set(None);
    }

    pub fn add_extmark(&self, range: std::ops::Range<u32>, options: ExtmarkOptions) -> ExtmarkId {
        let id = self.extmarks.borrow_mut().add(range, options);
        self.refresh_extmarks();
        id
    }

    pub fn remove_extmark(&self, id: ExtmarkId) -> bool {
        let removed = {
            let mut extmarks = self.extmarks.borrow_mut();
            let before = extmarks.marks.len();
            extmarks.marks.retain(|mark| mark.id != id);
            extmarks.marks.len() != before
        };
        if removed {
            self.refresh_extmarks();
        }
        removed
    }

    pub fn clear_extmarks(&self) {
        self.extmarks.borrow_mut().marks.clear();
        self.refresh_extmarks();
    }

    pub fn extmarks(&self) -> Vec<Extmark> {
        let mut marks = self.extmarks.borrow().marks.clone();
        marks.sort_by_key(|mark| (mark.start, mark.id));
        marks
    }

    /// Moves the cursor to a document offset, outside any atomic mark, and clears the selection.
    pub fn set_cursor_offset(&self, offset: u32) {
        let before = self.cursor().2;
        self.clear_selection_state();
        self.report(self.buffer.command(EditCommand::CursorOffset(offset)));
        self.keep_cursor_outside(offset.cmp(&before));
    }

    /// Tells change handlers about the text if it changed since `before`, a content epoch.
    pub fn changed_since(&self, cx: &mut Cx<'_>, before: u64) {
        if self.epoch() != before && !self.on_change.is_empty() {
            let text = self.text();
            self.on_change.emit(cx, &text);
        }
    }

    // Syntax highlighting.

    pub fn set_filetype(&self, filetype: Option<&str>) {
        if self.filetype.borrow().as_deref() == filetype {
            return;
        }
        *self.filetype.borrow_mut() = filetype.map(str::to_owned);
        self.highlighted.set(None);
        if filetype.is_some() {
            self.element.add_hooks(Hooks::UPDATE);
            self.element.app().inspect(App::request_redraw);
        } else {
            self.report(self.buffer.set_layer(extmarks::SYNTAX_LAYER, 0..u32::MAX, &[]));
        }
    }

    pub fn set_syntax_theme(&self, theme: SyntaxTheme) {
        if *self.syntax_theme.borrow() != theme {
            *self.syntax_theme.borrow_mut() = theme;
            self.highlighted.set(None);
            self.element.app().inspect(App::request_redraw);
        }
    }

    /// Highlights the text as its filetype when it changed since the last highlight, or the filetype or styles did.
    /// Captures become one layer run per styled piece, their styles merged as `Code` merges them, below extmarks.
    fn highlight(&self) {
        let filetype = self.filetype.borrow();
        let Some(filetype) = filetype.as_deref() else { return };
        let Some(info) = self.report(self.buffer.info()) else { return };
        if self.highlighted.replace(Some(info.content_epoch)) == Some(info.content_epoch) {
            return;
        }
        let text = self.text();
        let ranges = syntax::highlight_ranges(&text, filetype, &self.syntax_theme.borrow()).unwrap_or_default();
        let runs: Vec<LayerRun> = (ranges.into_iter())
            .filter(|(_, style)| *style != Style::new())
            .filter_map(|(range, style)| {
                Some(LayerRun {
                    start_byte: range.start as u32,
                    end_byte: range.end as u32,
                    group_set: self.group_set(style)?,
                })
            })
            .collect();
        self.report(self.buffer.set_layer(extmarks::SYNTAX_LAYER, 0..u32::MAX, &runs));
    }

    fn scroll(&self, rows: i64) {
        let Some(viewport) = self.report(self.view.viewport()) else { return };
        let total = self.report(self.view.info(false)).map_or(0, |info| info.total_virtual_line_count);
        let max = total.saturating_sub(viewport.height);
        let y = (i64::from(viewport.y) + rows).clamp(0, i64::from(max)) as u32;
        if y != viewport.y {
            self.report(self.view.set_viewport(Viewport { y, ..viewport }, true));
            // A selection holds the cursor where the wheel left it.
            if self.selection().is_none() {
                self.keep_cursor_outside(rows.cmp(&0));
            }
        }
    }
}

/// The name of `style` in a style table: made of its fields, so editors that share a table never redefine each other's
/// names, and within a group set's 64 bytes.
fn style_name(style: Style) -> String {
    let color = |color: Option<Color>| {
        color.map_or("-".into(), |color| {
            let [r, g, b, a] = color.to_raw();
            format!("{r:04x}{g:04x}{b:02x}{a:02x}")
        })
    };
    format!("opentui.{}_{}_{:02x}", color(style.fg), color(style.bg), style.attributes.bits())
}

impl Behavior for EditorCore {
    fn element(&self) -> &Element {
        &self.element
    }

    /// Highlights text that changed since the last frame.
    fn update(&self, _cx: &mut Cx<'_>) {
        self.highlight();
    }

    fn key(&self, cx: &mut Cx<'_>, key: &KeyEvent) -> bool {
        let before = self.epoch();
        let (row, col, _) = self.cursor();
        let action = self.keymap.borrow().get(key);
        if let Some(action) = action {
            self.tracked(|| self.run(cx, action));
        } else if let Some(character) = key.text() {
            self.tracked(|| self.insert(character.encode_utf8(&mut [0u8; 4])));
        } else {
            return false;
        }
        self.changed_since(cx, before);
        self.cursor_moved_since(cx, (row, col));
        true
    }

    fn paste(&self, cx: &mut Cx<'_>, text: &str) -> bool {
        let before = self.epoch();
        let (row, col, _) = self.cursor();
        self.tracked(|| self.insert(text));
        self.changed_since(cx, before);
        self.cursor_moved_since(cx, (row, col));
        true
    }

    fn mouse(&self, _cx: &mut Cx<'_>, event: &MouseEvent) -> bool {
        match event.kind {
            MouseEventKind::ScrollUp => self.scroll(-1),
            MouseEventKind::ScrollDown => self.scroll(1),
            _ => return false,
        }
        true
    }

    fn selectable(&self) -> bool {
        true
    }

    /// Mouse selections move the cursor to their focus, as Core's do.
    fn select(&self, selection: Option<&SelectionUpdate>) -> bool {
        self.anchor.set(None);
        let (row, col, _) = self.cursor();
        // A cursor the pointer left inside a mark stays until the press's handlers have seen it, then goes to the
        // nearer edge; once a drag's selection is gone, to the side the drag came from.
        let toward = if let Some(selection) = selection {
            let (anchor, focus) = selection.local(&self.element);
            let colors = self.colors.borrow().selection;
            self.report(self.view.select_local(anchor, focus, !selection.start, selection.unit, true, colors));
            self.pointer_side.set((anchor.1, anchor.0).cmp(&(focus.1, focus.0)));
            self.pointer_unit.set(selection.unit);
            (!selection.start).then_some(Ordering::Equal)
        } else {
            self.report(self.view.clear_selection());
            Some(self.pointer_side.get())
        };
        let selected = self.selection().is_some();
        if let (false, Some(toward)) = (selected, toward) {
            self.keep_cursor_outside(toward);
        }
        if let Some(app) = self.element.app() {
            self.cursor_moved_since(&mut Cx::new(&app), (row, col));
        }
        selected
    }

    fn focus_changed(&self, _cx: &mut Cx<'_>, focused: bool) {
        self.apply_colors(focused);
    }

    fn selected_text(&self) -> Option<String> {
        self.selection()?;
        self.report(self.view.selected_text())
    }

    fn visible_lines(&self) -> Option<VisibleLines> {
        let line_count = self.report(self.buffer.info())?.line_count;
        let rows = self.report(self.view.lines())?;
        Some(VisibleLines { line_count, rows })
    }

    fn teardown(&self) {
        self.on_change.clear();
        self.on_submit.clear();
        self.on_cursor.clear();
    }
}

#[cfg(all(test, feature = "tree-sitter"))]
mod tests {
    use super::*;
    use crate::testing::TestApp;
    use crate::widget::{Container, Textarea, Widget};
    use std::collections::HashMap;

    const TAG: u16 = u16::MAX - 1;

    /// Syntax highlighting as the editor did it before layers: one highlight per styled range, in display columns
    /// that leave out line breaks, under `TAG` at priority 0.
    struct Legacy {
        table: SyntaxStyle,
        ids: HashMap<Style, u32>,
        filetype: Option<&'static str>,
        theme: SyntaxTheme,
        highlighted: Option<u64>,
        /// Whether the pieces' widths fail to add up to the text's: a grapheme cluster spans two pieces, and the
        /// old columns drift from there on (the layer paints them right; see the next test).
        drifted: bool,
    }

    impl Legacy {
        fn refresh(&mut self, buffer: &EditBuffer) {
            let Some(filetype) = self.filetype else { return };
            let epoch = buffer.info().unwrap().content_epoch;
            if self.highlighted.replace(epoch) == Some(epoch) {
                return;
            }
            let text = buffer.text().unwrap();
            let ranges = syntax::highlight_ranges(&text, filetype, &self.theme);
            buffer.remove_highlights(TAG).unwrap();
            let mut start = 0;
            for (range, style) in ranges.unwrap_or_default() {
                let piece = &text[range];
                let end = start + buffer.measure(piece).unwrap() - piece.matches('\n').count() as u32;
                if style != Style::new() {
                    let next = format!("legacy.{}", self.ids.len());
                    let style_id = *self.ids.entry(style).or_insert_with(|| self.table.register(&next, style).unwrap());
                    buffer.highlight(Highlight { start, end, style_id, priority: 0, tag: TAG }).unwrap();
                }
                start = end;
            }
            self.drifted = start != 0 && start != buffer.measure(&text).unwrap() - text.matches('\n').count() as u32;
        }
    }

    // Rust and Markdown fragments, split at `|`.
    const PIECES: &str = "let |fn f() {|}|x| = |1|\"s\\n\"|// c|/* b */|'a'|\t|\n|\u{65e5}\u{672c}|\u{e9}|# h|*e*|`c`|\
                          ```rust\n|r#\"r\"#|;|\r\n|\"a\\n\u{fe0f}\"|\u{301}";
    const KEYS: &[&str] = &["backspace", "delete", "left", "right", "up", "down", "home", "end", "ctrl+-", "ctrl+."];
    const FILETYPES: &[Option<&str>] = &[Some("rust"), Some("markdown"), Some("cobol"), None];

    // Group sets are never freed. Past the Context's bound, styles that need a new set paint plain, and
    // the app keeps running.
    #[test]
    fn syntax_past_the_group_set_bound_paints_plain_and_keeps_running() {
        let app = TestApp::new(20, 2);
        let area = Textarea::new(&app).filetype("rust").grow(1.0);
        area.set_text("let a = 1;");
        app.root().add(&area);
        let keyword = |r: u8| SyntaxTheme::new().style("keyword", Style::new().fg(Color::rgb(r, 0, 0)));
        let fg = |app: &TestApp| app.try_render().expect("a frame past the bound").cell(0, 0).unwrap().fg;
        area.syntax_theme(keyword(1));
        assert_eq!(fg(&app), Color::rgb(1, 0, 0));
        let context = app.session().context();
        // Fill the 64 KiB name pool, down to fewer bytes than any style name has.
        let mut index = 0;
        for width in [64, 16, 4] {
            while context.group_set(&[&format!("{index:0width$}")]).is_ok() {
                index += 1;
            }
        }
        for r in 2..40 {
            area.syntax_theme(keyword(r));
            assert_eq!(fg(&app), app.theme().foreground);
        }
        area.focus();
        app.type_text("x");
        area.syntax_theme(keyword(1));
        assert_eq!(fg(&app), Color::rgb(1, 0, 0));
    }

    // A grapheme cluster across a capture boundary: VS16 joins the `n` of the escape `\n` but starts the string's
    // next piece. Measuring pieces apart put the old highlights one column early from there on; byte runs keep the
    // closing quote a string and the second `let` a keyword, with the space before it plain.
    #[test]
    fn a_cluster_across_a_capture_boundary_keeps_later_captures_in_place() {
        let app = TestApp::new(30, 2);
        let area = Textarea::new(&app).filetype("rust").grow(1.0);
        area.set_text("let x=\"a\\n\u{fe0f}\"; let y=3;");
        app.root().add(&area);
        let theme = SyntaxTheme::from_theme(&app.theme());
        let color = |name| theme.get(name).and_then(|style| style.fg).unwrap();
        let capture = app.render();
        let cells = &capture.cells[..capture.width as usize];
        let quote = cells.iter().rposition(|cell| cell.symbol == "\"").unwrap();
        let second_let = cells.iter().rposition(|cell| cell.symbol == "l").unwrap();
        assert_eq!(cells[quote].fg, color("string"));
        assert_eq!(cells[second_let - 1].fg, app.theme().foreground);
        assert!(cells[second_let..second_let + 3].iter().all(|cell| cell.fg == color("keyword")));
    }

    // P12: the editor's syntax layer paints byte-identical frames to the per-range highlights it replaced, over
    // random edits, filetype changes (with and without a grammar), clear_highlights, theme and table swaps, and
    // styled extmarks above both. One class is left out by rule: frames where the old path's piece widths do not add
    // up to the text's width (a grapheme cluster spans two pieces), because its columns drift there; the test above
    // checks the layer's colors for that class.
    #[test]
    fn syntax_layers_paint_as_per_range_highlights_did() {
        let pieces: Vec<&str> = PIECES.split('|').collect();
        let (mut compared, mut drifted) = (0, 0);
        for seed in 1..=200u64 {
            let mut state = seed.wrapping_mul(0x9e37_79b9_7f4a_7c15);
            let mut next = |bound: usize| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state % bound as u64) as usize
            };
            let (layered, legacy) = (TestApp::new(24, 6), TestApp::new(24, 6));
            let red = Style::new().fg(Color::RED);
            let other = SyntaxTheme::new().style("keyword", Style::new().bold()).style("comment", red);
            let themes = [SyntaxTheme::from_theme(&layered.theme()), other.style("string", red.bg(Color::BLUE))];
            let mut twin = Legacy {
                table: SyntaxStyle::new(legacy.session().context()).unwrap(),
                ids: HashMap::new(),
                filetype: Some("rust"),
                theme: themes[0].clone(),
                highlighted: None,
                drifted: false,
            };
            let areas = [Textarea::new(&layered).filetype("rust").grow(1.0), Textarea::new(&legacy).grow(1.0)];
            areas[1].syntax_style(&twin.table);
            for (app, area) in [&layered, &legacy].into_iter().zip(&areas) {
                app.root().add(area);
                area.focus();
            }
            for step in 0..24 {
                match if step == 0 { 8 } else { next(16) } {
                    0..=4 => {
                        let text = pieces[next(pieces.len())];
                        layered.type_text(text);
                        legacy.type_text(text);
                    }
                    5..=7 => {
                        let key = KEYS[next(KEYS.len())];
                        layered.press(key);
                        legacy.press(key);
                    }
                    8 => {
                        let text: String = (0..next(12)).map(|_| pieces[next(pieces.len())]).collect();
                        areas.iter().for_each(|area| drop(area.set_text(&text)));
                    }
                    9 => {
                        let filetype = FILETYPES[next(FILETYPES.len())];
                        areas[0].filetype(filetype);
                        if twin.filetype != filetype {
                            (twin.filetype, twin.highlighted) = (filetype, None);
                            if filetype.is_none() {
                                areas[1].buffer().remove_highlights(TAG).unwrap();
                                twin.drifted = false;
                            }
                        }
                    }
                    10 => {
                        areas.iter().for_each(|area| area.buffer().clear_highlights().unwrap());
                        twin.drifted = false;
                    }
                    11 => {
                        let theme = themes[next(2)].clone();
                        areas[0].syntax_theme(theme.clone());
                        if twin.theme != theme {
                            (twin.theme, twin.highlighted) = (theme, None);
                        }
                    }
                    12 => {
                        areas[0].syntax_style(&SyntaxStyle::new(layered.session().context()).unwrap());
                        twin.table = SyntaxStyle::new(legacy.session().context()).unwrap();
                        areas[1].syntax_style(&twin.table);
                        (twin.ids, twin.highlighted) = (HashMap::new(), None);
                    }
                    13 => {
                        let (start, length) = (next(40) as u32, next(6) as u32);
                        let options = ExtmarkOptions::default().style(Style::new().fg(Color::CYAN));
                        for area in &areas {
                            area.add_extmark(start..start + length, options);
                        }
                    }
                    _ => {
                        twin.refresh(areas[1].buffer());
                        let (want, got) = (legacy.render(), layered.render());
                        if twin.drifted {
                            drifted += 1;
                            continue;
                        }
                        let differ = want.cells.iter().zip(&got.cells).position(|(want, got)| want != got);
                        assert!(differ.is_none(), "seed {seed} step {step} cell {differ:?}: {:?}", areas[0].text());
                        compared += 1;
                    }
                }
            }
        }
        assert!(compared > 400 && drifted > 0 && drifted * 4 < compared, "{compared} compared, {drifted} drifted");
    }
}
