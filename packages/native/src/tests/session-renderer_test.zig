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

const Delivery = enum { ticket, writer };

const OutputTrace = struct {
    bytes: std.ArrayList(u8) = .empty,
    events: std.ArrayList([4]u64) = .empty,

    fn deinit(self: *OutputTrace) void {
        self.bytes.deinit(testing.allocator);
        self.events.deinit(testing.allocator);
    }
};

/// Deliver at most `limit` bytes. A ticket copy and a partial writer call deliver the same prefix.
fn deliverOutput(owner: *context.Context, id: context.Handle, delivery: Delivery, limit: u32, offered: u32, fail: bool, out: *std.ArrayList(u8)) !u32 {
    switch (delivery) {
        .ticket => {
            var copy: [64]u8 = undefined;
            const ticket = (try owner.readOutput(id, copy[0..limit])) orelse return 0;
            if (fail) {
                try owner.completeOutput(id, ticket, .failed);
                return error.SessionFailed;
            }
            try out.appendSlice(testing.allocator, copy[0..ticket.len]);
            try owner.completeOutput(id, ticket, .written);
            return ticket.len;
        },
        .writer => {
            const Writer = struct {
                limit: u32,
                fail: bool,
                out: *std.ArrayList(u8),
                pub fn write(self: @This(), bytes: []const u8) !usize {
                    if (self.fail) return error.WriteFailed;
                    const count = @min(bytes.len, self.limit);
                    try self.out.appendSlice(testing.allocator, bytes[0..count]);
                    return count;
                }
            };
            return owner.drainOutput(id, Writer{ .limit = limit, .fail = fail, .out = out }, offered);
        },
    }
}

const RawWrite = struct { offset: u64, bytes: [24]u8, len: usize };

/// Check, then forget, every raw write whose bytes have been delivered.
fn expectRawWrites(writes: *std.ArrayList(RawWrite), delivered: []const u8) !void {
    var index: usize = 0;
    while (index < writes.items.len) {
        const write = writes.items[index];
        if (write.offset + write.len > delivered.len) {
            index += 1;
            continue;
        }
        try testing.expectEqualSlices(u8, write.bytes[0..write.len], delivered[write.offset..][0..write.len]);
        _ = writes.swapRemove(index);
    }
}

/// Raw writes, frames (including no-byte frames and skips under pressure), and partial
/// deliveries in a seeded order. Checks after every step: completed bytes match the delivered
/// bytes, raw bytes land at their offsets, frames publish hits only at their endpoint, and
/// renderer and Session agree on whether a presentation is pending.
fn runOutputModel(seed: u64, delivery: Delivery, trace: *OutputTrace) !void {
    var prng = std.Random.DefaultPrng.init(seed);
    const random = prng.random();
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createSession(.{ .chunk_size = 16, .chunk_count = 16, .span_capacity = 8 });
    defer owner.cancelSession(id) catch unreachable;
    try owner.attachSessionRenderer(id, 4, 2, .{ .forwarded_env = &.{} });
    const cli = try owner.raw().getSessionRenderer(id);
    const value = try owner.raw().getSession(id);
    var raw_writes: std.ArrayList(RawWrite) = .empty;
    defer raw_writes.deinit(testing.allocator);
    var presented_hit: u32 = 0;
    var pending_hit: u32 = 0;
    var frame_start: u64 = 0;
    for (0..160) |step| {
        const before = value.getStats().bytes_written;
        const pending_before = value.frame_end_offset;
        var status: u64 = 4;
        switch (random.uintLessThan(u8, 5)) {
            0 => {
                var write: RawWrite = .{ .offset = before, .bytes = undefined, .len = random.intRangeAtMost(usize, 1, 24) };
                random.bytes(&write.bytes);
                if (owner.writeSession(id, write.bytes[0..write.len])) |_| {
                    try raw_writes.append(testing.allocator, write);
                } else |err| {
                    try testing.expectEqual(error.NoSpace, err);
                    try testing.expectEqual(before, value.getStats().bytes_written);
                }
            },
            1 => {
                const hit: u32 = @intCast(step + 1);
                // Two texts make repeated content, so unforced frames can encode no bytes.
                // The pending frame owns the next hit grid until its presentation completes.
                const text: []const u8 = if (random.boolean()) "ab" else "cd";
                if (pending_before == null) try paint(cli, text, hit);
                const result = try owner.renderSession(id, random.uintLessThan(u8, 4) == 0);
                status = @intFromEnum(result);
                const after = value.getStats().bytes_written;
                switch (result) {
                    .pending => if (pending_before == null) {
                        pending_hit = hit;
                        frame_start = before;
                        try testing.expectEqual(after, value.frame_end_offset.?);
                        try testing.expect(value.completed_bytes < after);
                    } else try testing.expectEqual(before, after),
                    .presented => {
                        presented_hit = hit;
                        try testing.expectEqual(before, after);
                        try testing.expect(value.isDrained());
                    },
                    .skipped, .failed => try testing.expectEqual(before, after),
                }
            },
            else => {
                const limit = random.intRangeAtMost(u32, 1, 40);
                const offered = limit + random.uintAtMost(u32, 8);
                // A stalled host delivers nothing this turn.
                if (random.uintLessThan(u8, 6) != 0) {
                    _ = try deliverOutput(owner, id, delivery, limit, offered, false, &trace.bytes);
                }
            },
        }
        if (pending_before) |end| if (value.frame_end_offset == null and value.completed_bytes >= end) {
            presented_hit = pending_hit;
            // A no-byte frame waits only for earlier output.
            const frame = trace.bytes.items[frame_start..end];
            if (frame.len != 0) {
                try testing.expect(std.mem.startsWith(u8, frame, ansi.ANSI.syncSet));
                try testing.expect(std.mem.endsWith(u8, frame, ansi.ANSI.syncReset));
            }
        };
        try testing.expectEqual(@as(u64, trace.bytes.items.len), value.completed_bytes);
        try testing.expectEqual(value.frame_end_offset != null, cli.pendingPresentation != null);
        try testing.expectEqual(presented_hit, cli.checkHit(0, 0));
        try expectRawWrites(&raw_writes, trace.bytes.items);
        const stats = value.getStats();
        try trace.events.append(testing.allocator, .{ status, cli.getRenderStats().frameCount, value.completed_bytes, stats.bytes_written });
    }

    if (seed % 2 == 1) {
        // A failed delivery keeps the published frame state, even with a frame pending.
        if (value.frame_end_offset == null) {
            try paint(cli, "ef", 999);
            _ = try owner.renderSession(id, true);
        }
        const frames = cli.getRenderStats().frameCount;
        try testing.expectError(error.SessionFailed, deliverOutput(owner, id, delivery, 1, 1, true, &trace.bytes));
        try testing.expectEqual(.failed, value.state);
        try testing.expect(value.frame_end_offset == null and cli.pendingPresentation == null);
        try testing.expectEqual(presented_hit, cli.checkHit(0, 0));
        try testing.expectEqual(frames, cli.getRenderStats().frameCount);
        try testing.expectError(error.SessionFailed, owner.renderSession(id, true));
        return;
    }
    try owner.beginSessionClose(id);
    while (value.state != .closed) _ = try deliverOutput(owner, id, delivery, 64, 64, false, &trace.bytes);
    try testing.expectEqual(value.getStats().bytes_written, trace.bytes.items.len);
    try expectRawWrites(&raw_writes, trace.bytes.items);
    try testing.expectEqual(@as(usize, 0), raw_writes.items.len);
}

test "Session output interleavings deliver the same bytes and presentations through tickets and writers" {
    for (0..48) |seed| {
        var tickets: OutputTrace = .{};
        defer tickets.deinit();
        var writers: OutputTrace = .{};
        defer writers.deinit();
        errdefer std.debug.print("Session output model failed: seed {d}\n", .{seed});
        try runOutputModel(seed, .ticket, &tickets);
        try runOutputModel(seed, .writer, &writers);
        try testing.expectEqualSlices(u8, tickets.bytes.items, writers.bytes.items);
        try testing.expectEqualSlices([4]u64, tickets.events.items, writers.events.items);
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
    try testing.expectError(error.PresentationPending, owner.resizeSessionRenderer(id, 2, 4));
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

    // Queued raw output does not depend on renderer geometry.
    const raw_queued = value.getStats();
    try owner.resizeSessionRenderer(id, 2, 4);
    try testing.expectEqual(@as(u32, 2), cli.width);
    try testing.expectEqual(@as(u32, 4), cli.height);
    try testing.expectEqualDeep(raw_queued, value.getStats());
    try testing.expectError(error.ContextBusy, owner.destroy(id));
    try testing.expectError(error.ContextBusy, owner.deinit());
    try testing.expect(!owner.closing and !owner.mutating);
    try testing.expect(cli == try owner.raw().getSessionRenderer(id));
    try testing.expectEqual(@as(u32, 1), owner.objects.live_count);
    try testing.expectEqualStrings("after", try drain(owner, id, &bytes));
    try testing.expectEqual(value.getStats().bytes_written, value.completed_bytes);
}

test "Session renderer skips frames under output pressure and fails frames that never fit" {
    const Case = struct { queued: usize, width: u32 = 4, fail_allocation: bool = false, status: session.RenderStatus };
    const cases = [_]Case{
        // A full queue rejects the frame before encoding and allocation.
        .{ .queued = 512, .status = .skipped },
        // The encoded frame exceeds only the free capacity; it fits after the queue drains.
        .{ .queued = 448, .status = .skipped },
        .{ .queued = 64, .fail_allocation = true, .status = .failed },
        // The encoded frame exceeds the empty queue.
        .{ .queued = 0, .width = 256, .status = .failed },
    };
    for (cases) |case| {
        var failing = testing.FailingAllocator.init(testing.allocator, .{});
        const owner = try context.Context.init(failing.allocator(), testing.io, .{});
        defer owner.deinit() catch unreachable;
        const id = try owner.createSession(.{ .chunk_size = 64, .chunk_count = 8, .span_capacity = 8 });
        defer owner.cancelSession(id) catch unreachable;
        try owner.attachSessionRenderer(id, case.width, 2, .{ .forwarded_env = &.{} });
        const cli = try owner.raw().getSessionRenderer(id);
        const value = try owner.raw().getSession(id);
        // Output pressure must leave a ready Kitty file transport enabled.
        cli.kittyTransport.mode = .file;
        cli.kittyTransport.file_state = .ready;
        const blocker = [_]u8{'x'} ** 512;
        if (case.queued != 0) try owner.writeSession(id, blocker[0..case.queued]);
        const queued = value.getStats();
        const published = cli.getRenderStats();
        try paint(cli, "new", 22);
        if (case.width != 4) {
            for (0..2) |y| try cli.getNextBuffer().drawText(&blocker, 0, @intCast(y), ansi.rgbColor(255, 255, 255, 255), null, 0);
        }
        const allocated = failing.allocated_bytes;
        const full = case.queued == blocker.len;
        if (full or case.fail_allocation) failing.fail_index = failing.alloc_index;
        if (full) failing.resize_fail_index = failing.resize_index;
        for (0..if (full) 64 else 1) |_| {
            try testing.expectEqual(case.status, try owner.renderSession(id, true));
            try testing.expectEqualDeep(queued, value.getStats());
        }
        if (full) try testing.expectEqual(allocated, failing.allocated_bytes);
        try testing.expectEqual(case.fail_allocation, failing.has_induced_failure);
        failing.fail_index = std.math.maxInt(usize);
        failing.resize_fail_index = std.math.maxInt(usize);
        const file_state: @TypeOf(cli.kittyTransport.file_state) = if (case.status == .skipped) .ready else .io_error;
        try testing.expectEqual(file_state, cli.kittyTransport.file_state);
        try testing.expect(value.frame_end_offset == null);
        try testing.expectEqual(.open, value.state);
        try testing.expectEqual(@as(u32, 0), cli.checkHit(0, 0));
        try testing.expectEqualDeep(published, cli.getRenderStats());
        var bytes: [512]u8 = undefined;
        try testing.expectEqualStrings(blocker[0..case.queued], try drain(owner, id, &bytes));
        try testing.expectEqual(queued.bytes_written, value.getStats().bytes_written);
        if (case.width != 4) continue;

        // An unforced retry still repaints every cell: no rejected frame reached the terminal.
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
