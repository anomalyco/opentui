const std = @import("std");
const renderer = @import("../renderer.zig");
const renderer_output = @import("../renderer-output.zig");
const gp = @import("../grapheme.zig");

pub const TestMemoryOutput = struct {
    allocator: std.mem.Allocator,
    bytes: std.ArrayListUnmanaged(u8) = .{},
    last_write_start: usize = 0,
    last_write_len: usize = 0,
    mutex: std.Thread.Mutex = .{},
    thread_safe: bool = false,

    pub fn init(allocator: std.mem.Allocator) TestMemoryOutput {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *TestMemoryOutput) void {
        self.bytes.deinit(self.allocator);
    }

    pub fn bufferedOutput(self: *TestMemoryOutput) renderer_output.BufferedOutput {
        return .{ .ctx = self, .write_fn = write, .thread_safe = self.thread_safe };
    }

    fn write(ctx: *anyopaque, data: []const u8) void {
        const self: *TestMemoryOutput = @ptrCast(@alignCast(ctx));
        if (self.thread_safe) self.mutex.lock();
        defer if (self.thread_safe) self.mutex.unlock();

        const start = self.bytes.items.len;
        self.bytes.appendSlice(self.allocator, data) catch @panic("memory output write failed");
        self.last_write_start = start;
        self.last_write_len = data.len;
    }

    pub fn lastWrite(self: *const TestMemoryOutput) []const u8 {
        return self.bytes.items[self.last_write_start .. self.last_write_start + self.last_write_len];
    }
};

pub const TestRenderer = struct {
    allocator: std.mem.Allocator,
    memory: *TestMemoryOutput,
    renderer: *renderer.CliRenderer,

    pub fn create(allocator: std.mem.Allocator, width: u32, height: u32, pool: *gp.GraphemePool) !TestRenderer {
        return createWithThreadSafety(allocator, width, height, pool, false);
    }

    pub fn createThreadSafe(allocator: std.mem.Allocator, width: u32, height: u32, pool: *gp.GraphemePool) !TestRenderer {
        return createWithThreadSafety(allocator, width, height, pool, true);
    }

    fn createWithThreadSafety(
        allocator: std.mem.Allocator,
        width: u32,
        height: u32,
        pool: *gp.GraphemePool,
        thread_safe: bool,
    ) !TestRenderer {
        const memory = try allocator.create(TestMemoryOutput);
        errdefer allocator.destroy(memory);
        memory.* = TestMemoryOutput.init(allocator);
        memory.thread_safe = thread_safe;
        errdefer memory.deinit();

        const cli_renderer = try renderer.CliRenderer.createWithOptions(allocator, width, height, pool, .{
            .output = .{ .buffered = memory.bufferedOutput() },
        });

        return .{
            .allocator = allocator,
            .memory = memory,
            .renderer = cli_renderer,
        };
    }

    pub fn deinit(self: *TestRenderer) void {
        self.renderer.destroy();
        self.memory.deinit();
        self.allocator.destroy(self.memory);
    }

    pub fn lastOutput(self: *const TestRenderer) []const u8 {
        return self.memory.lastWrite();
    }
};
