const std = @import("std");
const ansi = @import("../ansi.zig");
const bench_utils = @import("../bench-utils.zig");
const buffer = @import("../buffer.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");

pub const benchName = "Buffer Cell Drawing";

const WIDTH: u32 = 200;
const HEIGHT: u32 = 50;
const SAMPLES: usize = 100;
const WARMUP_SAMPLES: usize = 10;
const BATCH_SIZE: usize = 10;
const BOX_CHARS = [_]u32{ '┌', '┐', '└', '┘', '─', '│', '┬', '┴', '├', '┤', '┼' };

const Scenario = enum {
    transparent_char,
    translucent_char,
    transparent_text,
    opaque_text,
    transparent_boxes,
    transparent_borders,
    opaque_boxes,
    translucent_boxes,
    half_clipped_boxes,
};

fn runWorkload(target: *buffer.OptimizedBuffer, scenario: Scenario, text: []const u8) !void {
    const transparent = ansi.rgbColor(10, 20, 30, 0);
    const translucent = ansi.rgbColor(10, 20, 30, 128);
    const opaque_color = ansi.rgbColor(10, 20, 30, 255);
    switch (scenario) {
        .transparent_char, .translucent_char => {
            const color = if (scenario == .transparent_char) transparent else translucent;
            const passes: usize = if (scenario == .transparent_char) 100 else 1;
            for (0..passes) |_| {
                var y: u32 = 0;
                while (y < HEIGHT) : (y += 1) {
                    var x: u32 = 0;
                    while (x < WIDTH) : (x += 1) {
                        if (scenario == .transparent_char) std.mem.doNotOptimizeAway(target);
                        target.drawChar('X', x, y, color, color, 0);
                    }
                }
            }
        },
        .transparent_text => {
            for (0..1000) |_| {
                var y: u32 = 0;
                while (y < HEIGHT) : (y += 1) {
                    std.mem.doNotOptimizeAway(target);
                    try target.drawText(text, 0, y, transparent, transparent, 0);
                }
            }
        },
        .opaque_text => {
            var y: u32 = 0;
            while (y < HEIGHT) : (y += 1) try target.drawText(text, 0, y, opaque_color, opaque_color, 0);
        },
        .transparent_boxes, .transparent_borders, .opaque_boxes, .translucent_boxes, .half_clipped_boxes => {
            const fully_transparent = scenario == .transparent_boxes;
            const box_count: usize = if (fully_transparent) 100_000 else 1000;
            const border_color = if (fully_transparent) transparent else opaque_color;
            const background_color = if (fully_transparent or scenario == .transparent_borders)
                transparent
            else if (scenario == .translucent_boxes)
                translucent
            else
                opaque_color;
            for (0..box_count) |index| {
                if (fully_transparent) std.mem.doNotOptimizeAway(target);
                try target.drawBox(
                    @intCast(index % WIDTH),
                    if (scenario == .half_clipped_boxes) -10 else 0,
                    40,
                    20,
                    &BOX_CHARS,
                    .{ .top = true, .right = true, .bottom = true, .left = true },
                    border_color,
                    background_color,
                    border_color,
                    scenario != .transparent_borders and !fully_transparent,
                    null,
                    0,
                    null,
                    0,
                );
            }
        },
    }
}

fn runScenario(io: std.Io, allocator: std.mem.Allocator, pool: *gp.GraphemePool, scenario: Scenario) !bench_utils.BenchStats {
    var link_pool = link.LinkPool.init(allocator);
    defer link_pool.deinit();
    const target = try buffer.OptimizedBuffer.init(allocator, WIDTH, HEIGHT, .{ .pool = pool, .link_pool = &link_pool });
    defer target.deinit();
    const text = "X" ** WIDTH;

    var stats: bench_utils.BenchStats = .{};
    for (0..WARMUP_SAMPLES + SAMPLES) |sample| {
        var elapsed: u64 = 0;
        for (0..BATCH_SIZE) |_| {
            target.clear(ansi.rgbColor(0, 0, 0, 255), null);
            const timer = bench_utils.BenchTimer.start(io);
            try runWorkload(target, scenario, text);
            elapsed += timer.read();
        }
        if (sample >= WARMUP_SAMPLES) stats.record(elapsed / BATCH_SIZE);
    }
    return stats;
}

fn runFrameBufferScenario(io: std.Io, allocator: std.mem.Allocator, pool: *gp.GraphemePool) !bench_utils.BenchStats {
    var link_pool = link.LinkPool.init(allocator);
    defer link_pool.deinit();
    const source = try buffer.OptimizedBuffer.init(allocator, WIDTH, HEIGHT, .{ .pool = pool, .link_pool = &link_pool });
    defer source.deinit();
    const target = try buffer.OptimizedBuffer.init(allocator, WIDTH, HEIGHT, .{ .pool = pool, .link_pool = &link_pool });
    defer target.deinit();
    var y: u32 = 0;
    while (y < HEIGHT) : (y += 1) {
        var x: u32 = 0;
        while (x < WIDTH) : (x += 1) source.setRaw(x, y, .{
            .char = 'A',
            .fg = ansi.rgbColor(200, 200, 200, 255),
            .bg = ansi.rgbColor(20, 20, 40, 255),
            .attributes = 0,
        });
    }

    var stats: bench_utils.BenchStats = .{};
    for (0..WARMUP_SAMPLES + SAMPLES) |sample| {
        var elapsed: u64 = 0;
        for (0..BATCH_SIZE) |_| {
            const timer = bench_utils.BenchTimer.start(io);
            target.drawFrameBuffer(0, 0, source, null, null, null, null);
            elapsed += timer.read();
            target.clear(ansi.rgbColor(0, 0, 0, 255), null);
        }
        if (sample >= WARMUP_SAMPLES) stats.record(elapsed / BATCH_SIZE);
    }
    return stats;
}

pub fn run(io: std.Io, allocator: std.mem.Allocator, show_mem: bool, bench_filter: ?[]const u8) ![]bench_utils.BenchResult {
    _ = show_mem;
    const pool = gp.initGlobalPool(allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();

    const scenarios = [_]struct { name: []const u8, kind: Scenario }{
        .{ .name = "1m transparent drawChar no images", .kind = .transparent_char },
        .{ .name = "10k translucent drawChar no images", .kind = .translucent_char },
        .{ .name = "50k transparent drawText calls no images", .kind = .transparent_text },
        .{ .name = "10k opaque drawText cells no images", .kind = .opaque_text },
        .{ .name = "100k fully transparent boxes no images", .kind = .transparent_boxes },
        .{ .name = "1k transparent borders no images", .kind = .transparent_borders },
        .{ .name = "1k opaque filled boxes no images", .kind = .opaque_boxes },
        .{ .name = "1k translucent filled boxes no images", .kind = .translucent_boxes },
        .{ .name = "1k half-clipped filled boxes no images", .kind = .half_clipped_boxes },
    };
    var results: std.ArrayListUnmanaged(bench_utils.BenchResult) = .empty;
    for (scenarios) |scenario| {
        if (!bench_utils.matchesBenchFilter(scenario.name, bench_filter)) continue;
        const stats = try runScenario(io, allocator, pool, scenario.kind);
        try results.append(allocator, .{
            .name = scenario.name,
            .min_ns = stats.min_ns,
            .avg_ns = stats.avg(),
            .max_ns = stats.max_ns,
            .total_ns = stats.total_ns,
            .iterations = stats.count,
            .stddev_ns = stats.standardDeviation(),
            .rme_95 = stats.relativeMarginOfError95(),
            .mem_stats = null,
        });
    }
    const framebuffer_name = "drawFrameBuffer 10k cells no images";
    if (bench_utils.matchesBenchFilter(framebuffer_name, bench_filter)) {
        const stats = try runFrameBufferScenario(io, allocator, pool);
        try results.append(allocator, .{
            .name = framebuffer_name,
            .min_ns = stats.min_ns,
            .avg_ns = stats.avg(),
            .max_ns = stats.max_ns,
            .total_ns = stats.total_ns,
            .iterations = stats.count,
            .stddev_ns = stats.standardDeviation(),
            .rme_95 = stats.relativeMarginOfError95(),
            .mem_stats = null,
        });
    }
    return results.toOwnedSlice(allocator);
}
