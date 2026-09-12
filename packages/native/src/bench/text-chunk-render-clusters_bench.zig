const std = @import("std");
const bench_utils = @import("../bench-utils.zig");
const seg_mod = @import("../text-buffer-segment.zig");
const mem_registry_mod = @import("../mem-registry.zig");
const gp = @import("../grapheme.zig");

const TextChunk = seg_mod.TextChunk;
const MemRegistry = mem_registry_mod.MemRegistry;
const BenchResult = bench_utils.BenchResult;
const BenchStats = bench_utils.BenchStats;
const MemStat = bench_utils.MemStat;

pub const benchName = "TextChunk getRenderClusters";

const TextType = enum { ascii, mixed, heavy_unicode };

fn generateTestText(allocator: std.mem.Allocator, size: usize, text_type: TextType) ![]u8 {
    var buffer: std.ArrayList(u8) = .empty;
    errdefer buffer.deinit(allocator);

    switch (text_type) {
        .ascii => {
            // Pure ASCII text with tabs
            const patterns = [_][]const u8{
                "The quick brown fox jumps over the lazy dog. ",
                "Lorem ipsum dolor sit amet, consectetur elit. ",
                "function test() {\n\tconst x = 10;\n\treturn x;\n}\n",
                "Programming: Rust, Zig, Go, Python, JavaScript. ",
            };
            var pos: usize = 0;
            while (pos < size) {
                const pattern = patterns[pos % patterns.len];
                const to_add = @min(pattern.len, size - pos);
                try buffer.appendSlice(allocator, pattern[0..to_add]);
                pos += to_add;
            }
        },
        .mixed => {
            // Mix of ASCII and Unicode (realistic code/text)
            const patterns = [_][]const u8{
                "Hello, 世界! Unicode test. ",
                "Mixed: ASCII 中文 emoji 🌍 text. ",
                "Code: const x = 10; // comment\n",
                "Αυτό είναι ελληνικό. Это русский. ",
                "Numbers: 12345 symbols: !@#$% ",
                "\tTab\tseparated\tvalues\there. ",
            };
            var pos: usize = 0;
            while (pos < size) {
                const pattern = patterns[pos % patterns.len];
                const to_add = @min(pattern.len, size - pos);
                try buffer.appendSlice(allocator, pattern[0..to_add]);
                pos += to_add;
            }
        },
        .heavy_unicode => {
            // Heavy Unicode with emojis, combining marks, and wide chars
            const patterns = [_][]const u8{
                "世界中文字符測試文本。",
                "こんにちは、日本語テキスト。",
                "🌍🎉🚀🔥💻✨🌟⭐",
                "👋🏿👩‍🚀🇺🇸❤️",
                "café\u{0301} naïve résumé",
                "Ελληνικά Русский العربية",
            };
            var pos: usize = 0;
            while (pos < size) {
                const pattern = patterns[pos % patterns.len];
                const to_add = @min(pattern.len, size - pos);
                try buffer.appendSlice(allocator, pattern[0..to_add]);
                pos += to_add;
            }
        },
    }

    return buffer.toOwnedSlice(allocator);
}

fn benchGetRenderClusters(
    io: std.Io,
    allocator: std.mem.Allocator,
    size: usize,
    text_type: TextType,
    iterations: usize,
    show_mem: bool,
) !BenchResult {
    // Generate test text
    const text = try generateTestText(allocator, size, text_type);
    defer allocator.free(text);

    // Create memory registry
    var registry = MemRegistry.init(allocator);
    defer registry.deinit();

    const mem_id = try registry.register(text, false);

    // Determine if ASCII-only
    const is_ascii = switch (text_type) {
        .ascii => true,
        else => false,
    };

    // Create TextChunk
    // Width is approximate - clamped to u16 max
    const approx_width: u32 = @intCast(@min(text.len, std.math.maxInt(u32)));
    var stats: BenchStats = .{};
    var render_cluster_count: usize = 0;
    var final_mem: usize = 0;

    for (0..iterations) |i| {
        // Create a fresh arena for each iteration
        var arena = std.heap.ArenaAllocator.init(allocator);
        defer arena.deinit();
        const arena_alloc = arena.allocator();

        const chunk: TextChunk = .{
            .mem_id = mem_id,
            .byte_start = 0,
            .byte_end = @intCast(text.len),
            .width_cols = approx_width,
            .flags = if (is_ascii) TextChunk.Flags.ASCII_ONLY else 0,
        };

        const timer = bench_utils.BenchTimer.start(io);
        const render_clusters = try chunk.getRenderClusters(
            arena_alloc,
            &registry,
            4, // tab width
            .unicode,
        );
        stats.record(timer.read());

        if (i == 0) {
            render_cluster_count = render_clusters.len;
        }

        if (i == iterations - 1 and show_mem) {
            // Estimate memory used for sparse render-cluster metadata.
            final_mem = render_clusters.len * @sizeOf(seg_mod.RenderClusterInfo);
        }
    }

    const type_str = switch (text_type) {
        .ascii => "ASCII",
        .mixed => "Mixed",
        .heavy_unicode => "Heavy Unicode",
    };

    const name = try std.fmt.allocPrint(
        allocator,
        "getRenderClusters {s} ({d} bytes, {d} render clusters)",
        .{ type_str, size, render_cluster_count },
    );

    const mem_stats: ?[]const MemStat = if (show_mem) blk: {
        const mem_stat_slice = try allocator.alloc(MemStat, 1);
        mem_stat_slice[0] = .{ .name = "Render clusters", .bytes = final_mem };
        break :blk mem_stat_slice;
    } else null;

    return .{
        .name = name,
        .min_ns = stats.min_ns,
        .avg_ns = stats.avg(),
        .max_ns = stats.max_ns,
        .total_ns = stats.total_ns,
        .iterations = iterations,
        .mem_stats = mem_stats,
    };
}

fn computeBenchName(allocator: std.mem.Allocator, size: usize, text_type: TextType) ![]const u8 {
    var temp_arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer temp_arena.deinit();
    const temp_alloc = temp_arena.allocator();

    const text = try generateTestText(temp_alloc, size, text_type);

    var registry = MemRegistry.init(temp_alloc);
    defer registry.deinit();

    const mem_id = try registry.register(text, false);
    const is_ascii = switch (text_type) {
        .ascii => true,
        else => false,
    };
    const approx_width: u32 = @intCast(@min(text.len, std.math.maxInt(u32)));
    var chunk: TextChunk = .{
        .mem_id = mem_id,
        .byte_start = 0,
        .byte_end = @intCast(text.len),
        .width_cols = approx_width,
        .flags = if (is_ascii) TextChunk.Flags.ASCII_ONLY else 0,
    };

    const render_clusters = try chunk.getRenderClusters(
        temp_alloc,
        &registry,
        4, // tab width
        .unicode,
    );

    const type_str = switch (text_type) {
        .ascii => "ASCII",
        .mixed => "Mixed",
        .heavy_unicode => "Heavy Unicode",
    };

    return std.fmt.allocPrint(
        allocator,
        "getRenderClusters {s} ({d} bytes, {d} render clusters)",
        .{ type_str, size, render_clusters.len },
    );
}

pub fn run(
    io: std.Io,
    allocator: std.mem.Allocator,
    show_mem: bool,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    // Global pool and unicode data are initialized once in bench.zig
    _ = gp.initGlobalPool(allocator);

    var results: std.ArrayList(BenchResult) = .empty;
    errdefer results.deinit(allocator);

    const iterations: usize = 100;

    // Test different chunk sizes: 100B, 1KB, 4KB, 16KB, 64KB
    const sizes = [_]usize{ 100, 1024, 4 * 1024, 16 * 1024, 64 * 1024 };
    const text_types = [_]TextType{ .ascii, .mixed, .heavy_unicode };

    if (bench_filter == null) {
        for (text_types) |text_type| {
            for (sizes) |size| {
                const result = try benchGetRenderClusters(
                    io,
                    allocator,
                    size,
                    text_type,
                    iterations,
                    show_mem,
                );
                try results.append(allocator, result);
            }
        }
    } else {
        for (text_types) |text_type| {
            for (sizes) |size| {
                const name = try computeBenchName(allocator, size, text_type);
                if (!bench_utils.matchesBenchFilter(name, bench_filter)) {
                    allocator.free(name);
                    continue;
                }

                var result = try benchGetRenderClusters(
                    io,
                    allocator,
                    size,
                    text_type,
                    iterations,
                    show_mem,
                );
                allocator.free(result.name);
                result.name = name;
                try results.append(allocator, result);
            }
        }
    }

    return results.toOwnedSlice(allocator);
}
