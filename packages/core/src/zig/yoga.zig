const std = @import("std");

const c = @cImport({
    @cInclude("yoga/Yoga.h");
});

pub const YGNodeRef = c.YGNodeRef;
pub const YGNodeConstRef = c.YGNodeConstRef;
pub const YGConfigRef = c.YGConfigRef;
pub const YGConfigConstRef = c.YGConfigConstRef;

pub const YogaEnumKind = enum(u32) {
    direction = 0,
    flex_direction = 1,
    justify_content = 2,
    align_content = 3,
    align_items = 4,
    align_self = 5,
    position_type = 6,
    flex_wrap = 7,
    overflow = 8,
    display = 9,
    box_sizing = 10,
};

pub const YogaFloatKind = enum(u32) {
    flex = 0,
    flex_grow = 1,
    flex_shrink = 2,
    aspect_ratio = 3,
};

pub const YogaValueKind = enum(u32) {
    width = 0,
    height = 1,
    min_width = 2,
    min_height = 3,
    max_width = 4,
    max_height = 5,
    flex_basis = 6,
    margin = 7,
    padding = 8,
    position = 9,
    gap = 10,
};

const YogaEdgeLayoutKind = enum(u32) {
    margin = 0,
    padding = 1,
    border = 2,
};

pub const YogaUnit = enum(u32) {
    undefined = 0,
    point = 1,
    percent = 2,
    auto = 3,
};

pub const YogaDirection = enum(u32) {
    inherit = 0,
    ltr = 1,
    rtl = 2,
};

pub const YogaFlexDirection = enum(u32) {
    column = 0,
    column_reverse = 1,
    row = 2,
    row_reverse = 3,
};

pub const ExternalYogaLayout = extern struct {
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
    width: f32,
    height: f32,
};

const CallbackContext = struct {
    measure_callback: ?*const anyopaque = null,
    dirtied_callback: ?*const anyopaque = null,
};

const JsMeasureCallback = *const fn (?*anyopaque, f32, u32, f32, u32) callconv(.c) void;
const JsDirtiedCallback = *const fn () callconv(.c) void;
const callback_allocator = std.heap.c_allocator;
var opentui_config: YGConfigRef = null;
var opentui_config_mutex: std.Thread.Mutex = .{};

threadlocal var tls_measure_width: f32 = 0;
threadlocal var tls_measure_height: f32 = 0;

fn enumValue(value: anytype) u32 {
    return @intCast(value);
}

fn toAlign(value: u32) c.YGAlign {
    return @intCast(value);
}

fn toBoxSizing(value: u32) c.YGBoxSizing {
    return @intCast(value);
}

fn toDirection(value: u32) c.YGDirection {
    return @intCast(value);
}

fn toDisplay(value: u32) c.YGDisplay {
    return @intCast(value);
}

fn toEdge(value: u32) c.YGEdge {
    return @intCast(value);
}

fn toErrata(value: u32) c.YGErrata {
    return @intCast(value);
}

fn toExperimentalFeature(value: u32) c.YGExperimentalFeature {
    return @intCast(value);
}

fn toFlexDirection(value: u32) c.YGFlexDirection {
    return @intCast(value);
}

fn toGutter(value: u32) c.YGGutter {
    return @intCast(value);
}

fn toJustify(value: u32) c.YGJustify {
    return @intCast(value);
}

fn toOverflow(value: u32) c.YGOverflow {
    return @intCast(value);
}

fn toPositionType(value: u32) c.YGPositionType {
    return @intCast(value);
}

fn toWrap(value: u32) c.YGWrap {
    return @intCast(value);
}

fn undefinedValue() c.YGValue {
    return .{ .value = std.math.nan(f32), .unit = c.YGUnitUndefined };
}

fn getOpenTUIConfig() YGConfigRef {
    opentui_config_mutex.lock();
    defer opentui_config_mutex.unlock();

    if (opentui_config == null) {
        const config = c.YGConfigNew();
        c.YGConfigSetUseWebDefaults(config, false);
        c.YGConfigSetPointScaleFactor(config, 1);
        opentui_config = config;
    }

    return opentui_config;
}

fn pointValue(value: f32) c.YGValue {
    return .{ .value = value, .unit = c.YGUnitPoint };
}

fn packValue(value: c.YGValue) u64 {
    const unit_bits: u32 = enumValue(value.unit);
    const value_bits: u32 = @bitCast(value.value);
    return (@as(u64, value_bits) << 32) | @as(u64, unit_bits);
}

fn getContext(node: YGNodeConstRef) ?*CallbackContext {
    const existing = c.YGNodeGetContext(node);
    if (existing) |ptr| {
        return @ptrCast(@alignCast(ptr));
    }
    return null;
}

fn getOrCreateContext(node: YGNodeRef) *CallbackContext {
    if (getContext(node)) |ctx| {
        return ctx;
    }

    const ctx = callback_allocator.create(CallbackContext) catch @panic("failed to allocate Yoga callback context");
    ctx.* = .{};
    c.YGNodeSetContext(node, ctx);
    return ctx;
}

fn freeContext(node: YGNodeRef) void {
    const existing = c.YGNodeGetContext(node);
    if (existing) |ptr| {
        const ctx: *CallbackContext = @ptrCast(@alignCast(ptr));
        callback_allocator.destroy(ctx);
        c.YGNodeSetContext(node, null);
    }
}

fn freeContextIfUnused(node: YGNodeRef) void {
    const existing = c.YGNodeGetContext(node);
    if (existing) |ptr| {
        const ctx: *CallbackContext = @ptrCast(@alignCast(ptr));
        if (ctx.measure_callback == null and ctx.dirtied_callback == null) {
            callback_allocator.destroy(ctx);
            c.YGNodeSetContext(node, null);
        }
    }
}

fn freeContextRecursive(node: YGNodeRef) void {
    const child_count = c.YGNodeGetChildCount(node);
    var index: usize = 0;
    while (index < child_count) : (index += 1) {
        const child = c.YGNodeGetChild(node, index);
        freeContextRecursive(child);
    }
    freeContext(node);
}

fn internalMeasureFunc(
    node: YGNodeConstRef,
    width: f32,
    width_mode: c.YGMeasureMode,
    height: f32,
    height_mode: c.YGMeasureMode,
) callconv(.c) c.YGSize {
    tls_measure_width = std.math.nan(f32);
    tls_measure_height = std.math.nan(f32);

    if (getContext(node)) |ctx| {
        if (ctx.measure_callback) |callback| {
            const trampoline: JsMeasureCallback = @ptrCast(@alignCast(callback));
            trampoline(null, width, enumValue(width_mode), height, enumValue(height_mode));
        }
    }

    return .{ .width = tls_measure_width, .height = tls_measure_height };
}

fn internalDirtiedFunc(node: YGNodeConstRef) callconv(.c) void {
    if (getContext(node)) |ctx| {
        if (ctx.dirtied_callback) |callback| {
            const trampoline: JsDirtiedCallback = @ptrCast(@alignCast(callback));
            trampoline();
        }
    }
}

pub export fn yogaConfigCreate() YGConfigRef {
    return c.YGConfigNew();
}

pub export fn yogaConfigFree(config: YGConfigRef) void {
    c.YGConfigFree(config);
}

export fn yogaConfigSetUseWebDefaults(config: YGConfigRef, enabled: bool) void {
    c.YGConfigSetUseWebDefaults(config, enabled);
}

pub export fn yogaConfigGetUseWebDefaults(config: YGConfigConstRef) bool {
    return c.YGConfigGetUseWebDefaults(config);
}

export fn yogaConfigSetPointScaleFactor(config: YGConfigRef, point_scale_factor: f32) void {
    c.YGConfigSetPointScaleFactor(config, point_scale_factor);
}

pub export fn yogaConfigGetPointScaleFactor(config: YGConfigConstRef) f32 {
    return c.YGConfigGetPointScaleFactor(config);
}

export fn yogaConfigSetErrata(config: YGConfigRef, errata: u32) void {
    c.YGConfigSetErrata(config, toErrata(errata));
}

export fn yogaConfigGetErrata(config: YGConfigConstRef) u32 {
    return enumValue(c.YGConfigGetErrata(config));
}

export fn yogaConfigSetExperimentalFeatureEnabled(config: YGConfigRef, feature: u32, enabled: bool) void {
    c.YGConfigSetExperimentalFeatureEnabled(config, toExperimentalFeature(feature), enabled);
}

export fn yogaConfigIsExperimentalFeatureEnabled(config: YGConfigConstRef, feature: u32) bool {
    return c.YGConfigIsExperimentalFeatureEnabled(config, toExperimentalFeature(feature));
}

pub export fn yogaNodeCreate() YGNodeRef {
    return c.YGNodeNew();
}

pub export fn yogaNodeCreateForOpenTUI() YGNodeRef {
    return c.YGNodeNewWithConfig(getOpenTUIConfig());
}

pub export fn yogaNodeCreateWithConfig(config: YGConfigConstRef) YGNodeRef {
    return c.YGNodeNewWithConfig(config);
}

pub export fn yogaNodeFree(node: YGNodeRef) void {
    freeContext(node);
    c.YGNodeFree(node);
}

export fn yogaNodeFreeRecursive(node: YGNodeRef) void {
    freeContextRecursive(node);
    c.YGNodeFreeRecursive(node);
}

export fn yogaNodeReset(node: YGNodeRef) void {
    freeContext(node);
    c.YGNodeReset(node);
}

export fn yogaNodeCopyStyle(dst_node: YGNodeRef, src_node: YGNodeConstRef) void {
    c.YGNodeCopyStyle(dst_node, src_node);
}

pub export fn yogaNodeInsertChild(node: YGNodeRef, child: YGNodeRef, index: u32) void {
    c.YGNodeInsertChild(node, child, index);
}

export fn yogaNodeRemoveChild(node: YGNodeRef, child: YGNodeRef) void {
    c.YGNodeRemoveChild(node, child);
}

export fn yogaNodeRemoveAllChildren(node: YGNodeRef) void {
    c.YGNodeRemoveAllChildren(node);
}

export fn yogaNodeGetChild(node: YGNodeRef, index: u32) YGNodeRef {
    return c.YGNodeGetChild(node, index);
}

export fn yogaNodeGetChildCount(node: YGNodeConstRef) u32 {
    return @intCast(c.YGNodeGetChildCount(node));
}

export fn yogaNodeGetParent(node: YGNodeRef) YGNodeRef {
    return c.YGNodeGetParent(node);
}

pub export fn yogaNodeCalculateLayout(node: YGNodeRef, width: f32, height: f32, direction: u32) void {
    c.YGNodeCalculateLayout(node, width, height, toDirection(direction));
}

export fn yogaNodeIsDirty(node: YGNodeConstRef) bool {
    return c.YGNodeIsDirty(node);
}

export fn yogaNodeMarkDirty(node: YGNodeRef) void {
    c.YGNodeMarkDirty(node);
}

export fn yogaNodeGetHasNewLayout(node: YGNodeConstRef) bool {
    return c.YGNodeGetHasNewLayout(node);
}

export fn yogaNodeSetHasNewLayout(node: YGNodeRef, has_new_layout: bool) void {
    c.YGNodeSetHasNewLayout(node, has_new_layout);
}

export fn yogaNodeSetIsReferenceBaseline(node: YGNodeRef, is_reference_baseline: bool) void {
    c.YGNodeSetIsReferenceBaseline(node, is_reference_baseline);
}

export fn yogaNodeIsReferenceBaseline(node: YGNodeConstRef) bool {
    return c.YGNodeIsReferenceBaseline(node);
}

export fn yogaNodeSetAlwaysFormsContainingBlock(node: YGNodeRef, always_forms_containing_block: bool) void {
    c.YGNodeSetAlwaysFormsContainingBlock(node, always_forms_containing_block);
}

export fn yogaNodeGetAlwaysFormsContainingBlock(node: YGNodeConstRef) bool {
    return c.YGNodeGetAlwaysFormsContainingBlock(node);
}

pub export fn yogaNodeGetComputedLayout(node: YGNodeConstRef, out_ptr: *ExternalYogaLayout) void {
    out_ptr.* = .{
        .left = c.YGNodeLayoutGetLeft(node),
        .top = c.YGNodeLayoutGetTop(node),
        .right = c.YGNodeLayoutGetRight(node),
        .bottom = c.YGNodeLayoutGetBottom(node),
        .width = c.YGNodeLayoutGetWidth(node),
        .height = c.YGNodeLayoutGetHeight(node),
    };
}

export fn yogaNodeLayoutGetEdge(node: YGNodeConstRef, kind: u32, edge: u32) f32 {
    const edge_value = toEdge(edge);
    return switch (@as(YogaEdgeLayoutKind, @enumFromInt(kind))) {
        .margin => c.YGNodeLayoutGetMargin(node, edge_value),
        .padding => c.YGNodeLayoutGetPadding(node, edge_value),
        .border => c.YGNodeLayoutGetBorder(node, edge_value),
    };
}

pub export fn yogaNodeStyleSetEnum(node: YGNodeRef, kind: u32, value: u32) void {
    switch (@as(YogaEnumKind, @enumFromInt(kind))) {
        .direction => c.YGNodeStyleSetDirection(node, toDirection(value)),
        .flex_direction => c.YGNodeStyleSetFlexDirection(node, toFlexDirection(value)),
        .justify_content => c.YGNodeStyleSetJustifyContent(node, toJustify(value)),
        .align_content => c.YGNodeStyleSetAlignContent(node, toAlign(value)),
        .align_items => c.YGNodeStyleSetAlignItems(node, toAlign(value)),
        .align_self => c.YGNodeStyleSetAlignSelf(node, toAlign(value)),
        .position_type => c.YGNodeStyleSetPositionType(node, toPositionType(value)),
        .flex_wrap => c.YGNodeStyleSetFlexWrap(node, toWrap(value)),
        .overflow => c.YGNodeStyleSetOverflow(node, toOverflow(value)),
        .display => c.YGNodeStyleSetDisplay(node, toDisplay(value)),
        .box_sizing => c.YGNodeStyleSetBoxSizing(node, toBoxSizing(value)),
    }
}

export fn yogaNodeStyleGetEnum(node: YGNodeConstRef, kind: u32) u32 {
    return switch (@as(YogaEnumKind, @enumFromInt(kind))) {
        .direction => enumValue(c.YGNodeStyleGetDirection(node)),
        .flex_direction => enumValue(c.YGNodeStyleGetFlexDirection(node)),
        .justify_content => enumValue(c.YGNodeStyleGetJustifyContent(node)),
        .align_content => enumValue(c.YGNodeStyleGetAlignContent(node)),
        .align_items => enumValue(c.YGNodeStyleGetAlignItems(node)),
        .align_self => enumValue(c.YGNodeStyleGetAlignSelf(node)),
        .position_type => enumValue(c.YGNodeStyleGetPositionType(node)),
        .flex_wrap => enumValue(c.YGNodeStyleGetFlexWrap(node)),
        .overflow => enumValue(c.YGNodeStyleGetOverflow(node)),
        .display => enumValue(c.YGNodeStyleGetDisplay(node)),
        .box_sizing => enumValue(c.YGNodeStyleGetBoxSizing(node)),
    };
}

pub export fn yogaNodeStyleSetFloat(node: YGNodeRef, kind: u32, value: f32) void {
    switch (@as(YogaFloatKind, @enumFromInt(kind))) {
        .flex => c.YGNodeStyleSetFlex(node, value),
        .flex_grow => c.YGNodeStyleSetFlexGrow(node, value),
        .flex_shrink => c.YGNodeStyleSetFlexShrink(node, value),
        .aspect_ratio => c.YGNodeStyleSetAspectRatio(node, value),
    }
}

export fn yogaNodeStyleGetFloat(node: YGNodeConstRef, kind: u32) f32 {
    return switch (@as(YogaFloatKind, @enumFromInt(kind))) {
        .flex => c.YGNodeStyleGetFlex(node),
        .flex_grow => c.YGNodeStyleGetFlexGrow(node),
        .flex_shrink => c.YGNodeStyleGetFlexShrink(node),
        .aspect_ratio => c.YGNodeStyleGetAspectRatio(node),
    };
}

export fn yogaNodeStyleSetBorder(node: YGNodeRef, edge: u32, border: f32) void {
    c.YGNodeStyleSetBorder(node, toEdge(edge), border);
}

export fn yogaNodeStyleGetBorder(node: YGNodeConstRef, edge: u32) f32 {
    return c.YGNodeStyleGetBorder(node, toEdge(edge));
}

pub export fn yogaNodeStyleSetValue(node: YGNodeRef, kind: u32, edge_or_gutter: u32, unit: u32, value: f32) void {
    const value_kind = @as(YogaValueKind, @enumFromInt(kind));
    const value_unit = @as(YogaUnit, @enumFromInt(unit));
    const undefined_value = std.math.nan(f32);

    switch (value_kind) {
        .width => switch (value_unit) {
            .point => c.YGNodeStyleSetWidth(node, value),
            .percent => c.YGNodeStyleSetWidthPercent(node, value),
            .auto => c.YGNodeStyleSetWidthAuto(node),
            .undefined => c.YGNodeStyleSetWidth(node, undefined_value),
        },
        .height => switch (value_unit) {
            .point => c.YGNodeStyleSetHeight(node, value),
            .percent => c.YGNodeStyleSetHeightPercent(node, value),
            .auto => c.YGNodeStyleSetHeightAuto(node),
            .undefined => c.YGNodeStyleSetHeight(node, undefined_value),
        },
        .min_width => switch (value_unit) {
            .point => c.YGNodeStyleSetMinWidth(node, value),
            .percent => c.YGNodeStyleSetMinWidthPercent(node, value),
            .undefined => c.YGNodeStyleSetMinWidth(node, undefined_value),
            .auto => {},
        },
        .min_height => switch (value_unit) {
            .point => c.YGNodeStyleSetMinHeight(node, value),
            .percent => c.YGNodeStyleSetMinHeightPercent(node, value),
            .undefined => c.YGNodeStyleSetMinHeight(node, undefined_value),
            .auto => {},
        },
        .max_width => switch (value_unit) {
            .point => c.YGNodeStyleSetMaxWidth(node, value),
            .percent => c.YGNodeStyleSetMaxWidthPercent(node, value),
            .undefined => c.YGNodeStyleSetMaxWidth(node, undefined_value),
            .auto => {},
        },
        .max_height => switch (value_unit) {
            .point => c.YGNodeStyleSetMaxHeight(node, value),
            .percent => c.YGNodeStyleSetMaxHeightPercent(node, value),
            .undefined => c.YGNodeStyleSetMaxHeight(node, undefined_value),
            .auto => {},
        },
        .flex_basis => switch (value_unit) {
            .point => c.YGNodeStyleSetFlexBasis(node, value),
            .percent => c.YGNodeStyleSetFlexBasisPercent(node, value),
            .auto => c.YGNodeStyleSetFlexBasisAuto(node),
            .undefined => c.YGNodeStyleSetFlexBasis(node, undefined_value),
        },
        .margin => switch (value_unit) {
            .point => c.YGNodeStyleSetMargin(node, toEdge(edge_or_gutter), value),
            .percent => c.YGNodeStyleSetMarginPercent(node, toEdge(edge_or_gutter), value),
            .auto => c.YGNodeStyleSetMarginAuto(node, toEdge(edge_or_gutter)),
            .undefined => c.YGNodeStyleSetMargin(node, toEdge(edge_or_gutter), undefined_value),
        },
        .padding => switch (value_unit) {
            .point => c.YGNodeStyleSetPadding(node, toEdge(edge_or_gutter), value),
            .percent => c.YGNodeStyleSetPaddingPercent(node, toEdge(edge_or_gutter), value),
            .undefined => c.YGNodeStyleSetPadding(node, toEdge(edge_or_gutter), undefined_value),
            .auto => {},
        },
        .position => switch (value_unit) {
            .point => c.YGNodeStyleSetPosition(node, toEdge(edge_or_gutter), value),
            .percent => c.YGNodeStyleSetPositionPercent(node, toEdge(edge_or_gutter), value),
            .auto => c.YGNodeStyleSetPositionAuto(node, toEdge(edge_or_gutter)),
            .undefined => c.YGNodeStyleSetPosition(node, toEdge(edge_or_gutter), undefined_value),
        },
        .gap => switch (value_unit) {
            .point => c.YGNodeStyleSetGap(node, toGutter(edge_or_gutter), value),
            .percent => c.YGNodeStyleSetGapPercent(node, toGutter(edge_or_gutter), value),
            .undefined => c.YGNodeStyleSetGap(node, toGutter(edge_or_gutter), undefined_value),
            .auto => {},
        },
    }
}

pub export fn yogaNodeStyleGetValue(node: YGNodeConstRef, kind: u32, edge_or_gutter: u32) u64 {
    const value = switch (@as(YogaValueKind, @enumFromInt(kind))) {
        .width => c.YGNodeStyleGetWidth(node),
        .height => c.YGNodeStyleGetHeight(node),
        .min_width => c.YGNodeStyleGetMinWidth(node),
        .min_height => c.YGNodeStyleGetMinHeight(node),
        .max_width => c.YGNodeStyleGetMaxWidth(node),
        .max_height => c.YGNodeStyleGetMaxHeight(node),
        .flex_basis => c.YGNodeStyleGetFlexBasis(node),
        .margin => c.YGNodeStyleGetMargin(node, toEdge(edge_or_gutter)),
        .padding => c.YGNodeStyleGetPadding(node, toEdge(edge_or_gutter)),
        .position => c.YGNodeStyleGetPosition(node, toEdge(edge_or_gutter)),
        .gap => blk: {
            const gap = c.YGNodeStyleGetGap(node, toGutter(edge_or_gutter));
            break :blk if (std.math.isNan(gap)) undefinedValue() else pointValue(gap);
        },
    };
    return packValue(value);
}

pub export fn yogaNodeSetMeasureFunc(node: YGNodeRef, callback: ?*const anyopaque) void {
    if (callback) |callback_ptr| {
        const ctx = getOrCreateContext(node);
        ctx.measure_callback = callback_ptr;
        c.YGNodeSetMeasureFunc(node, &internalMeasureFunc);
        return;
    }

    yogaNodeUnsetMeasureFunc(node);
}

export fn yogaNodeUnsetMeasureFunc(node: YGNodeRef) void {
    if (getContext(node)) |ctx| {
        ctx.measure_callback = null;
    }
    c.YGNodeSetMeasureFunc(node, null);
    freeContextIfUnused(node);
}

export fn yogaNodeHasMeasureFunc(node: YGNodeConstRef) bool {
    return c.YGNodeHasMeasureFunc(node);
}

pub export fn yogaNodeSetDirtiedFunc(node: YGNodeRef, callback: ?*const anyopaque) void {
    if (callback) |callback_ptr| {
        const ctx = getOrCreateContext(node);
        ctx.dirtied_callback = callback_ptr;
        c.YGNodeSetDirtiedFunc(node, &internalDirtiedFunc);
        return;
    }

    yogaNodeUnsetDirtiedFunc(node);
}

export fn yogaNodeUnsetDirtiedFunc(node: YGNodeRef) void {
    if (getContext(node)) |ctx| {
        ctx.dirtied_callback = null;
    }
    c.YGNodeSetDirtiedFunc(node, null);
    freeContextIfUnused(node);
}

export fn yogaStoreMeasureResult(width: f32, height: f32) void {
    tls_measure_width = width;
    tls_measure_height = height;
}

pub fn yogaNodeGetConfig(node: YGNodeRef) YGConfigConstRef {
    return c.YGNodeGetConfig(node);
}

pub fn yogaNodeHasContext(node: YGNodeConstRef) bool {
    return c.YGNodeGetContext(node) != null;
}
