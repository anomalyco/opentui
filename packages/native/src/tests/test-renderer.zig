const std = @import("std");
const renderer = @import("../renderer.zig");
const feed_mod = @import("../native-span-feed.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");

pub const TestMemoryOutput = struct {
    allocator: std.mem.Allocator,
    bytes: std.ArrayListUnmanaged(u8) = .empty,
    last_write_start: usize = 0,

    pub fn init(allocator: std.mem.Allocator) TestMemoryOutput {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *TestMemoryOutput) void {
        self.bytes.deinit(self.allocator);
    }

    pub fn write(self: *TestMemoryOutput, data: []const u8) void {
        self.bytes.appendSlice(self.allocator, data) catch @panic("memory output write failed");
    }

    /// The bytes that the last render or write delivered.
    pub fn lastWrite(self: *const TestMemoryOutput) []const u8 {
        return self.bytes.items[self.last_write_start..];
    }
};

/// Collects delivered bytes in caller storage.
pub const FixedSink = struct {
    writer: std.Io.Writer,

    pub fn init(storage: []u8) FixedSink {
        return .{ .writer = .fixed(storage) };
    }

    pub fn write(self: *FixedSink, data: []const u8) void {
        self.writer.writeAll(data) catch @panic("sink storage full");
    }

    pub fn bytes(self: *FixedSink) []const u8 {
        return self.writer.buffered();
    }
};

pub const discard = struct {
    pub fn write(_: @This(), _: []const u8) void {}
}{};

/// Hand every queued byte to `sink.write` in order, releasing each span.
pub fn deliverFeed(feed: *feed_mod.Stream, sink: anytype) void {
    var spans: [1]feed_mod.SpanInfo = undefined;
    while (feed.drainSpans(&spans) != 0) {
        sink.write(spans[0].slice());
        feed.releaseSpan(spans[0].slot_index, spans[0].release_id) catch unreachable;
    }
}

/// Render as a Session does: deliver every queued byte to `sink`, then
/// acknowledge a rendered frame.
pub fn renderPresented(cli: *renderer.CliRenderer, force: bool, sink: anytype) !renderer.RenderStatus {
    const status = try cli.renderDeferred(force);
    deliverFeed(cli.backend.feed, sink);
    if (status == .rendered) try cli.completePresentation(.presented);
    return status;
}

pub const TestEnvVar = struct {
    key: []const u8,
    value: []const u8,
};

/// A renderer on a callback-free feed, presented the way a Session presents it:
/// `renderDeferred` or `renderSplitDeferred`, deliver every queued byte, then
/// `completePresentation`. Tests borrow their own pools, which a Context-owned
/// Session cannot.
pub const TestRenderer = struct {
    allocator: std.mem.Allocator,
    memory: *TestMemoryOutput,
    // Owned environment injected into the renderer's Terminal. Defaults to an
    // empty map so tests never observe the host environment (TMUX, STY, TERM,
    // ...). Heap-allocated because Terminal borrows a stable pointer while
    // TestRenderer is returned by value.
    env_map: *std.process.Environ.Map,
    feed: *feed_mod.Stream,
    renderer: *renderer.CliRenderer,

    pub fn create(allocator: std.mem.Allocator, width: u32, height: u32, pool: *gp.GraphemePool, link_pool: *link.LinkPool) !TestRenderer {
        return createWithEnv(allocator, width, height, pool, link_pool, &.{});
    }

    pub fn createWithEnv(
        allocator: std.mem.Allocator,
        width: u32,
        height: u32,
        pool: *gp.GraphemePool,
        link_pool: *link.LinkPool,
        env_vars: []const TestEnvVar,
    ) !TestRenderer {
        const memory = try allocator.create(TestMemoryOutput);
        errdefer allocator.destroy(memory);
        memory.* = TestMemoryOutput.init(allocator);
        errdefer memory.deinit();

        const env_map = try allocator.create(std.process.Environ.Map);
        errdefer allocator.destroy(env_map);
        env_map.* = std.process.Environ.Map.init(allocator);
        errdefer env_map.deinit();
        for (env_vars) |env_var| {
            try env_map.put(env_var.key, env_var.value);
        }

        const feed = try feed_mod.Stream.create(allocator, null);
        errdefer feed.destroy();
        const cli_renderer = try renderer.CliRenderer.createWithOptions(allocator, width, height, pool, .{
            .feed = feed,
            .env_map = env_map,
            .link_pool = link_pool,
        });

        return .{
            .allocator = allocator,
            .memory = memory,
            .env_map = env_map,
            .feed = feed,
            .renderer = cli_renderer,
        };
    }

    pub fn deinit(self: *TestRenderer) void {
        // The renderer's Terminal borrows env_map and its backend borrows the feed.
        self.renderer.destroyStorage();
        self.feed.destroy();
        self.env_map.deinit();
        self.allocator.destroy(self.env_map);
        self.memory.deinit();
        self.allocator.destroy(self.memory);
    }

    pub fn render(self: *TestRenderer, force: bool) renderer.RenderStatus {
        return self.present(self.renderer.renderDeferred(force));
    }

    pub fn renderSplit(self: *TestRenderer, split: renderer.SplitRender, force: bool) renderer.RenderStatus {
        return self.present(self.renderer.renderSplitDeferred(split, force));
    }

    /// Append one snapshot above the footer and repaint the footer in one frame.
    pub fn commitSplit(self: *TestRenderer, snapshot: *renderer.OptimizedBuffer, row_columns: u32, start_on_new_line: bool, trailing_newline: bool, pinned_render_offset: u32, force: bool) renderer.RenderStatus {
        const snapshots = [_]renderer.SplitSnapshot{.{ .snapshot = snapshot, .row_columns = row_columns, .start_on_new_line = start_on_new_line, .trailing_newline = trailing_newline }};
        return self.renderSplit(.{ .snapshots = &snapshots, .pinned_render_offset = pinned_render_offset, .paint_footer = true, .suspended = false }, force);
    }

    pub fn repaintSplit(self: *TestRenderer, pinned_render_offset: u32, force: bool) renderer.RenderStatus {
        return self.renderSplit(.{ .snapshots = &.{}, .pinned_render_offset = pinned_render_offset, .paint_footer = true, .suspended = false }, force);
    }

    /// Append the queued bytes to memory; they are the last write.
    pub fn deliver(self: *TestRenderer) void {
        self.memory.last_write_start = self.memory.bytes.items.len;
        deliverFeed(self.feed, self.memory);
    }

    pub fn present(self: *TestRenderer, result: anyerror!renderer.RenderStatus) renderer.RenderStatus {
        const status = result catch |err| switch (err) {
            error.PresentationFailed => return .failed,
            else => std.debug.panic("deferred render failed: {}", .{err}),
        };
        self.deliver();
        if (status == .rendered) self.renderer.completePresentation(.presented) catch unreachable;
        return status;
    }

    pub fn lastOutput(self: *const TestRenderer) []const u8 {
        return self.memory.lastWrite();
    }
};
