const std = @import("std");
const builtin = @import("builtin");
const io = if (builtin.is_test) std.testing.io else @import("root").io;
const renderer = @import("../renderer.zig");
const renderer_output = @import("../renderer-output.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");

pub const TestMemoryOutput = struct {
    allocator: std.mem.Allocator,
    bytes: std.ArrayListUnmanaged(u8) = .empty,
    last_write_start: usize = 0,
    last_write_len: usize = 0,
    mutex: std.Io.Mutex = .init,
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
        if (self.thread_safe) self.mutex.lockUncancelable(io);
        defer if (self.thread_safe) self.mutex.unlock(io);

        const start = self.bytes.items.len;
        self.bytes.appendSlice(self.allocator, data) catch @panic("memory output write failed");
        self.last_write_start = start;
        self.last_write_len = data.len;
    }

    pub fn lastWrite(self: *const TestMemoryOutput) []const u8 {
        return self.bytes.items[self.last_write_start .. self.last_write_start + self.last_write_len];
    }
};

pub const TestEnvVar = struct {
    key: []const u8,
    value: []const u8,
};

pub const TestRenderer = struct {
    allocator: std.mem.Allocator,
    memory: *TestMemoryOutput,
    // Owned environment injected into the renderer's Terminal. Defaults to an
    // empty map so tests never observe the host environment (TMUX, STY, TERM,
    // ...). Heap-allocated because Terminal borrows a stable pointer while
    // TestRenderer is returned by value.
    env_map: *std.process.Environ.Map,
    renderer: *renderer.CliRenderer,

    const CreateConfig = struct {
        thread_safe: bool = false,
        env_vars: []const TestEnvVar = &.{},
        link_pool: ?*link.LinkPool = null,
    };

    pub fn create(allocator: std.mem.Allocator, width: u32, height: u32, pool: *gp.GraphemePool) !TestRenderer {
        return createWithConfig(allocator, width, height, pool, .{});
    }

    pub fn createThreadSafe(allocator: std.mem.Allocator, width: u32, height: u32, pool: *gp.GraphemePool) !TestRenderer {
        return createWithConfig(allocator, width, height, pool, .{ .thread_safe = true });
    }

    pub fn createWithEnv(
        allocator: std.mem.Allocator,
        width: u32,
        height: u32,
        pool: *gp.GraphemePool,
        env_vars: []const TestEnvVar,
    ) !TestRenderer {
        return createWithConfig(allocator, width, height, pool, .{ .env_vars = env_vars });
    }

    pub fn createWithLinkPool(allocator: std.mem.Allocator, width: u32, height: u32, pool: *gp.GraphemePool, link_pool: *link.LinkPool) !TestRenderer {
        return createWithConfig(allocator, width, height, pool, .{ .link_pool = link_pool });
    }

    fn createWithConfig(
        allocator: std.mem.Allocator,
        width: u32,
        height: u32,
        pool: *gp.GraphemePool,
        config: CreateConfig,
    ) !TestRenderer {
        const memory = try allocator.create(TestMemoryOutput);
        errdefer allocator.destroy(memory);
        memory.* = TestMemoryOutput.init(allocator);
        memory.thread_safe = config.thread_safe;
        errdefer memory.deinit();

        const env_map = try allocator.create(std.process.Environ.Map);
        errdefer allocator.destroy(env_map);
        env_map.* = std.process.Environ.Map.init(allocator);
        errdefer env_map.deinit();
        for (config.env_vars) |env_var| {
            try env_map.put(env_var.key, env_var.value);
        }

        const cli_renderer = try renderer.CliRenderer.createWithOptions(allocator, width, height, pool, .{
            .output = .{ .buffered = memory.bufferedOutput() },
            .env_map = env_map,
            .link_pool = config.link_pool,
        });

        return .{
            .allocator = allocator,
            .memory = memory,
            .env_map = env_map,
            .renderer = cli_renderer,
        };
    }

    pub fn deinit(self: *TestRenderer) void {
        // The renderer's Terminal borrows env_map; destroy the renderer first.
        self.renderer.destroy();
        self.env_map.deinit();
        self.allocator.destroy(self.env_map);
        self.memory.deinit();
        self.allocator.destroy(self.memory);
    }

    pub fn lastOutput(self: *const TestRenderer) []const u8 {
        return self.memory.lastWrite();
    }
};
