const std = @import("std");
const bench_utils = @import("../bench-utils.zig");
const native_span_feed = @import("../native-span-feed.zig");
const renderer_output = @import("../renderer-output.zig");

pub const benchName = "Renderer Output";

const Operation = enum { atomic, backend };

fn runScenario(
    io: std.Io,
    allocator: std.mem.Allocator,
    result_allocator: std.mem.Allocator,
    name: []const u8,
    byte_count: usize,
    iterations: usize,
    operation: Operation,
    show_mem: bool,
) !bench_utils.BenchResult {
    var options = native_span_feed.defaultOptions();
    const required_chunks = std.math.divCeil(usize, byte_count, options.chunk_size) catch return error.InvalidBenchmarkSize;
    options.initial_chunks = @intCast(required_chunks);
    options.span_queue_capacity = @intCast(required_chunks + 1);
    const feed = try native_span_feed.Stream.create(allocator, options);
    defer feed.destroy();

    var backend = renderer_output.FeedBackend.create(feed);
    defer backend.deinit();
    const bytes = try allocator.alloc(u8, byte_count);
    defer allocator.free(bytes);
    for (bytes, 0..) |*byte, index| byte.* = @truncate(index * 31 + 17);
    const spans = try allocator.alloc(native_span_feed.SpanInfo, required_chunks);
    defer allocator.free(spans);

    var stats: bench_utils.BenchStats = .{};
    var checksum: u64 = 0;
    for (0..iterations + 5) |iteration| {
        const timer = bench_utils.BenchTimer.start(io);
        switch (operation) {
            .atomic => try feed.writeAtomic(bytes),
            .backend => {
                if (backend.prepareFrame() != .ok) return error.FeedNotReady;
                backend.beginFrame();
                var writer = backend.writer();
                try writer.writeAll(bytes);
                if (backend.endFrame() != .ok) return error.FeedWriteFailed;
            },
        }
        const elapsed = timer.read();

        const count = feed.drainSpans(spans);
        if (count != required_chunks) return error.IncorrectSpanCount;
        for (spans[0..count]) |span| {
            checksum +%= span.len + span.slice()[0];
            feed.markSpanConsumed(span);
        }
        if (iteration >= 5) stats.record(elapsed);
    }
    if (checksum == 0) return error.InvalidRendererOutputBenchmark;

    const mem_stats: ?[]const bench_utils.MemStat = if (show_mem) blk: {
        const values = try result_allocator.alloc(bench_utils.MemStat, 2);
        values[0] = .{ .name = "Frame", .bytes = byte_count };
        values[1] = .{ .name = "Chunks", .bytes = required_chunks * options.chunk_size };
        break :blk values;
    } else null;
    return .{
        .name = name,
        .min_ns = stats.min_ns,
        .avg_ns = stats.avg(),
        .max_ns = stats.max_ns,
        .total_ns = stats.total_ns,
        .iterations = stats.count,
        .stddev_ns = stats.standardDeviation(),
        .rme_95 = stats.relativeMarginOfError95(),
        .mem_stats = mem_stats,
    };
}

pub fn run(io: std.Io, allocator: std.mem.Allocator, show_mem: bool, bench_filter: ?[]const u8) ![]bench_utils.BenchResult {
    const scenarios = [_]struct {
        name: []const u8,
        byte_count: usize,
        iterations: usize,
        operation: Operation,
    }{
        .{ .name = "writeAtomic 16 KiB", .byte_count = 16 * 1024, .iterations = 100, .operation = .atomic },
        .{ .name = "FeedBackend frame 16 KiB", .byte_count = 16 * 1024, .iterations = 100, .operation = .backend },
        .{ .name = "writeAtomic 4 MiB", .byte_count = 4 * 1024 * 1024, .iterations = 100, .operation = .atomic },
        .{ .name = "FeedBackend frame 4 MiB", .byte_count = 4 * 1024 * 1024, .iterations = 100, .operation = .backend },
    };
    var results: std.ArrayListUnmanaged(bench_utils.BenchResult) = .empty;
    var gpa: std.heap.DebugAllocator(.{}) = .init;
    defer _ = gpa.deinit();
    for (scenarios) |scenario| {
        if (!bench_utils.matchesBenchFilter(scenario.name, bench_filter)) continue;
        try results.append(allocator, try runScenario(
            io,
            gpa.allocator(),
            allocator,
            scenario.name,
            scenario.byte_count,
            scenario.iterations,
            scenario.operation,
            show_mem,
        ));
    }
    return results.toOwnedSlice(allocator);
}
