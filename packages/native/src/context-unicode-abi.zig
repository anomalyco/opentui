const std = @import("std");
const c = @import("context_abi_c");
const abi = @import("context-abi.zig");
const fail = @import("context-editor-abi.zig").fail;

pub fn ot_unicode_create(context: ?*abi.ContextHandle, bytes: ?[*]const u8, count: u32, width_method: u32, out: ?*c.ot_handle) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (out == null or width_method > c.OT_WIDTH_METHOD_UNICODE_WIDE or (count != 0 and bytes == null)) return fail(context, error.InvalidOptions);
    out.?.* = abi.handleToC(context.?.core.createUnicode(if (bytes) |p| p[0..count] else &.{}, @enumFromInt(width_method)) catch |err| return fail(context, err));
    return c.OT_OK;
}

pub fn ot_unicode_destroy(context: ?*abi.ContextHandle, id: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const handle = abi.handleFromC((id orelse return fail(context, error.InvalidOptions)).*);
    _ = context.?.core.getUnicode(handle) catch |err| return fail(context, err);
    context.?.core.destroy(handle) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_unicode_get(context: ?*abi.ContextHandle, id: ?*const c.ot_handle, characters: ?[*]c.ot_unicode_char, capacity: u32, out: ?*u32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (id == null or out == null or (capacity != 0 and characters == null)) return fail(context, error.InvalidOptions);
    const value = context.?.core.getUnicode(abi.handleFromC(id.?.*)) catch |err| return fail(context, err);
    if (capacity != 0 and capacity < value.chars.len) return fail(context, error.BufferTooSmall);
    if (capacity != 0) for (value.chars, 0..) |char, index| {
        characters.?[index] = .{ .width = char.width, .character = char.char };
    };
    out.?.* = @intCast(value.chars.len);
    return c.OT_OK;
}

pub fn ot_buffer_draw_unicode(context: ?*abi.ContextHandle, target: ?*const c.ot_handle, frame_ptr: ?*const c.ot_scene_frame_request, id: ?*const c.ot_handle, index: u32, x: i32, y: i32, foreground: ?*const [4]u16, background: ?*const [4]u16, attributes: u32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (target == null or id == null or foreground == null or background == null) return fail(context, error.InvalidOptions);
    const frame = if (frame_ptr) |p| abi.frameRequestFromC(p.*) catch |err| return fail(context, err) else null;
    context.?.core.drawBufferUnicode(abi.handleFromC(target.?.*), frame, abi.handleFromC(id.?.*), index, x, y, foreground.?.*, background.?.*, attributes) catch |err| return fail(context, err);
    return c.OT_OK;
}

test "Context Unicode ABI rejects invalid spans and preserves copied outputs" {
    const context: ?*abi.ContextHandle = try abi.createTestContext(.{ .object_capacity = 16, .render_cells_max = 16 });
    defer std.testing.expectEqual(c.OT_OK, abi.ot_context_destroy(context)) catch unreachable;
    var id = std.mem.zeroes(c.ot_handle);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_unicode_create(context, null, 1, 1, &id));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_unicode_create(context, "x", 1, 4, &id));
    try std.testing.expectEqual(0, id.context_id);
    try std.testing.expectEqual(c.OT_OK, ot_unicode_create(context, "A\xe7\x95\x8c", 4, 1, &id));
    var count: u32 = 99;
    try std.testing.expectEqual(c.OT_OK, ot_unicode_get(context, &id, null, 0, &count));
    try std.testing.expectEqual(2, count);
    var records = [_]c.ot_unicode_char{.{ .width = 99, .character = 99 }} ** 2;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_unicode_get(context, &id, &records, 1, &count));
    try std.testing.expectEqual(2, count);
    try std.testing.expectEqual(99, records[0].width);
    try std.testing.expectEqual(c.OT_OK, ot_unicode_get(context, &id, &records, 2, &count));
    try std.testing.expectEqual(1, records[0].width);
    try std.testing.expectEqual('A', records[0].character);
    try std.testing.expectEqual(2, records[1].width);
    var foreign = id;
    foreign.context_id += 1;
    try std.testing.expectEqual(c.OT_WRONG_CONTEXT, ot_unicode_get(context, &foreign, null, 0, &count));
    context.?.core.mutating = true;
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_unicode_destroy(context, &id));
    context.?.core.mutating = false;
    try std.testing.expectEqual(c.OT_OK, ot_unicode_destroy(context, &id));
    try std.testing.expectEqual(c.OT_STALE_HANDLE, ot_unicode_get(context, &id, null, 0, &count));
}
