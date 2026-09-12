const std = @import("std");
const link = @import("../link.zig");

const LinkPool = link.LinkPool;
const LinkPoolError = link.LinkPoolError;
const LinkTracker = link.LinkTracker;

test "LinkPool - can initialize and cleanup" {
    var pool = LinkPool.init(std.testing.allocator);
    pool.deinit();
}

test "LinkPool - alloc and get URL" {
    var pool = LinkPool.init(std.testing.allocator);
    defer pool.deinit();

    const url = "https://example.com";
    const id = try pool.alloc(url);
    try pool.incref(id);
    defer pool.decref(id) catch {};

    const retrieved = try pool.get(id);
    try std.testing.expectEqualSlices(u8, url, retrieved);
}

test "LinkPool - decref to zero allows slot reuse" {
    var pool = LinkPool.init(std.testing.allocator);
    defer pool.deinit();

    const id1 = try pool.alloc("https://first.example");
    try pool.incref(id1);
    try pool.decref(id1);

    const id2 = try pool.alloc("https://second.example");
    try pool.incref(id2);
    defer pool.decref(id2) catch {};

    const stale_get = pool.get(id1);
    try std.testing.expectError(LinkPoolError.WrongGeneration, stale_get);

    const stale_incref = pool.incref(id1);
    try std.testing.expectError(LinkPoolError.WrongGeneration, stale_incref);

    const stale_decref = pool.decref(id1);
    try std.testing.expectError(LinkPoolError.WrongGeneration, stale_decref);

    try std.testing.expectEqualSlices(u8, "https://second.example", try pool.get(id2));
}

test "LinkPool - decref on zero refcount fails" {
    var pool = LinkPool.init(std.testing.allocator);
    defer pool.deinit();

    const id = try pool.alloc("https://example.com");
    try std.testing.expectError(LinkPoolError.InvalidId, pool.decref(id));
}

test "LinkPool - alloc never returns sentinel zero ID" {
    var pool = LinkPool.init(std.testing.allocator);
    defer pool.deinit();

    const rounds: usize = 300;
    for (0..rounds) |_| {
        const id = try pool.alloc("https://example.com/rotate");
        try std.testing.expect(id != 0);

        try pool.incref(id);
        try pool.decref(id);
    }
}

test "LinkPool - stale ID stays invalid after generation exhaustion" {
    var pool = LinkPool.init(std.testing.allocator);
    defer pool.deinit();

    const stale_id = try pool.alloc("https://example.com/stale");
    try pool.incref(stale_id);
    try pool.decref(stale_id);

    var exhausted_id: link.IdPayload = undefined;
    var generation: u32 = 2;
    while (generation <= link.GEN_MASK) : (generation += 1) {
        const id = try pool.alloc("https://example.com/rotate");
        try pool.incref(id);
        try pool.decref(id);
        if (generation == link.GEN_MASK) exhausted_id = id;
    }

    try std.testing.expectError(LinkPoolError.WrongGeneration, pool.incref(exhausted_id));
    try std.testing.expectEqual(@as(u64, 0), pool.getLiveSlotCount());

    const live_id = try pool.alloc("https://example.com/live");
    try pool.incref(live_id);
    defer pool.decref(live_id) catch {};

    try std.testing.expect(stale_id != live_id);
    try std.testing.expectError(LinkPoolError.WrongGeneration, pool.get(stale_id));
    try std.testing.expectEqualSlices(u8, "https://example.com/live", try pool.get(live_id));
    try std.testing.expectEqual(@as(u64, 1), pool.getLiveSlotCount());
}

test "LinkTracker - add/remove keeps one pool ref per ID" {
    var pool = LinkPool.init(std.testing.allocator);
    defer pool.deinit();

    const id = try pool.alloc("https://example.com/same");

    var tracker = LinkTracker.init(std.testing.allocator, &pool);
    defer tracker.deinit();

    tracker.addCellRef(id);
    tracker.addCellRef(id);
    tracker.addCellRef(id);

    try std.testing.expectEqual(@as(u32, 1), tracker.getLinkCount());
    try std.testing.expectEqual(@as(u32, 1), try pool.getRefcount(id));

    tracker.removeCellRef(id);
    try std.testing.expectEqual(@as(u32, 1), tracker.getLinkCount());
    try std.testing.expectEqual(@as(u32, 1), try pool.getRefcount(id));

    tracker.removeCellRef(id);
    try std.testing.expectEqual(@as(u32, 1), tracker.getLinkCount());
    try std.testing.expectEqual(@as(u32, 1), try pool.getRefcount(id));

    tracker.removeCellRef(id);
    try std.testing.expectEqual(@as(u32, 0), tracker.getLinkCount());
    try std.testing.expectEqual(@as(u32, 0), try pool.getRefcount(id));
}

test "LinkTracker - clear releases tracked IDs" {
    var pool = LinkPool.init(std.testing.allocator);
    defer pool.deinit();

    const id1 = try pool.alloc("https://example.com/1");
    const id2 = try pool.alloc("https://example.com/2");

    var tracker = LinkTracker.init(std.testing.allocator, &pool);
    defer tracker.deinit();

    tracker.addCellRef(id1);
    tracker.addCellRef(id2);

    try std.testing.expect(tracker.hasAny());
    try std.testing.expectEqual(@as(u32, 2), try pool.getRefcount(id1) + try pool.getRefcount(id2));

    tracker.clear();

    try std.testing.expect(!tracker.hasAny());
    try std.testing.expectEqual(@as(u32, 0), try pool.getRefcount(id1));
    try std.testing.expectEqual(@as(u32, 0), try pool.getRefcount(id2));
}

test "LinkTracker - clear only decrefs once per ID with multiple cell refs" {
    var pool = LinkPool.init(std.testing.allocator);
    defer pool.deinit();

    const id = try pool.alloc("https://example.com/shared");

    var tracker_a = LinkTracker.init(std.testing.allocator, &pool);
    defer tracker_a.deinit();

    var tracker_b = LinkTracker.init(std.testing.allocator, &pool);
    defer tracker_b.deinit();

    tracker_a.addCellRef(id);
    tracker_a.addCellRef(id);
    tracker_a.addCellRef(id);

    tracker_b.addCellRef(id);

    try std.testing.expectEqual(@as(u32, 2), try pool.getRefcount(id));

    // Clear tracker A should decref once (2 -> 1).
    tracker_a.clear();

    try std.testing.expectEqual(@as(u32, 1), try pool.getRefcount(id));
    try std.testing.expectEqualSlices(u8, "https://example.com/shared", try pool.get(id));
}

test "LinkPool - leak repro: alloc-only IDs accumulate live slots" {
    var pool = LinkPool.init(std.testing.allocator);
    defer pool.deinit();

    const rounds: usize = 4096;
    for (0..rounds) |i| {
        var buf: [64]u8 = undefined;
        const url = std.fmt.bufPrint(&buf, "https://example.com/r{d}", .{i}) catch unreachable;
        _ = try pool.alloc(url);
    }

    try std.testing.expect(pool.getLiveSlotCount() > 0);
    try std.testing.expect(pool.getFreeSlotCount() < pool.getTotalSlots());
}

test "LinkPool - alloc reuses live ID for same URL" {
    var pool = LinkPool.init(std.testing.allocator);
    defer pool.deinit();

    const url = "https://example.com/stable";

    const id1 = try pool.alloc(url);
    try pool.incref(id1);

    const id2 = try pool.alloc(url);
    try std.testing.expectEqual(id1, id2);
    try std.testing.expectEqual(@as(u32, 1), try pool.getRefcount(id1));

    try pool.decref(id1);

    const id3 = try pool.alloc(url);
    try pool.incref(id3);
    defer pool.decref(id3) catch {};

    try std.testing.expect(id3 != id1);
    try std.testing.expectEqualSlices(u8, url, try pool.get(id3));

    const id4 = try pool.alloc(url);
    try std.testing.expectEqual(id3, id4);
}
