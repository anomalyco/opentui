const std = @import("std");
const bench_utils = @import("../bench-utils.zig");
const rope_mod = @import("../rope.zig");

const BenchResult = bench_utils.BenchResult;
const BenchStats = bench_utils.BenchStats;

pub const benchName = "Rope Data Structure";

// Simple test item type
const TestItem = struct {
    value: u32,

    pub fn empty() TestItem {
        return .{ .value = 0 };
    }

    pub fn is_empty(self: *const TestItem) bool {
        return self.value == 0;
    }
};

const RopeType = rope_mod.Rope(TestItem);

fn benchInsertOperations(
    io: std.Io,
    allocator: std.mem.Allocator,
    iterations: usize,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayList(BenchResult) = .empty;
    errdefer results.deinit(allocator);

    // Sequential appends
    {
        const name = "Rope sequential append 10k items";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                var rope = try RopeType.init(arena.allocator());
                const timer = bench_utils.BenchTimer.start(io);
                for (0..10000) |i| {
                    try rope.append(.{ .value = @intCast(i) });
                }
                stats.record(timer.read());
            }

            try results.append(allocator, .{
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

    // Sequential prepends
    {
        const name = "Rope sequential prepend 10k items";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                var rope = try RopeType.init(arena.allocator());
                const timer = bench_utils.BenchTimer.start(io);
                for (0..10000) |i| {
                    try rope.prepend(.{ .value = @intCast(i) });
                }
                stats.record(timer.read());
            }

            try results.append(allocator, .{
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

    // Random inserts
    {
        const name = "Rope random insert 5k items";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                var rope = try RopeType.init(arena.allocator());
                var prng = std.Random.DefaultPrng.init(42);
                const random = prng.random();
                const timer = bench_utils.BenchTimer.start(io);
                for (0..5000) |i| {
                    const pos = if (rope.count() > 0)
                        random.intRangeAtMost(u32, 0, rope.count())
                    else
                        0;
                    try rope.insert(pos, .{ .value = @intCast(i) });
                }
                stats.record(timer.read());
            }

            try results.append(allocator, .{
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

    return results.toOwnedSlice(allocator);
}

fn benchDeleteOperations(
    io: std.Io,
    allocator: std.mem.Allocator,
    iterations: usize,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayList(BenchResult) = .empty;
    errdefer results.deinit(allocator);

    var items: [10000]TestItem = undefined;
    for (&items, 0..) |*item, i| {
        item.* = .{ .value = @intCast(i) };
    }

    // Sequential deletes from end
    {
        const name = "Rope sequential delete 5k from end";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                var rope = try RopeType.from_slice(arena.allocator(), &items);
                const timer = bench_utils.BenchTimer.start(io);
                for (0..5000) |_| {
                    try rope.delete(rope.count() - 1);
                }
                stats.record(timer.read());
            }

            try results.append(allocator, .{
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

    // Sequential deletes from beginning
    {
        const name = "Rope sequential delete 5k from beginning";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                var rope = try RopeType.from_slice(arena.allocator(), &items);
                const timer = bench_utils.BenchTimer.start(io);
                for (0..5000) |_| {
                    try rope.delete(0);
                }
                stats.record(timer.read());
            }

            try results.append(allocator, .{
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

    // Random deletes
    {
        const name = "Rope random delete 5k items";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                var rope = try RopeType.from_slice(arena.allocator(), &items);
                var prng = std.Random.DefaultPrng.init(42);
                const random = prng.random();
                const timer = bench_utils.BenchTimer.start(io);
                for (0..5000) |_| {
                    const pos = random.intRangeAtMost(u32, 0, rope.count() - 1);
                    try rope.delete(pos);
                }
                stats.record(timer.read());
            }

            try results.append(allocator, .{
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

    return results.toOwnedSlice(allocator);
}

fn benchBulkOperations(
    io: std.Io,
    allocator: std.mem.Allocator,
    iterations: usize,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayList(BenchResult) = .empty;
    errdefer results.deinit(allocator);

    var items: [10000]TestItem = undefined;
    for (&items, 0..) |*item, i| {
        item.* = .{ .value = @intCast(i) };
    }

    // insert_slice
    {
        const name = "Rope insert_slice 10x1k items";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                var rope = try RopeType.init(arena.allocator());
                var chunk: [1000]TestItem = undefined;
                for (&chunk, 0..) |*item, i| {
                    item.* = .{ .value = @intCast(i) };
                }
                const timer = bench_utils.BenchTimer.start(io);
                for (0..10) |_| {
                    try rope.insert_slice(rope.count(), &chunk);
                }
                stats.record(timer.read());
            }

            try results.append(allocator, .{
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

    // delete_range
    {
        const name = "Rope delete_range 10x500 items";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                var rope = try RopeType.from_slice(arena.allocator(), &items);
                const timer = bench_utils.BenchTimer.start(io);
                for (0..10) |_| {
                    const start = if (rope.count() > 500) rope.count() - 500 else 0;
                    const end = rope.count();
                    try rope.delete_range(start, end);
                }
                stats.record(timer.read());
            }

            try results.append(allocator, .{
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

    // split/concat
    {
        const name = "Rope split/concat 100 cycles at midpoint";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                var rope = try RopeType.from_slice(arena.allocator(), &items);
                const timer = bench_utils.BenchTimer.start(io);
                for (0..100) |_| {
                    const mid = rope.count() / 2;
                    var right = try rope.split(mid);
                    try rope.concat(&right);
                }
                stats.record(timer.read());
            }

            try results.append(allocator, .{
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

    // concat two ropes
    {
        const name = "Rope concat two 5k-item ropes";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                var rope1 = try RopeType.from_slice(arena.allocator(), items[0..5000]);
                const rope2 = try RopeType.from_slice(arena.allocator(), items[5000..]);
                const timer = bench_utils.BenchTimer.start(io);
                try rope1.concat(&rope2);
                stats.record(timer.read());
            }

            try results.append(allocator, .{
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

    return results.toOwnedSlice(allocator);
}

fn benchAccessPatterns(
    io: std.Io,
    allocator: std.mem.Allocator,
    iterations: usize,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayList(BenchResult) = .empty;
    errdefer results.deinit(allocator);

    var items: [10000]TestItem = undefined;
    for (&items, 0..) |*item, i| {
        item.* = .{ .value = @intCast(i) };
    }

    // Sequential get
    {
        const name = "Rope sequential get all 10k items";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                const rope = try RopeType.from_slice(arena.allocator(), &items);
                const timer = bench_utils.BenchTimer.start(io);
                for (0..10000) |i| {
                    _ = rope.get(@intCast(i));
                }
                stats.record(timer.read());
            }

            try results.append(allocator, .{
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

    // Random get
    {
        const name = "Rope random get 10k accesses";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                const rope = try RopeType.from_slice(arena.allocator(), &items);
                var prng = std.Random.DefaultPrng.init(42);
                const random = prng.random();
                const timer = bench_utils.BenchTimer.start(io);
                for (0..10000) |_| {
                    const pos = random.intRangeAtMost(u32, 0, 9999);
                    _ = rope.get(pos);
                }
                stats.record(timer.read());
            }

            try results.append(allocator, .{
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

    // Walk
    {
        const name = "Rope walk all 10k items";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                const rope = try RopeType.from_slice(arena.allocator(), &items);
                const Ctx = struct {
                    sum: u64 = 0,
                    fn walker(ctx: *anyopaque, data: *const TestItem, index: u32) RopeType.Node.WalkerResult {
                        _ = index;
                        const self = @as(*@This(), @ptrCast(@alignCast(ctx)));
                        self.sum += data.value;
                        return .{};
                    }
                };
                var ctx: Ctx = .{};
                const timer = bench_utils.BenchTimer.start(io);
                try rope.walk(&ctx, Ctx.walker);
                stats.record(timer.read());
            }

            try results.append(allocator, .{
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

    return results.toOwnedSlice(allocator);
}

pub fn run(
    io: std.Io,
    allocator: std.mem.Allocator,
    show_mem: bool,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    _ = show_mem; // Rope benchmarks don't currently track memory

    var all_results: std.ArrayList(BenchResult) = .empty;
    errdefer all_results.deinit(allocator);

    const iterations: usize = 10;

    // Run all benchmark categories and filter results
    const insert_results = try benchInsertOperations(io, allocator, iterations, bench_filter);
    try all_results.appendSlice(allocator, insert_results);

    const delete_results = try benchDeleteOperations(io, allocator, iterations, bench_filter);
    try all_results.appendSlice(allocator, delete_results);

    const bulk_results = try benchBulkOperations(io, allocator, iterations, bench_filter);
    try all_results.appendSlice(allocator, bulk_results);

    const access_results = try benchAccessPatterns(io, allocator, iterations, bench_filter);
    try all_results.appendSlice(allocator, access_results);

    return all_results.toOwnedSlice(allocator);
}
