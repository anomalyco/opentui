const std = @import("std");
const renderer = @import("../renderer.zig");
const feed_mod = @import("../native-span-feed.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");
const ansi = @import("../ansi.zig");

// The presented link-id plane must follow the hit grid: it publishes only when a frame is
// presented, never for a pending, skipped, failed, or cancelled frame, and it owns pool
// references for every id it shows.

const Fixture = struct {
    pool: gp.GraphemePool,
    links: link.LinkPool,
    env: std.process.Environ.Map,
    feed: *feed_mod.Stream,
    cli: *renderer.CliRenderer,

    fn init(self: *Fixture, max_bytes: u64) !void {
        self.pool = gp.GraphemePool.init(std.testing.allocator);
        errdefer self.pool.deinit();
        self.links = link.LinkPool.init(std.testing.allocator);
        errdefer self.links.deinit();
        self.env = std.process.Environ.Map.init(std.testing.allocator);
        errdefer self.env.deinit();
        self.feed = try feed_mod.Stream.create(std.testing.allocator, .{
            .chunk_size = 64,
            .initial_chunks = 64,
            .max_bytes = max_bytes,
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

    /// Draws `text` at the origin carrying a fresh key-only fragment, and returns its id.
    /// The id's only owner after the draw is the next buffer's cell reference.
    fn paintFragment(self: *Fixture, text: []const u8, key: u32) !u32 {
        const id = try self.links.acquireFragment("", key);
        defer self.links.decref(id) catch unreachable;
        try self.cli.getNextBuffer().drawText(text, 0, 0, ansi.rgbColor(255, 255, 255, 255), null, ansi.TextAttributes.setLinkId(0, id));
        return id;
    }

    fn drain(self: *Fixture) !void {
        var spans: [64]feed_mod.SpanInfo = undefined;
        const count = self.feed.drainSpans(&spans);
        for (spans[0..count]) |span| self.feed.markSpanConsumed(span);
    }
};

test "presented link ids wait for presentation of a deferred frame" {
    var fixture: Fixture = undefined;
    try fixture.init(4096);
    defer fixture.deinit();
    const cli = fixture.cli;

    const old = try fixture.paintFragment("old", 1);
    try std.testing.expectEqual(.rendered, cli.render(true));
    try fixture.drain();
    try std.testing.expectEqual(old, cli.getPresentedLinkId(0, 0));

    const new = try fixture.paintFragment("new", 2);
    try std.testing.expectEqual(.rendered, try cli.renderDeferred(true));
    // Encoding already synced the current buffer, but the frame is not presented.
    try std.testing.expectEqual(old, cli.getPresentedLinkId(0, 0));
    // The old id stays live through the plane even though no cell references it any more.
    try std.testing.expectEqual(@as(u32, 1), try fixture.links.getKey(old));
    try std.testing.expect((try fixture.links.getRefcount(old)) > 0);
    try fixture.drain();
    try std.testing.expectEqual(old, cli.getPresentedLinkId(0, 0));

    try cli.completePresentation(.presented);
    try std.testing.expectEqual(new, cli.getPresentedLinkId(0, 0));
    try std.testing.expectEqual(@as(u32, 0), try fixture.links.getRefcount(old));
}

test "presented link ids survive a failed presentation" {
    var fixture: Fixture = undefined;
    try fixture.init(4096);
    defer fixture.deinit();
    const cli = fixture.cli;

    const old = try fixture.paintFragment("old", 1);
    try std.testing.expectEqual(.rendered, cli.render(true));
    try fixture.drain();
    _ = try fixture.paintFragment("BAD", 2);
    try std.testing.expectEqual(.rendered, try cli.renderDeferred(false));
    try fixture.drain();
    try cli.completePresentation(.failed);
    try std.testing.expectEqual(old, cli.getPresentedLinkId(0, 0));
    try std.testing.expect((try fixture.links.getRefcount(old)) > 0);
}

test "presented link ids survive a cancelled presentation" {
    var fixture: Fixture = undefined;
    try fixture.init(4096);
    defer fixture.deinit();
    const cli = fixture.cli;

    const old = try fixture.paintFragment("old", 1);
    try std.testing.expectEqual(.rendered, cli.render(true));
    try fixture.drain();
    _ = try fixture.paintFragment("last", 3);
    try std.testing.expectEqual(.rendered, try cli.renderDeferred(true));
    cli.performShutdownSequence();
    try std.testing.expectEqual(old, cli.getPresentedLinkId(0, 0));
}

test "presented link ids survive a frame that is too large for the queue" {
    var fixture: Fixture = undefined;
    try fixture.init(4096);
    defer fixture.deinit();
    const cli = fixture.cli;

    const kept = try fixture.paintFragment("ok", 4);
    try std.testing.expectEqual(.rendered, cli.render(true));
    try fixture.drain();
    try std.testing.expectEqual(kept, cli.getPresentedLinkId(0, 0));

    // Distinct 512-byte URLs on every cell: each cell needs its own OSC 8 open of over 512 bytes,
    // so the 4 x 2 frame needs more than 4096 bytes and can never fit the queue.
    cli.terminal.caps.hyperlinks = true;
    var url: [link.MAX_URL_LENGTH]u8 = @splat('a');
    for (0..2) |y| {
        for (0..4) |x| {
            url[0] = @intCast('a' + y * 4 + x);
            const id = try fixture.links.acquire(&url);
            defer fixture.links.decref(id) catch unreachable;
            try cli.getNextBuffer().drawText("X", @intCast(x), @intCast(y), ansi.rgbColor(255, 255, 255, 255), null, ansi.TextAttributes.setLinkId(0, id));
        }
    }
    try std.testing.expectEqual(.failed, cli.render(true));
    try std.testing.expectEqual(kept, cli.getPresentedLinkId(0, 0));
    try std.testing.expect((try fixture.links.getRefcount(kept)) > 0);
}

test "presented link ids capture rows the diff skips" {
    var fixture: Fixture = undefined;
    try fixture.init(4096);
    defer fixture.deinit();
    const cli = fixture.cli;
    const top = try fixture.links.acquireFragment("", 5);
    defer fixture.links.decref(top) catch unreachable;
    const bottom = try fixture.links.acquireFragment("", 6);
    defer fixture.links.decref(bottom) catch unreachable;
    const white = ansi.rgbColor(255, 255, 255, 255);

    for (0..2) |_| {
        // Both frames are identical, so the second frame's diff skips every row.
        try cli.getNextBuffer().drawText("ab", 0, 0, white, null, ansi.TextAttributes.setLinkId(0, top));
        try cli.getNextBuffer().drawText("cd", 0, 1, white, null, ansi.TextAttributes.setLinkId(0, bottom));
        try std.testing.expectEqual(.rendered, cli.render(false));
        try fixture.drain();
        try std.testing.expectEqual(top, cli.getPresentedLinkId(1, 0));
        try std.testing.expectEqual(bottom, cli.getPresentedLinkId(1, 1));
    }
}

test "presented link ids reject out-of-range coordinates" {
    var fixture: Fixture = undefined;
    try fixture.init(4096);
    defer fixture.deinit();
    _ = try fixture.paintFragment("abcd", 7);
    try std.testing.expectEqual(.rendered, fixture.cli.render(true));
    try std.testing.expect(fixture.cli.getPresentedLinkId(3, 0) != 0);
    try std.testing.expectEqual(@as(u32, 0), fixture.cli.getPresentedLinkId(4, 0));
    try std.testing.expectEqual(@as(u32, 0), fixture.cli.getPresentedLinkId(0, 2));
    try std.testing.expectEqual(@as(u32, 0), fixture.cli.getPresentedLinkId(std.math.maxInt(u32), std.math.maxInt(u32)));
}

test "presented link ids are dropped when the terminal is cleared, until the next frame" {
    var fixture: Fixture = undefined;
    try fixture.init(4096);
    defer fixture.deinit();
    const cli = fixture.cli;

    const shown = try fixture.paintFragment("shown", 12);
    try std.testing.expectEqual(.rendered, cli.render(true));
    try fixture.drain();
    try std.testing.expectEqual(shown, cli.getPresentedLinkId(0, 0));
    const held = try fixture.links.getRefcount(shown);

    cli.clearTerminal();
    try fixture.drain();
    // The plane released its reference; the current buffer's cell still holds its own.
    try std.testing.expectEqual(@as(u32, 0), cli.getPresentedLinkId(0, 0));
    try std.testing.expectEqual(held - 1, try fixture.links.getRefcount(shown));

    const again = try fixture.paintFragment("again", 13);
    try std.testing.expectEqual(.rendered, cli.render(true));
    try fixture.drain();
    try std.testing.expectEqual(again, cli.getPresentedLinkId(0, 0));
}

test "presented link ids are dropped once the shutdown sequence is written" {
    var fixture: Fixture = undefined;
    try fixture.init(4096);
    defer fixture.deinit();
    const cli = fixture.cli;

    const shown = try fixture.paintFragment("shown", 14);
    try std.testing.expectEqual(.rendered, cli.render(true));
    try fixture.drain();
    try std.testing.expectEqual(shown, cli.getPresentedLinkId(0, 0));

    cli.terminalSetup = true;
    cli.performShutdownSequence();
    try fixture.drain();
    try std.testing.expectEqual(@as(u32, 0), cli.getPresentedLinkId(0, 0));
}

test "presented link ids: a frame without links replaces the plane and drops its references" {
    var fixture: Fixture = undefined;
    try fixture.init(4096);
    defer fixture.deinit();
    const cli = fixture.cli;

    const shown = try fixture.paintFragment("link", 15);
    try std.testing.expectEqual(.rendered, cli.render(true));
    try fixture.drain();
    try std.testing.expectEqual(shown, cli.getPresentedLinkId(3, 0));

    // No cell of this frame carries a link id, so staging takes the empty-tracker shortcut.
    try cli.getNextBuffer().drawText("text", 0, 0, ansi.rgbColor(255, 255, 255, 255), null, 0);
    try std.testing.expect(!cli.getNextBuffer().link_tracker.hasAny());
    try std.testing.expectEqual(.rendered, cli.render(true));
    try fixture.drain();
    for (0..4) |x| try std.testing.expectEqual(@as(u32, 0), cli.getPresentedLinkId(@intCast(x), 0));
    try std.testing.expectEqual(@as(u32, 0), try fixture.links.getRefcount(shown));

    // Links in a later frame publish again.
    const again = try fixture.paintFragment("next", 16);
    try std.testing.expectEqual(.rendered, cli.render(true));
    try fixture.drain();
    try std.testing.expectEqual(again, cli.getPresentedLinkId(3, 0));
}

test "presented link ids stage ids that the next buffer's tracker does not count" {
    var fixture: Fixture = undefined;
    try fixture.init(4096);
    defer fixture.deinit();
    const cli = fixture.cli;
    const tracked = try fixture.paintFragment("ab", 8);
    // A cell id written without the tracker: staging reserves too little and must grow.
    const untracked = try fixture.links.acquireFragment("", 9);
    defer fixture.links.decref(untracked) catch unreachable;
    const next = cli.getNextBuffer();
    next.buffer.attributes[3] = ansi.TextAttributes.setLinkId(0, untracked);
    try std.testing.expectEqual(@as(u32, 1), next.link_tracker.getLinkCount());

    try std.testing.expectEqual(.rendered, cli.render(true));
    try fixture.drain();
    try std.testing.expectEqual(tracked, cli.getPresentedLinkId(0, 0));
    try std.testing.expectEqual(untracked, cli.getPresentedLinkId(3, 0));
    // The plane holds its own reference, next to the one this test holds.
    try std.testing.expect((try fixture.links.getRefcount(untracked)) >= 2);
}

test "link tracker reports allocation failure instead of aborting" {
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const id = try links.acquireFragment("", 10);
    defer links.decref(id) catch unreachable;
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0 });
    var tracker = link.LinkTracker.init(failing.allocator(), &links);
    defer tracker.deinit();
    try std.testing.expectError(error.OutOfMemory, tracker.tryAddCellRef(id));
    try std.testing.expectEqual(@as(u32, 0), tracker.getLinkCount());
    try std.testing.expectEqual(@as(u32, 1), try links.getRefcount(id));
}

test "presented link ids: a staging allocation failure fails the frame and keeps the plane" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    const feed = try feed_mod.Stream.create(std.testing.allocator, .{
        .chunk_size = 64,
        .initial_chunks = 64,
        .max_bytes = 4096,
        .growth_policy = @intFromEnum(feed_mod.GrowthPolicy.block),
        .auto_commit_on_full = 0,
        .span_queue_capacity = 64,
    });
    defer feed.destroy();
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    const cli = try renderer.CliRenderer.createWithOptions(failing.allocator(), 4, 2, &pool, .{
        .output = .{ .feed = feed },
        .link_pool = &links,
        .env_map = &env,
    });
    defer cli.destroy();
    const white = ansi.rgbColor(255, 255, 255, 255);
    const drain = struct {
        fn run(stream: *feed_mod.Stream) void {
            var spans: [64]feed_mod.SpanInfo = undefined;
            const count = stream.drainSpans(&spans);
            for (spans[0..count]) |span| stream.markSpanConsumed(span);
        }
    }.run;

    const kept = try links.acquireFragment("", 11);
    defer links.decref(kept) catch unreachable;
    try cli.getNextBuffer().drawText("ok", 0, 0, white, null, ansi.TextAttributes.setLinkId(0, kept));
    try std.testing.expectEqual(.rendered, cli.render(true));
    drain(feed);
    try std.testing.expectEqual(kept, cli.getPresentedLinkId(0, 0));

    // Eight ids that the tracker does not count, so staging must grow its map while encoding.
    // One tracked id is drawn first: a buffer whose tracker is empty skips staging entirely.
    var ids: [8]u32 = undefined;
    for (&ids, 0..) |*id, index| id.* = try links.acquireFragment("", @intCast(20 + index));
    defer for (ids) |id| links.decref(id) catch unreachable;
    const next = cli.getNextBuffer();
    try next.drawText("k", 0, 0, white, null, ansi.TextAttributes.setLinkId(0, kept));
    for (ids, 0..) |id, index| next.buffer.attributes[index] = ansi.TextAttributes.setLinkId(0, id);
    failing.fail_index = failing.alloc_index;
    const status = cli.render(true);
    failing.fail_index = std.math.maxInt(usize);
    drain(feed);
    try std.testing.expectEqual(.failed, status);
    // The failed frame published nothing and dropped every staged reference.
    try std.testing.expectEqual(kept, cli.getPresentedLinkId(0, 0));
    for (ids) |id| try std.testing.expectEqual(@as(u32, 1), try links.getRefcount(id));
}
