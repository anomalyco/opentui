const std = @import("std");

const native_renderable = @import("../native-renderable.zig");
const yoga = @import("../yoga.zig");
const edit_buffer = @import("../edit-buffer.zig");
const editor_view = @import("../editor-view.zig");
const grapheme = @import("../grapheme.zig");
const link = @import("../link.zig");

// Width, mode, normalized width, cells; a width within Yoga's 1e-4 below a cell is that cell.
test "NativeRenderable measure inputs match previous TypeScript rules and Yoga's tolerance" {
    for ([_]struct { f32, yoga.YogaMeasureMode, f32, u32 }{
        .{ 42, .undefined, 0, 0 },            .{ std.math.nan(f32), .exactly, 0, 0 },                 .{ 42, .exactly, 42, 42 },                       .{ 42, .at_most, 42, 42 },
        .{ 2.999999, .at_most, 2.999999, 3 }, .{ 2.9999, .at_most, 2.9999, 3 },                       .{ 2.99989, .at_most, 2.99989, 2 },              .{ 0.00009, .at_most, 0.00009, 0 },
        .{ -0.00005, .exactly, -0.00005, 0 }, .{ std.math.inf(f32), .exactly, std.math.inf(f32), 0 }, .{ 1e10, .exactly, 1e10, std.math.maxInt(u32) }, .{ 1.9999, .at_most, 1.9999, 1 },
    }) |row| {
        const width = native_renderable.normalizeYogaMeasureWidthInput(row[0], @backingInt(row[1]));
        try std.testing.expectEqual(row[2], width);
        try std.testing.expectEqual(row[3], native_renderable.measureCells(width));
    }
    try std.testing.expectEqual(@as(f32, 1), native_renderable.normalizeYogaMeasureHeightInput(std.math.nan(f32)));
    try std.testing.expectEqual(@as(f32, 24), native_renderable.normalizeYogaMeasureHeightInput(24));
}

test "NativeRenderable target destruction unlinks only its current borrowers without handles" {
    var graphemes = grapheme.GraphemePool.init(std.testing.allocator);
    defer graphemes.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const buffer = try edit_buffer.EditBuffer.init(std.testing.allocator, &graphemes, &links, .unicode, null);
    defer buffer.deinit();

    for ([_]bool{ false, true }) |use_editor| {
        var first = try native_renderable.NativeRenderable.init();
        defer first.deinit();
        var second = try native_renderable.NativeRenderable.init();
        defer second.deinit();
        var third = try native_renderable.NativeRenderable.init();
        defer third.deinit();
        const replacement = try editor_view.EditorView.init(std.testing.allocator, buffer, 10, 4);
        defer replacement.deinit();
        const next: native_renderable.MeasureTarget = if (use_editor)
            .{ .text_buffer_view = replacement.getTextBufferView() }
        else
            .{ .editor_view = replacement };

        {
            const view = try editor_view.EditorView.init(std.testing.allocator, buffer, 10, 4);
            defer view.deinit();
            const target: native_renderable.MeasureTarget = if (use_editor)
                .{ .editor_view = view }
            else
                .{ .text_buffer_view = view.getTextBufferView() };
            try first.setMeasureTarget(target);
            try second.setMeasureTarget(target);
            try third.setMeasureTarget(target);
            try second.setMeasureTarget(next);
            try first.setMeasureTarget(target);

            var temporary = try native_renderable.NativeRenderable.init();
            defer temporary.deinit();
            try temporary.setMeasureTarget(target);
        }

        try std.testing.expect(first.measure_target == .none);
        try std.testing.expect(third.measure_target == .none);
        try std.testing.expectEqual(next, second.measure_target);
        try std.testing.expect(second.measure_previous == null);
        try std.testing.expect(second.measure_next == null);
        try second.setMeasureTarget(.none);
        try std.testing.expect(second.measure_dependents == null);
        try std.testing.expect(replacement.measure_dependents == null);
        try std.testing.expect(replacement.getTextBufferView().measure_dependents == null);
    }
}
