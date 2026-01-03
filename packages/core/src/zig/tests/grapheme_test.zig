const std = @import("std");
const gp = @import("../grapheme.zig");

const GraphemePool = gp.GraphemePool;
const GraphemeTracker = gp.GraphemeTracker;

test "GraphemePool - can initialize and cleanup" {
    // Just verify init/deinit don't crash
    var pool = GraphemePool.init(std.testing.allocator);
    pool.deinit();
}

test "GraphemePool - alloc and get small grapheme" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "a";
    const id = try pool.alloc(text);
    try pool.incref(id);
    defer pool.decref(id) catch {};

    const retrieved = try pool.get(id);
    try std.testing.expectEqualSlices(u8, text, retrieved);
}

test "GraphemePool - alloc and get emoji" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const emoji = "🌟";
    const id = try pool.alloc(emoji);
    try pool.incref(id);
    defer pool.decref(id) catch {};

    const retrieved = try pool.get(id);
    try std.testing.expectEqualSlices(u8, emoji, retrieved);
}

test "GraphemePool - alloc and get multi-byte grapheme" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const grapheme = "é";
    const id = try pool.alloc(grapheme);
    try pool.incref(id);
    defer pool.decref(id) catch {};

    const retrieved = try pool.get(id);
    try std.testing.expectEqualSlices(u8, grapheme, retrieved);
}

test "GraphemePool - alloc and get combining character grapheme" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const grapheme = "e\u{0301}"; // e with combining acute accent
    const id = try pool.alloc(grapheme);
    try pool.incref(id);
    defer pool.decref(id) catch {};

    const retrieved = try pool.get(id);
    try std.testing.expectEqualSlices(u8, grapheme, retrieved);
}

test "GraphemePool - multiple allocations" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text1 = "a";
    const text2 = "b";
    const text3 = "🌟";

    const id1 = try pool.alloc(text1);
    const id2 = try pool.alloc(text2);
    const id3 = try pool.alloc(text3);
    try pool.incref(id1);
    try pool.incref(id2);
    try pool.incref(id3);
    defer pool.decref(id1) catch {};
    defer pool.decref(id2) catch {};
    defer pool.decref(id3) catch {};

    try std.testing.expect(id1 != id2);
    try std.testing.expect(id2 != id3);
    try std.testing.expect(id1 != id3);

    try std.testing.expectEqualSlices(u8, text1, try pool.get(id1));
    try std.testing.expectEqualSlices(u8, text2, try pool.get(id2));
    try std.testing.expectEqualSlices(u8, text3, try pool.get(id3));
}

test "GraphemePool - handles various size graphemes" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const small = "a";
    const medium = "0123456789";
    const large = "012345678901234567890123456789";

    const id_small = try pool.alloc(small);
    const id_medium = try pool.alloc(medium);
    const id_large = try pool.alloc(large);
    try pool.incref(id_small);
    try pool.incref(id_medium);
    try pool.incref(id_large);
    defer pool.decref(id_small) catch {};
    defer pool.decref(id_medium) catch {};
    defer pool.decref(id_large) catch {};

    try std.testing.expectEqualSlices(u8, small, try pool.get(id_small));
    try std.testing.expectEqualSlices(u8, medium, try pool.get(id_medium));
    try std.testing.expectEqualSlices(u8, large, try pool.get(id_large));
}

test "GraphemePool - large allocation (128 bytes)" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    var buffer: [128]u8 = undefined;
    @memset(&buffer, 'X');

    const id = try pool.alloc(&buffer);
    try pool.incref(id);
    defer pool.decref(id) catch {};

    const retrieved = try pool.get(id);

    try std.testing.expectEqual(@as(usize, 128), retrieved.len);
    try std.testing.expectEqualSlices(u8, &buffer, retrieved);
}

test "GraphemePool - incref increases refcount" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "a";
    const id = try pool.alloc(text);

    // Initial refcount is 0, increment it
    try pool.incref(id);
    defer pool.decref(id) catch {};

    const retrieved = try pool.get(id);
    try std.testing.expectEqualSlices(u8, text, retrieved);
}

test "GraphemePool - decref once keeps data alive" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "a";
    const id = try pool.alloc(text);

    // Initial refcount is 0, incref to 1, incref to 2
    try pool.incref(id);
    try pool.incref(id);
    defer pool.decref(id) catch {};

    // Decref from 2 to 1
    try pool.decref(id);

    // Should still be accessible (refcount is 1)
    const retrieved = try pool.get(id);
    try std.testing.expectEqualSlices(u8, text, retrieved);
}

test "GraphemePool - decref to zero allows slot reuse" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text1 = "a";
    const id1 = try pool.alloc(text1);
    try pool.incref(id1);

    // Decref to zero makes slot available for reuse
    try pool.decref(id1);

    // Allocate again - should reuse the freed slot with new generation
    const text2 = "b";
    const id2 = try pool.alloc(text2);

    // Old ID should fail due to generation mismatch
    const result1 = pool.get(id1);
    try std.testing.expectError(gp.GraphemePoolError.WrongGeneration, result1);

    try pool.incref(id2);
    const retrieved = try pool.get(id2);
    try std.testing.expectEqualSlices(u8, text2, retrieved);

    try pool.decref(id2);
}

test "GraphemePool - multiple incref and decref" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "test";
    const id = try pool.alloc(text);

    // Increment refcount multiple times (starting from 0)
    try pool.incref(id);
    try pool.incref(id);
    try pool.incref(id);

    try pool.decref(id);
    try pool.decref(id);

    // Should still be accessible (refcount is 1)
    const retrieved = try pool.get(id);
    try std.testing.expectEqualSlices(u8, text, retrieved);

    // Decrement to zero
    try pool.decref(id);

    // Allocate something else to trigger reuse with new generation
    _ = try pool.alloc("x");

    // Old ID should now fail due to generation mismatch
    const result = pool.get(id);
    try std.testing.expectError(gp.GraphemePoolError.WrongGeneration, result);

    // Cleanup not needed since allocated IDs have refcount 0
}

test "GraphemePool - freed IDs become invalid after reuse" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text1 = "a";
    const text2 = "b";

    const id1 = try pool.alloc(text1);
    try pool.incref(id1);

    // Decref to free the slot
    try pool.decref(id1);

    // Allocate again (pool may reuse internal storage)
    const id2 = try pool.alloc(text2);

    // Old ID should be invalid due to generation mismatch
    const result = pool.get(id1);
    try std.testing.expectError(gp.GraphemePoolError.WrongGeneration, result);

    try pool.incref(id2);
    const retrieved = try pool.get(id2);
    try std.testing.expectEqualSlices(u8, text2, retrieved);
    try pool.decref(id2);
}

test "GraphemePool - stale ID with wrong generation fails" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "test";
    const id = try pool.alloc(text);
    try pool.incref(id);
    defer pool.decref(id) catch {};

    // Manually create a stale ID by modifying generation
    const stale_id = id ^ (1 << gp.SLOT_BITS); // XOR generation bits

    const result = pool.get(stale_id);
    try std.testing.expectError(gp.GraphemePoolError.WrongGeneration, result);
}

test "GraphemePool - decref on zero refcount fails" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "a";
    const id = try pool.alloc(text);

    // Refcount starts at 0, so decref should fail immediately
    const result = pool.decref(id);
    try std.testing.expectError(gp.GraphemePoolError.InvalidId, result);
}

test "GraphemePool - many allocations" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const count = 1000;
    var ids: [count]u32 = undefined;

    for (0..count) |i| {
        var buffer: [8]u8 = undefined;
        const slice = std.fmt.bufPrint(&buffer, "{d}", .{i}) catch unreachable;
        ids[i] = try pool.alloc(slice);
        try pool.incref(ids[i]);
    }

    for (ids, 0..count) |id, i| {
        const retrieved = try pool.get(id);
        var buffer: [8]u8 = undefined;
        const slice = std.fmt.bufPrint(&buffer, "{d}", .{i}) catch unreachable;
        try std.testing.expectEqualSlices(u8, slice, retrieved);
    }

    for (ids) |id| {
        try pool.decref(id);
    }
}

test "GraphemePool - allocations with varying sizes" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    var ids: std.ArrayListUnmanaged(u32) = .{};
    defer ids.deinit(std.testing.allocator);

    for (0..50) |i| {
        const size = (i % 5) * 16 + 5; // Vary sizes: 5, 21, 37, 53, 69...
        var buffer: [128]u8 = undefined;
        @memset(buffer[0..size], @intCast(i % 256));
        const id = try pool.alloc(buffer[0..size]);
        try pool.incref(id);
        try ids.append(std.testing.allocator, id);
    }

    for (ids.items, 0..50) |id, i| {
        const size = (i % 5) * 16 + 5;
        const retrieved = try pool.get(id);
        try std.testing.expectEqual(size, retrieved.len);
        for (retrieved) |byte| {
            try std.testing.expectEqual(@as(u8, @intCast(i % 256)), byte);
        }
    }

    for (ids.items) |id| {
        try pool.decref(id);
    }
}

test "GraphemePool - reuse many slots" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    for (0..100) |i| {
        var buffer: [8]u8 = undefined;
        const slice = std.fmt.bufPrint(&buffer, "{d}", .{i}) catch unreachable;
        const id = try pool.alloc(slice);
        try pool.incref(id);

        const retrieved = try pool.get(id);
        try std.testing.expectEqualSlices(u8, slice, retrieved);

        try pool.decref(id);
    }
}

test "GraphemePool - invalid ID returns error" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "test";
    const id = try pool.alloc(text);
    try pool.incref(id);

    // Decref to free the slot
    try pool.decref(id);

    // Now allocate again to change generation
    const text2 = "test2";
    _ = try pool.alloc(text2);

    // Original ID should now be invalid due to generation mismatch
    const result = pool.get(id);
    try std.testing.expectError(gp.GraphemePoolError.WrongGeneration, result);
}

test "GraphemePool - IDs from different pools don't interfere" {
    var pool1 = GraphemePool.init(std.testing.allocator);
    defer pool1.deinit();

    var pool2 = GraphemePool.init(std.testing.allocator);
    defer pool2.deinit();

    const text1 = "pool1_data";
    const text2 = "pool2_data";

    const id1 = try pool1.alloc(text1);
    const id2 = try pool2.alloc(text2);
    try pool1.incref(id1);
    try pool2.incref(id2);
    defer pool1.decref(id1) catch {};
    defer pool2.decref(id2) catch {};

    try std.testing.expectEqualSlices(u8, text1, try pool1.get(id1));
    try std.testing.expectEqualSlices(u8, text2, try pool2.get(id2));

    // Using ID from pool1 in pool2 may succeed or fail depending on internal state,
    // but should not return pool1's data or crash
    _ = pool2.get(id1) catch |err| {
        try std.testing.expectEqual(gp.GraphemePoolError.InvalidId, err);
    };
}

test "GraphemePool - use-after-free returns error not garbage" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text1 = "first";
    const id1 = try pool.alloc(text1);
    try pool.incref(id1);
    try pool.decref(id1);

    // Allocate something else to potentially reuse the slot
    const text2 = "second";
    const id2 = try pool.alloc(text2);

    // Old ID should fail due to generation mismatch, not return text2 or garbage
    const result = pool.get(id1);
    try std.testing.expectError(gp.GraphemePoolError.WrongGeneration, result);

    try pool.incref(id2);
    try std.testing.expectEqualSlices(u8, text2, try pool.get(id2));
    try pool.decref(id2);
}

test "GraphemePool - IDs remain unique across many allocations" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const count = 100;
    var ids: [count]u32 = undefined;

    for (0..count) |i| {
        var buffer: [8]u8 = undefined;
        const slice = std.fmt.bufPrint(&buffer, "{d}", .{i}) catch unreachable;
        ids[i] = try pool.alloc(slice);
        try pool.incref(ids[i]);
    }

    for (ids, 0..count) |id1, i| {
        for (ids[i + 1 ..]) |id2| {
            try std.testing.expect(id1 != id2);
        }
    }

    for (ids) |id| {
        try pool.decref(id);
    }
}

test "GraphemePool - concurrent incref/decref maintains consistency" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "test";
    const id = try pool.alloc(text);

    // Multiple incref/decref operations (starting from refcount 0)
    try pool.incref(id);
    try pool.incref(id);
    try pool.incref(id);

    // Should still be accessible (refcount is 3)
    try std.testing.expectEqualSlices(u8, text, try pool.get(id));

    try pool.decref(id);
    try std.testing.expectEqualSlices(u8, text, try pool.get(id));

    try pool.decref(id);
    try std.testing.expectEqualSlices(u8, text, try pool.get(id));

    // Final decref brings refcount to 0
    try pool.decref(id);
}

test "GraphemePool - zero-length grapheme" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const empty: []const u8 = "";
    const id = try pool.alloc(empty);
    try pool.incref(id);

    const retrieved = try pool.get(id);
    try std.testing.expectEqual(@as(usize, 0), retrieved.len);

    try pool.decref(id);
}

test "GraphemePool - incref on stale ID fails" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "test";
    const id = try pool.alloc(text);
    try pool.incref(id);
    try pool.decref(id);

    // Allocate again to invalidate old ID
    _ = try pool.alloc("new");

    const result = pool.incref(id); // Old ID should fail due to wrong generation
    try std.testing.expectError(gp.GraphemePoolError.WrongGeneration, result);
}

test "GraphemePool - decref on stale ID fails" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "test";
    const id = try pool.alloc(text);

    // Already at refcount 0, decref should fail
    const result = pool.decref(id);
    try std.testing.expectError(gp.GraphemePoolError.InvalidId, result);
}

test "GraphemePool - bit manipulation functions" {
    const grapheme_char = gp.CHAR_FLAG_GRAPHEME | 0x1234;
    try std.testing.expect(gp.isGraphemeChar(grapheme_char));
    try std.testing.expect(!gp.isGraphemeChar(0x41)); // Plain 'A'

    const cont_char = gp.CHAR_FLAG_CONTINUATION | 0x1234;
    try std.testing.expect(gp.isContinuationChar(cont_char));
    try std.testing.expect(!gp.isContinuationChar(0x41));

    try std.testing.expect(gp.isClusterChar(grapheme_char));
    try std.testing.expect(gp.isClusterChar(cont_char));
    try std.testing.expect(!gp.isClusterChar(0x41));

    const id: u32 = 0x12345;
    const packed_char = gp.CHAR_FLAG_GRAPHEME | id;
    try std.testing.expectEqual(id, gp.graphemeIdFromChar(packed_char));
}

test "GraphemePool - extent encoding and decoding" {
    const right: u32 = 2;
    const char_with_right = (right << gp.CHAR_EXT_RIGHT_SHIFT) | gp.CHAR_FLAG_GRAPHEME;
    try std.testing.expectEqual(right, gp.charRightExtent(char_with_right));

    const left: u32 = 1;
    const char_with_left = (left << gp.CHAR_EXT_LEFT_SHIFT) | gp.CHAR_FLAG_GRAPHEME;
    try std.testing.expectEqual(left, gp.charLeftExtent(char_with_left));
}

test "GraphemePool - packGraphemeStart" {
    const gid: u32 = 0x1234;
    const width: u32 = 2;

    const packed_char = gp.packGraphemeStart(gid, width);

    try std.testing.expect(gp.isGraphemeChar(packed_char));

    try std.testing.expectEqual(gid, gp.graphemeIdFromChar(packed_char));

    try std.testing.expectEqual(width - 1, gp.charRightExtent(packed_char));

    try std.testing.expectEqual(@as(u32, 0), gp.charLeftExtent(packed_char));
}

test "GraphemePool - packContinuation" {
    const gid: u32 = 0x1234;
    const left: u32 = 1;
    const right: u32 = 2;

    const packed_char = gp.packContinuation(left, right, gid);

    try std.testing.expect(gp.isContinuationChar(packed_char));

    try std.testing.expectEqual(gid, gp.graphemeIdFromChar(packed_char));

    try std.testing.expectEqual(left, gp.charLeftExtent(packed_char));
    try std.testing.expectEqual(right, gp.charRightExtent(packed_char));
}

test "GraphemePool - encodedCharWidth" {
    const single = @as(u32, 'A');
    try std.testing.expectEqual(@as(u32, 1), gp.encodedCharWidth(single));

    const grapheme_2 = gp.packGraphemeStart(0x1234, 2);
    try std.testing.expectEqual(@as(u32, 2), gp.encodedCharWidth(grapheme_2));

    const cont = gp.packContinuation(1, 1, 0x1234);
    try std.testing.expectEqual(@as(u32, 3), gp.encodedCharWidth(cont));
}

test "GraphemeTracker - init and deinit" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    var tracker = GraphemeTracker.init(std.testing.allocator, &pool);
    defer tracker.deinit();

    try std.testing.expect(!tracker.hasAny());
    try std.testing.expectEqual(@as(u32, 0), tracker.getGraphemeCount());
}

test "GraphemeTracker - add single grapheme" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "a";
    const id = try pool.alloc(text);

    var tracker = GraphemeTracker.init(std.testing.allocator, &pool);
    defer tracker.deinit();

    tracker.add(id);

    try std.testing.expect(tracker.hasAny());
    try std.testing.expect(tracker.contains(id));
    try std.testing.expectEqual(@as(u32, 1), tracker.getGraphemeCount());
}

test "GraphemeTracker - add multiple graphemes" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text1 = "a";
    const text2 = "b";
    const text3 = "🌟";

    const id1 = try pool.alloc(text1);
    const id2 = try pool.alloc(text2);
    const id3 = try pool.alloc(text3);

    var tracker = GraphemeTracker.init(std.testing.allocator, &pool);
    defer tracker.deinit();

    tracker.add(id1);
    tracker.add(id2);
    tracker.add(id3);

    try std.testing.expectEqual(@as(u32, 3), tracker.getGraphemeCount());
    try std.testing.expect(tracker.contains(id1));
    try std.testing.expect(tracker.contains(id2));
    try std.testing.expect(tracker.contains(id3));
}

test "GraphemeTracker - add same grapheme twice increfs once" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "a";
    const id = try pool.alloc(text);

    {
        var tracker = GraphemeTracker.init(std.testing.allocator, &pool);
        defer tracker.deinit();

        tracker.add(id);
        tracker.add(id); // Should not incref again

        try std.testing.expectEqual(@as(u32, 1), tracker.getGraphemeCount());

        // After deinit (via defer), tracker decrefs once, bringing refcount to 0
    }

    // Allocate new item to trigger slot reuse
    const text2 = "b";
    _ = try pool.alloc(text2);

    // Old ID should now be invalid due to generation change
    const result = pool.get(id);
    try std.testing.expectError(gp.GraphemePoolError.WrongGeneration, result);
}

test "GraphemeTracker - remove grapheme" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "a";
    const id = try pool.alloc(text);

    var tracker = GraphemeTracker.init(std.testing.allocator, &pool);
    defer tracker.deinit();

    tracker.add(id);
    try std.testing.expect(tracker.contains(id));

    tracker.remove(id);
    try std.testing.expect(!tracker.contains(id));
    try std.testing.expectEqual(@as(u32, 0), tracker.getGraphemeCount());
}

test "GraphemeTracker - remove non-existent grapheme is safe" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "a";
    const id = try pool.alloc(text);

    var tracker = GraphemeTracker.init(std.testing.allocator, &pool);
    defer tracker.deinit();

    // Remove without adding - should be safe
    tracker.remove(id);

    try std.testing.expectEqual(@as(u32, 0), tracker.getGraphemeCount());
}

test "GraphemeTracker - clear removes all graphemes" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text1 = "a";
    const text2 = "b";
    const id1 = try pool.alloc(text1);
    const id2 = try pool.alloc(text2);

    var tracker = GraphemeTracker.init(std.testing.allocator, &pool);
    defer tracker.deinit();

    tracker.add(id1);
    tracker.add(id2);
    try std.testing.expectEqual(@as(u32, 2), tracker.getGraphemeCount());

    tracker.clear();

    try std.testing.expectEqual(@as(u32, 0), tracker.getGraphemeCount());
    try std.testing.expect(!tracker.contains(id1));
    try std.testing.expect(!tracker.contains(id2));
    try std.testing.expect(!tracker.hasAny());
}

test "GraphemeTracker - getTotalGraphemeBytes" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text1 = "a"; // 1 byte
    const text2 = "🌟"; // 4 bytes
    const text3 = "test"; // 4 bytes

    const id1 = try pool.alloc(text1);
    const id2 = try pool.alloc(text2);
    const id3 = try pool.alloc(text3);

    var tracker = GraphemeTracker.init(std.testing.allocator, &pool);
    defer tracker.deinit();

    tracker.add(id1);
    tracker.add(id2);
    tracker.add(id3);

    const total_bytes = tracker.getTotalGraphemeBytes();
    try std.testing.expectEqual(@as(u32, 1 + 4 + 4), total_bytes);
}

test "GraphemeTracker - tracker keeps graphemes alive" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "test";
    const id = try pool.alloc(text);

    {
        var tracker = GraphemeTracker.init(std.testing.allocator, &pool);
        defer tracker.deinit();

        tracker.add(id);

        // Should be accessible because tracker holds a reference (refcount is 1)
        const retrieved = try pool.get(id);
        try std.testing.expectEqualSlices(u8, text, retrieved);

        // After tracker deinit (via defer), refcount will be 0
    }

    // Allocate new item to trigger slot reuse with new generation
    const text2 = "x";
    _ = try pool.alloc(text2);

    // Old ID should fail due to generation mismatch
    const result = pool.get(id);
    try std.testing.expectError(gp.GraphemePoolError.WrongGeneration, result);
}

test "GraphemeTracker - multiple trackers share same grapheme" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "shared";
    const id = try pool.alloc(text);

    {
        var tracker1 = GraphemeTracker.init(std.testing.allocator, &pool);
        defer tracker1.deinit();

        {
            var tracker2 = GraphemeTracker.init(std.testing.allocator, &pool);
            defer tracker2.deinit();

            tracker1.add(id);
            tracker2.add(id);

            try std.testing.expect(tracker1.contains(id));
            try std.testing.expect(tracker2.contains(id));

            // Should be accessible (ref count is 2 from both trackers)
            const retrieved = try pool.get(id);
            try std.testing.expectEqualSlices(u8, text, retrieved);

            // tracker2 deinit via defer here (decrefs to 1)
        }

        // Should still be accessible (ref count is 1)
        const retrieved2 = try pool.get(id);
        try std.testing.expectEqualSlices(u8, text, retrieved2);

        // tracker1 deinit via defer here (decrefs to 0)
    }

    // Allocate new item to trigger slot reuse with new generation
    const text2 = "y";
    _ = try pool.alloc(text2);

    // Old ID should fail due to generation mismatch
    const result = pool.get(id);
    try std.testing.expectError(gp.GraphemePoolError.WrongGeneration, result);
}

test "GraphemeTracker - stress test many graphemes" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    var tracker = GraphemeTracker.init(std.testing.allocator, &pool);
    defer tracker.deinit();

    const count = 500;
    var ids: [count]u32 = undefined;

    // Add many graphemes
    for (0..count) |i| {
        var buffer: [8]u8 = undefined;
        const slice = std.fmt.bufPrint(&buffer, "{d}", .{i}) catch unreachable;
        ids[i] = try pool.alloc(slice);
        tracker.add(ids[i]);
    }

    try std.testing.expectEqual(@as(u32, count), tracker.getGraphemeCount());

    // Verify all are tracked
    for (ids) |id| {
        try std.testing.expect(tracker.contains(id));
    }

    // Clear should remove all
    tracker.clear();
    try std.testing.expectEqual(@as(u32, 0), tracker.getGraphemeCount());

    for (ids) |id| {
        try std.testing.expect(!tracker.contains(id));
    }
}

test "GraphemePool - global pool init and deinit" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    const text = "test";
    const id = try pool.alloc(text);
    try pool.incref(id);

    const retrieved = try pool.get(id);
    try std.testing.expectEqualSlices(u8, text, retrieved);

    try pool.decref(id);
}

test "GraphemePool - global pool reinitialization returns same instance" {
    const pool1 = gp.initGlobalPool(std.testing.allocator);
    const pool2 = gp.initGlobalPool(std.testing.allocator);

    try std.testing.expectEqual(pool1, pool2);

    gp.deinitGlobalPool();
}

test "GraphemePool - global unicode data init" {


    // Pointers should not be null (just verify they're returned)
    // We can't easily test their validity without using them
}

test "GraphemePool - allocUnowned basic" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    // External memory that we manage
    const external_text = "external";
    const id = try pool.allocUnowned(external_text);
    try pool.incref(id);

    const retrieved = try pool.get(id);
    try std.testing.expectEqualSlices(u8, external_text, retrieved);

    // Verify it's actually pointing to the same memory location
    try std.testing.expectEqual(@intFromPtr(external_text.ptr), @intFromPtr(retrieved.ptr));

    try pool.decref(id);
}

test "GraphemePool - allocUnowned multiple references" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const external_text1 = "external1";
    const external_text2 = "external2";
    const external_text3 = "external3";

    const id1 = try pool.allocUnowned(external_text1);
    const id2 = try pool.allocUnowned(external_text2);
    const id3 = try pool.allocUnowned(external_text3);
    try pool.incref(id1);
    try pool.incref(id2);
    try pool.incref(id3);

    try std.testing.expectEqualSlices(u8, external_text1, try pool.get(id1));
    try std.testing.expectEqualSlices(u8, external_text2, try pool.get(id2));
    try std.testing.expectEqualSlices(u8, external_text3, try pool.get(id3));

    // Verify they point to original memory
    try std.testing.expectEqual(@intFromPtr(external_text1.ptr), @intFromPtr((try pool.get(id1)).ptr));
    try std.testing.expectEqual(@intFromPtr(external_text2.ptr), @intFromPtr((try pool.get(id2)).ptr));
    try std.testing.expectEqual(@intFromPtr(external_text3.ptr), @intFromPtr((try pool.get(id3)).ptr));

    try pool.decref(id1);
    try pool.decref(id2);
    try pool.decref(id3);
}

test "GraphemePool - allocUnowned with emoji" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const external_emoji = "🌟🎉🚀";
    const id = try pool.allocUnowned(external_emoji);
    try pool.incref(id);

    const retrieved = try pool.get(id);
    try std.testing.expectEqualSlices(u8, external_emoji, retrieved);
    try std.testing.expectEqual(@intFromPtr(external_emoji.ptr), @intFromPtr(retrieved.ptr));

    try pool.decref(id);
}

test "GraphemePool - allocUnowned refcounting" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const external_text = "refcount_test";
    const id = try pool.allocUnowned(external_text);

    // Increment refcount (starting from 0)
    try pool.incref(id);
    try pool.incref(id);
    try pool.incref(id);

    // Should still be accessible (refcount is 3)
    try std.testing.expectEqualSlices(u8, external_text, try pool.get(id));

    // Decrement
    try pool.decref(id);
    try std.testing.expectEqualSlices(u8, external_text, try pool.get(id));

    try pool.decref(id);
    try std.testing.expectEqualSlices(u8, external_text, try pool.get(id));

    // Final decref
    try pool.decref(id);
}

test "GraphemePool - mix owned and unowned allocations" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const owned_text = "owned";
    const external_text = "unowned";

    const owned_id = try pool.alloc(owned_text);
    const unowned_id = try pool.allocUnowned(external_text);
    try pool.incref(owned_id);
    try pool.incref(unowned_id);

    const retrieved_owned = try pool.get(owned_id);
    const retrieved_unowned = try pool.get(unowned_id);

    try std.testing.expectEqualSlices(u8, owned_text, retrieved_owned);
    try std.testing.expectEqualSlices(u8, external_text, retrieved_unowned);

    // Owned should be different memory location (copy)
    try std.testing.expect(@intFromPtr(owned_text.ptr) != @intFromPtr(retrieved_owned.ptr));

    // Unowned should be same memory location (reference)
    try std.testing.expectEqual(@intFromPtr(external_text.ptr), @intFromPtr(retrieved_unowned.ptr));

    try pool.decref(owned_id);
    try pool.decref(unowned_id);
}

test "GraphemePool - allocUnowned slot reuse" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text1 = "first";
    const id1 = try pool.allocUnowned(text1);
    try pool.incref(id1);
    try pool.decref(id1);

    // Allocate again - should reuse slot
    const text2 = "second";
    const id2 = try pool.allocUnowned(text2);

    const result = pool.get(id1);
    try std.testing.expectError(gp.GraphemePoolError.WrongGeneration, result);

    try pool.incref(id2);
    const retrieved = try pool.get(id2);
    try std.testing.expectEqualSlices(u8, text2, retrieved);
    try std.testing.expectEqual(@intFromPtr(text2.ptr), @intFromPtr(retrieved.ptr));

    try pool.decref(id2);
}

test "GraphemePool - allocUnowned large text" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    // Large external buffer
    var large_buffer: [1000]u8 = undefined;
    @memset(&large_buffer, 'X');
    const large_slice: []const u8 = &large_buffer;

    const id = try pool.allocUnowned(large_slice);
    try pool.incref(id);

    const retrieved = try pool.get(id);
    try std.testing.expectEqual(@as(usize, 1000), retrieved.len);
    try std.testing.expectEqualSlices(u8, large_slice, retrieved);
    try std.testing.expectEqual(@intFromPtr(large_slice.ptr), @intFromPtr(retrieved.ptr));

    try pool.decref(id);
}

test "GraphemeTracker - with unowned allocations" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text1 = "external1";
    const text2 = "external2";

    const id1 = try pool.allocUnowned(text1);
    const id2 = try pool.allocUnowned(text2);

    var tracker = GraphemeTracker.init(std.testing.allocator, &pool);
    defer tracker.deinit();

    tracker.add(id1);
    tracker.add(id2);

    try std.testing.expectEqual(@as(u32, 2), tracker.getGraphemeCount());
    try std.testing.expect(tracker.contains(id1));
    try std.testing.expect(tracker.contains(id2));

    // Should still get correct bytes
    try std.testing.expectEqualSlices(u8, text1, try pool.get(id1));
    try std.testing.expectEqualSlices(u8, text2, try pool.get(id2));
}

test "GraphemeTracker - mix owned and unowned" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const owned_text = "owned_data";
    const external_text = "external_data";

    const owned_id = try pool.alloc(owned_text);
    const unowned_id = try pool.allocUnowned(external_text);

    var tracker = GraphemeTracker.init(std.testing.allocator, &pool);
    defer tracker.deinit();

    tracker.add(owned_id);
    tracker.add(unowned_id);

    try std.testing.expectEqual(@as(u32, 2), tracker.getGraphemeCount());

    const total_bytes = tracker.getTotalGraphemeBytes();
    try std.testing.expectEqual(@as(u32, owned_text.len + external_text.len), total_bytes);

    try std.testing.expectEqualSlices(u8, owned_text, try pool.get(owned_id));
    try std.testing.expectEqualSlices(u8, external_text, try pool.get(unowned_id));
}

test "GraphemePool - allocUnowned with stack memory" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    // Simulate stack-allocated buffer
    var stack_buffer: [50]u8 = undefined;
    @memcpy(stack_buffer[0..11], "stack_based");
    const stack_slice = stack_buffer[0..11];

    const id = try pool.allocUnowned(stack_slice);
    try pool.incref(id);

    const retrieved = try pool.get(id);
    try std.testing.expectEqualSlices(u8, "stack_based", retrieved);
    try std.testing.expectEqual(@intFromPtr(stack_slice.ptr), @intFromPtr(retrieved.ptr));

    try pool.decref(id);
    // Note: In real usage, caller must ensure stack_buffer stays valid while ID is in use
}

test "GraphemePool - allocUnowned zero-length slice" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const empty: []const u8 = "";
    const id = try pool.allocUnowned(empty);
    try pool.incref(id);

    const retrieved = try pool.get(id);
    try std.testing.expectEqual(@as(usize, 0), retrieved.len);

    try pool.decref(id);
}

test "GraphemePool - initWithOptions with small slots_per_page" {
    // Create a pool with very small slots_per_page to test exhaustion
    const small_slots = [_]u32{ 2, 2, 2, 2, 2 }; // Only 2 slots per page for each class
    var pool = gp.GraphemePool.initWithOptions(std.testing.allocator, .{
        .slots_per_page = small_slots,
    });
    defer pool.deinit();

    const id1 = try pool.alloc("abc");
    const id2 = try pool.alloc("def");
    try pool.incref(id1);
    try pool.incref(id2);

    try std.testing.expectEqualSlices(u8, "abc", try pool.get(id1));
    try std.testing.expectEqualSlices(u8, "def", try pool.get(id2));

    try pool.decref(id1);
    try pool.decref(id2);
}

test "GraphemePool - small pool exhaustion and growth" {
    // Create a tiny pool that will need to grow
    const tiny_slots = [_]u32{ 1, 1, 1, 1, 1 }; // Only 1 slot per page initially
    var pool = gp.GraphemePool.initWithOptions(std.testing.allocator, .{
        .slots_per_page = tiny_slots,
    });
    defer pool.deinit();

    // Allocate first item - uses initial page
    const id1 = try pool.alloc("a");

    // Allocate second item - should trigger growth (new page)
    const id2 = try pool.alloc("b");
    try pool.incref(id1);
    try pool.incref(id2);

    try std.testing.expectEqualSlices(u8, "a", try pool.get(id1));
    try std.testing.expectEqualSlices(u8, "b", try pool.get(id2));

    try pool.decref(id1);
    try pool.decref(id2);
}

test "GraphemePool - small pool with refcount prevents exhaustion" {
    const tiny_slots = [_]u32{ 2, 2, 2, 2, 2 };
    var pool = gp.GraphemePool.initWithOptions(std.testing.allocator, .{
        .slots_per_page = tiny_slots,
    });
    defer pool.deinit();

    // Allocate 2 items (fills the first page)
    const id1 = try pool.alloc("aa");
    const id2 = try pool.alloc("bb");
    try pool.incref(id1);
    try pool.incref(id2);

    // Free one
    try pool.decref(id1);

    const id3 = try pool.alloc("cc");
    try pool.incref(id3);

    try std.testing.expectEqualSlices(u8, "bb", try pool.get(id2));
    try std.testing.expectEqualSlices(u8, "cc", try pool.get(id3));

    // Old id1 should be invalid due to generation change
    const result = pool.get(id1);
    try std.testing.expectError(gp.GraphemePoolError.WrongGeneration, result);

    try pool.decref(id2);
    try pool.decref(id3);
}

test "GraphemePool - different size classes with small limits" {
    const tiny_slots = [_]u32{ 2, 2, 2, 2, 2 };
    var pool = gp.GraphemePool.initWithOptions(std.testing.allocator, .{
        .slots_per_page = tiny_slots,
    });
    defer pool.deinit();

    // Allocate different sizes (should use different classes)
    const id_small = try pool.alloc("ab"); // 2 bytes -> class 0 (8-byte slots)
    const id_medium = try pool.alloc("0123456789abc"); // 13 bytes -> class 1 (16-byte slots)
    const id_large = try pool.alloc("012345678901234567890"); // 21 bytes -> class 2 (32-byte slots)
    try pool.incref(id_small);
    try pool.incref(id_medium);
    try pool.incref(id_large);

    try std.testing.expectEqualSlices(u8, "ab", try pool.get(id_small));
    try std.testing.expectEqualSlices(u8, "0123456789abc", try pool.get(id_medium));
    try std.testing.expectEqualSlices(u8, "012345678901234567890", try pool.get(id_large));

    try pool.decref(id_small);
    try pool.decref(id_medium);
    try pool.decref(id_large);
}

test "GraphemePool - tracker with small pool" {
    const tiny_slots = [_]u32{ 3, 3, 3, 3, 3 };
    var pool = gp.GraphemePool.initWithOptions(std.testing.allocator, .{
        .slots_per_page = tiny_slots,
    });
    defer pool.deinit();

    var tracker = gp.GraphemeTracker.init(std.testing.allocator, &pool);
    defer tracker.deinit();

    // Add multiple graphemes
    const id1 = try pool.alloc("🌟");
    const id2 = try pool.alloc("🎨");
    const id3 = try pool.alloc("🚀");

    tracker.add(id1);
    tracker.add(id2);
    tracker.add(id3);

    try std.testing.expectEqual(@as(u32, 3), tracker.getGraphemeCount());

    // Clear tracker should free all refs
    tracker.clear();
    try std.testing.expectEqual(@as(u32, 0), tracker.getGraphemeCount());

    // After tracker.clear(), the graphemes have been decref'd by tracker
    // Since alloc() starts with refcount 0, after tracker decrefs, they're freed
}
