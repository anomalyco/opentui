//! Mouse text selection across widgets, as Core's renderer does it.
//!
//! The app keeps one selection: an anchor fixed to the widget it started on and a focus that follows the pointer.
//! Every selectable widget that overlaps the rectangle between them selects its part natively. The selection starts
//! within the anchor's parent and widens to the next ancestor whenever the pointer leaves the current one, so a
//! drag inside one column of a layout does not select the next column.

use super::{App, Cx, HandlerId};
use crate::input::{Modifiers, MouseButton, MouseEvent, MouseEventKind};
use crate::layout::Rect;
use crate::native::SelectionUnit;
use crate::widget::{Behavior, Element, SelectionUpdate, Widget};
use std::rc::{Rc, Weak};
use std::time::{Duration, Instant};

/// Presses this close together, on the same widget and within a cell, count as double and triple clicks.
const CLICK_REPEAT: Duration = Duration::from_millis(500);

pub(super) struct TextSelection {
    anchor: Weak<dyn Behavior>,
    /// The anchor relative to its widget's top-left cell, so it moves with the widget when it scrolls.
    anchor_offset: (i32, i32),
    /// The anchor's screen cell at the start, used once its widget is gone.
    anchor_screen: (i32, i32),
    focus: (i32, i32),
    unit: SelectionUnit,
    dragging: bool,
    start: bool,
    /// The subtrees the selection may cover, innermost last.
    containers: Vec<Weak<dyn Behavior>>,
    touched: Vec<Weak<dyn Behavior>>,
}

impl TextSelection {
    fn anchor(&self) -> (i32, i32) {
        match self.anchor.upgrade() {
            Some(widget) => {
                let (x, y) = origin(&widget.element().rect());
                (x + self.anchor_offset.0, y + self.anchor_offset.1)
            }
            None => self.anchor_screen,
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct Click {
    time: Instant,
    x: u16,
    y: u16,
    widget: u32,
    count: u8,
}

fn origin(rect: &Rect) -> (i32, i32) {
    (rect.screen_x.trunc() as i32, rect.screen_y.trunc() as i32)
}

/// Whether a widget's cells overlap an inclusive rectangle of cells.
fn overlaps(rect: &Rect, (left, top, right, bottom): (i32, i32, i32, i32)) -> bool {
    let (x, y) = origin(rect);
    let (width, height) = (rect.width.max(0.0) as i32, rect.height.max(0.0) as i32);
    width > 0 && height > 0 && x <= right && x + width > left && y <= bottom && y + height > top
}

fn upgrade_all(widgets: &[Weak<dyn Behavior>]) -> Vec<Rc<dyn Behavior>> {
    widgets.iter().filter_map(Weak::upgrade).collect()
}

impl App {
    pub(crate) fn selection_dragging(&self) -> bool {
        self.0.selection.borrow().as_ref().is_some_and(|selection| selection.dragging)
    }

    /// The cell of the last mouse event.
    pub(crate) fn pointer(&self) -> Option<(u16, u16)> {
        self.0.pointer.get()
    }

    /// Starts or extends a selection for a left press or drag, before the event is dispatched. Returns whether the
    /// event belongs to a selection.
    pub(super) fn selection_mouse(&self, event: &MouseEvent, hit: Option<&Rc<dyn Behavior>>) -> bool {
        let point = (i32::from(event.x), i32::from(event.y));
        match event.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                // Ctrl+press extends the current selection to the pointer.
                if event.modifiers.contains(Modifiers::CTRL)
                    && let Some(selection) = self.0.selection.borrow_mut().as_mut()
                {
                    selection.dragging = true;
                } else if self.selection_dragging() || event.modifiers.contains(Modifiers::CTRL) {
                    // As in Core, Ctrl+press without a selection starts none.
                    return false;
                } else {
                    let selectable = hit
                        .and_then(|hit| {
                            std::iter::successors(Some(Rc::clone(hit)), |widget| widget.element().parent_behavior())
                                .find(|widget| widget.selectable())
                        })
                        .filter(|widget| widget.starts_selection(point.0, point.1));
                    let Some(widget) = selectable else { return false };
                    let unit = self.click_unit(&widget, event.x, event.y);
                    self.start_selection(widget, point, unit);
                    return true;
                }
                self.update_selection(hit, point);
                true
            }
            MouseEventKind::Drag(MouseButton::Left) if self.selection_dragging() => {
                self.update_selection(hit, point);
                true
            }
            _ => false,
        }
    }

    /// Re-applies a drag selection at the pointer after content scrolled under it.
    pub(crate) fn refresh_selection(&self) {
        if let (true, Some((x, y))) = (self.selection_dragging(), self.0.pointer.get()) {
            let hit = self.hit(x, y);
            self.update_selection(hit.as_ref(), (i32::from(x), i32::from(y)));
        }
    }

    /// Ends a drag selection after its release was dispatched: tells selection handlers, then copies.
    pub(super) fn finish_selection_drag(&self, event: &MouseEvent, hit: Option<&Rc<dyn Behavior>>) {
        if event.kind != MouseEventKind::Up(MouseButton::Left) || !self.selection_dragging() {
            return;
        }
        self.update_selection(hit, (i32::from(event.x), i32::from(event.y)));
        if let Some(selection) = self.0.selection.borrow_mut().as_mut() {
            selection.dragging = false;
        }
        let Some(text) = self.selected_text() else { return };
        let mut cx = Cx::new(self);
        self.0.handlers.selection.emit(&mut cx, &text);
        if self.0.options.copy_on_select && !cx.is_default_prevented() {
            self.copy_to_clipboard(&text);
        }
    }

    fn click_unit(&self, widget: &Rc<dyn Behavior>, x: u16, y: u16) -> SelectionUnit {
        let now = self.now();
        let widget = widget.element().id();
        let count = match self.0.last_click.get() {
            Some(last)
                if last.widget == widget
                    && now.saturating_duration_since(last.time) <= CLICK_REPEAT
                    && last.x.abs_diff(x) <= 1
                    && last.y.abs_diff(y) <= 1 =>
            {
                (last.count + 1).min(3)
            }
            _ => 1,
        };
        self.0.last_click.set(Some(Click { time: now, x, y, widget, count }));
        match count {
            1 => SelectionUnit::Cell,
            2 => SelectionUnit::Word,
            _ => SelectionUnit::Line,
        }
    }

    fn start_selection(&self, widget: Rc<dyn Behavior>, point: (i32, i32), unit: SelectionUnit) {
        self.clear_selection_state();
        let (x, y) = origin(&widget.element().rect());
        let container = widget.element().parent_behavior().or_else(|| self.root().element().behavior());
        *self.0.selection.borrow_mut() = Some(TextSelection {
            anchor: Rc::downgrade(&widget),
            anchor_offset: (point.0 - x, point.1 - y),
            anchor_screen: point,
            focus: point,
            unit,
            dragging: true,
            start: true,
            containers: container.iter().map(Rc::downgrade).collect(),
            touched: Vec::new(),
        });
        self.notify_selection();
    }

    /// Moves the focus to `point` and widens or narrows the covered subtree for the widget under it.
    fn update_selection(&self, hit: Option<&Rc<dyn Behavior>>, point: (i32, i32)) {
        {
            let mut slot = self.0.selection.borrow_mut();
            let Some(selection) = slot.as_mut() else { return };
            selection.start = false;
            selection.focus = point;
            if let Some(top) = selection.containers.last().and_then(Weak::upgrade) {
                match hit {
                    Some(hit) if hit.element().is_within(top.element()) => {
                        // Back inside an inner container: narrow to it.
                        let ids: Vec<Option<u32>> = selection
                            .containers
                            .iter()
                            .map(|container| container.upgrade().map(|container| container.element().id()))
                            .collect();
                        let parent = hit.element().parent_behavior().map(|parent| parent.element().id());
                        let index = ids
                            .iter()
                            .position(|&id| id == Some(hit.element().id()))
                            .or_else(|| ids.iter().position(|&id| id.is_some() && id == parent));
                        if let Some(index) = index {
                            selection.containers.truncate(index + 1);
                        }
                    }
                    _ => {
                        if let Some(parent) = top.element().parent_behavior() {
                            selection.containers.push(Rc::downgrade(&parent));
                        }
                    }
                }
            }
        }
        self.notify_selection();
    }

    /// Applies the selection to every selectable widget it overlaps and clears widgets it no longer does.
    fn notify_selection(&self) {
        let snapshot = self.0.selection.borrow().as_ref().map(|selection| {
            let update = SelectionUpdate {
                anchor: selection.anchor(),
                focus: selection.focus,
                start: selection.start,
                unit: selection.unit,
            };
            (selection.containers.last().and_then(Weak::upgrade), update, upgrade_all(&selection.touched))
        });
        let Some((container, update, previous)) = snapshot else { return };
        let Some(container) = container.or_else(|| self.root().element().behavior()) else { return };
        let bounds = (
            update.anchor.0.min(update.focus.0),
            update.anchor.1.min(update.focus.1),
            update.anchor.0.max(update.focus.0),
            update.anchor.1.max(update.focus.1),
        );
        let mut touched = Vec::new();
        visit(&container, &update, bounds, &mut touched);
        let ids: Vec<u32> = touched.iter().map(|widget| widget.element().id()).collect();
        for widget in previous.iter().filter(|widget| !ids.contains(&widget.element().id())) {
            widget.select(None);
        }
        if let Some(selection) = self.0.selection.borrow_mut().as_mut() {
            selection.touched = touched.iter().map(Rc::downgrade).collect();
        }
        self.request_redraw();
    }

    /// The text selected with the mouse, if any, as the widgets the selection covers hold it now. Text from several
    /// widgets is joined in reading order: pieces on the same row are concatenated left to right, and rows are joined
    /// with line breaks.
    pub fn selected_text(&self) -> Option<String> {
        let selected = upgrade_all(&self.0.selection.borrow().as_ref()?.touched);
        let mut pieces: Vec<(i32, i32, String)> = Vec::new();
        for widget in selected {
            let Some(text) = widget.selected_text().filter(|text| !text.is_empty()) else { continue };
            let (x, y) = origin(&widget.element().rect());
            pieces.extend(text.split('\n').enumerate().map(|(row, line)| (y + row as i32, x, line.to_owned())));
        }
        pieces.sort_by_key(|&(y, x, _)| (y, x));
        let mut lines: Vec<(i32, String)> = Vec::new();
        for (y, _, piece) in pieces {
            match lines.last_mut() {
                Some((row, line)) if *row == y => line.push_str(&piece),
                _ => lines.push((y, piece)),
            }
        }
        let text = lines.into_iter().map(|(_, line)| line).collect::<Vec<_>>().join("\n");
        (!text.is_empty()).then_some(text)
    }

    /// Whether a mouse selection drag is under way, as Core's `getSelection()?.isDragging` reports, even before it has
    /// selected text. A left press on selectable text starts one before the press is dispatched, and it ends after
    /// the release is dispatched, so handlers of both see it.
    pub fn is_selecting(&self) -> bool {
        self.selection_dragging()
    }

    /// Clears the mouse text selection. As in Core, the next press counts as a first click again.
    pub fn clear_selection(&self) {
        self.0.last_click.set(None);
        self.clear_selection_state();
    }

    fn clear_selection_state(&self) {
        let selection = self.0.selection.borrow_mut().take();
        if let Some(selection) = selection {
            for widget in upgrade_all(&selection.touched) {
                widget.select(None);
            }
            self.request_redraw();
        }
    }

    /// Ends the mouse selection without clearing `owner`'s part, as a keyboard selection in an editor does.
    pub(crate) fn keep_selection_only(&self, owner: &Element) {
        let selection = self.0.selection.borrow_mut().take();
        if let Some(selection) = selection {
            for widget in upgrade_all(&selection.touched).iter().filter(|widget| widget.element().id() != owner.id()) {
                widget.select(None);
            }
        }
    }

    /// Drops a removed or hidden subtree from the selection. Removing the anchor ends the selection.
    pub(super) fn selection_subtree_removed(&self, element: &Element) {
        let anchor = self.0.selection.borrow().as_ref().map(|selection| selection.anchor.upgrade());
        match anchor {
            None => {}
            Some(Some(anchor)) if !anchor.element().is_within(element) => {
                let removed: Vec<Rc<dyn Behavior>> = {
                    let mut slot = self.0.selection.borrow_mut();
                    let Some(selection) = slot.as_mut() else { return };
                    let within = |weak: &Weak<dyn Behavior>| {
                        weak.upgrade().is_some_and(|widget| widget.element().is_within(element))
                    };
                    let removed = selection.touched.iter().filter(|weak| within(weak)).filter_map(Weak::upgrade);
                    let removed = removed.collect();
                    selection.touched.retain(|weak| !within(weak));
                    selection.containers.retain(|weak| !within(weak));
                    removed
                };
                for widget in removed {
                    widget.select(None);
                }
            }
            Some(_) => self.clear_selection(),
        }
    }

    /// Called when a mouse selection ends with selected text, after the button is released. With
    /// [`AppOptions::copy_on_select`](super::AppOptions::copy_on_select), the text is copied afterwards unless a
    /// handler calls [`Cx::prevent_default`].
    pub fn on_selection(&self, mut handler: impl FnMut(&mut Cx<'_>, &str) + 'static) -> HandlerId {
        self.0.handlers.selection.add(move |cx, text: &str| handler(cx, text))
    }
}

fn visit(
    container: &Rc<dyn Behavior>,
    update: &SelectionUpdate,
    bounds: (i32, i32, i32, i32),
    touched: &mut Vec<Rc<dyn Behavior>>,
) {
    for child in container.element().child_behaviors() {
        if !child.element().is_visible() {
            continue;
        }
        if child.selectable() && overlaps(&child.element().rect(), bounds) {
            child.select(Some(update));
            touched.push(Rc::clone(&child));
        }
        visit(&child, update, bounds, touched);
    }
}
