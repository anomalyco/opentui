//! Widgets: retained handles over native scene nodes.
//!
//! Every widget is a cheap [`Clone`] handle. Changing a property updates the native node immediately and schedules
//! a redraw. Property methods take `&self` and return a new handle, so the same method configures a widget while it
//! is built and changes it later:
//!
//! ```no_run
//! # use opentui::prelude::*;
//! # let app = App::new(AppOptions::default())?;
//! let status = Text::new(&app, "Ready").fg(Color::GREEN);
//! status.fg(Color::RED); // later, from an event handler
//! # Ok::<(), opentui::Error>(())
//! ```
//!
//! A parent keeps its children alive; a detached widget is destroyed when its last handle drops. Handlers may capture
//! widget handles, including the widget's own; the app breaks those cycles when it ends.

mod code;
mod content;
mod custom;
mod diff;
mod editor;
mod extmarks;
mod frame_buffer;
mod image;
mod input;
mod line_numbers;
mod markdown;
mod painter;
mod scroll;
mod select;
mod slider;
mod table;
mod tabs;
mod terminal;
mod text;
mod text_table;
mod textarea;
mod video;
mod view;

pub use code::Code;
pub use content::Content;
pub use custom::{Component, Custom};
pub use diff::{Diff, DiffColors, DiffGutter, DiffView};
pub use editor::EditorAction;
pub use extmarks::{Extmark, ExtmarkId, ExtmarkOptions};
pub use frame_buffer::FrameBuffer;
pub use image::ImageView;
pub use input::Input;
pub use line_numbers::{LineColor, LineNumbers, LineSign};
pub use markdown::{
    CodeBlock, InlineContext, InlineSpan, Markdown, MarkdownColors, MarkdownExtension, MarkdownTableOptions,
    MarkdownTableStyle,
};
pub use painter::Painter;
pub use scroll::{LinearScroll, MacOsScroll, ScrollAcceleration, ScrollAction, ScrollBox, ScrollEdge};
pub use select::{Select, SelectAction, SelectOption};
pub use slider::{Slider, SliderAction};
pub use table::{Column, ColumnWidth, Table, TableAction};
pub use tabs::{TabSelect, TabSelectAction};
pub use terminal::{TerminalData, TerminalScreen, TerminalView};
pub use text::Text;
pub use text_table::{ColumnFitter, ColumnWidthMode, TextTable};
pub use textarea::Textarea;
pub use video::{VideoEvent, VideoView};
pub use view::View;

// Native types that widget methods take or return, so the widget layer needs no `native` imports.
pub use crate::native::{
    Constraint, CursorStyle, EmbeddedTerminalOptions, Image, ImageFit, ImageProtocol, MousePointer, SelectionColors,
    TerminalCursor, VideoInfo, VideoState, WrapMode,
};

use crate::app::{AnimationTick, App, AppInner, Cx, HandlerId, Tick};
use crate::error::Result;
use crate::input::{KeyEvent, MouseEvent};
use crate::layout::{
    Align, Display, Edge, FlexDirection, Gutter, Justify, LayoutMode, LayoutProperty, Length, Overflow, PositionType,
    Rect, Wrap,
};
use crate::native::{BoxDetails, Hooks, Node, NodeKind, Observation, Paint, SelectionUnit, TextOptions};
use crate::post::{Filter, FilterCell, FilterId};
use crate::style::{Alignment, Color};
use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};
use std::time::Duration;

/// A list of handlers for one kind of event. Emitting snapshots the list, so handlers may add and remove handlers.
type Handler<A> = Rc<RefCell<dyn FnMut(&mut Cx<'_>, &A)>>;

pub(crate) struct Callbacks<A: ?Sized>(RefCell<Vec<(HandlerId, Handler<A>)>>);

impl<A: ?Sized> Default for Callbacks<A> {
    fn default() -> Self {
        Self(RefCell::new(Vec::new()))
    }
}

impl<A: ?Sized> Callbacks<A> {
    pub fn add(&self, handler: impl FnMut(&mut Cx<'_>, &A) + 'static) -> HandlerId {
        let id = HandlerId::next();
        self.0.borrow_mut().push((id, Rc::new(RefCell::new(handler))));
        id
    }

    /// Removes a handler. Returns whether it was in the list.
    pub fn remove(&self, id: HandlerId) -> bool {
        let removed = {
            let mut handlers = self.0.borrow_mut();
            handlers.iter().position(|(entry, _)| *entry == id).map(|index| handlers.remove(index))
        };
        removed.is_some()
    }

    pub fn is_empty(&self) -> bool {
        self.0.borrow().is_empty()
    }

    /// Calls every handler until one stops propagation. A handler that is already running, or that an earlier
    /// handler removed, is skipped.
    pub fn emit(&self, cx: &mut Cx<'_>, argument: &A) {
        let handlers = self.0.borrow().clone();
        for (id, handler) in handlers {
            if cx.is_stopped() {
                return;
            }
            if !self.0.borrow().iter().any(|(entry, _)| *entry == id) {
                continue;
            }
            if let Ok(mut handler) = handler.try_borrow_mut() {
                handler(cx, argument);
            }
        }
    }

    pub fn clear(&self) {
        self.0.borrow_mut().clear();
    }
}

/// User handlers every element supports.
#[derive(Default)]
pub(crate) struct Handlers {
    pub key: Callbacks<KeyEvent>,
    pub paste: Callbacks<str>,
    pub mouse: Callbacks<MouseEvent>,
    pub hover: Callbacks<bool>,
    pub focus: Callbacks<bool>,
    pub resize: Callbacks<Rect>,
    pub drag_over: Callbacks<(AnyWidget, bool)>,
    pub drop: Callbacks<(AnyWidget, MouseEvent)>,
}

impl Handlers {
    fn clear(&self) {
        self.drag_over.clear();
        self.drop.clear();
        self.key.clear();
        self.paste.clear();
        self.mouse.clear();
        self.hover.clear();
        self.focus.clear();
        self.resize.clear();
    }
}

/// Widget behavior the app calls during dispatch and frames. Built-in widgets implement it on their shared state.
pub(crate) trait Behavior: 'static {
    fn element(&self) -> &Element;

    /// Built-in key handling. Returns whether the key was consumed.
    fn key(&self, _cx: &mut Cx<'_>, _key: &KeyEvent) -> bool {
        false
    }

    fn paste(&self, _cx: &mut Cx<'_>, _text: &str) -> bool {
        false
    }

    /// Built-in mouse handling, with screen coordinates. Returns whether the event was consumed.
    fn mouse(&self, _cx: &mut Cx<'_>, _event: &MouseEvent) -> bool {
        false
    }

    fn focus_changed(&self, _cx: &mut Cx<'_>, _focused: bool) {}

    /// Runs once per frame while the element registers [`Hooks::UPDATE`].
    fn update(&self, _cx: &mut Cx<'_>) {}

    /// Runs during a frame when the node's size changes, while it registers [`Hooks::RESIZE`].
    fn resized(&self, _cx: &mut Cx<'_>, _width: u32, _height: u32) {}

    /// Records drawing while the element registers paint hooks.
    fn paint(&self, _painter: &mut Painter<'_>) {}

    /// Whether a left press on this widget starts a mouse text selection.
    fn selectable(&self) -> bool {
        false
    }

    /// Whether a left press at a screen cell starts a selection on this selectable widget. Anywhere, by default.
    fn starts_selection(&self, _x: i32, _y: i32) -> bool {
        true
    }

    /// Applies the app's mouse text selection to this widget, or clears its selection with `None`. Returns whether
    /// the widget now holds selected text.
    fn select(&self, _selection: Option<&SelectionUpdate>) -> bool {
        false
    }

    /// The widget's selected text, if it holds any.
    fn selected_text(&self) -> Option<String> {
        None
    }

    /// The lines a text widget shows, so [`LineNumbers`] can follow it.
    fn visible_lines(&self) -> Option<VisibleLines> {
        None
    }

    /// Drops widget-specific handlers when the app ends, breaking cycles through captured handles.
    fn teardown(&self) {}
}

/// A text widget's logical line count and the source of each row it shows, from its first visible row.
#[derive(Clone, Debug, Default)]
pub(crate) struct VisibleLines {
    pub line_count: u32,
    pub rows: Vec<crate::native::VisualLine>,
}

/// The app's mouse text selection, in screen cells, as one selectable widget sees it.
#[derive(Clone, Copy, Debug)]
pub(crate) struct SelectionUpdate {
    pub anchor: (i32, i32),
    pub focus: (i32, i32),
    /// A new selection: the widget replaces its selection instead of extending it.
    pub start: bool,
    pub unit: SelectionUnit,
}

impl SelectionUpdate {
    /// The anchor and focus relative to an element's top-left cell.
    pub fn local(&self, element: &Element) -> ((i32, i32), (i32, i32)) {
        let rect = element.rect();
        let (x, y) = (rect.screen_x.trunc() as i32, rect.screen_y.trunc() as i32);
        ((self.anchor.0 - x, self.anchor.1 - y), (self.focus.0 - x, self.focus.1 - y))
    }

    pub fn local_selection(&self, element: &Element) -> LocalSelection {
        let (anchor, focus) = self.local(element);
        LocalSelection { anchor, focus, unit: self.unit }
    }
}

/// The app's selection relative to a widget's top-left cell. Text widgets keep the last one and apply it again when
/// their content changes, as Core's do.
#[derive(Clone, Copy, Debug)]
pub(crate) struct LocalSelection {
    pub anchor: (i32, i32),
    pub focus: (i32, i32),
    pub unit: SelectionUnit,
}

/// Owned box titles, so the element can resend all box details after one changes.
#[derive(Clone, Debug, Default)]
pub(crate) struct Titles {
    pub title: String,
    pub title_alignment: Alignment,
    pub bottom_title: String,
    pub bottom_title_alignment: Alignment,
    pub title_color: Option<Color>,
    pub border_chars: Option<[char; 11]>,
}

/// The shared record behind every widget handle: its native node, tree links, handlers, and cached native options.
///
/// Build composite widgets by implementing [`Widget::element`] with an inner widget's element.
pub struct Element {
    app: Weak<AppInner>,
    node: Option<Node>,
    num: u32,
    root: bool,
    this: Weak<dyn Behavior>,
    parent: RefCell<Option<Weak<dyn Behavior>>>,
    children: RefCell<Vec<Rc<dyn Behavior>>>,
    pub(crate) handlers: Handlers,
    focusable: Cell<bool>,
    visible: Cell<bool>,
    paint: Cell<Paint>,
    text_options: Cell<TextOptions>,
    /// Whether code outside the setters may have written the native node through [`Self::node`], so the cached
    /// values above no longer show its state and setters write even an equal value.
    bypassed: Cell<bool>,
    titles: RefCell<Titles>,
    /// The hooks the widget itself registers; filters add [`Hooks::RENDER_BEFORE`] to learn the painted area.
    hooks: Cell<Hooks>,
    registered: Cell<Hooks>,
    hook_generation: Cell<u64>,
    pub(crate) pointer: Cell<Option<MousePointer>>,
    pub(crate) filters: RefCell<Vec<Rc<FilterCell>>>,
}

impl Drop for Element {
    fn drop(&mut self) {
        if let Some(app) = self.app.upgrade() {
            app.unregister(self.num);
            App::from_inner(app).end_widget_ticks(self.num);
        }
    }
}

impl Element {
    /// Creates the element and its native node. A native failure is reported to the app; the element then does
    /// nothing.
    pub(crate) fn new(app: &App, kind: NodeKind, this: Weak<dyn Behavior>) -> Self {
        let num = app.inner().allocate_num();
        let node = app.report(Node::new(app.synced_session(), kind, num));
        Self {
            app: Rc::downgrade(app.inner()),
            node,
            num,
            root: kind == NodeKind::Root,
            this,
            parent: RefCell::new(None),
            children: RefCell::new(Vec::new()),
            handlers: Handlers::default(),
            focusable: Cell::new(false),
            visible: Cell::new(true),
            paint: Cell::new(Paint::default()),
            text_options: Cell::new(TextOptions::default()),
            bypassed: Cell::new(false),
            titles: RefCell::new(Titles::default()),
            hooks: Cell::new(Hooks::NONE),
            registered: Cell::new(Hooks::NONE),
            hook_generation: Cell::new(0),
            pointer: Cell::new(None),
            filters: RefCell::new(Vec::new()),
        }
    }

    /// Registers the element's widget with its app so hit tests and frame hooks can find it.
    pub(crate) fn register(&self) {
        if let (Some(app), Some(this)) = (self.app.upgrade(), self.this.upgrade()) {
            app.register(self.num, Rc::downgrade(&this));
        }
    }

    /// The widget's public number: unique within its app and stable for its lifetime.
    pub fn id(&self) -> u32 {
        self.num
    }

    /// Whether the widget edits text ([`Input`] or [`Textarea`]), as Core's
    /// `currentFocusedEditor` counts them.
    pub fn is_editor(&self) -> bool {
        self.node.as_ref().is_some_and(|node| node.kind() == NodeKind::Editor)
    }

    pub(crate) fn app(&self) -> Option<App> {
        self.app.upgrade().map(App::from_inner)
    }

    /// The native node. A caller may write it directly, so the element stops trusting its cached values.
    pub(crate) fn node(&self) -> Option<&Node> {
        self.bypassed.set(true);
        self.node.as_ref()
    }

    /// Whether a setter may skip a value equal to the cached one.
    pub(crate) fn cached(&self) -> bool {
        !self.bypassed.get()
    }

    pub(crate) fn behavior(&self) -> Option<Rc<dyn Behavior>> {
        self.this.upgrade()
    }

    pub(crate) fn behavior_weak(&self) -> &Weak<dyn Behavior> {
        &self.this
    }

    /// Runs a native mutation, reports a failure to the app, and schedules a redraw.
    pub(crate) fn apply(&self, mutation: impl FnOnce(&Node) -> Result<()>) {
        let Some(node) = &self.node else { return };
        let result = mutation(node);
        if let Some(app) = self.app() {
            app.report(result);
            app.request_redraw();
        }
    }

    /// Runs a native query, reporting a failure to the app.
    pub(crate) fn query<T>(&self, query: impl FnOnce(&Node) -> Result<T>) -> Option<T> {
        let node = self.node.as_ref()?;
        let result = query(node);
        match self.app() {
            Some(app) => app.report(result),
            None => result.ok(),
        }
    }

    pub(crate) fn set_layout(&self, property: LayoutProperty) {
        self.apply(|node| node.set_layout(property));
    }

    pub(crate) fn update_paint(&self, change: impl FnOnce(&mut Paint)) {
        let mut paint = self.paint.get();
        change(&mut paint);
        if self.cached() && paint == self.paint.get() {
            return;
        }
        self.paint.set(paint);
        self.apply(|node| node.set_paint(&paint));
    }

    pub(crate) fn update_text_options(&self, change: impl FnOnce(&mut TextOptions)) {
        let mut options = self.text_options.get();
        change(&mut options);
        if self.cached() && options == self.text_options.get() {
            return;
        }
        self.text_options.set(options);
        self.apply(|node| node.set_text_options(&options));
    }

    pub(crate) fn update_titles(&self, change: impl FnOnce(&mut Titles)) {
        let titles = {
            let mut titles = self.titles.borrow_mut();
            change(&mut titles);
            titles.clone()
        };
        self.apply(|node| {
            node.set_box_details(&BoxDetails {
                title: &titles.title,
                title_alignment: titles.title_alignment,
                bottom_title: &titles.bottom_title,
                bottom_title_alignment: titles.bottom_title_alignment,
                title_color: titles.title_color,
                border_chars: titles.border_chars,
            })
        });
    }

    /// Adds frame hooks to the node's registration.
    pub(crate) fn add_hooks(&self, hooks: Hooks) {
        self.hooks.set(self.hooks.get().union(hooks));
        self.sync_hooks();
    }

    /// The hooks the widget registers itself. Its own drawing records in the latest of their paint phases.
    pub(crate) fn own_hooks(&self) -> Hooks {
        self.hooks.get()
    }

    /// Registers the widget's hooks, plus a paint hook while it has filters, so each frame reports its painted area.
    /// The root cannot have paint hooks; its filters cover the whole screen.
    fn sync_hooks(&self) {
        let mut hooks = self.hooks.get();
        if !self.root && !self.filters.borrow().is_empty() {
            hooks = hooks.union(Hooks::RENDER_BEFORE);
        }
        if hooks == self.registered.get() {
            return;
        }
        self.registered.set(hooks);
        let generation = self.hook_generation.get() + 1;
        self.hook_generation.set(generation);
        self.apply(|node| node.set_hooks(hooks, generation, (0.0, 0.0)));
    }

    pub(crate) fn add_filter(&self, filter: Box<dyn Filter>) -> FilterId {
        let app = self.app();
        let id = FilterId(app.as_ref().map_or(0, |app| app.inner().next_filter_id()));
        let animated = filter.animated();
        let cell = Rc::new(FilterCell { id, filter: RefCell::new(filter), elapsed: Cell::new(Duration::ZERO) });
        if animated && let Some(app) = &app {
            // Runs while the filter stays attached, keeping frames coming and handing it their time.
            let attached = Rc::downgrade(&cell);
            app.animate(move |_cx, elapsed| match attached.upgrade() {
                Some(cell) => {
                    cell.elapsed.set(cell.elapsed.get().saturating_add(elapsed));
                    true
                }
                None => false,
            });
        }
        self.filters.borrow_mut().push(cell);
        self.sync_hooks();
        app.inspect(App::request_redraw);
        id
    }

    pub(crate) fn remove_filter(&self, id: FilterId) -> bool {
        let removed = {
            let mut filters = self.filters.borrow_mut();
            let count = filters.len();
            filters.retain(|cell| cell.id != id);
            filters.len() != count
        };
        if removed {
            self.sync_hooks();
            self.app().inspect(App::request_redraw);
        }
        removed
    }

    pub(crate) fn clear_filters(&self) {
        let removed = std::mem::take(&mut *self.filters.borrow_mut());
        if !removed.is_empty() {
            self.sync_hooks();
            self.app().inspect(App::request_redraw);
        }
    }

    pub(crate) fn has_filters(&self) -> bool {
        !self.filters.borrow().is_empty()
    }

    /// Whether the element can take focus: it is focusable, and neither it nor an ancestor is hidden.
    pub(crate) fn is_focusable(&self) -> bool {
        self.focusable.get() && self.is_shown()
    }

    /// Sets whether the element can take focus. Making the focused element unfocusable blurs it.
    pub(crate) fn set_focusable(&self, focusable: bool) {
        self.focusable.set(focusable);
        if !focusable
            && let Some(app) = self.app()
            && app.focused().is_some_and(|focused| focused.id() == self.num)
        {
            app.blur();
        }
    }

    pub(crate) fn is_visible(&self) -> bool {
        self.visible.get()
    }

    /// Whether this element and all its ancestors are visible.
    pub(crate) fn is_shown(&self) -> bool {
        if !self.visible.get() {
            return false;
        }
        let mut current = self.parent_behavior();
        while let Some(widget) = current {
            if !widget.element().visible.get() {
                return false;
            }
            current = widget.element().parent_behavior();
        }
        true
    }

    pub(crate) fn parent_behavior(&self) -> Option<Rc<dyn Behavior>> {
        self.parent.borrow().as_ref()?.upgrade()
    }

    pub(crate) fn child_behaviors(&self) -> Vec<Rc<dyn Behavior>> {
        self.children.borrow().clone()
    }

    /// Moves `child` under this element at `index`, or last. A child that is an ancestor is rejected natively.
    pub(crate) fn insert(&self, child: &Element, index: Option<usize>) {
        let Some(behavior) = child.behavior() else { return };
        if std::ptr::eq(child, self) {
            return;
        }
        let Some(parent_node) = &self.node else { return };
        // Positions count this parent's other children, as native moves within one parent do.
        let within = child.parent.borrow().as_ref().is_some_and(|parent| Weak::ptr_eq(parent, &self.this));
        let others = self.children.borrow().len() - usize::from(within);
        let index = index.unwrap_or(others).min(others);
        // Change the Rust tree only after native code accepts the move, so a rejected move changes nothing.
        let result = child.node.as_ref().map_or(Ok(()), |node| node.insert_into(parent_node, index as u32));
        let accepted = result.is_ok();
        let app = self.app();
        if let Some(app) = &app {
            app.report(result);
            app.request_redraw();
        }
        if !accepted {
            return;
        }
        child.detach_from_parent();
        self.children.borrow_mut().insert(index, behavior);
        *child.parent.borrow_mut() = Some(self.this.clone());
        if let Some(app) = app
            && !self.is_shown()
        {
            app.subtree_hidden(child);
        }
    }

    fn detach_from_parent(&self) {
        let parent = self.parent.borrow_mut().take().and_then(|weak| weak.upgrade());
        if let Some(parent) = parent {
            let mut children = parent.element().children.borrow_mut();
            if let Some(index) = children.iter().position(|child| child.element().num == self.num) {
                children.remove(index);
            }
        }
    }

    /// Removes this element from its parent. It is destroyed once no handle refers to it.
    pub(crate) fn detach(&self) {
        let had_parent = self.parent.borrow().is_some();
        self.detach_from_parent();
        if had_parent {
            self.apply(Node::detach);
            if let Some(app) = self.app() {
                app.subtree_removed(self);
            }
        }
    }

    pub(crate) fn clear_children(&self) {
        let Some(node) = &self.node else { return };
        if self.children.borrow().is_empty() {
            return;
        }
        // Native code detaches every child in one pass, or none on error; the Rust tree follows only on success.
        let result = node.clear_children();
        let accepted = result.is_ok();
        let app = self.app();
        if let Some(app) = &app {
            app.report(result);
            app.request_redraw();
        }
        if !accepted {
            return;
        }
        let children = std::mem::take(&mut *self.children.borrow_mut());
        for child in children {
            *child.element().parent.borrow_mut() = None;
            if let Some(app) = &app {
                app.subtree_removed(child.element());
            }
        }
    }

    /// Whether `ancestor` is this element or one of its ancestors.
    pub(crate) fn is_within(&self, ancestor: &Element) -> bool {
        if self.num == ancestor.num {
            return true;
        }
        let mut current = self.parent_behavior();
        while let Some(element) = current {
            if element.element().num == ancestor.num {
                return true;
            }
            current = element.element().parent_behavior();
        }
        false
    }

    /// Clears handlers and children recursively, breaking reference cycles that handlers create.
    pub(crate) fn teardown(&self) {
        self.handlers.clear();
        self.filters.borrow_mut().clear();
        let children = std::mem::take(&mut *self.children.borrow_mut());
        for child in children {
            child.element().teardown();
        }
    }

    /// The geometry from the latest frame, in cells. Screen coordinates are absolute.
    pub fn rect(&self) -> Rect {
        self.query(|node| node.layout(Observation::Public)).unwrap_or_default()
    }

    fn set_visible(&self, visible: bool) {
        if self.cached() && visible == self.visible.get() {
            return;
        }
        self.visible.set(visible);
        self.set_layout(LayoutProperty::Display(if visible { Display::Flex } else { Display::None }));
        if !visible && let Some(app) = self.app() {
            app.subtree_hidden(self);
        }
    }
}

/// A type-erased widget handle, as returned by [`App::focused`].
#[derive(Clone)]
pub struct AnyWidget(pub(crate) Rc<dyn Behavior>);

impl AnyWidget {
    /// Whether this is the same widget as `other`.
    pub fn is(&self, other: &impl Widget) -> bool {
        self.id() == other.id()
    }
}

impl PartialEq for AnyWidget {
    fn eq(&self, other: &Self) -> bool {
        self.id() == other.id()
    }
}

impl Eq for AnyWidget {}

impl std::hash::Hash for AnyWidget {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.id().hash(state);
    }
}

impl std::fmt::Debug for AnyWidget {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_tuple("AnyWidget").field(&self.id()).finish()
    }
}

impl Widget for AnyWidget {
    fn element(&self) -> &Element {
        self.0.element()
    }
}

/// Layout, focus, and event methods shared by every widget.
///
/// Methods that set a property take `&self` and return a clone of the handle, so they chain while building and work
/// on their own later. Lengths accept integers as cells, or [`Length`] values such as `Length::percent(50.0)`.
pub trait Widget: Clone + 'static {
    /// The shared element. Composite widgets return an inner widget's element.
    fn element(&self) -> &Element;

    /// The widget's public number: unique within its app and stable for its lifetime.
    fn id(&self) -> u32 {
        self.element().id()
    }

    /// The geometry from the latest frame. Screen coordinates are absolute cells.
    fn rect(&self) -> Rect {
        self.element().rect()
    }

    fn parent(&self) -> Option<AnyWidget> {
        self.element().parent_behavior().map(AnyWidget)
    }

    /// Removes the widget from its parent. It is destroyed once no handle refers to it.
    fn detach(&self) {
        self.element().detach();
    }

    fn as_any(&self) -> AnyWidget {
        AnyWidget(self.element().behavior().expect("a live widget has a behavior"))
    }

    /// [`App::on_animation_tick`] while this widget is drawn, as Core's `animationFps`: a hidden, detached, or culled
    /// widget wakes the app at most twice more, then not until a frame draws it again, which resumes the ticks. The
    /// animation also ends when the widget drops.
    fn on_animation_tick(&self, fps: f64, callback: impl FnMut(&mut Cx<'_>, Tick) + 'static) -> AnimationTick {
        let element = self.element();
        let Some(app) = element.app() else { return AnimationTick::ended() };
        // Each frame that draws the widget sends it an update.
        element.add_hooks(Hooks::UPDATE);
        app.subscribe_tick(fps, Some(element.num), callback)
    }

    // Layout.

    fn width(&self, width: impl Into<Length>) -> Self {
        self.element().set_layout(LayoutProperty::Width(width.into()));
        self.clone()
    }

    fn height(&self, height: impl Into<Length>) -> Self {
        self.element().set_layout(LayoutProperty::Height(height.into()));
        self.clone()
    }

    fn size(&self, width: impl Into<Length>, height: impl Into<Length>) -> Self {
        self.width(width).height(height)
    }

    fn min_width(&self, width: impl Into<Length>) -> Self {
        self.element().set_layout(LayoutProperty::MinWidth(width.into()));
        self.clone()
    }

    fn min_height(&self, height: impl Into<Length>) -> Self {
        self.element().set_layout(LayoutProperty::MinHeight(height.into()));
        self.clone()
    }

    fn max_width(&self, width: impl Into<Length>) -> Self {
        self.element().set_layout(LayoutProperty::MaxWidth(width.into()));
        self.clone()
    }

    fn max_height(&self, height: impl Into<Length>) -> Self {
        self.element().set_layout(LayoutProperty::MaxHeight(height.into()));
        self.clone()
    }

    /// Fills free space along the parent's main axis, shared with other growing siblings by factor.
    ///
    /// Like CSS `flex: <factor>`, this also sets the flex basis to zero, so growing widgets split space by factor
    /// whatever their content, and long content scrolls or clips instead of squeezing siblings. Call
    /// [`Self::basis`] afterwards to start from another size. A factor of zero restores the automatic basis.
    fn grow(&self, factor: f32) -> Self {
        let element = self.element();
        element.set_layout(LayoutProperty::FlexGrow(factor));
        element.set_layout(LayoutProperty::FlexBasis(if factor > 0.0 { Length::Cells(0.0) } else { Length::Auto }));
        self.clone()
    }

    fn shrink(&self, factor: f32) -> Self {
        self.element().set_layout(LayoutProperty::FlexShrink(factor));
        self.clone()
    }

    fn basis(&self, basis: impl Into<Length>) -> Self {
        self.element().set_layout(LayoutProperty::FlexBasis(basis.into()));
        self.clone()
    }

    /// Lays out children left to right.
    fn row(&self) -> Self {
        self.direction(FlexDirection::Row)
    }

    /// Lays out children top to bottom, the default.
    fn column(&self) -> Self {
        self.direction(FlexDirection::Column)
    }

    fn direction(&self, direction: FlexDirection) -> Self {
        self.element().set_layout(LayoutProperty::FlexDirection(direction));
        self.clone()
    }

    fn justify(&self, justify: Justify) -> Self {
        self.element().set_layout(LayoutProperty::JustifyContent(justify));
        self.clone()
    }

    fn align_items(&self, align: Align) -> Self {
        self.element().set_layout(LayoutProperty::AlignItems(align));
        self.clone()
    }

    fn align_self(&self, align: Align) -> Self {
        self.element().set_layout(LayoutProperty::AlignSelf(align));
        self.clone()
    }

    fn align_content(&self, align: Align) -> Self {
        self.element().set_layout(LayoutProperty::AlignContent(align));
        self.clone()
    }

    fn flex_wrap(&self, wrap: Wrap) -> Self {
        self.element().set_layout(LayoutProperty::FlexWrap(wrap));
        self.clone()
    }

    /// [`LayoutMode::List`] stacks children without a flex pass over them, for long scrolling content.
    fn layout_mode(&self, mode: LayoutMode) -> Self {
        self.element().set_layout(LayoutProperty::LayoutMode(mode));
        self.clone()
    }

    /// Space between children, in both directions.
    fn gap(&self, gap: impl Into<Length>) -> Self {
        self.element().set_layout(LayoutProperty::Gap(Gutter::All, gap.into()));
        self.clone()
    }

    /// Space between columns: between children of a row, or between wrapped lines of a column.
    fn column_gap(&self, gap: impl Into<Length>) -> Self {
        self.element().set_layout(LayoutProperty::Gap(Gutter::Column, gap.into()));
        self.clone()
    }

    /// Space between rows: between children of a column, or between wrapped lines of a row.
    fn row_gap(&self, gap: impl Into<Length>) -> Self {
        self.element().set_layout(LayoutProperty::Gap(Gutter::Row, gap.into()));
        self.clone()
    }

    fn padding(&self, padding: impl Into<Length>) -> Self {
        self.padding_edge(Edge::All, padding)
    }

    /// Left and right padding.
    fn padding_x(&self, padding: impl Into<Length>) -> Self {
        self.padding_edge(Edge::Horizontal, padding)
    }

    /// Top and bottom padding.
    fn padding_y(&self, padding: impl Into<Length>) -> Self {
        self.padding_edge(Edge::Vertical, padding)
    }

    fn padding_edge(&self, edge: Edge, padding: impl Into<Length>) -> Self {
        self.element().set_layout(LayoutProperty::Padding(edge, padding.into()));
        self.clone()
    }

    fn margin(&self, margin: impl Into<Length>) -> Self {
        self.margin_edge(Edge::All, margin)
    }

    fn margin_x(&self, margin: impl Into<Length>) -> Self {
        self.margin_edge(Edge::Horizontal, margin)
    }

    fn margin_y(&self, margin: impl Into<Length>) -> Self {
        self.margin_edge(Edge::Vertical, margin)
    }

    fn margin_edge(&self, edge: Edge, margin: impl Into<Length>) -> Self {
        self.element().set_layout(LayoutProperty::Margin(edge, margin.into()));
        self.clone()
    }

    /// Takes the widget out of the flex flow; place it with [`Self::position`].
    fn absolute(&self) -> Self {
        self.element().set_layout(LayoutProperty::PositionType(PositionType::Absolute));
        self.clone()
    }

    /// Offsets one edge, relative to the parent for absolute widgets.
    fn position(&self, edge: Edge, offset: impl Into<Length>) -> Self {
        self.element().set_layout(LayoutProperty::Position(edge, offset.into()));
        self.clone()
    }

    fn overflow(&self, overflow: Overflow) -> Self {
        self.element().set_layout(LayoutProperty::Overflow(overflow));
        self.clone()
    }

    /// Shows or hides the widget. Hidden widgets take no space, receive no events, and lose focus.
    fn visible(&self, visible: bool) -> Self {
        self.element().set_visible(visible);
        self.clone()
    }

    /// Whether the widget's own visibility flag is set; see [`Self::is_shown`] for its ancestors too.
    fn is_visible(&self) -> bool {
        self.element().is_visible()
    }

    /// Whether the widget and all its ancestors are visible, so it can appear on screen.
    fn is_shown(&self) -> bool {
        self.element().is_shown()
    }

    // Paint.

    /// Paint order among siblings. On a tie, the later child paints above and receives clicks at the overlap.
    fn z_index(&self, z_index: i32) -> Self {
        self.element().update_paint(|paint| paint.z_index = z_index);
        self.clone()
    }

    /// Opacity from 0 through 1, multiplied with the parent's.
    fn opacity(&self, opacity: f32) -> Self {
        self.element().update_paint(|paint| paint.opacity = opacity);
        self.clone()
    }

    /// Offset in cells applied after layout. Children move along.
    fn translate(&self, x: f64, y: f64) -> Self {
        self.element().update_paint(|paint| paint.translate = (x, y));
        self.clone()
    }

    // Post-processing.

    /// Adds a post-processing [`Filter`] for the widget's area, as [`Self::add_filter`] does, and returns the
    /// widget.
    ///
    /// ```no_run
    /// # use opentui::prelude::*;
    /// # let app = App::new(AppOptions::default())?;
    /// let disabled = View::new(&app).border(BorderStyle::Single).filter(ColorMatrix::GRAYSCALE.strength(0.8));
    /// # Ok::<(), opentui::Error>(())
    /// ```
    fn filter(&self, filter: impl Filter) -> Self {
        self.add_filter(filter);
        self.clone()
    }

    /// Adds a post-processing [`Filter`]: after each frame is painted, it changes the cells of the widget's area, cut
    /// by its ancestors' clips, including whatever other widgets draw over that area. Filters run in the order they
    /// were added, after those of the widget's descendants. On [`App::root`] they cover the whole screen and run
    /// last. Hidden and detached widgets are not filtered.
    ///
    /// An [animated](Filter::animated) filter keeps frames coming until it is removed.
    ///
    /// ```no_run
    /// # use opentui::prelude::*;
    /// use opentui::post::CrtRollingBar;
    /// # let app = App::new(AppOptions::default())?;
    /// let bar = app.root().add_filter(CrtRollingBar::default());
    /// // Later:
    /// app.root().remove_filter(bar);
    /// # Ok::<(), opentui::Error>(())
    /// ```
    fn add_filter(&self, filter: impl Filter) -> FilterId {
        self.element().add_filter(Box::new(filter))
    }

    /// Removes a filter added with [`Self::add_filter`]. Returns whether the widget had it.
    fn remove_filter(&self, id: FilterId) -> bool {
        self.element().remove_filter(id)
    }

    /// Removes every filter from the widget.
    fn clear_filters(&self) -> Self {
        self.element().clear_filters();
        self.clone()
    }

    // Focus.

    fn focusable(&self, focusable: bool) -> Self {
        self.element().set_focusable(focusable);
        self.clone()
    }

    fn is_focusable(&self) -> bool {
        self.element().is_focusable()
    }

    /// Gives this widget keyboard focus, if it is focusable.
    fn focus(&self) {
        if let Some(app) = self.element().app() {
            app.focus(self);
        }
    }

    fn is_focused(&self) -> bool {
        self.element().app().and_then(|app| app.focused()).is_some_and(|focused| focused.id() == self.id())
    }

    // Events.

    /// Handles keys while this widget or a descendant has focus. Runs before the widget's built-in key handling;
    /// [`Cx::prevent_default`] skips that, and [`Cx::stop_propagation`] stops the key from reaching ancestors.
    fn on_key(&self, handler: impl FnMut(&mut Cx<'_>, &KeyEvent) + 'static) -> Self {
        self.element().handlers.key.add(handler);
        self.clone()
    }

    /// Handles bracketed paste while this widget or a descendant has focus.
    fn on_paste(&self, mut handler: impl FnMut(&mut Cx<'_>, &str) + 'static) -> Self {
        self.element().handlers.paste.add(move |cx, text: &str| handler(cx, text));
        self.clone()
    }

    /// Handles mouse events over this widget or a descendant, and drags that started on it.
    fn on_mouse(&self, handler: impl FnMut(&mut Cx<'_>, &MouseEvent) + 'static) -> Self {
        self.element().handlers.mouse.add(handler);
        self.clone()
    }

    /// Handles a left click: a press and a release, both over this widget or a descendant.
    fn on_click(&self, mut handler: impl FnMut(&mut Cx<'_>, &MouseEvent) + 'static) -> Self {
        use crate::input::{MouseButton, MouseEventKind};
        let pressed = Cell::new(false);
        let this = Weak::clone(self.element().behavior_weak());
        self.element().handlers.mouse.add(move |cx, event: &MouseEvent| match event.kind {
            MouseEventKind::Down(MouseButton::Left) => pressed.set(true),
            MouseEventKind::Up(MouseButton::Left) if pressed.replace(false) => {
                // The release reaches the pressed widget wherever it happens; only one over it is a click.
                let over = this
                    .upgrade()
                    .is_some_and(|widget| widget.element().rect().contains(f64::from(event.x), f64::from(event.y)));
                if over {
                    handler(cx, event);
                }
            }
            _ => {}
        });
        self.clone()
    }

    /// The mouse pointer's shape over this widget and descendants without one of their own, in terminals that
    /// change pointer shapes (OSC 22). [`MousePointer::POINTER`] suits clickable widgets; inputs show
    /// [`MousePointer::TEXT`] by default.
    fn mouse_pointer(&self, pointer: MousePointer) -> Self {
        self.element().pointer.set(Some(pointer));
        if let Some(app) = self.element().app() {
            app.refresh_pointer();
        }
        self.clone()
    }

    /// Called with `true` when the pointer enters this widget or a descendant, and `false` when it leaves both.
    /// Needs [`MouseTracking::Motion`](crate::native::MouseTracking::Motion) for motion without a pressed button.
    fn on_hover(&self, mut handler: impl FnMut(&mut Cx<'_>, bool) + 'static) -> Self {
        self.element().handlers.hover.add(move |cx, hovered: &bool| handler(cx, *hovered));
        self.clone()
    }

    /// Called with the dragged widget and `true` when a mouse drag that started on another widget moves over this
    /// widget or a descendant, and with `false` when it leaves or the drag ends: Core's `over` and `out` events with
    /// a source. Drags that select text do not count.
    fn on_drag_over(&self, mut handler: impl FnMut(&mut Cx<'_>, &AnyWidget, bool) + 'static) -> Self {
        self.element().handlers.drag_over.add(move |cx, (source, over): &(AnyWidget, bool)| handler(cx, source, *over));
        self.clone()
    }

    /// Called when a mouse drag that started on another widget, `source`, ends with the button released over this
    /// widget or a descendant: Core's `drop` event. It bubbles from the widget under the pointer to its ancestors
    /// until a handler stops it.
    fn on_drop(&self, mut handler: impl FnMut(&mut Cx<'_>, &AnyWidget, &MouseEvent) + 'static) -> Self {
        self.element()
            .handlers
            .drop
            .add(move |cx, (source, event): &(AnyWidget, MouseEvent)| handler(cx, source, event));
        self.clone()
    }

    /// Called with `true` when this widget gains focus and `false` when it loses it.
    fn on_focus(&self, mut handler: impl FnMut(&mut Cx<'_>, bool) + 'static) -> Self {
        self.element().handlers.focus.add(move |cx, focused: &bool| handler(cx, *focused));
        self.clone()
    }

    /// Called during a frame when layout changes the widget's size.
    fn on_resize(&self, handler: impl FnMut(&mut Cx<'_>, &Rect) + 'static) -> Self {
        self.element().handlers.resize.add(handler);
        self.element().add_hooks(Hooks::RESIZE);
        self.clone()
    }
}

/// A widget that holds children.
pub trait Container: Widget {
    /// The element children attach to.
    fn content(&self) -> &Element {
        self.element()
    }

    /// Appends a child.
    fn add(&self, child: &impl Widget) -> Self {
        self.content().insert(child.element(), None);
        self.clone()
    }

    /// Appends a child, as [`Self::add`] does; reads better in builder chains.
    fn child(&self, child: &impl Widget) -> Self {
        self.add(child)
    }

    /// Inserts a child at `index`, clamped to the child count.
    fn insert(&self, index: usize, child: &impl Widget) -> Self {
        self.content().insert(child.element(), Some(index));
        self.clone()
    }

    /// Removes every child.
    fn clear(&self) -> Self {
        self.content().clear_children();
        self.clone()
    }

    fn children(&self) -> Vec<AnyWidget> {
        self.content().child_behaviors().into_iter().map(AnyWidget).collect()
    }
}

/// Creates a widget's shared state with its element, then registers it.
pub(crate) fn build<T: Behavior>(app: &App, kind: NodeKind, make: impl FnOnce(Element) -> T) -> Rc<T> {
    let inner = Rc::new_cyclic(|this: &Weak<T>| {
        let this: Weak<dyn Behavior> = this.clone();
        make(Element::new(app, kind, this))
    });
    inner.element().register();
    inner
}

/// Adds key-binding methods to a widget handle whose state has a `keymap: RefCell<Keymap<$action>>` field.
macro_rules! keymap_methods {
    ($action:ty) => {
        /// Binds `shortcut` to `action` for this widget, replacing the shortcut's earlier action.
        ///
        /// # Panics
        ///
        /// Panics if `shortcut` is a name [`Shortcut::parse`](crate::input::Shortcut::parse) rejects.
        pub fn bind(&self, shortcut: impl $crate::input::IntoShortcut, action: $action) -> Self {
            self.0.keymap.borrow_mut().insert(shortcut, action);
            self.clone()
        }

        /// Removes this widget's binding for `shortcut`, so the key reaches its ancestors and the app instead.
        ///
        /// # Panics
        ///
        /// Panics if `shortcut` is a name [`Shortcut::parse`](crate::input::Shortcut::parse) rejects.
        pub fn unbind(&self, shortcut: impl $crate::input::IntoShortcut) -> Self {
            self.0.keymap.borrow_mut().remove(shortcut);
            self.clone()
        }

        /// Replaces all of this widget's key bindings.
        pub fn set_keymap(&self, keymap: $crate::input::Keymap<$action>) -> Self {
            *self.0.keymap.borrow_mut() = keymap;
            self.clone()
        }

        /// This widget's key bindings.
        pub fn keymap(&self) -> $crate::input::Keymap<$action> {
            self.0.keymap.borrow().clone()
        }
    };
}
pub(crate) use keymap_methods;

/// Implements [`Widget`] and `Debug` for a handle type whose only field is `Rc<Inner>` with an `element` field.
macro_rules! handle {
    ($handle:ident, $inner:ident) => {
        impl $crate::widget::Widget for $handle {
            fn element(&self) -> &$crate::widget::Element {
                &self.0.element
            }
        }

        impl std::fmt::Debug for $handle {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.debug_tuple(stringify!($handle)).field(&self.0.element.id()).finish()
            }
        }
    };
}
pub(crate) use handle;
