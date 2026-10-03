const std = @import("std");

pub const LogLevel = enum(u8) {
    err = 0,
    warn = 1,
    info = 2,
    debug = 3,
};

pub const LogCallback = *const fn (level: u8, msgPtr: [*]const u8, msgLen: u32) callconv(.c) void;

pub const Diagnostic = struct {
    // Match the legacy formatting limit; truncation preserves a byte prefix.
    pub const message_bytes_max = 4096;

    level: LogLevel,
    truncated: bool = false,
    message_len: u32 = 0,
    message: [message_bytes_max]u8 = @splat(0),
};

/// Single-owner telemetry storage. Full queues drop the newest message before
/// formatting it. No enqueue or drain allocates or invokes host code.
pub const Diagnostics = struct {
    allocator: std.mem.Allocator,
    events: []Diagnostic,
    head: u32 = 0,
    count: u32 = 0,
    dropped_count: u64 = 0,

    pub const Drain = struct {
        count: u32,
        remaining: u32,
        /// Saturating lifetime total, not reset by draining.
        dropped: u64,
    };

    /// Zero capacity disables storage but still counts dropped messages.
    pub fn init(allocator: std.mem.Allocator, capacity: u32) std.mem.Allocator.Error!Diagnostics {
        return .{ .allocator = allocator, .events = try allocator.alloc(Diagnostic, capacity) };
    }

    pub fn deinit(self: *Diagnostics) void {
        self.allocator.free(self.events);
        self.* = undefined;
    }

    /// Copies the oldest records into caller storage. An empty output only
    /// snapshots pressure. Copied records survive queue reuse and owner teardown.
    pub fn drain(self: *Diagnostics, out: []Diagnostic) Drain {
        std.debug.assert(self.count <= self.events.len);
        const count: u32 = @intCast(@min(out.len, self.count));
        for (out[0..count]) |*event| {
            event.* = self.events[self.head];
            self.head = @intCast((@as(u64, self.head) + 1) % self.events.len);
        }
        self.count -= count;
        return .{ .count = count, .remaining = self.count, .dropped = self.dropped_count };
    }

    fn logMessage(self: *Diagnostics, level: LogLevel, comptime format: []const u8, args: anytype) void {
        std.debug.assert(self.count <= self.events.len);
        if (self.count == self.events.len) {
            self.dropped_count +|= 1;
            return;
        }
        const index: usize = @intCast((@as(u64, self.head) + self.count) % self.events.len);
        const event = &self.events[index];
        event.* = .{ .level = level };
        var writer: std.Io.Writer = .fixed(&event.message);
        writer.print(format, args) catch {
            event.truncated = true;
        };
        event.message_len = @intCast(writer.end);
        self.count += 1;
    }
};

/// Resources borrow a logger at a stable address for their entire lifetime.
/// Diagnostic loggers and queues share the context's single-owner contract.
pub const Logger = union(enum) {
    callback: ?LogCallback,
    diagnostics: *Diagnostics,
    /// The process callback from setLogCallback. Threads other than its installer drop messages.
    process,

    pub fn logMessage(self: *const Logger, level: LogLevel, comptime format: []const u8, args: anytype) void {
        switch (self.*) {
            .diagnostics => |queue| queue.logMessage(level, format, args),
            .process => {
                // A host callback runs only on the thread that created it: Node aborts on any other
                // thread, and a Worker's callback dies with it. Seeing a callback implies seeing its
                // installer's thread, so a callback installed elsewhere never runs here.
                const callback = process_callback.load(.acquire);
                if (process_thread.load(.monotonic) != std.Thread.getCurrentId()) return;
                const owner: Logger = .{ .callback = callback };
                owner.logMessage(level, format, args);
            },
            .callback => |maybe_callback| {
                const callback = maybe_callback orelse return;
                var buf: [Diagnostic.message_bytes_max]u8 = undefined;
                const msg = std.fmt.bufPrint(&buf, format, args) catch {
                    const fallback = "Log formatting failed";
                    callback(@intFromEnum(LogLevel.err), fallback.ptr, fallback.len);
                    return;
                };
                callback(@intFromEnum(level), msg.ptr, @intCast(msg.len));
            },
        }
    }

    pub fn err(self: *const Logger, comptime format: []const u8, args: anytype) void {
        self.logMessage(.err, format, args);
    }

    pub fn warn(self: *const Logger, comptime format: []const u8, args: anytype) void {
        self.logMessage(.warn, format, args);
    }

    pub fn info(self: *const Logger, comptime format: []const u8, args: anytype) void {
        self.logMessage(.info, format, args);
    }

    pub fn debug(self: *const Logger, comptime format: []const u8, args: anytype) void {
        self.logMessage(.debug, format, args);
    }
};

/// Process-wide callback logger. Context diagnostic queues do not use this sink.
const process_logger: Logger = .process;
var process_callback: std.atomic.Value(?LogCallback) = .init(null);
var process_thread: std.atomic.Value(std.Thread.Id) = .init(0);

pub fn processLogger() *const Logger {
    return &process_logger;
}

pub fn setLogCallback(callback: ?LogCallback) void {
    process_thread.store(std.Thread.getCurrentId(), .monotonic);
    process_callback.store(callback, .release);
}

pub fn logMessage(level: LogLevel, comptime format: []const u8, args: anytype) void {
    processLogger().logMessage(level, format, args);
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

comptime {
    if (@import("builtin").is_test) _ = @import("tests/diagnostics_test.zig");
}

test "process log callback runs only on the thread that installed it" {
    const Probe = struct {
        var calls: std.atomic.Value(u32) = .init(0);
        fn callback(_: u8, _: [*]const u8, _: u32) callconv(.c) void {
            _ = calls.fetchAdd(1, .monotonic);
        }
        fn logFromOtherThread() void {
            warn("other thread", .{});
        }
    };
    setLogCallback(Probe.callback);
    defer setLogCallback(null);
    const thread = try std.Thread.spawn(.{}, Probe.logFromOtherThread, .{});
    thread.join();
    try std.testing.expectEqual(0, Probe.calls.load(.monotonic));
    warn("owner thread", .{});
    try std.testing.expectEqual(1, Probe.calls.load(.monotonic));
}
