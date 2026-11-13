//! The C ABI permits copied handles, unlike the safe wrappers that keep their owners alive.
use opentui::{
    native::{Context, ContextOptions},
    sys,
};

#[derive(Clone, Copy, Debug)]
enum Family {
    Edit,
    Text,
}

impl Family {
    fn buffer(self, cx: &Context, method: u32) -> sys::ot_handle {
        let options = sys::ot_edit_buffer_options { width_method: method, ..Default::default() };
        let create = match self {
            Self::Edit => sys::ot_edit_buffer_create,
            Self::Text => sys::ot_text_buffer_create,
        };
        let mut out = sys::ot_handle::default();
        assert_eq!(unsafe { create(cx.as_raw(), &options, &mut out) }, sys::OT_OK);
        out
    }

    fn view(self, cx: &Context, buffer: &sys::ot_handle) -> sys::ot_handle {
        let mut out = sys::ot_handle::default();
        let s = unsafe {
            match self {
                Self::Edit => sys::ot_editor_view_create(cx.as_raw(), buffer, 2, 1, &mut out),
                Self::Text => sys::ot_text_buffer_view_create(cx.as_raw(), buffer, &mut out),
            }
        };
        assert_eq!(s, sys::OT_OK);
        out
    }

    fn query(self, cx: &Context, view: &sys::ot_handle) -> i32 {
        let mut info = sys::ot_editor_view_info::default();
        unsafe {
            match self {
                Self::Edit => sys::ot_editor_view_get_info(cx.as_raw(), view, 0, &mut info),
                Self::Text => sys::ot_text_buffer_view_get_info(cx.as_raw(), view, &mut info),
            }
        }
    }
}

#[test]
fn a_buffer_consumes_only_its_own_views_in_every_release_order() {
    // 48 traces: two families × four width methods × all orders of releasing
    // the parent (0) and two siblings (1, 2). No terminal or random seed.
    let orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    for family in [Family::Edit, Family::Text] {
        for method in [
            sys::OT_WIDTH_METHOD_WCWIDTH,
            sys::OT_WIDTH_METHOD_UNICODE,
            sys::OT_WIDTH_METHOD_NO_ZWJ,
            sys::OT_WIDTH_METHOD_UNICODE_WIDE,
        ] {
            for order in orders {
                let cx = Context::new(ContextOptions { object_capacity: 1, render_cells_max: 8 }).unwrap();
                let parent = family.buffer(&cx, method);
                let children = [family.view(&cx, &parent), family.view(&cx, &parent)];
                let peer = family.view(&cx, &family.buffer(&cx, method));
                let mut alive = [true; 2];
                let mut replacement = None;
                for id in order {
                    if id == 0 {
                        let end = match family {
                            Family::Edit => sys::ot_edit_buffer_destroy,
                            Family::Text => sys::ot_text_buffer_destroy,
                        };
                        assert_eq!(unsafe { end(cx.as_raw(), &parent) }, sys::OT_OK);
                        alive = [false; 2];
                        let next = family.buffer(&cx, method);
                        replacement = Some(family.view(&cx, &next));
                    } else {
                        let end = match family {
                            Family::Edit => sys::ot_editor_view_destroy,
                            Family::Text => sys::ot_text_buffer_view_destroy,
                        };
                        let expect = if alive[id - 1] { sys::OT_OK } else { sys::OT_STALE_HANDLE };
                        assert_eq!(
                            unsafe { end(cx.as_raw(), &children[id - 1]) },
                            expect,
                            "{family:?} {method} {order:?} at {id}"
                        );
                        alive[id - 1] = false;
                    }
                    for (&view, live) in children.iter().zip(alive) {
                        let expect = if live { sys::OT_OK } else { sys::OT_STALE_HANDLE };
                        assert_eq!(family.query(&cx, &view), expect, "{family:?} {method} {order:?} at {id}");
                    }
                    assert_eq!(family.query(&cx, &peer), sys::OT_OK, "{family:?} {method} {order:?} at {id}");
                    if let Some(view) = replacement {
                        assert_eq!(family.query(&cx, &view), sys::OT_OK, "{family:?} {method} {order:?} at {id}");
                    }
                }
                // Context owns the peer and replacement resources.
            }
        }
    }
}
