const std = @import("std");
const bench_utils = @import("../bench-utils.zig");
const utf8 = @import("../utf8.zig");

const BenchResult = bench_utils.BenchResult;
const BenchStats = bench_utils.BenchStats;

pub const benchName = "UTF-8 Operations";

// Test data generators
fn generateAsciiText(allocator: std.mem.Allocator, length: usize) ![]const u8 {
    const text = try allocator.alloc(u8, length);
    for (text, 0..) |*c, i| {
        // Generate printable ASCII (32-126)
        c.* = @as(u8, @intCast(32 + (i % 95)));
    }
    return text;
}

fn generateMixedText(allocator: std.mem.Allocator, length: usize) ![]const u8 {
    var text: std.ArrayList(u8) = .empty;
    errdefer text.deinit(allocator);
    var i: usize = 0;
    while (text.items.len < length) : (i += 1) {
        if (i % 4 == 0) {
            try text.appendSlice(allocator, "世");
        } else if (i % 4 == 1) {
            try text.appendSlice(allocator, "😀");
        } else {
            try text.append(allocator, @as(u8, @intCast(32 + (i % 95))));
        }
    }
    return text.toOwnedSlice(allocator);
}

fn generateUnicodeHeavyText(allocator: std.mem.Allocator, length: usize) ![]const u8 {
    var text: std.ArrayList(u8) = .empty;
    errdefer text.deinit(allocator);
    var i: usize = 0;
    while (text.items.len < length) : (i += 1) {
        if (i % 3 == 0) {
            try text.appendSlice(allocator, "世界");
        } else if (i % 3 == 1) {
            try text.appendSlice(allocator, "😀🎉");
        } else {
            try text.appendSlice(allocator, "Ñoño");
        }
    }
    return text.toOwnedSlice(allocator);
}

// Benchmark isAsciiOnly
fn benchIsAsciiOnly(
    io: std.Io,
    results_alloc: std.mem.Allocator,
    iterations: usize,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayList(BenchResult) = .empty;
    errdefer results.deinit(results_alloc);

    // Small ASCII text (1KB)
    {
        const name = "isAsciiOnly: ASCII text (1KB)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var temp = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer temp.deinit();
            const text = try generateAsciiText(temp.allocator(), 1024);

            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                const timer = bench_utils.BenchTimer.start(io);
                _ = utf8.isAsciiOnly(text);
                stats.record(timer.read());
            }

            try results.append(results_alloc, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = null,
            });
        }
    }

    // Large ASCII text (100KB)
    {
        const name = "isAsciiOnly: ASCII text (100KB)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var temp = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer temp.deinit();
            const text = try generateAsciiText(temp.allocator(), 100 * 1024);

            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                const timer = bench_utils.BenchTimer.start(io);
                _ = utf8.isAsciiOnly(text);
                stats.record(timer.read());
            }

            try results.append(results_alloc, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = null,
            });
        }
    }

    // Very large ASCII text (1MB)
    {
        const name = "isAsciiOnly: ASCII text (1MB)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var temp = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer temp.deinit();
            const text = try generateAsciiText(temp.allocator(), 1024 * 1024);

            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                const timer = bench_utils.BenchTimer.start(io);
                _ = utf8.isAsciiOnly(text);
                stats.record(timer.read());
            }

            try results.append(results_alloc, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = null,
            });
        }
    }

    // Mixed text (10KB)
    {
        const name = "isAsciiOnly: Mixed text (10KB)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var temp = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer temp.deinit();
            const text = try generateMixedText(temp.allocator(), 10 * 1024);

            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                const timer = bench_utils.BenchTimer.start(io);
                _ = utf8.isAsciiOnly(text);
                stats.record(timer.read());
            }

            try results.append(results_alloc, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = null,
            });
        }
    }

    return results.toOwnedSlice(results_alloc);
}

// Benchmark findLineBreaks
fn benchFindLineBreaks(
    io: std.Io,
    results_alloc: std.mem.Allocator,
    iterations: usize,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayList(BenchResult) = .empty;
    errdefer results.deinit(results_alloc);

    // Text with LF breaks
    {
        const name = "findLineBreaks: 100 LF lines";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var temp = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer temp.deinit();
            const alloc = temp.allocator();

            var text: std.ArrayList(u8) = .empty;
            for (0..100) |_| {
                try text.appendSlice(alloc, "This is a line of text that ends with a newline character.\n");
            }
            const test_text = text.items;

            var line_result = utf8.LineBreakResult.init(alloc);
            defer line_result.deinit();

            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                const timer = bench_utils.BenchTimer.start(io);
                try utf8.findLineBreaks(test_text, &line_result);
                stats.record(timer.read());
            }

            try results.append(results_alloc, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = null,
            });
        }
    }

    // Text with CRLF breaks
    {
        const name = "findLineBreaks: 100 CRLF lines";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var temp = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer temp.deinit();
            const alloc = temp.allocator();

            var text: std.ArrayList(u8) = .empty;
            for (0..100) |_| {
                try text.appendSlice(alloc, "This is a line of text that ends with CRLF.\r\n");
            }
            const test_text = text.items;

            var line_result = utf8.LineBreakResult.init(alloc);
            defer line_result.deinit();

            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                const timer = bench_utils.BenchTimer.start(io);
                try utf8.findLineBreaks(test_text, &line_result);
                stats.record(timer.read());
            }

            try results.append(results_alloc, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = null,
            });
        }
    }

    // Large text with many lines
    {
        const name = "findLineBreaks: 1000 short lines";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var temp = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer temp.deinit();
            const alloc = temp.allocator();

            var text: std.ArrayList(u8) = .empty;
            for (0..1000) |_| {
                try text.appendSlice(alloc, "Short line\n");
            }
            const test_text = text.items;

            var line_result = utf8.LineBreakResult.init(alloc);
            defer line_result.deinit();

            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                const timer = bench_utils.BenchTimer.start(io);
                try utf8.findLineBreaks(test_text, &line_result);
                stats.record(timer.read());
            }

            try results.append(results_alloc, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = null,
            });
        }
    }

    return results.toOwnedSlice(results_alloc);
}

fn benchFindChunkLayoutInfo(
    io: std.Io,
    results_alloc: std.mem.Allocator,
    iterations: usize,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayList(BenchResult) = .empty;
    errdefer results.deinit(results_alloc);

    const name = "findChunkLayoutInfo: ASCII punctuation (62.5 KiB)";
    if (bench_utils.matchesBenchFilter(name, bench_filter)) {
        const text = "word-" ** 12_800;
        var temp = std.heap.ArenaAllocator.init(std.heap.page_allocator);
        defer temp.deinit();
        const alloc = temp.allocator();
        var wrap_breaks: std.ArrayListUnmanaged(utf8.LayoutWrapBreak) = .empty;
        defer wrap_breaks.deinit(alloc);

        var stats: BenchStats = .{};
        for (0..iterations) |_| {
            const timer = bench_utils.BenchTimer.start(io);
            const word_classes = try utf8.findChunkLayoutInfo(alloc, text, 4, true, .unicode, &wrap_breaks);
            stats.record(timer.read());

            if (wrap_breaks.items.len != 12_800 or word_classes.first != .ascii_word or word_classes.last != .other) {
                return error.InvalidBenchmarkOutput;
            }
        }

        try results.append(results_alloc, .{
            .name = name,
            .min_ns = stats.min_ns,
            .avg_ns = stats.avg(),
            .max_ns = stats.max_ns,
            .total_ns = stats.total_ns,
            .iterations = iterations,
            .mem_stats = null,
        });
    }

    return results.toOwnedSlice(results_alloc);
}

// Benchmark findWrapPosByWidth
fn benchFindWrapPosByWidth(
    io: std.Io,
    results_alloc: std.mem.Allocator,
    iterations: usize,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayList(BenchResult) = .empty;
    errdefer results.deinit(results_alloc);

    // ASCII text, narrow width
    {
        const name = "findWrapPosByWidth: ASCII 1KB, width=40";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var temp = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer temp.deinit();
            const text = try generateAsciiText(temp.allocator(), 1024);

            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                const timer = bench_utils.BenchTimer.start(io);
                _ = utf8.findWrapPosByWidth(text, 40, 4, true, .unicode);
                stats.record(timer.read());
            }

            try results.append(results_alloc, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = null,
            });
        }
    }

    // ASCII text, wide width
    {
        const name = "findWrapPosByWidth: ASCII 1KB, width=120";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var temp = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer temp.deinit();
            const text = try generateAsciiText(temp.allocator(), 1024);

            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                const timer = bench_utils.BenchTimer.start(io);
                _ = utf8.findWrapPosByWidth(text, 120, 4, true, .unicode);
                stats.record(timer.read());
            }

            try results.append(results_alloc, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = null,
            });
        }
    }

    // Mixed text
    {
        const name = "findWrapPosByWidth: Mixed 1KB, width=80";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var temp = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer temp.deinit();
            const text = try generateMixedText(temp.allocator(), 1024);

            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                const timer = bench_utils.BenchTimer.start(io);
                _ = utf8.findWrapPosByWidth(text, 80, 4, false, .unicode);
                stats.record(timer.read());
            }

            try results.append(results_alloc, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = null,
            });
        }
    }

    // Unicode heavy text
    {
        const name = "findWrapPosByWidth: Unicode 1KB, width=80";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var temp = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer temp.deinit();
            const text = try generateUnicodeHeavyText(temp.allocator(), 1024);

            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                const timer = bench_utils.BenchTimer.start(io);
                _ = utf8.findWrapPosByWidth(text, 80, 4, false, .unicode);
                stats.record(timer.read());
            }

            try results.append(results_alloc, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = null,
            });
        }
    }

    return results.toOwnedSlice(results_alloc);
}

// Benchmark findPosByWidth
fn benchFindPosByWidth(
    io: std.Io,
    results_alloc: std.mem.Allocator,
    iterations: usize,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayList(BenchResult) = .empty;
    errdefer results.deinit(results_alloc);

    // ASCII text, find middle
    {
        const name = "findPosByWidth: ASCII 1KB, target=500";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var temp = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer temp.deinit();
            const text = try generateAsciiText(temp.allocator(), 1024);

            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                const timer = bench_utils.BenchTimer.start(io);
                _ = utf8.findPosByWidth(text, 500, 4, true, true, .unicode);
                stats.record(timer.read());
            }

            try results.append(results_alloc, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = null,
            });
        }
    }

    // Large ASCII text, find near end
    {
        const name = "findPosByWidth: ASCII 100KB, target=90000";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var temp = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer temp.deinit();
            const text = try generateAsciiText(temp.allocator(), 100 * 1024);

            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                const timer = bench_utils.BenchTimer.start(io);
                _ = utf8.findPosByWidth(text, 90000, 4, true, true, .unicode);
                stats.record(timer.read());
            }

            try results.append(results_alloc, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = null,
            });
        }
    }

    // Mixed text
    {
        const name = "findPosByWidth: Mixed 10KB, target=5000";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var temp = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer temp.deinit();
            const text = try generateMixedText(temp.allocator(), 10 * 1024);

            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                const timer = bench_utils.BenchTimer.start(io);
                _ = utf8.findPosByWidth(text, 5000, 4, false, true, .unicode);
                stats.record(timer.read());
            }

            try results.append(results_alloc, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = null,
            });
        }
    }

    return results.toOwnedSlice(results_alloc);
}

// Benchmark calculateTextWidth
fn benchCalculateTextWidth(
    io: std.Io,
    results_alloc: std.mem.Allocator,
    iterations: usize,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayList(BenchResult) = .empty;
    errdefer results.deinit(results_alloc);

    // Small ASCII text (1KB)
    {
        const name = "calculateTextWidth: ASCII (1KB)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var temp = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer temp.deinit();
            const text = try generateAsciiText(temp.allocator(), 1024);

            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                const timer = bench_utils.BenchTimer.start(io);
                _ = utf8.calculateTextWidth(text, 4, true, .unicode);
                stats.record(timer.read());
            }

            try results.append(results_alloc, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = null,
            });
        }
    }

    // Large ASCII text (100KB)
    {
        const name = "calculateTextWidth: ASCII (100KB)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var temp = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer temp.deinit();
            const text = try generateAsciiText(temp.allocator(), 100 * 1024);

            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                const timer = bench_utils.BenchTimer.start(io);
                _ = utf8.calculateTextWidth(text, 4, true, .unicode);
                stats.record(timer.read());
            }

            try results.append(results_alloc, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = null,
            });
        }
    }

    // Very large ASCII text (1MB)
    {
        const name = "calculateTextWidth: ASCII (1MB)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var temp = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer temp.deinit();
            const text = try generateAsciiText(temp.allocator(), 1024 * 1024);

            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                const timer = bench_utils.BenchTimer.start(io);
                _ = utf8.calculateTextWidth(text, 4, true, .unicode);
                stats.record(timer.read());
            }

            try results.append(results_alloc, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = null,
            });
        }
    }

    // ASCII with tabs
    {
        const name = "calculateTextWidth: ASCII with tabs (10KB)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var temp = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer temp.deinit();
            const alloc = temp.allocator();

            var text: std.ArrayList(u8) = .empty;
            for (0..10 * 1024) |i| {
                if (i % 20 == 0) {
                    try text.append(alloc, '\t');
                } else {
                    try text.append(alloc, @as(u8, @intCast(32 + (i % 95))));
                }
            }

            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                const timer = bench_utils.BenchTimer.start(io);
                _ = utf8.calculateTextWidth(text.items, 4, false, .unicode);
                stats.record(timer.read());
            }

            try results.append(results_alloc, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = null,
            });
        }
    }

    // Mixed text
    {
        const name = "calculateTextWidth: Mixed (10KB)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var temp = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer temp.deinit();
            const text = try generateMixedText(temp.allocator(), 10 * 1024);

            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                const timer = bench_utils.BenchTimer.start(io);
                _ = utf8.calculateTextWidth(text, 4, false, .unicode);
                stats.record(timer.read());
            }

            try results.append(results_alloc, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = null,
            });
        }
    }

    // Unicode heavy text
    {
        const name = "calculateTextWidth: Unicode heavy (10KB)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var temp = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer temp.deinit();
            const text = try generateUnicodeHeavyText(temp.allocator(), 10 * 1024);

            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                const timer = bench_utils.BenchTimer.start(io);
                _ = utf8.calculateTextWidth(text, 4, false, .unicode);
                stats.record(timer.read());
            }

            try results.append(results_alloc, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = null,
            });
        }
    }

    return results.toOwnedSlice(results_alloc);
}

pub fn run(
    io: std.Io,
    allocator: std.mem.Allocator,
    show_mem: bool,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    _ = show_mem;

    var all_results: std.ArrayList(BenchResult) = .empty;
    errdefer all_results.deinit(allocator);

    const iterations: usize = 1000;

    // isAsciiOnly benchmarks
    const ascii_only_results = try benchIsAsciiOnly(io, allocator, iterations, bench_filter);
    try all_results.appendSlice(allocator, ascii_only_results);

    // findLineBreaks benchmarks
    const line_breaks_results = try benchFindLineBreaks(io, allocator, iterations, bench_filter);
    try all_results.appendSlice(allocator, line_breaks_results);

    // Direct benchmark for the retained word-layout scanner.
    const chunk_layout_results = try benchFindChunkLayoutInfo(io, allocator, iterations, bench_filter);
    try all_results.appendSlice(allocator, chunk_layout_results);

    // findWrapPosByWidth benchmarks
    const wrap_pos_results = try benchFindWrapPosByWidth(io, allocator, iterations, bench_filter);
    try all_results.appendSlice(allocator, wrap_pos_results);

    // findPosByWidth benchmarks
    const pos_width_results = try benchFindPosByWidth(io, allocator, iterations, bench_filter);
    try all_results.appendSlice(allocator, pos_width_results);

    // calculateTextWidth benchmarks
    const text_width_results = try benchCalculateTextWidth(io, allocator, iterations, bench_filter);
    try all_results.appendSlice(allocator, text_width_results);

    return all_results.toOwnedSlice(allocator);
}
