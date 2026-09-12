const std = @import("std");
const builtin = @import("builtin");
const io = if (builtin.is_test) std.testing.io else @import("root").io;

pub const LogLevel = enum(u8) {
    err = 0,
    warn = 1,
    info = 2,
    debug = 3,
};

var log_file: ?std.Io.File = null;
var log_mutex: std.Io.Mutex = .init;
var initialized: bool = false;

/// Initialize the file logger with a timestamped filename (called automatically on first use)
fn ensureInit() void {
    if (initialized) return;

    const timestamp = std.Io.Clock.now(.real, io).toSeconds();
    var filename_buf: [128]u8 = undefined;
    const filename = std.fmt.bufPrint(&filename_buf, "opentui_debug_{d}.log", .{timestamp}) catch return;

    log_file = std.Io.Dir.cwd().createFile(io, filename, .{ .truncate = true }) catch return;

    // Log initialization
    const init_msg = std.fmt.bufPrint(&filename_buf, "=== Log initialized at timestamp {d} ===\n", .{timestamp}) catch return;
    var writer = log_file.?.writerStreaming(io, &.{});
    writer.interface.writeAll(init_msg) catch return;
    log_file.?.sync(io) catch return;

    initialized = true;
}

/// Close the log file
pub fn deinit() void {
    log_mutex.lockUncancelable(io);
    defer log_mutex.unlock(io);

    if (log_file) |file| {
        file.close(io);
        log_file = null;
        initialized = false;
    }
}

/// Log a message with level, file, line info and immediate flush
pub fn logMessage(level: LogLevel, comptime format: []const u8, args: anytype) void {
    log_mutex.lockUncancelable(io);
    defer log_mutex.unlock(io);

    // Auto-initialize on first use
    if (!initialized) {
        ensureInit();
    }

    if (log_file == null) return;

    var buf: [8192]u8 = undefined;

    const level_str = switch (level) {
        .err => "ERROR",
        .warn => "WARN ",
        .info => "INFO ",
        .debug => "DEBUG",
    };

    const timestamp = std.Io.Clock.now(.real, io).toMicroseconds();

    var writer = log_file.?.writerStreaming(io, &.{});

    const msg = std.fmt.bufPrint(&buf, "[{d}] {s}: ", .{ timestamp, level_str }) catch return;
    writer.interface.writeAll(msg) catch return;

    const user_msg = std.fmt.bufPrint(&buf, format, args) catch return;
    writer.interface.writeAll(user_msg) catch return;
    writer.interface.writeAll("\n") catch return;

    // CRITICAL: Flush immediately so logs are on disk even if we crash
    log_file.?.sync(io) catch return;
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
