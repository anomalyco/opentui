const std = @import("std");

const editor_view = @import("editor-view.zig");
const native_yoga = @import("yoga.zig");
const text_buffer_view = @import("text-buffer-view.zig");

pub const MeasureTargetKind = enum(u32) {
    none = 0,
    text_buffer_view = 1,
    editor_view = 2,
};

// Generic measure targets keep Yoga independent of concrete renderable types.
// Add target kinds here instead of adding type-specific Yoga APIs.
pub const MeasureTarget = union(MeasureTargetKind) {
    none,
    text_buffer_view: *text_buffer_view.UnifiedTextBufferView,
    editor_view: *editor_view.EditorView,
};

pub const NativeRenderable = struct {
    yoga_node: native_yoga.YGNodeRef,
    measure_target: MeasureTarget = .none,

    pub fn init() error{OutOfMemory}!NativeRenderable {
        const yoga_node = native_yoga.yogaNodeCreateForOpenTUI() orelse return error.OutOfMemory;
        return .{ .yoga_node = yoga_node };
    }

    pub fn deinit(self: *NativeRenderable) void {
        self.setMeasureTarget(.none);
        native_yoga.yogaNodeFree(self.yoga_node);
        self.* = undefined;
    }

    pub fn getYogaNode(self: *const NativeRenderable) native_yoga.YGNodeRef {
        return self.yoga_node;
    }

    pub fn setMeasureTarget(self: *NativeRenderable, target: MeasureTarget) void {
        self.measure_target = target;
        switch (target) {
            .none => native_yoga.yogaNodeSetNativeMeasureFunc(self.yoga_node, null, null),
            else => native_yoga.yogaNodeSetNativeMeasureFunc(self.yoga_node, self, &NativeRenderable.measure),
        }
    }

    pub fn clearMeasureTargetIfMatches(self: *NativeRenderable, target: MeasureTarget) void {
        const matches = switch (target) {
            .none => false,
            .text_buffer_view => |view| switch (self.measure_target) {
                .text_buffer_view => |current| current == view,
                else => false,
            },
            .editor_view => |view| switch (self.measure_target) {
                .editor_view => |current| current == view,
                else => false,
            },
        };
        if (matches) self.setMeasureTarget(.none);
    }

    fn measure(target: ?*anyopaque, width: f32, width_mode: u32, height: f32, height_mode: u32) callconv(.c) native_yoga.ExternalYogaSize {
        _ = height_mode;
        const self: *NativeRenderable = @ptrCast(@alignCast(target orelse return .{ .width = std.math.nan(f32), .height = std.math.nan(f32) }));
        const effective_width = normalizeYogaMeasureWidthInput(width, width_mode);
        const effective_height = normalizeYogaMeasureHeightInput(height);
        const measure_width = floorToU32(effective_width);
        const measure_height = floorToU32(effective_height);
        const result = self.measureTarget(measure_width, measure_height) orelse return .{ .width = 1, .height = 1 };

        var measured_width: f32 = @floatFromInt(@max(@as(u32, 1), result.width_cols_max));
        var measured_height: f32 = @floatFromInt(@max(@as(u32, 1), result.line_count));

        if (width_mode == @intFromEnum(native_yoga.YogaMeasureMode.at_most) and !isYogaNodeAbsolute(self.yoga_node)) {
            measured_width = @min(effective_width, measured_width);
            measured_height = @min(effective_height, measured_height);
        }

        return .{ .width = measured_width, .height = measured_height };
    }

    fn measureTarget(self: *NativeRenderable, width: u32, height: u32) ?text_buffer_view.MeasureResult {
        return switch (self.measure_target) {
            .none => null,
            .text_buffer_view => |view| view.measureForDimensions(width, height) catch null,
            .editor_view => |view| view.getTextBufferView().measureForDimensions(width, height) catch null,
        };
    }
};

pub fn normalizeYogaMeasureWidthInput(value: f32, width_mode: u32) f32 {
    if (width_mode == @intFromEnum(native_yoga.YogaMeasureMode.undefined) or std.math.isNan(value)) return 0;
    return value;
}

pub fn normalizeYogaMeasureHeightInput(value: f32) f32 {
    if (std.math.isNan(value)) return 1;
    return value;
}

fn floorToU32(value: f32) u32 {
    if (!std.math.isFinite(value) or value <= 0) return 0;
    const floored = @floor(value);
    if (floored >= @as(f32, @floatFromInt(std.math.maxInt(u32)))) return std.math.maxInt(u32);
    return @intFromFloat(floored);
}

fn isYogaNodeAbsolute(node: native_yoga.YGNodeRef) bool {
    return native_yoga.yogaNodeStyleGetEnum(node, @intFromEnum(native_yoga.YogaEnumKind.position_type)) ==
        @intFromEnum(native_yoga.YogaPositionType.absolute);
}
