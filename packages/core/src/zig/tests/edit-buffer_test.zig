const std = @import("std");
const edit_buffer = @import("../edit-buffer.zig");
const text_buffer_view = @import("../text-buffer-view.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");
const iter_mod = @import("../text-buffer-iterators.zig");

const EditBuffer = edit_buffer.EditBuffer;
const TextBufferView = text_buffer_view.TextBufferView;
const Cursor = edit_buffer.Cursor;

test "EditBuffer - init and deinit" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try std.testing.expectEqual(@as(u32, 0), eb.getTextBuffer().getLength());
    const cursor = eb.getCursor(0);
    try std.testing.expect(cursor != null);
    try std.testing.expectEqual(@as(u32, 0), cursor.?.row);
    try std.testing.expectEqual(@as(u32, 0), cursor.?.col);
}

test "EditBuffer - next word boundary basic" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello World");
    try eb.setCursor(0, 0);

    const next_cursor = eb.getNextWordBoundary();
    try std.testing.expectEqual(@as(u32, 0), next_cursor.row);
    try std.testing.expectEqual(@as(u32, 6), next_cursor.col);
}

test "EditBuffer - prev word boundary basic" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello World");
    try eb.setCursor(0, 7);

    const prev_cursor = eb.getPrevWordBoundary();
    try std.testing.expectEqual(@as(u32, 0), prev_cursor.row);
    try std.testing.expectEqual(@as(u32, 6), prev_cursor.col);
}

test "EditBuffer - next word boundary across line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello\nWorld");
    try eb.setCursor(0, 5);

    const next_cursor = eb.getNextWordBoundary();
    try std.testing.expectEqual(@as(u32, 1), next_cursor.row);
    try std.testing.expectEqual(@as(u32, 0), next_cursor.col);
}

test "EditBuffer - prev word boundary across line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello\nWorld");
    try eb.setCursor(1, 0);

    const prev_cursor = eb.getPrevWordBoundary();
    try std.testing.expectEqual(@as(u32, 0), prev_cursor.row);
    try std.testing.expectEqual(@as(u32, 5), prev_cursor.col);
}

test "EditBuffer - hyphen word boundary" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("self-contained");
    try eb.setCursor(0, 0);

    const next_cursor = eb.getNextWordBoundary();
    try std.testing.expectEqual(@as(u32, 0), next_cursor.row);
    try std.testing.expectEqual(@as(u32, 5), next_cursor.col);
}

test "EditBuffer - multiple word boundaries" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("The quick brown fox");
    try eb.setCursor(0, 0);

    var cursor = eb.getNextWordBoundary();
    try std.testing.expectEqual(@as(u32, 4), cursor.col);

    try eb.setCursor(cursor.row, cursor.col);
    cursor = eb.getNextWordBoundary();
    try std.testing.expectEqual(@as(u32, 10), cursor.col);

    try eb.setCursor(cursor.row, cursor.col);
    cursor = eb.getNextWordBoundary();
    try std.testing.expectEqual(@as(u32, 16), cursor.col);
}

test "EditBuffer - word boundary at end of line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello");
    try eb.setCursor(0, 5);

    const next_cursor = eb.getNextWordBoundary();
    try std.testing.expectEqual(@as(u32, 0), next_cursor.row);
    try std.testing.expectEqual(@as(u32, 5), next_cursor.col);
}

test "EditBuffer - word boundary at start of line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello");
    try eb.setCursor(0, 0);

    const prev_cursor = eb.getPrevWordBoundary();
    try std.testing.expectEqual(@as(u32, 0), prev_cursor.row);
    try std.testing.expectEqual(@as(u32, 0), prev_cursor.col);
}

test "EditBuffer - getEOL basic" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello World");
    try eb.setCursor(0, 0);

    const eol_cursor = eb.getEOL();
    try std.testing.expectEqual(@as(u32, 0), eol_cursor.row);
    try std.testing.expectEqual(@as(u32, 11), eol_cursor.col);
}

test "EditBuffer - getEOL at end of line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello");
    try eb.setCursor(0, 5);

    const eol_cursor = eb.getEOL();
    try std.testing.expectEqual(@as(u32, 0), eol_cursor.row);
    try std.testing.expectEqual(@as(u32, 5), eol_cursor.col);
}

test "EditBuffer - getEOL multi-line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello\nWorld\nTest");
    try eb.setCursor(1, 0);

    const eol_cursor = eb.getEOL();
    try std.testing.expectEqual(@as(u32, 1), eol_cursor.row);
    try std.testing.expectEqual(@as(u32, 5), eol_cursor.col);
}

test "EditBuffer - getEOL empty line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello\n\nWorld");
    try eb.setCursor(1, 0);

    const eol_cursor = eb.getEOL();
    try std.testing.expectEqual(@as(u32, 1), eol_cursor.row);
    try std.testing.expectEqual(@as(u32, 0), eol_cursor.col);
}

test "EditBuffer - word boundary with tabs" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello\tWorld");

    try eb.setCursor(0, 12);

    const prev_cursor = eb.getPrevWordBoundary();
    try std.testing.expectEqual(@as(u32, 7), prev_cursor.col);

    try eb.setCursor(0, 0);
    const next_cursor = eb.getNextWordBoundary();
    try std.testing.expectEqual(@as(u32, 7), next_cursor.col);
}

test "EditBuffer - word boundary with CJK graphemes" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    // "你" = 2 cols, " " = 1 col, "好" = 2 cols
    try eb.insertText("你 好");
    try eb.setCursor(0, 0);

    const next_cursor = eb.getNextWordBoundary();
    try std.testing.expectEqual(@as(u32, 3), next_cursor.col);

    try eb.setCursor(0, 5);
    const prev_cursor = eb.getPrevWordBoundary();
    try std.testing.expectEqual(@as(u32, 3), prev_cursor.col);
}

test "EditBuffer - word boundary mixed CJK and ASCII transition" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.setText("日本語abc");

    const eol = eb.getEOL();
    try std.testing.expect(eol.col >= 3);

    try eb.setCursor(0, 0);
    const next_cursor = eb.getNextWordBoundary();
    try std.testing.expectEqual(eol.col - 3, next_cursor.col);

    try eb.setCursor(next_cursor.row, next_cursor.col);
    const next_cursor2 = eb.getNextWordBoundary();
    try std.testing.expectEqual(eol.col, next_cursor2.col);

    try eb.setCursor(0, eol.col);
    const prev_cursor = eb.getPrevWordBoundary();
    try std.testing.expectEqual(eol.col - 3, prev_cursor.col);

    try eb.setCursor(prev_cursor.row, prev_cursor.col);
    const prev_cursor2 = eb.getPrevWordBoundary();
    try std.testing.expectEqual(@as(u32, 0), prev_cursor2.col);
}

test "EditBuffer - word boundary keeps Hangul run grouped" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.setText("테스트test");

    const eol = eb.getEOL();
    try std.testing.expect(eol.col >= 4);

    try eb.setCursor(0, 0);
    const next_cursor = eb.getNextWordBoundary();
    try std.testing.expectEqual(eol.col - 4, next_cursor.col);

    try eb.setCursor(next_cursor.row, next_cursor.col);
    const next_cursor2 = eb.getNextWordBoundary();
    try std.testing.expectEqual(eol.col, next_cursor2.col);

    try eb.setCursor(0, eol.col);
    const prev_cursor = eb.getPrevWordBoundary();
    try std.testing.expectEqual(eol.col - 4, prev_cursor.col);

    try eb.setCursor(prev_cursor.row, prev_cursor.col);
    const prev_cursor2 = eb.getPrevWordBoundary();
    try std.testing.expectEqual(@as(u32, 0), prev_cursor2.col);
}

test "EditBuffer - word boundary respects CJK punctuation before ASCII" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.setText("日本語。abc");

    const eol = eb.getEOL();
    try std.testing.expect(eol.col >= 5);

    try eb.setCursor(0, 0);
    const next_cursor = eb.getNextWordBoundary();
    try std.testing.expectEqual(eol.col - 3, next_cursor.col);

    try eb.setCursor(next_cursor.row, next_cursor.col);
    const next_cursor2 = eb.getNextWordBoundary();
    try std.testing.expectEqual(eol.col, next_cursor2.col);

    try eb.setCursor(0, eol.col);
    const prev_cursor = eb.getPrevWordBoundary();
    try std.testing.expectEqual(eol.col - 3, prev_cursor.col);

    try eb.setCursor(prev_cursor.row, prev_cursor.col);
    const prev_cursor2 = eb.getPrevWordBoundary();
    try std.testing.expectEqual(@as(u32, 0), prev_cursor2.col);
}

test "EditBuffer - word boundary with compat ideograph and ASCII" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.setText("丽abc");

    const eol = eb.getEOL();
    try std.testing.expect(eol.col >= 3);

    try eb.setCursor(0, 0);
    const next_cursor = eb.getNextWordBoundary();
    try std.testing.expectEqual(eol.col - 3, next_cursor.col);

    try eb.setCursor(next_cursor.row, next_cursor.col);
    const next_cursor2 = eb.getNextWordBoundary();
    try std.testing.expectEqual(eol.col, next_cursor2.col);

    try eb.setCursor(0, eol.col);
    const prev_cursor = eb.getPrevWordBoundary();
    try std.testing.expectEqual(eol.col - 3, prev_cursor.col);

    try eb.setCursor(prev_cursor.row, prev_cursor.col);
    const prev_cursor2 = eb.getPrevWordBoundary();
    try std.testing.expectEqual(@as(u32, 0), prev_cursor2.col);
}

test "EditBuffer - word boundary single-character script transitions" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.setText("a日");

    var eol = eb.getEOL();
    try std.testing.expectEqual(@as(u32, 3), eol.col);

    try eb.setCursor(0, 0);
    var next_cursor = eb.getNextWordBoundary();
    try std.testing.expectEqual(@as(u32, 1), next_cursor.col);

    try eb.setCursor(next_cursor.row, next_cursor.col);
    var next_cursor2 = eb.getNextWordBoundary();
    try std.testing.expectEqual(@as(u32, 3), next_cursor2.col);

    try eb.setCursor(0, eol.col);
    var prev_cursor = eb.getPrevWordBoundary();
    try std.testing.expectEqual(@as(u32, 1), prev_cursor.col);

    try eb.setCursor(prev_cursor.row, prev_cursor.col);
    var prev_cursor2 = eb.getPrevWordBoundary();
    try std.testing.expectEqual(@as(u32, 0), prev_cursor2.col);

    try eb.setText("日a");

    eol = eb.getEOL();
    try std.testing.expectEqual(@as(u32, 3), eol.col);

    try eb.setCursor(0, 0);
    next_cursor = eb.getNextWordBoundary();
    try std.testing.expectEqual(@as(u32, 2), next_cursor.col);

    try eb.setCursor(next_cursor.row, next_cursor.col);
    next_cursor2 = eb.getNextWordBoundary();
    try std.testing.expectEqual(@as(u32, 3), next_cursor2.col);

    try eb.setCursor(0, eol.col);
    prev_cursor = eb.getPrevWordBoundary();
    try std.testing.expectEqual(@as(u32, 2), prev_cursor.col);

    try eb.setCursor(prev_cursor.row, prev_cursor.col);
    prev_cursor2 = eb.getPrevWordBoundary();
    try std.testing.expectEqual(@as(u32, 0), prev_cursor2.col);
}

test "EditBuffer - word boundary with emoji" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    // "🌟" = 2 cols, " " = 1 col, "ok" = 2 cols
    try eb.insertText("🌟 ok");
    try eb.setCursor(0, 0);

    const next_cursor = eb.getNextWordBoundary();
    try std.testing.expectEqual(@as(u32, 3), next_cursor.col);

    try eb.setCursor(0, 5);
    const prev_cursor = eb.getPrevWordBoundary();
    try std.testing.expectEqual(@as(u32, 3), prev_cursor.col);
}

test "EditBuffer - moveRight past tab at start of line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("\tHello");
    try eb.setCursor(0, 0);

    eb.moveRight();
    const cursor = eb.getCursor(0).?;
    try std.testing.expect(cursor.col > 0);

    eb.moveRight();
    const cursor2 = eb.getCursor(0).?;
    try std.testing.expect(cursor2.col > cursor.col);
}

test "EditBuffer - moveRight after typing before tab" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("\tWorld");
    try eb.setCursor(0, 0);
    try eb.insertText("Hi");

    const cursor_after_insert = eb.getCursor(0).?;
    try std.testing.expectEqual(@as(u32, 0), cursor_after_insert.row);

    eb.moveRight();
    const cursor_after_move1 = eb.getCursor(0).?;
    try std.testing.expect(cursor_after_move1.col > cursor_after_insert.col);

    eb.moveRight();
    const cursor_after_move2 = eb.getCursor(0).?;
    try std.testing.expect(cursor_after_move2.col > cursor_after_move1.col);

    eb.moveRight();
    const cursor_after_move3 = eb.getCursor(0).?;
    try std.testing.expect(cursor_after_move3.col > cursor_after_move2.col);
}

test "EditBuffer - moveRight between two tabs" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("\t\tHello");
    try eb.setCursor(0, 0);

    var prev_col: u32 = 0;
    var i: u32 = 0;
    while (i < 10) : (i += 1) {
        eb.moveRight();
        const cursor = eb.getCursor(0).?;
        try std.testing.expect(cursor.col >= prev_col);
        prev_col = cursor.col;
    }
}

test "EditBuffer - type and move around single tab" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("\t");
    try eb.setCursor(0, 0);
    try eb.insertText("a");

    var buffer: [100]u8 = undefined;
    _ = eb.getText(&buffer);

    const cursor1 = eb.getCursor(0).?;
    try std.testing.expectEqual(@as(u32, 0), cursor1.row);
    _ = iter_mod.lineWidthAt(eb.tb.rope(), 0);

    _ = eb.tb.getGraphemeWidthAt(0, cursor1.col);

    eb.moveRight();
    const cursor2 = eb.getCursor(0).?;
    const line_width2 = iter_mod.lineWidthAt(eb.tb.rope(), 0);
    const gw2 = eb.tb.getGraphemeWidthAt(0, cursor2.col);
    try std.testing.expect(cursor2.col > cursor1.col);

    // After moving right once, we're at the end of the line (col=3, line_width=3)
    // We can't move any further
    try std.testing.expectEqual(line_width2, cursor2.col);
    try std.testing.expectEqual(@as(u32, 0), gw2); // No grapheme to move to
}

test "EditBuffer - insert text between tabs and move right" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("\t\tx");
    try eb.setCursor(0, 0);

    eb.moveRight();
    _ = eb.getCursor(0).?;

    try eb.insertText("A");
    const after_insert = eb.getCursor(0).?;

    eb.moveRight();
    const after_move1 = eb.getCursor(0).?;
    try std.testing.expect(after_move1.col > after_insert.col);

    eb.moveRight();
    const after_move2 = eb.getCursor(0).?;
    try std.testing.expect(after_move2.col > after_move1.col);

    eb.moveRight();
    const after_move3 = eb.getCursor(0).?;
    // Should reach append position (line_width) and stay there
    try std.testing.expectEqual(after_move2.col, after_move3.col);
}

test "EditBuffer - insert after tab and move around" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("\t");
    const tab_width = eb.getCursor(0).?.col;

    try eb.insertText("x");
    const after_x = eb.getCursor(0).?;

    eb.moveLeft();
    const before_x = eb.getCursor(0).?;
    try std.testing.expectEqual(tab_width, before_x.col);

    eb.moveRight();
    const back_at_x = eb.getCursor(0).?;
    try std.testing.expectEqual(after_x.col, back_at_x.col);

    // Already at append position (after 'x'), can't move further on single line
    eb.moveRight();
    const still_at_x = eb.getCursor(0).?;
    try std.testing.expectEqual(back_at_x.col, still_at_x.col);
}

test "EditBuffer - cursor stuck after typing around tab" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("hello\tworld");
    try eb.setCursor(0, 5);

    eb.moveRight();
    const pos1 = eb.getCursor(0).?;

    eb.moveRight();
    const pos2 = eb.getCursor(0).?;
    try std.testing.expect(pos2.col > pos1.col);
}

test "EditBuffer - complex tab scenario" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("\tx\ty");
    try eb.setCursor(0, 0);

    const line_width = iter_mod.lineWidthAt(eb.tb.rope(), 0);

    eb.moveRight();
    const p1 = eb.getCursor(0).?;

    eb.moveRight();
    const p2 = eb.getCursor(0).?;
    try std.testing.expect(p2.col > p1.col);

    eb.moveRight();
    const p3 = eb.getCursor(0).?;
    try std.testing.expect(p3.col > p2.col);

    eb.moveRight();
    const p4 = eb.getCursor(0).?;
    try std.testing.expect(p4.col > p3.col);
    try std.testing.expectEqual(line_width, p4.col);

    // Already at append position, can't move further
    eb.moveRight();
    const p5 = eb.getCursor(0).?;
    try std.testing.expectEqual(p4.col, p5.col);
}

test "EditBuffer - cursor stuck at tab in middle of line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("a\tb");
    try eb.setCursor(0, 1);

    var buffer: [100]u8 = undefined;
    _ = eb.getText(&buffer);

    eb.moveRight();
    const p1 = eb.getCursor(0).?;

    eb.moveRight();
    const p2 = eb.getCursor(0).?;
    try std.testing.expect(p2.col > p1.col);
}

test "EditBuffer - type between tabs then move right" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("\t\t");
    try eb.setCursor(0, 2);
    try eb.insertText("x");

    const line_width = iter_mod.lineWidthAt(eb.tb.rope(), 0);
    const after_insert = eb.getCursor(0).?;

    eb.moveRight();
    const p1 = eb.getCursor(0).?;
    try std.testing.expect(p1.col > after_insert.col);
    try std.testing.expectEqual(line_width, p1.col);

    // Already at append position, can't move further
    eb.moveRight();
    const p2 = eb.getCursor(0).?;
    try std.testing.expectEqual(p1.col, p2.col);
}

test "EditBuffer - tabs only with cursor movement" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("\t\t\t");
    try eb.setCursor(0, 0);

    var prev_col: u32 = 0;
    var i: u32 = 0;
    while (i < 5) : (i += 1) {
        _ = iter_mod.lineWidthAt(eb.tb.rope(), 0);
        _ = eb.tb.getGraphemeWidthAt(0, prev_col);
        eb.moveRight();
        const cursor = eb.getCursor(0).?;
        try std.testing.expect(cursor.col >= prev_col);
        prev_col = cursor.col;
    }
}

// ===== getTextRange Tests =====

test "EditBuffer - getTextRange basic ASCII" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello World");

    var buffer: [100]u8 = undefined;
    const len = try eb.getTextRange(0, 5, &buffer);
    try std.testing.expectEqualStrings("Hello", buffer[0..len]);
}

test "EditBuffer - getTextRange full text" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello World");

    var buffer: [100]u8 = undefined;
    const len = try eb.getTextRange(0, 11, &buffer);
    try std.testing.expectEqualStrings("Hello World", buffer[0..len]);
}

test "EditBuffer - getTextRange with emojis" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello 👋 World");

    var buffer: [100]u8 = undefined;
    // "Hello " = 6 cols, emoji = 2 cols, so emoji is at offset 6-8
    const len = try eb.getTextRange(6, 8, &buffer);
    try std.testing.expectEqualStrings("👋", buffer[0..len]);
}

test "EditBuffer - getTextRange emoji with skin tone" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    // Waving hand with medium skin tone
    try eb.insertText("Hi 👋🏽 there");

    var buffer: [100]u8 = undefined;
    // "Hi " = 3 cols, emoji = 2 cols
    const len = try eb.getTextRange(3, 5, &buffer);
    try std.testing.expectEqualStrings("👋🏽", buffer[0..len]);
}

test "EditBuffer - getTextRange flag emoji" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    // USA flag 🇺🇸 (regional indicator symbols)
    try eb.insertText("Flag: 🇺🇸 here");

    var buffer: [100]u8 = undefined;
    // "Flag: " = 6 cols, flag = 2 cols
    const len = try eb.getTextRange(6, 8, &buffer);
    try std.testing.expectEqualStrings("🇺🇸", buffer[0..len]);
}

test "EditBuffer - getTextRange family emoji" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    // Family emoji (ZWJ sequence): 👨‍👩‍👧‍👦
    try eb.insertText("Family: 👨‍👩‍👧‍👦 end");

    var buffer: [100]u8 = undefined;
    // "Family: " = 8 cols, family emoji should be 2 cols
    const len = try eb.getTextRange(8, 10, &buffer);
    try std.testing.expectEqualStrings("👨‍👩‍👧‍👦", buffer[0..len]);
}

test "EditBuffer - getTextRange Devanagari with combining marks" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    // "नमस्ते" (Namaste in Devanagari) - 5 display columns with zero-width combining marks
    try eb.insertText("Say नमस्ते ok");

    var buffer: [100]u8 = undefined;
    // "Say " = 4 cols (0-3), "नमस्ते" = 5 cols (4-8), " " = col 9
    const len = try eb.getTextRange(4, 8, &buffer);
    try std.testing.expectEqualStrings("नमस्ते", buffer[0..len]);
}

test "EditBuffer - getTextRange CJK characters" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    // "你好" (Hello in Chinese) - each character is 2 cols wide
    try eb.insertText("Say 你好 end");

    var buffer: [100]u8 = undefined;
    // "Say " = 4 cols, 你 = 2 cols, 好 = 2 cols
    const len = try eb.getTextRange(4, 8, &buffer);
    try std.testing.expectEqualStrings("你好", buffer[0..len]);
}

test "EditBuffer - getTextRange single CJK character" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("A 日 B");

    var buffer: [100]u8 = undefined;
    // "A " = 2 cols, 日 = 2 cols at offset 2-4
    const len = try eb.getTextRange(2, 4, &buffer);
    try std.testing.expectEqualStrings("日", buffer[0..len]);
}

test "EditBuffer - getTextRange across lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello\nWorld");

    var buffer: [100]u8 = undefined;
    // "Hello" = 5 cols, newline = 1 weight, "Wo" = 2 cols
    const len = try eb.getTextRange(3, 8, &buffer);
    try std.testing.expectEqualStrings("lo\nWo", buffer[0..len]);
}

test "EditBuffer - getTextRange with tabs" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("A\tB");

    var buffer: [100]u8 = undefined;
    // Should include the tab character
    const len = try eb.getTextRange(0, 10, &buffer);
    try std.testing.expectEqualStrings("A\tB", buffer[0..len]);
}

test "EditBuffer - getTextRange partial grapheme snap to start" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    // CJK character is 2 cols wide
    try eb.insertText("A 好 B");

    var buffer: [100]u8 = undefined;
    // Try to get range starting at middle of 好 (offset 3), should snap to start (offset 2)
    const len = try eb.getTextRange(3, 5, &buffer);
    try std.testing.expectEqualStrings("好 ", buffer[0..len]);
}

test "EditBuffer - getTextRange partial grapheme snap to end" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    // CJK character is 2 cols wide
    try eb.insertText("A 好 B");

    var buffer: [100]u8 = undefined;
    // Try to get range ending at middle of 好 (offset 3), should snap to end (offset 4)
    const len = try eb.getTextRange(0, 3, &buffer);
    try std.testing.expectEqualStrings("A 好", buffer[0..len]);
}

test "EditBuffer - getTextRange empty range" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello");

    var buffer: [100]u8 = undefined;
    const len = try eb.getTextRange(5, 5, &buffer);
    try std.testing.expectEqual(@as(usize, 0), len);
}

test "EditBuffer - getTextRange out of bounds" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello");

    var buffer: [100]u8 = undefined;
    const len = try eb.getTextRange(0, 1000, &buffer);
    try std.testing.expectEqualStrings("Hello", buffer[0..len]);
}

test "EditBuffer - getTextRange mixed scripts" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    // Mix of ASCII, emoji, CJK, Devanagari
    try eb.insertText("Hi 👋 世界 नमस्ते");

    var buffer: [100]u8 = undefined;
    // Get everything
    const total_len = try eb.getTextRange(0, 100, &buffer);
    try std.testing.expectEqualStrings("Hi 👋 世界 नमस्ते", buffer[0..total_len]);

    // Get just the emoji
    const emoji_len = try eb.getTextRange(3, 5, &buffer);
    try std.testing.expectEqualStrings("👋", buffer[0..emoji_len]);

    // Get the CJK part: "Hi " = 3, "👋 " = 3, "世界" = 4 (cols 6-10)
    const cjk_len = try eb.getTextRange(6, 10, &buffer);
    try std.testing.expectEqualStrings("世界", buffer[0..cjk_len]);
}

test "EditBuffer - getTextRange before cursor" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello World");
    try eb.setCursor(0, 5);

    const cursor = eb.getCursor(0).?;
    var buffer: [100]u8 = undefined;

    // Get text before cursor
    const len = try eb.getTextRange(0, cursor.offset, &buffer);
    try std.testing.expectEqualStrings("Hello", buffer[0..len]);
}

test "EditBuffer - getTextRange char before cursor" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello World");
    try eb.setCursor(0, 5);

    const cursor = eb.getCursor(0).?;
    var buffer: [100]u8 = undefined;

    // Get last char before cursor (if cursor > 0)
    if (cursor.offset > 0) {
        const prev_width = eb.tb.getPrevGraphemeWidth(cursor.row, cursor.col);
        const len = try eb.getTextRange(cursor.offset - prev_width, cursor.offset, &buffer);
        try std.testing.expectEqualStrings("o", buffer[0..len]);
    }
}

test "EditBuffer - getTextRange emoji before cursor" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hi 👋");
    try eb.setCursor(0, 5); // After emoji

    const cursor = eb.getCursor(0).?;
    var buffer: [100]u8 = undefined;

    // Get emoji before cursor
    const prev_width = eb.tb.getPrevGraphemeWidth(cursor.row, cursor.col);
    const len = try eb.getTextRange(cursor.offset - prev_width, cursor.offset, &buffer);
    try std.testing.expectEqualStrings("👋", buffer[0..len]);
}

test "EditBuffer - getTextRange multiline with emojis" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Line1 👋\nLine2 🎉\nLine3");

    var buffer: [100]u8 = undefined;
    // Get across all lines
    const len = try eb.getTextRange(0, 100, &buffer);
    try std.testing.expectEqualStrings("Line1 👋\nLine2 🎉\nLine3", buffer[0..len]);
}

test "EditBuffer - wcwidth mode treats multi-codepoint emoji as separate chars" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    // Hand emoji with skin tone: U+1F44B (waving hand) + U+1F3FB (light skin tone)
    // In wcwidth mode, these should be treated as 2 separate chars with width 2 each = 4 total
    // In unicode/no_zwj mode, they would be 1 grapheme with width 2
    const hand_with_skin_tone = "👋🏻"; // U+1F44B U+1F3FB

    // Family emoji: U+1F468 (man) + U+200D (ZWJ) + U+1F469 (woman) + U+200D + U+1F467 (girl)
    // In wcwidth mode: each visible codepoint should count separately
    const family = "👨‍👩‍👧"; // man + ZWJ + woman + ZWJ + girl

    // Girl with laptop: U+1F469 (woman) + U+200D (ZWJ) + U+1F4BB (laptop)
    const girl_laptop = "👩‍💻"; // woman + ZWJ + laptop

    try eb.setText(hand_with_skin_tone);
    try eb.setCursor(0, 0);

    // In wcwidth mode:
    // - U+1F44B (👋) has width 2
    // - U+1F3FB (🏻 skin tone) has width 2
    // Total width should be 4 (not 2 as in grapheme mode)
    const line_width_hand = iter_mod.lineWidthAt(eb.tb.rope(), 0);

    // Move right should go: col 0 -> col 2 (after first codepoint) -> col 4 (after second codepoint)
    eb.moveRight();
    var cursor = eb.getPrimaryCursor();

    eb.moveRight();
    cursor = eb.getPrimaryCursor();

    // Expected behavior for wcwidth mode: treating each codepoint as separate
    try std.testing.expectEqual(@as(u32, 4), line_width_hand);
    try eb.setCursor(0, 0);
    eb.moveRight();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.col); // After first codepoint (width 2)
    eb.moveRight();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 4), cursor.col); // After second codepoint (width 2)

    try eb.setText(family);
    const line_width_family = iter_mod.lineWidthAt(eb.tb.rope(), 0);

    // Family: man (width 2) + ZWJ (width 0) + woman (width 2) + ZWJ (width 0) + girl (width 2)
    // In wcwidth mode, total should be 6
    try std.testing.expectEqual(@as(u32, 6), line_width_family);

    try eb.setCursor(0, 0);
    eb.moveRight(); // Should move to col 2 (after man)
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.col);

    eb.moveRight(); // Should move to col 4 (after woman)
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 4), cursor.col);

    eb.moveRight(); // Should move to col 6 (after girl)
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 6), cursor.col);

    try eb.setText(girl_laptop);
    const line_width_laptop = iter_mod.lineWidthAt(eb.tb.rope(), 0);

    // Woman (width 2) + ZWJ (width 0) + laptop (width 2) = 4 in wcwidth mode
    try std.testing.expectEqual(@as(u32, 4), line_width_laptop);

    try eb.setCursor(0, 0);
    eb.moveRight(); // Should move to col 2 (after woman)
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.col);

    eb.moveRight(); // Should move to col 4 (after laptop)
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 4), cursor.col);
}

test "EditBuffer - wcwidth comprehensive emoji cursor movement and backspace" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    // Test string with various emoji types
    // "👩🏽‍💻  👨‍👩‍👧‍👦  🏳️‍🌈  🇺🇸  🇩🇪  🇯🇵  🇮🇳"
    const woman_tech = "👩🏽‍💻"; // Woman + skin tone + ZWJ + laptop = 2+2+0+2 = 6
    const family = "👨‍👩‍👧‍👦"; // Man + ZWJ + Woman + ZWJ + Girl + ZWJ + Boy = 2+0+2+0+2+0+2 = 8
    const rainbow_flag = "🏳️‍🌈"; // Flag + VS16 + ZWJ + Rainbow = 1+0+0+2 = 3 (white flag is width 1 in wcwidth)
    const us_flag = "🇺🇸"; // Regional indicators = 1+1 = 2
    _ = "🇩🇪"; // German flag (unused but documented)
    _ = "🇯🇵"; // Japanese flag (unused but documented)
    _ = "🇮🇳"; // Indian flag (unused but documented)

    try eb.setText(woman_tech);
    const width1 = iter_mod.lineWidthAt(eb.tb.rope(), 0);
    try std.testing.expectEqual(@as(u32, 6), width1);

    // Test moving right through all codepoints
    try eb.setCursor(0, 0);
    eb.moveRight(); // Past woman (width 2)
    var cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.col);

    eb.moveRight(); // Past skin tone (width 2)
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 4), cursor.col);

    eb.moveRight(); // Past ZWJ - since ZWJ has width 0, we skip it and move to laptop
    cursor = eb.getPrimaryCursor();
    // ZWJ is zero-width and should be skipped - cursor jumps directly to laptop
    try std.testing.expectEqual(@as(u32, 6), cursor.col);

    // Test moving back left
    eb.moveLeft(); // Back before laptop, skip ZWJ, land at skin tone
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 4), cursor.col); // Skipped ZWJ, at skin tone

    eb.moveLeft(); // Back before skin tone
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.col);

    eb.moveLeft(); // Back to start
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.col);

    // Test backspace from end
    try eb.setCursor(0, 6); // At end

    // Get initial text
    var buf: [100]u8 = undefined;
    var len = eb.getText(&buf);
    try std.testing.expectEqualStrings(woman_tech, buf[0..len]);

    // Backspace from col 6 should delete laptop and move to col 4
    try eb.backspace();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 4), cursor.col);

    len = eb.getText(&buf);

    // Backspace from col 4: getPrevGraphemeWidth skips ZWJ and returns skin tone width (2)
    // So we delete from col 2 to col 4, which removes both ZWJ and skin tone
    // Cursor moves to col 2
    try eb.backspace();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.col);

    len = eb.getText(&buf);

    // Backspace from col 2 should delete woman and move to col 0
    try eb.backspace();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.col);

    len = eb.getText(&buf);
    try std.testing.expectEqual(@as(usize, 0), len);

    try eb.setText(family);
    const width2 = iter_mod.lineWidthAt(eb.tb.rope(), 0);
    try std.testing.expectEqual(@as(u32, 8), width2);

    // Move through all visible codepoints (ZWJs are automatically skipped)
    try eb.setCursor(0, 0);
    eb.moveRight(); // Man (skips following ZWJ)
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.col);

    eb.moveRight(); // Woman (skips preceding and following ZWJ)
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 4), cursor.col);

    eb.moveRight(); // Girl (skips preceding and following ZWJ)
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 6), cursor.col);

    eb.moveRight(); // Boy (skips preceding ZWJ)
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 8), cursor.col);

    // Move back (ZWJs are skipped)
    eb.moveLeft(); // Back to Girl
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 6), cursor.col);

    eb.moveLeft(); // Back to Woman
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 4), cursor.col);

    eb.moveLeft(); // Back to Man
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.col);

    try eb.setText(rainbow_flag);
    const width3 = iter_mod.lineWidthAt(eb.tb.rope(), 0);
    try std.testing.expectEqual(@as(u32, 3), width3);

    try eb.setCursor(0, 0);
    eb.moveRight(); // White flag (width 1, skips VS16 and ZWJ)
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 1), cursor.col);

    eb.moveRight(); // Rainbow (width 2, VS16 and ZWJ were skipped)
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 3), cursor.col);

    try eb.setText(us_flag);
    const width4 = iter_mod.lineWidthAt(eb.tb.rope(), 0);
    try std.testing.expectEqual(@as(u32, 2), width4);

    try eb.setCursor(0, 0);
    eb.moveRight(); // First regional indicator
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 1), cursor.col);

    eb.moveRight(); // Second regional indicator
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.col);

    // Move back
    eb.moveLeft();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 1), cursor.col);

    eb.moveLeft();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.col);

    const mixed_text = "A 👩🏽‍💻 B 👨‍👩‍👧‍👦 C";
    try eb.setText(mixed_text);
    const mixed_width = iter_mod.lineWidthAt(eb.tb.rope(), 0);
    // A(1) + space(1) + woman_tech(6) + space(1) + B(1) + space(1) + family(8) + space(1) + C(1) = 21
    try std.testing.expectEqual(@as(u32, 21), mixed_width);

    // Navigate through the mixed text
    try eb.setCursor(0, 0);

    // Move to 'A'
    eb.moveRight();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 1), cursor.col);

    // Move past space
    eb.moveRight();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.col);

    // Move through woman technologist (ZWJs are skipped)
    eb.moveRight(); // woman
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 4), cursor.col);

    eb.moveRight(); // skin tone
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 6), cursor.col);

    eb.moveRight(); // laptop (ZWJ is skipped)
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 8), cursor.col);

    // Should be at space after woman_tech
    eb.moveRight();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 9), cursor.col);
}

test "EditBuffer - wcwidth ZWJ does not appear in rendered text" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    const woman_tech = "👩🏽‍💻"; // Contains ZWJ at byte position
    try eb.setText(woman_tech);

    // Get the raw bytes - ZWJ should be present in the buffer
    var buf: [100]u8 = undefined;
    const len = eb.getText(&buf);
    const text_bytes = buf[0..len];

    // Check that ZWJ (U+200D = 0xE2 0x80 0x8D in UTF-8) is present in bytes
    var has_zwj = false;
    var i: usize = 0;
    while (i + 2 < len) : (i += 1) {
        if (text_bytes[i] == 0xE2 and text_bytes[i + 1] == 0x80 and text_bytes[i + 2] == 0x8D) {
            has_zwj = true;
            break;
        }
    }
    try std.testing.expect(has_zwj);

    // Verify that the full text is preserved byte-for-byte
    try std.testing.expectEqualStrings(woman_tech, text_bytes);

    // But cursor movement should skip over ZWJ
    try eb.setCursor(0, 0);
    const line_width = iter_mod.lineWidthAt(eb.tb.rope(), 0);
    try std.testing.expectEqual(@as(u32, 6), line_width); // 2+2+0+2

    // Moving through: cursor positions should be 0, 2, 4, 6
    // ZWJ is skipped automatically
    try eb.setCursor(0, 0);
    eb.moveRight(); // Woman
    var cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.col);

    eb.moveRight(); // Skin tone
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 4), cursor.col);

    eb.moveRight(); // Laptop (ZWJ is skipped)
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 6), cursor.col);
}

test "EditBuffer - wcwidth each visible emoji requires exactly one cursor move" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    // Test 1: Simple laptop emoji (no ZWJ)
    try eb.setText("💻");
    const width1 = iter_mod.lineWidthAt(eb.tb.rope(), 0);
    try std.testing.expectEqual(@as(u32, 2), width1);

    try eb.setCursor(0, 0);
    eb.moveRight(); // Should move past laptop in ONE move
    var cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.col);

    // Test 2: Woman emoji (no modifiers)
    try eb.setText("👩");
    try eb.setCursor(0, 0);
    eb.moveRight(); // Should move past woman in ONE move
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.col);

    // Test 3: Skin tone emoji alone
    try eb.setText("🏽");
    try eb.setCursor(0, 0);
    eb.moveRight(); // Should move past skin in ONE move
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.col);

    // Test 4: Woman + skin (no ZWJ yet)
    try eb.setText("👩🏽");
    const width4 = iter_mod.lineWidthAt(eb.tb.rope(), 0);
    try std.testing.expectEqual(@as(u32, 4), width4); // 2+2

    try eb.setCursor(0, 0);
    eb.moveRight(); // Move past woman
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.col);

    eb.moveRight(); // Move past skin in ONE more move
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 4), cursor.col);

    // Test 5: Woman + skin + ZWJ + laptop (full technologist)
    try eb.setText("👩🏽‍💻");
    const width5 = iter_mod.lineWidthAt(eb.tb.rope(), 0);
    try std.testing.expectEqual(@as(u32, 6), width5); // 2+2+0+2

    try eb.setCursor(0, 0);

    // Should take exactly 3 moves to get to the end (woman, skin, laptop)
    // ZWJ should be completely invisible to cursor
    eb.moveRight(); // Move 1: woman
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.col);

    eb.moveRight(); // Move 2: skin
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 4), cursor.col);

    eb.moveRight(); // Move 3: laptop (ZWJ should be skipped automatically)
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 6), cursor.col);

    // Moving right again should do nothing (at end)
    eb.moveRight();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 6), cursor.col);

    // Test moving backwards
    eb.moveLeft(); // Should move back to before laptop (skip ZWJ), land at skin
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 4), cursor.col);

    eb.moveLeft(); // Should move back to before skin
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.col);

    eb.moveLeft(); // Should move back to start
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.col);
}

test "EditBuffer - replaceText allows undo" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    // Set initial text (resets everything)
    try eb.setText("Initial");

    var buffer: [100]u8 = undefined;
    var len = eb.getText(&buffer);
    try std.testing.expectEqualStrings("Initial", buffer[0..len]);

    // Replace text with history preserved
    try eb.replaceText("Modified");
    len = eb.getText(&buffer);
    try std.testing.expectEqualStrings("Modified", buffer[0..len]);

    // Should be able to undo
    try std.testing.expect(eb.canUndo());
    _ = try eb.undo();

    // Should be back to "Initial"
    len = eb.getText(&buffer);
    try std.testing.expectEqualStrings("Initial", buffer[0..len]);
}

test "EditBuffer - setText clears all history" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    // Insert some text that creates undo history
    try eb.insertText("Initial");

    // Should have undo history
    try std.testing.expect(eb.canUndo());

    var buffer: [100]u8 = undefined;
    var len = eb.getText(&buffer);
    try std.testing.expectEqualStrings("Initial", buffer[0..len]);

    // setText now completely resets the buffer (clears history)
    try eb.setText("New");

    len = eb.getText(&buffer);
    try std.testing.expectEqualStrings("New", buffer[0..len]);

    // History should be cleared
    try std.testing.expect(!eb.canUndo());
}

test "EditBuffer - multiple replaceText with history keeps add_buffer functional" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    // Use replaceText to preserve history
    try eb.replaceText("Line 1");

    // Insert more text using the add_buffer
    try eb.insertText("\nLine 2");

    // Replace text again (preserves history)
    // This sets cursor to (0, 0)
    try eb.replaceText("Reset");

    // Insert more text using the add_buffer (should still work)
    // Since cursor is at (0, 0), text is inserted at the beginning
    try eb.insertText(" and more");

    var buffer: [100]u8 = undefined;
    const len = eb.getText(&buffer);
    // Text is inserted at cursor position (0, 0), so it appears before "Reset"
    try std.testing.expectEqualStrings(" and moreReset", buffer[0..len]);

    // Verify we can undo
    try std.testing.expect(eb.canUndo());

    // Move cursor to end and insert more text
    const line_count = eb.tb.lineCount();
    const last_line_width = iter_mod.lineWidthAt(eb.tb.rope(), line_count - 1);
    try eb.setCursor(line_count - 1, last_line_width);
    try eb.insertText(" more");

    const len2 = eb.getText(&buffer);
    try std.testing.expectEqualStrings(" and moreReset more", buffer[0..len2]);
}

test "EditBuffer - setText resets add_buffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    // Insert text that uses add_buffer
    try eb.insertText("First");
    try eb.insertText(" Second");

    var buffer: [100]u8 = undefined;
    var len = eb.getText(&buffer);
    try std.testing.expectEqualStrings("First Second", buffer[0..len]);

    // setText should reset add_buffer.len to 0
    try eb.setText("Reset");

    len = eb.getText(&buffer);
    try std.testing.expectEqualStrings("Reset", buffer[0..len]);

    // After setText, add_buffer should be reset and work fine
    // setText places cursor at (0,0), so move to end of text
    const line_count = eb.tb.lineCount();
    const last_line_width = iter_mod.lineWidthAt(eb.tb.rope(), line_count - 1);
    try eb.setCursor(line_count - 1, last_line_width);

    try eb.insertText(" More");

    len = eb.getText(&buffer);
    try std.testing.expectEqualStrings("Reset More", buffer[0..len]);
}
