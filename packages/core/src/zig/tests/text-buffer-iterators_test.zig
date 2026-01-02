const std = @import("std");
const testing = std.testing;
const iter_mod = @import("../text-buffer-iterators.zig");
const seg_mod = @import("../text-buffer-segment.zig");
const text_buffer = @import("../text-buffer.zig");
const gp = @import("../grapheme.zig");

const Segment = seg_mod.Segment;
const UnifiedRope = seg_mod.UnifiedRope;
const LineInfo = iter_mod.LineInfo;
const TextChunk = seg_mod.TextChunk;
const TextBuffer = text_buffer.UnifiedTextBuffer;

test "walkLines - empty rope" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var rope = try UnifiedRope.init(allocator);

    const Context = struct {
        count: u32 = 0,
        first_line: ?LineInfo = null,

        fn callback(ctx_ptr: *anyopaque, line_info: LineInfo) void {
            const ctx = @as(*@This(), @ptrCast(@alignCast(ctx_ptr)));
            if (ctx.count == 0) {
                ctx.first_line = line_info;
            }
            ctx.count += 1;
        }
    };

    var ctx = Context{};
    iter_mod.walkLines(&rope, &ctx, Context.callback, true);

    try testing.expectEqual(@as(u32, 1), ctx.count);
}

test "walkLines - single text segment" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var rope = try UnifiedRope.init(allocator);
    try rope.append(Segment{ .linestart = {} });
    try rope.append(Segment{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 0,
            .byte_end = 10,
            .width = 10,
            .flags = 0,
        },
    });

    const Context = struct {
        lines: std.ArrayListUnmanaged(LineInfo),
        allocator: std.mem.Allocator,

        fn callback(ctx_ptr: *anyopaque, line_info: LineInfo) void {
            const ctx = @as(*@This(), @ptrCast(@alignCast(ctx_ptr)));
            ctx.lines.append(ctx.allocator, line_info) catch {};
        }
    };

    var ctx = Context{ .lines = .{}, .allocator = allocator };
    defer ctx.lines.deinit(allocator);

    iter_mod.walkLines(&rope, &ctx, Context.callback, true);

    try testing.expectEqual(@as(usize, 1), ctx.lines.items.len);
    try testing.expectEqual(@as(u32, 10), ctx.lines.items[0].width);
}

test "walkLines - text + break + text" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var rope = try UnifiedRope.init(allocator);
    try rope.append(Segment{ .linestart = {} });
    try rope.append(Segment{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 0,
            .byte_end = 10,
            .width = 10,
            .flags = 0,
        },
    });
    try rope.append(Segment{ .brk = {} });
    try rope.append(Segment{ .linestart = {} });
    try rope.append(Segment{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 10,
            .byte_end = 15,
            .width = 5,
            .flags = 0,
        },
    });

    const Context = struct {
        lines: std.ArrayListUnmanaged(LineInfo),
        allocator: std.mem.Allocator,

        fn callback(ctx_ptr: *anyopaque, line_info: LineInfo) void {
            const ctx = @as(*@This(), @ptrCast(@alignCast(ctx_ptr)));
            ctx.lines.append(ctx.allocator, line_info) catch {};
        }
    };

    var ctx = Context{ .lines = .{}, .allocator = allocator };
    defer ctx.lines.deinit(allocator);

    iter_mod.walkLines(&rope, &ctx, Context.callback, true);

    try testing.expectEqual(@as(usize, 2), ctx.lines.items.len);

    try testing.expectEqual(@as(u32, 0), ctx.lines.items[0].line_idx);
    try testing.expectEqual(@as(u32, 10), ctx.lines.items[0].width);
    try testing.expectEqual(@as(u32, 0), ctx.lines.items[0].char_offset);

    try testing.expectEqual(@as(u32, 1), ctx.lines.items[1].line_idx);
    try testing.expectEqual(@as(u32, 5), ctx.lines.items[1].width);
    try testing.expectEqual(@as(u32, 11), ctx.lines.items[1].char_offset);
}

test "walkLines - exclude newlines in offset" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var rope = try UnifiedRope.init(allocator);
    try rope.append(Segment{ .linestart = {} });
    try rope.append(Segment{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 0,
            .byte_end = 10,
            .width = 10,
            .flags = 0,
        },
    });
    try rope.append(Segment{ .brk = {} });
    try rope.append(Segment{ .linestart = {} });
    try rope.append(Segment{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 10,
            .byte_end = 15,
            .width = 5,
            .flags = 0,
        },
    });

    const Context = struct {
        lines: std.ArrayListUnmanaged(LineInfo),
        allocator: std.mem.Allocator,

        fn callback(ctx_ptr: *anyopaque, line_info: LineInfo) void {
            const ctx = @as(*@This(), @ptrCast(@alignCast(ctx_ptr)));
            ctx.lines.append(ctx.allocator, line_info) catch {};
        }
    };

    var ctx = Context{ .lines = .{}, .allocator = allocator };
    defer ctx.lines.deinit(allocator);

    iter_mod.walkLines(&rope, &ctx, Context.callback, false);

    try testing.expectEqual(@as(usize, 2), ctx.lines.items.len);

    try testing.expectEqual(@as(u32, 0), ctx.lines.items[0].line_idx);
    try testing.expectEqual(@as(u32, 10), ctx.lines.items[0].width);
    try testing.expectEqual(@as(u32, 0), ctx.lines.items[0].char_offset);

    try testing.expectEqual(@as(u32, 1), ctx.lines.items[1].line_idx);
    try testing.expectEqual(@as(u32, 5), ctx.lines.items[1].width);
    try testing.expectEqual(@as(u32, 10), ctx.lines.items[1].char_offset);
}

test "coordsToOffset - valid coordinates" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var rope = try UnifiedRope.init(allocator);
    try rope.append(Segment{ .linestart = {} });
    try rope.append(Segment{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 0,
            .byte_end = 10,
            .width = 10,
            .flags = 0,
        },
    });
    try rope.append(Segment{ .brk = {} });
    try rope.append(Segment{ .linestart = {} });
    try rope.append(Segment{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 10,
            .byte_end = 15,
            .width = 5,
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
    try rope.append(Segment{ .linestart = {} });
    try rope.append(Segment{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 0,
            .byte_end = 10,
            .width = 10,
            .flags = 0,
        },
    });
    try rope.append(Segment{ .brk = {} });
    try rope.append(Segment{ .linestart = {} });
    try rope.append(Segment{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 10,
            .byte_end = 15,
            .width = 5,
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
    try rope.append(Segment{ .linestart = {} });
    try rope.append(Segment{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 0,
            .byte_end = 10,
            .width = 10,
            .flags = 0,
        },
    });
    try rope.append(Segment{ .brk = {} });
    try rope.append(Segment{ .linestart = {} });
    try rope.append(Segment{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 10,
            .byte_end = 15,
            .width = 5,
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
    try rope.append(Segment{ .linestart = {} });
    try rope.append(Segment{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 0,
            .byte_end = 10,
            .width = 10,
            .flags = 0,
        },
    });
    try rope.append(Segment{ .brk = {} });
    try rope.append(Segment{ .linestart = {} });
    try rope.append(Segment{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 10,
            .byte_end = 18,
            .width = 8,
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


    var tb = try TextBuffer.init(testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello");

    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 0, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 1, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 2, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 3, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 4, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 0), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 5, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 0), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 10, tb.tab_width, tb.width_method));
}

test "getGraphemeWidthAt - emoji and wide characters" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("a😀b");

    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 0, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 2), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 1, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 3, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 0), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 4, tb.tab_width, tb.width_method));
}

test "getGraphemeWidthAt - multiple chunks" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello World");

    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 0, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 4, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 5, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 6, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 10, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 0), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 11, tb.tab_width, tb.width_method));
}

test "getGraphemeWidthAt - empty line" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("");

    try testing.expectEqual(@as(u32, 0), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 0, tb.tab_width, tb.width_method));
}

test "getGraphemeWidthAt - at chunk boundary" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("abcdef");

    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 3, tb.tab_width, tb.width_method));
}

test "getGraphemeWidthAt - after break segment" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("abc\ndef");

    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 0, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 0), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 3, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 1, 0, tb.tab_width, tb.width_method));
}

test "getPrevGraphemeWidth - ASCII text" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello");

    try testing.expectEqual(@as(u32, 0), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 0, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 1, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 2, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 3, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 4, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 5, tb.tab_width, tb.width_method));
}

test "getPrevGraphemeWidth - emoji and wide characters" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("a😀b");

    try testing.expectEqual(@as(u32, 0), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 0, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 1, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 2), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 3, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 4, tb.tab_width, tb.width_method));
}

test "getPrevGraphemeWidth - at chunk boundary" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("abcdef");

    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 3, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 4, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 5, tb.tab_width, tb.width_method));
}

test "getPrevGraphemeWidth - emoji at chunk boundary" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("a😀b");

    try testing.expectEqual(@as(u32, 2), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 3, tb.tab_width, tb.width_method));
}

test "getPrevGraphemeWidth - multiple chunks" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello 😀");

    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 1, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 5, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 6, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 2), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 8, tb.tab_width, tb.width_method));
}

test "getPrevGraphemeWidth - empty line" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("");

    try testing.expectEqual(@as(u32, 0), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 0, tb.tab_width, tb.width_method));
}

test "getPrevGraphemeWidth - col beyond line width" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("abc");

    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 100, tb.tab_width, tb.width_method));
}

test "getPrevGraphemeWidth - multiline" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("abc\n😀xyz");

    try testing.expectEqual(@as(u32, 0), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 0, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 3, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 0), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 1, 0, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 2), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 1, 2, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 1, 3, tb.tab_width, tb.width_method));
}

test "getGraphemeWidthAt - CJK characters (Chinese)" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("a世界b");

    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 0, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 2), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 1, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 2), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 3, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 5, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 0), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 6, tb.tab_width, tb.width_method));
}

test "getGraphemeWidthAt - various emoji including star" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("🌟🎉");

    try testing.expectEqual(@as(u32, 2), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 0, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 2), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 2, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 0), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 4, tb.tab_width, tb.width_method));
}

test "getGraphemeWidthAt - tab characters" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(testing.allocator, pool, .unicode);
    defer tb.deinit();
    tb.setTabWidth(4);

    try tb.setText("a\tb\t\tc");

    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 0, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 4), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 1, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 5, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 4), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 6, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 4), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 10, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 14, tb.tab_width, tb.width_method));
}

test "getGraphemeWidthAt - tab with different tab_width" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("x\ty");

    tb.setTabWidth(2);
    try testing.expectEqual(@as(u32, 2), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 1, 2, .unicode));

    tb.setTabWidth(8);
    try testing.expectEqual(@as(u32, 8), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 1, 8, .unicode));
}

test "getGraphemeWidthAt - middle of wide character" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("世");

    try testing.expectEqual(@as(u32, 2), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 0, tb.tab_width, tb.width_method));
    const result = iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 1, tb.tab_width, tb.width_method);
    _ = result;
}

test "getGraphemeWidthAt - invalid row" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("test");

    try testing.expectEqual(@as(u32, 0), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 5, 0, tb.tab_width, tb.width_method));
}

test "getPrevGraphemeWidth - CJK characters" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("a世界b");

    try testing.expectEqual(@as(u32, 0), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 0, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 1, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 2), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 3, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 2), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 5, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 6, tb.tab_width, tb.width_method));
}

test "getPrevGraphemeWidth - star emoji" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("x🌟y");

    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 1, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 2), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 3, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 4, tb.tab_width, tb.width_method));
}

test "getPrevGraphemeWidth - tabs" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(testing.allocator, pool, .unicode);
    defer tb.deinit();
    tb.setTabWidth(4);

    try tb.setText("a\tb");

    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 1, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 4), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 5, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 6, tb.tab_width, tb.width_method));
}

test "getPrevGraphemeWidth - invalid row" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("test");

    try testing.expectEqual(@as(u32, 0), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 10, 5, tb.tab_width, tb.width_method));
}

test "getGraphemeWidthAt and getPrevGraphemeWidth - mixed content" {
    const pool = gp.initGlobalPool(testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(testing.allocator, pool, .unicode);
    defer tb.deinit();
    tb.setTabWidth(4);

    try tb.setText("Hi\t世🌟!");

    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 0, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 1, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 4), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 2, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 2), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 6, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 2), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 8, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getGraphemeWidthAt(&tb.rope, &tb.mem_registry, 0, 10, tb.tab_width, tb.width_method));

    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 1, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 1), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 2, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 4), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 6, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 2), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 8, tb.tab_width, tb.width_method));
    try testing.expectEqual(@as(u32, 2), iter_mod.getPrevGraphemeWidth(&tb.rope, &tb.mem_registry, 0, 10, tb.tab_width, tb.width_method));
}
