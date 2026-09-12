const std = @import("std");
const bench_utils = @import("../bench-utils.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");
const text_buffer = @import("../text-buffer.zig");

const BenchResult = bench_utils.BenchResult;
const BenchStats = bench_utils.BenchStats;
const TextBuffer = text_buffer.UnifiedTextBuffer;

pub const benchName = "TextBuffer Tab Width";

const change_count = 40;
const sample_count = 8;
const unit = "OpenTUI text metrics: 世界🙂 ";
const repeat_count = 32768;

fn makeInput(allocator: std.mem.Allocator) ![]u8 {
    const input = try allocator.alloc(u8, unit.len * repeat_count);
    for (0..repeat_count) |i| {
        @memcpy(input[i * unit.len ..][0..unit.len], unit);
    }
    return input;
}

fn changeTabWidth(tb: *TextBuffer) void {
    for (0..change_count) |i| {
        tb.setTabWidth(if (i % 2 == 0) 4 else 2);
    }
}

pub fn run(
    io: std.Io,
    allocator: std.mem.Allocator,
    _: bool,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    const pool = gp.initGlobalPool(allocator);
    const link_pool = link.initGlobalLinkPool(allocator);
    var results: std.ArrayList(BenchResult) = .empty;
    errdefer results.deinit(allocator);

    const tab_free = try makeInput(allocator);
    const one_tab = try allocator.dupe(u8, tab_free);
    one_tab[std.mem.indexOfScalar(u8, one_tab, 'x').?] = '\t';

    const tab_free_name = "40 tab-width changes: 1 MiB Unicode, no tabs";
    if (bench_utils.matchesBenchFilter(tab_free_name, bench_filter)) {
        var stats: BenchStats = .{};
        for (0..sample_count) |_| {
            var tb = try TextBuffer.init(allocator, pool, link_pool, .unicode);
            defer tb.deinit();
            try tb.setText(tab_free);
            const expected_width = tb.lineWidthAt(0);

            const timer = bench_utils.BenchTimer.start(io);
            changeTabWidth(tb);
            stats.record(timer.read());

            if (tb.lineWidthAt(0) != expected_width) return error.UnexpectedWidth;
            std.mem.doNotOptimizeAway(tb.lineWidthAt(0));
        }
        try results.append(allocator, .{
            .name = tab_free_name,
            .min_ns = stats.min_ns,
            .avg_ns = stats.avg(),
            .max_ns = stats.max_ns,
            .total_ns = stats.total_ns,
            .iterations = sample_count,
            .stddev_ns = stats.standardDeviation(),
            .rme_95 = stats.relativeMarginOfError95(),
            .mem_stats = null,
        });
    }

    const one_tab_name = "40 tab-width changes: 1 MiB Unicode, one tab";
    if (bench_utils.matchesBenchFilter(one_tab_name, bench_filter)) {
        var stats: BenchStats = .{};
        for (0..sample_count) |_| {
            var tb = try TextBuffer.init(allocator, pool, link_pool, .unicode);
            defer tb.deinit();
            try tb.setText(one_tab);
            const expected_width = tb.lineWidthAt(0);
            const tab_free_width = tb.measureText(tab_free);
            if (expected_width != tab_free_width + 1) return error.UnexpectedWidth;
            tb.setTabWidth(4);
            if (tb.lineWidthAt(0) != tab_free_width + 3) return error.UnexpectedWidth;
            tb.setTabWidth(2);

            const timer = bench_utils.BenchTimer.start(io);
            changeTabWidth(tb);
            stats.record(timer.read());

            if (tb.lineWidthAt(0) != expected_width) return error.UnexpectedWidth;
            std.mem.doNotOptimizeAway(tb.lineWidthAt(0));
        }
        try results.append(allocator, .{
            .name = one_tab_name,
            .min_ns = stats.min_ns,
            .avg_ns = stats.avg(),
            .max_ns = stats.max_ns,
            .total_ns = stats.total_ns,
            .iterations = sample_count,
            .stddev_ns = stats.standardDeviation(),
            .rme_95 = stats.relativeMarginOfError95(),
            .mem_stats = null,
        });
    }

    const set_text_name = "setText: 1 MiB Unicode, no tabs";
    if (bench_utils.matchesBenchFilter(set_text_name, bench_filter)) {
        var stats: BenchStats = .{};
        for (0..sample_count) |_| {
            var tb = try TextBuffer.init(allocator, pool, link_pool, .unicode);
            defer tb.deinit();

            const timer = bench_utils.BenchTimer.start(io);
            try tb.setText(tab_free);
            stats.record(timer.read());

            if (tb.lineWidthAt(0) == 0) return error.UnexpectedWidth;
            std.mem.doNotOptimizeAway(tb.lineWidthAt(0));
        }
        try results.append(allocator, .{
            .name = set_text_name,
            .min_ns = stats.min_ns,
            .avg_ns = stats.avg(),
            .max_ns = stats.max_ns,
            .total_ns = stats.total_ns,
            .iterations = sample_count,
            .stddev_ns = stats.standardDeviation(),
            .rme_95 = stats.relativeMarginOfError95(),
            .mem_stats = null,
        });
    }

    return results.toOwnedSlice(allocator);
}
