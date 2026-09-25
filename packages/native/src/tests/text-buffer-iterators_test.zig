const std = @import("std");
const testing = std.testing;
const iter_mod = @import("../text-buffer-iterators.zig");
const seg_mod = @import("../text-buffer-segment.zig");
const text_buffer = @import("../text-buffer.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");

const Segment = seg_mod.Segment;
const UnifiedRope = seg_mod.UnifiedRope;
const TextChunk = seg_mod.TextChunk;
const TextBuffer = text_buffer.UnifiedTextBuffer;

test "coordsToOffset - valid coordinates" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var rope = try UnifiedRope.init(allocator);
    try rope.append(.{ .linestart = {} });
    try rope.append(.{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 0,
            .byte_end = 10,
            .width_cols = 10,
            .flags = 0,
        },
    });
    try rope.append(.{ .brk = {} });
    try rope.append(.{ .linestart = {} });
    try rope.append(.{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 10,
            .byte_end = 15,
            .width_cols = 5,
            .flags = 0,
        },
    });

    const offset1 = iter_mod.coordsToOffset(&rope, 0, 5);
    try testing.expect(offset1 != null);
    try testing.expectEqual(@as(u32, 5), offset1.?);

    const offset2 = iter_mod.coordsToOffset(&rope, 1, 0);
    try testing.expect(offset2 != null);
    try testing.expectEqual(@as(u32, 11), offset2.?);

    const offset3 = iter_mod.coordsToOffset(&rope, 1, 3);
    try testing.expect(offset3 != null);
    try testing.expectEqual(@as(u32, 14), offset3.?);
}

test "offsetToCoords - valid offsets" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var rope = try UnifiedRope.init(allocator);
    try rope.append(.{ .linestart = {} });
    try rope.append(.{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 0,
            .byte_end = 10,
            .width_cols = 10,
            .flags = 0,
        },
    });
    try rope.append(.{ .brk = {} });
    try rope.append(.{ .linestart = {} });
    try rope.append(.{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 10,
            .byte_end = 15,
            .width_cols = 5,
            .flags = 0,
        },
    });

    const coords1 = iter_mod.offsetToCoords(&rope, 5);
    try testing.expect(coords1 != null);
    try testing.expectEqual(@as(u32, 0), coords1.?.row);
    try testing.expectEqual(@as(u32, 5), coords1.?.col);

    const coords2 = iter_mod.offsetToCoords(&rope, 10);
    try testing.expect(coords2 != null);
    try testing.expectEqual(@as(u32, 0), coords2.?.row);
    try testing.expectEqual(@as(u32, 10), coords2.?.col);

    const coords2b = iter_mod.offsetToCoords(&rope, 11);
    try testing.expect(coords2b != null);
    try testing.expectEqual(@as(u32, 1), coords2b.?.row);
    try testing.expectEqual(@as(u32, 0), coords2b.?.col);

    const coords3 = iter_mod.offsetToCoords(&rope, 14);
    try testing.expect(coords3 != null);
    try testing.expectEqual(@as(u32, 1), coords3.?.row);
    try testing.expectEqual(@as(u32, 3), coords3.?.col);
}

test "Helper functions" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var rope = try UnifiedRope.init(allocator);
    try rope.append(.{ .linestart = {} });
    try rope.append(.{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 0,
            .byte_end = 10,
            .width_cols = 10,
            .flags = 0,
        },
    });
    try rope.append(.{ .brk = {} });
    try rope.append(.{ .linestart = {} });
    try rope.append(.{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 10,
            .byte_end = 15,
            .width_cols = 5,
            .flags = 0,
        },
    });

    try testing.expectEqual(@as(u32, 2), iter_mod.getLineCount(&rope));
    try testing.expectEqual(@as(u32, 10), iter_mod.getMaxLineWidth(&rope));
    try testing.expectEqual(@as(u32, 15), iter_mod.getTotalWidth(&rope));
}

test "coordsToOffset and offsetToCoords - round trip" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var rope = try UnifiedRope.init(allocator);
    try rope.append(.{ .linestart = {} });
    try rope.append(.{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 0,
            .byte_end = 10,
            .width_cols = 10,
            .flags = 0,
        },
    });
    try rope.append(.{ .brk = {} });
    try rope.append(.{ .linestart = {} });
    try rope.append(.{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 10,
            .byte_end = 18,
            .width_cols = 8,
            .flags = 0,
        },
    });

    const test_cases = [_]struct { row: u32, col: u32 }{
        .{ .row = 0, .col = 0 },
        .{ .row = 0, .col = 5 },
        .{ .row = 0, .col = 9 },
        .{ .row = 1, .col = 0 },
        .{ .row = 1, .col = 4 },
        .{ .row = 1, .col = 7 },
    };

    for (test_cases) |tc| {
        const offset = iter_mod.coordsToOffset(&rope, tc.row, tc.col);
        try testing.expect(offset != null);

        const coords = iter_mod.offsetToCoords(&rope, offset.?);
        try testing.expect(coords != null);
        try testing.expectEqual(tc.row, coords.?.row);
        try testing.expectEqual(tc.col, coords.?.col);
    }
}

test "getGraphemeWidthAt - ASCII text" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello");

    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 0, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 1, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 2, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 3, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 4, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 0), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 5, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 0), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 10, tb.tabWidth(), tb.widthMethod()));
}

test "getGraphemeWidthAt - emoji and wide characters" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("a😀b");

    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 0, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 2), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 1, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 3, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 0), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 4, tb.tabWidth(), tb.widthMethod()));
}

test "getGraphemeWidthAt - multiple chunks" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello World");

    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 0, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 4, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 5, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 6, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 10, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 0), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 11, tb.tabWidth(), tb.widthMethod()));
}

test "getGraphemeWidthAt - empty line" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("");

    try testing.expectEqual(@as(u32, 0), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 0, tb.tabWidth(), tb.widthMethod()));
}

test "getGraphemeWidthAt - at chunk boundary" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("abcdef");

    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 3, tb.tabWidth(), tb.widthMethod()));
}

test "getGraphemeWidthAt - after break segment" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("abc\ndef");

    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 0, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 0), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 3, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 1, 0, tb.tabWidth(), tb.widthMethod()));
}

test "getPrevGraphemeWidth - ASCII text" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello");

    try testing.expectEqual(@as(u32, 0), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 0, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 1, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 2, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 3, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 4, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 5, tb.tabWidth(), tb.widthMethod()));
}

test "getPrevGraphemeWidth - emoji and wide characters" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("a😀b");

    try testing.expectEqual(@as(u32, 0), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 0, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 1, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 2), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 3, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 4, tb.tabWidth(), tb.widthMethod()));
}

test "getPrevGraphemeWidth - at chunk boundary" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("abcdef");

    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 3, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 4, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 5, tb.tabWidth(), tb.widthMethod()));
}

test "getPrevGraphemeWidth - emoji at chunk boundary" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("a😀b");

    try testing.expectEqual(@as(u32, 2), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 3, tb.tabWidth(), tb.widthMethod()));
}

test "getPrevGraphemeWidth - multiple chunks" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello 😀");

    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 1, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 5, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 6, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 2), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 8, tb.tabWidth(), tb.widthMethod()));
}

test "getPrevGraphemeWidth - empty line" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("");

    try testing.expectEqual(@as(u32, 0), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 0, tb.tabWidth(), tb.widthMethod()));
}

test "getPrevGraphemeWidth - col beyond line width" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("abc");

    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 100, tb.tabWidth(), tb.widthMethod()));
}

test "getPrevGraphemeWidth - multiline" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("abc\n😀xyz");

    try testing.expectEqual(@as(u32, 0), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 0, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 3, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 0), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 1, 0, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 2), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 1, 2, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 1, 3, tb.tabWidth(), tb.widthMethod()));
}

test "getGraphemeWidthAt - CJK characters (Chinese)" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("a世界b");

    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 0, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 2), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 1, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 2), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 3, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 5, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 0), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 6, tb.tabWidth(), tb.widthMethod()));
}

test "getGraphemeWidthAt - various emoji including star" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("🌟🎉");

    try testing.expectEqual(@as(u32, 2), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 0, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 2), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 2, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 0), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 4, tb.tabWidth(), tb.widthMethod()));
}

test "getGraphemeWidthAt - tab characters" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    tb.setTabWidth(4);

    try tb.setText("a\tb\t\tc");

    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 0, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 4), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 1, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 5, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 4), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 6, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 4), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 10, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 14, tb.tabWidth(), tb.widthMethod()));
}

test "getGraphemeWidthAt - tab with different tab_width" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("x\ty");

    tb.setTabWidth(2);
    try testing.expectEqual(@as(u32, 2), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 1, 2, .unicode));

    tb.setTabWidth(8);
    try testing.expectEqual(@as(u32, 8), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 1, 8, .unicode));
}

test "getGraphemeWidthAt - middle of wide character" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("世");

    try testing.expectEqual(@as(u32, 2), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 0, tb.tabWidth(), tb.widthMethod()));
    const result = iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 1, tb.tabWidth(), tb.widthMethod());
    try testing.expectEqual(@as(u32, 1), result);

    const bounds = iter_mod.getGraphemeBoundsAt(tb.rope(), tb.memRegistry(), 0, 1, tb.tabWidth(), tb.widthMethod()).?;
    try testing.expectEqual(@as(u32, 0), bounds.start);
    try testing.expectEqual(@as(u32, 2), bounds.end);
}

test "getGraphemeWidthAt - invalid row" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("test");

    try testing.expectEqual(@as(u32, 0), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 5, 0, tb.tabWidth(), tb.widthMethod()));
}

test "getPrevGraphemeWidth - CJK characters" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("a世界b");

    try testing.expectEqual(@as(u32, 0), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 0, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 1, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 2), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 3, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 2), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 5, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 6, tb.tabWidth(), tb.widthMethod()));
}

test "getPrevGraphemeWidth - star emoji" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("x🌟y");

    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 1, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 2), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 3, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 4, tb.tabWidth(), tb.widthMethod()));
}

test "getPrevGraphemeWidth - tabs" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    tb.setTabWidth(4);

    try tb.setText("a\tb");

    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 1, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 4), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 5, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 6, tb.tabWidth(), tb.widthMethod()));
}

test "getPrevGraphemeWidth - invalid row" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("test");

    try testing.expectEqual(@as(u32, 0), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 10, 5, tb.tabWidth(), tb.widthMethod()));
}

test "getGraphemeWidthAt and getPrevGraphemeWidth - mixed content" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    tb.setTabWidth(4);

    try tb.setText("Hi\t世🌟!");

    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 0, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 1, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 4), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 2, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 2), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 6, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 2), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 8, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(tb.rope(), tb.memRegistry(), 0, 10, tb.tabWidth(), tb.widthMethod()));

    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 1, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 2, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 4), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 6, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 2), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 8, tb.tabWidth(), tb.widthMethod()));
    try testing.expectEqual(@as(u32, 2), iter_mod.getPrevGraphemeWidth(tb.rope(), tb.memRegistry(), 0, 10, tb.tabWidth(), tb.widthMethod()));
}
