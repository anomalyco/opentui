const std = @import("std");

const yoga = @import("../yoga.zig");

test "Yoga wrapper computes basic flex layout" {
    const config = yoga.yogaConfigCreate();
    defer yoga.yogaConfigFree(config);

    const root = yoga.yogaNodeCreateWithConfig(config);
    defer yoga.yogaNodeFree(root);

    yoga.yogaNodeStyleSetEnum(root, @intFromEnum(yoga.YogaEnumKind.flex_direction), @intFromEnum(yoga.YogaFlexDirection.row));
    yoga.yogaNodeStyleSetValue(root, @intFromEnum(yoga.YogaValueKind.width), 0, @intFromEnum(yoga.YogaUnit.point), 100);
    yoga.yogaNodeStyleSetValue(root, @intFromEnum(yoga.YogaValueKind.height), 0, @intFromEnum(yoga.YogaUnit.point), 100);

    const child = yoga.yogaNodeCreateWithConfig(config);
    defer yoga.yogaNodeFree(child);
    yoga.yogaNodeStyleSetFloat(child, @intFromEnum(yoga.YogaFloatKind.flex_grow), 1);
    yoga.yogaNodeInsertChild(root, child, 0);

    yoga.yogaNodeCalculateLayout(root, std.math.nan(f32), std.math.nan(f32), @intFromEnum(yoga.YogaDirection.ltr));

    var layout: yoga.ExternalYogaLayout = undefined;
    yoga.yogaNodeGetComputedLayout(child, &layout);
    try std.testing.expectApproxEqAbs(@as(f32, 100), layout.width, 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 100), layout.height, 0.001);
}

test "OpenTUI Yoga nodes use the native fixed config" {
    const first = yoga.yogaNodeCreateForOpenTUI();
    defer yoga.yogaNodeFree(first);
    const second = yoga.yogaNodeCreateForOpenTUI();
    defer yoga.yogaNodeFree(second);

    const first_config = yoga.yogaNodeGetConfig(first);
    const second_config = yoga.yogaNodeGetConfig(second);
    try std.testing.expect(first_config == second_config);
    try std.testing.expect(!yoga.yogaConfigGetUseWebDefaults(first_config));
    try std.testing.expectEqual(@as(f32, 1), yoga.yogaConfigGetPointScaleFactor(first_config));
}

test "Yoga wrapper packs style values" {
    const node = yoga.yogaNodeCreate();
    defer yoga.yogaNodeFree(node);

    yoga.yogaNodeStyleSetValue(node, @intFromEnum(yoga.YogaValueKind.flex_basis), 0, @intFromEnum(yoga.YogaUnit.point), 10);
    const packed_value = yoga.yogaNodeStyleGetValue(node, @intFromEnum(yoga.YogaValueKind.flex_basis), 0);
    const unit: u32 = @intCast(packed_value & 0xffffffff);
    const value_bits: u32 = @intCast((packed_value >> 32) & 0xffffffff);
    const value: f32 = @bitCast(value_bits);

    try std.testing.expectEqual(@as(u32, @intFromEnum(yoga.YogaUnit.point)), unit);
    try std.testing.expectApproxEqAbs(@as(f32, 10), value, 0.001);
}

test "Yoga wrapper stores dirtied callback alongside measure callback" {
    const node = yoga.yogaNodeCreate();
    defer yoga.yogaNodeFree(node);

    yoga.yogaNodeSetMeasureFunc(node, null);
    yoga.yogaNodeSetDirtiedFunc(node, null);
    try std.testing.expect(!yoga.yogaNodeHasContext(node));
}
