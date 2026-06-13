// Benchmark Runner CLI
//
// This is the main entry point for running performance benchmarks for opentui core components.
//
// Usage:
//   zig build bench              - Run all benchmarks
//   zig build bench -- --help    - Show help message with available options
//
// Options:
//   --mem                   Show memory statistics after each benchmark
//   --filter, -f NAME       Run only benchmark categories matching NAME (case-insensitive substring)
//   --bench, -b NAME        Run only specific benchmarks matching NAME
//   --json                  Output results in JSON format (machine-readable)
//   --help, -h              Display help message and list available benchmarks
//
// Examples:
//   zig build bench -- --mem
//     Run all benchmarks with memory statistics
//
//   zig build bench -- --filter rope
//     Run only benchmarks with "rope" in their name (Rope Data Structure, Rope Marker Tracking)
//
//   zig build bench -- -f textbuffer --mem
//     Run TextBuffer benchmarks with memory statistics
//
//   zig build bench -- --filter "edit"
//     Run EditBuffer Operations benchmarks
//
//   zig build bench -- --bench "ASCII"
//     Run only benchmarks with "ASCII" in their name
//
//   zig build bench -- --json
//     Output results in JSON format for CI integration
//
// Adding New Benchmarks:
//   1. Create a new file in bench/ directory (e.g., bench/my_bench.zig)
//   2. Export `pub const benchName = "My Benchmark";`
//   3. Export `pub fn run(allocator: std.mem.Allocator, show_mem: bool, bench_filter: ?[]const u8) ![]BenchResult`
//   4. Import the module at the top of this file
//   5. Add an entry to the `benchmarks` array in main() with your module

const std = @import("std");
const bench_utils = @import("bench-utils.zig");
const gp = @import("grapheme.zig");

// Import all benchmark modules
const text_buffer_view_bench = @import("bench/text-buffer-view_bench.zig");
const edit_buffer_bench = @import("bench/edit-buffer_bench.zig");
const rope_bench = @import("bench/rope_bench.zig");
const rope_markers_bench = @import("bench/rope-markers_bench.zig");
const text_buffer_coords_bench = @import("bench/text-buffer-coords_bench.zig");
const styled_text_bench = @import("bench/styled-text_bench.zig");
const buffer_draw_text_buffer_bench = @import("bench/buffer-draw-text-buffer_bench.zig");
const buffer_color_blending_bench = @import("bench/buffer-color-blending_bench.zig");
const buffer_draw_box_bench = @import("bench/buffer-draw-box_bench.zig");
const utf8_bench = @import("bench/utf8_bench.zig");
const text_chunk_graphemes_bench = @import("bench/text-chunk-graphemes_bench.zig");
const editor_view_bench = @import("bench/editor-view_bench.zig");

const BenchModule = struct {
    name: []const u8,
    run: *const fn (std.mem.Allocator, bool, ?[]const u8) anyerror![]bench_utils.BenchResult,
};

fn matchesFilter(bench_name: []const u8, filter: ?[]const u8) bool {
    if (filter == null) return true;
    const filter_str = filter.?;
    if (filter_str.len == 0) return true;

    var i: usize = 0;
    while (i + filter_str.len <= bench_name.len) : (i += 1) {
        var matches = true;
        for (filter_str, 0..) |filter_char, j| {
            const bench_char = bench_name[i + j];
            const filter_lower = if (filter_char >= 'A' and filter_char <= 'Z') filter_char + 32 else filter_char;
            const bench_lower = if (bench_char >= 'A' and bench_char <= 'Z') bench_char + 32 else bench_char;
            if (filter_lower != bench_lower) {
                matches = false;
                break;
            }
        }
        if (matches) return true;
    }
    return false;
}

pub fn main() !void {
    var gpa: std.heap.GeneralPurposeAllocator(.{}) = .{};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    // Initialize global pool and unicode data ONCE with base GPA allocator
    // This ensures they persist across all benchmarks (even with arena allocators)
    _ = gp.initGlobalPool(allocator);
    defer gp.deinitGlobalPool();

    const benchmarks = [_]BenchModule{
        .{ .name = text_buffer_view_bench.benchName, .run = text_buffer_view_bench.run },
        .{ .name = edit_buffer_bench.benchName, .run = edit_buffer_bench.run },
        .{ .name = rope_bench.benchName, .run = rope_bench.run },
        .{ .name = rope_markers_bench.benchName, .run = rope_markers_bench.run },
        .{ .name = text_buffer_coords_bench.benchName, .run = text_buffer_coords_bench.run },
        .{ .name = styled_text_bench.benchName, .run = styled_text_bench.run },
        .{ .name = buffer_draw_text_buffer_bench.benchName, .run = buffer_draw_text_buffer_bench.run },
        .{ .name = buffer_color_blending_bench.benchName, .run = buffer_color_blending_bench.run },
        .{ .name = buffer_draw_box_bench.benchName, .run = buffer_draw_box_bench.run },
        .{ .name = utf8_bench.benchName, .run = utf8_bench.run },
        .{ .name = text_chunk_graphemes_bench.benchName, .run = text_chunk_graphemes_bench.run },
        .{ .name = editor_view_bench.benchName, .run = editor_view_bench.run },
    };

    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);

    var show_mem = false;
    var json_output = false;
    var filter: ?[]const u8 = null;
    var bench_filter: ?[]const u8 = null;
    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        const arg = args[i];
        if (std.mem.eql(u8, arg, "--mem")) {
            show_mem = true;
        } else if (std.mem.eql(u8, arg, "--json")) {
            json_output = true;
        } else if (std.mem.eql(u8, arg, "--filter") or std.mem.eql(u8, arg, "-f")) {
            if (i + 1 < args.len) {
                i += 1;
                filter = args[i];
            }
        } else if (std.mem.eql(u8, arg, "--bench") or std.mem.eql(u8, arg, "-b")) {
            if (i + 1 < args.len) {
                i += 1;
                bench_filter = args[i];
            }
        } else if (std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h")) {
            var stdout_buffer: [4096]u8 = undefined;
            var stdout_writer = std.fs.File.stdout().writer(&stdout_buffer);
            const stdout = &stdout_writer.interface;
            try stdout.print("Usage: bench [options]\n\n", .{});
            try stdout.print("Options:\n", .{});
            try stdout.print("  --mem                   Show memory statistics\n", .{});
            try stdout.print("  --json                  Output in JSON format (machine-readable)\n", .{});
            try stdout.print("  --filter, -f NAME       Run only benchmark categories matching NAME\n", .{});
            try stdout.print("  --bench, -b NAME        Run only specific benchmarks matching NAME\n", .{});
            try stdout.print("  --help, -h              Show this help message\n\n", .{});
            try stdout.print("Available benchmarks:\n", .{});
            for (benchmarks) |bench| {
                try stdout.print("  - {s}\n", .{bench.name});
            }
            try stdout.flush();
            return;
        }
    }

    var stdout_buffer: [4096]u8 = undefined;
    var stdout_writer = std.fs.File.stdout().writer(&stdout_buffer);
    const stdout = &stdout_writer.interface;

    if (!json_output and filter != null) {
        try stdout.print("Filtering benchmarks by: \"{s}\"\n", .{filter.?});
    }
    if (!json_output and bench_filter != null) {
        try stdout.print("Filtering individual benchmarks by: \"{s}\"\n", .{bench_filter.?});
    }

    var ran_any = false;

    for (benchmarks) |bench| {
        if (!matchesFilter(bench.name, filter)) continue;

        // Use arena for results only - benchmark modules manage their own temp memory
        var results_arena = std.heap.ArenaAllocator.init(allocator);
        defer results_arena.deinit();

        const start_time = std.time.nanoTimestamp();
        const results = try bench.run(results_arena.allocator(), show_mem, bench_filter);
        const end_time = std.time.nanoTimestamp();
        const elapsed_ns = end_time - start_time;

        if (results.len == 0) continue;

        if (!json_output) {
            try stdout.print("\n=== {s} Benchmarks ===\n\n", .{bench.name});
            try stdout.flush();
        }

        if (json_output) {
            try bench_utils.printResultsJson(stdout, results, bench.name);
        } else {
            try bench_utils.printResults(stdout, results);
            const elapsed_ms = @as(f64, @floatFromInt(elapsed_ns)) / 1_000_000.0;
            try stdout.print("\n  Overall time: {d:.2}ms\n", .{elapsed_ms});
        }

        ran_any = true;
    }

    if (!ran_any) {
        if (!json_output) {
            if (filter != null and bench_filter != null) {
                try stdout.print(
                    "\nNo benchmarks matched filters: category=\"{s}\", bench=\"{s}\"\n",
                    .{ filter.?, bench_filter.? },
                );
            } else if (bench_filter != null) {
                try stdout.print("\nNo benchmarks matched bench filter: \"{s}\"\n", .{bench_filter.?});
            } else if (filter != null) {
                try stdout.print("\nNo benchmarks matched filter: \"{s}\"\n", .{filter.?});
            } else {
                try stdout.print("\nNo benchmarks ran.\n", .{});
            }
            try stdout.print("Use --help to see available benchmarks.\n", .{});
        }
        try stdout.flush();
        return;
    }

    if (!json_output) {
        try stdout.print("\n✓ Benchmarks complete\n", .{});
    }
    try stdout.flush();
}
