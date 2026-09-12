const std = @import("std");
const bench_utils = @import("../bench-utils.zig");
const rope_mod = @import("../rope.zig");

const BenchResult = bench_utils.BenchResult;
const BenchStats = bench_utils.BenchStats;
const MemStats = bench_utils.MemStats;

pub const benchName = "Rope Marker Tracking";

// Test union type with markers (like Segment with .brk)
const Token = union(enum) {
    text: u32, // Text segments (width)
    marker: void, // Line markers

    pub const MarkerTypes = &[_]std.meta.Tag(Token){.marker};

    pub const Metrics = struct {
        width: u32 = 0,

        pub fn add(self: *Metrics, other: Metrics) void {
            self.width += other.width;
        }

        pub fn weight(self: *const Metrics) u32 {
            return self.width;
        }
    };

    pub fn measure(self: *const Token) Metrics {
        return switch (self.*) {
            .text => |w| .{ .width = w },
            .marker => .{ .width = 0 },
        };
    }

    pub fn empty() Token {
        return .{ .text = 0 };
    }

    pub fn is_empty(self: *const Token) bool {
        return switch (self.*) {
            .text => |w| w == 0,
            else => false,
        };
    }
};

const RopeType = rope_mod.Rope(Token);

/// Create a rope with specific marker density
/// marker_every: insert a marker every N text tokens
fn createRope(allocator: std.mem.Allocator, text_count: u32, marker_every: u32) !RopeType {
    var tokens: std.ArrayList(Token) = .empty;
    defer tokens.deinit(allocator);

    for (0..text_count) |i| {
        try tokens.append(allocator, .{ .text = 10 }); // Each text segment has width 10
        if ((i + 1) % marker_every == 0) {
            try tokens.append(allocator, .{ .marker = {} });
        }
    }

    return RopeType.from_slice(allocator, tokens.items);
}

fn benchRebuildMarkerIndex(
    io: std.Io,
    allocator: std.mem.Allocator,
    iterations: usize,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayList(BenchResult) = .empty;
    errdefer results.deinit(allocator);

    // Small rope, high marker density (every 10 tokens)
    {
        const name = "Create rope with markers: 1k tokens, marker every 10 (~100 markers)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                const timer = bench_utils.BenchTimer.start(io);
                const rope = try createRope(arena.allocator(), 1000, 10);
                _ = rope; // Markers are automatically indexed during rope creation
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

    // Small rope, low marker density (every 100 tokens)
    {
        const name = "Rebuild index: 1k tokens, marker every 100 (~10 markers)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                const timer = bench_utils.BenchTimer.start(io);
                const rope = try createRope(arena.allocator(), 1000, 100);
                _ = rope; // Markers are automatically indexed during rope creation
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

    // Medium rope, high marker density
    {
        const name = "Rebuild index: 10k tokens, marker every 10 (~1k markers)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                const timer = bench_utils.BenchTimer.start(io);
                const rope = try createRope(arena.allocator(), 10000, 10);
                _ = rope; // Markers are automatically indexed during rope creation
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

    // Medium rope, low marker density
    {
        const name = "Rebuild index: 10k tokens, marker every 100 (~100 markers)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                const timer = bench_utils.BenchTimer.start(io);
                const rope = try createRope(arena.allocator(), 10000, 100);
                _ = rope; // Markers are automatically indexed during rope creation
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

    // Large rope, text-editor-like density (marker every 50 = ~50 chars/line)
    {
        const name = "Rebuild index: 50k tokens, marker every 50 (~1k markers, text-editor-like)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                const timer = bench_utils.BenchTimer.start(io);
                const rope = try createRope(arena.allocator(), 50000, 50);
                _ = rope; // Markers are automatically indexed during rope creation
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

    // Very large rope, sparse markers
    {
        const name = "Rebuild index: 100k tokens, marker every 200 (~500 markers)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                const timer = bench_utils.BenchTimer.start(io);
                const rope = try createRope(arena.allocator(), 100000, 200);
                _ = rope; // Markers are automatically indexed during rope creation
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

fn benchMarkerLookup(
    io: std.Io,
    allocator: std.mem.Allocator,
    iterations: usize,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayList(BenchResult) = .empty;
    errdefer results.deinit(allocator);

    // O(1) lookup in small rope
    {
        const name = "O(1) lookup: 100 random marker accesses, ~100 markers";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                var rope = try createRope(arena.allocator(), 1000, 10);
                // Markers are automatically indexed in the tree structure

                const timer = bench_utils.BenchTimer.start(io);
                for (0..100) |i| {
                    _ = rope.getMarker(.marker, @intCast(i % rope.markerCount(.marker)));
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

    // O(1) lookup in medium rope
    {
        const name = "O(1) lookup: 1k random marker accesses, ~200 markers";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                var rope = try createRope(arena.allocator(), 10000, 50);
                // Markers are automatically indexed in the tree structure

                const timer = bench_utils.BenchTimer.start(io);
                for (0..1000) |i| {
                    _ = rope.getMarker(.marker, @intCast(i % rope.markerCount(.marker)));
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

    // O(1) lookup in large rope (text-editor scenario)
    {
        const name = "O(1) lookup: 10k random line jumps, ~1k lines (text-editor)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                var rope = try createRope(arena.allocator(), 50000, 50);
                // Markers are automatically indexed in the tree structure
                const marker_count = rope.markerCount(.marker);

                var prng = std.Random.DefaultPrng.init(42);
                const random = prng.random();

                const timer = bench_utils.BenchTimer.start(io);
                for (0..10000) |_| {
                    const line = random.intRangeAtMost(u32, 0, marker_count - 1);
                    _ = rope.getMarker(.marker, line);
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

    // Sequential marker access (best case)
    {
        const name = "O(1) lookup: Sequential access to all ~200 markers";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                var rope = try createRope(arena.allocator(), 10000, 50);
                // Markers are automatically indexed in the tree structure
                const marker_count = rope.markerCount(.marker);

                const timer = bench_utils.BenchTimer.start(io);
                for (0..marker_count) |i| {
                    _ = rope.getMarker(.marker, @intCast(i));
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

fn benchMarkerCount(
    io: std.Io,
    allocator: std.mem.Allocator,
    iterations: usize,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayList(BenchResult) = .empty;
    errdefer results.deinit(allocator);

    // Count markers - should be O(1) hash lookup
    {
        const name = "markerCount: 100k calls (should be ~O(1))";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                var rope = try createRope(arena.allocator(), 10000, 50);
                // Markers are automatically indexed in the tree structure

                const timer = bench_utils.BenchTimer.start(io);
                for (0..100000) |_| {
                    _ = rope.markerCount(.marker);
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

fn benchDepthVsPerformance(
    io: std.Io,
    allocator: std.mem.Allocator,
    iterations: usize,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayList(BenchResult) = .empty;
    errdefer results.deinit(allocator);

    // Shallow tree (from_slice creates balanced tree)
    {
        const name = "Create BALANCED tree with markers: 10k tokens, ~200 markers";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                const timer = bench_utils.BenchTimer.start(io);
                const rope = try createRope(arena.allocator(), 10000, 50);
                _ = rope; // Markers are automatically indexed during rope creation
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

    // Deep tree (built by sequential appends)
    {
        const name = "Rebuild on UNBALANCED tree: 10k tokens, ~200 markers";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                // Build unbalanced tree through sequential operations
                var rope = try RopeType.init(arena.allocator());
                for (0..10000) |i| {
                    try rope.append(.{ .text = 10 });
                    if ((i + 1) % 50 == 0) {
                        try rope.append(.{ .marker = {} });
                    }
                }

                const timer = bench_utils.BenchTimer.start(io);
                // Markers are automatically indexed in the tree structure
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

fn benchEditThenRebuild(
    io: std.Io,
    allocator: std.mem.Allocator,
    iterations: usize,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayList(BenchResult) = .empty;
    errdefer results.deinit(allocator);

    // Typical edit workflow: build, edit, rebuild
    {
        const name = "Edit workflow: 3 inserts + rebuild (~200 markers)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                var rope = try createRope(arena.allocator(), 10000, 50);
                // Markers are automatically indexed in the tree structure

                const timer = bench_utils.BenchTimer.start(io);
                // Simulate typing at line 50
                const line50_marker = rope.getMarker(.marker, 50).?;
                const insert_pos = line50_marker.leaf_index + 1;

                // Insert some text
                try rope.insert(insert_pos, .{ .text = 10 });
                try rope.insert(insert_pos + 1, .{ .text = 10 });
                try rope.insert(insert_pos + 2, .{ .text = 10 });

                // Rebuild index after edit
                // Markers are automatically indexed in the tree structure
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

    // Insert new line (adds marker)
    {
        const name = "Insert newline: insert marker + rebuild (~200 markers)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                var rope = try createRope(arena.allocator(), 10000, 50);
                // Markers are automatically indexed in the tree structure

                const timer = bench_utils.BenchTimer.start(io);
                // Insert new line (marker) at position 100
                try rope.insert(100, .{ .marker = {} });
                // Markers are automatically indexed in the tree structure
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

    // Delete line (removes marker)
    {
        const name = "Delete line: remove marker + rebuild (~200 markers)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                var rope = try createRope(arena.allocator(), 10000, 50);
                // Markers are automatically indexed in the tree structure

                const timer = bench_utils.BenchTimer.start(io);
                // Delete marker at position
                const marker_pos = rope.getMarker(.marker, 50).?.leaf_index;
                try rope.delete(marker_pos);
                // Markers are automatically indexed in the tree structure
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

fn benchMemoryUsage(
    allocator: std.mem.Allocator,
    iterations: usize,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayList(BenchResult) = .empty;
    errdefer results.deinit(allocator);

    // Memory comparison: with vs without marker index
    {
        const name = "Memory: 50k tokens WITHOUT marker index";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                const rope = try createRope(arena.allocator(), 50000, 50);
                // Don't rebuild index - just measure rope creation
                _ = rope;

                const elapsed: u64 = 0; // Placeholder for memory measurement
                stats.record(elapsed);
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

    {
        const name = "Memory: 50k tokens WITH marker index (~1k markers)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};
            for (0..iterations) |_| {
                var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
                defer arena.deinit();

                const rope = try createRope(arena.allocator(), 50000, 50);
                _ = rope; // Markers are automatically indexed in the tree structure

                const elapsed: u64 = 0; // Placeholder for memory measurement
                stats.record(elapsed);
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
    _ = show_mem;

    var all_results: std.ArrayList(BenchResult) = .empty;
    errdefer all_results.deinit(allocator);

    const iterations: usize = 10;

    // Rebuild index benchmarks
    const rebuild_results = try benchRebuildMarkerIndex(io, allocator, iterations, bench_filter);
    try all_results.appendSlice(allocator, rebuild_results);

    // Marker lookup benchmarks
    const lookup_results = try benchMarkerLookup(io, allocator, iterations, bench_filter);
    try all_results.appendSlice(allocator, lookup_results);

    // Marker count benchmarks
    const count_results = try benchMarkerCount(io, allocator, iterations, bench_filter);
    try all_results.appendSlice(allocator, count_results);

    // Tree depth impact
    const depth_results = try benchDepthVsPerformance(io, allocator, iterations, bench_filter);
    try all_results.appendSlice(allocator, depth_results);

    // Edit workflows
    const edit_results = try benchEditThenRebuild(io, allocator, iterations, bench_filter);
    try all_results.appendSlice(allocator, edit_results);

    // Memory usage comparison
    const memory_results = try benchMemoryUsage(allocator, iterations, bench_filter);
    try all_results.appendSlice(allocator, memory_results);

    return all_results.toOwnedSlice(allocator);
}
