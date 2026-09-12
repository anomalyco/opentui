const std = @import("std");
const ansi = @import("../ansi.zig");
const bench_utils = @import("../bench-utils.zig");
const buffer = @import("../buffer.zig");
const gp = @import("../grapheme.zig");
const image = @import("../image.zig");
const link = @import("../link.zig");

pub const benchName = "Buffer Image Overlap";

const WIDTH: u32 = 200;
const HEIGHT: u32 = 50;
const SAMPLES: usize = 100;
const WARMUP_SAMPLES: usize = 10;
const BOX_COUNT: usize = 1000;
const BOX_CHARS = [_]u32{ '┌', '┐', '└', '┘', '─', '│', '┬', '┴', '├', '┤', '┼' };

const Scenario = enum {
    transparent_char_disjoint,
    transparent_char_overlap,
    transparent_wide_text_overlap,
    transparent_boxes_disjoint,
    transparent_boxes_overlap,
    transparent_borders_disjoint,
    transparent_fill_sparse,
    transparent_fill_dense,
};

fn addPlacements(target: *buffer.OptimizedBuffer, source: *image.Image, scenario: Scenario) !void {
    switch (scenario) {
        .transparent_char_disjoint => {
            _ = try target.drawImage(source, 1, 0, 0, WIDTH, 1, 0, 0, 0, 0, 1, 1, .auto);
        },
        .transparent_char_overlap, .transparent_wide_text_overlap, .transparent_fill_dense => {
            _ = try target.drawImage(source, 1, 0, 0, WIDTH, HEIGHT, 0, 0, 0, 0, 1, 1, .auto);
        },
        .transparent_fill_sparse => {
            _ = try target.drawImage(source, 1, 95, 23, 10, 5, 0, 0, 0, 0, 1, 1, .auto);
        },
        .transparent_boxes_disjoint, .transparent_borders_disjoint => {
            for (0..16) |index| {
                _ = try target.drawImage(source, @intCast(index + 1), @intCast(index * 12), 49, 1, 1, 0, 0, 0, 0, 1, 1, .auto);
            }
        },
        .transparent_boxes_overlap => {
            for (0..16) |index| {
                _ = try target.drawImage(source, @intCast(index + 1), @intCast(index * 12), 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto);
            }
        },
    }
}

fn runWorkload(target: *buffer.OptimizedBuffer, scenario: Scenario) !void {
    const transparent = ansi.rgbColor(10, 20, 30, 0);
    switch (scenario) {
        .transparent_char_disjoint => {
            var y: u32 = 1;
            while (y < HEIGHT) : (y += 1) {
                var x: u32 = 0;
                while (x < WIDTH) : (x += 1) target.drawChar('X', x, y, transparent, transparent, 0);
            }
        },
        .transparent_char_overlap => {
            var y: u32 = 0;
            while (y < HEIGHT) : (y += 1) {
                var x: u32 = 0;
                while (x < WIDTH) : (x += 1) target.drawChar('X', x, y, transparent, transparent, 0);
            }
        },
        .transparent_wide_text_overlap => {
            const text = "界" ** (WIDTH / 2);
            var y: u32 = 0;
            while (y < HEIGHT) : (y += 1) try target.drawText(text, 0, y, transparent, transparent, 0);
        },
        .transparent_boxes_disjoint, .transparent_boxes_overlap => {
            for (0..BOX_COUNT) |index| {
                try target.drawBox(
                    @intCast(index % WIDTH),
                    0,
                    40,
                    20,
                    &BOX_CHARS,
                    .{ .top = true, .right = true, .bottom = true, .left = true },
                    transparent,
                    transparent,
                    transparent,
                    false,
                    null,
                    0,
                    null,
                    0,
                );
            }
        },
        .transparent_borders_disjoint => {
            const opaque_color = ansi.rgbColor(40, 50, 60, 255);
            for (0..BOX_COUNT) |index| {
                try target.drawBox(
                    @intCast(index % WIDTH),
                    0,
                    40,
                    20,
                    &BOX_CHARS,
                    .{ .top = true, .right = true, .bottom = true, .left = true },
                    opaque_color,
                    transparent,
                    opaque_color,
                    false,
                    null,
                    0,
                    null,
                    0,
                );
            }
        },
        .transparent_fill_sparse, .transparent_fill_dense => {
            const iterations: usize = if (scenario == .transparent_fill_sparse) 1000 else 100;
            for (0..iterations) |_| target.fillRect(0, 0, WIDTH, HEIGHT, transparent);
        },
    }
}

fn runScenario(
    io: std.Io,
    allocator: std.mem.Allocator,
    pool: *gp.GraphemePool,
    source: *image.Image,
    scenario: Scenario,
) !bench_utils.BenchStats {
    var link_pool = link.LinkPool.init(allocator);
    defer link_pool.deinit();
    const target = try buffer.OptimizedBuffer.init(allocator, WIDTH, HEIGHT, .{ .pool = pool, .link_pool = &link_pool });
    defer target.deinit();

    var stats: bench_utils.BenchStats = .{};
    for (0..WARMUP_SAMPLES + SAMPLES) |sample| {
        target.clear(ansi.rgbColor(0, 0, 0, 255), null);
        try addPlacements(target, source, scenario);
        const timer = bench_utils.BenchTimer.start(io);
        try runWorkload(target, scenario);
        const elapsed = timer.read();
        if (sample >= WARMUP_SAMPLES) stats.record(elapsed);
    }
    return stats;
}

pub fn run(io: std.Io, allocator: std.mem.Allocator, show_mem: bool, bench_filter: ?[]const u8) ![]bench_utils.BenchResult {
    _ = show_mem;
    const pool = gp.initGlobalPool(allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    const source = try image.createFromRgba(allocator, &[_]u8{ 10, 20, 30, 255 }, 1, 1, 4);
    defer source.deinit();

    const scenarios = [_]struct { name: []const u8, kind: Scenario }{
        .{ .name = "9.8k transparent drawChar placement disjoint", .kind = .transparent_char_disjoint },
        .{ .name = "10k transparent drawChar over image markers", .kind = .transparent_char_overlap },
        .{ .name = "5k transparent wide drawText over image markers", .kind = .transparent_wide_text_overlap },
        .{ .name = "1k transparent boxes scan 16 disjoint placements", .kind = .transparent_boxes_disjoint },
        .{ .name = "1k transparent boxes scan 16 overlapping placements", .kind = .transparent_boxes_overlap },
        .{ .name = "1k transparent borders scan 16 disjoint placements", .kind = .transparent_borders_disjoint },
        .{ .name = "1k transparent full fills with sparse placement", .kind = .transparent_fill_sparse },
        .{ .name = "100 transparent full fills with dense placement", .kind = .transparent_fill_dense },
    };
    var results: std.ArrayListUnmanaged(bench_utils.BenchResult) = .empty;
    for (scenarios) |scenario| {
        if (!bench_utils.matchesBenchFilter(scenario.name, bench_filter)) continue;
        const stats = try runScenario(io, allocator, pool, source, scenario.kind);
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
    return results.toOwnedSlice(allocator);
}
