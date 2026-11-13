use super::{Behavior, Content, Element, LocalSelection, Painter, SelectionUpdate, build, handle};
use crate::app::App;
use crate::layout::LayoutProperty;
use crate::native::{
    Constraint, GridSpec, Hooks, Measure, NodeKind, SelectionColors, SelectionUnit, TextBuffer, TextMeasure, TextView,
    Viewport, WrapMode,
};
use crate::style::{Alignment, Attributes, BorderStyle, Color, Style};
use std::cell::{Cell, RefCell};
use std::cmp::Ordering;
use std::rc::{Rc, Weak};

/// How a [`TextTable`] sizes its columns when the table has room to spare.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum ColumnWidthMode {
    /// Each column is as wide as its widest cell, and the table is narrower than its space.
    Content,
    /// The columns share the spare width, so the table fills its width.
    #[default]
    Full,
}

/// How a [`TextTable`] narrows columns whose cells do not fit its width. Cells then wrap; with
/// [`WrapMode::None`], columns keep their width and the table is cut off instead.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum ColumnFitter {
    /// Every column keeps at least one cell, and the rest of the width is shared by the square root of each
    /// column's extra width, so wide columns give up the most.
    #[default]
    Proportional,
    /// Columns narrower than an even share keep their width, and wider columns shrink by the square root of their
    /// excess, so the widths end up closer together.
    Balanced,
}

/// One cell: its content, and the native buffer and view that wrap, measure, draw, and select it.
struct TableCell {
    content: Content,
    buffer: TextBuffer,
    view: TextView,
}

/// Rows of cells, all `columns` long. A cell is `None` when native code could not create it.
#[derive(Default)]
struct Cells {
    rows: Vec<Vec<Option<TableCell>>>,
    columns: usize,
}

impl Cells {
    fn views(&self) -> impl Iterator<Item = &TextView> {
        self.rows.iter().flatten().flatten().map(|cell| &cell.view)
    }
}

struct Options {
    wrap: WrapMode,
    width_mode: ColumnWidthMode,
    fitter: ColumnFitter,
    /// Each column's line alignment; a missing one is left.
    alignments: Vec<Alignment>,
    padding_x: u32,
    padding_y: u32,
    column_gap: u32,
    border: bool,
    /// `None` follows `border`.
    outer_border: Option<bool>,
    show_borders: bool,
    border_style: BorderStyle,
    border_color: Color,
    border_bg: Color,
    /// Colors and attributes of text without its own.
    text: Style,
    selectable: bool,
    selection_colors: SelectionColors,
}

/// Which grid lines take space.
#[derive(Clone, Copy)]
struct Borders {
    outer: bool,
    inner_vertical: bool,
    inner_horizontal: bool,
}

impl Options {
    fn borders(&self, rows: usize, columns: usize) -> Borders {
        Borders {
            outer: self.outer_border.unwrap_or(self.border),
            inner_vertical: self.border && columns > 1,
            inner_horizontal: self.border && rows > 1,
        }
    }

    fn gap(&self, borders: Borders) -> u32 {
        if borders.inner_vertical { 0 } else { self.column_gap }
    }

    /// The width that layout depends on for a node width: none when the columns keep their content widths anyway.
    fn width_constraint(&self, width: Option<u32>) -> Option<u32> {
        width.filter(|&width| width > 0 && (self.wrap != WrapMode::None || self.width_mode == ColumnWidthMode::Full))
    }
}

/// Column widths and row heights, and the cells of the grid lines around them.
///
/// Offsets are the x or y cells of the boundaries, outer edges included: column `i` starts at
/// `column_offsets[i] + 1`. A left or top edge without a border lies one cell outside the table.
#[derive(Clone, Debug, Default, PartialEq)]
struct Layout {
    columns: Vec<u32>,
    rows: Vec<u32>,
    column_offsets: Vec<i32>,
    row_offsets: Vec<i32>,
    width: u32,
    height: u32,
}

impl Layout {
    fn cell_left(&self, column: usize) -> i32 {
        self.column_offsets[column] + 1
    }

    fn cell_top(&self, row: usize) -> i32 {
        self.row_offsets[row] + 1
    }

    fn column_at(&self, x: i32) -> Option<usize> {
        if x < 0 || x >= self.width as i32 {
            return None;
        }
        (0..self.columns.len()).find(|&column| {
            let left = self.cell_left(column);
            x >= left && x < left + self.columns[column] as i32
        })
    }

    fn cell_at(&self, x: i32, y: i32) -> Option<(usize, usize)> {
        if y < 0 || y >= self.height as i32 {
            return None;
        }
        let row = (0..self.rows.len()).find(|&row| {
            let top = self.cell_top(row);
            y >= top && y < top + self.rows[row] as i32
        })?;
        Some((row, self.column_at(x)?))
    }

    /// The row at `y`, or the nearest one above or below the table.
    fn row_near(&self, y: i32) -> usize {
        (0..self.rows.len())
            .find(|&row| y < self.cell_top(row) + self.rows[row] as i32)
            .unwrap_or(self.rows.len().saturating_sub(1))
    }
}

/// The cells of the boundaries around `parts`, as in [`Layout`].
fn offsets(parts: &[u32], outer: bool, inner: bool, gap: u32) -> Vec<i32> {
    let mut cursor = if outer { 0i64 } else { -1 };
    let mut offsets = Vec::with_capacity(parts.len() + 1);
    offsets.push(cursor as i32);
    for (index, &size) in parts.iter().enumerate() {
        let separator = if index + 1 < parts.len() { if inner { 1 } else { gap } } else { u32::from(outer) };
        cursor += i64::from(size) + i64::from(separator);
        offsets.push(cursor.min(i64::from(i32::MAX)) as i32);
    }
    offsets
}

fn measure_cell(cell: &Option<TableCell>, width: u32) -> TextMeasure {
    cell.as_ref().and_then(|cell| cell.view.measure(width).ok()).unwrap_or_default()
}

/// Lays the table out within `max_width` cells, or at its content size.
fn compute_layout(cells: &Cells, options: &Options, max_width: Option<u32>) -> Layout {
    let (row_count, column_count) = (cells.rows.len(), cells.columns);
    if row_count == 0 || column_count == 0 {
        return Layout { column_offsets: vec![0], row_offsets: vec![0], ..Layout::default() };
    }
    let borders = options.borders(row_count, column_count);
    let intrinsic: Vec<Vec<TextMeasure>> =
        cells.rows.iter().map(|row| row.iter().map(|cell| measure_cell(cell, 0)).collect()).collect();
    let columns = column_widths(options, borders, &intrinsic, column_count, max_width);
    let rows = row_heights(cells, options, &columns, &intrinsic);
    let column_offsets = offsets(&columns, borders.outer, borders.inner_vertical, options.gap(borders));
    let row_offsets = offsets(&rows, borders.outer, borders.inner_horizontal, 0);
    let width = (column_offsets.last().copied().unwrap_or(0) + 1).max(0) as u32;
    let height = (row_offsets.last().copied().unwrap_or(0) + 1).max(0) as u32;
    Layout { columns, rows, column_offsets, row_offsets, width, height }
}

fn column_widths(
    options: &Options,
    borders: Borders,
    intrinsic: &[Vec<TextMeasure>],
    column_count: usize,
    max_width: Option<u32>,
) -> Vec<u32> {
    let padding = u64::from(options.padding_x) * 2;
    let mut widths = vec![1 + padding; column_count];
    for row in intrinsic {
        for (width, measure) in widths.iter_mut().zip(row) {
            *width = (*width).max(u64::from(measure.width_max.max(1)) + padding);
        }
    }
    let narrow = |widths: Vec<u64>| widths.into_iter().map(|width| width.min(u64::from(u32::MAX)) as u32).collect();
    let Some(max_width) = max_width.filter(|&width| width > 0) else { return narrow(widths) };
    let inner_borders = if borders.inner_vertical { column_count as u64 - 1 } else { 0 };
    let vertical_borders = u64::from(borders.outer) * 2 + inner_borders;
    let gaps = (column_count as u64 - 1) * u64::from(options.gap(borders));
    let target = u64::from(max_width).saturating_sub(vertical_borders + gaps).max(1);
    let current: u64 = widths.iter().sum();
    let widths = match current.cmp(&target) {
        Ordering::Equal => widths,
        Ordering::Less if options.width_mode == ColumnWidthMode::Full => expand_widths(&widths, target),
        Ordering::Less => widths,
        Ordering::Greater if options.wrap == WrapMode::None => widths,
        Ordering::Greater => match options.fitter {
            ColumnFitter::Proportional => allocate_proportional(&widths, target, 1 + padding),
            ColumnFitter::Balanced => fit_balanced(&widths, target, 1 + padding),
        },
    };
    narrow(widths)
}

/// Shares the spare width evenly, the first columns taking the remainder.
fn expand_widths(widths: &[u64], target: u64) -> Vec<u64> {
    let base: Vec<u64> = widths.iter().map(|&width| width.max(1)).collect();
    let total: u64 = base.iter().sum();
    if total >= target {
        return base;
    }
    let count = base.len() as u64;
    let (shared, remainder) = ((target - total) / count, (target - total) % count);
    base.iter().enumerate().map(|(index, width)| width + shared + u64::from((index as u64) < remainder)).collect()
}

/// Compares the priorities `growth² / capacity` of two columns exactly.
fn compare_priority(left_growth: u64, left_capacity: u64, right_growth: u64, right_capacity: u64) -> Ordering {
    let square = |value: u64| u128::from(value) * u128::from(value);
    let left = square(left_growth).saturating_mul(u128::from(right_capacity));
    let right = square(right_growth).saturating_mul(u128::from(left_capacity));
    left.cmp(&right)
}

/// Core's proportional fitter: every column keeps `min`, and the rest of `target` grows each column by the square
/// root of its extra width, capped at its content width. Exact ties go to the lower column.
fn allocate_proportional(widths: &[u64], target: u64, min: u64) -> Vec<u64> {
    let base: Vec<u64> = widths.iter().map(|&width| width.max(min)).collect();
    let count = base.len();
    let floor = min * count as u64;
    let capacity: Vec<u64> = base.iter().map(|width| width - min).collect();
    let available = target.saturating_sub(floor).min(base.iter().sum::<u64>() - floor);
    if available == 0 {
        return vec![min; count];
    }
    if available == capacity.iter().sum::<u64>() {
        return base;
    }
    if capacity.iter().all(|&width| width > 0 && width == capacity[0]) {
        let (shared, remainder) = (available / count as u64, available % count as u64);
        return (0..count).map(|index| min + shared + u64::from((index as u64) < remainder)).collect();
    }
    let weights: Vec<f64> = capacity.iter().map(|&width| (width as f64).sqrt()).collect();
    let mut active: Vec<usize> = (0..count).filter(|&index| capacity[index] > 0).collect();
    active.sort_by(|&a, &b| weights[a].total_cmp(&weights[b]));
    let mut growth = vec![0u64; count];
    let mut remaining = available as f64;
    let mut total_weight: f64 = active.iter().map(|&index| weights[index]).sum();
    // Water-fill: columns too short for the common level take their whole capacity, shortest first.
    for &index in &active {
        if remaining / total_weight <= weights[index] {
            break;
        }
        growth[index] = capacity[index];
        remaining -= capacity[index] as f64;
        total_weight -= weights[index];
    }
    let level = remaining / total_weight;
    for &index in &active {
        if growth[index] != capacity[index] {
            growth[index] = capacity[index].min((level * weights[index]).floor() as u64);
        }
    }
    // Flooring leaves less than one cell per column to settle by exact priority.
    let mut allocated: u64 = growth.iter().sum();
    while allocated > available {
        let mut worst: Option<usize> = None;
        for index in (0..count).filter(|&index| growth[index] > 0) {
            let higher = worst.is_none_or(|worst| {
                compare_priority(growth[index], capacity[index], growth[worst], capacity[worst]) != Ordering::Less
            });
            if higher {
                worst = Some(index);
            }
        }
        let Some(worst) = worst else { break };
        growth[worst] -= 1;
        allocated -= 1;
    }
    while allocated < available {
        let mut best: Option<usize> = None;
        for index in (0..count).filter(|&index| growth[index] < capacity[index]) {
            let lower = best.is_none_or(|best| {
                compare_priority(growth[index] + 1, capacity[index], growth[best] + 1, capacity[best]) == Ordering::Less
            });
            if lower {
                best = Some(index);
            }
        }
        let Some(best) = best else { break };
        growth[best] += 1;
        allocated += 1;
    }
    growth.iter().map(|growth| growth + min).collect()
}

/// Core's balanced fitter: columns up to an even share keep their width when they all fit, and wider columns shrink
/// by the square root of their excess.
fn fit_balanced(widths: &[u64], target: u64, min: u64) -> Vec<u64> {
    let base: Vec<u64> = widths.iter().map(|&width| width.max(1)).collect();
    let total: u64 = base.iter().sum();
    let count = base.len() as u64;
    if count == 0 || total <= target {
        return base;
    }
    let even = min.max(target / count);
    let preferred: Vec<u64> = base.iter().map(|&width| width.min(even)).collect();
    let floors = if preferred.iter().sum::<u64>() <= target { preferred } else { vec![min; base.len()] };
    let clamped = floors.iter().sum::<u64>().max(target);
    if total <= clamped {
        return base;
    }
    let shrinkable: Vec<u64> = base.iter().zip(&floors).map(|(width, floor)| width.saturating_sub(*floor)).collect();
    if shrinkable.iter().all(|&width| width == 0) {
        return floors;
    }
    let shrink = shrink_by_weight(&shrinkable, total - clamped);
    base.iter()
        .zip(&floors)
        .zip(&shrink)
        .map(|((width, floor), shrink)| width.saturating_sub(*shrink).max(*floor))
        .collect()
}

/// Splits `target` cells of shrinking by the square root of each column's shrinkable width, largest remainders
/// first.
fn shrink_by_weight(shrinkable: &[u64], target: u64) -> Vec<u64> {
    let mut shrink = vec![0u64; shrinkable.len()];
    let weights: Vec<f64> = shrinkable.iter().map(|&width| (width as f64).sqrt()).collect();
    let total_weight: f64 = weights.iter().sum();
    if target == 0 || total_weight <= 0.0 {
        return shrink;
    }
    let mut fractions = vec![0f64; shrinkable.len()];
    let mut used = 0;
    for (index, &weight) in weights.iter().enumerate().filter(|&(_, &weight)| weight > 0.0) {
        let exact = weight / total_weight * target as f64;
        let whole = shrinkable[index].min(exact.floor() as u64);
        shrink[index] = whole;
        fractions[index] = exact - whole as f64;
        used += whole;
    }
    for _ in used..target {
        let mut best: Option<usize> = None;
        for index in (0..shrinkable.len()).filter(|&index| shrink[index] < shrinkable[index]) {
            let better = best.is_none_or(|best| {
                fractions[index] > fractions[best]
                    || fractions[index] == fractions[best] && shrinkable[index] > shrinkable[best]
            });
            if better {
                best = Some(index);
            }
        }
        let Some(best) = best else { break };
        shrink[best] += 1;
        fractions[best] = 0.0;
    }
    shrink
}

fn row_heights(cells: &Cells, options: &Options, columns: &[u32], intrinsic: &[Vec<TextMeasure>]) -> Vec<u32> {
    let (padding_x, padding_y) = (options.padding_x * 2, options.padding_y * 2);
    cells
        .rows
        .iter()
        .zip(intrinsic)
        .map(|(row, measures)| {
            let mut height = 1 + padding_y;
            for ((cell, measure), &column) in row.iter().zip(measures).zip(columns) {
                if cell.is_none() {
                    continue;
                }
                let width = column.saturating_sub(padding_x).max(1);
                let measure = if options.wrap == WrapMode::None || measure.width_max <= width {
                    *measure
                } else {
                    measure_cell(cell, width)
                };
                height = height.max(measure.line_count.max(1) + padding_y);
            }
            height
        })
        .collect()
}

/// How a drag selects cells, decided by where it started and where the pointer is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SelectionMode {
    /// Within one cell: only that cell selects, from the anchor to the focus.
    SingleCell,
    /// Within the anchor's column: only that column selects, the anchor cell whole.
    ColumnLocked,
    /// Across columns: every cell in the rows between the anchor and the focus, the anchor cell whole.
    Grid,
}

pub(crate) struct TextTableInner {
    element: Element,
    cells: RefCell<Cells>,
    options: RefCell<Options>,
    /// The layout of the latest measurement and the width constraint it was made for.
    measured: RefCell<Option<(Option<u32>, Layout)>>,
    /// The layout the cells' viewports follow, and its width constraint.
    layout: RefCell<Option<(Option<u32>, Layout)>>,
    selection: Cell<Option<LocalSelection>>,
    mode: Cell<Option<SelectionMode>>,
}

impl Measure for TextTableInner {
    fn measure(&self, width: Constraint, _height: Constraint) -> (f32, f32) {
        let available = match width {
            Constraint::Exactly(width) | Constraint::AtMost(width) if width.is_finite() => {
                Some(width.floor().max(1.0) as u32)
            }
            _ => None,
        };
        let (Ok(cells), Ok(options)) = (self.cells.try_borrow(), self.options.try_borrow()) else { return (0.0, 0.0) };
        let constraint = options.width_constraint(available);
        let layout = compute_layout(&cells, &options, constraint);
        let mut measured_width = layout.width.max(1);
        if let (Constraint::AtMost(_), Some(available)) = (width, available) {
            measured_width = measured_width.min(available);
        }
        // The full height even under an at-most height, so scrolling parents see all rows.
        let size = (measured_width as f32, layout.height.max(1) as f32);
        if let Ok(mut measured) = self.measured.try_borrow_mut() {
            *measured = Some((constraint, layout));
        }
        size
    }
}

impl TextTableInner {
    fn report<T>(&self, result: crate::Result<T>) -> Option<T> {
        match self.element.app() {
            Some(app) => app.report(result),
            None => result.ok(),
        }
    }

    fn redraw(&self) {
        self.element.app().inspect(App::request_redraw);
    }

    /// Drops the layout and measures the table again.
    fn relayout(&self) {
        *self.layout.borrow_mut() = None;
        *self.measured.borrow_mut() = None;
        self.element.apply(|node| node.mark_dirty());
    }

    /// Lays the cells out for a node width, unless they already are, and sizes their viewports.
    fn ensure_layout(&self, width: f32) {
        let constraint = {
            let options = self.options.borrow();
            options.width_constraint((width >= 1.0).then(|| width.floor() as u32))
        };
        if self.layout.borrow().as_ref().is_some_and(|(current, _)| *current == constraint) {
            return;
        }
        let layout = match self.measured.borrow_mut().take() {
            Some((measured, layout)) if measured == constraint => layout,
            _ => compute_layout(&self.cells.borrow(), &self.options.borrow(), constraint),
        };
        {
            let (cells, options) = (self.cells.borrow(), self.options.borrow());
            let (padding_x, padding_y) = (options.padding_x * 2, options.padding_y * 2);
            for (row, &height) in cells.rows.iter().zip(&layout.rows) {
                for (column, (cell, &width)) in row.iter().zip(&layout.columns).enumerate() {
                    let Some(cell) = cell else { continue };
                    let width = width.saturating_sub(padding_x).max(1);
                    let height = height.saturating_sub(padding_y).max(1);
                    self.report(cell.view.set_viewport(Viewport { x: 0, y: 0, width, height }));
                    self.report(cell.view.set_align(options.alignments.get(column).copied().unwrap_or_default()));
                }
            }
        }
        *self.layout.borrow_mut() = Some((constraint, layout));
        if let Some(selection) = self.selection.get() {
            self.apply_selection(selection, true);
        }
    }

    fn clear_cell_selections(&self) {
        for view in self.cells.borrow().views() {
            self.report(view.clear_selection());
        }
    }

    /// Selects in each cell as Core does: one cell while the pointer stays in it, one column while it stays in the
    /// anchor's column, and otherwise every cell in the rows between the anchor and the focus. The anchor cell is
    /// selected whole once the pointer leaves it.
    fn apply_selection(&self, selection: LocalSelection, start: bool) {
        let layout = self.layout.borrow();
        let Some((_, layout)) = layout.as_ref() else { return };
        let (cells, options) = (self.cells.borrow(), self.options.borrow());
        let (anchor, focus) = (selection.anchor, selection.focus);
        let anchor_cell = layout.cell_at(anchor.0, anchor.1);
        // A click selects nothing; a double or triple click selects a word or line of the cell under it.
        if anchor == focus && (selection.unit == SelectionUnit::Cell || anchor_cell.is_none()) {
            self.clear_cell_selections();
            self.mode.set(None);
            return;
        }
        let anchor_column = anchor_cell.map(|(_, column)| column).or_else(|| layout.column_at(anchor.0));
        let mode = if anchor_cell.is_some() && anchor_cell == layout.cell_at(focus.0, focus.1) {
            SelectionMode::SingleCell
        } else if anchor_column.is_some() && layout.column_at(focus.0) == anchor_column {
            SelectionMode::ColumnLocked
        } else {
            SelectionMode::Grid
        };
        let mode_changed = self.mode.replace(Some(mode)) != Some(mode);
        let rows = layout.row_near(anchor.1.min(focus.1))..=layout.row_near(anchor.1.max(focus.1));
        let (padding_x, padding_y) = (options.padding_x as i32, options.padding_y as i32);
        for (row, cells) in cells.rows.iter().enumerate() {
            for (column, cell) in cells.iter().enumerate() {
                let Some(cell) = cell else { continue };
                let is_anchor = anchor_cell == Some((row, column));
                let skip = !rows.contains(&row)
                    || mode == SelectionMode::ColumnLocked && Some(column) != anchor_column
                    || mode == SelectionMode::SingleCell && !is_anchor;
                if skip {
                    self.report(cell.view.clear_selection());
                    continue;
                }
                let (left, top) = (layout.cell_left(column) + padding_x, layout.cell_top(row) + padding_y);
                let whole = is_anchor && mode != SelectionMode::SingleCell;
                let (from, to) = if whole {
                    let width = layout.columns[column].saturating_sub(options.padding_x * 2).max(1) as i32;
                    let height = layout.rows[row].saturating_sub(options.padding_y * 2).max(1) as i32;
                    ((-1, 0), (width, height))
                } else {
                    ((anchor.0 - left, anchor.1 - top), (focus.0 - left, focus.1 - top))
                };
                let extend = !(start || mode_changed || whole);
                let colors = options.selection_colors;
                self.report(cell.view.select_local(from, to, extend, selection.unit, colors));
            }
        }
    }

    fn has_selection(&self) -> bool {
        self.cells.borrow().views().any(|view| self.report(view.selection()).flatten().is_some())
    }

    /// The selected text of each row's cells, joined by tabs, and the rows joined by line breaks.
    fn selection_text(&self) -> String {
        let cells = self.cells.borrow();
        let rows: Vec<String> = cells
            .rows
            .iter()
            .filter_map(|row| {
                let pieces: Vec<String> = row
                    .iter()
                    .flatten()
                    .filter(|cell| self.report(cell.view.selection()).flatten().is_some())
                    .filter_map(|cell| self.report(cell.view.selected_text()))
                    .filter(|text| !text.is_empty())
                    .collect();
                (!pieces.is_empty()).then(|| pieces.join("\t"))
            })
            .collect();
        rows.join("\n")
    }

    fn create_cell(app: &App, content: Content, options: &Options) -> Option<TableCell> {
        let buffer = app.report(TextBuffer::new(app.session().context(), app.width_method()))?;
        let view = app.report(TextView::new(&buffer))?;
        app.report(buffer.set_defaults(options.text));
        app.report(view.set_wrap(options.wrap));
        app.report(fill(&buffer, &content));
        Some(TableCell { content, buffer, view })
    }

    /// Replaces the cells, keeping the native buffers of cells that still exist.
    fn set_content(&self, rows: Vec<Vec<Content>>) {
        let Some(app) = self.element.app() else { return };
        let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
        let previous = std::mem::take(&mut self.cells.borrow_mut().rows);
        let mut previous = previous.into_iter();
        let mut next = Vec::with_capacity(rows.len());
        {
            let options = self.options.borrow();
            for row in rows {
                let mut old = previous.next().unwrap_or_default().into_iter();
                let mut contents = row.into_iter();
                let cells = (0..columns).map(|_| {
                    let content = contents.next().unwrap_or_default();
                    match old.next().flatten() {
                        Some(cell) if cell.content == content => Some(cell),
                        Some(mut cell) => {
                            app.report(fill(&cell.buffer, &content));
                            cell.content = content;
                            Some(cell)
                        }
                        None => Self::create_cell(&app, content, &options),
                    }
                });
                next.push(cells.collect());
            }
        }
        *self.cells.borrow_mut() = Cells { rows: next, columns };
        self.relayout();
    }

    fn update(&self, change: impl FnOnce(&mut Options)) {
        change(&mut self.options.borrow_mut());
        self.redraw();
    }

    fn update_layout(&self, change: impl FnOnce(&mut Options)) {
        change(&mut self.options.borrow_mut());
        self.relayout();
    }

    fn update_text_style(&self, change: impl FnOnce(&mut Style)) {
        let style = {
            let mut options = self.options.borrow_mut();
            change(&mut options.text);
            options.text
        };
        for cell in self.cells.borrow().rows.iter().flatten().flatten() {
            self.report(cell.buffer.set_defaults(style));
        }
        self.redraw();
    }
}

/// Puts content in a cell's buffer.
fn fill(buffer: &TextBuffer, content: &Content) -> crate::Result<()> {
    if content.is_plain() || content.is_empty() {
        buffer.set_text(&content.plain_text())
    } else {
        buffer.set_spans(&content.0)
    }
}

impl Behavior for TextTableInner {
    fn element(&self) -> &Element {
        &self.element
    }

    fn paint(&self, painter: &mut Painter<'_>) {
        self.ensure_layout(painter.width() as f32);
        let layout = self.layout.borrow();
        let Some((_, layout)) = layout.as_ref() else { return };
        let (cells, options) = (self.cells.borrow(), self.options.borrow());
        if cells.rows.is_empty() || cells.columns == 0 {
            return;
        }
        let borders = options.borders(cells.rows.len(), cells.columns);
        if options.show_borders && (borders.outer || borders.inner_vertical || borders.inner_horizontal) {
            let spec = GridSpec {
                style: options.border_style,
                border_chars: None,
                border_color: options.border_color,
                background: options.border_bg,
                inner: options.border,
                outer: borders.outer,
            };
            painter.grid(&layout.column_offsets, &layout.row_offsets, &spec);
        }
        // Only rows inside the clip, so a long table in a scroll box records what shows.
        let (_, clip_top, _, clip_height) = painter.visible_rect();
        let clip_bottom = clip_top + clip_height as i32;
        for (row, cells) in cells.rows.iter().enumerate() {
            let top = layout.cell_top(row);
            if top >= clip_bottom || top + layout.rows[row] as i32 <= clip_top {
                continue;
            }
            let y = top + options.padding_y as i32;
            for (column, cell) in cells.iter().enumerate() {
                if let Some(cell) = cell {
                    painter.text_view(&cell.view, layout.cell_left(column) + options.padding_x as i32, y);
                }
            }
        }
    }

    fn selectable(&self) -> bool {
        self.options.borrow().selectable
    }

    /// Only a press on a cell starts a selection, not one on a grid line.
    fn starts_selection(&self, x: i32, y: i32) -> bool {
        let rect = self.element.rect();
        self.ensure_layout(rect.width);
        let (left, top) = (rect.screen_x.trunc() as i32, rect.screen_y.trunc() as i32);
        self.layout.borrow().as_ref().is_some_and(|(_, layout)| layout.cell_at(x - left, y - top).is_some())
    }

    fn select(&self, selection: Option<&SelectionUpdate>) -> bool {
        let Some(update) = selection else {
            self.selection.set(None);
            self.mode.set(None);
            self.clear_cell_selections();
            self.redraw();
            return false;
        };
        self.ensure_layout(self.element.rect().width);
        let selection = update.local_selection(&self.element);
        self.selection.set(Some(selection));
        self.apply_selection(selection, update.start);
        self.redraw();
        self.has_selection()
    }

    fn selected_text(&self) -> Option<String> {
        Some(self.selection_text())
    }
}

/// A grid of styled, wrapping text: Markdown tables, reports, and other text laid out in rows and columns.
///
/// Cells take any [`Content`], so spans keep their colors, attributes, and links. Each column starts as wide as
/// its widest cell. With [`ColumnWidthMode::Full`], the default, the columns widen to fill the table's width; when
/// they do not fit, a [`ColumnFitter`] narrows them and the cells wrap. The table sizes itself to its content for
/// the width it gets, so it works inside a [`ScrollBox`](super::ScrollBox). There is no header row; style the
/// first row's cells instead.
///
/// A mouse drag selects text as in Core: within one cell, then down one column, then across whole rows, never the
/// grid lines. A double or triple click selects a word or a line of one cell. In the selected text, the cells of a
/// row are joined with tabs.
///
/// This is not [`Table`](super::Table), which shows one-line rows with keyboard selection and scrolling.
///
/// ```no_run
/// # use opentui::prelude::*;
/// # use opentui::widget::TextTable;
/// # let app = App::new(AppOptions::default())?;
/// let table = TextTable::new(&app).border(BorderStyle::Rounded).set_content([
///     vec!["Service".bold(), "Status".bold()],
///     vec!["api".into(), "OK".fg(Color::GREEN)],
///     vec!["billing".into(), "retrying the payment provider".fg(Color::RED)],
/// ]);
/// app.root().add(&table);
/// # Ok::<(), opentui::Error>(())
/// ```
#[derive(Clone)]
pub struct TextTable(Rc<TextTableInner>);

handle!(TextTable, TextTableInner);

impl TextTable {
    pub fn new(app: &App) -> Self {
        let theme = app.theme();
        let table = Self(build(app, NodeKind::Box, |element| TextTableInner {
            element,
            cells: RefCell::new(Cells::default()),
            options: RefCell::new(Options {
                wrap: WrapMode::Word,
                width_mode: ColumnWidthMode::Full,
                fitter: ColumnFitter::Proportional,
                alignments: Vec::new(),
                padding_x: 0,
                padding_y: 0,
                column_gap: 0,
                border: true,
                outer_border: None,
                show_borders: true,
                border_style: BorderStyle::Single,
                border_color: theme.border,
                border_bg: Color::TRANSPARENT,
                text: Style::new().fg(theme.foreground).bg(Color::TRANSPARENT),
                selectable: true,
                selection_colors: SelectionColors { fg: Some(theme.selection_fg), bg: Some(theme.selection_bg) },
            }),
            measured: RefCell::new(None),
            layout: RefCell::new(None),
            selection: Cell::new(None),
            mode: Cell::new(None),
        }));
        let weak = Rc::downgrade(&table.0);
        let measurer: Weak<dyn Measure> = weak;
        table.0.element.apply(|node| node.set_measure(Some(measurer)));
        // Like Core's table, it keeps its height in a column instead of shrinking and cutting off rows.
        table.0.element.set_layout(LayoutProperty::FlexShrink(0.0));
        table.0.element.add_hooks(Hooks::RENDER_AFTER);
        table
    }

    /// Replaces the cells: an iterator of rows, each an iterator of cells. Shorter rows get empty cells.
    pub fn set_content<R, C>(&self, rows: impl IntoIterator<Item = R>) -> Self
    where
        R: IntoIterator<Item = C>,
        C: Into<Content>,
    {
        let rows = rows.into_iter().map(|row| row.into_iter().map(Into::into).collect()).collect();
        self.0.set_content(rows);
        self.clone()
    }

    /// The cells, row by row.
    pub fn content(&self) -> Vec<Vec<Content>> {
        let cells = self.0.cells.borrow();
        let content = |cell: &Option<TableCell>| cell.as_ref().map(|cell| cell.content.clone()).unwrap_or_default();
        cells.rows.iter().map(|row| row.iter().map(content).collect()).collect()
    }

    pub fn row_count(&self) -> usize {
        self.0.cells.borrow().rows.len()
    }

    /// The length of the longest row.
    pub fn column_count(&self) -> usize {
        self.0.cells.borrow().columns
    }

    /// How cell text wraps. Word wrapping by default. With [`WrapMode::None`], columns never narrow, and a table
    /// wider than its space is cut off.
    pub fn wrap(&self, wrap: WrapMode) -> Self {
        for view in self.0.cells.borrow().views() {
            self.0.report(view.set_wrap(wrap));
        }
        self.0.update_layout(|options| options.wrap = wrap);
        self.clone()
    }

    /// Whether the columns widen to fill the table's width. [`ColumnWidthMode::Full`] by default.
    pub fn column_width_mode(&self, mode: ColumnWidthMode) -> Self {
        self.0.update_layout(|options| options.width_mode = mode);
        self.clone()
    }

    /// How columns narrow when the cells do not fit. [`ColumnFitter::Proportional`] by default.
    pub fn column_fitter(&self, fitter: ColumnFitter) -> Self {
        self.0.update_layout(|options| options.fitter = fitter);
        self.clone()
    }

    /// Each column's alignment of the lines in its cells, by column; columns past the list are left-aligned.
    pub fn column_alignments(&self, alignments: impl IntoIterator<Item = Alignment>) -> Self {
        let alignments = alignments.into_iter().collect();
        self.0.update_layout(|options| options.alignments = alignments);
        self.clone()
    }

    /// Blank cells around each cell's text, on all four sides.
    pub fn cell_padding(&self, padding: u32) -> Self {
        self.0.update_layout(|options| (options.padding_x, options.padding_y) = (padding, padding));
        self.clone()
    }

    /// Blank cells left and right of each cell's text.
    pub fn cell_padding_x(&self, padding: u32) -> Self {
        self.0.update_layout(|options| options.padding_x = padding);
        self.clone()
    }

    /// Blank rows above and below each cell's text.
    pub fn cell_padding_y(&self, padding: u32) -> Self {
        self.0.update_layout(|options| options.padding_y = padding);
        self.clone()
    }

    /// Blank cells between columns when there are no lines between them.
    pub fn column_gap(&self, gap: u32) -> Self {
        self.0.update_layout(|options| options.column_gap = gap);
        self.clone()
    }

    /// Turns on the lines between the cells and draws them in `style`, [`BorderStyle::Single`] by default. The outer
    /// border follows unless set with [`Self::outer_border`].
    pub fn border(&self, style: BorderStyle) -> Self {
        self.0.update_layout(|options| (options.border, options.border_style) = (true, style));
        self.clone()
    }

    /// Whether lines separate the cells. On by default. The outer border follows unless set with
    /// [`Self::outer_border`].
    pub fn grid_lines(&self, lines: bool) -> Self {
        self.0.update_layout(|options| options.border = lines);
        self.clone()
    }

    /// Whether a border surrounds the table, or `None` to follow [`Self::grid_lines`].
    pub fn outer_border(&self, outer: impl Into<Option<bool>>) -> Self {
        let outer = outer.into();
        self.0.update_layout(|options| options.outer_border = outer);
        self.clone()
    }

    /// Whether border lines are drawn. Hidden borders still take their space. On by default.
    pub fn show_borders(&self, show: bool) -> Self {
        self.0.update(|options| options.show_borders = show);
        self.clone()
    }

    /// The color of border lines; the theme's border color by default.
    pub fn border_color(&self, color: Color) -> Self {
        self.0.update(|options| options.border_color = color);
        self.clone()
    }

    /// The background behind border lines. Transparent by default.
    pub fn border_bg(&self, color: Color) -> Self {
        self.0.update(|options| options.border_bg = color);
        self.clone()
    }

    /// Fills the table's area with a background color.
    pub fn bg(&self, color: Color) -> Self {
        self.0.element.update_paint(|paint| {
            paint.fill = true;
            paint.background = color;
        });
        self.clone()
    }

    /// The color of text without a span color.
    pub fn fg(&self, color: Color) -> Self {
        self.0.update_text_style(|style| style.fg = Some(color));
        self.clone()
    }

    /// The background of text without a span background. Transparent by default.
    pub fn text_bg(&self, color: Color) -> Self {
        self.0.update_text_style(|style| style.bg = Some(color));
        self.clone()
    }

    /// Attributes of all cell text, added to the spans' own.
    pub fn attributes(&self, attributes: Attributes) -> Self {
        self.0.update_text_style(|style| style.attributes = attributes);
        self.clone()
    }

    /// Whether the mouse can select the cells' text. On by default. See [`App::selected_text`].
    pub fn selectable(&self, selectable: bool) -> Self {
        self.0.options.borrow_mut().selectable = selectable;
        self.clone()
    }

    pub fn selection_colors(&self, colors: SelectionColors) -> Self {
        self.0.options.borrow_mut().selection_colors = colors;
        self.clone()
    }

    /// This table's part of the mouse selection: each row's selected cell text joined by tabs, and the rows joined
    /// by line breaks. Empty without a selection.
    pub fn selected_text(&self) -> String {
        self.0.selection_text()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proportional_widths_follow_square_root_priority() {
        assert_eq!(allocate_proportional(&[91, 9], 37, 1), [28, 9]);
        assert_eq!(allocate_proportional(&[91, 9], 38, 1), [29, 9]);
        assert_eq!(allocate_proportional(&[1000, 100], 401, 1), [305, 96]);
        assert_eq!(allocate_proportional(&[1000, 100], 402, 1), [305, 97]);
        assert_eq!(allocate_proportional(&[4, 49, 4, 54, 38], 104, 1), [4, 33, 4, 34, 29]);
        assert_eq!(allocate_proportional(&[2_516_760, 2_528_584], 58_886, 1), [29_408, 29_478]);
        // Exact ties go to the lower column.
        assert_eq!(allocate_proportional(&[7, 7, 7], 10, 3), [4, 3, 3]);
        assert_eq!(allocate_proportional(&[7, 7, 7], 17, 3), [6, 6, 5]);
        assert_eq!(allocate_proportional(&[19, 3], 5, 1), [4, 1]);
        assert_eq!(allocate_proportional(&[4_000_000_001, 1_000_000_001], 300_001, 1), [200_001, 100_000]);
        // Targets clamp to the minimums and the content widths.
        assert_eq!(allocate_proportional(&[4, 49, 4, 54, 38], 3, 1), [1, 1, 1, 1, 1]);
        assert_eq!(allocate_proportional(&[4, 49, 4, 54, 38], 200, 1), [4, 49, 4, 54, 38]);
        assert_eq!(allocate_proportional(&[2, 8, 20], 14, 3), [3, 5, 6]);
    }

    #[test]
    fn proportional_widths_grow_one_cell_at_a_time() {
        // Core's deterministic vectors: each extra cell of target width goes to exactly one column, the one with
        // the lowest next priority.
        let mut seed: u32 = 0x1259;
        let mut next = || {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            seed
        };
        for vector in 0..40 {
            let min = u64::from(1 + next() % 4);
            let widths: Vec<u64> = (0..1 + vector % 8).map(|_| min + u64::from(next() % 80)).collect();
            let capacity: Vec<u64> = widths.iter().map(|width| width - min).collect();
            let mut expected = vec![0u64; widths.len()];
            let mut previous = allocate_proportional(&widths, min * widths.len() as u64, min);
            for target in min * widths.len() as u64 + 1..=widths.iter().sum() {
                let best = (0..widths.len())
                    .filter(|&index| expected[index] < capacity[index])
                    .reduce(|best, index| {
                        let ordering =
                            compare_priority(expected[index] + 1, capacity[index], expected[best] + 1, capacity[best]);
                        if ordering == Ordering::Less { index } else { best }
                    })
                    .unwrap();
                expected[best] += 1;
                let widths_now = allocate_proportional(&widths, target, min);
                assert_eq!(widths_now, expected.iter().map(|growth| growth + min).collect::<Vec<_>>());
                assert_eq!(widths_now.iter().sum::<u64>(), target);
                let grown = widths_now.iter().zip(&previous).filter(|(now, before)| now > before).count();
                assert_eq!(grown, 1);
                previous = widths_now;
            }
        }
    }

    #[test]
    fn balanced_widths_keep_narrow_columns() {
        // Core's six-column example at 58 cells: the narrow first column keeps more of its width.
        let widths = [19, 81, 59, 59, 38, 57];
        let proportional = allocate_proportional(&widths, 51, 1);
        let balanced = fit_balanced(&widths, 51, 1);
        assert_eq!(proportional.iter().sum::<u64>(), 51);
        assert_eq!(balanced.iter().sum::<u64>(), 51);
        assert!(balanced[0] > proportional[0]);
        assert_eq!(fit_balanced(&[3, 4], 10, 1), [3, 4]);
    }

    #[test]
    fn offsets_place_grid_lines_and_gaps() {
        assert_eq!(offsets(&[3, 2], true, true, 0), [0, 4, 7]);
        // Without an outer border the edges lie one cell outside.
        assert_eq!(offsets(&[3, 2], false, true, 0), [-1, 3, 5]);
        assert_eq!(offsets(&[3, 2], false, false, 2), [-1, 4, 6]);
    }
}
