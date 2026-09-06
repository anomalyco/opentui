const std = @import("std");
const renderer = @import("../renderer.zig");
const feed_mod = @import("../native-span-feed.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");
const ansi = @import("../ansi.zig");
const image = @import("../image.zig");

const Fixture = struct {
    pool: gp.GraphemePool,
    links: link.LinkPool,
    env: std.process.Environ.Map,
    feed: *feed_mod.Stream,
    cli: *renderer.CliRenderer,

    fn init(self: *Fixture) !void {
        self.pool = gp.GraphemePool.init(std.testing.allocator);
        errdefer self.pool.deinit();
        self.links = link.LinkPool.init(std.testing.allocator);
        errdefer self.links.deinit();
        self.env = std.process.Environ.Map.init(std.testing.allocator);
        errdefer self.env.deinit();
        self.feed = try feed_mod.Stream.create(std.testing.allocator, .{
            .chunk_size = 64,
            .initial_chunks = 64,
            .max_bytes = 4096,
            .growth_policy = @intFromEnum(feed_mod.GrowthPolicy.block),
            .auto_commit_on_full = 0,
            .span_queue_capacity = 64,
        });
        errdefer self.feed.destroy();
        self.cli = try renderer.CliRenderer.createWithOptions(std.testing.allocator, 4, 2, &self.pool, .{
            .output = .{ .feed = self.feed },
            .link_pool = &self.links,
            .env_map = &self.env,
        });
    }

    fn deinit(self: *Fixture) void {
        self.cli.destroy();
        self.feed.destroy();
        self.env.deinit();
        self.links.deinit();
        self.pool.deinit();
    }

    fn paint(self: *Fixture, text: []const u8, hit: u32) !void {
        try self.cli.getNextBuffer().drawText(text, 0, 0, ansi.rgbColor(255, 255, 255, 255), null, 0);
        self.cli.addToHitGrid(0, 0, 4, 2, hit);
    }

    fn drain(self: *Fixture, bytes: []u8) ![]const u8 {
        var spans: [64]feed_mod.SpanInfo = undefined;
        const count = self.feed.drainSpans(&spans);
        defer for (spans[0..count]) |span| self.feed.markSpanConsumed(span);
        var writer: std.Io.Writer = .fixed(bytes);
        for (spans[0..count]) |span| try writer.writeAll(span.slice());
        return writer.buffered();
    }
};

test "renderer batches frame encoding before feed admission" {
    var fixture: Fixture = undefined;
    try fixture.init();
    defer fixture.deinit();
    try fixture.paint("text", 11);
    try std.testing.expectEqual(.rendered, fixture.cli.render(true));
    try std.testing.expectEqual(@as(usize, 1), fixture.cli.backend.feed.frameWriteCount);
    var bytes: [4096]u8 = undefined;
    try std.testing.expect(std.mem.find(u8, try fixture.drain(&bytes), "text") != null);

    try fixture.paint("text", 11);
    try std.testing.expectEqual(.rendered, fixture.cli.render(false));
    try std.testing.expectEqual(@as(usize, 0), fixture.cli.backend.feed.frameWriteCount);
    try std.testing.expectEqual(@as(u64, 0), fixture.feed.getStats().outstanding_bytes);

    const cleared_char = fixture.cli.getNextBuffer().buffer.char[0];
    try fixture.cli.resize(140, 44);
    for (0..44) |y| {
        for (0..140) |x| {
            try fixture.cli.getNextBuffer().drawText("X", @intCast(x), @intCast(y), ansi.rgbColor(@intCast(x), @intCast(y), 0, 255), null, 0);
        }
    }
    try std.testing.expectEqual(.failed, fixture.cli.render(true));
    try std.testing.expect(fixture.cli.backend.feed.frameWriteCount > 1);
    try std.testing.expectEqual(@as(u64, 0), fixture.feed.getStats().outstanding_bytes);
    try std.testing.expectEqual(@as(usize, 0), fixture.feed.staged_bytes);
    try std.testing.expectEqual(cleared_char, fixture.cli.getNextBuffer().buffer.char[0]);

    try fixture.cli.resize(4, 2);
    try fixture.paint("text", 11);
    try std.testing.expectEqual(.rendered, fixture.cli.render(true));
    try std.testing.expect(std.mem.find(u8, try fixture.drain(&bytes), "text") != null);
}

test "renderer presentation publishes only on completion and preserves legacy render" {
    var fixture: Fixture = undefined;
    try fixture.init();
    defer fixture.deinit();
    const cli = fixture.cli;
    var bytes: [4096]u8 = undefined;
    try fixture.paint("old", 11);
    try std.testing.expectEqual(.rendered, cli.render(true));
    try std.testing.expectEqual(@as(u32, 11), cli.checkHit(0, 0));
    try std.testing.expectEqual(@as(u64, 1), cli.getRenderStats().frameCount);
    try std.testing.expect(fixture.feed.getStats().outstanding_bytes > 0);
    _ = try fixture.drain(&bytes);
    const previous_stats = cli.getRenderStats();

    const value = try image.createFromRgba(std.testing.allocator, &.{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    try fixture.paint("new", 22);
    try std.testing.expect(try cli.getNextBuffer().drawImage(value, 1, 0, 1, 1, 1, 0, 0, 0, 0, 1, 1, .kitty));
    try std.testing.expectEqual(.rendered, try cli.renderDeferred(true));
    try std.testing.expectEqual(@as(u32, 11), cli.checkHit(0, 0));
    try std.testing.expectEqualDeep(previous_stats, cli.getRenderStats());
    try std.testing.expectEqual(@as(usize, 0), cli.currentImages.items.len);
    try std.testing.expectEqual(@as(usize, 1), cli.pendingImages.items.len);
    const before = fixture.feed.getStats();
    try std.testing.expectError(error.PresentationPending, cli.renderDeferred(false));
    try std.testing.expectError(error.PresentationPending, cli.resize(8, 4));
    var writer: std.Io.Writer = .fixed(&bytes);
    try std.testing.expectError(error.PresentationPending, cli.prepareRenderFrameWithWriter(&writer, true, false));
    try std.testing.expectEqual(@as(usize, 0), writer.buffered().len);
    try std.testing.expectEqualDeep(before, fixture.feed.getStats());
    try std.testing.expect(std.mem.find(u8, try fixture.drain(&bytes), "new") != null);

    // Releasing feed storage is not a presentation acknowledgement.
    try std.testing.expectEqual(@as(u32, 11), cli.checkHit(0, 0));
    try std.testing.expectEqualDeep(previous_stats, cli.getRenderStats());
    try cli.completePresentation(.presented);
    try std.testing.expectEqual(@as(u32, 22), cli.checkHit(0, 0));
    try std.testing.expectEqual(@as(u64, 2), cli.getRenderStats().frameCount);
    try std.testing.expectEqual(@as(u32, 8), cli.getRenderStats().cellsUpdated);
    try std.testing.expectEqual(@as(usize, 1), cli.currentImages.items.len);
    try std.testing.expectEqual(@as(usize, 0), cli.pendingImages.items.len);
    const completed_stats = cli.getRenderStats();
    try std.testing.expectError(error.NoPendingPresentation, cli.completePresentation(.presented));
    try std.testing.expectError(error.NoPendingPresentation, cli.completePresentation(.failed));
    try std.testing.expectEqualDeep(completed_stats, cli.getRenderStats());

    try fixture.paint("new", 33);
    try std.testing.expect(try cli.getNextBuffer().drawImage(value, 1, 0, 1, 1, 1, 0, 0, 0, 0, 1, 1, .kitty));
    try std.testing.expectEqual(.rendered, try cli.renderDeferred(false));
    try std.testing.expectEqual(@as(u64, 0), fixture.feed.getStats().outstanding_bytes);
    try std.testing.expectEqual(@as(u32, 22), cli.checkHit(0, 0));
    try std.testing.expectEqualDeep(completed_stats, cli.getRenderStats());
    try cli.completePresentation(.presented);
    try std.testing.expectEqual(@as(u32, 33), cli.checkHit(0, 0));
    try std.testing.expectEqual(@as(u32, 0), cli.getRenderStats().cellsUpdated);
    try cli.resize(8, 4);
}

test "renderer shutdown image serialization is checked and does not publish" {
    var fixture: Fixture = undefined;
    try fixture.init();
    defer fixture.deinit();
    const cli = fixture.cli;
    cli.imageIdSalt = 100;
    const value = try image.createFromRgba(std.testing.allocator, &.{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    inline for (.{ .kitty, .blocks, .sixel, .kitty }, 0..) |protocol, index| {
        try std.testing.expect(try cli.getNextBuffer().drawImage(value, 1, index, 0, 1, 1, 1, 1, 0, 0, 1, 1, protocol));
    }
    try std.testing.expectEqual(.rendered, cli.render(true));
    var bytes: [4096]u8 = undefined;
    _ = try fixture.drain(&bytes);
    try std.testing.expectEqual(@as(usize, 4), cli.currentImages.items.len);
    const previous_images = cli.currentImages.items[0..4].*;
    const previous_stats = cli.getRenderStats();
    const previous_feed = fixture.feed.getStats();

    for ([_]bool{ false, true }) |tmux| {
        cli.terminal.multiplexer = if (tmux) .tmux else .none;
        const expected = if (tmux)
            "\x1bPtmux;\x1b\x1b_Ga=d,d=I,i=104,q=2\x1b\x1b\\\x1b\\"
        else
            "\x1b_Ga=d,d=I,i=104,q=2\x1b\\";
        for (0..expected.len) |capacity| {
            var writer: std.Io.Writer = .fixed(bytes[0..capacity]);
            try std.testing.expectError(error.WriteFailed, cli.writeShutdownImage(&writer, 3));
        }
        var writer: std.Io.Writer = .fixed(&bytes);
        try cli.writeShutdownImage(&writer, 3);
        try std.testing.expectEqualStrings(expected, writer.buffered());
        writer = .fixed(bytes[0..0]);
        try cli.writeShutdownImage(&writer, 1);
        try cli.writeShutdownImage(&writer, 2);
    }
    try std.testing.expectEqualDeep(previous_images[0..], cli.currentImages.items);
    try std.testing.expectEqualDeep(previous_stats, cli.getRenderStats());
    try std.testing.expectEqualDeep(previous_feed, fixture.feed.getStats());
}

test "renderer presentation invalidation preserves completion and repaints controls" {
    var fixture: Fixture = undefined;
    try fixture.init();
    defer fixture.deinit();
    const cli = fixture.cli;
    var bytes: [4096]u8 = undefined;
    cli.terminal.setCursorPosition(3, 2, true);
    cli.terminal.setCursorColor(ansi.rgbColor(0x12, 0x34, 0x56, 255));
    cli.terminal.setCursorStyle(.line, false);
    cli.terminal.setMousePointerStyle(.pointer);
    try fixture.paint("same", 11);
    try std.testing.expectEqual(.rendered, cli.render(true));
    _ = try fixture.drain(&bytes);
    const previous_stats = cli.getRenderStats();

    try fixture.paint("same", 22);
    try std.testing.expectEqual(.rendered, try cli.renderDeferred(false));
    try std.testing.expectEqual(@as(usize, 0), (try fixture.drain(&bytes)).len);
    const previous_pending = cli.pendingPresentation;
    const previous_feed = fixture.feed.getStats();
    cli.invalidateTerminalState();
    try std.testing.expectEqualDeep(previous_pending, cli.pendingPresentation);
    try std.testing.expectEqualDeep(previous_stats, cli.getRenderStats());
    try std.testing.expectEqualDeep(previous_feed, fixture.feed.getStats());
    try std.testing.expectEqual(@as(u32, 11), cli.checkHit(0, 0));
    try cli.completePresentation(.presented);
    try std.testing.expectEqual(@as(u32, 22), cli.checkHit(0, 0));

    try fixture.paint("same", 33);
    try std.testing.expectEqual(.rendered, try cli.renderDeferred(false));
    const output = try fixture.drain(&bytes);
    try std.testing.expect(std.mem.find(u8, output, "same") != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b]12;#123456\x07") != null);
    try std.testing.expect(std.mem.find(u8, output, ansi.ANSI.cursorLine) != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b[2;3H" ++ ansi.ANSI.showCursor) != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b]22;pointer\x07") != null);
    try cli.completePresentation(.presented);
    try std.testing.expectEqual(@as(u32, 8), cli.getRenderStats().cellsUpdated);
    try std.testing.expectEqual(@as(u32, 33), cli.checkHit(0, 0));
}

test "renderer presentation failure retains published state and forbids implicit replay" {
    for ([_]bool{ true, false }) |restore_image| {
        var fixture: Fixture = undefined;
        try fixture.init();
        defer fixture.deinit();
        const cli = fixture.cli;
        var bytes: [4096]u8 = undefined;
        const old_image = try image.createFromRgba(std.testing.allocator, &.{ 255, 0, 0, 255 }, 1, 1, 4);
        defer old_image.deinit();
        const new_image = try image.createFromRgba(std.testing.allocator, &.{ 0, 0, 255, 255 }, 1, 1, 4);
        defer new_image.deinit();
        cli.terminal.setCursorPosition(1, 1, true);
        try fixture.paint("old", 11);
        if (restore_image) {
            try std.testing.expect(try cli.getNextBuffer().drawImage(old_image, 1, 0, 1, 1, 1, 0, 0, 0, 0, 1, 1, .kitty));
        }
        try std.testing.expectEqual(.rendered, cli.render(true));
        _ = try fixture.drain(&bytes);
        const previous_stats = cli.getRenderStats();

        try fixture.paint("BAD", 22);
        try std.testing.expect(try cli.getNextBuffer().drawImage(new_image, 2, 0, 1, 1, 1, 0, 0, 0, 0, 1, 1, .kitty));
        try std.testing.expect(try cli.getNextBuffer().drawImage(new_image, 2, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, .kitty));
        try std.testing.expectEqual(.rendered, try cli.renderDeferred(false));
        var prefix: [1]feed_mod.SpanInfo = undefined;
        try std.testing.expectEqual(@as(u32, 1), fixture.feed.drainSpans(&prefix));
        fixture.feed.markSpanConsumed(prefix[0]);
        try std.testing.expect(fixture.feed.hasPendingSpans());
        _ = try fixture.drain(&bytes); // The host discards the unacknowledged suffix.
        try cli.completePresentation(.failed);
        try std.testing.expectEqual(@as(u32, 11), cli.checkHit(0, 0));
        try std.testing.expectEqualDeep(previous_stats, cli.getRenderStats());
        try std.testing.expectEqual(@as(usize, @intFromBool(restore_image)), cli.currentImages.items.len);
        if (restore_image) try std.testing.expectEqual(@as(u32, 1), cli.currentImages.items[0].image_handle);
        try std.testing.expect(cli.force_full_repaint);
        try std.testing.expectError(error.NoPendingPresentation, cli.completePresentation(.failed));

        try fixture.paint("retry", 33);
        try std.testing.expectError(error.PresentationFailed, cli.renderDeferred(false));
        try std.testing.expectEqual(.failed, cli.render(true));
        try std.testing.expectEqual(.failed, cli.repaintSplitFooter(2, true).status);
        const split = cli.commitSplitFooterSnapshotBatched(cli.getNextBuffer(), 4, false, true, 2, true, true, true);
        try std.testing.expectEqual(.failed, split.status);
        var writer: std.Io.Writer = .fixed(&bytes);
        try std.testing.expectError(error.PresentationFailed, cli.prepareRenderFrameWithWriter(&writer, true, false));
        try std.testing.expectError(error.PresentationFailed, cli.resize(8, 4));
        cli.setupTerminal(true);
        cli.resumeRenderer();
        try std.testing.expect(!cli.terminalSetup);
        try std.testing.expectEqual(@as(usize, 0), writer.buffered().len);
        try std.testing.expectEqual(@as(usize, 0), (try fixture.drain(&bytes)).len);
        try std.testing.expectEqual(@as(u32, 11), cli.checkHit(0, 0));
        try std.testing.expectEqualDeep(previous_stats, cli.getRenderStats());
    }
}

test "renderer presentation queries preserve resize invalidation until completion" {
    var fixture: Fixture = undefined;
    try fixture.init();
    defer fixture.deinit();
    const cli = fixture.cli;
    var bytes: [4096]u8 = undefined;
    for ([_]bool{ true, false }) |force| {
        try fixture.paint("old", 11);
        try std.testing.expectEqual(.rendered, cli.render(force));
        _ = try fixture.drain(&bytes);
    }
    try std.testing.expect(!cli.getHitGridDirty());
    try cli.resize(2, 2);
    try std.testing.expectEqual(.rendered, try cli.renderDeferred(true));
    try std.testing.expect(!cli.getHitGridDirty());
    _ = try fixture.drain(&bytes);
    try cli.completePresentation(.presented);
    try std.testing.expect(cli.getHitGridDirty());
    try std.testing.expectEqual(@as(u32, 0), cli.checkHit(0, 0));
    try std.testing.expectEqual(.rendered, try cli.renderDeferred(false));
    try cli.completePresentation(.presented);
    try std.testing.expect(!cli.getHitGridDirty());
}

test "renderer presentation rejects split prefixes and preserves split output" {
    var fixture: Fixture = undefined;
    try fixture.init();
    defer fixture.deinit();
    const cli = fixture.cli;
    var bytes: [4096]u8 = undefined;
    _ = cli.resetSplitScrollback(1, 2);
    const snapshot = cli.getNextBuffer();
    try fixture.paint("row", 11);
    try std.testing.expectEqual(.rendered, cli.commitSplitFooterSnapshotBatched(snapshot, 4, false, true, 2, false, true, false).status);
    try std.testing.expectError(error.SplitRenderPending, cli.renderDeferred(false));
    try std.testing.expect(cli.splitBatchActive);
    try std.testing.expectEqual(.rendered, cli.commitSplitFooterSnapshotBatched(snapshot, 4, false, true, 2, false, false, true).status);
    try std.testing.expect(!cli.splitBatchActive);
    _ = try fixture.drain(&bytes);

    cli.setPendingSplitFooterTransition(.viewport_scroll, 1, 1, 2, 1, 1);
    const previous_split = cli.splitScrollback;
    try std.testing.expectError(error.SplitRenderPending, cli.renderDeferred(false));
    try std.testing.expectEqualDeep(previous_split, cli.splitScrollback);
    try std.testing.expectEqual(.rendered, cli.render(true));
    try std.testing.expect(std.mem.find(u8, try fixture.drain(&bytes), "\x1b[1T") != null);
}

test "renderer presentation rejects active output and callback reentry" {
    const Probe = struct {
        var target: ?*renderer.CliRenderer = null;
        var rejected: ?anyerror = null;

        fn notify(_: usize, event: u32, _: usize, _: u64) callconv(.c) void {
            if (event != @intFromEnum(feed_mod.EventId.DataAvailable)) return;
            const cli = target.?;
            cli.backend.feed.feed.setCallback(null);
            _ = cli.renderDeferred(false) catch |err| {
                rejected = err;
                return;
            };
        }
    };
    var fixture: Fixture = undefined;
    try fixture.init();
    defer fixture.deinit();
    const cli = fixture.cli;
    Probe.target = cli;
    defer Probe.target = null;
    Probe.rejected = null;
    fixture.feed.setCallback(&Probe.notify);
    try std.testing.expectError(error.IncompatibleOutput, cli.renderDeferred(false));
    try fixture.feed.attach();
    try fixture.paint("old", 11);
    try std.testing.expectEqual(.rendered, cli.render(true));
    try std.testing.expectEqual(@as(?anyerror, error.IncompatibleOutput), Probe.rejected);
    try std.testing.expectEqual(@as(u32, 11), cli.checkHit(0, 0));
    try std.testing.expectError(error.NoPendingPresentation, cli.completePresentation(.presented));

    cli.backend.feed.beginFrame();
    var writer = cli.backend.feed.writer();
    try writer.writeAll("prefix");
    try std.testing.expectError(error.IncompatibleOutput, cli.renderDeferred(false));
    try std.testing.expectEqualStrings("prefix", cli.backend.feed.frameBytes.items);
    cli.backend.feed.cancelFrame();
}

test "renderer presentation failed or skipped admission has no completion" {
    var fixture: Fixture = undefined;
    try fixture.init();
    defer fixture.deinit();
    const cli = fixture.cli;
    var bytes: [4096]u8 = undefined;
    try fixture.paint("old", 11);
    try std.testing.expectEqual(.rendered, cli.render(true));
    _ = try fixture.drain(&bytes);
    const previous_stats = cli.getRenderStats();
    const blocker = [_]u8{'x'} ** 4096;
    for ([_]usize{ 4096, 4032 }) |size| {
        try fixture.feed.writeAtomic(blocker[0..size]);
        try fixture.paint("new", 22);
        const expected: renderer.RenderStatus = if (size == 4096) .skipped else .failed;
        try std.testing.expectEqual(expected, try cli.renderDeferred(true));
        try std.testing.expectError(error.NoPendingPresentation, cli.completePresentation(.presented));
        try std.testing.expectEqual(@as(u32, 11), cli.checkHit(0, 0));
        try std.testing.expectEqualDeep(previous_stats, cli.getRenderStats());
        try std.testing.expectEqualStrings(blocker[0..size], try fixture.drain(&bytes));
    }
    try fixture.paint("new", 22);
    try std.testing.expectEqual(.rendered, try cli.renderDeferred(false));
    _ = try fixture.drain(&bytes);
    try cli.completePresentation(.presented);
    try std.testing.expectEqual(@as(u32, 22), cli.checkHit(0, 0));
}

test "renderer presentation rejects legacy terminal setup without changing legacy rendering" {
    var fixture: Fixture = undefined;
    try fixture.init();
    defer fixture.deinit();
    const cli = fixture.cli;
    var bytes: [4096]u8 = undefined;
    cli.setupTerminal(false);
    _ = try fixture.drain(&bytes);
    const previous_stats = cli.getRenderStats();
    try fixture.paint("old", 11);
    try std.testing.expectError(error.IncompatibleOutput, cli.renderDeferred(true));
    try std.testing.expectEqualDeep(previous_stats, cli.getRenderStats());
    try std.testing.expectEqual(@as(usize, 0), (try fixture.drain(&bytes)).len);
    try std.testing.expectEqual(.rendered, cli.render(true));
    try std.testing.expect(std.mem.find(u8, try fixture.drain(&bytes), "old") != null);
    try std.testing.expectEqual(@as(u32, 11), cli.checkHit(0, 0));
}

test "renderer presentation cancellation and storage destruction release pending work" {
    for ([_]bool{ false, true }) |cancel| {
        var fixture: Fixture = undefined;
        try fixture.init();
        defer fixture.deinit();
        const cli = fixture.cli;
        var bytes: [4096]u8 = undefined;
        try fixture.paint("old", 11);
        try std.testing.expectEqual(.rendered, cli.render(true));
        _ = try fixture.drain(&bytes);
        const previous_stats = cli.getRenderStats();
        const value = try image.createFromRgba(std.testing.allocator, &.{ 255, 0, 0, 255 }, 1, 1, 4);
        defer value.deinit();
        try fixture.paint("last", 33);
        try std.testing.expect(try cli.getNextBuffer().drawImage(value, 1, 0, 1, 1, 1, 0, 0, 0, 0, 1, 1, .kitty));
        try std.testing.expectEqual(.rendered, try cli.renderDeferred(true));
        if (cancel) {
            cli.performShutdownSequence();
            try std.testing.expectError(error.NoPendingPresentation, cli.completePresentation(.presented));
            try std.testing.expectError(error.PresentationFailed, cli.renderDeferred(false));
        }
        try std.testing.expectEqual(@as(u32, 11), cli.checkHit(0, 0));
        try std.testing.expectEqualDeep(previous_stats, cli.getRenderStats());
    }
}
