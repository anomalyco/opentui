const std = @import("std");
const bench_utils = @import("../bench-utils.zig");
const edit_buffer = @import("../edit-buffer.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");

const EditBuffer = edit_buffer.EditBuffer;
const BenchResult = bench_utils.BenchResult;
const BenchStats = bench_utils.BenchStats;
const MemStat = bench_utils.MemStat;

pub const benchName = "EditBuffer Operations";

fn benchInsertOperations(
    allocator: std.mem.Allocator,
    pool: *gp.GraphemePool,
    iterations: usize,
    show_mem: bool,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayListUnmanaged(BenchResult) = .{};
    errdefer results.deinit(allocator);
    const link_pool = link.initGlobalLinkPool(allocator);

    // Single-line insert at start
    {
        const name = "EditBuffer insert 1k times at start";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            var final_mem: usize = 0;

            for (0..iterations) |iter| {
                var eb = try EditBuffer.init(allocator, pool, link_pool, .unicode, null);
                defer eb.deinit();

                const text = "Hello, world! ";
                var timer = try std.time.Timer.start();
                for (0..1000) |_| {
                    try eb.insertText(text);
                    try eb.setCursor(0, 0);
                }
                stats.record(timer.read());

                if (iter == iterations - 1 and show_mem) {
                    final_mem = eb.getTextBuffer().getArenaAllocatedBytes();
                }
            }

            const mem_stats: ?[]const MemStat = if (show_mem) blk: {
                const s = try allocator.alloc(MemStat, 1);
                s[0] = .{ .name = "TB", .bytes = final_mem };
                break :blk s;
            } else null;

            try results.append(allocator, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = mem_stats,
            });
        }
    }

    // Multi-line insert
    {
        const name = "EditBuffer insert 500 multi-line blocks";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            var final_mem: usize = 0;

            for (0..iterations) |iter| {
                var eb = try EditBuffer.init(allocator, pool, link_pool, .unicode, null);
                defer eb.deinit();

                const text = "Line 1\nLine 2\nLine 3\n";
                var timer = try std.time.Timer.start();
                for (0..500) |_| {
                    try eb.insertText(text);
                }
                stats.record(timer.read());

                if (iter == iterations - 1 and show_mem) {
                    final_mem = eb.getTextBuffer().getArenaAllocatedBytes();
                }
            }

            const mem_stats: ?[]const MemStat = if (show_mem) blk: {
                const s = try allocator.alloc(MemStat, 1);
                s[0] = .{ .name = "TB", .bytes = final_mem };
                break :blk s;
            } else null;

            try results.append(allocator, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = mem_stats,
            });
        }
    }

    return results.toOwnedSlice(allocator);
}

fn benchDeleteOperations(
    allocator: std.mem.Allocator,
    pool: *gp.GraphemePool,
    iterations: usize,
    show_mem: bool,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayListUnmanaged(BenchResult) = .{};
    errdefer results.deinit(allocator);
    const link_pool = link.initGlobalLinkPool(allocator);

    // Single-line delete with backspace
    {
        const name = "EditBuffer backspace 500 chars";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            var final_mem: usize = 0;

            for (0..iterations) |iter| {
                var eb = try EditBuffer.init(allocator, pool, link_pool, .unicode, null);
                defer eb.deinit();

                // Build up text
                const text = "Hello, world! ";
                for (0..1000) |_| {
                    try eb.insertText(text);
                }

                var timer = try std.time.Timer.start();
                for (0..500) |_| {
                    try eb.backspace();
                }
                stats.record(timer.read());

                if (iter == iterations - 1 and show_mem) {
                    final_mem = eb.getTextBuffer().getArenaAllocatedBytes();
                }
            }

            const mem_stats: ?[]const MemStat = if (show_mem) blk: {
                const s = try allocator.alloc(MemStat, 1);
                s[0] = .{ .name = "TB", .bytes = final_mem };
                break :blk s;
            } else null;

            try results.append(allocator, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = mem_stats,
            });
        }
    }

    // Multi-line delete range
    {
        const name = "EditBuffer delete 50-line range";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            var final_mem: usize = 0;

            for (0..iterations) |iter| {
                var eb = try EditBuffer.init(allocator, pool, link_pool, .unicode, null);
                defer eb.deinit();

                // Build up text with many lines
                const text = "Line 1\nLine 2\nLine 3\n";
                for (0..100) |_| {
                    try eb.insertText(text);
                }

                var timer = try std.time.Timer.start();
                // Delete across 50 lines
                try eb.deleteRange(.{ .row = 10, .col = 0 }, .{ .row = 60, .col = 0 });
                stats.record(timer.read());

                if (iter == iterations - 1 and show_mem) {
                    final_mem = eb.getTextBuffer().getArenaAllocatedBytes();
                }
            }

            const mem_stats: ?[]const MemStat = if (show_mem) blk: {
                const s = try allocator.alloc(MemStat, 1);
                s[0] = .{ .name = "TB", .bytes = final_mem };
                break :blk s;
            } else null;

            try results.append(allocator, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = mem_stats,
            });
        }
    }

    return results.toOwnedSlice(allocator);
}

fn benchMixedOperations(
    allocator: std.mem.Allocator,
    pool: *gp.GraphemePool,
    iterations: usize,
    show_mem: bool,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayListUnmanaged(BenchResult) = .{};
    errdefer results.deinit(allocator);
    const link_pool = link.initGlobalLinkPool(allocator);

    // Simulated typing session
    {
        const name = "EditBuffer mixed operations (300 lines)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            var final_mem: usize = 0;

            for (0..iterations) |iter| {
                var eb = try EditBuffer.init(allocator, pool, link_pool, .unicode, null);
                defer eb.deinit();

                var timer = try std.time.Timer.start();

                // Type some text
                for (0..100) |_| {
                    try eb.insertText("function test() {\n");
                    try eb.insertText("    return 42;\n");
                    try eb.insertText("}\n");
                }

                // Navigate and edit
                try eb.setCursor(50, 0);
                try eb.insertText("// Comment\n");

                // Delete a range
                try eb.deleteRange(.{ .row = 100, .col = 0 }, .{ .row = 120, .col = 0 });

                stats.record(timer.read());

                if (iter == iterations - 1 and show_mem) {
                    final_mem = eb.getTextBuffer().getArenaAllocatedBytes();
                }
            }

            const mem_stats: ?[]const MemStat = if (show_mem) blk: {
                const s = try allocator.alloc(MemStat, 1);
                s[0] = .{ .name = "TB", .bytes = final_mem };
                break :blk s;
            } else null;

            try results.append(allocator, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = mem_stats,
            });
        }
    }

    return results.toOwnedSlice(allocator);
}

fn benchWordBoundaryOperations(
    allocator: std.mem.Allocator,
    pool: *gp.GraphemePool,
    iterations: usize,
    show_mem: bool,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayListUnmanaged(BenchResult) = .{};
    errdefer results.deinit(allocator);
    const link_pool = link.initGlobalLinkPool(allocator);

    // Next word boundary navigation
    {
        const name = "EditBuffer getNextWordBoundary 1k times";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            var final_mem: usize = 0;

            for (0..iterations) |iter| {
                var eb = try EditBuffer.init(allocator, pool, link_pool, .unicode, null);
                defer eb.deinit();

                // Build text with many words
                const text = "The quick brown fox jumps over the lazy dog. ";
                for (0..100) |_| {
                    try eb.insertText(text);
                }

                try eb.setCursor(0, 0);

                var timer = try std.time.Timer.start();
                // Navigate through 1000 word boundaries
                for (0..1000) |_| {
                    const cursor = eb.getNextWordBoundary();
                    try eb.setCursor(cursor.row, cursor.col);
                }
                stats.record(timer.read());

                if (iter == iterations - 1 and show_mem) {
                    final_mem = eb.getTextBuffer().getArenaAllocatedBytes();
                }
            }

            const mem_stats: ?[]const MemStat = if (show_mem) blk: {
                const s = try allocator.alloc(MemStat, 1);
                s[0] = .{ .name = "TB", .bytes = final_mem };
                break :blk s;
            } else null;

            try results.append(allocator, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = mem_stats,
            });
        }
    }

    // Previous word boundary navigation
    {
        const name = "EditBuffer getPrevWordBoundary 1k times";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            var final_mem: usize = 0;

            for (0..iterations) |iter| {
                var eb = try EditBuffer.init(allocator, pool, link_pool, .unicode, null);
                defer eb.deinit();

                // Build text with many words
                const text = "The quick brown fox jumps over the lazy dog. ";
                for (0..100) |_| {
                    try eb.insertText(text);
                }

                // Start at end
                const line_count = eb.getTextBuffer().lineCount();
                const last_line = if (line_count > 0) line_count - 1 else 0;
                try eb.setCursor(last_line, 4500);

                var timer = try std.time.Timer.start();
                // Navigate backward through 1000 word boundaries
                for (0..1000) |_| {
                    const cursor = eb.getPrevWordBoundary();
                    try eb.setCursor(cursor.row, cursor.col);
                }
                stats.record(timer.read());

                if (iter == iterations - 1 and show_mem) {
                    final_mem = eb.getTextBuffer().getArenaAllocatedBytes();
                }
            }

            const mem_stats: ?[]const MemStat = if (show_mem) blk: {
                const s = try allocator.alloc(MemStat, 1);
                s[0] = .{ .name = "TB", .bytes = final_mem };
                break :blk s;
            } else null;

            try results.append(allocator, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = mem_stats,
            });
        }
    }

    // Word boundary with multi-line text
    {
        const name = "EditBuffer word boundary multi-line 500 times";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            var final_mem: usize = 0;

            for (0..iterations) |iter| {
                var eb = try EditBuffer.init(allocator, pool, link_pool, .unicode, null);
                defer eb.deinit();

                // Build multi-line text with words
                const text = "Hello world test\nAnother line here\nThird line content\n";
                for (0..100) |_| {
                    try eb.insertText(text);
                }

                try eb.setCursor(0, 0);

                var timer = try std.time.Timer.start();
                // Navigate through 500 word boundaries across lines
                for (0..500) |_| {
                    const cursor = eb.getNextWordBoundary();
                    try eb.setCursor(cursor.row, cursor.col);
                }
                stats.record(timer.read());

                if (iter == iterations - 1 and show_mem) {
                    final_mem = eb.getTextBuffer().getArenaAllocatedBytes();
                }
            }

            const mem_stats: ?[]const MemStat = if (show_mem) blk: {
                const s = try allocator.alloc(MemStat, 1);
                s[0] = .{ .name = "TB", .bytes = final_mem };
                break :blk s;
            } else null;

            try results.append(allocator, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = mem_stats,
            });
        }
    }

    return results.toOwnedSlice(allocator);
}

pub fn run(
    allocator: std.mem.Allocator,
    show_mem: bool,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    // Global pool and unicode data are initialized once in bench.zig
    const pool = gp.initGlobalPool(allocator);

    var all_results: std.ArrayListUnmanaged(BenchResult) = .{};
    errdefer all_results.deinit(allocator);

    const iterations: usize = 5;

    // Run all benchmark categories and filter results
    const insert_results = try benchInsertOperations(allocator, pool, iterations, show_mem, bench_filter);
    try all_results.appendSlice(allocator, insert_results);

    const delete_results = try benchDeleteOperations(allocator, pool, iterations, show_mem, bench_filter);
    try all_results.appendSlice(allocator, delete_results);

    const mixed_results = try benchMixedOperations(allocator, pool, iterations, show_mem, bench_filter);
    try all_results.appendSlice(allocator, mixed_results);

    const word_boundary_results = try benchWordBoundaryOperations(allocator, pool, iterations, show_mem, bench_filter);
    try all_results.appendSlice(allocator, word_boundary_results);

    return all_results.toOwnedSlice(allocator);
}
