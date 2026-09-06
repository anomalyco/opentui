const std = @import("std");

const editor_view = @import("editor-view.zig");
const native_yoga = @import("yoga.zig");
const text_buffer_view = @import("text-buffer-view.zig");
const scene = @import("scene.zig");
const buffer = @import("buffer.zig");

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
    context_owned: bool = false,
    measure_dependents: ?*?*NativeRenderable = null,
    measure_previous: ?*NativeRenderable = null,
    measure_next: ?*NativeRenderable = null,
    scene_node: ?scene.Node = null,
    surface: ?*buffer.OptimizedBuffer = null,

    pub fn init() native_yoga.Error!NativeRenderable {
        var yoga_node: native_yoga.YGNodeRef = null;
        try native_yoga.check(native_yoga.yogaNodeCreateForOpenTUIChecked(&yoga_node));
        return .{ .yoga_node = yoga_node };
    }

    pub fn initWithConfig(config: *native_yoga.Config) native_yoga.Error!NativeRenderable {
        return .{ .yoga_node = try config.createNode() };
    }

    pub fn deinit(self: *NativeRenderable) void {
        self.detachMeasure();
        native_yoga.yogaNodeFree(self.yoga_node);
        self.* = undefined;
    }

    pub fn detachMeasure(self: *NativeRenderable) void {
        native_yoga.yogaNodeSetDirtiedFunc(self.yoga_node, false);
        if (self.context_owned) {
            if (native_yoga.yogaNodeGetParent(self.yoga_node)) |parent| {
                native_yoga.yogaNodeRemoveChild(parent, self.yoga_node);
            }
        }
        self.setMeasureTarget(.none) catch unreachable;
    }

    pub fn resetForReuse(self: *NativeRenderable) bool {
        std.debug.assert(self.scene_node == null and self.surface == null);
        std.debug.assert(self.measure_target == .none and self.measure_dependents == null);
        std.debug.assert(self.measure_previous == null and self.measure_next == null);
        if (native_yoga.yogaNodeResetChecked(self.yoga_node) != .ok) return false;
        self.* = .{
            .yoga_node = self.yoga_node,
            .context_owned = true,
        };
        return true;
    }

    pub fn getYogaNode(self: *const NativeRenderable) native_yoga.YGNodeRef {
        return self.yoga_node;
    }

    pub fn setMeasureTarget(self: *NativeRenderable, target: MeasureTarget) native_yoga.Error!void {
        return self.setMeasureTargetPreservingProvider(target, false);
    }

    pub fn setMeasureTargetPreservingProvider(self: *NativeRenderable, target: MeasureTarget, preserve_provider: bool) native_yoga.Error!void {
        try native_yoga.check(if (preserve_provider) native_yoga.nodeTeardownStatus(self.yoga_node) else switch (target) {
            .none => native_yoga.yogaNodeSetNativeMeasureFunc(self.yoga_node, null, null),
            else => native_yoga.yogaNodeSetNativeMeasureFunc(self.yoga_node, self, &NativeRenderable.measure),
        });
        const invalidate = self.context_owned and (target != .none or self.measure_target != .none);
        if (self.measure_dependents) |head| {
            if (self.measure_previous) |previous| {
                previous.measure_next = self.measure_next;
            } else {
                head.* = self.measure_next;
            }
            if (self.measure_next) |next| next.measure_previous = self.measure_previous;
            self.measure_previous = null;
            self.measure_next = null;
        }
        self.measure_target = target;
        self.measure_dependents = switch (target) {
            .none => null,
            .text_buffer_view => |view| &view.measure_dependents,
            .editor_view => |view| &view.measure_dependents,
        };
        if (self.measure_dependents) |head| {
            self.measure_next = head.*;
            if (head.*) |next| next.measure_previous = self;
            head.* = self;
        }
        if (invalidate) native_yoga.yogaNodeInvalidateMeasure(self.yoga_node);
    }

    fn measure(target: ?*anyopaque, width: f32, width_mode: u32, height: f32, height_mode: u32) callconv(.c) native_yoga.ExternalYogaSize {
        _ = height_mode;
        const self: *NativeRenderable = @ptrCast(@alignCast(target orelse return .{ .width = std.math.nan(f32), .height = std.math.nan(f32) }));
        const effective_width = normalizeYogaMeasureWidthInput(width, width_mode);
        const effective_height = normalizeYogaMeasureHeightInput(height);
        const measure_width = floorToU32(effective_width);
        const measure_height = floorToU32(effective_height);
        const result = (self.measureTarget(measure_width, measure_height) catch |err| {
            native_yoga.reportMeasureError(self.yoga_node, err);
            return .{ .width = std.math.nan(f32), .height = std.math.nan(f32) };
        }) orelse return .{ .width = 1, .height = 1 };

        var measured_width: f32 = @floatFromInt(@max(@as(u32, 1), result.width_cols_max));
        var measured_height: f32 = @floatFromInt(@max(@as(u32, 1), result.line_count));

        if (width_mode == @intFromEnum(native_yoga.YogaMeasureMode.at_most) and !isYogaNodeAbsolute(self.yoga_node)) {
            measured_width = @min(effective_width, measured_width);
            measured_height = @min(effective_height, measured_height);
        }

        return .{ .width = measured_width, .height = measured_height };
    }

    fn measureTarget(self: *NativeRenderable, width: u32, height: u32) !?text_buffer_view.MeasureResult {
        return switch (self.measure_target) {
            .none => null,
            .text_buffer_view => |view| try view.measureForDimensions(width, height),
            .editor_view => |view| try view.getTextBufferView().measureForDimensions(width, height),
        };
    }
};

// Idle ownership travels between the Context pool and scene insertion/removal.
// Keeping it outside live nodes preserves their 512-byte release allocation class.
pub const NodeStorage = struct {
    node: *NativeRenderable,
    children: std.ArrayListUnmanaged(*NativeRenderable) = .empty,
    paint_children: std.ArrayListUnmanaged(*NativeRenderable) = .empty,
    reuse_web_defaults: bool = false,

    pub fn retainedBytes(self: *const NodeStorage) usize {
        return @sizeOf(NativeRenderable) + native_yoga.nodeStorageBytes(self.node.yoga_node) +
            (self.children.capacity + self.paint_children.capacity) * @sizeOf(*NativeRenderable);
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
