use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

thread_local! { static COUNT: Cell<usize> = const { Cell::new(0) }; }

struct Counting;
#[global_allocator]
static ALLOCATOR: Counting = Counting;

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        COUNT.with(|count| count.set(count.get() + 1));
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}

pub fn count() -> usize {
    COUNT.with(Cell::get)
}
