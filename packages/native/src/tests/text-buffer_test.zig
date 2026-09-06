const std = @import("std");
const text_buffer = @import("../text-buffer.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");
const iter_mod = @import("../text-buffer-iterators.zig");
const TextAttributes = @import("../ansi.zig").TextAttributes;

const TextBuffer = text_buffer.UnifiedTextBuffer;

test "TextBuffer CJK layout cache does not retain replaced dense metadata" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tracking = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    const tb = try TextBuffer.init(tracking.allocator(), pool, link_pool, .unicode);
    defer tb.deinit();
    const view = try @import("../text-buffer-view.zig").TextBufferView.init(tracking.allocator(), tb);
    defer view.deinit();
    view.setWrapMode(.word);
    view.setWrapWidth(80);

    var text = ("\u{65e5}" ** 4096).*;
    const mem_id = try tb.registerMemBuffer(&text, false);
    try tb.setTextFromMemId(mem_id);
    try std.testing.expectEqual(@as(u32, 103), view.getVirtualLineCount());
    const initial_bytes = tracking.allocated_bytes - tracking.freed_bytes;
    for (0..200) |i| {
        @memcpy(text[text.len - 3 ..], if (i % 2 == 0) "\u{672c}" else "\u{65e5}");
        try tb.setTextFromMemId(mem_id);
        try std.testing.expectEqual(@as(u32, 103), view.getVirtualLineCount());
    }
    const final_bytes = tracking.allocated_bytes - tracking.freed_bytes;
    // Persistent rope nodes may grow, but obsolete per-character layouts must not.
    try std.testing.expect(final_bytes - initial_bytes < 1024 * 1024);

    const original_chunk = tb.rope().get(1).?.asText().?;
    const cached_ptr = original_chunk.getCachedLayoutInfo(2, .unicode).?.cjk_breaks.ptr;
    try tb.append("\nx");
    try std.testing.expect(original_chunk.getCachedLayoutInfo(2, .unicode) != null);
    try std.testing.expectEqual(@as(u32, 104), view.getVirtualLineCount());
    try std.testing.expectEqual(cached_ptr, original_chunk.getCachedLayoutInfo(2, .unicode).?.cjk_breaks.ptr);

    try tb.rope().setSegments(&.{ .{ .linestart = {} }, .{ .text = tb.createChunk(mem_id, 0, 6) } });
    tb.markViewsDirty();
    const replacement_chunk = tb.rope().get(1).?.asText().?;
    _ = try tb.getWordLayoutInfoFor(replacement_chunk);
    try std.testing.expectEqual(@as(u32, 1), view.getVirtualLineCount());
    try std.testing.expect(replacement_chunk.cold.?.wrap_breaks != null);
    try std.testing.expect(original_chunk.getCachedLayoutInfo(2, .unicode) == null);
}

test "TextBuffer CJK layout cache survives history and multiple views" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();
    const tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    const TextBufferView = @import("../text-buffer-view.zig").TextBufferView;
    const first = try TextBufferView.init(std.testing.allocator, tb);
    defer first.deinit();
    const second = try TextBufferView.init(std.testing.allocator, tb);
    defer second.deinit();
    first.setWrapMode(.word);
    first.setWrapWidth(80);
    second.setWrapMode(.word);
    second.setWrapWidth(100);

    const original = "\u{65e5}" ** 512;
    const replacement = "\u{672c}" ** 400;
    try tb.setText(original);
    try std.testing.expectEqual(@as(u32, 13), first.getVirtualLineCount());
    const original_chunk = tb.rope().get(1).?.asText().?;
    const cached_ptr = original_chunk.getCachedLayoutInfo(2, .unicode).?.cjk_breaks.ptr;
    try std.testing.expectEqual(@as(u32, 11), second.getVirtualLineCount());
    try std.testing.expectEqual(cached_ptr, original_chunk.getCachedLayoutInfo(2, .unicode).?.cjk_breaks.ptr);
    tb.setTabWidth(4);
    try std.testing.expectEqual(cached_ptr, original_chunk.getCachedLayoutInfo(2, .unicode).?.cjk_breaks.ptr);
    try std.testing.expectEqual(@as(u32, 13), first.getVirtualLineCount());
    try std.testing.expectEqual(cached_ptr, original_chunk.getCachedLayoutInfo(4, .unicode).?.cjk_breaks.ptr);
    tb.setTabWidth(2);
    try tb.rope().store_undo("original");

    try tb.setText(replacement);
    try std.testing.expect(original_chunk.getCachedLayoutInfo(2, .unicode) == null);
    try std.testing.expectEqual(@as(u32, 10), first.getVirtualLineCount());
    try std.testing.expectEqual(@as(u32, 8), second.getVirtualLineCount());
    try std.testing.expectEqualStrings("original", try tb.undo("replacement"));
    tb.markViewsDirty();
    try std.testing.expectEqual(original_chunk, tb.rope().get(1).?.asText().?);

    for ([_]*TextBufferView{ first, second }, [_]u32{ 80, 100 }) |view, width| {
        var byte_offset: u32 = 0;
        for (view.getVirtualLines()) |line| {
            try std.testing.expect(line.width_cols <= width);
            for (line.chunks.items) |chunk| {
                try std.testing.expectEqual(byte_offset, chunk.byte_start_in_chunk);
                const bytes = chunk.chunk.getBytes(tb.memRegistry());
                try std.testing.expectEqualStrings(original[byte_offset..][0..chunk.byte_len], bytes[chunk.byte_start_in_chunk..][0..chunk.byte_len]);
                byte_offset += chunk.byte_len;
            }
        }
        try std.testing.expectEqual(original.len, byte_offset);
    }
    try std.testing.expectEqualStrings("replacement", try tb.redo());
    tb.markViewsDirty();
    try std.testing.expectEqual(@as(u32, 10), first.getVirtualLineCount());
    try std.testing.expectEqual(@as(u32, 8), second.getVirtualLineCount());

    try tb.reset();
    try std.testing.expectEqual(@as(u32, 1), first.getVirtualLineCount());
    try tb.setText(original);
    try std.testing.expectEqual(@as(u32, 11), second.getVirtualLineCount());
    try tb.setStyledText(&.{.{
        .text_ptr = replacement.ptr,
        .text_len = replacement.len,
        .fg_ptr = null,
        .bg_ptr = null,
        .attributes = 0,
    }});
    try std.testing.expectEqual(@as(u32, 10), first.getVirtualLineCount());
    try std.testing.expectEqual(@as(u32, 8), second.getVirtualLineCount());
}

test "TextBuffer init - creates empty buffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try std.testing.expectEqual(@as(u32, 0), tb.getLength());
    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount()); // Empty buffer has 1 empty line (invariant)
}

test "TextBuffer line info - empty buffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("");

    try std.testing.expectEqual(@as(u32, 0), tb.getLength());
    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 1), tb.rope().count());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(tb.rope(), 0, 0).?);
    try std.testing.expectEqual(@as(u32, 0), iter_mod.lineWidthAt(tb.rope(), 0));
}

test "TextBuffer line info - simple text without newlines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const text = "Hello World";
    try tb.setText(text);

    try std.testing.expectEqual(@as(u32, 11), tb.getLength());
    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 2), tb.rope().count());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(tb.rope(), 0, 0).?);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 0) > 0);

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqual(@as(usize, 11), written);
    try std.testing.expectEqualStrings(text, out_buffer[0..written]);
}

test "TextBuffer tab width changes preserve large tab-free Unicode and update one-tab control" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const unit = "OpenTUI text: 世界🙂 ";
    const repeat_count = 4096;
    const tab_free = try std.testing.allocator.alloc(u8, unit.len * repeat_count);
    defer std.testing.allocator.free(tab_free);
    for (0..repeat_count) |i| {
        @memcpy(tab_free[i * unit.len ..][0..unit.len], unit);
    }

    try tb.setText(tab_free);
    try std.testing.expect(!tb.rope().root.metrics().custom.has_tabs);
    const tab_free_width = tb.lineWidthAt(0);
    for (0..40) |i| {
        tb.setTabWidth(if (i % 2 == 0) 4 else 2);
        try std.testing.expectEqual(tab_free_width, tb.lineWidthAt(0));
    }

    const one_tab = try std.testing.allocator.dupe(u8, tab_free);
    defer std.testing.allocator.free(one_tab);
    one_tab[std.mem.indexOfScalar(u8, one_tab, 'x').?] = '\t';
    try tb.setText(one_tab);
    try std.testing.expect(tb.rope().root.metrics().custom.has_tabs);
    for (0..40) |i| {
        tb.setTabWidth(if (i % 2 == 0) 4 else 2);
        try std.testing.expectEqual(tb.measureText(one_tab), tb.lineWidthAt(0));
    }
}

test "TextBuffer line info - single newline" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello\nWorld");

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(tb.rope(), 0, 0).?);
    try std.testing.expectEqual(@as(u32, 6), iter_mod.coordsToOffset(tb.rope(), 1, 0).?);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 0) > 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 1) > 0);
}

test "TextBuffer line info - multiple lines separated by newlines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const text = "Line 1\nLine 2\nLine 3";
    try tb.setText(text);

    try std.testing.expectEqual(@as(u32, 18), tb.getLength());
    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 8), tb.rope().count());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(tb.rope(), 0, 0).?);
    try std.testing.expectEqual(@as(u32, 7), iter_mod.coordsToOffset(tb.rope(), 1, 0).?);
    try std.testing.expectEqual(@as(u32, 14), iter_mod.coordsToOffset(tb.rope(), 2, 0).?);

    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 0) > 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 1) > 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 2) > 0);

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqual(@as(usize, 20), written);
    try std.testing.expectEqualStrings(text, out_buffer[0..written]);
}

test "TextBuffer line info - text ending with newline" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const text = "Line 1\nLine 2\n";
    try tb.setText(text);

    // Trailing newline creates an empty 3rd line (matches editor semantics)
    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 7), tb.rope().count());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(tb.rope(), 0, 0).?);
    try std.testing.expectEqual(@as(u32, 7), iter_mod.coordsToOffset(tb.rope(), 1, 0).?);
    try std.testing.expectEqual(@as(u32, 14), iter_mod.coordsToOffset(tb.rope(), 2, 0).?);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 0) > 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 1) > 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 2) >= 0); // Empty line
}

test "TextBuffer line info - consecutive newlines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Line 1\n\nLine 3");

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(tb.rope(), 0, 0).?);
    try std.testing.expectEqual(@as(u32, 7), iter_mod.coordsToOffset(tb.rope(), 1, 0).?);
    try std.testing.expectEqual(@as(u32, 8), iter_mod.coordsToOffset(tb.rope(), 2, 0).?);
}

test "TextBuffer line info - text starting with newline" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("\nHello World");

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(tb.rope(), 0, 0).?);
    try std.testing.expectEqual(@as(u32, 1), iter_mod.coordsToOffset(tb.rope(), 1, 0).?);
}

test "TextBuffer line info - only newlines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("\n\n\n");

    try std.testing.expectEqual(@as(u32, 4), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(tb.rope(), 0, 0).?);
    try std.testing.expectEqual(@as(u32, 1), iter_mod.coordsToOffset(tb.rope(), 1, 0).?);
    try std.testing.expectEqual(@as(u32, 2), iter_mod.coordsToOffset(tb.rope(), 2, 0).?);
    try std.testing.expectEqual(@as(u32, 3), iter_mod.coordsToOffset(tb.rope(), 3, 0).?);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 0) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 1) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 2) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 3) >= 0);
}

test "TextBuffer line info - wide characters (Unicode)" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const text = "Hello 世界 🌟";
    try tb.setText(text);

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(tb.rope(), 0, 0).?);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 0) > 0);

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings(text, out_buffer[0..written]);
}

test "TextBuffer line info - empty lines between content" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("First\n\nThird");

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(tb.rope(), 0, 0).?);
    try std.testing.expectEqual(@as(u32, 6), iter_mod.coordsToOffset(tb.rope(), 1, 0).?);
    try std.testing.expectEqual(@as(u32, 7), iter_mod.coordsToOffset(tb.rope(), 2, 0).?);
}

test "TextBuffer line info - very long lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    // Create a long text with 1000 'A' characters
    const longText = [_]u8{'A'} ** 1000;
    try tb.setText(&longText);

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(tb.rope(), 0, 0).?);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 0) > 0);
}

test "TextBuffer line info - lines with different widths" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    // Create text with different line lengths
    var text_builder: std.ArrayListUnmanaged(u8) = .empty;
    defer text_builder.deinit(std.testing.allocator);
    try text_builder.appendSlice(std.testing.allocator, "Short\n");
    try text_builder.appendNTimes(std.testing.allocator, 'A', 50);
    try text_builder.appendSlice(std.testing.allocator, "\nMedium");
    const text = text_builder.items;
    try tb.setText(text);

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 0) < iter_mod.lineWidthAt(tb.rope(), 1));
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 1) > iter_mod.lineWidthAt(tb.rope(), 2));
}

test "TextBuffer line info - text without styling" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    // setText now handles all text at once without styling
    try tb.setText("Red\nBlue");

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(tb.rope(), 0, 0).?);
    try std.testing.expectEqual(@as(u32, 4), iter_mod.coordsToOffset(tb.rope(), 1, 0).?);
}

test "TextBuffer line info - buffer with only whitespace" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("   \n \n ");

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(tb.rope(), 0, 0).?);
    try std.testing.expectEqual(@as(u32, 4), iter_mod.coordsToOffset(tb.rope(), 1, 0).?);
    try std.testing.expectEqual(@as(u32, 6), iter_mod.coordsToOffset(tb.rope(), 2, 0).?);

    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 0) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 1) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 2) >= 0);
}

test "TextBuffer line info - single character lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("A\nB\nC");

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(tb.rope(), 0, 0).?);
    try std.testing.expectEqual(@as(u32, 2), iter_mod.coordsToOffset(tb.rope(), 1, 0).?);
    try std.testing.expectEqual(@as(u32, 4), iter_mod.coordsToOffset(tb.rope(), 2, 0).?);

    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 0) > 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 1) > 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 2) > 0);
}

test "TextBuffer line info - mixed content with special characters" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Normal\n123\n!@#\n测试\n");

    try std.testing.expectEqual(@as(u32, 5), tb.getLineCount()); // line_count (4 lines + empty line at end)
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 0) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 1) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 2) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 3) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 4) >= 0);
}

test "TextBuffer line info - buffer resize operations" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    // Create a small buffer that will need to resize

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    // Add text that will cause multiple resizes
    var text_builder: std.ArrayListUnmanaged(u8) = .empty;
    defer text_builder.deinit(std.testing.allocator);
    try text_builder.appendNTimes(std.testing.allocator, 'A', 100);
    try text_builder.appendSlice(std.testing.allocator, "\n");
    try text_builder.appendNTimes(std.testing.allocator, 'B', 100);
    const longText = text_builder.items;
    try tb.setText(longText);

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());
}

test "TextBuffer line info - thousands of lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    // Create text with 1000 lines
    var text_builder: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer text_builder.deinit();

    var i: u32 = 0;
    while (i < 999) : (i += 1) {
        try text_builder.writer.print("Line {}\n", .{i});
    }
    // Last line without newline
    try text_builder.writer.print("Line {}", .{i});

    try tb.setText(text_builder.written());

    try std.testing.expectEqual(@as(u32, 1000), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(tb.rope(), 0, 0).?);

    // Check that line starts are monotonically increasing
    var line_idx: u32 = 1;
    while (line_idx < 1000) : (line_idx += 1) {
        try std.testing.expect(iter_mod.coordsToOffset(tb.rope(), line_idx, 0).? > iter_mod.coordsToOffset(tb.rope(), line_idx - 1, 0).?);
    }
}

test "TextBuffer line info - alternating empty and content lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("\nContent\n\nMore\n\n");

    try std.testing.expectEqual(@as(u32, 6), tb.getLineCount());
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 0) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 1) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 2) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 3) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 4) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 5) >= 0);
}

test "TextBuffer line info - complex Unicode combining characters" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("café\nnaïve\nrésumé");

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 0) > 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 1) > 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 2) > 0);
}

test "TextBuffer line info - simple multi-line text" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Test\nText");

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(tb.rope(), 0, 0).?);
    try std.testing.expectEqual(@as(u32, 5), iter_mod.coordsToOffset(tb.rope(), 1, 0).?);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 0) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 1) >= 0);
}

test "TextBuffer line info - unicode width method" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello 世界 🌟");

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(tb.rope(), 0, 0).?);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 0) > 0);
}

test "TextBuffer line info - unicode mixed content with special characters" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Normal\n123\n!@#\n测试\n");

    try std.testing.expectEqual(@as(u32, 5), tb.getLineCount()); // line_count (4 lines + empty line at end)
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 0) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 1) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 2) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 3) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 4) >= 0);
}

test "TextBuffer line info - unicode text without styling" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    // setText now handles all text at once without styling
    try tb.setText("Red\nBlue");

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(tb.rope(), 0, 0).?);
    try std.testing.expectEqual(@as(u32, 4), iter_mod.coordsToOffset(tb.rope(), 1, 0).?);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 0) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 1) >= 0);
}

test "TextBuffer line info - extremely long single line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    // Create extremely long text with 10000 'A' characters
    const extremelyLongText = [_]u8{'A'} ** 10000;
    try tb.setText(&extremelyLongText);

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(tb.rope(), 0, 0).?);
    try std.testing.expect(iter_mod.lineWidthAt(tb.rope(), 0) > 0);
}

test "TextBuffer unicode - multi-line with extraction" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const text = "Hello 世界\n🚀 Emoji\nΑλφα";
    try tb.setText(text);

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings(text, out_buffer[0..written]);
}

test "TextBuffer reset - clears all content" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Some text\nMore text");
    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());

    try tb.reset();
    try std.testing.expectEqual(@as(u32, 0), tb.getLength());
    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
}

test "TextBuffer line queries - comprehensive rope coordinate checks" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("First\nSecond\nThird");

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());

    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(tb.rope(), 0, 0).?);
    try std.testing.expectEqual(@as(u32, 5), iter_mod.lineWidthAt(tb.rope(), 0));

    try std.testing.expectEqual(@as(u32, 6), iter_mod.coordsToOffset(tb.rope(), 1, 0).?);
    try std.testing.expectEqual(@as(u32, 6), iter_mod.lineWidthAt(tb.rope(), 1));

    try std.testing.expectEqual(@as(u32, 13), iter_mod.coordsToOffset(tb.rope(), 2, 0).?);
    try std.testing.expectEqual(@as(u32, 5), iter_mod.lineWidthAt(tb.rope(), 2));

    try std.testing.expectEqual(@as(u32, 6), iter_mod.getMaxLineWidth(tb.rope()));
}

// ===== View Registration Tests =====

test "TextBuffer view registration - multiple views can be created" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const id1 = try tb.registerView();
    const id2 = try tb.registerView();
    const id3 = try tb.registerView();

    try std.testing.expect(id1 != id2);
    try std.testing.expect(id2 != id3);
    try std.testing.expect(id1 != id3);

    tb.unregisterView(id1);
    tb.unregisterView(id2);
    tb.unregisterView(id3);
}

test "TextBuffer view registration - views marked dirty on setText" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const id1 = try tb.registerView();
    defer tb.unregisterView(id1);

    try std.testing.expect(tb.isViewDirty(id1));

    tb.clearViewDirty(id1);
    try std.testing.expect(!tb.isViewDirty(id1));

    try tb.setText("Hello World");
    try std.testing.expect(tb.isViewDirty(id1));

    tb.clearViewDirty(id1);
    try std.testing.expect(!tb.isViewDirty(id1));

    try tb.setText("New text");
    try std.testing.expect(tb.isViewDirty(id1));
}

test "TextBuffer view registration - views marked dirty on reset" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const id1 = try tb.registerView();
    defer tb.unregisterView(id1);

    tb.clearViewDirty(id1);
    try std.testing.expect(!tb.isViewDirty(id1));

    try tb.reset();
    try std.testing.expect(tb.isViewDirty(id1));
}

test "TextBuffer view registration - ID reuse after unregister" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const id1 = try tb.registerView();
    tb.unregisterView(id1);

    const id2 = try tb.registerView();
    defer tb.unregisterView(id2);

    try std.testing.expectEqual(id1, id2);

    try std.testing.expect(tb.isViewDirty(id2));
}

test "TextBuffer view registration - multiple views all marked dirty on setText" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const id1 = try tb.registerView();
    defer tb.unregisterView(id1);

    const id2 = try tb.registerView();
    defer tb.unregisterView(id2);

    const id3 = try tb.registerView();
    defer tb.unregisterView(id3);

    tb.clearViewDirty(id1);
    tb.clearViewDirty(id2);
    tb.clearViewDirty(id3);

    try std.testing.expect(!tb.isViewDirty(id1));
    try std.testing.expect(!tb.isViewDirty(id2));
    try std.testing.expect(!tb.isViewDirty(id3));

    try tb.setText("Test");

    try std.testing.expect(tb.isViewDirty(id1));
    try std.testing.expect(tb.isViewDirty(id2));
    try std.testing.expect(tb.isViewDirty(id3));
}

// ===== Memory Registry Tests =====

test "TextBuffer memory registry - register and get buffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const text = "Hello World";
    const mem_id = try tb.registerMemBuffer(text, false);

    const retrieved = tb.getMemBuffer(mem_id);
    try std.testing.expect(retrieved != null);
    try std.testing.expectEqualStrings(text, retrieved.?);
}

test "TextBuffer memory registry - multiple buffers" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const text1 = "First buffer";
    const text2 = "Second buffer";
    const text3 = "Third buffer";

    const id1 = try tb.registerMemBuffer(text1, false);
    const id2 = try tb.registerMemBuffer(text2, false);
    const id3 = try tb.registerMemBuffer(text3, false);

    try std.testing.expect(id1 != id2);
    try std.testing.expect(id2 != id3);
    try std.testing.expect(id1 != id3);

    try std.testing.expectEqualStrings(text1, tb.getMemBuffer(id1).?);
    try std.testing.expectEqualStrings(text2, tb.getMemBuffer(id2).?);
    try std.testing.expectEqualStrings(text3, tb.getMemBuffer(id3).?);
}

test "TextBuffer memory registry - invalid ID returns null" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    // Try to get buffer with ID that doesn't exist
    const result = tb.getMemBuffer(99);
    try std.testing.expect(result == null);
}

test "TextBuffer memory registry - addLine from single buffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const text = "Hello World";
    const mem_id = try tb.registerMemBuffer(text, false);

    // Add line from buffer
    try tb.addLine(mem_id, 0, 5); // "Hello"

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 5), tb.getLength());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Hello", out_buffer[0..written]);
}

test "TextBuffer memory registry - addLine from multiple buffers" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const text1 = "First line";
    const text2 = "Second line";
    const text3 = "Third line";

    const id1 = try tb.registerMemBuffer(text1, false);
    const id2 = try tb.registerMemBuffer(text2, false);
    const id3 = try tb.registerMemBuffer(text3, false);

    try tb.addLine(id1, 0, 10);
    try tb.addLine(id2, 0, 11);
    try tb.addLine(id3, 0, 10);

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("First line\nSecond line\nThird line", out_buffer[0..written]);
}

test "TextBuffer memory registry - addLine with invalid mem_id" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    // Try to add line with invalid mem_id
    const result = tb.addLine(99, 0, 5);
    try std.testing.expectError(text_buffer.TextBufferError.InvalidMemId, result);
}

test "TextBuffer memory registry - mixed with setText" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Initial text");
    try std.testing.expectEqual(@as(u32, 12), tb.getLength());

    const text = "New text";
    const mem_id = try tb.registerMemBuffer(text, false);
    try tb.addLine(mem_id, 0, 8);

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());
}

test "TextBuffer memory registry - reset clears memory buffers" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const text = "Hello";
    const mem_id = try tb.registerMemBuffer(text, false);
    try tb.addLine(mem_id, 0, 5);

    try tb.reset();

    // Old mem_id should no longer be valid
    try std.testing.expect(tb.getMemBuffer(mem_id) == null);
    try std.testing.expectEqual(@as(u32, 0), tb.getLength());
}

test "TextBuffer clear - preserves memory buffers" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const text = "Hello World";
    const mem_id = try tb.registerMemBuffer(text, false);
    try tb.addLine(mem_id, 0, 5); // "Hello"

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 5), tb.getLength());

    // Clear should empty the buffer but preserve memory registry
    try tb.clear();

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount()); // Empty buffer has 1 empty line
    try std.testing.expectEqual(@as(u32, 0), tb.getLength());

    // mem_id should still be valid
    const retrieved = tb.getMemBuffer(mem_id);
    try std.testing.expect(retrieved != null);
    try std.testing.expectEqualStrings(text, retrieved.?);

    // We can re-use the same mem_id after clear
    try tb.addLine(mem_id, 6, 11); // "World"
    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 5), tb.getLength());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("World", out_buffer[0..written]);
}

test "TextBuffer setText - preserves previously registered memory buffers" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    // Register a memory buffer
    const old_text = "Previous content";
    const old_mem_id = try tb.registerMemBuffer(old_text, false);

    // Set some text using setText (which now calls clear() not reset())
    try tb.setText("New text content");

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());

    // The old mem_id should still be valid after setText
    const retrieved = tb.getMemBuffer(old_mem_id);
    try std.testing.expect(retrieved != null);
    try std.testing.expectEqualStrings(old_text, retrieved.?);

    // We can still use the old mem_id
    try tb.clear();
    try tb.addLine(old_mem_id, 0, 8); // "Previous"
    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Previous", out_buffer[0..written]);
}

test "TextBuffer setStyledText - preserves previously registered memory buffers" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    // Register a memory buffer before setStyledText
    const preserved_text = "Preserved data";
    const preserved_mem_id = try tb.registerMemBuffer(preserved_text, false);

    // Use setStyledText (which now calls clear() not reset())
    const chunk1_text = "Styled ";
    const chunk2_text = "Text";
    const chunks = [_]text_buffer.StyledChunk{
        .{
            .text_ptr = chunk1_text.ptr,
            .text_len = chunk1_text.len,
            .fg_ptr = null,
            .bg_ptr = null,
            .attributes = 0,
        },
        .{
            .text_ptr = chunk2_text.ptr,
            .text_len = chunk2_text.len,
            .fg_ptr = null,
            .bg_ptr = null,
            .attributes = 0,
        },
    };
    try tb.setStyledText(&chunks);

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());

    // The preserved mem_id should still be valid
    const retrieved = tb.getMemBuffer(preserved_mem_id);
    try std.testing.expect(retrieved != null);
    try std.testing.expectEqualStrings(preserved_text, retrieved.?);

    // We can use the preserved buffer
    try tb.clear();
    try tb.addLine(preserved_mem_id, 0, 9); // "Preserved"
    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Preserved", out_buffer[0..written]);
}

test "TextBuffer clear vs reset - memory registry behavior" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const text = "Test buffer";
    const mem_id = try tb.registerMemBuffer(text, false);
    try tb.addLine(mem_id, 0, 4); // "Test"

    // clear() preserves memory buffers
    try tb.clear();
    try std.testing.expect(tb.getMemBuffer(mem_id) != null);
    try std.testing.expectEqual(@as(u32, 0), tb.getLength());

    // Restore content
    try tb.addLine(mem_id, 5, 11); // "buffer"
    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());

    // reset() clears memory buffers
    try tb.reset();
    try std.testing.expect(tb.getMemBuffer(mem_id) == null);
    try std.testing.expectEqual(@as(u32, 0), tb.getLength());
}

test "TextBuffer memory registry - partial buffer slices" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const full_text = "0123456789ABCDEFGHIJ";
    const mem_id = try tb.registerMemBuffer(full_text, false);

    try tb.addLine(mem_id, 0, 5); // "01234"
    try tb.addLine(mem_id, 5, 10); // "56789"
    try tb.addLine(mem_id, 10, 20); // "ABCDEFGHIJ"

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("01234\n56789\nABCDEFGHIJ", out_buffer[0..written]);
}

test "TextBuffer memory registry - unicode text from buffers" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const text1 = "Hello 世界";
    const text2 = "🌟 Test";

    const id1 = try tb.registerMemBuffer(text1, false);
    const id2 = try tb.registerMemBuffer(text2, false);

    try tb.addLine(id1, 0, @intCast(text1.len));
    try tb.addLine(id2, 0, @intCast(text2.len));

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    const expected = "Hello 世界\n🌟 Test";
    try std.testing.expectEqualStrings(expected, out_buffer[0..written]);
}

test "TextBuffer memory registry - getByteSize with multiple buffers" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const text1 = "Hello"; // 5 bytes
    const text2 = "World"; // 5 bytes

    const id1 = try tb.registerMemBuffer(text1, false);
    const id2 = try tb.registerMemBuffer(text2, false);

    try tb.addLine(id1, 0, 5);
    try tb.addLine(id2, 0, 5);

    const byte_size = tb.getByteSize();
    try std.testing.expectEqual(@as(u32, 11), byte_size);
}

test "TextBuffer memory registry - views marked dirty on addLine" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const view_id = try tb.registerView();
    defer tb.unregisterView(view_id);

    tb.clearViewDirty(view_id);
    try std.testing.expect(!tb.isViewDirty(view_id));

    const text = "Hello";
    const mem_id = try tb.registerMemBuffer(text, false);
    try tb.addLine(mem_id, 0, 5);

    try std.testing.expect(tb.isViewDirty(view_id));
}

test "TextBuffer memory registry - empty chunk handling" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const text = "Hello World";
    const mem_id = try tb.registerMemBuffer(text, false);

    // Add line with empty slice (start == end)
    try tb.addLine(mem_id, 5, 5);

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), tb.getLength());
}

test "TextBuffer memory registry - buffer limit of 255" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    // Register 255 buffers (the maximum for u8)
    var i: u32 = 0;
    while (i < 255) : (i += 1) {
        const text = "Buffer";
        _ = try tb.registerMemBuffer(text, false);
    }

    // Try to register 256th buffer - should fail
    const result = tb.registerMemBuffer("One more", false);
    try std.testing.expectError(text_buffer.TextBufferError.OutOfMemory, result);
}

test "TextBuffer memory registry - owned buffer memory management" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    // Allocate a buffer that the TextBuffer should own and free
    const owned_text = try std.testing.allocator.dupe(u8, "Owned text");
    const mem_id = try tb.registerMemBuffer(owned_text, true);

    try tb.addLine(mem_id, 0, 10);

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());

    // tb.deinit() should free the owned buffer
    // If there's a memory leak, the test allocator will catch it
}

test "TextBuffer memory registry - byte range out of bounds" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const text = "Hello"; // Only 5 bytes
    const mem_id = try tb.registerMemBuffer(text, false);

    // This should panic in debug mode or cause undefined behavior
    // We can't easily test this without catching panics, but we can document it
    // try tb.addLine(mem_id, 0, 100); // Would access out of bounds

    // Test that valid range works
    try tb.addLine(mem_id, 0, 5);
    try std.testing.expectEqual(@as(u32, 5), tb.getLength());
}

test "TextBuffer memory registry - character range highlights across buffers" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const text1 = "Line One";
    const text2 = "Line Two";

    const id1 = try tb.registerMemBuffer(text1, false);
    const id2 = try tb.registerMemBuffer(text2, false);

    try tb.addLine(id1, 0, 8);
    try tb.addLine(id2, 0, 8);

    // Add highlight spanning both lines (from different buffers)
    try tb.addHighlightByCharRange(3, 11, 1, 1, 0);

    const line0_highlights = tb.getLineHighlights(0);
    const line1_highlights = tb.getLineHighlights(1);

    try std.testing.expectEqual(@as(usize, 1), line0_highlights.len);
    try std.testing.expectEqual(@as(usize, 1), line1_highlights.len);
}

test "TextBuffer memory registry - empty buffer registration" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const empty_text = "";
    const mem_id = try tb.registerMemBuffer(empty_text, false);

    const retrieved = tb.getMemBuffer(mem_id);
    try std.testing.expect(retrieved != null);
    try std.testing.expectEqual(@as(usize, 0), retrieved.?.len);
}

test "TextBuffer memory registry - same buffer registered multiple times" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const text = "Shared buffer";

    // Register the same buffer multiple times (different IDs)
    const id1 = try tb.registerMemBuffer(text, false);
    const id2 = try tb.registerMemBuffer(text, false);
    const id3 = try tb.registerMemBuffer(text, false);

    // IDs should be different
    try std.testing.expect(id1 != id2);
    try std.testing.expect(id2 != id3);

    // Use different slices of the same registered buffer
    try tb.addLine(id1, 0, 6); // "Shared"
    try tb.addLine(id2, 7, 13); // "buffer"
    try tb.addLine(id3, 0, 13); // "Shared buffer"

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Shared\nbuffer\nShared buffer", out_buffer[0..written]);
}

// ===== setText SIMD Line Break Tests =====

test "TextBuffer setText - CRLF line endings (Windows)" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Line1\r\nLine2\r\nLine3");

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(tb.rope(), 0, 0).?);
    try std.testing.expectEqual(@as(u32, 6), iter_mod.coordsToOffset(tb.rope(), 1, 0).?);
    try std.testing.expectEqual(@as(u32, 12), iter_mod.coordsToOffset(tb.rope(), 2, 0).?);

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Line1\nLine2\nLine3", out_buffer[0..written]);
}

test "TextBuffer setText - mixed line endings (LF, CRLF, CR)" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Unix\nWindows\r\nOldMac\rEnd");

    try std.testing.expectEqual(@as(u32, 4), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Unix\nWindows\nOldMac\nEnd", out_buffer[0..written]);
}

test "TextBuffer setText - text ending with CRLF" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello World\r\n");

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(tb.rope(), 0, 0).?);
    try std.testing.expectEqual(@as(u32, 12), iter_mod.coordsToOffset(tb.rope(), 1, 0).?);
    try std.testing.expectEqual(@as(u32, 0), iter_mod.lineWidthAt(tb.rope(), 1)); // Empty line
}

test "TextBuffer setText - consecutive CRLF sequences" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Line1\r\n\r\nLine3");

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(tb.rope(), 0, 0).?);
    try std.testing.expectEqual(@as(u32, 6), iter_mod.coordsToOffset(tb.rope(), 1, 0).?);
    try std.testing.expectEqual(@as(u32, 7), iter_mod.coordsToOffset(tb.rope(), 2, 0).?);
}

test "TextBuffer setText - only CRLF sequences" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("\r\n\r\n\r\n");

    try std.testing.expectEqual(@as(u32, 4), tb.getLineCount());

    // All lines should be empty
    for (0..4) |i| {
        try std.testing.expectEqual(@as(u32, 0), iter_mod.lineWidthAt(tb.rope(), @intCast(i)));
    }
}

test "TextBuffer setText - text starting with CRLF" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("\r\nHello World");

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(tb.rope(), 0, 0).?); // Empty first line
    try std.testing.expectEqual(@as(u32, 1), iter_mod.coordsToOffset(tb.rope(), 1, 0).?);
}

test "TextBuffer setText - CR without LF" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Line1\rLine2\rLine3");

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Line1\nLine2\nLine3", out_buffer[0..written]);
}

test "TextBuffer setText - very long line with SIMD processing" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    // Create a text longer than 16 bytes (SIMD vector size) to test SIMD path
    var text_builder: std.ArrayListUnmanaged(u8) = .empty;
    defer text_builder.deinit(std.testing.allocator);

    try text_builder.appendNTimes(std.testing.allocator, 'A', 100);
    try text_builder.appendSlice(std.testing.allocator, "\r\n");
    try text_builder.appendNTimes(std.testing.allocator, 'B', 100);
    try text_builder.appendSlice(std.testing.allocator, "\n");
    try text_builder.appendNTimes(std.testing.allocator, 'C', 100);

    try tb.setText(text_builder.items);

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 100), iter_mod.lineWidthAt(tb.rope(), 0));
    try std.testing.expectEqual(@as(u32, 100), iter_mod.lineWidthAt(tb.rope(), 1));
    try std.testing.expectEqual(@as(u32, 100), iter_mod.lineWidthAt(tb.rope(), 2));
}

test "TextBuffer setText - unicode content with various line endings" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello 世界\r\n🌟 Test\nEnd");

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Hello 世界\n🌟 Test\nEnd", out_buffer[0..written]);
}

test "TextBuffer setText - multiple consecutive different line endings" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    // Mix of \n, \r\n, \r in sequence
    try tb.setText("A\n\r\n\rB");

    // "A", "", "", "B"
    try std.testing.expectEqual(@as(u32, 4), tb.getLineCount());
}

test "TextBuffer setText - SIMD boundary conditions" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    // Create text with newlines at SIMD vector boundaries (16 bytes)
    var text_builder: std.ArrayListUnmanaged(u8) = .empty;
    defer text_builder.deinit(std.testing.allocator);

    // 15 chars + \n = exactly 16 bytes
    try text_builder.appendNTimes(std.testing.allocator, 'X', 15);
    try text_builder.appendSlice(std.testing.allocator, "\n");
    // 15 more chars + \n
    try text_builder.appendNTimes(std.testing.allocator, 'Y', 15);
    try text_builder.appendSlice(std.testing.allocator, "\n");
    // Final line
    try text_builder.appendNTimes(std.testing.allocator, 'Z', 10);

    try tb.setText(text_builder.items);

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 15), iter_mod.lineWidthAt(tb.rope(), 0));
    try std.testing.expectEqual(@as(u32, 15), iter_mod.lineWidthAt(tb.rope(), 1));
    try std.testing.expectEqual(@as(u32, 10), iter_mod.lineWidthAt(tb.rope(), 2));
}

test "TextBuffer setText - CRLF at SIMD boundary" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    // Create text where \r is at end of SIMD vector and \n is at start of next
    var text_builder: std.ArrayListUnmanaged(u8) = .empty;
    defer text_builder.deinit(std.testing.allocator);

    // 15 chars + \r = 16 bytes, then \n at position 16
    try text_builder.appendNTimes(std.testing.allocator, 'A', 15);
    try text_builder.appendSlice(std.testing.allocator, "\r\n");
    try text_builder.appendSlice(std.testing.allocator, "Next line");

    try tb.setText(text_builder.items);

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 15), iter_mod.lineWidthAt(tb.rope(), 0));

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    const expected_len = 15 + 1 + 9;
    try std.testing.expectEqual(expected_len, written);
}

test "TextBuffer setText - line with multiple u16-sized chunks (SKIPPED)" {
    return error.SkipZigTest;
}

test "TextBuffer setText - validate rope structure is correct" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try text_buffer.UnifiedTextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    try tb.setText("Line 1\nLine 2\nLine 3");

    const line_count = tb.lineCount();
    try std.testing.expectEqual(@as(u32, 3), line_count);

    const break_count = tb.rope().markerCount(.brk);
    try std.testing.expectEqual(@as(u32, 2), break_count);

    const linestart_count = tb.rope().markerCount(.linestart);
    try std.testing.expectEqual(@as(u32, 3), linestart_count);

    try std.testing.expectEqual(@as(u32, 6), iter_mod.lineWidthAt(tb.rope(), 0));
    try std.testing.expectEqual(@as(u32, 6), iter_mod.lineWidthAt(tb.rope(), 1));
    try std.testing.expectEqual(@as(u32, 6), iter_mod.lineWidthAt(tb.rope(), 2));

    const total_weight = tb.rope().totalWeight();
    try std.testing.expectEqual(@as(u32, 20), total_weight);
}

test "TextBuffer setText - then deleteRange via EditBuffer - validate markers" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    const edit_buffer = @import("../edit-buffer.zig");
    var eb = try edit_buffer.EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.setText("Line 1\nLine 2\nLine 3");

    try eb.deleteRange(.{ .row = 2, .col = 0 }, .{ .row = 2, .col = 6 });

    var output: [32]u8 = undefined;
    try std.testing.expectEqualStrings("Line 1\nLine 2\n", output[0..eb.getText(&output)]);
    try std.testing.expectEqual(@as(u32, 3), eb.getTextBuffer().lineCount());
    try std.testing.expectEqual(@as(u32, 2), eb.getTextBuffer().rope().markerCount(.brk));
    try std.testing.expectEqual(@as(u32, 3), eb.getTextBuffer().rope().markerCount(.linestart));
    try std.testing.expectEqual(@as(u32, 0), eb.getTextBuffer().lineWidthAt(2));
}

const PlainTextOperation = enum { set, from_mem, with_undo, replace_new, replace_slot, owned_new, owned_slot };

fn runPlainTextOperation(tb: *TextBuffer, operation: PlainTextOperation, text: []const u8, mem_id: u8, owned: bool) !u8 {
    switch (operation) {
        .set => try tb.setText(text),
        .from_mem => try tb.setTextFromMemId(mem_id),
        .with_undo => try tb.setTextFromMemIdWithUndo(mem_id, "replacement metadata"),
        .replace_new, .replace_slot => {
            return tb.replaceText(text, if (operation == .replace_slot) mem_id else null, owned);
        },
        .owned_new, .owned_slot => {
            return tb.replaceOwnedText(text, if (operation == .owned_slot) mem_id else null);
        },
    }
    return mem_id;
}

fn setupPlainTextHistory(tb: *TextBuffer, style: *text_buffer.SyntaxStyle) !void {
    tb.setSyntaxStyle(style);
    try tb.setStyledText(&.{.{
        .text_ptr = "old\ttext\nsecond".ptr,
        .text_len = "old\ttext\nsecond".len,
        .fg_ptr = null,
        .bg_ptr = null,
        .attributes = 0,
        .link_ptr = "https://example.com/plain".ptr,
        .link_len = "https://example.com/plain".len,
    }});
    try tb.rope().store_undo("base");
    try tb.append(" tail");
    try tb.rope().store_undo("tail");
    try tb.append("!");
    _ = try tb.undo("last");
    try tb.addHighlight(0, 2, 4, 42, 2, 7);
    try tb.addHighlight(1, 0, 2, 43, 2, 8);
}

test "TextBuffer plain replacement registration limit preserves the live document" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const style = try text_buffer.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    const tb = try TextBuffer.init(std.testing.allocator, &pool, &links, .unicode);
    defer tb.deinit();
    try setupPlainTextHistory(tb, style);
    while (tb.mem_registry.buffers.items.len < 255) _ = try tb.registerMemBuffer("spare", false);
    const view = try tb.registerView();
    tb.clearViewDirty(view);
    const old_rope = tb.rope().*;
    const old_epoch = tb.getContentEpoch();
    const old_highlights = tb.getHighlightCount();
    const old_links = tb.link_tracker.?.used_ids.count();
    try std.testing.expectError(error.OutOfMemory, tb.setText("rejected"));
    try std.testing.expectEqual(old_rope.root, tb.rope().root);
    try std.testing.expectEqual(old_rope.version, tb.rope().version);
    try std.testing.expectEqual(old_rope.undo_history, tb.rope().undo_history);
    try std.testing.expectEqual(old_rope.redo_history, tb.rope().redo_history);
    try std.testing.expectEqual(old_epoch, tb.getContentEpoch());
    try std.testing.expectEqual(old_highlights, tb.getHighlightCount());
    try std.testing.expectEqual(old_links, tb.link_tracker.?.used_ids.count());
    try std.testing.expect(!tb.isViewDirty(view));
}

const TextState = struct {
    text: [512]u8 = @splat(0),
    text_len: usize = 0,
    epoch: u64,
    lines: u32,
    highlights: u32,
    line_highlights: [2][8]text_buffer.Highlight = std.mem.zeroes([2][8]text_buffer.Highlight),
    line_spans: [2][8]text_buffer.StyleSpan = std.mem.zeroes([2][8]text_buffer.StyleSpan),
    span_counts: [2]usize = @splat(0),
    slots: usize,
    links: u32,
    style: ?*const text_buffer.SyntaxStyle,
    undo_depth: usize,

    fn capture(tb: *TextBuffer) TextState {
        var result: TextState = .{
            .epoch = tb.getContentEpoch(),
            .lines = tb.getLineCount(),
            .highlights = tb.getHighlightCount(),
            .slots = tb.memRegistry().getUsedSlots(),
            .links = if (tb.link_tracker) |*tracker| tracker.getLinkCount() else 0,
            .style = tb.getSyntaxStyle(),
            .undo_depth = tb.rope().undo_depth,
        };
        result.text_len = tb.getPlainTextIntoBuffer(&result.text);
        std.debug.assert(result.text_len < result.text.len);
        std.debug.assert(result.lines <= result.line_highlights.len);
        for (0..result.lines) |row| {
            const highlights = tb.getLineHighlights(row);
            const spans = tb.getLineSpans(row);
            std.debug.assert(highlights.len <= result.line_highlights[row].len);
            std.debug.assert(spans.len <= result.line_spans[row].len);
            @memcpy(result.line_highlights[row][0..highlights.len], highlights);
            @memcpy(result.line_spans[row][0..spans.len], spans);
            result.span_counts[row] = spans.len;
        }
        return result;
    }
};

fn checkPlainTextAllocationFailures(operation: PlainTextOperation) !void {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const style = try text_buffer.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    const owned = operation == .owned_new or operation == .owned_slot;
    for ([_][]const u8{ "replacement\t\u{754c}\n" ** 8, "" }) |input| {
        for ([_]bool{ false, true }) |fail_rope| {
            if (owned and fail_rope) continue;
            var succeeded = false;
            for (0..128) |offset| {
                var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
                const tb = try TextBuffer.init(failing.allocator(), &pool, &links, .unicode);
                defer tb.deinit();
                try setupPlainTextHistory(tb, style);
                const mem_id = switch (operation) {
                    .replace_slot, .owned_slot => tb.styled_text_mem_id.?,
                    .from_mem, .with_undo => try tb.registerMemBuffer(input, false),
                    else => 0,
                };
                const bytes = if (owned) try failing.allocator().dupe(u8, input) else input;
                var transferred = false;
                defer if (owned and !transferred) failing.allocator().free(bytes);
                const view = try tb.registerView();
                tb.clearViewDirty(view);
                const before = TextState.capture(tb);
                const capacity = tb.getArenaAllocatedBytes();
                const allocator = tb.rope().allocator;
                var rope_failing = std.testing.FailingAllocator.init(allocator, .{});
                tb.rope().allocator = rope_failing.allocator();
                defer tb.rope().allocator = allocator;
                const fault = if (fail_rope) &rope_failing else &failing;
                fault.fail_index = fault.alloc_index + offset;
                fault.resize_fail_index = fault.resize_index;
                const result = runPlainTextOperation(tb, operation, bytes, mem_id, owned);
                fault.fail_index = std.math.maxInt(usize);
                fault.resize_fail_index = std.math.maxInt(usize);
                if (result) |_| {
                    transferred = owned;
                    succeeded = true;
                } else |err| {
                    try std.testing.expectEqual(error.OutOfMemory, err);
                    try std.testing.expect(fault.has_induced_failure);
                    try std.testing.expectEqualDeep(before, TextState.capture(tb));
                    try std.testing.expect(!tb.isViewDirty(view));
                    if (owned) try std.testing.expectEqual(capacity, tb.getArenaAllocatedBytes());
                    try std.testing.expectEqualStrings("last", try tb.redo());
                    try std.testing.expectEqualStrings("tail", try tb.undo("last"));
                    continue;
                }
                var actual: [512]u8 = undefined;
                try std.testing.expectEqualStrings(input, actual[0..tb.getPlainTextIntoBuffer(&actual)]);
                try std.testing.expectEqual(before.epoch + 1, tb.getContentEpoch());
                try std.testing.expect(tb.isViewDirty(view));
                try std.testing.expectEqual(@as(u32, 0), tb.link_tracker.?.getLinkCount());
                if (operation == .with_undo) {
                    try std.testing.expectEqualStrings("replacement metadata", try tb.undo("accepted"));
                    try std.testing.expectEqualStrings(before.text[0..before.text_len], actual[0..tb.getPlainTextIntoBuffer(&actual)]);
                } else if (operation != .set and operation != .from_mem) {
                    try std.testing.expect(!tb.rope().can_undo() and !tb.rope().can_redo());
                }
                break;
            }
            try std.testing.expect(succeeded);
        }
    }
}

test "TextBuffer plain replacement setText allocation failures" {
    try checkPlainTextAllocationFailures(.set);
}

test "TextBuffer plain replacement FromMemId allocation failures" {
    try checkPlainTextAllocationFailures(.from_mem);
}

test "TextBuffer plain replacement WithUndo allocation failures" {
    try checkPlainTextAllocationFailures(.with_undo);
}

test "TextBuffer plain replacement new and reused slots allocation failures" {
    try checkPlainTextAllocationFailures(.replace_new);
    try checkPlainTextAllocationFailures(.replace_slot);
}

test "TextBuffer owned replacement allocation failures preserve arena and document" {
    try checkPlainTextAllocationFailures(.owned_new);
    try checkPlainTextAllocationFailures(.owned_slot);
}

fn replaceOwnedStyledForTest(
    tb: *TextBuffer,
    text: []const u8,
    mem_id: ?u8,
    byte_counts: []const u32,
    url: []const u8,
) !struct { mem_id: u8, style: *text_buffer.SyntaxStyle, link_id: u32 } {
    const style = try text_buffer.SyntaxStyle.init(tb.global_allocator);
    errdefer style.deinit();
    var prepared_links = link.LinkTracker.init(tb.global_allocator, tb.link_pool);
    defer prepared_links.deinit();
    var link_id: u32 = 0;
    const chunks = try tb.global_allocator.alloc(text_buffer.OwnedStyledChunk, byte_counts.len);
    defer tb.global_allocator.free(chunks);
    for (byte_counts, 0..) |byte_count, i| {
        var name_buffer: [32]u8 = undefined;
        const name = try std.fmt.bufPrint(&name_buffer, "chunk{d}", .{i});
        link_id = try prepared_links.trackUrl(url);
        chunks[i] = .{
            .byte_count = byte_count,
            .style_id = try style.registerStyle(name, null, null, TextAttributes.setLinkId(@intCast(i + 1), link_id)),
        };
    }
    return .{
        .mem_id = try tb.replaceOwnedStyledText(text, mem_id, style, chunks, &prepared_links),
        .style = style,
        .link_id = link_id,
    };
}

test "TextBuffer owned styled replacement preserves accepted linked content on allocation failure" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    for ([_]bool{ false, true }) |reuse| {
        var succeeded = false;
        for (0..128) |offset| {
            var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
            const allocator = failing.allocator();
            var links = link.LinkPool.init(allocator);
            defer links.deinit();
            const tb = try TextBuffer.init(allocator, &pool, &links, .unicode);
            defer tb.deinit();
            const old_bytes = try allocator.dupe(u8, "accepted");
            const old = try replaceOwnedStyledForTest(tb, old_bytes, null, &.{8}, "https://old.test");
            defer old.style.deinit();
            const before = TextState.capture(tb);
            const arena = tb.getArenaAllocatedBytes();
            const copy = try allocator.dupe(u8, "new\nlinked");
            var transferred = false;
            defer if (!transferred) allocator.free(copy);
            failing.fail_index = failing.alloc_index + offset;
            failing.resize_fail_index = failing.resize_index;
            const result = replaceOwnedStyledForTest(tb, copy, if (reuse) old.mem_id else null, &.{ 4, 6 }, "https://new.test");
            failing.fail_index = std.math.maxInt(usize);
            failing.resize_fail_index = std.math.maxInt(usize);
            if (result) |accepted| {
                transferred = true;
                defer accepted.style.deinit();
                try std.testing.expectEqual(@as(u32, 0), try links.getRefcount(old.link_id));
                try std.testing.expectEqual(@as(u32, 1), try links.getRefcount(accepted.link_id));
                try std.testing.expectEqual(@as(usize, 0), old.style.emitter.listeners.get(.Destroy).?.items.len);
                try std.testing.expectEqual(@as(usize, 1), accepted.style.emitter.listeners.get(.Destroy).?.items.len);
                try std.testing.expectEqual(copy.ptr, tb.getMemBuffer(accepted.mem_id).?.ptr);
                var actual: [32]u8 = undefined;
                try std.testing.expectEqualStrings(copy, actual[0..tb.getPlainTextIntoBuffer(&actual)]);
                succeeded = true;
                break;
            } else |err| {
                try std.testing.expectEqual(error.OutOfMemory, err);
                try std.testing.expect(failing.has_induced_failure);
                try std.testing.expectEqualDeep(before, TextState.capture(tb));
                try std.testing.expectEqual(arena, tb.getArenaAllocatedBytes());
                try std.testing.expectEqual(@as(u64, 1), links.getLiveSlotCount());
                try std.testing.expectEqual(@as(u32, 1), try links.getRefcount(old.link_id));
                try std.testing.expectEqual(@as(usize, 1), old.style.emitter.listeners.get(.Destroy).?.items.len);
                try std.testing.expectEqualStrings("new\nlinked", copy);
            }
        }
        try std.testing.expect(succeeded);
    }
}

test "TextBuffer owned styled replacement reserves the permanent listener before publication" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const tb = try TextBuffer.init(std.testing.allocator, &pool, &links, .unicode);
    defer tb.deinit();
    const old_copy = try std.testing.allocator.dupe(u8, "accepted");
    const old = try replaceOwnedStyledForTest(tb, old_copy, null, &.{8}, "https://example.com/old");
    defer old.style.deinit();
    const style = try text_buffer.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    var prepared_links = link.LinkTracker.init(std.testing.allocator, &links);
    defer prepared_links.deinit();
    const link_id = try prepared_links.trackUrl("https://example.com/new");
    const id = try style.registerStyle("new", null, null, TextAttributes.setLinkId(2, link_id));
    const candidate_links = prepared_links;
    const copy = try std.testing.allocator.dupe(u8, "replacement\nnext");
    var transferred = false;
    defer if (!transferred) std.testing.allocator.free(copy);
    const root = tb.rope().root;
    const epoch = tb.getContentEpoch();
    const allocator = style.emitter.allocator;
    var failing = std.testing.FailingAllocator.init(allocator, .{ .fail_index = 0 });
    style.emitter.allocator = failing.allocator();
    defer style.emitter.allocator = allocator;
    try std.testing.expectError(error.OutOfMemory, tb.replaceOwnedStyledText(copy, old.mem_id, style, &.{.{
        .byte_count = @intCast(copy.len),
        .style_id = id,
    }}, &prepared_links));
    try std.testing.expect(failing.has_induced_failure);
    try std.testing.expectEqual(root, tb.rope().root);
    try std.testing.expectEqual(epoch, tb.getContentEpoch());
    try std.testing.expectEqual(old.style, tb.getSyntaxStyle().?);
    try std.testing.expectEqualDeep(candidate_links, prepared_links);
    try std.testing.expectEqual(@as(u32, 1), tb.link_tracker.?.getLinkCount());
    try std.testing.expect(tb.link_tracker.?.used_ids.contains(old.link_id));
    try std.testing.expectEqual(@as(u32, 1), try links.getRefcount(old.link_id));
    try std.testing.expectEqual(@as(u32, 1), try links.getRefcount(link_id));
    try std.testing.expectEqual(@as(usize, 1), old.style.emitter.listeners.get(.Destroy).?.items.len);
    try std.testing.expectEqual(@as(usize, 0), style.emitter.listeners.get(.Destroy).?.items.len);
    var actual: [32]u8 = undefined;
    try std.testing.expectEqualStrings("accepted", actual[0..tb.getPlainTextIntoBuffer(&actual)]);
    style.emitter.allocator = allocator;
    try std.testing.expectEqual(old.mem_id, try tb.replaceOwnedStyledText(copy, old.mem_id, style, &.{.{
        .byte_count = @intCast(copy.len),
        .style_id = id,
    }}, &prepared_links));
    transferred = true;
    try std.testing.expectEqual(@as(u32, 0), prepared_links.getLinkCount());
    try std.testing.expectEqual(@as(u32, 1), tb.link_tracker.?.getLinkCount());
    try std.testing.expect(tb.link_tracker.?.used_ids.contains(link_id));
    try std.testing.expectEqual(@as(u32, 0), try links.getRefcount(old.link_id));
    try std.testing.expectEqual(@as(u32, 1), try links.getRefcount(link_id));
    try std.testing.expectEqual(style, tb.getSyntaxStyle().?);
    try std.testing.expectEqual(@as(usize, 0), old.style.emitter.listeners.get(.Destroy).?.items.len);
    try std.testing.expectEqual(@as(usize, 1), style.emitter.listeners.get(.Destroy).?.items.len);
}

test "TextBuffer prepared styled replacement abort detaches only the candidate and commit does not allocate" {
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    const allocator = failing.allocator();
    var pool = gp.GraphemePool.init(allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(allocator);
    defer links.deinit();
    const tb = try TextBuffer.init(allocator, &pool, &links, .unicode);
    defer tb.deinit();
    const old_copy = try allocator.dupe(u8, "accepted");
    const old = try replaceOwnedStyledForTest(tb, old_copy, null, &.{8}, "https://example.test/old");
    defer old.style.deinit();
    const epoch = tb.getContentEpoch();
    const copy = try allocator.dupe(u8, "next");
    var transferred = false;
    defer if (!transferred) allocator.free(copy);
    const style = try text_buffer.SyntaxStyle.init(allocator);
    defer style.deinit();
    const chunks = [_]text_buffer.OwnedStyledChunk{.{ .byte_count = 4, .style_id = 0 }};
    var prepared: TextBuffer.PreparedOwnedStyledText = undefined;
    try tb.prepareOwnedStyledText(&prepared, copy, old.mem_id, style, &chunks, null, null);
    try std.testing.expectEqual(epoch, tb.getContentEpoch());
    try std.testing.expectEqual(old.style, tb.getSyntaxStyle().?);
    prepared.deinit();
    try std.testing.expectEqual(@as(usize, 0), style.emitter.listeners.get(.Destroy).?.items.len);
    try std.testing.expectEqual(@as(usize, 1), old.style.emitter.listeners.get(.Destroy).?.items.len);
    try std.testing.expectEqual(old.style, tb.getSyntaxStyle().?);
    try tb.prepareOwnedStyledText(&prepared, copy, old.mem_id, style, &chunks, null, null);
    defer prepared.deinit();
    const allocations = failing.alloc_index;
    const resizes = failing.resize_index;
    failing.fail_index = allocations;
    failing.resize_fail_index = resizes;
    try std.testing.expectEqual(old.mem_id, prepared.commit());
    transferred = true;
    try std.testing.expectEqual(allocations, failing.alloc_index);
    try std.testing.expectEqual(resizes, failing.resize_index);
    try std.testing.expect(!failing.has_induced_failure);
    try std.testing.expectEqual(style, tb.getSyntaxStyle().?);
    try std.testing.expectEqual(epoch + 1, tb.getContentEpoch());
}

test "TextBuffer owned styled replacement rejects unowned and foreign links without consuming inputs" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const tb = try TextBuffer.init(std.testing.allocator, &pool, &links, .unicode);
    defer tb.deinit();
    const old_copy = try std.testing.allocator.dupe(u8, "accepted");
    const old = try replaceOwnedStyledForTest(tb, old_copy, null, &.{8}, "https://example.com/old");
    defer old.style.deinit();
    const old_root = tb.rope().root;
    const epoch = tb.getContentEpoch();
    const copy = try std.testing.allocator.dupe(u8, "new");
    defer std.testing.allocator.free(copy);
    const style = try text_buffer.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    var prepared = link.LinkTracker.init(std.testing.allocator, &links);
    defer prepared.deinit();
    const id = try prepared.trackUrl("https://example.com/new");
    const style_id = try style.registerStyle("new", null, null, TextAttributes.setLinkId(0, id));
    const chunks = [_]text_buffer.OwnedStyledChunk{.{ .byte_count = 3, .style_id = style_id }};

    try std.testing.expectError(error.InvalidId, tb.replaceOwnedStyledText(copy, old.mem_id, style, &chunks, null));
    var empty = link.LinkTracker.init(std.testing.allocator, &links);
    defer empty.deinit();
    try std.testing.expectError(error.InvalidId, tb.replaceOwnedStyledText(copy, old.mem_id, style, &chunks, &empty));
    var other_pool = link.LinkPool.init(std.testing.allocator);
    defer other_pool.deinit();
    var foreign = link.LinkTracker.init(std.testing.allocator, &other_pool);
    defer foreign.deinit();
    _ = try foreign.trackUrl("https://example.com/new");
    try std.testing.expectError(error.InvalidId, tb.replaceOwnedStyledText(copy, old.mem_id, style, &chunks, &foreign));
    try std.testing.expectEqual(@as(u32, 1), foreign.getLinkCount());

    _ = try style.registerStyle("new", null, null, TextAttributes.setLinkId(0, old.link_id));
    try std.testing.expectError(error.InvalidId, tb.replaceOwnedStyledText(copy, old.mem_id, style, &chunks, &tb.link_tracker.?));
    _ = try style.registerStyle("new", null, null, TextAttributes.setLinkId(0, id));
    prepared.used_ids.getPtr(id).?.* = 0;
    try std.testing.expectError(error.InvalidId, tb.replaceOwnedStyledText(copy, old.mem_id, style, &chunks, &prepared));
    try std.testing.expectEqual(@as(u32, 0), prepared.used_ids.get(id).?);
    prepared.used_ids.getPtr(id).?.* = 1;
    try links.decref(id);
    try std.testing.expectError(error.InvalidId, tb.replaceOwnedStyledText(copy, old.mem_id, style, &chunks, &prepared));
    try std.testing.expectEqual(@as(u32, 1), prepared.used_ids.get(id).?);
    _ = prepared.used_ids.remove(id);

    try std.testing.expectEqual(old_root, tb.rope().root);
    try std.testing.expectEqual(epoch, tb.getContentEpoch());
    try std.testing.expectEqual(old.style, tb.getSyntaxStyle().?);
    try std.testing.expectEqual(@as(u32, 1), tb.link_tracker.?.getLinkCount());
    try std.testing.expectEqual(@as(u32, 1), try links.getRefcount(old.link_id));
    try std.testing.expectEqual(@as(u64, 1), links.getLiveSlotCount());
    try std.testing.expectEqual(@as(usize, 1), tb.mem_registry.getUsedSlots());
    try std.testing.expectEqual(@as(usize, 1), style.getStyleCount());
    try std.testing.expectEqualStrings("new", copy);
}

test "TextBuffer owned styled replacement matches concatenated chunk ranges" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const cases = [_][]const []const u8{
        &.{ "\u{1f469}", "\u{200d}\u{1f4bb}", "WXYZ" },
        &.{ "e", "\u{301}X", "Y" },
        &.{ "\u{4e16}", "\t", "B\r", "\nC" },
        &.{ "a\r\nb\rc\nd", "\n", "tail" },
        &.{ "\u{301}", "\n", "word" },
        &.{ "\u{2764}", "\u{fe0f}", "xyz" },
        &.{ "\u{1f1fa}", "\u{1f1f8}", "xyz" },
    };
    for ([_]@import("../utf8.zig").WidthMethod{ .unicode, .wcwidth, .no_zwj, .unicode_wide }) |method| {
        for (cases) |parts| {
            const legacy_style = try text_buffer.SyntaxStyle.init(std.testing.allocator);
            defer legacy_style.deinit();
            const legacy = try TextBuffer.init(std.testing.allocator, &pool, &links, method);
            defer legacy.deinit();
            legacy.setSyntaxStyle(legacy_style);
            const style = try text_buffer.SyntaxStyle.init(std.testing.allocator);
            defer style.deinit();
            const tb = try TextBuffer.init(std.testing.allocator, &pool, &links, method);
            defer tb.deinit();
            const copy = try std.mem.concat(std.testing.allocator, u8, parts);
            var width_cursor = @import("../utf8.zig").TextWidthCursor{
                .text = copy,
                .tab_width = tb.tabWidth(),
                .width_method = method,
            };
            var legacy_chunks: [4]text_buffer.StyledChunk = undefined;
            var chunks: [4]text_buffer.OwnedStyledChunk = undefined;
            var byte_end: usize = 0;
            for (parts, 0..) |part, i| {
                const attributes: u32 = @intCast(i + 1);
                legacy_chunks[i] = .{
                    .text_ptr = part.ptr,
                    .text_len = part.len,
                    .fg_ptr = null,
                    .bg_ptr = null,
                    .attributes = attributes,
                };
                const char_pos = width_cursor.columns;
                byte_end += part.len;
                const char_end = width_cursor.advanceTo(byte_end);
                var name_buffer: [32]u8 = undefined;
                const name = try std.fmt.bufPrint(&name_buffer, "chunk{d}", .{i});
                chunks[i] = .{
                    .byte_count = @intCast(part.len),
                    .style_id = if (char_end == char_pos) 0 else try style.registerStyle(name, null, null, attributes),
                };
            }
            try legacy.setStyledText(legacy_chunks[0..parts.len]);
            _ = tb.replaceOwnedStyledText(copy, null, style, chunks[0..parts.len], null) catch |err| {
                std.testing.allocator.free(copy);
                return err;
            };
            try std.testing.expectEqual(legacy.getLength(), tb.getLength());
            try std.testing.expectEqual(legacy.getLineCount(), tb.getLineCount());
            var expected: [64]u8 = undefined;
            var actual: [64]u8 = undefined;
            try std.testing.expectEqualStrings(expected[0..legacy.getPlainTextIntoBuffer(&expected)], actual[0..tb.getPlainTextIntoBuffer(&actual)]);
            for (0..tb.getLineCount()) |line| {
                try std.testing.expectEqualDeep(legacy.getLineHighlights(line), tb.getLineHighlights(line));
                try std.testing.expectEqualDeep(legacy.getLineSpans(line), tb.getLineSpans(line));
            }
        }
    }
}

test "TextBuffer owned styled replacement reclaims styled plain and empty transitions" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    var tracked = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    const allocator = tracked.allocator();
    const tb = try TextBuffer.init(allocator, &pool, &links, .unicode);
    defer tb.deinit();
    var mem_id: ?u8 = null;
    var style: ?*text_buffer.SyntaxStyle = null;
    defer if (style) |value| value.deinit();
    var retained: [5]usize = undefined;
    for (0..8) |iteration| {
        for ([_]struct { text: []const u8, styled: bool }{
            .{ .text = "word\t\u{754c}e\u{301}\n" ** 32, .styled = true },
            .{ .text = "x", .styled = true },
            .{ .text = "", .styled = false },
            .{ .text = "plain", .styled = false },
            .{ .text = "", .styled = true },
        }, 0..) |case, index| {
            const copy = try allocator.dupe(u8, case.text);
            var transferred = false;
            defer if (!transferred) allocator.free(copy);
            const previous = style;
            if (case.styled) {
                const sizes = [_]u32{@intCast(copy.len)};
                const accepted = try replaceOwnedStyledForTest(tb, copy, mem_id, sizes[0..@intFromBool(copy.len > 0)], "https://example.com/transition");
                mem_id = accepted.mem_id;
                style = accepted.style;
            } else {
                mem_id = try tb.replaceOwnedText(copy, mem_id);
                tb.setSyntaxStyle(null);
                style = null;
                try std.testing.expectEqual(@as(u32, 0), tb.getHighlightCount());
                for (tb.line_spans.items) |list| try std.testing.expectEqual(@as(usize, 0), list.items.len);
            }
            transferred = true;
            if (previous) |value| {
                try std.testing.expectEqual(@as(usize, 0), value.emitter.listeners.get(.Destroy).?.items.len);
                value.deinit();
            }
            try std.testing.expectEqual(style, tb.getSyntaxStyle());
            const link_count: u32 = @intFromBool(case.styled and copy.len > 0);
            try std.testing.expectEqual(link_count, tb.link_tracker.?.getLinkCount());
            try std.testing.expectEqual(link_count, links.getLiveSlotCount());
            try std.testing.expectEqual(link_count, links.interned_live_ids.count());
            try std.testing.expectEqual(@as(usize, 1), tb.mem_registry.getUsedSlots());
            try std.testing.expectEqual(@as(usize, 1), tb.mem_registry.buffers.items.len);
            for (0..tb.rope().count()) |segment| {
                if (tb.rope().get(@intCast(segment)).?.asText()) |chunk| {
                    _ = try tb.getLayoutInfoFor(chunk);
                    _ = try chunk.getRenderClusters(tb.getAllocator(), tb.memRegistry(), tb.tabWidth(), tb.widthMethod());
                }
            }
            const live = tracked.allocated_bytes - tracked.freed_bytes;
            if (iteration == 0) retained[index] = live else try std.testing.expectEqual(retained[index], live);
        }
    }
}

test "TextBuffer plain replacement reuses full registry and recovers an absent preferred slot" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const tb = try TextBuffer.init(std.testing.allocator, &pool, &links, .unicode);
    defer tb.deinit();
    const owned = try std.testing.allocator.dupe(u8, "old");
    const id = try tb.registerMemBuffer(owned, true);
    try tb.setTextFromMemId(id);
    try tb.rope().store_undo("owned history");
    while (tb.mem_registry.buffers.items.len < 255) _ = try tb.registerMemBuffer("spare", false);
    const old_root = tb.rope().root;
    try std.testing.expectError(error.InvalidMemId, tb.setTextFromMemId(255));
    try std.testing.expectError(error.InvalidMemId, tb.replaceText(owned[1..], id, false));
    try std.testing.expectError(error.OutOfMemory, tb.replaceText("new slot", null, false));
    try std.testing.expectEqual(old_root, tb.rope().root);
    try std.testing.expect(tb.rope().can_undo());
    for ([_][]const u8{ owned[1..1], "longer\t\u{754c}", "\u{1f31f}", "", "\n" }) |input| {
        try std.testing.expectEqual(id, try tb.replaceText(input, id, false));
        var actual: [32]u8 = undefined;
        try std.testing.expectEqualStrings(input, actual[0..tb.getPlainTextIntoBuffer(&actual)]);
        if (input.len == 0) try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
        try std.testing.expectEqualStrings("spare", tb.getMemBuffer(254).?);
        try std.testing.expectEqual(@as(usize, 255), tb.mem_registry.getUsedSlots());
        try std.testing.expect(!tb.rope().can_undo());
    }
    try tb.reset();
    try std.testing.expectError(error.InvalidMemId, tb.setTextFromMemId(id));
    try std.testing.expectEqual(@as(u8, 0), try tb.replaceText("after reset", id, false));
    try std.testing.expectEqual(@as(u8, 1), try tb.replaceText("absent", 254, false));
}

test "TextBuffer plain replacement textToSegments measures supplied bytes with insertion offset" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const tb = try TextBuffer.init(std.testing.allocator, &pool, &links, .unicode);
    defer tb.deinit();
    const input = "\u{754c}\t\n\u{1f31f}";
    const id = try tb.registerMemBuffer("prefix" ++ input, false);
    var parsed = try tb.textToSegments(std.testing.allocator, input, id, 6, true);
    defer parsed.segments.deinit(std.testing.allocator);
    try tb.rope().setSegments(parsed.segments.items);
    var actual: [32]u8 = undefined;
    try std.testing.expectEqualStrings(input, actual[0..tb.getPlainTextIntoBuffer(&actual)]);
    try std.testing.expectEqual(@as(u32, 4), tb.lineWidthAt(0));
    try std.testing.expectEqual(@as(u32, 2), tb.lineWidthAt(1));
    try std.testing.expectEqual(@as(u32, 6), parsed.segments.items[1].text.byte_start);
    try std.testing.expectEqual(tb.createChunk(id, 6, 10), parsed.segments.items[1].text);
}

test "TextBuffer clear and reset retire multipage links without pool allocation" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    const style = try text_buffer.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    for ([_]bool{ false, true }) |reset| {
        var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        var links = link.LinkPool.init(failing.allocator());
        defer links.deinit();
        const tb = try TextBuffer.init(std.testing.allocator, &pool, &links, .unicode);
        defer tb.deinit();
        tb.setSyntaxStyle(style);
        var urls: [130][64]u8 = undefined;
        var chunks: [130]text_buffer.StyledChunk = undefined;
        for (&chunks, &urls, 0..) |*chunk, *url_buffer, index| {
            const url = try std.fmt.bufPrint(url_buffer, "https://retirement.invalid/{d}", .{index});
            chunk.* = .{
                .text_ptr = "A".ptr,
                .text_len = 1,
                .fg_ptr = null,
                .bg_ptr = null,
                .attributes = 0,
                .link_ptr = url.ptr,
                .link_len = url.len,
            };
        }
        try tb.setStyledText(&chunks);
        const num_slots = links.num_slots;
        try std.testing.expect(num_slots > links.slots_per_page);
        try std.testing.expectEqual(chunks.len, tb.link_tracker.?.getLinkCount());
        try std.testing.expectEqual(chunks.len, links.interned_live_ids.count());
        const alloc_index = failing.alloc_index;
        const resize_index = failing.resize_index;
        failing.fail_index = alloc_index;
        failing.resize_fail_index = resize_index;
        if (reset) try tb.reset() else try tb.clear();
        try std.testing.expectEqual(@as(u32, 0), tb.getLength());
        try std.testing.expectEqual(@as(u32, 0), tb.link_tracker.?.getLinkCount());
        try std.testing.expectEqual(@as(u32, 0), links.interned_live_ids.count());
        try std.testing.expectEqual(num_slots, links.getFreeSlotCount());
        try std.testing.expectEqual(@as(u64, 0), links.getLiveSlotCount());
        try std.testing.expectEqual(alloc_index, failing.alloc_index);
        try std.testing.expectEqual(resize_index, failing.resize_index);
        try std.testing.expect(!failing.has_induced_failure);

        failing.fail_index = std.math.maxInt(usize);
        failing.resize_fail_index = std.math.maxInt(usize);
        try tb.setStyledText(&chunks);
        try std.testing.expectEqual(chunks.len, tb.getLength());
        try std.testing.expectEqual(chunks.len, tb.link_tracker.?.getLinkCount());
        try std.testing.expectEqual(num_slots, links.num_slots);
        try tb.clear();
        try std.testing.expectEqual(num_slots, links.getFreeSlotCount());
    }
}

test "TextBuffer clear failure preserves text, highlights, links, and view state" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const tb = try TextBuffer.init(std.testing.allocator, &pool, &links, .unicode);
    defer tb.deinit();
    const style = try text_buffer.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    tb.setSyntaxStyle(style);
    try tb.setStyledText(&.{.{
        .text_ptr = "old".ptr,
        .text_len = 3,
        .fg_ptr = null,
        .bg_ptr = null,
        .attributes = 0,
        .link_ptr = "https://example.com".ptr,
        .link_len = "https://example.com".len,
    }});
    const replacement = try tb.registerMemBuffer("replacement", false);
    const view = try tb.registerView();
    tb.clearViewDirty(view);
    const old_root = tb.rope().root;
    const old_version = tb.rope().version;
    const old_epoch = tb.getContentEpoch();
    const old_highlights = tb.getHighlightCount();
    const old_links = tb.link_tracker.?.used_ids.count();
    try std.testing.expect(old_highlights > 0);
    try std.testing.expect(old_links > 0);
    const rope_allocator = tb.rope().allocator;
    var failing = std.testing.FailingAllocator.init(rope_allocator, .{ .fail_index = 0 });
    tb.rope().allocator = failing.allocator();
    defer tb.rope().allocator = rope_allocator;

    try std.testing.expectError(error.OutOfMemory, tb.clear());
    try std.testing.expectError(error.OutOfMemory, tb.setText("replacement"));
    try std.testing.expectError(error.OutOfMemory, tb.setTextFromMemId(replacement));
    try std.testing.expectError(error.OutOfMemory, tb.setStyledText(&.{}));
    try std.testing.expectEqual(old_root, tb.rope().root);
    try std.testing.expectEqual(old_version, tb.rope().version);
    try std.testing.expectEqual(old_epoch, tb.getContentEpoch());
    try std.testing.expectEqual(old_highlights, tb.getHighlightCount());
    try std.testing.expectEqual(old_links, tb.link_tracker.?.used_ids.count());
    try std.testing.expect(!tb.isViewDirty(view));
    var actual: [16]u8 = undefined;
    const length = tb.getPlainTextIntoBuffer(&actual);
    try std.testing.expectEqualStrings("old", actual[0..length]);
}

fn checkAppendAllocationFailures(from_mem_id: bool) !void {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    for ([_]bool{ false, true }) |fail_rope| {
        for ([_]bool{ false, true }) |reuse_slot| {
            var succeeded = false;
            for (0..128) |offset| {
                var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
                const tb = try TextBuffer.init(failing.allocator(), &pool, &links, .unicode);
                defer tb.deinit();
                try tb.setText("old\n");
                try tb.rope().store_undo("base");
                try tb.append("!");
                _ = try tb.undo("last");
                try tb.addHighlight(0, 0, 1, 1, 1, 7);
                const spare = try tb.registerMemBuffer("spare", false);
                while (tb.mem_registry.buffers.items.len < @min(tb.mem_registry.buffers.capacity, 255)) {
                    _ = try tb.registerMemBuffer("unused", false);
                }
                if (reuse_slot) try tb.mem_registry.unregister(spare);
                const input = "\u{754c}\r\n\ttail";
                const mem_id = if (from_mem_id) try tb.registerMemBuffer(input, false) else 0;
                const view = try tb.registerView();
                tb.clearViewDirty(view);
                const before = TextState.capture(tb);
                const allocator = tb.rope().allocator;
                var rope_failing = std.testing.FailingAllocator.init(allocator, .{});
                tb.rope().allocator = rope_failing.allocator();
                defer tb.rope().allocator = allocator;
                const fault = if (fail_rope) &rope_failing else &failing;
                fault.fail_index = fault.alloc_index + offset;
                fault.resize_fail_index = fault.resize_index;
                const result = if (from_mem_id) tb.appendFromMemId(mem_id) else tb.append(input);
                fault.fail_index = std.math.maxInt(usize);
                fault.resize_fail_index = std.math.maxInt(usize);
                if (result) |_| {
                    succeeded = true;
                } else |err| {
                    try std.testing.expectEqual(error.OutOfMemory, err);
                    try std.testing.expectEqualDeep(before, TextState.capture(tb));
                    try std.testing.expect(!tb.isViewDirty(view));
                    if (from_mem_id) try std.testing.expectEqualStrings(input, tb.getMemBuffer(mem_id).?);
                    try std.testing.expectEqualStrings("last", try tb.redo());
                    continue;
                }
                var actual: [64]u8 = undefined;
                try std.testing.expectEqualStrings("old\n\u{754c}\n\ttail", actual[0..tb.getPlainTextIntoBuffer(&actual)]);
                try std.testing.expectEqual(before.epoch + 1, tb.getContentEpoch());
                try std.testing.expect(tb.isViewDirty(view));
                break;
            }
            try std.testing.expect(succeeded);
        }
    }
}

test "TextBuffer append allocation failure preserves state and cancels its registration" {
    try checkAppendAllocationFailures(false);
}

test "TextBuffer appendFromMemId allocation failure preserves state and caller registration" {
    try checkAppendAllocationFailures(true);
}

test "TextBuffer reset allocation failure preserves the document and allows retry" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const style = try text_buffer.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    for (0..64) |offset| {
        var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        const tb = try TextBuffer.init(failing.allocator(), &pool, &links, .unicode);
        defer tb.deinit();
        try setupPlainTextHistory(tb, style);
        const view = try tb.registerView();
        tb.clearViewDirty(view);
        const before = TextState.capture(tb);
        failing.fail_index = failing.alloc_index + offset;
        failing.resize_fail_index = failing.resize_index;
        const result = tb.reset();
        failing.fail_index = std.math.maxInt(usize);
        failing.resize_fail_index = std.math.maxInt(usize);
        if (result) |_| {} else |err| {
            try std.testing.expectEqual(error.OutOfMemory, err);
            try std.testing.expectEqualDeep(before, TextState.capture(tb));
            try std.testing.expect(!tb.isViewDirty(view));
            try std.testing.expectEqualStrings("last", try tb.redo());
            _ = try tb.undo("last");
            try tb.reset();
        }
        try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
        try std.testing.expectEqual(@as(u32, 0), tb.getHighlightCount());
        try std.testing.expectEqual(@as(usize, 0), tb.memRegistry().getUsedSlots());
        try std.testing.expectEqual(@as(u32, 0), tb.link_tracker.?.getLinkCount());
        try std.testing.expect(!tb.rope().can_undo() and !tb.rope().can_redo());
        try std.testing.expect(tb.isViewDirty(view));
        try std.testing.expectEqual(style, tb.getSyntaxStyle().?);
        try tb.setText("reused");
        if (result) |_| return else |_| {}
    }
    return error.MissingSuccessfulReset;
}

test "TextBuffer styled replacement remains valid after allocation failures" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    var fail_offset: usize = 0;
    while (true) : (fail_offset += 1) {
        var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        const tb = try TextBuffer.init(failing.allocator(), &pool, &links, .unicode);
        defer tb.deinit();
        var chunk: text_buffer.StyledChunk = .{
            .text_ptr = "old".ptr,
            .text_len = 3,
            .fg_ptr = null,
            .bg_ptr = null,
            .attributes = 0,
        };
        try tb.setStyledText(&.{chunk});
        const old_root = tb.rope().root;
        const old_bytes = tb.styled_buffer.?.ptr;
        chunk.text_ptr = "replacement".ptr;
        chunk.text_len = "replacement".len;
        failing.fail_index = failing.alloc_index + fail_offset;
        failing.resize_fail_index = failing.resize_index;
        const result = tb.setStyledText(&.{chunk});
        failing.fail_index = std.math.maxInt(usize);
        failing.resize_fail_index = std.math.maxInt(usize);
        var actual: [16]u8 = undefined;
        if (result) {
            const length = tb.getPlainTextIntoBuffer(&actual);
            try std.testing.expectEqualStrings("replacement", actual[0..length]);
            break;
        } else |err| {
            try std.testing.expectEqual(error.OutOfMemory, err);
            try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
            const length = tb.getPlainTextIntoBuffer(&actual);
            if (tb.styled_buffer.?.ptr == old_bytes) {
                try std.testing.expectEqual(old_root, tb.rope().root);
                try std.testing.expectEqualStrings("old", actual[0..length]);
            } else {
                try std.testing.expectEqual(@as(usize, 0), length);
            }
            try tb.setStyledText(&.{chunk});
            const recovered_length = tb.getPlainTextIntoBuffer(&actual);
            try std.testing.expectEqualStrings("replacement", actual[0..recovered_length]);
        }
    }
}

test "TextBuffer setStyledText - repeated calls with SyntaxStyle (crash reproduction)" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    // Create a SyntaxStyle (similar to what Text.ts does)
    const ss = @import("../syntax-style.zig");
    const style = try ss.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    tb.setSyntaxStyle(style);

    const iterations = 10000;
    const initial_arena = tb.getArenaAllocatedBytes();

    // Simulate what styled-text-demo does - call setStyledText repeatedly
    var iteration: u32 = 0;
    while (iteration < iterations) : (iteration += 1) {
        // Create styled chunks similar to the demo
        const text1 = "System Stats: ";
        const text2 = "Frame: ";
        var frame_buf: [32]u8 = undefined;
        const frame_text = try std.fmt.bufPrint(&frame_buf, "{}", .{iteration});

        const chunks = [_]text_buffer.StyledChunk{
            .{
                .text_ptr = text1.ptr,
                .text_len = text1.len,
                .fg_ptr = null,
                .bg_ptr = null,
                .attributes = 1, // bold
            },
            .{
                .text_ptr = text2.ptr,
                .text_len = text2.len,
                .fg_ptr = null,
                .bg_ptr = null,
                .attributes = 0,
            },
            .{
                .text_ptr = frame_text.ptr,
                .text_len = frame_text.len,
                .fg_ptr = null,
                .bg_ptr = null,
                .attributes = 0,
            },
        };

        try tb.setStyledText(&chunks);
        try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    }

    const final_arena = tb.getArenaAllocatedBytes();
    const arena_growth = final_arena - initial_arena;

    // Arena should not grow significantly - setStyledText should reuse memory
    // Max 50KB growth is reasonable for rope structure
    const max_expected_growth = 50000;
    try std.testing.expect(arena_growth < max_expected_growth);
}

test "addHighlightByCharRange - single line highlight should not extend to EOL" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const text = "Try moving your cursor through the [VIRTUAL] markers below:";
    try tb.setText(text);

    try tb.addHighlightByCharRange(35, 44, 1, 1, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 1), highlights.len);
    try std.testing.expectEqual(@as(u32, 35), highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 44), highlights[0].col_end);

    try std.testing.expect(highlights[0].col_end < 59);
    try std.testing.expect(highlights[0].col_end == 44);
}

test "addHighlightByCharRange - multiple highlights on same line should have correct bounds" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const text = "Text [MARK1] and [MARK2] here";
    try tb.setText(text);

    try tb.addHighlightByCharRange(5, 12, 1, 1, 0);
    try tb.addHighlightByCharRange(17, 24, 1, 2, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 2), highlights.len);

    try std.testing.expectEqual(@as(u32, 5), highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 12), highlights[0].col_end);

    try std.testing.expectEqual(@as(u32, 17), highlights[1].col_start);
    try std.testing.expectEqual(@as(u32, 24), highlights[1].col_end);
}

test "addHighlightByCharRange - highlight after newline should not span to EOL" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const text = "Line1\nLine2 with [MARK] text\nLine3";
    try tb.setText(text);

    const line1_char_offset: u32 = 5;
    const mark_start = line1_char_offset + 11;
    const mark_end = line1_char_offset + 17;

    try tb.addHighlightByCharRange(mark_start, mark_end, 1, 1, 0);

    const hl0 = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 0), hl0.len);

    const hl1 = tb.getLineHighlights(1);
    try std.testing.expectEqual(@as(usize, 1), hl1.len);

    try std.testing.expectEqual(@as(u32, 11), hl1[0].col_start);
    try std.testing.expectEqual(@as(u32, 17), hl1[0].col_end);

    const line1_text = "Line2 with [MARK] text";
    try std.testing.expect(hl1[0].col_end < line1_text.len);
}

test "addHighlightByCharRange - extmarks demo scenario reproduction" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const full_text =
        \\Welcome to the Extmarks Demo!
        \\
        \\This demo showcases virtual extmarks - text ranges that the cursor jumps over.
        \\
        \\Try moving your cursor through the [VIRTUAL] markers below:
        \\- Use arrow keys to navigate
    ;
    try tb.setText(full_text);

    const line4_char_offset: u32 = 107;
    const virtual_start = line4_char_offset + 35;
    const virtual_end = line4_char_offset + 44;

    try tb.addHighlightByCharRange(virtual_start, virtual_end, 1, 1, 0);

    const line4_highlights = tb.getLineHighlights(4);
    try std.testing.expectEqual(@as(usize, 1), line4_highlights.len);
    try std.testing.expectEqual(@as(u32, 35), line4_highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 44), line4_highlights[0].col_end);

    const line4_text = "Try moving your cursor through the [VIRTUAL] markers below:";
    try std.testing.expect(line4_highlights[0].col_end == 44);
    try std.testing.expect(line4_highlights[0].col_end < line4_text.len);
}

// ===== TextBuffer.append() Tests =====

test "TextBuffer append - to empty buffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.append("Hello");

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 5), tb.getLength());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Hello", out_buffer[0..written]);
}

test "TextBuffer append - to non-empty buffer, no newline" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello");
    try tb.append(" World");

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 11), tb.getLength());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Hello World", out_buffer[0..written]);
}

test "TextBuffer append - creating new line with LF" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello");
    try tb.append("\nWorld");

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Hello\nWorld", out_buffer[0..written]);
}

test "TextBuffer append - multiple lines with various endings" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("A\nB");
    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());

    try tb.append("\nC\nD\n");

    try std.testing.expectEqual(@as(u32, 5), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("A\nB\nC\nD\n", out_buffer[0..written]);
}

test "TextBuffer append - CRLF line endings" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.append("Line1\r\nLine2\r\nLine3");

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    // CRLF should be normalized to LF
    try std.testing.expectEqualStrings("Line1\nLine2\nLine3", out_buffer[0..written]);
}

test "TextBuffer append - mixed line endings" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Unix\n");
    try tb.append("Windows\r\nOldMac\rEnd");

    try std.testing.expectEqual(@as(u32, 4), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Unix\nWindows\nOldMac\nEnd", out_buffer[0..written]);
}

test "TextBuffer append - empty string is no-op" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello");
    const initial_length = tb.getLength();
    const initial_line_count = tb.getLineCount();

    try tb.append("");

    try std.testing.expectEqual(initial_length, tb.getLength());
    try std.testing.expectEqual(initial_line_count, tb.getLineCount());
}

test "TextBuffer append - unicode content" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello ");
    try tb.append("世界 🌟");

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Hello 世界 🌟", out_buffer[0..written]);
}

test "TextBuffer append - streaming/chunked append vs ground truth" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    // Append in chunks
    try tb.append("First");
    try tb.append("\nLine2");
    try tb.append("\n");
    try tb.append("Line3");
    try tb.append(" end");

    // Build expected ground truth
    var expected: std.ArrayListUnmanaged(u8) = .empty;
    defer expected.deinit(std.testing.allocator);
    try expected.appendSlice(std.testing.allocator, "First");
    try expected.appendSlice(std.testing.allocator, "\nLine2");
    try expected.appendSlice(std.testing.allocator, "\n");
    try expected.appendSlice(std.testing.allocator, "Line3");
    try expected.appendSlice(std.testing.allocator, " end");

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings(expected.items, out_buffer[0..written]);

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
}

test "TextBuffer append - large streaming append" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    // Simulate streaming large content
    var i: u32 = 0;
    while (i < 100) : (i += 1) {
        var buf: [32]u8 = undefined;
        const line = try std.fmt.bufPrint(&buf, "Line {}\n", .{i});
        try tb.append(line);
    }

    try std.testing.expectEqual(@as(u32, 101), tb.getLineCount()); // 100 lines + empty final line

    // Verify first and last lines can be extracted correctly
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(tb.rope(), 0, 0).?);
    try std.testing.expect(iter_mod.coordsToOffset(tb.rope(), 99, 0).? > 0);
}

test "TextBuffer appendFromMemId - basic functionality" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const text = "Alpha\nBeta";
    const mem_id = try tb.registerMemBuffer(text, false);

    try tb.appendFromMemId(mem_id);

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Alpha\nBeta", out_buffer[0..written]);
}

test "TextBuffer appendFromMemId - append to existing content" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const text = "Gamma";
    const mem_id = try tb.registerMemBuffer(text, false);

    try tb.setText("Alpha\nBeta");
    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());

    try tb.appendFromMemId(mem_id);

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Alpha\nBetaGamma", out_buffer[0..written]);
}

test "TextBuffer appendFromMemId - invalid mem_id" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const result = tb.appendFromMemId(99);
    try std.testing.expectError(text_buffer.TextBufferError.InvalidMemId, result);
}

test "TextBuffer append - marker invariants maintained" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.append("Line1\n");
    try tb.append("Line2\n");
    try tb.append("Line3");

    const line_count = tb.getLineCount();
    try std.testing.expectEqual(@as(u32, 3), line_count);

    // Verify marker counts
    const linestart_count = tb.rope().markerCount(.linestart);
    try std.testing.expectEqual(line_count, linestart_count);

    const break_count = tb.rope().markerCount(.brk);
    try std.testing.expectEqual(@as(u32, 2), break_count); // 2 newlines
}

test "TextBuffer append - memory registry preserved" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const preserved_text = "Preserved";
    const preserved_id = try tb.registerMemBuffer(preserved_text, false);

    try tb.append("First\n");
    try tb.append("Second\n");
    try tb.append("Third");

    // Preserved buffer should still be accessible
    const retrieved = tb.getMemBuffer(preserved_id);
    try std.testing.expect(retrieved != null);
    try std.testing.expectEqualStrings(preserved_text, retrieved.?);
}

test "TextBuffer append - views marked dirty" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const view_id = try tb.registerView();
    defer tb.unregisterView(view_id);

    tb.clearViewDirty(view_id);
    try std.testing.expect(!tb.isViewDirty(view_id));

    try tb.append("New content");

    try std.testing.expect(tb.isViewDirty(view_id));
}

test "TextBuffer append - append after clear" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Initial content");
    try tb.clear();

    try tb.append("After clear");

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("After clear", out_buffer[0..written]);
}

test "TextBuffer append - consecutive empty line handling" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Line1\n");
    try tb.append("\n");
    try tb.append("Line3");

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Line1\n\nLine3", out_buffer[0..written]);
}

test "TextBuffer append - mixed append and setText" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("First");
    try tb.append(" appended");

    var out_buffer: [100]u8 = undefined;
    var written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("First appended", out_buffer[0..written]);

    try tb.setText("Reset");
    try tb.append(" again");

    written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Reset again", out_buffer[0..written]);
}
