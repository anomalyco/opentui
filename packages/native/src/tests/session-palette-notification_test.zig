const std = @import("std");
const testing = std.testing;
const session = @import("../session.zig");
const ansi = @import("../ansi.zig");

const transport: session.Options = .{ .chunk_size = 4096, .chunk_count = 4, .span_capacity = 4, .control_capacity = 4096 };
const Fixture = @import("session-terminal_test.zig").Fixture;

test "Session palette queries admit only bounded read-only packets in output order" {
    const f = try Fixture.initWithOptions(testing.allocator, testing.io, 4, 2, transport, .{ .object_capacity = 2 });
    defer f.deinit();
    var now_ns: u64 = 0;
    var bytes: [16 * 1024]u8 = undefined;
    const queries = "\x1b]4;0;?\x07\x1b]4;255;?\x07\x1b]10;?\x07\x1b]19;?\x07";
    try testing.expectError(error.TerminalInactive, f.value.control(.{ .palette_query = queries }));
    try f.owner.setupSessionTerminal(f.id, .{});
    try f.drive(&now_ns, .active);
    const reservation = f.value.output.control_sequence;
    try f.value.write("before");
    try f.value.control(.{ .palette_query = queries });
    try f.value.write("after");
    try testing.expectEqualStrings("before" ++ queries ++ "after", try f.drain(&bytes));
    const wrapped = "\x1bPtmux;\x1b\x1b]4;0;?\x07\x1b\x1b]4;255;?\x07\x1b\\";
    try f.value.control(.{ .palette_query = wrapped });
    try testing.expectEqualStrings(wrapped, try f.drain(&bytes));
    var maximum: [session.control_packet_bytes_max]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&maximum);
    try writer.writeAll(ansi.ANSI.tmuxDcsStart);
    for (0..256) |index| try writer.print("\x1b\x1b]4;{d};?\x07", .{index});
    try writer.writeAll(ansi.ANSI.tmuxDcsEnd);
    try f.value.control(.{ .palette_query = writer.buffered() });
    try testing.expectEqualStrings(writer.buffered(), try f.drain(&bytes));
    const oversized: [session.control_packet_bytes_max + 1]u8 = @splat('x');
    for ([_][]const u8{
        "",                              &oversized,                          "\x1b]4;256;?\x07", "\x1b]4;0;#ffffff\x07",
        "\x1b]10;?\x07\x1b]0;title\x07", "\x1b]18;?\x07",                     "\x1b]10;?",        "\x1bPtmux;\x1b\x1b]4;0;?\x07",
        "\x1bPtmux;\x1b\\",              "\x1bPtmux;\x1b\x1b]10;?\x07\x1b\\",
    }) |invalid| {
        const before = f.value.getStats();
        try testing.expectError(error.InvalidOptions, f.value.control(.{ .palette_query = invalid }));
        try testing.expectEqualDeep(before, f.value.getStats());
    }
    try testing.expectEqualDeep(reservation, f.value.output.control_sequence);
}

test "Session notification and palette rejection retain restoration reserves and accepted state" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const f = try Fixture.initWithOptions(failing.allocator(), testing.io, 4, 2, transport, .{ .object_capacity = 2 });
    defer f.deinit();
    var now_ns: u64 = 0;
    var bytes: [16 * 1024]u8 = undefined;
    try f.owner.setupSessionTerminal(f.id, .{});
    try f.drive(&now_ns, .active);
    try f.value.control(.{ .capability_response = "\x1bP>|kitty 0.41.0\x1b\\" });
    _ = try f.drain(&bytes);
    const before = f.value.renderer.?.terminal;
    const reservation = f.value.output.control_sequence;
    const oversized: [session.control_packet_bytes_max + 1]u8 = @splat('x');
    try testing.expect(!try f.value.triggerNotification(&oversized, null));
    const too_large_encoded: [session.control_packet_bytes_max]u8 = @splat('x');
    try testing.expect(!try f.value.triggerNotification(&too_large_encoded, null));
    failing.fail_index = failing.alloc_index;
    try testing.expect(!try f.value.triggerNotification("allocation failure", null));
    failing.fail_index = std.math.maxInt(usize);
    const blocker: [3 * 4096]u8 = @splat('x');
    try f.value.write(&blocker);
    const ticket = (try f.owner.readOutput(f.id, bytes[0..1])).?;
    const stats = f.value.getStats();
    try testing.expect(!try f.value.triggerNotification("pressure", null));
    try testing.expectError(error.NoSpace, f.value.control(.{ .palette_query = "\x1b]4;0;?\x07" }));
    try testing.expectEqualDeep(before, f.value.renderer.?.terminal);
    try testing.expectEqualDeep(stats, f.value.getStats());
    try testing.expectEqualDeep(ticket, f.value.pending.?);
    try testing.expectEqualDeep(reservation, f.value.output.control_sequence);
    try f.owner.completeOutput(f.id, ticket, .written);
    try testing.expectEqualStrings(blocker[1..], try f.drain(&bytes));
    try f.value.suspendTerminal();
    try testing.expectError(error.TerminalInactive, f.value.triggerNotification("suspending", null));
    try f.drive(&now_ns, .suspended);
    try testing.expectError(error.TerminalInactive, f.value.control(.{ .palette_query = "\x1b]4;0;?\x07" }));
    try f.value.resumeTerminal();
    try f.drive(&now_ns, .active);
    try testing.expect(try f.value.triggerNotification("accepted", null));
    _ = try f.drain(&bytes);
    try testing.expectEqual(@as(u32, 1), f.value.renderer.?.terminal.notification_id_counter);
    try f.owner.beginSessionClose(f.id);
    try testing.expectError(error.SessionClosed, f.value.triggerNotification("closed", null));
    const restored = try f.driveOutput(&now_ns, .restored, &bytes, 64);
    try testing.expect(std.mem.find(u8, restored, ansi.ANSI.showCursor) != null);
}
