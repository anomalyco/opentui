//! Line numbers beside a text widget, ported from Core's `LineNumberRenderable`.

use super::{AnyWidget, Behavior, Element, Painter, Widget, build, handle};
use crate::app::{App, Cx};
use crate::input::MouseEvent;
use crate::layout::{FlexDirection, LayoutProperty, Length};
use crate::native::{Hooks, NodeKind, WidthMethod};
use crate::style::{Color, Style};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::{Rc, Weak};

/// Text drawn in the gutter beside one line's number, such as a diff's `+` or a breakpoint marker.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LineSign {
    /// Drawn left of the number, right-aligned with the other lines' signs.
    pub before: String,
    pub before_color: Option<Color>,
    /// Drawn right of the number.
    pub after: String,
    pub after_color: Option<Color>,
}

impl LineSign {
    /// A sign left of the number. `None` uses the gutter's color.
    pub fn before(text: impl Into<String>, color: impl Into<Option<Color>>) -> Self {
        Self { before: text.into(), before_color: color.into(), ..Self::default() }
    }

    /// A sign right of the number. `None` uses the gutter's color.
    pub fn after(text: impl Into<String>, color: impl Into<Option<Color>>) -> Self {
        Self { after: text.into(), after_color: color.into(), ..Self::default() }
    }
}

/// Background colors for one line: in the gutter, and behind the line's text.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LineColor {
    pub gutter: Option<Color>,
    pub content: Option<Color>,
}

impl LineColor {
    pub fn new(gutter: impl Into<Option<Color>>, content: impl Into<Option<Color>>) -> Self {
        Self { gutter: gutter.into(), content: content.into() }
    }
}

/// One color for the gutter, and the same color 20% darker behind the text, as Core does.
impl From<Color> for LineColor {
    fn from(color: Color) -> Self {
        Self { gutter: Some(color), content: Some(color.darken(0.2)) }
    }
}

pub(crate) struct GutterState {
    pub fg: Color,
    pub bg: Color,
    pub min_width: u32,
    pub padding_left: u32,
    pub padding_right: u32,
    /// Room for at least this many digits, and at least this many cells of after signs.
    pub min_digits: u32,
    pub min_after_width: u32,
    pub offset: i64,
    pub show: bool,
    pub hidden: HashSet<u32>,
    pub numbers: HashMap<u32, u64>,
    pub colors: HashMap<u32, LineColor>,
    pub signs: HashMap<u32, Rc<LineSign>>,
    /// The widest before and after signs, in cells.
    pub sign_widths: (u32, u32),
}

impl GutterState {
    pub fn new(fg: Color) -> Self {
        Self {
            fg,
            bg: Color::TRANSPARENT,
            min_width: 3,
            padding_left: 1,
            padding_right: 1,
            min_digits: 0,
            min_after_width: 0,
            offset: 0,
            show: true,
            hidden: HashSet::new(),
            numbers: HashMap::new(),
            colors: HashMap::new(),
            signs: HashMap::new(),
            sign_widths: (0, 0),
        }
    }

    /// Room for the widest number, its padding, and the signs.
    fn width(&self, line_count: u32) -> u32 {
        if !self.show {
            return 0;
        }
        let highest = (i64::from(line_count) + self.offset).max(0) as u64;
        let highest = self.numbers.values().copied().fold(highest, u64::max);
        let digits = if highest > 0 { highest.ilog10() + 1 } else { 1 };
        self.min_width.max(digits.max(self.min_digits) + self.padding_left + self.padding_right)
            + self.sign_widths.0
            + self.sign_widths.1
    }
}

/// The gutter: paints the numbers of the lines its target shows, and sizes itself to the widest.
pub(crate) struct GutterInner {
    pub element: Element,
    pub target: RefCell<Weak<dyn Behavior>>,
    pub state: RefCell<GutterState>,
    width: Cell<u32>,
    sign_method: Cell<Option<WidthMethod>>,
}

impl GutterInner {
    pub fn build(app: &App, fg: Color) -> Rc<Self> {
        let gutter = build(app, NodeKind::Box, |element| Self {
            element,
            target: RefCell::new(Weak::<GutterInner>::new()),
            state: RefCell::new(GutterState::new(fg)),
            width: Cell::new(u32::MAX),
            sign_method: Cell::new(None),
        });
        gutter.element.add_hooks(Hooks::UPDATE.union(Hooks::RENDER_AFTER));
        gutter.element.set_layout(LayoutProperty::FlexShrink(0.0));
        gutter
    }

    /// Resizes the gutter for the target's line count and the width method. Runs before every frame's layout.
    pub fn refresh(&self) {
        if self.element.app().map(|app| app.width_method()) != self.sign_method.get() {
            return self.measure_signs();
        }
        let lines = self.target.borrow().upgrade().and_then(|target| target.visible_lines());
        let width = self.state.borrow().width(lines.map_or(1, |lines| lines.line_count.max(1)));
        if self.width.replace(width) != width {
            self.element.set_layout(LayoutProperty::FixedWidth(Length::Cells(width as f32)));
        }
    }

    /// Recomputes the sign widths after the signs changed.
    pub fn measure_signs(&self) {
        let Some(app) = self.element.app() else { return };
        let (context, method) = (app.session().context().clone(), app.width_method());
        let measure = |text: &str| context.text_width(text, method).unwrap_or(0);
        let mut state = self.state.borrow_mut();
        let widths = state.signs.values().fold((0, state.min_after_width), |(before, after), sign| {
            (before.max(measure(&sign.before)), after.max(measure(&sign.after)))
        });
        state.sign_widths = widths;
        drop(state);
        self.sign_method.set(Some(method));
        self.changed();
    }

    pub fn changed(&self) {
        self.width.set(u32::MAX);
        self.refresh();
        self.element.app().inspect(App::request_redraw);
    }
}

impl Behavior for GutterInner {
    fn element(&self) -> &Element {
        &self.element
    }

    fn update(&self, _cx: &mut Cx<'_>) {
        self.refresh();
    }

    fn paint(&self, painter: &mut Painter<'_>) {
        let state = self.state.borrow();
        let Some(lines) = self.target.borrow().upgrade().and_then(|target| target.visible_lines()) else { return };
        let (width, height) = painter.size();
        if !state.show || width == 0 {
            return;
        }
        if state.bg.a > 0 {
            painter.fill(0, 0, width, height, state.bg);
        }
        let (before_width, after_width) = state.sign_widths;
        for (row, line) in lines.rows.iter().take(height as usize).enumerate() {
            let y = row as i32;
            let source = line.source_line;
            let bg = state.colors.get(&source).and_then(|color| color.gutter).unwrap_or(state.bg);
            if bg != state.bg {
                painter.fill(0, y, width, 1, bg);
            }
            // The row holds its color now. The text blends its own color into the cell, as in Core's gutter buffer;
            // passing the line color again would blend an alpha line color twice.
            // Only a line's first row is numbered.
            if line.wrap_index > 0 {
                continue;
            }
            let sign = state.signs.get(&source);
            if let Some(sign) = sign.filter(|sign| !sign.before.is_empty()) {
                let x = before_width.saturating_sub(painter.text_width(&sign.before)) as i32;
                painter.text(
                    x,
                    y,
                    &sign.before,
                    Style::new().fg(sign.before_color.unwrap_or(state.fg)).bg(Color::TRANSPARENT),
                );
            }
            if !state.hidden.contains(&source) {
                let number = match state.numbers.get(&source) {
                    Some(&number) => number.to_string(),
                    None => (i64::from(source) + 1 + state.offset).to_string(),
                };
                // Right-aligned before the padding, keeping the left padding after the before signs.
                let room = i64::from(width) - i64::from(before_width + after_width + state.padding_right);
                let x = i64::from(before_width) + room - number.len() as i64;
                if x >= i64::from(before_width + state.padding_left) {
                    painter.text(x as i32, y, &number, Style::new().fg(state.fg).bg(Color::TRANSPARENT));
                }
            }
            if let Some(sign) = sign.filter(|sign| !sign.after.is_empty()) {
                let x = width.saturating_sub(state.padding_right + after_width) as i32;
                painter.text(
                    x,
                    y,
                    &sign.after,
                    Style::new().fg(sign.after_color.unwrap_or(state.fg)).bg(Color::TRANSPARENT),
                );
            }
        }
    }
}

pub(crate) struct LineNumbersInner {
    element: Element,
    gutter: Rc<GutterInner>,
    target: AnyWidget,
}

impl Behavior for LineNumbersInner {
    fn element(&self) -> &Element {
        &self.element
    }

    /// The wheel over the gutter scrolls the target.
    fn mouse(&self, cx: &mut Cx<'_>, event: &MouseEvent) -> bool {
        use crate::input::MouseEventKind as Kind;
        matches!(event.kind, Kind::ScrollUp | Kind::ScrollDown | Kind::ScrollLeft | Kind::ScrollRight)
            && self.target.0.mouse(cx, event)
    }

    /// Fills lines' content colors behind the target, before it draws its text.
    fn paint(&self, painter: &mut Painter<'_>) {
        let state = self.gutter.state.borrow();
        if state.colors.values().all(|color| color.content.is_none()) {
            return;
        }
        let Some(lines) = self.target.0.visible_lines() else { return };
        let (rect, target) = (self.element.rect(), self.target.rect());
        let left = self.gutter.element.rect().width.max(0.0) as u32;
        let top = (target.screen_y - rect.screen_y).round() as i32;
        let width = painter.width().saturating_sub(left);
        for (row, line) in lines.rows.iter().enumerate() {
            if let Some(color) = state.colors.get(&line.source_line).and_then(|color| color.content) {
                painter.fill(left as i32, top + row as i32, width, 1, color);
            }
        }
    }
}

/// Line numbers beside a [`Code`](super::Code) view or a [`Textarea`](super::Textarea), with per-line signs,
/// colors, and custom numbers, as Core's `LineNumberRenderable`.
///
/// The numbers follow the target's scrolling and wrapping: only the first row of a wrapped line is numbered. The
/// gutter sizes itself to the widest number.
///
/// ```no_run
/// # use opentui::prelude::*;
/// # use opentui::widget::{LineColor, LineNumbers, LineSign};
/// # let app = App::new(AppOptions::default())?;
/// let editor = Textarea::new(&app).grow(1.0);
/// let numbered = LineNumbers::new(&app, &editor).grow(1.0);
/// numbered.line_sign(2, LineSign::before("●", Color::RED)).line_color(2, Color::hex(0x3a1d1d));
/// app.root().add(&numbered);
/// # Ok::<(), opentui::Error>(())
/// ```
#[derive(Clone)]
pub struct LineNumbers(Rc<LineNumbersInner>);

handle!(LineNumbers, LineNumbersInner);

impl LineNumbers {
    /// Numbers the lines of `target`, which moves into the new widget. Detach `target` from any parent first.
    pub fn new(app: &App, target: &impl Widget) -> Self {
        let gutter = GutterInner::build(app, app.theme().muted);
        *gutter.target.borrow_mut() = Rc::downgrade(&target.as_any().0);
        let numbers =
            Self(build(app, NodeKind::Box, |element| LineNumbersInner { element, gutter, target: target.as_any() }));
        let element = &numbers.0.element;
        element.set_layout(LayoutProperty::FlexDirection(FlexDirection::Row));
        element.insert(&numbers.0.gutter.element, None);
        element.insert(target.element(), None);
        element.add_hooks(Hooks::RENDER_BEFORE);
        numbers.0.gutter.refresh();
        numbers
    }

    /// The numbered widget.
    pub fn target(&self) -> AnyWidget {
        self.0.target.clone()
    }

    fn update(&self, change: impl FnOnce(&mut GutterState)) -> Self {
        change(&mut self.0.gutter.state.borrow_mut());
        self.0.gutter.changed();
        self.clone()
    }

    /// Number and sign color; the theme's muted color by default.
    pub fn fg(&self, color: Color) -> Self {
        self.update(|state| state.fg = color)
    }

    /// Gutter background; transparent by default.
    pub fn bg(&self, color: Color) -> Self {
        self.update(|state| state.bg = color)
    }

    /// The narrowest gutter, in cells, before signs; 3 by default.
    pub fn gutter_min_width(&self, cells: u32) -> Self {
        self.update(|state| state.min_width = cells)
    }

    /// Cells between the number and the text; 1 by default.
    pub fn gutter_padding(&self, cells: u32) -> Self {
        self.update(|state| state.padding_right = cells)
    }

    /// Added to every computed line number, for showing part of a larger file.
    pub fn offset(&self, offset: i64) -> Self {
        self.update(|state| state.offset = offset)
    }

    /// Shows or hides the gutter; shown by default. Content colors stay.
    pub fn show_line_numbers(&self, show: bool) -> Self {
        self.update(|state| state.show = show)
    }

    /// Hides one line's number, keeping its sign and colors.
    pub fn hide_line_number(&self, line: u32, hidden: bool) -> Self {
        self.update(|state| {
            if hidden {
                state.hidden.insert(line);
            } else {
                state.hidden.remove(&line);
            }
        })
    }

    /// Shows `number` for zero-based `line` instead of its position, or the position again with `None`.
    pub fn line_number(&self, line: u32, number: impl Into<Option<u64>>) -> Self {
        let number = number.into();
        self.update(|state| match number {
            Some(number) => {
                state.numbers.insert(line, number);
            }
            None => {
                state.numbers.remove(&line);
            }
        })
    }

    /// Colors zero-based `line`: a [`Color`] colors the gutter and, 20% darker, the text background.
    pub fn line_color(&self, line: u32, color: impl Into<LineColor>) -> Self {
        let color = color.into();
        self.update(|state| {
            state.colors.insert(line, color);
        })
    }

    pub fn clear_line_color(&self, line: u32) -> Self {
        self.update(|state| {
            state.colors.remove(&line);
        })
    }

    pub fn clear_line_colors(&self) -> Self {
        self.update(|state| state.colors.clear())
    }

    /// Sizes the gutter as Core's `setGutterLayout` does.
    pub(crate) fn gutter_layout(&self, min_width: u32, padding_left: u32, min_digits: u32, min_after_width: u32) {
        {
            let mut state = self.0.gutter.state.borrow_mut();
            (state.min_width, state.padding_left, state.min_digits, state.min_after_width) =
                (min_width, padding_left, min_digits, min_after_width);
        }
        self.0.gutter.measure_signs();
    }

    /// Replaces every line's colors, signs, custom numbers, and hidden numbers at once.
    pub(crate) fn replace_lines(
        &self,
        colors: HashMap<u32, LineColor>,
        signs: HashMap<u32, Rc<LineSign>>,
        numbers: HashMap<u32, u64>,
        hidden: HashSet<u32>,
    ) {
        {
            let mut state = self.0.gutter.state.borrow_mut();
            (state.colors, state.signs, state.numbers, state.hidden) = (colors, signs, numbers, hidden);
        }
        self.0.gutter.measure_signs();
    }

    /// Sets zero-based `line`'s sign.
    pub fn line_sign(&self, line: u32, sign: LineSign) -> Self {
        self.0.gutter.state.borrow_mut().signs.insert(line, Rc::new(sign));
        self.0.gutter.measure_signs();
        self.clone()
    }

    pub fn clear_line_sign(&self, line: u32) -> Self {
        self.0.gutter.state.borrow_mut().signs.remove(&line);
        self.0.gutter.measure_signs();
        self.clone()
    }

    pub fn clear_line_signs(&self) -> Self {
        self.0.gutter.state.borrow_mut().signs.clear();
        self.0.gutter.measure_signs();
        self.clone()
    }
}
