use super::{Behavior, Callbacks, Element, Painter, build, handle, keymap_methods};
use crate::app::{App, Cx};
use crate::input::{KeyEvent, Keymap, MouseButton, MouseEvent, MouseEventKind};
use crate::native::{Hooks, NodeKind};
use crate::style::{Alignment, Color, Style};
use std::cell::RefCell;
use std::rc::Rc;

/// What a key does in a [`Table`]. Bind keys to actions with [`Table::bind`], or run one with [`Table::perform`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TableAction {
    /// The row above, or the first row when none is selected.
    MoveUp,
    /// The row below, or the first row when none is selected.
    MoveDown,
    PageUp,
    PageDown,
    First,
    Last,
    /// Calls [`Table::on_select`] with the selected row.
    SelectCurrent,
}

/// How wide a table column is.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ColumnWidth {
    /// A fixed number of cells.
    Cells(u32),
    /// A share of the space left after fixed columns, by weight.
    Fill(f32),
}

/// One table column.
#[derive(Clone, Debug, PartialEq)]
pub struct Column {
    pub title: String,
    pub width: ColumnWidth,
    pub align: Alignment,
}

impl Column {
    /// A column that shares the free space equally with other filling columns.
    pub fn new(title: impl Into<String>) -> Self {
        Self { title: title.into(), width: ColumnWidth::Fill(1.0), align: Alignment::Left }
    }

    pub fn width(mut self, width: ColumnWidth) -> Self {
        self.width = width;
        self
    }

    pub fn align(mut self, align: Alignment) -> Self {
        self.align = align;
        self
    }
}

impl From<&str> for Column {
    fn from(title: &str) -> Self {
        Self::new(title)
    }
}

impl From<String> for Column {
    fn from(title: String) -> Self {
        Self::new(title)
    }
}

struct State {
    columns: Vec<Column>,
    rows: Vec<Vec<String>>,
    selected: Option<usize>,
    offset: usize,
    header: bool,
    striped: bool,
    fg: Color,
    header_fg: Color,
    header_bg: Color,
    stripe_bg: Color,
    selected_fg: Color,
    selected_bg: Color,
}

impl State {
    /// Resolves column widths for a total width, with one cell between columns.
    fn widths(&self, total: u32) -> Vec<u32> {
        let gaps = self.columns.len().saturating_sub(1) as u32;
        let fixed: u32 = self
            .columns
            .iter()
            .map(|column| match column.width {
                ColumnWidth::Cells(cells) => cells,
                ColumnWidth::Fill(_) => 0,
            })
            .sum();
        let free = total.saturating_sub(fixed + gaps);
        let weight: f32 = self
            .columns
            .iter()
            .map(|column| match column.width {
                ColumnWidth::Fill(weight) => weight.max(0.0),
                ColumnWidth::Cells(_) => 0.0,
            })
            .sum();
        let mut remaining = free;
        let fills = self.columns.iter().filter(|column| matches!(column.width, ColumnWidth::Fill(_))).count();
        let mut seen = 0;
        self.columns
            .iter()
            .map(|column| match column.width {
                ColumnWidth::Cells(cells) => cells,
                ColumnWidth::Fill(share) => {
                    seen += 1;
                    // The last filling column takes the rounding remainder.
                    let width = if seen == fills {
                        remaining
                    } else if weight > 0.0 {
                        ((free as f32) * share.max(0.0) / weight).floor() as u32
                    } else {
                        0
                    };
                    let width = width.min(remaining);
                    remaining -= width;
                    width
                }
            })
            .collect()
    }

    fn body_rows(&self, height: u32) -> usize {
        height.saturating_sub(u32::from(self.header)).max(1) as usize
    }

    /// The first visible row: the stored offset, clamped to the rows and height. Painting and hit testing both use
    /// it, so a stale offset can never make them disagree.
    fn offset(&self, visible: usize) -> usize {
        self.offset.min(self.rows.len().saturating_sub(visible))
    }

    /// Scrolls the least distance that keeps the selection visible.
    fn reveal(&mut self, visible: usize) {
        self.offset = self.offset(visible);
        if let Some(selected) = self.selected {
            if selected < self.offset {
                self.offset = selected;
            } else if selected >= self.offset + visible {
                self.offset = selected + 1 - visible;
            }
        }
        self.offset = self.offset.min(self.rows.len().saturating_sub(visible));
    }
}

pub(crate) struct TableInner {
    element: Element,
    state: RefCell<State>,
    on_change: Callbacks<usize>,
    on_select: Callbacks<usize>,
    keymap: RefCell<Keymap<TableAction>>,
}

impl TableInner {
    fn visible(&self) -> usize {
        let height = self.element.rect().height.max(0.0) as u32;
        self.state.borrow().body_rows(height)
    }

    fn select(&self, cx: &mut Cx<'_>, index: usize) {
        let visible = self.visible();
        let changed = {
            let mut state = self.state.borrow_mut();
            if state.rows.is_empty() {
                return;
            }
            let index = index.min(state.rows.len() - 1);
            let changed = state.selected != Some(index);
            state.selected = Some(index);
            state.reveal(visible);
            changed.then_some(index)
        };
        self.element.app().inspect(App::request_redraw);
        // Handlers may change this table, so no borrow is held while they run.
        if let Some(index) = changed {
            self.on_change.emit(cx, &index);
        }
    }
}

impl TableInner {
    /// Runs an action. With no selection, only actions that start one do anything.
    fn run(&self, cx: &mut Cx<'_>, action: TableAction) -> bool {
        use TableAction as A;
        let current = self.state.borrow().selected;
        let page = self.visible().max(2) - 1;
        let target = match (current, action) {
            (None, A::MoveUp | A::MoveDown | A::First) => 0,
            (None, _) => return false,
            (Some(index), A::MoveUp) => index.saturating_sub(1),
            (Some(index), A::MoveDown) => index + 1,
            (Some(index), A::PageUp) => index.saturating_sub(page),
            (Some(index), A::PageDown) => index + page,
            (Some(_), A::First) => 0,
            (Some(_), A::Last) => usize::MAX,
            (Some(index), A::SelectCurrent) => {
                self.on_select.emit(cx, &index);
                return true;
            }
        };
        self.select(cx, target);
        true
    }
}

impl Behavior for TableInner {
    fn element(&self) -> &Element {
        &self.element
    }

    fn key(&self, cx: &mut Cx<'_>, key: &KeyEvent) -> bool {
        let action = self.keymap.borrow().get(key);
        action.is_some_and(|action| self.run(cx, action))
    }

    fn mouse(&self, cx: &mut Cx<'_>, event: &MouseEvent) -> bool {
        match event.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                let rect = self.element.rect();
                let row = (f64::from(event.y) - rect.screen_y.floor()).max(0.0) as usize;
                let visible = self.visible();
                let (header, offset, count, selected) = {
                    let state = self.state.borrow();
                    (usize::from(state.header), state.offset(visible), state.rows.len(), state.selected)
                };
                if row < header || offset + row - header >= count {
                    return false;
                }
                let index = offset + row - header;
                if selected == Some(index) {
                    self.on_select.emit(cx, &index);
                } else {
                    self.select(cx, index);
                }
                false
            }
            MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
                let visible = self.visible();
                let mut state = self.state.borrow_mut();
                let offset = state.offset(visible);
                state.offset = if event.kind == MouseEventKind::ScrollUp {
                    offset.saturating_sub(1)
                } else {
                    (offset + 1).min(state.rows.len().saturating_sub(visible))
                };
                self.element.app().inspect(App::request_redraw);
                // An unmoved table lets an outer scroll area scroll instead.
                state.offset != offset
            }
            _ => false,
        }
    }

    fn teardown(&self) {
        self.on_change.clear();
        self.on_select.clear();
    }

    fn paint(&self, painter: &mut Painter<'_>) {
        let state = self.state.borrow();
        let (width, height) = painter.size();
        let widths = state.widths(width);
        let draw_row = |painter: &mut Painter<'_>, y: i32, cells: &mut dyn Iterator<Item = &str>, style: Style| {
            let mut x = 0i32;
            for ((column, cell), &cells_width) in state.columns.iter().zip(cells).zip(&widths) {
                if cells_width > 0 && !cell.is_empty() {
                    let text_width = painter.text_width(cell);
                    let left = match column.align {
                        Alignment::Left => x,
                        Alignment::Center => x + (cells_width.saturating_sub(text_width) / 2) as i32,
                        Alignment::Right => x + cells_width.saturating_sub(text_width) as i32,
                    };
                    if text_width > cells_width && cells_width > 1 {
                        painter.clip(x, y, cells_width - 1, 1, |painter| painter.text(x, y, cell, style));
                        painter.text(x + cells_width as i32 - 1, y, "…", style);
                    } else {
                        painter.clip(x, y, cells_width, 1, |painter| painter.text(left, y, cell, style));
                    }
                }
                x += cells_width as i32 + 1;
            }
        };
        let mut y = 0;
        if state.header {
            painter.fill(0, 0, width, 1, state.header_bg);
            draw_row(
                painter,
                0,
                &mut state.columns.iter().map(|column| column.title.as_str()),
                Style::new().fg(state.header_fg).bold(),
            );
            y = 1;
        }
        let visible = state.body_rows(height);
        let offset = state.offset(visible);
        for (index, row) in state.rows.iter().enumerate().skip(offset).take(visible) {
            let selected = state.selected == Some(index);
            let background = if selected {
                Some(state.selected_bg)
            } else if state.striped && index % 2 == 1 {
                Some(state.stripe_bg)
            } else {
                None
            };
            if let Some(background) = background {
                painter.fill(0, y, width, 1, background);
            }
            let fg = if selected { state.selected_fg } else { state.fg };
            draw_row(painter, y, &mut row.iter().map(String::as_str), Style::new().fg(fg));
            y += 1;
        }
    }
}

/// Rows of text in aligned columns, with a header, an optional selection, and scrolling.
///
/// While focused, Up/Down or j/k move the selection, Page Up/Down and Home/End jump, and Enter calls
/// [`Self::on_select`]; [`Self::bind`] changes the keys. Clicking a row selects it; clicking the selected row activates it. Give it a height or a
/// grow factor.
///
/// ```no_run
/// # use opentui::prelude::*;
/// # use opentui::widget::{Column, ColumnWidth, Table};
/// # let app = App::new(AppOptions::default())?;
/// let table = Table::new(&app)
///     .set_columns([Column::new("Name"), Column::new("Size").width(ColumnWidth::Cells(8)).align(Alignment::Right)])
///     .set_rows([["Cargo.toml", "1 KB"], ["README.md", "6 KB"]])
///     .grow(1.0);
/// # Ok::<(), opentui::Error>(())
/// ```
#[derive(Clone)]
pub struct Table(Rc<TableInner>);

handle!(Table, TableInner);

impl Table {
    pub fn new(app: &App) -> Self {
        let theme = app.theme();
        let table = Self(build(app, NodeKind::Box, |element| TableInner {
            element,
            state: RefCell::new(State {
                columns: Vec::new(),
                rows: Vec::new(),
                selected: None,
                offset: 0,
                header: true,
                striped: false,
                fg: theme.foreground,
                header_fg: theme.accent,
                header_bg: theme.surface,
                stripe_bg: theme.surface,
                selected_fg: theme.highlight_fg,
                selected_bg: theme.highlight_bg,
            }),
            on_change: Callbacks::default(),
            on_select: Callbacks::default(),
            keymap: RefCell::new(Self::default_keymap()),
        }));
        table.0.element.set_focusable(true);
        table.0.element.add_hooks(Hooks::RENDER_AFTER);
        table
    }

    /// The key bindings a new table starts with.
    pub fn default_keymap() -> Keymap<TableAction> {
        use TableAction as A;
        Keymap::new()
            .bind("up", A::MoveUp)
            .bind("k", A::MoveUp)
            .bind("down", A::MoveDown)
            .bind("j", A::MoveDown)
            .bind("pageup", A::PageUp)
            .bind("pagedown", A::PageDown)
            .bind("home", A::First)
            .bind("end", A::Last)
            .bind("enter", A::SelectCurrent)
            .bind("linefeed", A::SelectCurrent)
    }

    keymap_methods!(TableAction);

    /// Runs an action as its key would, including change and select handlers.
    pub fn perform(&self, action: TableAction) -> Self {
        if let Some(app) = self.0.element.app() {
            self.0.run(&mut Cx::new(&app), action);
        }
        self.clone()
    }

    fn update(&self, change: impl FnOnce(&mut State)) -> Self {
        change(&mut self.0.state.borrow_mut());
        self.0.element.app().inspect(App::request_redraw);
        self.clone()
    }

    /// Replaces the columns: [`Column`]s, or titles of columns like [`Column::new`] makes.
    pub fn set_columns<C: Into<Column>>(&self, columns: impl IntoIterator<Item = C>) -> Self {
        let columns = columns.into_iter().map(Into::into).collect();
        self.update(|state| state.columns = columns)
    }

    pub fn columns(&self) -> Vec<Column> {
        self.0.state.borrow().columns.clone()
    }

    /// Replaces the rows. Keeps the selection when its index still exists.
    pub fn set_rows<R, C>(&self, rows: impl IntoIterator<Item = R>) -> Self
    where
        R: IntoIterator<Item = C>,
        C: Into<String>,
    {
        let rows: Vec<Vec<String>> = rows.into_iter().map(|row| row.into_iter().map(Into::into).collect()).collect();
        self.update(|state| {
            state.selected = state.selected.filter(|&index| index < rows.len());
            state.offset = state.offset.min(rows.len().saturating_sub(1));
            state.rows = rows;
        })
    }

    pub fn rows(&self) -> Vec<Vec<String>> {
        self.0.state.borrow().rows.clone()
    }

    /// Appends one row.
    pub fn push_row<C: Into<String>>(&self, row: impl IntoIterator<Item = C>) -> Self {
        let row = row.into_iter().map(Into::into).collect();
        self.update(|state| state.rows.push(row))
    }

    pub fn row_count(&self) -> usize {
        self.0.state.borrow().rows.len()
    }

    pub fn row(&self, index: usize) -> Option<Vec<String>> {
        self.0.state.borrow().rows.get(index).cloned()
    }

    pub fn selected(&self) -> Option<usize> {
        self.0.state.borrow().selected
    }

    /// Selects a row and scrolls it into view, or clears the selection with `None`. Out-of-range indexes are ignored.
    /// Does not call change handlers.
    pub fn select(&self, index: Option<usize>) -> Self {
        let visible = self.0.visible();
        self.update(|state| {
            if index.is_none_or(|index| index < state.rows.len()) {
                state.selected = index;
                state.reveal(visible);
            }
        })
    }

    pub fn show_header(&self, show: bool) -> Self {
        self.update(|state| state.header = show)
    }

    /// Shades every other row with [`Self::stripe_color`].
    pub fn striped(&self, striped: bool) -> Self {
        self.update(|state| state.striped = striped)
    }

    /// The color of the rows' text. It starts as the theme's foreground.
    pub fn fg(&self, color: Color) -> Self {
        self.update(|state| state.fg = color)
    }

    /// The background of every other row when [`Self::striped`]. It starts as the theme's surface, the header's
    /// background.
    pub fn stripe_color(&self, color: Color) -> Self {
        self.update(|state| state.stripe_bg = color)
    }

    pub fn header_colors(&self, fg: Color, bg: Color) -> Self {
        self.update(|state| (state.header_fg, state.header_bg) = (fg, bg))
    }

    pub fn selected_colors(&self, fg: Color, bg: Color) -> Self {
        self.update(|state| (state.selected_fg, state.selected_bg) = (fg, bg))
    }

    /// Called when the selection moves, with the selected row index.
    pub fn on_change(&self, mut handler: impl FnMut(&mut Cx<'_>, usize) + 'static) -> Self {
        self.0.on_change.add(move |cx, index: &usize| handler(cx, *index));
        self.clone()
    }

    /// Called when Enter or a click activates the selected row.
    pub fn on_select(&self, mut handler: impl FnMut(&mut Cx<'_>, usize) + 'static) -> Self {
        self.0.on_select.add(move |cx, index: &usize| handler(cx, *index));
        self.clone()
    }
}
