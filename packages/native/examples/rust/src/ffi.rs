//! Raw declarations for the bound subset of `opentui.h`.
//!
//! Calls are unsafe: callers must uphold the header's pointer, ownership, and
//! thread-affinity contracts. Versioned record defaults initialize ABI metadata,
//! not application limits or paint defaults. Layouts are checked by the C probe.

#![allow(non_camel_case_types, dead_code)]

use std::ffi::c_void;

pub type ot_context = c_void;
pub type ot_status = i32;

macro_rules! constants {
    ($($name:ident: $kind:ty = $value:expr;)*) => {
        $(pub const $name: $kind = $value;)*
        #[cfg(test)]
        fn constants() -> Vec<u32> { vec![$($name as u32,)*] }
    };
}

constants! {
    OT_CONTEXT_ABI_VERSION: u32 = 1;
    OT_OK: i32 = 0;
    OT_INVALID_ARGUMENT: i32 = -1;
    OT_CONTEXT_BUSY: i32 = -6;
    OT_STALE_HANDLE: i32 = -9;
    OT_OUTPUT_BACKPRESSURE: i32 = -11;
    OT_OUTPUT_BUSY: i32 = -13;
    OT_STALE_OUTPUT: i32 = -14;
    OT_OUTPUT_FAILED: i32 = -15;
    OT_OBJECT_LIMIT: i32 = -16;
    OT_SCENE_ROOT: u32 = 0;
    OT_SCENE_TEXT: u32 = 2;
    OT_SCENE_TEXT_FOREGROUND: u32 = 1;
    OT_SCENE_TEXT_LINK: u32 = 4;
    OT_SESSION_CLOSED_STATE: u32 = 2;
    OT_SESSION_FAILED: u32 = 3;
    OT_SESSION_CANCELLED_STATE: u32 = 4;
    OT_SESSION_REMOTE_REMOTE: u32 = 2;
    OT_RENDER_PENDING: u32 = 1;
    OT_SESSION_CONTROL_PACKET_BYTES: u32 = 4096;
    OT_TERMINAL_ALTERNATE_SCREEN: u32 = 1;
    OT_TERMINAL_ACTIVE: u32 = 2;
    OT_TERMINAL_RESTORED: u32 = 7;
    OT_PUMP_IDLE: u32 = 0;
    OT_PUMP_AGAIN: u32 = 1;
    OT_PUMP_OUTPUT_PENDING: u32 = 2;
    OT_PUMP_WAIT_UNTIL: u32 = 3;
    OT_PUMP_CLOSED: u32 = 4;
    OT_SCENE_BOX: u32 = 1;
    OT_SESSION_REMOTE_AUTO: u32 = 0;
    OT_SESSION_REMOTE_LOCAL: u32 = 1;
    OT_SESSION_ENV_ENTRIES_MAX: u32 = 256;
    OT_SESSION_ENV_BYTES_MAX: u32 = 65536;
    OT_RENDER_PRESENTED: u32 = 0;
    OT_RENDER_SKIPPED: u32 = 2;
    OT_RENDER_FAILED: u32 = 3;
    OT_WRONG_CONTEXT: i32 = -7;
    OT_WRONG_SESSION: i32 = -10;
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct ot_handle {
    pub context_id: u64,
    pub slot: u32,
    pub generation: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct ot_output_ticket {
    pub session: ot_handle,
    pub request_id: u64,
    pub byte_count: u32,
    pub reserved: u32,
}

// This small binding is checked field-by-field against opentui.h by abi.c.
macro_rules! records {
    ($($name:ident { $($field:ident: $kind:ty,)* })*) => {
        $(
            #[repr(C)]
            #[derive(Clone, Copy, Debug)]
            pub struct $name {
                pub struct_size: u32,
                pub abi_version: u32,
                $(pub $field: $kind,)*
            }
            impl Default for $name {
                fn default() -> Self {
                    Self {
                        struct_size: std::mem::size_of::<Self>() as u32,
                        abi_version: OT_CONTEXT_ABI_VERSION,
                        $($field: Default::default(),)*
                    }
                }
            }
        )*
        #[cfg(test)]
        pub fn layout() -> Vec<u32> {
            use std::mem::{align_of, offset_of, size_of};
            let mut values = constants();
            values.extend([
                size_of::<ot_status>() as u32, align_of::<ot_status>() as u32,
                size_of::<ot_handle>() as u32, align_of::<ot_handle>() as u32,
                offset_of!(ot_handle, context_id) as u32,
                offset_of!(ot_handle, slot) as u32, offset_of!(ot_handle, generation) as u32,
                size_of::<ot_output_ticket>() as u32, align_of::<ot_output_ticket>() as u32,
                offset_of!(ot_output_ticket, session) as u32, offset_of!(ot_output_ticket, request_id) as u32,
                offset_of!(ot_output_ticket, byte_count) as u32, offset_of!(ot_output_ticket, reserved) as u32,
            ]);
            $(values.extend([
                size_of::<$name>() as u32, align_of::<$name>() as u32,
                offset_of!($name, struct_size) as u32, offset_of!($name, abi_version) as u32,
                $(offset_of!($name, $field) as u32,)*
            ]);)*
            values
        }
    };
}

records! {
    ot_context_options {
        flags: u32,
        object_capacity: u32,
        render_cells_max: u32,
        reserved: [u32; 3],
    }
    ot_context_error {
        status: ot_status,
        reserved: u32,
    }
    ot_session_options {
        chunk_size: u32,
        span_capacity: u32,
        max_bytes: u64,
        control_capacity: u32,
        reserved: u32,
    }
    ot_session_renderer_env_options {
        width: u32,
        height: u32,
        remote_mode: u32,
        entry_count: u32,
        byte_count: u32,
        reserved: u32,
    }
    ot_session_renderer_state {
        width: u32,
        height: u32,
        frame_count: u64,
        frame_pending: u32,
        reserved: u32,
    }
    ot_session_terminal_options {
        flags: u32,
        kitty_keyboard_flags: u32,
    }
    ot_session_pump_result {
        status: u32,
        reserved: u32,
        deadline_ns: u64,
    }
    ot_scene_linked_text_chunk {
        byte_count: u32,
        flags: u32,
        foreground: [u16; 4],
        background: [u16; 4],
        attributes: u32,
        reserved: u32,
        link_offset: u32,
        link_byte_count: u32,
    }
    ot_scene_paint_options {
        z_index: i32,
        opacity: f32,
        translate_x: f64,
        translate_y: f64,
        border_sides: u32,
        should_fill: u32,
        background: [u16; 4],
        border_color: [u16; 4],
        border_style: u32,
        focusable: u32,
        focused_border_color: [u16; 4],
        reserved: u32,
    }
}

unsafe extern "C" {
    pub fn ot_context_abi_version() -> u32;
    pub fn ot_context_create(options: *const ot_context_options, context: *mut *mut ot_context) -> ot_status;
    pub fn ot_context_destroy(context: *mut ot_context) -> ot_status;
    pub fn ot_context_get_last_error(context: *mut ot_context, error: *mut ot_context_error) -> ot_status;
    pub fn ot_session_create(
        context: *mut ot_context,
        options: *const ot_session_options,
        session: *mut ot_handle,
    ) -> ot_status;
    pub fn ot_session_attach_renderer_with_env(
        context: *mut ot_context,
        session: *const ot_handle,
        options: *const ot_session_renderer_env_options,
        environment: *const u8,
    ) -> ot_status;
    pub fn ot_session_setup_terminal(
        context: *mut ot_context,
        session: *const ot_handle,
        options: *const ot_session_terminal_options,
    ) -> ot_status;
    pub fn ot_session_get_terminal_state(
        context: *mut ot_context,
        session: *const ot_handle,
        phase: *mut u32,
    ) -> ot_status;
    pub fn ot_session_pump(
        context: *mut ot_context,
        session: *const ot_handle,
        now_ns: u64,
        work_budget: u32,
        result: *mut ot_session_pump_result,
    ) -> ot_status;
    pub fn ot_session_render(
        context: *mut ot_context,
        session: *const ot_handle,
        force: u32,
        result: *mut u32,
    ) -> ot_status;
    pub fn ot_session_get_renderer_state(
        context: *mut ot_context,
        session: *const ot_handle,
        state: *mut ot_session_renderer_state,
    ) -> ot_status;
    pub fn ot_session_resize_renderer(
        context: *mut ot_context,
        session: *const ot_handle,
        width: u32,
        height: u32,
    ) -> ot_status;
    pub fn ot_session_write(
        context: *mut ot_context,
        session: *const ot_handle,
        bytes: *const u8,
        count: u32,
    ) -> ot_status;
    pub fn ot_session_read_output(
        context: *mut ot_context,
        session: *const ot_handle,
        bytes: *mut u8,
        capacity: u32,
        ticket: *mut ot_output_ticket,
    ) -> ot_status;
    pub fn ot_session_complete_output(
        context: *mut ot_context,
        session: *const ot_handle,
        ticket: *const ot_output_ticket,
        success: u32,
    ) -> ot_status;
    pub fn ot_session_close(context: *mut ot_context, session: *const ot_handle) -> ot_status;
    pub fn ot_session_cancel(context: *mut ot_context, session: *const ot_handle) -> ot_status;
    pub fn ot_session_get_state(context: *mut ot_context, session: *const ot_handle, state: *mut u32) -> ot_status;
    pub fn ot_session_destroy(context: *mut ot_context, session: *const ot_handle) -> ot_status;
    pub fn ot_scene_create_node(
        context: *mut ot_context,
        session: *const ot_handle,
        kind: u32,
        num: u32,
        node: *mut ot_handle,
    ) -> ot_status;
    pub fn ot_scene_destroy_node(context: *mut ot_context, node: *const ot_handle) -> ot_status;
    pub fn ot_scene_move_node(
        context: *mut ot_context,
        node: *const ot_handle,
        parent: *const ot_handle,
        index: u32,
    ) -> ot_status;
    pub fn ot_scene_set_text(
        context: *mut ot_context,
        node: *const ot_handle,
        bytes: *const u8,
        count: u32,
    ) -> ot_status;
    pub fn ot_scene_set_style(
        context: *mut ot_context,
        node: *const ot_handle,
        group: u32,
        kind: u32,
        edge: u32,
        unit: u32,
        value: f32,
        flags: u32,
    ) -> ot_status;
    pub fn ot_scene_set_paint(
        context: *mut ot_context,
        node: *const ot_handle,
        options: *const ot_scene_paint_options,
    ) -> ot_status;
    pub fn ot_scene_get_text(
        context: *mut ot_context,
        node: *const ot_handle,
        bytes: *mut u8,
        capacity: u32,
        count: *mut u32,
    ) -> ot_status;
    pub fn ot_scene_set_styled_text_with_links(
        context: *mut ot_context,
        node: *const ot_handle,
        bytes: *const u8,
        byte_count: u32,
        chunks: *const ot_scene_linked_text_chunk,
        chunk_count: u32,
        urls: *const u8,
        url_byte_count: u32,
    ) -> ot_status;
    pub fn ot_scene_paint(
        context: *mut ot_context,
        session: *const ot_handle,
        background: *const u16,
        use_mouse: u32,
        excluded_hit_num: u32,
    ) -> ot_status;
    pub fn ot_scene_hit_test(
        context: *mut ot_context,
        session: *const ot_handle,
        x: i32,
        y: i32,
        num: *mut u32,
    ) -> ot_status;
}
