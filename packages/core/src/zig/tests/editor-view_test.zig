const std = @import("std");
const editor_view = @import("../editor-view.zig");
const edit_buffer = @import("../edit-buffer.zig");
const text_buffer = @import("../text-buffer.zig");
const text_buffer_view = @import("../text-buffer-view.zig");
const opt_buffer_mod = @import("../buffer.zig");
const ansi = @import("../ansi.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");

const EditorView = editor_view.EditorView;
const EditBuffer = edit_buffer.EditBuffer;
const Cursor = edit_buffer.Cursor;
const Viewport = text_buffer_view.Viewport;

test "EditorView - init and deinit" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    const vp = ev.getViewport();
    try std.testing.expect(vp != null);
    try std.testing.expectEqual(@as(u32, 80), vp.?.width);
    try std.testing.expectEqual(@as(u32, 24), vp.?.height);
    try std.testing.expectEqual(@as(u32, 0), vp.?.y);
}

test "EditorView - ensureCursorVisible scrolls down when cursor moves below viewport" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.insertText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10\nLine 11\nLine 12\nLine 13\nLine 14\nLine 15\nLine 16\nLine 17\nLine 18\nLine 19");

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 19), cursor.row);

    _ = ev.getVirtualLines();

    const vp = ev.getViewport().?;
    try std.testing.expect(vp.y > 0);
    try std.testing.expect(cursor.row >= vp.y);
    try std.testing.expect(cursor.row < vp.y + vp.height);
}

test "EditorView - ensureCursorVisible scrolls up when cursor moves above viewport" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.insertText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10\nLine 11\nLine 12\nLine 13\nLine 14\nLine 15\nLine 16\nLine 17\nLine 18\nLine 19");

    _ = ev.getVirtualLines();

    var vp = ev.getViewport().?;
    try std.testing.expect(vp.y > 0);

    try eb.gotoLine(0);

    _ = ev.getVirtualLines();

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);

    vp = ev.getViewport().?;
    try std.testing.expectEqual(@as(u32, 0), vp.y);
}

test "EditorView - moveDown scrolls viewport automatically" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.insertText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10\nLine 11\nLine 12\nLine 13\nLine 14\nLine 15\nLine 16\nLine 17\nLine 18\nLine 19");

    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();
    var vp = ev.getViewport().?;
    try std.testing.expectEqual(@as(u32, 0), vp.y);

    var i: u32 = 0;
    while (i < 15) : (i += 1) {
        eb.moveDown();
    }

    _ = ev.getVirtualLines();

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 15), cursor.row);

    vp = ev.getViewport().?;
    try std.testing.expect(cursor.row >= vp.y);
    try std.testing.expect(cursor.row < vp.y + vp.height);
}

test "EditorView - moveUp scrolls viewport automatically" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.insertText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10\nLine 11\nLine 12\nLine 13\nLine 14\nLine 15\nLine 16\nLine 17\nLine 18\nLine 19");

    _ = ev.getVirtualLines();

    var vp = ev.getViewport().?;
    const initial_y = vp.y;
    try std.testing.expect(initial_y > 0);

    var i: u32 = 0;
    while (i < 10) : (i += 1) {
        eb.moveUp();
    }

    _ = ev.getVirtualLines();

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 9), cursor.row);

    vp = ev.getViewport().?;
    try std.testing.expect(vp.y < initial_y);
    try std.testing.expect(cursor.row >= vp.y);
    try std.testing.expect(cursor.row < vp.y + vp.height);
}

test "EditorView - scroll margin keeps cursor away from edges" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    ev.setScrollMargin(0.2);

    try eb.insertText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10\nLine 11\nLine 12\nLine 13\nLine 14\nLine 15\nLine 16\nLine 17\nLine 18\nLine 19");

    try eb.gotoLine(5);

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 5), cursor.row);

    const vp = ev.getViewport().?;
    const cursor_offset_in_viewport = cursor.row - vp.y;

    try std.testing.expect(cursor_offset_in_viewport >= 2);
    try std.testing.expect(cursor_offset_in_viewport < vp.height - 2);
}

test "EditorView - insertText with newlines maintains cursor visibility" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 5);
    defer ev.deinit();

    try eb.insertText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9");

    _ = ev.getVirtualLines();

    const cursor = ev.getPrimaryCursor();
    const vp = ev.getViewport().?;

    try std.testing.expect(cursor.row >= vp.y);
    try std.testing.expect(cursor.row < vp.y + vp.height);
}

test "EditorView - backspace at line start maintains visibility" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 5);
    defer ev.deinit();

    try eb.insertText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9");

    try eb.backspace();

    _ = ev.getVirtualLines();

    const cursor = ev.getPrimaryCursor();
    const vp = ev.getViewport().?;

    try std.testing.expect(cursor.row >= vp.y);
    try std.testing.expect(cursor.row < vp.y + vp.height);
}

test "EditorView - deleteForward at line end maintains visibility" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 5);
    defer ev.deinit();

    try eb.insertText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9");

    try eb.setCursor(8, 6);

    try eb.deleteForward();

    _ = ev.getVirtualLines();

    const cursor = ev.getPrimaryCursor();
    const vp = ev.getViewport().?;

    try std.testing.expect(cursor.row >= vp.y);
    try std.testing.expect(cursor.row < vp.y + vp.height);
}

test "EditorView - deleteRange maintains cursor visibility" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 5);
    defer ev.deinit();

    try eb.insertText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9");

    try eb.deleteRange(.{ .row = 2, .col = 0 }, .{ .row = 7, .col = 6 });

    _ = ev.getVirtualLines();

    const cursor = ev.getPrimaryCursor();
    const vp = ev.getViewport().?;

    try std.testing.expect(cursor.row >= vp.y);
    try std.testing.expect(cursor.row < vp.y + vp.height);
}

test "EditorView - deleteLine maintains cursor visibility" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 5);
    defer ev.deinit();

    try eb.insertText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9");

    try eb.gotoLine(7);

    try eb.deleteLine();

    _ = ev.getVirtualLines();

    const cursor = ev.getPrimaryCursor();
    const vp = ev.getViewport().?;

    try std.testing.expect(cursor.row >= vp.y);
    try std.testing.expect(cursor.row < vp.y + vp.height);
}

test "EditorView - setText resets viewport to top" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 5);
    defer ev.deinit();

    try eb.insertText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9");

    _ = ev.getVirtualLines();

    var vp = ev.getViewport().?;
    try std.testing.expect(vp.y > 0);

    try eb.setText("New Line 0\nNew Line 1\nNew Line 2");

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);

    _ = ev.getVirtualLines();

    vp = ev.getViewport().?;
    try std.testing.expectEqual(@as(u32, 0), vp.y);
}

test "EditorView - viewport respects total line count as max offset" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.insertText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4");

    try eb.gotoLine(4);

    const vp = ev.getViewport().?;
    try std.testing.expectEqual(@as(u32, 0), vp.y);
}

test "EditorView - horizontal movement doesn't affect vertical scroll" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.insertText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4");

    try eb.setCursor(2, 0);

    const vp_before = ev.getViewport().?;

    eb.moveRight();
    eb.moveRight();
    eb.moveRight();

    const vp_after = ev.getViewport().?;
    try std.testing.expectEqual(vp_before.y, vp_after.y);
}

test "EditorView - cursor at boundaries doesn't cause invalid viewport" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.setCursor(0, 0);

    var vp = ev.getViewport().?;
    try std.testing.expectEqual(@as(u32, 0), vp.y);

    try eb.insertText("First line");

    try eb.setCursor(0, 0);

    vp = ev.getViewport().?;
    try std.testing.expectEqual(@as(u32, 0), vp.y);

    eb.moveLeft();
    vp = ev.getViewport().?;
    try std.testing.expectEqual(@as(u32, 0), vp.y);

    eb.moveUp();
    vp = ev.getViewport().?;
    try std.testing.expectEqual(@as(u32, 0), vp.y);
}

test "EditorView - rapid cursor movements maintain visibility" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.insertText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10\nLine 11\nLine 12\nLine 13\nLine 14\nLine 15\nLine 16\nLine 17\nLine 18\nLine 19\nLine 20\nLine 21\nLine 22\nLine 23\nLine 24\nLine 25\nLine 26\nLine 27\nLine 28\nLine 29");

    try eb.gotoLine(0);
    try eb.gotoLine(29);
    try eb.gotoLine(15);
    try eb.gotoLine(5);
    try eb.gotoLine(25);

    _ = ev.getVirtualLines();

    const cursor = ev.getPrimaryCursor();
    const vp = ev.getViewport().?;

    try std.testing.expect(cursor.row >= vp.y);
    try std.testing.expect(cursor.row < vp.y + vp.height);
}

test "EditorView - VisualCursor without wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.insertText("Hello World\nSecond Line\nThird Line");

    try eb.setCursor(1, 3);

    const vcursor = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 1), vcursor.visual_row);
    try std.testing.expectEqual(@as(u32, 3), vcursor.visual_col);
    try std.testing.expectEqual(@as(u32, 1), vcursor.logical_row);
    try std.testing.expectEqual(@as(u32, 3), vcursor.logical_col);
}

test "EditorView - VisualCursor with character wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    ev.setWrapMode(.char);

    try eb.setText("This is a very long line that will definitely wrap at 20 characters");

    try eb.setCursor(0, 25);

    const vcursor = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 0), vcursor.logical_row);
    try std.testing.expectEqual(@as(u32, 25), vcursor.logical_col);
    try std.testing.expect(vcursor.visual_row > 0);
    try std.testing.expect(vcursor.visual_col <= 20);
}

test "EditorView - VisualCursor with word wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    ev.setWrapMode(.word);

    try eb.setText("Hello world this is a test of word wrapping");

    const line_count = eb.getTextBuffer().getLineCount();
    try std.testing.expectEqual(@as(u32, 1), line_count);

    _ = ev.getVisualCursor();
}

test "EditorView - moveUpVisual with wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    ev.setWrapMode(.char);

    try eb.setText("This is a very long line that will definitely wrap multiple times at twenty characters");

    try eb.setCursor(0, 50);

    const vcursor_before = ev.getVisualCursor();
    const visual_row_before = vcursor_before.visual_row;

    ev.moveUpVisual();

    const vcursor_after = ev.getVisualCursor();

    try std.testing.expectEqual(visual_row_before - 1, vcursor_after.visual_row);

    try std.testing.expectEqual(@as(u32, 0), vcursor_after.logical_row);
}

test "EditorView - moveDownVisual with wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    ev.setWrapMode(.char);

    try eb.setText("This is a very long line that will definitely wrap multiple times at twenty characters");

    try eb.setCursor(0, 0);

    const vcursor_before = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 0), vcursor_before.visual_row);

    ev.moveDownVisual();

    const vcursor_after = ev.getVisualCursor();

    try std.testing.expectEqual(@as(u32, 1), vcursor_after.visual_row);

    try std.testing.expectEqual(@as(u32, 0), vcursor_after.logical_row);
}

test "EditorView - visualToLogicalCursor conversion" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    ev.setWrapMode(.char);

    try eb.setText("12345678901234567890123456789012345");

    if (ev.visualToLogicalCursor(1, 5)) |vcursor| {
        try std.testing.expectEqual(@as(u32, 1), vcursor.visual_row);
        try std.testing.expectEqual(@as(u32, 0), vcursor.logical_row);
        try std.testing.expectEqual(@as(u32, 25), vcursor.logical_col);
    }
}

test "EditorView - moveUpVisual resolves wrapped boundary with canonical conversion" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 10, 10);
    defer ev.deinit();

    ev.setWrapMode(.word);

    const text = "quick brown fox";
    try eb.setText(text);

    const line_info = ev.getCachedLineInfo();
    try std.testing.expectEqualSlices(u32, &[_]u32{ 6, 9 }, line_info.line_width_cols);

    const canonical_boundary_cursor = ev.visualToLogicalCursor(0, 6) orelse return error.MissingVisualCursor;
    try std.testing.expectEqual(@as(u32, 0), canonical_boundary_cursor.visual_row);
    try std.testing.expectEqual(@as(u32, 6), canonical_boundary_cursor.visual_col);
    try std.testing.expectEqual(@as(u32, 6), canonical_boundary_cursor.logical_col);

    const canonical_cursor_from_boundary = ev.logicalToVisualCursor(canonical_boundary_cursor.logical_row, canonical_boundary_cursor.logical_col);
    try std.testing.expectEqual(@as(u32, 1), canonical_cursor_from_boundary.visual_row);

    try eb.setCursor(0, text.len);
    var cursor = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 1), cursor.visual_row);
    try std.testing.expectEqual(@as(u32, 9), cursor.visual_col);

    ev.moveUpVisual();
    cursor = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.visual_row);
    try std.testing.expectEqual(@as(u32, 5), cursor.visual_col);
}

test "EditorView - moveDownVisual resolves wrapped boundary with canonical conversion" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 10, 10);
    defer ev.deinit();

    ev.setWrapMode(.word);

    try eb.setText("0123456789\nquick brown fox");

    const line_info = ev.getCachedLineInfo();
    try std.testing.expectEqualSlices(u32, &[_]u32{ 10, 6, 9 }, line_info.line_width_cols);

    try eb.setCursor(0, 10);
    var cursor = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.visual_row);
    try std.testing.expectEqual(@as(u32, 10), cursor.visual_col);

    ev.moveDownVisual();
    cursor = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 1), cursor.visual_row);
    try std.testing.expectEqual(@as(u32, 5), cursor.visual_col);
}

test "EditorView - moveUpVisual at top boundary" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    ev.setWrapMode(.char);
    try eb.setText("Short line");

    try eb.setCursor(0, 0);

    const before = ev.getPrimaryCursor();
    ev.moveUpVisual();
    const after = ev.getPrimaryCursor();

    try std.testing.expectEqual(before.row, after.row);
    try std.testing.expectEqual(before.col, after.col);
}

test "EditorView - moveDownVisual at bottom boundary" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    ev.setWrapMode(.char);
    try eb.setText("Short line\nSecond line");

    try eb.setCursor(1, 0);

    const before = ev.getPrimaryCursor();
    ev.moveDownVisual();
    const after = ev.getPrimaryCursor();

    try std.testing.expectEqual(before.row, after.row);
}

test "EditorView - VisualCursor preserves desired column across wrapped lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    ev.setWrapMode(.char);

    try eb.setText("12345678901234567890123456789012345678901234567890");

    try eb.setCursor(0, 15);

    ev.moveDownVisual();
    ev.moveDownVisual();
    ev.moveUpVisual();

    const vcursor = ev.getVisualCursor();

    try std.testing.expect(vcursor.visual_col <= 20);
}

test "EditorView - VisualCursor with multiple logical lines and wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    ev.setWrapMode(.char);

    try eb.setText("Short line 1\nThis is a very long line that will wrap multiple times\nShort line 3");

    try eb.setCursor(1, 30);

    const vcursor = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 1), vcursor.logical_row);

    try std.testing.expect(vcursor.visual_row > 1);
}

test "EditorView - logicalToVisualCursor handles cursor past line end" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.setText("Short");

    const vcursor = ev.logicalToVisualCursor(0, 100);

    try std.testing.expectEqual(@as(u32, 0), vcursor.logical_row);
}

test "EditorView - getTextBufferView returns correct view" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    const tbv = ev.getTextBufferView();
    const vp = tbv.getViewport();
    try std.testing.expect(vp != null);
}

test "EditorView - getEditBuffer returns correct buffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    const returned_eb = ev.getEditBuffer();
    try std.testing.expect(returned_eb == eb);
}

test "EditorView - setViewportSize maintains cursor visibility" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.insertText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10\nLine 11\nLine 12\nLine 13\nLine 14");

    try eb.gotoLine(10);

    ev.setViewportSize(80, 5);

    const vp = ev.getViewport().?;
    try std.testing.expectEqual(@as(u32, 80), vp.width);
    try std.testing.expectEqual(@as(u32, 5), vp.height);
}

test "EditorView - moveDownVisual across empty line preserves desired column" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.setText("Line with some text\n\nAnother line with text");

    try eb.setCursor(0, 10);

    const vcursor_before = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 10), vcursor_before.visual_col);

    ev.moveDownVisual();

    const vcursor_empty = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 1), vcursor_empty.logical_row);
    try std.testing.expectEqual(@as(u32, 0), vcursor_empty.visual_col);

    ev.moveDownVisual();

    const vcursor_after = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 2), vcursor_after.logical_row);
    try std.testing.expectEqual(@as(u32, 10), vcursor_after.visual_col);
}

test "EditorView - moveUpVisual across empty line preserves desired column" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.setText("Line with some text\n\nAnother line with text");

    try eb.setCursor(2, 10);

    const vcursor_before = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 10), vcursor_before.visual_col);

    ev.moveUpVisual();

    const vcursor_empty = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 1), vcursor_empty.logical_row);
    try std.testing.expectEqual(@as(u32, 0), vcursor_empty.visual_col);

    ev.moveUpVisual();

    const vcursor_after = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 0), vcursor_after.logical_row);
    try std.testing.expectEqual(@as(u32, 10), vcursor_after.visual_col);
}

test "EditorView - horizontal movement resets desired visual column" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.setText("Line with some text\n\nAnother line with text");

    try eb.setCursor(0, 10);

    const vcursor_initial = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 10), vcursor_initial.visual_col);

    ev.moveDownVisual();
    ev.moveDownVisual();

    const vcursor_after = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 2), vcursor_after.logical_row);
    try std.testing.expectEqual(@as(u32, 10), vcursor_after.visual_col);

    eb.moveRight();

    const vcursor_after_right = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 11), vcursor_after_right.visual_col);

    ev.moveUpVisual();
    ev.moveUpVisual();

    const vcursor_final = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 0), vcursor_final.logical_row);
    try std.testing.expectEqual(@as(u32, 11), vcursor_final.visual_col);
}

test "EditorView - inserting newlines maintains rope integrity" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Line 0\nLine 1\nLine 2");

    const rope_init = eb.getTextBuffer().rope();
    const line_count_init = eb.getTextBuffer().lineCount();
    try std.testing.expectEqual(@as(u32, 3), line_count_init);

    try eb.insertText("\n");

    const line_count_1 = eb.getTextBuffer().lineCount();
    try std.testing.expectEqual(@as(u32, 4), line_count_1);

    if (rope_init.getMarker(.linestart, 2)) |m2| {
        if (rope_init.getMarker(.linestart, 3)) |m3| {
            try std.testing.expect(m2.global_weight != m3.global_weight);
        }
    }

    try eb.insertText("\n");

    const line_count_2 = eb.getTextBuffer().lineCount();
    try std.testing.expectEqual(@as(u32, 5), line_count_2);

    if (rope_init.getMarker(.linestart, 3)) |m3| {
        if (rope_init.getMarker(.linestart, 4)) |m4| {
            try std.testing.expect(m3.global_weight != m4.global_weight);
        }
    }
}

test "EditorView - visual cursor stays in sync after scrolling and moving up" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.insertText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4");

    var cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 4), cursor.row);
    try std.testing.expectEqual(@as(u32, 6), cursor.col);

    _ = ev.getVirtualLines();

    var vp = ev.getViewport().?;
    try std.testing.expectEqual(@as(u32, 0), vp.y);

    var i: u32 = 0;
    while (i < 6) : (i += 1) {
        try eb.insertText("\n");
        _ = ev.getVirtualLines();
    }

    cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 10), cursor.row);
    try std.testing.expectEqual(@as(u32, 0), cursor.col);

    vp = ev.getViewport().?;
    try std.testing.expect(vp.y > 0);

    const vcursor_before = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 10), vcursor_before.logical_row);

    ev.moveUpVisual();
    _ = ev.getVirtualLines();

    const vcursor_after_up = ev.getVisualCursor();
    const logical_cursor_after_up = ev.getPrimaryCursor();

    try std.testing.expectEqual(@as(u32, 9), logical_cursor_after_up.row);
    try std.testing.expectEqual(@as(u32, 9), vcursor_after_up.logical_row);

    try std.testing.expect(vcursor_after_up.visual_row < vcursor_before.visual_row);

    try eb.insertText("X");
    _ = ev.getVirtualLines();

    const cursor_after_insert = ev.getPrimaryCursor();
    const vcursor_after_insert = ev.getVisualCursor();

    try std.testing.expectEqual(@as(u32, 9), cursor_after_insert.row);
    try std.testing.expectEqual(@as(u32, 1), cursor_after_insert.col);

    try std.testing.expectEqual(@as(u32, 9), vcursor_after_insert.logical_row);
    try std.testing.expectEqual(@as(u32, 1), vcursor_after_insert.logical_col);

    var out_buffer: [200]u8 = undefined;
    const written = eb.getText(&out_buffer);
    const text = out_buffer[0..written];

    var line_count: u32 = 0;
    var line_start: usize = 0;
    for (text, 0..) |c, idx| {
        if (c == '\n') {
            if (line_count == 9) {
                const line_9 = text[line_start..idx];
                try std.testing.expect(line_9.len >= 1);
                try std.testing.expectEqual(@as(u8, 'X'), line_9[0]);
                break;
            }
            line_count += 1;
            line_start = idx + 1;
        }
    }
}

test "EditorView - cursor positioning after wide grapheme" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.insertText("AB東CD");

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);
    try std.testing.expectEqual(@as(u32, 6), cursor.col);

    try eb.setCursor(0, 4);
    const cursor_after_move = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 4), cursor_after_move.col);

    const vcursor = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 0), vcursor.logical_row);
    try std.testing.expectEqual(@as(u32, 4), vcursor.logical_col);
    try std.testing.expectEqual(@as(u32, 4), vcursor.visual_col);
}

test "EditorView - backspace after wide grapheme updates cursor correctly" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.insertText("AB東CD");

    try eb.setCursor(0, 4);

    try eb.backspace();

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);
    try std.testing.expectEqual(@as(u32, 2), cursor.col);

    const vcursor = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 2), vcursor.logical_col);
    try std.testing.expectEqual(@as(u32, 2), vcursor.visual_col);

    var out_buffer: [100]u8 = undefined;
    const written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("ABCD", out_buffer[0..written]);
}

test "EditorView - viewport scrolling with wrapped lines: down + edit + up" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    const tbv = ev.getTextBufferView();
    tbv.setWrapMode(.char);
    ev.setViewport(.{ .x = 0, .y = 0, .width = 20, .height = 10 }, true);

    try eb.setText("AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFFFGGGGGGGGGGHHHHHHHHHHIIIIIIIIIIJJJJJJJJJJKKKKKKKKKKLLLLLLLLLLMMMMMMMMMMNNNNNNNNNNOOOOOOOOOOPPPPPPPPPPQQQQQQQQQQRRRRRRRRRRSSSSSSSSSSTTTTTTTTTTUUUUUUUUUUVVVVVVVVVVWWWWWWWWWWXXXXXXXXXXYYYYYYYYYYZZZZZZZZZZ");

    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();

    var vp = ev.getViewport().?;
    const initial_vp_y = vp.y;
    try std.testing.expectEqual(@as(u32, 0), initial_vp_y);

    ev.moveDownVisual();
    ev.moveDownVisual();
    ev.moveDownVisual();
    _ = ev.getVirtualLines();

    vp = ev.getViewport().?;
    _ = vp.y;

    _ = ev.getVisualCursor();

    try eb.insertText("X");
    _ = ev.getVirtualLines();

    vp = ev.getViewport().?;
    _ = vp.y;

    ev.moveUpVisual();
    ev.moveUpVisual();
    ev.moveUpVisual();
    _ = ev.getVirtualLines();

    vp = ev.getViewport().?;
    const final_vp_y = vp.y;

    const vcursor_final = ev.getVisualCursor();

    try std.testing.expectEqual(@as(u32, 0), vcursor_final.visual_row);
    try std.testing.expectEqual(@as(u32, 0), final_vp_y);
}

test "EditorView - viewport scrolling with wrapped lines: aggressive down + edit + up sequence" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    const tbv = ev.getTextBufferView();
    tbv.setWrapMode(.char);
    ev.setViewport(.{ .x = 0, .y = 0, .width = 20, .height = 10 }, true);

    try eb.setText("AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFFFGGGGGGGGGGHHHHHHHHHHIIIIIIIIIIJJJJJJJJJJKKKKKKKKKKLLLLLLLLLLMMMMMMMMMMNNNNNNNNNNOOOOOOOOOOPPPPPPPPPPQQQQQQQQQQRRRRRRRRRRSSSSSSSSSSTTTTTTTTTTUUUUUUUUUUVVVVVVVVVVWWWWWWWWWWXXXXXXXXXXYYYYYYYYYYZZZZZZZZZZ");

    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();

    const total_vlines = ev.getTotalVirtualLineCount();
    try std.testing.expect(total_vlines > 10);

    var vp = ev.getViewport().?;
    try std.testing.expectEqual(@as(u32, 0), vp.y);

    var i: u32 = 0;
    while (i < 12) : (i += 1) {
        ev.moveDownVisual();
    }
    _ = ev.getVirtualLines();

    vp = ev.getViewport().?;
    try std.testing.expect(vp.y > 0);

    try eb.insertText("TEST");
    _ = ev.getVirtualLines();

    i = 0;
    while (i < 12) : (i += 1) {
        ev.moveUpVisual();
    }
    _ = ev.getVirtualLines();

    vp = ev.getViewport().?;
    const vcursor = ev.getVisualCursor();

    try std.testing.expectEqual(@as(u32, 0), vcursor.visual_row);
    try std.testing.expectEqual(@as(u32, 0), vp.y);
}

test "EditorView - viewport scrolling with wrapped lines: multiple edits and movements" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 15, 8);
    defer ev.deinit();

    const tbv = ev.getTextBufferView();
    tbv.setWrapMode(.char);
    ev.setViewport(.{ .x = 0, .y = 0, .width = 15, .height = 8 }, true);

    try eb.setText("AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFFFGGGGGGGGGGHHHHHHHHHHIIIIIIIIIIJJJJJJJJJJKKKKKKKKKKLLLLLLLLLLMMMMMMMMMMNNNNNNNNNNOOOOOOOOOOPPPPPPPPPPQQQQQQQQQQRRRRRRRRRRSSSSSSSSSSTTTTTTTTTTUUUUUUUUUUVVVVVVVVVV");

    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();

    ev.moveDownVisual();
    ev.moveDownVisual();
    _ = ev.getVirtualLines();

    try eb.insertText("A");
    _ = ev.getVirtualLines();

    ev.moveDownVisual();
    _ = ev.getVirtualLines();

    try eb.insertText("B");
    _ = ev.getVirtualLines();

    ev.moveUpVisual();
    ev.moveUpVisual();
    ev.moveUpVisual();
    _ = ev.getVirtualLines();

    const vp = ev.getViewport().?;
    const vcursor = ev.getVisualCursor();

    try std.testing.expectEqual(@as(u32, 0), vcursor.visual_row);
    try std.testing.expectEqual(@as(u32, 0), vp.y);
}

test "EditorView - viewport scrolling with wrapped lines: verify viewport consistency" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    const tbv = ev.getTextBufferView();
    tbv.setWrapMode(.char);
    ev.setViewport(.{ .x = 0, .y = 0, .width = 20, .height = 10 }, true);

    try eb.setText("AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFFFGGGGGGGGGGHHHHHHHHHHIIIIIIIIIIJJJJJJJJJJKKKKKKKKKKLLLLLLLLLLMMMMMMMMMMNNNNNNNNNNOOOOOOOOOOPPPPPPPPPPQQQQQQQQQQRRRRRRRRRRSSSSSSSSSSTTTTTTTTTTUUUUUUUUUUVVVVVVVVVVWWWWWWWWWWXXXXXXXXXXYYYYYYYYYYZZZZZZZZZZ");

    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();

    const vline_count = ev.getTotalVirtualLineCount();
    try std.testing.expect(vline_count >= 10);

    var movements_down: u32 = 0;
    var i: u32 = 0;
    while (i < 5) : (i += 1) {
        const vcursor_before = ev.getVisualCursor();
        ev.moveDownVisual();
        const vcursor_after = ev.getVisualCursor();
        if (true) {
            if (vcursor_after.visual_row > vcursor_before.visual_row) {
                movements_down += 1;
            }
        }
    }
    _ = ev.getVirtualLines();

    _ = ev.getViewport().?;
    _ = ev.getVisualCursor();

    try eb.insertText("EDITED");
    _ = ev.getVirtualLines();

    i = 0;
    while (i < movements_down) : (i += 1) {
        ev.moveUpVisual();
    }
    _ = ev.getVirtualLines();

    const vp_final = ev.getViewport().?;
    const vcursor_final = ev.getVisualCursor();

    try std.testing.expectEqual(@as(u32, 0), vcursor_final.visual_row);
    try std.testing.expectEqual(@as(u32, 0), vp_final.y);
}

test "EditorView - viewport scrolling with wrapped lines: backspace after scroll" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    const tbv = ev.getTextBufferView();
    tbv.setWrapMode(.char);
    ev.setViewport(.{ .x = 0, .y = 0, .width = 20, .height = 10 }, true);

    try eb.setText("AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFFFGGGGGGGGGGHHHHHHHHHHIIIIIIIIIIJJJJJJJJJJKKKKKKKKKKLLLLLLLLLLMMMMMMMMMMNNNNNNNNNNOOOOOOOOOOPPPPPPPPPPQQQQQQQQQQRRRRRRRRRRSSSSSSSSSSTTTTTTTTTTUUUUUUUUUUVVVVVVVVVVWWWWWWWWWWXXXXXXXXXXYYYYYYYYYYZZZZZZZZZZ");

    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();

    ev.moveDownVisual();
    ev.moveDownVisual();
    _ = ev.getVirtualLines();

    try eb.backspace();
    _ = ev.getVirtualLines();

    ev.moveUpVisual();
    ev.moveUpVisual();
    _ = ev.getVirtualLines();

    const vp = ev.getViewport().?;
    const vcursor = ev.getVisualCursor();

    try std.testing.expectEqual(@as(u32, 0), vcursor.visual_row);
    try std.testing.expectEqual(@as(u32, 0), vp.y);
}

test "EditorView - viewport scrolling with wrapped lines: viewport follows cursor precisely" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 5);
    defer ev.deinit();

    const tbv = ev.getTextBufferView();
    tbv.setWrapMode(.char);
    ev.setViewport(.{ .x = 0, .y = 0, .width = 20, .height = 5 }, true);

    try eb.setText("AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFFFGGGGGGGGGGHHHHHHHHHHIIIIIIIIIIJJJJJJJJJJKKKKKKKKKKLLLLLLLLLLMMMMMMMMMMNNNNNNNNNNOOOOOOOOOOPPPPPPPPPPQQQQQQQQQQRRRRRRRRRRSSSSSSSSSSTTTTTTTTTTUUUUUUUUUUVVVVVVVVVVWWWWWWWWWWXXXXXXXXXXYYYYYYYYYYZZZZZZZZZZ");

    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();

    var i: u32 = 0;
    while (i < 10) : (i += 1) {
        ev.moveDownVisual();
        _ = ev.getVirtualLines();

        const vp = ev.getViewport().?;
        const vcursor = ev.getVisualCursor();

        try std.testing.expect(vcursor.visual_row >= 0);
        try std.testing.expect(vcursor.visual_row < vp.height);
    }

    try eb.insertText("MIDDLE");
    _ = ev.getVirtualLines();

    const vp_middle = ev.getViewport().?;
    const vcursor_middle = ev.getVisualCursor();
    try std.testing.expect(vcursor_middle.visual_row >= 0);
    try std.testing.expect(vcursor_middle.visual_row < vp_middle.height);

    i = 0;
    while (i < 10) : (i += 1) {
        ev.moveUpVisual();
        _ = ev.getVirtualLines();

        const vp = ev.getViewport().?;
        const vcursor = ev.getVisualCursor();

        try std.testing.expect(vcursor.visual_row >= 0);
        try std.testing.expect(vcursor.visual_row < vp.height);
    }

    const vp_final = ev.getViewport().?;
    const vcursor_final = ev.getVisualCursor();

    try std.testing.expectEqual(@as(u32, 0), vcursor_final.visual_row);
    try std.testing.expectEqual(@as(u32, 0), vp_final.y);
}

test "EditorView - wrapped lines: specific scenario with insert and deletions" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    const tbv = ev.getTextBufferView();
    tbv.setWrapMode(.char);
    ev.setViewport(.{ .x = 0, .y = 0, .width = 20, .height = 10 }, true);

    try eb.setText("AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFFFGGGGGGGGGGHHHHHHHHHHIIIIIIIIIIJJJJJJJJJJKKKKKKKKKKLLLLLLLLLLMMMMMMMMMMNNNNNNNNNNOOOOOOOOOOPPPPPPPPPPQQQQQQQQQQRRRRRRRRRRSSSSSSSSSSTTTTTTTTTTUUUUUUUUUUVVVVVVVVVVWWWWWWWWWWXXXXXXXXXXYYYYYYYYYYZZZZZZZZZZ");

    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();

    var vp = ev.getViewport().?;
    try std.testing.expectEqual(@as(u32, 0), vp.y);

    ev.moveDownVisual();
    ev.moveDownVisual();
    ev.moveDownVisual();
    ev.moveDownVisual();
    ev.moveDownVisual();
    _ = ev.getVirtualLines();

    vp = ev.getViewport().?;
    const vcursor_mid = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 5), vcursor_mid.visual_row);

    try eb.insertText("XXX");
    _ = ev.getVirtualLines();

    vp = ev.getViewport().?;
    const vcursor_after_insert = ev.getVisualCursor();
    try std.testing.expect(vcursor_after_insert.visual_row >= 0);
    try std.testing.expect(vcursor_after_insert.visual_row < vp.height);

    try eb.backspace();
    try eb.backspace();
    try eb.backspace();
    _ = ev.getVirtualLines();

    ev.moveUpVisual();
    ev.moveUpVisual();
    ev.moveUpVisual();
    ev.moveUpVisual();
    ev.moveUpVisual();
    _ = ev.getVirtualLines();

    vp = ev.getViewport().?;
    const vcursor_final2 = ev.getVisualCursor();

    try std.testing.expectEqual(@as(u32, 0), vcursor_final2.visual_row);
    try std.testing.expectEqual(@as(u32, 0), vp.y);
}

test "EditorView - wrapped lines: many small edits with viewport scrolling" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 15, 8);
    defer ev.deinit();

    const tbv = ev.getTextBufferView();
    tbv.setWrapMode(.char);
    ev.setViewport(.{ .x = 0, .y = 0, .width = 15, .height = 8 }, true);

    try eb.setText("AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFFFGGGGGGGGGGHHHHHHHHHHIIIIIIIIIIJJJJJJJJJJKKKKKKKKKKLLLLLLLLLLMMMMMMMMMMNNNNNNNNNNOOOOOOOOOOPPPPPPPPPPQQQQQQQQQQRRRRRRRRRRSSSSSSSSSSTTTTTTTTTTUUUUUUUUUUVVVVVVVVVV");

    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();

    ev.moveDownVisual();
    ev.moveDownVisual();
    _ = ev.getVirtualLines();

    try eb.insertText("1");
    _ = ev.getVirtualLines();

    ev.moveDownVisual();
    _ = ev.getVirtualLines();

    try eb.insertText("2");
    _ = ev.getVirtualLines();

    ev.moveDownVisual();
    _ = ev.getVirtualLines();

    try eb.insertText("3");
    _ = ev.getVirtualLines();

    ev.moveUpVisual();
    _ = ev.getVirtualLines();

    try eb.insertText("4");
    _ = ev.getVirtualLines();

    ev.moveUpVisual();
    ev.moveUpVisual();
    ev.moveUpVisual();
    _ = ev.getVirtualLines();

    const vp2 = ev.getViewport().?;
    const vcursor2 = ev.getVisualCursor();

    try std.testing.expectEqual(@as(u32, 0), vcursor2.visual_row);
    try std.testing.expectEqual(@as(u32, 0), vp2.y);
}

test "EditorView - horizontal scroll: cursor moves right beyond viewport" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    try eb.setText("This is a very long line that exceeds the viewport width of 20 characters");

    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();

    var vp = ev.getViewport().?;
    try std.testing.expectEqual(@as(u32, 0), vp.x);

    try eb.setCursor(0, 50);
    _ = ev.getVirtualLines();

    vp = ev.getViewport().?;
    try std.testing.expect(vp.x > 0);

    const cursor = ev.getPrimaryCursor();
    try std.testing.expect(cursor.col >= vp.x);
    try std.testing.expect(cursor.col < vp.x + vp.width);
}

test "EditorView - horizontal scroll: cursor moves left to beginning" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    try eb.setText("This is a very long line that exceeds the viewport width of 20 characters");

    try eb.setCursor(0, 50);
    _ = ev.getVirtualLines();

    var vp = ev.getViewport().?;
    try std.testing.expect(vp.x > 0);

    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();

    vp = ev.getViewport().?;
    try std.testing.expectEqual(@as(u32, 0), vp.x);
}

test "EditorView - horizontal scroll: moveRight scrolls viewport" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    try eb.setText("AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFFFGGGGGGGGGGHHHHHHHHHHIIIIIIIIIIJJJJJJJJJJKKKKKKKKKKLLLLLLLLLLMMMMMMMMMMNNNNNNNNNNOOOOOOOOOOPPPPPPPPPP");

    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();

    var vp = ev.getViewport().?;
    try std.testing.expectEqual(@as(u32, 0), vp.x);

    var i: u32 = 0;
    while (i < 50) : (i += 1) {
        eb.moveRight();
    }

    _ = ev.getVirtualLines();

    vp = ev.getViewport().?;
    try std.testing.expect(vp.x > 0);

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 50), cursor.col);
    try std.testing.expect(cursor.col >= vp.x);
    try std.testing.expect(cursor.col < vp.x + vp.width);
}

test "EditorView - horizontal scroll: moveLeft scrolls viewport back" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    try eb.setText("AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFFFGGGGGGGGGGHHHHHHHHHHIIIIIIIIIIJJJJJJJJJJKKKKKKKKKKLLLLLLLLLLMMMMMMMMMMNNNNNNNNNNOOOOOOOOOOPPPPPPPPPP");

    try eb.setCursor(0, 50);
    _ = ev.getVirtualLines();

    var vp = ev.getViewport().?;
    const initial_x = vp.x;
    try std.testing.expect(initial_x > 0);

    var i: u32 = 0;
    while (i < 30) : (i += 1) {
        eb.moveLeft();
    }

    _ = ev.getVirtualLines();

    vp = ev.getViewport().?;
    try std.testing.expect(vp.x < initial_x);

    const cursor = ev.getPrimaryCursor();
    try std.testing.expect(cursor.col >= vp.x);
    try std.testing.expect(cursor.col < vp.x + vp.width);
}

test "EditorView - horizontal scroll: editing in scrolled view" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    try eb.setText("AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFFFGGGGGGGGGGHHHHHHHHHHIIIIIIIIIIJJJJJJJJJJKKKKKKKKKKLLLLLLLLLLMMMMMMMMMMNNNNNNNNNNOOOOOOOOOOPPPPPPPPPP");

    try eb.setCursor(0, 50);
    _ = ev.getVirtualLines();

    var vp = ev.getViewport().?;
    try std.testing.expect(vp.x > 0);

    try eb.insertText("XYZ");
    _ = ev.getVirtualLines();

    vp = ev.getViewport().?;
    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 53), cursor.col);
    try std.testing.expect(cursor.col >= vp.x);
    try std.testing.expect(cursor.col < vp.x + vp.width);

    var out_buffer: [200]u8 = undefined;
    const written = eb.getText(&out_buffer);
    const text = out_buffer[0..written];
    try std.testing.expect(std.mem.indexOf(u8, text, "XYZ") != null);
}

test "EditorView - horizontal scroll: backspace in scrolled view" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    try eb.setText("AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFFFGGGGGGGGGGHHHHHHHHHHIIIIIIIIIIJJJJJJJJJJKKKKKKKKKKLLLLLLLLLLMMMMMMMMMMNNNNNNNNNNOOOOOOOOOOPPPPPPPPPP");

    try eb.setCursor(0, 50);
    _ = ev.getVirtualLines();

    var vp = ev.getViewport().?;
    try std.testing.expect(vp.x > 0);

    try eb.backspace();
    try eb.backspace();
    try eb.backspace();
    _ = ev.getVirtualLines();

    vp = ev.getViewport().?;
    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 47), cursor.col);
    try std.testing.expect(cursor.col >= vp.x);
    try std.testing.expect(cursor.col < vp.x + vp.width);
}

test "EditorView - horizontal scroll: short lines reset scroll" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    try eb.setText("Short line\nAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFGGGGGGGGGGHHHHHHHHHHIIIIIIIIIIJJJJJJJJJJ\nAnother short");

    try eb.setCursor(1, 50);
    _ = ev.getVirtualLines();

    var vp = ev.getViewport().?;
    try std.testing.expect(vp.x > 0);

    try eb.setCursor(0, 5);
    _ = ev.getVirtualLines();

    vp = ev.getViewport().?;
    try std.testing.expect(vp.x <= 5);

    try eb.setCursor(1, 50);
    _ = ev.getVirtualLines();

    vp = ev.getViewport().?;
    try std.testing.expect(vp.x > 0);
}

test "EditorView - horizontal scroll: scroll margin works" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    ev.setScrollMargin(0.2);

    try eb.setText("AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFFFGGGGGGGGGGHHHHHHHHHHIIIIIIIIIIJJJJJJJJJJKKKKKKKKKKLLLLLLLLLLMMMMMMMMMMNNNNNNNNNNOOOOOOOOOOPPPPPPPPPP");

    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();

    var i: u32 = 0;
    while (i < 25) : (i += 1) {
        eb.moveRight();
    }

    _ = ev.getVirtualLines();

    const vp = ev.getViewport().?;
    const cursor = ev.getPrimaryCursor();

    const cursor_offset_in_viewport = cursor.col - vp.x;
    try std.testing.expect(cursor_offset_in_viewport >= 4);
    try std.testing.expect(cursor_offset_in_viewport < vp.width - 4);
}

test "EditorView - horizontal scroll: no scrolling with wrapping enabled" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    ev.setWrapMode(.char);

    try eb.setText("AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFFFGGGGGGGGGGHHHHHHHHHHIIIIIIIIIIJJJJJJJJJJKKKKKKKKKKLLLLLLLLLLMMMMMMMMMMNNNNNNNNNNOOOOOOOOOOPPPPPPPPPP");

    try eb.setCursor(0, 50);
    _ = ev.getVirtualLines();

    const vp = ev.getViewport().?;
    try std.testing.expectEqual(@as(u32, 0), vp.x);
}

test "EditorView - horizontal scroll: cursor position correct after scrolling" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    try eb.setText("AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFFFGGGGGGGGGGHHHHHHHHHHIIIIIIIIIIJJJJJJJJJJKKKKKKKKKKLLLLLLLLLLMMMMMMMMMMNNNNNNNNNNOOOOOOOOOOPPPPPPPPPP");

    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();

    var i: u32 = 0;
    while (i < 50) : (i += 1) {
        eb.moveRight();
        _ = ev.getVirtualLines();

        const cursor = ev.getPrimaryCursor();
        const vp = ev.getViewport().?;
        const vcursor = ev.getVisualCursor();

        try std.testing.expectEqual(cursor.col, vcursor.logical_col);
        try std.testing.expect(cursor.col >= vp.x);
        try std.testing.expect(cursor.col < vp.x + vp.width);
    }
}

test "EditorView - horizontal scroll: rapid movements maintain visibility" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    try eb.setText("AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFFFGGGGGGGGGGHHHHHHHHHHIIIIIIIIIIJJJJJJJJJJKKKKKKKKKKLLLLLLLLLLMMMMMMMMMMNNNNNNNNNNOOOOOOOOOOPPPPPPPPPP");

    try eb.setCursor(0, 0);
    try eb.setCursor(0, 80);
    try eb.setCursor(0, 40);
    try eb.setCursor(0, 10);
    try eb.setCursor(0, 60);

    _ = ev.getVirtualLines();

    const vp = ev.getViewport().?;
    const cursor = ev.getPrimaryCursor();

    try std.testing.expectEqual(@as(u32, 60), cursor.col);
    try std.testing.expect(cursor.col >= vp.x);
    try std.testing.expect(cursor.col < vp.x + vp.width);
}

test "EditorView - horizontal scroll: goto end of long line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    const long_line = "AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFFFGGGGGGGGGGHHHHHHHHHHIIIIIIIIIIJJJJJJJJJJKKKKKKKKKKLLLLLLLLLLMMMMMMMMMMNNNNNNNNNNOOOOOOOOOOPPPPPPPPPP";
    try eb.setText(long_line);

    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();

    try eb.setCursor(0, @intCast(long_line.len));
    _ = ev.getVirtualLines();

    const vp = ev.getViewport().?;
    const cursor = ev.getPrimaryCursor();

    try std.testing.expect(vp.x > 0);
    try std.testing.expect(cursor.col >= vp.x);
    try std.testing.expect(cursor.col < vp.x + vp.width);
}

test "EditorView - cursor at second cell of width=2 grapheme moveLeft should jump to before grapheme" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    try eb.setText("(emoji 🌟 and CJK 世界)");

    try eb.setCursor(0, 7);
    var cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 7), cursor.col);

    // Move right - should jump over emoji to col 9
    eb.moveRight();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 9), cursor.col);

    // Manually set cursor to col 8 (second cell of emoji at 7-8)
    // TODO: setCursor should probably also snap to beginning of grapheme?
    //       When the width/cell based cursor is visual only and EditBuffer/Rope cursor is byte based
    try eb.setCursor(0, 8);
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 8), cursor.col);

    // Should jump to col 9 (after the emoji), not col 10
    eb.moveRight();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 9), cursor.col);

    try eb.setCursor(0, 8);
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 8), cursor.col);

    eb.moveLeft();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 6), cursor.col);
}

test "EditorView - cursor should be able to land after closing paren on line with wide graphemes" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    try eb.setText("(emoji 🌟 and CJK 世界)\nNext line");

    try eb.setCursor(0, 0);
    var cursor = eb.getPrimaryCursor();

    var i: u32 = 0;
    while (i < 30) : (i += 1) {
        const prev_col = cursor.col;
        const prev_row = cursor.row;
        eb.moveRight();
        cursor = eb.getPrimaryCursor();

        // Should not jump to next line until we've reached the end of the current line
        if (prev_row == 0 and cursor.row == 1) {
            // We jumped to the next line - check that we were at the end
            const iter_mod = @import("../text-buffer-iterators.zig");
            const line_width = iter_mod.lineWidthAt(eb.getTextBuffer().rope(), 0);
            try std.testing.expectEqual(line_width, prev_col);
            break;
        }

        if (i > 25) {
            break;
        }
    }

    try std.testing.expectEqual(@as(u32, 1), cursor.row);
    try std.testing.expectEqual(@as(u32, 0), cursor.col);
}

test "EditorView - visual cursor should stay on same line when moving to line end with wide graphemes" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    try eb.setText("(emoji 🌟 and CJK 世界)\nNext line");

    try eb.setCursor(0, 0);

    var i: u32 = 0;
    while (i < 30) : (i += 1) {
        eb.moveRight();
        const cursor = eb.getPrimaryCursor();
        const vcursor = ev.getVisualCursor();

        // Visual cursor should stay on row 0 until we move past the line end
        if (cursor.row == 0) {
            try std.testing.expectEqual(@as(u32, 0), vcursor.visual_row);
            try std.testing.expectEqual(cursor.col, vcursor.visual_col);
        }

        if (cursor.row == 1) {
            try std.testing.expectEqual(@as(u32, 1), vcursor.visual_row);
            break;
        }

        if (i > 25) break;
    }
}

test "EditorView - placeholder with styled text renders with correct highlights" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    const ss = @import("../syntax-style.zig");
    const style = try ss.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    eb.getTextBuffer().setSyntaxStyle(style);

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    const text_part1 = "Enter ";
    const text_part2 = "something";
    const text_part3 = " here";

    const fg_gray = ansi.rgbaFromFloats(0.5, 0.5, 0.5, 1.0);
    const fg_blue = ansi.rgbaFromFloats(0.3, 0.5, 0.9, 1.0);

    const chunks = [_]text_buffer.StyledChunk{
        .{
            .text_ptr = text_part1.ptr,
            .text_len = text_part1.len,
            .fg_ptr = @ptrCast(&fg_gray),
            .bg_ptr = null,
            .attributes = 0,
        },
        .{
            .text_ptr = text_part2.ptr,
            .text_len = text_part2.len,
            .fg_ptr = @ptrCast(&fg_blue),
            .bg_ptr = null,
            .attributes = 0,
        },
        .{
            .text_ptr = text_part3.ptr,
            .text_len = text_part3.len,
            .fg_ptr = @ptrCast(&fg_gray),
            .bg_ptr = null,
            .attributes = 0,
        },
    };

    try ev.setPlaceholderStyledText(&chunks);

    var out_buffer: [100]u8 = undefined;
    const written = eb.getText(&out_buffer);
    try std.testing.expectEqual(@as(usize, 0), written);

    ev.updateBeforeRender();

    const tbv_ptr = ev.getTextBufferView();

    var opt_buffer = try opt_buffer_mod.OptimizedBuffer.init(
        std.testing.allocator,
        80,
        24,
        .{ .pool = pool, .width_method = .wcwidth },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(tbv_ptr, 0, 0);

    const epsilon: f32 = 0.01;

    const cell_0 = opt_buffer.get(0, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'E'), cell_0.char);

    const cell_6 = opt_buffer.get(6, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 's'), cell_6.char);

    const cell_15 = opt_buffer.get(15, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, ' '), cell_15.char);

    const fg_0 = opt_buffer.buffer.fg[0];
    try std.testing.expect(@abs(ansi.redF(fg_0) - ansi.redF(fg_gray)) < epsilon);
    try std.testing.expect(@abs(ansi.greenF(fg_0) - ansi.greenF(fg_gray)) < epsilon);
    try std.testing.expect(@abs(ansi.blueF(fg_0) - ansi.blueF(fg_gray)) < epsilon);

    const fg_6 = opt_buffer.buffer.fg[6];
    try std.testing.expect(@abs(ansi.redF(fg_6) - ansi.redF(fg_blue)) < epsilon);
    try std.testing.expect(@abs(ansi.greenF(fg_6) - ansi.greenF(fg_blue)) < epsilon);
    try std.testing.expect(@abs(ansi.blueF(fg_6) - ansi.blueF(fg_blue)) < epsilon);

    const fg_15 = opt_buffer.buffer.fg[15];
    try std.testing.expect(@abs(ansi.redF(fg_15) - ansi.redF(fg_gray)) < epsilon);
    try std.testing.expect(@abs(ansi.greenF(fg_15) - ansi.greenF(fg_gray)) < epsilon);
    try std.testing.expect(@abs(ansi.blueF(fg_15) - ansi.blueF(fg_gray)) < epsilon);
}

test "EditorView - getNextWordBoundary returns VisualCursor" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.insertText("Hello World Test");
    try eb.setCursor(0, 0);

    const next_vcursor = ev.getNextWordBoundary();
    try std.testing.expectEqual(@as(u32, 0), next_vcursor.logical_row);
    try std.testing.expectEqual(@as(u32, 6), next_vcursor.logical_col);
    try std.testing.expectEqual(@as(u32, 0), next_vcursor.visual_row);
    try std.testing.expectEqual(@as(u32, 6), next_vcursor.visual_col);
}

test "EditorView - getPrevWordBoundary returns VisualCursor" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.insertText("Hello World Test");
    try eb.setCursor(0, 12);

    const prev_vcursor = ev.getPrevWordBoundary();
    try std.testing.expectEqual(@as(u32, 0), prev_vcursor.logical_row);
    try std.testing.expectEqual(@as(u32, 6), prev_vcursor.logical_col);
    try std.testing.expectEqual(@as(u32, 0), prev_vcursor.visual_row);
    try std.testing.expectEqual(@as(u32, 6), prev_vcursor.visual_col);
}

test "EditorView - word boundary with wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    ev.setWrapMode(.char);

    try eb.setText("This is a very long line that will wrap and has multiple words");
    try eb.setCursor(0, 0);

    const next_vcursor = ev.getNextWordBoundary();
    try std.testing.expectEqual(@as(u32, 0), next_vcursor.logical_row);
    try std.testing.expectEqual(@as(u32, 5), next_vcursor.logical_col);

    try std.testing.expect(next_vcursor.visual_col <= 20);
}

test "EditorView - word boundary across lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.insertText("Hello\nWorld");
    try eb.setCursor(0, 5);

    const next_vcursor = ev.getNextWordBoundary();
    try std.testing.expectEqual(@as(u32, 1), next_vcursor.logical_row);
    try std.testing.expectEqual(@as(u32, 0), next_vcursor.logical_col);
    try std.testing.expectEqual(@as(u32, 1), next_vcursor.visual_row);
    try std.testing.expectEqual(@as(u32, 0), next_vcursor.visual_col);
}

test "EditorView - word boundary prev across lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.insertText("Hello\nWorld");
    try eb.setCursor(1, 0);

    const prev_vcursor = ev.getPrevWordBoundary();
    try std.testing.expectEqual(@as(u32, 0), prev_vcursor.logical_row);
    try std.testing.expectEqual(@as(u32, 5), prev_vcursor.logical_col);
    try std.testing.expectEqual(@as(u32, 0), prev_vcursor.visual_row);
    try std.testing.expectEqual(@as(u32, 5), prev_vcursor.visual_col);
}

test "EditorView - word boundary with punctuation" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.insertText("self-contained multi-word");
    try eb.setCursor(0, 0);

    const next_vcursor = ev.getNextWordBoundary();
    try std.testing.expectEqual(@as(u32, 0), next_vcursor.logical_row);
    try std.testing.expectEqual(@as(u32, 5), next_vcursor.logical_col);
}

test "EditorView - word boundary at end of buffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.insertText("Hello World");
    try eb.setCursor(0, 11);

    const next_vcursor = ev.getNextWordBoundary();
    try std.testing.expectEqual(@as(u32, 0), next_vcursor.logical_row);
    try std.testing.expectEqual(@as(u32, 11), next_vcursor.logical_col);
}

test "EditorView - word boundary at start of buffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.insertText("Hello World");
    try eb.setCursor(0, 0);

    const prev_vcursor = ev.getPrevWordBoundary();
    try std.testing.expectEqual(@as(u32, 0), prev_vcursor.logical_row);
    try std.testing.expectEqual(@as(u32, 0), prev_vcursor.logical_col);
}

test "EditorView - horizontal scroll: combined vertical and horizontal scrolling" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    const line0 = "AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFFFGGGGGGGGGGHHHHHHHHHHIIIIIIIIIIJJJJJJJJJJ";
    const repeated_line = "\nAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFGGGGGGGGGGHHHHHHHHHHIIIIIIIIIIJJJJJJJJJJ";

    var buffer: [3000]u8 = undefined;
    var fbs = std.io.fixedBufferStream(&buffer);
    const writer = fbs.writer();
    writer.writeAll(line0) catch unreachable;
    var i: u32 = 1;
    while (i < 20) : (i += 1) {
        writer.writeAll(repeated_line) catch unreachable;
    }

    const text = fbs.getWritten();
    try eb.setText(text);

    try eb.setCursor(15, 60);
    _ = ev.getVirtualLines();

    const vp = ev.getViewport().?;
    const cursor = ev.getPrimaryCursor();

    try std.testing.expect(vp.y > 0);
    try std.testing.expect(vp.x > 0);

    try std.testing.expect(cursor.row >= vp.y);
    try std.testing.expect(cursor.row < vp.y + vp.height);
    try std.testing.expect(cursor.col >= vp.x);
    try std.testing.expect(cursor.col < vp.x + vp.width);
}

test "EditorView - deleteSelectedText single line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb_inst = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb_inst.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb_inst, 80, 24);
    defer ev.deinit();

    try eb_inst.setText("Hello World");

    ev.text_buffer_view.setSelection(0, 5, null, null);

    const sel_before = ev.text_buffer_view.getSelection();
    try std.testing.expect(sel_before != null);
    try std.testing.expectEqual(@as(u32, 0), sel_before.?.start);
    try std.testing.expectEqual(@as(u32, 5), sel_before.?.end);

    try ev.deleteSelectedText();

    var out_buffer: [100]u8 = undefined;
    const written = ev.getText(&out_buffer);
    try std.testing.expectEqualStrings(" World", out_buffer[0..written]);

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);
    try std.testing.expectEqual(@as(u32, 0), cursor.col);

    const sel_after = ev.text_buffer_view.getSelection();
    try std.testing.expect(sel_after == null);
}

test "EditorView - deleteSelectedText multi-line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb_inst = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb_inst.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb_inst, 80, 24);
    defer ev.deinit();

    try eb_inst.setText("Line 1\nLine 2\nLine 3");

    ev.text_buffer_view.setSelection(2, 15, null, null);

    try ev.deleteSelectedText();

    var out_buffer: [100]u8 = undefined;
    const written = ev.getText(&out_buffer);
    try std.testing.expectEqualStrings("Liine 3", out_buffer[0..written]);

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);
    try std.testing.expectEqual(@as(u32, 2), cursor.col);
}

test "EditorView - deleteSelectedText with wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb_inst = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb_inst.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb_inst, 20, 10);
    defer ev.deinit();

    ev.setWrapMode(.char);

    try eb_inst.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ");

    const vline_count = ev.getTotalVirtualLineCount();
    try std.testing.expect(vline_count >= 2);

    ev.text_buffer_view.setSelection(5, 15, null, null);

    try ev.deleteSelectedText();

    var out_buffer: [100]u8 = undefined;
    const written = ev.getText(&out_buffer);
    try std.testing.expectEqualStrings("ABCDEPQRSTUVWXYZ", out_buffer[0..written]);

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);
    try std.testing.expectEqual(@as(u32, 5), cursor.col);
}

test "EditorView - deleteSelectedText with viewport scrolled" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb_inst = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb_inst.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb_inst, 40, 5);
    defer ev.deinit();

    try eb_inst.setText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10\nLine 11\nLine 12\nLine 13\nLine 14\nLine 15\nLine 16\nLine 17\nLine 18\nLine 19");

    try eb_inst.gotoLine(10);
    _ = ev.getVirtualLines();

    var vp = ev.getViewport().?;
    try std.testing.expect(vp.y > 0);

    ev.text_buffer_view.setSelection(50, 70, null, null);

    try ev.deleteSelectedText();

    _ = ev.getVirtualLines();
    vp = ev.getViewport().?;
    const cursor = ev.getPrimaryCursor();

    try std.testing.expect(cursor.row >= vp.y);
    try std.testing.expect(cursor.row < vp.y + vp.height);
}

test "EditorView - deleteSelectedText with no selection" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb_inst = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb_inst.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb_inst, 80, 24);
    defer ev.deinit();

    try eb_inst.setText("Hello World");

    try ev.deleteSelectedText();

    var out_buffer: [100]u8 = undefined;
    const written = ev.getText(&out_buffer);
    try std.testing.expectEqualStrings("Hello World", out_buffer[0..written]);
}

test "EditorView - deleteSelectedText entire line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb_inst = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb_inst.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb_inst, 80, 24);
    defer ev.deinit();

    try eb_inst.setText("First\nSecond\nThird\n");

    ev.text_buffer_view.setSelection(5, 13, null, null);

    try ev.deleteSelectedText();

    var out_buffer: [100]u8 = undefined;
    const written = ev.getText(&out_buffer);
    try std.testing.expectEqualStrings("FirstThird\n", out_buffer[0..written]);

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);
    try std.testing.expectEqual(@as(u32, 5), cursor.col);
}

test "EditorView - deleteSelectedText respects selection with empty lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb_inst = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb_inst.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb_inst, 40, 10);
    defer ev.deinit();

    ev.setWrapMode(.word);

    try eb_inst.setText("AAAA\n\nBBBB\n\nCCCC");

    try eb_inst.setCursor(2, 0);

    _ = ev.text_buffer_view.setLocalSelection(0, 2, 4, 2, null, null);

    const sel = ev.text_buffer_view.getSelection();
    try std.testing.expect(sel != null);

    try std.testing.expectEqual(@as(u32, 6), sel.?.start);
    try std.testing.expectEqual(@as(u32, 10), sel.?.end);

    var selected_buffer: [100]u8 = undefined;
    const selected_len = ev.text_buffer_view.getSelectedTextIntoBuffer(&selected_buffer);
    const selected_text = selected_buffer[0..selected_len];
    try std.testing.expectEqualStrings("BBBB", selected_text);

    try ev.deleteSelectedText();

    var out_buffer: [100]u8 = undefined;
    const written = ev.getText(&out_buffer);
    try std.testing.expectEqualStrings("AAAA\n\n\n\nCCCC", out_buffer[0..written]);

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.row);
    try std.testing.expectEqual(@as(u32, 0), cursor.col);
}

test "EditorView - word wrapping with space insertion maintains cursor sync" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 15, 10);
    defer ev.deinit();

    ev.setWrapMode(.word);
    ev.setViewport(.{ .x = 0, .y = 0, .width = 15, .height = 10 }, true);

    try eb.setText("AAAAAAAAAAAAAAAAAAA");
    try eb.setCursor(0, 7);
    try eb.insertText(" ");

    const logical_cursor_after_space = eb.getPrimaryCursor();
    const vcursor_after_space = ev.getVisualCursor();

    try std.testing.expectEqual(@as(u32, 0), logical_cursor_after_space.row);
    try std.testing.expectEqual(@as(u32, 8), logical_cursor_after_space.col);

    try std.testing.expectEqual(@as(u32, 0), vcursor_after_space.logical_row);
    try std.testing.expectEqual(@as(u32, 1), vcursor_after_space.visual_row);

    try eb.backspace();

    const logical_cursor_after_backspace = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), logical_cursor_after_backspace.row);
    try std.testing.expectEqual(@as(u32, 7), logical_cursor_after_backspace.col);
}

test "EditorView - getVisualCursor always returns on empty buffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    const vcursor = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 0), vcursor.visual_row);
    try std.testing.expectEqual(@as(u32, 0), vcursor.visual_col);
    try std.testing.expectEqual(@as(u32, 0), vcursor.logical_row);
    try std.testing.expectEqual(@as(u32, 0), vcursor.logical_col);
}

test "EditorView - logicalToVisualCursor clamps row beyond last line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    try eb.setText("Line 1\nLine 2\nLine 3");

    const vcursor = ev.logicalToVisualCursor(100, 0);
    try std.testing.expectEqual(@as(u32, 2), vcursor.logical_row);
    try std.testing.expectEqual(@as(u32, 0), vcursor.logical_col);
}

test "EditorView - logicalToVisualCursor clamps col beyond line width" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    try eb.setText("Hello");

    const vcursor = ev.logicalToVisualCursor(0, 100);
    try std.testing.expectEqual(@as(u32, 0), vcursor.logical_row);
    try std.testing.expectEqual(@as(u32, 5), vcursor.logical_col);
    try std.testing.expectEqual(@as(u32, 5), vcursor.visual_col);
}

test "EditorView - placeholder shows when empty" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    const text = "Enter text here...";
    const gray_color = ansi.rgbaFromFloats(0.4, 0.4, 0.4, 1.0);
    const chunks = [_]text_buffer.StyledChunk{.{
        .text_ptr = text.ptr,
        .text_len = text.len,
        .fg_ptr = @ptrCast(&gray_color),
        .bg_ptr = null,
        .attributes = 0,
    }};
    try ev.setPlaceholderStyledText(&chunks);

    var out_buffer: [100]u8 = undefined;
    const text_len = eb.getText(&out_buffer);
    try std.testing.expectEqual(@as(usize, 0), text_len);

    try std.testing.expect(ev.placeholder_buffer != null);
    const placeholder = ev.placeholder_buffer.?;
    try std.testing.expectEqual(@as(u32, 18), placeholder.getLength());
}

test "EditorView - placeholder cleared when set to empty" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    const text = "Placeholder";
    const gray_color = ansi.rgbaFromFloats(0.4, 0.4, 0.4, 1.0);
    const chunks = [_]text_buffer.StyledChunk{.{
        .text_ptr = text.ptr,
        .text_len = text.len,
        .fg_ptr = @ptrCast(&gray_color),
        .bg_ptr = null,
        .attributes = 0,
    }};
    try ev.setPlaceholderStyledText(&chunks);

    try std.testing.expect(ev.placeholder_buffer != null);

    const empty_chunks: [0]text_buffer.StyledChunk = .{};
    try ev.setPlaceholderStyledText(&empty_chunks);

    try std.testing.expect(ev.placeholder_buffer == null);
}

test "EditorView - placeholder with styled text" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    const text1 = "Hello ";
    const text2 = "World";
    const red_color = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const blue_color = ansi.rgbaFromFloats(0.0, 0.0, 1.0, 1.0);

    const chunks = [_]text_buffer.StyledChunk{
        .{
            .text_ptr = text1.ptr,
            .text_len = text1.len,
            .fg_ptr = @ptrCast(&red_color),
            .bg_ptr = null,
            .attributes = 0,
        },
        .{
            .text_ptr = text2.ptr,
            .text_len = text2.len,
            .fg_ptr = @ptrCast(&blue_color),
            .bg_ptr = null,
            .attributes = 0,
        },
    };

    try ev.setPlaceholderStyledText(&chunks);

    try std.testing.expect(ev.placeholder_buffer != null);
    const placeholder = ev.placeholder_buffer.?;
    try std.testing.expectEqual(@as(u32, 11), placeholder.getLength());
}

test "EditorView - placeholder renders to buffer when empty" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    const placeholder_text = "Type something...";
    const gray_color = ansi.rgbaFromFloats(0.5, 0.5, 0.5, 1.0);
    const placeholder_chunks = [_]text_buffer.StyledChunk{.{
        .text_ptr = placeholder_text.ptr,
        .text_len = placeholder_text.len,
        .fg_ptr = @ptrCast(&gray_color),
        .bg_ptr = null,
        .attributes = 0,
    }};
    try ev.setPlaceholderStyledText(&placeholder_chunks);

    try std.testing.expect(ev.placeholder_buffer != null);
    try std.testing.expect(ev.placeholder_active);

    var opt_buffer = try opt_buffer_mod.OptimizedBuffer.init(
        std.testing.allocator,
        80,
        10,
        .{ .pool = pool, .width_method = .wcwidth },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawEditorView(ev, 0, 0);

    var out_buffer: [1000]u8 = undefined;
    const written = try opt_buffer.writeResolvedChars(&out_buffer, false);
    const result = out_buffer[0..written];

    try std.testing.expect(std.mem.startsWith(u8, result, "Type something..."));

    try eb.insertText("Hello");

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawEditorView(ev, 0, 0);
    try std.testing.expect(!ev.placeholder_active);

    const written2 = try opt_buffer.writeResolvedChars(&out_buffer, false);
    const result2 = out_buffer[0..written2];

    try std.testing.expect(std.mem.startsWith(u8, result2, "Hello"));
    try std.testing.expect(!std.mem.startsWith(u8, result2, "Type something..."));
}

test "EditorView - placeholder shrink clears tail and preserves background" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    const long_text = "Ask anything... \"Fix a TODO in the codebase\"";
    const short_text = "Run a command... \"pwd\"";
    const fg = ansi.rgbaFromFloats(0.6, 0.6, 0.6, 1.0);
    const panel_bg = ansi.rgbaFromFloats(0.14, 0.14, 0.16, 1.0);

    const long_chunks = [_]text_buffer.StyledChunk{.{
        .text_ptr = long_text.ptr,
        .text_len = long_text.len,
        .fg_ptr = @ptrCast(&fg),
        .bg_ptr = null,
        .attributes = 0,
    }};
    const short_chunks = [_]text_buffer.StyledChunk{.{
        .text_ptr = short_text.ptr,
        .text_len = short_text.len,
        .fg_ptr = @ptrCast(&fg),
        .bg_ptr = null,
        .attributes = 0,
    }};

    var opt_buffer = try opt_buffer_mod.OptimizedBuffer.init(
        std.testing.allocator,
        120,
        10,
        .{ .pool = pool, .width_method = .wcwidth },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);

    var x: u32 = 0;
    while (x < 80) : (x += 1) {
        opt_buffer.set(x, 0, .{ .char = 32, .fg = fg, .bg = panel_bg, .attributes = 0 });
    }

    try ev.setPlaceholderStyledText(&long_chunks);
    opt_buffer.drawEditorView(ev, 0, 0);

    x = 0;
    while (x < 80) : (x += 1) {
        opt_buffer.set(x, 0, .{ .char = 32, .fg = fg, .bg = panel_bg, .attributes = 0 });
    }

    try ev.setPlaceholderStyledText(&short_chunks);
    opt_buffer.drawEditorView(ev, 0, 0);

    var out_buffer: [1600]u8 = undefined;
    const written = try opt_buffer.writeResolvedChars(&out_buffer, false);
    const line = out_buffer[0..written];

    try std.testing.expect(std.mem.indexOf(u8, line, short_text) != null);
    try std.testing.expect(std.mem.indexOf(u8, line, "roken tests") == null);
    try std.testing.expect(std.mem.indexOf(u8, line, "TODO in the codebase") == null);

    const tail = opt_buffer.get(35, 0) orelse return error.TestUnexpectedResult;
    try std.testing.expectEqual(@as(u32, 32), tail.char);
    try std.testing.expectEqual(panel_bg, tail.bg);
}

test "EditorView - translucent default background fills viewport without double blending" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 6, 2);
    defer ev.deinit();

    try eb.setText("abc");
    eb.tb.setDefaultBg(ansi.rgbaFromFloats(1.0, 0.0, 0.0, 0.5));

    var opt_buffer = try opt_buffer_mod.OptimizedBuffer.init(
        std.testing.allocator,
        6,
        2,
        .{ .pool = pool, .width_method = .wcwidth },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawEditorView(ev, 0, 0);

    const text_cell = opt_buffer.get(0, 0).?;
    const trailing_cell = opt_buffer.get(3, 0).?;
    const blank_row_cell = opt_buffer.get(0, 1).?;

    try std.testing.expectEqual(@as(u32, 'a'), text_cell.char);
    try std.testing.expectEqual(@as(u32, 32), trailing_cell.char);
    try std.testing.expectEqual(@as(u32, 32), blank_row_cell.char);
    try std.testing.expectEqual(text_cell.bg, trailing_cell.bg);
    try std.testing.expectEqual(trailing_cell.bg, blank_row_cell.bg);
}

test "EditorView - placeholder uses original default background fill" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 6, 2);
    defer ev.deinit();

    const placeholder_text = "hint";
    const placeholder_fg = ansi.rgbaFromFloats(0.5, 0.5, 0.5, 1.0);
    const placeholder_chunks = [_]text_buffer.StyledChunk{.{
        .text_ptr = placeholder_text.ptr,
        .text_len = placeholder_text.len,
        .fg_ptr = @ptrCast(&placeholder_fg),
        .bg_ptr = null,
        .attributes = 0,
    }};

    eb.tb.setDefaultBg(ansi.indexedColor(254, 228, 228, 228));
    try ev.setPlaceholderStyledText(&placeholder_chunks);

    var opt_buffer = try opt_buffer_mod.OptimizedBuffer.init(
        std.testing.allocator,
        6,
        2,
        .{ .pool = pool, .width_method = .wcwidth },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawEditorView(ev, 0, 0);

    const text_cell = opt_buffer.get(0, 0).?;
    const trailing_cell = opt_buffer.get(4, 0).?;
    const blank_row_cell = opt_buffer.get(0, 1).?;

    try std.testing.expectEqual(@as(u32, 'h'), text_cell.char);
    try std.testing.expectEqual(@as(u32, 32), trailing_cell.char);
    try std.testing.expectEqual(@as(u32, 32), blank_row_cell.char);
    try std.testing.expectEqual(ansi.ColorIntent.indexed, ansi.intent(text_cell.bg));
    try std.testing.expectEqual(ansi.ColorIntent.indexed, ansi.intent(trailing_cell.bg));
    try std.testing.expectEqual(ansi.ColorIntent.indexed, ansi.intent(blank_row_cell.bg));
    try std.testing.expectEqual(@as(u8, 254), ansi.slot(text_cell.bg));
    try std.testing.expectEqual(@as(u8, 255), ansi.alpha(text_cell.bg));
    try std.testing.expectEqual(@as(u8, 255), ansi.alpha(blank_row_cell.bg));
}

test "EditorView - tab indicator set and get" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    try std.testing.expect(ev.getTabIndicator() == null);
    try std.testing.expect(ev.getTabIndicatorColor() == null);

    ev.setTabIndicator('·');
    ev.setTabIndicatorColor(ansi.rgbaFromFloats(0.5, 0.5, 0.5, 1.0));

    try std.testing.expectEqual(@as(u32, '·'), ev.getTabIndicator().?);
    try std.testing.expectEqual(@as(u8, 128), ansi.red(ev.getTabIndicatorColor().?));
}

test "EditorView - tab indicator renders in buffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    eb.tb.setTabWidth(4);
    try eb.insertText("A\tB");

    ev.setTabIndicator('→');
    ev.setTabIndicatorColor(ansi.rgbaFromFloats(0.3, 0.3, 0.3, 1.0));

    var opt_buffer = try opt_buffer_mod.OptimizedBuffer.init(
        std.testing.allocator,
        20,
        10,
        .{ .pool = pool, .width_method = .wcwidth },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawEditorView(ev, 0, 0);

    const cell_0 = opt_buffer.get(0, 0);
    try std.testing.expect(cell_0 != null);
    try std.testing.expectEqual(@as(u32, 'A'), cell_0.?.char);

    const cell_1 = opt_buffer.get(1, 0);
    try std.testing.expect(cell_1 != null);
    try std.testing.expectEqual(@as(u32, '→'), cell_1.?.char);
    try std.testing.expectEqual(@as(u8, 77), ansi.red(cell_1.?.fg));

    const cell_2 = opt_buffer.get(2, 0);
    try std.testing.expect(cell_2 != null);
    try std.testing.expectEqual(@as(u32, 32), cell_2.?.char);

    const cell_3 = opt_buffer.get(3, 0);
    try std.testing.expect(cell_3 != null);
    try std.testing.expectEqual(@as(u32, 32), cell_3.?.char);

    const cell_4 = opt_buffer.get(4, 0);
    try std.testing.expect(cell_4 != null);
    try std.testing.expectEqual(@as(u32, 32), cell_4.?.char);

    const cell_5 = opt_buffer.get(5, 0);
    try std.testing.expect(cell_5 != null);
    try std.testing.expectEqual(@as(u32, 'B'), cell_5.?.char);
}

test "EditorView - word wrapping during editing: typing with incremental wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 17, 10);
    defer ev.deinit();

    ev.setWrapMode(.word);

    // Type "Hello world ddddddddd" character by character
    // Width=17
    // "Hello world " = 12 chars
    // "Hello world ddddd" = 17 chars (fits exactly on one line)
    // "Hello world dddddd" = 18 chars (should wrap after "world ", moving ALL d's to next line)
    //
    // The key issue: word wrapping should keep the break point AFTER "world " consistently
    // When "Hello world dddddd" (18 chars) wraps, it should become:
    //   Line 1: "Hello world " (12 chars)
    //   Line 2: "dddddd" (6 chars)
    // NOT:
    //   Line 1: "Hello world ddddd" (17 chars)
    //   Line 2: "d" (1 char)
    const text_to_type = "Hello world ddddddddd";

    for (text_to_type, 0..) |char, i| {
        var char_buf: [1]u8 = .{char};
        try eb.insertText(&char_buf);
        _ = ev.getVirtualLines();

        const vline_count = ev.getTotalVirtualLineCount();
        const cursor = ev.getPrimaryCursor();

        // "Hello world " = 12 chars (i=11 completes this)
        // "Hello world d" through "Hello world ddddd" = 13-17 chars (i=12 to i=16)
        // "Hello world dddddd" = 18 chars (i=17) - should wrap AFTER "world "
        const current_len = i + 1;
        if (current_len <= 17) {
            // Should fit on 1 line
            try std.testing.expectEqual(@as(u32, 1), vline_count);
        } else {
            // Should wrap AFTER "world ", moving ALL d's to line 2
            try std.testing.expectEqual(@as(u32, 2), vline_count);

            // Cursor should still be on row 0 (single logical line that wrapped)
            try std.testing.expectEqual(@as(u32, 0), cursor.row);
        }
    }

    // Now we have "Hello world ddddddddd" (21 chars) with word wrapping at width=17
    // Should be: "Hello world " (12 chars) on vline 1, "ddddddddd" (9 chars) on vline 2
    var vline_count = ev.getTotalVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 2), vline_count);

    // Backspace to remove d's until only 2 remain: "Hello world dd"
    // We need to delete 7 d's (from 9 d's to 2 d's)
    var i: usize = 0;
    while (i < 7) : (i += 1) {
        try eb.backspace();
        _ = ev.getVirtualLines();
    }

    // After removing 7 d's, we should have "Hello world dd" (14 chars)
    // This should fit on one line at width=17
    vline_count = ev.getTotalVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 1), vline_count);

    var cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);
    try std.testing.expectEqual(@as(u32, 14), cursor.col);

    // Now type more d's again - should wrap correctly after "world "
    // Starting with "Hello world dd" (14 chars)
    const more_ds = "ddddddd";
    for (more_ds, 0..) |char, j| {
        var char_buf: [1]u8 = .{char};
        try eb.insertText(&char_buf);
        _ = ev.getVirtualLines();

        vline_count = ev.getTotalVirtualLineCount();

        // After each d:
        // j=0: "Hello world ddd" (15) - fits on 1 line
        // j=1: "Hello world dddd" (16) - fits on 1 line
        // j=2: "Hello world ddddd" (17) - fits exactly on 1 line
        // j=3: "Hello world dddddd" (18) - should wrap AFTER "world ", moving ALL d's to line 2
        // j=4: "Hello world ddddddd" (19) - still wrapped same way
        // j=5: "Hello world dddddddd" (20) - still wrapped same way
        // j=6: "Hello world ddddddddd" (21) - still wrapped same way
        const current_len = 14 + j + 1;
        if (current_len <= 17) {
            // Should fit on 1 line
            try std.testing.expectEqual(@as(u32, 1), vline_count);
        } else {
            // Should wrap AFTER "world ", moving ALL d's to line 2
            // This is the key: the wrap point should stay at "world " boundary
            try std.testing.expectEqual(@as(u32, 2), vline_count);

            // CRITICAL: Check that first virtual line is "Hello world " (12 chars)
            // and second virtual line has all the d's
            const vlines = ev.getVirtualLines();
            try std.testing.expect(vlines.len == 2);

            // First vline should be "Hello world " with width 12
            try std.testing.expectEqual(@as(u32, 12), vlines[0].width_cols);

            // Second vline should have all the d's (the original "dd" plus newly typed d's)
            const expected_d_count: u32 = @as(u32, 2) + @as(u32, @intCast(j + 1)); // dd + newly typed d's
            try std.testing.expectEqual(expected_d_count, vlines[1].width_cols);
        }
    }

    // After adding 7 more d's, we have "Hello world ddddddddd" (21 chars) again
    // Should wrap after "world " into 2 lines
    vline_count = ev.getTotalVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 2), vline_count);

    cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);

    // Verify the text is correct
    var out_buffer: [100]u8 = undefined;
    const written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("Hello world ddddddddd", out_buffer[0..written]);
}

test "EditorView - cursor movement with emoji skin tone modifier wcwidth" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    // "👋🏿" is a waving hand emoji with dark skin tone modifier
    // In wcwidth mode (tmux-style), each codepoint has width 2, total = 4 columns
    // IMPORTANT: In wcwidth mode, each codepoint is treated as a separate char for cursor movement
    try eb.setText("👋🏿");

    // Start at position 0 (before the first codepoint)
    try eb.setCursor(0, 0);
    var cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.col);

    // Move right once - should move past the FIRST codepoint (2 columns)
    // In wcwidth mode, each codepoint is a separate char, so this moves to col 2
    eb.moveRight();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.col);

    // Move right again - should move past the SECOND codepoint (2 more columns)
    eb.moveRight();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 4), cursor.col);

    // Move left once - should move back to col 2 (before second codepoint)
    eb.moveLeft();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.col);

    // Move left again - should move back to the beginning
    eb.moveLeft();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.col);
}

test "EditorView - cursor movement with emoji skin tone modifier unicode" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .unicode, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    // "👋🏿" is a waving hand emoji with dark skin tone modifier
    // In unicode mode (modern terminals), skin tone is 0-width, total = 2 columns
    try eb.setText("👋🏿");

    // Start at position 0 (before the grapheme cluster)
    try eb.setCursor(0, 0);
    var cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.col);

    // Move right once - should move past the entire grapheme cluster (2 columns in unicode)
    eb.moveRight();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.col);

    // Move left once - should move back to the beginning
    eb.moveLeft();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.col);
}

test "EditorView - backspace emoji with skin tone modifier wcwidth" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    // "👋🏿" is a waving hand emoji with dark skin tone modifier
    // In wcwidth mode, this renders as 4 columns (2+2)
    // In wcwidth mode, each codepoint is treated as a separate char
    try eb.setText("👋🏿");

    // Move cursor to col 2 (after first codepoint)
    eb.moveRight();
    var cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.col);

    // Move cursor to col 4 (after second codepoint)
    eb.moveRight();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 4), cursor.col);

    // Get text before backspace to verify it contains the emoji
    var buffer_before: [100]u8 = undefined;
    const len_before = eb.getText(&buffer_before);
    try std.testing.expectEqualStrings("👋🏿", buffer_before[0..len_before]);

    // First backspace should delete just the skin tone modifier (second codepoint)
    try eb.backspace();

    // Cursor should now be at position 2 (after the first codepoint)
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.col);

    // Text buffer should contain just the hand emoji without skin tone
    var buffer_middle: [100]u8 = undefined;
    const len_middle = eb.getText(&buffer_middle);
    try std.testing.expectEqualStrings("👋", buffer_middle[0..len_middle]);

    // Second backspace should delete the hand emoji (first codepoint)
    try eb.backspace();

    // Cursor should now be at position 0
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.col);

    // Text buffer should be empty
    var buffer_after: [100]u8 = undefined;
    const len_after = eb.getText(&buffer_after);
    try std.testing.expectEqual(@as(usize, 0), len_after);
    try std.testing.expectEqualStrings("", buffer_after[0..len_after]);
}

test "EditorView - backspace emoji with skin tone modifier unicode" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .unicode, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    // "👋🏿" is a waving hand emoji with dark skin tone modifier
    // In unicode mode, this renders as 2 columns (modifier is 0-width)
    try eb.setText("👋🏿");

    // Move cursor to AFTER the grapheme cluster (2 columns total in unicode mode)
    eb.moveRight();
    var cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.col);

    // Get text before backspace to verify it contains the emoji
    var buffer_before: [100]u8 = undefined;
    const len_before = eb.getText(&buffer_before);
    try std.testing.expectEqualStrings("👋🏿", buffer_before[0..len_before]);

    // Backspace should delete the entire grapheme cluster (both codepoints)
    try eb.backspace();

    // Cursor should now be at position 0
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.col);

    // Text buffer should be empty
    var buffer_after: [100]u8 = undefined;
    const len_after = eb.getText(&buffer_after);
    try std.testing.expectEqual(@as(usize, 0), len_after);
    try std.testing.expectEqualStrings("", buffer_after[0..len_after]);
}

test "EditorView - mouse selection doesn't scroll when focus is within viewport" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 40, 10);
    defer ev.deinit();

    // Create 50 lines of text
    var i: u32 = 0;
    while (i < 50) : (i += 1) {
        if (i > 0) try eb.insertText("\n");
        try eb.insertText("Line ");
        var num_buf: [10]u8 = undefined;
        const num_str = try std.fmt.bufPrint(&num_buf, "{d}", .{i});
        try eb.insertText(num_str);
    }

    // Reset cursor to top
    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();

    const vp_initial = ev.getViewport().?;
    try std.testing.expectEqual(@as(u32, 0), vp_initial.y);

    // Simulate selection within the viewport (lines 0-5, all visible)
    _ = ev.setLocalSelection(0, 0, 5, 5, null, null, true);
    _ = ev.getVirtualLines();

    const vp_after = ev.getViewport().?;

    // Viewport should not have changed
    try std.testing.expectEqual(vp_initial.y, vp_after.y);
    try std.testing.expectEqual(vp_initial.x, vp_after.x);
}

test "EditorView - mouse selection focus outside buffer bounds clamps correctly" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 40, 10);
    defer ev.deinit();

    // Create just 10 lines
    var i: u32 = 0;
    while (i < 10) : (i += 1) {
        if (i > 0) try eb.insertText("\n");
        try eb.insertText("Line ");
        var num_buf: [10]u8 = undefined;
        const num_str = try std.fmt.bufPrint(&num_buf, "{d}", .{i});
        try eb.insertText(num_str);
    }

    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();

    // Try to select way beyond buffer (to line 100)
    _ = ev.setLocalSelection(0, 0, 5, 100, null, null, true);
    _ = ev.getVirtualLines();

    const cursor = ev.getPrimaryCursor();

    // Cursor should be clamped to last line (line 9)
    try std.testing.expectEqual(@as(u32, 9), cursor.row);
}
