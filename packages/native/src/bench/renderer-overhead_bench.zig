const std = @import("std");
const bench_utils = @import("../bench-utils.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");
const test_renderer_mod = @import("../tests/test-renderer.zig");

pub const benchName = "Renderer Overhead";

const WIDTH: u32 = 200;
const HEIGHT: u32 = 50;
const SAMPLES: usize = 100;
const WARMUP_SAMPLES: usize = 10;
const BATCH_SIZE: usize = 10;

const Scenario = enum { no_changes, one_change, full_change };

fn drawFrame(target: anytype, frame: usize, scenario: Scenario) void {
    var y: u32 = 0;
    while (y < HEIGHT) : (y += 1) {
        var x: u32 = 0;
        while (x < WIDTH) : (x += 1) {
            const changed = scenario == .full_change or (scenario == .one_change and x == 0 and y == 0);
            target.setRaw(x, y, .{
                .char = if (changed) 'A' + @as(u32, @intCast(frame % 2)) else 'A',
                .fg = .{ 200, 200, 200, 255 },
                .bg = .{ 20, 20, 40, 255 },
                .attributes = 0,
            });
        }
    }
}

fn runScenario(io: std.Io, allocator: std.mem.Allocator, pool: *gp.GraphemePool, scenario: Scenario) !bench_utils.BenchStats {
    var test_renderer = try test_renderer_mod.TestRenderer.create(allocator, WIDTH, HEIGHT, pool);
    defer test_renderer.deinit();
    drawFrame(test_renderer.renderer.getNextBuffer(), 0, .full_change);
    _ = test_renderer.renderer.render(true);

    var stats: bench_utils.BenchStats = .{};
    for (0..WARMUP_SAMPLES + SAMPLES) |sample| {
        var elapsed: u64 = 0;
        for (0..BATCH_SIZE) |batch| {
            drawFrame(test_renderer.renderer.getNextBuffer(), sample * BATCH_SIZE + batch, scenario);
            test_renderer.memory.bytes.clearRetainingCapacity();
            test_renderer.memory.last_write_start = 0;
            test_renderer.memory.last_write_len = 0;
            const timer = bench_utils.BenchTimer.start(io);
            _ = test_renderer.renderer.render(false);
            elapsed += timer.read();
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
        .{ .name = "10k cells no changes no images", .kind = .no_changes },
        .{ .name = "10k cells one change no images", .kind = .one_change },
        .{ .name = "10k cells full change no images", .kind = .full_change },
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
    return results.toOwnedSlice(allocator);
}
