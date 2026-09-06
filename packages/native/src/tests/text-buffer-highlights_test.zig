const std = @import("std");
const text_buffer = @import("../text-buffer.zig");
const ansi = @import("../ansi.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");
const ss = @import("../syntax-style.zig");
const utf8 = @import("../utf8.zig");

const TextBuffer = text_buffer.UnifiedTextBuffer;
const RGBA = text_buffer.RGBA;
const Highlight = text_buffer.Highlight;

test "TextBuffer styled seek - JSON tokens retain every line span" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();
    const tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();
    const style = try ss.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    tb.setSyntaxStyle(style);
    const line_count = 200;
    const chunks = try std.testing.allocator.alloc(text_buffer.StyledChunk, line_count * 5);
    defer std.testing.allocator.free(chunks);
    for (0..line_count) |row| {
        for ([_][]const u8{ "  ", "\"field\"", ": ", "123", ",\n" }, 0..) |text, token| {
            chunks[row * 5 + token] = .{
                .text_ptr = text.ptr,
                .text_len = text.len,
                .fg_ptr = null,
                .bg_ptr = null,
                .attributes = @intCast(token),
            };
        }
    }
    for (0..2) |_| {
        try tb.setStyledText(chunks);
        try std.testing.expectEqual(line_count + 1, tb.getLineCount());
        try std.testing.expectEqual(chunks.len, tb.getHighlightCount());
        try std.testing.expectEqual(chunks.len, style.getStyleCount());
        for (0..line_count) |row| {
            const highlights = tb.getLineHighlights(row);
            const spans = tb.line_spans.items[row].items;
            try std.testing.expectEqual(5, highlights.len);
            try std.testing.expectEqual(5, spans.len);
            for ([_]u32{ 0, 2, 9, 11, 14 }, [_]u32{ 2, 9, 11, 14, 15 }, 0..) |start, end, token| {
                try std.testing.expectEqual(start, highlights[token].col_start);
                try std.testing.expectEqual(end, highlights[token].col_end);
                try std.testing.expect(highlights[token].internal);
                try std.testing.expectEqual(1, highlights[token].priority);
                try std.testing.expectEqual(token, style.resolveById(highlights[token].style_id).?.attributes);
                try std.testing.expectEqual(start, spans[token].col);
                try std.testing.expectEqual(end, spans[token].next_col);
                try std.testing.expectEqual(highlights[token].style_id, spans[token].style_id);
            }
        }
        try std.testing.expectEqual(0, tb.getLineHighlights(line_count).len);
    }
}

test "TextBuffer styled seek - newline excluded ranges across empty lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();
    const tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();
    try tb.setText("\n\nabc\n\ndef\n\n");
    try tb.addHighlightByCharRange(3, 6, 1, 1, 42);
    try std.testing.expectEqual(1, tb.getHighlightCount());
    try std.testing.expectEqual(0, tb.getLineHighlights(4)[0].col_start);
    try std.testing.expectEqual(3, tb.getLineHighlights(4)[0].col_end);
    tb.startHighlightsTransaction();
    try tb.addHighlightByCharRange(2, 4, 2, 5, 43);
    tb.endHighlightsTransaction();
    try std.testing.expectEqual(3, tb.getHighlightCount());
    try std.testing.expectEqual(2, tb.getLineHighlights(2)[0].col_start);
    try std.testing.expectEqual(3, tb.getLineHighlights(2)[0].col_end);
    try std.testing.expectEqual(0, tb.getLineHighlights(4)[1].col_start);
    try std.testing.expectEqual(1, tb.getLineHighlights(4)[1].col_end);
    try std.testing.expectEqual(2, tb.line_spans.items[4].items[0].style_id);
    tb.removeHighlightsByRef(43);
    try std.testing.expectEqual(1, tb.getHighlightCount());
    try std.testing.expectEqual(1, tb.line_spans.items[4].items[0].style_id);
    try tb.addHighlightByCharRange(6, 100, 2, 1, 0);
    try std.testing.expectEqual(1, tb.getHighlightCount());
}

test "TextBuffer styled seek - display widths multiline chunks and links" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();
    const first = "\t\u{4e16}\u{754c}";
    const emoji = "\u{1f469}\u{200d}\u{1f4bb}";
    const combining = "e\u{301}";
    const url = "https://example.com/fixture.json";
    const fg = ansi.rgbaFromFloats(1, 0, 0, 1);
    const bg = ansi.rgbaFromFloats(0, 0, 1, 1);
    for (std.enums.values(utf8.WidthMethod)) |method| {
        const tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, method);
        defer tb.deinit();
        const style = try ss.SyntaxStyle.init(std.testing.allocator);
        defer style.deinit();
        tb.setSyntaxStyle(style);
        for ([_]u8{ 2, 4 }) |tab_width| {
            tb.setTabWidth(tab_width);
            var chunks: [5]text_buffer.StyledChunk = undefined;
            for ([_][]const u8{ "\n\n", first ++ "\n\n" ++ emoji, "", "\n" ++ combining ++ "\n\tX", "\n\n" }, 0..) |text, i| {
                chunks[i] = .{
                    .text_ptr = text.ptr,
                    .text_len = text.len,
                    .fg_ptr = @ptrCast(&fg),
                    .bg_ptr = @ptrCast(&bg),
                    .attributes = 3,
                    .link_ptr = url.ptr,
                    .link_len = url.len,
                };
            }
            try tb.setStyledText(&chunks);
            try std.testing.expectEqual(9, tb.getLineCount());
            try std.testing.expectEqual(4, tb.getHighlightCount());
            try std.testing.expectEqual(2, style.getStyleCount());
            for ([_]usize{ 2, 4, 5, 6 }, [_][]const u8{ first, emoji, combining, "\tX" }) |row, text| {
                const highlights = tb.getLineHighlights(row);
                try std.testing.expectEqual(1, highlights.len);
                try std.testing.expectEqual(0, highlights[0].col_start);
                try std.testing.expectEqual(tb.measureText(text), highlights[0].col_end);
                const definition = style.resolveById(highlights[0].style_id).?;
                try std.testing.expectEqualDeep(fg, definition.fg.?);
                try std.testing.expectEqualDeep(bg, definition.bg.?);
                const link_id = ansi.TextAttributes.getLinkId(definition.attributes);
                try std.testing.expectEqual(ansi.TextAttributes.setLinkId(3, link_id), definition.attributes);
                try std.testing.expectEqualStrings(url, try link_pool.get(link_id));
                try std.testing.expectEqual(1, try link_pool.getRefcount(link_id));
            }
            const text = "\n\n" ++ first ++ "\n\n" ++ emoji ++ "\n" ++ combining ++ "\n\tX\n\n";
            var output: [text.len]u8 = undefined;
            try std.testing.expectEqualStrings(text, output[0..tb.getPlainTextIntoBuffer(&output)]);
            const offset = tb.measureText(first ++ emoji ++ combining);
            try tb.addHighlightByCharRange(offset, offset + tb.measureText("\tX"), 99, 9, 42);
            try std.testing.expectEqual(2, tb.getLineHighlights(6).len);
            try std.testing.expectEqual(99, tb.line_spans.items[6].items[0].style_id);
            tb.removeHighlightsByRef(42);
            try std.testing.expectEqual(4, tb.getHighlightCount());
        }
    }
}

test "TextBuffer styled seek - arbitrary range order after replacing rope" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();
    const tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    const style = try ss.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    tb.setSyntaxStyle(style);
    const style_id = try style.registerStyle("token", null, null, 1);
    const count = 5000;
    const text = try std.testing.allocator.alloc(u8, count * 3);
    defer std.testing.allocator.free(text);
    for (0..count) |i| @memcpy(text[i * 3 ..][0..3], "\nx\n");
    try tb.setText("previous rope");
    try tb.addHighlightByCharRange(1, 3, style_id, 1, 42);
    tb.clearAllHighlights();
    try tb.setText(text);
    tb.startHighlightsTransaction();
    for (0..count) |i| {
        const start: u32 = @intCast(count - i - 1);
        try tb.addHighlightByCharRange(start, start + 1, style_id, 1, 42);
    }
    tb.endHighlightsTransaction();
    try std.testing.expectEqual(count, tb.getHighlightCount());
    for (0..count) |i| {
        try std.testing.expectEqual(0, tb.getLineHighlights(i * 2).len);
        const highlights = tb.getLineHighlights(i * 2 + 1);
        try std.testing.expectEqual(1, highlights.len);
        try std.testing.expectEqual(0, highlights[0].col_start);
        try std.testing.expectEqual(1, highlights[0].col_end);
        try std.testing.expectEqual(style_id, tb.line_spans.items[i * 2 + 1].items[0].style_id);
    }
}

test "TextBuffer styled text - failed growth keeps storage safe to reuse" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    const tb = try TextBuffer.init(failing.allocator(), pool, link_pool, .unicode);
    defer tb.deinit();
    const small = [_]text_buffer.StyledChunk{.{ .text_ptr = "a".ptr, .text_len = 1, .fg_ptr = null, .bg_ptr = null, .attributes = 0 }};
    const large = [_]text_buffer.StyledChunk{.{ .text_ptr = "larger".ptr, .text_len = 6, .fg_ptr = null, .bg_ptr = null, .attributes = 0 }};
    try tb.setStyledText(&small);

    failing.fail_index = failing.alloc_index;
    try std.testing.expectError(error.OutOfMemory, tb.setStyledText(&large));
    failing.fail_index = std.math.maxInt(usize);
    try tb.setStyledText(&small);
    var output: [1]u8 = undefined;
    try std.testing.expectEqualStrings("a", output[0..tb.getPlainTextIntoBuffer(&output)]);
}

test "TextBuffer rejection - single highlight preserves accepted highlights and spans" {
    try checkHighlightRejection(false, false);
}

test "TextBuffer rejection - range highlight is atomic across lines" {
    try checkHighlightRejection(true, false);
}

test "TextBuffer rejection - batched highlights preserve dirty lines" {
    try checkHighlightRejection(false, true);
    try checkHighlightRejection(true, true);
}

fn checkHighlightRejection(comptime range: bool, batched: bool) !void {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    var succeeded = false;
    for (0..64) |fail_index| {
        const tb = try TextBuffer.init(std.testing.allocator, &pool, &links, .wcwidth);
        defer tb.deinit();
        try tb.setText("hello\nworld\nlast\nfour\nfive\nsix\nseven\neight\nnine\nten");
        try tb.addHighlight(0, 0, 2, 11, 1, 7);
        const accepted = tb.getLineHighlights(0)[0];
        const spans = try std.testing.allocator.dupe(text_buffer.StyleSpan, tb.getLineSpans(0));
        defer std.testing.allocator.free(spans);
        const highlights_len = tb.line_highlights.items.len;
        const spans_len = tb.line_spans.items.len;
        if (batched) tb.startHighlightsTransaction();
        const allocator = tb.global_allocator;
        var failing = std.testing.FailingAllocator.init(allocator, .{ .fail_index = fail_index, .resize_fail_index = 0 });
        tb.global_allocator = failing.allocator();
        tb.dirty_span_lines.allocator = failing.allocator();
        const result = if (range) tb.addHighlightByCharRange(1, 100, 22, 2, 8) else tb.addHighlight(0, 1, 4, 22, 2, 8);
        tb.global_allocator = allocator;
        tb.dirty_span_lines.allocator = allocator;
        if (result) |_| {
            try std.testing.expect(!failing.has_induced_failure);
            try std.testing.expectEqual(@as(u32, if (range) 11 else 2), tb.getHighlightCount());
            if (batched) {
                try std.testing.expectEqualSlices(text_buffer.StyleSpan, spans, tb.getLineSpans(0));
                try std.testing.expectEqual(@as(u32, if (range) 10 else 1), tb.dirty_span_lines.count());
                tb.endHighlightsTransaction();
            }
            try std.testing.expectEqual(@as(u32, 22), tb.getLineSpans(0)[1].style_id);
            succeeded = true;
            break;
        } else |err| {
            try std.testing.expectEqual(error.OutOfMemory, err);
            try std.testing.expect(failing.has_induced_failure);
        }
        try std.testing.expectEqual(@as(u32, 1), tb.getHighlightCount());
        try std.testing.expectEqualDeep(accepted, tb.getLineHighlights(0)[0]);
        try std.testing.expectEqualSlices(text_buffer.StyleSpan, spans, tb.getLineSpans(0));
        try std.testing.expectEqual(highlights_len, tb.line_highlights.items.len);
        try std.testing.expectEqual(spans_len, tb.line_spans.items.len);
        for (1..tb.getLineCount()) |line_idx| {
            try std.testing.expectEqual(@as(usize, 0), tb.getLineHighlights(line_idx).len);
            try std.testing.expectEqual(@as(usize, 0), tb.getLineSpans(line_idx).len);
        }
        try std.testing.expectEqual(@as(usize, 0), tb.internal_highlight_count);
        try std.testing.expectEqual(@as(u32, 0), tb.dirty_span_lines.count());
        if (batched) tb.endHighlightsTransaction();
        try tb.addHighlightByCharRange(1, 100, 22, 2, 8);
        try std.testing.expectEqual(@as(u32, 11), tb.getHighlightCount());
    }
    try std.testing.expect(succeeded);
}

test "TextBuffer rejection - first highlight does not publish partial storage" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    var succeeded = false;
    for (0..16) |fail_index| {
        const tb = try TextBuffer.init(std.testing.allocator, &pool, &links, .wcwidth);
        defer tb.deinit();
        try tb.setText("hello\nworld");
        var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = fail_index, .resize_fail_index = 0 });
        tb.global_allocator = failing.allocator();
        const result = tb.addHighlight(1, 0, 3, 9, 1, 4);
        tb.global_allocator = std.testing.allocator;
        if (result) |_| {
            try std.testing.expect(!failing.has_induced_failure);
            try std.testing.expectEqual(@as(u32, 1), tb.getHighlightCount());
            try std.testing.expectEqual(@as(u32, 9), tb.getLineSpans(1)[0].style_id);
            succeeded = true;
            break;
        } else |err| {
            try std.testing.expectEqual(error.OutOfMemory, err);
        }
        try std.testing.expectEqual(@as(usize, 0), tb.line_highlights.items.len);
        try std.testing.expectEqual(@as(usize, 0), tb.line_spans.items.len);
        try std.testing.expectEqual(@as(u32, 0), tb.getHighlightCount());
    }
    try std.testing.expect(succeeded);
}

test "TextBuffer coords - addHighlightByCoords" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    try tb.setText("Hello\nWorld");

    try tb.addHighlightByCoords(0, 1, 0, 5, 1, 1, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 1), highlights.len);
    try std.testing.expectEqual(@as(u32, 1), highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 5), highlights[0].col_end);
}

test "TextBuffer coords - addHighlightByCoords multi-line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    try tb.setText("Hello\nWorld");

    try tb.addHighlightByCoords(0, 3, 1, 3, 1, 1, 0);

    const line0_highlights = tb.getLineHighlights(0);
    const line1_highlights = tb.getLineHighlights(1);

    try std.testing.expectEqual(@as(usize, 1), line0_highlights.len);
    try std.testing.expectEqual(@as(usize, 1), line1_highlights.len);
    try std.testing.expectEqual(@as(u32, 3), line0_highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 5), line0_highlights[0].col_end);
    try std.testing.expectEqual(@as(u32, 0), line1_highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 3), line1_highlights[0].col_end);
}

test "TextBuffer coords - highlights after empty lines keep line-local columns" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();
    const tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("a\n\nword");
    try tb.addHighlightByCoords(2, 1, 2, 3, 1, 1, 0);
    const highlights = tb.getLineHighlights(2);
    try std.testing.expectEqual(@as(usize, 1), highlights.len);
    try std.testing.expectEqual(@as(u32, 1), highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 3), highlights[0].col_end);
}

// ===== Highlight System Tests =====

test "TextBuffer highlights - add single highlight to line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello World");

    try tb.addHighlight(0, 0, 5, 1, 0, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 1), highlights.len);
    try std.testing.expectEqual(@as(u32, 0), highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 5), highlights[0].col_end);
    try std.testing.expectEqual(@as(u32, 1), highlights[0].style_id);
}

test "TextBuffer highlights - add multiple highlights to same line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello World");

    try tb.addHighlight(0, 0, 5, 1, 0, 0);
    try tb.addHighlight(0, 6, 11, 2, 0, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 2), highlights.len);
    try std.testing.expectEqual(@as(u32, 1), highlights[0].style_id);
    try std.testing.expectEqual(@as(u32, 2), highlights[1].style_id);
}

test "TextBuffer highlights - add highlights to multiple lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Line 1\nLine 2\nLine 3");

    try tb.addHighlight(0, 0, 6, 1, 0, 0);
    try tb.addHighlight(1, 0, 6, 2, 0, 0);
    try tb.addHighlight(2, 0, 6, 3, 0, 0);

    try std.testing.expectEqual(@as(usize, 1), tb.getLineHighlights(0).len);
    try std.testing.expectEqual(@as(usize, 1), tb.getLineHighlights(1).len);
    try std.testing.expectEqual(@as(usize, 1), tb.getLineHighlights(2).len);
}

test "TextBuffer highlights - remove highlights by reference" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

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

test "TextBuffer removal rejection - mixed refs preserve accepted highlights and spans" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    for ([_]bool{ false, true }) |batched| {
        for ([_]u16{ 0, 200 }) |hl_ref| {
            var succeeded = false;
            for (0..32) |fail_index| {
                const tb = try TextBuffer.init(std.testing.allocator, &pool, &links, .wcwidth);
                defer tb.deinit();
                const style = try ss.SyntaxStyle.init(std.testing.allocator);
                defer style.deinit();
                tb.setSyntaxStyle(style);
                const text = "abcdef\nabcdef";
                try tb.setStyledText(&.{.{ .text_ptr = text.ptr, .text_len = text.len, .fg_ptr = null, .bg_ptr = null, .attributes = 1 }});
                for (0..2) |line_idx| try tb.addHighlight(line_idx, 2, 6, 9, 2, 200);
                const highlights = try std.testing.allocator.dupe(Highlight, tb.getLineHighlights(0));
                defer std.testing.allocator.free(highlights);
                const spans = try std.testing.allocator.dupe(text_buffer.StyleSpan, tb.getLineSpans(0));
                defer std.testing.allocator.free(spans);
                const retained = highlights[if (hl_ref == 0) 1 else 0];
                tb.dirty_span_lines.clearAndFree();
                if (batched) tb.startHighlightsTransaction();
                var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = fail_index, .resize_fail_index = 0 });
                tb.global_allocator = failing.allocator();
                tb.dirty_span_lines.allocator = failing.allocator();
                const result = tb.removeHighlightsByRefChecked(hl_ref);
                tb.global_allocator = std.testing.allocator;
                tb.dirty_span_lines.allocator = std.testing.allocator;
                if (result) |_| {
                    try std.testing.expect(!failing.has_induced_failure);
                    succeeded = true;
                } else |err| {
                    try std.testing.expectEqual(error.OutOfMemory, err);
                    try std.testing.expect(failing.has_induced_failure);
                    for (0..2) |line_idx| {
                        try std.testing.expectEqualSlices(Highlight, highlights, tb.getLineHighlights(line_idx));
                        try std.testing.expectEqualSlices(text_buffer.StyleSpan, spans, tb.getLineSpans(line_idx));
                    }
                    try std.testing.expectEqual(@as(usize, 2), tb.internal_highlight_count);
                    try std.testing.expectEqual(@as(u32, 0), tb.dirty_span_lines.count());
                    try tb.removeHighlightsByRefChecked(hl_ref);
                }
                try std.testing.expectEqual(@as(u32, 2), tb.getHighlightCount());
                try std.testing.expectEqual(@as(usize, if (hl_ref == 0) 0 else 2), tb.internal_highlight_count);
                for (0..2) |line_idx| {
                    try std.testing.expectEqualSlices(Highlight, &.{retained}, tb.getLineHighlights(line_idx));
                    if (batched) try std.testing.expectEqualSlices(text_buffer.StyleSpan, spans, tb.getLineSpans(line_idx));
                }
                if (batched) {
                    try std.testing.expectEqual(@as(u32, 2), tb.dirty_span_lines.count());
                    tb.endHighlightsTransaction();
                }
                for (0..2) |line_idx| {
                    const actual = tb.getLineSpans(line_idx);
                    try std.testing.expectEqual(@as(usize, if (hl_ref == 0) 2 else 1), actual.len);
                    try std.testing.expectEqual(retained.style_id, actual[actual.len - 1].style_id);
                    try std.testing.expectEqual(@as(u32, 6), actual[actual.len - 1].next_col);
                }
                if (succeeded) break;
            }
            try std.testing.expect(succeeded);
        }
    }
}

test "TextBuffer removal - absent and final refs preserve nested batches" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const tb = try TextBuffer.init(std.testing.allocator, &pool, &links, .wcwidth);
    defer tb.deinit();
    try tb.setText("one\ntwo\nthree");
    try tb.addHighlight(0, 0, 3, 1, 1, 7);
    try tb.addHighlight(1, 0, 3, 2, 1, 8);
    tb.startHighlightsTransaction();
    tb.startHighlightsTransaction();
    try tb.addHighlight(2, 0, 5, 3, 1, 9);
    try tb.removeHighlightsByRefChecked(7);
    try std.testing.expectEqual(@as(u32, 2), tb.dirty_span_lines.count());
    try std.testing.expect(tb.dirty_span_lines.contains(0));
    try std.testing.expect(tb.dirty_span_lines.contains(2));

    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0 });
    tb.global_allocator = failing.allocator();
    tb.dirty_span_lines.allocator = failing.allocator();
    const result = tb.removeHighlightsByRefChecked(7);
    tb.global_allocator = std.testing.allocator;
    tb.dirty_span_lines.allocator = std.testing.allocator;
    try result;
    try std.testing.expect(!failing.has_induced_failure);
    tb.endHighlightsTransaction();
    try std.testing.expectEqual(@as(u32, 1), tb.getLineSpans(0)[0].style_id);
    try std.testing.expectEqual(@as(usize, 0), tb.getLineSpans(2).len);
    tb.endHighlightsTransaction();
    try std.testing.expectEqual(@as(usize, 0), tb.getLineHighlights(0).len);
    try std.testing.expectEqual(@as(usize, 0), tb.getLineSpans(0).len);
    try std.testing.expectEqual(@as(u32, 2), tb.getLineSpans(1)[0].style_id);
    try std.testing.expectEqual(@as(u32, 3), tb.getLineSpans(2)[0].style_id);
    try std.testing.expectEqual(@as(u32, 0), tb.dirty_span_lines.count());
    try tb.removeHighlightsByRefChecked(8);
    try std.testing.expectEqual(@as(usize, 0), tb.getLineSpans(1).len);
    try std.testing.expectEqual(@as(u32, 1), tb.getHighlightCount());
}

test "TextBuffer highlights - clear line highlights" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Line 1\nLine 2");

    try tb.addHighlight(0, 0, 6, 1, 0, 0);
    try tb.addHighlight(0, 6, 10, 2, 0, 0);

    tb.clearLineHighlights(0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 0), highlights.len);
}

test "TextBuffer highlights - clear all highlights" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Line 1\nLine 2\nLine 3");

    try tb.addHighlight(0, 0, 6, 1, 0, 0);
    try tb.addHighlight(1, 0, 6, 2, 0, 0);
    try tb.addHighlight(2, 0, 6, 3, 0, 0);

    tb.clearAllHighlights();

    try std.testing.expectEqual(@as(usize, 0), tb.getLineHighlights(0).len);
    try std.testing.expectEqual(@as(usize, 0), tb.getLineHighlights(1).len);
    try std.testing.expectEqual(@as(usize, 0), tb.getLineHighlights(2).len);
}

test "TextBuffer highlights - get highlights from non-existent line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Line 1");

    // Get highlights from line that doesn't have any
    const highlights = tb.getLineHighlights(10);
    try std.testing.expectEqual(@as(usize, 0), highlights.len);
}

test "TextBuffer highlights - overlapping highlights" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello World");

    try tb.addHighlight(0, 0, 8, 1, 0, 0);
    try tb.addHighlight(0, 5, 11, 2, 0, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 2), highlights.len);
}

test "TextBuffer highlights - reset clears highlights" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello World");
    try tb.addHighlight(0, 0, 5, 1, 0, 0);

    try tb.reset();

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 0), highlights.len);
}

test "TextBuffer highlights - setSyntaxStyle and getSyntaxStyle" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var syntax_style = try ss.SyntaxStyle.init(std.testing.allocator);
    defer syntax_style.deinit();

    try std.testing.expect(tb.getSyntaxStyle() == null);

    tb.setSyntaxStyle(syntax_style);
    try std.testing.expect(tb.getSyntaxStyle() != null);

    tb.setSyntaxStyle(null);
    try std.testing.expect(tb.getSyntaxStyle() == null);
}

test "TextBuffer highlights - rejects syntax style when destroy listener allocation fails" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    var failing_allocator = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 2 });
    var syntax_style = try ss.SyntaxStyle.init(failing_allocator.allocator());
    defer syntax_style.deinit();
    defer tb.deinit();

    tb.setSyntaxStyle(syntax_style);

    try std.testing.expect(failing_allocator.has_induced_failure);
    try std.testing.expect(tb.getSyntaxStyle() == null);
}

test "TextBuffer highlights - preserves syntax style when replacement listener allocation fails" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    var first_style = try ss.SyntaxStyle.init(std.testing.allocator);
    defer first_style.deinit();
    var failing_allocator = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 2 });
    var second_style = try ss.SyntaxStyle.init(failing_allocator.allocator());
    defer second_style.deinit();

    tb.setSyntaxStyle(first_style);
    tb.setSyntaxStyle(second_style);

    try std.testing.expect(failing_allocator.has_induced_failure);
    try std.testing.expectEqual(@as(?*const ss.SyntaxStyle, first_style), tb.getSyntaxStyle());
}

test "TextBuffer highlights - integration with SyntaxStyle" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    var syntax_style = try ss.SyntaxStyle.init(std.testing.allocator);
    defer syntax_style.deinit();

    const keyword_id = try syntax_style.registerStyle("keyword", ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0), null, 0);
    const string_id = try syntax_style.registerStyle("string", ansi.rgbaFromFloats(0.0, 1.0, 0.0, 1.0), null, 0);
    const comment_id = try syntax_style.registerStyle("comment", ansi.rgbaFromFloats(0.5, 0.5, 0.5, 1.0), null, 0);

    try tb.setText("function hello() // comment");
    tb.setSyntaxStyle(syntax_style);

    try tb.addHighlight(0, 0, 8, keyword_id, 1, 0);
    try tb.addHighlight(0, 9, 14, string_id, 1, 0);
    try tb.addHighlight(0, 17, 27, comment_id, 1, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 3), highlights.len);

    const style = tb.getSyntaxStyle().?;
    try std.testing.expect(style.resolveById(keyword_id) != null);
    try std.testing.expect(style.resolveById(string_id) != null);
    try std.testing.expect(style.resolveById(comment_id) != null);
}

test "TextBuffer highlights - style spans computed correctly" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("0123456789");

    try tb.addHighlight(0, 0, 3, 1, 1, 0);
    try tb.addHighlight(0, 5, 8, 2, 1, 0);

    const spans = tb.getLineSpans(0);
    try std.testing.expect(spans.len > 0);

    // Should have spans for: [0-3 style:1], [3-5 style:0/default], [5-8 style:2], ...
    var found_style1 = false;
    var found_style2 = false;
    for (spans) |span| {
        if (span.style_id == 1) found_style1 = true;
        if (span.style_id == 2) found_style2 = true;
    }
    try std.testing.expect(found_style1);
    try std.testing.expect(found_style2);
}

test "TextBuffer highlights - priority handling in spans" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("0123456789");

    try tb.addHighlight(0, 0, 8, 1, 1, 0);
    try tb.addHighlight(0, 3, 6, 2, 5, 0);

    const spans = tb.getLineSpans(0);
    try std.testing.expect(spans.len > 0);

    // In range 3-6, style 2 should win due to higher priority
    var found_high_priority = false;
    for (spans) |span| {
        if (span.col >= 3 and span.col < 6 and span.style_id == 2) {
            found_high_priority = true;
        }
    }
    try std.testing.expect(found_high_priority);
}

// ===== Character Range Highlight Tests =====

test "TextBuffer char range highlights - single line highlight" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello World");

    try tb.addHighlightByCharRange(0, 5, 1, 1, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 1), highlights.len);
    try std.testing.expectEqual(@as(u32, 0), highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 5), highlights[0].col_end);
    try std.testing.expectEqual(@as(u32, 1), highlights[0].style_id);
}

test "TextBuffer char range highlights - multi-line highlight" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    // "Hello" = 5 chars (0-4, newlines not counted in offsets)
    // "World" = 5 chars (5-9, newlines not counted in offsets)
    // "Test" = 4 chars (10-13, newlines not counted in offsets)
    try tb.setText("Hello\nWorld\nTest");

    // Highlight from middle of line 0 to middle of line 1 (chars 3-9, not counting newlines)
    // char 3 = 'l' in "Hello", char 9 = 'd' in "World" (last char)
    try tb.addHighlightByCharRange(3, 9, 1, 1, 0);

    const line0_highlights = tb.getLineHighlights(0);
    const line1_highlights = tb.getLineHighlights(1);

    try std.testing.expectEqual(@as(usize, 1), line0_highlights.len);
    try std.testing.expectEqual(@as(usize, 1), line1_highlights.len);

    // Line 0: highlight from col 3 to end (col 5)
    try std.testing.expectEqual(@as(u32, 3), line0_highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 5), line0_highlights[0].col_end);

    // Line 1: highlight from start (col 0) to col 4 (chars 5,6,7,8 = cols 0,1,2,3)
    try std.testing.expectEqual(@as(u32, 0), line1_highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 4), line1_highlights[0].col_end);
}

test "TextBuffer char range highlights - spanning three lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

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

test "TextBuffer char range highlights - exact line boundaries" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("AAAA\nBBBB\nCCCC");

    // Highlight entire first line (chars 0-4, excluding newline)
    try tb.addHighlightByCharRange(0, 4, 1, 1, 0);

    const line0_highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 1), line0_highlights.len);
    try std.testing.expectEqual(@as(u32, 0), line0_highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 4), line0_highlights[0].col_end);

    // Line 1 should have no highlights
    const line1_highlights = tb.getLineHighlights(1);
    try std.testing.expectEqual(@as(usize, 0), line1_highlights.len);
}

test "TextBuffer char range highlights - empty range" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello World");

    // Empty range (start == end) should add no highlights
    try tb.addHighlightByCharRange(5, 5, 1, 1, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 0), highlights.len);
}

test "TextBuffer char range highlights - invalid range" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello World");

    // Invalid range (start > end) should add no highlights
    try tb.addHighlightByCharRange(10, 5, 1, 1, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 0), highlights.len);
}

test "TextBuffer char range highlights - out of bounds range" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello");

    // Range extends beyond text length - should handle gracefully
    try tb.addHighlightByCharRange(3, 100, 1, 1, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 1), highlights.len);
    try std.testing.expectEqual(@as(u32, 3), highlights[0].col_start);
}

test "TextBuffer char range highlights - multiple non-overlapping ranges" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

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

test "TextBuffer char range highlights - with reference ID for removal" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Line1\nLine2\nLine3");

    try tb.addHighlightByCharRange(0, 5, 1, 1, 100);
    try tb.addHighlightByCharRange(6, 11, 2, 1, 100);

    try std.testing.expectEqual(@as(usize, 1), tb.getLineHighlights(0).len);
    try std.testing.expectEqual(@as(usize, 1), tb.getLineHighlights(1).len);

    tb.removeHighlightsByRef(100);
    try std.testing.expectEqual(@as(usize, 0), tb.getLineHighlights(0).len);
    try std.testing.expectEqual(@as(usize, 0), tb.getLineHighlights(1).len);
}

test "TextBuffer char range highlights - priority handling" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("0123456789");

    try tb.addHighlightByCharRange(0, 8, 1, 1, 0);
    try tb.addHighlightByCharRange(3, 6, 2, 5, 0);

    const spans = tb.getLineSpans(0);
    try std.testing.expect(spans.len > 0);

    // Higher priority should win in overlap region
    var found_high_priority = false;
    for (spans) |span| {
        if (span.col >= 3 and span.col < 6 and span.style_id == 2) {
            found_high_priority = true;
        }
    }
    try std.testing.expect(found_high_priority);
}

test "TextBuffer char range highlights - unicode text" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello 世界 🌟");

    const text_len = tb.getLength();
    try tb.addHighlightByCharRange(0, text_len, 1, 1, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 1), highlights.len);
}

test "TextBuffer char range highlights - preserved after setText" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello World");
    try tb.addHighlightByCharRange(0, 5, 1, 1, 0);

    // Set new text - with clear() highlights are now preserved
    try tb.setText("New Text");

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 1), highlights.len);

    // To clear highlights, caller must explicitly call clearAllHighlights
    tb.clearAllHighlights();
    const cleared_highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 0), cleared_highlights.len);
}

test "TextBuffer char range highlights - multi-width chars before highlight" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("前后端分离 @git-committer");
    try tb.addHighlightByCharRange(11, 25, 1, 1, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 1), highlights.len);
    try std.testing.expectEqual(@as(u32, 11), highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 25), highlights[0].col_end);
}

test "TextBuffer char range highlights - multi-width chars between highlights" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("abc前后端def");
    try tb.addHighlightByCharRange(9, 12, 1, 1, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 1), highlights.len);
    try std.testing.expectEqual(@as(u32, 9), highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 12), highlights[0].col_end);
}

test "TextBuffer char range highlights - emoji grapheme clusters" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("前🌟test");
    try tb.addHighlightByCharRange(4, 8, 1, 1, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 1), highlights.len);
    try std.testing.expectEqual(@as(u32, 4), highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 8), highlights[0].col_end);
}
