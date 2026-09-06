const std = @import("std");
const build_options = @import("build_options");
const c = @import("context_abi_c");
const Context = @import("context.zig").Context;
const ObjectHandle = @import("context-handles.zig").Handle;
const scene = @import("scene.zig");

test {
    _ = @import("tests/scene_flush_test.zig");
}

const editor_transport = @import("context-editor-abi.zig");
const text_transport = @import("context-text-abi.zig");
const unicode_transport = @import("context-unicode-abi.zig");
const terminal_transport = @import("context-terminal-abi.zig");
const output_transport = @import("context-output-abi.zig");
pub const ot_edit_buffer_command = editor_transport.ot_edit_buffer_command;

pub const ContextHandle = struct {
    gpa: std.heap.DebugAllocator(.{
        .enable_memory_limit = build_options.gpa_safe_stats,
        .safety = build_options.gpa_safe_stats,
    }),
    io_threaded: std.Io.Threaded,
    core: *Context,
    owner_thread: std.Thread.Id,
    last_error: c.ot_status = c.OT_OK,
    edit_event_callback: c.ot_edit_event_callback = null,
};

pub fn ot_context_abi_version() callconv(.c) u32 {
    return c.OT_CONTEXT_ABI_VERSION;
}

pub fn ot_context_create(
    options_ptr: ?*const c.ot_context_options,
    out_context_ptr: ?*?*ContextHandle,
) callconv(.c) c.ot_status {
    return createContext(options_ptr, out_context_ptr, std.heap.page_allocator);
}

fn createContext(
    options_ptr: ?*const c.ot_context_options,
    out_context_ptr: ?*?*ContextHandle,
    backing_allocator: std.mem.Allocator,
) c.ot_status {
    const out_context = out_context_ptr orelse return c.OT_INVALID_ARGUMENT;
    out_context.* = null;
    const options = options_ptr orelse return c.OT_INVALID_ARGUMENT;
    if (options.struct_size != @sizeOf(c.ot_context_options)) return c.OT_INVALID_ARGUMENT;
    if (options.abi_version != c.OT_CONTEXT_ABI_VERSION) return c.OT_UNSUPPORTED_VERSION;
    if (options.flags != 0) return c.OT_INVALID_ARGUMENT;
    if (options.object_capacity == 0 or options.render_cells_max == 0) return c.OT_INVALID_ARGUMENT;
    for (options.reserved) |reserved| {
        if (reserved != 0) return c.OT_INVALID_ARGUMENT;
    }

    const handle = std.heap.c_allocator.create(ContextHandle) catch return c.OT_OUT_OF_MEMORY;
    handle.* = .{
        // Keep allocator and I/O userdata at stable addresses without installing
        // process-wide signal handlers or borrowing legacy global state.
        .gpa = .init,
        .io_threaded = .init_single_threaded,
        .core = undefined,
        .owner_thread = std.Thread.getCurrentId(),
    };
    handle.gpa.backing_allocator = backing_allocator;
    handle.core = Context.init(handle.gpa.allocator(), handle.io_threaded.io(), .{
        .object_capacity = options.object_capacity,
        .render_cells_max = options.render_cells_max,
    }) catch |err| {
        handle.io_threaded.deinit();
        _ = handle.gpa.deinit();
        std.heap.c_allocator.destroy(handle);
        return switch (err) {
            error.OutOfMemory => c.OT_OUT_OF_MEMORY,
            else => c.OT_INTERNAL_ERROR,
        };
    };
    out_context.* = handle;
    return c.OT_OK;
}

pub fn ot_context_destroy(context: ?*ContextHandle) callconv(.c) c.ot_status {
    const handle = context orelse return c.OT_INVALID_ARGUMENT;
    if (handle.owner_thread != std.Thread.getCurrentId()) return c.OT_WRONG_THREAD;
    handle.core.deinit() catch {
        handle.last_error = c.OT_CONTEXT_BUSY;
        return handle.last_error;
    };
    handle.io_threaded.deinit();
    _ = handle.gpa.deinit();
    std.heap.c_allocator.destroy(handle);
    return c.OT_OK;
}

pub fn ot_context_get_last_error(
    context: ?*ContextHandle,
    out_error_ptr: ?*c.ot_context_error,
) callconv(.c) c.ot_status {
    const handle = context orelse return c.OT_INVALID_ARGUMENT;
    if (handle.owner_thread != std.Thread.getCurrentId()) return c.OT_WRONG_THREAD;
    const out_error = out_error_ptr orelse {
        handle.last_error = c.OT_INVALID_ARGUMENT;
        return handle.last_error;
    };
    if (out_error.struct_size != @sizeOf(c.ot_context_error)) {
        handle.last_error = c.OT_INVALID_ARGUMENT;
        return handle.last_error;
    }
    if (out_error.abi_version != c.OT_CONTEXT_ABI_VERSION) {
        handle.last_error = c.OT_UNSUPPORTED_VERSION;
        return handle.last_error;
    }
    out_error.* = .{
        .struct_size = @sizeOf(c.ot_context_error),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .status = handle.last_error,
        .reserved = 0,
    };
    return c.OT_OK;
}

pub fn ot_context_drain_diagnostics(
    context: ?*ContextHandle,
    records: ?[*]c.ot_diagnostic,
    capacity: u32,
    out_drain_ptr: ?*c.ot_diagnostic_drain,
) callconv(.c) c.ot_status {
    const handle = context orelse return c.OT_INVALID_ARGUMENT;
    if (handle.owner_thread != std.Thread.getCurrentId()) return c.OT_WRONG_THREAD;
    const status: c.ot_status = invalid: {
        if (handle.core.mutating or handle.core.closing) break :invalid c.OT_CONTEXT_BUSY;
        const out = out_drain_ptr orelse break :invalid c.OT_INVALID_ARGUMENT;
        if (out.struct_size != @sizeOf(c.ot_diagnostic_drain)) break :invalid c.OT_INVALID_ARGUMENT;
        if (out.abi_version != c.OT_CONTEXT_ABI_VERSION) break :invalid c.OT_UNSUPPORTED_VERSION;
        if (capacity != 0 and records == null) break :invalid c.OT_INVALID_ARGUMENT;
        break :invalid c.OT_OK;
    };
    if (status != c.OT_OK) {
        handle.last_error = status;
        return status;
    }

    const queue = &handle.core.diagnostics;
    const count = @min(capacity, queue.count);
    var record: [1]@import("context.zig").Diagnostic = undefined;
    for (0..count) |index| {
        _ = queue.drain(&record);
        records.?[index] = .{
            .level = @intFromEnum(record[0].level),
            .message_len = record[0].message_len,
            .flags = if (record[0].truncated) c.OT_DIAGNOSTIC_TRUNCATED else 0,
            .reserved = 0,
            .message = record[0].message,
        };
    }
    out_drain_ptr.?.* = .{
        .struct_size = @sizeOf(c.ot_diagnostic_drain),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .count = count,
        .remaining = queue.count,
        .dropped = queue.dropped_count,
    };
    return c.OT_OK;
}

pub fn ot_context_get_link_url(
    context: ?*ContextHandle,
    link_id: u32,
    bytes: ?[*]u8,
    capacity: u32,
    out: ?*u32,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    if (out == null or (capacity != 0 and bytes == null)) return sessionError(owner, error.InvalidOptions);
    const count = owner.core.getLinkUrl(
        link_id,
        if (capacity == 0) &.{} else bytes.?[0..capacity],
    ) catch |err| return sessionError(owner, err);
    out.?.* = count;
    return c.OT_OK;
}

pub fn ot_edit_buffer_create(context: ?*ContextHandle, options_ptr: ?*const c.ot_edit_buffer_options, out_ptr: ?*c.ot_handle) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const options = options_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (options.struct_size != @sizeOf(c.ot_edit_buffer_options) or options.reserved != 0) return sessionError(owner, error.InvalidOptions);
    if (options.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    const width_method: @import("utf8.zig").WidthMethod = switch (options.width_method) {
        c.OT_WIDTH_METHOD_WCWIDTH => .wcwidth,
        c.OT_WIDTH_METHOD_UNICODE => .unicode,
        c.OT_WIDTH_METHOD_NO_ZWJ => .no_zwj,
        c.OT_WIDTH_METHOD_UNICODE_WIDE => .unicode_wide,
        else => return sessionError(owner, error.InvalidOptions),
    };
    out.* = handleToC(owner.core.createEditBuffer(width_method) catch |err| return sessionError(owner, err));
    return c.OT_OK;
}

pub fn ot_edit_buffer_destroy(context: ?*ContextHandle, edit_ptr: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = edit_ptr orelse return sessionError(owner, error.InvalidOptions);
    const handle = handleFromC(id.*);
    _ = owner.core.getEditBuffer(handle) catch |err| return sessionError(owner, err);
    owner.core.destroy(handle) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_editor_view_create(context: ?*ContextHandle, edit_ptr: ?*const c.ot_handle, width: u32, height: u32, out_ptr: ?*c.ot_handle) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = edit_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (width > std.math.maxInt(i32) or height > std.math.maxInt(i32)) return sessionError(owner, error.InvalidDimensions);
    out.* = handleToC(owner.core.createEditorView(handleFromC(id.*), width, height) catch |err| return sessionError(owner, err));
    return c.OT_OK;
}

pub fn ot_editor_view_destroy(context: ?*ContextHandle, view_ptr: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = view_ptr orelse return sessionError(owner, error.InvalidOptions);
    const handle = handleFromC(id.*);
    _ = owner.core.getEditorView(handle) catch |err| return sessionError(owner, err);
    owner.core.destroy(handle) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_syntax_style_create(context: ?*ContextHandle, out_ptr: ?*c.ot_handle) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const out = out_ptr orelse return sessionError(owner, error.InvalidOptions);
    out.* = handleToC(owner.core.createSyntaxStyle() catch |err| return sessionError(owner, err));
    return c.OT_OK;
}

pub fn ot_syntax_style_destroy(context: ?*ContextHandle, style_ptr: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = style_ptr orelse return sessionError(owner, error.InvalidOptions);
    const handle = handleFromC(id.*);
    _ = owner.core.getSyntaxStyle(handle) catch |err| return sessionError(owner, err);
    owner.core.destroy(handle) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_edit_buffer_set_syntax_style(context: ?*ContextHandle, edit_ptr: ?*const c.ot_handle, style_ptr: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = edit_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.editSetSyntaxStyle(handleFromC(id.*), if (style_ptr) |ptr| handleFromC(ptr.*) else null) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_edit_buffer_set_text(context: ?*ContextHandle, edit_ptr: ?*const c.ot_handle, bytes_ptr: ?[*]const u8, byte_count: u32, preserve_history: u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = edit_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (preserve_history > 1 or (byte_count != 0 and bytes_ptr == null)) return sessionError(owner, error.InvalidOptions);
    const bytes = if (bytes_ptr) |ptr| ptr[0..byte_count] else &.{};
    owner.core.editSetText(handleFromC(id.*), bytes, preserve_history == 1) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_edit_buffer_insert_text(context: ?*ContextHandle, edit_ptr: ?*const c.ot_handle, bytes_ptr: ?[*]const u8, byte_count: u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = edit_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (byte_count != 0 and bytes_ptr == null) return sessionError(owner, error.InvalidOptions);
    const bytes = if (bytes_ptr) |ptr| ptr[0..byte_count] else &.{};
    owner.core.editInsertText(handleFromC(id.*), bytes) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_edit_buffer_delete_range(context: ?*ContextHandle, edit_ptr: ?*const c.ot_handle, start_row: u32, start_col: u32, end_row: u32, end_col: u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = edit_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.editDeleteRange(handleFromC(id.*), .{ .row = start_row, .col = start_col }, .{ .row = end_row, .col = end_col }) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_edit_buffer_set_cursor(context: ?*ContextHandle, edit_ptr: ?*const c.ot_handle, row: u32, col: u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = edit_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.editSetCursor(handleFromC(id.*), row, col) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_edit_buffer_get_text(context: ?*ContextHandle, edit_ptr: ?*const c.ot_handle, bytes_ptr: ?[*]u8, capacity: u32, out_ptr: ?*u32) callconv(.c) c.ot_status {
    const status = sceneReadStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = edit_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (capacity != 0 and bytes_ptr == null) return sessionError(owner, error.InvalidOptions);
    const edit = owner.core.getEditBuffer(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    const byte_count = edit.buffer.tb.getByteSize();
    if (capacity != 0 and capacity < byte_count) return sessionError(owner, error.BufferTooSmall);
    out.* = if (capacity == 0) byte_count else @intCast(edit.buffer.getText(bytes_ptr.?[0..capacity]));
    return c.OT_OK;
}

pub fn ot_edit_buffer_get_info(context: ?*ContextHandle, edit_ptr: ?*const c.ot_handle, out_ptr: ?*c.ot_edit_buffer_info) callconv(.c) c.ot_status {
    const status = sceneReadStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = edit_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (out.struct_size != @sizeOf(c.ot_edit_buffer_info)) return sessionError(owner, error.InvalidOptions);
    if (out.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    const edit = owner.core.getEditBuffer(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    const cursor = edit.buffer.getPrimaryCursor();
    out.* = .{
        .struct_size = @sizeOf(c.ot_edit_buffer_info),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .content_epoch = edit.buffer.tb.getContentEpoch(),
        .byte_count = edit.buffer.tb.getByteSize(),
        .line_count = edit.buffer.tb.lineCount(),
        .cursor_row = cursor.row,
        .cursor_col = cursor.col,
        .cursor_offset = cursor.offset,
        .can_undo = @intFromBool(edit.buffer.canUndo()),
        .can_redo = @intFromBool(edit.buffer.canRedo()),
        .tab_width = edit.buffer.tb.getTabWidth(),
    };
    return c.OT_OK;
}

fn editEventCallback(userdata: ?*anyopaque, handle: ObjectHandle, event: @import("context.zig").EditEvent) void {
    const owner: *ContextHandle = @ptrCast(@alignCast(userdata.?));
    if (owner.edit_event_callback) |callback| callback(handle.context_id, handle.slot, handle.generation, @intFromEnum(event));
}

pub fn ot_context_set_edit_event_callback(context: ?*ContextHandle, callback: c.ot_edit_event_callback) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    owner.core.setEditEventCallback(if (callback != null) editEventCallback else null, if (callback != null) owner else null) catch |err| return sessionError(owner, err);
    owner.edit_event_callback = callback;
    return c.OT_OK;
}

pub fn ot_scene_set_editor_view(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, view_ptr: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.sceneSetEditorView(handleFromC(id.*), if (view_ptr) |ptr| handleFromC(ptr.*) else null) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_scene_set_editor_options(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, options_ptr: ?*const c.ot_scene_editor_options) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    const options = options_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (options.struct_size != @sizeOf(c.ot_scene_editor_options) or options.reserved != 0 or options.reserved2 != 0 or options.show_cursor > 1 or options.blinking > 1) return sessionError(owner, error.InvalidOptions);
    if (options.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    owner.core.sceneSetEditorOptions(handleFromC(id.*), .{
        .show_cursor = options.show_cursor == 1,
        .style = options.style,
        .blinking = options.blinking == 1,
        .color = options.color,
        .mouse_pointer = options.mouse_pointer,
    }) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_image_destroy(context: ?*ContextHandle, image_ptr: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = image_ptr orelse return sessionError(owner, error.InvalidOptions);
    const handle = handleFromC(id.*);
    _ = owner.core.getImage(handle) catch |err| return sessionError(owner, err);
    owner.core.destroy(handle) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_scene_set_image(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, image_ptr: ?*const c.ot_handle, fit: u32, protocol: u32, buffer_ptr: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const node = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (fit > c.OT_IMAGE_FILL or protocol > c.OT_IMAGE_PROTOCOL_BLOCKS) return sessionError(owner, error.InvalidOptions);
    owner.core.sceneSetImage(
        handleFromC(node.*),
        if (image_ptr) |id| handleFromC(id.*) else null,
        @enumFromInt(fit),
        @enumFromInt(protocol),
        if (buffer_ptr) |id| handleFromC(id.*) else null,
    ) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_buffer_draw_image(context: ?*ContextHandle, target_ptr: ?*const c.ot_handle, frame_ptr: ?*const c.ot_scene_frame_request, image_ptr: ?*const c.ot_handle, options_ptr: ?*const c.ot_image_draw_options, out_ptr: ?*u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const target = target_ptr orelse return sessionError(owner, error.InvalidOptions);
    const source = image_ptr orelse return sessionError(owner, error.InvalidOptions);
    const options = options_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (options.struct_size != @sizeOf(c.ot_image_draw_options)) return sessionError(owner, error.InvalidOptions);
    if (options.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    if (options.flags & ~@as(u32, c.OT_IMAGE_DRAW_SOURCE_WIDTH | c.OT_IMAGE_DRAW_SOURCE_HEIGHT) != 0 or
        options.protocol > c.OT_IMAGE_PROTOCOL_BLOCKS or options.reserved[0] != 0 or options.reserved[1] != 0 or
        (options.flags & c.OT_IMAGE_DRAW_SOURCE_WIDTH == 0 and options.source_width != 0) or
        (options.flags & c.OT_IMAGE_DRAW_SOURCE_HEIGHT == 0 and options.source_height != 0)) return sessionError(owner, error.InvalidOptions);
    const frame = if (frame_ptr) |record| frameRequestFromC(record.*) catch |err| return sessionError(owner, err) else null;
    out.* = @intFromBool(owner.core.drawBufferImage(handleFromC(target.*), frame, handleFromC(source.*), .{
        .x = options.x,
        .y = options.y,
        .width = options.width,
        .height = options.height,
        .pixel_width = options.pixel_width,
        .pixel_height = options.pixel_height,
        .source_x = options.source_x,
        .source_y = options.source_y,
        .source_width = if (options.flags & c.OT_IMAGE_DRAW_SOURCE_WIDTH != 0) options.source_width else null,
        .source_height = if (options.flags & c.OT_IMAGE_DRAW_SOURCE_HEIGHT != 0) options.source_height else null,
        .protocol = @enumFromInt(options.protocol),
    }) catch |err| return sessionError(owner, err));
    return c.OT_OK;
}

pub fn ot_session_set_image_resolution(context: ?*ContextHandle, session_ptr: ?*const c.ot_handle, terminal_width: u32, terminal_height: u32, pixel_width: u32, pixel_height: u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.sessionSetImageResolution(handleFromC(id.*), terminal_width, terminal_height, pixel_width, pixel_height) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_session_set_kitty_image_transport(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    mode: u32,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.sessionSetKittyImageTransport(handleFromC(id.*), mode) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_session_get_kitty_image_transport(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    out_status_ptr: ?*c.ot_session_kitty_image_transport,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_status_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (out.struct_size != @sizeOf(c.ot_session_kitty_image_transport)) return sessionError(owner, error.InvalidOptions);
    if (out.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    const values = owner.core.sessionKittyImageTransportStatus(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    out.* = .{
        .struct_size = @sizeOf(c.ot_session_kitty_image_transport),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .requested = values[0],
        .effective = values[1],
        .file_state = values[2],
        .fallback = values[3],
        .pending_files = values[4],
        .pending_bytes = values[5],
    };
    return c.OT_OK;
}

pub fn ot_session_poll_kitty_image_transport(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    out_retry_ptr: ?*u32,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_retry_ptr orelse return sessionError(owner, error.InvalidOptions);
    out.* = 0;
    const retry = owner.core.sessionPollKittyImageTransport(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    out.* = @intFromBool(retry);
    return c.OT_OK;
}

pub fn ot_session_cancel_kitty_image_transport(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    failed: u32,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (failed > 1) return sessionError(owner, error.InvalidOptions);
    owner.core.sessionCancelKittyImageTransport(handleFromC(id.*), failed != 0) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_session_process_kitty_image_reply(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    bytes_ptr: ?[*]const u8,
    byte_count: u32,
    out_result_ptr: ?*u32,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_result_ptr orelse return sessionError(owner, error.InvalidOptions);
    out.* = 0;
    if (byte_count != 0 and bytes_ptr == null) return sessionError(owner, error.InvalidOptions);
    const bytes = if (bytes_ptr) |ptr| ptr[0..byte_count] else &.{};
    const result = owner.core.sessionProcessKittyImageReply(handleFromC(id.*), bytes) catch |err| return sessionError(owner, err);
    out.* = result;
    return c.OT_OK;
}

pub fn ot_session_start_kitty_file_probe(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.sessionStartKittyFileProbe(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_buffer_create(
    context: ?*ContextHandle,
    options_ptr: ?*const c.ot_buffer_options,
    out_buffer_ptr: ?*c.ot_handle,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const options = options_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_buffer_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (options.struct_size != @sizeOf(c.ot_buffer_options)) return sessionError(owner, error.InvalidOptions);
    if (options.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    if (options.flags & ~@as(u32, c.OT_BUFFER_RESPECT_ALPHA) != 0) return sessionError(owner, error.InvalidOptions);
    const width_method: @import("utf8.zig").WidthMethod = switch (options.width_method) {
        c.OT_WIDTH_METHOD_WCWIDTH => .wcwidth,
        c.OT_WIDTH_METHOD_UNICODE => .unicode,
        c.OT_WIDTH_METHOD_NO_ZWJ => .no_zwj,
        c.OT_WIDTH_METHOD_UNICODE_WIDE => .unicode_wide,
        else => return sessionError(owner, error.InvalidOptions),
    };
    const buffer = owner.core.createBuffer(options.width, options.height, .{
        .width_method = width_method,
        .respect_alpha = options.flags & c.OT_BUFFER_RESPECT_ALPHA != 0,
    }) catch |err| return sessionError(owner, err);
    out.* = handleToC(buffer);
    return c.OT_OK;
}

pub fn ot_buffer_destroy(context: ?*ContextHandle, buffer_ptr: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = buffer_ptr orelse return sessionError(owner, error.InvalidOptions);
    const buffer = handleFromC(id.*);
    _ = owner.core.getBuffer(buffer) catch |err| return sessionError(owner, err);
    owner.core.destroy(buffer) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_buffer_resize(
    context: ?*ContextHandle,
    buffer_ptr: ?*const c.ot_handle,
    width: u32,
    height: u32,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = buffer_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.resizeBuffer(handleFromC(id.*), width, height) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_buffer_clear(
    context: ?*ContextHandle,
    buffer_ptr: ?*const c.ot_handle,
    background_ptr: ?*const [4]u16,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = buffer_ptr orelse return sessionError(owner, error.InvalidOptions);
    const background = background_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.clearBuffer(handleFromC(id.*), background.*) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_buffer_fill_rect(context: ?*ContextHandle, buffer_ptr: ?*const c.ot_handle, x: u32, y: u32, width: u32, height: u32, background_ptr: ?*const [4]u16) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = buffer_ptr orelse return sessionError(owner, error.InvalidOptions);
    const background = background_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.fillBufferRect(handleFromC(id.*), x, y, width, height, background.*) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_buffer_draw_text(
    context: ?*ContextHandle,
    buffer_ptr: ?*const c.ot_handle,
    options_ptr: ?*const c.ot_buffer_text_options,
    bytes_ptr: ?[*]const u8,
    byte_count: u32,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = buffer_ptr orelse return sessionError(owner, error.InvalidOptions);
    const options = options_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (options.struct_size != @sizeOf(c.ot_buffer_text_options)) return sessionError(owner, error.InvalidOptions);
    if (options.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    if (options.flags & ~@as(u32, c.OT_BUFFER_TEXT_HAS_BACKGROUND) != 0) return sessionError(owner, error.InvalidOptions);
    if (options.flags == 0) {
        for (options.background) |channel| {
            if (channel != 0) return sessionError(owner, error.InvalidOptions);
        }
    }
    if (byte_count > c.OT_BUFFER_TEXT_BYTES_MAX or (byte_count != 0 and bytes_ptr == null)) {
        return sessionError(owner, error.InvalidOptions);
    }
    const bytes = if (bytes_ptr) |ptr| ptr[0..byte_count] else &.{};
    owner.core.drawBufferText(
        handleFromC(id.*),
        bytes,
        options.x,
        options.y,
        options.foreground,
        if (options.flags == c.OT_BUFFER_TEXT_HAS_BACKGROUND) options.background else null,
        options.attributes,
    ) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_buffer_draw(context: ?*ContextHandle, target_ptr: ?*const c.ot_handle, frame_ptr: ?*const c.ot_scene_frame_request, options_ptr: ?*const c.ot_buffer_draw_options, source_ptr: ?*const c.ot_handle, text_ptr: ?[*]const u8, text_len: u32, bottom_ptr: ?[*]const u8, bottom_len: u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const target = target_ptr orelse return sessionError(owner, error.InvalidOptions);
    const options = options_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (options.struct_size != @sizeOf(c.ot_buffer_draw_options) or options.reserved != 0 or options.reserved2 != 0 or
        options.flags & ~@as(u32, 7) != 0 or options.operation > c.OT_BUFFER_DRAW_RESPECT_ALPHA) return sessionError(owner, error.InvalidOptions);
    if (options.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    if (text_len > c.OT_BUFFER_TEXT_BYTES_MAX or bottom_len > c.OT_BUFFER_TEXT_BYTES_MAX or
        (text_len != 0 and text_ptr == null) or (bottom_len != 0 and bottom_ptr == null) or
        (options.operation == c.OT_BUFFER_DRAW_COMPOSE) != (source_ptr != null)) return sessionError(owner, error.InvalidOptions);
    const frame = if (frame_ptr) |record| frameRequestFromC(record.*) catch |err| return sessionError(owner, err) else null;
    owner.core.drawBuffer(handleFromC(target.*), frame, .{
        .operation = @enumFromInt(options.operation),
        .x = options.x,
        .y = options.y,
        .width = options.width,
        .height = options.height,
        .char = options.character,
        .attributes = options.attributes,
        .foreground = options.foreground,
        .background = if (options.flags & c.OT_BUFFER_DRAW_HAS_BACKGROUND != 0) options.background else null,
        .title_color = options.title_color,
        .packed_options = options.packed_options,
        .border_chars = options.border_chars,
        .source = if (source_ptr) |source| handleFromC(source.*) else null,
        .crop = .{
            .x = options.source_x,
            .y = options.source_y,
            .width = if (options.flags & c.OT_BUFFER_DRAW_HAS_SOURCE_WIDTH != 0) options.source_width else null,
            .height = if (options.flags & c.OT_BUFFER_DRAW_HAS_SOURCE_HEIGHT != 0) options.source_height else null,
        },
    }, if (text_ptr) |bytes| bytes[0..text_len] else &.{}, if (bottom_ptr) |bytes| bytes[0..bottom_len] else &.{}) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_buffer_stack(context: ?*ContextHandle, target_ptr: ?*const c.ot_handle, frame_ptr: ?*const c.ot_scene_frame_request, operation: u32, x: i32, y: i32, width: u32, height: u32, opacity_ptr: ?*const f32, out_ptr: ?*f32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const target = target_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_ptr orelse return sessionError(owner, error.InvalidOptions);
    const opacity = opacity_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (operation > c.OT_BUFFER_STACK_CLEAR_OPACITY) return sessionError(owner, error.InvalidOptions);
    const frame = if (frame_ptr) |record| frameRequestFromC(record.*) catch |err| return sessionError(owner, err) else null;
    out.* = owner.core.bufferStack(handleFromC(target.*), frame, .{
        .operation = @enumFromInt(operation),
        .x = x,
        .y = y,
        .width = width,
        .height = height,
        .opacity = opacity.*,
    }) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_buffer_draw_grid(context: ?*ContextHandle, target_ptr: ?*const c.ot_handle, frame_ptr: ?*const c.ot_scene_frame_request, options_ptr: ?*const c.ot_buffer_grid_options, columns_ptr: ?[*]const i32, column_count: u32, rows_ptr: ?[*]const i32, row_count: u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const target = target_ptr orelse return sessionError(owner, error.InvalidOptions);
    const options = options_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (options.struct_size != @sizeOf(c.ot_buffer_grid_options) or options.reserved != 0 or
        options.flags & ~@as(u32, c.OT_BUFFER_GRID_INNER | c.OT_BUFFER_GRID_OUTER) != 0 or
        (column_count != 0 and columns_ptr == null) or (row_count != 0 and rows_ptr == null)) return sessionError(owner, error.InvalidOptions);
    if (options.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    const frame = if (frame_ptr) |record| frameRequestFromC(record.*) catch |err| return sessionError(owner, err) else null;
    owner.core.drawGrid(handleFromC(target.*), frame, .{
        .border_chars = options.border_chars,
        .foreground = options.foreground,
        .background = options.background,
        .draw_inner = options.flags & c.OT_BUFFER_GRID_INNER != 0,
        .draw_outer = options.flags & c.OT_BUFFER_GRID_OUTER != 0,
    }, if (columns_ptr) |ptr| ptr[0..column_count] else &.{}, if (rows_ptr) |ptr| ptr[0..row_count] else &.{}) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_buffer_draw_packed(context: ?*ContextHandle, target_ptr: ?*const c.ot_handle, frame_ptr: ?*const c.ot_scene_frame_request, data_ptr: ?[*]const u8, byte_count: u32, x: u32, y: u32, width: u32, height: u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const target = target_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (byte_count != 0 and data_ptr == null) return sessionError(owner, error.InvalidOptions);
    const frame = if (frame_ptr) |record| frameRequestFromC(record.*) catch |err| return sessionError(owner, err) else null;
    owner.core.drawPackedBuffer(handleFromC(target.*), frame, if (data_ptr) |ptr| ptr[0..byte_count] else &.{}, x, y, width, height) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_buffer_draw_supersample(context: ?*ContextHandle, target_ptr: ?*const c.ot_handle, frame_ptr: ?*const c.ot_scene_frame_request, data_ptr: ?[*]const u8, byte_count: u32, x: u32, y: u32, format: u32, stride: u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const target = target_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (byte_count != 0 and data_ptr == null) return sessionError(owner, error.InvalidOptions);
    const frame = if (frame_ptr) |record| frameRequestFromC(record.*) catch |err| return sessionError(owner, err) else null;
    owner.core.drawSuperSampleBuffer(handleFromC(target.*), frame, if (data_ptr) |ptr| ptr[0..byte_count] else &.{}, x, y, format, stride) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_buffer_draw_grayscale(context: ?*ContextHandle, target_ptr: ?*const c.ot_handle, frame_ptr: ?*const c.ot_scene_frame_request, data_ptr: ?[*]align(1) const f32, sample_count: u32, x: i32, y: i32, width: u32, height: u32, foreground: ?*const [4]u16, background: ?*const [4]u16, supersampled: u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const target = target_ptr orelse return sessionError(owner, error.InvalidOptions);
    if ((sample_count != 0 and data_ptr == null) or supersampled > 1) return sessionError(owner, error.InvalidOptions);
    const frame = if (frame_ptr) |record| frameRequestFromC(record.*) catch |err| return sessionError(owner, err) else null;
    owner.core.drawGrayscaleBuffer(handleFromC(target.*), frame, if (data_ptr) |ptr| ptr[0..sample_count] else &.{}, x, y, width, height, if (foreground) |fg| fg.* else null, if (background) |bg| bg.* else null, supersampled == 1) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_buffer_color_matrix(context: ?*ContextHandle, target_ptr: ?*const c.ot_handle, frame_ptr: ?*const c.ot_scene_frame_request, matrix_ptr: ?[*]align(1) const f32, matrix_count: u32, mask_ptr: ?[*]align(1) const f32, mask_count: u32, strength_ptr: ?*const f32, channel: u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const target = target_ptr orelse return sessionError(owner, error.InvalidOptions);
    const strength = strength_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (matrix_count != 16 or matrix_ptr == null or (mask_count != 0 and mask_ptr == null)) return sessionError(owner, error.InvalidOptions);
    const frame = if (frame_ptr) |record| frameRequestFromC(record.*) catch |err| return sessionError(owner, err) else null;
    owner.core.colorMatrixBuffer(handleFromC(target.*), frame, matrix_ptr.?[0..matrix_count], if (mask_ptr) |ptr| ptr[0..mask_count] else null, strength.*, channel) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_buffer_draw_editor_view(context: ?*ContextHandle, target: ?*const c.ot_handle, frame: ?*const c.ot_scene_frame_request, source: ?*const c.ot_handle, x: i32, y: i32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    if (target == null or source == null) return sessionError(owner, error.InvalidOptions);
    const request = if (frame) |p| frameRequestFromC(p.*) catch |err| return sessionError(owner, err) else null;
    owner.core.drawEditorView(handleFromC(target.?.*), request, handleFromC(source.?.*), x, y) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_buffer_draw_scene_text(context: ?*ContextHandle, target: ?*const c.ot_handle, frame: ?*const c.ot_scene_frame_request, source: ?*const c.ot_handle, x: i32, y: i32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    if (target == null or source == null) return sessionError(owner, error.InvalidOptions);
    const request = if (frame) |p| frameRequestFromC(p.*) catch |err| return sessionError(owner, err) else null;
    owner.core.drawSceneText(handleFromC(target.?.*), request, handleFromC(source.?.*), x, y) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_buffer_acquire_lease(
    context: ?*ContextHandle,
    buffer_ptr: ?*const c.ot_handle,
    out_snapshot_ptr: ?*c.ot_buffer_lease_snapshot,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = buffer_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_snapshot_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (out.struct_size != @sizeOf(c.ot_buffer_lease_snapshot)) return sessionError(owner, error.InvalidOptions);
    if (out.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    if (out.reserved != 0) return sessionError(owner, error.InvalidOptions);
    const lease = owner.core.acquireOwnedBufferLease(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    return writeBufferLeaseSnapshot(owner, lease, out);
}

pub fn ot_session_create(
    context: ?*ContextHandle,
    options_ptr: ?*const c.ot_session_options,
    out_session_ptr: ?*c.ot_handle,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const options = options_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_session_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (options.struct_size != @sizeOf(c.ot_session_options)) return sessionError(owner, error.InvalidOptions);
    if (options.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    if (options.reserved != 0) return sessionError(owner, error.InvalidOptions);
    if (options.chunk_size == 0 or options.max_bytes == 0 or
        options.max_bytes % options.chunk_size != 0 or
        options.max_bytes / options.chunk_size > std.math.maxInt(u32))
    {
        return sessionError(owner, error.InvalidOptions);
    }
    const session = owner.core.createSession(.{
        .chunk_size = options.chunk_size,
        .chunk_count = @intCast(options.max_bytes / options.chunk_size),
        .span_capacity = options.span_capacity,
        .control_capacity = options.control_capacity,
    }) catch |err| return sessionError(owner, err);
    out.* = handleToC(session);
    return c.OT_OK;
}

pub fn ot_session_get_write_limit(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    out_bytes_ptr: ?*u64,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_bytes_ptr orelse return sessionError(owner, error.InvalidOptions);
    const value = owner.core.getSession(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    out.* = @min(value.output.atomicByteLimit(), std.math.maxInt(u32));
    return c.OT_OK;
}

pub fn ot_session_write(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    bytes_ptr: ?[*]const u8,
    byte_count: u32,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (byte_count != 0 and bytes_ptr == null) return sessionError(owner, error.InvalidOptions);
    const bytes = if (bytes_ptr) |ptr| ptr[0..byte_count] else &.{};
    owner.core.writeSession(handleFromC(id.*), bytes) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_session_attach_renderer(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    options_ptr: ?*const c.ot_session_renderer_options,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const options = options_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (options.struct_size != @sizeOf(c.ot_session_renderer_options)) return sessionError(owner, error.InvalidOptions);
    if (options.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    if (options.remote > 1 or options.reserved != 0) return sessionError(owner, error.InvalidOptions);
    owner.core.attachSessionRenderer(handleFromC(id.*), options.width, options.height, .{
        .remote_mode = if (options.remote == 1) .remote else .local,
    }) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_session_attach_renderer_with_env(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    options_ptr: ?*const c.ot_session_renderer_env_options,
    environment_ptr: ?[*]const u8,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const options = options_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (options.struct_size != @sizeOf(c.ot_session_renderer_env_options)) return sessionError(owner, error.InvalidOptions);
    if (options.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    const session = @import("session.zig");
    if (options.reserved != 0 or options.remote_mode > c.OT_SESSION_REMOTE_REMOTE or
        options.entry_count > session.environment_entries_max or options.byte_count > session.environment_bytes_max or
        (options.byte_count != 0 and environment_ptr == null)) return sessionError(owner, error.InvalidOptions);
    const bytes = if (environment_ptr) |ptr| ptr[0..options.byte_count] else &.{};
    var entries: [session.environment_entries_max]session.EnvironmentEntry = undefined;
    var offset: usize = 0;
    for (entries[0..options.entry_count]) |*entry| {
        if (bytes.len - offset < 8) return sessionError(owner, error.InvalidOptions);
        const key_len = std.mem.readInt(u32, bytes[offset..][0..4], .little);
        const value_len = std.mem.readInt(u32, bytes[offset + 4 ..][0..4], .little);
        offset += 8;
        if (key_len > bytes.len - offset) return sessionError(owner, error.InvalidOptions);
        entry.key = bytes[offset..][0..key_len];
        offset += key_len;
        if (value_len > bytes.len - offset) return sessionError(owner, error.InvalidOptions);
        entry.value = bytes[offset..][0..value_len];
        offset += value_len;
    }
    if (offset != bytes.len) return sessionError(owner, error.InvalidOptions);
    owner.core.attachSessionRenderer(handleFromC(id.*), options.width, options.height, .{
        .remote_mode = switch (options.remote_mode) {
            c.OT_SESSION_REMOTE_AUTO => .auto,
            c.OT_SESSION_REMOTE_LOCAL => .local,
            c.OT_SESSION_REMOTE_REMOTE => .remote,
            else => unreachable,
        },
        .forwarded_env = entries[0..options.entry_count],
    }) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_session_render(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    force: u32,
    out_result_ptr: ?*u32,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_result_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (force > 1) return sessionError(owner, error.InvalidOptions);
    const result = owner.core.renderSession(handleFromC(id.*), force == 1) catch |err| return sessionError(owner, err);
    out.* = renderStatusToC(result);
    return c.OT_OK;
}

pub fn renderStatusToC(result: @import("session.zig").RenderStatus) u32 {
    return switch (result) {
        .presented => c.OT_RENDER_PRESENTED,
        .pending => c.OT_RENDER_PENDING,
        .skipped => c.OT_RENDER_SKIPPED,
        .failed => c.OT_RENDER_FAILED,
    };
}

pub fn ot_session_resize_renderer(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    width: u32,
    height: u32,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.resizeSessionRenderer(handleFromC(id.*), width, height) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_session_draw_buffer(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    source_ptr: ?*const c.ot_handle,
    x: i32,
    y: i32,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const session = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const source = source_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.drawSessionBuffer(handleFromC(session.*), handleFromC(source.*), x, y) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_session_set_debug_overlay(context: ?*ContextHandle, session_ptr: ?*const c.ot_handle, enabled: u32, corner: u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (enabled > 1) return sessionError(owner, error.InvalidOptions);
    owner.core.sessionSetDebugOverlay(handleFromC(id.*), enabled == 1, corner) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_session_update_stats(context: ?*ContextHandle, session_ptr: ?*const c.ot_handle, overall_ms: f64, fps: u32, callback_ms: f64) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.sessionUpdateStats(handleFromC(id.*), overall_ms, fps, callback_ms) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_session_update_memory_stats(context: ?*ContextHandle, session_ptr: ?*const c.ot_handle, heap_used: u32, heap_total: u32, array_buffers: u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.sessionUpdateMemoryStats(handleFromC(id.*), heap_used, heap_total, array_buffers) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_session_dump_hit_grid(context: ?*ContextHandle, session_ptr: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.sessionDumpHitGrid(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_session_get_renderer_state(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    out_state_ptr: ?*c.ot_session_renderer_state,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_state_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (out.struct_size != @sizeOf(c.ot_session_renderer_state)) return sessionError(owner, error.InvalidOptions);
    if (out.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    const value = owner.core.getSession(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    const attached = value.renderer orelse return sessionError(owner, error.RendererNotAttached);
    out.* = .{
        .struct_size = @sizeOf(c.ot_session_renderer_state),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .width = attached.width,
        .height = attached.height,
        .frame_count = attached.getRenderStats().frameCount,
        .frame_pending = @intFromBool(value.frame_end_offset != null),
        .reserved = 0,
    };
    return c.OT_OK;
}

pub fn ot_session_acquire_buffer_lease(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    which: u32,
    out_snapshot_ptr: ?*c.ot_buffer_lease_snapshot,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_snapshot_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (out.struct_size != @sizeOf(c.ot_buffer_lease_snapshot)) return sessionError(owner, error.InvalidOptions);
    if (out.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    if (out.reserved != 0) return sessionError(owner, error.InvalidOptions);
    const target: @import("context.zig").RendererBuffer = switch (which) {
        c.OT_SESSION_BUFFER_CURRENT => .current,
        c.OT_SESSION_BUFFER_NEXT => .next,
        else => return sessionError(owner, error.InvalidOptions),
    };
    const lease = owner.core.acquireSessionBufferLease(handleFromC(id.*), target) catch |err| return sessionError(owner, err);
    return writeBufferLeaseSnapshot(owner, lease, out);
}

fn writeBufferLeaseSnapshot(owner: *ContextHandle, lease: ObjectHandle, out: *c.ot_buffer_lease_snapshot) c.ot_status {
    const snapshot = owner.core.bufferLeaseSnapshot(lease) catch |err| {
        owner.core.releaseBufferLease(lease) catch unreachable;
        return sessionError(owner, err);
    };
    out.* = .{
        .struct_size = @sizeOf(c.ot_buffer_lease_snapshot),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .lease = handleToC(lease),
        .width = snapshot.width,
        .height = snapshot.height,
        .generation = snapshot.generation,
        .char_ptr = @intFromPtr(snapshot.buffer.char.ptr),
        .fg_ptr = @intFromPtr(snapshot.buffer.fg.ptr),
        .bg_ptr = @intFromPtr(snapshot.buffer.bg.ptr),
        .attributes_ptr = @intFromPtr(snapshot.buffer.attributes.ptr),
        .reserved = 0,
    };
    return c.OT_OK;
}

pub fn ot_buffer_lease_validate(context: ?*ContextHandle, lease_ptr: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = lease_ptr orelse return sessionError(owner, error.InvalidOptions);
    _ = owner.core.bufferLeaseSnapshot(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_buffer_lease_release(context: ?*ContextHandle, lease_ptr: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = lease_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.releaseBufferLease(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_buffer_lease_get_real_char_size(context: ?*ContextHandle, lease_ptr: ?*const c.ot_handle, add_line_breaks: u32, out_size_ptr: ?*u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = lease_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_size_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (add_line_breaks > 1) return sessionError(owner, error.InvalidOptions);
    const snapshot = owner.core.bufferLeaseSnapshot(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    out.* = snapshot.getRealCharSize(add_line_breaks == 1) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_buffer_lease_write_resolved_chars(context: ?*ContextHandle, lease_ptr: ?*const c.ot_handle, bytes_ptr: ?[*]u8, capacity: u32, add_line_breaks: u32, cell_lengths_ptr: ?[*]u8, cell_capacity: u32, out_written_ptr: ?*u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = lease_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_written_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (add_line_breaks > 1 or (capacity != 0 and bytes_ptr == null)) return sessionError(owner, error.InvalidOptions);
    if (cell_capacity != 0 and cell_lengths_ptr == null) return sessionError(owner, error.InvalidOptions);
    const snapshot = owner.core.bufferLeaseSnapshot(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    const bytes: []u8 = if (bytes_ptr) |ptr| ptr[0..capacity] else &.{};
    out.* = if (cell_lengths_ptr) |lengths|
        snapshot.writeResolvedCells(bytes, add_line_breaks == 1, lengths[0..cell_capacity]) catch |err| return sessionError(owner, err)
    else
        snapshot.writeResolvedChars(bytes, add_line_breaks == 1) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_session_read_output(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    bytes_ptr: ?[*]u8,
    capacity: u32,
    out_ticket_ptr: ?*c.ot_output_ticket,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_ticket_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (capacity != 0 and bytes_ptr == null) return sessionError(owner, error.InvalidOptions);
    const bytes: []u8 = if (bytes_ptr) |ptr| ptr[0..capacity] else &.{};
    const ticket = owner.core.readOutput(handleFromC(id.*), bytes) catch |err| return sessionError(owner, err);
    out.* = if (ticket) |value| .{
        .session = handleToC(value.session),
        .request_id = value.request_id,
        .byte_count = value.len,
        .reserved = 0,
    } else std.mem.zeroes(c.ot_output_ticket);
    return c.OT_OK;
}

pub fn ot_session_setup_terminal(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    options_ptr: ?*const c.ot_session_terminal_options,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const options = options_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (options.struct_size != @sizeOf(c.ot_session_terminal_options)) return sessionError(owner, error.InvalidOptions);
    if (options.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    const known_flags: u32 = c.OT_TERMINAL_ALTERNATE_SCREEN | c.OT_TERMINAL_MOUSE |
        c.OT_TERMINAL_MOUSE_MOVEMENT | c.OT_TERMINAL_CLEAR_ON_CLOSE;
    if (options.flags & ~known_flags != 0 or options.kitty_keyboard_flags > 31) {
        return sessionError(owner, error.InvalidOptions);
    }
    owner.core.setupSessionTerminal(handleFromC(id.*), .{
        .use_alternate_screen = options.flags & c.OT_TERMINAL_ALTERNATE_SCREEN != 0,
        .mouse = options.flags & c.OT_TERMINAL_MOUSE != 0,
        .mouse_movement = options.flags & c.OT_TERMINAL_MOUSE_MOVEMENT != 0,
        .clear_on_close = options.flags & c.OT_TERMINAL_CLEAR_ON_CLOSE != 0,
        .kitty_keyboard_flags = @intCast(options.kitty_keyboard_flags),
    }) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_session_suspend(context: ?*ContextHandle, session_ptr: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.suspendSession(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_session_resume(context: ?*ContextHandle, session_ptr: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.resumeSession(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_session_get_terminal_state(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    out_phase_ptr: ?*u32,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_phase_ptr orelse return sessionError(owner, error.InvalidOptions);
    const state = owner.core.getSessionTerminalState(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    out.* = switch (state.phase) {
        .uninitialized => c.OT_TERMINAL_UNINITIALIZED,
        .setting_up => c.OT_TERMINAL_SETTING_UP,
        .active => c.OT_TERMINAL_ACTIVE,
        .suspending => c.OT_TERMINAL_SUSPENDING,
        .suspended => c.OT_TERMINAL_SUSPENDED,
        .resuming => c.OT_TERMINAL_RESUMING,
        .closing => c.OT_TERMINAL_CLOSING,
        .restored => c.OT_TERMINAL_RESTORED,
        .failed => c.OT_TERMINAL_FAILED,
        .cancelled => c.OT_TERMINAL_CANCELLED,
    };
    return c.OT_OK;
}

pub fn ot_session_pump(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    now_ns: u64,
    work_budget: u32,
    out_result_ptr: ?*c.ot_session_pump_result,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_result_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (out.struct_size != @sizeOf(c.ot_session_pump_result)) return sessionError(owner, error.InvalidOptions);
    if (out.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    const result = owner.core.pumpSession(handleFromC(id.*), now_ns, work_budget) catch |err| return sessionError(owner, err);
    out.* = .{
        .struct_size = @sizeOf(c.ot_session_pump_result),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .status = switch (result.status) {
            .idle => c.OT_PUMP_IDLE,
            .again => c.OT_PUMP_AGAIN,
            .output_pending => c.OT_PUMP_OUTPUT_PENDING,
            .wait_until => c.OT_PUMP_WAIT_UNTIL,
            .closed => c.OT_PUMP_CLOSED,
        },
        .reserved = 0,
        .deadline_ns = result.deadline_ns orelse 0,
    };
    return c.OT_OK;
}

pub fn ot_session_pump_exit(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    out_status_ptr: ?*u32,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_status_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.beginMutation() catch |err| return sessionError(owner, err);
    defer owner.core.mutating = false;
    const session = owner.core.getSession(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    const result = session.pumpExit() catch |err| return sessionError(owner, err);
    out.* = switch (result) {
        .again => c.OT_PUMP_AGAIN,
        .output_pending => c.OT_PUMP_OUTPUT_PENDING,
        .closed => c.OT_PUMP_CLOSED,
        .idle, .wait_until => unreachable,
    };
    return c.OT_OK;
}

pub fn ot_session_control(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    options_ptr: ?*const c.ot_session_control_options,
    bytes_ptr: ?[*]const u8,
    byte_count: u32,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const options = options_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (options.struct_size != @sizeOf(c.ot_session_control_options)) return sessionError(owner, error.InvalidOptions);
    if (options.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    if (options.reserved != 0 or (byte_count != 0 and bytes_ptr == null)) return sessionError(owner, error.InvalidOptions);
    const payload = options.kind == c.OT_CONTROL_CAPABILITY_RESPONSE or options.kind == c.OT_CONTROL_TITLE or options.kind == c.OT_CONTROL_CURSOR or options.kind == c.OT_CONTROL_PALETTE_QUERY;
    if ((!payload and byte_count != 0) or (payload and options.argument != 0)) return sessionError(owner, error.InvalidOptions);
    const bytes = if (bytes_ptr) |ptr| ptr[0..byte_count] else &.{};
    const command: @import("session.zig").Control = switch (options.kind) {
        c.OT_CONTROL_CAPABILITY_RESPONSE => .{ .capability_response = bytes },
        c.OT_CONTROL_TITLE => .{ .title = bytes },
        c.OT_CONTROL_MOUSE => .{ .mouse = switch (options.argument) {
            0 => .disabled,
            1 => .drag,
            2 => .motion,
            else => return sessionError(owner, error.InvalidOptions),
        } },
        c.OT_CONTROL_KITTY_KEYBOARD_FLAGS => .{ .kitty_keyboard_flags = if (options.argument <= 31)
            @intCast(options.argument)
        else
            return sessionError(owner, error.InvalidOptions) },
        c.OT_CONTROL_RESTORE_MODES => .restore_modes,
        c.OT_CONTROL_QUERY_PIXEL_RESOLUTION => .query_pixel_resolution,
        c.OT_CONTROL_QUERY_THEME_COLORS => .query_theme_colors,
        c.OT_CONTROL_RESET_BACKGROUND => .reset_background,
        c.OT_CONTROL_PALETTE_QUERY => .{ .palette_query = bytes },
        c.OT_CONTROL_CURSOR => blk: {
            if (bytes.len != @sizeOf(c.ot_session_cursor_update)) return sessionError(owner, error.InvalidOptions);
            var update: c.ot_session_cursor_update = undefined;
            @memcpy(std.mem.asBytes(&update), bytes);
            if (update.fields & ~@as(u32, 31) != 0 or update.visible > 1 or update.style > 3 or
                update.blinking > 1 or update.mouse_pointer > 5) return sessionError(owner, error.InvalidOptions);
            if (update.fields & c.OT_CURSOR_POSITION == 0 and (update.x != 0 or update.y != 0 or update.visible != 0)) {
                return sessionError(owner, error.InvalidOptions);
            }
            if ((update.fields & c.OT_CURSOR_STYLE == 0 and update.style != 0) or
                (update.fields & c.OT_CURSOR_BLINKING == 0 and update.blinking != 0) or
                (update.fields & c.OT_CURSOR_MOUSE_POINTER == 0 and update.mouse_pointer != 0)) return sessionError(owner, error.InvalidOptions);
            if (update.fields & c.OT_CURSOR_COLOR == 0) {
                for (update.color) |channel| if (channel != 0) return sessionError(owner, error.InvalidOptions);
            }
            break :blk .{ .cursor = .{
                .position = if (update.fields & c.OT_CURSOR_POSITION != 0) .{
                    .x = update.x,
                    .y = update.y,
                    .visible = update.visible != 0,
                } else null,
                .style = if (update.fields & c.OT_CURSOR_STYLE != 0) @enumFromInt(update.style) else null,
                .blinking = if (update.fields & c.OT_CURSOR_BLINKING != 0) update.blinking != 0 else null,
                .color = if (update.fields & c.OT_CURSOR_COLOR != 0) update.color else null,
                .cursor = if (update.fields & c.OT_CURSOR_MOUSE_POINTER != 0) @enumFromInt(update.mouse_pointer) else null,
            } };
        },
        else => return sessionError(owner, error.InvalidOptions),
    };
    if (options.kind >= c.OT_CONTROL_RESTORE_MODES and options.argument != 0) return sessionError(owner, error.InvalidOptions);
    owner.core.controlSession(handleFromC(id.*), command) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_session_clipboard(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    target: u32,
    bytes_ptr: ?[*]const u8,
    byte_count: u32,
    out_written_ptr: ?*u32,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_written_ptr orelse return sessionError(owner, error.InvalidOptions);
    out.* = 0;
    if (target > 3 or (byte_count != 0 and bytes_ptr == null)) return sessionError(owner, error.InvalidOptions);
    const bytes = if (bytes_ptr) |ptr| ptr[0..byte_count] else &.{};
    out.* = @intFromBool(owner.core.writeSessionClipboard(handleFromC(id.*), @enumFromInt(target), bytes) catch |err| return sessionError(owner, err));
    return c.OT_OK;
}

pub fn ot_session_set_palette_state(context: ?*ContextHandle, session_ptr: ?*const c.ot_handle, palette_ptr: ?[*]const [4]u16, color_count: u32, foreground_ptr: ?*const [4]u16, background_ptr: ?*const [4]u16, epoch: u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const foreground = foreground_ptr orelse return sessionError(owner, error.InvalidOptions);
    const background = background_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (color_count > 256 or (color_count != 0 and palette_ptr == null)) return sessionError(owner, error.InvalidOptions);
    for (foreground.*) |channel| if (channel > 255) return sessionError(owner, error.InvalidOptions);
    for (background.*) |channel| if (channel > 255) return sessionError(owner, error.InvalidOptions);
    const palette = if (palette_ptr) |ptr| ptr[0..color_count] else &.{};
    for (palette) |color| {
        for (color) |channel| if (channel > 255) return sessionError(owner, error.InvalidOptions);
    }
    owner.core.beginMutation() catch |err| return sessionError(owner, err);
    defer owner.core.mutating = false;
    const value = owner.core.getSession(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    value.setPaletteState(palette, foreground.*, background.*, epoch) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_session_notification(context: ?*ContextHandle, session_ptr: ?*const c.ot_handle, message_ptr: ?[*]const u8, message_len: u32, title_ptr: ?[*]const u8, title_len: u32, out_written_ptr: ?*u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_written_ptr orelse return sessionError(owner, error.InvalidOptions);
    out.* = 0;
    if ((message_len != 0 and message_ptr == null) or (title_len != 0 and title_ptr == null)) return sessionError(owner, error.InvalidOptions);
    owner.core.beginMutation() catch |err| return sessionError(owner, err);
    defer owner.core.mutating = false;
    const value = owner.core.getSession(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    out.* = @intFromBool(value.triggerNotification(if (message_ptr) |ptr| ptr[0..message_len] else &.{}, if (title_ptr) |ptr| ptr[0..title_len] else null) catch |err| return sessionError(owner, err));
    return c.OT_OK;
}

pub fn ot_session_get_capabilities(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    out_capabilities_ptr: ?*c.ot_session_capabilities,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_capabilities_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (out.struct_size != @sizeOf(c.ot_session_capabilities)) return sessionError(owner, error.InvalidOptions);
    if (out.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    const value = owner.core.getSessionRenderer(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    const term = &value.terminal;
    const caps = term.getCapabilities();
    var result = std.mem.zeroes(c.ot_session_capabilities);
    result.struct_size = @sizeOf(c.ot_session_capabilities);
    result.abi_version = c.OT_CONTEXT_ABI_VERSION;
    inline for (.{
        .{ "kitty_keyboard", c.OT_CAP_KITTY_KEYBOARD },
        .{ "kitty_graphics", c.OT_CAP_KITTY_GRAPHICS },
        .{ "rgb", c.OT_CAP_RGB },
        .{ "ansi256", c.OT_CAP_ANSI256 },
        .{ "sgr_pixels", c.OT_CAP_SGR_PIXELS },
        .{ "color_scheme_updates", c.OT_CAP_COLOR_SCHEME_UPDATES },
        .{ "explicit_width", c.OT_CAP_EXPLICIT_WIDTH },
        .{ "scaled_text", c.OT_CAP_SCALED_TEXT },
        .{ "sixel", c.OT_CAP_SIXEL },
        .{ "focus_tracking", c.OT_CAP_FOCUS_TRACKING },
        .{ "sync", c.OT_CAP_SYNC },
        .{ "bracketed_paste", c.OT_CAP_BRACKETED_PASTE },
        .{ "hyperlinks", c.OT_CAP_HYPERLINKS },
        .{ "osc52", c.OT_CAP_OSC52 },
        .{ "notifications", c.OT_CAP_NOTIFICATIONS },
        .{ "explicit_cursor_positioning", c.OT_CAP_EXPLICIT_CURSOR_POSITIONING },
        .{ "remote", c.OT_CAP_REMOTE },
    }) |field| {
        if (@field(caps, field[0])) result.flags |= field[1];
    }
    result.width_method = @intFromEnum(caps.unicode);
    result.multiplexer = @intFromEnum(term.multiplexer);
    result.image_protocol = @intFromEnum(term.image_protocol);
    result.osc52_support = @intFromEnum(term.osc52_support);
    result.kitty_keyboard_flags = term.opts.kitty_keyboard_flags;
    result.term_name_len = @intCast(term.term_info.name_len);
    result.term_version_len = @intCast(term.term_info.version_len);
    result.term_from_xtversion = @intFromBool(term.term_info.from_xtversion);
    @memcpy(result.term_name[0..result.term_name_len], term.term_info.name[0..result.term_name_len]);
    @memcpy(result.term_version[0..result.term_version_len], term.term_info.version[0..result.term_version_len]);
    out.* = result;
    return c.OT_OK;
}

pub fn ot_session_complete_output(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    ticket_ptr: ?*const c.ot_output_ticket,
    success: u32,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const ticket = ticket_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (success > 1 or ticket.reserved != 0) return sessionError(owner, error.InvalidOptions);
    owner.core.completeOutput(handleFromC(id.*), .{
        .session = handleFromC(ticket.session),
        .request_id = ticket.request_id,
        .len = ticket.byte_count,
    }, if (success == 1) .written else .failed) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_session_close(context: ?*ContextHandle, session_ptr: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.beginSessionClose(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_session_cancel(context: ?*ContextHandle, session_ptr: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.cancelSession(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_session_get_state(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    out_state_ptr: ?*u32,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_state_ptr orelse return sessionError(owner, error.InvalidOptions);
    const session = owner.core.getSession(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    out.* = switch (session.state) {
        .open => c.OT_SESSION_OPEN,
        .closing => c.OT_SESSION_CLOSING,
        .closed => c.OT_SESSION_CLOSED_STATE,
        .failed => c.OT_SESSION_FAILED,
        .cancelled => c.OT_SESSION_CANCELLED_STATE,
    };
    return c.OT_OK;
}

pub fn ot_session_destroy(context: ?*ContextHandle, session_ptr: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const session = handleFromC(id.*);
    _ = owner.core.getSession(session) catch |err| return sessionError(owner, err);
    owner.core.destroy(session) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_scene_create_node(context: ?*ContextHandle, session_ptr: ?*const c.ot_handle, kind: u32, num: u32, out_node_ptr: ?*c.ot_handle) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_node_ptr orelse return sessionError(owner, error.InvalidOptions);
    const result = owner.core.sceneCreateNode(handleFromC(id.*), kind, num) catch |err| return sessionError(owner, err);
    out.* = handleToC(result);
    return c.OT_OK;
}

pub fn ot_scene_destroy_node(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.sceneDestroyNode(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_scene_move_node(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, parent_ptr: ?*const c.ot_handle, index: u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    const parent = if (parent_ptr) |ptr| handleFromC(ptr.*) else null;
    owner.core.sceneMoveNode(handleFromC(id.*), parent, index) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_scene_set_measure(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, callback: c.ot_scene_measure_callback) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.sceneSetMeasure(handleFromC(id.*), @ptrCast(callback)) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_scene_has_measure(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, out_ptr: ?*u32) callconv(.c) c.ot_status {
    const status = sceneReadStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_ptr orelse return sessionError(owner, error.InvalidOptions);
    out.* = @intFromBool(owner.core.sceneHasMeasure(handleFromC(id.*)) catch |err| return sessionError(owner, err));
    return c.OT_OK;
}

pub fn ot_scene_mark_dirty(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.sceneMarkDirty(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_scene_set_style(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, group: u32, kind: u32, edge: u32, unit: u32, value: f32, flags: u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.sceneSetStyle(handleFromC(id.*), group, kind, edge, unit, value, flags) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_scene_get_style(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, group: u32, kind: u32, edge: u32, out_ptr: ?*c.ot_scene_style_value) callconv(.c) c.ot_status {
    const status = sceneReadStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (out.struct_size != @sizeOf(c.ot_scene_style_value)) return sessionError(owner, error.InvalidOptions);
    if (out.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    const result = owner.core.sceneGetStyle(handleFromC(id.*), group, kind, edge) catch |err| return sessionError(owner, err);
    out.* = .{ .struct_size = @sizeOf(c.ot_scene_style_value), .abi_version = c.OT_CONTEXT_ABI_VERSION, .unit = result.unit, .value = result.value };
    return c.OT_OK;
}

pub fn ot_scene_set_paint(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, options_ptr: ?*const c.ot_scene_paint_options) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    const options = options_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (options.struct_size != @sizeOf(c.ot_scene_paint_options) or options.reserved != 0 or options.focusable > 1) return sessionError(owner, error.InvalidOptions);
    if (options.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    owner.core.sceneSetPaint(handleFromC(id.*), paintFromC(options)) catch |err| {
        return sessionError(owner, err);
    };
    return c.OT_OK;
}

/// Maps validated paint options onto the scene record. Callers check
/// size/version, reserved, and focusable first.
fn paintFromC(options: *const c.ot_scene_paint_options) scene.Paint {
    return .{
        .zIndex = options.z_index,
        .opacity = options.opacity,
        .translateX = options.translate_x,
        .translateY = options.translate_y,
        .borderSides = options.border_sides,
        .shouldFill = options.should_fill,
        .background = options.background,
        .borderColor = options.border_color,
        .borderStyle = options.border_style,
        .focusable = options.focusable == 1,
        .focusedBorderColor = options.focused_border_color,
    };
}

pub fn ot_scene_flush(
    context: ?*ContextHandle,
    styles_ptr: ?[*]const c.ot_scene_style_update,
    style_count: u32,
    backgrounds_ptr: ?[*]const c.ot_scene_background_update,
    background_count: u32,
    paints_ptr: ?[*]const c.ot_scene_paint_update,
    paint_count: u32,
    out_applied_ptr: ?*u32,
) callconv(.c) c.ot_status {
    if (out_applied_ptr) |out| out.* = 0;
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const out = out_applied_ptr orelse return sessionError(owner, error.InvalidOptions);
    const counts = [_]u32{ style_count, background_count, paint_count };
    const pointers = [_]bool{ styles_ptr != null, backgrounds_ptr != null, paints_ptr != null };
    for (counts) |count| {
        if (count > c.OT_SCENE_MUTATIONS_MAX) return sessionError(owner, error.ObjectLimit);
    }
    for (counts, pointers) |count, present| {
        if (count != 0 and !present) return sessionError(owner, error.InvalidOptions);
    }
    if (style_count == 0 and background_count == 0 and paint_count == 0) return c.OT_OK;
    // One admission covers the whole batch; the Locked setters do not call user code.
    owner.core.beginMutation() catch |err| return sessionError(owner, err);
    defer owner.core.mutating = false;
    const styles = if (styles_ptr) |ptr| ptr[0..style_count] else &.{};
    const backgrounds = if (backgrounds_ptr) |ptr| ptr[0..background_count] else &.{};
    const paints = if (paints_ptr) |ptr| ptr[0..paint_count] else &.{};
    const style_status = flushStyles(owner, styles, out);
    if (style_status != c.OT_OK) return style_status;
    const background_status = flushBackgrounds(owner, backgrounds, out);
    if (background_status != c.OT_OK) return background_status;
    return flushPaints(owner, paints, out);
}

fn flushStyles(
    owner: *ContextHandle,
    styles: []const c.ot_scene_style_update,
    out: *u32,
) c.ot_status {
    for (styles) |*entry| {
        owner.core.sceneSetStyleLocked(
            handleFromC(entry.node),
            entry.group,
            entry.kind,
            entry.edge,
            entry.unit,
            entry.value,
            entry.flags,
        ) catch |err| return sessionError(owner, err);
        out.* += 1;
    }
    return c.OT_OK;
}

fn flushBackgrounds(
    owner: *ContextHandle,
    backgrounds: []const c.ot_scene_background_update,
    out: *u32,
) c.ot_status {
    for (backgrounds) |*entry| {
        if (entry.fields == c.OT_SCENE_UPDATE_SKIP) {
            out.* += 1;
            continue;
        }
        if (entry.fields != c.OT_SCENE_UPDATE_APPLY or entry.reserved != 0) {
            return sessionError(owner, error.InvalidOptions);
        }
        owner.core.sceneSetBackgroundLocked(handleFromC(entry.node), entry.background) catch |err| {
            return sessionError(owner, err);
        };
        out.* += 1;
    }
    return c.OT_OK;
}

fn flushPaints(
    owner: *ContextHandle,
    paints: []const c.ot_scene_paint_update,
    out: *u32,
) c.ot_status {
    for (paints) |*entry| {
        const options = &entry.paint;
        if (options.struct_size != @sizeOf(c.ot_scene_paint_options) or options.reserved != 0 or
            options.focusable > 1)
        {
            return sessionError(owner, error.InvalidOptions);
        }
        if (options.abi_version != c.OT_CONTEXT_ABI_VERSION) {
            return sessionError(owner, error.UnsupportedVersion);
        }
        owner.core.sceneSetPaintLocked(handleFromC(entry.node), paintFromC(options)) catch |err| {
            return sessionError(owner, err);
        };
        out.* += 1;
    }
    return c.OT_OK;
}

pub fn ot_scene_set_surface(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, buffer_ptr: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const node = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    const buffer = if (buffer_ptr) |ptr| handleFromC(ptr.*) else null;
    owner.core.sceneSetSurface(handleFromC(node.*), buffer) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_scene_set_box_details(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, options_ptr: ?*const c.ot_scene_box_details, title_ptr: ?[*]const u8, title_bytes: u32, bottom_ptr: ?[*]const u8, bottom_bytes: u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    const options = options_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (options.struct_size != @sizeOf(c.ot_scene_box_details) or options.reserved != 0 or options.flags & ~@as(u32, 3) != 0) return sessionError(owner, error.InvalidOptions);
    if (options.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    if ((title_bytes != 0 and title_ptr == null) or (bottom_bytes != 0 and bottom_ptr == null)) return sessionError(owner, error.InvalidOptions);
    if (options.flags & 1 == 0) for (options.title_color) |channel| {
        if (channel != 0) return sessionError(owner, error.InvalidOptions);
    };
    if (options.flags & 2 == 0) {
        for (options.border_characters) |char| if (char != 0) return sessionError(owner, error.InvalidOptions);
    }
    owner.core.sceneSetBoxDetails(handleFromC(id.*), .{
        .title = if (title_ptr) |bytes| bytes[0..title_bytes] else "",
        .bottom_title = if (bottom_ptr) |bytes| bytes[0..bottom_bytes] else "",
        .title_alignment = options.title_alignment,
        .bottom_title_alignment = options.bottom_title_alignment,
        .title_color = if (options.flags & 1 != 0) options.title_color else null,
        .custom_border_chars = if (options.flags & 2 != 0) options.border_characters else null,
    }) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_scene_set_box_border_style(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, style: u32, sides: u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.sceneSetBoxBorderStyle(handleFromC(id.*), style, sides) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

test "Context Box details ABI validates records before publishing titles and styles" {
    var owner: ContextHandle = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = undefined, .owner_thread = std.Thread.getCurrentId() };
    defer owner.io_threaded.deinit();
    owner.core = try Context.init(std.testing.allocator, owner.io_threaded.io(), .{});
    defer owner.core.deinit() catch unreachable;
    const session_id = try owner.core.createSession(.{ .chunk_size = 4096 });
    try owner.core.attachSessionRenderer(session_id, 16, 5, .{});
    _ = try owner.core.sceneCreateNode(session_id, 0, 1);
    const box = try owner.core.sceneCreateNode(session_id, 1, 2);
    const id: c.ot_handle = .{ .context_id = box.context_id, .slot = box.slot, .generation = box.generation };
    var details = std.mem.zeroes(c.ot_scene_box_details);
    details.struct_size = @sizeOf(c.ot_scene_box_details);
    details.abi_version = c.OT_CONTEXT_ABI_VERSION;
    details.flags = 3;
    details.title_color = .{ 1, 2, 3, 255 };
    details.border_characters = @splat('+');
    var title = "owned".*;
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_box_details(&owner, &id, &details, &title, title.len, null, 0));
    @memset(&title, 'x');
    const node = &(try owner.core.getRenderable(box)).scene_node.?;
    try std.testing.expectEqualStrings("owned", node.control.box.?.title);
    for (0..8) |field| {
        var invalid = details;
        switch (field) {
            0 => invalid.struct_size -= 1,
            1 => invalid.abi_version += 1,
            2 => invalid.flags = 4,
            3 => invalid.reserved = 1,
            4 => invalid.title_alignment = 3,
            5 => invalid.bottom_title_alignment = 3,
            6 => invalid.title_color[0] = 256,
            7 => invalid.border_characters[0] = 0x4e16,
            else => unreachable,
        }
        try std.testing.expectEqual(if (field == 1) c.OT_UNSUPPORTED_VERSION else c.OT_INVALID_ARGUMENT, ot_scene_set_box_details(&owner, &id, &invalid, "new", 3, null, 0));
        try std.testing.expectEqualStrings("owned", node.control.box.?.title);
    }
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_box_details(&owner, &id, &details, null, 1, null, 0));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_box_border_style(&owner, &id, 4, 15));
    try std.testing.expect(node.control.box.?.custom_border_chars != null);
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_box_border_style(&owner, &id, 2, 15));
    try std.testing.expect(node.control.box.?.custom_border_chars == null);
    try std.testing.expectEqualStrings("owned", node.control.box.?.title);
    owner.core.mutating = true;
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_scene_set_box_details(&owner, &id, &details, null, 0, null, 0));
    owner.core.mutating = false;
    try owner.core.destroy(box);
    try std.testing.expectEqual(c.OT_STALE_HANDLE, ot_scene_set_box_details(&owner, &id, &details, null, 0, null, 0));
}

pub fn ot_scene_set_viewport(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, viewport_ptr: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const node = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    const viewport = if (viewport_ptr) |ptr| handleFromC(ptr.*) else null;
    owner.core.sceneSetViewport(handleFromC(node.*), viewport) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_scene_set_focus(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, focused: u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const node = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (focused > 1) return sessionError(owner, error.InvalidOptions);
    owner.core.sceneSetFocus(handleFromC(node.*), focused == 1) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_scene_get_layout(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, raw_yoga: u32, out_ptr: ?*c.ot_scene_layout) callconv(.c) c.ot_status {
    const status = sceneReadStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (out.struct_size != @sizeOf(c.ot_scene_layout)) return sessionError(owner, error.InvalidOptions);
    if (out.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    if (raw_yoga > 2) return sessionError(owner, error.InvalidOptions);
    const result = (if (raw_yoga == 2)
        owner.core.sceneGetPaintLayout(handleFromC(id.*))
    else
        owner.core.sceneGetLayout(handleFromC(id.*), raw_yoga == 1)) catch |err| return sessionError(owner, err);
    out.* = sceneLayoutToC(result);
    return c.OT_OK;
}

fn sceneLayoutToC(layout: scene.Layout) c.ot_scene_layout {
    return .{
        .struct_size = @sizeOf(c.ot_scene_layout),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .left = layout.left,
        .top = layout.top,
        .right = layout.right,
        .bottom = layout.bottom,
        .width = layout.width,
        .height = layout.height,
        .screen_x = layout.screenX,
        .screen_y = layout.screenY,
    };
}

pub fn ot_scene_set_slider(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, options_ptr: ?*const c.ot_scene_slider_options) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const node = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    const options = options_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (options.struct_size != @sizeOf(c.ot_scene_slider_options) or options.reserved != 0) return sessionError(owner, error.InvalidOptions);
    if (options.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    owner.core.sceneSetSlider(handleFromC(node.*), .{
        .orientation = options.orientation,
        .min = options.min,
        .max = options.max,
        .value = options.value,
        .viewport_size = options.viewport_size,
        .foreground = options.foreground,
        .background = options.background,
    }) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_scene_get_slider_thumb(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, out_ptr: ?*c.ot_scene_slider_thumb) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const node = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (out.struct_size != @sizeOf(c.ot_scene_slider_thumb)) return sessionError(owner, error.InvalidOptions);
    if (out.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    const thumb = owner.core.sceneGetSliderThumb(handleFromC(node.*)) catch |err| return sessionError(owner, err);
    out.* = .{ .struct_size = @sizeOf(c.ot_scene_slider_thumb), .abi_version = c.OT_CONTEXT_ABI_VERSION, .size = thumb.size, .start = thumb.start };
    return c.OT_OK;
}

pub fn ot_scene_set_arrow(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, options_ptr: ?*const c.ot_scene_arrow_options, text_ptr: ?[*]const u8, byte_count: u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const node = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    const options = options_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (options.struct_size != @sizeOf(c.ot_scene_arrow_options)) return sessionError(owner, error.InvalidOptions);
    if (options.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    if (text_ptr == null and byte_count != 0) return sessionError(owner, error.InvalidOptions);
    owner.core.sceneSetArrow(handleFromC(node.*), .{
        .direction = options.direction,
        .attributes = options.attributes,
        .foreground = options.foreground,
        .background = options.background,
        .text = if (text_ptr) |ptr| ptr[0..byte_count] else null,
    }) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_scene_set_text(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, bytes_ptr: ?[*]const u8, byte_count: u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const node = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (byte_count != 0 and bytes_ptr == null) return sessionError(owner, error.InvalidOptions);
    const bytes = if (bytes_ptr) |ptr| ptr[0..byte_count] else &.{};
    owner.core.sceneSetText(handleFromC(node.*), bytes) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_scene_set_styled_text(
    context: ?*ContextHandle,
    node_ptr: ?*const c.ot_handle,
    bytes_ptr: ?[*]const u8,
    byte_count: u32,
    chunks_ptr: ?[*]const c.ot_scene_text_chunk,
    chunk_count: u32,
) callconv(.c) c.ot_status {
    return setStyledText(c.ot_scene_text_chunk, false, context, node_ptr, bytes_ptr, byte_count, chunks_ptr, chunk_count, null, 0);
}

pub fn ot_scene_set_styled_text_with_links(
    context: ?*ContextHandle,
    node_ptr: ?*const c.ot_handle,
    bytes_ptr: ?[*]const u8,
    byte_count: u32,
    chunks_ptr: ?[*]const c.ot_scene_linked_text_chunk,
    chunk_count: u32,
    urls_ptr: ?[*]const u8,
    url_byte_count: u32,
) callconv(.c) c.ot_status {
    return setStyledText(c.ot_scene_linked_text_chunk, false, context, node_ptr, bytes_ptr, byte_count, chunks_ptr, chunk_count, urls_ptr, url_byte_count);
}

pub fn setStyledText(
    comptime Record: type,
    comptime shared: bool,
    context: ?*ContextHandle,
    node_ptr: ?*const c.ot_handle,
    bytes_ptr: ?[*]const u8,
    byte_count: u32,
    chunks_ptr: ?[*]const Record,
    chunk_count: u32,
    urls_ptr: ?[*]const u8,
    url_byte_count: u32,
) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const node = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    if ((byte_count != 0 and bytes_ptr == null) or (chunk_count != 0 and chunks_ptr == null) or
        (url_byte_count != 0 and urls_ptr == null) or (!shared and chunk_count > byte_count)) return sessionError(owner, error.InvalidOptions);
    const bytes = if (bytes_ptr) |ptr| ptr[0..byte_count] else &.{};
    const urls = if (urls_ptr) |ptr| ptr[0..url_byte_count] else &.{};
    const records = if (chunks_ptr) |ptr| ptr[0..chunk_count] else &.{};
    const chunks = owner.core.allocator.alloc(@import("context.zig").StyledTextChunk, chunk_count) catch |err| return sessionError(owner, err);
    defer owner.core.allocator.free(chunks);
    for (records, chunks) |record, *chunk| {
        const linked = Record == c.ot_scene_linked_text_chunk;
        const flags: u32 = c.OT_SCENE_TEXT_FOREGROUND | c.OT_SCENE_TEXT_BACKGROUND |
            (if (linked) @as(u32, c.OT_SCENE_TEXT_LINK) else 0);
        if (record.struct_size != @sizeOf(Record) or record.reserved != 0 or
            record.flags & ~flags != 0) return sessionError(owner, error.InvalidOptions);
        if (record.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
        var url: ?[]const u8 = null;
        if (linked) {
            if (record.link_offset > urls.len or record.link_byte_count > urls.len - record.link_offset) {
                return sessionError(owner, error.InvalidOptions);
            }
            if (record.flags & c.OT_SCENE_TEXT_LINK != 0) {
                url = urls[record.link_offset..][0..record.link_byte_count];
            } else if (record.link_offset != 0 or record.link_byte_count != 0) {
                return sessionError(owner, error.InvalidOptions);
            }
        }
        chunk.* = .{
            .byte_count = record.byte_count,
            .foreground = if (record.flags & c.OT_SCENE_TEXT_FOREGROUND != 0) record.foreground else null,
            .background = if (record.flags & c.OT_SCENE_TEXT_BACKGROUND != 0) record.background else null,
            .attributes = record.attributes,
            .link_url = url,
        };
    }
    if (shared) {
        owner.core.textBufferSetStyledText(handleFromC(node.*), bytes, chunks) catch |err| return sessionError(owner, err);
    } else {
        owner.core.sceneSetStyledText(handleFromC(node.*), bytes, chunks) catch |err| return sessionError(owner, err);
    }
    return c.OT_OK;
}

pub fn ot_scene_set_text_options(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, options_ptr: ?*const c.ot_scene_text_options) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const node = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    const options = options_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (options.struct_size != @sizeOf(c.ot_scene_text_options) or options.truncate > 1 or options.tab_color_set > 1) return sessionError(owner, error.InvalidOptions);
    if (options.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    if (options.tab_color_set == 0) for (options.tab_color) |channel| {
        if (channel != 0) return sessionError(owner, error.InvalidOptions);
    };
    const wrap_mode: @import("text-buffer-view.zig").WrapMode = switch (options.wrap_mode) {
        c.OT_SCENE_WRAP_NONE => .none,
        c.OT_SCENE_WRAP_CHAR => .char,
        c.OT_SCENE_WRAP_WORD => .word,
        else => return sessionError(owner, error.InvalidOptions),
    };
    owner.core.sceneSetTextOptions(handleFromC(node.*), .{
        .foreground = options.foreground,
        .background = options.background,
        .attributes = options.attributes,
        .wrap_mode = wrap_mode,
        .truncate = options.truncate == 1,
        .first_line_offset = options.first_line_offset,
        .scroll_x = options.scroll_x,
        .scroll_y = options.scroll_y,
        .tab_indicator = if (options.tab_indicator != 0) options.tab_indicator else null,
        .tab_color = if (options.tab_color_set == 1) options.tab_color else null,
    }) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_scene_set_text_selection(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, options_ptr: ?*const c.ot_scene_text_selection_options, out_changed_ptr: ?*u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const node = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    const options = options_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_changed_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (options.struct_size != @sizeOf(c.ot_scene_text_selection_options)) return sessionError(owner, error.InvalidOptions);
    if (options.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    const bg = c.OT_SCENE_TEXT_SELECTION_BACKGROUND;
    const fg = c.OT_SCENE_TEXT_SELECTION_FOREGROUND;
    if (options.reserved != 0 or options.flags & ~@as(u32, bg | fg) != 0) return sessionError(owner, error.InvalidOptions);
    if (options.flags & bg == 0) for (options.background) |channel| {
        if (channel != 0) return sessionError(owner, error.InvalidOptions);
    };
    if (options.flags & fg == 0) for (options.foreground) |channel| {
        if (channel != 0) return sessionError(owner, error.InvalidOptions);
    };
    const changed = owner.core.sceneSetTextSelection(handleFromC(node.*), .{
        .operation = options.operation,
        .behavior = options.behavior,
        .anchor_x = options.anchor_x,
        .anchor_y = options.anchor_y,
        .focus_x = options.focus_x,
        .focus_y = options.focus_y,
        .background = if (options.flags & bg != 0) options.background else null,
        .foreground = if (options.flags & fg != 0) options.foreground else null,
    }) catch |err| return sessionError(owner, err);
    out.* = @intFromBool(changed);
    return c.OT_OK;
}

pub fn ot_scene_get_text_selection(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, out_packed_ptr: ?*u64) callconv(.c) c.ot_status {
    const status = sceneReadStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const node = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_packed_ptr orelse return sessionError(owner, error.InvalidOptions);
    out.* = owner.core.sceneGetTextSelection(handleFromC(node.*)) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_scene_get_selected_text(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, bytes_ptr: ?[*]u8, capacity: u32, out_count_ptr: ?*u32) callconv(.c) c.ot_status {
    const status = sceneReadStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const node = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_count_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (capacity != 0 and bytes_ptr == null) return sessionError(owner, error.InvalidOptions);
    const bytes: []u8 = if (bytes_ptr) |ptr| ptr[0..capacity] else &.{};
    out.* = owner.core.sceneGetSelectedText(handleFromC(node.*), bytes) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_scene_get_text(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, bytes_ptr: ?[*]u8, capacity: u32, out_count_ptr: ?*u32) callconv(.c) c.ot_status {
    const status = sceneReadStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const node = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_count_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (capacity != 0 and bytes_ptr == null) return sessionError(owner, error.InvalidOptions);
    const bytes: []u8 = if (bytes_ptr) |ptr| ptr[0..capacity] else &.{};
    const count = owner.core.sceneGetText(handleFromC(node.*), bytes) catch |err| return sessionError(owner, err);
    out.* = count;
    return c.OT_OK;
}

pub fn ot_scene_get_text_info(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, out_ptr: ?*c.ot_scene_text_info) callconv(.c) c.ot_status {
    const status = sceneReadStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const node = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (out.struct_size != @sizeOf(c.ot_scene_text_info)) return sessionError(owner, error.InvalidOptions);
    if (out.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    const info = owner.core.sceneGetTextInfo(handleFromC(node.*)) catch |err| return sessionError(owner, err);
    out.* = .{
        .struct_size = @sizeOf(c.ot_scene_text_info),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .byte_count = info.byte_count,
        .text_length = info.text_length,
        .line_count = info.line_count,
        .virtual_line_count = info.virtual_line_count,
        .width_cols_max = info.width_cols_max,
        .reserved = 0,
    };
    return c.OT_OK;
}

pub fn ot_scene_get_text_lines(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, lines_ptr: ?[*]c.ot_scene_text_line, capacity: u32, out_count_ptr: ?*u32) callconv(.c) c.ot_status {
    const status = sceneReadStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const node = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_count_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (capacity != 0 and lines_ptr == null) return sessionError(owner, error.InvalidOptions);
    const lines: []@import("scene.zig").TextLine = if (lines_ptr) |ptr| @as([*]@import("scene.zig").TextLine, @ptrCast(ptr))[0..capacity] else &.{};
    const count = owner.core.sceneGetTextLines(handleFromC(node.*), lines) catch |err| return sessionError(owner, err);
    out.* = count;
    return c.OT_OK;
}

pub fn ot_scene_set_hooks(context: ?*ContextHandle, node_ptr: ?*const c.ot_handle, options_ptr: ?*const c.ot_scene_hooks) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const node = node_ptr orelse return sessionError(owner, error.InvalidOptions);
    const options = options_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (options.struct_size != @sizeOf(c.ot_scene_hooks) or options.reserved != 0) return sessionError(owner, error.InvalidOptions);
    if (options.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    owner.core.sceneSetHooks(handleFromC(node.*), options.flags, options.generation, options.initial_width, options.initial_height) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn frameRequestFromC(record: c.ot_scene_frame_request) !scene.FrameRequest {
    if (record.struct_size != @sizeOf(c.ot_scene_frame_request) or record.reserved[0] != 0 or record.reserved[1] != 0) return error.InvalidOptions;
    if (record.abi_version != c.OT_CONTEXT_ABI_VERSION) return error.UnsupportedVersion;
    return .{
        .session = handleFromC(record.session),
        .root = handleFromC(record.root),
        .node = handleFromC(record.node),
        .frame_id = record.frame_id,
        .request_id = record.request_id,
        .layout_epoch = record.layout_epoch,
        .hook_generation = record.hook_generation,
        .kind = record.kind,
        .num = record.num,
        .width = record.width,
        .height = record.height,
    };
}

pub fn ot_scene_frame_step_with_geometry(context: ?*ContextHandle, session_ptr: ?*const c.ot_handle, previous_ptr: ?*const c.ot_scene_frame_request, options_ptr: ?*const c.ot_scene_frame_options, max_paint_members: u32, max_work_items: u32, out_ptr: ?*c.ot_scene_frame_request, geometry_ptr: ?*c.ot_scene_frame_geometry) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const geometry = geometry_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (geometry.struct_size != @sizeOf(c.ot_scene_frame_geometry) or geometry.reserved != 0) return sessionError(owner, error.InvalidOptions);
    if (geometry.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const options = options_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (out.struct_size != @sizeOf(c.ot_scene_frame_request) or out.reserved[0] != 0 or out.reserved[1] != 0) return sessionError(owner, error.InvalidOptions);
    if (out.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    const previous = if (previous_ptr) |record| frameRequestFromC(record.*) catch |err| return sessionError(owner, err) else null;
    if (options.struct_size != @sizeOf(c.ot_scene_frame_options) or options.preserve_unwritten > 1 or options.use_mouse > 1) return sessionError(owner, error.InvalidOptions);
    if (options.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    const result = owner.core.sceneFrameStepWorkBudgeted(handleFromC(id.*), previous, .{
        .background = options.background,
        .use_mouse = options.use_mouse == 1,
        .excluded_hit_num = options.excluded_hit_num,
        .max_layout_rounds = options.max_layout_rounds,
        .max_host_requests = options.max_host_requests,
        .preserve_unwritten = options.preserve_unwritten == 1,
    }, max_paint_members, max_work_items) catch |err| return sessionError(owner, err);
    out.* = .{
        .struct_size = @sizeOf(c.ot_scene_frame_request),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .session = handleToC(result.session),
        .root = handleToC(result.root),
        .node = handleToC(result.node),
        .frame_id = result.frame_id,
        .request_id = result.request_id,
        .layout_epoch = result.layout_epoch,
        .hook_generation = result.hook_generation,
        .kind = result.kind,
        .num = result.num,
        .width = result.width,
        .height = result.height,
        .reserved = .{ 0, 0 },
    };
    geometry.* = std.mem.zeroes(c.ot_scene_frame_geometry);
    geometry.struct_size = @sizeOf(c.ot_scene_frame_geometry);
    geometry.abi_version = c.OT_CONTEXT_ABI_VERSION;
    if (result.kind == c.OT_SCENE_FRAME_DONE or result.kind == c.OT_SCENE_FRAME_YIELD) return c.OT_OK;
    const node = result.node;
    // Public observations advance during refresh, after the ticket is created.
    if (owner.core.sceneGetPaintLayout(node)) |layout| {
        geometry.paint = sceneLayoutToC(layout);
        geometry.flags |= c.OT_SCENE_GEOMETRY_PAINT;
    } else |_| {}
    if (owner.core.sceneGetLayout(node, false)) |layout| {
        geometry.public_layout = sceneLayoutToC(layout);
        geometry.flags |= c.OT_SCENE_GEOMETRY_PUBLIC;
    } else |_| {}
    return c.OT_OK;
}

pub fn ot_scene_frame_cancel(context: ?*ContextHandle, session_ptr: ?*const c.ot_handle, frame_id: u64) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    owner.core.sceneFrameCancel(handleFromC(id.*), frame_id) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_scene_frame_acquire_buffer_lease(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    frame_ptr: ?*const c.ot_scene_frame_request,
    which: u32,
    out_snapshot_ptr: ?*c.ot_buffer_lease_snapshot,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const record = frame_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_snapshot_ptr orelse return sessionError(owner, error.InvalidOptions);
    const frame = frameRequestFromC(record.*) catch |err| return sessionError(owner, err);
    if (out.struct_size != @sizeOf(c.ot_buffer_lease_snapshot)) return sessionError(owner, error.InvalidOptions);
    if (out.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    if (out.reserved != 0) return sessionError(owner, error.InvalidOptions);
    const target: @import("context.zig").RendererBuffer = switch (which) {
        c.OT_SESSION_BUFFER_CURRENT => .current,
        c.OT_SESSION_BUFFER_NEXT => .next,
        else => return sessionError(owner, error.InvalidOptions),
    };
    const lease = owner.core.sceneFrameAcquireBufferLease(handleFromC(id.*), frame, target) catch |err| return sessionError(owner, err);
    return writeBufferLeaseSnapshot(owner, lease, out);
}

pub fn ot_scene_frame_draw_buffer(context: ?*ContextHandle, session_ptr: ?*const c.ot_handle, frame_ptr: ?*const c.ot_scene_frame_request, source_ptr: ?*const c.ot_handle, x: i32, y: i32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const record = frame_ptr orelse return sessionError(owner, error.InvalidOptions);
    const source = source_ptr orelse return sessionError(owner, error.InvalidOptions);
    const frame = frameRequestFromC(record.*) catch |err| return sessionError(owner, err);
    owner.core.sceneFrameDrawBuffer(handleFromC(id.*), frame, handleFromC(source.*), x, y) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_scene_frame_commit(
    context: ?*ContextHandle,
    session_ptr: ?*const c.ot_handle,
    frame_ptr: ?*const c.ot_scene_frame_request,
    force: u32,
    out_status_ptr: ?*u32,
) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const record = frame_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_status_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (force > 1) return sessionError(owner, error.InvalidOptions);
    const frame = frameRequestFromC(record.*) catch |err| return sessionError(owner, err);
    const result = owner.core.sceneFrameCommit(handleFromC(id.*), frame, force == 1) catch |err| return sessionError(owner, err);
    out.* = renderStatusToC(result);
    return c.OT_OK;
}

pub fn ot_scene_paint(context: ?*ContextHandle, session_ptr: ?*const c.ot_handle, background_ptr: ?*const [4]u16, use_mouse: u32, excluded_hit_num: u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const background = background_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (use_mouse > 1) return sessionError(owner, error.InvalidOptions);
    owner.core.scenePaint(handleFromC(id.*), background.*, use_mouse == 1, excluded_hit_num) catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_scene_hit_test(context: ?*ContextHandle, session_ptr: ?*const c.ot_handle, x: i32, y: i32, out_ptr: ?*u32) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_ptr orelse return sessionError(owner, error.InvalidOptions);
    const result = owner.core.sceneHitTest(handleFromC(id.*), x, y) catch |err| return sessionError(owner, err);
    out.* = result;
    return c.OT_OK;
}

pub fn ot_scene_get_stats(context: ?*ContextHandle, session_ptr: ?*const c.ot_handle, out_ptr: ?*c.ot_scene_stats) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (out.struct_size != @sizeOf(c.ot_scene_stats)) return sessionError(owner, error.InvalidOptions);
    if (out.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    const result = owner.core.sceneGetStats(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    out.* = .{
        .struct_size = @sizeOf(c.ot_scene_stats),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .last_frame_time = result.lastFrameTime,
        .average_frame_time = result.averageFrameTime,
        .render_time = result.renderTime orelse 0,
        .stdout_write_time = result.outputWriteTime orelse 0,
        .frame_count = result.frameCount,
        .cells_updated = result.cellsUpdated,
        .average_cells_updated = result.averageCellsUpdated,
        .render_time_valid = @intFromBool(result.renderTime != null),
        .stdout_write_time_valid = @intFromBool(result.outputWriteTime != null),
    };
    return c.OT_OK;
}

pub fn ot_scene_get_cursor_state(context: ?*ContextHandle, session_ptr: ?*const c.ot_handle, out_ptr: ?*c.ot_scene_cursor_state) callconv(.c) c.ot_status {
    const status = sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = session_ptr orelse return sessionError(owner, error.InvalidOptions);
    const out = out_ptr orelse return sessionError(owner, error.InvalidOptions);
    if (out.struct_size != @sizeOf(c.ot_scene_cursor_state)) return sessionError(owner, error.InvalidOptions);
    if (out.abi_version != c.OT_CONTEXT_ABI_VERSION) return sessionError(owner, error.UnsupportedVersion);
    const result = owner.core.sceneGetCursorState(handleFromC(id.*)) catch |err| return sessionError(owner, err);
    out.* = .{
        .struct_size = @sizeOf(c.ot_scene_cursor_state),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .x = result.x,
        .y = result.y,
        .visible = @intFromBool(result.visible),
        .style = result.style,
        .blinking = @intFromBool(result.blinking),
        .reserved = 0,
        .r = result.color[0],
        .g = result.color[1],
        .b = result.color[2],
        .a = result.color[3],
    };
    return c.OT_OK;
}

pub fn sessionContextStatus(context: ?*ContextHandle) c.ot_status {
    const owner = context orelse return c.OT_INVALID_ARGUMENT;
    if (owner.owner_thread != std.Thread.getCurrentId()) return c.OT_WRONG_THREAD;
    if (owner.core.closing or owner.core.mutating) return sessionError(owner, error.ContextBusy);
    return c.OT_OK;
}

fn sceneReadStatus(context: ?*ContextHandle) c.ot_status {
    const owner = context orelse return c.OT_INVALID_ARGUMENT;
    if (owner.owner_thread != std.Thread.getCurrentId()) return c.OT_WRONG_THREAD;
    owner.core.checkSceneRead() catch |err| return sessionError(owner, err);
    return c.OT_OK;
}

pub fn handleFromC(value: c.ot_handle) ObjectHandle {
    return .{ .context_id = value.context_id, .slot = value.slot, .generation = value.generation };
}

pub fn handleToC(value: ObjectHandle) c.ot_handle {
    return .{ .context_id = value.context_id, .slot = value.slot, .generation = value.generation };
}

pub fn sessionError(owner: *ContextHandle, err: anyerror) c.ot_status {
    const status: c.ot_status = switch (err) {
        error.InvalidOptions, error.Invalid, error.InvalidValue, error.InvalidDimensions, error.BufferTooSmall, error.IncompatibleOutput, error.InvalidClock, error.InvalidBudget => c.OT_INVALID_ARGUMENT,
        error.InvalidUnicode, error.TextLimit, error.InvalidCursor, error.InvalidIndex, error.InvalidId => c.OT_INVALID_ARGUMENT,
        error.YogaInvalidArgument, error.SceneAlreadyAttached => c.OT_INVALID_ARGUMENT,
        error.SceneNotAttached => c.OT_INVALID_PHASE,
        error.YogaDepthLimit => c.OT_OBJECT_LIMIT,
        error.YogaBusy => c.OT_CONTEXT_BUSY,
        error.UnsupportedVersion => c.OT_UNSUPPORTED_VERSION,
        error.OutOfMemory => c.OT_OUT_OF_MEMORY,
        error.ContextBusy => c.OT_CONTEXT_BUSY,
        error.WrongContext => c.OT_WRONG_CONTEXT,
        error.WrongKind => c.OT_WRONG_KIND,
        error.StaleHandle => c.OT_STALE_HANDLE,
        error.WrongSession => c.OT_WRONG_SESSION,
        error.NoSpace, error.MaxBytes, error.ResponseOverflow => c.OT_OUTPUT_BACKPRESSURE,
        error.SessionClosed, error.SessionCancelled => c.OT_SESSION_CLOSED,
        error.Busy, error.PresentationPending, error.SplitRenderPending => c.OT_OUTPUT_BUSY,
        error.StaleRequest, error.InvalidTicket => c.OT_STALE_OUTPUT,
        error.SessionFailed, error.PresentationFailed => c.OT_OUTPUT_FAILED,
        error.ObjectLimit, error.RequestLimit, error.TrackerLimit => c.OT_OBJECT_LIMIT,
        error.RendererAlreadyAttached => c.OT_RENDERER_ATTACHED,
        error.RendererNotAttached => c.OT_RENDERER_NOT_ATTACHED,
        error.InvalidTerminalState, error.TerminalInactive => c.OT_INVALID_PHASE,
        error.ControlPacketTooLarge => c.OT_CONTROL_PACKET_LIMIT,
        error.LeaseLimit => c.OT_LEASE_LIMIT,
        error.LeaseBytesLimit => c.OT_LEASE_BYTES_LIMIT,
        error.StaleLease => c.OT_STALE_LEASE,
        error.UnsupportedResource, error.Unsupported => c.OT_UNSUPPORTED_RESOURCE,
        error.StaleFrame => c.OT_STALE_FRAME,
        error.LayoutLimit => c.OT_LAYOUT_LIMIT,
        error.FrameBusy => c.OT_FRAME_BUSY,
        error.FrameRequestLimit => c.OT_FRAME_REQUEST_LIMIT,
        else => c.OT_INTERNAL_ERROR,
    };
    owner.last_error = status;
    return status;
}

pub fn createTestContext(options: struct { object_capacity: u32, render_cells_max: u32 }) !*ContextHandle {
    var config = std.mem.zeroes(c.ot_context_options);
    config.struct_size = @sizeOf(c.ot_context_options);
    config.abi_version = c.OT_CONTEXT_ABI_VERSION;
    config.object_capacity = options.object_capacity;
    config.render_cells_max = options.render_cells_max;
    var context: ?*ContextHandle = null;
    try std.testing.expectEqual(c.OT_OK, ot_context_create(&config, &context));
    return context.?;
}

test "Context link URL ABI copies interned URLs and rejects unknown ids" {
    const context: ?*ContextHandle = try createTestContext(.{ .object_capacity = 4, .render_cells_max = 4 });
    defer std.testing.expectEqual(c.OT_OK, ot_context_destroy(context)) catch unreachable;
    const url = "https://example.com/link";
    const id = try context.?.core.links.acquire(url);
    var count: u32 = 99;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_context_get_link_url(null, id, null, 0, &count));
    try std.testing.expectEqual(@as(u32, 99), count);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_context_get_link_url(context, id, null, 1, &count));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_context_get_link_url(context, id, null, 0, null));
    try std.testing.expectEqual(c.OT_OK, ot_context_get_link_url(context, id, null, 0, &count));
    try std.testing.expectEqual(@as(u32, url.len), count);
    var too_small: [3]u8 = undefined;
    count = 99;
    try std.testing.expectEqual(
        c.OT_INVALID_ARGUMENT,
        ot_context_get_link_url(context, id, &too_small, too_small.len, &count),
    );
    try std.testing.expectEqual(@as(u32, 99), count);
    var output: [64]u8 = undefined;
    @memset(&output, 'x');
    try std.testing.expectEqual(c.OT_OK, ot_context_get_link_url(context, id, &output, output.len, &count));
    try std.testing.expectEqual(@as(u32, url.len), count);
    try std.testing.expectEqualStrings(url, output[0..url.len]);
    try std.testing.expectEqual(
        c.OT_INVALID_ARGUMENT,
        ot_context_get_link_url(context, 0, &output, output.len, &count),
    );
    context.?.core.mutating = true;
    defer context.?.core.mutating = false;
    try std.testing.expectEqual(
        c.OT_CONTEXT_BUSY,
        ot_context_get_link_url(context, id, &output, output.len, &count),
    );
}

test "Context synchronous text drawing ABI validates sources and frame records before painting" {
    const context: ?*ContextHandle = try createTestContext(.{ .object_capacity = 8, .render_cells_max = 8 });
    defer std.testing.expectEqual(c.OT_OK, ot_context_destroy(context)) catch unreachable;
    const core = context.?.core;
    const session = try core.createSession(.{});
    try core.attachSessionRenderer(session, 4, 1, .{ .remote_mode = .remote });
    _ = try core.sceneCreateNode(session, 0, 1);
    const node = try core.sceneCreateNode(session, 2, 2);
    try core.sceneSetText(node, "text");
    const edit = try core.createEditBuffer(.unicode);
    const view = try core.createEditorView(edit, 4, 1);
    try core.editSetText(edit, "text", false);
    const target = handleToC(try core.createBuffer(4, 1, .{}));
    const buffer = try core.getBuffer(handleFromC(target));
    inline for ([_]bool{ false, true }) |is_editor| {
        const draw = if (is_editor) ot_buffer_draw_editor_view else ot_buffer_draw_scene_text;
        const source = handleToC(if (is_editor) view else node);
        buffer.clear(@splat(0), null);
        try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, draw(null, &target, null, &source, 0, 0));
        try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, draw(context, null, null, &source, 0, 0));
        try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, draw(context, &target, null, null, 0, 0));
        try std.testing.expectEqual(c.OT_WRONG_KIND, draw(context, &target, null, &target, 0, 0));
        var frame = std.mem.zeroes(c.ot_scene_frame_request);
        try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, draw(context, &target, &frame, &source, 0, 0));
        frame.struct_size = @sizeOf(c.ot_scene_frame_request);
        frame.abi_version = c.OT_CONTEXT_ABI_VERSION + 1;
        try std.testing.expectEqual(c.OT_UNSUPPORTED_VERSION, draw(context, &target, &frame, &source, 0, 0));
        try std.testing.expectEqual(@as(u32, ' '), buffer.get(0, 0).?.char);
        try std.testing.expectEqual(c.OT_OK, draw(context, &target, null, &source, 0, 0));
        try std.testing.expectEqual(@as(u32, 't'), buffer.get(0, 0).?.char);
    }
}

test "Context palette and notification ABI validate input and mutation authority" {
    const context: ?*ContextHandle = try createTestContext(.{ .object_capacity = 16, .render_cells_max = 16 });
    defer std.testing.expectEqual(c.OT_OK, ot_context_destroy(context)) catch unreachable;
    const core = context.?.core;
    const session = try core.createSession(.{});
    const id = handleToC(session);
    try core.attachSessionRenderer(session, 2, 1, .{ .remote_mode = .remote });
    const color = [_]u16{ 255, 0, 0, 255 };
    var output: u32 = 99;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_notification(null, &id, "x", 1, null, 0, &output));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_notification(context, &id, null, 1, null, 0, &output));
    try std.testing.expectEqual(0, output);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_notification(context, &id, "x", 1, null, 1, &output));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_set_palette_state(context, &id, null, 1, &color, &color, 1));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_set_palette_state(context, &id, null, 257, &color, &color, 1));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_set_palette_state(context, &id, null, 0, &.{ 256, 0, 0, 255 }, &color, 1));
    try std.testing.expectEqual(c.OT_INVALID_PHASE, ot_session_set_palette_state(context, &id, null, 0, &color, &color, 1));
    try std.testing.expectEqual(c.OT_INVALID_PHASE, ot_session_notification(context, &id, "x", 1, null, 0, &output));
    core.mutating = true;
    defer core.mutating = false;
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_session_set_palette_state(context, &id, null, 0, &color, &color, 1));
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_session_notification(context, &id, "x", 1, null, 0, &output));
}

test "Context color matrix ABI checks spans handles and reentry" {
    const context: ?*ContextHandle = try createTestContext(.{ .object_capacity = 16, .render_cells_max = 16 });
    defer std.testing.expectEqual(c.OT_OK, ot_context_destroy(context)) catch unreachable;
    const core = context.?.core;
    const target = handleToC(try core.createBuffer(2, 1, .{}));
    const matrix = [_]f32{ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 };
    var strength: f32 = 1;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_buffer_color_matrix(null, &target, null, &matrix, 16, null, 0, &strength, 0));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_buffer_color_matrix(context, null, null, &matrix, 16, null, 0, &strength, 0));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_buffer_color_matrix(context, &target, null, null, 16, null, 0, &strength, 0));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_buffer_color_matrix(context, &target, null, &matrix, 15, null, 0, &strength, 0));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_buffer_color_matrix(context, &target, null, &matrix, 16, null, 3, &strength, 0));
    var foreign = target;
    foreign.context_id += 1;
    try std.testing.expectEqual(c.OT_WRONG_CONTEXT, ot_buffer_color_matrix(context, &foreign, null, &matrix, 16, null, 0, &strength, 0));
    var frame = std.mem.zeroes(c.ot_scene_frame_request);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_buffer_color_matrix(context, &target, &frame, &matrix, 16, null, 0, &strength, 0));
    try std.testing.expectEqual(c.OT_OK, ot_buffer_color_matrix(context, &target, null, &matrix, 16, null, 0, &strength, 3));
    core.mutating = true;
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_buffer_color_matrix(context, &target, null, &matrix, 16, null, 0, &strength, 0));
    core.mutating = false;
    try core.destroy(handleFromC(target));
    try std.testing.expectEqual(c.OT_STALE_HANDLE, ot_buffer_color_matrix(context, &target, null, &matrix, 16, null, 0, &strength, 0));
}

test "Context image ABI rejects invalid records identities and mutation reentry" {
    const context: ?*ContextHandle = try createTestContext(.{ .object_capacity = 16, .render_cells_max = 16 });
    defer std.testing.expectEqual(c.OT_OK, ot_context_destroy(context)) catch unreachable;
    const core = context.?.core;
    const source = try @import("image.zig").createFromRgba(std.testing.allocator, &.{ 255, 0, 0, 255 }, 1, 1, 4);
    defer source.deinit();
    const image = handleToC(try core.importImage(source));
    const target = handleToC(try core.createBuffer(2, 1, .{}));
    const session = try core.createSession(.{});
    const session_c = handleToC(session);
    try core.attachSessionRenderer(session, 2, 1, .{ .remote_mode = .local });
    _ = try core.sceneCreateNode(session, c.OT_SCENE_ROOT, 1);
    var node = std.mem.zeroes(c.ot_handle);
    try std.testing.expectEqual(c.OT_OK, ot_scene_create_node(context, &session_c, c.OT_SCENE_IMAGE, 2, &node));
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_image(context, &node, &image, c.OT_IMAGE_COVER, c.OT_IMAGE_PROTOCOL_BLOCKS, &target));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_image(null, &node, &image, 0, 0, null));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_image(context, null, &image, 0, 0, null));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_image(context, &node, &image, 3, 0, null));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_image(context, &node, &image, 0, 4, null));
    try std.testing.expectEqual(c.OT_WRONG_KIND, ot_scene_set_image(context, &node, &target, 0, 0, null));
    try std.testing.expectEqual(c.OT_WRONG_KIND, ot_scene_set_image(context, &node, &image, 0, 0, &image));
    var foreign = image;
    foreign.context_id += 1;
    try std.testing.expectEqual(c.OT_WRONG_CONTEXT, ot_scene_set_image(context, &node, &foreign, 0, 0, null));

    var draw = std.mem.zeroes(c.ot_image_draw_options);
    draw.struct_size = @sizeOf(c.ot_image_draw_options);
    draw.abi_version = c.OT_CONTEXT_ABI_VERSION;
    draw.width = 2;
    draw.height = 1;
    draw.protocol = c.OT_IMAGE_PROTOCOL_BLOCKS;
    var drawn: u32 = 99;
    for (0..9) |field| {
        var invalid = draw;
        switch (field) {
            0 => invalid.struct_size -= 1,
            1 => invalid.abi_version += 1,
            2 => invalid.flags = 4,
            3 => invalid.protocol = 4,
            4 => invalid.reserved[0] = 1,
            5 => invalid.reserved[1] = 1,
            6 => invalid.source_width = 1,
            7 => invalid.source_height = 1,
            8 => invalid.source_x = 2,
            else => unreachable,
        }
        const before = (try core.getBuffer(handleFromC(target))).buffer.char[0];
        try std.testing.expectEqual(if (field == 1) c.OT_UNSUPPORTED_VERSION else c.OT_INVALID_ARGUMENT, ot_buffer_draw_image(context, &target, null, &image, &invalid, &drawn));
        try std.testing.expectEqual(99, drawn);
        try std.testing.expectEqual(before, (try core.getBuffer(handleFromC(target))).buffer.char[0]);
    }
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_buffer_draw_image(null, &target, null, &image, &draw, &drawn));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_buffer_draw_image(context, null, null, &image, &draw, &drawn));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_buffer_draw_image(context, &target, null, null, &draw, &drawn));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_buffer_draw_image(context, &target, null, &image, null, &drawn));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_buffer_draw_image(context, &target, null, &image, &draw, null));
    try std.testing.expectEqual(c.OT_WRONG_CONTEXT, ot_buffer_draw_image(context, &target, null, &foreign, &draw, &drawn));
    try std.testing.expectEqual(c.OT_WRONG_KIND, ot_buffer_draw_image(context, &target, null, &target, &draw, &drawn));
    var frame = std.mem.zeroes(c.ot_scene_frame_request);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_buffer_draw_image(context, &target, &frame, &image, &draw, &drawn));
    try std.testing.expectEqual(99, drawn);
    try std.testing.expectEqual(c.OT_OK, ot_buffer_draw_image(context, &target, null, &image, &draw, &drawn));
    try std.testing.expectEqual(1, drawn);
    draw.x = 2;
    try std.testing.expectEqual(c.OT_OK, ot_buffer_draw_image(context, &target, null, &image, &draw, &drawn));
    try std.testing.expectEqual(0, drawn);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_set_image_resolution(null, &session_c, 2, 1, 16, 16));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_set_image_resolution(context, null, 2, 1, 16, 16));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_set_image_resolution(context, &session_c, 2, 0, 16, 16));
    try std.testing.expectEqual(c.OT_WRONG_KIND, ot_session_set_image_resolution(context, &image, 2, 1, 16, 16));
    try std.testing.expectEqual(c.OT_OK, ot_session_set_image_resolution(context, &session_c, 2, 1, 16, 16));
    try std.testing.expectEqual(c.OT_OK, ot_session_set_image_resolution(context, &session_c, 0, 0, 0, 0));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_set_kitty_image_transport(null, &session_c, 0));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_set_kitty_image_transport(context, null, 0));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_set_kitty_image_transport(context, &session_c, 3));
    try std.testing.expectEqual(c.OT_WRONG_KIND, ot_session_set_kitty_image_transport(context, &image, 0));
    try std.testing.expectEqual(c.OT_OK, ot_session_set_kitty_image_transport(context, &session_c, 0));
    try std.testing.expectEqual(c.OT_OK, ot_session_set_kitty_image_transport(context, &session_c, 1));
    var kitty = std.mem.zeroes(c.ot_session_kitty_image_transport);
    kitty.struct_size = @sizeOf(c.ot_session_kitty_image_transport);
    kitty.abi_version = c.OT_CONTEXT_ABI_VERSION;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_get_kitty_image_transport(context, &session_c, null));
    try std.testing.expectEqual(c.OT_OK, ot_session_get_kitty_image_transport(context, &session_c, &kitty));
    try std.testing.expectEqual(@as(u32, 1), kitty.requested);
    var retry: u32 = 99;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_poll_kitty_image_transport(context, &session_c, null));
    try std.testing.expectEqual(c.OT_OK, ot_session_poll_kitty_image_transport(context, &session_c, &retry));
    try std.testing.expectEqual(@as(u32, 0), retry);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_cancel_kitty_image_transport(context, &session_c, 2));
    try std.testing.expectEqual(c.OT_OK, ot_session_cancel_kitty_image_transport(context, &session_c, 0));
    var reply_result: u32 = 99;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_process_kitty_image_reply(context, &session_c, null, 1, &reply_result));
    try std.testing.expectEqual(c.OT_OK, ot_session_process_kitty_image_reply(context, &session_c, null, 0, &reply_result));
    try std.testing.expectEqual(@as(u32, 0), reply_result);
    try std.testing.expectEqual(c.OT_OK, ot_session_start_kitty_file_probe(context, &session_c));
    {
        core.mutating = true;
        defer core.mutating = false;
        core.scene_measuring = true;
        defer core.scene_measuring = false;
        var measured: u32 = 99;
        try std.testing.expectEqual(c.OT_OK, ot_scene_has_measure(context, &node, &measured));
        try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_scene_set_image(context, &node, null, 0, 0, null));
        try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_buffer_draw_image(context, &target, null, &image, &draw, &drawn));
        try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_image_destroy(context, &image));
        try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_session_set_image_resolution(context, &session_c, 0, 0, 0, 0));
        try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_session_set_kitty_image_transport(context, &session_c, 0));
        try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_session_start_kitty_file_probe(context, &session_c));
    }
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_image_destroy(null, &image));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_image_destroy(context, null));
    try std.testing.expectEqual(c.OT_WRONG_CONTEXT, ot_image_destroy(context, &foreign));
    try std.testing.expectEqual(c.OT_WRONG_KIND, ot_image_destroy(context, &target));
    try std.testing.expectEqual(c.OT_OK, ot_image_destroy(context, &image));
    try std.testing.expectEqual(c.OT_STALE_HANDLE, ot_image_destroy(context, &image));
    try std.testing.expectEqual(c.OT_STALE_HANDLE, ot_buffer_draw_image(context, &target, null, &image, &draw, &drawn));
    try std.testing.expectEqual(c.OT_STALE_HANDLE, ot_scene_set_image(context, &node, &image, 0, 0, null));
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_image(context, &node, null, 0, 0, null));
}

test "Context console ABI validates rectangle frame and diagnostic arguments" {
    const handle: ?*ContextHandle = try createTestContext(.{ .object_capacity = 4, .render_cells_max = 8 });
    defer std.testing.expectEqual(c.OT_OK, ot_context_destroy(handle)) catch unreachable;
    const core = handle.?.core;
    const session = handleToC(try core.createSession(.{}));
    try core.attachSessionRenderer(handleFromC(session), 4, 1, .{ .remote_mode = .remote });
    _ = try core.sceneCreateNode(handleFromC(session), 0, 1);
    const buffer = handleToC(try core.createBuffer(2, 1, .{}));
    const red: [4]u16 = .{ 255, 0, 0, 255 };
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_buffer_fill_rect(handle, &buffer, 0, 0, 1, 1, null));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_buffer_fill_rect(handle, null, 0, 0, 1, 1, &red));
    try std.testing.expectEqual(c.OT_OK, ot_buffer_fill_rect(handle, &buffer, 0, 0, std.math.maxInt(u32), 1, &red));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_set_debug_overlay(handle, &session, 2, 0));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_set_debug_overlay(handle, &session, 1, 4));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_update_stats(handle, &session, std.math.nan(f64), 60, 0));
    try std.testing.expectEqual(c.OT_WRONG_KIND, ot_session_update_memory_stats(handle, &buffer, 1, 2, 3));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_dump_hit_grid(handle, null));
    try std.testing.expectEqual(c.OT_OK, ot_session_set_debug_overlay(handle, &session, 1, 3));
    try std.testing.expectEqual(c.OT_OK, ot_session_update_stats(handle, &session, 1.5, 60, 0.25));
    try std.testing.expectEqual(c.OT_OK, ot_session_update_memory_stats(handle, &session, 1, 2, 3));
    const config: c.ot_scene_frame_options = .{
        .struct_size = @sizeOf(c.ot_scene_frame_options),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .background = .{ 0, 0, 0, 255 },
        .use_mouse = 0,
        .excluded_hit_num = 0,
        .max_layout_rounds = 8,
        .max_host_requests = 64,
        .preserve_unwritten = 0,
    };
    var frame = std.mem.zeroes(c.ot_scene_frame_request);
    frame.struct_size = @sizeOf(c.ot_scene_frame_request);
    frame.abi_version = c.OT_CONTEXT_ABI_VERSION;
    var geometry = std.mem.zeroes(c.ot_scene_frame_geometry);
    geometry.struct_size = @sizeOf(c.ot_scene_frame_geometry);
    geometry.abi_version = c.OT_CONTEXT_ABI_VERSION;
    const unlimited = std.math.maxInt(u32);
    try std.testing.expectEqual(c.OT_OK, ot_scene_frame_step_with_geometry(handle, &session, null, &config, unlimited, unlimited, &frame, &geometry));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_frame_draw_buffer(handle, &session, null, &buffer, 0, 0));
    frame.reserved[0] = 1;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_frame_draw_buffer(handle, &session, &frame, &buffer, 0, 0));
    frame.reserved[0] = 0;
    try std.testing.expectEqual(c.OT_OK, ot_scene_frame_draw_buffer(handle, &session, &frame, &buffer, 1, 0));
    try std.testing.expectEqual(red, (try core.getSessionRenderer(handleFromC(session))).getNextBuffer().buffer.bg[1]);
    var draw = std.mem.zeroes(c.ot_buffer_draw_options);
    draw.struct_size = @sizeOf(c.ot_buffer_draw_options);
    draw.abi_version = c.OT_CONTEXT_ABI_VERSION;
    draw.operation = c.OT_BUFFER_DRAW_TEXT;
    draw.foreground = red;
    try std.testing.expectEqual(c.OT_OK, ot_buffer_draw(handle, &buffer, null, &draw, null, "AB", 2, null, 0));
    try std.testing.expectEqual(c.OT_OK, ot_buffer_draw(handle, &session, &frame, &draw, null, "CD", 2, null, 0));
    try std.testing.expectEqual(c.OT_WRONG_KIND, ot_buffer_draw(handle, &session, null, &draw, null, "AB", 2, null, 0));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_buffer_draw(handle, &buffer, null, &draw, null, null, 1, null, 0));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_buffer_draw(handle, &buffer, null, &draw, null, "\xff", 1, null, 0));
    draw.reserved = 1;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_buffer_draw(handle, &buffer, null, &draw, null, null, 0, null, 0));
    draw.reserved = 0;
    try std.testing.expectEqualSlices(u32, &.{ 'C', 'D' }, (try core.getSessionRenderer(handleFromC(session))).getNextBuffer().buffer.char[0..2]);
    core.mutating = true;
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_buffer_draw(handle, &buffer, null, &draw, null, null, 0, null, 0));
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_session_dump_hit_grid(handle, &session));
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_buffer_fill_rect(handle, &buffer, 0, 0, 1, 1, &red));
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_scene_frame_draw_buffer(handle, &session, &frame, &buffer, 0, 0));
    core.mutating = false;
    try std.testing.expectEqual(c.OT_OK, ot_scene_frame_cancel(handle, &session, frame.frame_id));
    try std.testing.expectEqual(c.OT_STALE_FRAME, ot_scene_frame_draw_buffer(handle, &session, &frame, &buffer, 0, 0));
    try std.testing.expectEqual(c.OT_STALE_FRAME, ot_buffer_draw(handle, &session, &frame, &draw, null, null, 0, null, 0));
}

test "Context editor transport commands preserve provider unset and reject reentry" {
    const handle: ?*ContextHandle = try createTestContext(.{ .object_capacity = 16, .render_cells_max = 16 });
    defer std.testing.expectEqual(c.OT_OK, ot_context_destroy(handle)) catch unreachable;
    const core = handle.?.core;
    const session = try core.createSession(.{});
    try core.attachSessionRenderer(session, 8, 2, .{ .remote_mode = .remote });
    _ = try core.sceneCreateNode(session, c.OT_SCENE_ROOT, 1);
    const node = try core.sceneCreateNode(session, c.OT_SCENE_EDITOR, 2);
    const edit = handleToC(try core.createEditBuffer(.unicode));
    const view = try core.createEditorView(handleFromC(edit), 8, 2);
    try core.sceneSetEditorView(node, view);
    try core.sceneSetMeasure(node, null);
    try std.testing.expectEqual(c.OT_OK, ot_edit_buffer_set_text(handle, &edit, "ab", 2, 0));
    try std.testing.expectEqual(c.OT_OK, ot_edit_buffer_command(handle, &edit, c.OT_EDIT_MOVE_RIGHT, 0));
    try std.testing.expectEqual(1, (try core.getEditBuffer(handleFromC(edit))).buffer.getPrimaryCursor().col);
    try std.testing.expect(!try core.sceneHasMeasure(node));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_edit_buffer_command(handle, &edit, c.OT_EDIT_MOVE_RIGHT, 1));
    core.mutating = true;
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_edit_buffer_command(handle, &edit, c.OT_EDIT_DELETE_FORWARD, 0));
    core.mutating = false;
    try std.testing.expectEqual(c.OT_OK, ot_edit_buffer_command(handle, &edit, c.OT_EDIT_DELETE_FORWARD, 0));
    var bytes: [8]u8 = undefined;
    var count: u32 = 0;
    try std.testing.expectEqual(c.OT_OK, ot_edit_buffer_get_text(handle, &edit, &bytes, bytes.len, &count));
    try std.testing.expectEqualStrings("a", bytes[0..count]);
    const view_handle = handleToC(view);
    const viewport: c.ot_editor_viewport = .{ .struct_size = @sizeOf(c.ot_editor_viewport), .abi_version = c.OT_CONTEXT_ABI_VERSION, .x = 0, .y = 1, .width = 2, .height = 1 };
    try std.testing.expectEqual(c.OT_OK, editor_transport.ot_editor_view_set_viewport(handle, &view_handle, &viewport, 0, 0));
    var actual = viewport;
    try std.testing.expectEqual(c.OT_OK, editor_transport.ot_editor_view_get_viewport(handle, &view_handle, &actual));
    try std.testing.expectEqualDeep(viewport, actual);
    try std.testing.expectEqual(c.OT_OK, editor_transport.ot_editor_view_set_viewport(handle, &view_handle, &viewport, 0, 1));
    try std.testing.expect(!try core.sceneHasMeasure(node));
}

test "Context editor transport copies styles selections positions history and line queries" {
    const handle: ?*ContextHandle = try createTestContext(.{ .object_capacity = 16, .render_cells_max = 16 });
    defer std.testing.expectEqual(c.OT_OK, ot_context_destroy(handle)) catch unreachable;
    const core = handle.?.core;
    const edit = handleToC(try core.createEditBuffer(.unicode));
    const view = handleToC(try core.createEditorView(handleFromC(edit), 2, 2));
    const style = handleToC(try core.createSyntaxStyle());
    const api = editor_transport;
    var definition: c.ot_editor_style = .{ .struct_size = @sizeOf(c.ot_editor_style), .abi_version = c.OT_CONTEXT_ABI_VERSION, .flags = c.OT_EDITOR_STYLE_FOREGROUND, .attributes = 0, .foreground = .{ 12, 34, 56, 255 }, .background = .{ 0, 0, 0, 0 } };
    var style_id: u32 = 99;
    try std.testing.expectEqual(c.OT_OK, api.ot_syntax_style_register(handle, &style, "test", 4, &definition, &style_id));
    try std.testing.expectEqual(1, style_id);
    var count: u32 = 99;
    try std.testing.expectEqual(c.OT_OK, api.ot_syntax_style_resolve(handle, &style, "test", 4, &count));
    try std.testing.expectEqual(style_id, count);
    try std.testing.expectEqual(c.OT_OK, api.ot_syntax_style_get_count(handle, &style, &count));
    try std.testing.expectEqual(1, count);
    try std.testing.expectEqual(c.OT_OK, api.ot_syntax_style_register(handle, &style, null, 0, &definition, &count));
    try std.testing.expectEqual(2, count);
    try std.testing.expectEqual(c.OT_OK, api.ot_syntax_style_resolve(handle, &style, null, 0, &count));
    try std.testing.expectEqual(2, count);
    try std.testing.expectEqual(c.OT_OK, ot_edit_buffer_set_syntax_style(handle, &edit, &style));
    try std.testing.expectEqual(c.OT_OK, api.ot_edit_buffer_set_defaults(handle, &edit, 1, &definition));
    definition.foreground[0] = 256;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, api.ot_edit_buffer_set_defaults(handle, &edit, 1, &definition));
    try std.testing.expectEqual(c.OT_OK, ot_edit_buffer_set_text(handle, &edit, "abcd\nxy", 7, 0));
    try std.testing.expectEqual(c.OT_OK, api.ot_editor_view_command(handle, &view, c.OT_EDITOR_WRAP_MODE, c.OT_SCENE_WRAP_CHAR));
    var info = std.mem.zeroes(c.ot_editor_view_info);
    info.struct_size = @sizeOf(c.ot_editor_view_info);
    info.abi_version = c.OT_CONTEXT_ABI_VERSION;
    try std.testing.expectEqual(c.OT_OK, api.ot_editor_view_get_info(handle, &view, 0, &info));
    try std.testing.expectEqual(2, info.virtual_line_count);
    try std.testing.expectEqual(3, info.total_virtual_line_count);
    var measure = std.mem.zeroes(c.ot_editor_measure);
    measure.struct_size = @sizeOf(c.ot_editor_measure);
    measure.abi_version = c.OT_CONTEXT_ABI_VERSION;
    try std.testing.expectEqual(c.OT_OK, api.ot_editor_view_measure(handle, &view, 4, 1, &measure));
    try std.testing.expectEqual(2, measure.line_count);
    var lines: [3]c.ot_scene_text_line = undefined;
    try std.testing.expectEqual(c.OT_OK, api.ot_editor_view_get_lines(handle, &view, 1, &lines, 3, &measure));
    try std.testing.expectEqual(3, measure.line_count);
    try std.testing.expectEqual(1, lines[1].wrap_index);
    try std.testing.expectEqual(1, lines[2].source_line);
    const saved = measure;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, api.ot_editor_view_get_lines(handle, &view, 1, &lines, 1, &measure));
    try std.testing.expectEqualDeep(saved, measure);
    var position = std.mem.zeroes(c.ot_edit_position);
    position.struct_size = @sizeOf(c.ot_edit_position);
    position.abi_version = c.OT_CONTEXT_ABI_VERSION;
    try std.testing.expectEqual(c.OT_OK, api.ot_edit_buffer_get_position(handle, &edit, c.OT_EDIT_POSITION_OFFSET, 6, 0, &position));
    try std.testing.expectEqual(1, position.valid);
    try std.testing.expectEqual(1, position.row);
    try std.testing.expectEqual(1, position.col);
    try std.testing.expectEqual(c.OT_OK, api.ot_edit_buffer_get_position(handle, &edit, c.OT_EDIT_POSITION_OFFSET, 99, 0, &position));
    try std.testing.expectEqual(0, position.valid);
    var selection = std.mem.zeroes(c.ot_editor_selection);
    selection.struct_size = @sizeOf(c.ot_editor_selection);
    selection.abi_version = c.OT_CONTEXT_ABI_VERSION;
    selection.operation = c.OT_EDITOR_SELECT_SET;
    selection.start = 0;
    selection.end = 2;
    try std.testing.expectEqual(c.OT_OK, api.ot_editor_view_select(handle, &view, &selection, &count));
    var bytes: [64]u8 = undefined;
    try std.testing.expectEqual(c.OT_OK, api.ot_editor_view_get_selected_text(handle, &view, &bytes, bytes.len, &count));
    try std.testing.expectEqualStrings("ab", bytes[0..count]);
    var steps: u32 = 0;
    try std.testing.expectEqual(c.OT_OK, api.ot_editor_view_replace_selection(handle, &view, "Q", 1, &steps));
    try std.testing.expectEqual(@as(u32, 3), steps);
    try std.testing.expectEqual(c.OT_OK, ot_edit_buffer_get_text(handle, &edit, &bytes, bytes.len, &count));
    try std.testing.expectEqualStrings("Qcd\nxy", bytes[0..count]);
    count = 99;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, api.ot_edit_buffer_history(handle, &edit, 0, &bytes, 63, &count));
    try std.testing.expectEqual(99, count);
    try std.testing.expectEqual(c.OT_OK, api.ot_edit_buffer_history(handle, &edit, 0, &bytes, bytes.len, &count));
    try std.testing.expect(count > 0);
    try std.testing.expectEqual(c.OT_OK, ot_edit_buffer_get_text(handle, &edit, &bytes, bytes.len, &count));
    try std.testing.expectEqualStrings("cd\nxy", bytes[0..count]);
    try std.testing.expectEqual(c.OT_OK, api.ot_edit_buffer_history(handle, &edit, 0, &bytes, bytes.len, &count));
    try std.testing.expectEqual(c.OT_OK, ot_edit_buffer_get_text(handle, &edit, &bytes, bytes.len, &count));
    try std.testing.expectEqualStrings("abcd\nxy", bytes[0..count]);
    const highlight: c.ot_edit_highlight = .{ .start = 0, .end = 2, .style_id = style_id, .priority = 1, .ref = 7 };
    try std.testing.expectEqual(c.OT_OK, api.ot_edit_buffer_highlight(handle, &edit, c.OT_EDIT_HIGHLIGHT_ADD_LINE, 0, &highlight));
    var highlights: [1]c.ot_edit_highlight = undefined;
    try std.testing.expectEqual(c.OT_OK, api.ot_edit_buffer_get_highlights(handle, &edit, 0, &highlights, 1, &count));
    try std.testing.expectEqual(1, count);
    try std.testing.expectEqualDeep(highlight, highlights[0]);
    try std.testing.expectEqual(c.OT_OK, api.ot_edit_buffer_highlight(handle, &edit, c.OT_EDIT_HIGHLIGHT_REMOVE_REF, 7, null));
    try std.testing.expectEqual(c.OT_OK, api.ot_edit_buffer_get_range(handle, &edit, 1, 0, 1, 1, 1, &bytes, bytes.len, &count));
    try std.testing.expectEqualStrings("bcd\nx", bytes[0..count]);
    try std.testing.expectEqual(c.OT_OK, ot_edit_buffer_set_text(handle, &edit, "a\xe7\x95\x8c\t\nz", 7, 0));
    try std.testing.expectEqual(c.OT_OK, api.ot_edit_buffer_get_range(handle, &edit, 1, 0, 1, 0, 3, &bytes, bytes.len, &count));
    try std.testing.expectEqualStrings("\xe7\x95\x8c", bytes[0..count]);
    try std.testing.expectEqual(c.OT_OK, api.ot_edit_buffer_get_position(handle, &edit, c.OT_EDIT_POSITION_OFFSET, 3, 0, &position));
    try std.testing.expectEqual(3, position.col);
    core.mutating = true;
    core.scene_measuring = true;
    try std.testing.expectEqual(c.OT_OK, api.ot_editor_view_get_info(handle, &view, 0, &info));
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, api.ot_editor_view_select(handle, &view, &selection, &count));
    core.scene_measuring = false;
    core.mutating = false;
    try std.testing.expectEqual(c.OT_OK, ot_editor_view_destroy(handle, &view));
    try std.testing.expectEqual(c.OT_STALE_HANDLE, api.ot_editor_view_get_info(handle, &view, 0, &info));
}

test "Context editor ABI validates bindings records and readonly admission" {
    const handle: ?*ContextHandle = try createTestContext(.{ .object_capacity = 16, .render_cells_max = 16 });
    defer std.testing.expectEqual(c.OT_OK, ot_context_destroy(handle)) catch unreachable;
    const core = handle.?.core;
    const session = try core.createSession(.{});
    try core.attachSessionRenderer(session, 8, 2, .{ .remote_mode = .remote });
    _ = try core.sceneCreateNode(session, c.OT_SCENE_ROOT, 1);
    const node = handleToC(try core.sceneCreateNode(session, c.OT_SCENE_EDITOR, 2));
    const peer = handleToC(try core.sceneCreateNode(session, c.OT_SCENE_EDITOR, 3));
    const edit = handleToC(try core.createEditBuffer(.unicode));
    var view = std.mem.zeroes(c.ot_handle);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_editor_view_create(handle, &edit, std.math.maxInt(u32), 2, &view));
    try std.testing.expectEqual(0, view.context_id);
    try std.testing.expectEqual(c.OT_OK, ot_editor_view_create(handle, &edit, 8, 2, &view));
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_editor_view(handle, &node, &view));
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_scene_set_editor_view(handle, &peer, &view));
    try std.testing.expectEqual(c.OT_WRONG_KIND, ot_scene_set_editor_view(handle, &node, &edit));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_editor_view(handle, null, &view));
    var foreign = view;
    foreign.context_id += 1;
    try std.testing.expectEqual(c.OT_WRONG_CONTEXT, ot_scene_set_editor_view(handle, &node, &foreign));

    var paint: c.ot_scene_editor_options = .{
        .struct_size = @sizeOf(c.ot_scene_editor_options),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .show_cursor = 1,
        .style = 2,
        .blinking = 0,
        .reserved = 0,
        .color = .{ 128, 0, 255, 255 },
        .mouse_pointer = 6,
        .reserved2 = 0,
    };
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_editor_options(handle, &node, &paint));
    const accepted = (try core.getRenderable(handleFromC(node))).scene_node.?.control.editor;
    for (0..8) |field| {
        var invalid = paint;
        switch (field) {
            0 => invalid.struct_size -= 1,
            1 => invalid.abi_version += 1,
            2 => invalid.reserved = 1,
            3 => invalid.show_cursor = 2,
            4 => invalid.blinking = 2,
            5 => invalid.style = 4,
            6 => invalid.color[0] = 256,
            7 => invalid.mouse_pointer = 7,
            else => unreachable,
        }
        try std.testing.expectEqual(if (field == 1) c.OT_UNSUPPORTED_VERSION else c.OT_INVALID_ARGUMENT, ot_scene_set_editor_options(handle, &node, &invalid));
        try std.testing.expectEqualDeep(accepted, (try core.getRenderable(handleFromC(node))).scene_node.?.control.editor);
    }
    var info = std.mem.zeroes(c.ot_edit_buffer_info);
    info.struct_size = 0;
    info.abi_version = c.OT_CONTEXT_ABI_VERSION;
    const before = info;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_edit_buffer_get_info(handle, &edit, &info));
    try std.testing.expectEqualDeep(before, info);
    info.struct_size = @sizeOf(c.ot_edit_buffer_info);
    core.mutating = true;
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_edit_buffer_get_info(handle, &edit, &info));
    core.scene_measuring = true;
    try std.testing.expectEqual(c.OT_OK, ot_edit_buffer_get_info(handle, &edit, &info));
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_edit_buffer_set_cursor(handle, &edit, 0, 0));
    core.scene_measuring = false;
    core.mutating = false;
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_editor_view(handle, &node, null));
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_editor_view(handle, &peer, &view));
    try std.testing.expectEqual(c.OT_OK, ot_editor_view_destroy(handle, &view));
    try std.testing.expect((try core.getRenderable(handleFromC(peer))).scene_node.?.editor == null);
    try std.testing.expectEqual(c.OT_STALE_HANDLE, ot_scene_set_editor_view(handle, &node, &view));
    try std.testing.expectEqual(c.OT_OK, ot_edit_buffer_destroy(handle, &edit));
}

test "Scene flush ABI copies background and preserves paint on acceptance and rejection" {
    const ansi = @import("ansi.zig");
    var owner: ContextHandle = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = undefined, .owner_thread = std.Thread.getCurrentId() };
    defer owner.io_threaded.deinit();
    owner.core = try Context.init(std.testing.allocator, owner.io_threaded.io(), .{});
    defer owner.core.deinit() catch unreachable;
    const core = owner.core;
    const session = try core.createSession(.{});
    try core.attachSessionRenderer(session, 8, 3, .{ .remote_mode = .remote });
    _ = try core.sceneCreateNode(session, c.OT_SCENE_ROOT, 1);
    const box = try core.sceneCreateNode(session, c.OT_SCENE_BOX, 2);
    const id = handleToC(box);
    const wrong_kind = handleToC(try core.createTextBuffer(.unicode));
    var accepted: scene.Paint = .{
        .zIndex = 3,
        .opacity = 0.5,
        .translateX = 1.25,
        .translateY = 1.5,
        .borderSides = 15,
        .shouldFill = 0,
        .background = .{ 200, 0, 0, 255 },
        .borderColor = .{ 20, 40, 60, 255 },
        .borderStyle = 2,
        .focusable = true,
        .focusedBorderColor = .{ 60, 40, 20, 255 },
    };
    try core.sceneSetPaint(box, accepted);
    const node = &(try core.getRenderable(box)).scene_node.?;
    var input: [1]c.ot_scene_background_update = .{.{ .node = id, .background = undefined, .fields = c.OT_SCENE_UPDATE_APPLY, .reserved = 0 }};
    var applied: u32 = 0;
    for ([_]ansi.RGBA{ ansi.rgbColor(0, 200, 0, 128), ansi.indexedColor(255, 10, 20, 30), ansi.defaultColor(30, 20, 10, 255) }) |color| {
        input[0].background = color;
        try std.testing.expectEqual(c.OT_OK, ot_scene_flush(&owner, null, 0, &input, 1, null, 0, &applied));
        try std.testing.expectEqual(@as(u32, 1), applied);
        @memset(&input[0].background, 0);
        accepted.background = color;
        try std.testing.expectEqualDeep(accepted, node.paint);
    }
    var foreign = id;
    foreign.context_id += 1;
    var stale = id;
    stale.generation += 1;
    const replacement = ansi.rgbColor(0, 0, 200, 255);
    input[0].background = replacement;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_flush(null, null, 0, &input, 1, null, 0, &applied));
    for ([_]c.ot_handle{ wrong_kind, foreign, stale }, [_]c.ot_status{ c.OT_WRONG_KIND, c.OT_WRONG_CONTEXT, c.OT_STALE_HANDLE }) |invalid, expected| {
        input[0].node = invalid;
        try std.testing.expectEqual(expected, ot_scene_flush(&owner, null, 0, &input, 1, null, 0, &applied));
        try std.testing.expectEqual(@as(u32, 0), applied);
        try std.testing.expectEqualDeep(accepted, node.paint);
    }
    input[0].node = id;
    for (0..4) |channel| {
        input[0].background = replacement;
        input[0].background[channel] |= 0x8000;
        try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_flush(&owner, null, 0, &input, 1, null, 0, &applied));
        try std.testing.expectEqual(@as(u32, 0), applied);
        try std.testing.expectEqualDeep(accepted, node.paint);
    }
    input[0].background = replacement;
    try core.cancelSession(session);
    try std.testing.expectEqual(c.OT_SESSION_CLOSED, ot_scene_flush(&owner, null, 0, &input, 1, null, 0, &applied));
    try std.testing.expectEqual(@as(u32, 0), applied);
    try std.testing.expectEqualDeep(accepted, node.paint);
    try core.sceneDestroyNode(box);
    try std.testing.expectEqual(c.OT_STALE_HANDLE, ot_scene_flush(&owner, null, 0, &input, 1, null, 0, &applied));
}

test "Scene flush ABI paints live copied background during a host hook pause" {
    const ansi = @import("ansi.zig");
    var owner: ContextHandle = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = undefined, .owner_thread = std.Thread.getCurrentId() };
    defer owner.io_threaded.deinit();
    owner.core = try Context.init(std.testing.allocator, owner.io_threaded.io(), .{});
    defer owner.core.deinit() catch unreachable;
    const core = owner.core;
    const session = try core.createSession(.{});
    try core.attachSessionRenderer(session, 8, 3, .{ .remote_mode = .remote });
    const root = try core.sceneCreateNode(session, c.OT_SCENE_ROOT, 1);
    const box = try core.sceneCreateNode(session, c.OT_SCENE_BOX, 2);
    try core.sceneSetStyle(box, 4, 0, 0, 1, 4, 1);
    try core.sceneSetStyle(box, 4, 1, 0, 1, 1, 1);
    try core.sceneSetPaint(box, .{ .translateX = 1, .translateY = 1, .background = .{ 200, 0, 0, 255 } });
    try core.sceneMoveNode(box, root, 0);
    try core.sceneSetHooks(box, c.OT_SCENE_HOOK_RENDER_BEFORE, 1, 4, 1);
    const options: scene.FrameOptions = .{ .background = .{ 0, 0, 0, 255 }, .use_mouse = false, .excluded_hit_num = 0, .max_layout_rounds = 8, .max_host_requests = 64 };
    const before = try core.sceneFrameStep(session, null, options);
    try std.testing.expectEqual(c.OT_SCENE_FRAME_RENDER_BEFORE, before.kind);
    try std.testing.expectEqual(box, before.node);
    const id = handleToC(box);
    const color = ansi.indexedColor(42, 0, 200, 0);
    var input: [1]c.ot_scene_background_update = .{.{ .node = id, .background = color, .fields = c.OT_SCENE_UPDATE_APPLY, .reserved = 0 }};
    var applied: u32 = 0;
    try std.testing.expectEqual(c.OT_OK, ot_scene_flush(&owner, null, 0, &input, 1, null, 0, &applied));
    try std.testing.expectEqual(@as(u32, 1), applied);
    @memset(&input[0].background, 0);
    const done = try core.sceneFrameStep(session, before, options);
    try std.testing.expectEqual(c.OT_SCENE_FRAME_DONE, done.kind);
    const target = (try core.getSessionRenderer(session)).getNextBuffer();
    try std.testing.expectEqual(color, target.get(1, 1).?.bg);
    try std.testing.expectEqual(options.background, target.get(0, 0).?.bg);
    try core.sceneFrameCancel(session, done.frame_id);
}

test "Scene viewport and focus ABI validate copied bindings and expanded paint records" {
    const handle: ?*ContextHandle = try createTestContext(.{ .object_capacity = 4, .render_cells_max = 8 });
    defer std.testing.expectEqual(c.OT_OK, ot_context_destroy(handle)) catch unreachable;
    const owner = handle.?.core;
    const session = try owner.createSession(.{});
    try owner.attachSessionRenderer(session, 4, 2, .{ .remote_mode = .remote });
    const root = try owner.sceneCreateNode(session, 0, 1);
    const box = try owner.sceneCreateNode(session, 1, 2);
    const node = handleToC(box);
    var viewport = handleToC(root);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_viewport(null, &node, &viewport));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_viewport(handle, null, &viewport));
    try std.testing.expectEqual(c.OT_WRONG_KIND, ot_scene_set_viewport(handle, &viewport, &node));
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_viewport(handle, &node, &viewport));
    viewport.generation += 1;
    try std.testing.expectEqual(root, (try owner.getRenderable(box)).scene_node.?.viewport.?);
    try std.testing.expectEqual(c.OT_STALE_HANDLE, ot_scene_set_viewport(handle, &node, &viewport));
    try std.testing.expectEqual(root, (try owner.getRenderable(box)).scene_node.?.viewport.?);
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_viewport(handle, &node, null));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_focus(handle, null, 1));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_focus(handle, &node, 2));
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_focus(handle, &node, 1));
    try std.testing.expectEqual(c.OT_STALE_HANDLE, ot_scene_set_focus(handle, &viewport, 1));
    try std.testing.expectEqual(box, (try owner.getSession(session)).scene.?.focus.?);

    var paint = std.mem.zeroes(c.ot_scene_paint_options);
    paint.struct_size = @sizeOf(c.ot_scene_paint_options);
    paint.abi_version = c.OT_CONTEXT_ABI_VERSION;
    paint.opacity = 1;
    paint.focusable = 1;
    paint.focused_border_color = .{ 12, 34, 56, 255 };
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_paint(handle, &node, &paint));
    const accepted = (try owner.getRenderable(box)).scene_node.?.paint;
    try std.testing.expect(accepted.focusable);
    try std.testing.expectEqual(paint.focused_border_color, accepted.focusedBorderColor);
    for (0..4) |field| {
        var invalid = paint;
        switch (field) {
            0 => invalid.struct_size = 56,
            1 => invalid.focusable = 2,
            2 => invalid.reserved = 1,
            3 => invalid.abi_version += 1,
            else => unreachable,
        }
        try std.testing.expectEqual(if (field == 3) c.OT_UNSUPPORTED_VERSION else c.OT_INVALID_ARGUMENT, ot_scene_set_paint(handle, &node, &invalid));
        try std.testing.expectEqualDeep(accepted, (try owner.getRenderable(box)).scene_node.?.paint);
    }
    try owner.cancelSession(session);
    try std.testing.expectEqual(c.OT_SESSION_CLOSED, ot_scene_set_focus(handle, &node, 1));
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_focus(handle, &node, 0));
    try std.testing.expect((try owner.getSession(session)).scene.?.focus == null);
}

test "Scene Slider and Arrow ABI validate fixed records without changing accepted state or outputs" {
    const handle: ?*ContextHandle = try createTestContext(.{ .object_capacity = 4, .render_cells_max = 8 });
    defer std.testing.expectEqual(c.OT_OK, ot_context_destroy(handle)) catch unreachable;
    const owner = handle.?.core;
    const session = try owner.createSession(.{});
    try owner.attachSessionRenderer(session, 4, 2, .{ .remote_mode = .remote });
    const id = handleToC(session);
    var root: c.ot_handle = undefined;
    var slider: c.ot_handle = undefined;
    var arrow: c.ot_handle = undefined;
    try std.testing.expectEqual(c.OT_OK, ot_scene_create_node(handle, &id, c.OT_SCENE_ROOT, 1, &root));
    try std.testing.expectEqual(c.OT_OK, ot_scene_create_node(handle, &id, c.OT_SCENE_SLIDER, 2, &slider));
    try std.testing.expectEqual(c.OT_OK, ot_scene_create_node(handle, &id, c.OT_SCENE_ARROW, 3, &arrow));
    try owner.sceneSetHooks(handleFromC(slider), 0, 1, 4.25, 1);
    const slider_options: c.ot_scene_slider_options = .{
        .struct_size = @sizeOf(c.ot_scene_slider_options),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .orientation = 0,
        .reserved = 0,
        .min = 0.125,
        .max = 7.125,
        .value = 1.125,
        .viewport_size = 3,
        .foreground = .{ 10, 20, 30, 40 },
        .background = .{ 50, 60, 70, 80 },
    };
    const arrow_options: c.ot_scene_arrow_options = .{
        .struct_size = @sizeOf(c.ot_scene_arrow_options),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .direction = 3,
        .attributes = 7,
        .foreground = .{ 90, 100, 110, 120 },
        .background = .{ 130, 140, 150, 160 },
    };
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_slider(handle, &slider, &slider_options));
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_arrow(handle, &arrow, &arrow_options, null, 0));
    const accepted_slider = (try owner.getRenderable(handleFromC(slider))).scene_node.?.control.slider;
    const accepted_arrow = (try owner.getRenderable(handleFromC(arrow))).scene_node.?.control.arrow;
    try std.testing.expectEqual(@as(f64, 0.125), accepted_slider.min);
    try std.testing.expectEqual(slider_options.foreground, accepted_slider.foreground);
    try std.testing.expectEqual(arrow_options.background, accepted_arrow.background);
    var output: c.ot_scene_slider_thumb = .{
        .struct_size = @sizeOf(c.ot_scene_slider_thumb),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .size = 999,
        .start = 999,
    };
    try std.testing.expectEqual(c.OT_OK, ot_scene_get_slider_thumb(handle, &slider, &output));
    try std.testing.expectEqual(@as(f64, 2), output.size);
    try std.testing.expectEqual(@as(f64, 1), output.start);
    const before = output;
    for (0..5) |field| {
        var invalid = slider_options;
        switch (field) {
            0 => invalid.struct_size -= 1,
            1 => invalid.abi_version += 1,
            2 => invalid.reserved = 1,
            3 => invalid.orientation = 2,
            4 => invalid.value = std.math.inf(f64),
            else => unreachable,
        }
        try std.testing.expectEqual(if (field == 1) c.OT_UNSUPPORTED_VERSION else c.OT_INVALID_ARGUMENT, ot_scene_set_slider(handle, &slider, &invalid));
    }
    for (0..4) |field| {
        var invalid = arrow_options;
        switch (field) {
            0 => invalid.struct_size += 1,
            1 => invalid.abi_version += 1,
            2 => invalid.direction = 4,
            3 => invalid.attributes = 256,
            else => unreachable,
        }
        try std.testing.expectEqual(if (field == 1) c.OT_UNSUPPORTED_VERSION else c.OT_INVALID_ARGUMENT, ot_scene_set_arrow(handle, &arrow, &invalid, null, 0));
    }
    try std.testing.expectEqual(c.OT_WRONG_KIND, ot_scene_set_slider(handle, &arrow, &slider_options));
    try std.testing.expectEqual(c.OT_WRONG_KIND, ot_scene_set_arrow(handle, &slider, &arrow_options, null, 0));
    try std.testing.expectEqual(c.OT_WRONG_KIND, ot_scene_get_slider_thumb(handle, &root, &output));
    try std.testing.expectEqualDeep(before, output);
    for (0..2) |field| {
        output = before;
        if (field == 0) output.struct_size -= 1 else output.abi_version += 1;
        const sentinel = output;
        try std.testing.expectEqual(if (field == 0) c.OT_INVALID_ARGUMENT else c.OT_UNSUPPORTED_VERSION, ot_scene_get_slider_thumb(handle, &slider, &output));
        try std.testing.expectEqualDeep(sentinel, output);
    }
    output = before;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_get_slider_thumb(handle, null, &output));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_get_slider_thumb(handle, &slider, null));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_slider(handle, &slider, null));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_arrow(handle, &arrow, null, null, 0));
    try std.testing.expectEqualDeep(before, output);
    try std.testing.expectEqualDeep(accepted_slider, (try owner.getRenderable(handleFromC(slider))).scene_node.?.control.slider);
    try std.testing.expectEqualDeep(accepted_arrow, (try owner.getRenderable(handleFromC(arrow))).scene_node.?.control.arrow);
    try std.testing.expectEqual(c.OT_OK, ot_scene_destroy_node(handle, &slider));
    try std.testing.expectEqual(c.OT_STALE_HANDLE, ot_scene_get_slider_thumb(handle, &slider, &output));
    try std.testing.expectEqualDeep(before, output);
}

test "Scene frame geometry reports delivered observations without expanding ticket authority" {
    var owner: ContextHandle = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = undefined, .owner_thread = std.Thread.getCurrentId() };
    defer owner.io_threaded.deinit();
    owner.core = try Context.init(std.testing.allocator, owner.io_threaded.io(), .{});
    defer owner.core.deinit() catch unreachable;
    const session = try owner.core.createSession(.{});
    try owner.core.attachSessionRenderer(session, 6, 3, .{ .remote_mode = .remote });
    const id = handleToC(session);
    const root = try owner.core.sceneCreateNode(session, 0, 1);
    const box = try owner.core.sceneCreateNode(session, 1, 2);
    try owner.core.sceneMoveNode(box, root, 0);
    try owner.core.sceneSetHooks(root, 1 | 2, 1, 0, 0);
    try owner.core.sceneSetHooks(box, 8 | 16, 1, 0, 0);
    const config: c.ot_scene_frame_options = .{
        .struct_size = @sizeOf(c.ot_scene_frame_options),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .background = .{ 0, 0, 0, 255 },
        .use_mouse = 0,
        .excluded_hit_num = 0,
        .max_layout_rounds = 8,
        .max_host_requests = 8,
        .preserve_unwritten = 0,
    };
    var output = std.mem.zeroes(c.ot_scene_frame_request);
    output.struct_size = @sizeOf(c.ot_scene_frame_request);
    output.abi_version = c.OT_CONTEXT_ABI_VERSION;
    var geometry = std.mem.zeroes(c.ot_scene_frame_geometry);
    geometry.struct_size = @sizeOf(c.ot_scene_frame_geometry);
    geometry.abi_version = c.OT_CONTEXT_ABI_VERSION;
    const unlimited = std.math.maxInt(u32);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_frame_step_with_geometry(&owner, &id, null, &config, unlimited, unlimited, &output, null));
    geometry.reserved = 1;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_frame_step_with_geometry(&owner, &id, null, &config, unlimited, unlimited, &output, &geometry));
    geometry.reserved = 0;
    try std.testing.expectEqual(c.OT_OK, ot_scene_frame_step_with_geometry(&owner, &id, null, &config, unlimited, unlimited, &output, &geometry));
    try std.testing.expectEqual(c.OT_SCENE_FRAME_UPDATE, output.kind);
    try std.testing.expectEqual(@as(f32, 6), geometry.paint.width);
    try std.testing.expectEqual(@as(f32, 0), geometry.public_layout.width);
    const update = output;
    const snapshot = geometry;
    geometry.abi_version += 1;
    try std.testing.expectEqual(c.OT_UNSUPPORTED_VERSION, ot_scene_frame_step_with_geometry(&owner, &id, &update, &config, unlimited, unlimited, &output, &geometry));
    try std.testing.expectEqualDeep(update, output);
    geometry = snapshot;
    try std.testing.expectEqual(c.OT_OK, ot_scene_frame_step_with_geometry(&owner, &id, &output, &config, unlimited, unlimited, &output, &geometry));
    try std.testing.expectEqual(c.OT_SCENE_FRAME_RESIZE, output.kind);
    try std.testing.expectEqual(@as(f32, 6), geometry.public_layout.width);
    try std.testing.expectEqual(@as(u32, 3), geometry.flags);
    try std.testing.expectEqual(c.OT_OK, ot_scene_frame_step_with_geometry(&owner, &id, &output, &config, unlimited, unlimited, &output, &geometry));
    try std.testing.expectEqual(c.OT_SCENE_FRAME_RENDER_BEFORE, output.kind);
    try owner.core.sceneDestroyNode(box);
    try std.testing.expectEqual(c.OT_OK, ot_scene_frame_step_with_geometry(&owner, &id, &output, &config, unlimited, unlimited, &output, &geometry));
    try std.testing.expectEqual(c.OT_SCENE_FRAME_RENDER_AFTER, output.kind);
    try std.testing.expectEqual(@as(u32, 0), geometry.flags);
    try std.testing.expectEqualDeep(std.mem.zeroes(c.ot_scene_layout), geometry.paint);
    try std.testing.expectEqualDeep(std.mem.zeroes(c.ot_scene_layout), geometry.public_layout);
    try std.testing.expectEqual(c.OT_OK, ot_scene_frame_step_with_geometry(&owner, &id, &output, &config, unlimited, unlimited, &output, &geometry));
    try std.testing.expectEqual(c.OT_SCENE_FRAME_DONE, output.kind);
    try std.testing.expectEqual(@as(u32, 0), geometry.flags);
    try owner.core.sceneFrameCancel(session, output.frame_id);
}

test "Scene work budget ABI preserves unlimited dispatch and exact preparation tickets" {
    var owner: ContextHandle = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = undefined, .owner_thread = std.Thread.getCurrentId() };
    defer owner.io_threaded.deinit();
    owner.core = try Context.init(std.testing.allocator, owner.io_threaded.io(), .{});
    defer owner.core.deinit() catch unreachable;
    const session = try owner.core.createSession(.{});
    try owner.core.attachSessionRenderer(session, 6, 3, .{ .remote_mode = .remote });
    const id = handleToC(session);
    const root = try owner.core.sceneCreateNode(session, 0, 1);
    const box = try owner.core.sceneCreateNode(session, 1, 2);
    try owner.core.sceneMoveNode(box, root, 0);
    const config: c.ot_scene_frame_options = .{
        .struct_size = @sizeOf(c.ot_scene_frame_options),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .background = .{ 0, 0, 0, 255 },
        .use_mouse = 0,
        .excluded_hit_num = 0,
        .max_layout_rounds = 8,
        .max_host_requests = 8,
        .preserve_unwritten = 0,
    };
    var output = std.mem.zeroes(c.ot_scene_frame_request);
    output.struct_size = @sizeOf(c.ot_scene_frame_request);
    output.abi_version = c.OT_CONTEXT_ABI_VERSION;
    var geometry = std.mem.zeroes(c.ot_scene_frame_geometry);
    geometry.struct_size = @sizeOf(c.ot_scene_frame_geometry);
    geometry.abi_version = c.OT_CONTEXT_ABI_VERSION;
    const unlimited = std.math.maxInt(u32);
    try std.testing.expectEqual(c.OT_OK, ot_scene_frame_step_with_geometry(&owner, &id, null, &config, unlimited, unlimited, &output, &geometry));
    try std.testing.expectEqual(c.OT_SCENE_FRAME_DONE, output.kind);
    try owner.core.sceneFrameCancel(session, output.frame_id);
    const before = output;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_frame_step_with_geometry(&owner, &id, null, &config, unlimited, 0, &output, &geometry));
    try std.testing.expectEqualDeep(before, output);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_frame_step_with_geometry(&owner, &id, null, &config, 0, unlimited, &output, &geometry));
    try std.testing.expectEqualDeep(before, output);
    try std.testing.expectEqual(c.OT_OK, ot_scene_frame_step_with_geometry(&owner, &id, null, &config, unlimited, 1, &output, &geometry));
    try std.testing.expectEqual(c.OT_SCENE_FRAME_YIELD, output.kind);
    try std.testing.expectEqualDeep(handleToC(root), output.node);
    try std.testing.expectEqual(@as(u32, 0), output.num | output.width | output.height);
    try std.testing.expectEqual(@as(u64, 0), output.hook_generation);
    const first = output;
    var stale = first;
    stale.request_id += 1;
    try std.testing.expectEqual(c.OT_STALE_FRAME, ot_scene_frame_step_with_geometry(&owner, &id, &stale, &config, unlimited, 1, &output, &geometry));
    try std.testing.expectEqualDeep(first, output);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_frame_step_with_geometry(&owner, &id, &first, &config, unlimited, 0, &output, &geometry));
    try std.testing.expectEqualDeep(first, output);
    try std.testing.expectError(error.StaleFrame, owner.core.sceneFrameAcquireBufferLease(session, try frameRequestFromC(output), .next));
    for (0..16) |_| {
        try std.testing.expectEqual(c.OT_OK, ot_scene_frame_step_with_geometry(&owner, &id, &output, &config, unlimited, 1, &output, &geometry));
        if (output.kind == c.OT_SCENE_FRAME_DONE) break;
        try std.testing.expectEqual(c.OT_SCENE_FRAME_YIELD, output.kind);
        try std.testing.expectEqual(first.frame_id, output.frame_id);
        try std.testing.expect(output.request_id > first.request_id);
    } else return error.TestUnexpectedResult;
    try owner.core.sceneFrameCancel(session, output.frame_id);
}

test "Scene feedback ABI validates records and preserves the pending ticket on rejection" {
    const handle: ?*ContextHandle = try createTestContext(.{ .object_capacity = 4, .render_cells_max = 18 });
    defer std.testing.expectEqual(c.OT_OK, ot_context_destroy(handle)) catch unreachable;
    const owner = handle.?;
    const session = try owner.core.createSession(.{});
    try owner.core.attachSessionRenderer(session, 6, 3, .{ .remote_mode = .remote });
    const id = handleToC(session);
    var root: c.ot_handle = undefined;
    try std.testing.expectEqual(c.OT_OK, ot_scene_create_node(handle, &id, 0, 1, &root));
    var hooks: c.ot_scene_hooks = .{
        .struct_size = @sizeOf(c.ot_scene_hooks),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .flags = 3,
        .reserved = 1,
        .generation = 1,
        .initial_width = 0,
        .initial_height = 0,
    };
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_hooks(handle, &root, &hooks));
    hooks.reserved = 0;
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_hooks(handle, &root, &hooks));
    var config: c.ot_scene_frame_options = .{
        .struct_size = @sizeOf(c.ot_scene_frame_options),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .background = .{ 0, 0, 0, 255 },
        .use_mouse = 1,
        .excluded_hit_num = 0,
        .max_layout_rounds = 1,
        .max_host_requests = 8,
        .preserve_unwritten = 0,
    };
    var output = std.mem.zeroes(c.ot_scene_frame_request);
    output.struct_size = @sizeOf(c.ot_scene_frame_request);
    output.abi_version = c.OT_CONTEXT_ABI_VERSION;
    output.width = 999;
    var geometry = std.mem.zeroes(c.ot_scene_frame_geometry);
    geometry.struct_size = @sizeOf(c.ot_scene_frame_geometry);
    geometry.abi_version = c.OT_CONTEXT_ABI_VERSION;
    const unlimited = std.math.maxInt(u32);
    const sentinel = output;
    config.preserve_unwritten = 2;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_frame_step_with_geometry(handle, &id, null, &config, unlimited, unlimited, &output, &geometry));
    try std.testing.expectEqualDeep(sentinel, output);
    config.preserve_unwritten = 0;
    try std.testing.expectEqual(c.OT_OK, ot_scene_frame_step_with_geometry(handle, &id, null, &config, unlimited, unlimited, &output, &geometry));
    try std.testing.expectEqual(c.OT_SCENE_FRAME_UPDATE, output.kind);
    try std.testing.expectEqual(@as(u32, 6), output.width);
    const first = output;
    var invalid = first;
    invalid.reserved[1] = 1;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_frame_step_with_geometry(handle, &id, &invalid, &config, unlimited, unlimited, &output, &geometry));
    try std.testing.expectEqualDeep(first, output);
    invalid = first;
    invalid.struct_size -= 1;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_frame_step_with_geometry(handle, &id, &invalid, &config, unlimited, unlimited, &output, &geometry));
    invalid = first;
    invalid.abi_version += 1;
    try std.testing.expectEqual(c.OT_UNSUPPORTED_VERSION, ot_scene_frame_step_with_geometry(handle, &id, &invalid, &config, unlimited, unlimited, &output, &geometry));
    invalid = first;
    invalid.hook_generation += 1;
    try std.testing.expectEqual(c.OT_STALE_FRAME, ot_scene_frame_step_with_geometry(handle, &id, &invalid, &config, unlimited, unlimited, &output, &geometry));
    config.max_layout_rounds = 2;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_frame_step_with_geometry(handle, &id, &first, &config, unlimited, unlimited, &output, &geometry));
    config.max_layout_rounds = 1;
    try std.testing.expectEqualDeep(first, output);
    var render_status: u32 = 999;
    try std.testing.expectEqual(c.OT_FRAME_BUSY, ot_session_render(handle, &id, 1, &render_status));
    try std.testing.expectEqual(@as(u32, 999), render_status);
    // An in-place acknowledgement is valid: input is copied before output publication.
    try std.testing.expectEqual(c.OT_OK, ot_scene_frame_step_with_geometry(handle, &id, &output, &config, unlimited, unlimited, &output, &geometry));
    try std.testing.expectEqual(c.OT_SCENE_FRAME_RESIZE, output.kind);
    const second = output;
    try std.testing.expectEqual(c.OT_STALE_FRAME, ot_scene_frame_step_with_geometry(handle, &id, &first, &config, unlimited, unlimited, &output, &geometry));
    try std.testing.expectEqualDeep(second, output);
    try std.testing.expectEqual(c.OT_STALE_FRAME, ot_scene_frame_cancel(handle, &id, output.frame_id + 1));
    try std.testing.expectEqual(c.OT_OK, ot_scene_frame_cancel(handle, &id, output.frame_id));
    try std.testing.expectEqual(c.OT_STALE_FRAME, ot_scene_frame_step_with_geometry(handle, &id, &second, &config, unlimited, unlimited, &output, &geometry));
    hooks.flags = 1;
    hooks.generation = 2;
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_hooks(handle, &root, &hooks));
    try std.testing.expectEqual(c.OT_OK, ot_scene_frame_step_with_geometry(handle, &id, null, &config, unlimited, unlimited, &output, &geometry));
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_style(handle, &root, 4, 0, 0, 1, 3, 1));
    const before_limit = output;
    try std.testing.expectEqual(c.OT_LAYOUT_LIMIT, ot_scene_frame_step_with_geometry(handle, &id, &output, &config, unlimited, unlimited, &output, &geometry));
    try std.testing.expectEqualDeep(before_limit, output);
    try std.testing.expectEqual(@as(u64, 0), (try owner.core.sceneGetStats(session)).frameCount);
}

test "Scene ABI custom measurement checks identity reentry and registration lifetime" {
    const Probe = struct {
        var owner: *ContextHandle = undefined;
        var expected: c.ot_handle = undefined;
        var calls: u32 = 0;
        var read_status: c.ot_status = c.OT_INTERNAL_ERROR;
        var paint_layout_status: c.ot_status = c.OT_INTERNAL_ERROR;
        var write_status: c.ot_status = c.OT_OK;
        var background_status: c.ot_status = c.OT_OK;
        var applied: u32 = 99;
        var paint_status: c.ot_status = c.OT_OK;
        var replace_status: c.ot_status = c.OT_OK;
        var destroy_status: c.ot_status = c.OT_OK;

        fn measure(context_id: u64, slot: u32, generation: u32, _: f32, _: u32, _: f32, _: u32, result: [*c]f32) callconv(.c) void {
            std.debug.assert(context_id == expected.context_id and slot == expected.slot and generation == expected.generation);
            calls += 1;
            var style: c.ot_scene_style_value = .{ .struct_size = @sizeOf(c.ot_scene_style_value), .abi_version = c.OT_CONTEXT_ABI_VERSION, .unit = 0, .value = 0 };
            read_status = ot_scene_get_style(owner, &expected, 0, 9, 0, &style);
            var layout = std.mem.zeroes(c.ot_scene_layout);
            layout.struct_size = @sizeOf(c.ot_scene_layout);
            layout.abi_version = c.OT_CONTEXT_ABI_VERSION;
            paint_layout_status = ot_scene_get_layout(owner, &expected, 2, &layout);
            write_status = ot_scene_set_style(owner, &expected, 4, 0, 0, 1, 99, 0);
            const background: [1]c.ot_scene_background_update = .{.{ .node = expected, .background = .{ 200, 0, 0, 255 }, .fields = c.OT_SCENE_UPDATE_APPLY, .reserved = 0 }};
            background_status = ot_scene_flush(owner, null, 0, &background, 1, null, 0, &applied);
            paint_status = ot_scene_set_paint(owner, &expected, null);
            replace_status = ot_scene_set_measure(owner, &expected, null);
            destroy_status = ot_context_destroy(owner);
            result[0] = 2;
            result[1] = 1;
        }
    };
    const handle: ?*ContextHandle = try createTestContext(.{ .object_capacity = 4, .render_cells_max = 8 });
    defer std.testing.expectEqual(c.OT_OK, ot_context_destroy(handle)) catch unreachable;
    const owner = handle.?;
    const session = try owner.core.createSession(.{});
    try owner.core.attachSessionRenderer(session, 4, 2, .{ .remote_mode = .remote });
    const session_c = handleToC(session);
    var root: c.ot_handle = undefined;
    var leaf: c.ot_handle = undefined;
    try std.testing.expectEqual(c.OT_OK, ot_scene_create_node(handle, &session_c, 0, 1, &root));
    try std.testing.expectEqual(c.OT_OK, ot_scene_create_node(handle, &session_c, 1, 2, &leaf));
    try std.testing.expectEqual(c.OT_OK, ot_scene_move_node(handle, &leaf, &root, 0));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_measure(handle, &root, &Probe.measure));
    try std.testing.expectEqual(@as(u32, 0), owner.core.scene_measures.count());
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_measure(handle, null, &Probe.measure));
    try std.testing.expectEqual(c.OT_WRONG_KIND, ot_scene_set_measure(handle, &session_c, &Probe.measure));
    var foreign = leaf;
    foreign.context_id += 1;
    try std.testing.expectEqual(c.OT_WRONG_CONTEXT, ot_scene_set_measure(handle, &foreign, &Probe.measure));
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_measure(handle, &leaf, &Probe.measure));
    Probe.owner = owner;
    Probe.expected = leaf;
    Probe.calls = 0;
    try std.testing.expectEqual(c.OT_OK, ot_scene_paint(handle, &session_c, &.{ 0, 0, 0, 255 }, 0, 0));
    try std.testing.expect(Probe.calls > 0);
    try std.testing.expectEqual(c.OT_OK, Probe.read_status);
    try std.testing.expectEqual(c.OT_OK, Probe.paint_layout_status);
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, Probe.write_status);
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, Probe.background_status);
    try std.testing.expectEqual(@as(u32, 0), Probe.applied);
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, Probe.paint_status);
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, Probe.replace_status);
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, Probe.destroy_status);
    const calls = Probe.calls;
    try std.testing.expectEqual(c.OT_OK, ot_scene_paint(handle, &session_c, &.{ 0, 0, 0, 255 }, 0, 0));
    try std.testing.expectEqual(calls, Probe.calls);
    try std.testing.expectEqual(c.OT_OK, ot_scene_mark_dirty(handle, &leaf));
    try std.testing.expectEqual(c.OT_OK, ot_scene_paint(handle, &session_c, &.{ 0, 0, 0, 255 }, 0, 0));
    try std.testing.expect(Probe.calls > calls);
    try std.testing.expectEqual(c.OT_OK, ot_scene_move_node(handle, &leaf, null, 0));
    try std.testing.expectEqual(c.OT_OK, ot_scene_destroy_node(handle, &leaf));
    try std.testing.expectEqual(@as(u32, 0), owner.core.scene_measures.count());
    var reused: c.ot_handle = undefined;
    try std.testing.expectEqual(c.OT_OK, ot_scene_create_node(handle, &session_c, 1, 3, &reused));
    try std.testing.expectEqual(leaf.slot, reused.slot);
    try std.testing.expect(reused.generation != leaf.generation);
    try std.testing.expectEqual(c.OT_STALE_HANDLE, ot_scene_set_measure(handle, &leaf, &Probe.measure));
    var enabled: u32 = 123;
    try std.testing.expectEqual(c.OT_OK, ot_scene_has_measure(handle, &reused, &enabled));
    try std.testing.expectEqual(@as(u32, 0), enabled);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_mark_dirty(handle, &reused));
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_measure(handle, &reused, &Probe.measure));
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_measure(handle, &reused, null));
    try std.testing.expectEqual(@as(u32, 0), owner.core.scene_measures.count());
}

test "Scene ABI records preserve rejected outputs and read real Session metadata" {
    const handle: ?*ContextHandle = try createTestContext(.{ .object_capacity = 4, .render_cells_max = 8 });
    defer std.testing.expectEqual(c.OT_OK, ot_context_destroy(handle)) catch unreachable;
    const owner = handle.?;
    const session = try owner.core.createSession(.{});
    try owner.core.attachSessionRenderer(session, 4, 2, .{ .remote_mode = .remote });
    var session_c = handleToC(session);
    var root: c.ot_handle = undefined;
    try std.testing.expectEqual(c.OT_OK, ot_scene_create_node(handle, &session_c, 0, 1, &root));
    var box: c.ot_handle = undefined;
    try std.testing.expectEqual(c.OT_OK, ot_scene_create_node(handle, &session_c, 1, 2, &box));
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_style(handle, &box, 4, 0, 0, 1, 3, 1));
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_style(handle, &box, 4, 1, 0, 1, 1, 1));
    try std.testing.expectEqual(c.OT_OK, ot_scene_move_node(handle, &box, &root, 0));
    var layout: c.ot_scene_layout = std.mem.zeroes(c.ot_scene_layout);
    layout.struct_size = @sizeOf(c.ot_scene_layout);
    layout.abi_version = c.OT_CONTEXT_ABI_VERSION + 1;
    layout.width = 999;
    const before = layout;
    try std.testing.expectEqual(c.OT_UNSUPPORTED_VERSION, ot_scene_get_layout(handle, &box, 0, &layout));
    try std.testing.expectEqualDeep(before, layout);
    layout.abi_version = c.OT_CONTEXT_ABI_VERSION;
    try std.testing.expectEqual(c.OT_OK, ot_scene_paint(handle, &session_c, &.{ 0, 0, 0, 255 }, 1, 0));
    try std.testing.expectEqual(c.OT_OK, ot_scene_get_layout(handle, &box, 0, &layout));
    try std.testing.expectEqual(@as(f32, 3), layout.width);
    const before_selector = layout;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_get_layout(handle, &box, 3, &layout));
    try std.testing.expectEqualDeep(before_selector, layout);
    try owner.core.sceneSetStyle(handleFromC(box), 4, 0, 0, 1, 0, 1);
    try std.testing.expectEqual(c.OT_OK, ot_scene_paint(handle, &session_c, &.{ 0, 0, 0, 255 }, 0, 0));
    try std.testing.expectEqual(c.OT_OK, ot_scene_get_layout(handle, &box, 0, &layout));
    try std.testing.expectEqual(@as(f32, 1), layout.width);
    try std.testing.expectEqual(c.OT_OK, ot_scene_get_layout(handle, &box, 1, &layout));
    try std.testing.expectEqual(@as(f32, 0), layout.width);
    try std.testing.expectEqual(@as(f64, 0), layout.screen_x);
    try std.testing.expectEqual(@as(f64, 0), layout.screen_y);
    const paint_options: c.ot_scene_paint_options = .{
        .struct_size = @sizeOf(c.ot_scene_paint_options),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .z_index = 0,
        .opacity = 1,
        .translate_x = 0.999999999,
        .translate_y = 0.1,
        .border_sides = 0,
        .should_fill = 1,
        .background = .{ 0, 0, 0, 0 },
        .border_color = .{ 255, 255, 255, 255 },
        .border_style = 0,
        .focusable = 0,
        .focused_border_color = .{ 0, 170, 255, 255 },
        .reserved = 0,
    };
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_paint(handle, &box, &paint_options));
    try std.testing.expectEqual(c.OT_OK, ot_scene_get_layout(handle, &box, 0, &layout));
    try std.testing.expectEqual(@as(f64, 0.999999999), layout.screen_x);
    try std.testing.expectEqual(@as(f64, 0.1), layout.screen_y);
    var style: c.ot_scene_style_value = .{ .struct_size = @sizeOf(c.ot_scene_style_value), .abi_version = c.OT_CONTEXT_ABI_VERSION, .unit = 99, .value = 999 };
    const style_before = style;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_get_style(handle, &box, 99, 0, 0, &style));
    try std.testing.expectEqualDeep(style_before, style);
    var cursor: c.ot_scene_cursor_state = std.mem.zeroes(c.ot_scene_cursor_state);
    cursor.struct_size = @sizeOf(c.ot_scene_cursor_state);
    cursor.abi_version = c.OT_CONTEXT_ABI_VERSION;
    const cli = try owner.core.getSessionRenderer(session);
    cli.terminal.setCursorPosition(3, 2, true);
    cli.terminal.setCursorStyle(.underline, false);
    try std.testing.expectEqual(c.OT_OK, ot_scene_get_cursor_state(handle, &session_c, &cursor));
    try std.testing.expectEqual(@as(u32, 3), cursor.x);
    try std.testing.expectEqual(@as(u32, 2), cursor.y);
    try std.testing.expectEqual(@as(u32, 1), cursor.visible);
    try std.testing.expectEqual(@as(u32, 2), cursor.style);
    try std.testing.expectEqual(@as(u32, 0), cursor.blinking);
    try std.testing.expectEqual(@as(u32, 0), cursor.reserved);
    const layout_before_overflow = layout;
    try owner.core.sceneSetPaint(handleFromC(root), .{ .translateX = std.math.floatMax(f64) });
    try owner.core.sceneSetPaint(handleFromC(box), .{ .translateX = std.math.floatMax(f64) });
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_get_layout(handle, &box, 0, &layout));
    try std.testing.expectEqualDeep(layout_before_overflow, layout);
    try std.testing.expectEqual(c.OT_OK, ot_scene_get_layout(handle, &box, 1, &layout));
    try std.testing.expectEqual(@as(f64, 0), layout.screen_x);
    try owner.core.cancelSession(session);
    try std.testing.expectEqual(c.OT_OK, ot_scene_destroy_node(handle, &root));
    try std.testing.expectEqual(c.OT_OK, ot_scene_destroy_node(handle, &box));
}

test "Scene ABI paint layout preserves prepared coordinates through reparenting" {
    const handle: ?*ContextHandle = try createTestContext(.{ .object_capacity = 8, .render_cells_max = 12 });
    defer std.testing.expectEqual(c.OT_OK, ot_context_destroy(handle)) catch unreachable;
    const core = handle.?.core;
    const session = try core.createSession(.{});
    try core.attachSessionRenderer(session, 12, 1, .{ .remote_mode = .remote });
    const root = try core.sceneCreateNode(session, 0, 1);
    const source = try core.sceneCreateNode(session, 1, 2);
    const child = try core.sceneCreateNode(session, 1, 3);
    const destination = try core.sceneCreateNode(session, 1, 4);
    for ([_]ObjectHandle{ source, child, destination }) |node| {
        try core.sceneSetStyle(node, 4, 0, 0, 1, 2, 1);
        try core.sceneSetStyle(node, 4, 1, 0, 1, 1, 1);
        try core.sceneSetStyle(node, 0, 6, 0, 0, 2, 0);
    }
    try core.sceneMoveNode(source, root, 0);
    try core.sceneMoveNode(child, source, 0);
    try core.sceneMoveNode(destination, root, 1);
    try core.sceneSetPaint(source, .{ .translateX = 1 });
    try core.sceneSetPaint(destination, .{ .translateX = 5 });
    try core.sceneSetHooks(source, 8, 1, 2, 1);
    try core.sceneSetHooks(child, 56, 1, 2, 1);
    const options: scene.FrameOptions = .{ .background = .{ 0, 0, 0, 255 }, .use_mouse = true, .excluded_hit_num = 0, .max_layout_rounds = 8, .max_host_requests = 64 };
    var request = try core.sceneFrameStep(session, null, options);
    try std.testing.expectEqual(source, request.node);
    try core.sceneMoveNode(child, destination, 0);
    request = try core.sceneFrameStep(session, request, options);
    try std.testing.expectEqual(child, request.node);
    const child_c = handleToC(child);
    var layout = std.mem.zeroes(c.ot_scene_layout);
    layout.struct_size = @sizeOf(c.ot_scene_layout);
    layout.abi_version = c.OT_CONTEXT_ABI_VERSION;
    try std.testing.expectEqual(c.OT_OK, ot_scene_get_layout(handle, &child_c, 0, &layout));
    try std.testing.expectEqual(@as(f64, 5), layout.screen_x);
    try std.testing.expectEqual(c.OT_OK, ot_scene_get_layout(handle, &child_c, 2, &layout));
    try std.testing.expectEqual(@as(f64, 1), layout.screen_x);
    try std.testing.expectEqual(@as(f32, 2), layout.width);
    try core.sceneSetPaint(destination, .{ .translateX = 6 });
    try std.testing.expectEqual(@as(f64, 6), (try core.sceneGetLayout(child, false)).screenX);
    try std.testing.expectEqual(c.OT_OK, ot_scene_get_layout(handle, &child_c, 2, &layout));
    try std.testing.expectEqual(@as(f64, 1), layout.screen_x);
    try core.sceneSetPaint(child, .{ .translateX = 2 });
    try std.testing.expectEqual(c.OT_OK, ot_scene_get_layout(handle, &child_c, 2, &layout));
    try std.testing.expectEqual(@as(f64, 8), layout.screen_x);
    const before = layout;
    core.mutating = true;
    const busy = ot_scene_get_layout(handle, &child_c, 2, &layout);
    core.mutating = false;
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, busy);
    try std.testing.expectEqualDeep(before, layout);
    var foreign = child_c;
    foreign.context_id += 1;
    try std.testing.expectEqual(c.OT_WRONG_CONTEXT, ot_scene_get_layout(handle, &foreign, 2, &layout));
    try std.testing.expectEqualDeep(before, layout);
    try core.sceneFrameCancel(session, request.frame_id);
    try core.sceneDestroyNode(child);
    _ = try core.sceneCreateNode(session, 1, 5);
    try std.testing.expectEqual(c.OT_STALE_HANDLE, ot_scene_get_layout(handle, &child_c, 2, &layout));
    try std.testing.expectEqualDeep(before, layout);
}

test "Scene styled text ABI validates linked chunk bounds and preserves the legacy record" {
    const handle: ?*ContextHandle = try createTestContext(.{ .object_capacity = 4, .render_cells_max = 16 });
    defer std.testing.expectEqual(c.OT_OK, ot_context_destroy(handle)) catch unreachable;
    const owner = handle.?.core;
    const session = try owner.createSession(.{});
    try owner.attachSessionRenderer(session, 8, 2, .{ .remote_mode = .remote });
    const root = try owner.sceneCreateNode(session, 0, 1);
    const node = try owner.sceneCreateNode(session, 2, 2);
    const id = handleToC(node);
    var legacy = std.mem.zeroes(c.ot_scene_text_chunk);
    legacy.struct_size = @sizeOf(c.ot_scene_text_chunk);
    legacy.abi_version = c.OT_CONTEXT_ABI_VERSION;
    legacy.byte_count = 4;
    legacy.attributes = 1;
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_styled_text(handle, &id, "kept", 4, &.{legacy}, 1));
    legacy.flags = c.OT_SCENE_TEXT_LINK;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_styled_text(handle, &id, "next", 4, &.{legacy}, 1));
    var linked = std.mem.zeroes(c.ot_scene_linked_text_chunk);
    linked.struct_size = @sizeOf(c.ot_scene_linked_text_chunk);
    linked.abi_version = c.OT_CONTEXT_ABI_VERSION;
    linked.byte_count = 4;
    linked.flags = c.OT_SCENE_TEXT_LINK;
    linked.link_offset = 1;
    linked.link_byte_count = 3;
    var urls = [_]u8{ '_', 0xff, 0, 0x1b };
    const text = (try owner.getRenderable(node)).scene_node.?.text.?;
    const style = text.owned_style;
    const epoch = text.buffer.getContentEpoch();
    for (0..13) |field| {
        var invalid = linked;
        var expected: c.ot_status = c.OT_INVALID_ARGUMENT;
        switch (field) {
            0 => invalid.struct_size -= 1,
            1 => {
                invalid.abi_version += 1;
                expected = c.OT_UNSUPPORTED_VERSION;
            },
            2 => invalid.flags |= 8,
            3 => invalid.reserved = 1,
            4 => invalid.byte_count = 0,
            5 => invalid.byte_count = 5,
            6 => invalid.attributes = 256,
            7 => invalid.link_offset = std.math.maxInt(u32),
            8 => invalid.link_byte_count = std.math.maxInt(u32),
            9 => invalid.link_offset = urls.len + 1,
            10 => invalid.link_byte_count += 1,
            11 => invalid.flags = 0,
            12 => {
                invalid.flags |= c.OT_SCENE_TEXT_FOREGROUND;
                invalid.foreground[0] = 256;
            },
            else => unreachable,
        }
        try std.testing.expectEqual(expected, ot_scene_set_styled_text_with_links(handle, &id, "next", 4, &.{invalid}, 1, &urls, urls.len));
        try std.testing.expectEqual(style, text.owned_style);
        try std.testing.expectEqual(epoch, text.buffer.getContentEpoch());
        try std.testing.expectEqual(@as(u64, 0), owner.links.getTotalSlots());
    }
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_styled_text_with_links(null, &id, "next", 4, &.{linked}, 1, &urls, urls.len));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_styled_text_with_links(handle, null, "next", 4, &.{linked}, 1, &urls, urls.len));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_styled_text_with_links(handle, &id, null, 4, &.{linked}, 1, &urls, urls.len));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_styled_text_with_links(handle, &id, "next", 4, null, 1, &urls, urls.len));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_styled_text_with_links(handle, &id, "next", 4, &.{linked}, 5, &urls, urls.len));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_styled_text_with_links(handle, &id, "next", 4, &.{linked}, 1, null, urls.len));
    linked.byte_count = 2;
    var invalid_tail = linked;
    invalid_tail.byte_count = 1;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_styled_text_with_links(handle, &id, "next", 4, &.{ linked, invalid_tail }, 2, &urls, urls.len));
    invalid_tail.byte_count = 3;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_styled_text_with_links(handle, &id, "next", 4, &.{ linked, invalid_tail }, 2, &urls, urls.len));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_styled_text_with_links(handle, &id, "a\xc3\xa9b", 4, &.{ linked, linked }, 2, &urls, urls.len));
    try std.testing.expectEqual(@as(u64, 0), owner.links.getTotalSlots());
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_styled_text_with_links(handle, &id, "next", 4, &.{ linked, linked }, 2, &urls, urls.len));
    @memset(&urls, '!');
    try owner.sceneMoveNode(node, root, 0);
    try owner.scenePaint(session, .{ 0, 0, 0, 255 }, false, 0);
    const target = (try owner.getSessionRenderer(session)).getNextBuffer();
    const link_id = @import("ansi.zig").TextAttributes.getLinkId(target.get(0, 0).?.attributes);
    try std.testing.expectEqualStrings("\xff\x00\x1b", try owner.links.get(link_id));
    try std.testing.expectEqual(link_id, @import("ansi.zig").TextAttributes.getLinkId(target.get(3, 0).?.attributes));
    try std.testing.expectEqual(@as(u32, 2), try owner.links.getRefcount(link_id));
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_styled_text_with_links(handle, &id, null, 0, null, 0, null, 0));
    try owner.scenePaint(session, .{ 0, 0, 0, 255 }, false, 0);
    try std.testing.expectEqual(@as(u64, 0), owner.links.getLiveSlotCount());
}

test "Scene text selection ABI validates records pointers and readonly outputs" {
    try std.testing.expectEqual(@as(usize, 56), @sizeOf(c.ot_scene_text_selection_options));
    const handle: ?*ContextHandle = try createTestContext(.{ .object_capacity = 4, .render_cells_max = 32 });
    defer std.testing.expectEqual(c.OT_OK, ot_context_destroy(handle)) catch unreachable;
    const owner = handle.?.core;
    const session = try owner.createSession(.{});
    try owner.attachSessionRenderer(session, 8, 4, .{ .remote_mode = .remote });
    const root = handleToC(try owner.sceneCreateNode(session, 0, 1));
    const node = handleToC(try owner.sceneCreateNode(session, 2, 2));
    try owner.sceneSetText(handleFromC(node), "one two\r\nlast");
    var options = std.mem.zeroes(c.ot_scene_text_selection_options);
    options.struct_size = @sizeOf(c.ot_scene_text_selection_options);
    options.abi_version = c.OT_CONTEXT_ABI_VERSION;
    options.operation = c.OT_SCENE_TEXT_SELECTION_SET;
    options.behavior = c.OT_SCENE_TEXT_SELECTION_WORD;
    var changed: u32 = 999;
    var packed_selection: u64 = 999;
    var count: u32 = 999;
    var bytes: [16]u8 = @splat('!');
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_text_selection(handle, &node, &options, &changed));
    try std.testing.expectEqual(@as(u32, 1), changed);
    try std.testing.expectEqual(c.OT_OK, ot_scene_get_text_selection(handle, &node, &packed_selection));
    try std.testing.expectEqual(@as(u64, 3), packed_selection);
    for (0..9) |case| {
        var invalid = options;
        switch (case) {
            0 => invalid.struct_size -= 1,
            1 => invalid.abi_version += 1,
            2 => invalid.operation = 3,
            3 => invalid.behavior = 3,
            4 => invalid.flags = 4,
            5 => invalid.reserved = 1,
            6 => invalid.background[0] = 1,
            7 => invalid.foreground[0] = 1,
            8 => {
                invalid.flags = c.OT_SCENE_TEXT_SELECTION_FOREGROUND;
                invalid.foreground[0] = 256;
            },
            else => unreachable,
        }
        changed = 999;
        const status = if (case == 1) c.OT_UNSUPPORTED_VERSION else c.OT_INVALID_ARGUMENT;
        try std.testing.expectEqual(status, ot_scene_set_text_selection(handle, &node, &invalid, &changed));
        try std.testing.expectEqual(@as(u32, 999), changed);
        try std.testing.expectEqual(c.OT_OK, ot_scene_get_text_selection(handle, &node, &packed_selection));
        try std.testing.expectEqual(@as(u64, 3), packed_selection);
    }
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_text_selection(null, &node, &options, &changed));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_text_selection(handle, null, &options, &changed));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_text_selection(handle, &node, null, &changed));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_text_selection(handle, &node, &options, null));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_get_text_selection(null, &node, &packed_selection));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_get_text_selection(handle, null, &packed_selection));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_get_text_selection(handle, &node, null));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_get_selected_text(null, &node, null, 0, &count));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_get_selected_text(handle, null, null, 0, &count));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_get_selected_text(handle, &node, null, 0, null));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_get_selected_text(handle, &node, null, 1, &count));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_get_selected_text(handle, &node, &bytes, 3, &count));
    try std.testing.expectEqual(@as(u32, 999), count);
    try std.testing.expectEqualStrings("!!!!!!!!!!!!!!!!", &bytes);
    try std.testing.expectEqual(c.OT_OK, ot_scene_get_selected_text(handle, &node, null, 0, &count));
    try std.testing.expectEqual(@as(u32, 12), count);
    try std.testing.expectEqual(c.OT_OK, ot_scene_get_selected_text(handle, &node, &bytes, count, &count));
    try std.testing.expectEqual(@as(u32, 3), count);
    try std.testing.expectEqualStrings("one!!!!!!!!!!!!!", &bytes);
    try std.testing.expectEqual(c.OT_WRONG_KIND, ot_scene_set_text_selection(handle, &root, &options, &changed));
    try std.testing.expectEqual(c.OT_WRONG_KIND, ot_scene_get_text_selection(handle, &root, &packed_selection));
    try std.testing.expectEqual(c.OT_WRONG_KIND, ot_scene_get_selected_text(handle, &root, &bytes, bytes.len, &count));
    var foreign = node;
    foreign.context_id += 1;
    try std.testing.expectEqual(c.OT_WRONG_CONTEXT, ot_scene_get_text_selection(handle, &foreign, &packed_selection));
    handle.?.owner_thread += 1;
    const thread_status = ot_scene_get_text_selection(handle, &node, &packed_selection);
    handle.?.owner_thread -= 1;
    try std.testing.expectEqual(c.OT_WRONG_THREAD, thread_status);
    owner.mutating = true;
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_scene_get_text_selection(handle, &node, &packed_selection));
    owner.scene_measuring = true;
    try std.testing.expectEqual(c.OT_OK, ot_scene_get_text_selection(handle, &node, &packed_selection));
    try std.testing.expectEqual(c.OT_OK, ot_scene_get_selected_text(handle, &node, &bytes, bytes.len, &count));
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_scene_set_text_selection(handle, &node, &options, &changed));
    owner.scene_measuring = false;
    owner.mutating = false;
    try owner.cancelSession(session);
    try std.testing.expectEqual(c.OT_SESSION_CLOSED, ot_scene_set_text_selection(handle, &node, &options, &changed));
    options.operation = c.OT_SCENE_TEXT_SELECTION_RESET;
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_text_selection(handle, &node, &options, &changed));
    try std.testing.expectEqual(c.OT_OK, ot_scene_get_text_selection(handle, &node, &packed_selection));
    try std.testing.expectEqual(std.math.maxInt(u64), packed_selection);
    try std.testing.expectEqual(c.OT_OK, ot_scene_get_selected_text(handle, &node, null, 0, &count));
    try std.testing.expectEqual(@as(u32, 0), count);
    try owner.sceneDestroyNode(handleFromC(node));
    try std.testing.expectEqual(c.OT_STALE_HANDLE, ot_scene_set_text_selection(handle, &node, &options, &changed));
    try std.testing.expectEqual(c.OT_STALE_HANDLE, ot_scene_get_text_selection(handle, &node, &packed_selection));
    try std.testing.expectEqual(c.OT_STALE_HANDLE, ot_scene_get_selected_text(handle, &node, &bytes, bytes.len, &count));
    try std.testing.expectEqual(std.math.maxInt(u64), packed_selection);
    try std.testing.expectEqual(@as(u32, 0), count);
}

test "Scene text ABI validates options and copies bounded text queries" {
    const handle: ?*ContextHandle = try createTestContext(.{ .object_capacity = 4, .render_cells_max = 32 });
    defer std.testing.expectEqual(c.OT_OK, ot_context_destroy(handle)) catch unreachable;
    const owner = handle.?;
    const session = try owner.core.createSession(.{});
    try owner.core.attachSessionRenderer(session, 8, 4, .{ .remote_mode = .remote });
    const id = handleToC(session);
    var root: c.ot_handle = undefined;
    var text: c.ot_handle = undefined;
    try std.testing.expectEqual(c.OT_OK, ot_scene_create_node(handle, &id, c.OT_SCENE_ROOT, 1, &root));
    try std.testing.expectEqual(c.OT_OK, ot_scene_create_node(handle, &id, c.OT_SCENE_TEXT, 2, &text));
    var text_options: c.ot_scene_text_options = .{
        .struct_size = @sizeOf(c.ot_scene_text_options),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .foreground = .{ 200, 100, 50, 255 },
        .background = .{ 10, 20, 30, 255 },
        .attributes = 1,
        .wrap_mode = c.OT_SCENE_WRAP_WORD,
        .truncate = 0,
        .first_line_offset = 0,
        .scroll_x = 0,
        .scroll_y = 0,
        .tab_indicator = 0,
        .tab_color_set = 0,
        .tab_color = .{ 0, 0, 0, 0 },
    };
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_text_options(handle, &text, &text_options));
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_text(handle, &text, "one two\r\nlast", 13));
    try std.testing.expectEqual(c.OT_OK, ot_scene_move_node(handle, &text, &root, 0));
    try std.testing.expectEqual(c.OT_OK, ot_scene_paint(handle, &id, &.{ 0, 0, 0, 255 }, 0, 0));
    var info = std.mem.zeroes(c.ot_scene_text_info);
    info.struct_size = @sizeOf(c.ot_scene_text_info);
    info.abi_version = c.OT_CONTEXT_ABI_VERSION;
    try std.testing.expectEqual(c.OT_OK, ot_scene_get_text_info(handle, &text, &info));
    try std.testing.expectEqual(@as(u32, 12), info.byte_count);
    try std.testing.expectEqual(@as(u32, 11), info.text_length);
    try std.testing.expectEqual(@as(u32, 2), info.virtual_line_count);
    try std.testing.expectEqual(@as(u32, 7), info.width_cols_max);
    var bytes: [16]u8 = @splat('!');
    var count: u32 = 999;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_get_text(handle, &text, &bytes, 1, &count));
    try std.testing.expectEqual(@as(u32, 999), count);
    try std.testing.expectEqualStrings("!!!!!!!!!!!!!!!!", &bytes);
    try std.testing.expectEqual(c.OT_OK, ot_scene_get_text(handle, &text, null, 0, &count));
    try std.testing.expectEqual(@as(u32, 12), count);
    try std.testing.expectEqual(c.OT_OK, ot_scene_get_text(handle, &text, &bytes, count, &count));
    try std.testing.expectEqualStrings("one two\nlast", bytes[0..count]);
    var lines: [2]c.ot_scene_text_line = @splat(.{ .start_cols = 999, .width_cols = 999, .source_line = 999, .wrap_index = 999 });
    count = 999;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_get_text_lines(handle, &text, &lines, 1, &count));
    try std.testing.expectEqual(@as(u32, 999), count);
    try std.testing.expectEqual(@as(u32, 999), lines[0].start_cols);
    try std.testing.expectEqual(c.OT_OK, ot_scene_get_text_lines(handle, &text, &lines, 2, &count));
    try std.testing.expectEqual(@as(u32, 2), count);
    try std.testing.expectEqual(@as(u32, 4), lines[1].width_cols);
    try std.testing.expectEqual(@as(u32, 1), lines[1].source_line);
    text_options.scroll_x = 0.5;
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_text_options(handle, &text, &text_options));
    for ([_]f64{ -0.5, std.math.inf(f64), std.math.nan(f64), 2147483648 }) |invalid| {
        text_options.scroll_x = invalid;
        try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_text_options(handle, &text, &text_options));
    }
    text_options.scroll_x = 0.5;
    text_options.wrap_mode = 99;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_text_options(handle, &text, &text_options));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_text(handle, &text, null, 1));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_text(handle, &text, "\xff", 1));
    try std.testing.expectEqual(c.OT_WRONG_KIND, ot_scene_set_text(handle, &root, "no", 2));
    const before = info;
    owner.core.mutating = true;
    const status = ot_scene_get_text_info(handle, &text, &info);
    owner.core.mutating = false;
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, status);
    try std.testing.expectEqualDeep(before, info);
    try std.testing.expectEqual(c.OT_OK, ot_scene_get_text_info(handle, &text, &info));
    try std.testing.expectEqualDeep(before, info);
    try std.testing.expectEqual(c.OT_OK, ot_scene_destroy_node(handle, &text));
    try std.testing.expectEqual(c.OT_STALE_HANDLE, ot_scene_get_text_info(handle, &text, &info));
    try std.testing.expectEqualDeep(before, info);
}

test "Context ABI Session write limit matches ordinary atomic admission" {
    const context: ?*ContextHandle = try createTestContext(.{ .object_capacity = 2, .render_cells_max = 1 });
    defer std.testing.expectEqual(c.OT_OK, ot_context_destroy(context)) catch unreachable;
    const cases = [_]@import("session.zig").Options{
        .{ .chunk_size = 4, .chunk_count = 4, .span_capacity = 2 },
        .{ .chunk_size = 4, .chunk_count = 2, .span_capacity = 4 },
        .{ .chunk_size = 4, .chunk_count = 5, .span_capacity = 4, .control_capacity = 5 },
        .{ .chunk_size = 4, .chunk_count = 4, .span_capacity = 5, .control_capacity = 5 },
    };
    for (cases) |config| {
        const id = handleToC(try context.?.core.createSession(config));
        defer std.testing.expectEqual(c.OT_OK, ot_session_destroy(context, &id)) catch unreachable;
        var limit: u64 = 99;
        try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_get_write_limit(null, &id, &limit));
        try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_get_write_limit(context, null, &limit));
        try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_get_write_limit(context, &id, null));
        var invalid = id;
        invalid.context_id += 1;
        try std.testing.expectEqual(c.OT_WRONG_CONTEXT, ot_session_get_write_limit(context, &invalid, &limit));
        invalid = id;
        invalid.generation += 1;
        try std.testing.expectEqual(c.OT_STALE_HANDLE, ot_session_get_write_limit(context, &invalid, &limit));
        try std.testing.expectEqual(99, limit);
        try std.testing.expectEqual(c.OT_OK, ot_session_get_write_limit(context, &id, &limit));
        try std.testing.expectEqual(8, limit);
        try std.testing.expectEqual(c.OT_OUTPUT_BACKPRESSURE, ot_session_write(context, &id, "rejected!", 9));
        try std.testing.expectEqual(c.OT_OK, ot_session_write(context, &id, "accepted", 8));
        try std.testing.expectEqual(c.OT_OUTPUT_BACKPRESSURE, ot_session_write(context, &id, "x", 1));
        var bytes: [4]u8 = undefined;
        for ([_][]const u8{ "acce", "pted" }) |expected| {
            var ticket = std.mem.zeroes(c.ot_output_ticket);
            try std.testing.expectEqual(c.OT_OK, ot_session_read_output(context, &id, &bytes, bytes.len, &ticket));
            try std.testing.expectEqualSlices(u8, expected, &bytes);
            try std.testing.expectEqual(c.OT_OK, ot_session_get_write_limit(context, &id, &limit));
            try std.testing.expectEqual(8, limit);
            try std.testing.expectEqual(c.OT_OK, ot_session_complete_output(context, &id, &ticket, 1));
        }
        try std.testing.expectEqual(c.OT_OK, ot_session_get_write_limit(context, &id, &limit));
        try std.testing.expectEqual(8, limit);
        try std.testing.expectEqual(c.OT_OUTPUT_BACKPRESSURE, ot_session_write(context, &id, "rejected!", 9));
    }
}

test "Context ABI Session leases preserve rejected outputs and map storage limits" {
    const handle: ?*ContextHandle = try createTestContext(.{ .object_capacity = 3, .render_cells_max = 4 });
    const owner = handle.?;
    defer std.testing.expectEqual(c.OT_OK, ot_context_destroy(owner)) catch unreachable;
    const session = try owner.core.createSession(.{ .chunk_size = 64 });
    try owner.core.attachSessionRenderer(session, 1, 1, .{ .remote_mode = .remote });
    const id = handleToC(session);
    var out = std.mem.zeroes(c.ot_buffer_lease_snapshot);
    out.struct_size = @sizeOf(c.ot_buffer_lease_snapshot);
    out.abi_version = c.OT_CONTEXT_ABI_VERSION;
    out.char_ptr = std.math.maxInt(u64);
    const before = out;
    owner.core.mutating = true;
    const busy = ot_session_acquire_buffer_lease(owner, &id, c.OT_SESSION_BUFFER_NEXT, &out);
    owner.core.mutating = false;
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, busy);
    try std.testing.expectEqualDeep(before, out);
    owner.core.lease_count_max = 0;
    try std.testing.expectEqual(c.OT_LEASE_LIMIT, ot_session_acquire_buffer_lease(owner, &id, c.OT_SESSION_BUFFER_NEXT, &out));
    try std.testing.expectEqualDeep(before, out);
    owner.core.lease_count_max = 2;
    owner.core.lease_bytes_max = 0;
    try std.testing.expectEqual(c.OT_LEASE_BYTES_LIMIT, ot_session_acquire_buffer_lease(owner, &id, c.OT_SESSION_BUFFER_NEXT, &out));
    try std.testing.expectEqualDeep(before, out);
    try std.testing.expectEqual(0, owner.core.lease_count);
    try std.testing.expectEqual(1, owner.core.objects.live_count);
    owner.core.lease_bytes_max = @import("buffer.zig").BufferLease.bytes_max_default;
    try std.testing.expectEqual(c.OT_OK, ot_session_acquire_buffer_lease(owner, &id, c.OT_SESSION_BUFFER_NEXT, &out));
    defer std.testing.expectEqual(c.OT_OK, ot_buffer_lease_release(owner, &out.lease)) catch unreachable;
    var count: u32 = 999;
    try std.testing.expectEqual(c.OT_OK, ot_buffer_lease_get_real_char_size(owner, &out.lease, 1, &count));
    try std.testing.expectEqual(@as(u32, 2), count);
    var bytes: [2]u8 = @splat('!');
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_buffer_lease_write_resolved_chars(owner, &out.lease, &bytes, 1, 1, null, 0, &count));
    try std.testing.expectEqual(@as(u32, 2), count);
    var lengths: [1]u8 = @splat(255);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_buffer_lease_write_resolved_chars(owner, &out.lease, &bytes, 2, 1, null, 1, &count));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_buffer_lease_write_resolved_chars(owner, &out.lease, &bytes, 2, 1, &lengths, 0, &count));
    try std.testing.expectEqual(c.OT_OK, ot_buffer_lease_write_resolved_chars(owner, &out.lease, &bytes, 2, 1, &lengths, 1, &count));
    try std.testing.expectEqualSlices(u8, &.{1}, &lengths);
    try std.testing.expectEqualStrings(" \n", &bytes);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_buffer_lease_get_real_char_size(owner, &out.lease, 2, &count));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_buffer_lease_write_resolved_chars(owner, &out.lease, null, 1, 0, null, 0, &count));
    try owner.core.resizeSessionRenderer(session, 2, 1);
    try std.testing.expectEqual(c.OT_STALE_LEASE, ot_buffer_lease_validate(owner, &out.lease));
    try std.testing.expectEqual(c.OT_STALE_LEASE, ot_buffer_lease_get_real_char_size(owner, &out.lease, 0, &count));
    try std.testing.expectEqual(c.OT_STALE_LEASE, ot_buffer_lease_write_resolved_chars(owner, &out.lease, &bytes, 2, 0, &lengths, 1, &count));
    try std.testing.expectEqual(@as(u32, 2), count);
    try std.testing.expectEqual(c.OT_STALE_LEASE, owner.last_error);
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_context_destroy(owner));
}

test "Context ABI creation clears failed Yoga output and retries without retaining backing storage" {
    const yoga = @import("yoga.zig");
    const options: c.ot_context_options = .{
        .struct_size = @sizeOf(c.ot_context_options),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .flags = 0,
        .object_capacity = 1,
        .render_cells_max = 2,
        .reserved = .{ 0, 0, 0 },
    };
    var backing = std.testing.FailingAllocator.init(std.heap.page_allocator, .{});
    var handle: ?*ContextHandle = @ptrFromInt(@alignOf(ContextHandle));
    yoga.testFailAfter(0);
    defer yoga.testFailAfter(-1);
    try std.testing.expectEqual(c.OT_OUT_OF_MEMORY, createContext(&options, &handle, backing.allocator()));
    try std.testing.expect(handle == null);
    try std.testing.expect(backing.allocated_bytes > 0);
    try std.testing.expectEqual(backing.allocated_bytes, backing.freed_bytes);

    yoga.testFailAfter(-1);
    try std.testing.expectEqual(c.OT_OK, createContext(&options, &handle, backing.allocator()));
    try std.testing.expectEqual(c.OT_OK, ot_context_destroy(handle));
    try std.testing.expectEqual(backing.allocated_bytes, backing.freed_bytes);
}

test "Context ABI creation releases backing storage at every allocation failure" {
    const options: c.ot_context_options = .{
        .struct_size = @sizeOf(c.ot_context_options),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .flags = 0,
        .object_capacity = 1,
        .render_cells_max = 2,
        .reserved = .{ 0, 0, 0 },
    };
    // Page backing preserves the DebugAllocator's zero-filled allocation contract.
    var baseline = std.testing.FailingAllocator.init(std.heap.page_allocator, .{});
    var handle: ?*ContextHandle = null;
    try std.testing.expectEqual(c.OT_OK, createContext(&options, &handle, baseline.allocator()));
    try std.testing.expectEqual(c.OT_OK, ot_context_destroy(handle));
    try std.testing.expect(baseline.allocations > 0);
    try std.testing.expectEqual(baseline.allocated_bytes, baseline.freed_bytes);

    for (0..baseline.allocations) |fail_index| {
        var failing = std.testing.FailingAllocator.init(std.heap.page_allocator, .{ .fail_index = fail_index });
        handle = @ptrFromInt(@alignOf(ContextHandle));
        const status = createContext(&options, &handle, failing.allocator());
        defer if (status == c.OT_OK) std.testing.expectEqual(c.OT_OK, ot_context_destroy(handle)) catch unreachable;
        try std.testing.expectEqual(c.OT_OUT_OF_MEMORY, status);
        try std.testing.expect(handle == null);
        try std.testing.expect(failing.has_induced_failure);
        try std.testing.expectEqual(failing.allocated_bytes, failing.freed_bytes);
    }
}

test "Context ABI preserves its allocator and I/O through busy destruction and peer teardown" {
    const options: c.ot_context_options = .{
        .struct_size = @sizeOf(c.ot_context_options),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .flags = 0,
        .object_capacity = 1,
        .render_cells_max = 2,
        .reserved = .{ 0, 0, 0 },
    };
    var backing = std.testing.FailingAllocator.init(std.heap.page_allocator, .{});
    var peer_backing = std.testing.FailingAllocator.init(std.heap.page_allocator, .{});
    var handle: ?*ContextHandle = null;
    var peer: ?*ContextHandle = null;
    try std.testing.expectEqual(c.OT_OK, createContext(&options, &handle, backing.allocator()));
    defer if (handle != null) std.testing.expectEqual(c.OT_OK, ot_context_destroy(handle)) catch unreachable;
    try std.testing.expectEqual(c.OT_OK, createContext(&options, &peer, peer_backing.allocator()));
    defer if (peer != null) std.testing.expectEqual(c.OT_OK, ot_context_destroy(peer)) catch unreachable;
    const peer_link = try peer.?.core.links.alloc("https://peer.invalid");
    try peer.?.core.links.incref(peer_link);
    const owner = handle.?;
    const session = try owner.core.createSession(.{ .chunk_size = 4096 });
    try owner.core.attachSessionRenderer(session, 2, 1, .{ .remote_mode = .remote });
    try std.testing.expectEqual(.pending, try owner.core.renderSession(session, true));
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_context_destroy(owner));
    var details: c.ot_context_error = .{
        .struct_size = @sizeOf(c.ot_context_error),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .status = c.OT_OK,
        .reserved = 0,
    };
    try std.testing.expectEqual(c.OT_OK, ot_context_get_last_error(owner, &details));
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, details.status);
    const before = backing.allocated_bytes;
    const link = try owner.core.links.alloc("https://after-busy.invalid");
    try owner.core.links.incref(link);
    try std.testing.expect(backing.allocated_bytes > before);
    try std.testing.expectEqualStrings("https://after-busy.invalid", try owner.core.links.get(link));
    var bytes: [4096]u8 = undefined;
    while (try owner.core.readOutput(session, &bytes)) |ticket| try owner.core.completeOutput(session, ticket, .written);
    try std.testing.expectEqual(.pending, try owner.core.renderSession(session, true));
    while (try owner.core.readOutput(session, &bytes)) |ticket| try owner.core.completeOutput(session, ticket, .written);
    try std.testing.expectEqual(c.OT_OK, ot_context_destroy(handle));
    handle = null;
    try std.testing.expectEqual(backing.allocated_bytes, backing.freed_bytes);

    try std.testing.expectEqualStrings("https://peer.invalid", try peer.?.core.links.get(peer_link));
    const next = try peer.?.core.links.alloc("https://survivor.invalid");
    try peer.?.core.links.incref(next);
    try std.testing.expectEqualStrings("https://survivor.invalid", try peer.?.core.links.get(next));
    try std.testing.expect(peer_backing.allocated_bytes > peer_backing.freed_bytes);
    try std.testing.expectEqual(c.OT_OK, ot_context_destroy(peer));
    peer = null;
    try std.testing.expectEqual(peer_backing.allocated_bytes, peer_backing.freed_bytes);
}

test "Context ABI diagnostics copy bounded records and preserve failed drains" {
    const first: ?*ContextHandle = try createTestContext(.{ .object_capacity = 1, .render_cells_max = 1 });
    defer std.testing.expectEqual(c.OT_OK, ot_context_destroy(first)) catch unreachable;
    var second: ?*ContextHandle = try createTestContext(.{ .object_capacity = 1, .render_cells_max = 1 });
    defer if (second != null) std.testing.expectEqual(c.OT_OK, ot_context_destroy(second)) catch unreachable;
    const owner = first.?;
    second.?.core.logger.info("peer", .{});
    owner.core.logger.warn("{s}", .{"x" ** (c.OT_DIAGNOSTIC_MESSAGE_BYTES + 1)});
    for (0..64) |index| owner.core.logger.info("{}", .{index});

    var out: c.ot_diagnostic_drain = .{
        .struct_size = @sizeOf(c.ot_diagnostic_drain),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .count = 0,
        .remaining = 0,
        .dropped = 0,
    };
    try std.testing.expectEqual(c.OT_OK, ot_context_drain_diagnostics(first, null, 0, &out));
    try std.testing.expectEqual(64, out.remaining);
    try std.testing.expectEqual(1, out.dropped);
    const before = out;
    var record: c.ot_diagnostic = std.mem.zeroes(c.ot_diagnostic);
    record.reserved = 99;
    owner.core.mutating = true;
    const busy_status = ot_context_drain_diagnostics(first, @ptrCast(&record), 1, &out);
    owner.core.mutating = false;
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, busy_status);
    try std.testing.expectEqualDeep(before, out);
    try std.testing.expectEqual(99, record.reserved);
    try std.testing.expectEqual(c.OT_OK, ot_context_drain_diagnostics(first, @ptrCast(&record), 1, &out));
    try std.testing.expectEqual(1, out.count);
    try std.testing.expectEqual(63, out.remaining);
    try std.testing.expectEqual(1, out.dropped);
    try std.testing.expectEqual(1, record.level);
    try std.testing.expectEqual(c.OT_DIAGNOSTIC_MESSAGE_BYTES, record.message_len);
    try std.testing.expectEqual(c.OT_DIAGNOSTIC_TRUNCATED, record.flags);
    try std.testing.expectEqual(0, record.reserved);
    try std.testing.expectEqualSlices(u8, "x" ** c.OT_DIAGNOSTIC_MESSAGE_BYTES, &record.message);

    try std.testing.expectEqual(c.OT_OK, ot_context_drain_diagnostics(second, @ptrCast(&record), 1, &out));
    try std.testing.expectEqual(c.OT_OK, ot_context_destroy(second));
    second = null;
    try std.testing.expectEqual(0, out.remaining);
    try std.testing.expectEqual(0, out.dropped);
    try std.testing.expectEqualSlices(u8, "peer", record.message[0..record.message_len]);
    try std.testing.expectEqual(0, record.flags);
    for (record.message[record.message_len..]) |byte| try std.testing.expectEqual(0, byte);

    try std.testing.expectEqual(c.OT_OK, ot_context_drain_diagnostics(first, @ptrCast(&record), 1, &out));
    try std.testing.expectEqualSlices(u8, "0", record.message[0..record.message_len]);
    try std.testing.expectEqual(62, out.remaining);

    const batch = try std.testing.allocator.alloc(c.ot_diagnostic, 64);
    defer std.testing.allocator.free(batch);
    batch[62] = std.mem.zeroes(c.ot_diagnostic);
    batch[62].reserved = 99;
    try std.testing.expectEqual(c.OT_OK, ot_context_drain_diagnostics(first, batch.ptr, @intCast(batch.len), &out));
    try std.testing.expectEqual(62, out.count);
    try std.testing.expectEqual(0, out.remaining);
    try std.testing.expectEqualSlices(u8, "1", batch[0].message[0..batch[0].message_len]);
    try std.testing.expectEqualSlices(u8, "62", batch[61].message[0..batch[61].message_len]);
    try std.testing.expectEqual(99, batch[62].reserved);
}

test "Session exit pump ABI validates ownership and preserves rejected outputs" {
    const handle: ?*ContextHandle = try createTestContext(.{ .object_capacity = 2, .render_cells_max = 16 });
    defer std.testing.expectEqual(c.OT_OK, ot_context_destroy(handle)) catch unreachable;
    const owner = handle.?;
    const id = handleToC(try owner.core.createSession(.{}));
    var result: u32 = 99;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_pump_exit(null, &id, &result));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_pump_exit(handle, null, &result));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_pump_exit(handle, &id, null));
    var foreign = id;
    foreign.context_id += 1;
    try std.testing.expectEqual(c.OT_WRONG_CONTEXT, ot_session_pump_exit(handle, &foreign, &result));
    owner.owner_thread += 1;
    const thread_status = ot_session_pump_exit(handle, &id, &result);
    owner.owner_thread -= 1;
    try std.testing.expectEqual(c.OT_WRONG_THREAD, thread_status);
    owner.core.mutating = true;
    const busy_status = ot_session_pump_exit(handle, &id, &result);
    owner.core.mutating = false;
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, busy_status);
    try std.testing.expectEqual(@as(u32, 99), result);
    try std.testing.expectEqual(.open, (try owner.core.getSession(handleFromC(id))).state);
    try std.testing.expectEqual(c.OT_OK, ot_session_pump_exit(handle, &id, &result));
    try std.testing.expectEqual(c.OT_PUMP_CLOSED, result);
    try owner.core.destroy(handleFromC(id));
    result = 99;
    try std.testing.expectEqual(c.OT_STALE_HANDLE, ot_session_pump_exit(handle, &id, &result));
    try std.testing.expectEqual(@as(u32, 99), result);
}

// The library opts into exports; layout-only cross-target checks do not link
// Context or platform backends. The C header is the source of ABI record types.
pub fn export_symbols() void {
    @setEvalBranchQuota(100_000);
    for (@typeInfo(c).@"struct".decls) |declaration| {
        if (!std.mem.startsWith(u8, declaration.name, "ot_")) continue;
        if (@typeInfo(@TypeOf(@field(c, declaration.name))) != .@"fn") continue;
        // The image loader owns the remaining compatibility-to-Context bridge.
        if (std.mem.eql(u8, declaration.name, "ot_image_import_compat")) continue;
        const implementation = find: {
            for (.{ @This(), editor_transport, text_transport, unicode_transport, terminal_transport, output_transport }) |module| {
                if (@hasDecl(module, declaration.name)) break :find &@field(module, declaration.name);
            }
            @compileError("Missing checked ABI implementation: " ++ declaration.name);
        };
        @export(implementation, .{ .name = declaration.name });
    }
}

comptime {
    std.debug.assert(c.OT_IMAGE_FIT == @intFromEnum(@import("image.zig").Fit.fit));
    std.debug.assert(c.OT_IMAGE_COVER == @intFromEnum(@import("image.zig").Fit.cover));
    std.debug.assert(c.OT_IMAGE_FILL == @intFromEnum(@import("image.zig").Fit.fill));
    std.debug.assert(c.OT_IMAGE_PROTOCOL_AUTO == @intFromEnum(@import("image.zig").RenderProtocol.auto));
    std.debug.assert(c.OT_IMAGE_PROTOCOL_KITTY == @intFromEnum(@import("image.zig").RenderProtocol.kitty));
    std.debug.assert(c.OT_IMAGE_PROTOCOL_SIXEL == @intFromEnum(@import("image.zig").RenderProtocol.sixel));
    std.debug.assert(c.OT_IMAGE_PROTOCOL_BLOCKS == @intFromEnum(@import("image.zig").RenderProtocol.blocks));
    std.debug.assert(@offsetOf(c.ot_edit_buffer_options, "struct_size") == 0);
    std.debug.assert(@offsetOf(c.ot_edit_buffer_options, "abi_version") == 4);
    std.debug.assert(@offsetOf(c.ot_edit_buffer_info, "struct_size") == 0);
    std.debug.assert(@offsetOf(c.ot_edit_buffer_info, "abi_version") == 4);
    std.debug.assert(@offsetOf(c.ot_edit_buffer_info, "line_count") == 20);
    std.debug.assert(@offsetOf(c.ot_edit_buffer_info, "cursor_col") == 28);
    std.debug.assert(@offsetOf(c.ot_edit_buffer_info, "cursor_offset") == 32);
    std.debug.assert(@offsetOf(c.ot_edit_buffer_info, "can_undo") == 36);
    std.debug.assert(@offsetOf(c.ot_edit_buffer_info, "can_redo") == 40);
    std.debug.assert(@offsetOf(c.ot_scene_editor_options, "struct_size") == 0);
    std.debug.assert(@offsetOf(c.ot_scene_editor_options, "abi_version") == 4);
    std.debug.assert(@offsetOf(c.ot_scene_editor_options, "style") == 12);
    std.debug.assert(@offsetOf(c.ot_scene_editor_options, "blinking") == 16);
    std.debug.assert(@offsetOf(c.ot_scene_editor_options, "reserved") == 20);
    std.debug.assert(c.OT_EDIT_CURSOR_CHANGED == @intFromEnum(@import("context.zig").EditEvent.cursor_changed));
    std.debug.assert(c.OT_EDIT_CONTENT_CHANGED == @intFromEnum(@import("context.zig").EditEvent.content_changed));
    std.debug.assert(c.OT_EDIT_HISTORY_CURSOR_CHANGED == @intFromEnum(@import("context.zig").EditEvent.history_cursor_changed));
    for (std.meta.fields(c.ot_scene_text_chunk)) |field| {
        std.debug.assert(@offsetOf(c.ot_scene_text_chunk, field.name) == @offsetOf(c.ot_scene_linked_text_chunk, field.name));
    }
    std.debug.assert(@sizeOf(c.ot_scene_text_options) == 72);
    std.debug.assert(@alignOf(c.ot_scene_text_options) == 8);
    std.debug.assert(@offsetOf(c.ot_scene_text_options, "foreground") == 8);
    std.debug.assert(@offsetOf(c.ot_scene_text_options, "background") == 16);
    std.debug.assert(@offsetOf(c.ot_scene_text_options, "attributes") == 24);
    std.debug.assert(@offsetOf(c.ot_scene_text_options, "wrap_mode") == 28);
    std.debug.assert(@offsetOf(c.ot_scene_text_options, "truncate") == 32);
    std.debug.assert(@offsetOf(c.ot_scene_text_options, "first_line_offset") == 36);
    std.debug.assert(@offsetOf(c.ot_scene_text_options, "scroll_x") == 40);
    std.debug.assert(@offsetOf(c.ot_scene_text_options, "scroll_y") == 48);
    std.debug.assert(@offsetOf(c.ot_scene_text_options, "tab_indicator") == 56);
    std.debug.assert(@offsetOf(c.ot_scene_text_options, "tab_color") == 64);
    std.debug.assert(@sizeOf(c.ot_scene_text_info) == 32);
    std.debug.assert(@sizeOf(c.ot_scene_text_line) == @sizeOf(@import("scene.zig").TextLine));
    std.debug.assert(@alignOf(c.ot_scene_text_line) == @alignOf(@import("scene.zig").TextLine));
    for (std.meta.fields(@import("scene.zig").TextLine)) |field| {
        std.debug.assert(@offsetOf(c.ot_scene_text_line, field.name) == @offsetOf(@import("scene.zig").TextLine, field.name));
    }
    std.debug.assert(@alignOf(c.ot_scene_style_value) == 4);
    std.debug.assert(@sizeOf(usize) == 8);
    std.debug.assert(c.OT_BUFFER_TEXT_BYTES_MAX == @import("buffer.zig").text_bytes_max);
    std.debug.assert(@import("link.zig").MAX_URL_LENGTH == 512);
}
