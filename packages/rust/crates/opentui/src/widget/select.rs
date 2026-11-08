use super::{Behavior, Callbacks, Element, Painter, build, handle, keymap_methods};
use crate::app::{App, Cx};
use crate::input::{KeyEvent, Keymap, MouseButton, MouseEvent, MouseEventKind};
use crate::native::{Hooks, NodeKind};
use crate::style::{Color, Style};
use std::cell::{Cell, RefCell};
use std::rc::Rc;

/// One choice in a [`Select`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SelectOption {
    pub name: String,
    /// A second, dimmer line under the name, shown unless the select hides descriptions.
    pub description: String,
}

impl SelectOption {
    pub fn new(name: impl Into<String>, description: impl Into<String>) -> Self {
        Self { name: name.into(), description: description.into() }
    }
}

impl From<&str> for SelectOption {
    fn from(name: &str) -> Self {
        Self::new(name, "")
    }
}

impl From<String> for SelectOption {
    fn from(name: String) -> Self {
        Self::new(name, "")
    }
}

impl<N: Into<String>, D: Into<String>> From<(N, D)> for SelectOption {
    fn from((name, description): (N, D)) -> Self {
        Self::new(name, description)
    }
}

/// What a key does in a [`Select`]. Bind keys to actions with [`Select::bind`], or run one with
/// [`Select::perform`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SelectAction {
    /// One option up, wrapping around when [`Select::wrap_selection`] allows it.
    MoveUp,
    MoveDown,
    /// Five options up, wrapping like [`Self::MoveUp`].
    MoveUpFast,
    MoveDownFast,
    /// One screen of options up, stopping at the first.
    PageUp,
    PageDown,
    First,
    Last,
    /// Calls [`Select::on_select`] with the selected option.
    SelectCurrent,
}

struct State {
    options: Vec<SelectOption>,
    selected: usize,
    show_description: bool,
    show_indicator: bool,
    show_scroll_indicator: bool,
    wrap: bool,
    spacing: u32,
    fast_step: usize,
    fg: Color,
    bg: Color,
    focused_fg: Color,
    focused_bg: Color,
    selected_fg: Color,
    selected_bg: Color,
    description: Color,
    selected_description: Color,
}

impl State {
    fn lines_per_item(&self) -> u32 {
        1 + u32::from(self.show_description) + self.spacing
    }
}

pub(crate) struct SelectInner {
    element: Element,
    state: RefCell<State>,
    focused: Cell<bool>,
    /// The first visible option, rows per option, and visible options, as last painted, for mapping clicks.
    painted: Cell<(usize, u32, usize)>,
    on_change: Callbacks<(usize, SelectOption)>,
    on_select: Callbacks<(usize, SelectOption)>,
    keymap: RefCell<Keymap<SelectAction>>,
}

impl SelectInner {
    fn changed(&self, cx: &mut Cx<'_>) {
        self.element.app().inspect(App::request_redraw);
        let event = {
            let state = self.state.borrow();
            state.options.get(state.selected).map(|option| (state.selected, option.clone()))
        };
        if let Some(event) = event {
            self.on_change.emit(cx, &event);
        }
    }

    /// Moves the selection by `steps`, clamping at the ends, or wrapping when both `wrap` and the select allow it.
    /// Returns whether it moved.
    fn step(&self, steps: isize, wrap: bool) -> bool {
        let mut state = self.state.borrow_mut();
        let count = state.options.len();
        if count == 0 {
            return false;
        }
        let target = (state.selected as isize).saturating_add(steps);
        let next = if (0..count as isize).contains(&target) {
            target as usize
        } else if wrap && state.wrap {
            if target < 0 { count - 1 } else { 0 }
        } else {
            target.clamp(0, count as isize - 1) as usize
        };
        let moved = next != state.selected;
        state.selected = next;
        moved
    }

    fn run(&self, cx: &mut Cx<'_>, action: SelectAction) {
        let (fast, page) = {
            let state = self.state.borrow();
            let rows = self.element.rect().height.max(1.0) as u32;
            (isize::try_from(state.fast_step).unwrap_or(isize::MAX), (rows / state.lines_per_item()).max(1) as isize)
        };
        // Only single and fast steps wrap; paging and Home/End stop at the ends.
        let (steps, wrap) = match action {
            SelectAction::MoveUp => (-1, true),
            SelectAction::MoveDown => (1, true),
            SelectAction::MoveUpFast => (-fast, true),
            SelectAction::MoveDownFast => (fast, true),
            SelectAction::PageUp => (-page, false),
            SelectAction::PageDown => (page, false),
            SelectAction::First => (isize::MIN / 2, false),
            SelectAction::Last => (isize::MAX / 2, false),
            SelectAction::SelectCurrent => return self.activate(cx),
        };
        if self.step(steps, wrap) {
            self.changed(cx);
        }
    }

    fn activate(&self, cx: &mut Cx<'_>) {
        let event = {
            let state = self.state.borrow();
            state.options.get(state.selected).map(|option| (state.selected, option.clone()))
        };
        if let Some(event) = event {
            self.on_select.emit(cx, &event);
        }
    }
}

impl Behavior for SelectInner {
    fn element(&self) -> &Element {
        &self.element
    }

    fn key(&self, cx: &mut Cx<'_>, key: &KeyEvent) -> bool {
        let action = self.keymap.borrow().get(key);
        action.inspect(|&action| self.run(cx, action)).is_some()
    }

    fn mouse(&self, cx: &mut Cx<'_>, event: &MouseEvent) -> bool {
        match event.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                let rect = self.element.rect();
                let row = (f64::from(event.y) - rect.screen_y.floor()).max(0.0) as u32;
                let (offset, lines, visible) = self.painted.get();
                let slot = (row / lines.max(1)) as usize;
                // Leftover rows below the last whole option belong to no option.
                if slot >= visible {
                    return false;
                }
                let index = offset + slot;
                let (current, count) = {
                    let state = self.state.borrow();
                    (state.selected, state.options.len())
                };
                if index >= count {
                    return false;
                }
                if index == current {
                    self.activate(cx);
                } else {
                    self.state.borrow_mut().selected = index;
                    self.changed(cx);
                }
                false
            }
            MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
                if self.step(if event.kind == MouseEventKind::ScrollUp { -1 } else { 1 }, false) {
                    self.changed(cx);
                }
                true
            }
            _ => false,
        }
    }

    fn focus_changed(&self, _cx: &mut Cx<'_>, focused: bool) {
        self.focused.set(focused);
        self.element.app().inspect(App::request_redraw);
    }

    fn teardown(&self) {
        self.on_change.clear();
        self.on_select.clear();
    }

    fn paint(&self, painter: &mut Painter<'_>) {
        let state = self.state.borrow();
        let (width, height) = painter.size();
        let focused = self.focused.get();
        let background = if focused { state.focused_bg } else { state.bg };
        if background.a > 0 {
            painter.fill(0, 0, width, height, background);
        }
        let lines = state.lines_per_item();
        let visible = (height / lines).max(1) as usize;
        let count = state.options.len();
        let offset = state.selected.saturating_sub(visible / 2).min(count.saturating_sub(visible));
        self.painted.set((offset, lines, visible.min(count.saturating_sub(offset))));
        let base = if focused { state.focused_fg } else { state.fg };
        let indicator_width = if state.show_indicator { 2 } else { 0 };
        for (row, (index, option)) in state.options.iter().enumerate().skip(offset).take(visible).enumerate() {
            let y = (row as u32 * lines) as i32;
            if y as u32 + lines > height && row > 0 {
                break;
            }
            let selected = index == state.selected;
            if selected {
                painter.fill(0, y, width, lines - state.spacing, state.selected_bg);
            }
            let color = if selected { state.selected_fg } else { base };
            let indicator = match (state.show_indicator, selected) {
                (false, _) => "",
                (true, true) => "▶ ",
                (true, false) => "  ",
            };
            painter.text(1, y, &format!("{indicator}{}", option.name), Style::new().fg(color));
            if state.show_description && (y as u32 + 1) < height {
                let color = if selected { state.selected_description } else { state.description };
                painter.text(1 + indicator_width, y + 1, &option.description, Style::new().fg(color));
            }
        }
        if state.show_scroll_indicator && count > visible {
            let span = height.saturating_sub(2).max(1);
            let y = 1 + (offset as f64 / (count - visible) as f64 * f64::from(span)).floor() as i32;
            painter.text(width as i32 - 1, y.min(height as i32 - 1), "█", Style::new().fg(state.description));
        }
    }
}

/// A vertical list of options with a highlighted selection.
///
/// Up/Down or j/k move, Shift+Up/Down move five, Page Up/Down and Home/End jump, and Enter calls
/// [`Self::on_select`]; [`Self::bind`] changes the keys. Clicking an option selects it; clicking the selected option
/// activates it. Give the list a height or a grow factor: it does not size itself to its options.
///
/// ```no_run
/// # use opentui::prelude::*;
/// # let app = App::new(AppOptions::default())?;
/// let menu = Select::new(&app)
///     .options([("New", "Create a file"), ("Open", "Open a file"), ("Quit", "Leave the app")])
///     .height(6);
/// menu.on_select(|cx, index, _option| {
///     if index == 2 {
///         cx.quit();
///     }
/// });
/// # Ok::<(), opentui::Error>(())
/// ```
#[derive(Clone)]
pub struct Select(Rc<SelectInner>);

handle!(Select, SelectInner);

impl Select {
    pub fn new(app: &App) -> Self {
        let theme = app.theme();
        let select = Self(build(app, NodeKind::Box, |element| SelectInner {
            element,
            state: RefCell::new(State {
                options: Vec::new(),
                selected: 0,
                show_description: true,
                show_indicator: true,
                show_scroll_indicator: false,
                wrap: false,
                spacing: 0,
                fast_step: 5,
                fg: theme.foreground,
                bg: Color::TRANSPARENT,
                focused_fg: theme.foreground,
                focused_bg: Color::TRANSPARENT,
                selected_fg: theme.highlight_fg,
                selected_bg: theme.highlight_bg,
                description: theme.muted,
                selected_description: theme.foreground,
            }),
            focused: Cell::new(false),
            painted: Cell::new((0, 1, 1)),
            on_change: Callbacks::default(),
            on_select: Callbacks::default(),
            keymap: RefCell::new(Self::default_keymap()),
        }));
        select.0.element.set_focusable(true);
        select.0.element.add_hooks(Hooks::RENDER_AFTER);
        select
    }

    /// The key bindings a new select starts with: Core's, plus Page Up/Down and Home/End.
    pub fn default_keymap() -> Keymap<SelectAction> {
        use SelectAction as A;
        Keymap::new()
            .bind("up", A::MoveUp)
            .bind("k", A::MoveUp)
            .bind("down", A::MoveDown)
            .bind("j", A::MoveDown)
            .bind("shift+up", A::MoveUpFast)
            .bind("shift+down", A::MoveDownFast)
            .bind("pageup", A::PageUp)
            .bind("pagedown", A::PageDown)
            .bind("home", A::First)
            .bind("end", A::Last)
            .bind("enter", A::SelectCurrent)
            .bind("linefeed", A::SelectCurrent)
    }

    keymap_methods!(SelectAction);

    /// Runs an action as its key would, including change and select handlers.
    pub fn perform(&self, action: SelectAction) -> Self {
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

    /// Replaces the options. Keeps the selected index when it still exists.
    pub fn options<O: Into<SelectOption>>(&self, options: impl IntoIterator<Item = O>) -> Self {
        let options: Vec<SelectOption> = options.into_iter().map(Into::into).collect();
        self.update(|state| {
            state.selected = state.selected.min(options.len().saturating_sub(1));
            state.options = options;
        })
    }

    pub fn option_count(&self) -> usize {
        self.0.state.borrow().options.len()
    }

    pub fn option(&self, index: usize) -> Option<SelectOption> {
        self.0.state.borrow().options.get(index).cloned()
    }

    /// The selected index. Zero for an empty list.
    pub fn selected(&self) -> usize {
        self.0.state.borrow().selected
    }

    pub fn selected_option(&self) -> Option<SelectOption> {
        let state = self.0.state.borrow();
        state.options.get(state.selected).cloned()
    }

    /// Selects an index. Out-of-range indexes are ignored. Does not call change handlers.
    pub fn select(&self, index: usize) -> Self {
        self.update(|state| {
            if index < state.options.len() {
                state.selected = index;
            }
        })
    }

    /// Shows each option's description on a second line. On by default.
    pub fn show_description(&self, show: bool) -> Self {
        self.update(|state| state.show_description = show)
    }

    /// Marks the selected option with `▶`. On by default.
    pub fn show_indicator(&self, show: bool) -> Self {
        self.update(|state| state.show_indicator = show)
    }

    /// Shows a scroll position marker on the right edge when options overflow.
    pub fn show_scroll_indicator(&self, show: bool) -> Self {
        self.update(|state| state.show_scroll_indicator = show)
    }

    /// Moving past either end wraps around.
    pub fn wrap_selection(&self, wrap: bool) -> Self {
        self.update(|state| state.wrap = wrap)
    }

    /// How far [`SelectAction::MoveUpFast`] and [`SelectAction::MoveDownFast`] move: five options by default.
    pub fn fast_scroll_step(&self, options: usize) -> Self {
        self.update(|state| state.fast_step = options.max(1))
    }

    /// Blank rows between options.
    pub fn item_spacing(&self, rows: u32) -> Self {
        self.update(|state| state.spacing = rows)
    }

    pub fn colors(&self, fg: Color, bg: Color) -> Self {
        self.update(|state| (state.fg, state.bg) = (fg, bg))
    }

    pub fn focused_colors(&self, fg: Color, bg: Color) -> Self {
        self.update(|state| (state.focused_fg, state.focused_bg) = (fg, bg))
    }

    pub fn selected_colors(&self, fg: Color, bg: Color) -> Self {
        self.update(|state| (state.selected_fg, state.selected_bg) = (fg, bg))
    }

    pub fn description_colors(&self, normal: Color, selected: Color) -> Self {
        self.update(|state| (state.description, state.selected_description) = (normal, selected))
    }

    /// Called when the selection moves, with the new index and option.
    pub fn on_change(&self, mut handler: impl FnMut(&mut Cx<'_>, usize, &SelectOption) + 'static) -> Self {
        self.0.on_change.add(move |cx, (index, option): &(usize, SelectOption)| handler(cx, *index, option));
        self.clone()
    }

    /// Called when Enter activates the selected option, or a click activates it.
    pub fn on_select(&self, mut handler: impl FnMut(&mut Cx<'_>, usize, &SelectOption) + 'static) -> Self {
        self.0.on_select.add(move |cx, (index, option): &(usize, SelectOption)| handler(cx, *index, option));
        self.clone()
    }
}
