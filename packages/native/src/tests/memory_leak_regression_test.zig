const std = @import("std");
const gp = @import("../grapheme.zig");

const GraphemePool = gp.GraphemePool;
const GraphemePoolError = gp.GraphemePoolError;

test "GraphemePool - invalid class_id returns InvalidId" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    // class_id 5, 6, 7 are invalid (valid are 0-4)
    for ([_]u32{ 5, 6, 7 }) |invalid_class_id| {
        const invalid_id = (invalid_class_id << (gp.GENERATION_BITS + gp.SLOT_BITS));

        try std.testing.expectError(GraphemePoolError.InvalidId, pool.incref(invalid_id));
        try std.testing.expectError(GraphemePoolError.InvalidId, pool.decref(invalid_id));
        try std.testing.expectError(GraphemePoolError.InvalidId, pool.get(invalid_id));
        try std.testing.expectError(GraphemePoolError.InvalidId, pool.getRefcount(invalid_id));
    }
}

test "GraphemePool - out-of-range slot returns InvalidId before dereference" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    _ = try pool.acquire("allocated");

    // Class 0 exists after the allocation, but the highest encodable slot has
    // not been allocated. Public operations must reject it before slot access.
    const invalid_id = gp.SLOT_MASK;
    try std.testing.expectError(GraphemePoolError.InvalidId, pool.incref(invalid_id));
    try std.testing.expectError(GraphemePoolError.InvalidId, pool.decref(invalid_id));
    try std.testing.expectError(GraphemePoolError.InvalidId, pool.get(invalid_id));
    try std.testing.expectError(GraphemePoolError.InvalidId, pool.getRefcount(invalid_id));
}

test "GraphemePool - last release cannot be decref'd again" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const id = try pool.acquire("live");
    try pool.decref(id);

    try std.testing.expectError(GraphemePoolError.InvalidId, pool.decref(id));
    try std.testing.expectError(GraphemePoolError.InvalidId, pool.get(id));
}

test "GraphemePool - failed first-use acquire leaves no live reference" {
    var fail_offset: usize = 0;
    while (fail_offset < 16) : (fail_offset += 1) {
        var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        var pool = GraphemePool.initWithOptions(failing.allocator(), .{
            .slots_per_page = [_]u32{ 1, 1, 1, 1, 1 },
        });
        defer pool.deinit();
        failing.fail_index = fail_offset;
        const result = pool.acquire("owned");
        failing.fail_index = std.math.maxInt(usize);
        if (result) |id| {
            try std.testing.expect(!failing.has_induced_failure);
            try std.testing.expectEqual(@as(u32, 1), try pool.getRefcount(id));
            try pool.decref(id);
        } else |err| {
            try std.testing.expectEqual(error.OutOfMemory, err);
            try std.testing.expect(failing.has_induced_failure);
        }
        try std.testing.expectEqual(@as(u32, 0), pool.interned_live_ids.count());
        const retry = try pool.acquire("owned");
        try std.testing.expectEqual(@as(u32, 1), try pool.getRefcount(retry));
        try pool.decref(retry);
        if (result) |_| break else |_| {}
    }
    try std.testing.expect(fail_offset < 16);
}

test "GraphemePool - growth allocation failure leaves state reusable" {
    var failing_allocator = std.testing.FailingAllocator.init(
        std.testing.allocator,
        .{ .fail_index = 1 },
    );
    var pool = GraphemePool.initWithOptions(failing_allocator.allocator(), .{
        .slots_per_page = [_]u32{ 1, 1, 1, 1, 1 },
    });
    defer pool.deinit();

    try std.testing.expectError(GraphemePoolError.OutOfMemory, pool.acquire("value"));
    try std.testing.expect(failing_allocator.has_induced_failure);

    failing_allocator.fail_index = std.math.maxInt(usize);
    const id = try pool.acquire("value");
    try std.testing.expectEqualSlices(u8, "value", try pool.get(id));
    try pool.decref(id);
}

test "GraphemePool - defer cleanup on failure path" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    var allocated_ids: std.ArrayListUnmanaged(u32) = .empty;
    defer allocated_ids.deinit(std.testing.allocator);

    for (0..5) |i| {
        var buffer: [8]u8 = undefined;
        const slice = std.fmt.bufPrint(&buffer, "{d}", .{i}) catch unreachable;
        const gid = try pool.acquire(slice);
        try allocated_ids.append(std.testing.allocator, gid);
    }

    // Simulate failure cleanup
    for (allocated_ids.items) |id| {
        try pool.decref(id);
    }

    var reused: [5]u32 = undefined;
    for (&reused, 0..) |*id, i| {
        var buffer: [8]u8 = undefined;
        const slice = std.fmt.bufPrint(&buffer, "r{d}", .{i}) catch unreachable;
        id.* = try pool.acquire(slice);
    }
    defer for (reused) |id| pool.decref(id) catch {};

    for (allocated_ids.items) |id| {
        try std.testing.expectError(GraphemePoolError.WrongGeneration, pool.get(id));
    }
}

test "GraphemePool - pending grapheme cleanup on failure" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    var result_graphemes: std.ArrayListUnmanaged(u32) = .empty;
    defer result_graphemes.deinit(std.testing.allocator);

    var pending_gid: ?u32 = null;
    const success = false; // intentionally never true to test cleanup path

    defer {
        if (!success) {
            if (pending_gid) |pgid| {
                pool.decref(pgid) catch {};
            }
            for (result_graphemes.items) |gid| {
                pool.decref(gid) catch {};
            }
        }
    }

    const gid1 = try pool.acquire("grapheme1");
    pending_gid = gid1;
    try result_graphemes.append(std.testing.allocator, gid1);
    pending_gid = null;

    const gid2 = try pool.acquire("grapheme2");
    pending_gid = gid2;
    // Simulate failure before storing - pending_gid remains set
}

test "encodeUnicode - cleanup on mid-operation failure" {
    const SimulateResult = struct {
        success: bool,
        captured_ids: [2]u32,
        captured_count: usize,
    };

    const simulateEncodeUnicode = struct {
        fn run(pool: *GraphemePool, should_fail: bool) SimulateResult {
            var result: SimulateResult = .{
                .success = false,
                .captured_ids = undefined,
                .captured_count = 0,
            };
            var pending_gid: ?u32 = null;
            var stored_ids: [8]u32 = undefined;
            var stored_count: usize = 0;

            defer {
                if (!result.success) {
                    if (pending_gid) |pgid| {
                        pool.decref(pgid) catch {};
                    }
                    for (stored_ids[0..stored_count]) |gid| {
                        pool.decref(gid) catch {};
                    }
                }
            }

            const gid1 = pool.acquire("emoji1") catch return result;
            result.captured_ids[result.captured_count] = gid1;
            result.captured_count += 1;
            pending_gid = gid1;
            stored_ids[stored_count] = gid1;
            stored_count += 1;
            pending_gid = null;

            const gid2 = pool.acquire("emoji2") catch return result;
            result.captured_ids[result.captured_count] = gid2;
            result.captured_count += 1;
            pending_gid = gid2;

            if (should_fail) {
                return result;
            }

            stored_ids[stored_count] = gid2;
            stored_count += 1;
            pending_gid = null;

            result.success = true;
            return result;
        }
    }.run;

    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const sim_result = simulateEncodeUnicode(&pool, true);
    try std.testing.expect(!sim_result.success);
    try std.testing.expectEqual(@as(usize, 2), sim_result.captured_count);

    var reused: [4]u32 = undefined;
    for (&reused, 0..) |*id, i| {
        var buffer: [8]u8 = undefined;
        const slice = std.fmt.bufPrint(&buffer, "r{d}", .{i}) catch unreachable;
        id.* = try pool.acquire(slice);
    }
    defer for (reused) |id| pool.decref(id) catch {};

    // Verify cleanup: old IDs should now have wrong generation
    for (sim_result.captured_ids[0..sim_result.captured_count]) |old_id| {
        try std.testing.expectError(GraphemePoolError.WrongGeneration, pool.get(old_id));
    }
}
