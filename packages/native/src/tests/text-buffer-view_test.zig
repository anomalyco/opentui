const std = @import("std");
const text_buffer = @import("../text-buffer.zig");
const iter_mod = @import("../text-buffer-iterators.zig");
const text_buffer_view = @import("../text-buffer-view.zig");
const seg_mod = @import("../text-buffer-segment.zig");
const ansi = @import("../ansi.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");

const TextBuffer = text_buffer.UnifiedTextBuffer;
const TextBufferView = text_buffer_view.UnifiedTextBufferView;
const RGBA = text_buffer.RGBA;

test "TextBufferView first layout retains reusable word metadata" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const links = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();
    const tb = try TextBuffer.init(std.testing.allocator, pool, links, .unicode);
    defer tb.deinit();
    const view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();
    try tb.setText("alpha \u{754c}abc e\u{301} words\n" ** 100);
    view.setWrapMode(.word);
    view.setWrapWidth(80);
    _ = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 100), view.word_layout.layouts.items.len);
    const ptr = view.word_layout.layouts.items.ptr;
    const capacity = view.word_layout.arena.queryCapacity();
    view.setWrapWidth(79);
    _ = view.getVirtualLines();
    try std.testing.expectEqual(ptr, view.word_layout.layouts.items.ptr);
    try std.testing.expectEqual(capacity, view.word_layout.arena.queryCapacity());
}

test "TextBufferView fragmented ASCII measurement streams complete words without scratch allocation" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const links = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();
    const tb = try TextBuffer.init(std.testing.allocator, pool, links, .unicode);
    defer tb.deinit();
    const view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();
    view.setWrapMode(.word);
    try tb.append("word ");
    const single = try view.measureForDimensions(10, 24);
    try std.testing.expectEqual(@as(u32, 1), single.line_count);
    try std.testing.expectEqual(@as(u32, 5), single.width_cols_max);
    for (0..63) |_| try tb.append("word ");

    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0 });
    view.measure_arena.child_allocator = failing.allocator();
    for ([_]u32{ 10, 15, 10 }, [_]u32{ 32, 22, 32 }) |width, line_count| {
        const measured = try view.measureForDimensions(width, 24);
        try std.testing.expectEqual(line_count, measured.line_count);
        try std.testing.expectEqual(width, measured.width_cols_max);
        view.setWrapWidth(width);
        try std.testing.expectEqual(line_count, view.getVirtualLineCount());
    }
    try std.testing.expect(!failing.has_induced_failure);
    try std.testing.expectEqual(@as(usize, 0), view.measure_arena.queryCapacity());
}

test "TextBufferView CJK cache survives a failed sibling layout" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const links = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();
    const tb = try TextBuffer.init(std.testing.allocator, pool, links, .unicode);
    defer tb.deinit();
    try tb.setText("x\n" ++ ("\u{65e5}" ** 512));
    const healthy = try TextBufferView.init(std.testing.allocator, tb);
    defer healthy.deinit();
    healthy.setWrapMode(.word);
    healthy.setWrapWidth(80);
    try std.testing.expectEqual(@as(u32, 14), healthy.getVirtualLineCount());
    const chunk = tb.rope().get(4).?.asText().?;
    const cached = chunk.getCachedLayoutInfo(tb.tabWidth(), tb.widthMethod()).?;
    try std.testing.expectEqual(cached.cjk_breaks.ptr, healthy.word_layout.layouts.items[1].cjk_breaks.ptr);

    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    const sibling = try TextBufferView.init(failing.allocator(), tb);
    defer sibling.deinit();
    sibling.setWrapMode(.word);
    sibling.setWrapWidth(80);
    failing.fail_index = failing.alloc_index;
    try std.testing.expectEqual(@as(u32, 0), sibling.getVirtualLineCount());
    try std.testing.expect(failing.has_induced_failure);
    try std.testing.expect(!tb.isViewDirty(healthy.view_id));
    try std.testing.expect(chunk.getCachedLayoutInfo(tb.tabWidth(), tb.widthMethod()) != null);

    healthy.setWrapWidth(40);
    try std.testing.expectEqual(@as(u32, 27), healthy.getVirtualLineCount());
    try std.testing.expectEqual(cached.cjk_breaks.ptr, chunk.getCachedLayoutInfo(tb.tabWidth(), tb.widthMethod()).?.cjk_breaks.ptr);

    failing.fail_index = std.math.maxInt(usize);
    try std.testing.expectEqual(@as(u32, 14), sibling.getVirtualLineCount());
    try std.testing.expect(!sibling.virtual_lines_dirty);
    healthy.setWrapWidth(80);
    try std.testing.expectEqual(@as(u32, 14), healthy.getVirtualLineCount());
    try std.testing.expectEqual(cached.cjk_breaks.ptr, chunk.getCachedLayoutInfo(tb.tabWidth(), tb.widthMethod()).?.cjk_breaks.ptr);
}

test "TextBufferView optional metadata failure preserves every streamed piece" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const links = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();
    const tb = try TextBuffer.init(std.testing.allocator, pool, links, .unicode);
    defer tb.deinit();
    try tb.setText(("a\u{754c}e\u{301} \u{0600} xy\tend-" ** 5000) ++ "\n" ++ ("\u{754c}abc e\u{301}\n" ** 100));
    const expected = try TextBufferView.init(std.testing.allocator, tb);
    defer expected.deinit();
    expected.setWrapMode(.word);
    expected.setWrapWidth(79);
    const want = expected.getVirtualLines();
    for (0..14) |failure| {
        var tracking = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        const actual = try TextBufferView.init(std.testing.allocator, tb);
        defer actual.deinit();
        actual.word_layout.arena.child_allocator = tracking.allocator();
        actual.setWrapMode(.word);
        tracking.fail_index = failure;
        actual.setWrapWidth(79);
        const got = actual.getVirtualLines();
        try std.testing.expect(!actual.virtual_lines_dirty);
        try std.testing.expectEqual(want.len, got.len);
        for (want, got) |wl, gl| {
            try std.testing.expectEqual(wl.width_cols, gl.width_cols);
            try std.testing.expectEqual(wl.source_line, gl.source_line);
            try std.testing.expectEqual(wl.source_col_start, gl.source_col_start);
            try std.testing.expectEqual(wl.document_cell_offset, gl.document_cell_offset);
            try std.testing.expectEqualDeep(wl.chunks.items, gl.chunks.items);
        }
        if (tracking.has_induced_failure) try std.testing.expectEqual(@as(usize, 0), actual.word_layout.layouts.items.len);
        tracking.fail_index = std.math.maxInt(usize);
        actual.setWrapWidth(80);
        _ = actual.getVirtualLines();
        actual.setWrapWidth(79);
        try std.testing.expectEqual(want.len, actual.getVirtualLines().len);
        const measured = try actual.measureForDimensions(79, 24);
        try std.testing.expectEqual(want.len, measured.line_count);
    }
}

test "TextBufferView width reuse does not leave metadata in old buffer roots" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();
    var retained: [2]usize = undefined;
    for (0..2) |side| {
        var tracking = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        const tb = try TextBuffer.init(tracking.allocator(), pool, link_pool, .unicode);
        defer tb.deinit();
        const view = try TextBufferView.init(tracking.allocator(), tb);
        view.setWrapMode(.word);
        view.setWrapWidth(80);
        const mem_id = try tb.registerMemBuffer("", false);
        for (0..20) |edit| {
            const text = if (edit % 2 == 0)
                "OpenTUI text metrics: \u{754c} e\u{301} abcdefghijklmnop \n" ** 100
            else
                "Changed text metrics: \u{754c} e\u{301} abcdefghijklmnop \n" ** 100;
            try tb.replaceMemBuffer(mem_id, text, false);
            try tb.setTextFromMemId(mem_id);
            _ = view.getVirtualLines();
            if (side == 1) for ([_]u32{ 79, 80, 43, 96, 80 }) |width| {
                view.setWrapWidth(width);
                _ = view.getVirtualLines();
            };
        }
        view.deinit();
        retained[side] = tracking.allocated_bytes - tracking.freed_bytes;
    }
    try std.testing.expectEqual(retained[0], retained[1]);
}

test "TextBufferView live word metadata follows views history and buffer switches" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();
    const edit = try @import("../edit-buffer.zig").EditBuffer.init(std.testing.allocator, pool, link_pool, .unicode, null);
    defer edit.deinit();
    const view = try TextBufferView.init(std.testing.allocator, edit.tb);
    defer view.deinit();
    const second = try TextBufferView.init(std.testing.allocator, edit.tb);
    defer second.deinit();
    const other = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer other.deinit();
    try other.setText("unrelated\t\u{754c} text");
    try edit.setText("alpha \u{754c} e\u{301} abcdefghijklmnopqrstuvwxyz\n" ** 10);
    view.setWrapMode(.word);
    second.setWrapMode(.word);
    view.setWrapWidth(16);
    second.setWrapWidth(32);
    _ = view.getVirtualLines();
    _ = second.getVirtualLines();
    try std.testing.expect(view.word_layout.layouts.items.len > 0);
    view.setWrapWidth(17);
    second.setWrapWidth(33);
    _ = view.getVirtualLines();
    _ = second.getVirtualLines();
    const ptr = view.word_layout.layouts.items.ptr;
    const capacity = view.word_layout.arena.queryCapacity();
    for ([_]u32{ 43, 7, 16, 96, 32 }) |width| {
        view.setWrapWidth(width);
        _ = view.getVirtualLines();
        try std.testing.expectEqual(ptr, view.word_layout.layouts.items.ptr);
        try std.testing.expectEqual(capacity, view.word_layout.arena.queryCapacity());
    }
    try edit.replaceText("changed\ttext \u{0600} \u{301} \u{754c} words\n" ** 10);
    for (0..3) |step| {
        if (step == 1) _ = try edit.undo();
        if (step == 2) _ = try edit.redo();
        edit.tb.setTabWidth(@intCast(2 + step * 2));
        for ([_]*TextBufferView{ view, second }) |current| {
            _ = current.getVirtualLines();
            try std.testing.expect(current.word_layout.layouts.items.len > 0);
            current.setWrapWidth(19);
            _ = current.getVirtualLines();
            current.setWrapWidth(23);
            const measured = try current.measureForDimensions(23, 24);
            try std.testing.expectEqual(measured.line_count, current.getVirtualLineCount());
            try std.testing.expect(current.word_layout.layouts.items.len > 0);
            var bytes: [4096]u8 = undefined;
            const len = edit.tb.getPlainTextIntoBuffer(&bytes);
            const fresh_tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
            defer fresh_tb.deinit();
            fresh_tb.setTabWidth(edit.tb.tabWidth());
            try fresh_tb.setText(bytes[0..len]);
            const fresh = try TextBufferView.init(std.testing.allocator, fresh_tb);
            defer fresh.deinit();
            fresh.setWrapMode(.word);
            fresh.setWrapWidth(23);
            const expected = fresh.getVirtualLines();
            const actual = current.getVirtualLines();
            try std.testing.expectEqual(expected.len, actual.len);
            for (expected, actual) |want, got| {
                try std.testing.expectEqual(want.width_cols, got.width_cols);
                try std.testing.expectEqual(want.source_line, got.source_line);
                try std.testing.expectEqual(want.source_col_start, got.source_col_start);
                try std.testing.expectEqual(want.document_cell_offset, got.document_cell_offset);
                try std.testing.expectEqual(want.chunks.items.len, got.chunks.items.len);
                for (want.chunks.items, got.chunks.items) |wc, gc| {
                    try std.testing.expectEqual(wc.byte_start_in_chunk, gc.byte_start_in_chunk);
                    try std.testing.expectEqual(wc.byte_len, gc.byte_len);
                    try std.testing.expectEqual(wc.col_start_in_chunk, gc.col_start_in_chunk);
                    try std.testing.expectEqual(wc.width_cols, gc.width_cols);
                    try std.testing.expectEqualStrings(wc.chunk.getBytes(fresh_tb.memRegistry()), gc.chunk.getBytes(edit.tb.memRegistry()));
                }
            }
        }
    }
    view.switchToBuffer(other);
    try std.testing.expectEqual(@as(usize, 0), view.word_layout.layouts.items.len);
    _ = view.getVirtualLines();
    view.switchToOriginalBuffer();
    try std.testing.expectEqual(@as(usize, 0), view.word_layout.layouts.items.len);
    _ = view.getVirtualLines();
    view.setWrapMode(.char);
    _ = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 0), view.word_layout.arena.queryCapacity());
}

test "TextBufferView live word metadata discards partial allocation on failure" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();
    for (0..10) |failure| {
        var tracking = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        const tb = try TextBuffer.init(tracking.allocator(), pool, link_pool, .unicode);
        defer tb.deinit();
        const view = try TextBufferView.init(tracking.allocator(), tb);
        defer view.deinit();
        try tb.setText("alpha \u{754c} e\u{301} word word word word\n" ** 100);
        view.setWrapMode(.word);
        view.setWrapWidth(16);
        tracking.fail_index = tracking.alloc_index + failure;
        view.setWrapWidth(17);
        _ = view.getVirtualLines();
        if (tracking.has_induced_failure) {
            try std.testing.expectEqual(@as(usize, 0), view.word_layout.layouts.items.len);
            if (view.virtual_lines_dirty) try std.testing.expectEqual(@as(usize, 0), view.virtual_lines.items.len);
        }
        tracking.fail_index = std.math.maxInt(usize);
        const measured = try view.measureForDimensions(17, 24);
        try std.testing.expectEqual(measured.line_count, view.getVirtualLineCount());
    }
}

test "TextBufferView rewrap reuses virtual line allocation without retaining cleared layout" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();
    var tracking = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    const tb = try TextBuffer.init(tracking.allocator(), pool, link_pool, .unicode);
    defer tb.deinit();
    const view = try TextBufferView.init(tracking.allocator(), tb);
    defer view.deinit();
    try tb.setText("OpenTUI text metrics: \u{754c} e\u{301} abcdefghijklmnop " ** 100);
    view.setWrapMode(.word);
    view.setWrapWidth(80);
    _ = view.getVirtualLines();
    view.setWrapWidth(79);
    _ = view.getVirtualLines();
    view.setWrapWidth(80);
    _ = view.getVirtualLines();
    const allocated = tracking.allocated_bytes;
    const capacity = view.virtual_lines_arena.queryCapacity();
    for (0..20) |i| {
        view.setWrapWidth(@intCast(79 + i % 2));
        _ = view.getVirtualLines();
    }
    try std.testing.expectEqual(allocated, tracking.allocated_bytes);
    tb.clear();
    try std.testing.expectEqual(@as(u32, 1), view.getVirtualLineCount());
    try std.testing.expect(view.virtual_lines_arena.queryCapacity() < capacity);
}

test "TextBufferView rewrap matches fresh layout after text and tab changes" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();
    const texts = [_][]const u8{
        "",                                                             "one",                                                              "one two three\n\nshort\n",
        "\talpha \u{754c}abc e\u{301} \u{1f469}\u{200d}\u{1f4bb}\tend", "abcdefg \u{301} hi\n\u{0600} 0123456789abcdef\nword\u{200b}word ", "\u{754c} " ** 600,
        "\u{754c}abc " ** 10000,
    };
    inline for (std.meta.tags(@import("../utf8.zig").WidthMethod)) |method| {
        const tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, method);
        defer tb.deinit();
        const view = try TextBufferView.init(std.testing.allocator, tb);
        defer view.deinit();
        view.setWrapMode(.word);
        const mem_id = try tb.registerMemBuffer("", false);
        for (texts) |text| {
            try tb.replaceMemBuffer(mem_id, text, false);
            try tb.setTextFromMemId(mem_id);
            for ([_]u8{ 2, 4 }) |tab_width| {
                tb.setTabWidth(tab_width);
                for ([_]u32{ 7, 16, 79, 16 }) |width| {
                    const fresh_tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, method);
                    defer fresh_tb.deinit();
                    fresh_tb.setTabWidth(tab_width);
                    try fresh_tb.setText(text);
                    const fresh = try TextBufferView.init(std.testing.allocator, fresh_tb);
                    defer fresh.deinit();
                    fresh.setWrapMode(.word);
                    fresh.setWrapWidth(width);
                    view.setWrapWidth(width);
                    const measured = try view.measureForDimensions(width, 24);
                    const expected = fresh.getVirtualLines();
                    const actual = view.getVirtualLines();
                    try std.testing.expectEqual(expected.len, actual.len);
                    try std.testing.expectEqual(measured.line_count, actual.len);
                    for (expected, actual) |want, got| {
                        try std.testing.expectEqual(want.width_cols, got.width_cols);
                        try std.testing.expectEqual(want.source_line, got.source_line);
                        try std.testing.expectEqual(want.source_col_start, got.source_col_start);
                        try std.testing.expectEqual(want.document_cell_offset, got.document_cell_offset);
                        try std.testing.expectEqual(want.chunks.items.len, got.chunks.items.len);
                        for (want.chunks.items, got.chunks.items) |wc, gc| {
                            try std.testing.expectEqual(wc.byte_start_in_chunk, gc.byte_start_in_chunk);
                            try std.testing.expectEqual(wc.byte_len, gc.byte_len);
                            try std.testing.expectEqual(wc.col_start_in_chunk, gc.col_start_in_chunk);
                            try std.testing.expectEqual(wc.width_cols, gc.width_cols);
                            try std.testing.expectEqualStrings(wc.chunk.getBytes(fresh_tb.memRegistry()), gc.chunk.getBytes(tb.memRegistry()));
                        }
                    }
                }
            }
        }
        tb.clear();
        try std.testing.expectEqual(@as(u32, 1), view.getVirtualLineCount());
    }
}

test "TextBufferView wrapping - no wrap returns same line count" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    // Inclusive selection: the cell under the focus (7) is selected too.
    _ = view.setLocalSelection(2, 0, 7, 0, null, null);

    const packed_info = view.packSelectionInfo();
    try std.testing.expect(packed_info != 0xFFFFFFFF_FFFFFFFF);

    const start = @as(u32, @intCast(packed_info >> 32));
    const end = @as(u32, @intCast(packed_info & 0xFFFFFFFF));
    try std.testing.expectEqual(@as(u32, 2), start);
    try std.testing.expectEqual(@as(u32, 8), end);
}

test "TextBufferView selection - with wrapped lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST");

    view.setWrapMode(.char);
    view.setWrapWidth(10);

    try std.testing.expectEqual(@as(u32, 2), view.getVirtualLineCount());

    // Inclusive selection: focus cell (5,1) = offset 15 is selected too.
    _ = view.setLocalSelection(5, 0, 5, 1, null, null);

    const packed_info = view.packSelectionInfo();
    try std.testing.expect(packed_info != 0xFFFFFFFF_FFFFFFFF);

    const start = @as(u32, @intCast(packed_info >> 32));
    const end = @as(u32, @intCast(packed_info & 0xFFFFFFFF));
    try std.testing.expectEqual(@as(u32, 5), start);
    try std.testing.expectEqual(@as(u32, 16), end);
}

test "TextBufferView selection - no selection returns all bits set" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    view.setWrapMode(.word);
    view.setWrapWidth(8);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expectEqual(@as(u32, 2), wrapped_count);
}

test "TextBufferView word wrapping - overflowing separator whitespace is consumed" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    view.setWrapMode(.word);
    view.setWrapWidth(5);
    try tb.setText("hello world");

    try std.testing.expectEqualSlices(u32, &.{ 5, 5 }, view.getCachedLineInfo().line_width_cols);
    try std.testing.expectEqualSlices(u32, &.{ 0, 6 }, view.getCachedLineInfo().line_start_cols);

    const measured = try view.measureForDimensions(5, 24);
    try std.testing.expectEqual(@as(u32, 2), measured.line_count);
    try std.testing.expectEqual(@as(u32, 5), measured.width_cols_max);

    view.setWrapWidth(6);
    try std.testing.expectEqualSlices(u32, &.{ 6, 5 }, view.getCachedLineInfo().line_width_cols);
    try std.testing.expectEqualSlices(u32, &.{ 0, 6 }, view.getCachedLineInfo().line_start_cols);
}

test "TextBufferView word wrapping - consumed whitespace cursor positions stay on preceding visual line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("hello world again");
    view.setWrapMode(.word);
    view.setWrapWidth(5);

    try std.testing.expectEqualSlices(u32, &.{ 0, 6, 12 }, view.getCachedLineInfo().line_start_cols);
    try std.testing.expectEqual(@as(u32, 0), view.findVisualLineIndex(0, 5));
    try std.testing.expectEqual(@as(u32, 1), view.findVisualLineIndex(0, 11));
    try std.testing.expectEqual(@as(u32, 2), view.findVisualLineIndex(0, 12));
}

test "TextBufferView word wrapping - full local selection includes consumed trailing whitespace" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("hello ");
    view.setWrapMode(.word);
    view.setWrapWidth(5);

    try std.testing.expectEqual(@as(u32, 1), view.getVirtualLineCount());
    _ = view.setLocalSelection(0, 0, 0, 1, null, null);
    var selected: [16]u8 = undefined;
    const selected_len = view.getSelectedTextIntoBuffer(&selected);
    try std.testing.expectEqualStrings("hello ", selected[0..selected_len]);
}

test "TextBufferView wrapping - large single line retains its full width" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const text = try std.testing.allocator.alloc(u8, 70_000);
    defer std.testing.allocator.free(text);
    @memset(text, 'a');
    try tb.setText(text);

    view.setWrapMode(.word);
    view.setWrapWidth(80);
    try std.testing.expectEqual(@as(u32, 875), view.getVirtualLineCount());
    try std.testing.expect(view.getArenaAllocatedBytes() > 0);

    const measured = try view.measureForDimensions(80, 24);
    try std.testing.expectEqual(@as(u32, 875), measured.line_count);
    try std.testing.expectEqual(@as(u32, 80), measured.width_cols_max);
}

test "TextBufferView word wrapping - fragmented overflowing separator matches contiguous text" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const text = "hello world";
    const mem_id = try tb.registerMemBuffer(text, false);
    var segments: std.ArrayListUnmanaged(seg_mod.Segment) = .empty;
    defer segments.deinit(std.testing.allocator);
    try segments.append(std.testing.allocator, .{ .linestart = {} });
    try segments.append(std.testing.allocator, .{ .text = tb.createChunk(mem_id, 0, 5) });
    try segments.append(std.testing.allocator, .{ .text = tb.createChunk(mem_id, 5, 6) });
    try segments.append(std.testing.allocator, .{ .text = tb.createChunk(mem_id, 6, 11) });
    try tb.rope().setSegments(segments.items);

    view.setWrapMode(.word);
    view.setWrapWidth(5);
    try std.testing.expectEqualSlices(u32, &.{ 5, 5 }, view.getCachedLineInfo().line_width_cols);
    try std.testing.expectEqualSlices(u32, &.{ 0, 6 }, view.getCachedLineInfo().line_start_cols);

    const measured = try view.measureForDimensions(5, 24);
    try std.testing.expectEqual(@as(u32, 2), measured.line_count);
    try std.testing.expectEqual(@as(u32, 5), measured.width_cols_max);
}

test "TextBufferView word wrapping - wide separator boundaries do not create whitespace continuations" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();
    view.setWrapMode(.word);
    view.setWrapWidth(5);

    try tb.setText("hello　world");
    try std.testing.expectEqualSlices(u32, &.{ 5, 5 }, view.getCachedLineInfo().line_width_cols);
    try std.testing.expectEqualSlices(u32, &.{ 0, 7 }, view.getCachedLineInfo().line_start_cols);

    tb.setTabWidth(4);
    try tb.setText("hello\tworld");
    try std.testing.expectEqualSlices(u32, &.{ 5, 5 }, view.getCachedLineInfo().line_width_cols);
    try std.testing.expectEqualSlices(u32, &.{ 0, 9 }, view.getCachedLineInfo().line_start_cols);
}

test "TextBufferView word wrapping - logical-line leading whitespace is preserved" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText(" hello");
    view.setWrapMode(.word);
    view.setWrapWidth(5);
    try std.testing.expectEqualSlices(u32, &.{ 1, 5 }, view.getCachedLineInfo().line_width_cols);
    try std.testing.expectEqualSlices(u32, &.{ 0, 1 }, view.getCachedLineInfo().line_start_cols);
}

test "TextBufferView word wrapping - long word exceeds width" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST");

    view.setWrapMode(.char);
    view.setWrapWidth(7);
    const line_count = view.getVirtualLineCount();
    const line_info = view.getCachedLineInfo();

    try std.testing.expectEqual(@as(usize, line_count), line_info.line_start_cols.len);
    try std.testing.expectEqual(@as(usize, line_count), line_info.line_width_cols.len);

    for (line_info.line_width_cols, 0..) |width, i| {
        if (i < line_info.line_width_cols.len - 1) {
            try std.testing.expect(width <= 7);
        }
    }
}

test "TextBufferView virtual line spans - with highlights" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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

    try std.testing.expectEqual(@as(u32, 0), vline0_info.source_col_start);
    try std.testing.expectEqual(@as(u32, 10), vline1_info.source_col_start);

    try std.testing.expect(vline0_info.spans.len > 0);
    try std.testing.expect(vline1_info.spans.len > 0);
}

test "TextBufferView updates after buffer setText" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello,World.Test");

    view.setWrapMode(.word);
    view.setWrapWidth(8);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expect(wrapped_count >= 2);
}

test "TextBufferView word wrapping - tab boundary width" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    // "AB" = 2 cols, tab = 2 cols, "CD" = 2 cols
    try tb.setText("AB\tCD");

    view.setWrapMode(.word);
    view.setWrapWidth(4);
    const vlines = view.getVirtualLines();

    try std.testing.expectEqual(@as(usize, 2), vlines.len);
    try std.testing.expectEqual(@as(u32, 4), vlines[0].width_cols);
    try std.testing.expectEqual(@as(u32, 2), vlines[1].width_cols);
}

test "TextBufferView word wrapping - emoji boundary width" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    // "AB" = 2 cols, "🌟" = 2 cols, space = 1 col, "CD" = 2 cols
    try tb.setText("AB🌟 CD");

    view.setWrapMode(.word);
    view.setWrapWidth(5);
    const vlines = view.getVirtualLines();

    try std.testing.expectEqual(@as(usize, 2), vlines.len);
    try std.testing.expectEqual(@as(u32, 5), vlines[0].width_cols);
    try std.testing.expectEqual(@as(u32, 2), vlines[1].width_cols);
}

test "TextBufferView word wrapping - CJK boundary width" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    // "AB" = 2 cols, "好" = 2 cols, space = 1 col, "CD" = 2 cols
    try tb.setText("AB好 CD");

    view.setWrapMode(.word);
    view.setWrapWidth(5);
    const vlines = view.getVirtualLines();

    try std.testing.expectEqual(@as(usize, 2), vlines.len);
    try std.testing.expectEqual(@as(u32, 5), vlines[0].width_cols);
    try std.testing.expectEqual(@as(u32, 2), vlines[1].width_cols);
}

test "TextBufferView word wrapping - compare char vs word mode" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const text = "hello my good friend";
    const mem_id = try tb.registerMemBuffer(text, false);

    const Segment = seg_mod.Segment;

    const chunk1 = tb.createChunk(mem_id, 0, 14); // "hello my good "
    const chunk2 = tb.createChunk(mem_id, 14, 15); // "f"
    const chunk3 = tb.createChunk(mem_id, 15, 20); // "riend"

    var segments: std.ArrayListUnmanaged(Segment) = .empty;
    defer segments.deinit(std.testing.allocator);

    try segments.append(std.testing.allocator, .{ .linestart = {} });
    try segments.append(std.testing.allocator, .{ .text = chunk1 });
    try segments.append(std.testing.allocator, .{ .text = chunk2 });
    try segments.append(std.testing.allocator, .{ .text = chunk3 });

    try tb.rope().setSegments(segments.items);

    view.virtual_lines_dirty = true;

    view.setWrapMode(.word);
    view.setWrapWidth(18);

    const vlines = view.getVirtualLines();

    try std.testing.expectEqual(@as(usize, 2), vlines.len);

    try std.testing.expectEqual(@as(u32, 14), vlines[0].width_cols);

    try std.testing.expectEqual(@as(u32, 6), vlines[1].width_cols);

    var line_buf: [32]u8 = undefined;
    const line0_len = tb.getTextRange(vlines[0].document_cell_offset, vlines[0].document_cell_offset + vlines[0].width_cols, &line_buf);
    try std.testing.expectEqualStrings("hello my good ", line_buf[0..line0_len]);

    const line1_len = tb.getTextRange(vlines[1].document_cell_offset, vlines[1].document_cell_offset + vlines[1].width_cols, &line_buf);
    try std.testing.expectEqualStrings("friend", line_buf[0..line1_len]);
}

test "TextBufferView word wrapping - fragmented long word force-breaks by wrap width" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const text = "abcdefghijklmnopqrst";
    const mem_id = try tb.registerMemBuffer(text, false);

    var segments: std.ArrayListUnmanaged(seg_mod.Segment) = .empty;
    defer segments.deinit(std.testing.allocator);
    try segments.append(std.testing.allocator, .{ .linestart = {} });
    try segments.append(std.testing.allocator, .{ .text = tb.createChunk(mem_id, 0, 5) });
    try segments.append(std.testing.allocator, .{ .text = tb.createChunk(mem_id, 5, 13) });
    try segments.append(std.testing.allocator, .{ .text = tb.createChunk(mem_id, 13, 20) });
    try tb.rope().setSegments(segments.items);

    view.setWrapMode(.word);
    view.setWrapWidth(8);

    const vlines = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 3), vlines.len);
    try std.testing.expectEqualSlices(u32, &.{ 8, 8, 4 }, view.getCachedLineInfo().line_width_cols);
}

test "TextBufferView word wrapping - zero width still makes progress" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("word");
    view.setWrapMode(.word);
    view.setWrapWidth(0);

    try std.testing.expectEqual(@as(u32, 4), view.getVirtualLineCount());
    try std.testing.expectEqualSlices(u32, &.{ 1, 1, 1, 1 }, view.getCachedLineInfo().line_width_cols);
}

test "TextBufferView word wrapping - fragmented zero width delimiter ends pending word" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const text = "hello\u{200B}world";
    const mem_id = try tb.registerMemBuffer(text, false);
    var segments: std.ArrayListUnmanaged(seg_mod.Segment) = .empty;
    defer segments.deinit(std.testing.allocator);
    try segments.append(std.testing.allocator, .{ .linestart = {} });
    try segments.append(std.testing.allocator, .{ .text = tb.createChunk(mem_id, 0, 5) });
    try segments.append(std.testing.allocator, .{ .text = tb.createChunk(mem_id, 5, @intCast(text.len)) });
    try tb.rope().setSegments(segments.items);

    view.setWrapMode(.word);
    view.setWrapWidth(6);

    try std.testing.expectEqualSlices(u32, &.{ 5, 5 }, view.getCachedLineInfo().line_width_cols);
}

test "TextBufferView word wrapping - fragmented ASCII CJK transition is a boundary" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const text = "abc日本";
    const mem_id = try tb.registerMemBuffer(text, false);
    var segments: std.ArrayListUnmanaged(seg_mod.Segment) = .empty;
    defer segments.deinit(std.testing.allocator);
    try segments.append(std.testing.allocator, .{ .linestart = {} });
    try segments.append(std.testing.allocator, .{ .text = tb.createChunk(mem_id, 0, 3) });
    try segments.append(std.testing.allocator, .{ .text = tb.createChunk(mem_id, 3, @intCast(text.len)) });
    try tb.rope().setSegments(segments.items);

    view.setWrapMode(.word);
    view.setWrapWidth(5);

    // "abc日" fills the first line; the CJK run may break between characters.
    try std.testing.expectEqualSlices(u32, &.{ 5, 2 }, view.getCachedLineInfo().line_width_cols);
}

test "TextBufferView word wrapping - combining mark keeps base class across chunks" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const text = "a\u{0301}日本";
    const mem_id = try tb.registerMemBuffer(text, false);
    var segments: std.ArrayListUnmanaged(seg_mod.Segment) = .empty;
    defer segments.deinit(std.testing.allocator);
    try segments.append(std.testing.allocator, .{ .linestart = {} });
    try segments.append(std.testing.allocator, .{ .text = tb.createChunk(mem_id, 0, 3) });
    try segments.append(std.testing.allocator, .{ .text = tb.createChunk(mem_id, 3, @intCast(text.len)) });
    try tb.rope().setSegments(segments.items);

    view.setWrapMode(.word);
    view.setWrapWidth(4);
    // "a\u{0301}日" fills the first line; the CJK run may break between characters.
    try std.testing.expectEqualSlices(u32, &.{ 3, 2 }, view.getCachedLineInfo().line_width_cols);
}

test "TextBufferView word wrapping - CJK run wraps between characters" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    // "AB" = 2 cols, space = 1 col, each CJK char = 2 cols.
    try tb.setText("AB 测试文字");

    view.setWrapMode(.word);
    view.setWrapWidth(6);

    // "AB 测" (5) then "试文字" (6); without intercharacter breaks the CJK run
    // would drop to its own line and force-break after overflowing.
    try std.testing.expectEqualSlices(u32, &.{ 5, 6 }, view.getCachedLineInfo().line_width_cols);
}

test "TextBufferView word wrapping - ideographic punctuation never starts a line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("测试。文字");

    view.setWrapMode(.word);
    view.setWrapWidth(4);

    // "试。" stays together: no break opportunity exists before 。.
    try std.testing.expectEqualSlices(u32, &.{ 2, 4, 4 }, view.getCachedLineInfo().line_width_cols);
}

test "TextBufferView word wrapping - CJK break spans chunk boundary" {
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
    var segments: std.ArrayListUnmanaged(seg_mod.Segment) = .empty;
    defer segments.deinit(std.testing.allocator);
    try segments.append(std.testing.allocator, .{ .linestart = {} });
    try segments.append(std.testing.allocator, .{ .text = tb.createChunk(mem_id, 0, 6) });
    try segments.append(std.testing.allocator, .{ .text = tb.createChunk(mem_id, 6, @intCast(text.len)) });
    try tb.rope().setSegments(segments.items);

    view.setWrapMode(.word);
    view.setWrapWidth(4);

    // The 好|世 chunk edge is a break opportunity, so the run fills both lines
    // instead of carrying "好" into the second chunk as one word.
    try std.testing.expectEqualSlices(u32, &.{ 4, 4 }, view.getCachedLineInfo().line_width_cols);
}

test "TextBufferView word wrapping - non-CJK appends keep chunk-local boundaries" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();
    for ([_]@import("../utf8.zig").WidthMethod{ .unicode, .unicode_wide, .wcwidth, .no_zwj }) |method| {
        var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, method);
        defer tb.deinit();
        var view = try TextBufferView.init(std.testing.allocator, tb);
        defer view.deinit();
        try tb.append("\u{1f1e6}");
        try tb.append("\u{1f1e7}\u{1f1e8}");
        try tb.append("\u{1f1e9}\u{1f1ea}\u{1f1eb}");
        view.setWrapMode(.word);
        view.setWrapWidth(3);
        const measured = try view.measureForDimensions(3, 8);
        try std.testing.expectEqual(@as(u32, 2), measured.line_count);
        try std.testing.expectEqualSlices(u32, &.{ 3, 3 }, view.getCachedLineInfo().line_width_cols);
    }
}

test "TextBufferView word wrapping - CJK policy retains bytes and uses legacy fitting for split chunks" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();
    const cases = [_]struct { parts: []const []const u8, width: u32, widths: []const u32 }{
        .{ .parts = &.{ "\u{65e5}\u{672c}\u{1f1fa}", "\u{1f1f8}\u{1f1fa}\u{1f1f8}\u{8a9e}\u{6587}" }, .width = 4, .widths = &.{ 4, 4, 4 } },
        .{ .parts = &.{ "\u{65e5}\u{672c}\u{1f44b}", "\u{1f3fb}\u{8a9e}\u{6587}" }, .width = 4, .widths = &.{ 4, 4, 4 } },
        .{ .parts = &.{ "\u{65e5}\u{672c}\u{1f44b}", "\u{1f3fb}" ++ ("\u{8a9e}\u{6587}" ** 256) ++ "\u{65e5}", "abc" }, .width = 4, .widths = &(([_]u32{4} ** 258) ++ [_]u32{ 2, 3 }) },
        .{ .parts = &.{ "\u{304b}", "\u{3099}\u{304f}" }, .width = 8, .widths = &.{4} },
        .{ .parts = &.{ "\u{306f}", "\u{309a}\u{3072}" }, .width = 8, .widths = &.{4} },
        .{ .parts = &.{"\u{304b}\u{200d}\u{3099}"}, .width = 8, .widths = &.{2} },
        .{ .parts = &.{"\u{306f}\u{200d}\u{309a}"}, .width = 8, .widths = &.{2} },
        .{ .parts = &.{"AB \u{30ab}\u{30fb}\u{30ca}"}, .width = 6, .widths = &.{ 3, 6 } },
        .{ .parts = &.{ "AB \u{30ab}", "\u{30fb}\u{30ca}" }, .width = 6, .widths = &.{ 3, 6 } },
    };
    for ([_]@import("../utf8.zig").WidthMethod{ .unicode, .unicode_wide, .wcwidth, .no_zwj }) |method| {
        for (cases) |case| {
            var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, method);
            defer tb.deinit();
            var view = try TextBufferView.init(std.testing.allocator, tb);
            defer view.deinit();
            for (case.parts) |part| try tb.append(part);
            view.setWrapMode(.word);
            const expected = try std.mem.concat(std.testing.allocator, u8, case.parts);
            defer std.testing.allocator.free(expected);
            var actual: std.ArrayListUnmanaged(u8) = .empty;
            defer actual.deinit(std.testing.allocator);
            for ([_]u32{ case.width, case.width + 2, case.width }) |width| {
                view.setWrapWidth(width);
                const measured = try view.measureForDimensions(width, 8);
                const lines = view.getCachedLineInfo();
                try std.testing.expectEqual(lines.line_width_cols.len, measured.line_count);
                if (width == case.width) try std.testing.expectEqualSlices(u32, case.widths, lines.line_width_cols);
                actual.clearRetainingCapacity();
                for (view.getVirtualLines()) |line| {
                    for (line.chunks.items) |chunk| {
                        const bytes = chunk.chunk.getBytes(tb.memRegistry());
                        try actual.appendSlice(std.testing.allocator, bytes[chunk.byte_start_in_chunk..][0..chunk.byte_len]);
                    }
                }
                try std.testing.expectEqualStrings(expected, actual.items);
            }
        }
    }
}

test "TextBufferView wrapping - very narrow width (1 char)" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEF");

    view.setWrapMode(.char);
    view.setWrapWidth(2);
    const wrapped_count = view.getVirtualLineCount();

    try std.testing.expectEqual(@as(u32, 3), wrapped_count);
}

test "TextBufferView character wrapping - first line offset only changes initial width" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();
    try tb.setText("abcdef");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();
    view.setWrapMode(.char);
    view.setWrapWidth(4);
    view.setFirstLineOffset(2);

    const lines = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 2), lines.len);
    try std.testing.expectEqual(@as(u32, 2), lines[0].width_cols);
    try std.testing.expectEqual(@as(u32, 4), lines[1].width_cols);

    const measured = try view.measureForDimensions(4, 10);
    try std.testing.expectEqual(@as(u32, 2), measured.line_count);
    try std.testing.expectEqual(@as(u32, 4), measured.width_cols_max);
}

test "TextBufferView character wrapping - virtual chunks grow after exact capacity one" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();
    try tb.setText("abcdef");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();
    view.setWrapMode(.char);
    view.setWrapWidth(10);

    try std.testing.expectEqual(@as(usize, 1), view.getVirtualLines()[0].chunks.capacity);

    const mem_id = try tb.registerMemBuffer("abcdef", false);
    const segments = [_]seg_mod.Segment{
        .{ .linestart = {} },
        .{ .text = tb.createChunk(mem_id, 0, 2) },
        .{ .text = tb.createChunk(mem_id, 2, 4) },
        .{ .text = tb.createChunk(mem_id, 4, 6) },
    };
    try tb.rope().setSegments(&segments);
    tb.markViewsDirty();

    const chunks = view.getVirtualLines()[0].chunks;
    try std.testing.expectEqual(@as(usize, 3), chunks.items.len);
    try std.testing.expect(chunks.capacity >= chunks.items.len);
}

test "TextBufferView character wrapping - OOM discards partial layout without retry loop" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    try tb.setText("abcdefghij");

    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    var view = try TextBufferView.init(failing.allocator(), tb);
    defer view.deinit();
    view.setWrapMode(.char);
    view.setWrapWidth(2);

    failing.fail_index = failing.alloc_index;
    try std.testing.expectEqual(@as(u32, 0), view.getVirtualLineCount());
    try std.testing.expect(failing.has_induced_failure);
    try std.testing.expect(view.virtual_lines_dirty);
    try std.testing.expectEqual(@as(usize, 0), view.virtual_lines.items.len);
    try std.testing.expectEqual(@as(usize, 0), view.cached_line_starts.items.len);
    try std.testing.expectEqual(@as(usize, 0), view.cached_line_widths.items.len);
    try std.testing.expectEqual(@as(usize, 0), view.cached_line_sources.items.len);
}

test "TextBufferView word wrapping - streaming OOM discards partial layout" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    const text = try std.testing.allocator.alloc(u8, 70_000);
    defer std.testing.allocator.free(text);
    for (text, 0..) |*byte, i| byte.* = if (i % 2 == 0) 'a' else ' ';

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    try tb.setText(text);

    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    var view = try TextBufferView.init(failing.allocator(), tb);
    defer view.deinit();
    view.setWrapMode(.word);
    view.setWrapWidth(8);

    failing.fail_index = failing.alloc_index;
    try std.testing.expectEqual(@as(u32, 0), view.getVirtualLineCount());
    try std.testing.expect(failing.has_induced_failure);
    try std.testing.expect(view.virtual_lines_dirty);
    try std.testing.expectEqual(@as(usize, 0), view.virtual_lines.items.len);
    try std.testing.expectEqual(@as(usize, 0), view.cached_line_starts.items.len);
    try std.testing.expectEqual(@as(usize, 0), view.cached_line_widths.items.len);
    try std.testing.expectEqual(@as(usize, 0), view.cached_line_sources.items.len);
}

test "TextBufferView word wrapping - layout cache OOM falls back to complete streamed render" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const text = "a," ** 1023 ++ "\xC3\xA9";
    try tb.setText(text);

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();
    view.setWrapMode(.word);
    view.setWrapWidth(80);
    const measured = try view.measureForDimensions(80, 24);
    try std.testing.expectEqual(@as(u32, 26), measured.line_count);

    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0 });
    const layout_allocator = tb.layout_cache.allocator;
    tb.layout_cache.allocator = failing.allocator();
    defer tb.layout_cache.allocator = layout_allocator;
    const vlines = view.getVirtualLines();

    try std.testing.expect(failing.has_induced_failure);
    try std.testing.expectEqual(@as(usize, measured.line_count), vlines.len);
    var rendered_bytes: usize = 0;
    for (vlines) |vline| {
        for (vline.chunks.items) |chunk| rendered_bytes += chunk.byte_len;
    }
    try std.testing.expectEqual(text.len, rendered_bytes);
    try std.testing.expect(!view.virtual_lines_dirty);
}

test "TextBufferView wrapping - switch between char and word mode" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST");

    view.setWrapMode(.char);
    view.setWrapWidth(10);

    // Inclusive selection: focus cell (1,1) = offset 11 is selected too.
    _ = view.setLocalSelection(9, 0, 1, 1, null, null);

    const packed_info = view.packSelectionInfo();
    try std.testing.expect(packed_info != 0xFFFFFFFF_FFFFFFFF);

    const start = @as(u32, @intCast(packed_info >> 32));
    const end = @as(u32, @intCast(packed_info & 0xFFFFFFFF));
    try std.testing.expectEqual(@as(u32, 9), start);
    try std.testing.expectEqual(@as(u32, 12), end);
}

test "TextBufferView selection - spanning multiple wrapped lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123");

    view.setWrapMode(.char);
    view.setWrapWidth(10);
    try std.testing.expectEqual(@as(u32, 3), view.getVirtualLineCount());

    // Inclusive selection: focus cell (8,2) = offset 28 is selected too.
    _ = view.setLocalSelection(2, 0, 8, 2, null, null);

    const packed_info = view.packSelectionInfo();
    try std.testing.expect(packed_info != 0xFFFFFFFF_FFFFFFFF);

    const start = @as(u32, @intCast(packed_info >> 32));
    const end = @as(u32, @intCast(packed_info & 0xFFFFFFFF));
    try std.testing.expectEqual(@as(u32, 2), start);
    try std.testing.expectEqual(@as(u32, 29), end);
}

test "TextBufferView selection - changes when wrap width changes" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    try std.testing.expectEqual(@as(u32, 16), end);

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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("");

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 1), line_count);

    const line_info = view.getCachedLineInfo();
    try std.testing.expectEqual(@as(usize, 1), line_info.line_start_cols.len);
    try std.testing.expectEqual(@as(u32, 0), line_info.line_start_cols[0]);
    try std.testing.expectEqual(@as(u32, 0), line_info.line_width_cols[0]);
}

test "TextBufferView line info - simple text without newlines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 1), line_count);

    const line_info = view.getCachedLineInfo();
    try std.testing.expectEqual(@as(u32, 0), line_info.line_start_cols[0]);
    try std.testing.expect(line_info.line_width_cols[0] > 0);
}

test "TextBufferView line info - text ending with newline" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World\n");

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 2), line_count);

    const line_info = view.getCachedLineInfo();
    try std.testing.expectEqual(@as(u32, 0), line_info.line_start_cols[0]);
    try std.testing.expect(line_info.line_width_cols[0] > 0);
    try std.testing.expect(line_info.line_width_cols[1] >= 0);
}

test "TextBufferView line info - consecutive newlines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 1\n\nLine 3");

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 3), line_count);

    const line_info = view.getCachedLineInfo();
    try std.testing.expectEqual(@as(u32, 0), line_info.line_start_cols[0]);
}

test "TextBufferView line info - only newlines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("\n\n\n");

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 4), line_count);

    const line_info = view.getCachedLineInfo();
    for (line_info.line_width_cols) |width| {
        try std.testing.expect(width >= 0);
    }
}

test "TextBufferView line info - wide characters (Unicode)" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello 世界 🌟");

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 1), line_count);

    const line_info = view.getCachedLineInfo();
    try std.testing.expect(line_info.line_width_cols[0] > 0);
}

test "TextBufferView line info - very long lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const longText = [_]u8{'A'} ** 1000;
    try tb.setText(&longText);

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 1), line_count);

    const line_info = view.getCachedLineInfo();
    try std.testing.expect(line_info.line_width_cols[0] > 0);
}

test "TextBufferView line info - buffer with only whitespace" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("   \n \n ");

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 3), line_count);

    const line_info = view.getCachedLineInfo();
    for (line_info.line_width_cols) |width| {
        try std.testing.expect(width >= 0);
    }
}

test "TextBufferView line info - single character lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("A\nB\nC");

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 3), line_count);

    const line_info = view.getCachedLineInfo();
    for (line_info.line_width_cols) |width| {
        try std.testing.expect(width > 0);
    }
}

test "TextBufferView line info - complex Unicode combining characters" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("café\nnaïve\nrésumé");

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 3), line_count);

    const line_info = view.getCachedLineInfo();
    for (line_info.line_width_cols) |width| {
        try std.testing.expect(width > 0);
    }
}

test "TextBufferView line info - extremely long single line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const extremelyLongText = [_]u8{'A'} ** 10000;
    try tb.setText(&extremelyLongText);

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 1), line_count);

    const line_info = view.getCachedLineInfo();
    try std.testing.expect(line_info.line_width_cols[0] > 0);
}

test "TextBufferView line info - extremely long line with wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("\nHello World");

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 2), line_count);

    const line_info = view.getCachedLineInfo();
    try std.testing.expectEqual(@as(u32, 0), line_info.line_start_cols[0]);

    try std.testing.expectEqual(@as(u32, 1), line_info.line_start_cols[1]);
}

test "TextBufferView line info - lines with different widths" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var text_builder: std.ArrayListUnmanaged(u8) = .empty;
    defer text_builder.deinit(std.testing.allocator);
    try text_builder.appendSlice(std.testing.allocator, "Short\n");
    try text_builder.appendNTimes(std.testing.allocator, 'A', 50);
    try text_builder.appendSlice(std.testing.allocator, "\nMedium");
    const text = text_builder.items;

    try tb.setText(text);

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 3), line_count);

    const line_info = view.getCachedLineInfo();
    try std.testing.expect(line_info.line_width_cols[0] < line_info.line_width_cols[1]);
    try std.testing.expect(line_info.line_width_cols[1] > line_info.line_width_cols[2]);
}

test "TextBufferView line info - alternating empty and content lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("\nContent\n\nMore\n\n");

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 6), line_count);

    const line_info = view.getCachedLineInfo();
    for (line_info.line_width_cols) |width| {
        try std.testing.expect(width >= 0);
    }
}

test "TextBufferView line info - thousands of lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var text_builder: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer text_builder.deinit();

    var i: u32 = 0;
    while (i < 999) : (i += 1) {
        try text_builder.writer.print("Line {}\n", .{i});
    }
    try text_builder.writer.print("Line {}", .{i});

    try tb.setText(text_builder.written());

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 1000), line_count);

    const line_info = view.getCachedLineInfo();
    try std.testing.expectEqual(@as(u32, 0), line_info.line_start_cols[0]);

    var line_idx: u32 = 1;
    while (line_idx < 1000) : (line_idx += 1) {
        try std.testing.expect(line_info.line_start_cols[line_idx] > line_info.line_start_cols[line_idx - 1]);
    }
}

test "TextBufferView highlights - add single highlight to line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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

    try std.testing.expectEqual(@as(u32, 0), vline0_info.source_col_start);
    try std.testing.expectEqual(@as(u32, 10), vline1_info.source_col_start);

    try std.testing.expect(vline0_info.spans.len > 0);
    try std.testing.expect(vline1_info.spans.len > 0);
}

test "TextBufferView measureForDimensions - does not modify cache" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    try std.testing.expectEqual(@as(u32, 10), result.width_cols_max);

    // Now check that the actual cached virtual lines are NOT changed
    const actual_count = view.getVirtualLineCount();
    // Should be 1 line because wrap_width is 100
    try std.testing.expectEqual(@as(u32, 1), actual_count);
}

test "TextBufferView measureForDimensions - cache invalidates after updateVirtualLines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("AAAAA");
    view.setWrapMode(.char);
    view.setWrapWidth(5);

    const result1 = try view.measureForDimensions(5, 10);
    try std.testing.expectEqual(@as(u32, 1), result1.line_count);
    try std.testing.expectEqual(@as(u32, 5), result1.width_cols_max);

    try tb.setText("AAAAAAAAAA");

    // This clears the dirty flag, which would cause a false cache hit
    // if we keyed on dirty instead of epoch.
    _ = view.getVirtualLineCount();

    const result2 = try view.measureForDimensions(5, 10);
    try std.testing.expectEqual(@as(u32, 2), result2.line_count);
    try std.testing.expectEqual(@as(u32, 5), result2.width_cols_max);
}

test "TextBufferView measureForDimensions - width 0 uses intrinsic line widths" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("abc\ndefghij");
    view.setWrapMode(.char);

    const result = try view.measureForDimensions(0, 24);
    try std.testing.expectEqual(tb.getLineCount(), result.line_count);
    try std.testing.expectEqual(iter_mod.getMaxLineWidth(tb.rope()), result.width_cols_max);
}

test "TextBufferView measureForDimensions - no wrap matches multi-segment line widths" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("AAAA");
    try tb.append("BBBB");
    view.setWrapMode(.none);

    const line_info = view.getCachedLineInfo();
    var expected_max: u32 = 0;
    for (line_info.line_width_cols) |w| {
        expected_max = @max(expected_max, w);
    }

    const result = try view.measureForDimensions(80, 24);
    try std.testing.expectEqual(expected_max, result.width_cols_max);
    try std.testing.expectEqual(@as(u32, @intCast(line_info.line_width_cols.len)), result.line_count);
}

test "TextBufferView measureForDimensions - cache invalidates on switchToBuffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var other_tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer other_tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("AAAAAA");
    view.setWrapMode(.char);

    const result1 = try view.measureForDimensions(10, 10);
    try std.testing.expectEqual(@as(u32, 6), result1.width_cols_max);

    try other_tb.setText("BBBBBBBBBB");
    try std.testing.expectEqual(tb.getContentEpoch(), other_tb.getContentEpoch());

    view.switchToBuffer(other_tb);

    const result2 = try view.measureForDimensions(10, 10);
    try std.testing.expectEqual(@as(u32, 10), result2.width_cols_max);
    try std.testing.expectEqual(@as(u32, 1), result2.line_count);
}

test "TextBufferView measureForDimensions - char wrap" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST");
    view.setWrapMode(.char);

    // Test different widths
    const result1 = try view.measureForDimensions(10, 10);
    try std.testing.expectEqual(@as(u32, 2), result1.line_count);
    try std.testing.expectEqual(@as(u32, 10), result1.width_cols_max);

    const result2 = try view.measureForDimensions(5, 10);
    try std.testing.expectEqual(@as(u32, 4), result2.line_count);
    try std.testing.expectEqual(@as(u32, 5), result2.width_cols_max);

    const result3 = try view.measureForDimensions(20, 10);
    try std.testing.expectEqual(@as(u32, 1), result3.line_count);
    try std.testing.expectEqual(@as(u32, 20), result3.width_cols_max);
}

test "TextBufferView measureForDimensions - no wrap mode" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello\nWorld\nTest");
    view.setWrapMode(.none);

    // With no wrap, width shouldn't matter
    const result = try view.measureForDimensions(3, 10);
    try std.testing.expectEqual(@as(u32, 3), result.line_count);
    // width_cols_max should be the longest line
    try std.testing.expect(result.width_cols_max >= 4);
}

test "TextBufferView measureForDimensions - word wrap" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello wonderful world");
    view.setWrapMode(.word);

    const result = try view.measureForDimensions(10, 10);
    // Should wrap at word boundaries
    try std.testing.expect(result.line_count >= 2);
    try std.testing.expect(result.width_cols_max <= 10);
}

test "TextBufferView measureForDimensions - word summary OOM returns computed result" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();

    const text = try std.testing.allocator.alloc(u8, 512);
    defer std.testing.allocator.free(text);
    @memset(text, 'a');
    try tb.setText(text);

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();
    view.setWrapMode(.word);

    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0 });
    const internal_allocator = tb.allocator;
    tb.allocator = failing.allocator();
    defer tb.allocator = internal_allocator;
    const result = try view.measureForDimensions(80, 24);

    try std.testing.expect(failing.has_induced_failure);
    try std.testing.expectEqual(@as(u32, 7), result.line_count);
    try std.testing.expectEqual(@as(u32, 80), result.width_cols_max);

    const recomputed = try view.measureForDimensions(79, 24);
    try std.testing.expectEqual(@as(u32, 7), recomputed.line_count);
    try std.testing.expectEqual(@as(u32, 79), recomputed.width_cols_max);
}

test "TextBufferView word wrap - first line offset reduces initial line width" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText(" located");
    view.setWrapMode(.word);
    view.setWrapWidth(20);
    view.setFirstLineOffset(17);

    const vlines = view.getVirtualLines();

    try std.testing.expectEqual(@as(usize, 2), vlines.len);
    try std.testing.expectEqual(@as(u32, 1), vlines[0].width_cols);
    try std.testing.expectEqual(@as(u32, 7), vlines[1].width_cols);
}

test "TextBufferView measureForDimensions - fragmented word wrap matches render with first line offset" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const text = "prefix fragmentedword suffix";
    const mem_id = try tb.registerMemBuffer(text, false);

    var segments: std.ArrayListUnmanaged(seg_mod.Segment) = .empty;
    defer segments.deinit(std.testing.allocator);
    try segments.append(std.testing.allocator, .{ .linestart = {} });
    try segments.append(std.testing.allocator, .{ .text = tb.createChunk(mem_id, 0, 10) });
    try segments.append(std.testing.allocator, .{ .text = tb.createChunk(mem_id, 10, 18) });
    try segments.append(std.testing.allocator, .{ .text = tb.createChunk(mem_id, 18, @intCast(text.len)) });
    try tb.rope().setSegments(segments.items);

    view.setWrapMode(.word);
    view.setWrapWidth(12);
    view.setFirstLineOffset(5);

    const measured = try view.measureForDimensions(12, 24);
    const vlines = view.getVirtualLines();
    var rendered_width_max: u32 = 0;
    for (vlines) |vline| rendered_width_max = @max(rendered_width_max, vline.width_cols);

    try std.testing.expectEqual(@as(u32, @intCast(vlines.len)), measured.line_count);
    try std.testing.expectEqual(rendered_width_max, measured.width_cols_max);
}

test "TextBufferView measureForDimensions - empty buffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("");
    view.setWrapMode(.char);

    const result = try view.measureForDimensions(10, 10);
    try std.testing.expectEqual(@as(u32, 1), result.line_count);
    try std.testing.expectEqual(@as(u32, 0), result.width_cols_max);
}

test "TextBufferView truncation - basic truncate single line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST");

    view.setTruncate(true);
    view.setWrapMode(.none);
    view.setViewport(.{ .x = 0, .y = 0, .width = 10, .height = 5 });

    const vlines = view.getVirtualLines();

    // With truncation, line should be truncated to viewport width
    try std.testing.expectEqual(@as(usize, 1), vlines.len);
    // Width should be reduced (prefix + suffix, ellipsis handled separately)
    try std.testing.expect(vlines[0].width_cols <= 10);
}

test "TextBufferView truncation - allocation failure is atomic and retryable" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    var view = try TextBufferView.init(failing.allocator(), tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    view.setWrapMode(.none);
    view.setViewport(.{ .x = 0, .y = 0, .width = 10, .height = 1 });
    view.setTruncate(true);
    view.updateVirtualLines();
    const original = view.virtual_lines.items[0];
    try std.testing.expectEqual(@as(u32, 26), original.width_cols);
    try std.testing.expectEqual(@as(usize, 1), original.chunks.items.len);
    const original_chunk = original.chunks.items[0];

    failing.fail_index = failing.alloc_index;
    const failed = view.getVirtualLines()[0];
    try std.testing.expect(failing.has_induced_failure);
    try std.testing.expectEqual(@as(u32, 26), failed.width_cols);
    try std.testing.expect(!failed.is_truncated);
    try std.testing.expectEqual(@as(usize, 1), failed.chunks.items.len);
    try std.testing.expectEqualDeep(original_chunk, failed.chunks.items[0]);

    failing.fail_index = std.math.maxInt(usize);
    const retried = view.getVirtualLines()[0];
    try std.testing.expect(retried.is_truncated);
    try std.testing.expectEqual(@as(u32, 10), retried.width_cols);
    try std.testing.expectEqual(@as(usize, 3), retried.chunks.items.len);
}

test "TextBufferView truncation - fitting prebuilt lines do not allocate" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    var view = try TextBufferView.init(failing.allocator(), tb);
    defer view.deinit();

    var text: std.ArrayListUnmanaged(u8) = .empty;
    defer text.deinit(std.testing.allocator);
    for (0..4096) |_| try text.appendSlice(std.testing.allocator, "fit\n");
    try tb.setText(text.items);
    view.setWrapMode(.none);
    view.setViewport(.{ .x = 0, .y = 0, .width = 10, .height = 4096 });
    view.setTruncate(true);
    view.updateVirtualLines();

    const allocation_index = failing.alloc_index;
    failing.fail_index = allocation_index;
    _ = view.getVirtualLines();

    try std.testing.expect(!failing.has_induced_failure);
    try std.testing.expectEqual(allocation_index, failing.alloc_index);
}

test "TextBufferView truncation - replacement staging is proportional to overflow" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();
    var tracking = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    var view = try TextBufferView.init(tracking.allocator(), tb);
    defer view.deinit();

    var text: std.ArrayListUnmanaged(u8) = .empty;
    defer text.deinit(std.testing.allocator);
    try text.appendSlice(std.testing.allocator, "first line overflows\n");
    for (0..4096) |_| try text.appendSlice(std.testing.allocator, "fit\n");
    try text.appendSlice(std.testing.allocator, "last line overflows");
    try tb.setText(text.items);
    view.setWrapMode(.none);
    view.setViewport(.{ .x = 0, .y = 0, .width = 10, .height = 4098 });
    view.setTruncate(true);
    view.updateVirtualLines();

    const Replacement = struct {
        chunks: std.ArrayListUnmanaged(text_buffer_view.VirtualChunk) = .empty,
        width_cols: u32 = 0,
        is_truncated: bool = false,
        ellipsis_col: u32 = 0,
        truncation_suffix_col_start: u32 = 0,
    };
    const allocated_bytes = tracking.allocated_bytes;
    const lines = view.getVirtualLines();

    try std.testing.expect(lines[0].is_truncated);
    try std.testing.expect(lines[lines.len - 1].is_truncated);
    try std.testing.expectEqual(2 * @sizeOf(Replacement), tracking.allocated_bytes - allocated_bytes);
}

test "TextBufferView truncation - multiline with truncate" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST\nShortLine\nAnotherVeryLongLineHere");

    view.setTruncate(true);
    view.setWrapMode(.none);
    view.setViewport(.{ .x = 0, .y = 0, .width = 12, .height = 5 });

    const vlines = view.getVirtualLines();

    try std.testing.expectEqual(@as(usize, 3), vlines.len);

    // First line should be truncated
    try std.testing.expect(vlines[0].width_cols <= 12);
    // Second line is short, should not be truncated
    try std.testing.expectEqual(@as(u32, 9), vlines[1].width_cols);
    // Third line should be truncated
    try std.testing.expect(vlines[2].width_cols <= 12);
}

test "TextBufferView truncation - with wrapping disabled" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("0123456789ABCDEFGHIJ");

    view.setTruncate(true);
    view.setWrapMode(.none);
    view.setViewport(.{ .x = 0, .y = 0, .width = 15, .height = 1 });

    const vlines = view.getVirtualLines();

    try std.testing.expectEqual(@as(usize, 1), vlines.len);
    // Should be truncated to fit viewport
    try std.testing.expect(vlines[0].width_cols <= 15);
}

test "TextBufferView truncation - toggle truncate on and off" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ");

    view.setWrapMode(.none);
    view.setViewport(.{ .x = 0, .y = 0, .width = 10, .height = 1 });

    // Without truncation
    view.setTruncate(false);
    var vlines = view.getVirtualLines();
    const width_no_truncate = vlines[0].width_cols;

    // With truncation
    view.setTruncate(true);
    vlines = view.getVirtualLines();
    const width_with_truncate = vlines[0].width_cols;

    try std.testing.expectEqual(@as(u32, 26), width_no_truncate);
    try std.testing.expect(width_with_truncate <= 10);
}

test "TextBufferView truncation - very small viewport" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Hello World");

    view.setTruncate(true);
    view.setWrapMode(.none);
    view.setViewport(.{ .x = 0, .y = 0, .width = 3, .height = 1 });

    const vlines = view.getVirtualLines();

    // With width=3, only room for "..." - should clear the line
    try std.testing.expectEqual(@as(u32, 0), vlines[0].width_cols);
}

test "TextBufferView truncation - empty suffix retains the source end" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDE好");
    view.setWrapMode(.none);
    view.setTruncate(true);

    for (2..5) |width| {
        view.setViewport(.{ .x = 0, .y = 0, .width = @intCast(width), .height = 1 });
        const line = view.getVirtualLines()[0];
        try std.testing.expect(line.is_truncated);
        try std.testing.expectEqual(@as(u32, 7), line.truncation_suffix_col_start);
    }
}

test "TextBufferView truncation - verify ellipsis chunk injection" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("0123456789ABCDEFGHIJ");

    view.setTruncate(true);
    view.setWrapMode(.none);
    view.setViewport(.{ .x = 0, .y = 0, .width = 10, .height = 1 });

    const vlines = view.getVirtualLines();

    try std.testing.expectEqual(@as(usize, 1), vlines.len);
    try std.testing.expectEqual(@as(u32, 10), vlines[0].width_cols);

    // Should have 3 chunks: prefix, ellipsis, suffix
    try std.testing.expectEqual(@as(usize, 3), vlines[0].chunks.items.len);

    // Verify the middle chunk is the ellipsis
    const ellipsis_chunk = vlines[0].chunks.items[1];
    try std.testing.expectEqual(@as(u32, 3), ellipsis_chunk.width_cols);

    // Get the ellipsis text to verify it's "..."
    const ellipsis_text = ellipsis_chunk.chunk.getBytes(tb.memRegistry());
    try std.testing.expectEqualStrings("...", ellipsis_text);
}

test "TextBufferView truncation - works with wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ");

    view.setTruncate(true);
    view.setWrapMode(.char);
    view.setWrapWidth(10);
    view.setViewport(.{ .x = 0, .y = 0, .width = 15, .height = 5 });

    const vlines = view.getVirtualLines();

    // With char wrap at 10, should wrap into multiple lines first
    // Then truncation should apply to lines exceeding viewport width
    try std.testing.expect(vlines.len >= 2);
}

test "TextBufferView truncation - verify prefix and suffix content" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("0123456789ABCDEFGHIJ");

    view.setTruncate(true);
    view.setWrapMode(.none);
    view.setViewport(.{ .x = 0, .y = 0, .width = 10, .height = 1 });

    const vlines = view.getVirtualLines();
    const chunks = vlines[0].chunks.items;

    // Should have 3 chunks: prefix, ellipsis, suffix
    try std.testing.expectEqual(@as(usize, 3), chunks.len);

    // Middle chunk (ellipsis)
    const ellipsis_bytes = chunks[1].chunk.getBytes(tb.memRegistry());

    // Verify ellipsis is correct
    try std.testing.expectEqualStrings("...", ellipsis_bytes);

    // Verify total width matches viewport
    try std.testing.expectEqual(@as(u32, 10), vlines[0].width_cols);
}

test "TextBufferView truncation - byte windows snap around wide graphemes" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDE가FG");
    view.setWrapMode(.none);
    view.setTruncate(true);
    view.setViewport(.{ .x = 0, .y = 0, .width = 8, .height = 1 });

    const line = view.getVirtualLines()[0];
    try std.testing.expectEqual(@as(u32, 7), line.width_cols);
    try std.testing.expectEqual(@as(u32, 2), line.ellipsis_col);
    try std.testing.expectEqual(@as(u32, 7), line.truncation_suffix_col_start);
    try std.testing.expectEqual(@as(usize, 3), line.chunks.items.len);

    for (line.chunks.items) |chunk| {
        const bytes = chunk.chunk.getBytes(tb.memRegistry());
        const window = bytes[chunk.byte_start_in_chunk .. chunk.byte_start_in_chunk + chunk.byte_len];
        try std.testing.expect(std.unicode.utf8ValidateSlice(window));
    }
    const prefix = line.chunks.items[0];
    const suffix = line.chunks.items[2];
    try std.testing.expectEqualStrings("AB", prefix.chunk.getBytes(tb.memRegistry())[prefix.byte_start_in_chunk .. prefix.byte_start_in_chunk + prefix.byte_len]);
    try std.testing.expectEqualStrings("FG", suffix.chunk.getBytes(tb.memRegistry())[suffix.byte_start_in_chunk .. suffix.byte_start_in_chunk + suffix.byte_len]);
}

test "TextBufferView wcwidth wrapping keeps grapheme byte windows atomic" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("A👋🏻B👩‍💻C");
    view.setWrapMode(.char);
    view.setWrapWidth(2);

    const expected = [_][]const u8{ "A", "👋🏻", "B", "👩‍💻", "C" };
    const lines = view.getVirtualLines();
    try std.testing.expectEqual(expected.len, lines.len);
    for (lines, expected) |line, expected_window| {
        try std.testing.expectEqual(@as(usize, 1), line.chunks.items.len);
        const chunk = line.chunks.items[0];
        const bytes = chunk.chunk.getBytes(tb.memRegistry());
        const window = bytes[chunk.byte_start_in_chunk .. chunk.byte_start_in_chunk + chunk.byte_len];
        try std.testing.expect(std.unicode.utf8ValidateSlice(window));
        try std.testing.expectEqualStrings(expected_window, window);
    }
    try std.testing.expectEqual(@as(u32, 4), lines[1].width_cols);
    try std.testing.expectEqual(@as(u32, 4), lines[3].width_cols);
}

test "TextBufferView wcwidth truncation does not start suffix inside grapheme" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDE👋🏻Z");
    view.setWrapMode(.none);
    view.setTruncate(true);
    view.setViewport(.{ .x = 0, .y = 0, .width = 8, .height = 1 });

    const line = view.getVirtualLines()[0];
    try std.testing.expectEqual(@as(usize, 3), line.chunks.items.len);
    const suffix = line.chunks.items[2];
    const bytes = suffix.chunk.getBytes(tb.memRegistry());
    const window = bytes[suffix.byte_start_in_chunk .. suffix.byte_start_in_chunk + suffix.byte_len];
    try std.testing.expect(std.unicode.utf8ValidateSlice(window));
    try std.testing.expectEqualStrings("Z", window);
}

test "TextBufferView measureForDimensions - multiple lines with different widths" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Short\nAVeryLongLineHere\nMedium");
    view.setWrapMode(.char);

    const result = try view.measureForDimensions(10, 10);
    // "Short" (1 line), "AVeryLongLineHere" (2 lines), "Medium" (1 line) = 4 lines
    try std.testing.expectEqual(@as(u32, 4), result.line_count);
    try std.testing.expectEqual(@as(u32, 10), result.width_cols_max);
}

test "TextBufferView highlights - multiple highlights on wrapped line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
        try std.testing.expectEqual(@as(u32, @intCast(i * 10)), vline_info.source_col_start);
    }
}

test "TextBufferView highlights - with emojis and wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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

    try std.testing.expectEqual(@as(u32, 0), vline0_info.source_col_start);
    try std.testing.expect(vline1_info.source_col_start == 6);

    try std.testing.expect(vline0_info.spans.len > 0);
}

test "TextBufferView highlights - with CJK characters and wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
            try std.testing.expectEqual(@as(u32, 0), vline_info.source_col_start);
        } else if (i == 1) {
            try std.testing.expectEqual(@as(u32, 6), vline_info.source_col_start);
        }
    }
}

test "TextBufferView highlights - mixed ASCII and wide chars with wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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

    try std.testing.expectEqual(@as(u32, 0), vline0_info.source_col_start);
    try std.testing.expectEqual(@as(u32, 7), vline1_info.source_col_start);

    try std.testing.expect(vline0_info.spans.len > 0);
    try std.testing.expect(vline1_info.spans.len > 0);
}

test "TextBufferView highlights - emoji at wrap boundary" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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

    try std.testing.expectEqual(@as(u32, 0), vline0_info.source_col_start);
    try std.testing.expect(vline1_info.source_col_start >= 4);
}

test "TextBufferView highlights - emojis without wrapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 1\nLine 2\nLine 3");

    try std.testing.expectEqual(@as(u32, 3), view.getVirtualLineCount());
    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());

    const line_info = view.getCachedLineInfo();
    try std.testing.expectEqual(@as(usize, 3), line_info.line_start_cols.len);
    try std.testing.expectEqual(@as(usize, 3), line_info.line_width_cols.len);
}

test "TextBufferView virtual lines - updated when wrap width set" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    try std.testing.expectEqual(@as(usize, 2), line_info.line_start_cols.len);
    try std.testing.expectEqual(@as(usize, 2), line_info.line_width_cols.len);
}

test "TextBufferView virtual lines - multi-line text without wrap" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("First line\n\nThird line with more text\n");

    try std.testing.expectEqual(@as(u32, 4), view.getVirtualLineCount());

    const line_info = view.getCachedLineInfo();
    try std.testing.expectEqual(@as(usize, 4), line_info.line_start_cols.len);
    try std.testing.expectEqual(@as(usize, 4), line_info.line_width_cols.len);

    // Verify the line starts are monotonically non-decreasing (empty lines have same start)
    try std.testing.expect(line_info.line_start_cols[0] == 0);
    try std.testing.expect(line_info.line_start_cols[1] >= line_info.line_start_cols[0]);
    try std.testing.expect(line_info.line_start_cols[2] >= line_info.line_start_cols[1]);
    try std.testing.expect(line_info.line_start_cols[3] >= line_info.line_start_cols[2]);
}

test "TextBufferView line info - line starts and widths consistency" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("ABCDEFGHIJKLMNOPQRST");

    view.setWrapMode(.char);
    view.setWrapWidth(7);
    const line_count = view.getVirtualLineCount();
    const line_info = view.getCachedLineInfo();

    try std.testing.expectEqual(@as(usize, line_count), line_info.line_start_cols.len);
    try std.testing.expectEqual(@as(usize, line_count), line_info.line_width_cols.len);

    for (line_info.line_width_cols, 0..) |width, i| {
        if (i < line_info.line_width_cols.len - 1) {
            try std.testing.expect(width <= 7);
        }
    }
}

test "TextBufferView line info - line starts monotonically increasing" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var text_builder: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer text_builder.deinit();

    var i: u32 = 0;
    while (i < 99) : (i += 1) {
        try text_builder.writer.print("Line {}\n", .{i});
    }
    try text_builder.writer.print("Line {}", .{i});

    try tb.setText(text_builder.written());

    const line_count = view.getVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 100), line_count);

    const line_info = view.getCachedLineInfo();
    try std.testing.expectEqual(@as(u32, 0), line_info.line_start_cols[0]);

    var line_idx: u32 = 1;
    while (line_idx < 100) : (line_idx += 1) {
        try std.testing.expect(line_info.line_start_cols[line_idx] >= line_info.line_start_cols[line_idx - 1]);
    }
}

test "TextBufferView - highlights preserved after wrap width change" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    view.setWrapMode(.char);
    view.setWrapWidth(10);

    try tb.setText("ABCDEFGHIJKLMNOPQRST");
    try std.testing.expectEqual(@as(u32, 2), view.getVirtualLineCount());

    const info1 = view.getCachedLineInfo();
    try std.testing.expectEqual(@as(usize, 2), info1.line_start_cols.len);

    try tb.setText("Short");
    try std.testing.expectEqual(@as(u32, 1), view.getVirtualLineCount());

    const info2 = view.getCachedLineInfo();
    try std.testing.expectEqual(@as(usize, 1), info2.line_start_cols.len);

    try tb.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    const vline_count = view.getVirtualLineCount();
    try std.testing.expect(vline_count >= 3);

    const info3 = view.getCachedLineInfo();
    try std.testing.expect(info3.line_start_cols.len >= 3);
}

test "TextBufferView automatic updates - reset clears content and marks views dirty" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try std.testing.expect(view.getTabIndicator() == null);
    try std.testing.expect(view.getTabIndicatorColor() == null);

    view.setTabIndicator(@as(u32, '·'));
    view.setTabIndicatorColor(ansi.rgbaFromFloats(0.4, 0.4, 0.4, 1.0));

    try std.testing.expectEqual(@as(u32, '·'), view.getTabIndicator().?);
    try std.testing.expectEqual(@as(u8, 102), ansi.red(view.getTabIndicatorColor().?));
}

test "TextBufferView findVisualLineIndex - finds correct line for wrapped text" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
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

    // Column 51 is consumed separator whitespace and remains associated with the preceding visual line.
    const idx51 = view.findVisualLineIndex(0, 51);
    try std.testing.expectEqual(@as(u32, 2), idx51);
}

test "TextBufferView word wrapping - chunk at exact wrap boundary" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const text = "hello world ddddddddd";
    const mem_id = try tb.registerMemBuffer(text, false);

    const Segment = seg_mod.Segment;

    var segments: std.ArrayListUnmanaged(Segment) = .empty;
    defer segments.deinit(std.testing.allocator);

    try segments.append(std.testing.allocator, .{ .linestart = {} });

    const chunk1 = tb.createChunk(mem_id, 0, 17);
    try segments.append(std.testing.allocator, .{ .text = chunk1 });

    const chunk2 = tb.createChunk(mem_id, 17, 21);
    try segments.append(std.testing.allocator, .{ .text = chunk2 });

    try tb.rope().setSegments(segments.items);
    view.virtual_lines_dirty = true;

    view.setWrapMode(.word);
    view.setWrapWidth(17);

    const vlines = view.getVirtualLines();

    try std.testing.expectEqual(@as(usize, 2), vlines.len);
    try std.testing.expectEqual(@as(u32, 12), vlines[0].width_cols);
    try std.testing.expectEqual(@as(u32, 9), vlines[1].width_cols);
}

test "TextBufferView word wrapping - does not split 'uses' across lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const text =
        "So: the per‑repo config is the baseline; the -c flags are a “don’t depend on baseline” guard for commands where output consistency matters. " ++
        "Revert uses checkout, which is less about output formatting and already respects the repo config, so it didn’t get the extra guard. " ++
        "If you want stricter consistency, we can add -c core.autocrlf=false there too.";

    try tb.setText(text);
    view.setWrapMode(.word);

    var split_found = false;

    var width: u32 = 100;
    while (width >= 80) : (width -= 1) {
        view.setWrapWidth(width);

        const vlines = view.getVirtualLines();
        var i: usize = 0;
        while (i + 1 < vlines.len) : (i += 1) {
            var line_buf: [1024]u8 = undefined;
            var next_line_buf: [1024]u8 = undefined;

            const line_len = tb.getTextRange(vlines[i].document_cell_offset, vlines[i].document_cell_offset + vlines[i].width_cols, &line_buf);
            const next_line_len = tb.getTextRange(
                vlines[i + 1].document_cell_offset,
                vlines[i + 1].document_cell_offset + vlines[i + 1].width_cols,
                &next_line_buf,
            );

            const line = std.mem.trim(u8, line_buf[0..line_len], " \t");
            const next_line = std.mem.trim(u8, next_line_buf[0..next_line_len], " \t");

            const split_u = std.mem.endsWith(u8, line, "Revert u") and std.mem.startsWith(u8, next_line, "ses checkout");
            const split_us = std.mem.endsWith(u8, line, "Revert us") and std.mem.startsWith(u8, next_line, "es checkout");
            const split_use = std.mem.endsWith(u8, line, "Revert use") and std.mem.startsWith(u8, next_line, "s checkout");

            if (split_u or split_us or split_use) {
                split_found = true;
                break;
            }
        }

        if (split_found or width == 80) {
            break;
        }
    }

    try std.testing.expect(!split_found);
}

test "TextBufferView wrap indent - same pads continuations and narrows wrap width" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var text_buf: [84]u8 = undefined;
    @memset(text_buf[0..4], ' ');
    @memset(text_buf[4..], 'a');
    try tb.setText(&text_buf);

    view.setWrapMode(.char);
    view.setWrapWidth(20);
    view.setWrapIndent(.same);

    const vlines = view.getVirtualLines();
    try std.testing.expect(vlines.len >= 2);
    try std.testing.expectEqual(@as(u32, 0), vlines[0].pad_cols);
    try std.testing.expectEqual(@as(u32, 20), vlines[0].width_cols);
    try std.testing.expectEqual(@as(u32, 4), vlines[1].pad_cols);
    try std.testing.expectEqual(@as(u32, 16), vlines[1].width_cols);
    // Visual occupancy of continuation = pad + content <= wrap width
    try std.testing.expectEqual(@as(u32, 20), vlines[1].pad_cols + vlines[1].width_cols);
}

test "TextBufferView wrap indent - none keeps pad_cols zero" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var text_buf: [84]u8 = undefined;
    @memset(text_buf[0..4], ' ');
    @memset(text_buf[4..], 'a');
    try tb.setText(&text_buf);

    view.setWrapMode(.char);
    view.setWrapWidth(20);
    view.setWrapIndent(.none);

    const vlines = view.getVirtualLines();
    try std.testing.expect(vlines.len >= 2);
    for (vlines) |vline| {
        try std.testing.expectEqual(@as(u32, 0), vline.pad_cols);
    }
    try std.testing.expectEqual(@as(u32, 20), vlines[0].width_cols);
    try std.testing.expectEqual(@as(u32, 20), vlines[1].width_cols);
}

test "TextBufferView wrap indent - clamp when indent >= wrap width" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var text_buf: [60]u8 = undefined;
    @memset(text_buf[0..20], ' ');
    @memset(text_buf[20..], 'b');
    try tb.setText(&text_buf);

    view.setWrapMode(.char);
    view.setWrapWidth(20);
    view.setWrapIndent(.same);

    const vlines = view.getVirtualLines();
    try std.testing.expect(vlines.len >= 2);
    for (vlines) |vline| {
        try std.testing.expectEqual(@as(u32, 0), vline.pad_cols);
    }
}

test "TextBufferView wrap indent - leading tab uses tab width" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();
    tb.setTabWidth(4);

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var text_buf: [81]u8 = undefined;
    text_buf[0] = '\t';
    @memset(text_buf[1..], 'c');
    try tb.setText(&text_buf);

    view.setWrapMode(.char);
    view.setWrapWidth(20);
    view.setWrapIndent(.same);

    const vlines = view.getVirtualLines();
    try std.testing.expect(vlines.len >= 2);
    try std.testing.expectEqual(@as(u32, 0), vlines[0].pad_cols);
    try std.testing.expectEqual(@as(u32, 4), vlines[1].pad_cols);
}

test "TextBufferView wrap indent - mixed spaces and tab use fixed tab width" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();
    tb.setTabWidth(4);

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    // Engine tab width is fixed (2 spaces + tab = 6), not a modulo tab stop (would be 4).
    var text_buf: [83]u8 = undefined;
    text_buf[0] = ' ';
    text_buf[1] = ' ';
    text_buf[2] = '\t';
    @memset(text_buf[3..], 'd');
    try tb.setText(&text_buf);

    view.setWrapMode(.char);
    view.setWrapWidth(20);
    view.setWrapIndent(.same);

    const vlines = view.getVirtualLines();
    try std.testing.expect(vlines.len >= 2);
    try std.testing.expectEqual(@as(u32, 0), vlines[0].pad_cols);
    try std.testing.expectEqual(@as(u32, 6), vlines[1].pad_cols);
}

test "TextBufferView wrap indent - short indented line has no pad" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("    hello");
    view.setWrapMode(.char);
    view.setWrapWidth(20);
    view.setWrapIndent(.same);

    const vlines = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 1), vlines.len);
    try std.testing.expectEqual(@as(u32, 0), vlines[0].pad_cols);
}

test "TextBufferView wrap indent - ignored when wrapMode is none" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var text_buf: [84]u8 = undefined;
    @memset(text_buf[0..4], ' ');
    @memset(text_buf[4..], 'a');
    try tb.setText(&text_buf);

    view.setWrapMode(.none);
    view.setWrapWidth(20);
    view.setWrapIndent(.same);

    const vlines = view.getVirtualLines();
    try std.testing.expectEqual(@as(usize, 1), vlines.len);
    try std.testing.expectEqual(@as(u32, 0), vlines[0].pad_cols);
}

test "TextBufferView wrap indent - click on pad maps to content start" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var text_buf: [84]u8 = undefined;
    @memset(text_buf[0..4], ' ');
    @memset(text_buf[4..], 'a');
    try tb.setText(&text_buf);

    view.setWrapMode(.char);
    view.setWrapWidth(20);
    view.setWrapIndent(.same);

    const vlines = view.getVirtualLines();
    try std.testing.expect(vlines.len >= 2);
    const content_start = vlines[1].document_cell_offset;

    // Click on pad column 0 of continuation row
    _ = view.setLocalSelection(0, 1, 1, 1, null, null);
    const sel = view.getSelection().?;
    try std.testing.expectEqual(content_start, sel.start);

    // Click on content column after pad should advance past content start
    view.resetLocalSelection();
    _ = view.setLocalSelection(5, 1, 6, 1, null, null);
    const sel2 = view.getSelection().?;
    try std.testing.expectEqual(content_start + 1, sel2.start);
}

test "TextBufferView wrap indent - measure includes continuation pad" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    // Word wrap: first visual row is short; continuation occupies full wrap width with pad.
    try tb.setText("    hello world_and_more");
    view.setWrapMode(.word);
    view.setWrapIndent(.same);

    const result = try view.measureForDimensions(12, 10);
    try std.testing.expect(result.line_count >= 2);
    try std.testing.expectEqual(@as(u32, 12), result.width_cols_max);
}

test "TextBufferView wrap indent - truncation accounts for pad" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var text_buf: [84]u8 = undefined;
    @memset(text_buf[0..4], ' ');
    @memset(text_buf[4..], 'a');
    try tb.setText(&text_buf);

    view.setWrapMode(.char);
    view.setWrapWidth(20);
    view.setWrapIndent(.same);
    // Force a continuation that would overflow a narrower viewport if pad is ignored.
    view.setViewport(.{ .x = 0, .y = 0, .width = 18, .height = 10 });
    view.setTruncate(true);

    const vlines = view.getVirtualLines();
    try std.testing.expect(vlines.len >= 2);
    try std.testing.expectEqual(@as(u32, 4), vlines[1].pad_cols);
    try std.testing.expect(vlines[1].pad_cols + vlines[1].width_cols <= 18);
}
