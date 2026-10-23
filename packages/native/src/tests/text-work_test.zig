//! Work sentinels for text layout, drawing, and scanning. Each row pins the work an
//! operation does today; a change that removes work updates the row in the same commit.
const std = @import("std");
const TestPools = @import("test-pools.zig").TestPools;
const text_work = @import("../text-work.zig");
const TextBuffer = @import("../text-buffer.zig").UnifiedTextBuffer;
const text_buffer_view = @import("../text-buffer-view.zig");
const TextBufferView = text_buffer_view.UnifiedTextBufferView;
const WrapMode = text_buffer_view.WrapMode;
const MeasureResult = text_buffer_view.MeasureResult;
const EditBuffer = @import("../edit-buffer.zig").EditBuffer;
const EditorView = @import("../editor-view.zig").EditorView;
const OptimizedBuffer = @import("../buffer.zig").OptimizedBuffer;
const scene_fixture = @import("scene_fixture_test.zig");
const Counts = text_work.Counts;

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

test "text work: one edit in a 10,000-line editor lays out the whole document" {
    const allocator = std.testing.allocator;
    var pools = TestPools.init(allocator);
    defer pools.deinit();
    const text = try repeatLines(allocator, "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor in", 10_000);
    defer allocator.free(text);
    const rows = [_]struct { mode: WrapMode, insert: Counts, burst: Counts, measure: Counts }{
        .{
            .mode = .none,
            .insert = .{ .layouts = 1, .lines_laid_out = 10_000, .marker_rebuilds = 1, .marker_leaves = 30_000, .marker_lookups = 8 },
            .burst = .{ .layouts = 10, .lines_laid_out = 100_000, .marker_rebuilds = 10, .marker_leaves = 300_000, .marker_lookups = 80 },
            // Unwrapped measure reads every line width from the markers.
            .measure = .{ .measure_passes = 1, .measure_lines = 10_000, .marker_lookups = 19_999 },
        },
        .{
            .mode = .word,
            .insert = .{ .layouts = 1, .lines_laid_out = 10_000, .marker_rebuilds = 1, .marker_leaves = 30_000, .marker_lookups = 8, .ascii_bytes = 790_001 },
            .burst = .{ .layouts = 10, .lines_laid_out = 100_000, .marker_rebuilds = 10, .marker_leaves = 300_000, .marker_lookups = 80, .ascii_bytes = 7_900_065 },
            .measure = .{ .measure_passes = 1, .measure_lines = 10_000, .ascii_bytes = 790_011 },
        },
        .{
            .mode = .char,
            .insert = .{ .layouts = 1, .lines_laid_out = 10_000, .marker_rebuilds = 1, .marker_leaves = 30_000, .marker_lookups = 8, .prefix_seeks = 10_001 },
            .burst = .{ .layouts = 10, .lines_laid_out = 100_000, .marker_rebuilds = 10, .marker_leaves = 300_000, .marker_lookups = 80, .prefix_seeks = 100_010 },
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
        try expectWork(row.insert);
        for (0..10) |_| try eb.insertText("x");
        try expectWork(row.burst);
        // The cursor listener laid the document out already, so the frame only draws.
        screen.drawEditorView(ev, 0, 0);
        try expectWork(.{ .marker_lookups = 10, .clusters_drawn = 3_171 });
        eb.moveRight();
        try expectWork(.{ .marker_lookups = 13, .prefix_seeks = 1, .grapheme_width_reads = 1 });
        _ = try ev.getTextBufferView().measureForDimensions(100, 40);
        try expectWork(row.measure);
    }
}

test "text work: an append measures and lays out a 5,000-line view once each" {
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
    // The second measure hits the cache; render lays the document out again.
    try expectWork(.{ .layouts = 1, .lines_laid_out = 5_000, .measure_passes = 1, .measure_lines = 5_000, .ascii_bytes = 355_083 });
}

test "text work: drawing rows of a wrapped CJK line rescans its clusters from the line start" {
    const allocator = std.testing.allocator;
    var pools = TestPools.init(allocator);
    defer pools.deinit();
    const text = try repeatText(allocator, "\u{754c}", 100_000 * 3);
    defer allocator.free(text);
    const tb = try TextBuffer.init(allocator, &pools.graphemes, &pools.links, .unicode);
    defer tb.deinit();
    const view = try TextBufferView.init(allocator, tb);
    defer view.deinit();
    try tb.setText(text);
    view.setWrapMode(.char);
    view.setViewport(.{ .x = 0, .y = 0, .width = 80, .height = 30 });
    const rows = view.getVirtualLineCount();
    try std.testing.expectEqual(2_500, rows);
    const screen = try OptimizedBuffer.init(allocator, 80, 30, .{ .pool = &pools.graphemes, .link_pool = &pools.links });
    defer screen.deinit();
    screen.drawTextBuffer(view, 0, 0);

    _ = text_work.take();
    screen.drawTextBuffer(view, 0, 0);
    try expectWork(.{ .cluster_scan_steps = 17_400, .clusters_drawn = 1_200 });
    view.setViewport(.{ .x = 0, .y = rows - 30, .width = 80, .height = 30 });
    screen.drawTextBuffer(view, 0, 0);
    _ = text_work.take();
    screen.drawTextBuffer(view, 0, 0);
    try expectWork(.{ .cluster_scan_steps = 2_981_400, .clusters_drawn = 1_200 });
}

test "text work: drawing a long unwrapped line scrolled right skips every cluster before the viewport" {
    const allocator = std.testing.allocator;
    var pools = TestPools.init(allocator);
    defer pools.deinit();
    const rows = [_]struct { unit: []const u8, draw: Counts }{
        .{ .unit = "a", .draw = .{ .left_skip_steps = 130_992, .clusters_drawn = 80 } },
        .{ .unit = "\u{754c}", .draw = .{ .left_skip_steps = 131_032, .clusters_drawn = 40 } },
    };
    for (rows) |row| {
        const text = try repeatText(allocator, row.unit, 131_072 * row.unit.len);
        defer allocator.free(text);
        const tb = try TextBuffer.init(allocator, &pools.graphemes, &pools.links, .unicode);
        defer tb.deinit();
        const view = try TextBufferView.init(allocator, tb);
        defer view.deinit();
        try tb.setText(text);
        view.setWrapMode(.none);
        view.setViewport(.{ .x = tb.lineWidthAt(0) - 80, .y = 0, .width = 80, .height = 1 });
        const screen = try OptimizedBuffer.init(allocator, 80, 1, .{ .pool = &pools.graphemes, .link_pool = &pools.links });
        defer screen.deinit();
        screen.drawTextBuffer(view, 0, 0);

        _ = text_work.take();
        screen.drawTextBuffer(view, 0, 0);
        try expectWork(row.draw);
    }
}

test "text work: a changed scene frame measures and lays out an auto-height text node in two passes" {
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

    const changed: Counts = .{ .layouts = 1, .lines_laid_out = 5_000, .measure_passes = 1, .measure_lines = 5_000, .clusters_drawn = 972, .ascii_bytes = 810_000 };
    _ = text_work.take();
    try scene_fixture.repaint(f.owner, f.id, .{ 0, 0, 0, 255 }, false, 0);
    try expectWork(changed);
    try scene_fixture.repaint(f.owner, f.id, .{ 0, 0, 0, 255 }, false, 0);
    try expectWork(.{ .clusters_drawn = 972 });
    text[10] = 'X';
    try f.owner.sceneSetText(node, text);
    _ = text_work.take();
    try scene_fixture.repaint(f.owner, f.id, .{ 0, 0, 0, 255 }, false, 0);
    try expectWork(changed);
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
    view.setWrapMode(mode);
    view.setWrapWidth(80);
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
        .{ .unit = "\u{e9}" ** 10 ++ " ", .mode = .word },
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

test "text work: styled text on a buffer that borrows a style registers every chunk and scans the object table" {
    const ctx = @import("../context.zig");
    const bytes = "const x = 1;\nfoo";
    // 8 chunks of 2 bytes that alternate 2 styles.
    var chunks: [8]ctx.StyledTextChunk = undefined;
    for (&chunks, 0..) |*chunk, index| chunk.* = if (index % 2 == 0)
        .{ .byte_count = 2, .foreground = .{ 255, 0, 0, 255 } }
    else
        .{ .byte_count = 2, .attributes = 1 };
    // Zero borrowers: the buffer owns the style that styled text creates. `copied` is per set: the
    // second set copies the `chunkN` names of the first too. A borrowed style measures each chunk;
    // `scanned` is the "\nf" chunk on the scalar path.
    const rows = [_]struct { capacity: u32, borrowers: u32, slots: u64, copied: [2]u64, scanned: u64 }{
        .{ .capacity = 64, .borrowers = 0, .slots = 0, .copied = .{ 0, 0 }, .scanned = 0 },
        .{ .capacity = 64, .borrowers = 1, .slots = 128, .copied = .{ 4, 12 }, .scanned = 2 },
        .{ .capacity = 64, .borrowers = 8, .slots = 128, .copied = .{ 4, 12 }, .scanned = 2 },
        .{ .capacity = 4096, .borrowers = 1, .slots = 8192, .copied = .{ 4, 12 }, .scanned = 2 },
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
        _ = text_work.take();
        _ = try owner.syntaxStyleRegister(style, "type", .{ .fg = null, .bg = null, .attributes = 2 });
        try expectWork(.{ .style_registrations = 1, .style_dependent_slots = row.slots });
        // The last borrower reuses the `chunkN` names of the first.
        for ([_]ctx.Handle{ buffers[0], buffers[@max(row.borrowers, 1) - 1] }, row.copied) |buffer, copied| {
            try owner.textBufferSetStyledText(buffer, bytes, &chunks);
            try expectWork(.{ .styled_text_sets = 1, .styled_text_bytes = 16, .style_registrations = 8, .style_entries_copied = copied, .style_dependent_slots = row.slots, .bytes_scanned = row.scanned });
        }
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
    // Build the line markers once, so neither row pays for it.
    try tb.addHighlightByCharRange(0, 1, 1, 1, 0);
    // 100 lines of 10 words: one range per word, alone or inside one transaction.
    const rows = [_]struct { transaction: bool, add: Counts }{
        .{ .transaction = false, .add = .{ .marker_lookups = 23_190, .line_span_builds = 1_000, .line_span_highlights = 5_500 } },
        .{ .transaction = true, .add = .{ .marker_lookups = 23_190, .line_span_builds = 100, .line_span_highlights = 1_000 } },
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
