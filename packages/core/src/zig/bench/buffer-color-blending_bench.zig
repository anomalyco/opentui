const std = @import("std");
const ansi = @import("../ansi.zig");
const bench_utils = @import("../bench-utils.zig");
const buffer = @import("../buffer.zig");
const text_buffer = @import("../text-buffer.zig");
const text_buffer_view = @import("../text-buffer-view.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");

const OptimizedBuffer = buffer.OptimizedBuffer;
const UnifiedTextBuffer = text_buffer.UnifiedTextBuffer;
const UnifiedTextBufferView = text_buffer_view.UnifiedTextBufferView;
const BorderSides = buffer.BorderSides;
const BenchResult = bench_utils.BenchResult;
const BenchStats = bench_utils.BenchStats;
const MemStat = bench_utils.MemStat;

pub const benchName = "Buffer Color Blending";

const CLEAR_BG = ansi.rgbColor(0, 0, 0, 255);

const BUFFER_WIDTH: u32 = 1200;
const BUFFER_HEIGHT: u32 = 600;

const BOX_COUNT: usize = 1000;
const BOX_WIDTH: u32 = 40;
const BOX_HEIGHT: u32 = 20;
const BOX_CHARS: [11]u32 = .{ '┌', '┐', '└', '┘', '─', '│', '┬', '┴', '├', '┤', '┼' };

const TEXT_COUNT: usize = 1000;
const TEXT_CONTENT: []const u8 = "Some text with a translucent background";

const BORDER_ALL: BorderSides = .{
    .top = true,
    .right = true,
    .bottom = true,
    .left = true,
};

fn rgba(r: f32, g: f32, b: f32, a: f32) buffer.RGBA {
    return ansi.rgbaFromFloats(r, g, b, a);
}

fn setupTextBuffer(
    allocator: std.mem.Allocator,
    pool: *gp.GraphemePool,
    text: []const u8,
    wrap_width: ?u32,
) !struct { *UnifiedTextBuffer, *UnifiedTextBufferView } {
    const link_pool = link.initGlobalLinkPool(allocator);
    const tb = try UnifiedTextBuffer.init(allocator, pool, link_pool, .unicode);
    errdefer tb.deinit();

    try tb.setText(text);

    const view = try UnifiedTextBufferView.init(allocator, tb);
    errdefer view.deinit();

    if (wrap_width) |w| {
        view.setWrapMode(.char);
        view.setWrapWidth(w);
    } else {
        view.setWrapMode(.none);
    }

    return .{ tb, view };
}

fn runTranslucentBoxes(
    allocator: std.mem.Allocator,
    pool: *gp.GraphemePool,
    show_mem: bool,
    iterations: usize,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayListUnmanaged(BenchResult) = .{};
    errdefer results.deinit(allocator);

    const name_translucent_bg = "1k translucent boxes (bg alpha 0.5)";
    const name_translucent_opacity = "1k translucent boxes (opacity 0.5)";

    const run_translucent_bg = bench_utils.matchesBenchFilter(name_translucent_bg, bench_filter);
    const run_translucent_opacity = bench_utils.matchesBenchFilter(name_translucent_opacity, bench_filter);
    if (!run_translucent_bg and !run_translucent_opacity) return results.toOwnedSlice(allocator);

    const buf = try OptimizedBuffer.init(allocator, BUFFER_WIDTH, BUFFER_HEIGHT, .{ .pool = pool });
    defer buf.deinit();

    var final_mem: usize = 0;

    if (run_translucent_bg) {
        const border_color = rgba(0.5, 0.5, 0.5, 1.0);
        const bg_color = rgba(0.2, 0.2, 0.2, 0.5);

        var stats: BenchStats = .{};
        for (0..iterations) |i| {
            buf.clear(CLEAR_BG, null);

            var timer = try std.time.Timer.start();
            var box_i: usize = 0;
            while (box_i < BOX_COUNT) : (box_i += 1) {
                const x: i32 = @intCast(@as(i32, @intCast(box_i % BUFFER_WIDTH)));
                const y: i32 = 0;
                try buf.drawBox(
                    x,
                    y,
                    BOX_WIDTH,
                    BOX_HEIGHT,
                    &BOX_CHARS,
                    BORDER_ALL,
                    border_color,
                    bg_color,
                    border_color,
                    true,
                    null,
                    0,
                    null,
                    0,
                );
            }
            stats.record(timer.read());

            if (i == iterations - 1 and show_mem) {
                final_mem = @sizeOf(OptimizedBuffer) + (buf.width * buf.height * (@sizeOf(u32) + @sizeOf(@TypeOf(buf.buffer.fg[0])) * 2 + @sizeOf(u8)));
            }
        }

        const mem_stats: ?[]const MemStat = if (show_mem) blk: {
            const s = try allocator.alloc(MemStat, 1);
            s[0] = .{ .name = "Buf", .bytes = final_mem };
            break :blk s;
        } else null;

        try results.append(allocator, .{
            .name = name_translucent_bg,
            .min_ns = stats.min_ns,
            .avg_ns = stats.avg(),
            .max_ns = stats.max_ns,
            .total_ns = stats.total_ns,
            .iterations = iterations,
            .mem_stats = mem_stats,
        });
    }

    if (run_translucent_opacity) {
        const border_color = rgba(0.5, 0.5, 0.5, 1.0);
        const bg_color = rgba(0.2, 0.2, 0.2, 1.0);

        var stats: BenchStats = .{};
        for (0..iterations) |i| {
            buf.clear(CLEAR_BG, null);

            try buf.pushOpacity(0.5);
            errdefer buf.popOpacity();

            var timer = try std.time.Timer.start();
            var box_i: usize = 0;
            while (box_i < BOX_COUNT) : (box_i += 1) {
                const x: i32 = @intCast(@as(i32, @intCast(box_i % BUFFER_WIDTH)));
                const y: i32 = 0;
                try buf.drawBox(
                    x,
                    y,
                    BOX_WIDTH,
                    BOX_HEIGHT,
                    &BOX_CHARS,
                    BORDER_ALL,
                    border_color,
                    bg_color,
                    border_color,
                    true,
                    null,
                    0,
                    null,
                    0,
                );
            }
            stats.record(timer.read());

            if (i == iterations - 1 and show_mem) {
                final_mem = @sizeOf(OptimizedBuffer) + (buf.width * buf.height * (@sizeOf(u32) + @sizeOf(@TypeOf(buf.buffer.fg[0])) * 2 + @sizeOf(u8)));
            }
        }

        const mem_stats: ?[]const MemStat = if (show_mem) blk: {
            const s = try allocator.alloc(MemStat, 1);
            s[0] = .{ .name = "Buf", .bytes = final_mem };
            break :blk s;
        } else null;

        try results.append(allocator, .{
            .name = name_translucent_opacity,
            .min_ns = stats.min_ns,
            .avg_ns = stats.avg(),
            .max_ns = stats.max_ns,
            .total_ns = stats.total_ns,
            .iterations = iterations,
            .mem_stats = mem_stats,
        });
    }

    return results.toOwnedSlice(allocator);
}

fn runTranslucentTextBuffers(
    allocator: std.mem.Allocator,
    pool: *gp.GraphemePool,
    show_mem: bool,
    iterations: usize,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayListUnmanaged(BenchResult) = .{};
    errdefer results.deinit(allocator);

    const name_translucent_bg = "1k translucent text buffer (bg alpha 0.5)";
    const name_translucent_opacity = "1k translucent text buffer (opacity 0.5)";

    const run_translucent_bg = bench_utils.matchesBenchFilter(name_translucent_bg, bench_filter);
    const run_translucent_opacity = bench_utils.matchesBenchFilter(name_translucent_opacity, bench_filter);
    if (!run_translucent_bg and !run_translucent_opacity) return results.toOwnedSlice(allocator);

    const buf = try OptimizedBuffer.init(allocator, BUFFER_WIDTH, BUFFER_HEIGHT, .{ .pool = pool });
    defer buf.deinit();

    var final_mem: usize = 0;

    if (run_translucent_bg) {
        var stats: BenchStats = .{};
        for (0..iterations) |i| {
            buf.clear(CLEAR_BG, null);

            const tbs = try allocator.alloc(*UnifiedTextBuffer, TEXT_COUNT);
            const views = try allocator.alloc(*UnifiedTextBufferView, TEXT_COUNT);
            errdefer allocator.free(tbs);
            errdefer allocator.free(views);

            for (0..TEXT_COUNT) |j| {
                tbs[j], views[j] = try setupTextBuffer(allocator, pool, TEXT_CONTENT, 100);
                tbs[j].setDefaultFg(rgba(0.8, 0.8, 0.8, 1.0));
                tbs[j].setDefaultBg(rgba(0.2, 0.2, 0.2, 0.5));
                try tbs[j].setText(TEXT_CONTENT);
            }

            var timer = try std.time.Timer.start();
            var buf_i: usize = 0;
            while (buf_i < TEXT_COUNT) : (buf_i += 1) {
                const x: i32 = @intCast(@as(i32, @intCast(buf_i % BUFFER_WIDTH)));
                const y: i32 = 0;

                buf.drawTextBuffer(views[buf_i % TEXT_COUNT], x, y);
            }
            stats.record(timer.read());

            if (i == iterations - 1 and show_mem) {
                final_mem = @sizeOf(OptimizedBuffer) + (buf.width * buf.height * (@sizeOf(u32) + @sizeOf(@TypeOf(buf.buffer.fg[0])) * 2 + @sizeOf(u8)));
            }
        }

        const mem_stats: ?[]const MemStat = if (show_mem) blk: {
            const s = try allocator.alloc(MemStat, 1);
            s[0] = .{ .name = "Buf", .bytes = final_mem };
            break :blk s;
        } else null;

        try results.append(allocator, .{
            .name = name_translucent_bg,
            .min_ns = stats.min_ns,
            .avg_ns = stats.avg(),
            .max_ns = stats.max_ns,
            .total_ns = stats.total_ns,
            .iterations = iterations,
            .mem_stats = mem_stats,
        });
    }

    if (run_translucent_opacity) {
        var stats: BenchStats = .{};
        for (0..iterations) |i| {
            buf.clear(CLEAR_BG, null);

            const tbs = try allocator.alloc(*UnifiedTextBuffer, TEXT_COUNT);
            const views = try allocator.alloc(*UnifiedTextBufferView, TEXT_COUNT);
            errdefer allocator.free(tbs);
            errdefer allocator.free(views);

            for (0..TEXT_COUNT) |j| {
                tbs[j], views[j] = try setupTextBuffer(allocator, pool, TEXT_CONTENT, 100);
                tbs[j].setDefaultFg(rgba(0.8, 0.8, 0.8, 1.0));
                tbs[j].setDefaultBg(rgba(0.2, 0.2, 0.2, 1.0));
                try tbs[j].setText(TEXT_CONTENT);
            }

            try buf.pushOpacity(0.5);
            errdefer buf.popOpacity();

            var timer = try std.time.Timer.start();
            var buf_i: usize = 0;
            while (buf_i < TEXT_COUNT) : (buf_i += 1) {
                const x: i32 = @intCast(@as(i32, @intCast(buf_i % BUFFER_WIDTH)));
                const y: i32 = 0;

                buf.drawTextBuffer(views[buf_i % TEXT_COUNT], x, y);
            }
            stats.record(timer.read());

            if (i == iterations - 1 and show_mem) {
                final_mem = @sizeOf(OptimizedBuffer) + (buf.width * buf.height * (@sizeOf(u32) + @sizeOf(@TypeOf(buf.buffer.fg[0])) * 2 + @sizeOf(u8)));
            }
        }

        const mem_stats: ?[]const MemStat = if (show_mem) blk: {
            const s = try allocator.alloc(MemStat, 1);
            s[0] = .{ .name = "Buf", .bytes = final_mem };
            break :blk s;
        } else null;

        try results.append(allocator, .{
            .name = name_translucent_opacity,
            .min_ns = stats.min_ns,
            .avg_ns = stats.avg(),
            .max_ns = stats.max_ns,
            .total_ns = stats.total_ns,
            .iterations = iterations,
            .mem_stats = mem_stats,
        });
    }

    return results.toOwnedSlice(allocator);
}

pub fn run(
    allocator: std.mem.Allocator,
    show_mem: bool,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    const pool = gp.initGlobalPool(allocator);

    var all_results: std.ArrayListUnmanaged(BenchResult) = .{};
    errdefer all_results.deinit(allocator);

    const iterations: usize = 10;

    const boxes_results = try runTranslucentBoxes(allocator, pool, show_mem, iterations, bench_filter);
    try all_results.appendSlice(allocator, boxes_results);

    const text_buffers_results = try runTranslucentTextBuffers(allocator, pool, show_mem, iterations, bench_filter);
    try all_results.appendSlice(allocator, text_buffers_results);

    return all_results.toOwnedSlice(allocator);
}
