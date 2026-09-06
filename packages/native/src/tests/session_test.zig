const std = @import("std");
const testing = std.testing;
const context = @import("../context.zig");
const session = @import("../session.zig");

const small: session.Options = .{ .chunk_size = 4, .chunk_count = 3, .span_capacity = 3 };

test "Session output copies input and advances only completed prefixes in byte order" {
    const owner = try context.Context.init(testing.allocator, std.Io.failing, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createSession(small);
    defer owner.cancelSession(id) catch unreachable;
    const value = try owner.getSession(id);
    var input = "abcdef".*;
    try owner.writeSession(id, &input);
    try owner.writeSession(id, "Z");
    @memset(&input, '!');
    const queued = value.getStats();
    try testing.expectEqual(@as(u64, 7), queued.outstanding_bytes);
    try testing.expect((try owner.readOutput(id, &.{})) == null);
    try testing.expectEqualDeep(queued, value.getStats());
    try testing.expectEqual(@as(u64, 0), value.last_request_id);

    var out = [_]u8{'?'} ** 8;
    const first = (try owner.readOutput(id, out[0..2])).?;
    try testing.expectEqualDeep(id, first.session);
    try testing.expectEqual(@as(u32, 2), first.len);
    try testing.expectEqualStrings("ab??????", &out);
    try owner.completeOutput(id, first, .written);
    try testing.expectEqual(@as(u64, 7), value.getStats().outstanding_bytes);
    try testing.expectError(error.NoSpace, owner.writeSession(id, "x"));
    @memset(&out, '?');
    const next = (try owner.readOutput(id, &out)).?;
    try testing.expectEqual(first.request_id + 1, next.request_id);
    try testing.expectEqual(@as(u32, 2), next.len);
    try testing.expectEqualStrings("cd??????", &out);
    try owner.completeOutput(id, next, .written);
    try testing.expectEqual(@as(u64, 3), value.getStats().outstanding_bytes);
    try owner.writeSession(id, "xy");
    for ([_][]const u8{ "ef", "Z", "xy" }) |expected| {
        @memset(&out, '?');
        const ticket = (try owner.readOutput(id, &out)).?;
        try testing.expectEqualStrings(expected, out[0..ticket.len]);
        try testing.expectEqual(@as(u8, '?'), out[ticket.len]);
        try owner.completeOutput(id, ticket, .written);
    }
    try testing.expect(value.isDrained());
    const drained = value.getStats();
    const request_id = value.last_request_id;
    @memset(&out, '?');
    try testing.expect((try owner.readOutput(id, &out)) == null);
    try testing.expectEqualStrings("????????", &out);
    try testing.expectEqualDeep(drained, value.getStats());
    try testing.expectEqual(request_id, value.last_request_id);
}

test "Session completion rejects whole foreign stale and modified tickets including handle reuse" {
    const owner = try context.Context.init(testing.allocator, std.Io.failing, .{ .object_capacity = 2 });
    defer owner.deinit() catch unreachable;
    const other = try context.Context.init(testing.allocator, std.Io.failing, .{ .object_capacity = 1 });
    defer other.deinit() catch unreachable;
    const id = try owner.createSession(small);
    const sibling = try owner.createSession(small);
    defer owner.cancelSession(sibling) catch unreachable;
    const foreign = try other.createSession(small);
    defer other.cancelSession(foreign) catch unreachable;
    try owner.writeSession(id, "a");
    try owner.writeSession(sibling, "b");
    try other.writeSession(foreign, "c");
    var out: [1]u8 = undefined;
    const ticket = (try owner.readOutput(id, &out)).?;
    const sibling_ticket = (try owner.readOutput(sibling, &out)).?;
    const foreign_ticket = (try other.readOutput(foreign, &out)).?;
    const value = try owner.getSession(id);
    const before = value.getStats();
    var invalid = [_]session.OutputTicket{ foreign_ticket, sibling_ticket, ticket, ticket, ticket, ticket };
    invalid[2].session.generation += 1;
    invalid[3].request_id += 1;
    invalid[4].len = 0;
    invalid[5].len += 1;
    const errors = [_]context.Error{
        error.WrongContext, error.WrongSession,  error.StaleHandle,
        error.StaleRequest, error.InvalidTicket, error.InvalidTicket,
    };
    for (invalid, errors) |bad, expected| {
        for ([_]session.OutputResult{ .written, .failed }) |result| {
            try testing.expectError(expected, owner.completeOutput(id, bad, result));
            try testing.expectEqualDeep(before, value.getStats());
            try testing.expectEqualDeep(ticket, value.pending.?);
            try testing.expectEqual(.open, value.state);
        }
    }
    out[0] = '?';
    try testing.expectError(error.WrongContext, other.readOutput(id, &out));
    try testing.expectEqual(@as(u8, '?'), out[0]);
    owner.mutating = true;
    try testing.expectError(error.ContextBusy, owner.completeOutput(id, ticket, .written));
    owner.mutating = false;
    try owner.completeOutput(id, ticket, .written);
    try testing.expectError(error.StaleRequest, owner.completeOutput(id, ticket, .written));
    try owner.writeSession(id, "d");
    const later = (try owner.readOutput(id, &out)).?;
    try testing.expectError(error.StaleRequest, owner.completeOutput(id, ticket, .failed));
    try testing.expectEqualDeep(later, value.pending.?);
    try owner.cancelSession(id);
    try owner.destroy(id);
    const replacement = try owner.createSession(small);
    defer owner.cancelSession(replacement) catch unreachable;
    try testing.expectEqual(id.slot, replacement.slot);
    try testing.expect(id.generation != replacement.generation);
    try owner.writeSession(replacement, "e");
    const current = (try owner.readOutput(replacement, &out)).?;
    try testing.expectEqual(ticket.request_id, current.request_id);
    try testing.expectEqual(ticket.len, current.len);
    try testing.expectError(error.StaleHandle, owner.completeOutput(id, ticket, .written));
    try testing.expectError(error.StaleHandle, owner.completeOutput(replacement, ticket, .written));
    try testing.expectError(error.WrongSession, owner.completeOutput(replacement, sibling_ticket, .written));
    try testing.expectError(error.WrongContext, owner.completeOutput(replacement, foreign_ticket, .written));
    try testing.expectEqualDeep(current, (try owner.getSession(replacement)).pending.?);
    try owner.completeOutput(replacement, current, .written);
    try owner.completeOutput(sibling, sibling_ticket, .written);
    try other.completeOutput(foreign, foreign_ticket, .written);
}

test "Session request and byte counters never wrap or consume rejected output" {
    for ([_]bool{ false, true }) |partial| {
        const owner = try context.Context.init(testing.allocator, std.Io.failing, .{});
        defer owner.deinit() catch unreachable;
        const id = try owner.createSession(small);
        defer owner.cancelSession(id) catch unreachable;
        const value = try owner.getSession(id);
        try owner.writeSession(id, "ab");
        value.last_request_id = std.math.maxInt(u64) - @as(u64, @intFromBool(partial));
        var out: [1]u8 = undefined;
        if (partial) {
            const ticket = (try owner.readOutput(id, &out)).?;
            try testing.expectEqual(std.math.maxInt(u64), ticket.request_id);
            try owner.completeOutput(id, ticket, .written);
        }
        const before = value.getStats();
        out[0] = '?';
        try testing.expect((try owner.readOutput(id, &.{})) == null);
        try testing.expectError(error.RequestLimit, owner.readOutput(id, &out));
        try testing.expectEqual(@as(u8, '?'), out[0]);
        try testing.expectEqualDeep(before, value.getStats());
        try testing.expectEqual(@as(u32, @intFromBool(partial)), value.span_offset);
        value.output.stats.bytes_written = std.math.maxInt(u64);
        const exhausted = value.getStats();
        try testing.expectError(error.NoSpace, owner.writeSession(id, "x"));
        try testing.expectEqualDeep(exhausted, value.getStats());
    }
}

fn createWithAllocationFailures(allocator: std.mem.Allocator) !void {
    const owner = try context.Context.init(allocator, std.Io.failing, .{ .object_capacity = 2 });
    defer owner.deinit() catch unreachable;
    const id = try owner.createSession(small);
    defer owner.cancelSession(id) catch unreachable;
    try owner.writeSession(id, "safe");
    const value = try owner.getSession(id);
    const before = value.getStats();
    const next = owner.createSession(.{
        .chunk_size = 4,
        .chunk_count = 3,
        .span_capacity = 3,
        .control_capacity = 5,
    }) catch |err| {
        try testing.expectEqual(@as(u32, 1), owner.objects.live_count);
        try testing.expectEqualDeep(before, value.getStats());
        try testing.expect(!owner.mutating);
        var out: [4]u8 = undefined;
        const ticket = (try owner.readOutput(id, &out)).?;
        try testing.expectEqualStrings("safe", &out);
        try owner.completeOutput(id, ticket, .written);
        return err;
    };
    try testing.expect(value == try owner.getSession(id));
    try testing.expectEqualDeep(before, value.getStats());
    try owner.destroy(next);
}

test "Session creation validates finite limits and unwinds every allocation failure" {
    try testing.checkAllAllocationFailures(testing.allocator, createWithAllocationFailures, .{});
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const owner = try context.Context.init(failing.allocator(), std.Io.failing, .{ .object_capacity = 1 });
    defer owner.deinit() catch unreachable;
    const allocated = failing.allocated_bytes;
    for ([_]session.Options{
        .{ .chunk_size = 0 },
        .{ .chunk_count = 0 },
        .{ .span_capacity = 0 },
        .{ .chunk_size = 4, .chunk_count = 2, .span_capacity = 3, .control_capacity = 5 },
        .{ .chunk_size = 4, .chunk_count = 3, .span_capacity = 2, .control_capacity = 5 },
        .{ .chunk_size = 4, .chunk_count = 2, .span_capacity = 3, .control_capacity = 8 },
        .{ .span_capacity = 1, .control_capacity = 1 },
        .{ .control_capacity = std.math.maxInt(u32) },
    }) |options| {
        try testing.expectError(error.InvalidOptions, owner.createSession(options));
        try testing.expectEqual(@as(u32, 0), owner.objects.live_count);
        try testing.expectEqual(allocated, failing.allocated_bytes);
        try testing.expect(!owner.mutating);
    }
    const id = try owner.createSession(small);
    defer owner.cancelSession(id) catch unreachable;
    try owner.writeSession(id, "kept");
    const before = (try owner.getSession(id)).getStats();
    try testing.expectError(error.ObjectLimit, owner.createSession(small));
    try testing.expectEqualDeep(before, (try owner.getSession(id)).getStats());
}
