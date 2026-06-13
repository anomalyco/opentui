const std = @import("std");

pub const LogLevel = enum(u8) {
    err = 0,
    warn = 1,
    info = 2,
    debug = 3,
};

var global_log_callback: ?*const fn (level: u8, msgPtr: [*]const u8, msgLen: u32) callconv(.c) void = null;

pub fn setLogCallback(callback: ?*const fn (level: u8, msgPtr: [*]const u8, msgLen: u32) callconv(.c) void) void {
    global_log_callback = callback;
}

// Helper function to log messages - can be used directly throughout the codebase
pub fn logMessage(level: LogLevel, comptime format: []const u8, args: anytype) void {
    if (global_log_callback) |callback| {
        var buf: [4096]u8 = undefined;
        const msg = std.fmt.bufPrint(&buf, format, args) catch {
            const fallback = "Log formatting failed";
            callback(@intFromEnum(LogLevel.err), fallback.ptr, std.math.cast(u32, fallback.len) orelse return);
            return;
        };
        callback(@intFromEnum(level), msg.ptr, std.math.cast(u32, msg.len) orelse return);
    }
}

pub fn err(comptime format: []const u8, args: anytype) void {
    logMessage(.err, format, args);
}

pub fn warn(comptime format: []const u8, args: anytype) void {
    logMessage(.warn, format, args);
}

pub fn info(comptime format: []const u8, args: anytype) void {
    logMessage(.info, format, args);
}

pub fn debug(comptime format: []const u8, args: anytype) void {
    logMessage(.debug, format, args);
}
