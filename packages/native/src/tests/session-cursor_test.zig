const std = @import("std");
const testing = std.testing;
const session = @import("../session.zig");
const ansi = @import("../ansi.zig");

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
