const std = @import("std");
const c = @import("context_abi_c");
const abi = @import("context-abi.zig");
const transport = @import("context-editor-abi.zig");
const fail = transport.fail;

pub fn ot_embedded_terminal_create(context: ?*abi.ContextHandle, options: ?*const c.ot_embedded_terminal_options, out: ?*c.ot_handle) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const value = transport.record(c.ot_embedded_terminal_options, options) catch |err| return fail(context, err);
    if (out == null or value.reserved != 0) return fail(context, error.InvalidOptions);
    out.?.* = abi.handleToC(context.?.core.createEmbeddedTerminal(value.cols, value.rows, value.max_scrollback) catch |err| return fail(context, err));
    return c.OT_OK;
}

pub fn ot_embedded_terminal_destroy(context: ?*abi.ContextHandle, id: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const handle = abi.handleFromC((id orelse return fail(context, error.InvalidOptions)).*);
    _ = context.?.core.getEmbeddedTerminal(handle) catch |err| return fail(context, err);
    context.?.core.destroy(handle) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_embedded_terminal_write(context: ?*abi.ContextHandle, id: ?*const c.ot_handle, bytes: ?[*]const u8, count: u32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (id == null or (count != 0 and bytes == null)) return fail(context, error.InvalidOptions);
    context.?.core.embeddedTerminalWrite(abi.handleFromC(id.?.*), if (bytes) |p| p[0..count] else &.{}) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_embedded_terminal_resize(context: ?*abi.ContextHandle, id: ?*const c.ot_handle, cols: u32, rows: u32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (id == null) return fail(context, error.InvalidOptions);
    context.?.core.embeddedTerminalResize(abi.handleFromC(id.?.*), cols, rows) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_embedded_terminal_command(context: ?*abi.ContextHandle, id: ?*const c.ot_handle, command: u32, argument: i32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (id == null) return fail(context, error.InvalidOptions);
    context.?.core.embeddedTerminalCommand(abi.handleFromC(id.?.*), command, argument) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_embedded_terminal_set_selection(context: ?*abi.ContextHandle, id: ?*const c.ot_handle, start_x: u32, start_y: u32, end_x: u32, end_y: u32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (id == null) return fail(context, error.InvalidOptions);
    context.?.core.embeddedTerminalSetSelection(abi.handleFromC(id.?.*), start_x, start_y, end_x, end_y) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_embedded_terminal_get_selected_text(context: ?*abi.ContextHandle, id: ?*const c.ot_handle, bytes: ?[*]u8, capacity: u32, out: ?*u32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (id == null or out == null or (capacity != 0 and bytes == null)) return fail(context, error.InvalidOptions);
    out.?.* = context.?.core.embeddedTerminalGetSelectedText(abi.handleFromC(id.?.*), if (bytes) |p| p[0..capacity] else &.{}) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_embedded_terminal_compose(context: ?*abi.ContextHandle, id: ?*const c.ot_handle, target: ?*const c.ot_handle, frame_ptr: ?*const c.ot_scene_frame_request, x: i32, y: i32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (id == null or target == null) return fail(context, error.InvalidOptions);
    const frame = if (frame_ptr) |p| abi.frameRequestFromC(p.*) catch |err| return fail(context, err) else null;
    context.?.core.embeddedTerminalCompose(abi.handleFromC(id.?.*), abi.handleFromC(target.?.*), frame, x, y) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_embedded_terminal_cursor_get(context: ?*abi.ContextHandle, id: ?*const c.ot_handle, out: ?*c.ot_embedded_terminal_cursor) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const record = transport.record(c.ot_embedded_terminal_cursor, out) catch |err| return fail(context, err);
    if (id == null or record.reserved != 0) return fail(context, error.InvalidOptions);
    const cursor = context.?.core.embeddedTerminalCursor(abi.handleFromC(id.?.*)) catch |err| return fail(context, err);
    out.?.* = .{
        .struct_size = @sizeOf(c.ot_embedded_terminal_cursor),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .x = cursor.x,
        .y = cursor.y,
        .has_value = @intFromBool(cursor.has_value),
        .visible = @intFromBool(cursor.visible),
        .blinking = @intFromBool(cursor.blinking),
        .wide_tail = @intFromBool(cursor.wide_tail),
        .style = cursor.style,
        .color_has_value = @intFromBool(cursor.color != null),
        .color_r = if (cursor.color) |color| color.r else 0,
        .color_g = if (cursor.color) |color| color.g else 0,
        .color_b = if (cursor.color) |color| color.b else 0,
        .reserved = 0,
    };
    return c.OT_OK;
}

pub fn ot_embedded_terminal_encode_key(context: ?*abi.ContextHandle, id: ?*const c.ot_handle, options: ?*const c.ot_embedded_terminal_key, key: ?[*]const u8, key_count: u32, text: ?[*]const u8, text_count: u32, bytes: ?[*]u8, capacity: u32, out: ?*u32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const value = transport.record(c.ot_embedded_terminal_key, options) catch |err| return fail(context, err);
    if (id == null or out == null or value.reserved != 0 or value.composing > 1 or
        (key_count != 0 and key == null) or (text_count != 0 and text == null) or
        (capacity != 0 and bytes == null)) return fail(context, error.InvalidOptions);
    out.?.* = context.?.core.embeddedTerminalEncodeKey(abi.handleFromC(id.?.*), .{
        .action = value.action,
        .composing = value.composing == 1,
        .mods = value.mods,
        .consumed_mods = value.consumed_mods,
        .unshifted_codepoint = value.unshifted_codepoint,
        .key = if (key) |p| p[0..key_count] else &.{},
        .text = if (text) |p| p[0..text_count] else &.{},
    }, if (bytes) |p| p[0..capacity] else &.{}) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_embedded_terminal_encode_mouse(context: ?*abi.ContextHandle, id: ?*const c.ot_handle, options: ?*const c.ot_embedded_terminal_mouse, bytes: ?[*]u8, capacity: u32, out: ?*u32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const value = transport.record(c.ot_embedded_terminal_mouse, options) catch |err| return fail(context, err);
    if (id == null or out == null or value.any_button_pressed > 1 or (capacity != 0 and bytes == null)) return fail(context, error.InvalidOptions);
    out.?.* = context.?.core.embeddedTerminalEncodeMouse(abi.handleFromC(id.?.*), .{
        .action = value.action,
        .button = value.button,
        .mods = value.mods,
        .any_button_pressed = value.any_button_pressed == 1,
        .x = value.x,
        .y = value.y,
    }, if (bytes) |p| p[0..capacity] else &.{}) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_embedded_terminal_encode_paste(context: ?*abi.ContextHandle, id: ?*const c.ot_handle, input: ?[*]const u8, input_count: u32, bytes: ?[*]u8, capacity: u32, out: ?*u32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (id == null or out == null or (input_count != 0 and input == null) or (capacity != 0 and bytes == null)) return fail(context, error.InvalidOptions);
    out.?.* = context.?.core.embeddedTerminalEncodePaste(abi.handleFromC(id.?.*), if (input) |p| p[0..input_count] else &.{}, if (bytes) |p| p[0..capacity] else &.{}) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_embedded_terminal_encode_focus(context: ?*abi.ContextHandle, id: ?*const c.ot_handle, focused: u32, bytes: ?[*]u8, capacity: u32, out: ?*u32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (id == null or out == null or focused > 1 or (capacity != 0 and bytes == null)) return fail(context, error.InvalidOptions);
    out.?.* = context.?.core.embeddedTerminalEncodeFocus(abi.handleFromC(id.?.*), focused == 1, if (bytes) |p| p[0..capacity] else &.{}) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_embedded_terminal_drain_responses(context: ?*abi.ContextHandle, id: ?*const c.ot_handle, bytes: ?[*]u8, capacity: u32, out: ?*u32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (id == null or out == null or (capacity != 0 and bytes == null)) return fail(context, error.InvalidOptions);
    out.?.* = context.?.core.embeddedTerminalDrainResponses(abi.handleFromC(id.?.*), if (bytes) |p| p[0..capacity] else &.{}) catch |err| return fail(context, err);
    return c.OT_OK;
}

test "Context terminal ABI rejects malformed records and wrong-thread access" {
    const context: ?*abi.ContextHandle = try abi.createTestContext(.{ .object_capacity = 16, .render_cells_max = 16 });
    defer std.testing.expectEqual(c.OT_OK, abi.ot_context_destroy(context)) catch unreachable;
    var id = std.mem.zeroes(c.ot_handle);
    var terminal_options = std.mem.zeroes(c.ot_embedded_terminal_options);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_embedded_terminal_create(context, &terminal_options, &id));
    terminal_options.struct_size = @sizeOf(c.ot_embedded_terminal_options);
    terminal_options.abi_version = c.OT_CONTEXT_ABI_VERSION + 1;
    try std.testing.expectEqual(c.OT_UNSUPPORTED_VERSION, ot_embedded_terminal_create(context, &terminal_options, &id));
    terminal_options.abi_version = c.OT_CONTEXT_ABI_VERSION;
    terminal_options.cols = 2;
    terminal_options.rows = 1;
    terminal_options.reserved = 1;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_embedded_terminal_create(context, &terminal_options, &id));
    try std.testing.expectEqual(0, id.context_id);
    const thread = try std.Thread.spawn(.{}, struct {
        fn run(owner: *abi.ContextHandle) void {
            std.testing.expectEqual(c.OT_WRONG_THREAD, ot_embedded_terminal_create(owner, null, null)) catch unreachable;
            std.testing.expectEqual(c.OT_WRONG_THREAD, ot_embedded_terminal_destroy(owner, null)) catch unreachable;
            std.testing.expectEqual(c.OT_WRONG_THREAD, ot_embedded_terminal_write(owner, null, null, 0)) catch unreachable;
        }
    }.run, .{context.?});
    thread.join();
}

test "Context terminal ABI copies controller output and rejects stale handles" {
    if (!@import("ghostty_vt_options").available) return error.SkipZigTest;
    const context: ?*abi.ContextHandle = try abi.createTestContext(.{ .object_capacity = 16, .render_cells_max = 16 });
    defer std.testing.expectEqual(c.OT_OK, abi.ot_context_destroy(context)) catch unreachable;
    const config: c.ot_embedded_terminal_options = .{ .struct_size = 24, .abi_version = 1, .cols = 4, .rows = 2, .max_scrollback = 0, .reserved = 0 };
    var id = std.mem.zeroes(c.ot_handle);
    try std.testing.expectEqual(c.OT_OK, ot_embedded_terminal_create(context, &config, &id));
    const target = abi.handleToC(try context.?.core.createBuffer(4, 2, .{}));
    try std.testing.expectEqual(c.OT_WRONG_KIND, ot_embedded_terminal_destroy(context, &target));
    var foreign = id;
    foreign.context_id += 1;
    try std.testing.expectEqual(c.OT_WRONG_CONTEXT, ot_embedded_terminal_write(context, &foreign, "x", 1));
    const input = "abc\x1b[?1004h\x1b[?2004h\x1b[?1003h\x1b[?1006h";
    try std.testing.expectEqual(c.OT_OK, ot_embedded_terminal_write(context, &id, input, input.len));
    try std.testing.expectEqual(c.OT_OK, ot_embedded_terminal_set_selection(context, &id, 0, 0, 1, 0));
    var bytes = [_]u8{0xaa} ** 128;
    var count: u32 = 99;
    try std.testing.expectEqual(c.OT_OK, ot_embedded_terminal_get_selected_text(context, &id, null, 0, &count));
    try std.testing.expectEqual(2, count);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_embedded_terminal_get_selected_text(context, &id, &bytes, 1, &count));
    try std.testing.expectEqual(0xaa, bytes[0]);
    try std.testing.expectEqual(2, count);
    try std.testing.expectEqual(c.OT_OK, ot_embedded_terminal_get_selected_text(context, &id, &bytes, bytes.len, &count));
    try std.testing.expectEqualStrings("ab", bytes[0..count]);
    try std.testing.expectEqual(c.OT_OK, ot_embedded_terminal_compose(context, &id, &target, null, 0, 0));
    var cursor = std.mem.zeroes(c.ot_embedded_terminal_cursor);
    cursor.struct_size = 56;
    cursor.abi_version = 1;
    try std.testing.expectEqual(c.OT_OK, ot_embedded_terminal_cursor_get(context, &id, &cursor));
    try std.testing.expectEqual(3, cursor.x);
    try std.testing.expectEqual(1, cursor.has_value);
    try std.testing.expectEqual(c.OT_OK, ot_embedded_terminal_encode_focus(context, &id, 1, &bytes, bytes.len, &count));
    try std.testing.expectEqualStrings("\x1b[I", bytes[0..count]);
    var key = std.mem.zeroes(c.ot_embedded_terminal_key);
    key.struct_size = 32;
    key.abi_version = 1;
    key.action = 1;
    try std.testing.expectEqual(c.OT_OK, ot_embedded_terminal_encode_key(context, &id, &key, "Enter", 5, null, 0, &bytes, bytes.len, &count));
    try std.testing.expectEqualStrings("\r", bytes[0..count]);
    key.composing = 2;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_embedded_terminal_encode_key(context, &id, &key, "Enter", 5, null, 0, &bytes, bytes.len, &count));
    try std.testing.expectEqual(1, count);
    try std.testing.expectEqual(c.OT_OK, ot_embedded_terminal_write(context, &id, "\x1b[5n", 4));
    try std.testing.expectEqual(c.OT_OK, ot_embedded_terminal_drain_responses(context, &id, &bytes, bytes.len, &count));
    try std.testing.expectEqualStrings("\x1b[0n", bytes[0..count]);
    try std.testing.expectEqual(c.OT_OK, ot_embedded_terminal_encode_paste(context, &id, "xy", 2, &bytes, bytes.len, &count));
    try std.testing.expectEqualStrings("\x1b[200~xy\x1b[201~", bytes[0..count]);
    var mouse: c.ot_embedded_terminal_mouse = .{ .struct_size = 32, .abi_version = 1, .action = 2, .button = -1, .mods = 0, .any_button_pressed = 0, .x = 1, .y = 0 };
    try std.testing.expectEqual(c.OT_OK, ot_embedded_terminal_encode_mouse(context, &id, &mouse, null, 0, &count));
    const required = count;
    try std.testing.expect(required > 1);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_embedded_terminal_encode_mouse(context, &id, &mouse, &bytes, 1, &count));
    try std.testing.expectEqual(required, count);
    try std.testing.expectEqual(c.OT_OK, ot_embedded_terminal_encode_mouse(context, &id, &mouse, &bytes, bytes.len, &count));
    try std.testing.expectEqual(required, count);
    mouse.any_button_pressed = 2;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_embedded_terminal_encode_mouse(context, &id, &mouse, &bytes, bytes.len, &count));
    try std.testing.expectEqual(c.OT_OK, ot_embedded_terminal_command(context, &id, c.OT_EMBEDDED_TERMINAL_CLEAR_SELECTION, 0));
    try std.testing.expectEqual(c.OT_OK, ot_embedded_terminal_command(context, &id, c.OT_EMBEDDED_TERMINAL_INVALIDATE, 0));
    try std.testing.expectEqual(c.OT_OK, ot_embedded_terminal_command(context, &id, c.OT_EMBEDDED_TERMINAL_SCROLL, 1));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_embedded_terminal_command(context, &id, c.OT_EMBEDDED_TERMINAL_INVALIDATE, 1));
    try std.testing.expectEqual(c.OT_OK, ot_embedded_terminal_resize(context, &id, 2, 2));
    try std.testing.expectEqual(c.OT_OK, ot_embedded_terminal_destroy(context, &id));
    try std.testing.expectEqual(c.OT_STALE_HANDLE, ot_embedded_terminal_write(context, &id, null, 0));
}
