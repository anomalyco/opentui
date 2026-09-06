const std = @import("std");
const testing = std.testing;
const context = @import("../context.zig");
const session = @import("../session.zig");
const ansi = @import("../ansi.zig");

const Fixture = struct {
    owner: *context.Context,
    value: *session.Session,
    now_ns: u64 = 0,
    bytes: [16 * 1024]u8 = undefined,

    fn init(allocator: std.mem.Allocator) !Fixture {
        const owner = try context.Context.init(allocator, testing.io, .{ .object_capacity = 2 });
        errdefer owner.deinit() catch unreachable;
        const id = try owner.createSession(.{ .chunk_size = 4096, .chunk_count = 4, .span_capacity = 4, .control_capacity = 4096 });
        try owner.attachSessionRenderer(id, 4, 2, .{ .remote_mode = .remote });
        return .{ .owner = owner, .value = try owner.getSession(id) };
    }

    fn deinit(self: *Fixture) void {
        self.owner.cancelSession(self.value.handle) catch unreachable;
        self.owner.deinit() catch unreachable;
    }

    fn drain(self: *Fixture) ![]const u8 {
        var len: usize = 0;
        for (0..64) |_| {
            const result = try self.value.pump(self.now_ns, 1);
            switch (result.status) {
                .output_pending => {
                    const ticket = (try self.owner.readOutput(self.value.handle, self.bytes[len..])).?;
                    len += ticket.len;
                    try self.owner.completeOutput(self.value.handle, ticket, .written);
                },
                .wait_until => self.now_ns = result.deadline_ns.?,
                .again => {},
                .idle, .closed => return self.bytes[0..len],
            }
        }
        return error.TestUnexpectedResult;
    }

    fn activate(self: *Fixture) !void {
        try self.value.setupTerminal(.{});
        _ = try self.drain();
        try testing.expectEqual(.active, self.value.lifecycle.phase);
    }
};

test "Session palette queries admit only bounded read-only packets in output order" {
    var f = try Fixture.init(testing.allocator);
    defer f.deinit();
    const queries = "\x1b]4;0;?\x07\x1b]4;255;?\x07\x1b]10;?\x07\x1b]19;?\x07";
    try testing.expectError(error.TerminalInactive, f.value.control(.{ .palette_query = queries }));
    try f.activate();
    const reservation = f.value.output.control_sequence;
    try f.value.write("before");
    try f.value.control(.{ .palette_query = queries });
    try f.value.write("after");
    try testing.expectEqualStrings("before" ++ queries ++ "after", try f.drain());
    const wrapped = "\x1bPtmux;\x1b\x1b]4;0;?\x07\x1b\x1b]4;255;?\x07\x1b\\";
    try f.value.control(.{ .palette_query = wrapped });
    try testing.expectEqualStrings(wrapped, try f.drain());
    var maximum: [session.control_packet_bytes_max]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&maximum);
    try writer.writeAll(ansi.ANSI.tmuxDcsStart);
    for (0..256) |index| try writer.print("\x1b\x1b]4;{d};?\x07", .{index});
    try writer.writeAll(ansi.ANSI.tmuxDcsEnd);
    try f.value.control(.{ .palette_query = writer.buffered() });
    try testing.expectEqualStrings(writer.buffered(), try f.drain());
    const oversized = [_]u8{'x'} ** (session.control_packet_bytes_max + 1);
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
    var f = try Fixture.init(failing.allocator());
    defer f.deinit();
    try f.activate();
    try f.value.control(.{ .capability_response = "\x1bP>|kitty 0.41.0\x1b\\" });
    _ = try f.drain();
    const before = f.value.renderer.?.terminal;
    const reservation = f.value.output.control_sequence;
    const oversized = [_]u8{'x'} ** (session.control_packet_bytes_max + 1);
    try testing.expect(!try f.value.triggerNotification(&oversized, null));
    const too_large_encoded = [_]u8{'x'} ** session.control_packet_bytes_max;
    try testing.expect(!try f.value.triggerNotification(&too_large_encoded, null));
    failing.fail_index = failing.alloc_index;
    try testing.expect(!try f.value.triggerNotification("allocation failure", null));
    failing.fail_index = std.math.maxInt(usize);
    const blocker = [_]u8{'x'} ** (3 * 4096);
    try f.value.write(&blocker);
    const ticket = (try f.owner.readOutput(f.value.handle, f.bytes[0..1])).?;
    const stats = f.value.getStats();
    try testing.expect(!try f.value.triggerNotification("pressure", null));
    try testing.expectError(error.NoSpace, f.value.control(.{ .palette_query = "\x1b]4;0;?\x07" }));
    try testing.expectEqualDeep(before, f.value.renderer.?.terminal);
    try testing.expectEqualDeep(stats, f.value.getStats());
    try testing.expectEqualDeep(ticket, f.value.pending.?);
    try testing.expectEqualDeep(reservation, f.value.output.control_sequence);
    try f.owner.completeOutput(f.value.handle, ticket, .written);
    try testing.expectEqualStrings(blocker[1..], try f.drain());
    try f.value.suspendTerminal();
    try testing.expectError(error.TerminalInactive, f.value.triggerNotification("suspending", null));
    _ = try f.drain();
    try testing.expectError(error.TerminalInactive, f.value.control(.{ .palette_query = "\x1b]4;0;?\x07" }));
    try f.value.resumeTerminal();
    _ = try f.drain();
    try testing.expect(try f.value.triggerNotification("accepted", null));
    _ = try f.drain();
    try testing.expectEqual(@as(u32, 1), f.value.renderer.?.terminal.notification_id_counter);
    try f.owner.beginSessionClose(f.value.handle);
    try testing.expectError(error.SessionClosed, f.value.triggerNotification("closed", null));
    const restored = try f.drain();
    try testing.expect(std.mem.find(u8, restored, ansi.ANSI.showCursor) != null);
}
