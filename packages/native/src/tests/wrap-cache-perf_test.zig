const std = @import("std");
const text_buffer = @import("../text-buffer.zig");
const text_buffer_view = @import("../text-buffer-view.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");

const TextBuffer = text_buffer.UnifiedTextBuffer;
const TextBufferView = text_buffer_view.UnifiedTextBufferView;

test "word wrap complexity - width changes are O(n)" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    const size: usize = 100_000;

    const text = try std.testing.allocator.alloc(u8, size);
    defer std.testing.allocator.free(text);
    @memset(text, 'x');

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();
    try tb.setText(text);

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();
    view.setWrapMode(.word);

    const widths = [_]u32{ 60, 70, 80, 90, 100 };

    // Run multiple iterations and use median to reduce noise from CI variability
    const iterations = 5;
    var median_times: [widths.len]u64 = undefined;

    for (widths, 0..) |width, width_idx| {
        var iter_times: [iterations]u64 = undefined;

        for (0..iterations) |iter| {
            // Reset cache by setting a different width first
            view.setWrapWidth(50);
            _ = view.getVirtualLineCount();

            view.setWrapWidth(width);
            const start = std.Io.Clock.awake.now(std.testing.io);
            _ = view.getVirtualLineCount();
            iter_times[iter] = @intCast(start.untilNow(std.testing.io, .awake).toNanoseconds());
        }

        // Sort and take median
        std.mem.sort(u64, &iter_times, {}, std.sort.asc(u64));
        median_times[width_idx] = iter_times[iterations / 2];
    }

    var min_time: u64 = std.math.maxInt(u64);
    var max_time: u64 = 0;
    for (median_times) |t| {
        min_time = @min(min_time, t);
        max_time = @max(max_time, t);
    }

    const ratio = @as(f64, @floatFromInt(max_time)) / @as(f64, @floatFromInt(min_time));

    // All times should be roughly similar since text size is constant.
    // Use a generous threshold (5x) to account for CI runner variability.
    try std.testing.expect(ratio < 5.0);
}

test "word wrap - virtual line count correctness" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    const pattern = "var abc=123;function foo(){return bar+baz;}if(x>0){y=z*2;}else{y=0;}";
    const size = 10_000;
    var text = try std.testing.allocator.alloc(u8, size);
    defer std.testing.allocator.free(text);

    var i: usize = 0;
    while (i < size) {
        const remaining = size - i;
        const copy_len = @min(pattern.len, remaining);
        @memcpy(text[i .. i + copy_len], pattern[0..copy_len]);
        i += copy_len;
    }

    try tb.setText(text);
    view.setWrapMode(.word);

    view.setWrapWidth(80);
    const count_80 = view.getVirtualLineCount();

    view.setWrapWidth(100);
    const count_100 = view.getVirtualLineCount();

    view.setWrapWidth(60);
    const count_60 = view.getVirtualLineCount();

    view.setWrapWidth(80);
    const count_80_again = view.getVirtualLineCount();

    try std.testing.expect(count_80 > 100);
    try std.testing.expectEqual(count_80, count_80_again);
    try std.testing.expect(count_100 < count_80);
    try std.testing.expect(count_60 > count_80);
}
