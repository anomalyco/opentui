use super::Node;
use crate::error::{Result, check};
use crate::sys;
use std::any::Any;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Weak;

/// The space layout offers a measured node along one axis, in cells.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Constraint {
    /// Any size: report the natural size.
    Unbounded,
    /// Exactly this size.
    Exactly(f32),
    /// At most this size.
    AtMost(f32),
}

impl Constraint {
    fn from_raw(value: f32, mode: u32) -> Self {
        match mode {
            sys::OT_MEASURE_EXACTLY => Self::Exactly(value),
            sys::OT_MEASURE_AT_MOST => Self::AtMost(value),
            _ => Self::Unbounded,
        }
    }

    /// Fits a natural size into the constraint.
    pub fn apply(self, natural: f32) -> f32 {
        match self {
            Self::Unbounded => natural,
            Self::Exactly(size) => size,
            Self::AtMost(size) => natural.min(size),
        }
    }
}

/// Reports a leaf node's size during layout. It runs inside native layout: it may read scene state but must not
/// change it.
pub trait Measure {
    fn measure(&self, width: Constraint, height: Constraint) -> (f32, f32);
}

type Key = (u64, u32, u32);

thread_local! {
    static MEASURERS: RefCell<HashMap<Key, Weak<dyn Measure>>> = RefCell::new(HashMap::new());
    static PANIC: RefCell<Option<Box<dyn Any + Send>>> = const { RefCell::new(None) };
}

fn key(handle: &sys::ot_handle) -> Key {
    (handle.context_id, handle.slot, handle.generation)
}

unsafe extern "C" fn trampoline(
    context_id: u64,
    slot: u32,
    generation: u32,
    width: f32,
    width_mode: u32,
    height: f32,
    height_mode: u32,
    out_size: *mut f32,
) {
    let measurer = MEASURERS
        .try_with(|measurers| measurers.try_borrow().ok()?.get(&(context_id, slot, generation))?.upgrade())
        .ok()
        .flatten();
    let (width, height) = (Constraint::from_raw(width, width_mode), Constraint::from_raw(height, height_mode));
    // A panic must not unwind through native frames; it resumes after the native call returns.
    let size = measurer.map_or((0.0, 0.0), |measurer| {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| measurer.measure(width, height))).unwrap_or_else(
            |payload| {
                let _ = PANIC.try_with(|panic| {
                    panic.borrow_mut().get_or_insert(payload);
                });
                (0.0, 0.0)
            },
        )
    });
    // SAFETY: native code passes two writable floats, valid for this call.
    unsafe {
        *out_size = size.0;
        *out_size.add(1) = size.1;
    }
}

/// Resumes a panic that a measurement raised inside native layout.
pub(crate) fn resume_measure_panic() {
    if let Some(payload) = PANIC.try_with(|panic| panic.borrow_mut().take()).ok().flatten() {
        std::panic::resume_unwind(payload);
    }
}

pub(crate) fn forget(handle: &sys::ot_handle) {
    let _ = MEASURERS.try_with(|measurers| {
        if let Ok(mut measurers) = measurers.try_borrow_mut() {
            measurers.remove(&key(handle));
        }
    });
}

impl Node {
    /// Measures this leaf with `measurer` during layout, or restores no measurement with `None`. The node holds a
    /// weak reference; a dropped measurer measures as zero. Leaves with a measurer cannot have children.
    pub fn set_measure(&self, measurer: Option<Weak<dyn Measure>>) -> Result<()> {
        let handle = self.handle();
        let callback: sys::ot_scene_measure_callback = measurer.is_some().then_some(trampoline);
        MEASURERS.with(|measurers| match &measurer {
            Some(measurer) => measurers.borrow_mut().insert(key(&handle), measurer.clone()),
            None => measurers.borrow_mut().remove(&key(&handle)),
        });
        check("ot_scene_set_measure", unsafe { sys::ot_scene_set_measure(self.context_raw(), &handle, callback) })
    }
}
