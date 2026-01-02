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

test "GraphemePool - defer cleanup on failure path" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    var allocated_ids: std.ArrayListUnmanaged(u32) = .{};
    defer allocated_ids.deinit(std.testing.allocator);

    for (0..5) |i| {
        var buffer: [8]u8 = undefined;
        const slice = std.fmt.bufPrint(&buffer, "{d}", .{i}) catch unreachable;
        const gid = try pool.alloc(slice);
        try pool.incref(gid);
        try allocated_ids.append(std.testing.allocator, gid);
    }

    // Simulate failure cleanup
    for (allocated_ids.items) |id| {
        try pool.decref(id);
    }

    // Force slot reuse
    for (0..5) |_| {
        _ = try pool.alloc("reuse");
    }

    for (allocated_ids.items) |id| {
        try std.testing.expectError(GraphemePoolError.WrongGeneration, pool.get(id));
    }
}

test "GraphemePool - pending grapheme cleanup on failure" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    var result_graphemes: std.ArrayListUnmanaged(u32) = .{};
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

    const gid1 = try pool.alloc("grapheme1");
    pending_gid = gid1;
    try pool.incref(gid1);
    try result_graphemes.append(std.testing.allocator, gid1);
    pending_gid = null;

    const gid2 = try pool.alloc("grapheme2");
    pending_gid = gid2;
    try pool.incref(gid2);
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
            var result = SimulateResult{
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

            const gid1 = pool.alloc("emoji1") catch return result;
            result.captured_ids[result.captured_count] = gid1;
            result.captured_count += 1;
            pending_gid = gid1;
            pool.incref(gid1) catch return result;
            stored_ids[stored_count] = gid1;
            stored_count += 1;
            pending_gid = null;

            const gid2 = pool.alloc("emoji2") catch return result;
            result.captured_ids[result.captured_count] = gid2;
            result.captured_count += 1;
            pending_gid = gid2;
            pool.incref(gid2) catch return result;

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

    // Force slot reuse by allocating enough graphemes to cycle through freed slots
    // Allocate more than captured to ensure freed slots get reused
    for (0..4) |_| {
        _ = try pool.alloc("reuse");
    }

    // Verify cleanup: old IDs should now have wrong generation
    for (sim_result.captured_ids[0..sim_result.captured_count]) |old_id| {
        try std.testing.expectError(GraphemePoolError.WrongGeneration, pool.get(old_id));
    }
}
