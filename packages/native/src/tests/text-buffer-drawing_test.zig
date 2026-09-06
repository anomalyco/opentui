const std = @import("std");
const text_buffer = @import("../text-buffer.zig");
const text_buffer_view = @import("../text-buffer-view.zig");
const buffer = @import("../buffer.zig");
const ansi = @import("../ansi.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");
const ss = @import("../syntax-style.zig");

const TextBuffer = text_buffer.TextBuffer;
const TextBufferView = text_buffer_view.TextBufferView;
const OptimizedBuffer = buffer.OptimizedBuffer;
const RGBA = text_buffer.RGBA;
const WrapMode = text_buffer.WrapMode;
const StyledChunk = text_buffer.StyledChunk;

fn resolvedRow(allocator: std.mem.Allocator, opt_buffer: *const OptimizedBuffer, pool: *gp.GraphemePool, y: u32) ![]u8 {
    var row: std.ArrayListUnmanaged(u8) = .empty;
    errdefer row.deinit(allocator);

    for (0..opt_buffer.width) |x| {
        const char = opt_buffer.get(@intCast(x), y).?.char;
        if (gp.isContinuationChar(char)) continue;
        if (gp.isGraphemeChar(char)) {
            const bytes = try pool.get(gp.graphemeIdFromChar(char));
            try row.appendSlice(allocator, bytes);
            continue;
        }
        var encoded: [4]u8 = undefined;
        const len = try std.unicode.utf8Encode(@intCast(char), &encoded);
        try row.appendSlice(allocator, encoded[0..len]);
    }
    return row.toOwnedSlice(allocator);
}

fn expectRenderedRows(
    text: []const u8,
    wrap_mode: WrapMode,
    width: u32,
    expected_rows: []const []const u8,
    expected_starts: ?[]const u32,
) !void {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();
    try tb.setText(text);
    view.setWrapMode(wrap_mode);
    view.setWrapWidth(width);
    try std.testing.expectEqual(expected_rows.len, view.getVirtualLines().len);
    if (expected_starts) |starts| {
        try std.testing.expectEqualSlices(u32, starts, view.getCachedLineInfo().line_start_cols);
    }

    const render_width = @max(width, 16);
    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        render_width,
        @intCast(expected_rows.len),
        .{ .pool = pool, .width_method = .wcwidth },
    );
    defer opt_buffer.deinit();
    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    for (expected_rows, 0..) |expected, y| {
        const row = try resolvedRow(std.testing.allocator, opt_buffer, pool, @intCast(y));
        defer std.testing.allocator.free(row);
        try std.testing.expect(std.unicode.utf8ValidateSlice(row));
        try std.testing.expectEqualStrings(expected, std.mem.trim(u8, row, " "));
    }
}

test "drawTextBuffer - exact CJK and issue 609 wrapped rows" {
    const vectors = [_]struct {
        text: []const u8,
        width: u32,
        rows: []const []const u8,
        starts: []const u32,
    }{
        .{ .text = "你好世界", .width = 4, .rows = &.{ "你好", "世界" }, .starts = &.{ 0, 4 } },
        .{ .text = "가나다", .width = 1, .rows = &.{ "가", "나", "다" }, .starts = &.{ 0, 2, 4 } },
        .{ .text = "흐름도", .width = 4, .rows = &.{ "흐름", "도" }, .starts = &.{ 0, 4 } },
        .{ .text = "1️⃣한글", .width = 4, .rows = &.{ "1️⃣한", "글" }, .starts = &.{ 0, 3 } },
        .{ .text = "👋🏻👋🏿hi", .width = 4, .rows = &.{ "👋🏻", "👋🏿", "hi" }, .starts = &.{ 0, 4, 8 } },
        .{ .text = "A👋🏻B👩‍💻C", .width = 2, .rows = &.{ "A", "👋🏻", "B", "👩‍💻", "C" }, .starts = &.{ 0, 1, 5, 6, 10 } },
    };

    for (vectors) |vector| {
        try expectRenderedRows(vector.text, .char, vector.width, vector.rows, vector.starts);
    }
}

test "drawTextBuffer - streaming Prepend before ASCII vector is preserved" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    const text = try std.testing.allocator.alloc(u8, 70_000);
    defer std.testing.allocator.free(text);
    const prefix = "\u{0600} ";
    @memcpy(text[0..prefix.len], prefix);
    @memset(text[prefix.len..], 'a');

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();
    try tb.setText(text);
    view.setWrapMode(.word);
    view.setWrapWidth(8);

    const lines = view.getVirtualLines();
    try std.testing.expect(lines.len > 1);
    try std.testing.expectEqual(@as(usize, 1), lines[0].chunks.items.len);
    const first_chunk = lines[0].chunks.items[0];
    const first_bytes = first_chunk.chunk.getBytes(tb.memRegistry());
    const first_window = first_bytes[first_chunk.byte_start_in_chunk .. first_chunk.byte_start_in_chunk + first_chunk.byte_len];
    try std.testing.expectEqualStrings(prefix, first_window);

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        8,
        1,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();
    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);
    const row = try resolvedRow(std.testing.allocator, opt_buffer, pool, 0);
    defer std.testing.allocator.free(row);
    try std.testing.expect(std.unicode.utf8ValidateSlice(row));
    try std.testing.expectEqualStrings("\u{0600}", std.mem.trim(u8, row, " "));
}

test "drawTextBuffer - long grapheme byte window stays atomic for unicode and wcwidth" {
    var text: std.ArrayListUnmanaged(u8) = .empty;
    defer text.deinit(std.testing.allocator);
    for (0..130) |i| {
        if (i > 0) try text.appendSlice(std.testing.allocator, "\u{200D}");
        try text.appendSlice(std.testing.allocator, "👩");
    }

    for ([_]struct { method: @import("../utf8.zig").WidthMethod, expected_width: u32 }{
        .{ .method = .unicode, .expected_width = 2 },
        .{ .method = .wcwidth, .expected_width = 260 },
    }) |case| {
        const pool = gp.initGlobalPool(std.testing.allocator);
        defer gp.deinitGlobalPool();
        const link_pool = link.initGlobalLinkPool(std.testing.allocator);
        defer link.deinitGlobalLinkPool();

        var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, case.method);
        defer tb.deinit();
        var view = try TextBufferView.init(std.testing.allocator, tb);
        defer view.deinit();
        try tb.setText(text.items);
        view.setWrapMode(.char);
        view.setWrapWidth(80);

        const lines = view.getVirtualLines();
        try std.testing.expectEqual(@as(usize, 1), lines.len);
        try std.testing.expectEqual(case.expected_width, lines[0].width_cols);
        try std.testing.expectEqual(@as(usize, 1), lines[0].chunks.items.len);
        const chunk = lines[0].chunks.items[0];
        const bytes = chunk.chunk.getBytes(tb.memRegistry());
        const window = bytes[chunk.byte_start_in_chunk .. chunk.byte_start_in_chunk + chunk.byte_len];
        try std.testing.expectEqualStrings(text.items, window);

        var opt_buffer = try OptimizedBuffer.init(
            std.testing.allocator,
            80,
            1,
            .{ .pool = pool, .width_method = case.method },
        );
        defer opt_buffer.deinit();
        opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
        opt_buffer.drawTextBuffer(view, 0, 0);

        const row = try resolvedRow(std.testing.allocator, opt_buffer, pool, 0);
        defer std.testing.allocator.free(row);
        // The grapheme pool intentionally rejects owned entries above 128 bytes.
        // Rendering must skip the whole atomic cluster rather than slice or trap.
        try std.testing.expectEqualStrings("", std.mem.trim(u8, row, " "));
    }
}

test "drawTextBuffer - tab width changes refresh no-wrap and word-wrap layout" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();
    try tb.setText("a\tb");

    const expectRow = struct {
        fn run(view_ptr: *TextBufferView, pool_ptr: *gp.GraphemePool, width: u32, expected: []const u8) !void {
            var opt_buffer = try OptimizedBuffer.init(
                std.testing.allocator,
                width,
                1,
                .{ .pool = pool_ptr, .width_method = .unicode },
            );
            defer opt_buffer.deinit();
            opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
            opt_buffer.drawTextBuffer(view_ptr, 0, 0);

            const row = try resolvedRow(std.testing.allocator, opt_buffer, pool_ptr, 0);
            defer std.testing.allocator.free(row);
            try std.testing.expectEqualStrings(expected, row);
        }
    }.run;
    const cases = [_]struct { tab_width: u8, row: []const u8 }{
        .{ .tab_width = 2, .row = "a  b" },
        .{ .tab_width = 8, .row = "a        b" },
        .{ .tab_width = 4, .row = "a    b" },
    };
    for (cases) |case| {
        tb.setTabWidth(case.tab_width);
        const expected_width: u32 = 2 + case.tab_width;
        try std.testing.expectEqual(expected_width, tb.lineWidthAt(0));

        view.setWrapMode(.none);
        const no_wrap = view.getVirtualLines();
        try std.testing.expectEqual(@as(usize, 1), no_wrap.len);
        try std.testing.expectEqual(expected_width, no_wrap[0].width_cols);
        const no_wrap_measure = try view.measureForDimensions(80, 24);
        try std.testing.expectEqual(expected_width, no_wrap_measure.width_cols_max);
        try expectRow(view, pool, expected_width, case.row);

        view.setWrapMode(.word);
        view.setWrapWidth(expected_width);
        const word_wrap = view.getVirtualLines();
        try std.testing.expectEqual(@as(usize, 1), word_wrap.len);
        try std.testing.expectEqual(expected_width, word_wrap[0].width_cols);
        const word_measure = try view.measureForDimensions(expected_width, 24);
        try std.testing.expectEqual(@as(u32, 1), word_measure.line_count);
        try std.testing.expectEqual(expected_width, word_measure.width_cols_max);
        try expectRow(view, pool, expected_width, case.row);
    }

    tb.setTabWidth(255);
    try std.testing.expectEqual(@as(u8, 254), tb.getTabWidth());
    try std.testing.expectEqual(@as(u32, 256), tb.lineWidthAt(0));
}

test "drawTextBuffer - fragmented CJK chunks render exact rows across wrap" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const text = "你好世界";
    const mem_id = try tb.registerMemBuffer(text, false);
    var segments: std.ArrayListUnmanaged(@import("../text-buffer-segment.zig").Segment) = .empty;
    defer segments.deinit(std.testing.allocator);
    try segments.append(std.testing.allocator, .{ .linestart = {} });
    try segments.append(std.testing.allocator, .{ .text = tb.createChunk(mem_id, 0, 3) });
    try segments.append(std.testing.allocator, .{ .text = tb.createChunk(mem_id, 3, 9) });
    try segments.append(std.testing.allocator, .{ .text = tb.createChunk(mem_id, 9, 12) });
    try tb.rope().setSegments(segments.items);
    view.setWrapMode(.char);
    view.setWrapWidth(4);

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        4,
        2,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();
    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const row0 = try resolvedRow(std.testing.allocator, opt_buffer, pool, 0);
    defer std.testing.allocator.free(row0);
    const row1 = try resolvedRow(std.testing.allocator, opt_buffer, pool, 1);
    defer std.testing.allocator.free(row1);
    try std.testing.expectEqualStrings("你好", row0);
    try std.testing.expectEqualStrings("世界", row1);
    try std.testing.expect(std.unicode.utf8ValidateSlice(row0));
    try std.testing.expect(std.unicode.utf8ValidateSlice(row1));
}

test "drawTextBuffer - reset preserves live view ellipsis across widths and wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();
    view.setTruncate(true);
    view.setViewport(.{ .x = 0, .y = 0, .width = 10, .height = 1 });

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        1,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();
    var out: [10]u8 = undefined;
    for (0..3) |_| {
        {
            var peer = try TextBufferView.init(std.testing.allocator, tb);
            defer peer.deinit();
            peer.setTruncate(true);
            peer.setViewport(.{ .x = 0, .y = 0, .width = 10, .height = 1 });

            try tb.reset();
            try std.testing.expectEqual(@as(usize, 0), tb.memRegistry().getUsedSlots());
            try std.testing.expectEqual(@as(u8, 0), try tb.replaceText("", null, false));
            try tb.append("0123456789ABCDEFGHIJ");
            for ([_]*TextBufferView{ view, peer }) |current| {
                opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
                opt_buffer.drawTextBuffer(current, 0, 0);
                const written = try opt_buffer.writeResolvedChars(&out, false);
                try std.testing.expectEqualStrings("012...GHIJ", out[0..written]);
                const ellipsis = current.getVirtualLines()[0].chunks.items[1].chunk;
                try std.testing.expectEqualStrings("...", ellipsis.getBytes(tb.memRegistry()));
                try std.testing.expect(ellipsis.cold == null);
            }
        }
        opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
        opt_buffer.drawTextBuffer(view, 0, 0);
        const written = try opt_buffer.writeResolvedChars(&out, false);
        try std.testing.expectEqualStrings("012...GHIJ", out[0..written]);
        try std.testing.expectEqual(@as(usize, 2), tb.memRegistry().getUsedSlots());
    }
    try tb.reset();
    _ = try tb.replaceText("", null, false);
    try tb.append("0123456789ABCDEFGHIJ");
    const cases = [_]struct { width: u32, mode: WrapMode = .none, expected: []const u8 }{
        .{ .width = 1, .expected = " " },
        .{ .width = 2, .expected = "  " },
        .{ .width = 3, .expected = "   " },
        .{ .width = 4, .expected = "...J" },
        .{ .width = 5, .expected = "0...J" },
        .{ .width = 4, .mode = .char, .expected = "0123" },
        .{ .width = 4, .mode = .word, .expected = "0123" },
    };
    for (cases) |case| {
        view.setViewport(.{ .x = 0, .y = 0, .width = case.width, .height = 1 });
        view.setWrapMode(case.mode);
        try opt_buffer.resize(case.width, 1);
        opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
        opt_buffer.drawTextBuffer(view, 0, 0);
        const written = try opt_buffer.writeResolvedChars(&out, false);
        try std.testing.expectEqualStrings(case.expected, out[0..written]);
    }
}

test "drawTextBuffer - truncation snaps suffix past wide grapheme" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();
    try tb.reset();
    _ = try tb.replaceText("", null, false);
    try tb.append("ABCDE가FG");
    view.setWrapMode(.none);
    view.setTruncate(true);
    view.setViewport(.{ .x = 0, .y = 0, .width = 8, .height = 1 });

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        8,
        1,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();
    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    var out: [32]u8 = undefined;
    const written = try opt_buffer.writeResolvedChars(&out, false);
    try std.testing.expectEqualStrings("AB...FG ", out[0..written]);
    try std.testing.expect(std.unicode.utf8ValidateSlice(out[0..written]));
}

test "drawTextBuffer - wcwidth truncation never renders a modifier-only suffix" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();
    try tb.reset();
    _ = try tb.replaceText("", null, false);
    try tb.append("ABCDE👋🏻Z");
    view.setWrapMode(.none);
    view.setTruncate(true);
    view.setViewport(.{ .x = 0, .y = 0, .width = 8, .height = 1 });

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        8,
        1,
        .{ .pool = pool, .width_method = .wcwidth },
    );
    defer opt_buffer.deinit();
    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const row = try resolvedRow(std.testing.allocator, opt_buffer, pool, 0);
    defer std.testing.allocator.free(row);
    try std.testing.expect(std.unicode.utf8ValidateSlice(row));
    try std.testing.expectEqualStrings("AB...Z", std.mem.trim(u8, row, " "));
}

test "drawTextBuffer - issue 799 CJK word wrap has no duplicated glyphs" {
    try expectRenderedRows(
        "在aber (“但”)引入的转折从句前表示让步：虽然，的确",
        .word,
        15,
        &.{ "在aber (“但”)引", "入的转折从句前", "表示让步：虽", "然，的确" },
        null,
    );
}

test "drawTextBuffer - simple single line text" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        5,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    var out_buffer: [100]u8 = undefined;
    const written = try opt_buffer.writeResolvedChars(&out_buffer, false);
    const result = out_buffer[0..written];

    try std.testing.expect(std.mem.startsWith(u8, result, "Hello World"));
}

test "drawTextBuffer - empty text buffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("");

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        5,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);
}

test "drawTextBuffer - multiple lines without wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 1\nLine 2\nLine 3");

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        10,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const virtual_lines = view.getVirtualLines();
    try std.testing.expect(virtual_lines.len == 3);
}

test "drawTextBuffer - text wrapping at word boundaries" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("This is a long line that should wrap at word boundaries");
    view.setWrapMode(.word);
    view.setWrapWidth(15);
    view.updateVirtualLines();

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        15,
        10,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const virtual_lines = view.getVirtualLines();
    try std.testing.expect(virtual_lines.len > 1);
}

test "drawTextBuffer - transparent background preserves underlying non-space under spaces" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("A A");

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        5,
        2,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    const red_bg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const blue_bg = ansi.rgbaFromFloats(0.0, 0.0, 1.0, 1.0);
    const green_fg = ansi.rgbaFromFloats(0.0, 1.0, 0.0, 1.0);
    opt_buffer.clear(red_bg, 32);
    opt_buffer.drawChar('X', 1, 0, green_fg, blue_bg, ansi.TextAttributes.BOLD);

    opt_buffer.drawTextBuffer(view, 0, 0);

    const left = opt_buffer.get(0, 0).?;
    try std.testing.expectEqual(@as(u32, 'A'), left.char);
    try std.testing.expectEqual(ansi.redF(red_bg), ansi.redF(left.bg));
    try std.testing.expectEqual(ansi.greenF(red_bg), ansi.greenF(left.bg));
    try std.testing.expectEqual(ansi.blueF(red_bg), ansi.blueF(left.bg));

    const middle = opt_buffer.get(1, 0).?;
    try std.testing.expectEqual(@as(u32, 'X'), middle.char);
    try std.testing.expectEqual(ansi.redF(green_fg), ansi.redF(middle.fg));
    try std.testing.expectEqual(ansi.greenF(green_fg), ansi.greenF(middle.fg));
    try std.testing.expectEqual(ansi.blueF(green_fg), ansi.blueF(middle.fg));
    try std.testing.expectEqual(ansi.redF(blue_bg), ansi.redF(middle.bg));
    try std.testing.expectEqual(ansi.greenF(blue_bg), ansi.greenF(middle.bg));
    try std.testing.expectEqual(ansi.blueF(blue_bg), ansi.blueF(middle.bg));
    try std.testing.expectEqual(ansi.TextAttributes.BOLD, middle.attributes);

    const right = opt_buffer.get(2, 0).?;
    try std.testing.expectEqual(@as(u32, 'A'), right.char);
    try std.testing.expectEqual(ansi.redF(red_bg), ansi.redF(right.bg));
    try std.testing.expectEqual(ansi.greenF(red_bg), ansi.greenF(right.bg));
    try std.testing.expectEqual(ansi.blueF(red_bg), ansi.blueF(right.bg));
}

test "drawTextBuffer - text wrapping at character boundaries" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    view.setWrapMode(.char);
    view.setWrapWidth(10);
    view.updateVirtualLines();

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        10,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const virtual_lines = view.getVirtualLines();
    try std.testing.expect(virtual_lines.len == 4);
}

test "drawTextBuffer - no wrapping with none mode" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("This is a very long line that extends beyond the buffer width");
    view.setWrapMode(.word);
    view.setWrapWidth(null);
    view.updateVirtualLines();

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        5,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const virtual_lines = view.getVirtualLines();
    try std.testing.expect(virtual_lines.len == 1);
}

test "drawTextBuffer - wrapped text with multiple lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("First long line that wraps\nSecond long line that also wraps\nThird line");
    view.setWrapMode(.word);
    view.setWrapWidth(15);
    view.updateVirtualLines();

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        15,
        15,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const virtual_lines = view.getVirtualLines();
    try std.testing.expect(virtual_lines.len >= 3);
}

test "drawTextBuffer - unicode characters with wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello 世界 🌟 Test wrapping");
    view.setWrapMode(.word);
    view.setWrapWidth(15);
    view.updateVirtualLines();

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        15,
        10,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const virtual_lines = view.getVirtualLines();
    try std.testing.expect(virtual_lines.len > 0);
}

test "drawTextBuffer - wrapping preserves wide characters" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("測試測試測試測試測試");
    view.setWrapMode(.char);
    view.setWrapWidth(10);
    view.updateVirtualLines();

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        10,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const virtual_lines = view.getVirtualLines();
    try std.testing.expect(virtual_lines.len > 1);
}

test "drawTextBuffer - word wrap does not split multi-byte UTF-8 characters" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("🌟 Unicode test: こんにちは世界 Hello World 你好世界");
    view.setWrapMode(.word);
    view.setWrapWidth(35);
    view.updateVirtualLines();

    const vlines = view.getVirtualLines();

    for (vlines) |vline| {
        var line_buffer: [200]u8 = undefined;
        const line_start_offset = vline.document_cell_offset;
        const line_end_offset = line_start_offset + vline.width_cols;
        const extracted = tb.getTextRange(line_start_offset, line_end_offset, &line_buffer);

        const is_valid_utf8 = std.unicode.utf8ValidateSlice(line_buffer[0..extracted]);
        try std.testing.expect(is_valid_utf8);
    }

    try std.testing.expect(vlines.len == 2);

    var full_buffer: [200]u8 = undefined;
    const line0_len = tb.getTextRange(vlines[0].document_cell_offset, vlines[0].document_cell_offset + vlines[0].width_cols, &full_buffer);
    const line0_text = full_buffer[0..line0_len];

    const line1_len = tb.getTextRange(vlines[1].document_cell_offset, vlines[1].document_cell_offset + vlines[1].width_cols, &full_buffer);
    const line1_text = full_buffer[0..line1_len];

    const line0_ends_with_kai = std.mem.endsWith(u8, line0_text, "界");
    const line1_starts_with_kai = std.mem.startsWith(u8, line1_text, "界");

    try std.testing.expect(!(line0_ends_with_kai and line1_starts_with_kai));
}

test "drawTextBuffer - wrapped text with offset position" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Short line that wraps nicely");
    view.setWrapMode(.word);
    view.setWrapWidth(10);
    view.updateVirtualLines();

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        20,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 5, 5);

    const cell = opt_buffer.get(5, 5);
    try std.testing.expect(cell != null);
    try std.testing.expect(cell.?.char != 32);
}

test "drawTextBuffer - clipping with scrolled view" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 1\nLine 2\nLine 3\nLine 4");

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        5,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const virtual_lines = view.getVirtualLines();
    try std.testing.expect(virtual_lines.len >= 4);
}

test "drawTextBuffer - wrapping with very narrow width" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello");
    view.setWrapMode(.char);
    view.setWrapWidth(3);
    view.updateVirtualLines();

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        3,
        10,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const virtual_lines = view.getVirtualLines();
    try std.testing.expect(virtual_lines.len == 2);
}

test "drawTextBuffer - word wrap doesn't break mid-word" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");
    view.setWrapMode(.word);
    view.setWrapWidth(8);
    view.updateVirtualLines();

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        8,
        5,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const virtual_lines = view.getVirtualLines();
    try std.testing.expect(virtual_lines.len == 2);
}

test "drawTextBuffer - empty lines render correctly" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 1\n\nLine 3");

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        10,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const virtual_lines = view.getVirtualLines();
    try std.testing.expect(virtual_lines.len == 3);
}

test "drawTextBuffer - wrapping with tabs" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello\tWorld\tTest");
    view.setWrapMode(.word);
    view.setWrapWidth(15);
    view.updateVirtualLines();

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        15,
        10,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);
}

test "drawTextBuffer - very long unwrapped line clipping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var long_text: std.ArrayListUnmanaged(u8) = .empty;
    defer long_text.deinit(std.testing.allocator);
    try long_text.appendNTimes(std.testing.allocator, 'A', 200);

    try tb.setText(long_text.items);
    view.setWrapMode(.word);
    view.setWrapWidth(null);

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        5,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const virtual_lines = view.getVirtualLines();
    try std.testing.expect(virtual_lines.len == 1);
}

test "drawTextBuffer - wrap mode transitions" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("This is a test line for wrapping");

    view.setWrapMode(.word);
    view.setWrapWidth(null);
    view.updateVirtualLines();
    const no_wrap_lines = view.getVirtualLines().len;

    view.setWrapMode(.char);
    view.setWrapWidth(10);
    view.updateVirtualLines();
    const char_lines = view.getVirtualLines().len;

    view.setWrapMode(.word);
    view.setWrapWidth(10);
    view.updateVirtualLines();
    const word_lines = view.getVirtualLines().len;

    try std.testing.expect(no_wrap_lines == 1);
    try std.testing.expect(char_lines > 1);
    try std.testing.expect(word_lines > 1);
}

test "drawTextBuffer - changing wrap width updates virtual lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("AAAAAAAAAAAAAAAAAAAAAAAAAAAA");

    view.setWrapMode(.char);
    view.setWrapWidth(10);
    view.updateVirtualLines();
    const lines_10 = view.getVirtualLines().len;

    view.setWrapWidth(20);
    view.updateVirtualLines();
    const lines_20 = view.getVirtualLines().len;

    view.setWrapWidth(5);
    view.updateVirtualLines();
    const lines_5 = view.getVirtualLines().len;

    try std.testing.expect(lines_10 > lines_20);
    try std.testing.expect(lines_5 > lines_10);
}

test "drawTextBuffer - wrapping with mixed ASCII and Unicode" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABC測試DEF試験GHI");
    view.setWrapMode(.char);
    view.setWrapWidth(10);
    view.updateVirtualLines();

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        10,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const virtual_lines = view.getVirtualLines();
    try std.testing.expect(virtual_lines.len > 1);
}

test "setStyledText - basic rendering with single chunk" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const style = try ss.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    tb.setSyntaxStyle(style);

    const text = "Hello World";
    const fg_color = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);

    const chunks = [_]StyledChunk{.{
        .text_ptr = text.ptr,
        .text_len = text.len,
        .fg_ptr = @ptrCast(&fg_color),
        .bg_ptr = null,
        .attributes = 0,
    }};

    try tb.setStyledText(&chunks);

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    const result = out_buffer[0..written];

    try std.testing.expectEqualStrings("Hello World", result);
}

test "setStyledText - multiple chunks render correctly" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const style = try ss.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    tb.setSyntaxStyle(style);

    const text0 = "Hello ";
    const text1 = "World";
    const fg_color = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);

    const chunks = [_]StyledChunk{
        .{ .text_ptr = text0.ptr, .text_len = text0.len, .fg_ptr = @ptrCast(&fg_color), .bg_ptr = null, .attributes = 0 },
        .{ .text_ptr = text1.ptr, .text_len = text1.len, .fg_ptr = @ptrCast(&fg_color), .bg_ptr = null, .attributes = 0 },
    };

    try tb.setStyledText(&chunks);

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    const result = out_buffer[0..written];

    try std.testing.expectEqualStrings("Hello World", result);
}

// Viewport Tests

test "viewport - basic vertical scrolling limits returned lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9");

    view.setViewport(.{ .x = 0, .y = 2, .width = 20, .height = 5 });

    const visible_lines = view.getVirtualLines();

    try std.testing.expectEqual(@as(usize, 5), visible_lines.len);
    try std.testing.expectEqual(@as(usize, 2), visible_lines[0].source_line);
    try std.testing.expectEqual(@as(usize, 6), visible_lines[4].source_line);
}

test "viewport - vertical scrolling at start boundary" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4");

    view.setViewport(.{ .x = 0, .y = 0, .width = 20, .height = 3 });

    const visible_lines = view.getVirtualLines();

    try std.testing.expectEqual(@as(usize, 3), visible_lines.len);
    try std.testing.expectEqual(@as(usize, 0), visible_lines[0].source_line);
    try std.testing.expectEqual(@as(usize, 2), visible_lines[2].source_line);
}

test "viewport - vertical scrolling at end boundary" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4");

    view.setViewport(.{ .x = 0, .y = 3, .width = 20, .height = 3 });

    const visible_lines = view.getVirtualLines();

    try std.testing.expectEqual(@as(usize, 2), visible_lines.len);
    try std.testing.expectEqual(@as(usize, 3), visible_lines[0].source_line);
    try std.testing.expectEqual(@as(usize, 4), visible_lines[1].source_line);
}

test "viewport - vertical scrolling beyond content" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 0\nLine 1\nLine 2");

    view.setViewport(.{ .x = 0, .y = 10, .width = 20, .height = 5 });

    const visible_lines = view.getVirtualLines();

    try std.testing.expectEqual(@as(usize, 0), visible_lines.len);
}

test "viewport - with wrapping vertical scrolling" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("This is a long line that will wrap\nShort\nAnother long line that wraps");

    view.setWrapMode(.word);
    view.setWrapWidth(15);
    view.updateVirtualLines();

    const total_vlines = view.getVirtualLineCount();
    try std.testing.expect(total_vlines > 3);

    view.setViewport(.{ .x = 0, .y = 2, .width = 15, .height = 3 });

    const visible_lines = view.getVirtualLines();

    try std.testing.expectEqual(@as(usize, 3), visible_lines.len);
}

test "viewport - getCachedLineInfo returns only viewport lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5");

    view.setViewport(.{ .x = 0, .y = 1, .width = 20, .height = 3 });

    const line_info = view.getCachedLineInfo();

    try std.testing.expectEqual(@as(usize, 3), line_info.line_start_cols.len);
    try std.testing.expectEqual(@as(usize, 3), line_info.line_width_cols.len);
}

test "viewport - changing viewport updates returned lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5");

    view.setViewport(.{ .x = 0, .y = 0, .width = 20, .height = 2 });
    const lines1 = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 2), lines1.len);
    try std.testing.expectEqual(@as(usize, 0), lines1[0].source_line);

    view.setViewport(.{ .x = 0, .y = 3, .width = 20, .height = 2 });
    const lines2 = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 2), lines2.len);
    try std.testing.expectEqual(@as(usize, 3), lines2[0].source_line);

    view.setViewport(.{ .x = 0, .y = 1, .width = 20, .height = 4 });
    const lines3 = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 4), lines3.len);
    try std.testing.expectEqual(@as(usize, 1), lines3[0].source_line);
}

test "viewport - null viewport returns all lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4");

    const all_lines = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 5), all_lines.len);

    view.setViewport(.{ .x = 0, .y = 1, .width = 20, .height = 2 });
    const viewport_lines = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 2), viewport_lines.len);

    view.setViewport(null);
    const all_lines_again = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 5), all_lines_again.len);
}

test "viewport - setViewportSize convenience method" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 0\nLine 1\nLine 2\nLine 3");

    view.setViewportSize(20, 2);
    const vp1 = view.getViewport().?;
    try std.testing.expectEqual(@as(u32, 0), vp1.x);
    try std.testing.expectEqual(@as(u32, 0), vp1.y);
    try std.testing.expectEqual(@as(u32, 20), vp1.width);
    try std.testing.expectEqual(@as(u32, 2), vp1.height);

    view.setViewport(.{ .x = 5, .y = 1, .width = 20, .height = 2 });

    view.setViewportSize(30, 3);
    const vp2 = view.getViewport().?;
    try std.testing.expectEqual(@as(u32, 5), vp2.x);
    try std.testing.expectEqual(@as(u32, 1), vp2.y);
    try std.testing.expectEqual(@as(u32, 30), vp2.width);
    try std.testing.expectEqual(@as(u32, 3), vp2.height);
}

test "viewport - stores horizontal offset value with no wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ");

    view.setWrapMode(.none);
    view.setWrapWidth(null);

    view.setViewport(.{ .x = 5, .y = 0, .width = 10, .height = 1 });

    const vp = view.getViewport().?;
    try std.testing.expectEqual(@as(u32, 5), vp.x);
    try std.testing.expectEqual(@as(u32, 0), vp.y);
    try std.testing.expectEqual(@as(u32, 10), vp.width);
    try std.testing.expectEqual(@as(u32, 1), vp.height);

    const lines = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 1), lines.len);
}

test "viewport - preserves horizontal offset when changing vertical (no wrap)" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJ\nKLMNOPQRST\nUVWXYZ1234");

    view.setWrapMode(.none);
    view.setWrapWidth(null);

    view.setViewport(.{ .x = 3, .y = 0, .width = 8, .height = 2 });

    var vp = view.getViewport().?;
    try std.testing.expectEqual(@as(u32, 3), vp.x);
    try std.testing.expectEqual(@as(u32, 0), vp.y);

    view.setViewport(.{ .x = 3, .y = 1, .width = 8, .height = 2 });

    vp = view.getViewport().?;
    try std.testing.expectEqual(@as(u32, 3), vp.x);
    try std.testing.expectEqual(@as(u32, 1), vp.y);

    const visible_lines = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 2), visible_lines.len);
    try std.testing.expectEqual(@as(usize, 1), visible_lines[0].source_line);
}

test "viewport - can set large horizontal offset (no wrap)" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Short\nLonger line here\nTiny");

    view.setWrapMode(.none);
    view.setWrapWidth(null);

    view.setViewport(.{ .x = 10, .y = 0, .width = 10, .height = 3 });

    const vp = view.getViewport().?;
    try std.testing.expectEqual(@as(u32, 10), vp.x);

    const visible_lines = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 3), visible_lines.len);
}

test "viewport - horizontal and vertical offset combined (no wrap)" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 0: ABCDEFGHIJ\nLine 1: KLMNOPQRST\nLine 2: UVWXYZ1234\nLine 3: 567890ABCD");

    view.setWrapMode(.none);
    view.setWrapWidth(null);

    view.setViewport(.{ .x = 8, .y = 1, .width = 15, .height = 2 });

    const vp = view.getViewport().?;
    try std.testing.expectEqual(@as(u32, 8), vp.x);
    try std.testing.expectEqual(@as(u32, 1), vp.y);

    const visible_lines = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 2), visible_lines.len);
    try std.testing.expectEqual(@as(usize, 1), visible_lines[0].source_line);
    try std.testing.expectEqual(@as(usize, 2), visible_lines[1].source_line);
}

test "viewport - horizontal scrolling only for no-wrap mode" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const long_text = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    try tb.setText(long_text);

    view.setWrapMode(.none);
    view.setWrapWidth(null);
    view.setViewport(.{ .x = 10, .y = 0, .width = 15, .height = 1 });
    view.updateVirtualLines();

    var vp = view.getViewport().?;
    try std.testing.expectEqual(@as(u32, 10), vp.x);

    var lines = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 1), lines.len);

    view.setWrapMode(.char);
    view.setViewport(.{ .x = 10, .y = 0, .width = 15, .height = 5 });
    view.updateVirtualLines();

    vp = view.getViewport().?;
    try std.testing.expectEqual(@as(u32, 10), vp.x);

    lines = view.getVirtualLines();
    try std.testing.expect(lines.len > 1);
}

test "viewport - horizontal offset irrelevant with wrapping enabled" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("This is a very long line that will wrap into multiple virtual lines");

    view.setWrapMode(.word);
    view.setWrapWidth(20);
    view.updateVirtualLines();

    const total_vlines = view.getVirtualLineCount();
    try std.testing.expect(total_vlines > 1);

    view.setViewport(.{ .x = 5, .y = 1, .width = 15, .height = 2 });

    const vp = view.getViewport().?;
    try std.testing.expectEqual(@as(u32, 5), vp.x);
    try std.testing.expectEqual(@as(u32, 1), vp.y);
    try std.testing.expectEqual(@as(u32, 15), vp.width);

    const visible_lines = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 2), visible_lines.len);
}

test "viewport - zero width or height" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 0\nLine 1\nLine 2");

    view.setViewport(.{ .x = 0, .y = 0, .width = 20, .height = 0 });
    const lines1 = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 0), lines1.len);

    view.setViewport(.{ .x = 0, .y = 0, .width = 0, .height = 2 });
    const lines2 = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 2), lines2.len);
}

test "viewport - viewport sets wrap width automatically" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDD");

    view.setWrapMode(.char);

    view.setViewport(.{ .x = 0, .y = 0, .width = 10, .height = 5 });
    view.updateVirtualLines();

    const vline_count_10 = view.getVirtualLineCount();

    view.setViewport(.{ .x = 0, .y = 0, .width = 20, .height = 5 });
    view.updateVirtualLines();

    const vline_count_20 = view.getVirtualLineCount();

    try std.testing.expect(vline_count_10 > vline_count_20);
}

test "viewport - moving viewport dynamically (no wrap)" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("0123456789\nABCDEFGHIJ\nKLMNOPQRST\nUVWXYZ!@#$");

    view.setWrapMode(.none);
    view.setWrapWidth(null);

    view.setViewport(.{ .x = 0, .y = 0, .width = 5, .height = 2 });
    var vp = view.getViewport().?;
    try std.testing.expectEqual(@as(u32, 0), vp.x);
    try std.testing.expectEqual(@as(u32, 0), vp.y);
    const lines1 = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 2), lines1.len);
    try std.testing.expectEqual(@as(usize, 0), lines1[0].source_line);

    view.setViewport(.{ .x = 0, .y = 1, .width = 5, .height = 2 });
    vp = view.getViewport().?;
    try std.testing.expectEqual(@as(u32, 0), vp.x);
    try std.testing.expectEqual(@as(u32, 1), vp.y);
    const lines2 = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 2), lines2.len);
    try std.testing.expectEqual(@as(usize, 1), lines2[0].source_line);

    view.setViewport(.{ .x = 3, .y = 1, .width = 5, .height = 2 });
    vp = view.getViewport().?;
    try std.testing.expectEqual(@as(u32, 3), vp.x);
    try std.testing.expectEqual(@as(u32, 1), vp.y);
    const lines3 = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 2), lines3.len);

    view.setViewport(.{ .x = 5, .y = 2, .width = 5, .height = 2 });
    vp = view.getViewport().?;
    try std.testing.expectEqual(@as(u32, 5), vp.x);
    try std.testing.expectEqual(@as(u32, 2), vp.y);
    const lines4 = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 2), lines4.len);
    try std.testing.expectEqual(@as(usize, 2), lines4[0].source_line);
}

test "loadFile - loads and renders file correctly" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const test_content = "ABC\nDEF";
    const tmpdir = std.testing.tmpDir(.{});
    var tmp = tmpdir;
    defer tmp.cleanup();

    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "test.txt", .data = test_content });
    const file_path = try tmp.dir.realPathFileAlloc(std.testing.io, "test.txt", std.testing.allocator);
    defer std.testing.allocator.free(file_path);

    try tb.loadFile(file_path);

    const line_count = tb.getLineCount();
    try std.testing.expectEqual(@as(u32, 2), line_count);

    const char_count = tb.getLength();
    try std.testing.expectEqual(@as(u32, 6), char_count);

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        5,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    var render_buffer: [200]u8 = undefined;
    const render_written = try opt_buffer.writeResolvedChars(&render_buffer, false);
    const render_result = render_buffer[0..render_written];

    try std.testing.expect(std.mem.startsWith(u8, render_result, "ABC"));
}

test "drawTextBuffer - horizontal viewport offset renders correctly without wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("0123456789ABCDEFGHIJ");

    view.setWrapMode(.none);
    view.setWrapWidth(null);
    view.setViewport(.{ .x = 5, .y = 0, .width = 10, .height = 1 });

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        1,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    var out_buffer: [100]u8 = undefined;
    const written = try opt_buffer.writeResolvedChars(&out_buffer, false);
    const result = out_buffer[0..written];

    try std.testing.expect(std.mem.startsWith(u8, result, "56789ABCDE"));
}

test "drawTextBuffer - horizontal viewport offset with multiple lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNO\n0123456789!@#$%\nXYZ[\\]^_`{|}~");

    view.setWrapMode(.none);
    view.setWrapWidth(null);
    view.setViewport(.{ .x = 3, .y = 0, .width = 8, .height = 3 });

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        8,
        3,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    var out_buffer: [100]u8 = undefined;
    const written = try opt_buffer.writeResolvedChars(&out_buffer, false);
    const result = out_buffer[0..written];

    try std.testing.expect(std.mem.find(u8, result, "DEFGHIJK") != null);
    try std.testing.expect(std.mem.find(u8, result, "3456789!") != null);
    try std.testing.expect(std.mem.find(u8, result, "[\\]^_`{|") != null);
}

test "drawTextBuffer - combined horizontal and vertical viewport offsets" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line0ABCDEFGHIJ\nLine1KLMNOPQRST\nLine2UVWXYZ0123\nLine3456789!@#$");

    view.setWrapMode(.none);
    view.setWrapWidth(null);
    view.setViewport(.{ .x = 5, .y = 1, .width = 10, .height = 2 });

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        2,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    var out_buffer: [100]u8 = undefined;
    const written = try opt_buffer.writeResolvedChars(&out_buffer, false);
    const result = out_buffer[0..written];

    try std.testing.expect(std.mem.find(u8, result, "KLMNOPQRST") != null);
    try std.testing.expect(std.mem.find(u8, result, "UVWXYZ0123") != null);
}

test "drawTextBuffer - horizontal viewport stops rendering at viewport width" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ");

    view.setWrapMode(.none);
    view.setWrapWidth(null);
    view.setViewport(.{ .x = 5, .y = 0, .width = 10, .height = 1 });

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        1,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    var out_buffer: [100]u8 = undefined;
    const written = try opt_buffer.writeResolvedChars(&out_buffer, false);
    const result = out_buffer[0..written];

    try std.testing.expectEqualStrings("56789ABCDE", result[0..10]);

    const cell_9 = opt_buffer.get(9, 0);
    try std.testing.expect(cell_9 != null);
    try std.testing.expectEqual(@as(u32, 'E'), cell_9.?.char);
}

test "drawTextBuffer - horizontal viewport with small buffer renders only viewport width" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");

    view.setWrapMode(.none);
    view.setWrapWidth(null);
    view.setViewport(.{ .x = 10, .y = 0, .width = 5, .height = 1 });

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        1,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const cell_0 = opt_buffer.get(0, 0);
    try std.testing.expect(cell_0 != null);
    try std.testing.expectEqual(@as(u32, 'K'), cell_0.?.char);

    const cell_4 = opt_buffer.get(4, 0);
    try std.testing.expect(cell_4 != null);
    try std.testing.expectEqual(@as(u32, 'O'), cell_4.?.char);

    const cell_5 = opt_buffer.get(5, 0);
    try std.testing.expect(cell_5 != null);
    try std.testing.expectEqual(@as(u32, 32), cell_5.?.char);

    const cell_6 = opt_buffer.get(6, 0);
    try std.testing.expect(cell_6 != null);
    try std.testing.expectEqual(@as(u32, 32), cell_6.?.char);
}

test "drawTextBuffer - horizontal viewport width limits rendering (efficiency test)" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var long_line: std.ArrayListUnmanaged(u8) = .empty;
    defer long_line.deinit(std.testing.allocator);
    try long_line.appendNTimes(std.testing.allocator, 'A', 1000);

    try tb.setText(long_line.items);

    view.setWrapMode(.none);
    view.setWrapWidth(null);
    view.setViewport(.{ .x = 100, .y = 0, .width = 10, .height = 1 });

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        50,
        1,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    var non_space_count: u32 = 0;
    var i: u32 = 0;
    while (i < 50) : (i += 1) {
        if (opt_buffer.get(i, 0)) |cell| {
            if (cell.char == 'A') {
                non_space_count += 1;
            }
        }
    }

    try std.testing.expectEqual(@as(u32, 10), non_space_count);
}

test "drawTextBuffer - overwriting wide grapheme with ASCII leaves no ghost chars" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        5,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    try tb.setText("世界");
    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const first_cell = opt_buffer.get(0, 0) orelse unreachable;
    try std.testing.expect(gp.isGraphemeChar(first_cell.char));
    try std.testing.expectEqual(@as(u32, 2), gp.encodedCharWidth(first_cell.char));

    const second_cell = opt_buffer.get(1, 0) orelse unreachable;
    try std.testing.expect(gp.isContinuationChar(second_cell.char));

    try tb.setText("ABC");
    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const cell_a = opt_buffer.get(0, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'A'), cell_a.char);
    try std.testing.expect(!gp.isGraphemeChar(cell_a.char));
    try std.testing.expect(!gp.isContinuationChar(cell_a.char));

    const cell_b = opt_buffer.get(1, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'B'), cell_b.char);
    try std.testing.expect(!gp.isGraphemeChar(cell_b.char));
    try std.testing.expect(!gp.isContinuationChar(cell_b.char));

    const cell_c = opt_buffer.get(2, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'C'), cell_c.char);
    try std.testing.expect(!gp.isGraphemeChar(cell_c.char));
    try std.testing.expect(!gp.isContinuationChar(cell_c.char));

    var out_buffer: [100]u8 = undefined;
    const written = try opt_buffer.writeResolvedChars(&out_buffer, false);
    const result = out_buffer[0..written];
    try std.testing.expect(std.mem.startsWith(u8, result, "ABC"));
}

test "drawTextBuffer - syntax style destroy does not crash" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var style = try ss.SyntaxStyle.init(std.testing.allocator);
    tb.setSyntaxStyle(style);

    const style_id = try style.registerStyle("test", ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0), null, 0);
    try tb.setText("Hello World");
    try tb.addHighlightByCharRange(0, 5, style_id, 1, 0);

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        5,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    var out_buffer: [100]u8 = undefined;
    const written = try opt_buffer.writeResolvedChars(&out_buffer, false);
    const result = out_buffer[0..written];
    try std.testing.expect(std.mem.startsWith(u8, result, "Hello World"));

    style.deinit();

    try std.testing.expect(tb.getSyntaxStyle() == null);

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const written2 = try opt_buffer.writeResolvedChars(&out_buffer, false);
    const result2 = out_buffer[0..written2];
    try std.testing.expect(std.mem.startsWith(u8, result2, "Hello World"));
}

test "drawTextBuffer - tabs are rendered as spaces (empty cells)" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    tb.setTabWidth(4);

    try tb.setText("A\tB");

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        5,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const cell_0 = opt_buffer.get(0, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'A'), cell_0.char);

    const cell_1 = opt_buffer.get(1, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 32), cell_1.char);

    const cell_2 = opt_buffer.get(2, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 32), cell_2.char);

    const cell_3 = opt_buffer.get(3, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 32), cell_3.char);

    const cell_4 = opt_buffer.get(4, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 32), cell_4.char);

    // With static tabs: A at col 0, tab takes 4 cols (1-4), B at col 5
    const cell_5 = opt_buffer.get(5, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'B'), cell_5.char);
}

test "drawTextBuffer - tab indicator renders with correct color" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    tb.setTabWidth(4);
    try tb.setText("A\tB");

    view.setTabIndicator(@as(u32, '→'));
    view.setTabIndicatorColor(ansi.rgbaFromFloats(0.25, 0.25, 0.25, 1.0));

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        5,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const cell_0 = opt_buffer.get(0, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'A'), cell_0.char);

    const cell_1 = opt_buffer.get(1, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, '→'), cell_1.char);
    try std.testing.expectEqual(@as(u8, 64), ansi.red(cell_1.fg));
    try std.testing.expectEqual(@as(u8, 64), ansi.green(cell_1.fg));
    try std.testing.expectEqual(@as(u8, 64), ansi.blue(cell_1.fg));

    const cell_2 = opt_buffer.get(2, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 32), cell_2.char);

    const cell_3 = opt_buffer.get(3, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 32), cell_3.char);

    const cell_4 = opt_buffer.get(4, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 32), cell_4.char);

    // With static tabs: A at col 0, tab takes 4 cols (1-4), B at col 5
    const cell_5 = opt_buffer.get(5, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'B'), cell_5.char);
}

test "drawTextBuffer - wide tab indicator occupies whole cells without moving selected text" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();
    const tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    const view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();
    tb.setTabWidth(2);
    try tb.setText("A\tB");
    view.setWrapMode(.none);
    view.setTabIndicator(0x754c);
    const target = try OptimizedBuffer.init(std.testing.allocator, 8, 1, .{ .pool = pool, .width_method = .unicode });
    defer target.deinit();
    const selected = ansi.rgbColor(40, 80, 120, 255);
    view.setSelection(1, 4, selected, null);
    for ([_]struct { width: u32, text: []const u8 }{
        .{ .width = 8, .text = "A\u{754c}B    " },
        .{ .width = 3, .text = "A\u{754c}     " },
        .{ .width = 2, .text = "A       " },
    }) |case| {
        target.clear(ansi.rgbColor(0, 0, 0, 255), 32);
        view.setViewport(.{ .x = 0, .y = 0, .width = case.width, .height = 1 });
        try target.drawTextBufferChecked(view, 0, 0);
        var output: [32]u8 = undefined;
        const written = try target.writeResolvedChars(&output, false);
        try std.testing.expectEqualStrings(case.text, output[0..written]);
        try std.testing.expectEqual(@as(u32, 8), @import("../utf8.zig").calculateTextWidth(output[0..written], 2, false, .unicode));
        try std.testing.expectEqual(selected, target.get(1, 0).?.bg);
        if (case.width == 8) {
            try std.testing.expectEqual(@as(u32, 'B'), target.get(3, 0).?.char);
            try std.testing.expectEqual(selected, target.get(3, 0).?.bg);
        }
    }
}

test "drawTextBuffer - tab without indicator renders as spaces" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    tb.setTabWidth(4);
    try tb.setText("A\tB");

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        5,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const cell_0 = opt_buffer.get(0, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'A'), cell_0.char);

    const cell_1 = opt_buffer.get(1, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 32), cell_1.char);

    const cell_2 = opt_buffer.get(2, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 32), cell_2.char);

    const cell_3 = opt_buffer.get(3, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 32), cell_3.char);

    const cell_4 = opt_buffer.get(4, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 32), cell_4.char);

    // With static tabs: A at col 0, tab takes 4 cols (1-4), B at col 5
    const cell_5 = opt_buffer.get(5, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'B'), cell_5.char);
}

test "drawTextBuffer - mixed ASCII and Unicode with emoji renders completely" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("- ✅ All 881 native tests passs");

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        50,
        5,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const cell_0 = opt_buffer.get(0, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, '-'), cell_0.char);

    const cell_1 = opt_buffer.get(1, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, ' '), cell_1.char);

    const cell_2 = opt_buffer.get(2, 0) orelse unreachable;
    try std.testing.expect(gp.isGraphemeChar(cell_2.char));
    const width_2 = gp.encodedCharWidth(cell_2.char);
    try std.testing.expectEqual(@as(u32, 2), width_2);

    const cell_3 = opt_buffer.get(3, 0) orelse unreachable;
    try std.testing.expect(gp.isContinuationChar(cell_3.char));

    const cell_4 = opt_buffer.get(4, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, ' '), cell_4.char);

    const cell_5 = opt_buffer.get(5, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'A'), cell_5.char);

    const cell_6 = opt_buffer.get(6, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'l'), cell_6.char);

    const cell_7 = opt_buffer.get(7, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'l'), cell_7.char);

    const cell_8 = opt_buffer.get(8, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, ' '), cell_8.char);

    const cell_9 = opt_buffer.get(9, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, '8'), cell_9.char);

    const cell_10 = opt_buffer.get(10, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, '8'), cell_10.char);

    const cell_11 = opt_buffer.get(11, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, '1'), cell_11.char);

    const cell_12 = opt_buffer.get(12, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, ' '), cell_12.char);

    const cell_13 = opt_buffer.get(13, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'n'), cell_13.char);

    const cell_14 = opt_buffer.get(14, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'a'), cell_14.char);

    const cell_15 = opt_buffer.get(15, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 't'), cell_15.char);

    const cell_16 = opt_buffer.get(16, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'i'), cell_16.char);

    const cell_17 = opt_buffer.get(17, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'v'), cell_17.char);

    const cell_18 = opt_buffer.get(18, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'e'), cell_18.char);

    const cell_19 = opt_buffer.get(19, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, ' '), cell_19.char);

    const cell_20 = opt_buffer.get(20, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 't'), cell_20.char);

    const cell_21 = opt_buffer.get(21, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'e'), cell_21.char);

    const cell_22 = opt_buffer.get(22, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 's'), cell_22.char);

    const cell_23 = opt_buffer.get(23, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 't'), cell_23.char);

    const cell_24 = opt_buffer.get(24, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 's'), cell_24.char);

    const cell_25 = opt_buffer.get(25, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, ' '), cell_25.char);

    const cell_26 = opt_buffer.get(26, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'p'), cell_26.char);

    const cell_27 = opt_buffer.get(27, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'a'), cell_27.char);

    const cell_28 = opt_buffer.get(28, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 's'), cell_28.char);

    const cell_29 = opt_buffer.get(29, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 's'), cell_29.char);

    const cell_30 = opt_buffer.get(30, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 's'), cell_30.char);

    var out_buffer: [500]u8 = undefined;
    const written = try opt_buffer.writeResolvedChars(&out_buffer, false);
    const result = out_buffer[0..written];

    try std.testing.expect(std.mem.find(u8, result, "- ✅ All 881 native tests passs") != null);

    const plain_text = tb.getPlainTextIntoBuffer(&out_buffer);
    const plain_result = out_buffer[0..plain_text];
    try std.testing.expectEqualStrings("- ✅ All 881 native tests passs", plain_result);
}

test "viewport width = 31 exactly - last character rendering" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("- ✅ All 881 native tests passs");

    // Set viewport width to EXACTLY 31 (the display width needed)
    view.setViewport(.{ .x = 0, .y = 0, .width = 31, .height = 1 });

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        50,
        5,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    // BUG CHECK: The last 's' at cell 30 should be present
    const cell_30 = opt_buffer.get(30, 0);
    if (cell_30) |c| {
        try std.testing.expectEqual(@as(u32, 's'), c.char);
    } else {
        return error.TestFailed;
    }
}

test "drawTextBuffer - complex multilingual text with diverse scripts and emojis" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const text =
        \\# The Celestial Journey of संस्कृति 🌟🔮✨
        \\In the beginning, there was नमस्ते 🙏 and the ancient wisdom of the ॐ symbol echoing through dimensions. The travelers 🧑‍🚀👨‍🚀👩‍🚀 embarked on their quest through the cosmos, guided by the mysterious རྒྱ་མཚོ and the luminous 🌈🦄🧚‍♀️ beings of light. They encountered the great देवनागरी scribes who wrote in flowing अक्षर characters, documenting everything in their sacred texts 📜📖✍️.
        \\## Chapter प्रथम: The Eastern Gardens 🏯🎋🌸
        \\The journey led them to the mystical lands where 漢字 (kanji) danced with ひらがな and カタカナ across ancient scrolls 📯🎴🎎. In the gardens of Seoul, they found 한글 inscriptions speaking of 사랑 (love) and 평화 (peace) 💝🕊️☮️. The monks meditated under the bodhi tree 🧘‍♂️🌳, contemplating the nature of धर्म while drinking matcha 🍵 and eating 餃子 dumplings 🥟.
        \\Strange creatures emerged from the mist: 🦥🦦🦧🦨🦩🦚🦜🦝🦞🦟. They spoke in riddles about the प्राचीन (ancient) ways and the नवीन (new) paths forward. "भविष्य में क्या है?" they asked, while the ໂຫຍ່າກເຈົ້າ whispered secrets in Lao script 🤫🗣️💬.
        \\## The संगम (Confluence) of Scripts 🌊📝🎭
        \\At the great confluence, they witnessed the merger of བོད་ཡིག (Tibetan), ગુજરાતી (Gujarati), and தமிழ் (Tamil) scripts flowing together like rivers 🏞️🌊💧. The scholars debated about ਪੰਜਾਬੀ philosophy while juggling 🤹‍♂️🎪🎨 colorful orbs that represented different తెలుగు concepts.
        \\The marketplace buzzed with activity 🏪🛒💰: merchants sold বাংলা spices 🌶️🧄🧅, ಕನ್ನಡ silks 🧵👘, and മലയാളം handicrafts 🎨🖼️. Children played with toys shaped like 🦖🦕🐉🐲 while their parents bargained using ancient ଓଡ଼ିଆ numerals and gestures 🤝🤲👐.
        \\## The Festival of ๑๐๐ Lanterns 🏮🎆🎇
        \\During the grand festival, they lit exactly ๑๐๐ (100 in Thai numerals) lanterns 🏮🕯️💡 that floated into the night sky like ascending ความหวัง (hopes). The celebration featured dancers 💃🕺🩰 performing classical moves from भरतनाट्यम tradition, their मुद्रा hand gestures telling stories of प्रेम and वीरता.
        \\Musicians played unusual instruments: the 🎻🎺🎷🎸🪕🪘 ensemble created harmonies that resonated with the वेद chants and མཆོད་རྟེན bells 🔔⛩️. The audience sat mesmerized 😵‍💫🤯✨, some sipping on bubble tea 🧋 while others enjoyed मिठाई sweets 🍬🍭🧁.
        \\## The འཕྲུལ་དེབ (Machine) Age Arrives ⚙️🤖🦾
        \\As modernity crept in, the ancient འཁོར་ལོ (wheel) gave way to 🚗🚕🚙🚌🚎 vehicles and eventually to 🚀🛸🛰️ spacecraft. The યુવાન (youth) learned to code in Python 🐍💻⌨️, but still honored their గురువు (teachers) who taught them the old ways of ज्ञान acquisition 🧠📚🎓.
        \\The সমাজ (society) transformed: robots 🤖🦾🦿 worked alongside humans 👨‍💼👩‍💼👨‍🔬👩‍🔬, and AI learned to read སྐད (languages) from across the planet 🌍🌎🌏. Yet somehow, the essence of मानवता remained intact, preserved in the கவிதை (poetry) and the ກາບແກ້ວ stories passed down through generations 👴👵👨‍👩‍👧‍👦.
        \\## The Final ಅಧ್ಯಾಯ (Chapter) 🌅🌄🌠
        \\As the sun set over the പർവ്വതങ്ങൾ (mountains) 🏔️⛰️🗻, our travelers realized that every script, every symbol—from ا to ㄱ to অ to अ—represented not just sounds, but entire civilizations' worth of विचार (thoughts) and ಕನಸು (dreams) 💭💤🌌.
        \\They gathered around the final campfire 🔥🏕️, sharing stories in ภาษา (languages) both ancient and new. Someone brought out a guitar 🎸 and started singing in ગીત form, while others prepared ආහාර (food) 🍛🍲🥘 seasoned with love ❤️💕💖 and memories 📸🎞️📹.
        \\And so they learned that whether written in দেবনাগরী, 中文, 한글, or ไทย, the human experience transcends boundaries 🌐🤝🌈. The weird emojis 🦩🧿🪬🫀🫁🧠 and complex scripts were all part of the same beautiful བསྟན་པ (teaching): that diversity is our greatest strength 💪✊🙌.
        \\The end. समाप्त. 끝. จบ. முடிவு. ముగింపు. সমাপ্তি. ഒടുക്കം. ಅಂತ್ಯ. અંત. 🎬🎭🎪✨🌟⭐
        \\
    ;

    try tb.setText(text);

    // Test with word wrapping
    view.setWrapMode(.word);
    view.setWrapWidth(80);
    view.updateVirtualLines();

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        80,
        100,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    // Verify the text buffer can handle complex multilingual content
    const virtual_lines = view.getVirtualLines();
    try std.testing.expect(virtual_lines.len > 0);

    // Test that we can get the plain text back
    var plain_buffer: [10000]u8 = undefined;
    const plain_len = tb.getPlainTextIntoBuffer(&plain_buffer);
    const plain_text = plain_buffer[0..plain_len];

    // Verify some key multilingual content is present
    try std.testing.expect(std.mem.find(u8, plain_text, "संस्कृति") != null);
    try std.testing.expect(std.mem.find(u8, plain_text, "नमस्ते") != null);
    try std.testing.expect(std.mem.find(u8, plain_text, "漢字") != null);
    try std.testing.expect(std.mem.find(u8, plain_text, "한글") != null);
    try std.testing.expect(std.mem.find(u8, plain_text, "தமிழ்") != null);
    try std.testing.expect(std.mem.find(u8, plain_text, "বাংলা") != null);
    try std.testing.expect(std.mem.find(u8, plain_text, "ಕನ್ನಡ") != null);
    try std.testing.expect(std.mem.find(u8, plain_text, "മലയാളം") != null);
    try std.testing.expect(std.mem.find(u8, plain_text, "🌟") != null);
    try std.testing.expect(std.mem.find(u8, plain_text, "🙏") != null);

    // Test with no wrapping
    view.setWrapMode(.none);
    view.setWrapWidth(null);
    view.updateVirtualLines();

    const no_wrap_lines = view.getVirtualLines();
    // Should have one line per actual newline in the text
    try std.testing.expect(no_wrap_lines.len > 10);

    // Test with character wrapping on narrow width
    view.setWrapMode(.char);
    view.setWrapWidth(40);
    view.updateVirtualLines();

    const char_wrap_lines = view.getVirtualLines();
    // Should wrap into many more lines
    try std.testing.expect(char_wrap_lines.len > virtual_lines.len);

    // Test viewport scrolling through the content
    view.setWrapMode(.word);
    view.setWrapWidth(80);
    view.setViewport(.{ .x = 0, .y = 10, .width = 80, .height = 20 });
    view.updateVirtualLines();

    const viewport_lines = view.getVirtualLines();
    try std.testing.expect(viewport_lines.len <= 20);

    // Verify rendering doesn't crash with complex emoji sequences
    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    // Test that line count is reasonable
    const line_count = tb.getLineCount();
    try std.testing.expect(line_count > 15);
}

test "drawTextBuffer - wide glyph skips every crossed highlight boundary" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();
    const tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    const style = try ss.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    tb.setSyntaxStyle(style);
    const red = try style.registerStyle("red", ansi.rgbaFromFloats(1, 0, 0, 1), null, 0);
    const green_color = ansi.rgbaFromFloats(0, 1, 0, 1);
    const green = try style.registerStyle("green", green_color, null, 0);
    try tb.setText("界X");
    try tb.addHighlight(0, 0, 1, red, 1, 0);
    try tb.addHighlight(0, 1, 2, red, 1, 0);
    try tb.addHighlight(0, 2, 3, green, 1, 0);
    const view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();
    const output = try OptimizedBuffer.init(std.testing.allocator, 4, 1, .{ .pool = pool, .width_method = .unicode });
    defer output.deinit();
    output.clear(ansi.rgbaFromFloats(0, 0, 0, 1), 32);
    output.drawTextBuffer(view, 0, 0);
    try std.testing.expectEqual(@as(u32, 'X'), output.get(2, 0).?.char);
    try std.testing.expectEqualDeep(green_color, output.get(2, 0).?.fg);
}

test "setStyledText - scalar-split grapheme keeps the following token color" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();
    const red = ansi.rgbaFromFloats(1, 0, 0, 1);
    const green = ansi.rgbaFromFloats(0, 1, 0, 1);
    inline for (.{ .wcwidth, .unicode, .no_zwj, .unicode_wide }) |method| {
        const tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, method);
        defer tb.deinit();
        const style = try ss.SyntaxStyle.init(std.testing.allocator);
        defer style.deinit();
        tb.setSyntaxStyle(style);
        const view = try TextBufferView.init(std.testing.allocator, tb);
        defer view.deinit();
        const output = try OptimizedBuffer.init(std.testing.allocator, 12, 1, .{ .pool = pool, .width_method = method });
        defer output.deinit();
        const chunks = [_]StyledChunk{
            .{ .text_ptr = "👩".ptr, .text_len = "👩".len, .fg_ptr = @ptrCast(&red), .bg_ptr = null, .attributes = 0 },
            .{ .text_ptr = "\u{200d}".ptr, .text_len = "\u{200d}".len, .fg_ptr = @ptrCast(&red), .bg_ptr = null, .attributes = 0 },
            .{ .text_ptr = "💻".ptr, .text_len = "💻".len, .fg_ptr = @ptrCast(&red), .bg_ptr = null, .attributes = 0 },
            .{ .text_ptr = "X".ptr, .text_len = 1, .fg_ptr = @ptrCast(&green), .bg_ptr = null, .attributes = 0 },
        };
        try tb.setStyledText(&chunks);
        output.clear(ansi.rgbaFromFloats(0, 0, 0, 1), 32);
        output.drawTextBuffer(view, 0, 0);
        const cell = output.get(tb.measureText("👩‍💻"), 0).?;
        try std.testing.expectEqual(@as(u32, 'X'), cell.char);
        try std.testing.expectEqualDeep(green, cell.fg);
    }
}

test "setStyledText - highlight positioning with Unicode text" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const style = try ss.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    tb.setSyntaxStyle(style);

    // Text: "Say नमस्ते please."
    // Layout: "Say " (4 cols) + "नमस्ते" (4 cols) + " " (1 col) + "please" (6 cols) + "." (1 col)
    // We highlight "please" with a green background to verify correct positioning
    const text_part1 = "Say ";
    const text_part2 = "नमस्ते";
    const text_part3 = " ";
    const text_part4 = "please";
    const text_part5 = ".";

    const fg_normal = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg_highlight = ansi.rgbaFromFloats(0.0, 1.0, 0.0, 1.0); // Green background

    const chunks = [_]StyledChunk{
        .{ .text_ptr = text_part1.ptr, .text_len = text_part1.len, .fg_ptr = @ptrCast(&fg_normal), .bg_ptr = null, .attributes = 0 },
        .{ .text_ptr = text_part2.ptr, .text_len = text_part2.len, .fg_ptr = @ptrCast(&fg_normal), .bg_ptr = null, .attributes = 0 },
        .{ .text_ptr = text_part3.ptr, .text_len = text_part3.len, .fg_ptr = @ptrCast(&fg_normal), .bg_ptr = null, .attributes = 0 },
        .{ .text_ptr = text_part4.ptr, .text_len = text_part4.len, .fg_ptr = @ptrCast(&fg_normal), .bg_ptr = @ptrCast(&bg_highlight), .attributes = 0 },
        .{ .text_ptr = text_part5.ptr, .text_len = text_part5.len, .fg_ptr = @ptrCast(&fg_normal), .bg_ptr = null, .attributes = 0 },
    };

    try tb.setStyledText(&chunks);

    // Verify the text content
    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    const result = out_buffer[0..written];
    try std.testing.expectEqualStrings("Say नमस्ते please.", result);

    // Calculate expected positions using measureText
    const part1_width = tb.measureText(text_part1);
    const part2_width = tb.measureText(text_part2);
    const part3_width = tb.measureText(text_part3);
    const please_start_col = part1_width + part2_width + part3_width;

    // Render to buffer and check colors
    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        30,
        5,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    // Check that "please" (6 characters) all have the green background
    const epsilon: f32 = 0.01;
    var i: u32 = 0;
    while (i < 6) : (i += 1) {
        const cell_col = please_start_col + i;
        const cell = opt_buffer.get(cell_col, 0) orelse return error.TestFailed;

        // Verify green background (R=0, G=1, B=0)
        try std.testing.expect(@abs(ansi.redF(cell.bg) - 0.0) < epsilon);
        try std.testing.expect(@abs(ansi.greenF(cell.bg) - 1.0) < epsilon);
        try std.testing.expect(@abs(ansi.blueF(cell.bg) - 0.0) < epsilon);
    }

    // Check that text before "please" does NOT have green background
    i = 0;
    while (i < please_start_col) : (i += 1) {
        const cell = opt_buffer.get(i, 0) orelse unreachable;
        const has_green_bg = @abs(ansi.greenF(cell.bg) - 1.0) < epsilon and @abs(ansi.redF(cell.bg) - 0.0) < epsilon;
        try std.testing.expect(!has_green_bg);
    }

    // Check that "." after "please" does NOT have green background
    const period_col = please_start_col + 6;
    const period_cell = opt_buffer.get(period_col, 0) orelse unreachable;
    const has_green_bg = @abs(ansi.greenF(period_cell.bg) - 1.0) < epsilon and @abs(ansi.redF(period_cell.bg) - 0.0) < epsilon;
    try std.testing.expect(!has_green_bg);
}

test "drawTextBuffer - multiple syntax highlights with various horizontal viewport offsets" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const style = try ss.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    tb.setSyntaxStyle(style);

    // Register different color styles
    const red_style = try style.registerStyle("red", ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0), null, 0);
    const green_style = try style.registerStyle("green", ansi.rgbaFromFloats(0.0, 1.0, 0.0, 1.0), null, 0);
    const blue_style = try style.registerStyle("blue", ansi.rgbaFromFloats(0.0, 0.0, 1.0, 1.0), null, 0);
    const yellow_style = try style.registerStyle("yellow", ansi.rgbaFromFloats(1.0, 1.0, 0.0, 1.0), null, 0);

    // Text: "const x = function(y) { return y * 2; }"
    const test_text = "const x = function(y) { return y * 2; }";
    // Positions (0-indexed):
    // "const" is at 0-5 (exclusive end, so 0,1,2,3,4)
    // "function" is at 10-18 (chars 10-17)
    // "return" is at 24-30 (chars 24-29)
    // "2" is at 35-36 (char 35)

    try tb.setText(test_text);

    try tb.addHighlightByCharRange(0, 5, red_style, 1, 0); // "const"
    try tb.addHighlightByCharRange(10, 18, green_style, 1, 0); // "function"
    try tb.addHighlightByCharRange(24, 30, blue_style, 1, 0); // "return"
    try tb.addHighlightByCharRange(35, 36, yellow_style, 1, 0); // "2"

    view.setWrapMode(.none);
    view.setWrapWidth(null);

    const epsilon: f32 = 0.01;

    // Test 1: Viewport at x=0 (no scroll)
    {
        view.setViewport(.{ .x = 0, .y = 0, .width = 40, .height = 1 });
        var opt_buffer = try OptimizedBuffer.init(std.testing.allocator, 40, 1, .{ .pool = pool, .width_method = .unicode });
        defer opt_buffer.deinit();

        opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
        opt_buffer.drawTextBuffer(view, 0, 0);

        // Check "const" is red
        const cell_0 = opt_buffer.get(0, 0) orelse unreachable;
        try std.testing.expectEqual(@as(u32, 'c'), cell_0.char);
        try std.testing.expect(@abs(ansi.redF(cell_0.fg) - 1.0) < epsilon); // Red

        const cell_4 = opt_buffer.get(4, 0) orelse unreachable;
        try std.testing.expectEqual(@as(u32, 't'), cell_4.char);
        try std.testing.expect(@abs(ansi.redF(cell_4.fg) - 1.0) < epsilon); // Red

        // Check "function" is green
        const cell_10 = opt_buffer.get(10, 0) orelse unreachable;
        try std.testing.expectEqual(@as(u32, 'f'), cell_10.char);
        try std.testing.expect(@abs(ansi.greenF(cell_10.fg) - 1.0) < epsilon); // Green

        const cell_17 = opt_buffer.get(17, 0) orelse unreachable;
        try std.testing.expectEqual(@as(u32, 'n'), cell_17.char);
        try std.testing.expect(@abs(ansi.greenF(cell_17.fg) - 1.0) < epsilon); // Green
    }

    // Test 2: Viewport scrolled to x=3 (showing "st x = fun...")
    {
        view.setViewport(.{ .x = 3, .y = 0, .width = 20, .height = 1 });
        var opt_buffer = try OptimizedBuffer.init(std.testing.allocator, 20, 1, .{ .pool = pool, .width_method = .unicode });
        defer opt_buffer.deinit();

        opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
        opt_buffer.drawTextBuffer(view, 0, 0);

        // Buffer shows characters 3-22 from source: "st x = function(y) {"
        // Position 0: 's' (source 3) - should be RED (part of "const" 0-5)
        // Position 1: 't' (source 4) - should be RED (part of "const" 0-5)
        // Position 2: ' ' (source 5) - NOT red (outside "const")
        // Position 7: 'f' (source 10) - should be GREEN (start of "function" 10-18)
        // Position 14: 'n' (source 17) - should be GREEN (part of "function")

        const cell_0 = opt_buffer.get(0, 0) orelse unreachable;
        try std.testing.expectEqual(@as(u32, 's'), cell_0.char);
        try std.testing.expect(@abs(ansi.redF(cell_0.fg) - 1.0) < epsilon); // Red
        try std.testing.expect(@abs(ansi.greenF(cell_0.fg) - 0.0) < epsilon);
        try std.testing.expect(@abs(ansi.blueF(cell_0.fg) - 0.0) < epsilon);

        const cell_1 = opt_buffer.get(1, 0) orelse unreachable;
        try std.testing.expectEqual(@as(u32, 't'), cell_1.char);
        try std.testing.expect(@abs(ansi.redF(cell_1.fg) - 1.0) < epsilon); // Red
        try std.testing.expect(@abs(ansi.greenF(cell_1.fg) - 0.0) < epsilon);
        try std.testing.expect(@abs(ansi.blueF(cell_1.fg) - 0.0) < epsilon);

        const cell_2 = opt_buffer.get(2, 0) orelse unreachable;
        try std.testing.expectEqual(@as(u32, ' '), cell_2.char);
        try std.testing.expect(@abs(ansi.redF(cell_2.fg) - 1.0) < epsilon); // White (default)
        try std.testing.expect(@abs(ansi.greenF(cell_2.fg) - 1.0) < epsilon);
        try std.testing.expect(@abs(ansi.blueF(cell_2.fg) - 1.0) < epsilon);

        const cell_7 = opt_buffer.get(7, 0) orelse unreachable;
        try std.testing.expectEqual(@as(u32, 'f'), cell_7.char);
        try std.testing.expect(@abs(ansi.redF(cell_7.fg) - 0.0) < epsilon); // Green
        try std.testing.expect(@abs(ansi.greenF(cell_7.fg) - 1.0) < epsilon);
        try std.testing.expect(@abs(ansi.blueF(cell_7.fg) - 0.0) < epsilon);

        const cell_14 = opt_buffer.get(14, 0) orelse unreachable;
        try std.testing.expectEqual(@as(u32, 'n'), cell_14.char);
        try std.testing.expect(@abs(ansi.redF(cell_14.fg) - 0.0) < epsilon); // Green
        try std.testing.expect(@abs(ansi.greenF(cell_14.fg) - 1.0) < epsilon);
        try std.testing.expect(@abs(ansi.blueF(cell_14.fg) - 0.0) < epsilon);
    }

    // Test 4: Viewport scrolled to x=30 (showing "y * 2; }" based on 40 char text)
    {
        view.setViewport(.{ .x = 30, .y = 0, .width = 20, .height = 1 });
        var opt_buffer = try OptimizedBuffer.init(std.testing.allocator, 20, 1, .{ .pool = pool, .width_method = .unicode });
        defer opt_buffer.deinit();

        opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
        opt_buffer.drawTextBuffer(view, 0, 0);

        // Actual rendering shows: " y * 2; }"
        // Source chars 30-38 are shown
        // Position 0: ' ' (source 30) - white
        // Position 5: '2' (source 35) - should be YELLOW (highlighted 35-36)

        const cell_5 = opt_buffer.get(5, 0) orelse unreachable;
        try std.testing.expectEqual(@as(u32, '2'), cell_5.char);
        try std.testing.expect(@abs(ansi.redF(cell_5.fg) - 1.0) < epsilon); // Yellow
        try std.testing.expect(@abs(ansi.greenF(cell_5.fg) - 1.0) < epsilon);
        try std.testing.expect(@abs(ansi.blueF(cell_5.fg) - 0.0) < epsilon);
    }
}

test "drawTextBuffer - syntax highlighting with horizontal viewport offset" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const style = try ss.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    tb.setSyntaxStyle(style);

    // Register a red style
    const red_style_id = try style.registerStyle("keyword", ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0), null, 0);

    // Text: "const x = 1"
    // Highlight "const" (characters 0-5) in red
    try tb.setText("const x = 1");
    try tb.addHighlightByCharRange(0, 5, red_style_id, 1, 0);

    // Set viewport to skip first 3 characters, showing "st x = 1"
    view.setWrapMode(.none);
    view.setWrapWidth(null);
    view.setViewport(.{ .x = 3, .y = 0, .width = 10, .height = 1 });

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        1,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const epsilon: f32 = 0.01;
    const red_fg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    // Check that 's' at buffer position 0 is RED
    const cell_0 = opt_buffer.get(0, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 's'), cell_0.char);
    const is_red_0 = @abs(ansi.redF(cell_0.fg) - ansi.redF(red_fg)) < epsilon and
        @abs(ansi.greenF(cell_0.fg) - ansi.greenF(red_fg)) < epsilon and
        @abs(ansi.blueF(cell_0.fg) - ansi.blueF(red_fg)) < epsilon;
    try std.testing.expect(is_red_0);

    // Check that 't' at buffer position 1 is RED
    const cell_1 = opt_buffer.get(1, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 't'), cell_1.char);
    const is_red_1 = @abs(ansi.redF(cell_1.fg) - ansi.redF(red_fg)) < epsilon and
        @abs(ansi.greenF(cell_1.fg) - ansi.greenF(red_fg)) < epsilon and
        @abs(ansi.blueF(cell_1.fg) - ansi.blueF(red_fg)) < epsilon;
    try std.testing.expect(is_red_1);

    // Check that ' ' at buffer position 2 is NOT RED
    const cell_2 = opt_buffer.get(2, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, ' '), cell_2.char);
    const is_red_2 = @abs(ansi.redF(cell_2.fg) - ansi.redF(red_fg)) < epsilon and
        @abs(ansi.greenF(cell_2.fg) - ansi.greenF(red_fg)) < epsilon and
        @abs(ansi.blueF(cell_2.fg) - ansi.blueF(red_fg)) < epsilon;
    try std.testing.expect(!is_red_2);

    // Check that 'x' at buffer position 3 is NOT RED
    const cell_3 = opt_buffer.get(3, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'x'), cell_3.char);
    const is_red_3 = @abs(ansi.redF(cell_3.fg) - ansi.redF(red_fg)) < epsilon and
        @abs(ansi.greenF(cell_3.fg) - ansi.greenF(red_fg)) < epsilon and
        @abs(ansi.blueF(cell_3.fg) - ansi.blueF(red_fg)) < epsilon;
    try std.testing.expect(!is_red_3);
}

test "drawTextBuffer - setStyledText with multiple colors and horizontal scrolling" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const style = try ss.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    tb.setSyntaxStyle(style);

    // Simulate what code renderable does with setStyledText
    // Text will be: "const x = function(y) { return y * 2; }"
    // But split into colored chunks like syntax highlighting

    const chunk1_text = "const";
    const chunk2_text = " x = ";
    const chunk3_text = "function";
    const chunk4_text = "(y) { ";
    const chunk5_text = "return";
    const chunk6_text = " y * ";
    const chunk7_text = "2";
    const chunk8_text = "; }";

    const red_color = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const white_color = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const green_color = ansi.rgbaFromFloats(0.0, 1.0, 0.0, 1.0);
    const blue_color = ansi.rgbaFromFloats(0.0, 0.0, 1.0, 1.0);
    const yellow_color = ansi.rgbaFromFloats(1.0, 1.0, 0.0, 1.0);

    const chunks = [_]StyledChunk{
        .{ .text_ptr = chunk1_text.ptr, .text_len = chunk1_text.len, .fg_ptr = @ptrCast(&red_color), .bg_ptr = null, .attributes = 0 },
        .{ .text_ptr = chunk2_text.ptr, .text_len = chunk2_text.len, .fg_ptr = @ptrCast(&white_color), .bg_ptr = null, .attributes = 0 },
        .{ .text_ptr = chunk3_text.ptr, .text_len = chunk3_text.len, .fg_ptr = @ptrCast(&green_color), .bg_ptr = null, .attributes = 0 },
        .{ .text_ptr = chunk4_text.ptr, .text_len = chunk4_text.len, .fg_ptr = @ptrCast(&white_color), .bg_ptr = null, .attributes = 0 },
        .{ .text_ptr = chunk5_text.ptr, .text_len = chunk5_text.len, .fg_ptr = @ptrCast(&blue_color), .bg_ptr = null, .attributes = 0 },
        .{ .text_ptr = chunk6_text.ptr, .text_len = chunk6_text.len, .fg_ptr = @ptrCast(&white_color), .bg_ptr = null, .attributes = 0 },
        .{ .text_ptr = chunk7_text.ptr, .text_len = chunk7_text.len, .fg_ptr = @ptrCast(&yellow_color), .bg_ptr = null, .attributes = 0 },
        .{ .text_ptr = chunk8_text.ptr, .text_len = chunk8_text.len, .fg_ptr = @ptrCast(&white_color), .bg_ptr = null, .attributes = 0 },
    };

    try tb.setStyledText(&chunks);

    view.setWrapMode(.none);
    view.setWrapWidth(null);

    const epsilon: f32 = 0.01;

    // Helper to check if color matches
    const isRed = struct {
        fn check(fg: RGBA, eps: f32) bool {
            return @abs(ansi.redF(fg) - 1.0) < eps and @abs(ansi.greenF(fg) - 0.0) < eps and @abs(ansi.blueF(fg) - 0.0) < eps;
        }
    }.check;

    const isGreen = struct {
        fn check(fg: RGBA, eps: f32) bool {
            return @abs(ansi.redF(fg) - 0.0) < eps and @abs(ansi.greenF(fg) - 1.0) < eps and @abs(ansi.blueF(fg) - 0.0) < eps;
        }
    }.check;

    const isBlue = struct {
        fn check(fg: RGBA, eps: f32) bool {
            return @abs(ansi.redF(fg) - 0.0) < eps and @abs(ansi.greenF(fg) - 0.0) < eps and @abs(ansi.blueF(fg) - 1.0) < eps;
        }
    }.check;

    const isYellow = struct {
        fn check(fg: RGBA, eps: f32) bool {
            return @abs(ansi.redF(fg) - 1.0) < eps and @abs(ansi.greenF(fg) - 1.0) < eps and @abs(ansi.blueF(fg) - 0.0) < eps;
        }
    }.check;

    const isWhite = struct {
        fn check(fg: RGBA, eps: f32) bool {
            return @abs(ansi.redF(fg) - 1.0) < eps and @abs(ansi.greenF(fg) - 1.0) < eps and @abs(ansi.blueF(fg) - 1.0) < eps;
        }
    }.check;

    // Test at x=0 (no scroll)
    {
        view.setViewport(.{ .x = 0, .y = 0, .width = 40, .height = 1 });
        var opt_buffer = try OptimizedBuffer.init(std.testing.allocator, 40, 1, .{ .pool = pool, .width_method = .unicode });
        defer opt_buffer.deinit();

        opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
        opt_buffer.drawTextBuffer(view, 0, 0);

        const cell_0 = opt_buffer.get(0, 0) orelse unreachable; // 'c' from "const"
        try std.testing.expectEqual(@as(u32, 'c'), cell_0.char);
        try std.testing.expect(isRed(cell_0.fg, epsilon));

        const cell_10 = opt_buffer.get(10, 0) orelse unreachable; // 'f' from "function"
        try std.testing.expectEqual(@as(u32, 'f'), cell_10.char);
        try std.testing.expect(isGreen(cell_10.fg, epsilon));
    }

    // Test at x=5 (scrolled past "const")
    {
        view.setViewport(.{ .x = 5, .y = 0, .width = 20, .height = 1 });
        var opt_buffer = try OptimizedBuffer.init(std.testing.allocator, 20, 1, .{ .pool = pool, .width_method = .unicode });
        defer opt_buffer.deinit();

        opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
        opt_buffer.drawTextBuffer(view, 0, 0);

        // At x=5, showing chars 5-24: " x = function(y) { "
        // Position 0: ' ' (source 5) - should be white
        // Position 5: 'f' (source 10) - should be GREEN
        const cell_0 = opt_buffer.get(0, 0) orelse unreachable;
        try std.testing.expectEqual(@as(u32, ' '), cell_0.char);
        try std.testing.expect(isWhite(cell_0.fg, epsilon));

        const cell_5 = opt_buffer.get(5, 0) orelse unreachable;
        try std.testing.expectEqual(@as(u32, 'f'), cell_5.char);
        try std.testing.expect(isGreen(cell_5.fg, epsilon));
    }

    // Test at x=15 (in middle of "function")
    {
        view.setViewport(.{ .x = 15, .y = 0, .width = 20, .height = 1 });
        var opt_buffer = try OptimizedBuffer.init(std.testing.allocator, 20, 1, .{ .pool = pool, .width_method = .unicode });
        defer opt_buffer.deinit();

        opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
        opt_buffer.drawTextBuffer(view, 0, 0);

        // At x=15, showing chars 15-34: "ion(y) { return y * "
        // "const x = function..."
        //  0123456789012345678...
        // Position 0: 'i' (source 15) - should be GREEN (part of "function" 10-18)
        // Position 1: 'o' (source 16) - should be GREEN
        // Position 2: 'n' (source 17) - should be GREEN
        // Position 3: '(' (source 18) - should be WHITE (end of "function")
        const cell_0 = opt_buffer.get(0, 0) orelse unreachable;
        try std.testing.expectEqual(@as(u32, 'i'), cell_0.char);
        try std.testing.expect(isGreen(cell_0.fg, epsilon));

        const cell_1 = opt_buffer.get(1, 0) orelse unreachable;
        try std.testing.expectEqual(@as(u32, 'o'), cell_1.char);
        try std.testing.expect(isGreen(cell_1.fg, epsilon));

        const cell_2 = opt_buffer.get(2, 0) orelse unreachable;
        try std.testing.expectEqual(@as(u32, 'n'), cell_2.char);
        try std.testing.expect(isGreen(cell_2.fg, epsilon));

        const cell_3 = opt_buffer.get(3, 0) orelse unreachable;
        try std.testing.expectEqual(@as(u32, '('), cell_3.char);
        try std.testing.expect(isWhite(cell_3.fg, epsilon));

        // Position 9: 'r' (source 24) - should be BLUE (start of "return" 24-30)
        const cell_9 = opt_buffer.get(9, 0) orelse unreachable;
        try std.testing.expectEqual(@as(u32, 'r'), cell_9.char);
        try std.testing.expect(isBlue(cell_9.fg, epsilon));
    }

    // Test at x=25 (past "return")
    {
        view.setViewport(.{ .x = 25, .y = 0, .width = 20, .height = 1 });
        var opt_buffer = try OptimizedBuffer.init(std.testing.allocator, 20, 1, .{ .pool = pool, .width_method = .unicode });
        defer opt_buffer.deinit();

        opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
        opt_buffer.drawTextBuffer(view, 0, 0);

        // At x=25, showing chars 25-44: "eturn y * 2; }"
        // Position 0: 'e' (source 25) - should be BLUE (part of "return" 24-30)
        // Position 4: 'n' (source 29) - should be BLUE
        // Position 5: ' ' (source 30) - should be WHITE (end of "return")
        // Position 10: '2' (source 35) - should be YELLOW
        const cell_0 = opt_buffer.get(0, 0) orelse unreachable;
        try std.testing.expectEqual(@as(u32, 'e'), cell_0.char);
        try std.testing.expect(isBlue(cell_0.fg, epsilon));

        const cell_4 = opt_buffer.get(4, 0) orelse unreachable;
        try std.testing.expectEqual(@as(u32, 'n'), cell_4.char);
        try std.testing.expect(isBlue(cell_4.fg, epsilon));

        const cell_5 = opt_buffer.get(5, 0) orelse unreachable;
        try std.testing.expectEqual(@as(u32, ' '), cell_5.char);
        try std.testing.expect(isWhite(cell_5.fg, epsilon));

        const cell_10 = opt_buffer.get(10, 0) orelse unreachable;
        try std.testing.expectEqual(@as(u32, '2'), cell_10.char);
        try std.testing.expect(isYellow(cell_10.fg, epsilon));
    }
}

test "drawTextBuffer - selection with horizontal viewport offset" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    // Text: "0123456789ABCDEFGHIJ"
    // We'll set viewport to x=5, showing "56789ABCDE"
    // Then we'll select characters 7-12 (which are "789AB")
    // Expected: in the rendered buffer, "789AB" should be highlighted
    try tb.setText("0123456789ABCDEFGHIJ");

    view.setWrapMode(.none);
    view.setWrapWidth(null);
    view.setViewport(.{ .x = 5, .y = 0, .width = 10, .height = 1 });

    // Select characters at positions 7-12 in the original text ("789AB")
    view.setSelection(7, 12, ansi.rgbaFromFloats(1.0, 1.0, 0.0, 1.0), ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0));

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        1,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    // The viewport shows positions 5-14 of the text
    // Characters 7-11 (0-indexed) should be highlighted
    // In the buffer:
    // Position 0: '5' - not highlighted
    // Position 1: '6' - not highlighted
    // Position 2: '7' - HIGHLIGHTED (char pos 7)
    // Position 3: '8' - HIGHLIGHTED (char pos 8)
    // Position 4: '9' - HIGHLIGHTED (char pos 9)
    // Position 5: 'A' - HIGHLIGHTED (char pos 10)
    // Position 6: 'B' - HIGHLIGHTED (char pos 11)
    // Position 7: 'C' - not highlighted (char pos 12, selection end is exclusive)
    // Position 8: 'D' - not highlighted
    // Position 9: 'E' - not highlighted

    const epsilon: f32 = 0.01;
    const yellow_bg = ansi.rgbaFromFloats(1.0, 1.0, 0.0, 1.0);

    // Check non-highlighted cells
    const cell_0 = opt_buffer.get(0, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, '5'), cell_0.char);
    const has_yellow_0 = @abs(ansi.redF(cell_0.bg) - ansi.redF(yellow_bg)) < epsilon and
        @abs(ansi.greenF(cell_0.bg) - ansi.greenF(yellow_bg)) < epsilon and
        @abs(ansi.blueF(cell_0.bg) - ansi.blueF(yellow_bg)) < epsilon;
    try std.testing.expect(!has_yellow_0);

    const cell_1 = opt_buffer.get(1, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, '6'), cell_1.char);
    const has_yellow_1 = @abs(ansi.redF(cell_1.bg) - ansi.redF(yellow_bg)) < epsilon and
        @abs(ansi.greenF(cell_1.bg) - ansi.greenF(yellow_bg)) < epsilon and
        @abs(ansi.blueF(cell_1.bg) - ansi.blueF(yellow_bg)) < epsilon;
    try std.testing.expect(!has_yellow_1);

    // Check highlighted cells
    const cell_2 = opt_buffer.get(2, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, '7'), cell_2.char);
    const has_yellow_2 = @abs(ansi.redF(cell_2.bg) - ansi.redF(yellow_bg)) < epsilon and
        @abs(ansi.greenF(cell_2.bg) - ansi.greenF(yellow_bg)) < epsilon and
        @abs(ansi.blueF(cell_2.bg) - ansi.blueF(yellow_bg)) < epsilon;
    try std.testing.expect(has_yellow_2);

    const cell_3 = opt_buffer.get(3, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, '8'), cell_3.char);
    const has_yellow_3 = @abs(ansi.redF(cell_3.bg) - ansi.redF(yellow_bg)) < epsilon and
        @abs(ansi.greenF(cell_3.bg) - ansi.greenF(yellow_bg)) < epsilon and
        @abs(ansi.blueF(cell_3.bg) - ansi.blueF(yellow_bg)) < epsilon;
    try std.testing.expect(has_yellow_3);

    const cell_6 = opt_buffer.get(6, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'B'), cell_6.char);
    const has_yellow_6 = @abs(ansi.redF(cell_6.bg) - ansi.redF(yellow_bg)) < epsilon and
        @abs(ansi.greenF(cell_6.bg) - ansi.greenF(yellow_bg)) < epsilon and
        @abs(ansi.blueF(cell_6.bg) - ansi.blueF(yellow_bg)) < epsilon;
    try std.testing.expect(has_yellow_6);

    // Check cells after selection
    const cell_7 = opt_buffer.get(7, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'C'), cell_7.char);
    const has_yellow_7 = @abs(ansi.redF(cell_7.bg) - ansi.redF(yellow_bg)) < epsilon and
        @abs(ansi.greenF(cell_7.bg) - ansi.greenF(yellow_bg)) < epsilon and
        @abs(ansi.blueF(cell_7.bg) - ansi.blueF(yellow_bg)) < epsilon;
    try std.testing.expect(!has_yellow_7);
}

test "drawTextBuffer - syntax highlight respects truncation" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const style = try ss.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    tb.setSyntaxStyle(style);

    const red_style = try style.registerStyle("red", ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0), null, 0);
    const green_style = try style.registerStyle("green", ansi.rgbaFromFloats(0.0, 1.0, 0.0, 1.0), null, 0);

    try tb.setText("0123456789ABCDEFGHIJ");
    try tb.addHighlightByCharRange(4, 7, red_style, 1, 0); // highlight "456"
    try tb.addHighlightByCharRange(16, 20, green_style, 1, 0); // highlight "GHIJ"

    view.setWrapMode(.none);
    view.setWrapWidth(null);
    view.setTruncate(true);
    view.setViewport(.{ .x = 0, .y = 0, .width = 10, .height = 1 });

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        1,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const epsilon: f32 = 0.01;

    const prefix_cell = opt_buffer.get(1, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, '1'), prefix_cell.char);
    try std.testing.expect(@abs(ansi.redF(prefix_cell.fg) - 1.0) < epsilon);
    try std.testing.expect(@abs(ansi.greenF(prefix_cell.fg) - 1.0) < epsilon);
    try std.testing.expect(@abs(ansi.blueF(prefix_cell.fg) - 1.0) < epsilon);

    const ellipsis_cell = opt_buffer.get(3, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, '.'), ellipsis_cell.char);
    try std.testing.expect(@abs(ansi.redF(ellipsis_cell.fg) - 1.0) < epsilon);
    try std.testing.expect(@abs(ansi.greenF(ellipsis_cell.fg) - 1.0) < epsilon);
    try std.testing.expect(@abs(ansi.blueF(ellipsis_cell.fg) - 1.0) < epsilon);

    const suffix_cell = opt_buffer.get(6, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'G'), suffix_cell.char);
    try std.testing.expect(@abs(ansi.redF(suffix_cell.fg) - 0.0) < epsilon);
    try std.testing.expect(@abs(ansi.greenF(suffix_cell.fg) - 1.0) < epsilon);
    try std.testing.expect(@abs(ansi.blueF(suffix_cell.fg) - 0.0) < epsilon);
}

test "drawTextBuffer - highlight spanning ellipsis continues on suffix" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const style = try ss.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    tb.setSyntaxStyle(style);

    const magenta_style = try style.registerStyle("magenta", ansi.rgbaFromFloats(1.0, 0.0, 1.0, 1.0), null, 0);
    const green_style = try style.registerStyle("green", ansi.rgbaFromFloats(0.0, 1.0, 0.0, 1.0), null, 0);

    try tb.setText("0123456789ABCDEFGHIJ");
    try tb.addHighlightByCharRange(2, 18, magenta_style, 1, 0); // spans through ellipsis
    try tb.addHighlightByCharRange(18, 20, green_style, 2, 0); // suffix highlight

    view.setWrapMode(.none);
    view.setWrapWidth(null);
    view.setTruncate(true);
    view.setViewport(.{ .x = 0, .y = 0, .width = 10, .height = 1 });

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        1,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const epsilon: f32 = 0.01;

    const ellipsis_cell = opt_buffer.get(3, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, '.'), ellipsis_cell.char);
    try std.testing.expect(@abs(ansi.redF(ellipsis_cell.fg) - 1.0) < epsilon);
    try std.testing.expect(@abs(ansi.greenF(ellipsis_cell.fg) - 1.0) < epsilon);
    try std.testing.expect(@abs(ansi.blueF(ellipsis_cell.fg) - 1.0) < epsilon);

    const suffix_magenta = opt_buffer.get(6, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'G'), suffix_magenta.char);
    try std.testing.expect(@abs(ansi.redF(suffix_magenta.fg) - 1.0) < epsilon);
    try std.testing.expect(@abs(ansi.greenF(suffix_magenta.fg) - 0.0) < epsilon);
    try std.testing.expect(@abs(ansi.blueF(suffix_magenta.fg) - 1.0) < epsilon);

    const suffix_green = opt_buffer.get(8, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'I'), suffix_green.char);
    try std.testing.expect(@abs(ansi.redF(suffix_green.fg) - 0.0) < epsilon);
    try std.testing.expect(@abs(ansi.greenF(suffix_green.fg) - 1.0) < epsilon);
    try std.testing.expect(@abs(ansi.blueF(suffix_green.fg) - 0.0) < epsilon);
}

test "drawTextBuffer - selection respects truncation" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    // Text: "0123456789ABCDEFGHIJ" (len 20)
    // With width 10, truncation should render: "012...GHIJ"
    try tb.setText("0123456789ABCDEFGHIJ");

    view.setWrapMode(.none);
    view.setWrapWidth(null);
    view.setTruncate(true);
    view.setViewport(.{ .x = 0, .y = 0, .width = 10, .height = 1 });

    // Select across the ellipsis and suffix
    view.setSelection(2, 19, ansi.rgbaFromFloats(1.0, 1.0, 0.0, 1.0), ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0));

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        1,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const epsilon: f32 = 0.01;
    const yellow_bg = ansi.rgbaFromFloats(1.0, 1.0, 0.0, 1.0);

    const cell_0 = opt_buffer.get(0, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, '0'), cell_0.char);
    const has_yellow_0 = @abs(ansi.redF(cell_0.bg) - ansi.redF(yellow_bg)) < epsilon and
        @abs(ansi.greenF(cell_0.bg) - ansi.greenF(yellow_bg)) < epsilon and
        @abs(ansi.blueF(cell_0.bg) - ansi.blueF(yellow_bg)) < epsilon;
    try std.testing.expect(!has_yellow_0);

    const cell_3 = opt_buffer.get(3, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, '.'), cell_3.char);
    const has_yellow_3 = @abs(ansi.redF(cell_3.bg) - ansi.redF(yellow_bg)) < epsilon and
        @abs(ansi.greenF(cell_3.bg) - ansi.greenF(yellow_bg)) < epsilon and
        @abs(ansi.blueF(cell_3.bg) - ansi.blueF(yellow_bg)) < epsilon;
    try std.testing.expect(has_yellow_3);

    const cell_6 = opt_buffer.get(6, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'G'), cell_6.char);
    const has_yellow_6 = @abs(ansi.redF(cell_6.bg) - ansi.redF(yellow_bg)) < epsilon and
        @abs(ansi.greenF(cell_6.bg) - ansi.greenF(yellow_bg)) < epsilon and
        @abs(ansi.blueF(cell_6.bg) - ansi.blueF(yellow_bg)) < epsilon;
    try std.testing.expect(has_yellow_6);

    const cell_8 = opt_buffer.get(8, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'I'), cell_8.char);
    const has_yellow_8 = @abs(ansi.redF(cell_8.bg) - ansi.redF(yellow_bg)) < epsilon and
        @abs(ansi.greenF(cell_8.bg) - ansi.greenF(yellow_bg)) < epsilon and
        @abs(ansi.blueF(cell_8.bg) - ansi.blueF(yellow_bg)) < epsilon;
    try std.testing.expect(has_yellow_8);

    const cell_9 = opt_buffer.get(9, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'J'), cell_9.char);
    const has_yellow_9 = @abs(ansi.redF(cell_9.bg) - ansi.redF(yellow_bg)) < epsilon and
        @abs(ansi.greenF(cell_9.bg) - ansi.greenF(yellow_bg)) < epsilon and
        @abs(ansi.blueF(cell_9.bg) - ansi.blueF(yellow_bg)) < epsilon;
    try std.testing.expect(!has_yellow_9);
}

test "drawTextBuffer - truncation selection does not overshoot multiline" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText(
        "abcdefghijABCDEFGHIJ\n" ++
            "klmnopqrstKLMNOPQRST",
    );

    view.setWrapMode(.none);
    view.setWrapWidth(null);
    view.setTruncate(true);
    view.setViewport(.{ .x = 0, .y = 0, .width = 10, .height = 2 });

    // Select from line 1 col 2 through line 2 col 5 (exclusive)
    view.setSelection(2, 26, ansi.rgbaFromFloats(1.0, 1.0, 0.0, 1.0), ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0));

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        2,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const epsilon: f32 = 0.01;
    const yellow_bg = ansi.rgbaFromFloats(1.0, 1.0, 0.0, 1.0);

    const line2_cell_0 = opt_buffer.get(0, 1) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'k'), line2_cell_0.char);
    const has_yellow_line2_0 = @abs(ansi.redF(line2_cell_0.bg) - ansi.redF(yellow_bg)) < epsilon and
        @abs(ansi.greenF(line2_cell_0.bg) - ansi.greenF(yellow_bg)) < epsilon and
        @abs(ansi.blueF(line2_cell_0.bg) - ansi.blueF(yellow_bg)) < epsilon;
    try std.testing.expect(has_yellow_line2_0);

    const line2_cell_2 = opt_buffer.get(2, 1) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'm'), line2_cell_2.char);
    const has_yellow_line2_2 = @abs(ansi.redF(line2_cell_2.bg) - ansi.redF(yellow_bg)) < epsilon and
        @abs(ansi.greenF(line2_cell_2.bg) - ansi.greenF(yellow_bg)) < epsilon and
        @abs(ansi.blueF(line2_cell_2.bg) - ansi.blueF(yellow_bg)) < epsilon;
    try std.testing.expect(has_yellow_line2_2);

    const line2_cell_6 = opt_buffer.get(6, 1) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'Q'), line2_cell_6.char);
    const has_yellow_line2_6 = @abs(ansi.redF(line2_cell_6.bg) - ansi.redF(yellow_bg)) < epsilon and
        @abs(ansi.greenF(line2_cell_6.bg) - ansi.greenF(yellow_bg)) < epsilon and
        @abs(ansi.blueF(line2_cell_6.bg) - ansi.blueF(yellow_bg)) < epsilon;
    try std.testing.expect(!has_yellow_line2_6);
}

test "drawTextBuffer - Chinese text with wrapping no stray bytes" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const text =
        \\前后端分离 - TypeScript逻辑 + Go TUI界面
        \\组件化设计 - 基于tview的可复用组件
        \\渐进式交互 - 逐步披露避免信息过载
        \\智能上下文 - 基于项目状态动态生成问题
        \\丰富的问题类型 - 支持6种不同的交互形式
        \\完整的验证 - 实时输入验证和错误处理
    ;

    try tb.setText(text);

    // Try word wrapping with a width that might split multibyte chars
    view.setWrapMode(.word);
    view.setWrapWidth(35);
    view.updateVirtualLines();

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        40,
        20,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    // Write the rendered buffer to check for stray bytes
    var out_buffer: [2000]u8 = undefined;
    const written = try opt_buffer.writeResolvedChars(&out_buffer, false);
    const result = out_buffer[0..written];

    // Verify the output is valid UTF-8
    try std.testing.expect(std.unicode.utf8ValidateSlice(result));

    // Verify that the original text is contained in the output (with possible spaces/newlines from wrapping)
    try std.testing.expect(std.mem.find(u8, result, "完整的验证") != null);
    try std.testing.expect(std.mem.find(u8, result, "实时输入验证和错误处理") != null);

    // Check specific problematic line - should NOT contain stray bytes
    // The line should be present correctly (possibly wrapped with spaces)
    // But there should be NO stray å character or partial UTF-8 sequences
    try std.testing.expect(std.mem.find(u8, result, "å式") == null); // This should NOT appear
    try std.testing.expect(std.mem.find(u8, result, "å") == null); // No stray partial bytes

    // Verify the problematic characters appear correctly
    try std.testing.expect(std.mem.find(u8, result, "形式") != null);
}

test "drawTextBuffer - Chinese text WITHOUT wrapping no duplicate chunks" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const text =
        \\前后端分离 - TypeScript逻辑 + Go TUI界面
        \\组件化设计 - 基于tview的可复用组件
        \\渐进式交互 - 逐步披露避免信息过载
        \\智能上下文 - 基于项目状态动态生成问题
        \\丰富的问题类型 - 支持6种不同的交互形式
        \\完整的验证 - 实时输入验证和错误处理
    ;

    try tb.setText(text);

    // Word wrap mode but with wide width so nothing actually wraps
    view.setWrapMode(.word);
    view.setWrapWidth(80);
    view.updateVirtualLines();

    const vlines = view.getVirtualLines();

    // Check each virtual line - should have exactly ONE chunk when width is large enough
    for (vlines) |vline| {
        // Each line should have exactly ONE chunk when not actually wrapping
        try std.testing.expectEqual(@as(usize, 1), vline.chunks.items.len);
    }

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        80,
        10,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    // Write the rendered buffer
    var out_buffer: [2000]u8 = undefined;
    const written = try opt_buffer.writeResolvedChars(&out_buffer, false);
    const result = out_buffer[0..written];

    // Verify the output is valid UTF-8
    try std.testing.expect(std.unicode.utf8ValidateSlice(result));

    // Should NOT contain stray bytes
    try std.testing.expect(std.mem.find(u8, result, "å") == null);

    // All text should be present
    try std.testing.expect(std.mem.find(u8, result, "完整的验证 - 实时输入验证和错误处理") != null);
}

test "drawTextBuffer - Chinese text with CHAR wrapping no stray bytes" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const text =
        \\前后端分离 - TypeScript逻辑 + Go TUI界面
        \\组件化设计 - 基于tview的可复用组件
        \\渐进式交互 - 逐步披露避免信息过载
        \\智能上下文 - 基于项目状态动态生成问题
        \\丰富的问题类型 - 支持6种不同的交互形式
        \\完整的验证 - 实时输入验证和错误处理
    ;

    try tb.setText(text);

    // Char wrapping with a width that might split multibyte chars
    view.setWrapMode(.char);
    view.setWrapWidth(35);
    view.updateVirtualLines();

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        35,
        20,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    // Write the rendered buffer to check for stray bytes
    var out_buffer: [2000]u8 = undefined;
    const written = try opt_buffer.writeResolvedChars(&out_buffer, false);
    const result = out_buffer[0..written];

    // Verify the output is valid UTF-8
    try std.testing.expect(std.unicode.utf8ValidateSlice(result));

    // Should NOT contain stray bytes
    try std.testing.expect(std.mem.find(u8, result, "å") == null);

    // Verify the problematic characters appear correctly
    try std.testing.expect(std.mem.find(u8, result, "形式") != null);
    try std.testing.expect(std.mem.find(u8, result, "完整的验证") != null);
}

test "drawTextBuffer - word wrap CJK mixed text without break points" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("한글,English,中文,日本語,混合,Test,測試,テスト,가나다,ABC,一二三,あいう,라마바,DEF,四五六,えおか");

    view.setWrapMode(.word);
    view.setWrapWidth(20);
    view.updateVirtualLines();

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        30,
        20,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    var out_buffer: [1000]u8 = undefined;
    const written = try opt_buffer.writeResolvedChars(&out_buffer, false);
    const result = out_buffer[0..written];

    const vlines = view.getVirtualLines();
    try std.testing.expect(vlines.len > 1);

    var y: u32 = 0;
    while (y < vlines.len) : (y += 1) {
        const first_cell = opt_buffer.get(0, y);
        if (first_cell) |cell| {
            try std.testing.expect(!gp.isContinuationChar(cell.char));
        }
    }

    try std.testing.expect(std.unicode.utf8ValidateSlice(result));
}

test "drawTextBuffer - word wrap CJK text preserves UTF-8 boundaries" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("한글,English,中文,日本語,混合,Test,測試,テスト,가나다,ABC,一二三,あいう,라마바,DEF,四五六,えおか");

    view.setWrapMode(.word);
    view.setWrapWidth(20);
    view.updateVirtualLines();

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        30,
        20,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    var out_buffer: [1000]u8 = undefined;
    const written = try opt_buffer.writeResolvedChars(&out_buffer, false);
    const result = out_buffer[0..written];

    try std.testing.expect(std.unicode.utf8ValidateSlice(result));
    try std.testing.expect(std.mem.find(u8, result, "ä") == null);

    var i: usize = 0;
    while (i < result.len) : (i += 1) {
        if (result[i] == 0xE4) {
            if (i + 1 >= result.len) {
                return error.TestFailed;
            }
            const next_byte = result[i + 1];
            if (next_byte < 0x80 or next_byte > 0xBF) {
                return error.TestFailed;
            }
        }
    }

    const vlines = view.getVirtualLines();
    var y: u32 = 0;
    while (y < vlines.len) : (y += 1) {
        const first_cell = opt_buffer.get(0, y);
        if (first_cell) |cell| {
            try std.testing.expect(!gp.isContinuationChar(cell.char));
        }
    }
}

test "drawTextBuffer - Thai ว่ grapheme in quotes occupies one cell" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("\"ว่\"");

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        1,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(view, 0, 0);

    const cell_0 = opt_buffer.get(0, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, '"'), cell_0.char);

    const cell_1 = opt_buffer.get(1, 0) orelse unreachable;
    try std.testing.expect(cell_1.char != ' ');
    try std.testing.expect(cell_1.char != '"');

    const cell_2 = opt_buffer.get(2, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, '"'), cell_2.char);

    const cell_3 = opt_buffer.get(3, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, ' '), cell_3.char);

    var out_buffer: [100]u8 = undefined;
    const written = try opt_buffer.writeResolvedChars(&out_buffer, false);
    const result = out_buffer[0..written];

    try std.testing.expect(std.mem.find(u8, result, "\"ว่\"") != null);
}
