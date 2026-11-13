//! Editing behavior shared by [`Input`](super::Input) and [`Textarea`](super::Textarea), ported from OpenTUI Core's
//! `EditBufferRenderable` and `Textarea` key bindings.

use super::extmarks::{self, Extmark, ExtmarkId, ExtmarkOptions, Extmarks};
use super::{Behavior, Callbacks, Element, SelectionUpdate, VisibleLines, build};
use crate::app::{App, Cx};
use crate::error::Result;
use crate::input::{KeyEvent, Keymap, MouseEvent, MouseEventKind};
use crate::native::{
    EditBuffer, EditCommand, EditQuery, EditorOptions, EditorQuery, EditorView, Hooks, NodeKind, SelectionColors,
    SelectionUnit, SyntaxStyle, Viewport, WrapMode,
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
        /// count as the cursor's do and past the text mean its end; see [`Extmark`]. Replacing the text with `set_text`
        /// or `set_value` removes all marks; undoing an edit brings back the marks it removed.
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
    /// A press left the cursor on its cell, maybe inside an atomic mark, until a rule moves it out.
    held: Cell<bool>,
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
            held: Cell::new(false),
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
        let edge = if self.selection().is_some() {
            None
        } else if forward {
            let mark = extmarks::atomic_containing(&self.marks(), before + 1);
            mark.filter(|mark| before <= mark.start).map(|mark| mark.end)
        } else {
            before
                .checked_sub(1)
                .and_then(|target| extmarks::atomic_containing(&self.marks(), target))
                .filter(|mark| before >= mark.end)
                .map(|mark| mark.start)
        };
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
        let marks = self.marks();
        let Some(mark) = extmarks::atomic_containing(&marks, after) else { return };
        if after - mark.start < mark.end - after {
            self.move_before(mark.start);
            if !down || self.cursor().2 > before {
                return;
            }
        }
        // Past later marks that overlap the end, so the cursor is not left inside one.
        self.report(self.buffer.command(EditCommand::CursorOffset(Self::outside(&marks, mark.end, true))));
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

    /// The marks in creation (id) order, the order the cursor rules search them in. Native code moves them with each
    /// edit.
    fn marks(&self) -> Vec<Extmark> {
        let marks = self.report(self.buffer.marks()).unwrap_or_default();
        let mut marks: Vec<Extmark> = marks.iter().map(|(raw, style)| Extmark::from_native(raw, *style)).collect();
        marks.sort_by_key(|mark| mark.id);
        marks
    }

    /// Runs an edit and keeps the cursor out of atomic marks, once for nested edits.
    pub fn tracked<R>(&self, edit: impl FnOnce() -> R) -> R {
        if self.tracking.get() {
            return edit();
        }
        // A press leaves the cursor on its cell for the handlers until the release; an edit before then starts at the
        // nearer edge.
        if self.held.get() && self.selection().is_none() {
            self.keep_cursor_outside(Ordering::Equal);
        }
        self.tracking.set(true);
        let cursor_before = self.cursor().2;
        let result = edit();
        self.tracking.set(false);
        // Undo can bring back a mark around the cursor, so this runs even when no mark was there before.
        self.keep_cursor_outside(self.cursor().2.cmp(&cursor_before));
        result
    }

    /// Moves a cursor inside atomic marks to the outer edge of the marks around it: toward the end for `Greater`, the
    /// start for `Less`, or the nearer one.
    fn keep_cursor_outside(&self, toward: Ordering) {
        self.held.set(false);
        let marks = self.marks();
        let cursor = self.cursor().2;
        let (start, end) = (Self::outside(&marks, cursor, false), Self::outside(&marks, cursor, true));
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
    fn outside(marks: &[Extmark], mut offset: u32, forward: bool) -> u32 {
        while let Some(mark) = extmarks::atomic_around(marks, offset) {
            offset = if forward { mark.end } else { mark.start };
        }
        offset
    }

    /// Deletes a whole atomic mark that starts at the cursor (`forward`) or ends at it. Returns whether it did.
    fn delete_atomic(&self, forward: bool) -> bool {
        let cursor = self.cursor().2;
        let mark = self.marks().into_iter().find(|mark| {
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

    /// The buffer's style table. Until `syntax_style` sets one, the editor makes its own, with its syntax theme.
    fn table(&self) -> Option<SyntaxStyle> {
        if let Some(table) = &self.extmarks.borrow().syntax {
            return Some(table.clone());
        }
        let app = self.element.app()?;
        let table = app.report(SyntaxStyle::new(app.session().context()))?;
        self.report(table.set_capture_theme(&self.syntax_theme.borrow()));
        self.report(self.buffer.set_syntax_style(Some(&table)));
        self.extmarks.borrow_mut().syntax = Some(table.clone());
        Some(table)
    }

    /// Uses `style` as the buffer's style table, registering syntax styles in it as needed. Marks keep their styles.
    pub fn set_syntax_style(&self, style: &SyntaxStyle) {
        self.report(self.buffer.set_syntax_style(Some(style)));
        self.extmarks.borrow_mut().syntax = Some(style.clone());
        // The table takes this editor's theme and names; editors sharing it paint the theme set last.
        let lists = self.extmarks.borrow().group_sets.lists();
        self.report(style.set_capture_theme(&self.syntax_theme.borrow()));
        lists.iter().for_each(|names| drop(self.report(style.capture_group(names))));
    }

    pub fn add_extmark(&self, range: std::ops::Range<u32>, options: ExtmarkOptions) -> ExtmarkId {
        let range = range.start.min(range.end)..range.start.max(range.end);
        // Above syntax layers, which paint at 0.
        let priority = options.priority.saturating_add(1);
        ExtmarkId(self.report(self.buffer.add_mark(range, options.atomic, options.style, priority)).unwrap_or(0))
    }

    pub fn remove_extmark(&self, id: ExtmarkId) -> bool {
        self.report(self.buffer.remove_mark(id.0)).unwrap_or(false)
    }

    pub fn clear_extmarks(&self) {
        self.report(self.buffer.clear_marks());
    }

    pub fn extmarks(&self) -> Vec<Extmark> {
        let mut marks = self.marks();
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
        // Without a table yet there is nothing to restyle, and no table to make: one the app bound stays.
        let table = self.extmarks.borrow().syntax.clone();
        let restyled = table.is_some_and(|table| self.report(table.set_capture_theme(&theme)) == Some(true));
        if restyled || *self.syntax_theme.borrow() != theme {
            *self.syntax_theme.borrow_mut() = theme;
            self.element.app().inspect(App::request_redraw);
        }
    }

    /// Highlights the text as its filetype when it changed since the last highlight, or the filetype did. Each piece
    /// becomes a layer run of its capture names, which paint merges as `Code` merges their styles, below extmarks.
    fn highlight(&self) {
        let filetype = self.filetype.borrow();
        let Some(filetype) = filetype.as_deref() else { return };
        let Some(info) = self.report(self.buffer.info()) else { return };
        if self.highlighted.replace(Some(info.content_epoch)) == Some(info.content_epoch) {
            return;
        }
        let text = self.text();
        let named = syntax::highlight_names(&text, filetype).unwrap_or_default();
        // Without pieces the editor makes no table, so one the app bound on the buffer stays.
        let table = if named.0.is_empty() { None } else { self.table() };
        let runs = match table {
            Some(table) => self.extmarks.borrow_mut().group_sets.runs(&table, self.buffer.context(), named, |at| at),
            None => Ok(Vec::new()),
        };
        let Some(runs) = self.report(runs) else { return };
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
            self.held.set(selection.start);
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
    use crate::native::{Highlight, LayerRun};
    use crate::sys;
    use crate::testing::TestApp;
    use crate::widget::{Container, Textarea, Widget};
    use std::collections::HashMap;

    /// Syntax highlighting as the editor did it with value-named styles: each piece's merged style registered under a
    /// name of its own and interned as a one-name group set, so a new theme or table highlights again, unless
    /// `clear_highlights` emptied the layer since the last highlight (capture names keep it empty until an edit).
    struct Valued {
        table: SyntaxStyle,
        sets: HashMap<Style, u32>,
        filetype: Option<&'static str>,
        theme: SyntaxTheme,
        highlighted: Option<u64>,
        cleared: bool,
    }

    impl Valued {
        fn refresh(&mut self, buffer: &EditBuffer) {
            let Some(filetype) = self.filetype else { return };
            let epoch = buffer.info().unwrap().content_epoch;
            if self.highlighted.replace(epoch) == Some(epoch) {
                return;
            }
            self.cleared = false;
            let text = buffer.text().unwrap();
            let mut runs = Vec::new();
            for (range, style) in syntax::highlight_ranges(&text, filetype, &self.theme).unwrap_or_default() {
                if style == Style::new() {
                    continue;
                }
                let name = format!("valued.{}", self.sets.len());
                let group_set = *self.sets.entry(style).or_insert_with(|| {
                    self.table.register(&name, style).unwrap();
                    buffer.context().group_set(&[&name]).unwrap()
                });
                runs.push(LayerRun { start_byte: range.start as u32, end_byte: range.end as u32, group_set });
            }
            buffer.set_layer(extmarks::SYNTAX_LAYER, 0..u32::MAX, &runs).unwrap();
        }

        fn restyle(&mut self) {
            if !self.cleared {
                self.highlighted = None;
            }
        }
    }

    // Rust and Markdown fragments, split at `|`.
    const PIECES: &str = "let |fn f() {|}|x| = |1|\"s\\n\"|// c|/* b */|'a'|\t|\n|\u{65e5}\u{672c}|\u{e9}|# h|*e*|`c`|\
                          ```rust\n|r#\"r\"#|;|\r\n|\"a\\n\u{fe0f}\"|\u{301}";
    const KEYS: &[&str] = &["backspace", "delete", "left", "right", "up", "down", "home", "end", "ctrl+-", "ctrl+."];
    const FILETYPES: &[Option<&str>] = &[Some("rust"), Some("markdown"), Some("cobol"), None];

    // A group set composes its names as `Style::patch` does: fg and bg from the last name with one, attributes added.
    // Each run of random names paints as a run of its merged style under one name of its own.
    #[test]
    fn group_sets_compose_their_names_as_style_patch() {
        let app = TestApp::new(64, 1);
        let area = Textarea::new(&app).grow(1.0);
        area.set_text("x".repeat(64));
        app.root().add(&area);
        let context = app.session().context();
        let table = SyntaxStyle::new(context).unwrap();
        area.syntax_style(&table);
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = |bound: u64| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state % bound
        };
        for _ in 0..16 {
            let mut runs = Vec::new();
            let mut theme = SyntaxTheme::new();
            for name in ["n0", "n1", "n2", "n3", "n4", "n5"] {
                let mut color = || (next(2) == 1).then(|| Color::rgb(next(256) as u8, next(256) as u8, 0));
                let (fg, bg) = (color(), color());
                theme.set(name, Style { fg, bg, attributes: crate::style::Attributes::from_bits(next(256) as u8) });
                table.register(name, theme.get(name).unwrap()).unwrap();
            }
            for at in 0..32u32 {
                let names: Vec<String> = (0..=next(8)).map(|_| format!("n{}", next(6))).collect();
                let names: Vec<&str> = names.iter().map(String::as_str).collect();
                let merged = format!("merged.{at}");
                table.register(&merged, theme.merge(names.iter().copied())).unwrap();
                for (start_byte, names) in [(2 * at, &names[..]), (2 * at + 1, &[merged.as_str()][..])] {
                    let group_set = context.group_set(names).unwrap();
                    runs.push(LayerRun { start_byte, end_byte: start_byte + 1, group_set });
                }
            }
            area.buffer().set_layer(extmarks::SYNTAX_LAYER, 0..u32::MAX, &runs).unwrap();
            let capture = app.render();
            for at in 0..32 {
                assert_eq!(capture.cell(2 * at, 0), capture.cell(2 * at + 1, 0), "run {at}");
            }
        }
    }

    // A theme or table switch redefines capture names: it interns no group set and parses nothing (the grammar,
    // swapped for a counting lazy one after the first frame, loads at the next edit only; after
    // `clear_highlights` the text stays plain), so every new theme paints, also with the Context's name pool full.
    // Past the bound only a piece that needs a new set paints plain, and the app keeps running.
    #[test]
    fn theme_switches_intern_no_group_sets_and_highlight_nothing() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static LOADS: AtomicUsize = AtomicUsize::new(0);
        let grammar = || syntax::Grammar::new(tree_sitter_rust::LANGUAGE, "\"let\" @keyword (string_literal) @string");
        syntax::register("g7-churn", grammar()).unwrap();
        let app = TestApp::new(20, 2);
        let area = Textarea::new(&app).filetype("g7-churn").grow(1.0);
        area.set_text("let a = 1;");
        app.root().add(&area);
        let keyword = |r: u8| {
            let theme = SyntaxTheme::new().style("string", Style::new().fg(Color::GREEN));
            theme.style("keyword", Style::new().fg(Color::rgb(r, 0, 0)))
        };
        let fg = |app: &TestApp| app.try_render().expect("a frame past the bound").cell(0, 0).unwrap().fg;
        area.syntax_theme(keyword(1));
        assert_eq!(fg(&app), Color::rgb(1, 0, 0));
        syntax::register_lazy("g7-churn", move || {
            LOADS.fetch_add(1, Ordering::SeqCst);
            grammar().compile().ok()
        });
        let context = app.session().context();
        let first = context.group_set(&["probe.0"]).unwrap();
        for r in 2..40 {
            area.syntax_theme(keyword(r));
            assert_eq!(fg(&app), Color::rgb(r, 0, 0));
        }
        assert_eq!(context.group_set(&["probe.1"]).unwrap(), first + 1, "theme switches interned group sets");
        // Fill the 64 KiB name pool, down to fewer bytes than any list of names has.
        let mut index = 0;
        for width in [64, 16, 4] {
            while context.group_set(&[&format!("{index:0width$}")]).is_ok() {
                index += 1;
            }
        }
        for r in 40..80 {
            area.syntax_theme(keyword(r));
            assert_eq!(fg(&app), Color::rgb(r, 0, 0));
        }
        area.syntax_style(&SyntaxStyle::new(context).unwrap());
        assert_eq!(fg(&app), Color::rgb(79, 0, 0));
        assert_eq!(LOADS.load(Ordering::SeqCst), 0, "a theme or table switch parsed");
        area.focus();
        // The first string needs a new set, which the full pool refuses: it paints plain.
        app.type_text(" \"s\"");
        assert_eq!(fg(&app), Color::rgb(79, 0, 0));
        assert_eq!(app.render().cell(12, 0).unwrap().fg, app.theme().foreground);
        assert_eq!(LOADS.load(Ordering::SeqCst), 1);
        area.buffer().clear_highlights().unwrap();
        area.syntax_theme(keyword(1));
        assert_eq!(fg(&app), app.theme().foreground);
    }

    // Against hand-written colors, not the widget's own capture lists: a repeated name keeps its last place, the
    // last `none` clears what lies under it, and a three-part name takes its longest styled prefix, or its first
    // part with `first_part_fallback`.
    #[test]
    fn capture_lists_follow_the_stack_rule_and_the_theme_fallback() {
        let member = syntax::Grammar::new(tree_sitter_rust::LANGUAGE, "(identifier) @variable.other.member");
        syntax::register("g7-member", member).unwrap();
        let (red, blue) = (Style::new().fg(Color::RED), Style::new().fg(Color::BLUE));
        let marks = SyntaxTheme::new().style("text.emphasis", red).style("text.strong", blue);
        let members = SyntaxTheme::new().style("variable.other", red).style("variable", blue);
        let fence = "````markdown\n```rust\nlet x = y;\n```\n````\n";
        for (filetype, text, theme, symbol, want) in [
            ("markdown", "*a **b *c* d** e*", marks, "c", Some(Color::RED)),
            ("markdown", fence, SyntaxTheme::from_theme(&crate::theme::Theme::dark()), "y", None),
            ("g7-member", "x", members.clone(), "x", Some(Color::RED)),
            ("g7-member", "x", members.first_part_fallback(), "x", Some(Color::BLUE)),
        ] {
            let app = TestApp::new(20, 6);
            let area = Textarea::new(&app).filetype(filetype).syntax_theme(theme).grow(1.0);
            area.set_text(text);
            app.root().add(&area);
            let capture = app.render();
            let cell = capture.cells.iter().find(|cell| cell.symbol == symbol).unwrap();
            assert_eq!(cell.fg, want.unwrap_or(app.theme().foreground), "{text:?}");
        }
    }

    // A theme set on a shared table restyles every editor on it, and an edit registers only names the table has
    // not seen, with its palette: typing in one editor leaves the other's colors alone, even a name the app
    // redefined in the table.
    #[test]
    fn editors_sharing_a_table_paint_the_theme_set_last() {
        let app = TestApp::new(24, 2);
        let theme = |color: Color| -> SyntaxTheme {
            ["keyword", "string", "escape", "comment"].into_iter().map(|name| (name, Style::new().fg(color))).collect()
        };
        let table = SyntaxStyle::new(app.session().context()).unwrap();
        let areas = [("let x = \"a\";", Color::RED), ("let s = \"b\"; // c", Color::RED)].map(|(text, color)| {
            let area = Textarea::new(&app).filetype("rust").syntax_theme(theme(color)).syntax_style(&table).height(1);
            area.set_text(text);
            app.root().add(&area);
            area
        });
        let colors = |app: &TestApp| {
            let capture = app.render();
            [(8, 0), (8, 1), (13, 1)].map(|(x, y)| capture.cell(x, y).unwrap().fg)
        };
        assert_eq!(colors(&app), [Color::RED; 3]);
        areas[0].syntax_theme(theme(Color::BLUE));
        assert_eq!(colors(&app), [Color::BLUE; 3]);
        table.register("opentui.string", Style::new().fg(Color::GREEN)).unwrap();
        areas[1].set_text("let s = \"b\\n\"; // c");
        assert_eq!(colors(&app)[0], Color::GREEN);
    }

    // Without a filetype, a theme change neither makes nor binds a table: one the app bound on the buffer stays.
    #[test]
    fn a_theme_change_without_a_filetype_keeps_the_apps_table() {
        let app = TestApp::new(20, 1);
        let area = Textarea::new(&app).grow(1.0);
        area.set_text("let a = 1;");
        app.root().add(&area);
        let table = SyntaxStyle::new(app.session().context()).unwrap();
        let style_id = table.register("app", Style::new().fg(Color::GREEN)).unwrap();
        area.buffer().set_syntax_style(Some(&table)).unwrap();
        area.buffer().highlight(Highlight { start: 0, end: 3, style_id, priority: 1, tag: 1 }).unwrap();
        area.syntax_theme(SyntaxTheme::new().style("keyword", Style::new().fg(Color::RED)));
        assert_eq!(app.render().cell(0, 0).unwrap().fg, Color::GREEN);
    }

    // A list of capture names past the group-set bounds keeps every style, in the editor and in `Code`: a name over
    // the byte bound, or more names than a group set holds, paint as one name for the whole list (bigboi-4).
    #[test]
    fn capture_lists_past_the_group_set_bounds_keep_their_styles() {
        let bytes = sys::OT_GROUP_SET_NAME_BYTE_COUNT_MAX as usize - "opentui.".len();
        let count = sys::OT_GROUP_SET_NAME_COUNT_MAX as usize - 1;
        let default = Style::new().fg(Color::BLUE);
        for (captures, want) in [
            (vec!["n".repeat(bytes)], Style::new().fg(Color::RED)),
            (vec!["n".repeat(bytes + 1)], Style::new().fg(Color::RED)),
            ((1..=count).map(|index| format!("c{index}")).collect(), default.bold()),
            ((1..=count + 1).map(|index| format!("c{index}")).collect(), default.bold()),
        ] {
            let query: String = captures.iter().map(|name| format!("(\"let\" @{name})")).collect();
            let filetype = format!("g7-bounds-{}-{}", captures.len(), captures[0].len());
            let grammar = syntax::Grammar::new(tree_sitter_rust::LANGUAGE, query).core_captures();
            syntax::register(&filetype, grammar).unwrap();
            let last = captures.last().unwrap();
            let style = if captures.len() == 1 { Style::new().fg(Color::RED) } else { Style::new().bold() };
            let theme = SyntaxTheme::new().style("default", default).style(last.as_str(), style);
            let app = TestApp::new(20, 2);
            // Highlighted first under a theme without these styles, then switched to it.
            let area = Textarea::new(&app).filetype(filetype.as_str()).syntax_theme(SyntaxTheme::new()).height(1);
            area.set_text("let a = 1;");
            let code = crate::widget::Code::new(&app).filetype(filetype.as_str()).syntax_theme(SyntaxTheme::new());
            app.root().add(&area).add(&code.set_code("let a = 1;").height(1));
            app.render();
            area.syntax_theme(theme.clone());
            code.syntax_theme(theme);
            let capture = app.render();
            let fg = want.fg.unwrap_or(app.theme().foreground);
            for row in 0..2 {
                let cell = capture.cell(0, row).unwrap();
                let (count, bytes) = (captures.len(), last.len());
                assert_eq!(
                    (cell.fg, cell.attributes),
                    (fg, want.attributes),
                    "row {row}: {count} names of {bytes} bytes"
                );
            }
        }
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

    // P12: capture-name group sets paint byte-identical frames to value-named ones, over random edits, filetype
    // changes (with and without a grammar), clear_highlights, theme switches (longest-prefix and first-part themes,
    // `default` styles, attributes over attributes) and table swaps, and styled extmarks above both.
    #[test]
    fn capture_name_sets_paint_as_value_named_styles_did() {
        let pieces: Vec<&str> = PIECES.split('|').collect();
        let mut compared = 0;
        for seed in 1..=200u64 {
            let mut state = seed.wrapping_mul(0x9e37_79b9_7f4a_7c15);
            let mut next = |bound: usize| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state % bound as u64) as usize
            };
            let (named, valued) = (TestApp::new(24, 6), TestApp::new(24, 6));
            let red = Style::new().fg(Color::RED);
            let other = SyntaxTheme::new().style("keyword", Style::new().bold()).style("comment", red);
            let nested = SyntaxTheme::new()
                .style("default", Style::new().fg(Color::GREEN).italic())
                .style("punctuation", Style::new().bg(Color::BLUE))
                .style("punctuation.bracket", Style::new().underline())
                .style("string", red.bold())
                .style("markup", Style::new().fg(Color::YELLOW).dim())
                .style("markup.heading", Style::new().strikethrough());
            let themes = [
                SyntaxTheme::from_theme(&named.theme()),
                other.style("string", red.bg(Color::BLUE)),
                nested.clone(),
                nested.first_part_fallback(),
            ];
            let mut twin = Valued {
                table: SyntaxStyle::new(valued.session().context()).unwrap(),
                sets: HashMap::new(),
                filetype: Some("rust"),
                theme: themes[0].clone(),
                highlighted: None,
                cleared: false,
            };
            let areas = [Textarea::new(&named).filetype("rust").grow(1.0), Textarea::new(&valued).grow(1.0)];
            areas[1].syntax_style(&twin.table);
            for (app, area) in [&named, &valued].into_iter().zip(&areas) {
                app.root().add(area);
                area.focus();
            }
            for step in 0..24 {
                match if step == 0 { 8 } else { next(16) } {
                    0..=4 => {
                        let text = pieces[next(pieces.len())];
                        named.type_text(text);
                        valued.type_text(text);
                    }
                    5..=7 => {
                        let key = KEYS[next(KEYS.len())];
                        named.press(key);
                        valued.press(key);
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
                                areas[1].buffer().set_layer(extmarks::SYNTAX_LAYER, 0..u32::MAX, &[]).unwrap();
                            }
                        }
                    }
                    10 => {
                        areas.iter().for_each(|area| area.buffer().clear_highlights().unwrap());
                        twin.cleared = true;
                    }
                    11 => {
                        let theme = themes[next(themes.len())].clone();
                        areas[0].syntax_theme(theme.clone());
                        if twin.theme != theme {
                            twin.theme = theme;
                            twin.restyle();
                        }
                    }
                    12 => {
                        areas[0].syntax_style(&SyntaxStyle::new(named.session().context()).unwrap());
                        twin.table = SyntaxStyle::new(valued.session().context()).unwrap();
                        areas[1].syntax_style(&twin.table);
                        twin.sets = HashMap::new();
                        twin.restyle();
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
                        let (want, got) = (valued.render(), named.render());
                        let differ = want.cells.iter().zip(&got.cells).position(|(want, got)| want != got);
                        assert!(differ.is_none(), "seed {seed} step {step} cell {differ:?}: {:?}", areas[0].text());
                        compared += 1;
                    }
                }
            }
        }
        assert!(compared > 500, "{compared} compared");
    }

    // 474: with marks, a key read the whole text twice to find the edit; native code moves marks now. A typed key
    // reads the marks once, after the edit, however many there are: one count and one copy.
    #[test]
    fn keys_with_marks_read_no_text() {
        for count in [1, 40] {
            let app = TestApp::new(20, 2);
            let area = Textarea::new(&app).grow(1.0);
            area.set_text(format!("ab @file cd{}", " ".repeat(count)));
            app.root().add(&area);
            area.focus();
            area.add_extmark(3..8, ExtmarkOptions::default().atomic().style(Style::new().fg(Color::CYAN)));
            for at in 1..count as u32 {
                area.add_extmark(10 + at..11 + at, ExtmarkOptions::default().atomic());
            }
            area.set_cursor_offset(0);
            app.render();
            let reads = || (crate::native::TEXT_READS.with(Cell::get), crate::native::MARK_READS.with(Cell::get));
            crate::native::TEXT_READS.with(|reads| reads.set(0));
            crate::native::MARK_READS.with(|reads| reads.set(0));
            app.press("x");
            assert_eq!(reads(), (0, 2), "{count} marks");
            for key in ["backspace", "right", "delete"] {
                app.press(key);
            }
            assert_eq!(crate::native::TEXT_READS.with(Cell::get), 0);
            assert_eq!(area.extmarks()[0].range(), 2..7);
        }
    }
}
