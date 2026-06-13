const std = @import("std");
const text_buffer = @import("../text-buffer.zig");
const text_buffer_view = @import("../text-buffer-view.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");

const TextBuffer = text_buffer.TextBuffer;
const TextBufferView = text_buffer_view.TextBufferView;
const RGBA = text_buffer.RGBA;

test "Selection - basic selection without wrap" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    _ = view.setLocalSelection(2, 0, 7, 0, null, null);

    const packed_info = view.packSelectionInfo();
    try std.testing.expect(packed_info != 0xFFFFFFFF_FFFFFFFF);

    const start = @as(u32, @intCast(packed_info >> 32));
    const end = @as(u32, @intCast(packed_info & 0xFFFFFFFF));
    try std.testing.expectEqual(@as(u32, 2), start);
    try std.testing.expectEqual(@as(u32, 7), end);
}

test "Selection - with wrapped lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST");

    view.setWrapMode(.char);
    view.setWrapWidth(10);

    try std.testing.expectEqual(@as(u32, 2), view.getVirtualLineCount());

    _ = view.setLocalSelection(5, 0, 5, 1, null, null);

    const packed_info = view.packSelectionInfo();
    try std.testing.expect(packed_info != 0xFFFFFFFF_FFFFFFFF);

    const start = @as(u32, @intCast(packed_info >> 32));
    const end = @as(u32, @intCast(packed_info & 0xFFFFFFFF));
    try std.testing.expectEqual(@as(u32, 5), start);
    try std.testing.expectEqual(@as(u32, 15), end);
}

test "Selection - no selection returns all bits set" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    const packed_info = view.packSelectionInfo();
    try std.testing.expectEqual(@as(u64, 0xFFFFFFFF_FFFFFFFF), packed_info);
}

test "Selection - with newline characters" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 1\nLine 2\nLine 3");

    _ = view.setLocalSelection(2, 1, 4, 2, null, null);

    const packed_info = view.packSelectionInfo();
    try std.testing.expect(packed_info != 0xFFFFFFFF_FFFFFFFF);

    var out_buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&out_buffer);
    const text = out_buffer[0..len];

    try std.testing.expect(std.mem.indexOf(u8, text, "ne 2") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "\n") != null);
}

test "Selection - across empty lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 1\nLine 2\n\nLine 4");

    _ = view.setLocalSelection(0, 0, 2, 2, null, null);

    const packed_info = view.packSelectionInfo();
    try std.testing.expect(packed_info != 0xFFFFFFFF_FFFFFFFF);

    const start = @as(u32, @intCast(packed_info >> 32));
    const end = @as(u32, @intCast(packed_info & 0xFFFFFFFF));
    try std.testing.expectEqual(@as(u32, 0), start);
    // With newline-aware offsets: Line 0 (0-5) + newline (6) + Line 1 (7-12) + newline (13) + Line 2 empty (14)
    // Selection to (row=2, col=2) with empty line 2 clamps to col=0, so end=14
    try std.testing.expectEqual(@as(u32, 14), end);
}

test "Selection - ending in empty line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 1\n\nLine 3");

    _ = view.setLocalSelection(0, 0, 3, 1, null, null);

    const packed_info = view.packSelectionInfo();
    try std.testing.expect(packed_info != 0xFFFFFFFF_FFFFFFFF);

    const start = @as(u32, @intCast(packed_info >> 32));
    try std.testing.expectEqual(@as(u32, 0), start);
}

test "Selection - spanning multiple lines completely" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("First\nSecond\nThird");

    _ = view.setLocalSelection(0, 1, 6, 1, null, null);

    var out_buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&out_buffer);
    const text = out_buffer[0..len];

    try std.testing.expectEqualStrings("Second", text);
}

test "Selection - including multiple line breaks" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("A\nB\nC\nD");

    _ = view.setLocalSelection(0, 1, 1, 2, null, null);

    var out_buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&out_buffer);
    const text = out_buffer[0..len];

    try std.testing.expect(std.mem.indexOf(u8, text, "\n") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "B") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "C") != null);
}

test "Selection - at line boundaries" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line1\nLine2\nLine3");

    _ = view.setLocalSelection(4, 0, 2, 1, null, null);

    var out_buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&out_buffer);
    const text = out_buffer[0..len];

    try std.testing.expect(std.mem.indexOf(u8, text, "1") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "\n") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "Li") != null);
}

test "Selection - empty text" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("");

    _ = view.setLocalSelection(0, 0, 0, 0, null, null);

    const packed_info = view.packSelectionInfo();
    try std.testing.expectEqual(@as(u64, 0xFFFFFFFF_FFFFFFFF), packed_info);
}

test "Selection - single character" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("A");

    _ = view.setLocalSelection(0, 0, 1, 0, null, null);

    const packed_info = view.packSelectionInfo();
    try std.testing.expect(packed_info != 0xFFFFFFFF_FFFFFFFF);

    const start = @as(u32, @intCast(packed_info >> 32));
    const end = @as(u32, @intCast(packed_info & 0xFFFFFFFF));
    try std.testing.expectEqual(@as(u32, 0), start);
    try std.testing.expectEqual(@as(u32, 1), end);

    var out_buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&out_buffer);
    const text = out_buffer[0..len];
    try std.testing.expectEqualStrings("A", text);
}

test "Selection - zero-width selection" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    _ = view.setLocalSelection(5, 0, 5, 0, null, null);

    const packed_info = view.packSelectionInfo();
    try std.testing.expectEqual(@as(u64, 0xFFFFFFFF_FFFFFFFF), packed_info);
}

test "Selection - beyond text bounds" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hi");

    _ = view.setLocalSelection(0, 0, 10, 0, null, null);

    const packed_info = view.packSelectionInfo();
    try std.testing.expect(packed_info != 0xFFFFFFFF_FFFFFFFF);

    const start = @as(u32, @intCast(packed_info >> 32));
    const end = @as(u32, @intCast(packed_info & 0xFFFFFFFF));
    try std.testing.expectEqual(@as(u32, 0), start);
    try std.testing.expectEqual(@as(u32, 2), end);
}

test "Selection - clear selection" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    _ = view.setLocalSelection(0, 0, 5, 0, null, null);
    var packed_info = view.packSelectionInfo();
    try std.testing.expect(packed_info != 0xFFFFFFFF_FFFFFFFF);

    view.resetLocalSelection();
    packed_info = view.packSelectionInfo();
    try std.testing.expectEqual(@as(u64, 0xFFFFFFFF_FFFFFFFF), packed_info);
}

test "Selection - at wrap boundary" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST");

    view.setWrapMode(.char);
    view.setWrapWidth(10);

    _ = view.setLocalSelection(9, 0, 1, 1, null, null);

    const packed_info = view.packSelectionInfo();
    try std.testing.expect(packed_info != 0xFFFFFFFF_FFFFFFFF);

    const start = @as(u32, @intCast(packed_info >> 32));
    const end = @as(u32, @intCast(packed_info & 0xFFFFFFFF));
    try std.testing.expectEqual(@as(u32, 9), start);
    try std.testing.expectEqual(@as(u32, 11), end);
}

test "Selection - spanning multiple wrapped lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123");

    view.setWrapMode(.char);
    view.setWrapWidth(10);
    try std.testing.expectEqual(@as(u32, 3), view.getVirtualLineCount());

    _ = view.setLocalSelection(2, 0, 8, 2, null, null);

    const packed_info = view.packSelectionInfo();
    try std.testing.expect(packed_info != 0xFFFFFFFF_FFFFFFFF);

    const start = @as(u32, @intCast(packed_info >> 32));
    const end = @as(u32, @intCast(packed_info & 0xFFFFFFFF));
    try std.testing.expectEqual(@as(u32, 2), start);
    try std.testing.expectEqual(@as(u32, 28), end);
}

test "Selection - changes when wrap width changes" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST");

    view.setWrapMode(.char);
    view.setWrapWidth(10);
    _ = view.setLocalSelection(5, 0, 5, 1, null, null);

    var packed_info = view.packSelectionInfo();
    var start = @as(u32, @intCast(packed_info >> 32));
    var end = @as(u32, @intCast(packed_info & 0xFFFFFFFF));
    try std.testing.expectEqual(@as(u32, 5), start);
    try std.testing.expectEqual(@as(u32, 15), end);

    view.setWrapWidth(5);
    _ = view.setLocalSelection(5, 0, 5, 1, null, null);

    packed_info = view.packSelectionInfo();
    start = @as(u32, @intCast(packed_info >> 32));
    end = @as(u32, @intCast(packed_info & 0xFFFFFFFF));

    try std.testing.expect(packed_info != 0xFFFFFFFF_FFFFFFFF);
}

test "Selection - with newlines and wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNO\nPQRSTUVWXYZ");

    view.setWrapMode(.char);
    view.setWrapWidth(10);

    const vline_count = view.getVirtualLineCount();
    try std.testing.expect(vline_count >= 3);

    _ = view.setLocalSelection(5, 0, 5, 2, null, null);

    const packed_info = view.packSelectionInfo();
    try std.testing.expect(packed_info != 0xFFFFFFFF_FFFFFFFF);
}

test "Selection - getSelectedText simple" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");
    view.setSelection(6, 11, null, null);

    var out_buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&out_buffer);
    const text = out_buffer[0..len];

    try std.testing.expectEqualStrings("World", text);
}

test "Selection - getSelectedText with newlines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 1\nLine 2\nLine 3");
    // With rope weight system: Line 0 (0-5) + newline (6) + Line 1 (7-12) + newline (13) + Line 2 (14-19)
    // Selection [0, 9) includes: "Line 1" (0-5) + newline (6) + "Li" (7-8) = 9 chars total
    view.setSelection(0, 9, null, null);

    var out_buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&out_buffer);
    const text = out_buffer[0..len];

    try std.testing.expectEqualStrings("Line 1\nLi", text);
}

test "Selection - getSelectedText preserves empty lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("const a = 1\n\nconst b = 2");

    view.setSelection(0, 24, null, null);

    var out_buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&out_buffer);

    try std.testing.expectEqualStrings("const a = 1\n\nconst b = 2", out_buffer[0..len]);
}

test "Selection - spanning multiple lines with getSelectedText" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Red\nBlue");
    // Rope offsets: "Red" (0-2) + newline (3) + "Blue" (4-7)
    // Selection [2, 5) = "d" (2) + newline (3) + "B" (4) = 3 chars
    view.setSelection(2, 5, null, null);

    var out_buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&out_buffer);
    const text = out_buffer[0..len];

    try std.testing.expectEqualStrings("d\nB", text);
}

test "Selection - with graphemes" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello 🌍 World");

    view.setSelection(0, 8, null, null);

    var out_buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&out_buffer);
    const text = out_buffer[0..len];

    try std.testing.expect(std.mem.indexOf(u8, text, "Hello") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "🌍") != null);
}

test "Selection - wide emoji at boundary" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello 🌍 World");

    // Select "Hello 🌍" which is 7 columns: H(0),e(1),l(2),l(3),o(4),space(5),🌍(6-7)
    // Note: 🌍 is a 2-wide character
    // Selection [0, 7) should include the emoji because it starts at column 6
    view.setSelection(0, 7, null, null);

    var out_buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&out_buffer);
    const text = out_buffer[0..len];

    try std.testing.expectEqualStrings("Hello 🌍", text);
}

test "Selection - wide emoji BEFORE selection start should be excluded" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello 🌍 World");

    // Layout: H(0) e(1) l(2) l(3) o(4) space(5) 🌍(6-7) space(8) W(9) o(10) r(11) l(12) d(13)
    // Select [7, 10) - starts at col 7 (second cell of emoji), ends at col 10
    // When selection starts at second cell of width=2 grapheme, snap backward to include it
    // So selection should include emoji (snaps to col 6), space, and W
    // Should NOT include 'o' at col 10 because selection is [7, 10) exclusive end
    view.setSelection(7, 10, null, null);

    var out_buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&out_buffer);
    const text = out_buffer[0..len];

    try std.testing.expectEqualStrings("🌍 W", text);
}

test "Selection - start at second cell of width=2 grapheme should snap backward to include it" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("AB🌍CD");

    view.setSelection(3, 5, null, null);

    var out_buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&out_buffer);
    const text = out_buffer[0..len];

    try std.testing.expectEqualStrings("🌍C", text);
}

test "Selection - end at first cell of width=2 grapheme should snap forward to include it" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("AB🌍CD");

    view.setSelection(1, 3, null, null);

    var out_buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&out_buffer);
    const text = out_buffer[0..len];

    try std.testing.expectEqualStrings("B🌍", text);
}

test "Selection - both boundaries at cells of width=2 graphemes" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("A🌍B🌎C");

    view.setSelection(2, 5, null, null);

    var out_buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&out_buffer);
    const text = out_buffer[0..len];

    try std.testing.expectEqualStrings("🌍B🌎", text);
}

test "Selection - updateSelection extends existing selection" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    // Set initial selection from 0 to 5
    view.setSelection(0, 5, null, null);

    var packed_info = view.packSelectionInfo();
    var start = @as(u32, @intCast(packed_info >> 32));
    var end = @as(u32, @intCast(packed_info & 0xFFFFFFFF));
    try std.testing.expectEqual(@as(u32, 0), start);
    try std.testing.expectEqual(@as(u32, 5), end);

    // Update to extend end to 11
    view.updateSelection(11, null, null);

    packed_info = view.packSelectionInfo();
    start = @as(u32, @intCast(packed_info >> 32));
    end = @as(u32, @intCast(packed_info & 0xFFFFFFFF));
    try std.testing.expectEqual(@as(u32, 0), start);
    try std.testing.expectEqual(@as(u32, 11), end);

    var out_buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&out_buffer);
    const text = out_buffer[0..len];
    try std.testing.expectEqualStrings("Hello World", text);
}

test "Selection - updateSelection with no existing selection does nothing" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    // No selection set
    const packed_info_before = view.packSelectionInfo();
    try std.testing.expectEqual(@as(u64, 0xFFFFFFFF_FFFFFFFF), packed_info_before);

    // Try to update - should do nothing
    view.updateSelection(5, null, null);

    const packed_info_after = view.packSelectionInfo();
    try std.testing.expectEqual(@as(u64, 0xFFFFFFFF_FFFFFFFF), packed_info_after);
}

test "Selection - updateSelection can shrink selection" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    view.setSelection(0, 11, null, null);

    // Shrink to 5
    view.updateSelection(5, null, null);

    const packed_info = view.packSelectionInfo();
    const start = @as(u32, @intCast(packed_info >> 32));
    const end = @as(u32, @intCast(packed_info & 0xFFFFFFFF));
    try std.testing.expectEqual(@as(u32, 0), start);
    try std.testing.expectEqual(@as(u32, 5), end);

    var out_buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&out_buffer);
    const text = out_buffer[0..len];
    try std.testing.expectEqualStrings("Hello", text);
}

test "Selection - updateLocalSelection extends focus position" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    // Set initial local selection from (0,0) to (5,0)
    _ = view.setLocalSelection(0, 0, 5, 0, null, null);

    var packed_info = view.packSelectionInfo();
    var start = @as(u32, @intCast(packed_info >> 32));
    var end = @as(u32, @intCast(packed_info & 0xFFFFFFFF));
    try std.testing.expectEqual(@as(u32, 0), start);
    try std.testing.expectEqual(@as(u32, 5), end);

    // Update focus to (11,0) - should keep anchor at (0,0)
    const changed = view.updateLocalSelection(0, 0, 11, 0, null, null);
    try std.testing.expect(changed);

    packed_info = view.packSelectionInfo();
    start = @as(u32, @intCast(packed_info >> 32));
    end = @as(u32, @intCast(packed_info & 0xFFFFFFFF));
    try std.testing.expectEqual(@as(u32, 0), start);
    try std.testing.expectEqual(@as(u32, 11), end);

    var out_buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&out_buffer);
    const text = out_buffer[0..len];
    try std.testing.expectEqualStrings("Hello World", text);
}

test "Selection - updateLocalSelection with no existing selection falls back to setLocalSelection" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    // No selection set - updateLocalSelection now falls back to setLocalSelection
    const changed = view.updateLocalSelection(0, 0, 5, 0, null, null);
    try std.testing.expect(changed);

    const packed_info = view.packSelectionInfo();
    const start = @as(u32, @intCast(packed_info >> 32));
    const end = @as(u32, @intCast(packed_info & 0xFFFFFFFF));
    try std.testing.expectEqual(@as(u32, 0), start);
    try std.testing.expectEqual(@as(u32, 5), end);
}

test "Selection - updateLocalSelection can shrink selection" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    _ = view.setLocalSelection(0, 0, 11, 0, null, null);

    // Shrink focus to 5
    const changed = view.updateLocalSelection(0, 0, 5, 0, null, null);
    try std.testing.expect(changed);

    const packed_info = view.packSelectionInfo();
    const start = @as(u32, @intCast(packed_info >> 32));
    const end = @as(u32, @intCast(packed_info & 0xFFFFFFFF));
    try std.testing.expectEqual(@as(u32, 0), start);
    try std.testing.expectEqual(@as(u32, 5), end);

    var out_buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&out_buffer);
    const text = out_buffer[0..len];
    try std.testing.expectEqualStrings("Hello", text);
}

test "Selection - updateLocalSelection across multiple lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 1\nLine 2\nLine 3");

    // Start selection at (2, 0)
    _ = view.setLocalSelection(2, 0, 2, 0, null, null);

    // Extend to (4, 1) - should select from "ne 1\nLine"
    const changed = view.updateLocalSelection(2, 0, 4, 1, null, null);
    try std.testing.expect(changed);

    var out_buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&out_buffer);
    const text = out_buffer[0..len];

    try std.testing.expect(std.mem.indexOf(u8, text, "ne 1") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "\n") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "Line") != null);
}

test "Selection - updateLocalSelection backward selection" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World!");

    // Set anchor at (11, 0) - after "World"
    _ = view.setLocalSelection(11, 0, 11, 0, null, null);

    // Move focus backward to (6, 0) - start of "World"
    // Backward selection adds +1 to make it inclusive, so [6, 12) = "World!"
    const changed = view.updateLocalSelection(11, 0, 6, 0, null, null);
    try std.testing.expect(changed);

    const packed_info = view.packSelectionInfo();
    const start = @as(u32, @intCast(packed_info >> 32));
    const end = @as(u32, @intCast(packed_info & 0xFFFFFFFF));
    try std.testing.expectEqual(@as(u32, 6), start);
    try std.testing.expectEqual(@as(u32, 12), end);

    var out_buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&out_buffer);
    const text = out_buffer[0..len];
    try std.testing.expectEqualStrings("World!", text);
}

test "Selection - updateLocalSelection with wrapped lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST");

    view.setWrapMode(.char);
    view.setWrapWidth(10);

    try std.testing.expectEqual(@as(u32, 2), view.getVirtualLineCount());

    // Start at (0, 0)
    _ = view.setLocalSelection(0, 0, 0, 0, null, null);

    // Extend to second wrapped line (5, 1)
    const changed = view.updateLocalSelection(0, 0, 5, 1, null, null);
    try std.testing.expect(changed);

    const packed_info = view.packSelectionInfo();
    const start = @as(u32, @intCast(packed_info >> 32));
    const end = @as(u32, @intCast(packed_info & 0xFFFFFFFF));
    try std.testing.expectEqual(@as(u32, 0), start);
    try std.testing.expectEqual(@as(u32, 15), end);

    var out_buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&out_buffer);
    const text = out_buffer[0..len];
    try std.testing.expectEqualStrings("ABCDEFGHIJKLMNO", text);
}

test "Selection - updateLocalSelection with same focus position maintains selection" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    _ = view.setLocalSelection(0, 0, 5, 0, null, null);

    // Update to same focus position - selection should remain the same
    _ = view.updateLocalSelection(0, 0, 5, 0, null, null);

    const packed_info = view.packSelectionInfo();
    const start = @as(u32, @intCast(packed_info >> 32));
    const end = @as(u32, @intCast(packed_info & 0xFFFFFFFF));
    try std.testing.expectEqual(@as(u32, 0), start);
    try std.testing.expectEqual(@as(u32, 5), end);
}

test "Selection - updateLocalSelection preserves anchor correctly" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 1\nLine 2\nLine 3");

    // Set anchor at (3, 1) - middle of "Line 2" (at 'e' in "Line")
    _ = view.setLocalSelection(3, 1, 3, 1, null, null);

    // Update focus multiple times - last one to (6, 2) which is end of "Line 3"
    _ = view.updateLocalSelection(3, 1, 6, 1, null, null);
    _ = view.updateLocalSelection(3, 1, 2, 2, null, null);
    _ = view.updateLocalSelection(3, 1, 6, 2, null, null);

    // Final selection should still have anchor at (3, 1)
    var out_buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&out_buffer);
    const text = out_buffer[0..len];

    // Should include "e 2\nLine 3" since anchor is at col 3 of line 1 and focus at end of line 2
    try std.testing.expect(std.mem.indexOf(u8, text, "e 2") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "\nLine 3") != null);
}
