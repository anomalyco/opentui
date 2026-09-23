const std = @import("std");
const testing = std.testing;
const context = @import("../context.zig");
const session = @import("../session.zig");
const renderer = @import("../renderer.zig");
const ansi = @import("../ansi.zig");

const transport: session.Options = .{ .chunk_size = 64, .chunk_count = 16, .span_capacity = 16 };

fn paint(cli: *renderer.CliRenderer, text: []const u8, hit: u32) !void {
    try cli.getNextBuffer().drawText(text, 0, 0, ansi.rgbColor(255, 255, 255, 255), null, 0);
    cli.addToHitGrid(0, 0, cli.width, cli.height, hit);
}

fn drain(owner: *context.Context, id: context.Handle, out: []u8) ![]const u8 {
    var len: usize = 0;
    while (try owner.readOutput(id, out[len..])) |ticket| {
        len += ticket.len;
        try owner.completeOutput(id, ticket, .written);
    }
    try testing.expect((try owner.raw().getSession(id)).isDrained());
    return out[0..len];
}

test "Session native output publishes a frame only after its endpoint and preserves it on later failure" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createSession(transport);
    defer owner.cancelSession(id) catch unreachable;
    try owner.attachSessionRenderer(id, 4, 2, .{ .forwarded_env = &.{} });
    const cli = try owner.raw().getSessionRenderer(id);
    const value = try owner.raw().getSession(id);
    const Writer = struct {
        failed: bool = false,
        pub fn write(self: *@This(), bytes: []const u8) error{WriteFailed}!usize {
            if (self.failed) return error.WriteFailed;
            return bytes.len;
        }
    };
    var writer: Writer = .{};
    for ([_]u32{ 11, 22 }) |hit| {
        try owner.writeSession(id, "before");
        try paint(cli, "new", hit);
        try testing.expectEqual(.pending, try owner.renderSession(id, true));
        const end = value.frame_end_offset.?;
        try owner.writeSession(id, "after");
        while (value.completed_bytes < end - 1) {
            _ = try owner.drainOutput(id, &writer, @intCast(@min(64, end - 1 - value.completed_bytes)));
            try testing.expectEqual(@as(u32, if (hit == 11) 0 else 11), cli.checkHit(0, 0));
        }
        if (hit == 22) {
            writer.failed = true;
            try testing.expectError(error.SessionFailed, owner.drainOutput(id, &writer, 64));
            try testing.expectEqual(@as(u32, 11), cli.checkHit(0, 0));
            try testing.expectEqual(@as(u64, 1), cli.getRenderStats().frameCount);
            try testing.expect(value.frame_end_offset == null);
        } else {
            try testing.expectEqual(@as(u32, 1), try owner.drainOutput(id, &writer, 1));
            try testing.expectEqual(hit, cli.checkHit(0, 0));
            try testing.expect(value.frame_end_offset == null);
            try testing.expect(!value.isDrained());
            try testing.expectEqual(@as(u32, 5), try owner.drainOutput(id, &writer, 64));
        }
    }
}

test "Session renderer completes its byte endpoint between raw writes" {
    var environment = std.process.Environ.Map.init(testing.allocator);
    defer environment.deinit();
    const owner = try context.Context.init(testing.allocator, testing.io, .{
        .object_capacity = 1,
        .render_cells_max = 8,
    });
    defer owner.deinit() catch unreachable;
    const id = try owner.createSession(transport);
    defer owner.cancelSession(id) catch unreachable;
    const value = try owner.raw().getSession(id);
    var bytes: [1024]u8 = undefined;
    try owner.writeSession(id, "before");
    const prefix = (try owner.readOutput(id, bytes[0..2])).?;
    const raw_stats = value.getStats();
    try owner.attachSessionRenderer(id, 4, 2, .{ .env_map = &environment });
    const cli = try owner.raw().getSessionRenderer(id);
    try testing.expectEqualDeep(raw_stats, value.getStats());
    try testing.expect(!cli.terminalSetup);
    try testing.expect(value.output.callback == null);
    const published = cli.getRenderStats();

    try paint(cli, "new", 22);
    try testing.expectEqual(.pending, try owner.renderSession(id, true));
    const frame_end = value.getStats().bytes_written;
    try testing.expect(frame_end > "before".len);
    try owner.writeSession(id, "after");
    const queued = value.getStats();
    try testing.expectEqual(.pending, try owner.renderSession(id, true));
    try testing.expectEqualDeep(queued, value.getStats());
    try testing.expectError(error.Busy, owner.resizeSessionRenderer(id, 2, 4));
    var invalid = prefix;
    invalid.len += 1;
    try testing.expectError(error.InvalidTicket, owner.completeOutput(id, invalid, .written));
    try testing.expectEqual(@as(u64, 0), value.completed_bytes);
    try owner.completeOutput(id, prefix, .written);
    try testing.expectEqual(@as(u64, 2), value.completed_bytes);
    try testing.expectEqual(queued.outstanding_bytes, value.getStats().outstanding_bytes);

    var len: usize = prefix.len;
    while (value.completed_bytes < frame_end) {
        try testing.expect(len + 7 <= bytes.len);
        const ticket = (try owner.readOutput(id, bytes[len..][0..7])).?;
        len += ticket.len;
        try testing.expectEqual(@as(u32, 0), cli.checkHit(0, 0));
        try testing.expectEqualDeep(published, cli.getRenderStats());
        try owner.completeOutput(id, ticket, .written);
    }
    try testing.expectEqual(frame_end, len);
    try testing.expectEqualStrings("before", bytes[0.."before".len]);
    const frame = bytes["before".len..len];
    try testing.expect(std.mem.startsWith(u8, frame, ansi.ANSI.syncSet));
    try testing.expect(std.mem.find(u8, frame, "new") != null);
    try testing.expect(std.mem.endsWith(u8, frame, ansi.ANSI.syncReset));
    try testing.expectEqual(@as(u32, 22), cli.checkHit(0, 0));
    try testing.expectEqual(@as(u64, 1), cli.getRenderStats().frameCount);
    try testing.expectEqual(@as(u64, "after".len), value.getStats().outstanding_bytes);
    try testing.expect(value.frame_end_offset == null);

    try testing.expectError(error.Busy, owner.resizeSessionRenderer(id, 2, 4));
    try testing.expectError(error.ContextBusy, owner.destroy(id));
    try testing.expectError(error.ContextBusy, owner.deinit());
    try testing.expect(!owner.closing and !owner.mutating);
    try testing.expect(cli == try owner.raw().getSessionRenderer(id));
    try testing.expectEqual(@as(u32, 1), owner.objects.live_count);
    try testing.expectEqualStrings("after", try drain(owner, id, &bytes));
    try testing.expectEqual(value.getStats().bytes_written, value.completed_bytes);
    const drained = value.getStats();
    try owner.resizeSessionRenderer(id, 2, 4);
    try testing.expectEqual(@as(u32, 2), cli.width);
    try testing.expectEqual(@as(u32, 4), cli.height);
    try testing.expectEqualDeep(drained, value.getStats());
}

test "Session renderer no-byte frames wait only for earlier output" {
    var environment = std.process.Environ.Map.init(testing.allocator);
    defer environment.deinit();
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createSession(transport);
    defer owner.cancelSession(id) catch unreachable;
    try owner.attachSessionRenderer(id, 4, 2, .{ .env_map = &environment });
    const cli = try owner.raw().getSessionRenderer(id);
    const value = try owner.raw().getSession(id);
    var bytes: [1024]u8 = undefined;
    try paint(cli, "same", 11);
    try testing.expectEqual(.pending, try owner.renderSession(id, true));
    _ = try drain(owner, id, &bytes);
    const initial_end = value.getStats().bytes_written;

    try paint(cli, "same", 22);
    try testing.expectEqual(.presented, try owner.renderSession(id, false));
    try testing.expectEqual(initial_end, value.getStats().bytes_written);
    try testing.expect(value.isDrained());
    try testing.expectEqual(@as(u32, 22), cli.checkHit(0, 0));
    try testing.expectEqual(@as(u64, 2), cli.getRenderStats().frameCount);
    try testing.expectEqual(@as(u32, 0), cli.getRenderStats().cellsUpdated);

    try owner.writeSession(id, "wait");
    const prefix = (try owner.readOutput(id, bytes[0..1])).?;
    const earlier_end = value.getStats().bytes_written;
    const published = cli.getRenderStats();
    try paint(cli, "same", 33);
    try testing.expectEqual(.pending, try owner.renderSession(id, false));
    try testing.expectEqual(earlier_end, value.getStats().bytes_written);
    try owner.writeSession(id, "tail");
    try owner.completeOutput(id, prefix, .written);
    try testing.expectEqual(initial_end + 1, value.completed_bytes);
    try testing.expectEqual(@as(u64, 8), value.getStats().outstanding_bytes);
    try testing.expectEqualDeep(published, cli.getRenderStats());
    try testing.expectEqual(@as(u32, 22), cli.checkHit(0, 0));
    try testing.expectEqual(.pending, try owner.renderSession(id, false));
    const rest = (try owner.readOutput(id, bytes[0..3])).?;
    try testing.expectEqualStrings("ait", bytes[0..rest.len]);
    try owner.completeOutput(id, rest, .written);
    try testing.expectEqual(earlier_end, value.completed_bytes);
    try testing.expectEqual(@as(u32, 33), cli.checkHit(0, 0));
    try testing.expectEqual(@as(u64, 3), cli.getRenderStats().frameCount);
    try testing.expectEqual(@as(u32, 0), cli.getRenderStats().cellsUpdated);
    try testing.expectEqual(@as(u64, 4), value.getStats().outstanding_bytes);
    try testing.expectEqualStrings("tail", try drain(owner, id, &bytes));
}

test "Session renderer backpressure is bounded and frame rejection needs explicit retry" {
    for ([_]usize{ 512, 448, 64 }) |size| {
        var failing = testing.FailingAllocator.init(testing.allocator, .{});
        var environment = std.process.Environ.Map.init(testing.allocator);
        defer environment.deinit();
        const owner = try context.Context.init(failing.allocator(), testing.io, .{});
        defer owner.deinit() catch unreachable;
        const id = try owner.createSession(.{ .chunk_size = 64, .chunk_count = 8, .span_capacity = 8 });
        defer owner.cancelSession(id) catch unreachable;
        try owner.attachSessionRenderer(id, 4, 2, .{ .env_map = &environment });
        const cli = try owner.raw().getSessionRenderer(id);
        const value = try owner.raw().getSession(id);
        const blocker = [_]u8{'x'} ** 512;
        try owner.writeSession(id, blocker[0..size]);
        const queued = value.getStats();
        const published = cli.getRenderStats();
        try paint(cli, "new", 22);
        if (size == blocker.len) {
            const allocated = failing.allocated_bytes;
            failing.fail_index = failing.alloc_index;
            failing.resize_fail_index = failing.resize_index;
            for (0..64) |_| {
                try testing.expectEqual(.skipped, try owner.renderSession(id, true));
                try testing.expectEqualDeep(queued, value.getStats());
            }
            try testing.expectEqual(allocated, failing.allocated_bytes);
            try testing.expect(!failing.has_induced_failure);
            failing.fail_index = std.math.maxInt(usize);
            failing.resize_fail_index = std.math.maxInt(usize);
        } else {
            if (size == 64) failing.fail_index = failing.alloc_index;
            try testing.expectEqual(.failed, try owner.renderSession(id, true));
            try testing.expectEqualDeep(queued, value.getStats());
            if (size == 64) try testing.expect(failing.has_induced_failure);
            failing.fail_index = std.math.maxInt(usize);
        }
        try testing.expect(value.frame_end_offset == null);
        try testing.expectEqual(.open, value.state);
        try testing.expectEqual(@as(u32, 0), cli.checkHit(0, 0));
        try testing.expectEqualDeep(published, cli.getRenderStats());
        var bytes: [512]u8 = undefined;
        try testing.expectEqualStrings(blocker[0..size], try drain(owner, id, &bytes));
        try testing.expectEqual(queued.bytes_written, value.getStats().bytes_written);
        try testing.expectEqualDeep(published, cli.getRenderStats());

        try paint(cli, "new", 22);
        try testing.expectEqual(.pending, try owner.renderSession(id, false));
        try testing.expect(std.mem.find(u8, try drain(owner, id, &bytes), "new") != null);
        try testing.expectEqual(@as(u32, 22), cli.checkHit(0, 0));
        try testing.expectEqual(@as(u64, 1), cli.getRenderStats().frameCount);
    }
}

test "Session renderer attachment and resize reject invalid dimensions and duplicate owners" {
    var environment = std.process.Environ.Map.init(testing.allocator);
    defer environment.deinit();
    const owner = try context.Context.init(testing.allocator, testing.io, .{
        .object_capacity = 1,
        .render_cells_max = 8,
    });
    defer owner.deinit() catch unreachable;
    const id = try owner.createSession(transport);
    defer owner.cancelSession(id) catch unreachable;
    const value = try owner.raw().getSession(id);
    try testing.expectError(error.RendererNotAttached, owner.raw().getSessionRenderer(id));
    try testing.expectError(error.RendererNotAttached, owner.renderSession(id, true));
    try testing.expectError(error.RendererNotAttached, owner.resizeSessionRenderer(id, 1, 1));
    try owner.writeSession(id, "safe");
    const queued = value.getStats();
    const dimensions = [_][2]u32{ .{ 0, 1 }, .{ 1, 0 }, .{ 9, 1 }, .{ std.math.maxInt(u32), 2 } };
    for (dimensions) |size| {
        try testing.expectError(error.InvalidDimensions, owner.attachSessionRenderer(id, size[0], size[1], .{}));
        try testing.expect(value.renderer == null);
        try testing.expectEqualDeep(queued, value.getStats());
    }
    owner.mutating = true;
    try testing.expectError(error.ContextBusy, owner.attachSessionRenderer(id, 4, 2, .{}));
    try testing.expectError(error.ContextBusy, owner.renderSession(id, true));
    try testing.expectError(error.ContextBusy, owner.resizeSessionRenderer(id, 4, 2));
    owner.mutating = false;
    try owner.attachSessionRenderer(id, 4, 2, .{ .env_map = &environment });
    const cli = try owner.raw().getSessionRenderer(id);
    try testing.expectError(error.RendererAlreadyAttached, owner.attachSessionRenderer(id, 2, 4, .{}));
    try testing.expect(cli == try owner.raw().getSessionRenderer(id));
    try testing.expectEqual(@as(u32, 1), owner.objects.live_count);
    try testing.expectEqualDeep(queued, value.getStats());
    var bytes: [4]u8 = undefined;
    try testing.expectEqualStrings("safe", try drain(owner, id, &bytes));
    for (dimensions) |size| {
        try testing.expectError(error.InvalidDimensions, owner.resizeSessionRenderer(id, size[0], size[1]));
        try testing.expectEqual(@as(u32, 4), cli.width);
        try testing.expectEqual(@as(u32, 2), cli.height);
    }
    try owner.resizeSessionRenderer(id, 1, 8);
    try testing.expectEqual(@as(u32, 1), cli.width);
    try testing.expectEqual(@as(u32, 8), cli.height);
    try testing.expectEqual(queued.bytes_written, value.getStats().bytes_written);
    try owner.beginSessionClose(id);
    try testing.expectError(error.SessionClosed, owner.attachSessionRenderer(id, 4, 2, .{}));
    try testing.expectError(error.SessionClosed, owner.renderSession(id, true));
    try testing.expectError(error.SessionClosed, owner.resizeSessionRenderer(id, 4, 2));
}

fn attachWithAllocationFailures(allocator: std.mem.Allocator) !void {
    const owner = try context.Context.init(allocator, testing.io, .{ .object_capacity = 1 });
    defer owner.deinit() catch unreachable;
    const id = try owner.createSession(transport);
    defer owner.cancelSession(id) catch unreachable;
    const value = try owner.raw().getSession(id);
    try owner.writeSession(id, "safe");
    var bytes: [2]u8 = undefined;
    const ticket = (try owner.readOutput(id, &bytes)).?;
    try testing.expectEqualStrings("sa", &bytes);
    const queued = value.getStats();
    const result = owner.attachSessionRenderer(id, 4, 2, .{ .forwarded_env = &.{
        .{ .key = "OPENTUI_FORCE_WCWIDTH", .value = "1" },
        .{ .key = "COLORTERM", .value = "truecolor" },
    } });
    try testing.expect(value == try owner.raw().getSession(id));
    try testing.expectEqualDeep(queued, value.getStats());
    try testing.expectEqualDeep(ticket, value.pending.?);
    try testing.expectEqual(@as(u64, 0), value.completed_bytes);
    try testing.expectEqual(@as(u32, 0), value.span_offset);
    try testing.expectEqual(@as(u32, 1), owner.objects.live_count);
    try testing.expectEqual(.open, value.state);
    try testing.expect(!owner.mutating);
    if (result) |_| {
        const cli = try owner.raw().getSessionRenderer(id);
        try testing.expect(cli.backend.feed.feed == value.output);
    } else |_| {
        try testing.expectError(error.RendererNotAttached, owner.raw().getSessionRenderer(id));
    }
    try owner.completeOutput(id, ticket, .written);
    try testing.expectEqualStrings("fe", try drain(owner, id, &bytes));
    try result;
}

test "Session renderer attachment allocation failures preserve the Session and copied output" {
    try testing.checkAllAllocationFailures(testing.allocator, attachWithAllocationFailures, .{});
}
