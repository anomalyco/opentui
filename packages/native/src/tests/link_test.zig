const std = @import("std");
const link = @import("../link.zig");
const test_pools = @import("test-pools.zig");

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

test "LinkTracker - set retains a live ID without first-use interning" {
    const gp = @import("../grapheme.zig");
    const buffer = @import("../buffer.zig");
    const ansi = @import("../ansi.zig");
    var graphemes = gp.GraphemePool.init(std.testing.allocator);
    defer graphemes.deinit();
    var pool = LinkPool.init(std.testing.allocator);
    defer pool.deinit();
    const target = try buffer.OptimizedBuffer.init(std.testing.allocator, 2, 1, .{
        .pool = &graphemes,
        .link_pool = &pool,
    });
    defer target.deinit();
    const url = "https://example.com/retained";
    const id = try pool.acquire(url);
    defer pool.decref(id) catch unreachable;
    const interned = pool.interned_live_ids.count();
    var cell = target.get(0, 0).?;
    cell.char = 'A';
    cell.attributes = ansi.TextAttributes.setLinkId(0, id);
    target.set(0, 0, cell);
    try std.testing.expectEqual(interned, pool.interned_live_ids.count());
    try std.testing.expectEqual(pool.getTotalSlots() - 1, pool.getFreeSlotCount());
    try std.testing.expectEqual(@as(u32, 2), try pool.getRefcount(id));
    try std.testing.expectEqual(@as(u32, 1), target.link_tracker.used_ids.get(id).?);
    try std.testing.expectEqual(id, ansi.TextAttributes.getLinkId(target.get(0, 0).?.attributes));

    const other = try pool.acquire("https://example.com/other");
    defer pool.decref(other) catch unreachable;
    try std.testing.expectEqualStrings(url, try pool.get(id));
    target.set(1, 0, cell);
    try std.testing.expectEqual(@as(u32, 2), target.link_tracker.used_ids.get(id).?);
    try std.testing.expectEqual(@as(u32, 2), try pool.getRefcount(id));
    target.clear(cell.bg, null);
    try std.testing.expectEqual(@as(u32, 1), try pool.getRefcount(id));
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
                id.* = try pool.acquire(try std.fmt.bufPrint(&url, "https://example.com/{d}", .{index}));
            }
            const new_count = count + pool.slots_per_page;
            const growth_allocations = @as(usize, @intFromBool(pool.slots.capacity < new_count * pool.slot_size_bytes)) +
                @intFromBool(pool.free_list.capacity < new_count);
            if (fail_offset >= growth_allocations) continue;
            const old_slots = try std.testing.allocator.dupe(u8, pool.slots.items);
            defer std.testing.allocator.free(old_slots);
            failing.fail_index = failing.alloc_index + fail_offset;
            failing.resize_fail_index = failing.resize_index;
            try std.testing.expectError(error.OutOfMemory, pool.acquire("https://example.com/rejected"));
            try std.testing.expect(failing.has_induced_failure);
            try std.testing.expectEqual(count, pool.num_slots);
            try std.testing.expectEqualSlices(u8, old_slots, pool.slots.items);
            try std.testing.expectEqual(@as(u64, 0), pool.getFreeSlotCount());
            try std.testing.expectEqual(count, pool.getLiveSlotCount());
            try std.testing.expectEqual(count, pool.interned_live_ids.count());

            failing.fail_index = std.math.maxInt(usize);
            failing.resize_fail_index = std.math.maxInt(usize);
            const id = try pool.acquire("https://example.com/retry");
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

test "LinkPool - stale ID stays invalid after generation exhaustion" {
    var pool = LinkPool.init(std.testing.allocator);
    defer pool.deinit();

    const stale_id = try pool.acquire("https://example.com/stale");
    try pool.decref(stale_id);

    var exhausted_id: link.IdPayload = undefined;
    var generation: u32 = 2;
    while (generation <= link.GEN_MASK) : (generation += 1) {
        const id = try pool.acquire("https://example.com/rotate");
        try std.testing.expect(id != 0);
        try pool.decref(id);
        if (generation == link.GEN_MASK) exhausted_id = id;
    }

    try std.testing.expectError(LinkPoolError.WrongGeneration, pool.incref(exhausted_id));
    try std.testing.expectEqual(@as(u64, 0), pool.getLiveSlotCount());

    const live_id = try pool.acquire("https://example.com/live");
    defer pool.decref(live_id) catch {};

    try std.testing.expect(stale_id != live_id);
    try std.testing.expectError(LinkPoolError.WrongGeneration, pool.get(stale_id));
    try std.testing.expectEqualSlices(u8, "https://example.com/live", try pool.get(live_id));
    try std.testing.expectEqual(@as(u64, 1), pool.getLiveSlotCount());
}

test "LinkPool - interning failure retires an exhausted generation before retry" {
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    var pool = LinkPool.init(failing.allocator());
    defer pool.deinit();
    const url = "https://example.com/rollback";
    var previous_id: u32 = 0;
    for (0..link.GEN_MASK - 1) |_| {
        previous_id = try pool.acquire(url);
        try pool.decref(previous_id);
    }
    try std.testing.expectEqual(link.GEN_MASK - 1, previous_id >> link.SLOT_BITS);

    failing.fail_index = failing.alloc_index;
    try std.testing.expectError(error.OutOfMemory, pool.acquire(url));
    try std.testing.expect(failing.has_induced_failure);
    try std.testing.expectEqual(@as(u64, 0), pool.getLiveSlotCount());
    try std.testing.expectEqual(@as(u32, 0), pool.interned_live_ids.count());
    try std.testing.expectEqual(@as(u32, 1), pool.retired_slot_count);
    try std.testing.expectEqual(pool.getTotalSlots() - 1, pool.getFreeSlotCount());

    failing.fail_index = std.math.maxInt(usize);
    const retry = try pool.acquire(url);
    try std.testing.expect(retry & link.SLOT_MASK != previous_id & link.SLOT_MASK);
    try std.testing.expectEqualStrings(url, try pool.get(retry));
    try std.testing.expectEqual(@as(u32, 1), try pool.getRefcount(retry));
    try std.testing.expectError(error.WrongGeneration, pool.get(previous_id));
    try pool.decref(retry);
    try std.testing.expectEqual(@as(u64, 0), pool.getLiveSlotCount());
    try std.testing.expectEqual(pool.getTotalSlots() - 1, pool.getFreeSlotCount());
}

test "LinkPool and LinkTracker match a reference model" {
    for (0..8) |seed| try test_pools.checkPoolModel(test_pools.LinkSpec, seed, 400);
}

test "LinkPool - fragment entries intern by URL and key together" {
    var pool = LinkPool.init(std.testing.allocator);
    defer pool.deinit();
    const url = "https://example.com/shared";
    const plain = try pool.acquire(url);
    const keyed = try pool.acquireFragment(url, 7);
    const other_key = try pool.acquireFragment(url, 8);
    const key_only = try pool.acquireFragment("", 7);
    defer for ([_]u32{ plain, keyed, other_key, key_only }) |id| pool.decref(id) catch unreachable;

    // Each distinct (url, key) pair is its own entry; the URL alone does not merge them.
    try std.testing.expect(plain != keyed and keyed != other_key and keyed != key_only and plain != key_only);
    try std.testing.expectEqual(keyed, try pool.acquireFragment(url, 7));
    try pool.decref(keyed);
    try std.testing.expectEqual(plain, pool.lookupLiveUrl(url).?);

    try std.testing.expectEqualStrings(url, try pool.get(keyed));
    try std.testing.expectEqual(@as(u32, 0), try pool.getKey(plain));
    try std.testing.expectEqual(@as(u32, 7), try pool.getKey(keyed));
    try std.testing.expectEqual(@as(u32, 8), try pool.getKey(other_key));
    try std.testing.expectEqualStrings("", try pool.get(key_only));
    try std.testing.expectEqual(@as(u32, 7), try pool.getKey(key_only));

    // Only entries with a URL are hyperlinks.
    try std.testing.expectEqual(plain, pool.hyperlinkId(plain));
    try std.testing.expectEqual(keyed, pool.hyperlinkId(keyed));
    try std.testing.expectEqual(@as(u32, 0), pool.hyperlinkId(key_only));
    try std.testing.expectEqual(@as(u32, 0), pool.hyperlinkId(0));
    try std.testing.expectEqual(@as(u32, 0), pool.hyperlinkId(link.SLOT_MASK));
}

test "LinkPool - fragment acquisition rejects an empty entry and oversized URLs" {
    var pool = LinkPool.init(std.testing.allocator);
    defer pool.deinit();
    try std.testing.expectError(error.InvalidId, pool.acquireFragment("", 0));
    try std.testing.expectError(error.UrlTooLong, pool.acquireFragment("x" ** (link.MAX_URL_LENGTH + 1), 3));
    // A maximal URL with a key still fits: the key is not stored in the URL bytes.
    const id = try pool.acquireFragment("x" ** link.MAX_URL_LENGTH, std.math.maxInt(u32));
    defer pool.decref(id) catch unreachable;
    try std.testing.expectEqual(@as(usize, link.MAX_URL_LENGTH), (try pool.get(id)).len);
    try std.testing.expectEqual(std.math.maxInt(u32), try pool.getKey(id));
    try std.testing.expectEqual(@as(u64, 1), pool.getLiveSlotCount());
}

test "LinkPool - releasing a fragment entry frees its intern key and slot" {
    var pool = LinkPool.init(std.testing.allocator);
    defer pool.deinit();
    const id = try pool.acquireFragment("https://example.com/released", 5);
    try pool.decref(id);
    try std.testing.expectEqual(@as(u64, 0), pool.getLiveSlotCount());
    try std.testing.expectEqual(@as(u32, 0), pool.interned_live_ids.count());
    // Like get(), the raw pool still resolves a released id until its slot is reused; liveness
    // is the refcount, which Context-level lookups check (sessionGetPresentedLinkId).
    try std.testing.expectEqual(@as(u32, 0), try pool.getRefcount(id));
    // A new entry in the same slot has a new generation and never answers for the old id.
    const reused = try pool.acquireFragment("https://example.com/reused", 9);
    defer pool.decref(reused) catch unreachable;
    try std.testing.expect(reused != id);
    try std.testing.expectEqual(@as(u32, 9), try pool.getKey(reused));
}

test "LinkPool - fragment acquisition rolls back first-use allocation failures" {
    var fail_offset: usize = 0;
    while (fail_offset < 16) : (fail_offset += 1) {
        var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        var pool = LinkPool.init(failing.allocator());
        defer pool.deinit();
        failing.fail_index = fail_offset;
        const result = pool.acquireFragment("", 11);
        failing.fail_index = std.math.maxInt(usize);
        if (result) |id| {
            try std.testing.expect(!failing.has_induced_failure);
            try pool.decref(id);
        } else |err| {
            try std.testing.expectEqual(error.OutOfMemory, err);
        }
        try std.testing.expectEqual(@as(u64, 0), pool.getLiveSlotCount());
        try std.testing.expectEqual(@as(u32, 0), pool.interned_live_ids.count());
        if (result) |_| break else |_| {}
    }
    try std.testing.expect(fail_offset < 16);
}

test "LinkTracker - fragment membership is per (url, key) entry" {
    var pool = LinkPool.init(std.testing.allocator);
    defer pool.deinit();
    var tracker = LinkTracker.init(std.testing.allocator, &pool);
    defer tracker.deinit();
    const a = try tracker.trackFragment("https://example.com/t", 1);
    try std.testing.expectEqual(a, try tracker.trackFragment("https://example.com/t", 1));
    const b = try tracker.trackFragment("https://example.com/t", 2);
    const url_only = try tracker.trackUrl("https://example.com/t");
    try std.testing.expect(a != b and a != url_only and b != url_only);
    try std.testing.expectEqual(@as(u32, 3), tracker.getLinkCount());
    for ([_]u32{ a, b, url_only }) |id| try std.testing.expectEqual(@as(u32, 1), try pool.getRefcount(id));
    tracker.clear();
    try std.testing.expectEqual(@as(u64, 0), pool.getLiveSlotCount());
}
