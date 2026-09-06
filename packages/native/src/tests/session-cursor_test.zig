const std = @import("std");
const testing = std.testing;
const session = @import("../session.zig");
const ansi = @import("../ansi.zig");
const abi = @import("../context-abi.zig");
const c = @import("context_abi_c");

const Fixture = @import("session-terminal_test.zig").Fixture;
const transport: session.Options = .{ .chunk_size = 4096, .chunk_count = 4, .span_capacity = 4, .control_capacity = 4096 };

test "Session cursor changes retain pending frame bytes and wait for the next frame admission" {
    const f = try Fixture.initWithOptions(testing.allocator, testing.io, 8, 4, transport, .{ .object_capacity = 8 });
    defer f.deinit();
    var bytes: [8192]u8 = undefined;
    try f.owner.controlSession(f.id, .{ .cursor = .{ .position = .{ .x = 2, .y = 3, .visible = true } } });
    try testing.expectEqual(.pending, try f.owner.renderSession(f.id, true));
    const endpoint = f.value.frame_end_offset;
    const ticket = (try f.owner.readOutput(f.id, bytes[0..1])).?;
    const stats = f.value.getStats();
    try f.owner.controlSession(f.id, .{ .cursor = .{
        .position = .{ .x = 7, .y = 4, .visible = true },
        .style = .underline,
        .blinking = true,
        .color = ansi.rgbColor(128, 192, 64, 255),
        .cursor = .crosshair,
    } });
    try testing.expectEqualDeep(stats, f.value.getStats());
    try testing.expectEqualDeep(ticket, f.value.pending.?);
    try testing.expectEqual(endpoint, f.value.frame_end_offset);
    try testing.expectEqual(@as(u32, 7), (try f.owner.sceneGetCursorState(f.id)).x);
    try testing.expectEqual(@as(u64, 0), f.cli.getRenderStats().frameCount);
    try f.owner.completeOutput(f.id, ticket, .written);
    const first = try f.drain(&bytes);
    try testing.expect(std.mem.find(u8, first, "\x1b[3;2H") != null);
    try testing.expect(std.mem.find(u8, first, "\x1b[4;7H") == null);
    try testing.expectEqual(@as(u64, 1), f.cli.getRenderStats().frameCount);
    try testing.expectEqual(.pending, try f.owner.renderSession(f.id, false));
    const second = try f.drain(&bytes);
    try testing.expect(std.mem.find(u8, second, "\x1b[4;7H") != null);
    try testing.expect(std.mem.find(u8, second, ansi.ANSI.cursorUnderlineBlink) != null);
    try testing.expect(std.mem.find(u8, second, "\x1b]12;#80c040\x07") != null);
    try testing.expect(std.mem.find(u8, second, "\x1b]22;crosshair\x07") != null);
    try testing.expectEqual(@as(u64, 2), f.cli.getRenderStats().frameCount);
}

test "Session cursor state accepts output pressure without consuming restoration capacity" {
    const f = try Fixture.initWithOptions(testing.allocator, testing.io, 8, 4, transport, .{ .object_capacity = 8 });
    defer f.deinit();
    var now_ns: u64 = 0;
    var bytes: [4 * 4096]u8 = undefined;
    try f.owner.setupSessionTerminal(f.id, .{});
    _ = try f.driveOutput(&now_ns, .active, &bytes, 32);
    const reservation = f.value.output.control_sequence;
    const blocker = [_]u8{'x'} ** (3 * 4096);
    try f.owner.writeSession(f.id, &blocker);
    const stats = f.value.getStats();
    try f.owner.controlSession(f.id, .{ .cursor = .{ .position = .{ .x = 6, .y = 2, .visible = true } } });
    try testing.expectEqualDeep(stats, f.value.getStats());
    try testing.expectEqualDeep(reservation, f.value.output.control_sequence);
    try testing.expectEqual(.skipped, try f.owner.renderSession(f.id, true));
    try testing.expectEqual(@as(u32, 6), (try f.owner.sceneGetCursorState(f.id)).x);
    try testing.expectEqual(@as(u64, 0), f.cli.getRenderStats().frameCount);
    try testing.expectEqualStrings(&blocker, try f.drain(&bytes));
    try testing.expectEqual(.pending, try f.owner.renderSession(f.id, true));
    try testing.expect(std.mem.find(u8, try f.drain(&bytes), "\x1b[2;6H") != null);
    try testing.expectEqual(@as(u64, 1), f.cli.getRenderStats().frameCount);
    try testing.expectEqualDeep(reservation, f.value.output.control_sequence);
}

test "Session cursor state changes do not emit during terminal transitions and reject closed owners" {
    const f = try Fixture.initWithOptions(testing.allocator, testing.io, 8, 4, transport, .{ .object_capacity = 8 });
    defer f.deinit();
    var now_ns: u64 = 0;
    var bytes: [8192]u8 = undefined;
    try f.owner.setupSessionTerminal(f.id, .{});
    for ([_]session.TerminalPhase{ .setting_up, .active, .suspending, .suspended, .resuming }) |phase| {
        try testing.expectEqual(phase, f.value.getTerminalState().phase);
        const stats = f.value.getStats();
        const reservation = f.value.output.control_sequence;
        try f.owner.controlSession(f.id, .{ .cursor = .{ .style = .line, .blinking = true } });
        try testing.expectEqual(.line, f.cli.terminal.state.cursor.style);
        try testing.expect(f.cli.terminal.state.cursor.blinking);
        try testing.expectEqualDeep(stats, f.value.getStats());
        try testing.expectEqualDeep(reservation, f.value.output.control_sequence);
        switch (phase) {
            .setting_up => _ = try f.driveOutput(&now_ns, .active, &bytes, 32),
            .active => try f.owner.suspendSession(f.id),
            .suspending => _ = try f.driveOutput(&now_ns, .suspended, &bytes, 32),
            .suspended => try f.owner.resumeSession(f.id),
            .resuming => _ = try f.driveOutput(&now_ns, .active, &bytes, 32),
            else => unreachable,
        }
    }
    try f.owner.beginSessionClose(f.id);
    const accepted = f.cli.terminal.state;
    try testing.expectError(error.SessionClosed, f.owner.controlSession(f.id, .{ .cursor = .{ .style = .block } }));
    try testing.expectEqualDeep(accepted, f.cli.terminal.state);
    _ = try f.driveOutput(&now_ns, .restored, &bytes, 32);
    try testing.expectError(error.SessionClosed, f.owner.controlSession(f.id, .{ .cursor = .{} }));
}

test "Session cursor checked ownership and position bounds reject without partial updates" {
    const f = try Fixture.initWithOptions(testing.allocator, testing.io, 8, 4, transport, .{ .object_capacity = 8 });
    defer f.deinit();
    const unattached = try f.owner.createSession(.{});
    try testing.expectError(error.RendererNotAttached, f.owner.controlSession(unattached, .{ .cursor = .{} }));
    var wrong = f.id;
    wrong.context_id += 1;
    try testing.expectError(error.WrongContext, f.owner.controlSession(wrong, .{ .cursor = .{} }));
    wrong = f.id;
    wrong.generation += 1;
    try testing.expectError(error.StaleHandle, f.owner.controlSession(wrong, .{ .cursor = .{} }));
    try f.owner.controlSession(f.id, .{ .cursor = .{ .position = .{ .x = 65536, .y = 65536, .visible = true } } });
    try testing.expectEqual(@as(u16, 65535), f.cli.terminal.state.cursor.row);
    try testing.expectEqual(@as(u16, 65535), f.cli.terminal.state.cursor.col);
    const accepted = f.cli.terminal.state;
    for ([_][2]i32{ .{ 65537, 1 }, .{ 1, 65537 }, .{ std.math.maxInt(i32), 1 } }) |position| {
        try testing.expectError(error.InvalidOptions, f.owner.controlSession(f.id, .{ .cursor = .{
            .position = .{ .x = position[0], .y = position[1], .visible = false },
            .style = .line,
        } }));
        try testing.expectEqualDeep(accepted, f.cli.terminal.state);
    }
    try testing.expectEqual(.pending, try f.owner.renderSession(f.id, true));
    var bytes: [8192]u8 = undefined;
    const ticket = (try f.owner.readOutput(f.id, &bytes)).?;
    try f.owner.completeOutput(f.id, ticket, .failed);
    try testing.expectError(error.SessionFailed, f.owner.controlSession(f.id, .{ .cursor = .{} }));
    try f.owner.cancelSession(f.id);
    try testing.expectError(error.SessionCancelled, f.owner.controlSession(f.id, .{ .cursor = .{} }));
}

test "Session cursor ABI accepts copied unaligned updates and rejects malformed payloads atomically" {
    const config: c.ot_context_options = .{
        .struct_size = @sizeOf(c.ot_context_options),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .flags = 0,
        .object_capacity = 4,
        .render_cells_max = 32,
        .reserved = .{ 0, 0, 0 },
    };
    var handle: ?*abi.ContextHandle = null;
    try testing.expectEqual(c.OT_OK, abi.ot_context_create(&config, &handle));
    defer testing.expectEqual(c.OT_OK, abi.ot_context_destroy(handle)) catch unreachable;
    const owner = handle.?.core;
    const id = try owner.createSession(.{});
    defer owner.cancelSession(id) catch unreachable;
    try owner.attachSessionRenderer(id, 8, 4, .{ .remote_mode = .remote });
    const session_id: c.ot_handle = .{ .context_id = id.context_id, .slot = id.slot, .generation = id.generation };
    const command: c.ot_session_control_options = .{
        .struct_size = @sizeOf(c.ot_session_control_options),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .kind = c.OT_CONTROL_CURSOR,
        .argument = 0,
        .reserved = 0,
    };
    const update: c.ot_session_cursor_update = .{
        .fields = 31,
        .x = 4,
        .y = 2,
        .visible = 1,
        .style = 2,
        .blinking = 1,
        .mouse_pointer = 3,
        .color = .{ 128, 192, 64, 255 },
    };
    var storage: [25]u8 align(4) = undefined;
    const bytes = storage[1..];
    @memcpy(bytes, std.mem.asBytes(&update));
    try testing.expectEqual(c.OT_OK, abi.ot_session_control(handle, &session_id, &command, bytes.ptr, bytes.len));
    const cli = try owner.getSessionRenderer(id);
    const accepted = cli.terminal.state;
    try testing.expectEqual(@as(u32, 4), accepted.cursor.x);
    try testing.expectEqual(@as(u32, 2), accepted.cursor.y);
    try testing.expect(accepted.cursor.visible and accepted.cursor.blinking);
    try testing.expectEqual(.underline, accepted.cursor.style);
    try testing.expectEqual(.crosshair, accepted.mouse_pointer);
    try testing.expectEqualDeep(update.color, accepted.cursor.color);
    const stats = (try owner.getSession(id)).getStats();
    for ([_]u32{ 0, 23, 25 }) |len| {
        try testing.expectEqual(c.OT_INVALID_ARGUMENT, abi.ot_session_control(handle, &session_id, &command, bytes.ptr, len));
    }
    try testing.expectEqual(c.OT_INVALID_ARGUMENT, abi.ot_session_control(handle, &session_id, &command, null, bytes.len));
    for ([_][2]u8{ .{ 0, 32 }, .{ 0, 0 }, .{ 12, 2 }, .{ 13, 4 }, .{ 14, 2 }, .{ 15, 6 } }) |invalid| {
        @memcpy(bytes, std.mem.asBytes(&update));
        bytes[invalid[0]] = invalid[1];
        try testing.expectEqual(c.OT_INVALID_ARGUMENT, abi.ot_session_control(handle, &session_id, &command, bytes.ptr, bytes.len));
        try testing.expectEqualDeep(accepted, cli.terminal.state);
        try testing.expectEqualDeep(stats, (try owner.getSession(id)).getStats());
    }
    @memset(bytes, 0);
    bytes[0] = c.OT_CURSOR_BLINKING;
    try testing.expectEqual(c.OT_OK, abi.ot_session_control(handle, &session_id, &command, bytes.ptr, bytes.len));
    var expected = accepted;
    expected.cursor.blinking = false;
    try testing.expectEqualDeep(expected, cli.terminal.state);
    owner.mutating = true;
    defer owner.mutating = false;
    try testing.expectEqual(c.OT_CONTEXT_BUSY, abi.ot_session_control(handle, &session_id, &command, bytes.ptr, bytes.len));
}
