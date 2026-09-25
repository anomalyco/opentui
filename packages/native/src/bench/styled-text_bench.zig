const std = @import("std");
const ansi = @import("../ansi.zig");
const bench_utils = @import("../bench-utils.zig");
const text_buffer_mod = @import("../text-buffer.zig");
const syntax_style_mod = @import("../syntax-style.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");

const BenchResult = bench_utils.BenchResult;
const BenchStats = bench_utils.BenchStats;
const MemStats = bench_utils.MemStats;
const TextBuffer = text_buffer_mod.UnifiedTextBuffer;
const RGBA = text_buffer_mod.RGBA;
const StyledChunk = text_buffer_mod.StyledChunk; // Use the unified type from text-buffer
const SyntaxStyle = syntax_style_mod.SyntaxStyle;

pub const benchName = "Styled Text Operations";

// Helper to convert RGBA to pointer for benchmark
fn rgbaToPtr(color: *const RGBA) [*]const u16 {
    return @as([*]const u16, @ptrCast(color));
}

fn rgba(r: f32, g: f32, b: f32, a: f32) RGBA {
    return ansi.rgbaFromFloats(r, g, b, a);
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

    const pool = gp.initGlobalPool(global_alloc);
    const link_pool = link.initGlobalLinkPool(global_alloc);

    // Tokens and gap chunks grow with the number of lines, as in parsed JSON.
    inline for (.{ 200, 1000, 5000 }) |line_count| {
        const name = std.fmt.comptimePrint("setStyledText - JSON tokens ({d} lines, {d} chunks)", .{ line_count, line_count * 5 });
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            const color = rgba(0.7, 0.9, 1.0, 1.0);
            const chunks = try allocator.alloc(StyledChunk, line_count * 5);
            defer allocator.free(chunks);
            for (0..line_count) |row| {
                for ([_][]const u8{ "  ", "\"field\"", ": ", "123", ",\n" }, 0..) |text, token| {
                    chunks[row * 5 + token] = .{
                        .text_ptr = text.ptr,
                        .text_len = text.len,
                        .fg_ptr = if (token % 2 == 1) rgbaToPtr(&color) else null,
                        .bg_ptr = null,
                        .attributes = if (token == 1) 1 else 0,
                    };
                }
            }
            var stats: BenchStats = .{};
            for (0..5) |_| {
                const tb = try TextBuffer.init(allocator, pool, link_pool, .wcwidth);
                defer tb.deinit();
                const style = try SyntaxStyle.init(allocator);
                defer style.deinit();
                tb.setSyntaxStyle(style);
                const timer = bench_utils.BenchTimer.start(io);
                try tb.setStyledText(chunks);
                stats.record(timer.read());
                if (tb.getHighlightCount() != chunks.len or style.getStyleCount() != chunks.len)
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
        const name = "setStyledText - single chunk (55 chars)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};

            const text = "Hello, World! This is a test of styled text rendering.";
            const fg_color = rgba(1.0, 1.0, 1.0, 1.0);

            for (0..iterations) |_| {
                const tb = try TextBuffer.init(allocator, pool, link_pool, .wcwidth);
                defer tb.deinit();

                const style = try SyntaxStyle.init(allocator);
                defer style.deinit();
                tb.setSyntaxStyle(style);

                const chunks = [_]StyledChunk{.{
                    .text_ptr = text.ptr,
                    .text_len = text.len,
                    .fg_ptr = rgbaToPtr(&fg_color),
                    .bg_ptr = null,
                    .attributes = 0,
                }};

                const timer = bench_utils.BenchTimer.start(io);
                try tb.setStyledText(&chunks);
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
        const name = "setStyledText - 6 small chunks (~6 chars each)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};

            const red = rgba(1.0, 0.0, 0.0, 1.0);
            const green = rgba(0.0, 1.0, 0.0, 1.0);
            const blue = rgba(0.0, 0.0, 1.0, 1.0);
            const yellow = rgba(1.0, 1.0, 0.0, 1.0);
            const cyan = rgba(0.0, 1.0, 1.0, 1.0);
            const magenta = rgba(1.0, 0.0, 1.0, 1.0);

            for (0..iterations) |_| {
                const tb = try TextBuffer.init(allocator, pool, link_pool, .wcwidth);
                defer tb.deinit();

                const style = try SyntaxStyle.init(allocator);
                defer style.deinit();
                tb.setSyntaxStyle(style);

                const text0 = "Red ";
                const text1 = "Green ";
                const text2 = "Blue ";
                const text3 = "Yellow ";
                const text4 = "Cyan ";
                const text5 = "Magenta ";

                const chunks = [_]StyledChunk{
                    .{ .text_ptr = text0.ptr, .text_len = text0.len, .fg_ptr = rgbaToPtr(&red), .bg_ptr = null, .attributes = 0 },
                    .{ .text_ptr = text1.ptr, .text_len = text1.len, .fg_ptr = rgbaToPtr(&green), .bg_ptr = null, .attributes = 0 },
                    .{ .text_ptr = text2.ptr, .text_len = text2.len, .fg_ptr = rgbaToPtr(&blue), .bg_ptr = null, .attributes = 0 },
                    .{ .text_ptr = text3.ptr, .text_len = text3.len, .fg_ptr = rgbaToPtr(&yellow), .bg_ptr = null, .attributes = 0 },
                    .{ .text_ptr = text4.ptr, .text_len = text4.len, .fg_ptr = rgbaToPtr(&cyan), .bg_ptr = null, .attributes = 0 },
                    .{ .text_ptr = text5.ptr, .text_len = text5.len, .fg_ptr = rgbaToPtr(&magenta), .bg_ptr = null, .attributes = 0 },
                };

                const timer = bench_utils.BenchTimer.start(io);
                try tb.setStyledText(&chunks);
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
        const name = "setStyledText - 8 chunks (syntax highlighting)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};

            const keyword_color = rgba(0.8, 0.4, 1.0, 1.0);
            const identifier_color = rgba(0.7, 0.9, 1.0, 1.0);
            const operator_color = rgba(1.0, 1.0, 1.0, 1.0);
            const number_color = rgba(0.7, 1.0, 0.7, 1.0);

            for (0..iterations) |_| {
                const tb = try TextBuffer.init(allocator, pool, link_pool, .wcwidth);
                defer tb.deinit();

                const style = try SyntaxStyle.init(allocator);
                defer style.deinit();
                tb.setSyntaxStyle(style);

                // Simulate a line of syntax highlighted code: "const x = 42;"
                const t0 = "const";
                const t1 = " ";
                const t2 = "x";
                const t3 = " ";
                const t4 = "=";
                const t5 = " ";
                const t6 = "42";
                const t7 = ";";

                const chunks = [_]StyledChunk{
                    .{ .text_ptr = t0.ptr, .text_len = t0.len, .fg_ptr = rgbaToPtr(&keyword_color), .bg_ptr = null, .attributes = 0 },
                    .{ .text_ptr = t1.ptr, .text_len = t1.len, .fg_ptr = null, .bg_ptr = null, .attributes = 0 },
                    .{ .text_ptr = t2.ptr, .text_len = t2.len, .fg_ptr = rgbaToPtr(&identifier_color), .bg_ptr = null, .attributes = 0 },
                    .{ .text_ptr = t3.ptr, .text_len = t3.len, .fg_ptr = null, .bg_ptr = null, .attributes = 0 },
                    .{ .text_ptr = t4.ptr, .text_len = t4.len, .fg_ptr = rgbaToPtr(&operator_color), .bg_ptr = null, .attributes = 0 },
                    .{ .text_ptr = t5.ptr, .text_len = t5.len, .fg_ptr = null, .bg_ptr = null, .attributes = 0 },
                    .{ .text_ptr = t6.ptr, .text_len = t6.len, .fg_ptr = rgbaToPtr(&number_color), .bg_ptr = null, .attributes = 0 },
                    .{ .text_ptr = t7.ptr, .text_len = t7.len, .fg_ptr = rgbaToPtr(&operator_color), .bg_ptr = null, .attributes = 0 },
                };

                const timer = bench_utils.BenchTimer.start(io);
                try tb.setStyledText(&chunks);
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
        const name = "setStyledText - 10 chunks (~120 chars total)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};

            const text = "Lorem ipsum ";

            for (0..iterations) |_| {
                const tb = try TextBuffer.init(allocator, pool, link_pool, .wcwidth);
                defer tb.deinit();

                const style = try SyntaxStyle.init(allocator);
                defer style.deinit();
                tb.setSyntaxStyle(style);

                // Just repeat the same chunk 10 times
                const color = rgba(1.0, 0.5, 0.5, 1.0);
                const chunks = [_]StyledChunk{
                    .{ .text_ptr = text.ptr, .text_len = text.len, .fg_ptr = rgbaToPtr(&color), .bg_ptr = null, .attributes = 0 },
                    .{ .text_ptr = text.ptr, .text_len = text.len, .fg_ptr = rgbaToPtr(&color), .bg_ptr = null, .attributes = 0 },
                    .{ .text_ptr = text.ptr, .text_len = text.len, .fg_ptr = rgbaToPtr(&color), .bg_ptr = null, .attributes = 0 },
                    .{ .text_ptr = text.ptr, .text_len = text.len, .fg_ptr = rgbaToPtr(&color), .bg_ptr = null, .attributes = 0 },
                    .{ .text_ptr = text.ptr, .text_len = text.len, .fg_ptr = rgbaToPtr(&color), .bg_ptr = null, .attributes = 0 },
                    .{ .text_ptr = text.ptr, .text_len = text.len, .fg_ptr = rgbaToPtr(&color), .bg_ptr = null, .attributes = 0 },
                    .{ .text_ptr = text.ptr, .text_len = text.len, .fg_ptr = rgbaToPtr(&color), .bg_ptr = null, .attributes = 0 },
                    .{ .text_ptr = text.ptr, .text_len = text.len, .fg_ptr = rgbaToPtr(&color), .bg_ptr = null, .attributes = 0 },
                    .{ .text_ptr = text.ptr, .text_len = text.len, .fg_ptr = rgbaToPtr(&color), .bg_ptr = null, .attributes = 0 },
                    .{ .text_ptr = text.ptr, .text_len = text.len, .fg_ptr = rgbaToPtr(&color), .bg_ptr = null, .attributes = 0 },
                };

                const timer = bench_utils.BenchTimer.start(io);
                try tb.setStyledText(&chunks);
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
        const name = "setStyledText - 5 chunks with attributes";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};

            for (0..iterations) |_| {
                const tb = try TextBuffer.init(allocator, pool, link_pool, .wcwidth);
                defer tb.deinit();

                const style = try SyntaxStyle.init(allocator);
                defer style.deinit();
                tb.setSyntaxStyle(style);

                const t0 = "Normal ";
                const t1 = "Bold ";
                const t2 = "Italic ";
                const t3 = "Underline ";
                const t4 = "Bold+Italic ";

                const chunks = [_]StyledChunk{
                    .{ .text_ptr = t0.ptr, .text_len = t0.len, .fg_ptr = null, .bg_ptr = null, .attributes = 0 },
                    .{ .text_ptr = t1.ptr, .text_len = t1.len, .fg_ptr = null, .bg_ptr = null, .attributes = 1 },
                    .{ .text_ptr = t2.ptr, .text_len = t2.len, .fg_ptr = null, .bg_ptr = null, .attributes = 2 },
                    .{ .text_ptr = t3.ptr, .text_len = t3.len, .fg_ptr = null, .bg_ptr = null, .attributes = 4 },
                    .{ .text_ptr = t4.ptr, .text_len = t4.len, .fg_ptr = null, .bg_ptr = null, .attributes = 3 },
                };

                const timer = bench_utils.BenchTimer.start(io);
                try tb.setStyledText(&chunks);
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

    const pool = gp.initGlobalPool(global_alloc);
    const link_pool = link.initGlobalLinkPool(global_alloc);

    // Baseline: 1000 sequential addHighlightByCharRange calls (unbatched)
    {
        const name = "addHighlightByCharRange - 1000 calls (unbatched)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};

            for (0..iterations) |_| {
                const tb = try TextBuffer.init(allocator, pool, link_pool, .wcwidth);
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
                const tb = try TextBuffer.init(allocator, pool, link_pool, .wcwidth);
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

    // setStyledText with 100 chunks (realistic syntax highlighting scenario)
    {
        const name = "setStyledText - 100 chunks (realistic code)";
        if (bench_utils.matchesBenchFilter(name, bench_filter)) {
            var stats: BenchStats = .{};

            // Build a realistic multi-line code snippet with 100 chunks
            var chunk_list: std.ArrayList(StyledChunk) = .empty;
            defer chunk_list.deinit(allocator);

            const keyword_color = rgba(0.8, 0.4, 1.0, 1.0);
            const identifier_color = rgba(0.7, 0.9, 1.0, 1.0);
            const operator_color = rgba(1.0, 1.0, 1.0, 1.0);
            const number_color = rgba(0.7, 1.0, 0.7, 1.0);
            const string_color = rgba(0.9, 0.8, 0.5, 1.0);

            // Repeat a pattern to create 100 chunks
            for (0..10) |_| {
                try chunk_list.append(allocator, .{ .text_ptr = "const".ptr, .text_len = 5, .fg_ptr = rgbaToPtr(&keyword_color), .bg_ptr = null, .attributes = 0 });
                try chunk_list.append(allocator, .{ .text_ptr = " ".ptr, .text_len = 1, .fg_ptr = null, .bg_ptr = null, .attributes = 0 });
                try chunk_list.append(allocator, .{ .text_ptr = "myVar".ptr, .text_len = 5, .fg_ptr = rgbaToPtr(&identifier_color), .bg_ptr = null, .attributes = 0 });
                try chunk_list.append(allocator, .{ .text_ptr = " ".ptr, .text_len = 1, .fg_ptr = null, .bg_ptr = null, .attributes = 0 });
                try chunk_list.append(allocator, .{ .text_ptr = "=".ptr, .text_len = 1, .fg_ptr = rgbaToPtr(&operator_color), .bg_ptr = null, .attributes = 0 });
                try chunk_list.append(allocator, .{ .text_ptr = " ".ptr, .text_len = 1, .fg_ptr = null, .bg_ptr = null, .attributes = 0 });
                try chunk_list.append(allocator, .{ .text_ptr = "42".ptr, .text_len = 2, .fg_ptr = rgbaToPtr(&number_color), .bg_ptr = null, .attributes = 0 });
                try chunk_list.append(allocator, .{ .text_ptr = ";".ptr, .text_len = 1, .fg_ptr = rgbaToPtr(&operator_color), .bg_ptr = null, .attributes = 0 });
                try chunk_list.append(allocator, .{ .text_ptr = "\n".ptr, .text_len = 1, .fg_ptr = null, .bg_ptr = null, .attributes = 0 });
                try chunk_list.append(allocator, .{ .text_ptr = "\"str\"".ptr, .text_len = 5, .fg_ptr = rgbaToPtr(&string_color), .bg_ptr = null, .attributes = 0 });
            }

            for (0..iterations) |_| {
                const tb = try TextBuffer.init(allocator, pool, link_pool, .wcwidth);
                defer tb.deinit();

                const style = try SyntaxStyle.init(allocator);
                defer style.deinit();
                tb.setSyntaxStyle(style);

                const timer = bench_utils.BenchTimer.start(io);
                try tb.setStyledText(chunk_list.items);
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
