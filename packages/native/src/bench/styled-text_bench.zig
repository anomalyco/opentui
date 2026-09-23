const std = @import("std");
const TestPools = @import("../tests/test-pools.zig").TestPools;
const ansi = @import("../ansi.zig");
const bench_utils = @import("../bench-utils.zig");
const text_buffer_mod = @import("../text-buffer.zig");
const syntax_style_mod = @import("../syntax-style.zig");
const link = @import("../link.zig");

const BenchResult = bench_utils.BenchResult;
const BenchStats = bench_utils.BenchStats;
const MemStats = bench_utils.MemStats;
const TextBuffer = text_buffer_mod.UnifiedTextBuffer;
const RGBA = text_buffer_mod.RGBA;
const SyntaxStyle = syntax_style_mod.SyntaxStyle;

pub const benchName = "Styled Text Operations";

const Part = struct {
    text: []const u8,
    fg: ?RGBA = null,
    attributes: u32 = 0,
};

fn rgba(r: f32, g: f32, b: f32, a: f32) RGBA {
    return ansi.rgbaFromFloats(r, g, b, a);
}

fn commitOwnedStyledText(
    tb: *TextBuffer,
    allocator: std.mem.Allocator,
    style: *SyntaxStyle,
    parts: []const Part,
) !void {
    var total_len: usize = 0;
    for (parts) |part| total_len += part.text.len;
    const text = try allocator.alloc(u8, total_len);
    errdefer allocator.free(text);
    const ranges = try allocator.alloc(text_buffer_mod.OwnedStyledChunk, parts.len);
    defer allocator.free(ranges);
    var offset: usize = 0;
    for (parts, ranges, 0..) |part, *range, i| {
        @memcpy(text[offset..][0..part.text.len], part.text);
        var name_buf: [16]u8 = undefined;
        const name = std.fmt.bufPrint(&name_buf, "{d}", .{i}) catch unreachable;
        range.* = .{
            .byte_count = @intCast(part.text.len),
            .style_id = try style.registerStyle(name, part.fg, null, part.attributes),
        };
        offset += part.text.len;
    }
    _ = try tb.replaceOwnedStyledText(text, null, style, ranges, null);
}

fn benchSetStyledTextOperations(
    io: std.Io,
    allocator: std.mem.Allocator,
    iterations: usize,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayList(BenchResult) = .empty;
    errdefer results.deinit(allocator);

    // Setup global resources
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const global_alloc = arena.allocator();

    var pools = TestPools.init(global_alloc);
    defer pools.deinit();

    // Tokens and gap chunks grow with the number of lines, as in parsed JSON.
    inline for (.{ 200, 1000, 5000 }) |line_count| {
        const name = std.fmt.comptimePrint("replaceOwnedStyledText - JSON tokens ({d} lines, {d} chunks)", .{ line_count, line_count * 5 });
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            const color = rgba(0.7, 0.9, 1.0, 1.0);
            var parts: [line_count * 5]Part = undefined;
            for (0..line_count) |row| {
                for ([_][]const u8{ "  ", "\"field\"", ": ", "123", ",\n" }, 0..) |text, token| {
                    parts[row * 5 + token] = .{
                        .text = text,
                        .fg = if (token % 2 == 1) color else null,
                        .attributes = if (token == 1) 1 else 0,
                    };
                }
            }
            var stats: BenchStats = .{};
            for (0..5) |_| {
                const tb = try TextBuffer.init(allocator, &pools.graphemes, &pools.links, .wcwidth);
                defer tb.deinit();
                const style = try SyntaxStyle.init(allocator);
                defer style.deinit();
                const timer = bench_utils.BenchTimer.start(io);
                try commitOwnedStyledText(tb, allocator, style, &parts);
                stats.record(timer.read());
                if (tb.getHighlightCount() != parts.len or style.getStyleCount() != parts.len)
                    return error.MissingTokenHighlights;
            }
            try results.append(allocator, .{
                .name = name,
                .min_ns = stats.min_ns,
                .avg_ns = stats.avg(),
                .max_ns = stats.max_ns,
                .total_ns = stats.total_ns,
                .iterations = 5,
                .mem_stats = null,
            });
        }
    }

    // Single chunk - baseline
    {
        const name = "replaceOwnedStyledText - single chunk (55 chars)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};

            const text = "Hello, World! This is a test of styled text rendering.";
            const fg_color = rgba(1.0, 1.0, 1.0, 1.0);

            for (0..iterations) |_| {
                const tb = try TextBuffer.init(allocator, &pools.graphemes, &pools.links, .wcwidth);
                defer tb.deinit();

                const style = try SyntaxStyle.init(allocator);
                defer style.deinit();
                const parts = [_]Part{.{ .text = text, .fg = fg_color }};

                const timer = bench_utils.BenchTimer.start(io);
                try commitOwnedStyledText(tb, allocator, style, &parts);
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

    // Multiple small chunks
    {
        const name = "replaceOwnedStyledText - 6 small chunks (~6 chars each)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};

            const red = rgba(1.0, 0.0, 0.0, 1.0);
            const green = rgba(0.0, 1.0, 0.0, 1.0);
            const blue = rgba(0.0, 0.0, 1.0, 1.0);
            const yellow = rgba(1.0, 1.0, 0.0, 1.0);
            const cyan = rgba(0.0, 1.0, 1.0, 1.0);
            const magenta = rgba(1.0, 0.0, 1.0, 1.0);

            for (0..iterations) |_| {
                const tb = try TextBuffer.init(allocator, &pools.graphemes, &pools.links, .wcwidth);
                defer tb.deinit();

                const style = try SyntaxStyle.init(allocator);
                defer style.deinit();
                const parts = [_]Part{
                    .{ .text = "Red ", .fg = red },
                    .{ .text = "Green ", .fg = green },
                    .{ .text = "Blue ", .fg = blue },
                    .{ .text = "Yellow ", .fg = yellow },
                    .{ .text = "Cyan ", .fg = cyan },
                    .{ .text = "Magenta ", .fg = magenta },
                };

                const timer = bench_utils.BenchTimer.start(io);
                try commitOwnedStyledText(tb, allocator, style, &parts);
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

    // Many chunks (simulating syntax highlighted code)
    {
        const name = "replaceOwnedStyledText - 8 chunks (syntax highlighting)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};

            const keyword_color = rgba(0.8, 0.4, 1.0, 1.0);
            const identifier_color = rgba(0.7, 0.9, 1.0, 1.0);
            const operator_color = rgba(1.0, 1.0, 1.0, 1.0);
            const number_color = rgba(0.7, 1.0, 0.7, 1.0);

            for (0..iterations) |_| {
                const tb = try TextBuffer.init(allocator, &pools.graphemes, &pools.links, .wcwidth);
                defer tb.deinit();

                const style = try SyntaxStyle.init(allocator);
                defer style.deinit();
                const parts = [_]Part{
                    .{ .text = "const", .fg = keyword_color },
                    .{ .text = " " },
                    .{ .text = "x", .fg = identifier_color },
                    .{ .text = " " },
                    .{ .text = "=", .fg = operator_color },
                    .{ .text = " " },
                    .{ .text = "42", .fg = number_color },
                    .{ .text = ";", .fg = operator_color },
                };

                const timer = bench_utils.BenchTimer.start(io);
                try commitOwnedStyledText(tb, allocator, style, &parts);
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

    // Large text with many chunks (simplified)
    {
        const name = "replaceOwnedStyledText - 10 chunks (~120 chars total)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};

            const text = "Lorem ipsum ";
            const color = rgba(1.0, 0.5, 0.5, 1.0);

            for (0..iterations) |_| {
                const tb = try TextBuffer.init(allocator, &pools.graphemes, &pools.links, .wcwidth);
                defer tb.deinit();

                const style = try SyntaxStyle.init(allocator);
                defer style.deinit();
                const parts = [_]Part{.{ .text = text, .fg = color }} ** 10;

                const timer = bench_utils.BenchTimer.start(io);
                try commitOwnedStyledText(tb, allocator, style, &parts);
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

    // Chunks with attributes (bold, italic, etc.)
    {
        const name = "replaceOwnedStyledText - 5 chunks with attributes";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};

            for (0..iterations) |_| {
                const tb = try TextBuffer.init(allocator, &pools.graphemes, &pools.links, .wcwidth);
                defer tb.deinit();

                const style = try SyntaxStyle.init(allocator);
                defer style.deinit();
                const parts = [_]Part{
                    .{ .text = "Normal " },
                    .{ .text = "Bold ", .attributes = 1 },
                    .{ .text = "Italic ", .attributes = 2 },
                    .{ .text = "Underline ", .attributes = 4 },
                    .{ .text = "Bold+Italic ", .attributes = 3 },
                };

                const timer = bench_utils.BenchTimer.start(io);
                try commitOwnedStyledText(tb, allocator, style, &parts);
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

fn benchHighlightOperations(
    io: std.Io,
    allocator: std.mem.Allocator,
    iterations: usize,
    bench_filter: ?[]const u8,
) ![]BenchResult {
    var results: std.ArrayList(BenchResult) = .empty;
    errdefer results.deinit(allocator);

    // Setup global resources
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const global_alloc = arena.allocator();

    var pools = TestPools.init(global_alloc);
    defer pools.deinit();

    // Baseline: 1000 sequential addHighlightByCharRange calls (unbatched)
    {
        const name = "addHighlightByCharRange - 1000 calls (unbatched)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};

            for (0..iterations) |_| {
                const tb = try TextBuffer.init(allocator, &pools.graphemes, &pools.links, .wcwidth);
                defer tb.deinit();

                const style = try SyntaxStyle.init(allocator);
                defer style.deinit();
                tb.setSyntaxStyle(style);

                // Create a multi-line buffer
                const text = "Line 1 with some text\nLine 2 with more text\nLine 3 here\nLine 4 content\nLine 5 final";
                try tb.setText(text);

                const timer = bench_utils.BenchTimer.start(io);

                // Add 1000 highlights sequentially
                for (0..1000) |i| {
                    const start_char: u32 = @intCast((i * 2) % 50);
                    const end_char = start_char + 3;
                    const style_id: u32 = @intCast((i % 5) + 1);
                    tb.addHighlightByCharRange(start_char, end_char, style_id, 1, 0) catch {};
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

    // Batched: 1000 sequential addHighlightByCharRange calls in a transaction
    {
        const name = "addHighlightByCharRange - 1000 calls (batched)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};

            for (0..iterations) |_| {
                const tb = try TextBuffer.init(allocator, &pools.graphemes, &pools.links, .wcwidth);
                defer tb.deinit();

                const style = try SyntaxStyle.init(allocator);
                defer style.deinit();
                tb.setSyntaxStyle(style);

                // Create a multi-line buffer
                const text = "Line 1 with some text\nLine 2 with more text\nLine 3 here\nLine 4 content\nLine 5 final";
                try tb.setText(text);

                const timer = bench_utils.BenchTimer.start(io);

                // Batch all highlights in a transaction
                tb.startHighlightsTransaction();
                defer tb.endHighlightsTransaction();

                // Add 1000 highlights sequentially
                for (0..1000) |i| {
                    const start_char: u32 = @intCast((i * 2) % 50);
                    const end_char = start_char + 3;
                    const style_id: u32 = @intCast((i % 5) + 1);
                    tb.addHighlightByCharRange(start_char, end_char, style_id, 1, 0) catch {};
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

    // replaceOwnedStyledText with 100 chunks (realistic syntax highlighting scenario)
    {
        const name = "replaceOwnedStyledText - 100 chunks (realistic code)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};

            var parts: std.ArrayList(Part) = .empty;
            defer parts.deinit(allocator);

            const keyword_color = rgba(0.8, 0.4, 1.0, 1.0);
            const identifier_color = rgba(0.7, 0.9, 1.0, 1.0);
            const operator_color = rgba(1.0, 1.0, 1.0, 1.0);
            const number_color = rgba(0.7, 1.0, 0.7, 1.0);
            const string_color = rgba(0.9, 0.8, 0.5, 1.0);

            for (0..10) |_| {
                try parts.append(allocator, .{ .text = "const", .fg = keyword_color });
                try parts.append(allocator, .{ .text = " " });
                try parts.append(allocator, .{ .text = "myVar", .fg = identifier_color });
                try parts.append(allocator, .{ .text = " " });
                try parts.append(allocator, .{ .text = "=", .fg = operator_color });
                try parts.append(allocator, .{ .text = " " });
                try parts.append(allocator, .{ .text = "42", .fg = number_color });
                try parts.append(allocator, .{ .text = ";", .fg = operator_color });
                try parts.append(allocator, .{ .text = "\n" });
                try parts.append(allocator, .{ .text = "\"str\"", .fg = string_color });
            }

            for (0..iterations) |_| {
                const tb = try TextBuffer.init(allocator, &pools.graphemes, &pools.links, .wcwidth);
                defer tb.deinit();

                const style = try SyntaxStyle.init(allocator);
                defer style.deinit();

                const timer = bench_utils.BenchTimer.start(io);
                try commitOwnedStyledText(tb, allocator, style, parts.items);
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
    _ = show_mem;

    var all_results: std.ArrayList(BenchResult) = .empty;
    errdefer all_results.deinit(allocator);

    const iterations: usize = 100;

    const styled_text_results = try benchSetStyledTextOperations(io, allocator, iterations, bench_filter);
    try all_results.appendSlice(allocator, styled_text_results);

    const highlight_results = try benchHighlightOperations(io, allocator, iterations, bench_filter);
    try all_results.appendSlice(allocator, highlight_results);

    return all_results.toOwnedSlice(allocator);
}
