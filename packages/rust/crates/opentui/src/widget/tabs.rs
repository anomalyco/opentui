use super::{Behavior, Callbacks, Element, Painter, SelectOption, build, handle, keymap_methods};
use crate::app::{App, Cx};
use crate::input::{KeyEvent, Keymap, MouseButton, MouseEvent, MouseEventKind};
use crate::layout::LayoutProperty;
use crate::native::{Hooks, NodeKind};
use crate::style::{Color, Style};
use std::cell::{Cell, RefCell};
use std::rc::Rc;

/// What a key does in a [`TabSelect`]. Bind keys to actions with [`TabSelect::bind`], or run one with
/// [`TabSelect::perform`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TabSelectAction {
    /// The previous tab, wrapping around when [`TabSelect::wrap_selection`] allows it.
    MoveLeft,
    MoveRight,
    /// Calls [`TabSelect::on_select`] with the selected tab.
    SelectCurrent,
}

struct State {
    options: Vec<SelectOption>,
    selected: usize,
    tab_width: u32,
    show_underline: bool,
    show_description: bool,
    show_arrows: bool,
    wrap: bool,
    fg: Color,
    bg: Color,
    focused_fg: Color,
    focused_bg: Color,
    selected_fg: Color,
    selected_bg: Color,
    description: Color,
    arrows: Color,
}

impl State {
    fn height(&self) -> u32 {
        1 + u32::from(self.show_underline) + u32::from(self.show_description)
    }
}

pub(crate) struct TabsInner {
    element: Element,
    state: RefCell<State>,
    focused: Cell<bool>,
    /// The first visible tab, as last painted.
    painted: Cell<usize>,
    on_change: Callbacks<(usize, SelectOption)>,
    on_select: Callbacks<(usize, SelectOption)>,
    keymap: RefCell<Keymap<TabSelectAction>>,
}

impl TabsInner {
    fn emit(&self, cx: &mut Cx<'_>, callbacks: &Callbacks<(usize, SelectOption)>) {
        let event = {
            let state = self.state.borrow();
            state.options.get(state.selected).map(|option| (state.selected, option.clone()))
        };
        if let Some(event) = event {
            callbacks.emit(cx, &event);
        }
    }

    fn move_by(&self, cx: &mut Cx<'_>, forward: bool) {
        let moved = {
            let mut state = self.state.borrow_mut();
            let count = state.options.len();
            let next = match (forward, state.selected) {
                (true, index) if index + 1 < count => Some(index + 1),
                (false, index) if index > 0 => Some(index - 1),
                _ if state.wrap && count > 0 => Some(if forward { 0 } else { count - 1 }),
                _ => None,
            };
            next.map(|next| state.selected = next).is_some()
        };
        if moved {
            self.element.app().inspect(App::request_redraw);
            self.emit(cx, &self.on_change);
        }
    }

    fn run(&self, cx: &mut Cx<'_>, action: TabSelectAction) {
        match action {
            TabSelectAction::MoveLeft => self.move_by(cx, false),
            TabSelectAction::MoveRight => self.move_by(cx, true),
            TabSelectAction::SelectCurrent => self.emit(cx, &self.on_select),
        }
    }

    fn first_visible(state: &State, width: u32) -> usize {
        let visible = (width / state.tab_width.max(1)).max(1) as usize;
        state.selected.saturating_sub(visible / 2).min(state.options.len().saturating_sub(visible))
    }
}

impl Behavior for TabsInner {
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
                let x = (f64::from(event.x) - rect.screen_x.floor()).max(0.0) as u32;
                let index = {
                    let state = self.state.borrow();
                    self.painted.get() + (x / state.tab_width.max(1)) as usize
                };
                let (current, count) = {
                    let state = self.state.borrow();
                    (state.selected, state.options.len())
                };
                if index < count && index != current {
                    self.state.borrow_mut().selected = index;
                    self.element.app().inspect(App::request_redraw);
                    self.emit(cx, &self.on_change);
                } else if index == current {
                    self.emit(cx, &self.on_select);
                }
                false
            }
            MouseEventKind::ScrollUp | MouseEventKind::ScrollLeft => {
                self.move_by(cx, false);
                true
            }
            MouseEventKind::ScrollDown | MouseEventKind::ScrollRight => {
                self.move_by(cx, true);
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
        let first = Self::first_visible(&state, width);
        self.painted.set(first);
        let base = if focused { state.focused_fg } else { state.fg };
        let tab_width = state.tab_width.max(1);
        for (column, (index, option)) in state.options.iter().enumerate().skip(first).enumerate() {
            let x = column as u32 * tab_width;
            if x >= width {
                break;
            }
            let cells = tab_width.min(width - x);
            let selected = index == state.selected;
            let color = if selected { state.selected_fg } else { base };
            if selected {
                painter.fill(x as i32, 0, cells, 1, state.selected_bg);
            }
            let room = cells.saturating_sub(2);
            if painter.text_width(&option.name) > room {
                painter.clip(x as i32 + 1, 0, room.saturating_sub(1), 1, |painter| {
                    painter.text(x as i32 + 1, 0, &option.name, Style::new().fg(color));
                });
                if room > 0 {
                    painter.text((x + room) as i32, 0, "…", Style::new().fg(color));
                }
            } else {
                painter.text(x as i32 + 1, 0, &option.name, Style::new().fg(color));
            }
            if selected && state.show_underline && height >= 2 {
                let underline = "▬".repeat(cells as usize);
                painter.text(x as i32, 1, &underline, Style::new().fg(color).bg(state.selected_bg));
            }
        }
        let description_row = if state.show_underline { 2 } else { 1 };
        if state.show_description
            && height > description_row
            && let Some(option) = state.options.get(state.selected)
        {
            painter.clip(1, description_row as i32, width.saturating_sub(2), 1, |painter| {
                painter.text(1, description_row as i32, &option.description, Style::new().fg(state.description));
            });
        }
        let visible = (width / tab_width).max(1) as usize;
        if state.show_arrows && state.options.len() > visible {
            if first > 0 {
                painter.text(0, 0, "‹", Style::new().fg(state.arrows));
            }
            if first + visible < state.options.len() {
                painter.text(width as i32 - 1, 0, "›", Style::new().fg(state.arrows));
            }
        }
    }
}

/// A horizontal row of tabs with an underlined selection and the selected tab's description below.
///
/// Left/Right or `[`/`]` move, and Enter calls [`Self::on_select`]; [`Self::bind`] changes the keys. The widget sets
/// its own height from the rows it shows.
///
/// ```no_run
/// # use opentui::prelude::*;
/// # let app = App::new(AppOptions::default())?;
/// let tabs = TabSelect::new(&app).options([("Files", "Browse files"), ("Search", "Find text")]);
/// tabs.on_change(|_cx, index, _tab| eprintln!("tab {index}"));
/// # Ok::<(), opentui::Error>(())
/// ```
#[derive(Clone)]
pub struct TabSelect(Rc<TabsInner>);

handle!(TabSelect, TabsInner);

impl TabSelect {
    pub fn new(app: &App) -> Self {
        let theme = app.theme();
        let tabs = Self(build(app, NodeKind::Box, |element| TabsInner {
            element,
            state: RefCell::new(State {
                options: Vec::new(),
                selected: 0,
                tab_width: 20,
                show_underline: true,
                show_description: true,
                show_arrows: true,
                wrap: false,
                fg: theme.foreground,
                bg: Color::TRANSPARENT,
                focused_fg: theme.foreground,
                focused_bg: Color::TRANSPARENT,
                selected_fg: theme.highlight_fg,
                selected_bg: theme.highlight_bg,
                description: theme.muted,
                arrows: theme.muted,
            }),
            focused: Cell::new(false),
            painted: Cell::new(0),
            on_change: Callbacks::default(),
            on_select: Callbacks::default(),
            keymap: RefCell::new(Self::default_keymap()),
        }));
        tabs.0.element.set_focusable(true);
        tabs.0.element.add_hooks(Hooks::RENDER_AFTER);
        let height = tabs.0.state.borrow().height();
        tabs.0.element.set_layout(LayoutProperty::FixedHeight(height.into()));
        tabs
    }

    /// The key bindings a new tab row starts with: Core's.
    pub fn default_keymap() -> Keymap<TabSelectAction> {
        use TabSelectAction as A;
        Keymap::new()
            .bind("left", A::MoveLeft)
            .bind("[", A::MoveLeft)
            .bind("right", A::MoveRight)
            .bind("]", A::MoveRight)
            .bind("enter", A::SelectCurrent)
            .bind("linefeed", A::SelectCurrent)
    }

    keymap_methods!(TabSelectAction);

    /// Runs an action as its key would, including change and select handlers.
    pub fn perform(&self, action: TabSelectAction) -> Self {
        if let Some(app) = self.0.element.app() {
            self.0.run(&mut Cx::new(&app), action);
        }
        self.clone()
    }

    /// Changes the state and redraws. The row's height follows the lines it shows, only when that count changes, so
    /// a height set on the widget lasts until then.
    fn update(&self, change: impl FnOnce(&mut State)) -> Self {
        let (before, after) = {
            let mut state = self.0.state.borrow_mut();
            let before = state.height();
            change(&mut state);
            (before, state.height())
        };
        if before != after {
            self.0.element.set_layout(LayoutProperty::FixedHeight(after.into()));
        }
        self.0.element.app().inspect(App::request_redraw);
        self.clone()
    }

    /// Replaces the tabs. Keeps the selected index when it still exists.
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

    pub fn selected(&self) -> usize {
        self.0.state.borrow().selected
    }

    pub fn selected_option(&self) -> Option<SelectOption> {
        let state = self.0.state.borrow();
        state.options.get(state.selected).cloned()
    }

    /// Selects a tab. Out-of-range indexes are ignored. Does not call change handlers.
    pub fn select(&self, index: usize) -> Self {
        self.update(|state| {
            if index < state.options.len() {
                state.selected = index;
            }
        })
    }

    /// Cells per tab; 20 by default.
    pub fn tab_width(&self, width: u32) -> Self {
        self.update(|state| state.tab_width = width.max(1))
    }

    pub fn show_underline(&self, show: bool) -> Self {
        self.update(|state| state.show_underline = show)
    }

    pub fn show_description(&self, show: bool) -> Self {
        self.update(|state| state.show_description = show)
    }

    /// Shows `‹` and `›` when tabs overflow. On by default.
    pub fn show_arrows(&self, show: bool) -> Self {
        self.update(|state| state.show_arrows = show)
    }

    pub fn wrap_selection(&self, wrap: bool) -> Self {
        self.update(|state| state.wrap = wrap)
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

    /// The color of the selected tab's description; the theme's muted color by default.
    pub fn description_color(&self, color: Color) -> Self {
        self.update(|state| state.description = color)
    }

    /// The color of the overflow arrows; the theme's muted color by default.
    pub fn arrow_color(&self, color: Color) -> Self {
        self.update(|state| state.arrows = color)
    }

    pub fn on_change(&self, mut handler: impl FnMut(&mut Cx<'_>, usize, &SelectOption) + 'static) -> Self {
        self.0.on_change.add(move |cx, (index, option): &(usize, SelectOption)| handler(cx, *index, option));
        self.clone()
    }

    pub fn on_select(&self, mut handler: impl FnMut(&mut Cx<'_>, usize, &SelectOption) + 'static) -> Self {
        self.0.on_select.add(move |cx, (index, option): &(usize, SelectOption)| handler(cx, *index, option));
        self.clone()
    }
}
