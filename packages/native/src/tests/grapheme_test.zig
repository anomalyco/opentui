const std = @import("std");
const gp = @import("../grapheme.zig");

const GraphemePool = gp.GraphemePool;
const GraphemeTracker = gp.GraphemeTracker;

test "image cell markers use the unused character tag" {
    const marker = gp.packImageCell(12345, 9);
    try std.testing.expect(gp.isImageChar(marker));
    try std.testing.expect(!gp.isGraphemeChar(marker));
    try std.testing.expect(!gp.isContinuationChar(marker));
    try std.testing.expectEqual(@as(u32, 12345), gp.imageIdFromChar(marker));
    try std.testing.expectEqual(@as(u4, 9), gp.imageFallbackFromChar(marker));
}

test "GraphemePool - can initialize and cleanup" {
    // Just verify init/deinit don't crash
    var pool = GraphemePool.init(std.testing.allocator);
    pool.deinit();
}

test "GraphemePool - alloc and get small grapheme" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "a";
    const id = try pool.acquire(text);
    defer pool.decref(id) catch {};

    const retrieved = try pool.get(id);
    try std.testing.expectEqualSlices(u8, text, retrieved);
}

test "GraphemePool - alloc and get emoji" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const emoji = "🌟";
    const id = try pool.acquire(emoji);
    defer pool.decref(id) catch {};

    const retrieved = try pool.get(id);
    try std.testing.expectEqualSlices(u8, emoji, retrieved);
}

test "GraphemePool - alloc and get multi-byte grapheme" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const grapheme = "é";
    const id = try pool.acquire(grapheme);
    defer pool.decref(id) catch {};

    const retrieved = try pool.get(id);
    try std.testing.expectEqualSlices(u8, grapheme, retrieved);
}

test "GraphemePool - alloc and get combining character grapheme" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const grapheme = "e\u{0301}"; // e with combining acute accent
    const id = try pool.acquire(grapheme);
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

    const id1 = try pool.acquire(text1);
    const id2 = try pool.acquire(text2);
    const id3 = try pool.acquire(text3);
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

    const id_small = try pool.acquire(small);
    const id_medium = try pool.acquire(medium);
    const id_large = try pool.acquire(large);
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

    const id = try pool.acquire(&buffer);
    defer pool.decref(id) catch {};

    const retrieved = try pool.get(id);

    try std.testing.expectEqual(@as(usize, 128), retrieved.len);
    try std.testing.expectEqualSlices(u8, &buffer, retrieved);
}

test "GraphemePool - owned grapheme exceeding storage bound returns error" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    var buffer: [129]u8 = undefined;
    @memset(&buffer, 'X');

    try std.testing.expectError(gp.GraphemePoolError.GraphemeTooLong, pool.acquire(&buffer));
}

test "GraphemePool - incref increases refcount" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "a";
    const id = try pool.acquire(text);
    try pool.incref(id);
    defer pool.decref(id) catch {};
    defer pool.decref(id) catch {};

    const retrieved = try pool.get(id);
    try std.testing.expectEqualSlices(u8, text, retrieved);
}

test "GraphemePool - decref once keeps data alive" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "a";
    const id = try pool.acquire(text);
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
    const id1 = try pool.acquire(text1);

    // Decref to zero makes slot available for reuse
    try pool.decref(id1);

    // Allocate again - should reuse the freed slot with new generation
    const text2 = "b";
    const id2 = try pool.acquire(text2);
    defer pool.decref(id2) catch {};

    // Old ID should fail due to generation mismatch
    const result1 = pool.get(id1);
    try std.testing.expectError(gp.GraphemePoolError.WrongGeneration, result1);

    const retrieved = try pool.get(id2);
    try std.testing.expectEqualSlices(u8, text2, retrieved);
}

test "GraphemePool - multiple incref and decref" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "test";
    const id = try pool.acquire(text);

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
    const reused = try pool.acquire("x");
    defer pool.decref(reused) catch {};

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

    const id1 = try pool.acquire(text1);

    // Decref to free the slot
    try pool.decref(id1);

    // Allocate again (pool may reuse internal storage)
    const id2 = try pool.acquire(text2);
    defer pool.decref(id2) catch {};

    // Old ID should be invalid due to generation mismatch
    const result = pool.get(id1);
    try std.testing.expectError(gp.GraphemePoolError.WrongGeneration, result);

    const retrieved = try pool.get(id2);
    try std.testing.expectEqualSlices(u8, text2, retrieved);
}

test "GraphemePool - stale ID with wrong generation fails" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "test";
    const id = try pool.acquire(text);
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
    const id = try pool.acquire(text);
    try pool.decref(id);

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
        ids[i] = try pool.acquire(slice);
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

    var ids: std.ArrayListUnmanaged(u32) = .empty;
    defer ids.deinit(std.testing.allocator);

    for (0..50) |i| {
        const size = (i % 5) * 16 + 5; // Vary sizes: 5, 21, 37, 53, 69...
        var buffer: [128]u8 = undefined;
        @memset(buffer[0..size], @intCast(i % 256));
        const id = try pool.acquire(buffer[0..size]);
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
        const id = try pool.acquire(slice);

        const retrieved = try pool.get(id);
        try std.testing.expectEqualSlices(u8, slice, retrieved);

        try pool.decref(id);
    }
}

test "GraphemePool - invalid ID returns error" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "test";
    const id = try pool.acquire(text);

    // Decref to free the slot
    try pool.decref(id);

    // Now allocate again to change generation
    const text2 = "test2";
    const id2 = try pool.acquire(text2);
    defer pool.decref(id2) catch {};

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

    const id1 = try pool1.acquire(text1);
    const id2 = try pool2.acquire(text2);
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
    const id1 = try pool.acquire(text1);
    try pool.decref(id1);

    // Allocate something else to potentially reuse the slot
    const text2 = "second";
    const id2 = try pool.acquire(text2);
    defer pool.decref(id2) catch {};

    // Old ID should fail due to generation mismatch, not return text2 or garbage
    const result = pool.get(id1);
    try std.testing.expectError(gp.GraphemePoolError.WrongGeneration, result);

    try std.testing.expectEqualSlices(u8, text2, try pool.get(id2));
}

test "GraphemePool - IDs remain unique across many allocations" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const count = 100;
    var ids: [count]u32 = undefined;

    for (0..count) |i| {
        var buffer: [8]u8 = undefined;
        const slice = std.fmt.bufPrint(&buffer, "{d}", .{i}) catch unreachable;
        ids[i] = try pool.acquire(slice);
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
    const id = try pool.acquire(text);

    try pool.incref(id);
    try pool.incref(id);

    try std.testing.expectEqualSlices(u8, text, try pool.get(id));

    try pool.decref(id);
    try std.testing.expectEqualSlices(u8, text, try pool.get(id));

    try pool.decref(id);
    try std.testing.expectEqualSlices(u8, text, try pool.get(id));

    try pool.decref(id);
}

test "GraphemePool - zero-length grapheme" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const empty: []const u8 = "";
    const id = try pool.acquire(empty);

    const retrieved = try pool.get(id);
    try std.testing.expectEqual(@as(usize, 0), retrieved.len);

    try pool.decref(id);
}

test "GraphemePool - incref on stale ID fails" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "test";
    const id = try pool.acquire(text);
    try pool.decref(id);

    // Allocate again to invalidate old ID
    const replacement = try pool.acquire("new");
    defer pool.decref(replacement) catch {};

    const result = pool.incref(id); // Old ID should fail due to wrong generation
    try std.testing.expectError(gp.GraphemePoolError.WrongGeneration, result);
}

test "GraphemePool - decref on stale ID fails" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "test";
    const id = try pool.acquire(text);
    try pool.decref(id);

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

test "GraphemePool - packGraphemeStart saturates wider wcwidth clusters" {
    const packed_char = gp.packGraphemeStart(0x1234, 8);

    try std.testing.expectEqual(gp.CHAR_EXT_MASK, gp.charRightExtent(packed_char));
    try std.testing.expectEqual(gp.CHAR_EXT_MASK + 1, gp.encodedCharWidth(packed_char));
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
    const id = try pool.acquire(text);

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

    const id1 = try pool.acquire(text1);
    const id2 = try pool.acquire(text2);
    const id3 = try pool.acquire(text3);

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
    const id = try pool.acquire(text);

    {
        var tracker = GraphemeTracker.init(std.testing.allocator, &pool);
        defer tracker.deinit();

        tracker.add(id);
        try pool.decref(id);
        tracker.add(id); // Should not incref again

        try std.testing.expectEqual(@as(u32, 1), tracker.getGraphemeCount());
        try std.testing.expectEqual(@as(u32, 2), tracker.getGraphemeCellCount());
        try std.testing.expectEqual(@as(u32, 2), tracker.getTotalGraphemeBytes());

        tracker.remove(id);
        try std.testing.expect(tracker.contains(id));
        try std.testing.expectEqual(@as(u32, 1), tracker.getGraphemeCellCount());

        // After deinit (via defer), tracker decrefs once, bringing refcount to 0
    }

    // Allocate new item to trigger slot reuse
    const text2 = "b";
    _ = try pool.acquire(text2);

    // Old ID should now be invalid due to generation change
    const result = pool.get(id);
    try std.testing.expectError(gp.GraphemePoolError.WrongGeneration, result);
}

test "GraphemeTracker - remove grapheme" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "a";
    const id = try pool.acquire(text);

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
    const id = try pool.acquire(text);

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
    const id1 = try pool.acquire(text1);
    const id2 = try pool.acquire(text2);

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

    const id1 = try pool.acquire(text1);
    const id2 = try pool.acquire(text2);
    const id3 = try pool.acquire(text3);

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
    const id = try pool.acquire(text);

    {
        var tracker = GraphemeTracker.init(std.testing.allocator, &pool);
        defer tracker.deinit();

        tracker.add(id);
        try pool.decref(id);

        // Should be accessible because tracker holds a reference (refcount is 1)
        const retrieved = try pool.get(id);
        try std.testing.expectEqualSlices(u8, text, retrieved);

        // After tracker deinit (via defer), refcount will be 0
    }

    // Allocate new item to trigger slot reuse with new generation
    const text2 = "x";
    _ = try pool.acquire(text2);

    // Old ID should fail due to generation mismatch
    const result = pool.get(id);
    try std.testing.expectError(gp.GraphemePoolError.WrongGeneration, result);
}

test "GraphemeTracker - multiple trackers share same grapheme" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const text = "shared";
    const id = try pool.acquire(text);

    {
        var tracker1 = GraphemeTracker.init(std.testing.allocator, &pool);
        defer tracker1.deinit();

        {
            var tracker2 = GraphemeTracker.init(std.testing.allocator, &pool);
            defer tracker2.deinit();

            tracker1.add(id);
            tracker2.add(id);
            try pool.decref(id);

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
    _ = try pool.acquire(text2);

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
        ids[i] = try pool.acquire(slice);
        tracker.add(ids[i]);
        try pool.decref(ids[i]);
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

test "GraphemePool - alloc copies input into pool storage" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    var input = [_]u8{ 'o', 'w', 'n', 'e', 'd' };
    const id = try pool.acquire(&input);
    @memset(&input, 'x');
    defer pool.decref(id) catch @panic("Failed to decref grapheme");

    const retrieved = try pool.get(id);
    try std.testing.expectEqualSlices(u8, "owned", retrieved);
    try std.testing.expect(@intFromPtr(input[0..].ptr) != @intFromPtr(retrieved.ptr));
}

test "GraphemePool - initWithOptions with small slots_per_page" {
    // Create a pool with very small slots_per_page to test exhaustion
    const small_slots = [_]u32{ 2, 2, 2, 2, 2 }; // Only 2 slots per page for each class
    var pool = gp.GraphemePool.initWithOptions(std.testing.allocator, .{
        .slots_per_page = small_slots,
    });
    defer pool.deinit();

    const id1 = try pool.acquire("abc");
    const id2 = try pool.acquire("def");

    try std.testing.expectEqualSlices(u8, "abc", try pool.get(id1));
    try std.testing.expectEqualSlices(u8, "def", try pool.get(id2));

    try pool.decref(id1);
    try pool.decref(id2);
}

test "GraphemePool - alloc reuses live ID for same bytes" {
    const tiny_slots = [_]u32{ 1, 1, 1, 1, 1 };
    var pool = gp.GraphemePool.initWithOptions(std.testing.allocator, .{
        .slots_per_page = tiny_slots,
    });
    defer pool.deinit();

    const grapheme = "👋";

    const id1 = try pool.acquire(grapheme);
    const id2 = try pool.acquire(grapheme);
    try std.testing.expectEqual(id1, id2);
    try std.testing.expectEqual(@as(u32, 2), try pool.getRefcount(id1));

    try pool.decref(id1);
    try pool.decref(id2);

    const id3 = try pool.acquire(grapheme);
    defer pool.decref(id3) catch @panic("Failed to decref id3");

    try std.testing.expect(id3 != id1);
    try std.testing.expectEqualSlices(u8, grapheme, try pool.get(id3));

    const id4 = try pool.acquire(grapheme);
    defer pool.decref(id4) catch @panic("Failed to decref id4");
    try std.testing.expectEqual(id3, id4);
    try std.testing.expectEqual(@as(u32, 2), try pool.getRefcount(id3));
}

test "GraphemePool - small pool exhaustion and growth" {
    // Create a tiny pool that will need to grow
    const tiny_slots = [_]u32{ 1, 1, 1, 1, 1 }; // Only 1 slot per page initially
    var pool = gp.GraphemePool.initWithOptions(std.testing.allocator, .{
        .slots_per_page = tiny_slots,
    });
    defer pool.deinit();

    // Allocate first item - uses initial page
    const id1 = try pool.acquire("a");

    // Allocate second item - should trigger growth (new page)
    const id2 = try pool.acquire("b");

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
    const id1 = try pool.acquire("aa");
    const id2 = try pool.acquire("bb");

    // Free one
    try pool.decref(id1);

    const id3 = try pool.acquire("cc");

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
    const id_small = try pool.acquire("ab"); // 2 bytes -> class 0 (8-byte slots)
    const id_medium = try pool.acquire("0123456789abc"); // 13 bytes -> class 1 (16-byte slots)
    const id_large = try pool.acquire("012345678901234567890"); // 21 bytes -> class 2 (32-byte slots)

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
    const id1 = try pool.acquire("🌟");
    const id2 = try pool.acquire("🎨");
    const id3 = try pool.acquire("🚀");

    tracker.add(id1);
    tracker.add(id2);
    tracker.add(id3);
    try pool.decref(id1);
    try pool.decref(id2);
    try pool.decref(id3);

    try std.testing.expectEqual(@as(u32, 3), tracker.getGraphemeCount());

    // Clear tracker should free all refs
    tracker.clear();
    try std.testing.expectEqual(@as(u32, 0), tracker.getGraphemeCount());
}

test "GraphemePool - retaining a live ID does not intern" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const id = try pool.acquire("live");
    defer pool.decref(id) catch {};
    try std.testing.expectEqual(@as(u32, 1), pool.interned_live_ids.count());

    try pool.incref(id);
    defer pool.decref(id) catch {};
    try std.testing.expectEqual(@as(u32, 1), pool.interned_live_ids.count());
    try std.testing.expectEqual(@as(u32, 2), try pool.getRefcount(id));
}

test "GraphemePool - acquire copies borrowed same-pool bytes before growth" {
    var pool = GraphemePool.initWithOptions(std.testing.allocator, .{
        .slots_per_page = [_]u32{ 1, 1, 1, 1, 1 },
    });
    defer pool.deinit();

    const id = try pool.acquire("aaaaaaaa");
    defer pool.decref(id) catch {};
    const borrowed = (try pool.get(id))[0..1];
    const short = try pool.acquire(borrowed);
    defer pool.decref(short) catch {};

    try std.testing.expect(short != id);
    try std.testing.expectEqualSlices(u8, "a", try pool.get(short));
    try std.testing.expectEqualSlices(u8, "aaaaaaaa", try pool.get(id));
}

test "GraphemePool - incref of a released ID fails" {
    var pool = GraphemePool.init(std.testing.allocator);
    defer pool.deinit();

    const id = try pool.acquire("gone");
    try pool.decref(id);
    try std.testing.expectError(gp.GraphemePoolError.InvalidId, pool.incref(id));
}
