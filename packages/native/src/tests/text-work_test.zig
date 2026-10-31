//! Work sentinels for text layout, drawing, and scanning. Each row pins the work an
//! operation does today; a change that removes work updates the row in the same commit.
const std = @import("std");
const TestPools = @import("test-pools.zig").TestPools;
const text_work = @import("../text-work.zig");
const iter_mod = @import("../text-buffer-iterators.zig");
const TextBuffer = @import("../text-buffer.zig").UnifiedTextBuffer;
const text_buffer_view = @import("../text-buffer-view.zig");
const TextBufferView = text_buffer_view.UnifiedTextBufferView;
const WrapMode = text_buffer_view.WrapMode;
const MeasureResult = text_buffer_view.MeasureResult;
const EditBuffer = @import("../edit-buffer.zig").EditBuffer;
const EditorView = @import("../editor-view.zig").EditorView;
const OptimizedBuffer = @import("../buffer.zig").OptimizedBuffer;
const scene_fixture = @import("scene_fixture_test.zig");
const utils = @import("../utils.zig");
const Counts = text_work.Counts;
const ControlDisplay = @import("../utf8.zig").ControlDisplay;

fn expectWork(expected: Counts) !void {
    const actual = text_work.take();
    if (std.meta.eql(expected, actual)) return;
    std.debug.print("expected {any}\nfound    {any}\n", .{ expected, actual });
    return error.TestExpectedEqual;
}

/// Checks the work of `call`, which Zig evaluates before this function runs.
fn expectAfter(call: anytype, expected: Counts) !void {
    _ = call;
    try expectWork(expected);
}

fn repeatLines(allocator: std.mem.Allocator, line: []const u8, count: usize) ![]u8 {
    var list: std.ArrayList(u8) = .empty;
    errdefer list.deinit(allocator);
    for (0..count) |i| {
        if (i > 0) try list.append(allocator, '\n');
        try list.appendSlice(allocator, line);
    }
    return list.toOwnedSlice(allocator);
}

fn repeatText(allocator: std.mem.Allocator, unit: []const u8, bytes: usize) ![]u8 {
    const count = bytes / unit.len;
    const text = try allocator.alloc(u8, count * unit.len);
    for (0..count) |i| @memcpy(text[i * unit.len ..][0..unit.len], unit);
    return text;
}

test "text work: edits in a 10,000-line editor lay out the edited line at the next frame" {
    const allocator = std.testing.allocator;
    var pools = TestPools.init(allocator);
    defer pools.deinit();
    const text = try repeatLines(allocator, "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor in", 10_000);
    defer allocator.free(text);
    const rows = [_]struct { mode: WrapMode, frame: Counts, measure: Counts }{
        .{
            .mode = .none,
            .frame = .{ .layouts = 1, .lines_laid_out = 1, .rope_diff_nodes = 93, .lines_shifted = 9_989, .splices = 1, .line_seeks = 12, .line_seek_nodes = 186, .clusters_drawn = 3_171 },
            // Unwrapped measure reads the widest line from the rope metrics.
            .measure = .{ .measure_passes = 1 },
        },
        .{
            .mode = .word,
            .frame = .{ .layouts = 1, .lines_laid_out = 1, .rope_diff_nodes = 93, .lines_shifted = 9_989, .splices = 1, .line_seeks = 12, .line_seek_nodes = 186, .clusters_drawn = 3_171, .ascii_bytes = 90 },
            .measure = .{ .measure_passes = 1, .measure_lines = 10_000, .ascii_bytes = 790_011 },
        },
        .{
            .mode = .char,
            .frame = .{ .layouts = 1, .lines_laid_out = 1, .rope_diff_nodes = 93, .lines_shifted = 9_989, .splices = 1, .line_seeks = 12, .line_seek_nodes = 186, .clusters_drawn = 3_171, .prefix_seeks = 2 },
            .measure = .{ .measure_passes = 1, .measure_lines = 10_000, .prefix_seeks = 10_001 },
        },
    };
    for (rows) |row| {
        const eb = try EditBuffer.init(allocator, &pools.graphemes, &pools.links, .unicode, null);
        defer eb.deinit();
        const ev = try EditorView.init(allocator, eb, 120, 40);
        defer ev.deinit();
        ev.setWrapMode(row.mode);
        try eb.setText(text);
        try eb.setCursor(10, 0);
        _ = ev.getVisualCursor();
        const screen = try OptimizedBuffer.init(allocator, 120, 40, .{ .pool = &pools.graphemes, .link_pool = &pools.links });
        defer screen.deinit();
        screen.drawEditorView(ev, 0, 0);

        errdefer std.debug.print("mode {s}\n", .{@tagName(row.mode)});
        _ = text_work.take();
        try eb.insertText("x");
        try expectWork(.{ .line_seeks = 2, .line_seek_nodes = 30 });
        for (0..10) |_| try eb.insertText("x");
        try expectWork(.{ .line_seeks = 20, .line_seek_nodes = 310 });
        screen.drawEditorView(ev, 0, 0);
        try expectWork(row.frame);
        eb.moveRight();
        try expectWork(.{ .line_seeks = 7, .line_seek_nodes = 109, .prefix_seeks = 1, .grapheme_width_reads = 1 });
        _ = try ev.getTextBufferView().measureForDimensions(100, 40);
        try expectWork(row.measure);
    }
}

test "text work: a burst of K edits lays the editor out once, at the next frame" {
    const allocator = std.testing.allocator;
    var pools = TestPools.init(allocator);
    defer pools.deinit();
    const line = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor in";
    for ([_]u64{ 1_000, 10_000 }) |lines| {
        const text = try repeatLines(allocator, line, lines);
        defer allocator.free(text);
        for ([_]WrapMode{ .none, .word, .char }) |mode| for ([_]u64{ 1, 10, 100 }) |k| {
            const eb = try EditBuffer.init(allocator, &pools.graphemes, &pools.links, .unicode, null);
            defer eb.deinit();
            const ev = try EditorView.init(allocator, eb, 120, 40);
            defer ev.deinit();
            ev.setWrapMode(mode);
            try eb.setText(text);
            try eb.setCursor(10, 0);
            const screen = try OptimizedBuffer.init(allocator, 120, 40, .{ .pool = &pools.graphemes, .link_pool = &pools.links });
            defer screen.deinit();
            screen.drawEditorView(ev, 0, 0);

            errdefer std.debug.print("lines {d} mode {s} K {d}\n", .{ lines, @tagName(mode), k });
            _ = text_work.take();
            for (0..k) |_| try eb.insertText("x");
            const burst = text_work.take();
            try std.testing.expectEqual([2]u64{ 0, 0 }, [2]u64{ burst.layouts, burst.lines_laid_out });
            screen.drawEditorView(ev, 0, 0);
            const frame = text_work.take();
            try std.testing.expectEqual([2]u64{ 1, 1 }, [2]u64{ frame.layouts, frame.lines_laid_out });
        };
    }
}

test "text work: the frame after one edit lays out and measures only the lines it changed" {
    const allocator = std.testing.allocator;
    var pools = TestPools.init(allocator);
    defer pools.deinit();
    const line = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor in";
    const paste = utils.repeat(u8, "pasted line of text that is shorter than the wrap width\n", 100);
    const Op = enum { insert, delete, paste, undo, enter, join };
    // Lines laid out = document lines × `per_line` + `extra`. Before dirty line ranges, every
    // row was 1 × the document (paste +100, Enter +1, join −1).
    const rows = [_]struct { op: Op, per_line: u64, extra: i64 }{
        .{ .op = .insert, .per_line = 0, .extra = 1 },
        .{ .op = .delete, .per_line = 0, .extra = 1 },
        .{ .op = .paste, .per_line = 0, .extra = 101 },
        .{ .op = .undo, .per_line = 0, .extra = 1 },
        .{ .op = .enter, .per_line = 0, .extra = 2 },
        .{ .op = .join, .per_line = 0, .extra = 1 },
    };
    for ([_]u64{ 1_000, 10_000 }) |lines| {
        const text = try repeatLines(allocator, line, lines);
        defer allocator.free(text);
        for ([_]bool{ true, false }) |viewport| for ([_]WrapMode{ .none, .word, .char }) |mode| for (rows) |row| {
            const eb = try EditBuffer.init(allocator, &pools.graphemes, &pools.links, .unicode, null);
            defer eb.deinit();
            const ev = try EditorView.init(allocator, eb, 120, 40);
            defer ev.deinit();
            // Without a viewport: a plain view that wraps at 120 and is read without drawing.
            const plain = try TextBufferView.init(allocator, eb.getTextBuffer());
            defer plain.deinit();
            ev.setWrapMode(mode);
            plain.setWrapMode(mode);
            plain.setWrapWidth(120);
            try eb.setText(text);
            try eb.setCursor(10, if (row.op == .delete) 5 else 0);
            if (row.op == .undo) try eb.insertText("x");
            const screen = try OptimizedBuffer.init(allocator, 120, 40, .{ .pool = &pools.graphemes, .link_pool = &pools.links });
            defer screen.deinit();
            screen.drawEditorView(ev, 0, 0);
            _ = plain.getVirtualLineCount();
            // Yoga measures at the render width and, for a box narrower than its space, at another.
            const view = if (viewport) ev.getTextBufferView() else plain;
            for ([_]u32{ 120, 100 }) |width| _ = try view.measureForDimensions(width, 40);

            errdefer std.debug.print("lines {d} viewport {} mode {s} op {s}\n", .{ lines, viewport, @tagName(mode), @tagName(row.op) });
            switch (row.op) {
                .insert => try eb.insertText("x"),
                .delete, .join => try eb.backspace(),
                .paste => try eb.insertText(paste),
                .undo => _ = try eb.undo(),
                .enter => try eb.insertText("\n"),
            }
            _ = text_work.take();
            for ([_]u32{ 120, 100 }) |width| _ = try view.measureForDimensions(width, 40);
            if (viewport) screen.drawEditorView(ev, 0, 0) else _ = plain.getVirtualLineCount();
            const frame = text_work.take();
            const laid_out: u64 = @intCast(@as(i64, @intCast(lines * row.per_line)) + row.extra);
            // Every edit is at row 10 (a join at row 9), so the offsets of the lines after row 10 move.
            try std.testing.expectEqual([3]u64{ 1, laid_out, lines - 11 }, [3]u64{ frame.layouts, frame.lines_laid_out, frame.lines_shifted });
            // The measure at the render width reads the render layout; the other measures the changed
            // lines into its ledger. Before, both walked the document. Unwrapped ones read the rope.
            const expected: [2]u64 = if (mode == .none) .{ 2, 0 } else .{ 1, laid_out };
            try std.testing.expectEqual(expected, [2]u64{ frame.measure_passes, frame.measure_lines });
        };
    }
}

/// Peak capacity of `arena` against a full layout of the final text, in bytes.
const ArenaPeak = struct {
    peak: usize = 0,
    fn sample(self: *ArenaPeak, arena: *const std.heap.ArenaAllocator) void {
        self.peak = @max(self.peak, arena.queryCapacity());
    }
};

// Partial layouts leave replaced lines and word metadata in the view's arenas. A full layout frees
// them once the dead bytes exceed the live ones (plus 16 KiB), so the bytes stay within twice a
// fresh layout's. Arena blocks grow by half each, and in-place growth depends on the page size,
// so capacity is checked against 4 × a fresh layout's capacity in the same run, plus 64 KiB.
test "text work: replaced lines and word metadata stay within a constant factor of a fresh layout" {
    const allocator = std.testing.allocator;
    var pools = TestPools.init(allocator);
    defer pools.deinit();
    const slack = 64 * 1024;
    // A long unwrapped line typed into at moving positions: every frame replaces its whole row.
    {
        const long = try repeatText(allocator, "a", 20_000);
        defer allocator.free(long);
        const text = try std.mem.concat(allocator, u8, &.{ long, "\nend" });
        defer allocator.free(text);
        const eb = try EditBuffer.init(allocator, &pools.graphemes, &pools.links, .unicode, null);
        defer eb.deinit();
        const view = try TextBufferView.init(allocator, eb.getTextBuffer());
        defer view.deinit();
        try eb.setText(text);
        _ = view.getVirtualLineCount();
        var arena: ArenaPeak = .{};
        var prng = std.Random.DefaultPrng.init(7);
        for (0..2_000) |i| {
            if (i % 10 == 0) try eb.setCursor(0, prng.random().uintAtMost(u32, 20_000));
            try eb.insertText("b");
            _ = view.getVirtualLineCount();
            arena.sample(view.virtual_lines_arena);
        }
        const fresh = try TextBufferView.init(allocator, eb.getTextBuffer());
        defer fresh.deinit();
        _ = fresh.getVirtualLineCount();
        errdefer std.debug.print("unwrapped: peak {d}, fresh {d}\n", .{ arena.peak, fresh.virtual_lines_arena.queryCapacity() });
        try std.testing.expect(arena.peak <= 4 * fresh.virtual_lines_arena.queryCapacity() + slack);
    }
    // Word metadata: a one-line paragraph, and many lines whose edits alternate with width changes.
    const rows = [_]struct { line: []const u8, lines: usize, rewrap: bool }{
        .{ .line = utils.repeat(u8, "word ", 40), .lines = 1, .rewrap = false },
        .{ .line = "alpha \u{754c} e\u{301} words and more words", .lines = 200, .rewrap = true },
    };
    for (rows) |row| {
        const text = try repeatLines(allocator, row.line, row.lines);
        defer allocator.free(text);
        const eb = try EditBuffer.init(allocator, &pools.graphemes, &pools.links, .unicode, null);
        defer eb.deinit();
        const view = try TextBufferView.init(allocator, eb.getTextBuffer());
        defer view.deinit();
        view.setWrapMode(.word);
        view.setWrapWidth(20);
        try eb.setText(text);
        try eb.setCursor(@intCast(row.lines / 2), 3);
        _ = view.getVirtualLineCount();
        var storage: ArenaPeak = .{};
        for (0..3_000) |frame| {
            if (frame % 2 == 0) try eb.insertText("x") else try eb.backspace();
            if (row.rewrap) view.setWrapWidth(if (frame % 4 < 2) 20 else 21);
            _ = view.getVirtualLineCount();
            storage.sample(&view.word_layout.arena);
        }
        const fresh = try TextBufferView.init(allocator, eb.getTextBuffer());
        defer fresh.deinit();
        fresh.setWrapMode(.word);
        fresh.setWrapWidth(view.wrap_width);
        _ = fresh.getVirtualLineCount();
        errdefer std.debug.print("lines {d}: peak {d}, fresh {d}\n", .{ row.lines, storage.peak, fresh.word_layout.arena.queryCapacity() });
        try std.testing.expect(storage.peak <= 4 * fresh.word_layout.arena.queryCapacity() + slack);
    }
}

test "text work: an append to a 5,000-line view measures and lays out its last line once" {
    const allocator = std.testing.allocator;
    var pools = TestPools.init(allocator);
    defer pools.deinit();
    const text = try repeatLines(allocator, "The quick brown fox jumps over the lazy dog, again and again and again.", 5_000);
    defer allocator.free(text);
    const tb = try TextBuffer.init(allocator, &pools.graphemes, &pools.links, .unicode);
    defer tb.deinit();
    const view = try TextBufferView.init(allocator, tb);
    defer view.deinit();
    view.setWrapMode(.word);
    try tb.setText(text);
    _ = try view.measureForDimensions(40, 24);
    view.setWrapWidth(40);
    _ = view.getVirtualLineCount();

    _ = text_work.take();
    try tb.append(" token");
    _ = try view.measureForDimensions(40, 24);
    _ = try view.measureForDimensions(40, 24);
    _ = view.getVirtualLineCount();
    // The measure at the render width lays out the last line again, and the render reuses it.
    // Before the shared measure: 1 pass of 5,000 measure lines.
    try expectWork(.{ .layouts = 1, .lines_laid_out = 1, .rope_diff_nodes = 73, .splices = 1, .line_seeks = 4, .line_seek_nodes = 57, .ascii_bytes = 77 });
}

test "text work: rejoining a grapheme split across chunks copies only that grapheme" {
    const allocator = std.testing.allocator;
    var pools = TestPools.init(allocator);
    defer pools.deinit();
    const text = try repeatLines(allocator, "line", 10_000);
    defer allocator.free(text);
    // Appends copy their bytes as before; a join adds the tail it moves (an appended grapheme's
    // start). Edits copy their bytes to the add buffer as before; a join adds the grapheme it copies.
    const Row = struct { set: []const u8, append: ?[]const u8 = null, typed: []const []const u8 = &.{}, col: u32 = 0, joins: u64, bytes: u64 };
    const rows = [_]Row{
        .{ .set = "abc", .append = "def", .joins = 0, .bytes = 0 },
        .{ .set = "\u{65e5}", .append = "\u{672c}", .joins = 0, .bytes = 0 },
        .{ .set = "\u{1f1e6}\u{1f1e7}\u{1f1e8}", .append = "\u{1f1e9}", .joins = 1, .bytes = 4 },
        .{ .set = "\u{1f1e6}\u{1f1e7}", .append = "\u{1f1e8}", .joins = 0, .bytes = 0 },
        .{ .set = "x", .typed = &.{ "abc", "\u{65e5}\u{672c}" }, .col = 1, .joins = 0, .bytes = 0 },
        // Typed in place: the mark follows `e` in the add buffer, so the chunks split there.
        .{ .set = "x", .typed = &.{ "e", "\u{301}" }, .col = 1, .joins = 1, .bytes = 0 },
        .{ .set = "ex", .typed = &.{"\u{301}"}, .col = 5, .joins = 1, .bytes = 3 },
    };
    for (rows) |row| {
        const eb = try EditBuffer.init(allocator, &pools.graphemes, &pools.links, .unicode, null);
        defer eb.deinit();
        try eb.setText(text);
        try eb.tb.append(row.set);
        if (row.append) |bytes| {
            _ = text_work.take();
            try eb.tb.appendCopy(bytes);
        } else {
            try eb.setCursor(10_000, row.col);
            _ = text_work.take();
            for (row.typed) |bytes| try eb.insertText(bytes);
        }
        const work = text_work.take();
        try std.testing.expectEqual([2]u64{ row.joins, row.bytes }, [2]u64{ work.grapheme_joins, work.grapheme_join_bytes });
    }
}

test "text work: line lookups after an edit in a 10,000-line buffer" {
    const allocator = std.testing.allocator;
    var pools = TestPools.init(allocator);
    defer pools.deinit();
    const text = try repeatLines(allocator, "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor in", 10_000);
    defer allocator.free(text);

    const eb = try EditBuffer.init(allocator, &pools.graphemes, &pools.links, .unicode, null);
    defer eb.deinit();
    try eb.setText(text);
    try eb.setCursor(5_000, 3);
    _ = text_work.take();
    try eb.insertText("x");
    try eb.backspace();
    // A deletion takes its cursor from the join, not from a lookup of the line it shortened.
    try expectWork(.{ .line_seeks = 13, .line_seek_nodes = 212, .prefix_seeks = 3 });
    try eb.deleteForward();
    try expectWork(.{ .line_seeks = 13, .line_seek_nodes = 203, .prefix_seeks = 3, .grapheme_width_reads = 1 });

    const tb = eb.getTextBuffer();
    try tb.append("\nappended");
    _ = tb.lineWidthAt(10_000);
    try expectWork(.{ .line_seeks = 1, .line_seek_nodes = 17 });
    // A highlight seeks its first line and walks the leaves of the lines it covers.
    try tb.addHighlightByCharRange(0, tb.getLength(), 1, 1, 0);
    try expectWork(.{ .line_seeks = 2, .line_seek_nodes = 29, .highlight_leaves = 30_003, .line_span_builds = 10_001, .line_span_highlights = 10_001 });
    try tb.addHighlightByCharRange(5_000 * 80 + 3, 5_000 * 80 + 9, 1, 1, 0);
    try expectWork(.{ .line_seeks = 2, .line_seek_nodes = 30, .highlight_leaves = 3, .line_span_builds = 1, .line_span_highlights = 2 });

    // Zero-width appends have no weight; balancing counts their leaves, so the depth stays logarithmic.
    const zero_width = try TextBuffer.init(allocator, &pools.graphemes, &pools.links, .unicode);
    defer zero_width.deinit();
    try zero_width.setText(text);
    for (0..200) |_| try zero_width.append("\u{200b}");
    try std.testing.expect(zero_width.rope().root.depth() <= 2 * std.math.log2_int_ceil(u32, zero_width.rope().count()));
    _ = text_work.take();
    _ = zero_width.lineWidthAt(9_999);
    _ = iter_mod.offsetToCoords(zero_width.rope(), zero_width.textEndOffset());
    try expectWork(.{ .line_seeks = 3, .line_seek_nodes = 53 });
}

test "text work: drawing a long line scrolled right or down searches for its first visible cluster and span" {
    const allocator = std.testing.allocator;
    var pools = TestPools.init(allocator);
    defer pools.deinit();
    // With `part`, the line is appended in chunks of that many bytes. `prefix` goes before the
    // units. A truncated line puts the end of its chunk after the ellipsis. A wrapped line draws
    // its top, middle, and bottom 30 rows; on the old linear scan the bottom rows of the CJK line
    // took 3,913,800 search steps. With `highlight`, columns 4k and 4k+1 are highlighted; the old
    // linear span scan took 1,948,200 steps for the bottom rows.
    const rows = [_]struct { unit: []const u8, part: usize = 0, prefix: []const u8 = "", control: ControlDisplay = .hidden, truncate: bool = false, wrap: WrapMode = .none, highlight: bool = false, xs: [3]u32 = .{ 1_000, 50_000, 130_000 }, scan: [3]u64 = .{ 0, 0, 0 }, spans: [3]u64 = .{ 0, 0, 0 }, reads: u64 = 0, steps: [3]u64, drawn: [3]u64 }{
        .{ .unit = "a", .steps = .{ 0, 0, 0 }, .drawn = .{ 80, 80, 80 } },
        .{ .unit = "a", .prefix = "0123456789\x01", .reads = 1, .steps = .{ 0, 0, 0 }, .drawn = .{ 80, 80, 80 } },
        .{ .unit = "a", .prefix = "0123456789\x01", .control = .notation, .reads = 1, .steps = .{ 1, 1, 1 }, .drawn = .{ 80, 80, 80 } },
        .{ .unit = "a", .prefix = "0123456789\u{200b}", .reads = 1, .steps = .{ 0, 0, 0 }, .drawn = .{ 80, 80, 80 } },
        .{ .unit = "a", .prefix = "0123456789\u{200b}", .control = .notation, .reads = 1, .steps = .{ 0, 0, 0 }, .drawn = .{ 80, 80, 80 } },
        .{ .unit = "a", .truncate = true, .xs = .{ 10, 40, 60 }, .steps = .{ 0, 1, 2 }, .drawn = .{ 70, 40, 20 } },
        .{ .unit = "\u{754c}", .truncate = true, .xs = .{ 10, 40, 60 }, .scan = .{ 17, 17, 17 }, .steps = .{ 18, 1, 7 }, .drawn = .{ 36, 20, 10 } },
        .{ .unit = "\u{754c}", .part = 3 * 1024, .steps = .{ 11, 35, 74 }, .drawn = .{ 40, 40, 40 } },
        .{ .unit = "\u{754c}", .steps = .{ 18, 18, 18 }, .drawn = .{ 40, 40, 40 } },
        .{ .unit = "\u{1f600}", .steps = .{ 18, 18, 18 }, .drawn = .{ 40, 40, 40 } },
        .{ .unit = "ab\t", .steps = .{ 18, 18, 18 }, .drawn = .{ 60, 60, 60 } },
        .{ .unit = "e\u{301}", .steps = .{ 18, 18, 18 }, .drawn = .{ 80, 80, 80 } },
        .{ .unit = "\u{754c}", .wrap = .char, .scan = .{ 308, 510, 510 }, .steps = .{ 0, 0, 0 }, .drawn = .{ 1_200, 1_200, 1_192 } },
        .{ .unit = "\u{754c}", .wrap = .word, .scan = .{ 308, 510, 510 }, .steps = .{ 0, 0, 0 }, .drawn = .{ 1_200, 1_200, 1_192 } },
        .{ .unit = "e\u{301}", .wrap = .char, .scan = .{ 337, 510, 510 }, .steps = .{ 0, 0, 0 }, .drawn = .{ 2_400, 2_400, 2_352 } },
        .{ .unit = "\tab", .wrap = .char, .scan = .{ 279, 510, 510 }, .steps = .{ 0, 0, 0 }, .drawn = .{ 1_800, 1_800, 1_776 } },
        .{ .unit = "\u{1f600}", .wrap = .word, .scan = .{ 301, 510, 510 }, .steps = .{ 0, 0, 0 }, .drawn = .{ 1_200, 1_200, 1_192 } },
        .{ .unit = "ab\u{754c}c\u{1f600}d e\u{301}f\tgh ", .wrap = .word, .scan = .{ 300, 570, 570 }, .steps = .{ 0, 0, 0 }, .drawn = .{ 1_950, 1_950, 1_911 } },
        .{ .unit = "a", .highlight = true, .spans = .{ 9, 15, 16 }, .steps = .{ 0, 0, 0 }, .drawn = .{ 80, 80, 80 } },
        .{ .unit = "a", .highlight = true, .truncate = true, .xs = .{ 10, 40, 60 }, .spans = .{ 627, 629, 325 }, .steps = .{ 0, 1, 2 }, .drawn = .{ 70, 40, 20 } },
        .{ .unit = "a", .highlight = true, .wrap = .char, .spans = .{ 272, 479, 480 }, .steps = .{ 0, 0, 0 }, .drawn = .{ 2_400, 2_400, 2_352 } },
    };
    for (rows) |row| {
        const units = try repeatText(allocator, row.unit, 131_072 * row.unit.len);
        defer allocator.free(units);
        const text = try std.mem.concat(allocator, u8, &.{ row.prefix, units });
        defer allocator.free(text);
        const tb = try TextBuffer.initWithOptions(allocator, &pools.graphemes, &pools.links, .unicode, .{ .control_display = row.control });
        defer tb.deinit();
        const view = try TextBufferView.init(allocator, tb);
        defer view.deinit();
        if (row.part == 0) try tb.setText(text) else {
            var start: usize = 0;
            while (start < text.len) : (start += row.part) try tb.append(text[start..@min(start + row.part, text.len)]);
        }
        tb.startHighlightsTransaction();
        var col: u32 = 0;
        while (row.highlight and col < text.len) : (col += 4) try tb.addHighlightByCharRange(col, col + 2, 1, 1, 0);
        tb.endHighlightsTransaction();
        view.setTruncate(row.truncate);
        view.setWrapMode(row.wrap);
        view.setViewport(.{ .x = 0, .y = 0, .width = 80, .height = 30 });
        const count: u32 = view.getVirtualLineCount();
        const screen = try OptimizedBuffer.init(allocator, 80, 30, .{ .pool = &pools.graphemes, .link_pool = &pools.links });
        defer screen.deinit();
        const offsets: [3]u32 = if (row.wrap == .none) row.xs else .{ 0, count / 2, count - 30 };
        for (offsets, row.scan, row.spans, row.steps, row.drawn) |offset, scan, span_steps, steps, drawn| {
            if (row.wrap == .none) view.setViewport(.{ .x = offset, .y = 0, .width = 80, .height = 1 }) else view.setViewport(.{ .x = 0, .y = offset, .width = 80, .height = 30 });
            screen.drawTextBuffer(view, 0, 0);
            _ = text_work.take();
            screen.drawTextBuffer(view, 0, 0);
            try expectWork(.{ .cluster_scan_steps = scan, .left_skip_steps = steps, .span_search_steps = span_steps, .clusters_drawn = drawn, .grapheme_width_reads = row.reads });
        }
    }
}

test "text work: a changed scene frame lays out an auto-height text node once for measure and paint" {
    const allocator = std.testing.allocator;
    const f = try scene_fixture.Fixture.init(allocator, 80, 24, .{});
    defer f.deinit();
    const node = try f.owner.sceneCreateNode(f.id, 2, 2);
    // Width 80, height from measurement; the scene text default is word wrap.
    try f.owner.sceneSetStyle(node, 4, 0, 0, 1, 80, 1);
    try f.owner.sceneMoveNode(node, f.root, 0);
    const text = try repeatLines(allocator, "The quick brown fox jumps over the lazy dog, again and again and again and again.", 5_000);
    defer allocator.free(text);
    try f.owner.sceneSetText(node, text);

    // The first frame measures before paint gives the view its width, so it walks the text twice.
    _ = text_work.take();
    try scene_fixture.repaint(f.owner, f.id, .{ 0, 0, 0, 255 }, false, 0);
    try expectWork(.{ .layouts = 1, .lines_laid_out = 5_000, .measure_passes = 1, .measure_lines = 5_000, .clusters_drawn = 972, .ascii_bytes = 810_000 });
    try scene_fixture.repaint(f.owner, f.id, .{ 0, 0, 0, 255 }, false, 0);
    try expectWork(.{ .clusters_drawn = 972 });
    text[10] = 'X';
    try f.owner.sceneSetText(node, text);
    _ = text_work.take();
    try scene_fixture.repaint(f.owner, f.id, .{ 0, 0, 0, 255 }, false, 0);
    // The measure lays the node out at its width and paint reuses it; the text is new, so every
    // line. Before: a measure pass of 5,000 lines as well.
    try expectWork(.{ .layouts = 1, .lines_laid_out = 5_000, .clusters_drawn = 972, .ascii_bytes = 405_000 });

    // An auto-height wrapped editor: after a one-character edit, measure and paint share one
    // layout of the edited line. Before: 5,000 measure lines and 1 laid-out line.
    try f.owner.sceneDestroyNode(node);
    const edit = try f.owner.createEditBuffer(.unicode);
    const editor = try f.owner.createEditorView(edit, 1, 1);
    try f.owner.editorCommand(editor, .{ .wrap_mode = .word });
    const editor_node = try f.owner.sceneCreateNode(f.id, 5, 2);
    try f.owner.sceneSetEditorView(editor_node, editor);
    try f.owner.sceneSetStyle(editor_node, 4, 0, 0, 1, 80, 1);
    try f.owner.sceneMoveNode(editor_node, f.root, 0);
    try f.owner.editSetText(edit, text, false);
    try scene_fixture.repaint(f.owner, f.id, .{ 0, 0, 0, 255 }, false, 0);
    try f.owner.editSetCursor(edit, 10, 0);
    try f.owner.editInsertText(edit, "x");
    _ = text_work.take();
    try scene_fixture.repaint(f.owner, f.id, .{ 0, 0, 0, 255 }, false, 0);
    const frame = text_work.take();
    try std.testing.expectEqual([4]u64{ 1, 1, 0, 0 }, [4]u64{ frame.layouts, frame.lines_laid_out, frame.measure_passes, frame.measure_lines });
}

/// Loads the parts as chunks, measures once at each width to warm, then returns the work
/// of measuring again at each width. The measure cache holds 3 widths, so all 8 miss.
fn measureSweep(allocator: std.mem.Allocator, pools: *TestPools, parts: []const []const u8, mode: WrapMode, results: ?*[8]MeasureResult) !Counts {
    const tb = try TextBuffer.init(allocator, &pools.graphemes, &pools.links, .wcwidth);
    defer tb.deinit();
    const view = try TextBufferView.init(allocator, tb);
    defer view.deinit();
    try tb.setText(parts[0]);
    for (parts[1..]) |part| try tb.append(part);
    // No render width, so every width is measured, not read from a layout.
    view.setWrapMode(mode);
    for (76..84) |width| _ = try view.measureForDimensions(@intCast(width), 100);
    _ = text_work.take();
    for (76..84, 0..) |width, i| {
        const result = try view.measureForDimensions(@intCast(width), 100);
        if (results) |out| out[i] = result;
    }
    return text_work.take();
}

test "text work: wrapping one long line costs work linear in its length" {
    const allocator = std.testing.allocator;
    var pools = TestPools.init(allocator);
    defer pools.deinit();
    const rows = [_]struct { unit: []const u8, mode: WrapMode }{
        .{ .unit = "x", .mode = .word },
        .{ .unit = "\u{e9}", .mode = .word },
        .{ .unit = "xxxxxxxxxx ", .mode = .word },
        .{ .unit = utils.repeat(u8, "\u{e9}", 10) ++ " ", .mode = .word },
        .{ .unit = "x", .mode = .char },
        .{ .unit = "\u{e9}", .mode = .char },
    };
    for (rows) |row| {
        var work: [2]Counts = undefined;
        errdefer std.debug.print("unit \"{s}\" mode {s}:\n{any}\n{any}\n", .{ row.unit, @tagName(row.mode), work[0], work[1] });
        for (&work, [_]usize{ 20_000, 40_000 }) |*counts, bytes| {
            const text = try repeatText(allocator, row.unit, bytes);
            defer allocator.free(text);
            counts.* = try measureSweep(allocator, &pools, &.{text}, row.mode, null);
            try std.testing.expectEqual(8, counts.measure_passes);
            // Each pass scans the text once on its path and seeks at least once per wrapped row.
            const scanned = text.len * 8;
            if (row.unit[0] < 0x80) {
                try std.testing.expectEqual(0, counts.bytes_scanned);
                try std.testing.expectEqual(if (row.mode == .word) scanned else 0, counts.ascii_bytes);
            } else {
                try std.testing.expectEqual(0, counts.ascii_bytes);
                try std.testing.expect(counts.bytes_scanned >= scanned and counts.bytes_scanned <= 3 * scanned);
            }
            if (row.unit.len <= 2) try std.testing.expect(counts.prefix_seeks >= 8 * (text.len / row.unit.len) / 83);
        }
        // Twice the text may cost at most 3 times the work: n log n passes, a rescan per row costs about 4 times.
        inline for (.{ "prefix_seeks", "bytes_scanned", "ascii_bytes" }) |field| {
            try std.testing.expect(@field(work[1], field) <= 3 * @field(work[0], field) + 8);
        }
    }
}

test "text work: a grapheme split across chunks keeps ASCII fitting for the rest of the word" {
    const allocator = std.testing.allocator;
    var pools = TestPools.init(allocator);
    defer pools.deinit();
    const suffix = try repeatText(allocator, "x", 64_000);
    defer allocator.free(suffix);
    var control_layout: [8]MeasureResult = undefined;
    var split_layout: [8]MeasureResult = undefined;
    const control = try measureSweep(allocator, &pools, &.{ "\u{1f44b}", "\u{1f44b}", suffix, "y" }, .word, &control_layout);
    const split = try measureSweep(allocator, &pools, &.{ "\u{1f44b}", "\u{1f3fb}", suffix, "y" }, .word, &split_layout);
    try std.testing.expectEqualSlices(MeasureResult, &control_layout, &split_layout);
    errdefer std.debug.print("control {any}\nsplit   {any}\n", .{ control, split });
    try std.testing.expectEqual(8, split.measure_passes);
    try std.testing.expectEqual(control.ascii_bytes, split.ascii_bytes);
    // Only the emoji prefix takes the scalar path; the 64,000 ASCII bytes after it never do.
    for ([_]Counts{ control, split }) |counts| try std.testing.expect(counts.bytes_scanned <= 8 * 64);
}

test "text work: each UTF-8 scan entry counts its seeks, width reads, and bytes" {
    const utf8 = @import("../utf8.zig");
    var clusters: std.ArrayListUnmanaged(utf8.RenderClusterInfo) = .empty;
    defer clusters.deinit(std.testing.allocator);
    _ = text_work.take();
    // Finds the last grapheme from the line start, then reads its width; one without cells costs a second scan.
    try expectAfter(utf8.getPrevGraphemeStart("a\u{e9}", 3, 4, .hidden, .unicode), .{ .prefix_seeks = 1, .grapheme_width_reads = 1, .bytes_scanned = 3 });
    try expectAfter(utf8.getPrevGraphemeStart("\u{e9}\u{200b}", 5, 4, .hidden, .unicode), .{ .prefix_seeks = 1, .grapheme_width_reads = 1, .bytes_scanned = 10 });
    try expectAfter(utf8.getPrevGraphemeStart("a\u{e9}", 3, 4, .hidden, .wcwidth), .{ .prefix_seeks = 1, .bytes_scanned = 3 });
    try expectAfter(utf8.getGraphemeWidthAt("a\u{e9}", 1, 4, .hidden, .unicode), .{ .grapheme_width_reads = 1 });
    // Whole-slice scans on the ASCII hint return at once and count nothing.
    try expectAfter(utf8.calculateTextWidth("a\u{e9}", 4, .hidden, false, .unicode), .{ .bytes_scanned = 3 });
    try expectAfter(utf8.calculateTextWidth("abc", 4, .hidden, true, .unicode), .{});
    try expectAfter(try utf8.findRenderClusterInfo(std.testing.allocator, "a\u{e9}", 4, .hidden, false, .unicode, &clusters), .{ .bytes_scanned = 3 });
    try expectAfter(try utf8.findRenderClusterInfo(std.testing.allocator, "abc", 4, .hidden, true, .unicode, &clusters), .{});
    // A seek counts the bytes up to the position it returns.
    try expectAfter(utf8.findWrapPosByWidth("\u{e9}\u{e9}\u{e9}", 2, 4, .hidden, false, .unicode), .{ .prefix_seeks = 1, .bytes_scanned = 4 });
    try expectAfter(utf8.findWrapPosByWidthGraphemeSafe("\u{e9}\u{e9}\u{e9}", 2, 4, .hidden, false, .wcwidth), .{ .prefix_seeks = 1, .bytes_scanned = 4 });
    try expectAfter(utf8.findPosByWidth("\u{e9}\u{e9}\u{e9}", 1, 4, .hidden, false, true, .wcwidth), .{ .prefix_seeks = 1, .bytes_scanned = 2 });
    try expectAfter(utf8.findGraphemePosByWidth("\u{e9}\u{e9}\u{e9}", 1, 4, .hidden, false, true, .unicode), .{ .prefix_seeks = 1, .bytes_scanned = 2 });
}

test "text work: styled text interns each distinct chunk style and scans no objects" {
    const ctx = @import("../context.zig");
    const bytes = "const x = 1;\nfoo";
    // 8 chunks of 2 bytes that alternate 2 styles.
    var chunks: [8]ctx.StyledTextChunk = undefined;
    for (&chunks, 0..) |*chunk, index| chunk.* = if (index % 2 == 0)
        .{ .byte_count = 2, .foreground = .{ 255, 0, 0, 255 } }
    else
        .{ .byte_count = 2, .attributes = 1 };
    // Zero borrowers: no style is attached. A styled set never writes the attached style, so the
    // number of borrowers and the object table size do not change its work. Registering a style
    // checks each borrowing text or edit buffer once, whatever the table size.
    const rows = [_]struct { capacity: u32, borrowers: u32, edits: u32 = 0 }{
        .{ .capacity = 64, .borrowers = 0 },
        .{ .capacity = 64, .borrowers = 1 },
        .{ .capacity = 64, .borrowers = 8, .edits = 1 },
        .{ .capacity = 4096, .borrowers = 1 },
    };
    for (rows) |row| {
        errdefer std.debug.print("capacity {d}, borrowers {d}\n", .{ row.capacity, row.borrowers });
        const owner = try ctx.Context.init(std.testing.allocator, std.testing.io, .{ .object_capacity = row.capacity });
        defer owner.deinit() catch unreachable;
        const style = try owner.createSyntaxStyle();
        for ([_][]const u8{ "keyword", "string", "comment" }) |name| _ = try owner.syntaxStyleRegister(style, name, .{ .fg = null, .bg = null, .attributes = 1 });
        var buffers: [8]ctx.Handle = undefined;
        for (buffers[0..@max(row.borrowers, 1)]) |*buffer| {
            buffer.* = try owner.createTextBuffer(.unicode);
            if (row.borrowers > 0) try owner.textBufferSetSyntaxStyle(buffer.*, style);
        }
        for (0..row.edits) |_| try owner.editSetSyntaxStyle(try owner.createEditBuffer(.unicode), style);
        _ = text_work.take();
        _ = try owner.syntaxStyleRegister(style, "type", .{ .fg = null, .bg = null, .attributes = 2 });
        try expectWork(.{ .style_registrations = 1, .style_dependent_visits = row.borrowers + row.edits });
        for ([_]ctx.Handle{ buffers[0], buffers[@max(row.borrowers, 1) - 1] }) |buffer| {
            try owner.textBufferSetStyledText(buffer, bytes, &chunks);
            try expectWork(.{ .styled_text_sets = 1, .styled_text_bytes = 16, .style_registrations = 2 });
        }
        try std.testing.expectEqual(4, (try owner.raw().getSyntaxStyle(style)).getStyleCount());
    }
}

test "text work: highlights added one range at a time rebuild the spans of their line each time" {
    const allocator = std.testing.allocator;
    var pools = TestPools.init(allocator);
    defer pools.deinit();
    const line = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
    const text = try repeatLines(allocator, line, 100);
    defer allocator.free(text);
    const tb = try TextBuffer.init(allocator, &pools.graphemes, &pools.links, .unicode);
    defer tb.deinit();
    const view = try TextBufferView.init(allocator, tb);
    defer view.deinit();
    try tb.setText(text);
    // A 24-row viewport over the 100 lines, so spans built per drawn line can show their bound.
    view.setViewport(.{ .x = 0, .y = 0, .width = 80, .height = 24 });
    const screen = try OptimizedBuffer.init(allocator, 80, 24, .{ .pool = &pools.graphemes, .link_pool = &pools.links });
    defer screen.deinit();
    screen.drawTextBuffer(view, 0, 0);
    // 100 lines of 10 words: one range per word, alone or inside one transaction.
    const rows = [_]struct { transaction: bool, add: Counts }{
        .{ .transaction = false, .add = .{ .line_seeks = 2_000, .line_seek_nodes = 16_600, .highlight_leaves = 2_990, .line_span_builds = 1_000, .line_span_highlights = 5_500 } },
        .{ .transaction = true, .add = .{ .line_seeks = 2_000, .line_seek_nodes = 16_600, .highlight_leaves = 2_990, .line_span_builds = 100, .line_span_highlights = 1_000 } },
    };
    for (rows) |row| {
        errdefer std.debug.print("transaction {}\n", .{row.transaction});
        tb.clearAllHighlights();
        _ = text_work.take();
        if (row.transaction) tb.startHighlightsTransaction();
        for (0..100) |row_index| {
            var words = std.mem.tokenizeScalar(u8, line, ' ');
            while (words.next()) |word| {
                // Highlight offsets exclude line breaks.
                const start: u32 = @intCast(row_index * line.len + words.index - word.len);
                try tb.addHighlightByCharRange(start, start + @as(u32, @intCast(word.len)), 1, 1, 0);
            }
        }
        if (row.transaction) tb.endHighlightsTransaction();
        try expectWork(row.add);
        // Drawing reads the spans built above; it builds none.
        screen.drawTextBuffer(view, 0, 0);
        try expectWork(.{ .clusters_drawn = 1_344 });
    }
}
