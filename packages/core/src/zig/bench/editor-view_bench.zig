const std = @import("std");
const bench_utils = @import("../bench-utils.zig");
const edit_buffer = @import("../edit-buffer.zig");
const editor_view = @import("../editor-view.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");

const BenchResult = bench_utils.BenchResult;
const BenchStats = bench_utils.BenchStats;
const EditBuffer = edit_buffer.EditBuffer;
const EditorView = editor_view.EditorView;

pub const benchName = "EditorView Visual Navigation";

const calls_per_iteration = 10_000;

fn appendResult(allocator: std.mem.Allocator, results: *std.ArrayListUnmanaged(BenchResult), name: []const u8, stats: BenchStats) !void {
    try results.append(allocator, .{
        .name = name,
        .min_ns = stats.min_ns,
        .avg_ns = stats.avg(),
        .max_ns = stats.max_ns,
        .total_ns = stats.total_ns,
        .iterations = stats.count,
        .mem_stats = null,
    });
}

fn resetPrimaryCursor(eb: *EditBuffer, row: u32, col: u32, offset: u32) void {
    eb.cursors.items[0] = .{
        .row = row,
        .col = col,
        .desired_col = col,
        .offset = offset,
    };
}

fn keepAlive(checksum: u64) !void {
    if (checksum == std.math.maxInt(u64)) return error.InvalidBenchmarkChecksum;
}

fn benchMoveDownBoundary(
    allocator: std.mem.Allocator,
    pool: *gp.GraphemePool,
    link_pool: *link.LinkPool,
    iterations: usize,
    bench_filter: ?[]const u8,
    results: *std.ArrayListUnmanaged(BenchResult),
) !void {
    const name = "moveDownVisual wrapped boundary: 10k calls";
    if (!bench_utils.matchesBenchFilter(name, bench_filter)) return;

    var eb = try EditBuffer.init(allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();
    var ev = try EditorView.init(allocator, eb, 10, 10);
    defer ev.deinit();

    ev.setWrapMode(.word);
    try eb.setText("0123456789\nquick brown fox");
    _ = ev.getCachedLineInfo();

    var stats: BenchStats = .{};
    var checksum: u64 = 0;
    for (0..iterations) |_| {
        var timer = try std.time.Timer.start();
        for (0..calls_per_iteration) |_| {
            resetPrimaryCursor(eb, 0, 10, 10);
            ev.desired_visual_col = null;
            ev.moveDownVisual();
            const cursor = eb.getPrimaryCursor();
            checksum +%= cursor.row + cursor.col;
        }
        stats.record(timer.read());
    }
    try keepAlive(checksum);
    try appendResult(allocator, results, name, stats);
}

fn benchMoveUpBoundary(
    allocator: std.mem.Allocator,
    pool: *gp.GraphemePool,
    link_pool: *link.LinkPool,
    iterations: usize,
    bench_filter: ?[]const u8,
    results: *std.ArrayListUnmanaged(BenchResult),
) !void {
    const name = "moveUpVisual wrapped boundary: 10k calls";
    if (!bench_utils.matchesBenchFilter(name, bench_filter)) return;

    const text = "quick brown fox";
    var eb = try EditBuffer.init(allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();
    var ev = try EditorView.init(allocator, eb, 10, 10);
    defer ev.deinit();

    ev.setWrapMode(.word);
    try eb.setText(text);
    _ = ev.getCachedLineInfo();

    var stats: BenchStats = .{};
    var checksum: u64 = 0;
    for (0..iterations) |_| {
        var timer = try std.time.Timer.start();
        for (0..calls_per_iteration) |_| {
            resetPrimaryCursor(eb, 0, text.len, @intCast(text.len));
            ev.desired_visual_col = null;
            ev.moveUpVisual();
            const cursor = eb.getPrimaryCursor();
            checksum +%= cursor.row + cursor.col;
        }
        stats.record(timer.read());
    }
    try keepAlive(checksum);
    try appendResult(allocator, results, name, stats);
}

fn benchVisualEOLBoundary(
    allocator: std.mem.Allocator,
    pool: *gp.GraphemePool,
    link_pool: *link.LinkPool,
    iterations: usize,
    bench_filter: ?[]const u8,
    results: *std.ArrayListUnmanaged(BenchResult),
) !void {
    const name = "getVisualEOL wrapped boundary: 10k calls";
    if (!bench_utils.matchesBenchFilter(name, bench_filter)) return;

    var eb = try EditBuffer.init(allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();
    var ev = try EditorView.init(allocator, eb, 10, 10);
    defer ev.deinit();

    ev.setWrapMode(.word);
    try eb.setText("quick brown fox");
    try eb.setCursor(0, 3);
    _ = ev.getCachedLineInfo();

    var stats: BenchStats = .{};
    var checksum: u64 = 0;
    for (0..iterations) |_| {
        var timer = try std.time.Timer.start();
        for (0..calls_per_iteration) |_| {
            const cursor = ev.getVisualEOL();
            checksum +%= cursor.visual_row + cursor.visual_col + cursor.logical_col;
        }
        stats.record(timer.read());
    }
    try keepAlive(checksum);
    try appendResult(allocator, results, name, stats);
}

pub fn run(
    allocator: std.mem.Allocator,
    _: bool,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    const pool = gp.initGlobalPool(allocator);
    const link_pool = link.initGlobalLinkPool(allocator);

    var results: std.ArrayListUnmanaged(BenchResult) = .{};
    errdefer results.deinit(allocator);

    const iterations: usize = 20;
    try benchMoveDownBoundary(allocator, pool, link_pool, iterations, bench_filter, &results);
    try benchMoveUpBoundary(allocator, pool, link_pool, iterations, bench_filter, &results);
    try benchVisualEOLBoundary(allocator, pool, link_pool, iterations, bench_filter, &results);

    return results.toOwnedSlice(allocator);
}
