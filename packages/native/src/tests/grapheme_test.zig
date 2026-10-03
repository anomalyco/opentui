const std = @import("std");
const gp = @import("../grapheme.zig");
const test_pools = @import("test-pools.zig");

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

test "GraphemePool and GraphemeTracker match a reference model" {
    for (0..8) |seed| try test_pools.checkPoolModel(test_pools.GraphemeSpec, seed, 400);
}
