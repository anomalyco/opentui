const std = @import("std");
const text_buffer = @import("../text-buffer.zig");
const text_buffer_view = @import("../text-buffer-view.zig");
const ansi = @import("../ansi.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");

const TextBuffer = text_buffer.TextBuffer;
const TextBufferView = text_buffer_view.TextBufferView;
const Viewport = text_buffer_view.Viewport;

// ===== Viewport-Aware Selection Tests =====

test "Selection - vertical viewport selection without wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9");

    view.setViewport(.{ .x = 0, .y = 5, .width = 10, .height = 5 });

    _ = view.setLocalSelection(0, 0, 2, 2, null, null);

    var buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&buffer);
    const text = buffer[0..len];

    try std.testing.expect(std.mem.find(u8, text, "Line 5") != null);
    try std.testing.expect(std.mem.find(u8, text, "Line 6") != null);
    try std.testing.expect(std.mem.find(u8, text, "Li") != null);
    try std.testing.expect(std.mem.find(u8, text, "Line 7") == null);
}

test "Selection - horizontal viewport selection without wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");

    view.setViewport(.{ .x = 10, .y = 0, .width = 10, .height = 1 });

    _ = view.setLocalSelection(0, 0, 5, 0, null, null);

    var buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&buffer);
    const text = buffer[0..len];

    try std.testing.expectEqualStrings("KLMNO", text);
}

test "Selection - wrapping mode ignores horizontal viewport offset" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ");

    view.setWrapMode(.char);
    view.setWrapWidth(10);

    view.setViewport(.{ .x = 10, .y = 0, .width = 10, .height = 3 });

    _ = view.setLocalSelection(0, 0, 5, 0, null, null);

    var buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&buffer);
    const text = buffer[0..len];

    try std.testing.expectEqualStrings("ABCDE", text);
}

test "Selection - vertical viewport with wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");

    view.setWrapMode(.char);
    view.setWrapWidth(10);

    const vline_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 4), vline_count);

    view.setViewport(.{ .x = 0, .y = 1, .width = 10, .height = 2 });

    _ = view.setLocalSelection(0, 0, 5, 1, null, null);

    var buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&buffer);
    const text = buffer[0..len];

    try std.testing.expectEqualStrings("KLMNOPQRSTUVWXY", text);
}

test "Selection - across empty line with viewport offset" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line0\n\nLine2\nLine3\nLine4");

    view.setViewport(.{ .x = 0, .y = 1, .width = 10, .height = 3 });

    _ = view.setLocalSelection(0, 0, 3, 2, null, null);

    var buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&buffer);
    const text = buffer[0..len];
    try std.testing.expect(std.mem.find(u8, text, "Line2") != null);
    try std.testing.expect(std.mem.find(u8, text, "Lin") != null);
}

test "Selection - viewport offset with multi-line selection" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("AAA\nBBB\nCCC\nDDD\nEEE\nFFF\nGGG\nHHH");

    view.setViewport(.{ .x = 0, .y = 2, .width = 10, .height = 4 });

    _ = view.setLocalSelection(0, 0, 3, 0, null, null);

    var buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&buffer);
    const text = buffer[0..len];

    try std.testing.expectEqualStrings("CCC", text);
}

test "Selection - combined horizontal and vertical viewport offsets" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ\n0123456789ABCDEFGHIJKLMNOP\nQRSTUVWXYZ0123456789ABCDEF");

    view.setViewport(.{ .x = 5, .y = 1, .width = 10, .height = 2 });

    _ = view.setLocalSelection(0, 0, 5, 0, null, null);

    var buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&buffer);
    const text = buffer[0..len];

    try std.testing.expectEqualStrings("56789", text);
}

test "Selection - viewport without offsets behaves as before" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    view.setViewport(.{ .x = 0, .y = 0, .width = 20, .height = 5 });

    _ = view.setLocalSelection(2, 0, 7, 0, null, null);

    var buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&buffer);
    const text = buffer[0..len];

    try std.testing.expectEqualStrings("llo W", text);
}

test "Selection - no viewport behaves as before" {
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

    var buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&buffer);
    const text = buffer[0..len];

    try std.testing.expectEqualStrings("llo W", text);
}

test "Selection - VALIDATION: verify selection range matches extracted text with viewport" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line0\nLine1\nLine2\nLine3\nLine4\nLine5\nLine6\nLine7\nLine8\nLine9");

    view.setViewport(.{ .x = 0, .y = 5, .width = 10, .height = 5 });

    _ = view.setLocalSelection(0, 0, 5, 0, null, null);

    const selection = view.getSelection();
    try std.testing.expect(selection != null);

    var selected_buffer: [100]u8 = undefined;
    const selected_len = view.getSelectedTextIntoBuffer(&selected_buffer);
    const selected_text = selected_buffer[0..selected_len];

    try std.testing.expectEqualStrings("Line5", selected_text);

    const expected_start: u32 = 30; // Start of line 5
    const expected_end: u32 = 35; // First 5 chars of line 5

    try std.testing.expectEqual(expected_start, selection.?.start);
    try std.testing.expectEqual(expected_end, selection.?.end);
}

test "Selection - VALIDATION: multi-line selection range with viewport" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("AAA\nBBB\nCCC\nDDD\nEEE\nFFF\nGGG\nHHH");

    view.setViewport(.{ .x = 0, .y = 3, .width = 10, .height = 5 });

    _ = view.setLocalSelection(0, 0, 3, 2, null, null);

    var selected_buffer: [100]u8 = undefined;
    const selected_len = view.getSelectedTextIntoBuffer(&selected_buffer);
    const selected_text = selected_buffer[0..selected_len];

    try std.testing.expectEqualStrings("DDD\nEEE\nFFF", selected_text);

    const selection = view.getSelection();
    try std.testing.expect(selection != null);

    const expected_start: u32 = 12; // Start of line 3
    const expected_end: u32 = 23; // End of "FFF" on line 5

    try std.testing.expectEqual(expected_start, selection.?.start);
    try std.testing.expectEqual(expected_end, selection.?.end);
}

test "Selection - RENDER TEST: selection highlights correct cells with viewport scroll" {
    const buffer_mod = @import("../buffer.zig");

    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("AAA\nBBB\nCCC\nDDD\nEEE\nFFF\nGGG\nHHH");

    view.setViewport(.{ .x = 0, .y = 3, .width = 10, .height = 5 });

    const red_bg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    _ = view.setLocalSelection(0, 0, 3, 0, red_bg, null);

    var render_buffer = try buffer_mod.OptimizedBuffer.init(std.testing.allocator, 20, 10, .{ .pool = pool, .width_method = .unicode });
    defer render_buffer.deinit();

    render_buffer.drawTextBuffer(view, 0, 0);

    var x: u32 = 0;
    while (x < 3) : (x += 1) {
        const cell = render_buffer.get(x, 0);
        try std.testing.expect(cell != null);

        const bg = cell.?.bg;
        try std.testing.expectEqual(@as(u8, 255), ansi.red(bg));
        try std.testing.expectEqual(@as(u8, 0), ansi.green(bg));
        try std.testing.expectEqual(@as(u8, 0), ansi.blue(bg));
    }

    const cell_3 = render_buffer.get(3, 0);
    try std.testing.expect(cell_3 != null);
    const bg_3 = cell_3.?.bg;
    try std.testing.expect(bg_3[0] < 0.5); // Not red
}
