const std = @import("std");

const ansi = @import("../ansi.zig");

test "fallbackAnsi256Color returns base, cube, and grayscale colors" {
    try std.testing.expectEqual(@as(u32, 0xff0000), ansi.rgbaToRgb24(ansi.fallbackAnsi256Color(9)));
    try std.testing.expectEqual(@as(u32, 0x0000ff), ansi.rgbaToRgb24(ansi.fallbackAnsi256Color(21)));
    try std.testing.expectEqual(@as(u32, 0x080808), ansi.rgbaToRgb24(ansi.fallbackAnsi256Color(232)));
    try std.testing.expectEqual(@as(u32, 0xeeeeee), ansi.rgbaToRgb24(ansi.fallbackAnsi256Color(255)));
}

test "packed RGBA stores metadata" {
    const color = ansi.indexedColor(9, 255, 0, 0);

    try std.testing.expectEqual(@as(u8, 255), ansi.red(color));
    try std.testing.expectEqual(@as(u8, 9), ansi.slot(color));
    try std.testing.expectEqual(ansi.ColorIntent.indexed, ansi.intent(color));
}

test "OSC 22 mouse pointer uses ST terminator" {
    var buffer: [64]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&buffer);

    try ansi.ANSI.setMousePointerOutput(&writer, "pointer");

    try std.testing.expectEqualStrings("\x1b]22;pointer\x1b\\", writer.buffered());
}

test "OSC 22 mouse pointer reset uses ST terminator" {
    try std.testing.expectEqualStrings("\x1b]22;\x1b\\", ansi.ANSI.resetMousePointer);
}
