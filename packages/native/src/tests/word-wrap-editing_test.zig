const std = @import("std");
const TestPools = @import("test-pools.zig").TestPools;
const EditBuffer = @import("../edit-buffer.zig").EditBuffer;
const TextBufferView = @import("../text-buffer-view.zig").TextBufferView;

/// One edit: move the cursor when `at` is set, delete backward and forward, then insert.
const Step = struct { at: ?[2]u32 = null, back: u8 = 0, forward: u8 = 0, insert: []const u8 = "" };

test "Word wrap - edits near a wrap boundary wrap like the same text loaded fresh" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    const Case = struct { width: u32, text: []const u8, steps: []const Step, widths: []const u32 };
    const typed_friend = [_]Step{ .{ .insert = "f" }, .{ .insert = "r" }, .{ .insert = "i" }, .{ .insert = "e" }, .{ .insert = "n" }, .{ .insert = "d" } };
    const cases = [_]Case{
        .{ .width = 18, .text = "hello my good", .steps = &.{.{ .at = .{ 0, 13 }, .insert = " friend" }}, .widths = &.{ 14, 6 } },
        .{ .width = 18, .text = "hello my good friend", .steps = &.{ .{ .at = .{ 0, 20 }, .back = 7 }, .{ .insert = " friend" } }, .widths = &.{ 14, 6 } },
        .{ .width = 18, .text = "hello my good ", .steps = &[_]Step{.{ .at = .{ 0, 14 } }} ++ typed_friend ++ [_]Step{.{ .insert = " " }}, .widths = &.{ 14, 7 } },
        .{ .width = 18, .text = "hello my ", .steps = &[_]Step{ .{ .at = .{ 0, 9 }, .insert = "g" }, .{ .insert = "o" }, .{ .insert = "o" }, .{ .insert = "d" }, .{ .insert = " " } } ++ typed_friend, .widths = &.{ 14, 6 } },
        .{ .width = 18, .text = "hello ", .steps = &.{ .{ .at = .{ 0, 6 }, .insert = "my " }, .{ .insert = "good " }, .{ .insert = "friend" } }, .widths = &.{ 14, 6 } },
        .{ .width = 18, .text = "hello my good ", .steps = &.{ .{ .at = .{ 0, 14 }, .insert = "f" }, .{ .back = 1, .insert = "friend" } }, .widths = &.{ 14, 6 } },
        .{ .width = 18, .text = "hello my good friend buddy", .steps = &.{.{ .at = .{ 0, 6 }, .forward = 8 }}, .widths = &.{18} },
        .{ .width = 20, .text = "hello friend", .steps = &.{.{ .at = .{ 0, 6 }, .insert = "my good " }}, .widths = &.{20} },
        .{
            .width = 20,
            .text = "hello ",
            .steps = &.{
                .{ .at = .{ 0, 6 }, .insert = "w" }, .{ .back = 1, .insert = "m" }, .{ .insert = "y" },            .{ .insert = " " },
                .{ .insert = "g" },                  .{ .insert = "o" },            .{ .back = 1, .insert = "o" }, .{ .insert = "o" },
                .{ .insert = "d" },                  .{ .insert = " " },            .{ .insert = "x" },            .{ .back = 1, .insert = "f" },
                .{ .insert = "r" },                  .{ .insert = "iend" },
            },
            .widths = &.{20},
        },
        .{ .width = 15, .text = "hello world test", .steps = &.{.{ .at = .{ 0, 11 }, .insert = "s" }}, .widths = &.{ 13, 4 } },
        .{ .width = 20, .text = "12345678901234567890", .steps = &.{.{ .at = .{ 0, 20 }, .insert = " word" }}, .widths = &.{ 20, 4 } },
        // A newline earlier in the buffer must not leave stale wrap state for later lines.
        .{ .width = 3, .text = "a\n\u{597d}", .steps = &.{ .{ .at = .{ 0, 1 }, .insert = " b" }, .{ .at = .{ 1, 2 }, .insert = "\u{754c}" } }, .widths = &.{ 3, 2, 2 } },
    };
    for (cases) |case| {
        const eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
        defer eb.deinit();
        const view = try TextBufferView.init(std.testing.allocator, eb.getTextBuffer());
        defer view.deinit();
        view.setWrapMode(.word);
        view.setWrapWidth(case.width);
        try eb.setText(case.text);
        for (case.steps) |step| {
            if (step.at) |at| try eb.setCursor(at[0], at[1]);
            for (0..step.back) |_| try eb.backspace();
            for (0..step.forward) |_| try eb.deleteForward();
            if (step.insert.len > 0) try eb.insertText(step.insert);
            try expectFreshWrap(&pools, view, case.width);
        }
        const lines = view.getVirtualLines();
        try std.testing.expectEqual(case.widths.len, lines.len);
        for (case.widths, lines) |width, line| try std.testing.expectEqual(width, line.width_cols);
    }
}

fn expectFreshWrap(pools: *TestPools, edited: *TextBufferView, width: u32) !void {
    var text: [64]u8 = undefined;
    const buffer = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer buffer.deinit();
    try buffer.setText(text[0..edited.getPlainTextIntoBuffer(&text)]);
    const fresh = try TextBufferView.init(std.testing.allocator, buffer.getTextBuffer());
    defer fresh.deinit();
    fresh.setWrapMode(.word);
    fresh.setWrapWidth(width);
    const expected = fresh.getVirtualLines();
    const actual = edited.getVirtualLines();
    try std.testing.expectEqual(expected.len, actual.len);
    for (expected, actual) |want, got| {
        try std.testing.expectEqual(want.width_cols, got.width_cols);
        try std.testing.expectEqual(want.source_line, got.source_line);
        try std.testing.expectEqual(want.source_col_start, got.source_col_start);
    }
}
