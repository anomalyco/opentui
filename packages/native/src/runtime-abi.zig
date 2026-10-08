const std = @import("std");
const build_options = @import("build_options");
const logger = @import("logger.zig");
const runtime = @import("runtime.zig");

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

export fn getArenaAllocatedBytes() u64 {
    // Standalone resources allocate from the process GPA or c_allocator, not an arena.
    return 0;
}

export fn getBuildOptions(out_ptr: *ExternalBuildOptions) void {
    out_ptr.* = .{
        .gpa_safe_stats = build_options.gpa_safe_stats,
        .gpa_memory_limit_tracking = build_options.gpa_safe_stats,
    };
}

/// Reports only the process allocator. Each Context owns a private allocator, so
/// Context memory, including the objects of a Core renderer, is not included.
export fn getAllocatorStats(out_ptr: *ExternalAllocatorStats) void {
    var small_allocations: u64 = 0;
    for (runtime.gpa.buckets) |newest| {
        var bucket = newest;
        while (bucket) |current| : (bucket = current.prev) {
            small_allocations += current.allocated_count - current.freed_count;
        }
    }
    const large_allocations: u64 = runtime.gpa.large_allocations.count();
    out_ptr.* = .{
        .total_requested_bytes = if (build_options.gpa_safe_stats) runtime.gpa.total_requested_bytes else 0,
        .active_allocations = small_allocations + large_allocations,
        .small_allocations = small_allocations,
        .large_allocations = large_allocations,
        .requested_bytes_valid = build_options.gpa_safe_stats,
    };
}

test "getAllocatorStats counts live small allocations in every bucket" {
    var before: ExternalAllocatorStats = undefined;
    getAllocatorStats(&before);
    // 16 KiB slots fill a 128 KiB bucket after a few allocations, so these span several buckets.
    var slices: [24][]u8 = undefined;
    for (&slices, 0..) |*slice, index| {
        slice.* = runtime.allocator().alloc(u8, 16 * 1024) catch |err| {
            for (slices[0..index]) |allocated| runtime.allocator().free(allocated);
            return err;
        };
    }
    var during: ExternalAllocatorStats = undefined;
    getAllocatorStats(&during);
    for (slices) |slice| runtime.allocator().free(slice);
    var after: ExternalAllocatorStats = undefined;
    getAllocatorStats(&after);
    try std.testing.expectEqual(before.small_allocations + slices.len, during.small_allocations);
    try std.testing.expectEqual(during.small_allocations + during.large_allocations, during.active_allocations);
    try std.testing.expectEqualDeep(before, after);
}
