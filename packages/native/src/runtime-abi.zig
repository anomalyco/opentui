const std = @import("std");
const build_options = @import("build_options");
const logger = @import("logger.zig");
const compat = &@import("compatibility-context.zig").compatDefault;

pub const std_options: std.Options = .{
    .log_level = .debug,
    .logFn = handleStdLog,
};

fn handleStdLog(
    comptime message_level: std.log.Level,
    comptime scope: @EnumLiteral(),
    comptime format: []const u8,
    args: anytype,
) void {
    const ghostty_scope = switch (scope) {
        .parser,
        .stream,
        .stream_terminal,
        .screen,
        .terminal,
        .terminal_mem,
        .terminal_apc,
        .terminal_dcs,
        .osc,
        .osc_color,
        .osc_iterm2,
        .kitty_gfx,
        .key_encode,
        .mouse_encode,
        .render_state_c,
        => true,
        else => false,
    };
    if (!ghostty_scope) return;
    const configured = ghosttyLogLevel() orelse return;
    if (@intFromEnum(message_level) > @intFromEnum(configured)) return;

    const level: logger.LogLevel = switch (message_level) {
        .err => .err,
        .warn => .warn,
        .info => .info,
        .debug => .debug,
    };
    logger.logMessage(level, "(" ++ @tagName(scope) ++ ") " ++ format, args);
}

fn ghosttyLogLevel() ?std.log.Level {
    const Environment = struct {
        extern "c" fn getenv(name: [*:0]const u8) ?[*:0]const u8;
    };
    const value = std.mem.span(Environment.getenv("OTUI_GHOSTTY_LOG_LEVEL") orelse return null);
    if (std.ascii.eqlIgnoreCase(value, "error") or std.ascii.eqlIgnoreCase(value, "err")) return .err;
    if (std.ascii.eqlIgnoreCase(value, "warning") or std.ascii.eqlIgnoreCase(value, "warn")) return .warn;
    if (std.ascii.eqlIgnoreCase(value, "info")) return .info;
    if (std.ascii.eqlIgnoreCase(value, "debug")) return .debug;
    return null;
}

export fn setLogCallback(callback: ?*const fn (level: u8, msgPtr: [*]const u8, msgLen: u32) callconv(.c) void) void {
    logger.setLogCallback(callback);
}

pub const ExternalBuildOptions = extern struct {
    gpa_safe_stats: bool,
    gpa_memory_limit_tracking: bool,
};

pub const ExternalAllocatorStats = extern struct {
    total_requested_bytes: u64,
    active_allocations: u64,
    small_allocations: u64,
    large_allocations: u64,
    requested_bytes_valid: bool,
};

fn toNonNegativeU64(value: anytype) u64 {
    const ValueType = @TypeOf(value);

    return switch (@typeInfo(ValueType)) {
        .int => |int_info| if (int_info.signedness == .signed) blk: {
            const signed_value: i64 = @intCast(value);
            if (signed_value <= 0) break :blk 0;
            break :blk @intCast(signed_value);
        } else @intCast(value),
        .comptime_int => blk: {
            if (value <= 0) break :blk 0;
            break :blk @intCast(value);
        },
        else => 0,
    };
}

const RequestedBytesInfo = struct {
    bytes: u64,
    valid: bool,
};

fn sanitizeRequestedBytes(value: u64) RequestedBytesInfo {
    const signed_value: i64 = @bitCast(value);
    if (signed_value < 0) {
        return .{ .bytes = 0, .valid = false };
    }

    return .{ .bytes = @intCast(signed_value), .valid = true };
}

fn queryStatsField(comptime field_names: []const []const u8) ?u64 {
    if (!@hasDecl(@TypeOf(compat.gpa), "queryStats")) {
        return null;
    }

    const stats = compat.gpa.queryStats();
    const StatsType = @TypeOf(stats);

    inline for (field_names) |field_name| {
        if (@hasField(StatsType, field_name)) {
            return toNonNegativeU64(@field(stats, field_name));
        }
    }

    return null;
}

fn getTotalRequestedBytesInfo() RequestedBytesInfo {
    if (!build_options.gpa_safe_stats) {
        return .{ .bytes = 0, .valid = false };
    }

    if (queryStatsField(&.{"total_requested_bytes"})) |value| {
        return sanitizeRequestedBytes(value);
    }

    if (@hasField(@TypeOf(compat.gpa), "total_requested_bytes")) {
        if (@TypeOf(compat.gpa.total_requested_bytes) == void) {
            return .{ .bytes = 0, .valid = false };
        }

        return sanitizeRequestedBytes(toNonNegativeU64(compat.gpa.total_requested_bytes));
    }

    return .{ .bytes = 0, .valid = false };
}

fn getSmallAllocationCount() u64 {
    if (queryStatsField(&.{ "small_allocations", "small_allocation_count" })) |value| {
        return value;
    }

    var total: u64 = 0;
    for (compat.gpa.buckets) |bucket_head| {
        var current = bucket_head;
        while (current) |bucket| {
            const allocated: u64 = @intCast(bucket.allocated_count);
            const freed: u64 = @intCast(bucket.freed_count);
            if (allocated >= freed) {
                total += allocated - freed;
            }
            current = bucket.next;
        }
    }

    return total;
}

fn getLargeAllocationCount() u64 {
    if (queryStatsField(&.{ "large_allocations", "large_allocation_count" })) |value| {
        return value;
    }

    return @intCast(compat.gpa.large_allocations.count());
}

export fn getArenaAllocatedBytes() u64 {
    return @intCast(compat.arena.queryCapacity());
}

export fn getBuildOptions(out_ptr: *ExternalBuildOptions) void {
    out_ptr.* = .{
        .gpa_safe_stats = build_options.gpa_safe_stats,
        .gpa_memory_limit_tracking = build_options.gpa_safe_stats,
    };
}

export fn getAllocatorStats(out_ptr: *ExternalAllocatorStats) void {
    const small_allocations = getSmallAllocationCount();
    const large_allocations = getLargeAllocationCount();
    const active_allocations = small_allocations + large_allocations;
    const requested_bytes = getTotalRequestedBytesInfo();

    out_ptr.* = .{
        .total_requested_bytes = requested_bytes.bytes,
        .active_allocations = active_allocations,
        .small_allocations = small_allocations,
        .large_allocations = large_allocations,
        .requested_bytes_valid = requested_bytes.valid,
    };
}
