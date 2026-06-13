const std = @import("std");
const ansi = @import("../ansi.zig");
const bench_utils = @import("../bench-utils.zig");
const buffer = @import("../buffer.zig");
const gp = @import("../grapheme.zig");

const OptimizedBuffer = buffer.OptimizedBuffer;
const BorderSides = buffer.BorderSides;
const BenchResult = bench_utils.BenchResult;
const BenchStats = bench_utils.BenchStats;
const MemStat = bench_utils.MemStat;

pub const benchName = "Buffer drawBox";

const CLEAR_BG = ansi.rgbColor(0, 0, 0, 255);

const BUFFER_WIDTH: u32 = 1200;
const BUFFER_HEIGHT: u32 = 600;

const BOX_COUNT: usize = 1000;
const BOX_WIDTH: u32 = 40;
const BOX_HEIGHT: u32 = 20;
const BOX_CHARS: [11]u32 = .{ '┌', '┐', '└', '┘', '─', '│', '┬', '┴', '├', '┤', '┼' };

const BORDER_ALL: BorderSides = .{
    .top = true,
    .right = true,
    .bottom = true,
    .left = true,
};
const BORDER_NONE: BorderSides = .{
    .top = false,
    .right = false,
    .bottom = false,
    .left = false,
};

const TITLE: []const u8 = "test title";

fn rgba(r: f32, g: f32, b: f32, a: f32) buffer.RGBA {
    return ansi.rgbaFromFloats(r, g, b, a);
}

fn runTransparentBoxes(
    allocator: std.mem.Allocator,
    pool: *gp.GraphemePool,
    show_mem: bool,
    iterations: usize,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayListUnmanaged(BenchResult) = .{};
    errdefer results.deinit(allocator);

    const name_opacity = "1k transparent boxes (opacity 0)";
    const name_bg_alpha = "1k transparent boxes (bg alpha 0)";
    const name_both_alpha = "1k transparent boxes (bg+border alpha 0)";

    const run_opacity = bench_utils.matchesBenchFilter(name_opacity, bench_filter);
    const run_bg_alpha = bench_utils.matchesBenchFilter(name_bg_alpha, bench_filter);
    const run_both_alpha = bench_utils.matchesBenchFilter(name_both_alpha, bench_filter);
    if (!run_opacity and !run_bg_alpha and !run_both_alpha) return results.toOwnedSlice(allocator);

    const buf = try OptimizedBuffer.init(allocator, BUFFER_WIDTH, BUFFER_HEIGHT, .{ .pool = pool });
    defer buf.deinit();

    var final_mem: usize = 0;

    if (run_opacity) {
        const border_color = rgba(0.5, 0.5, 0.5, 1.0);
        const bg_color = rgba(0.0, 0.0, 0.0, 1.0);

        var stats: BenchStats = .{};
        for (0..iterations) |i| {
            buf.clear(CLEAR_BG, null);

            try buf.pushOpacity(0.0);
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
            buf.popOpacity();
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
            .name = name_opacity,
            .min_ns = stats.min_ns,
            .avg_ns = stats.avg(),
            .max_ns = stats.max_ns,
            .total_ns = stats.total_ns,
            .iterations = iterations,
            .mem_stats = mem_stats,
        });
    }

    if (run_bg_alpha) {
        const border_color = rgba(0.5, 0.5, 0.5, 1.0);
        const bg_color = rgba(0.0, 0.0, 0.0, 0.0);

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
            .name = name_bg_alpha,
            .min_ns = stats.min_ns,
            .avg_ns = stats.avg(),
            .max_ns = stats.max_ns,
            .total_ns = stats.total_ns,
            .iterations = iterations,
            .mem_stats = mem_stats,
        });
    }

    if (run_both_alpha) {
        const bg_color = rgba(0.0, 0.0, 0.0, 0.0);
        const border_color_alpha = rgba(0.0, 0.0, 0.0, 0.0);

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
                    border_color_alpha,
                    bg_color,
                    border_color_alpha,
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
            .name = name_both_alpha,
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

fn runFilledBoxes(
    allocator: std.mem.Allocator,
    pool: *gp.GraphemePool,
    show_mem: bool,
    iterations: usize,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayListUnmanaged(BenchResult) = .{};
    errdefer results.deinit(allocator);

    const name_opaque = "1k filled boxes (fully opaque)";
    const name_translucent_bg = "1k filled boxes (bg alpha 0.5)";
    const name_translucent_opacity = "1k filled boxes (opacity 0.5)";

    const run_opaque = bench_utils.matchesBenchFilter(name_opaque, bench_filter);
    const run_translucent_bg = bench_utils.matchesBenchFilter(name_translucent_bg, bench_filter);
    const run_translucent_opacity = bench_utils.matchesBenchFilter(name_translucent_opacity, bench_filter);
    if (!run_opaque and !run_translucent_bg and !run_translucent_opacity) return results.toOwnedSlice(allocator);

    const buf = try OptimizedBuffer.init(allocator, BUFFER_WIDTH, BUFFER_HEIGHT, .{ .pool = pool });
    defer buf.deinit();

    var final_mem: usize = 0;

    if (run_opaque) {
        const border_color = rgba(0.5, 0.5, 0.5, 1.0);
        const bg_color = rgba(0.2, 0.2, 0.2, 1.0);

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
            .name = name_opaque,
            .min_ns = stats.min_ns,
            .avg_ns = stats.avg(),
            .max_ns = stats.max_ns,
            .total_ns = stats.total_ns,
            .iterations = iterations,
            .mem_stats = mem_stats,
        });
    }

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

fn runFilledBoxesTitle(
    allocator: std.mem.Allocator,
    pool: *gp.GraphemePool,
    show_mem: bool,
    iterations: usize,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayListUnmanaged(BenchResult) = .{};
    errdefer results.deinit(allocator);

    const name_title = "1k filled boxes (with title)";

    const run_title = bench_utils.matchesBenchFilter(name_title, bench_filter);
    if (!run_title) return results.toOwnedSlice(allocator);

    const buf = try OptimizedBuffer.init(allocator, BUFFER_WIDTH, BUFFER_HEIGHT, .{ .pool = pool });
    defer buf.deinit();

    const border_color = rgba(0.5, 0.5, 0.5, 1.0);
    const bg_color = rgba(0.3, 0.3, 0.3, 1.0);

    var final_mem: usize = 0;

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
                TITLE,
                1,
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
        .name = name_title,
        .min_ns = stats.min_ns,
        .avg_ns = stats.avg(),
        .max_ns = stats.max_ns,
        .total_ns = stats.total_ns,
        .iterations = iterations,
        .mem_stats = mem_stats,
    });

    return results.toOwnedSlice(allocator);
}

fn runFilledBoxesBorders(
    allocator: std.mem.Allocator,
    pool: *gp.GraphemePool,
    show_mem: bool,
    iterations: usize,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayListUnmanaged(BenchResult) = .{};
    errdefer results.deinit(allocator);

    const name_noborders = "1k filled boxes (without borders)";

    const run_noborders = bench_utils.matchesBenchFilter(name_noborders, bench_filter);
    if (!run_noborders) return results.toOwnedSlice(allocator);

    const buf = try OptimizedBuffer.init(allocator, BUFFER_WIDTH, BUFFER_HEIGHT, .{ .pool = pool });
    defer buf.deinit();

    const border_color = rgba(0.5, 0.5, 0.5, 1.0);
    const bg_color = rgba(0.0, 0.0, 0.0, 1.0);

    var final_mem: usize = 0;

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
                BORDER_NONE,
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
        .name = name_noborders,
        .min_ns = stats.min_ns,
        .avg_ns = stats.avg(),
        .max_ns = stats.max_ns,
        .total_ns = stats.total_ns,
        .iterations = iterations,
        .mem_stats = mem_stats,
    });

    return results.toOwnedSlice(allocator);
}

fn runFilledBoxesClipped(
    allocator: std.mem.Allocator,
    pool: *gp.GraphemePool,
    show_mem: bool,
    iterations: usize,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayListUnmanaged(BenchResult) = .{};
    errdefer results.deinit(allocator);

    const name_fully_clipped = "1k filled boxes (fully clipped)";
    const name_half_clipped = "1k filled boxes (half clipped)";
    const name_negative_coords = "1k filled boxes (negative coords)";

    const run_fully = bench_utils.matchesBenchFilter(name_fully_clipped, bench_filter);
    const run_half = bench_utils.matchesBenchFilter(name_half_clipped, bench_filter);
    const run_negative = bench_utils.matchesBenchFilter(name_negative_coords, bench_filter);
    if (!run_fully and !run_half and !run_negative) return results.toOwnedSlice(allocator);

    const buf = try OptimizedBuffer.init(allocator, BUFFER_WIDTH, BUFFER_HEIGHT, .{ .pool = pool });
    defer buf.deinit();

    const border_color = rgba(0.5, 0.5, 0.5, 1.0);
    const bg_color = rgba(0.2, 0.2, 0.2, 1.0);

    var final_mem: usize = 0;

    if (run_fully) {
        var stats: BenchStats = .{};
        for (0..iterations) |i| {
            buf.clear(CLEAR_BG, null);

            var timer = try std.time.Timer.start();
            var box_i: usize = 0;
            while (box_i < BOX_COUNT) : (box_i += 1) {
                try buf.drawBox(
                    BUFFER_WIDTH,
                    BUFFER_HEIGHT,
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
            .name = name_fully_clipped,
            .min_ns = stats.min_ns,
            .avg_ns = stats.avg(),
            .max_ns = stats.max_ns,
            .total_ns = stats.total_ns,
            .iterations = iterations,
            .mem_stats = mem_stats,
        });
    }

    if (run_half) {
        var stats: BenchStats = .{};
        for (0..iterations) |i| {
            buf.clear(CLEAR_BG, null);

            var timer = try std.time.Timer.start();
            var box_i: usize = 0;
            while (box_i < BOX_COUNT) : (box_i += 1) {
                const x: i32 = @intCast(@as(i32, @intCast(box_i % BUFFER_WIDTH)));
                const y: i32 = -@as(i32, @intCast(BOX_HEIGHT / 2));
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
            .name = name_half_clipped,
            .min_ns = stats.min_ns,
            .avg_ns = stats.avg(),
            .max_ns = stats.max_ns,
            .total_ns = stats.total_ns,
            .iterations = iterations,
            .mem_stats = mem_stats,
        });
    }

    if (run_negative) {
        var stats: BenchStats = .{};
        for (0..iterations) |i| {
            buf.clear(CLEAR_BG, null);

            var timer = try std.time.Timer.start();
            var box_i: usize = 0;
            while (box_i < BOX_COUNT) : (box_i += 1) {
                try buf.drawBox(
                    -@as(i32, @intCast(BOX_WIDTH)),
                    -@as(i32, @intCast(BOX_HEIGHT)),
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
            .name = name_negative_coords,
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

    const transparent_results = try runTransparentBoxes(allocator, pool, show_mem, iterations, bench_filter);
    try all_results.appendSlice(allocator, transparent_results);

    const filled_results = try runFilledBoxes(allocator, pool, show_mem, iterations, bench_filter);
    try all_results.appendSlice(allocator, filled_results);

    const title_results = try runFilledBoxesTitle(allocator, pool, show_mem, iterations, bench_filter);
    try all_results.appendSlice(allocator, title_results);

    const partial_results = try runFilledBoxesBorders(allocator, pool, show_mem, iterations, bench_filter);
    try all_results.appendSlice(allocator, partial_results);

    const clipped_results = try runFilledBoxesClipped(allocator, pool, show_mem, iterations, bench_filter);
    try all_results.appendSlice(allocator, clipped_results);

    return all_results.toOwnedSlice(allocator);
}
