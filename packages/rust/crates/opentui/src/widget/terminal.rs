//! An embedded terminal, ported from OpenTUI Core's `EmbeddedTerminalRenderable`.

use super::{Behavior, Callbacks, Element, Painter, SelectionUpdate, build, handle};
use crate::app::{App, Cx};
use crate::error::Result;
use crate::input::{KeyCode, KeyEvent, Modifiers, MouseButton, MouseEvent, MouseEventKind};
use crate::native::{
    Buffer, Capture, Constraint, Control, CursorPosition, CursorStyle, CursorUpdate, EmbeddedTerminal,
    EmbeddedTerminalOptions, Hooks, Measure, MousePointer, NodeKind, SelectionUnit, TERMINAL_INPUT_BYTES_MAX,
    TerminalCursor, TerminalCursorShape, TerminalKey, TerminalMouse, TerminalMouseAction, TerminalMouseButton,
    TerminalViewport,
};
use crate::pty::Pty;
use crate::style::Color;
use std::cell::{Cell, RefCell};
use std::process::{Command, ExitStatus};
use std::rc::Rc;

/// Rows one wheel step scrolls the scrollback, as in Core.
const WHEEL_ROWS: i32 = 3;

/// Characters that end a word for double-click selection, besides whitespace. Ghostty's defaults.
const WORD_SEPARATORS: &str = "`|:;,()[]{}<>$'\"│";

/// Where bytes a [`TerminalView`] hands to [`TerminalView::on_data`] come from. Both go to the program's input.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TerminalData {
    /// Keys, mouse events, pastes, and focus changes, encoded as the program asked.
    Input,
    /// Replies to the program's queries, such as the cursor position.
    Response,
}

/// The text a [`TerminalView`] shows, from [`TerminalView::screen`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TerminalScreen {
    /// One string per row, without trailing spaces. Blank rows at the bottom are left out.
    pub lines: Vec<String>,
    /// The terminal's size.
    pub cols: u16,
    pub rows: u16,
    /// The program's cursor, relative to the terminal's top-left cell.
    pub cursor: TerminalCursor,
}

impl TerminalScreen {
    /// The lines joined with line breaks.
    pub fn text(&self) -> String {
        self.lines.join("\n")
    }
}

pub(crate) struct TerminalInner {
    element: Element,
    terminal: Option<EmbeddedTerminal>,
    /// Keeps the composed screen between frames: composing only redraws rows that changed.
    buffer: RefCell<Option<Buffer>>,
    natural: (u16, u16),
    size: Cell<(u16, u16)>,
    selectable: Cell<bool>,
    selected: Cell<bool>,
    /// Whether the program was told it has focus.
    focused: Cell<bool>,
    on_data: Callbacks<(TerminalData, Vec<u8>)>,
    on_terminal_resize: Callbacks<(u16, u16)>,
    on_exit: Callbacks<ExitStatus>,
    pty: RefCell<Option<Pty>>,
    /// The number of programs spawned. A program's callbacks act only while it is the latest, though a
    /// [`TerminalView::pty`] handle may keep a replaced one running.
    spawns: Cell<u64>,
}

impl Measure for TerminalInner {
    fn measure(&self, width: Constraint, height: Constraint) -> (f32, f32) {
        (width.apply(f32::from(self.natural.0)), height.apply(f32::from(self.natural.1)))
    }
}

impl TerminalInner {
    fn report<T>(&self, result: Result<T>) -> Option<T> {
        match self.element.app() {
            Some(app) => app.report(result),
            None => result.ok(),
        }
    }

    fn redraw(&self) {
        self.element.app().inspect(App::request_redraw);
    }

    /// Hands bytes to the program and to data handlers.
    fn send(&self, bytes: Vec<u8>, source: TerminalData) {
        if bytes.is_empty() {
            return;
        }
        let pty = self.pty.borrow().clone();
        if let Some(pty) = pty {
            // Input after the program exited, or beyond the queue's bound, has nowhere to go.
            let _ = pty.write(&bytes);
        }
        if !self.on_data.is_empty()
            && let Some(app) = self.element.app()
        {
            self.on_data.emit(&mut Cx::new(&app), &(source, bytes));
        }
    }

    fn flush_responses(&self) {
        if let Some(terminal) = &self.terminal
            && let Some(responses) = self.report(terminal.drain_responses())
        {
            self.send(responses, TerminalData::Response);
        }
    }

    fn write(&self, bytes: &[u8]) {
        let Some(terminal) = &self.terminal else { return };
        if bytes.is_empty() {
            return;
        }
        self.report(terminal.write(bytes));
        self.flush_responses();
        self.redraw();
    }

    /// Sends input from the user, returning the view to the live screen as terminals do.
    fn input(&self, bytes: Vec<u8>) -> bool {
        if bytes.is_empty() {
            return false;
        }
        self.scroll_to_bottom();
        self.send(bytes, TerminalData::Input);
        self.redraw();
        true
    }

    /// Scrolls the view through the scrollback by `rows`; negative values move back in history.
    fn scroll(&self, rows: i32) {
        let Some(terminal) = &self.terminal else { return };
        self.report(terminal.scroll(rows));
        self.redraw();
    }

    fn scroll_to_bottom(&self) {
        let Some(terminal) = &self.terminal else { return };
        self.report(terminal.scroll_to_bottom());
        self.redraw();
    }

    /// Where the view sits; all zero without a native terminal.
    fn viewport(&self) -> TerminalViewport {
        self.terminal.as_ref().and_then(|terminal| self.report(terminal.viewport())).unwrap_or_default()
    }

    fn resize_terminal(&self, cx: &mut Cx<'_>, cols: u16, rows: u16) {
        let Some(terminal) = &self.terminal else { return };
        if self.size.get() == (cols, rows) {
            return;
        }
        if self.report(terminal.resize(cols, rows)).is_none() {
            return;
        }
        self.size.set((cols, rows));
        self.report(terminal.invalidate());
        self.flush_responses();
        let pty = self.pty.borrow().clone();
        if let Some(pty) = pty {
            let _ = pty.resize(cols, rows);
        }
        self.on_terminal_resize.emit(cx, &(cols, rows));
        self.redraw();
    }

    /// The offscreen buffer with the current screen composed into it.
    fn composed(&self) -> Option<Buffer> {
        let terminal = self.terminal.as_ref()?;
        let (cols, rows) = self.size.get();
        let (width, height) = (u32::from(cols), u32::from(rows));
        let existing = self.buffer.borrow().clone();
        let buffer = match existing {
            Some(buffer) if buffer.size() == (width, height) => buffer,
            Some(buffer) => {
                self.report(buffer.resize(width, height))?;
                self.report(terminal.invalidate());
                buffer
            }
            None => {
                let app = self.element.app()?;
                let buffer = app.report(Buffer::new(app.session().context(), width, height, app.width_method()))?;
                self.report(terminal.invalidate());
                *self.buffer.borrow_mut() = Some(buffer.clone());
                buffer
            }
        };
        self.report(terminal.compose(&buffer, 0, 0))?;
        Some(buffer)
    }

    fn capture(&self) -> Option<Capture> {
        let buffer = self.composed()?;
        self.report(buffer.capture())
    }

    /// Puts the real cursor where the program's cursor is, as the latest compose left it.
    fn place_cursor(&self, painter: &Painter<'_>) {
        let (Some(terminal), Some(app)) = (&self.terminal, self.element.app()) else { return };
        let Some(cursor) = self.report(terminal.cursor()) else { return };
        let (left, top) = painter.origin();
        let (clip_x, clip_y, clip_width, clip_height) = painter.visible_rect();
        let cell = cursor.position.map(|(x, y)| {
            let x = if cursor.wide_tail { x.saturating_sub(1) } else { x };
            (i32::from(x), i32::from(y))
        });
        let shown = cell.filter(|&(x, y)| {
            cursor.visible
                && x >= clip_x
                && y >= clip_y
                && i64::from(x) < i64::from(clip_x) + i64::from(clip_width)
                && i64::from(y) < i64::from(clip_y) + i64::from(clip_height)
        });
        let update = match shown {
            Some((x, y)) => CursorUpdate {
                position: Some(CursorPosition { x: left + x + 1, y: top + y + 1, visible: true }),
                style: Some(match cursor.shape {
                    TerminalCursorShape::Bar => CursorStyle::Line,
                    TerminalCursorShape::Underline => CursorStyle::Underline,
                    TerminalCursorShape::Block | TerminalCursorShape::HollowBlock => CursorStyle::Block,
                }),
                blinking: Some(cursor.blinking),
                color: cursor.color,
                ..Default::default()
            },
            None => hidden_cursor(),
        };
        app.report(app.session().control(Control::Cursor(update)));
    }

    fn report_focus(&self, focused: bool) {
        if self.focused.replace(focused) == focused {
            return;
        }
        if let Some(terminal) = &self.terminal
            && let Some(bytes) = self.report(terminal.encode_focus(focused))
        {
            self.send(bytes, TerminalData::Input);
        }
        if !focused && let Some(app) = self.element.app() {
            app.report(app.session().control(Control::Cursor(hidden_cursor())));
        }
        self.redraw();
    }

    fn encode_key(&self, key: &KeyEvent) -> Vec<u8> {
        let Some(terminal) = &self.terminal else { return Vec::new() };
        // A line feed is Ctrl+J to the program in the terminal, which then reads the byte it stands for.
        let key = &match key.code {
            KeyCode::LineFeed => {
                KeyEvent { code: KeyCode::Char('j'), modifiers: key.modifiers | Modifiers::CTRL, ..*key }
            }
            _ => *key,
        };
        let code = physical_key(key);
        let text = textual_key(key);
        let mut modifiers = key.modifiers;
        if key.code == KeyCode::BackTab {
            modifiers |= Modifiers::SHIFT;
        }
        let key = TerminalKey {
            kind: key.kind,
            code: &code,
            modifiers,
            text: text.as_deref().unwrap_or(""),
            unshifted: unshifted(key),
            ..Default::default()
        };
        self.report(terminal.encode_key(&key)).unwrap_or_default()
    }

    fn encode_paste(&self, text: &str) -> Vec<u8> {
        let Some(terminal) = &self.terminal else { return Vec::new() };
        let mut bytes = Vec::new();
        for chunk in utf8_chunks(text, TERMINAL_INPUT_BYTES_MAX) {
            bytes.extend(self.report(terminal.encode_paste(chunk.as_bytes())).unwrap_or_default());
        }
        bytes
    }

    fn local(&self, x: u16, y: u16) -> (i32, i32) {
        let rect = self.element.rect();
        (i32::from(x) - rect.screen_x.floor() as i32, i32::from(y) - rect.screen_y.floor() as i32)
    }

    /// Clamps a local selection point into the screen, as Core does: above it is the first cell, below it the last.
    fn clamp(&self, (x, y): (i32, i32)) -> (u16, u16) {
        let (cols, rows) = self.size.get();
        let (last_x, last_y) = (i32::from(cols) - 1, i32::from(rows) - 1);
        let (x, y) = if y < 0 {
            (0, 0)
        } else if y > last_y {
            (last_x, last_y)
        } else {
            (x.clamp(0, last_x), y)
        };
        (x as u16, y as u16)
    }
}

fn hidden_cursor() -> CursorUpdate {
    CursorUpdate { position: Some(CursorPosition { x: 1, y: 1, visible: false }), ..Default::default() }
}

/// Splits text into pieces of at most `max` bytes, at character boundaries.
fn utf8_chunks(mut text: &str, max: usize) -> impl Iterator<Item = &str> {
    std::iter::from_fn(move || {
        if text.is_empty() {
            return None;
        }
        let mut end = text.len().min(max);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let (chunk, rest) = text.split_at(end);
        text = rest;
        Some(chunk)
    })
}

/// The W3C code of the key's physical position: letters and digits as on a US layout, using the base-layout key a
/// Kitty terminal reports for other layouts. Ported from Core's `physicalKey`.
fn physical_key(key: &KeyEvent) -> String {
    let named = match key.code {
        KeyCode::Char(character) => {
            let base = key.base_layout.unwrap_or(character);
            return if base.is_ascii_alphabetic() {
                format!("Key{}", base.to_ascii_uppercase())
            } else if base.is_ascii_digit() {
                format!("Digit{base}")
            } else if base == ' ' {
                "Space".to_owned()
            } else {
                String::new()
            };
        }
        KeyCode::F(number @ 1..=25) => return format!("F{number}"),
        KeyCode::Enter => "Enter",
        KeyCode::Tab | KeyCode::BackTab => "Tab",
        KeyCode::Backspace => "Backspace",
        KeyCode::Escape => "Escape",
        KeyCode::Up => "ArrowUp",
        KeyCode::Down => "ArrowDown",
        KeyCode::Left => "ArrowLeft",
        KeyCode::Right => "ArrowRight",
        KeyCode::Home => "Home",
        KeyCode::End => "End",
        KeyCode::PageUp => "PageUp",
        KeyCode::PageDown => "PageDown",
        KeyCode::Insert => "Insert",
        KeyCode::Delete => "Delete",
        KeyCode::CapsLock => "CapsLock",
        KeyCode::ScrollLock => "ScrollLock",
        KeyCode::NumLock => "NumLock",
        KeyCode::PrintScreen => "PrintScreen",
        KeyCode::Pause => "Pause",
        KeyCode::Menu => "ContextMenu",
        KeyCode::KeypadBegin => "NumpadBegin",
        KeyCode::F(_) | KeyCode::Other(_) | KeyCode::LineFeed => "",
    };
    named.to_owned()
}

/// The text a key types, for any modifiers: the encoder decides what Ctrl or Alt make of it. Core's `textualKey`.
fn textual_key(key: &KeyEvent) -> Option<String> {
    match key.code {
        KeyCode::Char(character) if !character.is_control() => Some(character.to_string()),
        _ => None,
    }
}

/// The character the key types without Shift. Core's `unshiftedCodepoint`, which also ignores Kitty's base-layout
/// key: it names a physical position, not the active layout's character.
fn unshifted(key: &KeyEvent) -> Option<char> {
    match key.code {
        KeyCode::Char(character) if !character.is_control() => {
            let mut lower = character.to_lowercase();
            match (lower.next(), lower.next()) {
                (Some(single), None) => Some(single),
                _ => Some(character),
            }
        }
        _ => None,
    }
}

fn mouse_button(button: MouseButton) -> Option<TerminalMouseButton> {
    match button {
        MouseButton::Left => Some(TerminalMouseButton::Left),
        MouseButton::Middle => Some(TerminalMouseButton::Middle),
        MouseButton::Right => Some(TerminalMouseButton::Right),
        // Back and forward have no encoding in the native ABI.
        MouseButton::Other(_) => None,
    }
}

/// Whether a captured cell belongs to a word. The right half of a wide character goes with its left half.
fn word_cell(capture: &Capture, x: u32, y: u32) -> bool {
    let mut x = x;
    loop {
        let Some(cell) = capture.cell(x, y) else { return false };
        if cell.symbol.is_empty() && x > 0 {
            x -= 1;
            continue;
        }
        return !cell.symbol.trim().is_empty()
            && !cell.symbol.chars().all(|character| WORD_SEPARATORS.contains(character));
    }
}

/// The first and last column of the word at a cell, or the cell alone outside words.
fn word_bounds(capture: &Capture, (x, y): (u16, u16)) -> (u16, u16) {
    let (x32, y32) = (u32::from(x), u32::from(y));
    if !word_cell(capture, x32, y32) {
        return (x, x);
    }
    let mut start = x32;
    while start > 0 && word_cell(capture, start - 1, y32) {
        start -= 1;
    }
    let mut end = x32;
    while end + 1 < capture.width && word_cell(capture, end + 1, y32) {
        end += 1;
    }
    (start as u16, end as u16)
}

impl Behavior for TerminalInner {
    fn element(&self) -> &Element {
        &self.element
    }

    fn key(&self, _cx: &mut Cx<'_>, key: &KeyEvent) -> bool {
        let bytes = self.encode_key(key);
        self.input(bytes)
    }

    fn paste(&self, _cx: &mut Cx<'_>, text: &str) -> bool {
        let bytes = self.encode_paste(text);
        self.input(bytes);
        true
    }

    fn mouse(&self, cx: &mut Cx<'_>, event: &MouseEvent) -> bool {
        use TerminalMouseAction::{Motion, Press, Release};
        let Some(terminal) = &self.terminal else { return false };
        let (action, button, pressed) = match event.kind {
            MouseEventKind::Down(button) => (Press, mouse_button(button), true),
            MouseEventKind::Up(button) => (Release, mouse_button(button), false),
            MouseEventKind::Drag(button) => (Motion, mouse_button(button), true),
            MouseEventKind::Moved => (Motion, None, false),
            MouseEventKind::ScrollUp => (Press, Some(TerminalMouseButton::WheelUp), false),
            MouseEventKind::ScrollDown => (Press, Some(TerminalMouseButton::WheelDown), false),
            MouseEventKind::ScrollLeft => (Press, Some(TerminalMouseButton::WheelLeft), false),
            MouseEventKind::ScrollRight => (Press, Some(TerminalMouseButton::WheelRight), false),
        };
        if action != Motion && button.is_none() {
            return false;
        }
        // A left press focuses the terminal even without `focus_on_click`, as Core's `forwardMouse` does, and tells
        // the program before it sees the click.
        if event.kind == MouseEventKind::Down(MouseButton::Left)
            && let Some(behavior) = self.element.behavior()
        {
            cx.focus(&super::AnyWidget(behavior));
            if self.element.is_focusable() {
                self.report_focus(true);
            }
        }
        let (x, y) = self.local(event.x, event.y);
        let mouse = TerminalMouse {
            action,
            button,
            modifiers: event.modifiers,
            x: x as f32,
            y: y as f32,
            any_button_pressed: pressed,
        };
        let bytes = self.report(terminal.encode_mouse(&mouse)).unwrap_or_default();
        if !bytes.is_empty() {
            self.send(bytes, TerminalData::Input);
            return true;
        }
        // A wheel step the program does not take scrolls the scrollback. A step the view cannot move, up at the top of
        // the history or down at the live screen, goes on to a surrounding scroll box.
        let viewport = self.viewport();
        let rows = match event.kind {
            MouseEventKind::ScrollUp if viewport.at_top() => return false,
            MouseEventKind::ScrollUp => -WHEEL_ROWS,
            MouseEventKind::ScrollDown if viewport.at_live() => return false,
            MouseEventKind::ScrollDown => WHEEL_ROWS,
            _ => return false,
        };
        self.scroll(rows);
        true
    }

    fn focus_changed(&self, _cx: &mut Cx<'_>, focused: bool) {
        self.report_focus(focused);
    }

    fn resized(&self, cx: &mut Cx<'_>, width: u32, height: u32) {
        if width > 0 && height > 0 {
            let clamp = |cells: u32| cells.min(u32::from(u16::MAX)) as u16;
            self.resize_terminal(cx, clamp(width), clamp(height));
        }
    }

    fn paint(&self, painter: &mut Painter<'_>) {
        let Some(buffer) = self.composed() else { return };
        painter.draw_buffer(&buffer, 0, 0);
        if self.focused.get() {
            self.place_cursor(painter);
        }
    }

    fn selectable(&self) -> bool {
        self.selectable.get() && self.terminal.is_some()
    }

    /// While the program tracks the mouse, presses go to it instead of starting a selection.
    fn starts_selection(&self, x: i32, y: i32) -> bool {
        let rect = self.element.rect();
        let inside = rect.contains(f64::from(x), f64::from(y));
        inside && self.terminal.as_ref().is_some_and(|terminal| self.report(terminal.tracks_mouse()) == Some(false))
    }

    fn select(&self, selection: Option<&SelectionUpdate>) -> bool {
        let Some(terminal) = &self.terminal else { return false };
        let Some(selection) = selection else {
            if self.selected.replace(false) {
                self.report(terminal.clear_selection());
                self.redraw();
            }
            return false;
        };
        let (anchor, focus) = selection.local(&self.element);
        // A cell drag selects once it leaves its first cell; coming back to it later still selects that cell.
        if !self.selected.get() && selection.unit == SelectionUnit::Cell && anchor == focus {
            return false;
        }
        let (anchor, focus) = (self.clamp(anchor), self.clamp(focus));
        let (first, last) = if (anchor.1, anchor.0) <= (focus.1, focus.0) { (anchor, focus) } else { (focus, anchor) };
        let (start, end) = match selection.unit {
            SelectionUnit::Cell => (first, last),
            SelectionUnit::Line => ((0, first.1), (self.size.get().0 - 1, last.1)),
            SelectionUnit::Word => match self.capture() {
                Some(capture) => ((word_bounds(&capture, first).0, first.1), (word_bounds(&capture, last).1, last.1)),
                None => (first, last),
            },
        };
        if self.report(terminal.set_selection(start, end)).is_none() {
            return false;
        }
        self.selected.set(true);
        self.redraw();
        true
    }

    fn selected_text(&self) -> Option<String> {
        if !self.selected.get() {
            return None;
        }
        self.report(self.terminal.as_ref()?.selected_text())
    }

    fn teardown(&self) {
        self.on_data.clear();
        self.on_terminal_resize.clear();
        self.on_exit.clear();
        self.pty.borrow_mut().take();
    }
}

/// A terminal emulator in a widget: shows a shell or any program running on a pseudo-terminal.
///
/// Native code emulates the terminal. [`Self::spawn`] runs a program on a new pseudo-terminal wired to the widget;
/// alternatively, feed program output to [`Self::write`] and send what [`Self::on_data`] hands you to the program's
/// input yourself.
///
/// The terminal follows the widget's size; without a size or grow factor it asks for 80 by 24 cells. While focused,
/// it encodes keys, pastes, and focus changes as the program asked, and places the real cursor at the program's
/// cursor. It takes every key that sends something, Tab and Ctrl+C included, so register app-wide shortcuts with
/// [`App::on_key_capture`]. Mouse events go to the program when it tracks the mouse; otherwise dragging selects text
/// and the wheel scrolls back through the output. A wheel step the view cannot take, up at the top of the history or
/// down at the live screen, goes on to a surrounding [`ScrollBox`](super::ScrollBox). [`Self::viewport`] says where
/// the view sits.
///
/// ```no_run
/// use opentui::prelude::*;
/// use opentui::pty;
///
/// fn main() -> Result<(), Box<dyn std::error::Error>> {
///     let app = App::new(AppOptions::default())?;
///     let terminal = TerminalView::new(&app).grow(1.0).spawn(pty::shell())?;
///     terminal.on_exit(|cx, _status| cx.quit());
///     app.on_key_capture(|cx, key| {
///         if key.matches("ctrl+q") {
///             cx.quit();
///         }
///     });
///     app.root().add(&terminal);
///     terminal.focus();
///     app.run()?;
///     Ok(())
/// }
/// ```
#[derive(Clone)]
pub struct TerminalView(Rc<TerminalInner>);

handle!(TerminalView, TerminalInner);

impl TerminalView {
    /// An 80 by 24 terminal with 10 MB of scrollback.
    pub fn new(app: &App) -> Self {
        Self::with_options(app, EmbeddedTerminalOptions::default())
    }

    /// A terminal of the given size and scrollback. The size is the one it asks layout for and starts with.
    pub fn with_options(app: &App, options: EmbeddedTerminalOptions) -> Self {
        let options = EmbeddedTerminalOptions { cols: options.cols.max(1), rows: options.rows.max(1), ..options };
        let terminal = app.report(EmbeddedTerminal::new(app.session().context(), options));
        let view = Self(build(app, NodeKind::Box, |element| TerminalInner {
            element,
            terminal,
            buffer: RefCell::new(None),
            natural: (options.cols, options.rows),
            size: Cell::new((options.cols, options.rows)),
            selectable: Cell::new(true),
            selected: Cell::new(false),
            focused: Cell::new(false),
            on_data: Callbacks::default(),
            on_terminal_resize: Callbacks::default(),
            on_exit: Callbacks::default(),
            pty: RefCell::new(None),
            spawns: Cell::new(0),
        }));
        let element = &view.0.element;
        element.set_focusable(true);
        element.pointer.set(Some(MousePointer::TEXT));
        element.add_hooks(Hooks::RESIZE | Hooks::RENDER_SELF);
        let weak = Rc::downgrade(&view.0);
        let measurer: std::rc::Weak<dyn Measure> = weak;
        element.apply(|node| node.set_measure(Some(measurer)));
        view.apply_theme(app);
        view
    }

    /// Starts with the theme's colors as the terminal's default colors, which programs can also query.
    fn apply_theme(&self, app: &App) {
        let Some(terminal) = &self.0.terminal else { return };
        let theme = app.theme();
        let osc = |number: u8, color: Color| {
            format!("\x1b]{number};rgb:{:02x}/{:02x}/{:02x}\x1b\\", color.r, color.g, color.b)
        };
        let colors = osc(10, theme.foreground) + &osc(11, theme.background) + &osc(12, theme.cursor);
        self.0.report(terminal.write(colors.as_bytes()));
        if theme.background.a == 0 {
            self.0.report(terminal.set_transparent_background(true));
        }
    }

    /// Feeds program output to the terminal. Replies the program asked for go to [`Self::on_data`] handlers and the
    /// spawned program as [`TerminalData::Response`].
    pub fn write(&self, bytes: impl AsRef<[u8]>) -> Self {
        self.0.write(bytes.as_ref());
        self.clone()
    }

    /// Handles bytes for the program's input: encoded keys, mouse events, pastes, and focus changes, and replies to
    /// its queries. A program started with [`Self::spawn`] gets them already; handlers see them too.
    pub fn on_data(&self, mut handler: impl FnMut(&mut Cx<'_>, &[u8], TerminalData) + 'static) -> Self {
        self.0.on_data.add(move |cx, (source, bytes): &(TerminalData, Vec<u8>)| handler(cx, bytes, *source));
        self.clone()
    }

    /// Called with the new columns and rows when the terminal follows a change of the widget's size. A program
    /// started with [`Self::spawn`] is resized already.
    pub fn on_terminal_resize(&self, mut handler: impl FnMut(&mut Cx<'_>, u16, u16) + 'static) -> Self {
        self.0.on_terminal_resize.add(move |cx, &(cols, rows): &(u16, u16)| handler(cx, cols, rows));
        self.clone()
    }

    /// Runs `command` on a new pseudo-terminal of the terminal's size, wired to this widget: its output shows here,
    /// input goes to it, and it follows the widget's size. A program started earlier is hung up, and its output and
    /// exit no longer reach the widget, even while a [`Self::pty`] handle keeps it running. See
    /// [`crate::pty::shell`] for the user's shell.
    pub fn spawn(&self, command: Command) -> std::io::Result<Self> {
        let app = self.0.element.app().ok_or_else(|| std::io::Error::other("the app has ended"))?;
        let (cols, rows) = self.0.size.get();
        let spawn = self.0.spawns.get() + 1;
        let weak = Rc::downgrade(&self.0);
        let current = move || weak.upgrade().filter(|inner| inner.spawns.get() == spawn);
        let pty = Pty::spawn(&app, command, cols, rows)?
            .on_output({
                let current = current.clone();
                move |_cx, bytes| {
                    if let Some(inner) = current() {
                        inner.write(bytes);
                    }
                }
            })
            .on_exit(move |cx, status| {
                if let Some(inner) = current() {
                    inner.on_exit.emit(cx, &status);
                }
            });
        self.0.spawns.set(spawn);
        let previous = self.0.pty.replace(Some(pty));
        drop(previous);
        Ok(self.clone())
    }

    /// Called after the last output when the program [`Self::spawn`] started exits.
    pub fn on_exit(&self, mut handler: impl FnMut(&mut Cx<'_>, ExitStatus) + 'static) -> Self {
        self.0.on_exit.add(move |cx, status: &ExitStatus| handler(cx, *status));
        self.clone()
    }

    /// The program [`Self::spawn`] started, to signal it or read its exit status.
    pub fn pty(&self) -> Option<Pty> {
        self.0.pty.borrow().clone()
    }

    /// The native emulator, for operations this widget does not wrap. `None` if native code failed to create it.
    pub fn terminal(&self) -> Option<EmbeddedTerminal> {
        self.0.terminal.clone()
    }

    /// The bytes a key sends in the program's keyboard mode, without sending them.
    pub fn encode_key(&self, key: &KeyEvent) -> Vec<u8> {
        self.0.encode_key(key)
    }

    /// The bytes a paste sends, bracketed if the program enabled bracketed paste, without sending them.
    pub fn encode_paste(&self, text: &str) -> Vec<u8> {
        self.0.encode_paste(text)
    }

    /// The current columns and rows.
    pub fn terminal_size(&self) -> (u16, u16) {
        self.0.size.get()
    }

    /// The text on screen and the cursor, as the next frame shows them.
    pub fn screen(&self) -> TerminalScreen {
        let (cols, rows) = self.0.size.get();
        let mut lines: Vec<String> = match self.0.capture() {
            Some(capture) => (0..capture.height).map(|y| capture.row(y).trim_end().to_owned()).collect(),
            None => Vec::new(),
        };
        while lines.last().is_some_and(String::is_empty) {
            lines.pop();
        }
        let cursor = self.0.terminal.as_ref().and_then(|terminal| self.0.report(terminal.cursor())).unwrap_or_default();
        TerminalScreen { lines, cols, rows, cursor }
    }

    /// Draws the default background in the terminal's own default color instead of the theme's background.
    pub fn transparent_background(&self, transparent: bool) -> Self {
        if let Some(terminal) = &self.0.terminal {
            self.0.report(terminal.set_transparent_background(transparent));
            self.0.redraw();
        }
        self.clone()
    }

    /// Whether dragging selects text, alone or as part of a selection across widgets. On by default.
    pub fn selectable(&self, selectable: bool) -> Self {
        self.0.selectable.set(selectable);
        self.clone()
    }

    /// This terminal's part of the mouse selection, or an empty string.
    pub fn selected_text(&self) -> String {
        self.0.selected_text().unwrap_or_default()
    }

    /// Scrolls through the scrollback by `rows`; negative values move back in history.
    pub fn scroll_by(&self, rows: i32) -> Self {
        self.0.scroll(rows);
        self.clone()
    }

    /// Returns to the live screen. Typing does this too.
    pub fn scroll_to_bottom(&self) -> Self {
        self.0.scroll_to_bottom();
        self.clone()
    }

    /// Where the view sits in the scrollback, as of the latest output, resize, and scroll. All zero if native code
    /// failed to create the terminal.
    pub fn viewport(&self) -> TerminalViewport {
        self.0.viewport()
    }
}
