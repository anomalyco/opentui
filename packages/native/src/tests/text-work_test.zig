//! Work sentinels for text layout, drawing, and scanning. Each row pins the work an
//! operation does today; a change that removes work updates the row in the same commit.
const std = @import("std");
const TestPools = @import("test-pools.zig").TestPools;
const text_work = @import("../text-work.zig");
const TextBuffer = @import("../text-buffer.zig").UnifiedTextBuffer;
const TextBufferView = @import("../text-buffer-view.zig").UnifiedTextBufferView;
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

fn repeatLines(allocator: std.mem.Allocator, line: []const u8, count: usize) ![]u8 {
    var list: std.ArrayList(u8) = .empty;
    errdefer list.deinit(allocator);
    for (0..count) |i| {
        if (i > 0) try list.append(allocator, '\n');
        try list.appendSlice(allocator, line);
    }
    return list.toOwnedSlice(allocator);
}

test "text work: one edit in a 10,000-line editor lays out the whole document" {
    const allocator = std.testing.allocator;
    var pools = TestPools.init(allocator);
    defer pools.deinit();
    const text = try repeatLines(allocator, "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor in", 10_000);
    defer allocator.free(text);
    const rows = [_]struct { mode: @import("../text-buffer-view.zig").WrapMode, insert: Counts, burst: Counts, measure: Counts }{
        .{
            .mode = .none,
            .insert = .{ .layouts = 1, .lines_laid_out = 10_000, .marker_rebuilds = 1, .marker_leaves = 30_000, .marker_lookups = 8, .ascii_bytes = 1 },
            .burst = .{ .layouts = 10, .lines_laid_out = 100_000, .marker_rebuilds = 10, .marker_leaves = 300_000, .marker_lookups = 80, .ascii_bytes = 75 },
            // Unwrapped measure reads every line width from the markers.
            .measure = .{ .measure_passes = 1, .measure_lines = 10_000, .marker_lookups = 19_999 },
        },
        .{
            .mode = .word,
            .insert = .{ .layouts = 1, .lines_laid_out = 10_000, .marker_rebuilds = 1, .marker_leaves = 30_000, .marker_lookups = 8, .ascii_bytes = 790_002 },
            .burst = .{ .layouts = 10, .lines_laid_out = 100_000, .marker_rebuilds = 10, .marker_leaves = 300_000, .marker_lookups = 80, .ascii_bytes = 7_900_140 },
            .measure = .{ .measure_passes = 1, .measure_lines = 10_000, .ascii_bytes = 790_011 },
        },
        .{
            .mode = .char,
            .insert = .{ .layouts = 1, .lines_laid_out = 10_000, .marker_rebuilds = 1, .marker_leaves = 30_000, .marker_lookups = 8, .prefix_seeks = 10_001, .ascii_bytes = 1 },
            .burst = .{ .layouts = 10, .lines_laid_out = 100_000, .marker_rebuilds = 10, .marker_leaves = 300_000, .marker_lookups = 80, .prefix_seeks = 100_010, .ascii_bytes = 75 },
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
    try expectWork(.{ .layouts = 1, .lines_laid_out = 5_000, .measure_passes = 1, .measure_lines = 5_000, .ascii_bytes = 355_089 });
}

test "text work: drawing rows of a wrapped CJK line rescans its clusters from the line start" {
    const allocator = std.testing.allocator;
    var pools = TestPools.init(allocator);
    defer pools.deinit();
    const text = try allocator.alloc(u8, 100_000 * 3);
    defer allocator.free(text);
    for (0..100_000) |i| @memcpy(text[i * 3 ..][0..3], "\u{754c}");
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
        const text = try allocator.alloc(u8, 131_072 * row.unit.len);
        defer allocator.free(text);
        for (0..131_072) |i| @memcpy(text[i * row.unit.len ..][0..row.unit.len], row.unit);
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

test "text work: each UTF-8 scan entry counts its seeks, width reads, and bytes" {
    const utf8 = @import("../utf8.zig");
    var clusters: std.ArrayListUnmanaged(utf8.RenderClusterInfo) = .empty;
    defer clusters.deinit(std.testing.allocator);
    _ = text_work.take();
    // Finds the last grapheme from the line start, then reads its width.
    _ = utf8.getPrevGraphemeStart("a\u{e9}", 3, 4, .hidden, .unicode);
    try expectWork(.{ .prefix_seeks = 1, .grapheme_width_reads = 1, .bytes_scanned = 3 });
    // A last grapheme without cells costs a second scan from the line start.
    _ = utf8.getPrevGraphemeStart("\u{e9}\u{200b}", 5, 4, .hidden, .unicode);
    try expectWork(.{ .prefix_seeks = 1, .grapheme_width_reads = 1, .bytes_scanned = 10 });
    _ = utf8.getPrevGraphemeStart("a\u{e9}", 3, 4, .hidden, .wcwidth);
    try expectWork(.{ .prefix_seeks = 1, .bytes_scanned = 3 });
    _ = utf8.getGraphemeWidthAt("a\u{e9}", 1, 4, .hidden, .unicode);
    try expectWork(.{ .grapheme_width_reads = 1 });
    // Walks to the first grapheme with cells after the zero-width prefix.
    _ = utf8.zeroWidthPrefixLen("\u{301}\u{e9}a", 4, .hidden, .unicode);
    try expectWork(.{ .bytes_scanned = 4 });
    try utf8.findRenderClusterInfo(std.testing.allocator, "a\u{e9}", 4, .hidden, false, .unicode, &clusters);
    try expectWork(.{ .bytes_scanned = 3 });
    try utf8.findRenderClusterInfo(std.testing.allocator, "abc", 4, .hidden, true, .unicode, &clusters);
    try expectWork(.{ .ascii_bytes = 3 });
    // A seek counts the bytes up to the position it returns.
    _ = utf8.findWrapPosByWidth("\u{e9}\u{e9}\u{e9}", 2, 4, .hidden, false, .unicode);
    try expectWork(.{ .prefix_seeks = 1, .bytes_scanned = 4 });
    _ = utf8.findWrapPosByWidthGraphemeSafe("\u{e9}\u{e9}\u{e9}", 2, 4, .hidden, false, .wcwidth);
    try expectWork(.{ .prefix_seeks = 1, .bytes_scanned = 4 });
    _ = utf8.findPosByWidth("\u{e9}\u{e9}\u{e9}", 1, 4, .hidden, false, true, .wcwidth);
    try expectWork(.{ .prefix_seeks = 1, .bytes_scanned = 2 });
    _ = utf8.findGraphemePosByWidth("abc", 1, 4, .hidden, true, true, .unicode);
    try expectWork(.{ .prefix_seeks = 1 });
}
