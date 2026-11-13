use super::line_numbers::GutterInner;
use super::{
    Behavior, Callbacks, Element, LocalSelection, ScrollAction, SelectionUpdate, VisibleLines, Widget, build,
    keymap_methods,
};
use crate::app::{App, Cx, ProxyError};
use crate::input::{KeyEvent, Keymap, MouseEvent, MouseEventKind};
use crate::layout::{FlexDirection, LayoutProperty, Length};
use crate::native::{Hooks, NodeKind, SelectionColors, TextBuffer, TextView, Viewport, WrapMode};
use crate::style::{Color, Span, Style};
use crate::syntax::{self, SyntaxTheme};
use std::cell::{Cell, RefCell};
use std::ops::Range;
use std::rc::{Rc, Weak};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::time::Duration;

/// Highlighted text: byte ranges of the source with their styles.
type Ranges = Vec<(Range<usize>, Style)>;

/// A highlight on a worker thread, of the source's first `len` bytes.
struct Pending {
    len: usize,
    receiver: Receiver<Option<Ranges>>,
}

pub(crate) struct CodeInner {
    element: Element,
    gutter: Rc<GutterInner>,
    text: Rc<CodeText>,
    buffer: TextBuffer,
    view: TextView,
    filetype: RefCell<Option<String>>,
    syntax: RefCell<Arc<SyntaxTheme>>,
    /// The text color, under the syntax theme's `default` style.
    fg: Cell<Color>,
    /// Text styled by the crate, shown instead of highlighting until the next `set_code`.
    styled: RefCell<Option<Vec<Span<'static>>>>,
    /// Whether the text changed since it was highlighted. The next frame highlights it.
    stale: Cell<bool>,
    /// Whether the buffer shows a highlight of the source, or of its start with the rest plain. Text appended then
    /// is highlighted on a worker thread, as Core highlights in its worker, and the shown highlight stays until the
    /// new one lands.
    highlighted: Cell<bool>,
    /// The highlight running on a worker thread. Replacing the text, filetype, or styles drops it, so its result
    /// never lands.
    pending: RefCell<Option<Pending>>,
    source: RefCell<String>,
    scroll: Cell<u32>,
    follow: Cell<bool>,
    /// Whether the view sits at the bottom, so following keeps it there.
    pinned: Cell<bool>,
    keymap: RefCell<Keymap<ScrollAction>>,
    on_scroll: Callbacks<u32>,
    laid_out_height: Cell<Option<u32>>,
    selectable: Cell<bool>,
    selection_colors: Cell<SelectionColors>,
    selection: Cell<Option<LocalSelection>>,
}

impl CodeInner {
    /// The text's height: the one the latest resize reported, which is current during the frame, before the frame's
    /// geometry is published.
    fn height(&self) -> u32 {
        self.laid_out_height.get().unwrap_or_else(|| self.text.element.rect().height.max(0.0) as u32)
    }

    fn total_lines(&self) -> u32 {
        self.report(self.view.info()).map_or(0, |info| info.total_virtual_line_count)
    }

    fn report<T>(&self, result: crate::Result<T>) -> Option<T> {
        match self.element.app() {
            Some(app) => app.report(result),
            None => result.ok(),
        }
    }

    /// Scrolls to a wrapped row, clamped to the text. Returns whether the view moved.
    fn scroll_to(&self, row: i64) -> bool {
        let max = self.total_lines().saturating_sub(self.height());
        let row = row.clamp(0, i64::from(max)) as u32;
        let previous = self.scroll.replace(row);
        self.pinned.set(row >= max);
        let rect = self.text.element.rect();
        let viewport = Viewport { x: 0, y: row, width: rect.width as u32, height: rect.height as u32 };
        self.report(self.view.set_viewport(viewport));
        if let Some(app) = self.element.app() {
            app.request_redraw();
            if previous != row {
                self.on_scroll.emit(&mut Cx::new(&app), &row);
            }
        }
        previous != row
    }

    /// Runs an action. Returns `false` for Left and Right: the view does not scroll sideways.
    fn run(&self, action: ScrollAction) -> bool {
        let (row, page) = (i64::from(self.scroll.get()), i64::from(self.height().max(2) - 1));
        let target = match action {
            ScrollAction::Up => row - 1,
            ScrollAction::Down => row + 1,
            ScrollAction::PageUp => row - page,
            ScrollAction::PageDown => row + page,
            ScrollAction::Top => 0,
            ScrollAction::Bottom => i64::from(u32::MAX),
            ScrollAction::Left | ScrollAction::Right => return false,
        };
        self.scroll_to(target);
        true
    }

    /// Shows the source at once, plain or as the crate styled it. Text with a filetype is highlighted at the start of
    /// the next frame, so any number of changes between frames costs one highlight.
    fn render_source(&self) {
        let result = match &*self.styled.borrow() {
            Some(spans) => self.buffer.set_spans(spans),
            None => self.buffer.set_text(&self.source.borrow()),
        };
        self.report(result);
        self.forget_highlight();
        self.changed();
    }

    /// Shows appended text plain after the shown highlight until the next one lands.
    fn extend(&self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.source.borrow_mut().push_str(text);
        self.report(self.buffer.append(text));
        self.changed();
    }

    /// The next highlight runs on the UI thread, and a running one never lands.
    fn forget_highlight(&self) {
        self.highlighted.set(false);
        self.pending.take();
    }

    /// Highlights the source on a worker thread. The UI thread pays only for copying the source.
    fn spawn(&self, filetype: String) {
        let Some(app) = self.element.app() else { return };
        let (source, syntax) = (self.source.borrow().clone(), Arc::clone(&self.syntax.borrow()));
        let len = source.len();
        let (sender, receiver) = mpsc::sync_channel(1);
        let proxy = app.proxy();
        let worker = std::thread::Builder::new().name("opentui-highlight".into()).spawn(move || {
            if sender.send(syntax::highlight_ranges(&source, &filetype, &syntax)).is_ok() {
                // Retry while the UI thread catches up, so the result is painted.
                while proxy.post(|cx| cx.app().request_redraw()) == Err(ProxyError::Full) {
                    std::thread::sleep(Duration::from_millis(1));
                }
            }
        });
        match worker {
            Ok(_) => *self.pending.borrow_mut() = Some(Pending { len, receiver }),
            Err(_) => self.highlight_now(),
        }
    }

    /// Applies a worker's highlight once it finished.
    fn land(&self) {
        let result = match self.pending.borrow().as_ref().map(|pending| pending.receiver.try_recv()) {
            None | Some(Err(TryRecvError::Empty)) => return,
            Some(result) => result,
        };
        let pending = self.pending.take().expect("a pending highlight");
        match result {
            Ok(Some(ranges)) => self.show(&ranges, pending.len),
            // No grammar, or the worker failed: the text stays plain.
            Ok(None) | Err(_) => self.highlighted.set(false),
        }
    }

    fn highlight_now(&self) {
        let filetype = self.filetype.borrow();
        let Some(filetype) = filetype.as_deref() else { return };
        let len = self.source.borrow().len();
        match syntax::highlight_ranges(&self.source.borrow(), filetype, &self.syntax.borrow()) {
            Some(ranges) => self.show(&ranges, len),
            None => self.highlighted.set(false),
        }
    }

    /// Shows the highlight of the source's first `len` bytes, and the rest plain.
    fn show(&self, ranges: &Ranges, len: usize) {
        let source = self.source.borrow();
        self.report(self.buffer.set_styled_ranges(&source[..len], ranges));
        if len < source.len() {
            self.report(self.buffer.append(&source[len..]));
        }
        self.highlighted.set(true);
    }

    /// Highlights changed text at the next frame. As in Core, the selection starts over at the same cells.
    fn changed(&self) {
        self.mark_stale();
        self.gutter.changed();
        if self.selection.get().is_some() {
            self.apply_selection(true);
        }
    }

    /// Applies the selection kept from the app, or clears the view's.
    fn apply_selection(&self, start: bool) -> bool {
        let colors = self.selection_colors.get();
        self.report(match self.selection.get() {
            Some(LocalSelection { anchor, focus, unit }) => {
                self.view.select_local(anchor, focus, !start, unit, colors).map(drop)
            }
            None => self.view.clear_selection(),
        });
        self.element.app().inspect(App::request_redraw);
        self.report(self.view.selection()).flatten().is_some()
    }

    fn mark_stale(&self) {
        let stale = self.styled.borrow().is_none() && self.filetype.borrow().is_some();
        self.stale.set(stale);
        if stale {
            self.element.app().inspect(App::request_redraw);
        }
    }

    /// Unstyled text takes the text color with the syntax theme's `default` style on top.
    fn apply_defaults(&self) {
        let default = self.syntax.borrow().get("default").unwrap_or_default();
        self.report(self.buffer.set_defaults(Style::new().fg(self.fg.get()).patch(default)));
    }
}

impl Behavior for CodeInner {
    fn element(&self) -> &Element {
        &self.element
    }

    /// Highlights text that changed since the last frame. Without a grammar it stays plain. Appended text is
    /// highlighted on a worker thread, one highlight at a time; anything else on the UI thread, before the frame
    /// paints.
    fn update(&self, _cx: &mut Cx<'_>) {
        self.land();
        if !self.stale.get() || self.pending.borrow().is_some() {
            return;
        }
        self.stale.set(false);
        let filetype = self.filetype.borrow().clone();
        match filetype {
            Some(filetype) if self.highlighted.get() => self.spawn(filetype),
            _ => self.highlight_now(),
        }
    }

    fn key(&self, _cx: &mut Cx<'_>, key: &KeyEvent) -> bool {
        let action = self.keymap.borrow().get(key);
        action.is_some_and(|action| self.run(action))
    }

    /// An unmoved view lets an outer scroll area scroll instead.
    fn mouse(&self, _cx: &mut Cx<'_>, event: &MouseEvent) -> bool {
        let row = i64::from(self.scroll.get());
        match event.kind {
            MouseEventKind::ScrollUp => self.scroll_to(row - 1),
            MouseEventKind::ScrollDown => self.scroll_to(row + 1),
            _ => false,
        }
    }

    fn selectable(&self) -> bool {
        self.selectable.get()
    }

    fn teardown(&self) {
        self.on_scroll.clear();
    }

    /// Selects in the text column: coordinates are relative to it, not to the gutter.
    fn select(&self, update: Option<&SelectionUpdate>) -> bool {
        self.selection.set(update.map(|update| update.local_selection(&self.text.element)));
        self.apply_selection(update.is_none_or(|update| update.start))
    }

    fn selected_text(&self) -> Option<String> {
        self.report(self.view.selected_text())
    }

    fn visible_lines(&self) -> Option<VisibleLines> {
        let line_count = self.report(self.buffer.info())?.line_count;
        let rows = self.report(self.view.lines(0, self.height()))?;
        Some(VisibleLines { line_count, rows })
    }
}

impl CodeInner {
    /// Keeps the scroll position within the text after the text column changed size, following the end if pinned.
    fn text_resized(&self, height: u32) {
        self.laid_out_height.set(Some(height));
        self.keep_in_view();
    }

    /// Keeps the view within the text, or at the end when following and the last scroll reached it. Before the first
    /// layout there is no view to keep: the first resize does it.
    fn keep_in_view(&self) {
        let Some(_) = self.laid_out_height.get() else { return };
        let follow = self.follow.get() && self.pinned.get();
        self.scroll_to(if follow { i64::from(u32::MAX) } else { i64::from(self.scroll.get()) });
    }
}

/// The text column: its resizes, not the whole view's, which includes padding, set the scroll limits.
pub(crate) struct CodeText {
    element: Element,
    code: Weak<CodeInner>,
}

impl Behavior for CodeText {
    fn element(&self) -> &Element {
        &self.element
    }

    fn resized(&self, _cx: &mut Cx<'_>, _width: u32, height: u32) {
        if let Some(code) = self.code.upgrade() {
            code.text_resized(height);
        }
    }
}

/// Read-only text with optional line numbers and highlighting: source code, logs, or command output.
///
/// The text scrolls with the wheel and, while focused, with the arrow keys, j/k, Page Up/Down, Space, Home/End, and
/// g/G; [`Self::bind`] changes the keys.
/// [`Self::follow`] keeps appended text in view, for logs. Give it a height or a grow factor.
///
/// With the `tree-sitter` feature, [`Self::filetype`] highlights the text; see [`syntax`](crate::syntax).
///
/// ```no_run
/// # use opentui::prelude::*;
/// # use opentui::widget::Code;
/// # let app = App::new(AppOptions::default())?;
/// let source = Code::new(&app).filetype("rust").line_numbers(true).grow(1.0);
/// source.set_code("fn main() {\n    println!(\"hello\");\n}\n");
/// # Ok::<(), opentui::Error>(())
/// ```
#[derive(Clone)]
pub struct Code(pub(crate) Rc<CodeInner>);

impl Widget for Code {
    fn element(&self) -> &Element {
        &self.0.element
    }
}

impl std::fmt::Debug for Code {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_tuple("Code").field(&self.0.element.id()).finish()
    }
}

impl Code {
    /// # Panics
    ///
    /// Panics if native code cannot create the text buffer or view, after the app recorded the error.
    pub fn new(app: &App) -> Self {
        Self::themed(app, Arc::new(SyntaxTheme::from_theme(&app.theme())))
    }

    /// A code view that shares `syntax`, as Markdown's code blocks share the document's.
    pub(crate) fn themed(app: &App, syntax: Arc<SyntaxTheme>) -> Self {
        let theme = app.theme();
        let buffer = app.report(TextBuffer::new(app.session().context(), app.width_method()));
        let buffer = buffer.unwrap_or_else(|| panic!("opentui: failed to create a text buffer: {:?}", app.check()));
        let view = app.report(TextView::new(&buffer));
        let view = view.unwrap_or_else(|| panic!("opentui: failed to create a text view: {:?}", app.check()));
        let inner = Rc::new_cyclic(|weak: &Weak<CodeInner>| {
            let this: Weak<dyn Behavior> = weak.clone();
            let element = Element::new(app, NodeKind::Box, this);
            let gutter = GutterInner::build(app, theme.muted);
            *gutter.target.borrow_mut() = weak.clone();
            gutter.state.borrow_mut().show = false;
            let text = build(app, NodeKind::TextView, |element| CodeText { element, code: weak.clone() });
            CodeInner {
                element,
                gutter,
                text,
                buffer,
                view,
                filetype: RefCell::new(None),
                syntax: RefCell::new(syntax),
                fg: Cell::new(theme.foreground),
                styled: RefCell::new(None),
                stale: Cell::new(false),
                highlighted: Cell::new(false),
                pending: RefCell::new(None),
                source: RefCell::new(String::new()),
                scroll: Cell::new(0),
                follow: Cell::new(false),
                pinned: Cell::new(true),
                keymap: RefCell::new(Code::default_keymap()),
                on_scroll: Callbacks::default(),
                laid_out_height: Cell::new(None),
                selectable: Cell::new(true),
                selection_colors: Cell::new(SelectionColors {
                    fg: Some(theme.selection_fg),
                    bg: Some(theme.selection_bg),
                }),
                selection: Cell::new(None),
            }
        });
        inner.element.register();
        inner.element.add_hooks(Hooks::UPDATE);
        inner.element.set_layout(LayoutProperty::FlexDirection(FlexDirection::Row));
        inner.element.set_focusable(true);
        inner.element.insert(&inner.gutter.element, None);
        inner.element.insert(&inner.text.element, None);
        inner.text.element.set_layout(LayoutProperty::FlexGrow(1.0));
        inner.text.element.set_layout(LayoutProperty::FlexBasis(Length::Cells(0.0)));
        inner.text.element.set_layout(LayoutProperty::MinHeight(Length::Cells(0.0)));
        inner.text.element.add_hooks(Hooks::RESIZE);
        let view = inner.view.clone();
        inner.text.element.apply(|node| node.set_text_view(Some(&view)));
        inner.apply_defaults();
        inner.report(inner.view.set_wrap(WrapMode::None));
        inner.gutter.changed();
        Self(inner)
    }

    /// The key bindings a new code view starts with.
    pub fn default_keymap() -> Keymap<ScrollAction> {
        use ScrollAction as A;
        Keymap::new()
            .bind("up", A::Up)
            .bind("k", A::Up)
            .bind("down", A::Down)
            .bind("j", A::Down)
            .bind("pageup", A::PageUp)
            .bind("pagedown", A::PageDown)
            .bind("space", A::PageDown)
            .bind("home", A::Top)
            .bind("g", A::Top)
            .bind("end", A::Bottom)
            .bind("G", A::Bottom)
    }

    keymap_methods!(ScrollAction);

    /// Runs an action as its key would.
    pub fn perform(&self, action: ScrollAction) -> Self {
        self.0.run(action);
        self.clone()
    }

    /// Replaces the text. Text that extends the current text is appended, as [`Self::append`] appends it.
    pub fn set_code(&self, code: impl Into<String>) -> Self {
        let code = code.into();
        let len = self.0.source.borrow().len();
        if self.0.styled.borrow().is_none() && code.starts_with(self.0.source.borrow().as_str()) {
            self.0.extend(&code[len..]);
        } else {
            *self.0.source.borrow_mut() = code;
            *self.0.styled.borrow_mut() = None;
            self.0.render_source();
        }
        self.0.keep_in_view();
        self.clone()
    }

    /// Replaces the text with styled text, which stays until the next [`Self::set_code`]: the debug console's
    /// colored messages.
    pub(crate) fn set_spans(&self, spans: Vec<Span<'static>>) {
        *self.0.source.borrow_mut() = spans.iter().map(|span| &*span.content).collect();
        *self.0.styled.borrow_mut() = Some(spans);
        self.0.render_source();
        self.0.keep_in_view();
    }

    /// Appends text, keeping the view at the bottom when following. With a filetype, the whole text is highlighted
    /// again: the first time before the next frame paints, and once highlighted on a worker thread, showing the new
    /// text plain until that highlight lands.
    pub fn append(&self, text: &str) -> Self {
        *self.0.styled.borrow_mut() = None;
        self.0.extend(text);
        self.0.keep_in_view();
        self.clone()
    }

    pub fn code(&self) -> String {
        self.0.source.borrow().clone()
    }

    /// Highlights the text as a filetype, such as `"rust"`, or shows it plain with `None`. Extensions, file names,
    /// and fence tags work too: `"rs"`, `"main.rs"`, `"ts"`. It needs the `tree-sitter` feature and a grammar for the
    /// filetype; without them the text is plain. See [`syntax`](crate::syntax).
    pub fn filetype<'a>(&self, filetype: impl Into<Option<&'a str>>) -> Self {
        let filetype = filetype.into().map(str::to_owned);
        if *self.0.filetype.borrow() != filetype {
            *self.0.filetype.borrow_mut() = filetype;
            self.0.render_source();
        }
        self.clone()
    }

    /// The styles for highlighted text. It starts as [`SyntaxTheme::from_theme`] for the app's theme.
    pub fn syntax_theme(&self, theme: SyntaxTheme) -> Self {
        if **self.0.syntax.borrow() != theme {
            *self.0.syntax.borrow_mut() = Arc::new(theme);
            self.0.apply_defaults();
            self.0.forget_highlight();
            self.0.mark_stale();
        }
        self.clone()
    }

    /// The color of text the syntax theme does not style. It starts as the app theme's foreground.
    pub fn fg(&self, color: Color) -> Self {
        self.0.fg.set(color);
        self.0.apply_defaults();
        self.0.element.app().inspect(App::request_redraw);
        self.clone()
    }

    /// The color of the line numbers [`Self::line_numbers`] shows.
    pub fn line_number_fg(&self, color: Color) -> Self {
        self.0.gutter.state.borrow_mut().fg = color;
        self.0.gutter.changed();
        self.clone()
    }

    /// Shows line numbers in a gutter, as [`LineNumbers`](super::LineNumbers) draws them. For signs and per-line
    /// colors, wrap the view in a `LineNumbers` instead.
    pub fn line_numbers(&self, show: bool) -> Self {
        self.0.gutter.state.borrow_mut().show = show;
        self.0.gutter.changed();
        self.clone()
    }

    /// Wraps long lines instead of cutting them off. Off by default.
    pub fn wrap(&self, wrap: WrapMode) -> Self {
        self.0.report(self.0.view.set_wrap(wrap));
        self.0.scroll_to(i64::from(self.0.scroll.get()));
        self.clone()
    }

    /// Whether the mouse can select the text. On by default.
    pub fn selectable(&self, selectable: bool) -> Self {
        self.0.selectable.set(selectable);
        self.clone()
    }

    pub fn selection_colors(&self, colors: SelectionColors) -> Self {
        self.0.selection_colors.set(colors);
        self.clone()
    }

    /// This view's part of the mouse selection, or an empty string.
    pub fn selected_text(&self) -> String {
        self.0.selected_text().unwrap_or_default()
    }

    /// Keeps the last line in view as text is appended, until the user scrolls up.
    pub fn follow(&self, follow: bool) -> Self {
        self.0.follow.set(follow);
        self.clone()
    }

    /// Called with the first visible wrapped line whenever the view scrolls, by the user or by the program.
    pub fn on_scroll(&self, mut handler: impl FnMut(&mut Cx<'_>, u32) + 'static) -> Self {
        self.0.on_scroll.add(move |cx, row: &u32| handler(cx, *row));
        self.clone()
    }

    /// The first visible wrapped line.
    pub fn scroll_position(&self) -> u32 {
        self.0.scroll.get()
    }

    /// Makes a wrapped line the first visible one, as far as the text allows. Without [`Self::wrap`], wrapped lines
    /// are the zero-based lines of the text.
    pub fn scroll_to(&self, row: u32) -> Self {
        self.0.scroll_to(i64::from(row));
        self.clone()
    }

    /// The native text buffer, for operations this widget does not wrap. Text written through it bypasses the widget:
    /// [`Self::code`] leaves it out, and the widget's next rewrite of the buffer, from [`Self::set_code`] with text
    /// that does not extend the current text, a [`Self::filetype`] change, or highlighting, replaces it.
    pub fn buffer(&self) -> &TextBuffer {
        &self.0.buffer
    }
}
