const std = @import("std");

const native_renderable = @import("../native-renderable.zig");
const yoga = @import("../yoga.zig");

test "NativeRenderable measure width normalization matches previous TypeScript rules" {
    try std.testing.expectEqual(@as(f32, 0), native_renderable.normalizeYogaMeasureWidthInput(42, @intFromEnum(yoga.YogaMeasureMode.undefined)));
    try std.testing.expectEqual(@as(f32, 0), native_renderable.normalizeYogaMeasureWidthInput(std.math.nan(f32), @intFromEnum(yoga.YogaMeasureMode.exactly)));
    try std.testing.expectEqual(@as(f32, 42), native_renderable.normalizeYogaMeasureWidthInput(42, @intFromEnum(yoga.YogaMeasureMode.exactly)));
    try std.testing.expectEqual(@as(f32, 42), native_renderable.normalizeYogaMeasureWidthInput(42, @intFromEnum(yoga.YogaMeasureMode.at_most)));
}

test "NativeRenderable measure height normalization matches previous TypeScript rules" {
    try std.testing.expectEqual(@as(f32, 1), native_renderable.normalizeYogaMeasureHeightInput(std.math.nan(f32)));
    try std.testing.expectEqual(@as(f32, 24), native_renderable.normalizeYogaMeasureHeightInput(24));
}
