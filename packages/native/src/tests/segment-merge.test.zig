const std = @import("std");
const EditBuffer = @import("../edit-buffer.zig").EditBuffer;
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");

test "EditBuffer - sequential character insertion merges segments" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("h");
    try eb.insertText("e");
    try eb.insertText("l");
    try eb.insertText("l");
    try eb.insertText("o");

    const count = eb.tb.rope().count();

    var buffer: [1024]u8 = undefined;
    const len = eb.getText(&buffer);
    try std.testing.expectEqualStrings("hello", buffer[0..len]);

    try std.testing.expect(count <= 4);
    try std.testing.expect(count >= 2);
}

test "EditBuffer - merging preserves text correctness" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    const text = "The quick brown fox jumps over the lazy dog";
    for (text) |c| {
        var char_buf: [1]u8 = .{c};
        try eb.insertText(&char_buf);
    }

    var buffer: [1024]u8 = undefined;
    const len = eb.getText(&buffer);
    try std.testing.expectEqualStrings(text, buffer[0..len]);
}

test "EditBuffer - non-contiguous segments do not merge" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("abc");
    try eb.setCursor(0, 0);
    try eb.insertText("xyz");

    var buffer: [1024]u8 = undefined;
    const len = eb.getText(&buffer);
    try std.testing.expectEqualStrings("xyzabc", buffer[0..len]);
}

test "EditBuffer - merging works across newlines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("a");
    try eb.insertText("b");
    try eb.insertText("c");
    try eb.insertText("\n");
    try eb.insertText("d");
    try eb.insertText("e");
    try eb.insertText("f");

    var buffer: [1024]u8 = undefined;
    const len = eb.getText(&buffer);
    try std.testing.expectEqualStrings("abc\ndef", buffer[0..len]);

    const line_count = eb.tb.lineCount();
    try std.testing.expectEqual(@as(u32, 2), line_count);
}

test "EditBuffer - merging with unicode characters" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("你");
    try eb.insertText("好");
    try eb.insertText("世");
    try eb.insertText("界");

    var buffer: [1024]u8 = undefined;
    const len = eb.getText(&buffer);
    try std.testing.expectEqualStrings("你好世界", buffer[0..len]);
}

test "EditBuffer - merging after delete and re-insert" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("hello");
    try eb.backspace();
    try eb.insertText("p");

    var buffer: [1024]u8 = undefined;
    const len = eb.getText(&buffer);
    try std.testing.expectEqualStrings("hellp", buffer[0..len]);
}

test "EditBuffer - empty buffer then type" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("t");
    try eb.insertText("e");
    try eb.insertText("s");
    try eb.insertText("t");

    var buffer: [1024]u8 = undefined;
    const len = eb.getText(&buffer);
    try std.testing.expectEqualStrings("test", buffer[0..len]);
}
