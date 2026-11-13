use super::extmarks::SYNTAX_LAYER;
use super::line_numbers::GutterInner;
use super::{
    Behavior, Callbacks, Element, LocalSelection, ScrollAction, SelectionUpdate, VisibleLines, Widget, build,
    keymap_methods,
};
use crate::app::{App, Cx, ProxyError};
use crate::input::{KeyEvent, Keymap, MouseEvent, MouseEventKind};
use crate::layout::{FlexDirection, LayoutProperty, Length};
use crate::native::{Hooks, NodeKind, SelectionColors, SyntaxStyle, TextBuffer, TextView, Viewport, WrapMode};
use crate::style::{Color, Span, Style};
use crate::syntax::{CaptureSets, Incremental, NamedRanges, SyntaxTheme};
use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::time::Duration;

/// A highlight on a worker thread, of the source's first `len` bytes. It owns the highlighter and hands it back.
struct Pending {
    len: usize,
    receiver: Receiver<(Incremental, Option<NamedRanges>)>,
}

pub(crate) struct CodeInner {
    element: Element,
    gutter: Rc<GutterInner>,
    text: Rc<CodeText>,
    buffer: TextBuffer,
    view: TextView,
    filetype: RefCell<Option<String>>,
    syntax: RefCell<Arc<SyntaxTheme>>,
    /// The buffer's style table, with `syntax` as its capture palette: the syntax layer paints capture names through
    /// it, so a new theme restyles the shown highlight without highlighting again.
    table: SyntaxStyle,
    sets: RefCell<CaptureSets>,
    /// The text color, under the syntax theme's `default` style.
    fg: Cell<Color>,
    /// Text styled by the crate, shown instead of highlighting until the next `set_code`.
    styled: RefCell<Option<Vec<Span<'static>>>>,
    /// Whether the text changed since it was highlighted. The next frame highlights it.
    stale: Cell<bool>,
    /// The length of the source's start the syntax layer highlights, the rest plain. Text appended then is
    /// highlighted on a worker thread, as Core highlights in its worker, and the shown highlight stays until the new
    /// one lands.
    highlighted: Cell<Option<usize>>,
    /// The highlight running on a worker thread. Replacing the text or filetype drops it, so its result never lands.
    pending: RefCell<Option<Pending>>,
    /// The highlighter with the tree of the highlighted start, while no highlight runs. An append hands it only the
    /// appended bytes; replacing the text or filetype drops it.
    pub(crate) incremental: RefCell<Option<Incremental>>,
    /// Whether the text is a closed Markdown fence, which drops its tree once its last highlight landed.
    closed: Cell<bool>,
    source: RefCell<String>,
    /// The source offsets of its CRLF pairs. The buffer counts one byte per line break, so a layer run edge moves left
    /// by the pairs before it.
    crlf: RefCell<Vec<usize>>,
    /// The buffer's content epoch after the widget's last write: another one means another caller wrote the text.
    written: Cell<u64>,
    /// Highlights started and syntax layers written, for tests.
    #[cfg(test)]
    pub(crate) work: Cell<(usize, usize)>,
    /// Bytes handed to highlights, for tests.
    #[cfg(test)]
    pub(crate) handed: Cell<usize>,
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
    /// Whether the text changed under a selection since the last frame, which applies it again once following,
    /// scrolling and wrapping settled, as Core's Code does when it sets its text in the frame.
    reselect: Cell<bool>,
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
        *self.crlf.borrow_mut() = self.source.borrow().match_indices("\r\n").map(|(at, _)| at).collect();
        self.wrote();
        self.forget_highlight();
        self.changed();
    }

    /// Shows appended text plain after the shown highlight until the next one lands. Text another caller wrote to the
    /// buffer, or an append that splits a CRLF, writes the whole source again: the buffer counts a CRLF as one line
    /// break, but a CR and then an LF as two.
    fn extend(&self, text: &str) {
        if text.is_empty() {
            return;
        }
        let (len, split) = (self.source.borrow().len(), text.starts_with('\n') && self.source.borrow().ends_with('\r'));
        self.source.borrow_mut().push_str(text);
        if split || self.epoch() != self.written.get() {
            return self.render_source();
        }
        self.crlf.borrow_mut().extend(text.match_indices("\r\n").map(|(at, _)| len + at));
        self.report(self.buffer.append(text));
        self.wrote();
        self.changed();
    }

    fn epoch(&self) -> u64 {
        self.report(self.buffer.info()).map_or(0, |info| info.content_epoch)
    }

    fn wrote(&self) {
        self.written.set(self.epoch());
    }

    /// The next highlight runs on the UI thread from a fresh parse, and a running one never lands.
    fn forget_highlight(&self) {
        self.highlighted.set(None);
        self.pending.take();
        self.incremental.take();
    }

    /// Highlights the source on a worker thread, handing it the highlighter and the bytes appended since its last
    /// highlight. The UI thread pays only for copying those.
    fn spawn(&self, filetype: String) {
        let Some(app) = self.element.app() else { return };
        let mut incremental = self.incremental.take().unwrap_or_else(|| Incremental::new(&filetype));
        let (len, appended) = {
            let source = self.source.borrow();
            debug_assert!(source.starts_with(incremental.text()));
            (source.len(), source[incremental.text().len()..].to_owned())
        };
        let (sender, receiver) = mpsc::sync_channel(1);
        // The worker gets the highlighter once it started, so a thread that fails to start leaves it here.
        let (job_sender, job) = mpsc::channel::<(Incremental, String)>();
        let proxy = app.proxy();
        #[cfg(test)]
        {
            self.work.set((self.work.get().0 + 1, self.work.get().1));
            self.handed.set(self.handed.get() + appended.len());
        }
        let job = move || {
            let Ok((mut incremental, appended)) = job.recv() else { return };
            let named = incremental.update([incremental.text(), &appended].concat());
            if sender.send((incremental, named)).is_ok() {
                // Retry while the UI thread catches up, so the result is painted.
                while proxy.post(|cx| cx.app().request_redraw()) == Err(ProxyError::Full) {
                    std::thread::sleep(Duration::from_millis(1));
                }
            }
        };
        let builder = std::thread::Builder::new().name("opentui-highlight".into());
        #[cfg(all(test, feature = "tree-sitter"))]
        let worker = if tests::DENY_THREADS.get() { Err(std::io::Error::other("denied")) } else { builder.spawn(job) };
        #[cfg(not(all(test, feature = "tree-sitter")))]
        let worker = builder.spawn(job);
        match worker {
            Ok(_) => {
                drop(job_sender.send((incremental, appended)));
                *self.pending.borrow_mut() = Some(Pending { len, receiver });
            }
            // Without a thread the same highlight runs here.
            Err(_) => {
                let named = incremental.update([incremental.text(), &appended].concat());
                self.keep(incremental, named, len);
            }
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
            Ok((incremental, named)) => self.keep(incremental, named, pending.len),
            // The worker failed: the shown highlight stays, and the next one runs on the UI thread.
            Err(_) => self.highlighted.set(None),
        }
    }

    fn highlight_now(&self) {
        let filetype = self.filetype.borrow();
        let Some(filetype) = filetype.as_deref() else { return };
        let mut incremental = Incremental::new(filetype);
        // Plain text stays plain without copying it.
        if !incremental.has_grammar() {
            return self.highlighted.set(None);
        }
        let source = self.source.borrow().clone();
        #[cfg(test)]
        {
            self.work.set((self.work.get().0 + 1, self.work.get().1));
            self.handed.set(self.handed.get() + source.len());
        }
        let len = source.len();
        let named = incremental.update(source);
        self.keep(incremental, named, len);
    }

    /// Shows a highlight and keeps its highlighter for the next one. Without one (no grammar), the shown highlight
    /// stays, and the next one runs on the UI thread.
    fn keep(&self, incremental: Incremental, named: Option<NamedRanges>, len: usize) {
        let Some(named) = named else { return self.highlighted.set(None) };
        *self.incremental.borrow_mut() = Some(incremental);
        self.show(named, len);
        self.release_closed();
    }

    /// A closed Markdown fence drops its tree once its last highlight landed: its text no longer grows. A running
    /// highlight holds the tree until it lands.
    fn release_closed(&self) {
        if self.closed.get() && !self.stale.get() {
            self.incremental.take();
        }
    }

    /// Marks the text as a Markdown fence that is closed or open again.
    pub(crate) fn set_closed(&self, closed: bool) {
        self.closed.set(closed);
        self.release_closed();
    }

    /// Shows the highlight of the source's first `len` bytes as the syntax layer, and the rest plain. Text another
    /// caller wrote to the buffer is replaced with the source first.
    fn show(&self, named: NamedRanges, len: usize) {
        if self.epoch() != self.written.get() {
            self.report(self.buffer.set_text(&self.source.borrow()));
            self.wrote();
        }
        let crlf = self.crlf.borrow();
        let runs = self
            .sets
            .borrow_mut()
            .runs(&self.table, self.buffer.context(), named, |at| at - crlf.partition_point(|&pair| pair < at));
        if let Some(runs) = self.report(runs) {
            self.report(self.buffer.set_layer(SYNTAX_LAYER, 0..u32::MAX, &runs));
        }
        #[cfg(test)]
        self.work.set((self.work.get().0, self.work.get().1 + 1));
        self.highlighted.set(Some(len));
    }

    /// Highlights changed text at the next frame. As in Core, the selection starts over at the same cells.
    fn changed(&self) {
        self.mark_stale();
        self.gutter.changed();
        if self.selection.get().is_some() {
            self.apply_selection(true);
            self.reselect.set(true);
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

    /// Makes `syntax` the table's capture palette, which every code view and editor sharing the table paints.
    /// The text color `fg` goes under the theme's `default` style.
    pub(crate) fn restyle(&self, syntax: Arc<SyntaxTheme>, fg: Color) {
        self.report(self.table.set_capture_theme(&syntax));
        *self.syntax.borrow_mut() = syntax;
        self.fg.set(fg);
        self.apply_defaults();
        self.element.app().inspect(App::request_redraw);
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
        if self.reselect.take() {
            self.apply_selection(true);
        }
        if !self.stale.get() || self.pending.borrow().is_some() {
            return;
        }
        self.stale.set(false);
        let filetype = self.filetype.borrow().clone();
        match filetype {
            Some(filetype) if self.highlighted.get().is_some() => self.spawn(filetype),
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
        Self::themed(app, Arc::new(SyntaxTheme::from_theme(&app.theme())), None)
    }

    /// A code view that shares `syntax` and the style `table`, as Markdown's code blocks share the document's; without
    /// a table it makes its own.
    pub(crate) fn themed(app: &App, syntax: Arc<SyntaxTheme>, table: Option<&SyntaxStyle>) -> Self {
        let theme = app.theme();
        let context = app.session().context();
        let buffer = app.report(TextBuffer::new(context, app.width_method()));
        let buffer = buffer.unwrap_or_else(|| panic!("opentui: failed to create a text buffer: {:?}", app.check()));
        let view = app.report(TextView::new(&buffer));
        let view = view.unwrap_or_else(|| panic!("opentui: failed to create a text view: {:?}", app.check()));
        let table = table.cloned().or_else(|| app.report(SyntaxStyle::new(context)));
        let table = table.unwrap_or_else(|| panic!("opentui: failed to create a style table: {:?}", app.check()));
        app.report(table.set_capture_theme(&syntax));
        app.report(buffer.set_syntax_style(Some(&table)));
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
                table,
                sets: RefCell::default(),
                fg: Cell::new(theme.foreground),
                styled: RefCell::new(None),
                stale: Cell::new(false),
                highlighted: Cell::new(None),
                pending: RefCell::new(None),
                incremental: RefCell::new(None),
                closed: Cell::new(false),
                source: RefCell::new(String::new()),
                crlf: RefCell::default(),
                written: Cell::new(0),
                #[cfg(test)]
                work: Cell::default(),
                #[cfg(test)]
                handed: Cell::default(),
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
                reselect: Cell::new(false),
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
        inner.wrote();
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

    /// Appends text, keeping the view at the bottom when following. With a filetype, the text is highlighted again:
    /// the first time before the next frame paints, and once highlighted on a worker thread, which parses the
    /// appended text reusing the last parse, showing the new text plain until that highlight lands.
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

    /// The styles for highlighted text. It starts as [`SyntaxTheme::from_theme`] for the app's theme. A new theme
    /// restyles the shown highlight without highlighting again.
    pub fn syntax_theme(&self, theme: SyntaxTheme) -> Self {
        if **self.0.syntax.borrow() != theme {
            self.0.restyle(Arc::new(theme), self.0.fg.get());
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
    /// [`Self::code`] leaves it out, and the widget's next write, from [`Self::set_code`], [`Self::append`], a
    /// [`Self::filetype`] change, or highlighting, replaces it with the source. Highlighting sets layer 1; highlights
    /// of priority 0 paint under it.
    pub fn buffer(&self) -> &TextBuffer {
        &self.0.buffer
    }
}

#[cfg(all(test, feature = "tree-sitter"))]
pub(crate) mod tests {
    use super::*;
    use crate::native::Capture;
    use crate::syntax;
    use crate::testing::TestApp;
    use crate::widget::Container;

    thread_local! {
        /// Whether highlight threads fail to start on this thread, as under a process limit.
        pub(crate) static DENY_THREADS: Cell<bool> = const { Cell::new(false) };
    }

    /// Renders until no code view has a highlight running or due, and returns the frame.
    pub(crate) fn settle(app: &TestApp, codes: &[Code]) -> Capture {
        for _ in 0..10_000 {
            let capture = app.render();
            if codes.iter().all(|code| !code.0.stale.get() && code.0.pending.borrow().is_none()) {
                return capture;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        panic!("a highlight never landed");
    }

    // Another view of a code view's buffer keeps its syntax colors after the code view is gone: the buffer holds the
    // style table it is bound to (bigboi-3).
    #[test]
    fn a_buffer_keeps_its_style_table_after_its_code_view_drops() {
        let app = TestApp::new(12, 1);
        let theme = SyntaxTheme::new().style("keyword", Style::new().fg(Color::RED));
        let code = Code::new(&app).filetype("rust").syntax_theme(theme).set_code("let a = 1;");
        app.root().add(&code);
        app.render();
        let view = TextView::new(code.buffer()).unwrap();
        let other = build(&app, NodeKind::TextView, |element| CodeText { element, code: Weak::new() });
        other.element.apply(|node| node.set_text_view(Some(&view)));
        other.element.set_layout(LayoutProperty::Width(Length::Cells(12.0)));
        code.element().detach();
        drop(code);
        app.root().element().insert(&other.element, None);
        assert_eq!(app.render().cell(0, 0).unwrap().fg, Color::RED);
    }

    // Rust, JavaScript and Markdown pieces, balanced ones and openers alone; a CR and an LF also arrive apart.
    const PIECES: &[&str] = &[
        "/*",
        "{",
        "`",
        " => x",
        "let ",
        "fn f() {",
        "}",
        "x",
        " = ",
        "1",
        "\"s\\n\"",
        "// c",
        "/* b */",
        "\t",
        "\n",
        "\r\n",
        "\r",
        "\u{65e5}",
        "\u{e9}",
        "# h",
        "*e*",
        "```rust\n",
        ";",
        "\"a\\n\u{fe0f}\"",
        "\u{301}",
    ];

    // P12 and C4 invariants 1, 2, 4, 8, 9 and 10: every frame equals a buffer written with the styled text of the
    // highlighted start of the source and the rest plain, as the styled-ranges view painted it, over appends (CRLF
    // whole and split), replacements, filetype and theme changes, and writes through `buffer()` before an append or
    // while a highlight runs; a settled view highlights all its text. The styled text is a fresh highlight's, or
    // where a fresh parse has an error, the view's own tree's. Since its last replacement, a settled view handed its
    // highlights each byte once and parsed without a tree once.
    #[test]
    fn capture_layers_paint_as_styled_text_of_the_highlighted_start() {
        let injective = syntax::injective_theme();
        let (mut compared, mut erroneous, mut own_differs) = (0, 0, 0);
        for seed in 1..=300u64 {
            let mut state = seed.wrapping_mul(0x9e37_79b9_7f4a_7c15);
            let mut next = |bound: usize| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state % bound as u64) as usize
            };
            let (app, fresh) = (TestApp::new(24, 6), TestApp::new(24, 6));
            let red = Style::new().fg(Color::RED);
            let nested = SyntaxTheme::new()
                .style("default", Style::new().fg(Color::GREEN).italic())
                .style("punctuation", Style::new().bg(Color::BLUE))
                .style("string", red.bold())
                .style("markup", Style::new().fg(Color::YELLOW).dim())
                .style("markup.heading", Style::new().strikethrough());
            let themes = [
                injective.clone(),
                SyntaxTheme::from_theme(&app.theme()),
                nested.clone(),
                nested.first_part_fallback(),
            ];
            let code = Code::new(&app).filetype("rust").syntax_theme(themes[0].clone());
            let twin = Code::new(&fresh);
            app.root().add(&code);
            fresh.root().add(&twin);
            // The theme the reference takes its styles and defaults from, never through the view under test.
            let theme = RefCell::new(themes[0].clone());
            // The bytes handed to highlights at the last replacement, which starts the highlighter afresh, and the
            // parses without a tree on this thread since. Only `compare` and a write by another caller render, and
            // that write's append replaces the text too.
            let mut replaced = (0, 0);
            let mut compare = |settled: bool| {
                if code.0.highlighted.get().is_none() && code.0.pending.borrow().is_none() {
                    replaced = (code.0.handed.get(), 0);
                }
                let parses = syntax::FRESH_PARSES.get();
                let got = if settled { settle(&app, std::slice::from_ref(&code)) } else { app.render() };
                replaced.1 += syntax::FRESH_PARSES.get() - parses;
                let source = code.code();
                let filetype = code.0.filetype.borrow().clone();
                let start = code.0.highlighted.get().unwrap_or(0);
                let own = code.0.incremental.borrow();
                let expected = |own: Option<&Incremental>| {
                    let filetype = filetype.as_deref()?;
                    syntax::expected_ranges(&source[..start], filetype, own, &theme.borrow())
                };
                let (ranges, error) = expected(None).unwrap_or_default();
                if settled && filetype.as_deref().is_some_and(syntax::has_grammar) {
                    assert_eq!(start, source.len(), "seed {seed}: settled with a plain tail");
                    let since = (code.0.handed.get() - replaced.0, replaced.1, own.is_some());
                    assert_eq!(since, (source.len(), 1, true), "seed {seed}: highlights since {source:?} was replaced");
                } else if settled {
                    // Without a grammar nothing is copied for a highlight (bigboi-2).
                    assert_eq!((own.is_none(), code.0.handed.get()), (true, replaced.0), "seed {seed}: plain text");
                }
                let paint = |ranges: Vec<(std::ops::Range<usize>, Style)>| {
                    let mut spans: Vec<Span<'static>> = ranges
                        .into_iter()
                        .map(|(range, style)| Span::styled(source[range].to_owned(), style))
                        .collect();
                    spans.push(Span::raw(source[start..].to_owned()));
                    twin.buffer().set_spans(&spans).unwrap();
                    fresh.render()
                };
                let mut want = paint(ranges);
                if error && want.cells != got.cells {
                    // Where a fresh parse has an error, the view's own tree, which a running highlight holds.
                    let Some(own) = own.as_ref() else { return };
                    want = paint(expected(Some(own)).expect("a grammar").0);
                    own_differs += 1;
                }
                erroneous += usize::from(error);
                let differ = want.cells.iter().zip(&got.cells).position(|(want, got)| want != got);
                assert!(differ.is_none(), "seed {seed} cell {differ:?}: {source:?} from {start}");
                compared += 1;
            };
            match seed {
                1 => {
                    // A registered capture that ends on the CR of a CRLF: its piece is that CR alone, empty in the
                    // buffer's bytes (bigboi-5).
                    let query = "(line_comment) @comment \"//\" @punctuation";
                    syntax::register("c4-crlf", syntax::Grammar::new(tree_sitter_rust::LANGUAGE, query)).unwrap();
                    code.filetype("c4-crlf").set_code("//\r\nlet x = 42;");
                    compare(true);
                }
                2 => {
                    // Review-bigboi-r2's append: ` => x` turns `f` on the line before into a function.
                    code.filetype("javascript").set_code("const f =\n  (x)");
                    compare(true);
                    code.append(" => x");
                    compare(true);
                }
                _ => {}
            }
            // Seed 3 highlights with every worker thread failing to start (bigboi-5).
            DENY_THREADS.set(seed == 3);
            for _ in 0..40 {
                match next(12) {
                    0..=4 => drop(code.append(PIECES[next(PIECES.len())])),
                    5 => drop(code.set_code((0..next(8)).map(|_| PIECES[next(PIECES.len())]).collect::<String>())),
                    6 => {
                        drop(code.filetype(
                            [Some("rust"), Some("markdown"), Some("javascript"), Some("cobol"), None][next(5)],
                        ))
                    }
                    7 => {
                        let next = themes[next(themes.len())].clone();
                        let defaults =
                            Style::new().fg(fresh.theme().foreground).patch(next.get("default").unwrap_or_default());
                        twin.buffer().set_defaults(defaults).unwrap();
                        code.syntax_theme(next.clone());
                        *theme.borrow_mut() = next;
                    }
                    8 => {
                        // Another caller writes the buffer: the next append, or the running highlight's landing,
                        // writes the source again.
                        app.render();
                        if next(2) == 0 { code.buffer().append("!") } else { code.buffer().clear(true) }.unwrap();
                        if code.0.pending.borrow().is_none() {
                            code.append(PIECES[next(PIECES.len())]);
                        }
                        compare(true);
                    }
                    9 => compare(false),
                    _ => compare(true),
                }
            }
            DENY_THREADS.set(false);
        }
        println!("C4 1b on {erroneous} of {compared} frames; the view's own tree painted otherwise on {own_differs}");
        assert!(compared > 3500 && erroneous * 4 < compared * 3, "{compared} compared, {erroneous} with errors");
    }
}
