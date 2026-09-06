const std = @import("std");
const builtin = @import("builtin");
const c = @import("yoga");
const compatibility = @import("compatibility-context.zig");
const logger = @import("logger.zig");

pub const YGNodeRef = c.YGNodeRef;
pub const YGNodeConstRef = c.YGNodeConstRef;
pub const YGConfigRef = c.YGConfigRef;
pub const YGConfigConstRef = c.YGConfigConstRef;

pub const Status = enum(u32) {
    ok = c.OT_YOGA_OK,
    invalid_argument = c.OT_YOGA_INVALID_ARGUMENT,
    out_of_memory = c.OT_YOGA_OUT_OF_MEMORY,
    exception = c.OT_YOGA_EXCEPTION,
    poisoned = c.OT_YOGA_POISONED,
    busy = c.OT_YOGA_BUSY,
    depth_limit = c.OT_YOGA_DEPTH_LIMIT,
};

pub const Error = error{ OutOfMemory, YogaInvalidArgument, YogaException, YogaPoisoned, YogaBusy, YogaDepthLimit };

pub fn check(status: Status) Error!void {
    return switch (status) {
        .ok => {},
        .invalid_argument => error.YogaInvalidArgument,
        .out_of_memory => error.OutOfMemory,
        .exception => error.YogaException,
        .poisoned => error.YogaPoisoned,
        .busy => error.YogaBusy,
        .depth_limit => error.YogaDepthLimit,
    };
}

pub fn fromError(err: Error) Status {
    return switch (err) {
        error.OutOfMemory => .out_of_memory,
        error.YogaInvalidArgument => .invalid_argument,
        error.YogaException => .exception,
        error.YogaPoisoned => .poisoned,
        error.YogaBusy => .busy,
        error.YogaDepthLimit => .depth_limit,
    };
}

// Yoga's solve and dirty propagation recurse. Reject deeper managed trees before
// entering upstream code; failure cleanup itself is iterative at any depth.
pub const depth_max = c.OT_YOGA_DEPTH_MAX;

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

pub const YogaMeasureMode = enum(u32) {
    undefined = 0,
    exactly = 1,
    at_most = 2,
};

pub const YogaPositionType = enum(u32) {
    static = 0,
    relative = 1,
    absolute = 2,
};

pub const YogaFlexDirection = enum(u32) {
    column = 0,
    column_reverse = 1,
    row = 2,
    row_reverse = 3,
};

pub const ExternalYogaLayout = c.OTYogaLayout;

pub const ExternalYogaSize = extern struct {
    width: f32,
    height: f32,
};

const JsMeasureCallback = *const fn (?*anyopaque, f32, u32, f32, u32) callconv(.c) void;
const JsDirtiedCallback = *const fn (?*anyopaque) callconv(.c) void;
pub const NativeMeasureCallback = *const fn (?*anyopaque, f32, u32, f32, u32) callconv(.c) ExternalYogaSize;

pub const Callbacks = struct {
    user_data: ?*anyopaque = null,
    measure: ?*const fn (?*anyopaque, YGNodeConstRef, f32, u32, f32, u32) ExternalYogaSize = null,
    dirtied: ?*const fn (?*anyopaque, YGNodeConstRef) void = null,
};

/// Initialize in place: upstream Yoga retains this object's address.
pub const Config = struct {
    ref: YGConfigRef,
    allocator: std.mem.Allocator,
    callbacks: Callbacks,
    logger: ?*const logger.Logger = null,
    js_measure: ?JsMeasureCallback = null,
    js_dirtied: ?JsDirtiedCallback = null,
    measure_result: ExternalYogaSize = .{ .width = std.math.nan(f32), .height = std.math.nan(f32) },
    nodes: ?*CallbackContext = null,
    test_work_count: if (builtin.is_test) u64 else void = if (builtin.is_test) 0 else {},
    heap_owned: bool = false,

    pub fn init(self: *Config, allocator: std.mem.Allocator, callbacks: Callbacks) Error!void {
        var config: YGConfigRef = null;
        try check(@enumFromInt(c.otYogaConfigCreate(&config)));
        self.* = .{ .ref = config, .allocator = allocator, .callbacks = callbacks };
        c.YGConfigSetUseWebDefaults(config, false);
        c.YGConfigSetPointScaleFactor(config, 1);
        c.YGConfigSetContext(config, self);
    }

    pub fn deinit(self: *Config) void {
        std.debug.assert(!self.hasLiveNodes());
        c.YGConfigSetContext(self.ref, null);
        c.YGConfigFree(self.ref);
        self.* = undefined;
    }

    pub fn setLogger(self: *Config, log: *const logger.Logger) void {
        std.debug.assert(log.* == .diagnostics);
        self.logger = log;
        c.YGConfigSetLogger(self.ref, &internalLogger);
    }

    pub fn createNode(self: *Config) Error!YGNodeRef {
        const callback_context = try self.allocator.create(CallbackContext);
        errdefer self.allocator.destroy(callback_context);
        var node: YGNodeRef = null;
        try check(@enumFromInt(c.otYogaNodeCreate(self.ref, &node)));
        callback_context.* = .{ .config = self, .node = node, .config_next = self.nodes };
        if (self.nodes) |head| head.config_previous = callback_context;
        self.nodes = callback_context;
        c.YGNodeSetContext(node, callback_context);
        return node;
    }

    pub fn hasLiveNodes(self: *const Config) bool {
        return self.nodes != null;
    }
};

const CallbackContext = struct {
    config: *Config,
    config_previous: ?*CallbackContext = null,
    config_next: ?*CallbackContext = null,
    node: YGNodeRef,
    native_measure_target: ?*anyopaque = null,
    native_measure_callback: ?NativeMeasureCallback = null,
    poisoned: bool = false,
    active_root: ?*CallbackContext = null,
    measure_error: Status = .ok,
    work_next: ?*CallbackContext = null,
    depth: u32 = 0,
};

fn enumValue(value: anytype) u32 {
    return @intCast(value);
}

fn getContext(node: YGNodeConstRef) ?*CallbackContext {
    if (node == null) return null;
    const existing = c.YGNodeGetContext(node);
    if (existing) |ptr| {
        return @ptrCast(@alignCast(ptr));
    }
    return null;
}

fn nodeStatus(node: YGNodeConstRef, mutation: bool, teardown: bool) Status {
    const ctx = getContext(node) orelse return .invalid_argument;
    if (mutation and treeRoot(ctx).active_root != null) return .busy;
    if (!teardown and ctx.poisoned) return .poisoned;
    return .ok;
}

pub fn nodeTeardownStatus(node: YGNodeConstRef) Status {
    return nodeStatus(node, true, true);
}

fn configContext(ref: YGConfigConstRef) ?*Config {
    if (ref == null) return null;
    return @ptrCast(@alignCast(c.YGConfigGetContext(ref) orelse return null));
}

fn configStatus(ref: YGConfigConstRef) Status {
    const config = configContext(ref) orelse return .invalid_argument;
    // Configuration changes are rare. Check owned nodes here rather than
    // visiting every connected configuration on every cached layout call.
    var cursor = config.nodes;
    while (cursor) |ctx| : (cursor = ctx.config_next) {
        if (treeRoot(ctx).active_root != null) return .busy;
    }
    return .ok;
}

fn treeRoot(start: *CallbackContext) *CallbackContext {
    // Managed placement bounds this owner chain and rejects cycles.
    var ctx = start;
    while (true) {
        if (builtin.is_test) ctx.config.test_work_count += 1;
        const owner = c.YGNodeGetOwner(ctx.node) orelse return ctx;
        ctx = getContext(owner).?;
    }
}

// Each managed node appears once: insertion rejects cycles and shared children.
// The intrusive breadth-first list needs no storage allocation, even on failure.
fn treeList(root: YGNodeRef) *CallbackContext {
    const head = getContext(root).?;
    head.work_next = null;
    head.depth = 1;
    var tail = head;
    var cursor: ?*CallbackContext = head;
    while (cursor) |ctx| : (cursor = ctx.work_next) {
        if (builtin.is_test) ctx.config.test_work_count += 1;
        for (0..c.YGNodeGetChildCount(ctx.node)) |index| {
            const child = c.YGNodeGetChild(ctx.node, index);
            const child_ctx = getContext(child).?;
            std.debug.assert(ctx.depth < depth_max);
            child_ctx.depth = ctx.depth + 1;
            child_ctx.work_next = null;
            tail.work_next = child_ctx;
            tail = child_ctx;
        }
    }
    return head;
}

pub fn reportMeasureError(node: YGNodeConstRef, err: anyerror) void {
    const ctx = getContext(node) orelse return;
    const root = treeRoot(ctx).active_root orelse return;
    if (root.measure_error == .ok) {
        root.measure_error = if (err == error.OutOfMemory) .out_of_memory else .exception;
    }
}

fn internalMeasureFunc(
    node: YGNodeConstRef,
    width: f32,
    width_mode: c.YGMeasureMode,
    height: f32,
    height_mode: c.YGMeasureMode,
) callconv(.c) c.YGSize {
    if (getConfigContext(node)) |config| {
        if (config.js_measure) |callback| {
            // A failing host callback leaves NaNs, Yoga's existing unspecified
            // size fallback. The host reports the failure after Yoga returns.
            config.measure_result = .{ .width = std.math.nan(f32), .height = std.math.nan(f32) };
            callback(@ptrCast(@constCast(node)), width, enumValue(width_mode), height, enumValue(height_mode));
            return .{ .width = config.measure_result.width, .height = config.measure_result.height };
        }
        if (config.callbacks.measure) |callback| {
            const size = callback(config.callbacks.user_data, node, width, enumValue(width_mode), height, enumValue(height_mode));
            return .{ .width = size.width, .height = size.height };
        }
    }
    return .{ .width = std.math.nan(f32), .height = std.math.nan(f32) };
}

fn internalNativeMeasureFunc(
    node: YGNodeConstRef,
    width: f32,
    width_mode: c.YGMeasureMode,
    height: f32,
    height_mode: c.YGMeasureMode,
) callconv(.c) c.YGSize {
    // Hot native renderables measure entirely in Zig: Yoga -> native renderable
    // -> native text/editor view. This is separate from the JS callback path.
    if (getContext(node)) |ctx| {
        if (ctx.native_measure_callback) |callback| {
            const size = callback(
                ctx.native_measure_target,
                width,
                enumValue(width_mode),
                height,
                enumValue(height_mode),
            );
            return .{ .width = size.width, .height = size.height };
        }
    }

    return .{ .width = std.math.nan(f32), .height = std.math.nan(f32) };
}

fn internalDirtiedFunc(node: YGNodeConstRef) callconv(.c) void {
    if (getConfigContext(node)) |config| {
        if (config.js_dirtied) |callback| {
            callback(@ptrCast(@constCast(node)));
            return;
        }
        if (config.callbacks.dirtied) |callback| callback(config.callbacks.user_data, node);
    }
}

fn getConfigContext(node: YGNodeConstRef) ?*Config {
    return (getContext(node) orelse return null).config;
}

// va_list is a pointer on some targets and a value on others. Use the translated
// callback parameter, not the typedef before C's array-to-pointer adjustment.
const LogArgs = @typeInfo(@typeInfo(@typeInfo(c.YGLogger).optional.child).pointer.child).@"fn".params[4].type.?;

fn internalLogger(ref: YGConfigConstRef, _: YGNodeConstRef, level: c.YGLogLevel, format: [*c]const u8, args: LogArgs) callconv(.c) c_int {
    const config = configContext(ref) orelse return 0;
    const log = config.logger orelse return 0;
    // Never enter a host callback from Yoga's C++ logger, even if a caller
    // replaces the context's borrowed logger after initialization.
    if (log.* != .diagnostics) return 0;
    var message: [c.OT_YOGA_LOG_BUFFER_SIZE]u8 = undefined;
    const length = c.otYogaFormatLog(&message, message.len, format, args);
    if (length < 0) {
        log.err("Yoga: Log formatting failed", .{});
        return length;
    }
    const severity: logger.LogLevel = switch (level) {
        c.YGLogLevelError, c.YGLogLevelFatal => .err,
        c.YGLogLevelWarn => .warn,
        c.YGLogLevelInfo => .info,
        else => .debug,
    };
    comptime std.debug.assert(logger.Diagnostic.message_bytes_max == c.OT_YOGA_LOG_BUFFER_SIZE);
    // The prefix makes the diagnostic's message capacity smaller than the C
    // buffer's. The sink therefore also flags any C-side truncation.
    const copied = @min(@as(u32, @intCast(length)), message.len - 1);
    log.logMessage(severity, "Yoga: {s}", .{message[0..copied]});
    return length;
}

pub export fn yogaConfigCreate() YGConfigRef {
    var out: YGConfigRef = null;
    _ = yogaConfigCreateChecked(&out);
    return out;
}

pub export fn yogaConfigCreateChecked(out: ?*YGConfigRef) Status {
    const result = out orelse return .invalid_argument;
    const config = std.heap.c_allocator.create(Config) catch return .out_of_memory;
    config.init(std.heap.c_allocator, .{}) catch |err| {
        std.heap.c_allocator.destroy(config);
        return fromError(err);
    };
    config.heap_owned = true;
    result.* = config.ref;
    return .ok;
}

pub export fn yogaConfigFree(ref: YGConfigRef) bool {
    return yogaConfigFreeChecked(ref) == .ok;
}

pub export fn yogaConfigFreeChecked(ref: YGConfigRef) Status {
    const config = configContext(ref) orelse return .invalid_argument;
    if (!config.heap_owned) return .invalid_argument;
    if (config.hasLiveNodes()) return .busy;
    const allocator = config.allocator;
    config.deinit();
    allocator.destroy(config);
    return .ok;
}

export fn yogaConfigSetUseWebDefaults(config: YGConfigRef, enabled: bool) void {
    _ = yogaConfigSetUseWebDefaultsChecked(config, @intFromBool(enabled));
}

pub export fn yogaConfigSetUseWebDefaultsChecked(config: YGConfigRef, enabled: u32) Status {
    const status = configStatus(config);
    if (status != .ok) return status;
    if (enabled > 1) return .invalid_argument;
    c.YGConfigSetUseWebDefaults(config, enabled != 0);
    return .ok;
}

pub export fn yogaConfigGetUseWebDefaults(config: YGConfigConstRef) bool {
    return c.YGConfigGetUseWebDefaults(config);
}

export fn yogaConfigSetPointScaleFactor(config: YGConfigRef, point_scale_factor: f32) void {
    _ = yogaConfigSetPointScaleFactorChecked(config, point_scale_factor);
}

pub export fn yogaConfigSetPointScaleFactorChecked(config: YGConfigRef, point_scale_factor: f32) Status {
    const status = configStatus(config);
    if (status != .ok) return status;
    if (!std.math.isFinite(point_scale_factor) or point_scale_factor < 0) return .invalid_argument;
    c.YGConfigSetPointScaleFactor(config, point_scale_factor);
    return .ok;
}

pub export fn yogaConfigGetPointScaleFactor(config: YGConfigConstRef) f32 {
    return c.YGConfigGetPointScaleFactor(config);
}

export fn yogaConfigSetErrata(config: YGConfigRef, errata: u32) void {
    _ = yogaConfigSetErrataChecked(config, errata);
}

pub export fn yogaConfigSetErrataChecked(config: YGConfigRef, errata: u32) Status {
    const status = configStatus(config);
    if (status != .ok) return status;
    if (errata > 7 and errata != c.YGErrataAll and errata != c.YGErrataClassic) return .invalid_argument;
    c.YGConfigSetErrata(config, @intCast(errata));
    return .ok;
}

export fn yogaConfigGetErrata(config: YGConfigConstRef) u32 {
    return enumValue(c.YGConfigGetErrata(config));
}

export fn yogaConfigSetExperimentalFeatureEnabled(config: YGConfigRef, feature: u32, enabled: bool) void {
    _ = yogaConfigSetExperimentalFeatureEnabledChecked(config, feature, @intFromBool(enabled));
}

pub export fn yogaConfigSetExperimentalFeatureEnabledChecked(config: YGConfigRef, feature: u32, enabled: u32) Status {
    const status = configStatus(config);
    if (status != .ok) return status;
    if (feature > c.YGExperimentalFeatureWebFlexBasis or enabled > 1) return .invalid_argument;
    c.YGConfigSetExperimentalFeatureEnabled(config, @intCast(feature), enabled != 0);
    return .ok;
}

export fn yogaConfigIsExperimentalFeatureEnabled(config: YGConfigConstRef, feature: u32) bool {
    var out: u32 = 0;
    _ = yogaConfigIsExperimentalFeatureEnabledChecked(config, feature, &out);
    return out != 0;
}

pub export fn yogaConfigIsExperimentalFeatureEnabledChecked(config: YGConfigConstRef, feature: u32, out: ?*u32) Status {
    if (configContext(config) == null or out == null or feature > c.YGExperimentalFeatureWebFlexBasis) return .invalid_argument;
    out.?.* = @intFromBool(c.YGConfigIsExperimentalFeatureEnabled(config, @intCast(feature)));
    return .ok;
}

pub export fn yogaNodeCreate() YGNodeRef {
    return yogaNodeCreateForOpenTUI();
}

pub export fn yogaNodeCreateForOpenTUI() YGNodeRef {
    var out: YGNodeRef = null;
    _ = yogaNodeCreateForOpenTUIChecked(&out);
    return out;
}

pub export fn yogaNodeCreateForOpenTUIChecked(out: ?*YGNodeRef) Status {
    const result = out orelse return .invalid_argument;
    const config = compatibility.compatDefault.getYogaConfig() catch |err| return fromError(err);
    result.* = config.createNode() catch |err| return fromError(err);
    return .ok;
}

pub export fn yogaNodeCreateWithConfig(ref: YGConfigConstRef) YGNodeRef {
    var out: YGNodeRef = null;
    _ = yogaNodeCreateWithConfigChecked(ref, &out);
    return out;
}

pub export fn yogaNodeCreateWithConfigChecked(ref: YGConfigConstRef, out: ?*YGNodeRef) Status {
    const config = configContext(ref) orelse return .invalid_argument;
    const result = out orelse return .invalid_argument;
    result.* = config.createNode() catch |err| return fromError(err);
    return .ok;
}

pub export fn yogaNodeFree(node: YGNodeRef) void {
    _ = yogaNodeFreeChecked(node);
}

pub export fn yogaNodeFreeChecked(node: YGNodeRef) Status {
    const status = nodeStatus(node, true, true);
    if (status != .ok) return status;
    const ctx = getContext(node).?;
    const config = ctx.config;
    const result: Status = @enumFromInt(c.otYogaNodeFree(node));
    if (result != .ok) return result;
    if (ctx.config_previous) |previous| {
        previous.config_next = ctx.config_next;
    } else {
        config.nodes = ctx.config_next;
    }
    if (ctx.config_next) |next| next.config_previous = ctx.config_previous;
    config.allocator.destroy(ctx);
    return .ok;
}

pub export fn yogaNodeFreeRecursive(node: YGNodeRef) void {
    _ = yogaNodeFreeRecursiveChecked(node);
}

pub export fn yogaNodeFreeRecursiveChecked(node: YGNodeRef) Status {
    const status = nodeStatus(node, true, true);
    if (status != .ok) return status;
    var cursor: ?*CallbackContext = getContext(node).?;
    cursor.?.work_next = null;
    cursor.?.depth = 0;
    var retired: ?*CallbackContext = null;
    while (cursor) |ctx| {
        // Keep Yoga's first-child teardown order and shared-child skip. Managed
        // insertion excludes shared/unmanaged children; raw Yoga graphs are not
        // part of this wrapper's ownership contract.
        if (c.YGNodeGetChildCount(ctx.node) > ctx.depth) {
            const child = c.YGNodeGetChild(ctx.node, ctx.depth);
            if (c.YGNodeGetOwner(child) != ctx.node) {
                ctx.depth += 1;
                continue;
            }
            const child_ctx = getContext(child) orelse return .invalid_argument;
            const result = yogaNodeRemoveChildChecked(ctx.node, child);
            if (result != .ok) return result;
            child_ctx.work_next = ctx;
            child_ctx.depth = 0;
            cursor = child_ctx;
        } else {
            const parent = ctx.work_next;
            ctx.work_next = retired;
            retired = ctx;
            cursor = parent;
        }
    }
    // Dirtied callbacks may read any retained subtree wrapper. Keep every node
    // alive until all child-removal callbacks have returned.
    while (retired) |ctx| {
        const next = ctx.work_next;
        const result = yogaNodeFreeChecked(ctx.node);
        if (result != .ok) return result;
        retired = next;
    }
    return .ok;
}

export fn yogaNodeReset(node: YGNodeRef) void {
    _ = yogaNodeResetChecked(node);
}

pub export fn yogaNodeResetChecked(node: YGNodeRef) Status {
    const status = nodeStatus(node, true, false);
    if (status != .ok) return status;
    const ctx = getContext(node).?;
    const result: Status = @enumFromInt(c.otYogaNodeReset(node));
    // Yoga clears its context on reset. The preallocated callback state belongs
    // to this wrapper for the node's full lifetime, including a failed reset.
    c.YGNodeSetContext(node, ctx);
    if (result == .ok) {
        ctx.* = .{
            .config = ctx.config,
            .node = node,
            .config_previous = ctx.config_previous,
            .config_next = ctx.config_next,
        };
    }
    return result;
}

pub fn nodeStorageBytes(node: YGNodeConstRef) usize {
    return @as(usize, @intCast(c.otYogaNodeStorageBytes(node))) + @sizeOf(CallbackContext);
}

export fn yogaNodeCopyStyle(dst_node: YGNodeRef, src_node: YGNodeConstRef) void {
    _ = yogaNodeCopyStyleChecked(dst_node, src_node);
}

pub export fn yogaNodeCopyStyleChecked(dst_node: YGNodeRef, src_node: YGNodeConstRef) Status {
    const dst = nodeStatus(dst_node, true, false);
    if (dst != .ok) return dst;
    const src = nodeStatus(src_node, false, false);
    if (src != .ok) return src;
    return @enumFromInt(c.otYogaNodeCopyStyle(dst_node, src_node));
}

pub export fn yogaNodeInsertChild(node: YGNodeRef, child: YGNodeRef, index: u32) void {
    _ = yogaNodeInsertChildChecked(node, child, index);
}

pub export fn yogaNodeInsertChildChecked(node: YGNodeRef, child: YGNodeRef, index: u32) Status {
    const status = placementStatus(node, child, index, false);
    if (status != .ok) return status;
    return @enumFromInt(c.otYogaNodeInsertChild(node, child, index));
}

pub export fn yogaNodeMoveChildChecked(parent: YGNodeRef, child: YGNodeRef, final_index: u32) Status {
    const status = placementStatus(parent, child, final_index, true);
    if (status != .ok) return status;
    // The bridge retains both ancestor paths until all dirtied callbacks return.
    const source = treeRoot(getContext(child).?);
    const destination = treeRoot(getContext(parent).?);
    source.active_root = source;
    destination.active_root = destination;
    defer source.active_root = null;
    defer destination.active_root = null;
    return @enumFromInt(c.otYogaNodeMoveChild(parent, child, final_index));
}

fn placementStatus(node: YGNodeRef, child: YGNodeRef, index: u32, moving: bool) Status {
    const status = nodeStatus(node, true, false);
    if (status != .ok) return status;
    const child_status = nodeStatus(child, true, false);
    if (child_status != .ok) return child_status;
    const previous = c.YGNodeGetOwner(child);
    if (!moving and previous != null) return .invalid_argument;
    if (previous != null) {
        const previous_status = nodeStatus(previous, true, false);
        if (previous_status != .ok) return previous_status;
    }
    const count = c.YGNodeGetChildCount(node);
    if (previous == node and count == 0) return .invalid_argument;
    if (index > count - @intFromBool(previous == node) or c.YGNodeHasMeasureFunc(node)) return .invalid_argument;
    var parent = node;
    var depth: u32 = 0;
    while (parent != null) : (parent = c.YGNodeGetOwner(parent)) {
        if (parent == child) return .invalid_argument;
        depth += 1;
        if (depth >= depth_max) return .depth_limit;
    }
    var cursor: ?*CallbackContext = treeList(child);
    while (cursor) |ctx| : (cursor = ctx.work_next) {
        if (depth + ctx.depth > depth_max) return .depth_limit;
    }
    return .ok;
}

pub export fn yogaNodeRemoveChild(node: YGNodeRef, child: YGNodeRef) void {
    _ = yogaNodeRemoveChildChecked(node, child);
}

pub export fn yogaNodeRemoveChildChecked(node: YGNodeRef, child: YGNodeRef) Status {
    const status = nodeStatus(node, true, true);
    if (status != .ok) return status;
    const child_status = nodeStatus(child, true, true);
    if (child_status != .ok) return child_status;
    return @enumFromInt(c.otYogaNodeRemoveChild(node, child));
}

export fn yogaNodeRemoveAllChildren(node: YGNodeRef) void {
    _ = yogaNodeRemoveAllChildrenChecked(node);
}

pub export fn yogaNodeRemoveAllChildrenChecked(node: YGNodeRef) Status {
    const status = nodeStatus(node, true, true);
    if (status != .ok) return status;
    return @enumFromInt(c.otYogaNodeRemoveAllChildren(node));
}

export fn yogaNodeGetChild(node: YGNodeRef, index: u32) YGNodeRef {
    var out: YGNodeRef = null;
    _ = yogaNodeGetChildChecked(node, index, &out);
    return out;
}

pub export fn yogaNodeGetChildChecked(node: YGNodeRef, index: u32, out: ?*YGNodeRef) Status {
    if (getContext(node) == null or out == null) return .invalid_argument;
    out.?.* = if (index < c.YGNodeGetChildCount(node)) c.YGNodeGetChild(node, index) else null;
    return .ok;
}

export fn yogaNodeGetChildCount(node: YGNodeConstRef) u32 {
    return @intCast(c.YGNodeGetChildCount(node));
}

pub export fn yogaNodeGetParent(node: YGNodeRef) YGNodeRef {
    return c.YGNodeGetParent(node);
}

pub export fn yogaNodeCalculateLayout(node: YGNodeRef, width: f32, height: f32, direction: u32) void {
    _ = yogaNodeCalculateLayoutChecked(node, width, height, direction);
}

pub export fn yogaNodeCalculateLayoutChecked(node: YGNodeRef, width: f32, height: f32, direction: u32) Status {
    const root = getContext(node) orelse return .invalid_argument;
    const top = treeRoot(root);
    if (top.active_root != null) return .busy;
    if (root.poisoned) return .poisoned;
    if (direction > c.YGDirectionRTL) return .invalid_argument;
    for ([_]f32{ width, height }) |dimension| {
        if (!std.math.isNan(dimension) and (!std.math.isFinite(dimension) or dimension < 0)) return .invalid_argument;
    }
    root.measure_error = .ok;
    top.active_root = root;
    var result: Status = @enumFromInt(c.otYogaNodeCalculateLayout(node, width, height, direction));
    if (result == .ok) result = root.measure_error;
    if (result != .ok) {
        // Interrupted solves and failed native measurement can leave partially
        // updated caches. Only teardown is safe, not a retry with stale geometry.
        var cursor: ?*CallbackContext = treeList(top.node);
        while (cursor) |ctx| : (cursor = ctx.work_next) {
            if (builtin.is_test) ctx.config.test_work_count += 1;
            ctx.poisoned = true;
        }
    }
    top.active_root = null;
    root.measure_error = .ok;
    return result;
}

export fn yogaNodeIsDirty(node: YGNodeConstRef) bool {
    var out: u32 = 0;
    _ = yogaNodeIsDirtyChecked(node, &out);
    return out != 0;
}

pub export fn yogaNodeIsDirtyChecked(node: YGNodeConstRef, out: ?*u32) Status {
    const status = nodeStatus(node, false, false);
    if (status != .ok) return status;
    const result = out orelse return .invalid_argument;
    result.* = @intFromBool(c.YGNodeIsDirty(node));
    return .ok;
}

pub export fn yogaNodeMarkDirty(node: YGNodeRef) void {
    _ = yogaNodeMarkDirtyChecked(node);
}

pub export fn yogaNodeMarkDirtyChecked(node: YGNodeRef) Status {
    const status = nodeStatus(node, true, false);
    if (status != .ok) return status;
    return @enumFromInt(c.otYogaNodeMarkDirty(node));
}

export fn yogaNodeGetHasNewLayout(node: YGNodeConstRef) bool {
    var out: u32 = 0;
    _ = yogaNodeGetHasNewLayoutChecked(node, &out);
    return out != 0;
}

pub export fn yogaNodeGetHasNewLayoutChecked(node: YGNodeConstRef, out: ?*u32) Status {
    const status = nodeStatus(node, false, false);
    if (status != .ok) return status;
    const result = out orelse return .invalid_argument;
    result.* = @intFromBool(c.YGNodeGetHasNewLayout(node));
    return .ok;
}

export fn yogaNodeSetHasNewLayout(node: YGNodeRef, has_new_layout: bool) void {
    _ = yogaNodeSetHasNewLayoutChecked(node, @intFromBool(has_new_layout));
}

pub export fn yogaNodeSetHasNewLayoutChecked(node: YGNodeRef, value: u32) Status {
    const status = nodeStatus(node, true, false);
    if (status != .ok) return status;
    return @enumFromInt(c.otYogaNodeSetFlag(node, 0, value));
}

export fn yogaNodeSetIsReferenceBaseline(node: YGNodeRef, is_reference_baseline: bool) void {
    _ = yogaNodeSetIsReferenceBaselineChecked(node, @intFromBool(is_reference_baseline));
}

pub export fn yogaNodeSetIsReferenceBaselineChecked(node: YGNodeRef, value: u32) Status {
    const status = nodeStatus(node, true, false);
    if (status != .ok) return status;
    return @enumFromInt(c.otYogaNodeSetFlag(node, 1, value));
}

export fn yogaNodeIsReferenceBaseline(node: YGNodeConstRef) bool {
    var out: u32 = 0;
    _ = yogaNodeIsReferenceBaselineChecked(node, &out);
    return out != 0;
}

pub export fn yogaNodeIsReferenceBaselineChecked(node: YGNodeConstRef, out: ?*u32) Status {
    const status = nodeStatus(node, false, false);
    if (status != .ok) return status;
    const result = out orelse return .invalid_argument;
    result.* = @intFromBool(c.YGNodeIsReferenceBaseline(node));
    return .ok;
}

export fn yogaNodeSetAlwaysFormsContainingBlock(node: YGNodeRef, always_forms_containing_block: bool) void {
    _ = yogaNodeSetAlwaysFormsContainingBlockChecked(node, @intFromBool(always_forms_containing_block));
}

pub export fn yogaNodeSetAlwaysFormsContainingBlockChecked(node: YGNodeRef, value: u32) Status {
    const status = nodeStatus(node, true, false);
    if (status != .ok) return status;
    return @enumFromInt(c.otYogaNodeSetFlag(node, 2, value));
}

export fn yogaNodeGetAlwaysFormsContainingBlock(node: YGNodeConstRef) bool {
    var out: u32 = 0;
    _ = yogaNodeGetAlwaysFormsContainingBlockChecked(node, &out);
    return out != 0;
}

pub export fn yogaNodeGetAlwaysFormsContainingBlockChecked(node: YGNodeConstRef, out: ?*u32) Status {
    const status = nodeStatus(node, false, false);
    if (status != .ok) return status;
    const result = out orelse return .invalid_argument;
    result.* = @intFromBool(c.YGNodeGetAlwaysFormsContainingBlock(node));
    return .ok;
}

pub export fn yogaNodeGetComputedLayout(node: YGNodeConstRef, out_ptr: *ExternalYogaLayout) void {
    if (yogaNodeGetComputedLayoutChecked(node, out_ptr) != .ok) {
        out_ptr.* = .{ .left = std.math.nan(f32), .top = std.math.nan(f32), .right = std.math.nan(f32), .bottom = std.math.nan(f32), .width = std.math.nan(f32), .height = std.math.nan(f32) };
    }
}

pub export fn yogaNodeGetComputedLayoutChecked(node: YGNodeConstRef, out: ?*ExternalYogaLayout) Status {
    const status = nodeStatus(node, false, false);
    if (status != .ok) return status;
    return @enumFromInt(c.otYogaNodeGetComputedLayout(node, out));
}

export fn yogaNodeLayoutGetEdge(node: YGNodeConstRef, kind: u32, edge: u32) f32 {
    var out = std.math.nan(f32);
    _ = yogaNodeLayoutGetEdgeChecked(node, kind, edge, &out);
    return out;
}

pub export fn yogaNodeLayoutGetEdgeChecked(node: YGNodeConstRef, kind: u32, edge: u32, out: ?*f32) Status {
    const status = nodeStatus(node, false, false);
    if (status != .ok) return status;
    return @enumFromInt(c.otYogaNodeLayoutGetEdge(node, kind, edge, out));
}

pub export fn yogaNodeStyleSetEnum(node: YGNodeRef, kind: u32, value: u32) void {
    _ = yogaNodeStyleSetEnumChecked(node, kind, value);
}

pub export fn yogaNodeStyleSetEnumChecked(node: YGNodeRef, kind: u32, value: u32) Status {
    const status = nodeStatus(node, true, false);
    if (status != .ok) return status;
    return @enumFromInt(c.otYogaNodeStyleSetEnum(node, kind, value));
}

pub export fn yogaNodeStyleGetEnum(node: YGNodeConstRef, kind: u32) u32 {
    var out: u32 = 0;
    _ = yogaNodeStyleGetEnumChecked(node, kind, &out);
    return out;
}

pub export fn yogaNodeStyleGetEnumChecked(node: YGNodeConstRef, kind: u32, out: ?*u32) Status {
    const status = nodeStatus(node, false, false);
    if (status != .ok) return status;
    return @enumFromInt(c.otYogaNodeStyleGetEnum(node, kind, out));
}

pub export fn yogaNodeStyleSetFloat(node: YGNodeRef, kind: u32, value: f32) void {
    _ = yogaNodeStyleSetFloatChecked(node, kind, value);
}

pub export fn yogaNodeStyleSetFloatChecked(node: YGNodeRef, kind: u32, value: f32) Status {
    const status = nodeStatus(node, true, false);
    if (status != .ok) return status;
    return @enumFromInt(c.otYogaNodeStyleSetFloat(node, kind, value));
}

export fn yogaNodeStyleGetFloat(node: YGNodeConstRef, kind: u32) f32 {
    var out = std.math.nan(f32);
    _ = yogaNodeStyleGetFloatChecked(node, kind, &out);
    return out;
}

pub export fn yogaNodeStyleGetFloatChecked(node: YGNodeConstRef, kind: u32, out: ?*f32) Status {
    const status = nodeStatus(node, false, false);
    if (status != .ok) return status;
    return @enumFromInt(c.otYogaNodeStyleGetFloat(node, kind, out));
}

export fn yogaNodeStyleSetBorder(node: YGNodeRef, edge: u32, border: f32) void {
    _ = yogaNodeStyleSetBorderChecked(node, edge, border);
}

pub export fn yogaNodeStyleSetBorderChecked(node: YGNodeRef, edge: u32, border: f32) Status {
    const status = nodeStatus(node, true, false);
    if (status != .ok) return status;
    return @enumFromInt(c.otYogaNodeStyleSetBorder(node, edge, border));
}

export fn yogaNodeStyleGetBorder(node: YGNodeConstRef, edge: u32) f32 {
    var out = std.math.nan(f32);
    _ = yogaNodeStyleGetBorderChecked(node, edge, &out);
    return out;
}

pub export fn yogaNodeStyleGetBorderChecked(node: YGNodeConstRef, edge: u32, out: ?*f32) Status {
    const status = nodeStatus(node, false, false);
    if (status != .ok) return status;
    return @enumFromInt(c.otYogaNodeStyleGetBorder(node, edge, out));
}

pub export fn yogaNodeStyleSetValue(node: YGNodeRef, kind: u32, edge_or_gutter: u32, unit: u32, value: f32) void {
    _ = yogaNodeStyleSetValueChecked(node, kind, edge_or_gutter, unit, value);
}

pub export fn yogaNodeStyleSetValueChecked(node: YGNodeRef, kind: u32, edge_or_gutter: u32, unit: u32, value: f32) Status {
    const status = nodeStatus(node, true, false);
    if (status != .ok) return status;
    return @enumFromInt(c.otYogaNodeStyleSetValue(node, kind, edge_or_gutter, unit, value));
}

pub export fn yogaNodeStyleSetDimensionChecked(node: YGNodeRef, kind: u32, unit: u32, value: f32, disable_flex_shrink: u32) Status {
    const status = nodeStatus(node, true, false);
    if (status != .ok) return status;
    return @enumFromInt(c.otYogaNodeStyleSetDimension(node, kind, unit, value, disable_flex_shrink));
}

pub export fn yogaNodeStyleSetPositionsChecked(node: YGNodeRef, edge_mask: u32, units: ?*const [4]u32, values: ?*const [4]f32) Status {
    const status = nodeStatus(node, true, false);
    if (status != .ok) return status;
    if (units == null or values == null) return .invalid_argument;
    return @enumFromInt(c.otYogaNodeStyleSetPositions(node, edge_mask, units.?, values.?));
}

pub export fn yogaNodeStyleGetValue(node: YGNodeConstRef, kind: u32, edge_or_gutter: u32) u64 {
    var out: u64 = @as(u64, @as(u32, @bitCast(std.math.nan(f32)))) << 32;
    _ = yogaNodeStyleGetValueChecked(node, kind, edge_or_gutter, &out);
    return out;
}

pub export fn yogaNodeStyleGetValueChecked(node: YGNodeConstRef, kind: u32, edge_or_gutter: u32, out: ?*u64) Status {
    const status = nodeStatus(node, false, false);
    if (status != .ok) return status;
    return @enumFromInt(c.otYogaNodeStyleGetValue(node, kind, edge_or_gutter, out));
}

pub export fn yogaConfigSetCallbacks(ref: YGConfigConstRef, measure: JsMeasureCallback, dirtied: JsDirtiedCallback) bool {
    if (configStatus(ref) != .ok) return false;
    const config = configContext(ref).?;
    // The measure trampoline is also the owner's identity. A second facade
    // cannot steal a compatibility config or clear another facade's callbacks.
    if (config.js_measure != null and config.js_measure != measure) return false;
    config.js_measure = measure;
    config.js_dirtied = dirtied;
    return true;
}

pub export fn yogaConfigClearCallbacks(ref: YGConfigConstRef, measure: JsMeasureCallback) bool {
    if (configStatus(ref) != .ok) return false;
    const config = configContext(ref).?;
    if (config.js_measure != measure) return false;
    config.js_measure = null;
    config.js_dirtied = null;
    return true;
}

pub export fn yogaNodeSetMeasureFunc(node: YGNodeRef, enabled: bool) void {
    _ = yogaNodeSetMeasureFuncChecked(node, @intFromBool(enabled));
}

pub export fn yogaNodeSetMeasureFuncChecked(node: YGNodeRef, enabled: u32) Status {
    if (enabled > 1) return .invalid_argument;
    const status = nodeStatus(node, true, enabled == 0);
    if (status != .ok) return status;
    return @enumFromInt(c.otYogaNodeSetMeasureFunc(node, if (enabled != 0) &internalMeasureFunc else null));
}

pub fn yogaNodeSetNativeMeasureFunc(node: YGNodeRef, target: ?*anyopaque, callback: ?NativeMeasureCallback) Status {
    if ((target == null) != (callback == null)) return .invalid_argument;
    const enabled = target != null;
    const status = nodeStatus(node, true, !enabled);
    if (status != .ok) return status;
    const ctx = getContext(node).?;
    const result: Status = @enumFromInt(c.otYogaNodeSetMeasureFunc(node, if (enabled) &internalNativeMeasureFunc else null));
    if (result != .ok) return result;
    ctx.native_measure_target = target;
    ctx.native_measure_callback = callback;
    return .ok;
}

pub fn yogaNodeInvalidateMeasure(node: YGNodeRef) void {
    // Called after accepted provider/link changes, including removal after a
    // public unset/reset. No public manual-mark-dirty precondition applies.
    if (!getContext(node).?.poisoned) c.otYogaNodeInvalidateMeasure(node);
}

export fn yogaNodeUnsetMeasureFunc(node: YGNodeRef) void {
    _ = yogaNodeUnsetMeasureFuncChecked(node);
}

pub export fn yogaNodeUnsetMeasureFuncChecked(node: YGNodeRef) Status {
    return yogaNodeSetMeasureFuncChecked(node, 0);
}

pub export fn yogaNodeHasMeasureFunc(node: YGNodeConstRef) bool {
    return c.YGNodeHasMeasureFunc(node);
}

pub export fn yogaNodeSetDirtiedFunc(node: YGNodeRef, enabled: bool) void {
    _ = yogaNodeSetDirtiedFuncChecked(node, @intFromBool(enabled));
}

pub export fn yogaNodeSetDirtiedFuncChecked(node: YGNodeRef, enabled: u32) Status {
    if (enabled > 1) return .invalid_argument;
    const status = nodeStatus(node, true, enabled == 0);
    if (status != .ok) return status;
    c.YGNodeSetDirtiedFunc(node, if (enabled != 0) &internalDirtiedFunc else null);
    return .ok;
}

export fn yogaNodeUnsetDirtiedFunc(node: YGNodeRef) void {
    _ = yogaNodeUnsetDirtiedFuncChecked(node);
}

pub export fn yogaNodeUnsetDirtiedFuncChecked(node: YGNodeRef) Status {
    return yogaNodeSetDirtiedFuncChecked(node, 0);
}

pub export fn yogaStoreMeasureResult(ref: YGConfigConstRef, width: f32, height: f32) void {
    const config = configContext(ref) orelse return;
    config.measure_result = .{ .width = width, .height = height };
}

pub export fn yogaNodeGetConfig(node: YGNodeRef) YGConfigConstRef {
    return c.YGNodeGetConfig(node);
}

pub fn yogaNodeHasContext(node: YGNodeConstRef) bool {
    return getContext(node) != null;
}

pub const testFailAfter = c.otYogaTestFailAfter;
pub const testAllocationCount = c.otYogaTestAllocationCount;
pub const testContentsChildCount = c.otYogaTestContentsChildCount;
pub const testLogMessage = c.otYogaTestLogMessage;
