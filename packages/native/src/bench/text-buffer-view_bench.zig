const std = @import("std");
const TestPools = @import("../tests/test-pools.zig").TestPools;
const bench_utils = @import("../bench-utils.zig");
const text_buffer = @import("../text-buffer.zig");
const text_buffer_view = @import("../text-buffer-view.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");
const utils = @import("../utils.zig");

const UnifiedTextBuffer = text_buffer.UnifiedTextBuffer;
const UnifiedTextBufferView = text_buffer_view.UnifiedTextBufferView;
const WrapMode = text_buffer.WrapMode;
const BenchResult = bench_utils.BenchResult;
const BenchStats = bench_utils.BenchStats;
const MemStat = bench_utils.MemStat;

pub const benchName = "TextBuffer Wrapping";

const large_text_patterns = [_][]const u8{
    "The quick brown fox jumps over the lazy dog. ",
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ",
    "Hello, 世界! Unicode テスト 🌍🎉 ",
    "Mixed width: ASCII 中文字符 emoji 🚀🔥💻 and more text. ",
    "Programming languages: Rust, Zig, Go, Python, JavaScript. ",
    "Αυτό είναι ελληνικό κείμενο. Это русский текст. ",
    "Numbers and symbols: 12345 !@#$%^&*() []{}|;:',.<>? ",
    "Tab\tseparated\tvalues\there\tfor\ttesting\twrapping. ",
};

const matched_single_chunk_text = utils.repeat(u8, "word-", 12_800);
const matched_single_chunk_width: u32 = 64_000;

pub fn generateLargeText(allocator: std.mem.Allocator, lines: u32, target_bytes: usize) ![]u8 {
    var buffer: std.ArrayList(u8) = .empty;
    errdefer buffer.deinit(allocator);

    var current_bytes: usize = 0;
    var line_idx: u32 = 0;

    while (current_bytes < target_bytes and line_idx < lines) : (line_idx += 1) {
        const pattern = large_text_patterns[line_idx % large_text_patterns.len];
        const repeat_count = 2 + (line_idx % 5);

        for (0..repeat_count) |_| {
            try buffer.appendSlice(allocator, pattern);
            current_bytes += pattern.len;
        }

        try buffer.append(allocator, '\n');
        current_bytes += 1;
    }

    return buffer.toOwnedSlice(allocator);
}

fn computeLargeTextStats(lines: u32, target_bytes: usize) struct { bytes: usize, line_count: usize } {
    var current_bytes: usize = 0;
    var line_idx: u32 = 0;

    while (current_bytes < target_bytes and line_idx < lines) : (line_idx += 1) {
        const pattern = large_text_patterns[line_idx % large_text_patterns.len];
        const repeat_count = 2 + (line_idx % 5);
        current_bytes += pattern.len * repeat_count + 1;
    }

    return .{ .bytes = current_bytes, .line_count = line_idx };
}

fn benchSetText(
    io: std.Io,
    allocator: std.mem.Allocator,
    pool: *gp.GraphemePool,
    link_pool: *link.LinkPool,
    iterations: usize,
    show_mem: bool,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayList(BenchResult) = .empty;
    errdefer results.deinit(allocator);

    // Small text
    {
        const name = "TextBuffer setText small (3 lines, 36 bytes)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            const text = "Hello, world!\nSecond line\nThird line";
            var stats: BenchStats = .{};
            var final_mem: usize = 0;

            for (0..iterations) |i| {
                var tb = try UnifiedTextBuffer.init(allocator, pool, link_pool, .unicode);
                defer tb.deinit();

                const timer = bench_utils.BenchTimer.start(io);
                try tb.setText(text);
                stats.record(timer.read());

                if (i == iterations - 1 and show_mem) {
                    final_mem = tb.getArenaAllocatedBytes();
                }
            }

            const mem_stats: ?[]const MemStat = if (show_mem) blk: {
                const mem = try allocator.alloc(MemStat, 1);
                mem[0] = .{ .name = "TB", .bytes = final_mem };
                break :blk mem;
            } else null;

            try results.append(allocator, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = mem_stats,
            });
        }
    }

    // Large multi-line text
    {
        const text_stats = computeLargeTextStats(5000, 1 * 1024 * 1024);
        const text_mb = @as(f64, @floatFromInt(text_stats.bytes)) / (1024.0 * 1024.0);
        const name = try std.fmt.allocPrint(
            allocator,
            "TextBuffer setText large ({d} lines, {d:.2} MiB)",
            .{ text_stats.line_count, text_mb },
        );

        if (!bench_utils.matchesBenchFilter(name, bench_filter)) {
            allocator.free(name);
        } else {
            const text = try generateLargeText(allocator, 5000, 1 * 1024 * 1024);
            defer allocator.free(text);

            var stats: BenchStats = .{};
            var final_mem: usize = 0;

            for (0..iterations) |i| {
                var tb = try UnifiedTextBuffer.init(allocator, pool, link_pool, .unicode);
                defer tb.deinit();

                const timer = bench_utils.BenchTimer.start(io);
                try tb.setText(text);
                stats.record(timer.read());

                if (i == iterations - 1 and show_mem) {
                    final_mem = tb.getArenaAllocatedBytes();
                }
            }

            const mem_stats: ?[]const MemStat = if (show_mem) blk: {
                const mem = try allocator.alloc(MemStat, 1);
                mem[0] = .{ .name = "TB", .bytes = final_mem };
                break :blk mem;
            } else null;

            try results.append(allocator, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = iterations,
                .mem_stats = mem_stats,
            });
        }
    }

    return results.toOwnedSlice(allocator);
}

fn benchWrap(
    io: std.Io,
    allocator: std.mem.Allocator,
    pool: *gp.GraphemePool,
    link_pool: *link.LinkPool,
    text: []const u8,
    wrap_width: u32,
    wrap_mode: WrapMode,
    iterations: usize,
    show_mem: bool,
    expected_total_width: ?u32,
) !BenchResult {
    var stats: BenchStats = .{};
    var final_tb_mem: usize = 0;
    var final_view_mem: usize = 0;

    for (0..iterations) |i| {
        var tb = try UnifiedTextBuffer.init(allocator, pool, link_pool, .unicode);
        defer tb.deinit();

        try tb.setText(text);

        var view = try UnifiedTextBufferView.init(allocator, tb);
        defer view.deinit();

        view.setWrapMode(wrap_mode);

        const timer = bench_utils.BenchTimer.start(io);
        view.setWrapWidth(wrap_width);
        const count = view.getVirtualLineCount();
        stats.record(timer.read());

        // Validate outside the timed interval so both revisions must produce the
        // same complete layout before their timings are compared.
        if (expected_total_width) |expected_width| {
            const lines = view.getVirtualLines();
            const expected_count = (expected_width + wrap_width - 1) / wrap_width;
            if (tb.getLineCount() != 1 or count != expected_count or lines.len != @as(usize, @intCast(expected_count))) {
                return error.InvalidBenchmarkOutput;
            }
            for (lines, 0..) |line, line_idx| {
                const remainder = expected_width % wrap_width;
                const expected_line_width = if (line_idx + 1 == lines.len and remainder != 0) remainder else wrap_width;
                if (line.width_cols != expected_line_width) return error.InvalidBenchmarkOutput;
            }
        }

        if (i == iterations - 1 and show_mem) {
            final_tb_mem = tb.getArenaAllocatedBytes();
            final_view_mem = view.getArenaAllocatedBytes();
        }
    }

    const mem_stats: ?[]const MemStat = if (show_mem) blk: {
        const mem = try allocator.alloc(MemStat, 2);
        mem[0] = .{ .name = "TB", .bytes = final_tb_mem };
        mem[1] = .{ .name = "View", .bytes = final_view_mem };
        break :blk mem;
    } else null;

    return .{
        .name = "",
        .min_ns = stats.min_ns,
        .avg_ns = stats.avg(),
        .max_ns = stats.max_ns,
        .total_ns = stats.total_ns,
        .iterations = iterations,
        .mem_stats = mem_stats,
    };
}

/// Rewraps one word-wrapped view across widths, as terminal resizes do.
fn benchRewrap(
    io: std.Io,
    allocator: std.mem.Allocator,
    pool: *gp.GraphemePool,
    link_pool: *link.LinkPool,
    line: []const u8,
    repeat: usize,
) !BenchResult {
    const text = try allocator.alloc(u8, line.len * repeat);
    defer allocator.free(text);
    for (0..repeat) |i| @memcpy(text[i * line.len ..][0..line.len], line);

    var tb = try UnifiedTextBuffer.init(allocator, pool, link_pool, .unicode);
    defer tb.deinit();
    try tb.setText(text);
    var view = try UnifiedTextBufferView.init(allocator, tb);
    defer view.deinit();
    view.setWrapMode(.word);
    view.setWrapWidth(80);
    _ = view.getVirtualLineCount();

    const widths = [_]u32{ 79, 43, 96, 80, 61, 120, 37 };
    const iterations = widths.len * 10;
    var stats: BenchStats = .{};
    var checksum: u64 = 0;
    for (0..iterations) |i| {
        const timer = bench_utils.BenchTimer.start(io);
        view.setWrapWidth(widths[i % widths.len]);
        checksum +%= view.getVirtualLineCount();
        stats.record(timer.read());
    }
    std.mem.doNotOptimizeAway(checksum);
    return .{
        .name = "",
        .min_ns = stats.min_ns,
        .avg_ns = stats.avg(),
        .max_ns = stats.max_ns,
        .total_ns = stats.total_ns,
        .iterations = iterations,
        .mem_stats = null,
    };
}

fn benchMeasureForDimensionsLayout(
    io: std.Io,
    allocator: std.mem.Allocator,
    pool: *gp.GraphemePool,
    link_pool: *link.LinkPool,
    text: []const u8,
    streaming: bool,
    measure_width: u32,
    layout_passes: usize,
    iterations: usize,
    show_mem: bool,
) !BenchResult {
    const steps: usize = 200;

    var stats: BenchStats = .{};
    var final_tb_mem: usize = 0;
    var final_view_mem: usize = 0;

    const token = "token ";
    const newline = "\n";
    const newline_stride: usize = 20;

    for (0..iterations) |i| {
        var tb = try UnifiedTextBuffer.init(allocator, pool, link_pool, .unicode);
        defer tb.deinit();

        try tb.setText(text);

        var view = try UnifiedTextBufferView.init(allocator, tb);
        defer view.deinit();

        view.setWrapMode(.word);

        var token_mem_id: u8 = 0;
        var newline_mem_id: u8 = 0;
        if (streaming) {
            token_mem_id = try tb.registerMemBuffer(token, false);
            newline_mem_id = try tb.registerMemBuffer(newline, false);
        }

        const timer = bench_utils.BenchTimer.start(io);
        for (0..steps) |step| {
            if (streaming) {
                try tb.appendFromMemId(token_mem_id);
                if ((step + 1) % newline_stride == 0) {
                    try tb.appendFromMemId(newline_mem_id);
                }
            }

            // Simulate Yoga's repeated measure calls within a single layout pass.
            for (0..layout_passes) |_| {
                _ = try view.measureForDimensions(measure_width, 24);
            }
        }
        stats.record(timer.read());

        if (i == iterations - 1 and show_mem) {
            final_tb_mem = tb.getArenaAllocatedBytes();
            final_view_mem = view.getArenaAllocatedBytes();
        }
    }

    const mem_stats: ?[]const MemStat = if (show_mem) blk: {
        const mem = try allocator.alloc(MemStat, 2);
        mem[0] = .{ .name = "TB", .bytes = final_tb_mem };
        mem[1] = .{ .name = "View", .bytes = final_view_mem };
        break :blk mem;
    } else null;

    return .{
        .name = "",
        .min_ns = stats.min_ns,
        .avg_ns = stats.avg(),
        .max_ns = stats.max_ns,
        .total_ns = stats.total_ns,
        .iterations = iterations,
        .mem_stats = mem_stats,
    };
}

pub fn run(
    io: std.Io,
    allocator: std.mem.Allocator,
    show_mem: bool,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var pools = TestPools.init(allocator);
    defer pools.deinit();

    var all_results: std.ArrayList(BenchResult) = .empty;
    errdefer all_results.deinit(allocator);

    const iterations: usize = 10;

    // Run setText benchmarks
    const setText_results = try benchSetText(io, allocator, &pools.graphemes, &pools.links, iterations, show_mem, bench_filter);
    try all_results.appendSlice(allocator, setText_results);

    var text_multiline: ?[]u8 = null;
    defer if (text_multiline) |text| allocator.free(text);
    const multiline_stats = computeLargeTextStats(5000, 1 * 1024 * 1024);
    const multiline_mb = @as(f64, @floatFromInt(multiline_stats.bytes)) / (1024.0 * 1024.0);

    // Run measureForDimensions benchmarks
    const layout_passes: usize = 3;
    const wrap_width: u32 = 80;
    const measure_scenarios = [_]struct {
        label: []const u8,
        streaming: bool,
        width: u32,
    }{
        .{ .label = "incremental append wrap", .streaming = true, .width = wrap_width },
        .{ .label = "incremental append intrinsic", .streaming = true, .width = 0 },
        .{ .label = "repeated cached wrap", .streaming = false, .width = wrap_width },
    };

    for (measure_scenarios) |scenario| {
        const bench_name = try std.fmt.allocPrint(
            allocator,
            "TextBufferView measureForDimensions ({s}, {d:.2} MiB initial text)",
            .{ scenario.label, multiline_mb },
        );

        if (!bench_utils.matchesBenchFilter(bench_name, bench_filter)) {
            allocator.free(bench_name);
            continue;
        }

        if (text_multiline == null) {
            text_multiline = try generateLargeText(allocator, 5000, 1 * 1024 * 1024);
        }

        var bench_result = try benchMeasureForDimensionsLayout(
            io,
            allocator,
            &pools.graphemes,
            &pools.links,
            text_multiline.?,
            scenario.streaming,
            scenario.width,
            layout_passes,
            iterations,
            show_mem,
        );
        bench_result.name = bench_name;

        try all_results.append(allocator, bench_result);
    }

    // Test wrapping scenarios
    const scenarios = [_]struct {
        width: u32,
        mode: WrapMode,
        mode_str: []const u8,
        single_line: bool,
    }{
        .{ .width = 40, .mode = .char, .mode_str = "char", .single_line = false },
        .{ .width = 80, .mode = .char, .mode_str = "char", .single_line = false },
        .{ .width = 120, .mode = .char, .mode_str = "char", .single_line = false },
        .{ .width = 40, .mode = .word, .mode_str = "word", .single_line = false },
        .{ .width = 80, .mode = .word, .mode_str = "word", .single_line = false },
        .{ .width = 120, .mode = .word, .mode_str = "word", .single_line = false },
        .{ .width = 40, .mode = .char, .mode_str = "char", .single_line = true },
        .{ .width = 80, .mode = .char, .mode_str = "char", .single_line = true },
        .{ .width = 120, .mode = .char, .mode_str = "char", .single_line = true },
        .{ .width = 40, .mode = .word, .mode_str = "word", .single_line = true },
        .{ .width = 80, .mode = .word, .mode_str = "word", .single_line = true },
        .{ .width = 120, .mode = .word, .mode_str = "word", .single_line = true },
    };

    for (scenarios) |scenario| {
        const bench_name = if (scenario.single_line)
            try std.fmt.allocPrint(allocator, "TextBufferView wrap ({s}, width={d}, validated 62.5 KiB single chunk)", .{
                scenario.mode_str,
                scenario.width,
            })
        else
            try std.fmt.allocPrint(allocator, "TextBufferView wrap ({s}, width={d}, multi-line)", .{
                scenario.mode_str,
                scenario.width,
            });

        if (!bench_utils.matchesBenchFilter(bench_name, bench_filter)) {
            allocator.free(bench_name);
            continue;
        }

        if (!scenario.single_line and text_multiline == null) {
            text_multiline = try generateLargeText(allocator, 5000, 1 * 1024 * 1024);
        }
        const text = if (scenario.single_line) matched_single_chunk_text else text_multiline.?;

        var bench_result = try benchWrap(
            io,
            allocator,
            &pools.graphemes,
            &pools.links,
            text,
            scenario.width,
            scenario.mode,
            iterations,
            show_mem,
            if (scenario.single_line) matched_single_chunk_width else null,
        );
        bench_result.name = bench_name;

        try all_results.append(allocator, bench_result);
    }

    const rewrap_scenarios = [_]struct { name: []const u8, line: []const u8, repeat: usize }{
        .{ .name = "TextBufferView rewrap (word, mixed, 5000 lines)", .line = "OpenTUI text metrics: \u{754c} e\u{301} abcdefghijklmnop wrap words here and there\n", .repeat = 5000 },
        .{ .name = "TextBufferView rewrap (word, ASCII prose, 5000 lines)", .line = "The quick brown fox jumps over the lazy dog, again and again and again.\n", .repeat = 5000 },
        .{ .name = "TextBufferView rewrap (word, CJK, 2000 lines)", .line = "\u{4e16}\u{754c}\u{4f60}\u{597d} \u{30c6}\u{30b9}\u{30c8} hello \u{1f30d} \u{4e2d}\u{6587}\u{6587}\u{672c}\u{6362}\u{884c}\u{6d4b}\u{8bd5}\n", .repeat = 2000 },
        .{ .name = "TextBufferView rewrap (word, one long mixed line)", .line = "alpha \u{754c} e\u{301} beta gamma ", .repeat = 4000 },
    };
    for (rewrap_scenarios) |scenario| {
        if (!bench_utils.matchesBenchFilter(scenario.name, bench_filter)) continue;
        var bench_result = try benchRewrap(io, allocator, &pools.graphemes, &pools.links, scenario.line, scenario.repeat);
        bench_result.name = scenario.name;
        try all_results.append(allocator, bench_result);
    }

    return all_results.toOwnedSlice(allocator);
}
