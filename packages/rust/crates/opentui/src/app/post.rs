//! Running widgets' post-processing filters on a painted frame, before it is presented.

use super::App;
use crate::error::Result;
use crate::native::{Draft, PaintSlot};
use crate::post::{Area, Surface};
use crate::widget::{Behavior, Widget};
use std::rc::Rc;

impl App {
    fn screen(&self) -> Area {
        let (width, height) = self.size();
        Area { x: 0, y: 0, width: u32::from(width), height: u32::from(height) }
    }

    /// Remembers the area a filtered widget paints in this frame: its rectangle cut by its clip.
    pub(super) fn filtered_slot(&self, widget: &Rc<dyn Behavior>, slot: &PaintSlot) {
        // Native code places bodies at truncated coordinates.
        let (x, y) = (slot.paint.screen_x.trunc() as i64, slot.paint.screen_y.trunc() as i64);
        let (width, height) = (slot.paint.width.max(0.0) as i64, slot.paint.height.max(0.0) as i64);
        let (clip_x, clip_y, clip_width, clip_height) = slot.clip;
        let left = x.max(i64::from(clip_x));
        let top = y.max(i64::from(clip_y));
        let right = (x + width).min(i64::from(clip_x) + i64::from(clip_width));
        let bottom = (y + height).min(i64::from(clip_y) + i64::from(clip_height));
        let area = Area::clipped(left, top, right - left, bottom - top, self.screen());
        self.0.filter_areas.borrow_mut().push((Rc::clone(widget), area));
    }

    /// Runs every painted widget's filters on the draft, innermost widgets first and the root's last.
    pub(super) fn post_process(&self, draft: &Draft) -> Result<()> {
        let mut targets = std::mem::take(&mut *self.0.filter_areas.borrow_mut());
        let screen = self.screen();
        let root = self.root();
        if root.element().has_filters()
            && let Some(behavior) = root.element().behavior()
        {
            targets.insert(0, (behavior, screen));
        }
        if targets.is_empty() {
            return Ok(());
        }
        let mut state = self.0.post.borrow_mut();
        state.begin();
        for (widget, area) in post_order(targets) {
            // A snapshot, so filters may add or remove filters.
            let filters = widget.element().filters.borrow().clone();
            for cell in filters {
                let elapsed = cell.elapsed.take();
                if let Ok(mut filter) = cell.filter.try_borrow_mut() {
                    filter.apply(&mut Surface::new(draft, &mut state, area, (screen.width, screen.height)), elapsed);
                }
            }
        }
        state.finish()
    }
}

/// Reorders widgets from paint order, where each comes before its descendants, so that each comes after them.
fn post_order(targets: Vec<(Rc<dyn Behavior>, Area)>) -> Vec<(Rc<dyn Behavior>, Area)> {
    let mut ordered = Vec::with_capacity(targets.len());
    let mut open: Vec<(Rc<dyn Behavior>, Area)> = Vec::new();
    for target in targets {
        while let Some((ancestor, _)) = open.last() {
            if target.0.element().is_within(ancestor.element()) {
                break;
            }
            ordered.extend(open.pop());
        }
        open.push(target);
    }
    ordered.extend(open.into_iter().rev());
    ordered
}
