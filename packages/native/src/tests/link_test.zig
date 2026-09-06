const std = @import("std");
const link = @import("../link.zig");

const LinkPool = link.LinkPool;
const LinkPoolError = link.LinkPoolError;
const LinkTracker = link.LinkTracker;

test "LinkPool - producer acquisition rolls back first-use allocation failures" {
    var fail_offset: usize = 0;
    while (fail_offset < 16) : (fail_offset += 1) {
        var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        var pool = LinkPool.init(failing.allocator());
        defer pool.deinit();
        failing.fail_index = fail_offset;
        const result = pool.acquire("https://example.com/new");
        failing.fail_index = std.math.maxInt(usize);
        if (result) |id| {
            try std.testing.expect(!failing.has_induced_failure);
            try std.testing.expectEqual(@as(u32, 1), try pool.getRefcount(id));
            try pool.decref(id);
        } else |err| {
            try std.testing.expectEqual(error.OutOfMemory, err);
            try std.testing.expect(failing.has_induced_failure);
        }
        try std.testing.expectEqual(@as(u64, 0), pool.getLiveSlotCount());
        try std.testing.expectEqual(pool.getTotalSlots(), pool.getFreeSlotCount());
        try std.testing.expectEqual(@as(u32, 0), pool.interned_live_ids.count());
        const retry = try pool.acquire("https://example.com/new");
        try pool.decref(retry);
        try std.testing.expectEqual(pool.getTotalSlots(), pool.getFreeSlotCount());
        if (result) |_| break else |_| {}
    }
    try std.testing.expect(fail_offset < 16);
}

test "LinkTracker - invalid cell reference leaves no membership" {
    var pool = LinkPool.init(std.testing.allocator);
    defer pool.deinit();
    var tracker = LinkTracker.init(std.testing.allocator, &pool);
    defer tracker.deinit();
    tracker.addCellRef(1);
    try std.testing.expectEqual(@as(u32, 0), tracker.getLinkCount());
}

test "LinkTracker - OptimizedBuffer set retains link ownership after interning OOM" {
    const gp = @import("../grapheme.zig");
    const buffer = @import("../buffer.zig");
    const ansi = @import("../ansi.zig");
    var graphemes = gp.GraphemePool.init(std.testing.allocator);
    defer graphemes.deinit();
    for ([_]usize{ 0, 1 }) |fail_offset| {
        var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        var pool = LinkPool.init(failing.allocator());
        defer pool.deinit();
        const target = try buffer.OptimizedBuffer.init(std.testing.allocator, 2, 1, .{
            .pool = &graphemes,
            .link_pool = &pool,
        });
        defer target.deinit();
        const url = "https://example.com/retained";
        const id = try pool.alloc(url);
        var cell = target.get(0, 0).?;
        cell.char = 'A';
        cell.attributes = ansi.TextAttributes.setLinkId(0, id);
        failing.fail_index = failing.alloc_index + fail_offset;
        target.set(0, 0, cell);
        try std.testing.expect(failing.has_induced_failure);
        try std.testing.expectEqual(pool.getTotalSlots() - 1, pool.getFreeSlotCount());
        try std.testing.expectEqual(@as(u32, 1), try pool.getRefcount(id));
        try std.testing.expectEqual(@as(u32, 1), target.link_tracker.used_ids.get(id).?);
        try std.testing.expectEqual(id, ansi.TextAttributes.getLinkId(target.get(0, 0).?.attributes));

        failing.fail_index = std.math.maxInt(usize);
        const other = try pool.acquire("https://example.com/other");
        defer pool.decref(other) catch unreachable;
        try std.testing.expectEqualStrings(url, try pool.get(id));
        target.set(1, 0, cell);
        try std.testing.expectEqual(@as(u32, 2), target.link_tracker.used_ids.get(id).?);
        try std.testing.expectEqual(@as(u32, 1), try pool.getRefcount(id));
        target.clear(cell.bg, null);
        try std.testing.expectEqual(@as(u32, 0), try pool.getRefcount(id));
        try std.testing.expectEqual(pool.getTotalSlots() - 1, pool.getFreeSlotCount());
    }
}

test "LinkTracker - checked URL membership is idempotent and rejects reference saturation" {
    var pool = LinkPool.init(std.testing.allocator);
    defer pool.deinit();
    var tracker = LinkTracker.init(std.testing.allocator, &pool);
    defer tracker.deinit();
    const url = "https://example.com/shared";
    const id = try tracker.trackUrl(url);
    try std.testing.expectEqual(id, try tracker.trackUrl(url));
    try std.testing.expectEqual(@as(u32, 1), tracker.used_ids.get(id).?);
    try std.testing.expectEqual(@as(u32, 1), try pool.getRefcount(id));
    const shared = try pool.acquire(url);
    try std.testing.expectEqual(id, shared);
    try std.testing.expectEqual(@as(u32, 2), try pool.getRefcount(id));
    try pool.decref(shared);

    const refcount_offset = (id & link.SLOT_MASK) * pool.slot_size_bytes + @sizeOf(u32);
    const refcount: *align(1) u32 = @ptrCast(&pool.slots.items[refcount_offset]);
    refcount.* = std.math.maxInt(u32);
    defer refcount.* = 1;
    try std.testing.expectError(error.RefcountOverflow, pool.acquire(url));
    var other = LinkTracker.init(std.testing.allocator, &pool);
    defer other.deinit();
    try std.testing.expectError(error.RefcountOverflow, other.trackUrl(url));
    try std.testing.expectEqual(@as(u32, 0), other.getLinkCount());
    try std.testing.expectEqual(id, try tracker.trackUrl(url));
    try std.testing.expectEqual(std.math.maxInt(u32), try pool.getRefcount(id));
    try std.testing.expectError(error.UrlTooLong, tracker.trackUrl("x" ** (link.MAX_URL_LENGTH + 1)));
}

test "LinkTracker - checked URL membership rolls back insertion failures" {
    var pool = LinkPool.init(std.testing.allocator);
    defer pool.deinit();
    for ([_]bool{ false, true }) |shared| {
        const url = "https://example.com/new";
        const owner = if (shared) try pool.acquire(url) else null;
        defer if (owner) |id| pool.decref(id) catch unreachable;
        var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0 });
        var tracker = LinkTracker.init(failing.allocator(), &pool);
        defer tracker.deinit();
        try std.testing.expectError(error.OutOfMemory, tracker.trackUrl(url));
        try std.testing.expect(failing.has_induced_failure);
        try std.testing.expectEqual(@as(u32, 0), tracker.getLinkCount());
        try std.testing.expectEqual(@as(u64, @intFromBool(shared)), pool.getLiveSlotCount());
        try std.testing.expectEqual(@as(u32, @intFromBool(shared)), pool.interned_live_ids.count());
        if (owner) |id| try std.testing.expectEqual(@as(u32, 1), try pool.getRefcount(id));
        failing.fail_index = std.math.maxInt(usize);
        const id = try tracker.trackUrl(url);
        try std.testing.expectEqual(@as(u32, 1) + @intFromBool(shared), try pool.getRefcount(id));
        tracker.clear();
        try std.testing.expectEqual(@as(u64, @intFromBool(shared)), pool.getLiveSlotCount());
    }
}

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

test "LinkPool - growth failures do not publish slots or free IDs" {
    for (0..3) |page_count| {
        for ([_]usize{ 0, 1 }) |fail_offset| {
            var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
            var pool = LinkPool.init(failing.allocator());
            defer pool.deinit();
            const count: u32 = @as(u32, @intCast(page_count)) * pool.slots_per_page;
            const ids = try std.testing.allocator.alloc(u32, count);
            defer std.testing.allocator.free(ids);
            for (ids, 0..) |*id, index| {
                var url: [64]u8 = undefined;
                id.* = try pool.alloc(try std.fmt.bufPrint(&url, "https://example.com/{d}", .{index}));
                try pool.incref(id.*);
            }
            const new_count = count + pool.slots_per_page;
            const growth_allocations = @as(usize, @intFromBool(pool.slots.capacity < new_count * pool.slot_size_bytes)) +
                @intFromBool(pool.free_list.capacity < new_count);
            if (fail_offset >= growth_allocations) continue;
            const old_slots = try std.testing.allocator.dupe(u8, pool.slots.items);
            defer std.testing.allocator.free(old_slots);
            failing.fail_index = failing.alloc_index + fail_offset;
            failing.resize_fail_index = failing.resize_index;
            try std.testing.expectError(error.OutOfMemory, pool.alloc("https://example.com/rejected"));
            try std.testing.expect(failing.has_induced_failure);
            try std.testing.expectEqual(count, pool.num_slots);
            try std.testing.expectEqualSlices(u8, old_slots, pool.slots.items);
            try std.testing.expectEqual(@as(u64, 0), pool.getFreeSlotCount());
            try std.testing.expectEqual(count, pool.getLiveSlotCount());
            try std.testing.expectEqual(count, pool.interned_live_ids.count());

            failing.fail_index = std.math.maxInt(usize);
            failing.resize_fail_index = std.math.maxInt(usize);
            const id = try pool.alloc("https://example.com/retry");
            try pool.incref(id);
            try std.testing.expectEqual(count + pool.slots_per_page, pool.num_slots);
            try std.testing.expectEqual(pool.num_slots * pool.slot_size_bytes, pool.slots.items.len);
            try std.testing.expect(pool.free_list.capacity >= pool.num_slots);
            try std.testing.expectEqualStrings("https://example.com/retry", try pool.get(id));
            try pool.decref(id);
            for (ids) |live_id| try pool.decref(live_id);
            try std.testing.expectEqual(pool.getTotalSlots(), pool.getFreeSlotCount());
            try std.testing.expectEqual(@as(u32, 0), pool.interned_live_ids.count());
        }
    }
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
