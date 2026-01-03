const std = @import("std");
const text_buffer = @import("../text-buffer.zig");
const text_buffer_view = @import("../text-buffer-view.zig");
const gp = @import("../grapheme.zig");

const TextBuffer = text_buffer.UnifiedTextBuffer;
const TextBufferView = text_buffer_view.UnifiedTextBufferView;
const RGBA = text_buffer.RGBA;

test "TextBufferView wrapping - no wrap returns same line count" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    const no_wrap_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 1), no_wrap_count);

    view.setWrapWidth(null);
    const still_no_wrap = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 1), still_no_wrap);
}

test "TextBufferView wrapping - simple wrap splits line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST");

    const no_wrap_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 1), no_wrap_count);

    view.setWrapMode(.char);
    view.setWrapWidth(10);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expectEqual(@as(u32, 2), wrapped_count);
}

test "TextBufferView wrapping - wrap at exact boundary" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("0123456789");

    view.setWrapMode(.char);
    view.setWrapWidth(10);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expectEqual(@as(u32, 1), wrapped_count);
}

test "TextBufferView wrapping - preserves newlines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Short\nAnother short line\nLast");

    const no_wrap_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 3), no_wrap_count);

    view.setWrapMode(.char);
    view.setWrapWidth(50);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expectEqual(@as(u32, 3), wrapped_count);
}

test "TextBufferView selection - basic selection without wrap" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
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

test "TextBufferView selection - with wrapped lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
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

test "TextBufferView selection - no selection returns all bits set" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    const packed_info = view.packSelectionInfo();
    try std.testing.expectEqual(@as(u64, 0xFFFFFFFF_FFFFFFFF), packed_info);
}

test "TextBufferView word wrapping - basic word wrap at space" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    view.setWrapMode(.word);
    view.setWrapWidth(8);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expectEqual(@as(u32, 2), wrapped_count);
}

test "TextBufferView word wrapping - long word exceeds width" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ");

    view.setWrapMode(.word);
    view.setWrapWidth(10);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expectEqual(@as(u32, 3), wrapped_count);
}

test "TextBufferView getSelectedTextIntoBuffer - simple selection" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");
    view.setSelection(6, 11, null, null);

    var buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&buffer);
    const text = buffer[0..len];

    try std.testing.expectEqualStrings("World", text);
}

test "TextBufferView getSelectedTextIntoBuffer - with newlines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 1\nLine 2\nLine 3");

    view.setSelection(0, 9, null, null);

    var buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&buffer);
    const text = buffer[0..len];

    try std.testing.expectEqualStrings("Line 1\nLi", text);
}

test "TextBufferView getCachedLineInfo - with wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST");

    view.setWrapMode(.char);
    view.setWrapWidth(7);
    const line_count = view.getVirtualLineCount();
    const line_info = view.getCachedLineInfo();

    try std.testing.expectEqual(@as(usize, line_count), line_info.starts.len);
    try std.testing.expectEqual(@as(usize, line_count), line_info.widths.len);

    for (line_info.widths, 0..) |width, i| {
        if (i < line_info.widths.len - 1) {
            try std.testing.expect(width <= 7);
        }
    }
}

test "TextBufferView virtual line spans - with highlights" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST");

    try tb.addHighlight(0, 5, 15, 1, 1, 0);

    view.setWrapMode(.char);
    view.setWrapWidth(10);

    try std.testing.expectEqual(@as(u32, 2), view.getVirtualLineCount());

    const vline0_info = view.getVirtualLineSpans(0);
    const vline1_info = view.getVirtualLineSpans(1);

    try std.testing.expectEqual(@as(usize, 0), vline0_info.source_line);
    try std.testing.expectEqual(@as(usize, 0), vline1_info.source_line);

    try std.testing.expectEqual(@as(u32, 0), vline0_info.col_offset);
    try std.testing.expectEqual(@as(u32, 10), vline1_info.col_offset);

    try std.testing.expect(vline0_info.spans.len > 0);
    try std.testing.expect(vline1_info.spans.len > 0);
}

test "TextBufferView updates after buffer setText" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("First text");
    view.setWrapMode(.char);
    view.setWrapWidth(5);
    const count1 = view.getVirtualLineCount();

    try tb.setText("New text that is much longer");

    const count2 = view.getVirtualLineCount();

    try std.testing.expect(count2 > count1);
}

test "TextBufferView wrapping - multiple wrap lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123");

    view.setWrapMode(.char);
    view.setWrapWidth(10);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expectEqual(@as(u32, 3), wrapped_count);
}

test "TextBufferView wrapping - long line with newlines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST\nShort");

    const no_wrap_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 2), no_wrap_count);

    view.setWrapMode(.char);
    view.setWrapWidth(10);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expectEqual(@as(u32, 3), wrapped_count);
}

test "TextBufferView wrapping - change wrap width" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST");

    view.setWrapMode(.char);
    view.setWrapWidth(10);
    var wrapped_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 2), wrapped_count);

    view.setWrapMode(.char);
    view.setWrapWidth(5);
    wrapped_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 4), wrapped_count);

    view.setWrapMode(.char);
    view.setWrapWidth(20);
    wrapped_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 1), wrapped_count);

    view.setWrapWidth(null);
    wrapped_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 1), wrapped_count);
}

test "TextBufferView wrapping - grapheme at exact boundary" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("12345678🌟");

    view.setWrapMode(.char);
    view.setWrapWidth(10);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expectEqual(@as(u32, 1), wrapped_count);
}

test "TextBufferView wrapping - grapheme split across boundary" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("123456789🌟ABC");

    view.setWrapMode(.char);
    view.setWrapWidth(10);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expectEqual(@as(u32, 2), wrapped_count);
}

test "TextBufferView wrapping - CJK characters at boundaries" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("测试文字处理");

    view.setWrapMode(.char);
    view.setWrapWidth(10);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expectEqual(@as(u32, 2), wrapped_count);
}

test "TextBufferView wrapping - mixed width characters" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("AB测试CD");

    view.setWrapMode(.char);
    view.setWrapWidth(6);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expectEqual(@as(u32, 2), wrapped_count);
}

test "TextBufferView wrapping - single wide character exceeds width" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("🌟");

    view.setWrapMode(.char);
    view.setWrapWidth(1);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expectEqual(@as(u32, 1), wrapped_count);
}

test "TextBufferView wrapping - multiple consecutive wide characters" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("🌟🌟🌟🌟🌟");

    view.setWrapMode(.char);
    view.setWrapWidth(6);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expectEqual(@as(u32, 2), wrapped_count);
}

test "TextBufferView wrapping - zero width characters" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("e\u{0301}e\u{0301}e\u{0301}"); // é é é using combining acute

    view.setWrapMode(.char);
    view.setWrapWidth(2);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expect(wrapped_count >= 1);
}

test "TextBufferView word wrapping - multiple words" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("The quick brown fox jumps");

    view.setWrapMode(.word);
    view.setWrapWidth(15);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expect(wrapped_count >= 2);
}

test "TextBufferView word wrapping - hyphenated words" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("self-contained multi-line");

    view.setWrapMode(.word);
    view.setWrapWidth(12);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expect(wrapped_count >= 2);
}

test "TextBufferView word wrapping - punctuation boundaries" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello,World.Test");

    view.setWrapMode(.word);
    view.setWrapWidth(8);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expect(wrapped_count >= 2);
}

test "TextBufferView word wrapping - compare char vs word mode" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello wonderful world");

    view.setWrapMode(.char);
    view.setWrapWidth(10);
    const char_wrapped_count = view.getVirtualLineCount();

    view.setWrapMode(.word);
    const word_wrapped_count = view.getVirtualLineCount();

    try std.testing.expect(char_wrapped_count >= 2);
    try std.testing.expect(word_wrapped_count >= 2);
}

test "TextBufferView word wrapping - empty lines preserved" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("First line\n\nSecond line");

    view.setWrapMode(.word);
    view.setWrapWidth(8);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expect(wrapped_count >= 3);
}

test "TextBufferView word wrapping - slash as boundary" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("path/to/file");

    view.setWrapMode(.word);
    view.setWrapWidth(8);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expect(wrapped_count >= 2);
}

test "TextBufferView word wrapping - brackets as boundaries" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("array[index]value");

    view.setWrapMode(.word);
    view.setWrapWidth(10);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expect(wrapped_count >= 2);
}

test "TextBufferView word wrapping - single character at boundary" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("a b c d e f");

    view.setWrapMode(.word);
    view.setWrapWidth(4);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expect(wrapped_count >= 3);
}

test "TextBufferView word wrapping - fragmented rope with word boundary" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const text = "hello my good friend";
    const mem_id = try tb.mem_registry.register(text, false);

    const seg_mod = @import("../text-buffer-segment.zig");
    const Segment = seg_mod.Segment;

    const chunk1 = tb.createChunk(mem_id, 0, 14); // "hello my good "
    const chunk2 = tb.createChunk(mem_id, 14, 15); // "f"
    const chunk3 = tb.createChunk(mem_id, 15, 20); // "riend"

    var segments: std.ArrayListUnmanaged(Segment) = .{};
    defer segments.deinit(std.testing.allocator);

    try segments.append(std.testing.allocator, Segment{ .linestart = {} });
    try segments.append(std.testing.allocator, Segment{ .text = chunk1 });
    try segments.append(std.testing.allocator, Segment{ .text = chunk2 });
    try segments.append(std.testing.allocator, Segment{ .text = chunk3 });

    try tb.rope.setSegments(segments.items);

    view.virtual_lines_dirty = true;

    view.setWrapMode(.word);
    view.setWrapWidth(18);

    const vlines = view.getVirtualLines();

    try std.testing.expectEqual(@as(usize, 2), vlines.len);

    try std.testing.expectEqual(@as(u32, 14), vlines[0].width);

    try std.testing.expectEqual(@as(u32, 6), vlines[1].width);
}

test "TextBufferView wrapping - very narrow width (1 char)" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDE");

    view.setWrapMode(.char);
    view.setWrapWidth(1);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expectEqual(@as(u32, 5), wrapped_count);
}

test "TextBufferView wrapping - very narrow width (2 chars)" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEF");

    view.setWrapMode(.char);
    view.setWrapWidth(2);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expectEqual(@as(u32, 3), wrapped_count);
}

test "TextBufferView wrapping - switch between char and word mode" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello world test");

    view.setWrapMode(.char);
    view.setWrapWidth(8);

    view.setWrapMode(.char);
    const char_count = view.getVirtualLineCount();

    view.setWrapMode(.word);
    const word_count = view.getVirtualLineCount();

    try std.testing.expect(char_count >= 2);
    try std.testing.expect(word_count >= 2);
}

test "TextBufferView wrapping - multiple consecutive newlines with wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJ\n\n\nKLMNOPQRST");

    view.setWrapMode(.char);
    view.setWrapWidth(5);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expect(wrapped_count >= 6);
}

test "TextBufferView wrapping - only spaces should not create extra lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("          "); // 10 spaces

    view.setWrapMode(.char);
    view.setWrapWidth(5);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expectEqual(@as(u32, 2), wrapped_count);
}

test "TextBufferView wrapping - mixed tabs and spaces" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("AB\tCD\tEF");

    view.setWrapMode(.char);
    view.setWrapWidth(5);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expect(wrapped_count >= 1);
}

test "TextBufferView wrapping - unicode emoji with varying widths" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("A🌟B🎨C🚀D");

    view.setWrapMode(.char);
    view.setWrapWidth(5);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expect(wrapped_count >= 2);
}

test "TextBufferView wrapping - getVirtualLines reflects current wrap state" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST");

    var vlines = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 1), vlines.len);

    view.setWrapMode(.char);
    view.setWrapWidth(10);
    vlines = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 2), vlines.len);

    view.setWrapMode(.char);
    view.setWrapWidth(5);
    vlines = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 4), vlines.len);

    view.setWrapWidth(null);
    vlines = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 1), vlines.len);
}

test "TextBufferView selection - multi-line selection without wrap" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 1\nLine 2\nLine 3");

    _ = view.setLocalSelection(2, 0, 4, 1, null, null);

    const packed_info = view.packSelectionInfo();
    try std.testing.expect(packed_info != 0xFFFFFFFF_FFFFFFFF);
}

test "TextBufferView selection - selection at wrap boundary" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
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

test "TextBufferView selection - spanning multiple wrapped lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
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

test "TextBufferView selection - changes when wrap width changes" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
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

    view.setWrapMode(.char);
    view.setWrapWidth(5);
    _ = view.setLocalSelection(5, 0, 5, 1, null, null);

    packed_info = view.packSelectionInfo();
    start = @as(u32, @intCast(packed_info >> 32));
    end = @as(u32, @intCast(packed_info & 0xFFFFFFFF));

    try std.testing.expect(packed_info != 0xFFFFFFFF_FFFFFFFF);
}

test "TextBufferView selection - empty selection with wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJ");

    view.setWrapMode(.char);
    view.setWrapWidth(5);

    _ = view.setLocalSelection(2, 0, 2, 0, null, null);

    const packed_info = view.packSelectionInfo();

    try std.testing.expectEqual(@as(u64, 0xFFFFFFFF_FFFFFFFF), packed_info);
}

test "TextBufferView selection - with newlines and wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
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

test "TextBufferView selection - reset clears selection" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
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

test "TextBufferView selection - spanning multiple lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Red\nBlue");

    view.setSelection(2, 5, null, null);

    var buffer: [100]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&buffer);
    const text = buffer[0..len];

    try std.testing.expectEqualStrings("d\nB", text);
}

test "TextBufferView line info - empty buffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("");

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 1), line_count);

    const line_info = view.getCachedLineInfo();
    try std.testing.expectEqual(@as(usize, 1), line_info.starts.len);
    try std.testing.expectEqual(@as(u32, 0), line_info.starts[0]);
    try std.testing.expectEqual(@as(u32, 0), line_info.widths[0]);
}

test "TextBufferView line info - simple text without newlines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 1), line_count);

    const line_info = view.getCachedLineInfo();
    try std.testing.expectEqual(@as(u32, 0), line_info.starts[0]);
    try std.testing.expect(line_info.widths[0] > 0);
}

test "TextBufferView line info - text ending with newline" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World\n");

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 2), line_count);

    const line_info = view.getCachedLineInfo();
    try std.testing.expectEqual(@as(u32, 0), line_info.starts[0]);
    try std.testing.expect(line_info.widths[0] > 0);
    try std.testing.expect(line_info.widths[1] >= 0);
}

test "TextBufferView line info - consecutive newlines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 1\n\nLine 3");

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 3), line_count);

    const line_info = view.getCachedLineInfo();
    try std.testing.expectEqual(@as(u32, 0), line_info.starts[0]);
}

test "TextBufferView line info - only newlines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("\n\n\n");

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 4), line_count);

    const line_info = view.getCachedLineInfo();
    for (line_info.widths) |width| {
        try std.testing.expect(width >= 0);
    }
}

test "TextBufferView line info - wide characters (Unicode)" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello 世界 🌟");

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 1), line_count);

    const line_info = view.getCachedLineInfo();
    try std.testing.expect(line_info.widths[0] > 0);
}

test "TextBufferView line info - very long lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const longText = [_]u8{'A'} ** 1000;
    try tb.setText(&longText);

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 1), line_count);

    const line_info = view.getCachedLineInfo();
    try std.testing.expect(line_info.widths[0] > 0);
}

test "TextBufferView line info - buffer with only whitespace" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("   \n \n ");

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 3), line_count);

    const line_info = view.getCachedLineInfo();
    for (line_info.widths) |width| {
        try std.testing.expect(width >= 0);
    }
}

test "TextBufferView line info - single character lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("A\nB\nC");

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 3), line_count);

    const line_info = view.getCachedLineInfo();
    for (line_info.widths) |width| {
        try std.testing.expect(width > 0);
    }
}

test "TextBufferView line info - complex Unicode combining characters" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("café\nnaïve\nrésumé");

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 3), line_count);

    const line_info = view.getCachedLineInfo();
    for (line_info.widths) |width| {
        try std.testing.expect(width > 0);
    }
}

test "TextBufferView line info - extremely long single line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const extremelyLongText = [_]u8{'A'} ** 10000;
    try tb.setText(&extremelyLongText);

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 1), line_count);

    const line_info = view.getCachedLineInfo();
    try std.testing.expect(line_info.widths[0] > 0);
}

test "TextBufferView line info - extremely long line with wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    // Create extremely long text with 10000 'A' characters
    const extremelyLongText = [_]u8{'A'} ** 10000;
    try tb.setText(&extremelyLongText);

    view.setWrapMode(.char);
    view.setWrapWidth(80);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expect(wrapped_count > 100);
}

test "TextBufferView getPlainTextIntoBuffer - simple text without newlines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    var buffer: [100]u8 = undefined;
    const len = view.getPlainTextIntoBuffer(&buffer);
    const text = buffer[0..len];

    try std.testing.expectEqualStrings("Hello World", text);
}

test "TextBufferView getPlainTextIntoBuffer - text with newlines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 1\nLine 2\nLine 3");

    var buffer: [100]u8 = undefined;
    const len = view.getPlainTextIntoBuffer(&buffer);
    const text = buffer[0..len];

    try std.testing.expectEqualStrings("Line 1\nLine 2\nLine 3", text);
}

test "TextBufferView getPlainTextIntoBuffer - text with only newlines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("\n\n\n");

    var buffer: [100]u8 = undefined;
    const len = view.getPlainTextIntoBuffer(&buffer);
    const text = buffer[0..len];

    try std.testing.expectEqualStrings("\n\n\n", text);
}

test "TextBufferView getPlainTextIntoBuffer - empty lines between content" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("First\n\nThird");

    var buffer: [100]u8 = undefined;
    const len = view.getPlainTextIntoBuffer(&buffer);
    const text = buffer[0..len];

    try std.testing.expectEqualStrings("First\n\nThird", text);
}

test "TextBufferView line info - text starting with newline" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("\nHello World");

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 2), line_count);

    const line_info = view.getCachedLineInfo();
    try std.testing.expectEqual(@as(u32, 0), line_info.starts[0]);

    try std.testing.expectEqual(@as(u32, 1), line_info.starts[1]);
}

test "TextBufferView line info - lines with different widths" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var text_builder: std.ArrayListUnmanaged(u8) = .{};
    defer text_builder.deinit(std.testing.allocator);
    try text_builder.appendSlice(std.testing.allocator, "Short\n");
    try text_builder.appendNTimes(std.testing.allocator, 'A', 50);
    try text_builder.appendSlice(std.testing.allocator, "\nMedium");
    const text = text_builder.items;

    try tb.setText(text);

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 3), line_count);

    const line_info = view.getCachedLineInfo();
    try std.testing.expect(line_info.widths[0] < line_info.widths[1]);
    try std.testing.expect(line_info.widths[1] > line_info.widths[2]);
}

test "TextBufferView line info - alternating empty and content lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("\nContent\n\nMore\n\n");

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 6), line_count);

    const line_info = view.getCachedLineInfo();
    for (line_info.widths) |width| {
        try std.testing.expect(width >= 0);
    }
}

test "TextBufferView line info - thousands of lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var text_builder: std.ArrayListUnmanaged(u8) = .{};
    defer text_builder.deinit(std.testing.allocator);

    var i: u32 = 0;
    while (i < 999) : (i += 1) {
        try text_builder.writer(std.testing.allocator).print("Line {}\n", .{i});
    }
    try text_builder.writer(std.testing.allocator).print("Line {}", .{i});

    try tb.setText(text_builder.items);

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 1000), line_count);

    const line_info = view.getCachedLineInfo();
    try std.testing.expectEqual(@as(u32, 0), line_info.starts[0]);

    var line_idx: u32 = 1;
    while (line_idx < 1000) : (line_idx += 1) {
        try std.testing.expect(line_info.starts[line_idx] > line_info.starts[line_idx - 1]);
    }
}

test "TextBufferView highlights - add single highlight to line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    try tb.addHighlight(0, 0, 5, 1, 0, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 1), highlights.len);
    try std.testing.expectEqual(@as(u32, 0), highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 5), highlights[0].col_end);
    try std.testing.expectEqual(@as(u32, 1), highlights[0].style_id);
}

test "TextBufferView highlights - add multiple highlights to same line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    try tb.addHighlight(0, 0, 5, 1, 0, 0);
    try tb.addHighlight(0, 6, 11, 2, 0, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 2), highlights.len);
    try std.testing.expectEqual(@as(u32, 1), highlights[0].style_id);
    try std.testing.expectEqual(@as(u32, 2), highlights[1].style_id);
}

test "TextBufferView highlights - add highlights to multiple lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 1\nLine 2\nLine 3");

    try tb.addHighlight(0, 0, 6, 1, 0, 0);
    try tb.addHighlight(1, 0, 6, 2, 0, 0);
    try tb.addHighlight(2, 0, 6, 3, 0, 0);

    try std.testing.expectEqual(@as(usize, 1), tb.getLineHighlights(0).len);
    try std.testing.expectEqual(@as(usize, 1), tb.getLineHighlights(1).len);
    try std.testing.expectEqual(@as(usize, 1), tb.getLineHighlights(2).len);
}

test "TextBufferView highlights - remove highlights by reference" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 1\nLine 2");

    try tb.addHighlight(0, 0, 3, 1, 0, 100);
    try tb.addHighlight(0, 3, 6, 2, 0, 200);
    try tb.addHighlight(1, 0, 6, 3, 0, 100);

    tb.removeHighlightsByRef(100);

    const line0_highlights = tb.getLineHighlights(0);
    const line1_highlights = tb.getLineHighlights(1);

    try std.testing.expectEqual(@as(usize, 1), line0_highlights.len);
    try std.testing.expectEqual(@as(u32, 2), line0_highlights[0].style_id);
    try std.testing.expectEqual(@as(usize, 0), line1_highlights.len);
}

test "TextBufferView highlights - clear line highlights" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 1\nLine 2");

    try tb.addHighlight(0, 0, 6, 1, 0, 0);
    try tb.addHighlight(0, 6, 10, 2, 0, 0);

    tb.clearLineHighlights(0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 0), highlights.len);
}

test "TextBufferView highlights - clear all highlights" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 1\nLine 2\nLine 3");

    try tb.addHighlight(0, 0, 6, 1, 0, 0);
    try tb.addHighlight(1, 0, 6, 2, 0, 0);
    try tb.addHighlight(2, 0, 6, 3, 0, 0);

    tb.clearAllHighlights();

    try std.testing.expectEqual(@as(usize, 0), tb.getLineHighlights(0).len);
    try std.testing.expectEqual(@as(usize, 0), tb.getLineHighlights(1).len);
    try std.testing.expectEqual(@as(usize, 0), tb.getLineHighlights(2).len);
}

test "TextBufferView highlights - overlapping highlights" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    try tb.addHighlight(0, 0, 8, 1, 0, 0);
    try tb.addHighlight(0, 5, 11, 2, 0, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 2), highlights.len);
}

test "TextBufferView highlights - style spans computed correctly" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("0123456789");

    try tb.addHighlight(0, 0, 3, 1, 1, 0);
    try tb.addHighlight(0, 5, 8, 2, 1, 0);

    const spans = tb.getLineSpans(0);
    try std.testing.expect(spans.len > 0);

    var found_style1 = false;
    var found_style2 = false;
    for (spans) |span| {
        if (span.style_id == 1) found_style1 = true;
        if (span.style_id == 2) found_style2 = true;
    }
    try std.testing.expect(found_style1);
    try std.testing.expect(found_style2);
}

test "TextBufferView highlights - priority handling in spans" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("0123456789");

    try tb.addHighlight(0, 0, 8, 1, 1, 0);
    try tb.addHighlight(0, 3, 6, 2, 5, 0);

    const spans = tb.getLineSpans(0);
    try std.testing.expect(spans.len > 0);

    var found_high_priority = false;
    for (spans) |span| {
        if (span.col >= 3 and span.col < 6 and span.style_id == 2) {
            found_high_priority = true;
        }
    }
    try std.testing.expect(found_high_priority);
}

test "TextBufferView char range highlights - single line highlight" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    try tb.addHighlightByCharRange(0, 5, 1, 1, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 1), highlights.len);
    try std.testing.expectEqual(@as(u32, 0), highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 5), highlights[0].col_end);
    try std.testing.expectEqual(@as(u32, 1), highlights[0].style_id);
}

test "TextBufferView char range highlights - multi-line highlight" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello\nWorld\nTest");

    try tb.addHighlightByCharRange(3, 9, 1, 1, 0);

    const line0_highlights = tb.getLineHighlights(0);
    const line1_highlights = tb.getLineHighlights(1);

    try std.testing.expectEqual(@as(usize, 1), line0_highlights.len);
    try std.testing.expectEqual(@as(usize, 1), line1_highlights.len);

    try std.testing.expectEqual(@as(u32, 3), line0_highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 5), line0_highlights[0].col_end);

    try std.testing.expectEqual(@as(u32, 0), line1_highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 4), line1_highlights[0].col_end);
}

test "TextBufferView char range highlights - spanning three lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line1\nLine2\nLine3");

    try tb.addHighlightByCharRange(3, 13, 1, 1, 0);

    const line0_highlights = tb.getLineHighlights(0);
    const line1_highlights = tb.getLineHighlights(1);
    const line2_highlights = tb.getLineHighlights(2);

    try std.testing.expectEqual(@as(usize, 1), line0_highlights.len);
    try std.testing.expectEqual(@as(usize, 1), line1_highlights.len);
    try std.testing.expectEqual(@as(usize, 1), line2_highlights.len);

    try std.testing.expectEqual(@as(u32, 3), line0_highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 0), line1_highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 0), line2_highlights[0].col_start);
}

test "TextBufferView char range highlights - empty range" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    try tb.addHighlightByCharRange(5, 5, 1, 1, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 0), highlights.len);
}

test "TextBufferView char range highlights - multiple non-overlapping ranges" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("function hello() { return 42; }");

    try tb.addHighlightByCharRange(0, 8, 1, 1, 0);
    try tb.addHighlightByCharRange(9, 14, 2, 1, 0);
    try tb.addHighlightByCharRange(19, 25, 3, 1, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 3), highlights.len);
    try std.testing.expectEqual(@as(u32, 1), highlights[0].style_id);
    try std.testing.expectEqual(@as(u32, 2), highlights[1].style_id);
    try std.testing.expectEqual(@as(u32, 3), highlights[2].style_id);
}

test "TextBufferView char range highlights - with reference ID for removal" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line1\nLine2\nLine3");

    try tb.addHighlightByCharRange(0, 5, 1, 1, 100);
    try tb.addHighlightByCharRange(6, 11, 2, 1, 100);

    try std.testing.expectEqual(@as(usize, 1), tb.getLineHighlights(0).len);
    try std.testing.expectEqual(@as(usize, 1), tb.getLineHighlights(1).len);

    tb.removeHighlightsByRef(100);

    try std.testing.expectEqual(@as(usize, 0), tb.getLineHighlights(0).len);
    try std.testing.expectEqual(@as(usize, 0), tb.getLineHighlights(1).len);
}

test "TextBufferView highlights - work correctly with wrapped lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST");

    try tb.addHighlight(0, 5, 15, 1, 1, 0);

    view.setWrapMode(.char);
    view.setWrapWidth(10);

    try std.testing.expectEqual(@as(u32, 2), view.getVirtualLineCount());

    const vline0_info = view.getVirtualLineSpans(0);
    const vline1_info = view.getVirtualLineSpans(1);

    try std.testing.expectEqual(@as(usize, 0), vline0_info.source_line);
    try std.testing.expectEqual(@as(usize, 0), vline1_info.source_line);

    try std.testing.expectEqual(@as(u32, 0), vline0_info.col_offset);
    try std.testing.expectEqual(@as(u32, 10), vline1_info.col_offset);

    try std.testing.expect(vline0_info.spans.len > 0);
    try std.testing.expect(vline1_info.spans.len > 0);
}

test "TextBufferView measureForDimensions - does not modify cache" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST");

    // Set wrap mode but don't call updateVirtualLines
    view.setWrapMode(.char);
    view.setWrapWidth(100); // Large width, no wrapping expected

    // Measure with different width WITHOUT updating cache
    const result = try view.measureForDimensions(10, 10);

    // Should have 2 lines for width 10
    try std.testing.expectEqual(@as(u32, 2), result.line_count);
    try std.testing.expectEqual(@as(u32, 10), result.max_width);

    // Now check that the actual cached virtual lines are NOT changed
    const actual_count = view.getVirtualLineCount();
    // Should be 1 line because wrap_width is 100
    try std.testing.expectEqual(@as(u32, 1), actual_count);
}

test "TextBufferView measureForDimensions - char wrap" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST");
    view.setWrapMode(.char);

    // Test different widths
    const result1 = try view.measureForDimensions(10, 10);
    try std.testing.expectEqual(@as(u32, 2), result1.line_count);
    try std.testing.expectEqual(@as(u32, 10), result1.max_width);

    const result2 = try view.measureForDimensions(5, 10);
    try std.testing.expectEqual(@as(u32, 4), result2.line_count);
    try std.testing.expectEqual(@as(u32, 5), result2.max_width);

    const result3 = try view.measureForDimensions(20, 10);
    try std.testing.expectEqual(@as(u32, 1), result3.line_count);
    try std.testing.expectEqual(@as(u32, 20), result3.max_width);
}

test "TextBufferView measureForDimensions - no wrap mode" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello\nWorld\nTest");
    view.setWrapMode(.none);

    // With no wrap, width shouldn't matter
    const result = try view.measureForDimensions(3, 10);
    try std.testing.expectEqual(@as(u32, 3), result.line_count);
    // max_width should be the longest line
    try std.testing.expect(result.max_width >= 4);
}

test "TextBufferView measureForDimensions - word wrap" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello wonderful world");
    view.setWrapMode(.word);

    const result = try view.measureForDimensions(10, 10);
    // Should wrap at word boundaries
    try std.testing.expect(result.line_count >= 2);
    try std.testing.expect(result.max_width <= 10);
}

test "TextBufferView measureForDimensions - empty buffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("");
    view.setWrapMode(.char);

    const result = try view.measureForDimensions(10, 10);
    try std.testing.expectEqual(@as(u32, 1), result.line_count);
    try std.testing.expectEqual(@as(u32, 0), result.max_width);
}

test "TextBufferView measureForDimensions - multiple lines with different widths" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Short\nAVeryLongLineHere\nMedium");
    view.setWrapMode(.char);

    const result = try view.measureForDimensions(10, 10);
    // "Short" (1 line), "AVeryLongLineHere" (2 lines), "Medium" (1 line) = 4 lines
    try std.testing.expectEqual(@as(u32, 4), result.line_count);
    try std.testing.expectEqual(@as(u32, 10), result.max_width);
}

test "TextBufferView highlights - multiple highlights on wrapped line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ");

    try tb.addHighlight(0, 2, 8, 1, 1, 0);
    try tb.addHighlight(0, 12, 18, 2, 1, 0);
    try tb.addHighlight(0, 22, 26, 3, 1, 0);

    view.setWrapMode(.char);
    view.setWrapWidth(10);

    const vline_count = view.getVirtualLineCount();
    try std.testing.expect(vline_count >= 3);

    for (0..vline_count) |i| {
        const vline_info = view.getVirtualLineSpans(i);
        try std.testing.expectEqual(@as(usize, 0), vline_info.source_line);
        try std.testing.expectEqual(@as(u32, @intCast(i * 10)), vline_info.col_offset);
    }
}

test "TextBufferView highlights - with emojis and wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("AB🌟CD🎨EF🚀GH");

    try tb.addHighlight(0, 2, 8, 1, 1, 0);

    view.setWrapMode(.char);
    view.setWrapWidth(6);

    const vline_count = view.getVirtualLineCount();
    try std.testing.expect(vline_count >= 2);

    const vline0_info = view.getVirtualLineSpans(0);
    const vline1_info = view.getVirtualLineSpans(1);

    try std.testing.expectEqual(@as(usize, 0), vline0_info.source_line);
    try std.testing.expectEqual(@as(usize, 0), vline1_info.source_line);

    try std.testing.expectEqual(@as(u32, 0), vline0_info.col_offset);
    try std.testing.expect(vline1_info.col_offset == 6);

    try std.testing.expect(vline0_info.spans.len > 0);
}

test "TextBufferView highlights - with CJK characters and wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("AB测试CD文字EF");

    try tb.addHighlight(0, 2, 6, 1, 1, 0);

    view.setWrapMode(.char);
    view.setWrapWidth(6);

    const vline_count = view.getVirtualLineCount();
    try std.testing.expect(vline_count >= 2);

    for (0..vline_count) |i| {
        const vline_info = view.getVirtualLineSpans(i);
        try std.testing.expectEqual(@as(usize, 0), vline_info.source_line);

        if (i == 0) {
            try std.testing.expectEqual(@as(u32, 0), vline_info.col_offset);
        } else if (i == 1) {
            try std.testing.expectEqual(@as(u32, 6), vline_info.col_offset);
        }
    }
}

test "TextBufferView highlights - mixed ASCII and wide chars with wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello🌟世界");

    try tb.addHighlight(0, 5, 11, 1, 1, 0);

    view.setWrapMode(.char);
    view.setWrapWidth(7);

    const vline_count = view.getVirtualLineCount();
    try std.testing.expect(vline_count >= 2);

    const vline0_info = view.getVirtualLineSpans(0);
    const vline1_info = view.getVirtualLineSpans(1);

    try std.testing.expectEqual(@as(usize, 0), vline0_info.source_line);
    try std.testing.expectEqual(@as(usize, 0), vline1_info.source_line);

    try std.testing.expectEqual(@as(u32, 0), vline0_info.col_offset);
    try std.testing.expectEqual(@as(u32, 7), vline1_info.col_offset);

    try std.testing.expect(vline0_info.spans.len > 0);
    try std.testing.expect(vline1_info.spans.len > 0);
}

test "TextBufferView highlights - emoji at wrap boundary" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCD🌟EFGH");

    try tb.addHighlight(0, 3, 7, 1, 1, 0);

    view.setWrapMode(.char);
    view.setWrapWidth(5);

    const vline_count = view.getVirtualLineCount();
    try std.testing.expect(vline_count >= 2);

    const vline0_info = view.getVirtualLineSpans(0);
    const vline1_info = view.getVirtualLineSpans(1);

    try std.testing.expectEqual(@as(u32, 0), vline0_info.col_offset);
    try std.testing.expect(vline1_info.col_offset >= 4);
}

test "TextBufferView highlights - emojis without wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("AB🌟CD🎨EF");

    try tb.addHighlight(0, 2, 8, 1, 1, 0);

    const vline_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 1), vline_count);

    const spans = tb.getLineSpans(0);
    try std.testing.expect(spans.len > 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 1), highlights.len);
    try std.testing.expectEqual(@as(u32, 2), highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 8), highlights[0].col_end);
}

test "TextBufferView highlights - CJK without wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("AB测试CD");

    try tb.addHighlight(0, 2, 6, 1, 1, 0);

    const vline_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 1), vline_count);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 1), highlights.len);
    try std.testing.expectEqual(@as(u32, 2), highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 6), highlights[0].col_end);

    const spans = tb.getLineSpans(0);
    try std.testing.expect(spans.len > 0);
}

test "TextBufferView highlights - mixed width graphemes without wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("A🌟B测C试D");

    try tb.addHighlight(0, 1, 4, 1, 1, 0);
    try tb.addHighlight(0, 4, 7, 2, 1, 0);

    const vline_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 1), vline_count);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 2), highlights.len);
    try std.testing.expectEqual(@as(u32, 1), highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 4), highlights[0].col_end);
    try std.testing.expectEqual(@as(u32, 4), highlights[1].col_start);
    try std.testing.expectEqual(@as(u32, 7), highlights[1].col_end);

    const spans = tb.getLineSpans(0);
    try std.testing.expect(spans.len > 0);
}

test "TextBufferView highlights - emoji at start without wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("🌟ABCD");

    try tb.addHighlight(0, 0, 3, 1, 1, 0);

    const vline_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 1), vline_count);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 1), highlights.len);
    try std.testing.expectEqual(@as(u32, 0), highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 3), highlights[0].col_end);
}

test "TextBufferView highlights - emoji at end without wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCD🌟");

    try tb.addHighlight(0, 3, 6, 1, 1, 0);

    const vline_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 1), vline_count);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 1), highlights.len);
    try std.testing.expectEqual(@as(u32, 3), highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 6), highlights[0].col_end);
}

test "TextBufferView highlights - consecutive emojis without wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("A🌟🎨🚀B");

    try tb.addHighlight(0, 1, 7, 1, 1, 0);

    const vline_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 1), vline_count);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 1), highlights.len);
    try std.testing.expectEqual(@as(u32, 1), highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 7), highlights[0].col_end);
}

test "TextBufferView accessor methods - getVirtualLines and getLines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 1\nLine 2");

    const virtual_lines = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 2), virtual_lines.len);

    try std.testing.expectEqual(@as(u32, 2), tb.lineCount());

    try std.testing.expect(virtual_lines[0].chunks.items.len > 0);
}

test "TextBufferView accessor methods - with wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST");

    view.setWrapMode(.char);
    view.setWrapWidth(10);

    const virtual_lines = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 2), virtual_lines.len);

    try std.testing.expectEqual(@as(u32, 1), tb.lineCount());
}

test "TextBufferView virtual lines - match real lines when no wrap" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 1\nLine 2\nLine 3");

    try std.testing.expectEqual(@as(u32, 3), view.getVirtualLineCount());
    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());

    const line_info = view.getCachedLineInfo();
    try std.testing.expectEqual(@as(usize, 3), line_info.starts.len);
    try std.testing.expectEqual(@as(usize, 3), line_info.widths.len);
}

test "TextBufferView virtual lines - updated when wrap width set" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST");

    try std.testing.expectEqual(@as(u32, 1), view.getVirtualLineCount());

    view.setWrapMode(.char);
    view.setWrapWidth(10);
    try std.testing.expectEqual(@as(u32, 2), view.getVirtualLineCount());
}

test "TextBufferView virtual lines - reset to match real lines when wrap removed" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST\nShort");

    view.setWrapMode(.char);
    view.setWrapWidth(10);
    try std.testing.expectEqual(@as(u32, 3), view.getVirtualLineCount());

    view.setWrapWidth(null);

    try std.testing.expectEqual(@as(u32, 2), view.getVirtualLineCount());

    const line_info = view.getCachedLineInfo();
    try std.testing.expectEqual(@as(usize, 2), line_info.starts.len);
    try std.testing.expectEqual(@as(usize, 2), line_info.widths.len);
}

test "TextBufferView virtual lines - multi-line text without wrap" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("First line\n\nThird line with more text\n");

    try std.testing.expectEqual(@as(u32, 4), view.getVirtualLineCount());

    const line_info = view.getCachedLineInfo();
    try std.testing.expectEqual(@as(usize, 4), line_info.starts.len);
    try std.testing.expectEqual(@as(usize, 4), line_info.widths.len);

    // Verify the line starts are monotonically non-decreasing (empty lines have same start)
    try std.testing.expect(line_info.starts[0] == 0);
    try std.testing.expect(line_info.starts[1] >= line_info.starts[0]);
    try std.testing.expect(line_info.starts[2] >= line_info.starts[1]);
    try std.testing.expect(line_info.starts[3] >= line_info.starts[2]);
}

test "TextBufferView line info - line starts and widths consistency" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST");

    view.setWrapMode(.char);
    view.setWrapWidth(7);
    const line_count = view.getVirtualLineCount();
    const line_info = view.getCachedLineInfo();

    try std.testing.expectEqual(@as(usize, line_count), line_info.starts.len);
    try std.testing.expectEqual(@as(usize, line_count), line_info.widths.len);

    for (line_info.widths, 0..) |width, i| {
        if (i < line_info.widths.len - 1) {
            try std.testing.expect(width <= 7);
        }
    }
}

test "TextBufferView line info - line starts monotonically increasing" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var text_builder: std.ArrayListUnmanaged(u8) = .{};
    defer text_builder.deinit(std.testing.allocator);

    var i: u32 = 0;
    while (i < 99) : (i += 1) {
        try text_builder.writer(std.testing.allocator).print("Line {}\n", .{i});
    }
    try text_builder.writer(std.testing.allocator).print("Line {}", .{i});

    try tb.setText(text_builder.items);

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 100), line_count);

    const line_info = view.getCachedLineInfo();
    try std.testing.expectEqual(@as(u32, 0), line_info.starts[0]);

    var line_idx: u32 = 1;
    while (line_idx < 100) : (line_idx += 1) {
        try std.testing.expect(line_info.starts[line_idx] >= line_info.starts[line_idx - 1]);
    }
}

test "TextBufferView - highlights preserved after wrap width change" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST");

    try tb.addHighlight(0, 0, 10, 1, 0, 0);

    view.setWrapMode(.char);
    view.setWrapWidth(10);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 1), highlights.len);
}

test "TextBufferView - get highlights from non-existent line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 1");

    const highlights = tb.getLineHighlights(10);
    try std.testing.expectEqual(@as(usize, 0), highlights.len);
}

test "TextBufferView - char range highlights out of bounds" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello");

    try tb.addHighlightByCharRange(3, 100, 1, 1, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 1), highlights.len);
    try std.testing.expectEqual(@as(u32, 3), highlights[0].col_start);
}

test "TextBufferView - char range highlights invalid range" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    try tb.addHighlightByCharRange(10, 5, 1, 1, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 0), highlights.len);
}

test "TextBufferView - char range highlights exact line boundaries" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("AAAA\nBBBB\nCCCC");

    try tb.addHighlightByCharRange(0, 4, 1, 1, 0);

    const line0_highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 1), line0_highlights.len);
    try std.testing.expectEqual(@as(u32, 0), line0_highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 4), line0_highlights[0].col_end);

    const line1_highlights = tb.getLineHighlights(1);
    try std.testing.expectEqual(@as(usize, 0), line1_highlights.len);
}

test "TextBufferView - char range highlights unicode text" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello 世界 🌟");

    const text_len = tb.getLength();
    try tb.addHighlightByCharRange(0, text_len, 1, 1, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 1), highlights.len);
}

test "TextBufferView automatic updates - view reflects buffer changes immediately" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello");
    try std.testing.expectEqual(@as(u32, 1), view.getVirtualLineCount());

    var buffer: [100]u8 = undefined;
    const len1 = view.getPlainTextIntoBuffer(&buffer);
    try std.testing.expectEqualStrings("Hello", buffer[0..len1]);

    try tb.setText("Hello\nWorld");
    try std.testing.expectEqual(@as(u32, 2), view.getVirtualLineCount());

    const len2 = view.getPlainTextIntoBuffer(&buffer);
    try std.testing.expectEqualStrings("Hello\nWorld", buffer[0..len2]);
}

test "TextBufferView automatic updates - multiple views update independently" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view1 = try TextBufferView.init(std.testing.allocator, tb);
    defer view1.deinit();

    var view2 = try TextBufferView.init(std.testing.allocator, tb);
    defer view2.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST");

    try std.testing.expectEqual(@as(u32, 1), view1.getVirtualLineCount());
    try std.testing.expectEqual(@as(u32, 1), view2.getVirtualLineCount());

    view1.setWrapMode(.char);
    view1.setWrapWidth(10);
    view2.setWrapMode(.char);
    view2.setWrapWidth(5);

    try std.testing.expectEqual(@as(u32, 2), view1.getVirtualLineCount());
    try std.testing.expectEqual(@as(u32, 4), view2.getVirtualLineCount());

    try tb.setText("Short");

    try std.testing.expectEqual(@as(u32, 1), view1.getVirtualLineCount());
    try std.testing.expectEqual(@as(u32, 1), view2.getVirtualLineCount());
}

test "TextBufferView automatic updates - view destroyed doesn't affect others" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view1 = try TextBufferView.init(std.testing.allocator, tb);
    defer view1.deinit();

    var view2 = try TextBufferView.init(std.testing.allocator, tb);

    try tb.setText("Hello");
    try std.testing.expectEqual(@as(u32, 1), view1.getVirtualLineCount());
    try std.testing.expectEqual(@as(u32, 1), view2.getVirtualLineCount());

    view2.deinit();

    try tb.setText("Hello\nWorld");
    try std.testing.expectEqual(@as(u32, 2), view1.getVirtualLineCount());
}

test "TextBufferView automatic updates - with wrapping across buffer changes" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    view.setWrapMode(.char);
    view.setWrapWidth(10);

    try tb.setText("ABCDEFGHIJKLMNOPQRST");
    try std.testing.expectEqual(@as(u32, 2), view.getVirtualLineCount());

    const info1 = view.getCachedLineInfo();
    try std.testing.expectEqual(@as(usize, 2), info1.starts.len);

    try tb.setText("Short");
    try std.testing.expectEqual(@as(u32, 1), view.getVirtualLineCount());

    const info2 = view.getCachedLineInfo();
    try std.testing.expectEqual(@as(usize, 1), info2.starts.len);

    try tb.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    const vline_count = view.getVirtualLineCount();
    try std.testing.expect(vline_count >= 3);

    const info3 = view.getCachedLineInfo();
    try std.testing.expect(info3.starts.len >= 3);
}

test "TextBufferView automatic updates - reset clears content and marks views dirty" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");
    try std.testing.expectEqual(@as(u32, 1), view.getVirtualLineCount());

    tb.reset();
    try std.testing.expectEqual(@as(u32, 1), view.getVirtualLineCount());

    try tb.setText("");
    try std.testing.expectEqual(@as(u32, 1), view.getVirtualLineCount());

    var buffer: [100]u8 = undefined;
    const len = view.getPlainTextIntoBuffer(&buffer);
    try std.testing.expectEqual(@as(usize, 0), len);
}

test "TextBufferView automatic updates - view updates work with selection" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");
    view.setSelection(0, 5, null, null);

    var buffer: [100]u8 = undefined;
    var len = view.getSelectedTextIntoBuffer(&buffer);
    try std.testing.expectEqualStrings("Hello", buffer[0..len]);

    try tb.setText("Hi");

    len = view.getPlainTextIntoBuffer(&buffer);
    try std.testing.expectEqualStrings("Hi", buffer[0..len]);
}

test "TextBufferView automatic updates - multiple views with different wrap settings" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view_nowrap = try TextBufferView.init(std.testing.allocator, tb);
    defer view_nowrap.deinit();

    var view_wrap10 = try TextBufferView.init(std.testing.allocator, tb);
    defer view_wrap10.deinit();
    view_wrap10.setWrapMode(.char);
    view_wrap10.setWrapWidth(10);

    var view_wrap5 = try TextBufferView.init(std.testing.allocator, tb);
    defer view_wrap5.deinit();
    view_wrap5.setWrapMode(.char);
    view_wrap5.setWrapWidth(5);

    try tb.setText("ABCDEFGHIJKLMNOPQRST");

    try std.testing.expectEqual(@as(u32, 1), view_nowrap.getVirtualLineCount());
    try std.testing.expectEqual(@as(u32, 2), view_wrap10.getVirtualLineCount());
    try std.testing.expectEqual(@as(u32, 4), view_wrap5.getVirtualLineCount());
    try tb.setText("Short");

    try std.testing.expectEqual(@as(u32, 1), view_nowrap.getVirtualLineCount());
    try std.testing.expectEqual(@as(u32, 1), view_wrap10.getVirtualLineCount());
    try std.testing.expectEqual(@as(u32, 1), view_wrap5.getVirtualLineCount());

    try tb.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ");

    try std.testing.expectEqual(@as(u32, 1), view_nowrap.getVirtualLineCount());
    try std.testing.expectEqual(@as(u32, 3), view_wrap10.getVirtualLineCount());
    try std.testing.expectEqual(@as(u32, 6), view_wrap5.getVirtualLineCount());
}

test "TextBufferView - tab indicator set and get" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try std.testing.expect(view.getTabIndicator() == null);
    try std.testing.expect(view.getTabIndicatorColor() == null);

    view.setTabIndicator(@as(u32, '·'));
    view.setTabIndicatorColor(RGBA{ 0.4, 0.4, 0.4, 1.0 });

    try std.testing.expectEqual(@as(u32, '·'), view.getTabIndicator().?);
    try std.testing.expectEqual(@as(f32, 0.4), view.getTabIndicatorColor().?[0]);
}

test "TextBufferView findVisualLineIndex - finds correct line for wrapped text" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    // Same text as in the failing test - wraps into 7 virtual lines
    try tb.setText("This is a very long line that will definitely wrap into multiple visual lines when the viewport is small");

    view.setWrapMode(.word);
    view.setWrapWidth(20);

    // Test findVisualLineIndex for various logical columns
    // Column 0 should be in visual line 0
    const idx0 = view.findVisualLineIndex(0, 0);
    try std.testing.expectEqual(@as(u32, 0), idx0);

    // Column 20 should be in visual line 1 (starts at col 20)
    const idx20 = view.findVisualLineIndex(0, 20);
    try std.testing.expectEqual(@as(u32, 1), idx20);

    // Column 35 should be in visual line 2 (starts at col 35)
    const idx35 = view.findVisualLineIndex(0, 35);
    try std.testing.expectEqual(@as(u32, 2), idx35);

    // Column 50 is the last column of visual line 2
    const idx50 = view.findVisualLineIndex(0, 50);
    try std.testing.expectEqual(@as(u32, 2), idx50);

    // Column 51 should be in visual line 3 (starts at col 51)
    const idx51 = view.findVisualLineIndex(0, 51);
    try std.testing.expectEqual(@as(u32, 3), idx51);
}

test "TextBufferView word wrapping - chunk at exact wrap boundary" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const text = "hello world ddddddddd";
    const mem_id = try tb.mem_registry.register(text, false);

    const seg_mod = @import("../text-buffer-segment.zig");
    const Segment = seg_mod.Segment;

    var segments: std.ArrayListUnmanaged(Segment) = .{};
    defer segments.deinit(std.testing.allocator);

    try segments.append(std.testing.allocator, Segment{ .linestart = {} });

    const chunk1 = tb.createChunk(mem_id, 0, 17);
    try segments.append(std.testing.allocator, Segment{ .text = chunk1 });

    const chunk2 = tb.createChunk(mem_id, 17, 21);
    try segments.append(std.testing.allocator, Segment{ .text = chunk2 });

    try tb.rope.setSegments(segments.items);
    view.virtual_lines_dirty = true;

    view.setWrapMode(.word);
    view.setWrapWidth(17);

    const vlines = view.getVirtualLines();

    try std.testing.expectEqual(@as(usize, 2), vlines.len);
    try std.testing.expectEqual(@as(u32, 12), vlines[0].width);
    try std.testing.expectEqual(@as(u32, 9), vlines[1].width);
}
