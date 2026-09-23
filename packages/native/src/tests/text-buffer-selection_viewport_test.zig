const std = @import("std");
const TestPools = @import("test-pools.zig").TestPools;
const text_buffer = @import("../text-buffer.zig");
const text_buffer_view = @import("../text-buffer-view.zig");
const ansi = @import("../ansi.zig");

const TextBuffer = text_buffer.TextBuffer;
const TextBufferView = text_buffer_view.TextBufferView;
const Viewport = text_buffer_view.Viewport;

const lines_0_to_9 = "Line0\nLine1\nLine2\nLine3\nLine4\nLine5\nLine6\nLine7\nLine8\nLine9";
const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const short_lines = "AAA\nBBB\nCCC\nDDD\nEEE\nFFF\nGGG\nHHH";

// Local selections are viewport-relative and use cell occupancy by default, so the focus cell
// is selected too. Character wrapping ignores the viewport's horizontal offset.
test "Selection - local selection coordinates follow the viewport" {
    const cases = [_]struct {
        text: []const u8,
        wrap_width: ?u32 = null,
        viewport: ?Viewport,
        anchor: [2]i32,
        focus: [2]i32,
        selected: []const u8,
        range: [2]u32,
    }{
        .{ .text = lines_0_to_9, .viewport = .{ .x = 0, .y = 5, .width = 10, .height = 5 }, .anchor = .{ 0, 0 }, .focus = .{ 2, 2 }, .selected = "Line5\nLine6\nLin", .range = .{ 30, 45 } },
        .{ .text = lines_0_to_9, .viewport = .{ .x = 0, .y = 5, .width = 10, .height = 5 }, .anchor = .{ 0, 0 }, .focus = .{ 5, 0 }, .selected = "Line5", .range = .{ 30, 35 } },
        .{ .text = letters ++ "0123456789", .viewport = .{ .x = 10, .y = 0, .width = 10, .height = 1 }, .anchor = .{ 0, 0 }, .focus = .{ 5, 0 }, .selected = "KLMNOP", .range = .{ 10, 16 } },
        .{ .text = letters, .wrap_width = 10, .viewport = .{ .x = 10, .y = 0, .width = 10, .height = 3 }, .anchor = .{ 0, 0 }, .focus = .{ 5, 0 }, .selected = "ABCDEF", .range = .{ 0, 6 } },
        .{ .text = letters ++ "0123456789", .wrap_width = 10, .viewport = .{ .x = 0, .y = 1, .width = 10, .height = 2 }, .anchor = .{ 0, 0 }, .focus = .{ 5, 1 }, .selected = "KLMNOPQRSTUVWXYZ", .range = .{ 10, 26 } },
        .{ .text = "Line0\n\nLine2\nLine3\nLine4", .viewport = .{ .x = 0, .y = 1, .width = 10, .height = 3 }, .anchor = .{ 0, 0 }, .focus = .{ 3, 2 }, .selected = "\nLine2\nLine", .range = .{ 6, 17 } },
        .{ .text = short_lines, .viewport = .{ .x = 0, .y = 2, .width = 10, .height = 4 }, .anchor = .{ 0, 0 }, .focus = .{ 3, 0 }, .selected = "CCC", .range = .{ 8, 11 } },
        .{ .text = short_lines, .viewport = .{ .x = 0, .y = 3, .width = 10, .height = 5 }, .anchor = .{ 0, 0 }, .focus = .{ 3, 2 }, .selected = "DDD\nEEE\nFFF", .range = .{ 12, 23 } },
        .{ .text = letters ++ "\n0123456789" ++ letters[0..16] ++ "\n", .viewport = .{ .x = 5, .y = 1, .width = 10, .height = 2 }, .anchor = .{ 0, 0 }, .focus = .{ 5, 0 }, .selected = "56789A", .range = .{ 32, 38 } },
        .{ .text = "Hello World", .viewport = .{ .x = 0, .y = 0, .width = 20, .height = 5 }, .anchor = .{ 2, 0 }, .focus = .{ 7, 0 }, .selected = "llo Wo", .range = .{ 2, 8 } },
        .{ .text = "Hello World", .viewport = null, .anchor = .{ 2, 0 }, .focus = .{ 7, 0 }, .selected = "llo Wo", .range = .{ 2, 8 } },
    };
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    for (cases) |case| {
        var tb = try TextBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode);
        defer tb.deinit();
        var view = try TextBufferView.init(std.testing.allocator, tb);
        defer view.deinit();
        try tb.setText(case.text);
        if (case.wrap_width) |width| {
            view.setWrapMode(.char);
            view.setWrapWidth(width);
        }
        view.setViewport(case.viewport);
        _ = view.setLocalSelection(case.anchor[0], case.anchor[1], case.focus[0], case.focus[1], null, null);

        var buffer: [100]u8 = undefined;
        errdefer std.debug.print("case \"{f}\" anchor {any} focus {any}\n", .{ std.zig.fmtString(case.text), case.anchor, case.focus });
        try std.testing.expectEqualStrings(case.selected, buffer[0..view.getSelectedTextIntoBuffer(&buffer)]);
        const selection = view.getSelection().?;
        try std.testing.expectEqual(case.range, [2]u32{ selection.start, selection.end });
    }
}

test "Selection - selection highlights the scrolled viewport cells" {
    const buffer_mod = @import("../buffer.zig");

    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    var tb = try TextBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode);
    defer tb.deinit();
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();
    try tb.setText(short_lines);
    view.setViewport(.{ .x = 0, .y = 3, .width = 10, .height = 5 });
    _ = view.setLocalSelection(0, 0, 3, 0, ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0), null);

    var render_buffer = try buffer_mod.OptimizedBuffer.init(std.testing.allocator, 20, 10, .{ .link_pool = &pools.links, .pool = &pools.graphemes, .width_method = .unicode });
    defer render_buffer.deinit();
    render_buffer.drawTextBuffer(view, 0, 0);

    // "DDD" is selected; the newline after it is not drawn as a cell.
    for (0..4) |x| {
        const bg = render_buffer.get(@intCast(x), 0).?.bg;
        const selected = x < 3;
        try std.testing.expectEqual(selected, ansi.red(bg) == 255 and ansi.green(bg) == 0 and ansi.blue(bg) == 0);
    }
}
