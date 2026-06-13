const std = @import("std");
const edit_buffer = @import("../edit-buffer.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");

const EditBuffer = edit_buffer.EditBuffer;

test "EditBuffer - basic undo/redo with insertText" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello");

    try eb.insertText(" World");
    var out_buffer: [100]u8 = undefined;
    var written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("Hello World", out_buffer[0..written]);

    const meta = try eb.undo();
    try std.testing.expect(std.mem.startsWith(u8, meta, "cursor:"));
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("Hello", out_buffer[0..written]);

    const meta2 = try eb.redo();
    try std.testing.expect(std.mem.startsWith(u8, meta2, "cursor:"));
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("Hello World", out_buffer[0..written]);
}

test "EditBuffer - undo and redo restore cursor for mid-line edits" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.setText("hello world");
    try eb.setCursor(0, 8);

    try eb.insertText("X");
    var cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);
    try std.testing.expectEqual(@as(u32, 9), cursor.col);

    _ = try eb.undo();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);
    try std.testing.expectEqual(@as(u32, 8), cursor.col);

    _ = try eb.redo();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);
    try std.testing.expectEqual(@as(u32, 9), cursor.col);
}

test "EditBuffer - canUndo/canRedo" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try std.testing.expect(!eb.canUndo());
    try std.testing.expect(!eb.canRedo());

    try eb.insertText("Test");

    try std.testing.expect(eb.canUndo());
    try std.testing.expect(!eb.canRedo());

    _ = try eb.undo();

    try std.testing.expect(!eb.canUndo());
    try std.testing.expect(eb.canRedo());

    _ = try eb.redo();

    try std.testing.expect(eb.canUndo());
    try std.testing.expect(!eb.canRedo());
}

test "EditBuffer - undo/redo with deleteRange" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello World");

    try eb.deleteRange(.{ .row = 0, .col = 5 }, .{ .row = 0, .col = 11 });
    var out_buffer: [100]u8 = undefined;
    var written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("Hello", out_buffer[0..written]);

    _ = try eb.undo();
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("Hello World", out_buffer[0..written]);

    _ = try eb.redo();
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("Hello", out_buffer[0..written]);
}

test "EditBuffer - undo/redo with backspace" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello");

    try eb.backspace();
    var out_buffer: [100]u8 = undefined;
    var written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("Hell", out_buffer[0..written]);

    _ = try eb.undo();
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("Hello", out_buffer[0..written]);
}

test "EditBuffer - undo/redo with deleteForward" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello");
    try eb.setCursor(0, 0);

    try eb.deleteForward();
    var out_buffer: [100]u8 = undefined;
    var written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("ello", out_buffer[0..written]);

    _ = try eb.undo();
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("Hello", out_buffer[0..written]);
}

test "EditBuffer - cursor position after undo" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Line 1\nLine 2");
    var cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 1), cursor.row);
    try std.testing.expectEqual(@as(u32, 6), cursor.col);

    try eb.insertText("\nLine 3");
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.row);

    // Undo - cursor should be clamped to valid position
    _ = try eb.undo();
    cursor = eb.getPrimaryCursor();
    // Cursor should be clamped to end of line 1
    try std.testing.expectEqual(@as(u32, 1), cursor.row);
    try std.testing.expectEqual(@as(u32, 6), cursor.col);
}

test "EditBuffer - lineCount after undo/redo" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Line 1");
    try std.testing.expectEqual(@as(u32, 1), eb.getTextBuffer().lineCount());

    try eb.insertText("\nLine 2\nLine 3");
    try std.testing.expectEqual(@as(u32, 3), eb.getTextBuffer().lineCount());

    _ = try eb.undo();
    try std.testing.expectEqual(@as(u32, 1), eb.getTextBuffer().lineCount());

    _ = try eb.redo();
    try std.testing.expectEqual(@as(u32, 3), eb.getTextBuffer().lineCount());
}

test "EditBuffer - clearHistory" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello");
    try eb.insertText(" World");

    try std.testing.expect(eb.canUndo());

    eb.clearHistory();

    try std.testing.expect(!eb.canUndo());
    try std.testing.expect(!eb.canRedo());
}

test "EditBuffer - undo history branching" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("State A");

    try eb.insertText(" -> B");

    var out_buffer: [100]u8 = undefined;
    var written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("State A -> B", out_buffer[0..written]);

    _ = try eb.undo();
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("State A", out_buffer[0..written]);

    // Create new branch by editing after undo
    try eb.insertText(" -> C");

    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("State A -> C", out_buffer[0..written]);

    _ = try eb.undo();
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("State A", out_buffer[0..written]);

    // Redo should go to state C (the new branch)
    _ = try eb.redo();
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("State A -> C", out_buffer[0..written]);
}

test "EditBuffer - multiple undo/redo operations" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var out_buffer: [100]u8 = undefined;

    try eb.insertText("A");

    try eb.insertText("B");

    try eb.insertText("C");

    var written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("ABC", out_buffer[0..written]);

    _ = try eb.undo();
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("AB", out_buffer[0..written]);

    _ = try eb.undo();
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("A", out_buffer[0..written]);

    _ = try eb.redo();
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("AB", out_buffer[0..written]);

    _ = try eb.redo();
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("ABC", out_buffer[0..written]);
}
