const std = @import("std");
const TestPools = @import("test-pools.zig").TestPools;
const io = std.testing.io;
const renderer = @import("../renderer.zig");
const text_buffer = @import("../text-buffer.zig");
const text_buffer_view = @import("../text-buffer-view.zig");
const buffer = @import("../buffer.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");
const ansi = @import("../ansi.zig");
const image = @import("../image.zig");
const ghostty_vt = @import("../ghostty-vt.zig");
const test_renderer_mod = @import("test-renderer.zig");
const terminal_image_test = @import("terminal-image_test.zig");
const owned_styled = @import("owned-styled-text.zig");
const utils = @import("../utils.zig");
const native_span_feed = @import("../native-span-feed.zig");
const terminal_mod = @import("../terminal.zig");

const CliRenderer = renderer.CliRenderer;
const TextBuffer = text_buffer.TextBuffer;
const TextBufferView = text_buffer_view.TextBufferView;
const OptimizedBuffer = buffer.OptimizedBuffer;
const RGBA = text_buffer.RGBA;
const TestRenderer = test_renderer_mod.TestRenderer;
const renderPresented = test_renderer_mod.renderPresented;
const FixedSink = test_renderer_mod.FixedSink;
const discard = test_renderer_mod.discard;

test "standalone renderer pools survive either owner teardown order" {
    const allocator = std.testing.allocator;
    const glyphs = [_][]const u8{ "e\xcc\x81", "o\xcc\x82" };
    const urls = [_][]const u8{ "https://first.invalid", "https://second.invalid" };
    for (0..2) |first| {
        var pools = [_]gp.GraphemePool{ gp.GraphemePool.init(allocator), gp.GraphemePool.init(allocator) };
        var links = [_]link.LinkPool{ link.LinkPool.init(allocator), link.LinkPool.init(allocator) };
        var alive = [_]bool{ true, true };
        var renderers: [2]?TestRenderer = .{ null, null };
        defer for (0..2) |i| {
            if (renderers[i]) |*value| value.deinit();
            if (alive[i]) {
                links[i].deinit();
                pools[i].deinit();
            }
        };

        var ids: [2]u32 = undefined;
        for (0..2) |i| {
            renderers[i] = try TestRenderer.create(allocator, 4, 1, &pools[i], &links[i]);
            const target = renderers[i].?.renderer;
            target.terminal.caps.hyperlinks = true;
            ids[i] = try links[i].acquire(urls[i]);
            defer links[i].decref(ids[i]) catch unreachable;
            try target.getNextBuffer().drawText(glyphs[i], 0, 0, ansi.rgbColor(255, 255, 255, 255), null, ansi.TextAttributes.setLinkId(0, ids[i]));
            try std.testing.expectEqual(renderer.RenderStatus.rendered, renderers[i].?.render(true));
            try std.testing.expect(std.mem.find(u8, renderers[i].?.lastOutput(), glyphs[i]) != null);
            try std.testing.expect(std.mem.find(u8, renderers[i].?.lastOutput(), urls[i]) != null);
        }
        try std.testing.expectEqual(ids[0], ids[1]);
        renderers[first].?.deinit();
        renderers[first] = null;
        try std.testing.expectEqual(@as(u32, 0), pools[first].interned_live_ids.count());
        try std.testing.expectEqual(@as(u32, 0), links[first].interned_live_ids.count());
        links[first].deinit();
        pools[first].deinit();
        alive[first] = false;

        const remaining = 1 - first;
        const target = renderers[remaining].?.renderer;
        try std.testing.expectEqualStrings(urls[remaining], try links[remaining].get(ids[remaining]));
        try target.getNextBuffer().drawText(glyphs[remaining], 1, 0, ansi.rgbColor(255, 255, 255, 255), null, ansi.TextAttributes.setLinkId(0, ids[remaining]));
        try std.testing.expectEqual(renderer.RenderStatus.rendered, renderers[remaining].?.render(true));
        try std.testing.expect(std.mem.find(u8, renderers[remaining].?.lastOutput(), glyphs[remaining]) != null);
        try std.testing.expect(std.mem.find(u8, renderers[remaining].?.lastOutput(), urls[remaining]) != null);
        renderers[remaining].?.deinit();
        renderers[remaining] = null;
        try std.testing.expectEqual(@as(u32, 0), pools[remaining].interned_live_ids.count());
        try std.testing.expectEqual(@as(u32, 0), links[remaining].interned_live_ids.count());
    }
}

test "standalone renderer construction failures preserve borrowed pools" {
    const Probe = struct {
        fn run(allocator: std.mem.Allocator) !void {
            var pool = gp.GraphemePool.init(std.testing.allocator);
            defer pool.deinit();
            var links = link.LinkPool.init(std.testing.allocator);
            defer links.deinit();
            const glyph_id = try pool.acquire("e\xcc\x81");
            defer pool.decref(glyph_id) catch unreachable;
            const link_id = try links.acquire("https://survivor.invalid");
            defer links.decref(link_id) catch unreachable;
            var env = std.process.Environ.Map.init(std.testing.allocator);
            defer env.deinit();
            const feed = try native_span_feed.Stream.create(std.testing.allocator, null);
            defer feed.destroy();
            const result = CliRenderer.createWithOptions(allocator, 4, 1, &pool, .{
                .link_pool = &links,
                .feed = feed,
                .env_map = &env,
            });
            if (result) |value| value.destroyStorage() else |_| {}
            try std.testing.expectEqual(@as(u32, 1), try pool.getRefcount(glyph_id));
            try std.testing.expectEqual(@as(u32, 1), try links.getRefcount(link_id));
            try std.testing.expectEqualStrings("e\xcc\x81", try pool.get(glyph_id));
            try std.testing.expectEqualStrings("https://survivor.invalid", try links.get(link_id));
            _ = try result;
        }
    };
    try std.testing.checkAllAllocationFailures(std.testing.allocator, Probe.run, .{});
}

const DiscardTerminalWriter = struct {
    pub fn writeAll(_: *DiscardTerminalWriter, _: []const u8) !void {}
};

fn lastSixelFrame(output: []const u8) ![]const u8 {
    const start = std.mem.findLast(u8, output, "\x1bP0;1;0q") orelse return error.NoSixelPayload;
    const end = std.mem.findPos(u8, output, start, "\x1b\\") orelse return error.NoSixelPayload;
    return output[start .. end + 2];
}

fn drawTranslucentSixelGeometry(
    target: *OptimizedBuffer,
    value: *image.Image,
    image_handle: u32,
    cell_width: u32,
    cell_height: u32,
) !void {
    const backgrounds = [_]buffer.RGBA{
        ansi.rgbColor(0, 0, 0, 255),
        ansi.rgbColor(255, 0, 0, 255),
        ansi.rgbColor(0, 255, 0, 255),
        ansi.rgbColor(0, 0, 255, 255),
    };
    for (backgrounds, 0..) |background, index| {
        const x: u32 = if (cell_width == 1) 0 else @intCast(index % cell_width);
        const y: u32 = if (cell_width == 1) @intCast(index) else @intCast(index / cell_width);
        target.setRaw(x, y, .{ .char = ' ', .fg = ansi.rgbColor(255, 255, 255, 255), .bg = background, .attributes = 0 });
    }
    try target.pushOpacity(0.5);
    defer target.popOpacity();
    try std.testing.expect(try target.drawImage(value, image_handle, 0, 0, cell_width, cell_height, 4, 4, 0, 0, 4, 4, .sixel));
}

test "renderer emits Kitty image once and leaves unchanged frame empty" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 2, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const image_handle: u32 = 1;
    test_renderer.renderer.terminal.caps.kitty_graphics = true;
    test_renderer.renderer.terminal.multiplexer = .none;

    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1b_Ga=t,f=24,s=1,v=1,i=") != null);
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "c=1,r=1,x=0,y=0,w=1,h=1,C=1,z=-1073741823") != null);

    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(false));
    try std.testing.expectEqual(@as(usize, 0), test_renderer.memory.lastWrite().len);

    const r = test_renderer.renderer;
    try r.pendingImages.appendSlice(std.testing.allocator, r.currentImages.items);
    try std.testing.expect(r.setKittyImageTransport(0));
    try std.testing.expect(!r.setKittyImageTransport(3));
    try std.testing.expectEqual(.raw, r.kittyTransport.mode);
    try std.testing.expectEqual(image_handle, r.currentImages.items[0].image_handle);
    try std.testing.expectEqual(image_handle, r.pendingImages.items[0].image_handle);
    try std.testing.expect(!r.force_full_repaint);
    try std.testing.expect(r.setKittyImageTransport(1));
    try std.testing.expectEqual(@as(u32, 0), r.currentImages.items[0].image_handle);
    try std.testing.expectEqual(@as(u32, 0), r.pendingImages.items[0].image_handle);
    try std.testing.expect(r.force_full_repaint);
}

test "renderer emits Sixel only with known pixel dimensions" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 2, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const image_handle: u32 = 1;
    test_renderer.renderer.terminal.caps.sixel = true;
    test_renderer.renderer.terminal.multiplexer = .none;

    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q") != null);
    try std.testing.expectEqual(@as(u64, 1), test_renderer.renderer.sixelCacheMisses);
    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q") != null);
    try std.testing.expectEqual(@as(u64, 1), test_renderer.renderer.sixelCacheHits);

    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 1, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    try std.testing.expectEqual(@as(u64, 2), test_renderer.renderer.sixelCacheHits);

    try test_renderer.renderer.getNextBuffer().pushOpacity(0.5);
    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 1, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    test_renderer.renderer.getNextBuffer().popOpacity();
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    try std.testing.expectEqual(@as(u64, 2), test_renderer.renderer.sixelCacheMisses);
}

test "renderer separates translucent Sixel cache entries by cell geometry" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var cached_renderer = try TestRenderer.create(std.testing.allocator, 2, 4, &pools.graphemes, &pools.links);
    defer cached_renderer.deinit();
    var fresh_renderer = try TestRenderer.create(std.testing.allocator, 2, 4, &pools.graphemes, &pools.links);
    defer fresh_renderer.deinit();
    const pixels: [64]u8 = @splat(255);
    const value = try image.createFromRgba(std.testing.allocator, &pixels, 4, 4, 16);
    defer value.deinit();
    const image_handle: u32 = 1;
    cached_renderer.renderer.terminal.caps.sixel = true;
    fresh_renderer.renderer.terminal.caps.sixel = true;

    try drawTranslucentSixelGeometry(cached_renderer.renderer.getNextBuffer(), value, image_handle, 1, 4);
    try std.testing.expectEqual(renderer.RenderStatus.rendered, cached_renderer.render(true));
    try drawTranslucentSixelGeometry(cached_renderer.renderer.getNextBuffer(), value, image_handle, 2, 2);
    try std.testing.expectEqual(renderer.RenderStatus.rendered, cached_renderer.render(true));
    try std.testing.expectEqual(@as(u64, 0), cached_renderer.renderer.sixelCacheHits);
    try std.testing.expectEqual(@as(u64, 2), cached_renderer.renderer.sixelCacheMisses);

    try drawTranslucentSixelGeometry(fresh_renderer.renderer.getNextBuffer(), value, image_handle, 2, 2);
    try std.testing.expectEqual(renderer.RenderStatus.rendered, fresh_renderer.render(true));

    try std.testing.expectEqualSlices(
        u8,
        try lastSixelFrame(fresh_renderer.memory.lastWrite()),
        try lastSixelFrame(cached_renderer.memory.lastWrite()),
    );
}

test "renderer does not copy identity Sixel geometry" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 1, 1, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();

    var source_allocator = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    const value = try image.createFromRgba(source_allocator.allocator(), &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const image_handle: u32 = 1;
    // A full-image extract consumes two allocations. Fail if rendering tries
    // to allocate a second image copy for the identity resize.
    source_allocator.fail_index = source_allocator.alloc_index + 2;
    const source_allocations_before_render = source_allocator.allocations;
    test_renderer.renderer.terminal.caps.sixel = true;

    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    try std.testing.expect(!source_allocator.has_induced_failure);
    try std.testing.expectEqual(source_allocations_before_render, source_allocator.allocations);
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q") != null);
}

test "renderer repaints unchanged upper Sixel after an overlapping lower image changes" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 1, 1, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();

    const red = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer red.deinit();
    const blue = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 0, 255, 255 }, 1, 1, 4);
    defer blue.deinit();
    const green = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 255, 0, 255 }, 1, 1, 4);
    defer green.deinit();
    const red_handle: u32 = 1;
    const blue_handle: u32 = 2;
    const green_handle: u32 = 3;
    test_renderer.renderer.terminal.caps.sixel = true;
    test_renderer.renderer.terminal.multiplexer = .none;

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(blue, blue_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(green, green_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(blue, blue_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(false));

    const output = test_renderer.memory.lastWrite();
    try std.testing.expectEqual(@as(usize, 2), std.mem.count(u8, output, "\x1bP0;1;0q"));
    try expectSinglePaintedSixelColor(output, .{ 0, 2 }, .{ 0, 2 }, .{ 95, 100 });
}

test "renderer repaints overlapping Sixel images when their order changes" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 1, 1, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();

    const red = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer red.deinit();
    const blue = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 0, 255, 255 }, 1, 1, 4);
    defer blue.deinit();
    const red_handle: u32 = 1;
    const blue_handle: u32 = 2;
    test_renderer.renderer.terminal.caps.sixel = true;
    test_renderer.renderer.terminal.multiplexer = .none;

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(blue, blue_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(blue, blue_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(false));

    const output = test_renderer.memory.lastWrite();
    try std.testing.expectEqual(@as(usize, 2), std.mem.count(u8, output, "\x1bP0;1;0q"));
    try expectSinglePaintedSixelColor(output, .{ 95, 100 }, .{ 0, 2 }, .{ 0, 2 });
}

test "renderer propagates Sixel repaint through an overlap chain" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 6, 1, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    test_renderer.renderer.terminal.caps.sixel = true;

    const red = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer red.deinit();
    const green = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 255, 0, 255 }, 1, 1, 4);
    defer green.deinit();
    const blue = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 0, 255, 255 }, 1, 1, 4);
    defer blue.deinit();
    const white = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 255, 255, 255 }, 1, 1, 4);
    defer white.deinit();
    const red_handle: u32 = 1;
    const green_handle: u32 = 2;
    const blue_handle: u32 = 3;
    const white_handle: u32 = 4;

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 2, 1, 2, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(blue, blue_handle, 1, 0, 2, 1, 2, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(white, white_handle, 2, 0, 2, 1, 2, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(red, red_handle, 5, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(green, green_handle, 0, 0, 2, 1, 2, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(blue, blue_handle, 1, 0, 2, 1, 2, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(white, white_handle, 2, 0, 2, 1, 2, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(red, red_handle, 5, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(false));

    try std.testing.expectEqual(@as(usize, 3), std.mem.count(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q"));
}

test "renderer repaints lower Sixel after removing an overlapping upper image" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 1, 1, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();

    const red = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer red.deinit();
    const blue = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 0, 255, 255 }, 1, 1, 4);
    defer blue.deinit();
    const red_handle: u32 = 1;
    const blue_handle: u32 = 2;
    test_renderer.renderer.terminal.caps.sixel = true;
    test_renderer.renderer.terminal.multiplexer = .none;

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(blue, blue_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(false));

    const output = test_renderer.memory.lastWrite();
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, output, "\x1bP0;1;0q"));
    try expectSinglePaintedSixelColor(output, .{ 95, 100 }, .{ 0, 2 }, .{ 0, 2 });
}

test "renderer repaints lower Sixel when an overlapping upper image becomes transparent" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 1, 1, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();

    const red = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer red.deinit();
    const blue = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 0, 255, 255 }, 1, 1, 4);
    defer blue.deinit();
    const transparent = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 0, 0, 0 }, 1, 1, 4);
    defer transparent.deinit();
    const red_handle: u32 = 1;
    const blue_handle: u32 = 2;
    const transparent_handle: u32 = 3;
    test_renderer.renderer.terminal.caps.sixel = true;
    test_renderer.renderer.terminal.multiplexer = .none;

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(blue, blue_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(transparent, transparent_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(false));

    const output = test_renderer.memory.lastWrite();
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, output, "\x1bP0;1;0q"));
    try expectSinglePaintedSixelColor(output, .{ 95, 100 }, .{ 0, 2 }, .{ 0, 2 });
}

test "renderer honors per-placement protocol overrides" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 2, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const image_handle: u32 = 1;

    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .kitty));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1b_Ga=t") != null);

    test_renderer.renderer.terminal.caps.kitty_graphics = true;
    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .blocks));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1b_Ga=t") == null);
}

test "renderer does not send forced Sixel to Apple Terminal" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.createWithEnv(std.testing.allocator, 4, 2, &pools.graphemes, &pools.links, &.{
        .{ .key = "TERM_PROGRAM", .value = "Apple_Terminal" },
    });
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const image_handle: u32 = 1;

    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    const output = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, output, "\x1bP0;1;0q") == null);
    try std.testing.expect(std.mem.find(u8, output, "█") != null);
}

test "renderer honors forced Sixel through tmux independently of tmux DA" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.createWithEnv(std.testing.allocator, 4, 2, &pools.graphemes, &pools.links, &.{
        .{ .key = "TERM_PROGRAM", .value = "Apple_Terminal" },
    });
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const image_handle: u32 = 1;
    test_renderer.renderer.terminal.processCapabilityResponse("\x1bP>|tmux 3.5a\x1b\\");
    test_renderer.renderer.terminal.processCapabilityResponse("\x1b[?62;4c");

    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    const output = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, output, "\x1bPtmux;") != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b\x1bP0;1;0q") != null);
}

test "renderer enables focus tracking after late tmux detection without passthrough probes" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 2, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();

    var writer = DiscardTerminalWriter{};
    try test_renderer.renderer.terminal.queryTerminalSend(&writer);
    // tmux before 3.6 answers XTVERSION but not DECRQM. A Session applies a reply like this.
    test_renderer.renderer.terminal.processCapabilityResponse("\x1bP>|tmux 3.5a\x1b\\");
    var features: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer features.deinit();
    try test_renderer.renderer.terminal.enableDetectedFeatures(&features.writer, false);

    const output = features.written();
    try std.testing.expect(std.mem.find(u8, output, ansi.ANSI.focusSet) != null);
    try std.testing.expect(std.mem.find(u8, output, ansi.ANSI.tmuxDcsStart) == null);
}

test "renderer does not send forced Sixel to Kitty" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 2, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const image_handle: u32 = 1;
    test_renderer.renderer.terminal.processCapabilityResponse("\x1bP>|kitty(0.48.2)\x1b\\");

    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    const output = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, output, "\x1bP0;1;0q") == null);
    try std.testing.expect(std.mem.find(u8, output, "█") != null);
}

test "renderer honors global image protocol override for auto placements" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 2, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const image_handle: u32 = 1;
    test_renderer.renderer.terminal.image_protocol = .kitty;
    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1b_Ga=t") != null);
}

test "renderer keeps unresolved Sixel fallback frames as no-ops" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 2, 1, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const image_handle: u32 = 1;
    test_renderer.renderer.terminal.caps.sixel = true;
    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    const first = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, first, "\x1bP0;1;0q") == null);
    try std.testing.expect(std.mem.find(u8, first, "█") != null);
    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(false));
    try std.testing.expectEqual(@as(usize, 0), test_renderer.memory.lastWrite().len);
}

test "renderer repaints a final blocks placement over Sixel" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 2, 1, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const image_handle: u32 = 1;
    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .blocks));
    _ = test_renderer.render(true);
    const output = test_renderer.memory.lastWrite();
    const sixel = std.mem.find(u8, output, "\x1bP0;1;0q") orelse return error.TestUnexpectedResult;
    const block = std.mem.findLast(u8, output, "█") orelse return error.TestUnexpectedResult;
    try std.testing.expect(block > sixel);
}

test "renderer does not retransmit Sixel when overlay text changes" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 2, 1, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const image_handle: u32 = 1;
    const fg = RGBA{ 1.0, 1.0, 1.0, 1.0 };
    const bg = RGBA{ 0.0, 0.0, 0.0, 1.0 };

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 2, 1, 2, 2, 0, 0, 1, 1, .sixel));
    _ = test_renderer.render(true);

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 2, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try next.drawText("1", 1, 0, fg, bg, 0);
    _ = test_renderer.render(false);
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q") == null);
    try std.testing.expect(std.mem.findScalar(u8, test_renderer.memory.lastWrite(), '1') != null);

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 2, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try next.drawText("2", 1, 0, fg, bg, 0);
    _ = test_renderer.render(false);
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q") == null);
    try std.testing.expect(std.mem.findScalar(u8, test_renderer.memory.lastWrite(), '2') != null);

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 2, 1, 2, 2, 0, 0, 1, 1, .sixel));
    _ = test_renderer.render(false);
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q") != null);
}

test "renderer replays a wide grapheme that starts before a Sixel placement" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 2, 1, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const image_handle: u32 = 1;

    const next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 1, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try next.drawText("界", 0, 0, ansi.rgbColor(255, 255, 255, 0), ansi.rgbColor(0, 0, 0, 0), 0);
    _ = test_renderer.render(true);

    const output = test_renderer.memory.lastWrite();
    const sixel = std.mem.find(u8, output, "\x1bP0;1;0q") orelse return error.TestUnexpectedResult;
    const overlay = std.mem.findLast(u8, output, "界") orelse return error.TestUnexpectedResult;
    try std.testing.expect(overlay > sixel);
}

test "renderer preserves terminal semantics when replaying cells over Sixel" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 3, 1, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    test_renderer.renderer.terminal.caps.sixel = true;
    test_renderer.renderer.terminal.caps.hyperlinks = true;
    test_renderer.renderer.terminal.caps.explicit_width = true;
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const image_handle: u32 = 1;
    const link_id = try pools.links.acquire("https://example.com/replayed");
    const linked_bold = ansi.TextAttributes.setLinkId(ansi.TextAttributes.BOLD, link_id);

    const next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 3, 1, 6, 2, 0, 0, 1, 1, .sixel));
    try next.drawText("界", 0, 0, ansi.rgbColor(255, 255, 255, 255), ansi.rgbColor(0, 0, 0, 255), linked_bold);
    try next.drawText("X", 2, 0, ansi.rgbColor(255, 255, 255, 255), ansi.rgbColor(0, 0, 0, 255), 0);
    _ = test_renderer.render(true);

    const output = test_renderer.memory.lastWrite();
    const sixel = std.mem.findLast(u8, output, "\x1bP0;1;0q") orelse return error.TestUnexpectedResult;
    const replay = output[sixel..];
    try std.testing.expect(std.mem.find(u8, replay, "\x1b]8;id=") != null);
    try std.testing.expect(std.mem.find(u8, replay, ";https://example.com/replayed\x1b\\") != null);
    try std.testing.expect(std.mem.find(u8, replay, "\x1b]8;;\x1b\\") != null);
    try std.testing.expect(std.mem.find(u8, replay, "\x1b]66;w=2;界\x1b\\") != null);
    try std.testing.expect(std.mem.find(u8, replay, "\x1b[0m\x1b[1;3H") != null);
}

test "renderer explicit width gives OSC 66 at most 7 cells and pads a wider glyph with spaces" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    const family = "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}";
    const men = "\u{1f468}" ++ utils.repeat(u8, "\u{200d}\u{1f468}", 7);
    // Kitty clamps w to 7 and foot ignores a larger w, so the spaces keep | at the glyph's last cell + 1.
    const rows = [_]struct { []const u8, []const u8 }{
        .{ family, "\x1b]66;w=6;" ++ family ++ "\x1b\\|" },
        .{ family ++ "\u{200d}\u{1f466}", "\x1b]66;w=7;" ++ family ++ "\u{200d}\u{1f466}\x1b\\ |" },
        .{ men, "\x1b]66;w=7;" ++ men ++ "\x1b\\" ++ utils.repeat(u8, " ", 9) ++ "|" },
    };
    for (rows) |row| {
        var test_renderer = try TestRenderer.create(std.testing.allocator, 20, 1, &pools.graphemes, &pools.links);
        defer test_renderer.deinit();
        test_renderer.renderer.terminal.caps.unicode = .wcwidth;
        test_renderer.renderer.terminal.caps.explicit_width = true;
        test_renderer.renderer.syncWidthMethod();
        var line: [64]u8 = undefined;
        try test_renderer.renderer.getNextBuffer().drawText(try std.fmt.bufPrint(&line, "{s}|", .{row[0]}), 0, 0, ansi.rgbColor(255, 255, 255, 255), ansi.rgbColor(0, 0, 0, 255), 0);
        try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
        try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), row[1]) != null);
    }
}

test "renderer preserves Malayalam report after Ghostty probe replies" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 80, 1, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    try std.testing.expect(test_renderer.renderer.setTerminalEnvVar("TERM_PROGRAM", "ghostty"));
    try std.testing.expect(test_renderer.renderer.setTerminalEnvVar("TERM_PROGRAM_VERSION", "1.3.1"));

    var writer = DiscardTerminalWriter{};
    try test_renderer.renderer.terminal.queryTerminalSend(&writer);
    test_renderer.renderer.terminal.processCapabilityResponse("\x1b[1;5R");
    test_renderer.renderer.terminal.processCapabilityResponse("\x1b[1;1R");
    test_renderer.renderer.terminal.processCapabilityResponse("\x1b[1;1R\x1bP>|ghostty 1.3.1\x1b\\");

    const report = "OpenCode search configuration പരിശോധിക്കൽ";
    try test_renderer.renderer.getNextBuffer().drawText(
        report,
        0,
        0,
        ansi.rgbColor(255, 255, 255, 255),
        ansi.rgbColor(0, 0, 0, 255),
        0,
    );
    try test_renderer.renderer.getNextBuffer().drawText(
        "|",
        40,
        0,
        ansi.rgbColor(255, 255, 255, 255),
        ansi.rgbColor(0, 0, 0, 255),
        0,
    );
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));

    const output = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, output, "\x1b]66;") == null);

    var terminal: ghostty_vt.vt.Terminal = try .init(std.testing.io, std.testing.allocator, .{
        .cols = 80,
        .rows = 1,
    });
    defer terminal.deinit(std.testing.allocator);
    var stream = terminal.vtStream();
    defer stream.deinit();
    stream.nextSlice("\x1b[?2027h");
    stream.nextSlice(output);

    const screen = try terminal.plainString(std.testing.allocator);
    defer std.testing.allocator.free(screen);
    try std.testing.expectEqualStrings(report ++ "|", std.mem.trimEnd(u8, screen, " "));
}

test "renderer preserves wide grapheme when continuation and next cell colors match" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    // OpenTUI text and the host (Ghostty) agree on Unicode 17 widths: U+1F6D9 is unassigned there, and
    // a consonant after U+1CF5 starts its own cell.
    for ([_][]const u8{ "✅ X", "\u{1F6D9} X", "\u{1CF5}\u{0915} X" }) |text| {
        var test_renderer = try TestRenderer.create(std.testing.allocator, 6, 1, &pools.graphemes, &pools.links);
        defer test_renderer.deinit();
        try std.testing.expect(test_renderer.renderer.setTerminalEnvVar("TERM_PROGRAM", "ghostty"));
        try std.testing.expect(test_renderer.renderer.setTerminalEnvVar("TERM_PROGRAM_VERSION", "1.3.1"));

        const foreground = ansi.rgbColor(255, 255, 255, 255);
        const background = ansi.rgbColor(0, 0, 0, 255);
        var next = test_renderer.renderer.getNextBuffer();
        try next.drawText(text, 0, 0, foreground, background, 0);
        try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));

        next = test_renderer.renderer.getNextBuffer();
        try next.drawText(text, 0, 0, foreground, background, 0);
        const colors = [_]buffer.RGBA{
            ansi.rgbColor(200, 0, 0, 255),
            ansi.rgbColor(0, 200, 0, 255),
            ansi.rgbColor(0, 200, 0, 255),
            ansi.rgbColor(0, 0, 200, 255),
        };
        for (colors, 0..) |color, x| {
            var cell = next.get(@intCast(x), 0).?;
            cell.fg = color;
            next.setRaw(@intCast(x), 0, cell);
        }
        try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(false));

        var terminal: ghostty_vt.vt.Terminal = try .init(std.testing.io, std.testing.allocator, .{
            .cols = 6,
            .rows = 1,
        });
        defer terminal.deinit(std.testing.allocator);
        var stream = terminal.vtStream();
        defer stream.deinit();
        stream.nextSlice("\x1b[?2027h");
        stream.nextSlice(test_renderer.memory.bytes.items);

        const screen = try terminal.plainString(std.testing.allocator);
        defer std.testing.allocator.free(screen);
        try std.testing.expectEqualStrings(text, std.mem.trimEnd(u8, screen, " "));
    }
}

test "renderer updates text after a default-ignorable code point where Ghostty shows it" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    const white = ansi.rgbColor(255, 255, 255, 255);
    const black = ansi.rgbColor(0, 0, 0, 255);
    // A left-to-right mark after a base, and a tag character at the line start: each takes no cell.
    const rows = [_]struct { []const u8, []const u8 }{ .{ "a\u{200e}", "abcdeZ" }, .{ "\u{e0041}", "bcdeZ" } };
    for (rows) |row| {
        var test_renderer = try TestRenderer.create(std.testing.allocator, 8, 1, &pools.graphemes, &pools.links);
        defer test_renderer.deinit();
        for ([_][]const u8{ "bcdef", "bcdeZ" }, [_]bool{ true, false }) |tail, force| {
            var line: [16]u8 = undefined;
            try test_renderer.renderer.getNextBuffer().drawText(try std.fmt.bufPrint(&line, "{s}{s}", .{ row[0], tail }), 0, 0, white, black, 0);
            try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(force));
        }
        var terminal: ghostty_vt.vt.Terminal = try .init(std.testing.io, std.testing.allocator, .{ .cols = 8, .rows = 1 });
        defer terminal.deinit(std.testing.allocator);
        var stream = terminal.vtStream();
        defer stream.deinit();
        stream.nextSlice(test_renderer.memory.bytes.items);
        const screen = try terminal.plainString(std.testing.allocator);
        defer std.testing.allocator.free(screen);
        try std.testing.expectEqualStrings(row[1], std.mem.trimEnd(u8, screen, " "));
    }
}

test "renderer closes each attributed run before the next run starts" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    const white = ansi.rgbColor(255, 255, 255, 255);
    const black = ansi.rgbColor(0, 0, 0, 255);
    const runs = [_]struct { []const u8, u32 }{ .{ "A", 2 }, .{ "A", 3 }, .{ "界", 2 } };

    // Each base attribute; a run that ends before the last column, in it, or with a wide cell
    // that fills it; followed by a run on the next row or after a row that row equality skips;
    // in a diff frame or a forced frame.
    for (0..8) |bit| for (runs) |run| for ([_]u32{ 1, 2 }) |follower_y| for ([_]bool{ false, true }) |force| {
        var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 3, &pools.graphemes, &pools.links);
        defer test_renderer.deinit();
        try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
        const next = test_renderer.renderer.getNextBuffer();
        try next.drawText(run[0], run[1], 0, white, black, @as(u32, 1) << @intCast(bit));
        try next.drawText("b", 0, follower_y, white, black, 0);
        try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(force));

        var terminal: ghostty_vt.vt.Terminal = try .init(std.testing.io, std.testing.allocator, .{ .cols = 4, .rows = 3 });
        defer terminal.deinit(std.testing.allocator);
        var stream = terminal.vtStream();
        defer stream.deinit();
        stream.nextSlice(test_renderer.memory.bytes.items);
        const pages = &terminal.screens.active.pages;
        try std.testing.expect(@as(u16, @bitCast(pages.getCell(.{ .active = .{ .x = @intCast(run[1]) } }).?.style().flags)) != 0);
        const cell = pages.getCell(.{ .active = .{ .y = follower_y } }).?;
        try std.testing.expectEqual(@as(u21, 'b'), cell.cell.codepoint());
        try std.testing.expectEqual(@as(u16, 0), @as(u16, @bitCast(cell.style().flags)));
    };
}

fn expectPlaneCoversImage(protocol: image.RenderProtocol) !void {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 2, 1, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const image_handle: u32 = 1;

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 2, 1, 2, 2, 0, 0, 1, 1, protocol));
    _ = test_renderer.render(true);

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 2, 1, 2, 2, 0, 0, 1, 1, protocol));
    next.fillRect(0, 0, 1, 1, ansi.rgbaFromFloats(0.0, 0.0, 1.0, 0.5));
    try std.testing.expectEqual(@as(usize, 1), next.image_placements.items.len);
    try std.testing.expectEqual(@as(u32, ' '), next.get(0, 0).?.char);
    try std.testing.expectEqual(ansi.rgbColor(0, 0, 255, 255), next.get(0, 0).?.bg);
    try std.testing.expect(gp.isImageChar(next.get(1, 0).?.char));
    _ = test_renderer.render(false);
    const covered_output = test_renderer.memory.lastWrite();
    try std.testing.expect(covered_output.len > 0);
    try std.testing.expect(std.mem.find(u8, covered_output, "\x1b_Ga=t") == null);
    try std.testing.expect(std.mem.find(u8, covered_output, "a=p") == null);
    try std.testing.expect(std.mem.find(u8, covered_output, "a=d") == null);
    try std.testing.expect(std.mem.find(u8, covered_output, "\x1bP0;1;0q") == null);

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 2, 1, 2, 2, 0, 0, 1, 1, protocol));
    try std.testing.expectEqual(@as(usize, 1), next.image_placements.items.len);
    _ = test_renderer.render(false);
    const restored_output = test_renderer.memory.lastWrite();
    switch (protocol) {
        .kitty => {
            try std.testing.expect(restored_output.len > 0);
            try std.testing.expect(std.mem.find(u8, restored_output, "\x1b_Ga=t") == null);
            try std.testing.expect(std.mem.find(u8, restored_output, "a=p") == null);
        },
        .sixel => try std.testing.expect(std.mem.find(u8, restored_output, "\x1bP0;1;0q") != null),
        .blocks => try std.testing.expect(std.mem.find(u8, restored_output, "█") != null),
        .auto => unreachable,
    }
}

const kitty_run_id_min: u32 = 0x8000_0000;

// The escape that drops one placement of a live Kitty image and keeps its
// data. Live image ids are the renderer's salt plus the buffer placement id.
// An image-wide `d=i` must not appear: iTerm2 also frees the image for it.
fn expectKittyPlacementDeleted(test_renderer: *const TestRenderer, output: []const u8, placement_id: u32, kitty_placement: u32) !void {
    const image_id = test_renderer.renderer.imageIdSalt + placement_id;
    var expected: [80]u8 = undefined;
    const escape = try std.fmt.bufPrint(&expected, "\x1b_Ga=d,d=i,i={d},p={d},q=2\x1b\\", .{ image_id, kitty_placement });
    try std.testing.expect(std.mem.find(u8, output, escape) != null);
    const image_wide = try std.fmt.bufPrint(&expected, "\x1b_Ga=d,d=i,i={d},q=2\x1b\\", .{image_id});
    try std.testing.expect(std.mem.find(u8, output, image_wide) == null);
}

test "renderer covers Kitty cells without hiding the rest of the image" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 2, 1, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{
        255, 0,   0, 255,
        0,   255, 0, 255,
    }, 2, 1, 8);
    defer value.deinit();
    const image_handle: u32 = 1;

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 2, 1, 0, 0, 0, 0, 2, 1, .kitty));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 2, 1, 0, 0, 0, 0, 2, 1, .kitty));
    next.fillRect(0, 0, 1, 1, ansi.rgbaFromFloats(0.0, 0.0, 1.0, 0.5));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(false));
    const covered = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, covered, "\x1b_Ga=t") == null);
    try expectKittyPlacementDeleted(&test_renderer, covered, 1, 1);
    try std.testing.expect(std.mem.find(u8, covered, "\x1b[1;2H") != null);
    try std.testing.expect(std.mem.find(u8, covered, "c=1,r=1,x=1,y=0,w=1,h=1,C=1,z=-1073741823") != null);
    try std.testing.expect(std.mem.find(u8, covered, "c=2,r=1") == null);

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 2, 1, 0, 0, 0, 0, 2, 1, .kitty));
    next.fillRect(0, 0, 1, 1, ansi.rgbaFromFloats(0.0, 0.0, 1.0, 0.5));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(false));
    try std.testing.expectEqual(@as(usize, 0), test_renderer.memory.lastWrite().len);

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 2, 1, 0, 0, 0, 0, 2, 1, .kitty));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(false));
    const restored = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, restored, "\x1b_Ga=t") == null);
    try expectKittyPlacementDeleted(&test_renderer, restored, 1, kitty_run_id_min);
    try std.testing.expect(std.mem.find(u8, restored, "c=2,r=1,x=0,y=0,w=2,h=1,C=1,z=-1073741823") != null);
}

test "renderer deletes a fully covered Kitty placement" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 1, 1, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const image_handle: u32 = 1;

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .kitty));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .kitty));
    next.fillRect(0, 0, 1, 1, ansi.rgbColor(0, 0, 255, 255));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(false));
    const covered = test_renderer.memory.lastWrite();
    try expectKittyPlacementDeleted(&test_renderer, covered, 1, 1);
    try std.testing.expect(std.mem.find(u8, covered, "a=p") == null);
    try std.testing.expect(std.mem.find(u8, covered, "\x1b_Ga=t") == null);
}

test "renderer moves a Kitty placement without an image-wide delete" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 3, 2, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const image_handle: u32 = 1;

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .kitty));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));

    // Scrolling moves the placement. The image data stays on the terminal, so
    // only the old placement is deleted before the put at the new position.
    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, .kitty));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(false));
    const moved = test_renderer.memory.lastWrite();
    try expectKittyPlacementDeleted(&test_renderer, moved, 1, 1);
    try std.testing.expect(std.mem.find(u8, moved, "\x1b_Ga=t") == null);
    try std.testing.expect(std.mem.find(u8, moved, "\x1b[2;2H") != null);
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, moved, "a=p"));
}

test "renderer keeps a Kitty image whole under an overlapping Kitty image" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 2, 1, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const red = try image.createFromRgba(std.testing.allocator, &[_]u8{
        255, 0, 0, 255,
        255, 0, 0, 255,
    }, 2, 1, 8);
    defer red.deinit();
    const transparent = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 0, 0, 0 }, 1, 1, 4);
    defer transparent.deinit();
    const red_handle: u32 = 1;
    const transparent_handle: u32 = 2;

    // The terminal composites Kitty placements by z, so the lower image keeps
    // its full rectangle and shows through the upper image's alpha.
    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 2, 1, 0, 0, 0, 0, 2, 1, .kitty));
    try std.testing.expect(try next.drawImage(transparent, transparent_handle, 1, 0, 1, 1, 0, 0, 0, 0, 1, 1, .kitty));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    const layered = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, layered, ",p=1,c=2,r=1,x=0,y=0,w=2,h=1,C=1,z=-1073741823") != null);
    try std.testing.expect(std.mem.find(u8, layered, ",p=2,c=1,r=1,x=0,y=0,w=1,h=1,C=1,z=-1073741822") != null);
    try std.testing.expect(std.mem.find(u8, layered, "p=2147483648") == null);

    // Text paints the shared cell, so both placements lose it.
    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 2, 1, 0, 0, 0, 0, 2, 1, .kitty));
    try std.testing.expect(try next.drawImage(transparent, transparent_handle, 1, 0, 1, 1, 0, 0, 0, 0, 1, 1, .kitty));
    try next.drawText("X", 1, 0, .{ 255, 255, 255, 255 }, null, 0);
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(false));
    const covered = test_renderer.memory.lastWrite();
    try expectKittyPlacementDeleted(&test_renderer, covered, 1, 1);
    try expectKittyPlacementDeleted(&test_renderer, covered, 2, 2);
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, covered, "a=p"));
    try std.testing.expect(std.mem.find(u8, covered, ",p=2147483648,c=1,r=1,x=0,y=0,w=1,h=1,C=1,z=-1073741823") != null);
}

test "renderer merges uncovered Kitty rows into one placement" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 2, 3, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    var pixels: [2 * 3 * 4]u8 = undefined;
    @memset(&pixels, 255);
    const value = try image.createFromRgba(std.testing.allocator, &pixels, 2, 3, 2 * 4);
    defer value.deinit();
    const image_handle: u32 = 1;

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 2, 3, 0, 0, 0, 0, 2, 3, .kitty));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));

    // Covering the top-left cell leaves one run on row 0 and two identical
    // rows below it, which become a single two-row rectangle. Run ids are
    // per owner and start at 2^31.
    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 2, 3, 0, 0, 0, 0, 2, 3, .kitty));
    next.fillRect(0, 0, 1, 1, ansi.rgbColor(0, 0, 255, 255));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(false));
    const covered = test_renderer.memory.lastWrite();
    try expectKittyPlacementDeleted(&test_renderer, covered, 1, 1);
    try std.testing.expectEqual(@as(usize, 2), std.mem.count(u8, covered, "a=p"));
    try std.testing.expect(std.mem.find(u8, covered, ",p=2147483648,c=1,r=1,x=1,y=0,w=1,h=1,C=1,z=-1073741823") != null);
    try std.testing.expect(std.mem.find(u8, covered, ",p=2147483649,c=2,r=2,x=0,y=1,w=2,h=2,C=1,z=-1073741823") != null);

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 2, 3, 0, 0, 0, 0, 2, 3, .kitty));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(false));
    const restored = test_renderer.memory.lastWrite();
    try expectKittyPlacementDeleted(&test_renderer, restored, 1, kitty_run_id_min);
    try expectKittyPlacementDeleted(&test_renderer, restored, 1, kitty_run_id_min + 1);
    try std.testing.expect(std.mem.find(u8, restored, ",p=1,c=2,r=3,x=0,y=0,w=2,h=3,C=1,z=-1073741823") != null);
}

test "renderer deletes committed Kitty runs after a failed frame" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 2, 1, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    test_renderer.renderer.terminal.caps.sixel = true;
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{
        255, 0,   0, 255,
        0,   255, 0, 255,
    }, 2, 1, 8);
    defer value.deinit();
    const sixel = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 0, 255, 255 }, 1, 1, 4);
    defer sixel.deinit();
    const image_handle: u32 = 1;
    const sixel_handle: u32 = 2;
    // Both image lists swap on commit, so size both before the first frame.
    try test_renderer.renderer.imageDirty.ensureTotalCapacity(std.testing.allocator, 2);
    try test_renderer.renderer.pendingImages.ensureTotalCapacity(std.testing.allocator, 2);
    try test_renderer.renderer.currentImages.ensureTotalCapacity(std.testing.allocator, 2);

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 2, 1, 0, 0, 0, 0, 2, 1, .kitty));
    next.fillRect(0, 0, 1, 1, ansi.rgbColor(0, 0, 255, 255));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), ",p=2147483648,c=1,r=1,x=1,y=0,w=1,h=1") != null);

    // Coverage moves, the run delete is written, then Sixel preparation fails
    // and the whole frame is dropped. The terminal still shows the first run.
    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 2, 1, 0, 0, 0, 0, 2, 1, .kitty));
    next.fillRect(1, 0, 1, 1, ansi.rgbColor(0, 0, 255, 255));
    try std.testing.expect(try next.drawImage(sixel, sixel_handle, 1, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));
    const written_before = test_renderer.memory.bytes.items.len;
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0 });
    test_renderer.renderer.allocator = failing.allocator();
    const status = test_renderer.render(false);
    test_renderer.renderer.allocator = std.testing.allocator;
    try std.testing.expect(failing.has_induced_failure);
    try std.testing.expectEqual(renderer.RenderStatus.failed, status);
    try std.testing.expectEqual(written_before, test_renderer.memory.bytes.items.len);

    // The forced repaint must delete the run that is actually on the terminal
    // without freeing the image, then place the new run.
    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 2, 1, 0, 0, 0, 0, 2, 1, .kitty));
    next.fillRect(1, 0, 1, 1, ansi.rgbColor(0, 0, 255, 255));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(false));
    const recovered = test_renderer.memory.lastWrite();
    try expectKittyPlacementDeleted(&test_renderer, recovered, 1, kitty_run_id_min);
    try std.testing.expect(std.mem.find(u8, recovered, "\x1b_Ga=t") == null);
    try std.testing.expect(std.mem.find(u8, recovered, ",p=2147483648,c=1,r=1,x=0,y=0,w=1,h=1") != null);
}

test "renderer splits changed background runs around clean Kitty image cells" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 5, 1, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const image_handle: u32 = 1;
    test_renderer.renderer.terminal.caps.kitty_graphics = true;

    var next = test_renderer.renderer.getNextBuffer();
    next.fillRect(0, 0, 5, 1, ansi.rgbColor(8, 11, 18, 255));
    try std.testing.expect(try next.drawImage(value, image_handle, 1, 0, 2, 1, 2, 2, 0, 0, 1, 1, .kitty));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));

    next = test_renderer.renderer.getNextBuffer();
    next.fillRect(0, 0, 5, 1, ansi.rgbColor(32, 43, 61, 255));
    try std.testing.expect(try next.drawImage(value, image_handle, 1, 0, 2, 1, 2, 2, 0, 0, 1, 1, .kitty));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(false));

    const output = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, output, "\x1b[1;1H") != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b[0m\x1b[1;4H") != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b_G") == null);
}

test "renderer retransmits Sixel after removing an alpha-colored plane" {
    try expectPlaneCoversImage(.sixel);
}

test "renderer redraws blocks after removing an alpha-colored plane" {
    try expectPlaneCoversImage(.blocks);
}

test "renderer clears old Sixel pixels when replacing an image" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 2, 1, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const opaque_image = try image.createFromRgba(std.testing.allocator, &[_]u8{
        255, 0, 0, 255, 255, 0, 0, 255,
    }, 2, 1, 8);
    defer opaque_image.deinit();
    const replacement = try image.createFromRgba(std.testing.allocator, &[_]u8{
        0, 0, 0, 0, 0, 0, 255, 255,
    }, 2, 1, 8);
    defer replacement.deinit();
    const opaque_handle: u32 = 1;
    const replacement_handle: u32 = 2;

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(opaque_image, opaque_handle, 0, 0, 2, 1, 2, 2, 0, 0, 2, 1, .sixel));
    _ = test_renderer.render(true);

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(replacement, replacement_handle, 0, 0, 2, 1, 2, 2, 0, 0, 2, 1, .sixel));
    _ = test_renderer.render(false);
    const output = test_renderer.memory.lastWrite();
    const sixel = std.mem.find(u8, output, "\x1bP0;1;0q") orelse return error.TestUnexpectedResult;
    try std.testing.expect(std.mem.findScalar(u8, output[0..sixel], ' ') != null);
}

const PaintedSixelColor = struct { r: u8, g: u8, b: u8 };

// Parses the last Sixel DCS in an output stream and returns the palette colors
// that actually paint at least one pixel (RGB in the 0-100 Sixel scale).
fn paintedSixelColors(output: []const u8, colors: *[8]PaintedSixelColor) !usize {
    const start = std.mem.findLast(u8, output, "\x1bP0;1;0q") orelse return error.NoSixelPayload;
    const end = std.mem.findPos(u8, output, start, "\x1b\\") orelse return error.NoSixelPayload;
    const payload = output[start + 8 .. end];

    var palette: [256][3]u8 = @splat(.{ 0, 0, 0 });
    var painted: [256]bool = @splat(false);
    var selected: usize = 0;
    var position: usize = 0;
    if (position < payload.len and payload[position] == '"') {
        position += 1;
        var separators: usize = 0;
        while (position < payload.len and separators < 3) : (position += 1) {
            if (payload[position] == ';') separators += 1;
        }
        while (position < payload.len and std.ascii.isDigit(payload[position])) position += 1;
    }
    while (position < payload.len) {
        const byte = payload[position];
        position += 1;
        switch (byte) {
            '#' => {
                var value: usize = 0;
                while (position < payload.len and std.ascii.isDigit(payload[position])) : (position += 1) {
                    value = value * 10 + (payload[position] - '0');
                }
                selected = value;
                if (position < payload.len and payload[position] == ';') {
                    var channels: [4]u8 = .{ 0, 0, 0, 0 };
                    for (0..4) |channel| {
                        if (position >= payload.len or payload[position] != ';') return error.InvalidSixel;
                        position += 1;
                        var channel_value: usize = 0;
                        while (position < payload.len and std.ascii.isDigit(payload[position])) : (position += 1) {
                            channel_value = channel_value * 10 + (payload[position] - '0');
                        }
                        channels[channel] = @intCast(@min(channel_value, 255));
                    }
                    palette[selected] = .{ channels[1], channels[2], channels[3] };
                }
            },
            '!' => {
                while (position < payload.len and std.ascii.isDigit(payload[position])) position += 1;
                if (position < payload.len) {
                    if (payload[position] > '?' and payload[position] <= '~') painted[selected] = true;
                    position += 1;
                }
            },
            '$', '-' => {},
            '?' => {},
            '@'...'~' => painted[selected] = true,
            else => {},
        }
    }
    var count: usize = 0;
    for (painted, 0..) |used, index| {
        if (!used or count >= colors.len) continue;
        colors[count] = .{ .r = palette[index][0], .g = palette[index][1], .b = palette[index][2] };
        count += 1;
    }
    return count;
}

fn expectSinglePaintedSixelColor(output: []const u8, r: [2]u8, g: [2]u8, b: [2]u8) !void {
    var colors: [8]PaintedSixelColor = undefined;
    const count = try paintedSixelColors(output, &colors);
    try std.testing.expectEqual(@as(usize, 1), count);
    try std.testing.expect(colors[0].r >= r[0] and colors[0].r <= r[1]);
    try std.testing.expect(colors[0].g >= g[0] and colors[0].g <= g[1]);
    try std.testing.expect(colors[0].b >= b[0] and colors[0].b <= b[1]);
}

test "renderer dims sixel placements by opacity instead of hiding them" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 2, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const red = try image.createFromRgba(std.testing.allocator, &[_]u8{
        255, 0, 0, 255, 255, 0, 0, 255,
        255, 0, 0, 255, 255, 0, 0, 255,
    }, 2, 2, 8);
    defer red.deinit();
    const red_handle: u32 = 1;
    test_renderer.renderer.terminal.caps.sixel = true;

    // Opacity 0.4 over the default (transparent) background must stay visible,
    // dimmed toward black: red 255 * 0.4 = 102 -> 40 on the Sixel 0-100 scale.
    var next = test_renderer.renderer.getNextBuffer();
    try next.pushOpacity(0.4);
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 1, 1, 2, 2, 0, 0, 2, 2, .sixel));
    next.popOpacity();
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    try expectSinglePaintedSixelColor(test_renderer.memory.lastWrite(), .{ 35, 45 }, .{ 0, 2 }, .{ 0, 2 });

    // The same placement over an opaque blue background must dim toward blue:
    // 0.4 * red + 0.6 * blue = (102, 0, 153) -> (40, 0, 60).
    test_renderer.renderer.setBackgroundColor(ansi.rgbColor(0, 0, 255, 255));
    _ = test_renderer.render(true);
    next = test_renderer.renderer.getNextBuffer();
    try next.pushOpacity(0.4);
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 1, 1, 2, 2, 0, 0, 2, 2, .sixel));
    next.popOpacity();
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    try expectSinglePaintedSixelColor(test_renderer.memory.lastWrite(), .{ 35, 45 }, .{ 0, 2 }, .{ 55, 65 });

    // Opacity 0.75 over the same blue background: (191, 0, 64) -> (75, 0, 25).
    // Today this renders at full brightness because opacity only rescales alpha.
    next = test_renderer.renderer.getNextBuffer();
    try next.pushOpacity(0.75);
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 1, 1, 2, 2, 0, 0, 2, 2, .sixel));
    next.popOpacity();
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    try expectSinglePaintedSixelColor(test_renderer.memory.lastWrite(), .{ 70, 80 }, .{ 0, 2 }, .{ 20, 30 });

    // Full opacity is unaffected by the background: pure red (100, 0, 0).
    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 1, 1, 2, 2, 0, 0, 2, 2, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    try expectSinglePaintedSixelColor(test_renderer.memory.lastWrite(), .{ 95, 100 }, .{ 0, 2 }, .{ 0, 2 });
}

test "renderer materializes lazy ICC PNGs before applying Sixel opacity" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 2, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();

    const encoded = std.mem.trim(u8, @embedFile("fixtures/display-p3.png.base64"), "\r\n");
    const png_len = try std.base64.standard.Decoder.calcSizeForSlice(encoded);
    const png = try std.testing.allocator.alloc(u8, png_len);
    defer std.testing.allocator.free(png);
    try std.base64.standard.Decoder.decode(png, encoded);
    const value = try image.decode(std.testing.allocator, png, .{});
    defer value.deinit();
    const image_handle: u32 = 1;
    try std.testing.expectEqual(@as(usize, 0), value.pixels.len);
    test_renderer.renderer.terminal.caps.sixel = true;

    var next = test_renderer.renderer.getNextBuffer();
    try next.pushOpacity(0.5);
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 3, 1, 3, 1, 0, 0, 3, 1, .sixel));
    next.popOpacity();
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q") != null);
    try std.testing.expectEqual(@as(usize, 0), value.pixels.len);
}

test "renderer keeps image alpha holes transparent while dimming by opacity" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 2, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    // Left pixel opaque red, right pixel fully transparent.
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{
        255, 0, 0, 255, 0, 0, 0, 0,
    }, 2, 1, 8);
    defer value.deinit();
    const value_handle: u32 = 1;
    test_renderer.renderer.terminal.caps.sixel = true;

    var next = test_renderer.renderer.getNextBuffer();
    try next.pushOpacity(0.6);
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 2, 1, 2, 1, 0, 0, 2, 1, .sixel));
    next.popOpacity();
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));

    const output = test_renderer.memory.lastWrite();
    var colors: [8]PaintedSixelColor = undefined;
    const count = try paintedSixelColors(output, &colors);
    // Only the dimmed red pixel paints; the transparent pixel stays a hole.
    try std.testing.expectEqual(@as(usize, 1), count);
    try std.testing.expect(colors[0].r >= 55 and colors[0].r <= 65);

    const start = std.mem.findLast(u8, output, "\x1bP0;1;0q").?;
    const end = std.mem.findPos(u8, output, start, "\x1b\\").?;
    const payload = output[start + 8 .. end];
    // Exactly one column paints in the single 2x1 band: one '@' data char.
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, payload, "@"));
}

fn createWithOptionsOnce(allocator: std.mem.Allocator, width: u32, height: u32) !void {
    var pools = TestPools.init(allocator);
    defer pools.deinit();

    const feed = try native_span_feed.Stream.create(allocator, null);
    defer feed.destroy();

    var cli_renderer = try CliRenderer.createWithOptions(allocator, width, height, &pools.graphemes, .{
        .link_pool = &pools.links,
        .feed = feed,
    });
    cli_renderer.destroyStorage();
}

test "renderer - createWithOptions late allocation failure cleans up" {
    const allocation_count = blk: {
        var counting_allocator = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        try createWithOptionsOnce(counting_allocator.allocator(), 80, 24);
        break :blk counting_allocator.alloc_index;
    };

    try std.testing.expect(allocation_count > 0);

    var failing_allocator = std.testing.FailingAllocator.init(std.testing.allocator, .{
        .fail_index = allocation_count - 1,
    });

    try std.testing.expectError(error.OutOfMemory, createWithOptionsOnce(failing_allocator.allocator(), 80, 24));
    try std.testing.expect(failing_allocator.has_induced_failure);
    try std.testing.expectEqual(failing_allocator.allocated_bytes, failing_allocator.freed_bytes);
}

test "renderer - create and destroy" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        &pools.graphemes,
        &pools.links,
    );
    defer test_renderer.deinit();
    const cli_renderer = test_renderer.renderer;

    try std.testing.expectEqual(@as(u32, 80), cli_renderer.width);
    try std.testing.expectEqual(@as(u32, 24), cli_renderer.height);
}

/// The OSC 52 sequence a Session writes, in a buffer of the exact computed size.
fn clipboardSequence(cli: *CliRenderer, payload: []const u8) ![]u8 {
    const bytes = try std.testing.allocator.alloc(u8, try cli.terminal.clipboardSequenceSize(payload.len));
    errdefer std.testing.allocator.free(bytes);
    var writer: std.Io.Writer = .fixed(bytes);
    try cli.terminal.writeClipboard(&writer, .clipboard, payload);
    try std.testing.expectEqual(bytes.len, writer.buffered().len);
    return bytes;
}

test "renderer - clipboard allocates one exact encoded sequence" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 80, 24, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();

    const payload: [2048]u8 = @splat('A');
    const output = try clipboardSequence(test_renderer.renderer, &payload);
    defer std.testing.allocator.free(output);

    try std.testing.expectEqual(std.base64.standard.Encoder.calcSize(payload.len) + 9, output.len);
    try std.testing.expect(std.mem.startsWith(u8, output, "\x1b]52;c;QUFB"));
    try std.testing.expect(std.mem.endsWith(u8, output, "QUE=\x1b\\"));
}

test "renderer - clipboard wraps OSC 52 in tmux DCS passthrough" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.createWithEnv(std.testing.allocator, 80, 24, &pools.graphemes, &pools.links, &.{
        .{ .key = "TMUX", .value = "/tmp/tmux-1000/default,12345,0" },
    });
    defer test_renderer.deinit();

    const payload: [2048]u8 = @splat('A');
    const output = try clipboardSequence(test_renderer.renderer, &payload);
    defer std.testing.allocator.free(output);

    // Envelope: "\x1bPtmux;" (7) + bare sequence (base64 + 9) with both inner
    // ESC bytes doubled (+2) + "\x1b\\" (2) = base64 + 20.
    try std.testing.expectEqual(std.base64.standard.Encoder.calcSize(payload.len) + 20, output.len);
    try std.testing.expect(std.mem.startsWith(u8, output, "\x1bPtmux;\x1b\x1b]52;c;QUFB"));
    try std.testing.expect(std.mem.endsWith(u8, output, "QUE=\x1b\x1b\\\x1b\\"));
}

test "renderer - clipboard chunks OSC 52 in screen DCS passthrough" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.createWithEnv(std.testing.allocator, 80, 24, &pools.graphemes, &pools.links, &.{
        .{ .key = "STY", .value = "12345.pts-0.host" },
    });
    defer test_renderer.deinit();

    const payload: [2048]u8 = @splat('A');
    const output = try clipboardSequence(test_renderer.renderer, &payload);
    defer std.testing.allocator.free(output);

    // Sequence: base64 (2732) + OSC 52 framing with BEL (8) = 2740 bytes,
    // split into 11 chunks of at most 252 bytes, each wrapped in
    // "\x1bP" .. "\x1b\\" (+4 per chunk) = 2784 total.
    try std.testing.expectEqual(@as(usize, 2784), output.len);
    try std.testing.expect(std.mem.startsWith(u8, output, "\x1bP\x1b]52;c;QUFB"));
    try std.testing.expect(std.mem.endsWith(u8, output, "QUE=\x07\x1b\\"));

    // ESC only precedes 'P' at envelope starts, so this counts the chunks.
    try std.testing.expectEqual(@as(usize, 11), std.mem.count(u8, output, "\x1bP"));

    // First envelope closes after exactly 252 payload bytes: "\x1bP" (2) +
    // payload (252) puts the terminator and the next start at offset 254.
    try std.testing.expectEqualSlices(u8, "\x1b\\\x1bP", output[254..258]);
}

test "renderer - simple text rendering to currentRenderBuffer" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode);
    defer tb.deinit();

    try tb.setText("Hello World");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);

    _ = test_cli_renderer.render(false);

    const current_buffer = cli_renderer.getCurrentBuffer();

    const cell_h = current_buffer.get(0, 0);
    try std.testing.expect(cell_h != null);
    try std.testing.expectEqual(@as(u32, 'H'), cell_h.?.char);

    const cell_e = current_buffer.get(1, 0);
    try std.testing.expect(cell_e != null);
    try std.testing.expectEqual(@as(u32, 'e'), cell_e.?.char);

    const cell_w = current_buffer.get(6, 0);
    try std.testing.expect(cell_w != null);
    try std.testing.expectEqual(@as(u32, 'W'), cell_w.?.char);
}

test "renderer - multi-line text rendering" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode);
    defer tb.deinit();

    try tb.setText("Line 1\nLine 2\nLine 3");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);
    _ = test_cli_renderer.render(false);

    const current_buffer = cli_renderer.getCurrentBuffer();

    const cell_line1 = current_buffer.get(0, 0);
    try std.testing.expect(cell_line1 != null);
    try std.testing.expectEqual(@as(u32, 'L'), cell_line1.?.char);

    const cell_line2 = current_buffer.get(0, 1);
    try std.testing.expect(cell_line2 != null);
    try std.testing.expectEqual(@as(u32, 'L'), cell_line2.?.char);

    const cell_line3 = current_buffer.get(0, 2);
    try std.testing.expect(cell_line3 != null);
    try std.testing.expectEqual(@as(u32, 'L'), cell_line3.?.char);
}

test "renderer - emoji (wide grapheme) rendering" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode);
    defer tb.deinit();

    try tb.setText("Hi 👋 there");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);
    _ = test_cli_renderer.render(false);

    const current_buffer = cli_renderer.getCurrentBuffer();

    const cell_h = current_buffer.get(0, 0);
    try std.testing.expect(cell_h != null);
    try std.testing.expectEqual(@as(u32, 'H'), cell_h.?.char);

    const cell_i = current_buffer.get(1, 0);
    try std.testing.expect(cell_i != null);
    try std.testing.expectEqual(@as(u32, 'i'), cell_i.?.char);

    const cell_space1 = current_buffer.get(2, 0);
    try std.testing.expect(cell_space1 != null);
    try std.testing.expectEqual(@as(u32, ' '), cell_space1.?.char);

    const cell_emoji = current_buffer.get(3, 0);
    try std.testing.expect(cell_emoji != null);
    try std.testing.expect(gp.isGraphemeChar(cell_emoji.?.char));

    const cell_emoji_continuation = current_buffer.get(4, 0);
    try std.testing.expect(cell_emoji_continuation != null);
    try std.testing.expect(gp.isContinuationChar(cell_emoji_continuation.?.char));

    const cell_space2 = current_buffer.get(5, 0);
    try std.testing.expect(cell_space2 != null);
    try std.testing.expectEqual(@as(u32, ' '), cell_space2.?.char);

    const cell_t = current_buffer.get(6, 0);
    try std.testing.expect(cell_t != null);
    try std.testing.expectEqual(@as(u32, 't'), cell_t.?.char);
}

test "renderer - CJK characters rendering" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode);
    defer tb.deinit();

    try tb.setText("Hello 世界");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);
    _ = test_cli_renderer.render(false);

    const current_buffer = cli_renderer.getCurrentBuffer();

    const cell_h = current_buffer.get(0, 0);
    try std.testing.expect(cell_h != null);
    try std.testing.expectEqual(@as(u32, 'H'), cell_h.?.char);

    const cell_space = current_buffer.get(5, 0);
    try std.testing.expect(cell_space != null);
    try std.testing.expectEqual(@as(u32, ' '), cell_space.?.char);

    const cell_cjk1 = current_buffer.get(6, 0);
    try std.testing.expect(cell_cjk1 != null);
    try std.testing.expect(gp.isGraphemeChar(cell_cjk1.?.char));

    const cell_cjk1_continuation = current_buffer.get(7, 0);
    try std.testing.expect(cell_cjk1_continuation != null);
    try std.testing.expect(gp.isContinuationChar(cell_cjk1_continuation.?.char));

    const cell_cjk2 = current_buffer.get(8, 0);
    try std.testing.expect(cell_cjk2 != null);
    try std.testing.expect(gp.isGraphemeChar(cell_cjk2.?.char));

    const cell_cjk2_continuation = current_buffer.get(9, 0);
    try std.testing.expect(cell_cjk2_continuation != null);
    try std.testing.expect(gp.isContinuationChar(cell_cjk2_continuation.?.char));
}

test "renderer - mixed ASCII, emoji, and CJK" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode);
    defer tb.deinit();

    try tb.setText("A 😀 世");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);
    _ = test_cli_renderer.render(false);

    const current_buffer = cli_renderer.getCurrentBuffer();

    const cell_a = current_buffer.get(0, 0);
    try std.testing.expect(cell_a != null);
    try std.testing.expectEqual(@as(u32, 'A'), cell_a.?.char);

    const cell_space1 = current_buffer.get(1, 0);
    try std.testing.expect(cell_space1 != null);
    try std.testing.expectEqual(@as(u32, ' '), cell_space1.?.char);

    const cell_emoji = current_buffer.get(2, 0);
    try std.testing.expect(cell_emoji != null);
    try std.testing.expect(gp.isGraphemeChar(cell_emoji.?.char));

    const cell_emoji_continuation = current_buffer.get(3, 0);
    try std.testing.expect(cell_emoji_continuation != null);
    try std.testing.expect(gp.isContinuationChar(cell_emoji_continuation.?.char));

    const cell_space2 = current_buffer.get(4, 0);
    try std.testing.expect(cell_space2 != null);
    try std.testing.expectEqual(@as(u32, ' '), cell_space2.?.char);

    const cell_cjk = current_buffer.get(5, 0);
    try std.testing.expect(cell_cjk != null);
    try std.testing.expect(gp.isGraphemeChar(cell_cjk.?.char));

    const cell_cjk_continuation = current_buffer.get(6, 0);
    try std.testing.expect(cell_cjk_continuation != null);
    try std.testing.expect(gp.isContinuationChar(cell_cjk_continuation.?.char));
}

test "renderer - resize updates dimensions" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    try std.testing.expectEqual(@as(u32, 80), cli_renderer.width);
    try std.testing.expectEqual(@as(u32, 24), cli_renderer.height);

    try cli_renderer.resize(120, 40);

    try std.testing.expectEqual(@as(u32, 120), cli_renderer.width);
    try std.testing.expectEqual(@as(u32, 40), cli_renderer.height);
}

test "renderer - resize allocation failures preserve both buffers and published hits" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    for ([_][2]u32{ .{ 4, 1 }, .{ 3, 2 } }) |dimensions| {
        for (0..10) |fail_index| {
            var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
            const feed = try native_span_feed.Stream.create(std.testing.allocator, null);
            defer feed.destroy();
            const target = try CliRenderer.createWithOptions(failing.allocator(), 2, 2, &pool, .{
                .io = io,
                .feed = feed,
                .link_pool = &links,
            });
            defer target.destroyStorage();
            const grapheme_id = try pool.acquire("\xf0\x9f\x98\x80");
            const link_id = try links.acquire("https://resize.invalid");
            const cell: buffer.Cell = .{
                .char = gp.packGraphemeStart(grapheme_id, 2),
                .fg = ansi.rgbColor(1, 2, 3, 255),
                .bg = ansi.rgbColor(4, 5, 6, 255),
                .attributes = ansi.TextAttributes.setLinkId(0, link_id),
            };
            target.currentRenderBuffer.set(0, 0, cell);
            target.nextRenderBuffer.set(0, 0, cell);
            try pool.decref(grapheme_id);
            try links.decref(link_id);
            target.presented_hits_frame = 42;
            target.terminal.setCursorPosition(2, 2, true);
            var current = try target.currentRenderBuffer.acquireLease();
            defer current.release();
            var next = try target.nextRenderBuffer.acquireLease();
            defer next.release();
            const current_snapshot = try current.snapshot();
            const next_snapshot = try next.snapshot();
            const live_bytes = failing.allocated_bytes - failing.freed_bytes;
            failing.fail_index = failing.alloc_index + fail_index;

            try std.testing.expectError(error.OutOfMemory, target.resize(dimensions[0], dimensions[1]));
            try std.testing.expectEqual(live_bytes, failing.allocated_bytes - failing.freed_bytes);
            try std.testing.expectEqual(@as(u32, 2), target.width);
            try std.testing.expectEqual(@as(u32, 2), target.height);
            try std.testing.expectEqualDeep(current_snapshot, try current.snapshot());
            try std.testing.expectEqualDeep(next_snapshot, try next.snapshot());
            try std.testing.expectEqual(current.storage.?, target.currentRenderBuffer.storage);
            try std.testing.expectEqual(next.storage.?, target.nextRenderBuffer.storage);
            try std.testing.expectEqualDeep(cell, target.currentRenderBuffer.get(0, 0).?);
            try std.testing.expectEqualDeep(cell, target.nextRenderBuffer.get(0, 0).?);
            try std.testing.expectEqual(@as(u64, 42), target.presented_hits_frame);
            try std.testing.expectEqual(@as(u64, 0), target.hits_generation);
            try std.testing.expectEqual(@as(u32, 2), target.terminal.getCursorPosition().y);
            try std.testing.expectEqual(@as(u32, 2), try pool.getRefcount(grapheme_id));
            try std.testing.expectEqual(@as(u32, 2), try links.getRefcount(link_id));

            failing.fail_index = std.math.maxInt(usize);
            try target.resize(dimensions[0], dimensions[1]);
            try std.testing.expectEqual(dimensions[0], target.width);
            try std.testing.expectEqual(dimensions[1], target.height);
            for ([_]*OptimizedBuffer{ target.currentRenderBuffer, target.nextRenderBuffer }) |frame| {
                try std.testing.expectEqual(dimensions[0], frame.width);
                try std.testing.expectEqual(dimensions[1], frame.height);
                try std.testing.expectEqual(@as(u64, 2), frame.storage.generation);
            }
            try std.testing.expectEqual(@as(u64, 0), target.presented_hits_frame);
            try std.testing.expectEqual(@as(u64, 1), target.hits_generation);
            try std.testing.expect(!current.isCurrent());
            try std.testing.expect(!next.isCurrent());
            try std.testing.expectEqual(cell.char, current_snapshot.buffer.char[0]);
            try std.testing.expectEqual(cell.char, next_snapshot.buffer.char[0]);
            try std.testing.expectEqualStrings("\xf0\x9f\x98\x80", try pool.get(grapheme_id));
            try std.testing.expectEqualStrings("https://resize.invalid", try links.get(link_id));
            failing.fail_index = failing.alloc_index;
            try target.resize(dimensions[0], dimensions[1]);
        }
    }
}

test "renderer - background color setting" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    const bg_color = ansi.rgbaFromFloats(0.1, 0.2, 0.3, 1.0);
    cli_renderer.setBackgroundColor(bg_color);

    try std.testing.expectEqual(bg_color, cli_renderer.backgroundColor);
    try std.testing.expectEqual(bg_color, cli_renderer.getNextBuffer().getBlendBackdropColor().?);

    const transparent_bg = ansi.rgbaFromFloats(0.25, 0.5, 0.75, 0.0);
    cli_renderer.setBackgroundColor(transparent_bg);

    try std.testing.expectEqual(transparent_bg, cli_renderer.backgroundColor);
    try std.testing.expectEqual(ansi.rgbaFromFloats(0.25, 0.5, 0.75, 1.0), cli_renderer.getNextBuffer().getBlendBackdropColor().?);
}

test "renderer - theme color query tracks pending background restore" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.setBackgroundColor(ansi.rgbaFromFloats(0.1, 0.2, 0.3, 1.0));
    var writer = DiscardTerminalWriter{};
    try cli_renderer.terminal.queryThemeColors(&writer);
    try std.testing.expectEqual(ansi.rgbaFromFloats(0.1, 0.2, 0.3, 1.0), cli_renderer.backgroundColor);
}

test "renderer - empty text buffer renders correctly" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode);
    defer tb.deinit();

    try tb.setText("");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);
    _ = test_cli_renderer.render(false);
}

test "renderer - multiple renders update currentRenderBuffer" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    try tb.setText("Hello");
    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);
    _ = test_cli_renderer.render(false);

    var current_buffer = cli_renderer.getCurrentBuffer();
    var first_cell = current_buffer.get(0, 0);
    try std.testing.expect(first_cell != null);
    try std.testing.expectEqual(@as(u32, 'H'), first_cell.?.char);

    try tb.setText("World");
    const next_buffer2 = cli_renderer.getNextBuffer();
    next_buffer2.drawTextBuffer(view, 0, 0);
    _ = test_cli_renderer.render(false);

    current_buffer = cli_renderer.getCurrentBuffer();
    first_cell = current_buffer.get(0, 0);
    try std.testing.expect(first_cell != null);
    try std.testing.expectEqual(@as(u32, 'W'), first_cell.?.char);
}

test "renderer - 1000 frame render loop with owned styled text" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        80,
        24,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    const frame_texts = [_][]const u8{
        "Frame ASCII",
        "Frame 👋 emoji",
        "Frame 世界 CJK",
        "Mixed 😀 世",
    };

    const fg_color = ansi.rgbaFromFloats(1.0, 0.8, 0.6, 1.0);
    const bg_color = ansi.rgbaFromFloats(0.1, 0.1, 0.2, 1.0);
    var current: ?owned_styled.Result = null;

    var frame: u32 = 0;
    while (frame < 1000) : (frame += 1) {
        const text_idx = frame % frame_texts.len;
        const text = frame_texts[text_idx];
        try owned_styled.replaceInPlace(tb, &current, &.{.{
            .text = text,
            .fg = fg_color,
            .bg = bg_color,
        }});
        opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
        opt_buffer.drawTextBuffer(view, 0, 0);

        const next_buffer = cli_renderer.getNextBuffer();
        next_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
        next_buffer.drawFrameBuffer(0, 0, opt_buffer, null, null, null, null);

        _ = test_cli_renderer.render(false);

        if (frame % 100 == 0) {
            const current_buffer = cli_renderer.getCurrentBuffer();
            const first_cell = current_buffer.get(0, 0);
            try std.testing.expect(first_cell != null);
            try std.testing.expect(first_cell.?.char != 32);

            try std.testing.expectEqual(frame + 1, cli_renderer.renderStats.frameCount);
        }
    }

    try std.testing.expectEqual(@as(u64, 1000), cli_renderer.renderStats.frameCount);

    const current_buffer = cli_renderer.getCurrentBuffer();
    const final_cell = current_buffer.get(0, 0);
    try std.testing.expect(final_cell != null);
    try std.testing.expectEqual(@as(u32, 'M'), final_cell.?.char);
}

test "renderer - grapheme pool refcounting with frame buffer fast path" {
    var link_pool_storage = link.LinkPool.init(std.testing.allocator);
    defer link_pool_storage.deinit();
    const link_pool = &link_pool_storage;
    var limited_pool_storage = gp.GraphemePool.initWithOptions(std.testing.allocator, .{
        .slots_per_page = [_]u32{ 2, 2, 2, 2, 2 },
    });
    defer limited_pool_storage.deinit();
    const limited_pool = &limited_pool_storage;

    var tb = try TextBuffer.init(std.testing.allocator, limited_pool, link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        limited_pool,
        link_pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    var frame_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        80,
        24,
        .{ .link_pool = link_pool, .pool = limited_pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer frame_buffer.deinit();

    const fg_color = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg_color = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0);

    var current: ?owned_styled.Result = null;
    try owned_styled.replaceInPlace(tb, &current, &.{.{
        .text = "👋",
        .fg = fg_color,
        .bg = bg_color,
    }});
    frame_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    frame_buffer.drawTextBuffer(view, 0, 0);

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.setRespectAlpha(false);
    next_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);

    next_buffer.drawFrameBuffer(0, 0, frame_buffer, null, null, null, null);

    frame_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);

    var i: usize = 0;
    while (i < 10) : (i += 1) {
        try owned_styled.replaceInPlace(tb, &current, &.{.{
            .text = "🎉🚀💯",
            .fg = fg_color,
            .bg = bg_color,
        }});
        frame_buffer.drawTextBuffer(view, 0, 0);
        frame_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    }

    _ = test_cli_renderer.render(false);

    const current_buffer = cli_renderer.getCurrentBuffer();
    const rendered_cell = current_buffer.get(0, 0);
    try std.testing.expect(rendered_cell != null);
}

test "renderer - unchanged grapheme should not churn IDs across frames" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        4,
        1,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);

    const first_next_buffer = cli_renderer.getNextBuffer();
    try first_next_buffer.drawText("👋", 0, 0, fg, bg, 0);
    _ = test_cli_renderer.render(false);

    const first_output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.find(u8, first_output, "👋") != null);

    const current_buffer = cli_renderer.getCurrentBuffer();
    const first_cell = current_buffer.get(0, 0);
    try std.testing.expect(first_cell != null);
    try std.testing.expect(gp.isGraphemeChar(first_cell.?.char));
    const first_gid = gp.graphemeIdFromChar(first_cell.?.char);

    const second_next_buffer = cli_renderer.getNextBuffer();
    try second_next_buffer.drawText("👋", 0, 0, fg, bg, 0);

    const second_cell = second_next_buffer.get(0, 0);
    try std.testing.expect(second_cell != null);
    try std.testing.expect(gp.isGraphemeChar(second_cell.?.char));
    const second_gid = gp.graphemeIdFromChar(second_cell.?.char);

    // Same grapheme content in consecutive frames should keep a stable ID,
    // otherwise diff/write treats unchanged cells as modified every frame.
    try std.testing.expectEqual(first_gid, second_gid);

    _ = test_cli_renderer.render(false);

    const second_output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.find(u8, second_output, "👋") == null);
}

test "renderer - grows frame output instead of committing cells whose ANSI was dropped" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    const width: u32 = 1000;
    const height: u32 = 160;
    {
        var test_cli_renderer = try TestRenderer.create(std.testing.allocator, width, height, &pools.graphemes, &pools.links);
        defer test_cli_renderer.deinit();
        const cli_renderer = test_cli_renderer.renderer;
        const next = cli_renderer.getNextBuffer();
        const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);

        for (0..height) |y| {
            for (0..width) |x| {
                const value: u8 = @intCast((x + y * width) % 255);
                const fg = ansi.rgbColor(value, 255 - value, value / 2, 255);
                next.set(@intCast(x), @intCast(y), .{ .char = 'X', .fg = fg, .bg = bg, .attributes = 0 });
            }
        }
        try next.drawText("EARLY_SCROLL_CHANGED", 0, 0, ansi.rgbaFromFloats(1, 1, 1, 1), bg, 0);
        try next.drawText(
            "FULL_TOOL_RESULT_MARKER",
            width - 24,
            height - 1,
            ansi.rgbaFromFloats(1, 1, 1, 1),
            bg,
            0,
        );

        _ = test_cli_renderer.render(false);
        const output = test_cli_renderer.lastOutput();
        const current = cli_renderer.getCurrentBuffer();

        // Guard that this test actually exercises the growth path: the frame
        // must not fit in many feed chunks.
        try std.testing.expect(output.len > 2 * 1024 * 1024);
        try std.testing.expect(current.get(width - 24, height - 1).?.char == 'F');
        try std.testing.expect(std.mem.find(u8, output, "EARLY_SCROLL_CHANGED") != null);
        try std.testing.expect(std.mem.find(u8, output, "FULL_TOOL_RESULT_MARKER") != null);
    }
}

test "renderer - hyperlinks enabled with OSC 8 output" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    // Enable hyperlinks capability
    cli_renderer.terminal.caps.hyperlinks = true;

    // Allocate a link
    const link_id = try pools.links.acquire("https://example.com");
    const attributes = ansi.TextAttributes.setLinkId(ansi.TextAttributes.BOLD, link_id);

    const next_buffer = cli_renderer.getNextBuffer();

    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("Click here", 0, 0, fg, bg, attributes);

    _ = test_cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();

    // Verify OSC 8 contains id parameter
    try std.testing.expect(std.mem.find(u8, output, "\x1b]8;id=") != null);
    // Verify OSC 8 contains the URL
    try std.testing.expect(std.mem.find(u8, output, ";https://example.com\x1b\\") != null);

    // Verify output contains OSC 8 end sequence
    const end_seq = "\x1b]8;;\x1b\\";
    var count: usize = 0;
    var pos: usize = 0;
    while (std.mem.find(u8, output[pos..], end_seq)) |found| {
        count += 1;
        pos += found + end_seq.len;
    }
    try std.testing.expect(count >= 1);
}

test "renderer - hyperlinks disabled no OSC 8 output" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    // Hyperlinks disabled by default
    cli_renderer.terminal.caps.hyperlinks = false;

    // Allocate a link
    const link_id = try pools.links.acquire("https://example.com");
    const attributes = ansi.TextAttributes.setLinkId(0, link_id);

    const next_buffer = cli_renderer.getNextBuffer();
    try std.testing.expect(next_buffer.link_pool == &pools.links);

    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("Click here", 0, 0, fg, bg, attributes);

    _ = test_cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();

    // Verify output does NOT contain OSC 8 sequences
    try std.testing.expect(std.mem.find(u8, output, "]8;;") == null);
    try std.testing.expect(std.mem.find(u8, output, "]8;id=") == null);
}

test "renderer - link transition mid-line" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    // Enable hyperlinks
    cli_renderer.terminal.caps.hyperlinks = true;

    const next_buffer = cli_renderer.getNextBuffer();
    try std.testing.expect(next_buffer.link_pool == &pools.links);

    // Allocate two different links
    const link_id1 = try pools.links.acquire("https://first.com");
    const link_id2 = try pools.links.acquire("https://second.com");

    const attr1 = ansi.TextAttributes.setLinkId(0, link_id1);
    const attr2 = ansi.TextAttributes.setLinkId(0, link_id2);

    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);

    // Draw first link
    try next_buffer.drawText("First", 0, 0, fg, bg, attr1);
    // Draw second link
    try next_buffer.drawText("Second", 6, 0, fg, bg, attr2);
    // Draw no link
    try next_buffer.drawText("Normal", 13, 0, fg, bg, 0);

    _ = test_cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();

    // Should contain both URLs
    try std.testing.expect(std.mem.find(u8, output, "https://first.com") != null);
    try std.testing.expect(std.mem.find(u8, output, "https://second.com") != null);

    // Should have multiple OSC 8 end sequences (at least 2 transitions)
    const end_seq = "\x1b]8;;\x1b\\";
    var count: usize = 0;
    var pos: usize = 0;
    while (std.mem.find(u8, output[pos..], end_seq)) |found| {
        count += 1;
        pos += found + end_seq.len;
    }
    try std.testing.expect(count >= 2);
}

test "renderer - hyperlink spanning multiple rows uses same id" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    // Enable hyperlinks
    cli_renderer.terminal.caps.hyperlinks = true;

    const next_buffer = cli_renderer.getNextBuffer();

    // Allocate a single link
    const link_id = try pools.links.acquire("https://example.com/long-url");
    const attributes = ansi.TextAttributes.setLinkId(0, link_id);

    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);

    // Fill entire row 0 with linked text so link is never interrupted by empty cells
    try next_buffer.drawText("01234567890123456789012345678901234567890123456789012345678901234567890123456789", 0, 0, fg, bg, attributes);
    // Continue the same link on row 1
    try next_buffer.drawText("Here", 0, 1, fg, bg, attributes);

    _ = test_cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();

    // Build expected OSC 8 open sequence with the link id
    var buf: [256]u8 = undefined;
    const expected_open = std.fmt.bufPrint(&buf, "\x1b]8;id={d};https://example.com/long-url\x1b\\", .{link_id}) catch unreachable;
    var count: usize = 0;
    var pos: usize = 0;
    while (std.mem.find(u8, output[pos..], expected_open)) |found| {
        count += 1;
        pos += found + expected_open.len;
    }
    // Should appear exactly once: the link stays open across rows without
    // close/reopen at row boundaries, so terminals treat it as one contiguous link.
    try std.testing.expectEqual(@as(usize, 1), count);
}

test "renderer - explicit default and indexed tags use ANSI default/indexed output" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        4,
        1,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.rgb = true;
    cli_renderer.terminal.caps.ansi256 = true;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.set(0, 0, .{
        .char = 'A',
        .fg = ansi.defaultColor(255, 255, 255, 255),
        .bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0),
        .attributes = 0,
    });
    next_buffer.set(1, 0, .{
        .char = 'B',
        .fg = ansi.indexedColor(6, 51, 179, 230),
        .bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0),
        .attributes = 0,
    });

    _ = test_cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.find(u8, output, "\x1b[39m") != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b[38;5;6m") != null);
}

test "renderer - indexed snapshots fall back to rgb and explicit bg default resets without ansi256" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        2,
        1,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.rgb = true;
    cli_renderer.terminal.caps.ansi256 = false;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.set(0, 0, .{
        .char = 'A',
        .fg = ansi.indexedColor(6, 51, 102, 153),
        .bg = ansi.defaultColor(0, 0, 0, 255),
        .attributes = 0,
    });

    _ = test_cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.find(u8, output, "\x1b[38;2;51;102;153m") != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b[38;5;6m") == null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b[49m") != null);
}

test "renderer - rgb colors fall back to ANSI256 mapping from auto remote forwarded TERM" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        2,
        1,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.opts.remote_mode = .auto;
    try cli_renderer.terminal.setHostEnvVar(std.testing.allocator, "SSH_CONNECTION", "192.0.2.1 54231 192.0.2.2 22");
    try cli_renderer.terminal.setHostEnvVar(std.testing.allocator, "TERM", "screen-256color");

    const next_buffer = cli_renderer.getNextBuffer();
    try next_buffer.drawText("A", 0, 0, ansi.rgbaFromFloats(0.95, 0.1, 0.1, 1.0), ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 0);

    _ = test_cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.find(u8, output, "\x1b[38;5;") != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b[38;2;") == null);
}

test "renderer - rgb fallback uses published palette state" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        2,
        1,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.rgb = false;
    cli_renderer.terminal.caps.ansi256 = true;

    const target = ansi.rgbaFromFloats(0.3, 0.6, 0.9, 1.0);
    var palette: [256]RGBA = @splat(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0));
    palette[42] = target;
    cli_renderer.setPaletteState(palette[0..], ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0), ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 1);

    const next_buffer = cli_renderer.getNextBuffer();
    try next_buffer.drawText("A", 0, 0, target, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 0);

    _ = test_cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.find(u8, output, "\x1b[38;5;42m") != null);
}

test "renderer - palette epoch changes force repaint and use new palette mapping" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        2,
        1,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.rgb = false;
    cli_renderer.terminal.caps.ansi256 = true;

    const target = ansi.rgbaFromFloats(0.3, 0.6, 0.9, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);

    var palette_a: [256]RGBA = @splat(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0));
    palette_a[42] = target;
    cli_renderer.setPaletteState(palette_a[0..], ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0), bg, 1);

    const next_buffer = cli_renderer.getNextBuffer();
    try next_buffer.drawText("A", 0, 0, target, bg, 0);
    _ = test_cli_renderer.render(false);

    const first_output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.find(u8, first_output, "\x1b[38;5;42m") != null);

    try next_buffer.drawText("A", 0, 0, target, bg, 0);
    _ = test_cli_renderer.render(false);

    const second_output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.find(u8, second_output, "A") == null);

    var palette_b: [256]RGBA = @splat(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0));
    palette_b[77] = target;
    cli_renderer.setPaletteState(palette_b[0..], ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0), bg, 2);

    try next_buffer.drawText("A", 0, 0, target, bg, 0);
    _ = test_cli_renderer.render(false);

    const third_output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.find(u8, third_output, "A") != null);
    try std.testing.expect(std.mem.find(u8, third_output, "\x1b[38;5;77m") != null);
}

test "renderer - transparent rgb backgrounds still emit 49 reset" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        2,
        1,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.rgb = true;

    const next_buffer = cli_renderer.getNextBuffer();
    try next_buffer.drawText("A", 0, 0, ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0), ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = test_cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.find(u8, output, "\x1b[49m") != null);
}

// ============================================================================
// GRAPHEME CURSOR POSITIONING TESTS
// ============================================================================

test "renderer - default cursor style emits reset cursor ANSI" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.setCursorPosition(4, 2, true);
    _ = test_cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();

    try std.testing.expect(std.mem.find(u8, output, ansi.ANSI.defaultCursorStyle) != null);
    try std.testing.expect(std.mem.find(u8, output, ansi.ANSI.cursorBlock) == null);
}

test "renderer - explicit_cursor_positioning emits cursor move after wide graphemes" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode);
    defer tb.deinit();

    try tb.setText("👋X");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.explicit_cursor_positioning = true;
    cli_renderer.terminal.caps.explicit_width = false;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);

    _ = test_cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();

    try std.testing.expect(std.mem.find(u8, output, "\x1b[1;3H") != null);
}

test "renderer - explicit_cursor_positioning produces more cursor moves" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode);
    defer tb.deinit();
    try tb.setText("👋🎉🚀");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer1 = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer1.deinit();
    const cli_renderer1 = test_cli_renderer1.renderer;

    cli_renderer1.terminal.caps.explicit_cursor_positioning = false;
    cli_renderer1.terminal.caps.explicit_width = false;

    const next_buffer1 = cli_renderer1.getNextBuffer();
    next_buffer1.drawTextBuffer(view, 0, 0);
    _ = test_cli_renderer1.render(false);
    const output_without = test_cli_renderer1.lastOutput();

    var test_cli_renderer2 = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer2.deinit();
    const cli_renderer2 = test_cli_renderer2.renderer;

    cli_renderer2.terminal.caps.explicit_cursor_positioning = true;
    cli_renderer2.terminal.caps.explicit_width = false;

    const next_buffer2 = cli_renderer2.getNextBuffer();
    next_buffer2.drawTextBuffer(view, 0, 0);
    _ = test_cli_renderer2.render(false);
    const output_with = test_cli_renderer2.lastOutput();

    var count_without: usize = 0;
    var count_with: usize = 0;

    var i: usize = 0;
    while (i + 3 < output_without.len) : (i += 1) {
        if (output_without[i] == '\x1b' and output_without[i + 1] == '[') {
            var j = i + 2;
            while (j < output_without.len and ((output_without[j] >= '0' and output_without[j] <= '9') or output_without[j] == ';')) : (j += 1) {}
            if (j < output_without.len and output_without[j] == 'H') {
                count_without += 1;
            }
        }
    }

    i = 0;
    while (i + 3 < output_with.len) : (i += 1) {
        if (output_with[i] == '\x1b' and output_with[i + 1] == '[') {
            var j = i + 2;
            while (j < output_with.len and ((output_with[j] >= '0' and output_with[j] <= '9') or output_with[j] == ';')) : (j += 1) {}
            if (j < output_with.len and output_with[j] == 'H') {
                count_with += 1;
            }
        }
    }

    try std.testing.expect(count_with > count_without);
}

test "renderer - explicit_cursor_positioning with CJK characters" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode);
    defer tb.deinit();

    try tb.setText("世X");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.explicit_cursor_positioning = true;
    cli_renderer.terminal.caps.explicit_width = false;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);

    _ = test_cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();

    try std.testing.expect(std.mem.find(u8, output, "\x1b[1;3H") != null);
}

test "renderer - split commit writes append before footer repaint in one output" {
    // Terminals ignore a scroll region of fewer than two rows, so a pane of one row or none sets 1;2r too.
    for ([_]u32{ 2, 1, 0 }) |pinned| {
        var pools = TestPools.init(std.testing.allocator);
        defer pools.deinit();

        var test_cli_renderer = try TestRenderer.create(std.testing.allocator, 12, 3, &pools.graphemes, &pools.links);
        defer test_cli_renderer.deinit();
        const cli_renderer = test_cli_renderer.renderer;

        _ = cli_renderer.resetSplitScrollback(pinned, pinned);

        const next_buffer = cli_renderer.getNextBuffer();
        const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
        const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
        try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

        var snapshot = try OptimizedBuffer.init(
            std.testing.allocator,
            11,
            1,
            .{ .link_pool = &pools.links, .pool = &pools.graphemes, .width_method = .unicode, .respectAlpha = false },
        );
        defer snapshot.deinit();

        snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 32);
        try snapshot.drawText("append-line", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

        // This test documents the critical ordering contract:
        // 1) append payload is emitted in the same sync frame as repaint
        // 2) DECSTBM is active only during append when pinned
        // 3) footer repaint cursor move happens after append payload
        _ = test_cli_renderer.commitSplit(snapshot, 11, false, true, pinned, false);

        const output = test_cli_renderer.lastOutput();
        const sync_index = std.mem.find(u8, output, ansi.ANSI.syncSet) orelse return error.TestUnexpectedResult;
        const region_index = std.mem.find(u8, output, "\x1b[1;2r") orelse return error.TestUnexpectedResult;
        const append_index = std.mem.find(u8, output, "append-line") orelse return error.TestUnexpectedResult;
        const reset_index = std.mem.find(u8, output, "\x1b[r") orelse return error.TestUnexpectedResult;
        var footer_move: [16]u8 = undefined;
        const footer_move_text = try std.fmt.bufPrint(&footer_move, "\x1b[{d};1H", .{pinned + 1});

        try std.testing.expect(sync_index < region_index and region_index < append_index and append_index < reset_index);
        try std.testing.expect(std.mem.find(u8, output[reset_index..], footer_move_text) != null);
        try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, output, ansi.ANSI.syncSet));
    }
}

test "renderer - pinned split scrollback repaints live native images after append" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 3, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const image_handle: u32 = 1;
    test_renderer.renderer.terminal.caps.kitty_graphics = true;
    _ = test_renderer.renderer.resetSplitScrollback(2, 2);

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .kitty));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));

    var snapshot = try OptimizedBuffer.init(std.testing.allocator, 4, 1, .{ .link_pool = &pools.links, .pool = &pools.graphemes });
    defer snapshot.deinit();
    try snapshot.drawText("line", 0, 0, .{ 255, 255, 255, 255 }, null, 0);

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .kitty));
    const result = test_renderer.commitSplit(snapshot, 4, false, true, 2, false);
    try std.testing.expectEqual(renderer.RenderStatus.rendered, result);

    const output = test_renderer.memory.lastWrite();
    const append_index = std.mem.find(u8, output, "line") orelse return error.TestUnexpectedResult;
    const placement_index = std.mem.find(u8, output, "\x1b_Ga=p") orelse return error.TestUnexpectedResult;
    try std.testing.expect(placement_index > append_index);
}

test "renderer - frames carry the sync envelope unless a remote endpoint lacks 2026 or runs under a host multiplexer" {
    // `da1`: width probes disabled, 2026 not reported, and DA1 ends the replies.
    const Reply = enum { reported, not_reported, pending, da1 };
    const Mode = terminal_mod.SynchronizedOutput;
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    var snapshot = try OptimizedBuffer.init(std.testing.allocator, 4, 1, .{ .link_pool = &pools.links, .pool = &pools.graphemes });
    defer snapshot.deinit();
    try snapshot.drawText("line", 0, 0, .{ 255, 255, 255, 255 }, null, 0);
    const snapshots = [_]renderer.SplitSnapshot{.{ .snapshot = snapshot, .row_columns = 4, .start_on_new_line = false, .trailing_newline = true }};
    const bools = [_]bool{ false, true };
    // `host`: the host says a multiplexer runs between the app and the link. `client_tmux`: the terminal's
    // environment names one, as a client's does; it must not count.
    for (bools) |remote| for (bools) |host| for (bools) |client_tmux| for (bools) |xtversion| for (bools) |sentinel| for (std.enums.values(Reply)) |reply| for (std.enums.values(Mode)) |mode| {
        errdefer std.debug.print("remote={} host={} client_tmux={} xtversion={} sentinel={} reply={t} mode={t}\n", .{ remote, host, client_tmux, xtversion, sentinel, reply, mode });
        const env_all = [_]test_renderer_mod.TestEnvVar{
            .{ .key = "TMUX", .value = "/tmp/tmux-1000/default,1,0" },
            .{ .key = "OPENTUI_FORCE_EXPLICIT_WIDTH", .value = "0" },
        };
        const env = env_all[@intFromBool(!client_tmux)..if (reply == .da1) 2 else 1];
        var test_renderer = try TestRenderer.createWithEnv(std.testing.allocator, 8, 2, &pools.graphemes, &pools.links, env);
        defer test_renderer.deinit();
        const term = &test_renderer.renderer.terminal;
        term.opts.remote_mode = if (remote) .remote else .local;
        term.synchronized_output = mode;
        term.multiplexer_on_host = host;
        term.reply_sentinel = sentinel;
        var writer = DiscardTerminalWriter{};
        try term.queryTerminalSend(&writer);
        // Replies come in query order: XTVERSION, the startup cursor report, DECRQM, then the width probe's report
        // or DA1. A pending reply has only the cursor report, which precedes DECRQM. A tmux on either side of the
        // link answers XTVERSION, so the answer alone does not drop the envelope.
        if (xtversion) term.processCapabilityResponse("\x1bP>|tmux 3.8\x1b\\");
        term.processCapabilityResponse("\x1b[3;1R");
        if (reply == .reported) term.processCapabilityResponse("\x1b[?2026;2$y");
        if (reply != .pending) term.processCapabilityResponse(if (reply == .da1) "\x1b[?62;22c" else "\x1b[1;1R");

        const dropped = remote and reply != .pending and (reply != .reported or host);
        const envelope = mode == .always or (mode == .auto and !dropped);
        _ = test_renderer.renderer.resetSplitScrollback(1, 1);
        try test_renderer.renderer.getNextBuffer().drawText("ab", 0, 0, .{ 255, 255, 255, 255 }, null, 0);
        // A full frame and a split frame without footer paint close the envelope in different places.
        for (0..2) |frame| {
            const status = if (frame == 0) test_renderer.render(true) else test_renderer.renderSplit(.{
                .snapshots = &snapshots,
                .pinned_render_offset = 1,
                .paint_footer = false,
                .suspended = false,
            }, false);
            try std.testing.expectEqual(renderer.RenderStatus.rendered, status);
            const output = test_renderer.lastOutput();
            try std.testing.expect(output.len != 0);
            try std.testing.expectEqual(envelope, std.mem.startsWith(u8, output, ansi.ANSI.syncSet));
            try std.testing.expectEqual(envelope, std.mem.endsWith(u8, output, ansi.ANSI.syncReset));
            try std.testing.expectEqual(@intFromBool(envelope), std.mem.count(u8, output, ansi.ANSI.syncSet));
            try std.testing.expectEqual(@intFromBool(envelope), std.mem.count(u8, output, ansi.ANSI.syncReset));
        }
    };
}

test "renderer - split scrollback materializes image fallback cells" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 3, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const image_handle: u32 = 1;
    const snapshot = try OptimizedBuffer.init(std.testing.allocator, 2, 1, .{ .pool = &pools.graphemes, .link_pool = &pools.links });
    defer snapshot.deinit();
    try std.testing.expect(try snapshot.drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));
    try snapshot.drawText("X", 1, 0, .{ 255, 255, 255, 255 }, null, 0);
    _ = test_renderer.renderer.resetSplitScrollback(2, 2);
    _ = test_renderer.commitSplit(snapshot, 2, false, true, 2, false);
    const output = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.findScalar(u8, output, 'X') != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b_G") == null);
    try std.testing.expect(std.mem.find(u8, output, "\x1bP0;1;0q") == null);
    try std.testing.expect(std.mem.find(u8, output, "█") != null);
}

test "renderer - split scrollback uses native Kitty when Kitty is selected" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 3, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const image_handle: u32 = 1;
    test_renderer.renderer.terminal.processCapabilityResponse("\x1b_Gi=31337;OK\x1b\\");
    var snapshot = try OptimizedBuffer.init(std.testing.allocator, 1, 1, .{ .pool = &pools.graphemes, .link_pool = &pools.links });
    defer snapshot.deinit();
    snapshot.clear(ansi.rgbColor(1, 2, 3, 255), null);
    try std.testing.expect(try snapshot.drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));
    _ = test_renderer.renderer.resetSplitScrollback(2, 2);

    const result = test_renderer.commitSplit(snapshot, 1, false, true, 2, false);
    try std.testing.expectEqual(renderer.RenderStatus.rendered, result);

    const output = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, output, "\x1b_Ga=t") != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b_Ga=p") != null);
    try std.testing.expect(std.mem.find(u8, output, "C=1,z=-1073741823") != null);
    try std.testing.expect(std.mem.find(u8, output, ",U=1,") == null);
    try std.testing.expect(std.mem.find(u8, output, "\u{10EEEE}") == null);
    try std.testing.expect(std.mem.find(u8, output, "█") == null);
    try std.testing.expect(std.mem.find(u8, output, "48;2;1;2;3") == null);
}

test "renderer - split scrollback covered Kitty image uses blocks" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 3, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const image_handle: u32 = 1;
    test_renderer.renderer.terminal.processCapabilityResponse("\x1b_Gi=31337;OK\x1b\\");
    const snapshot = try OptimizedBuffer.init(std.testing.allocator, 2, 1, .{ .pool = &pools.graphemes, .link_pool = &pools.links });
    defer snapshot.deinit();
    try std.testing.expect(try snapshot.drawImage(value, image_handle, 0, 0, 2, 1, 0, 0, 0, 0, 1, 1, .auto));
    try snapshot.drawText("X", 0, 0, .{ 255, 255, 255, 255 }, null, 0);
    _ = test_renderer.renderer.resetSplitScrollback(2, 2);

    const result = test_renderer.commitSplit(snapshot, 2, false, true, 2, false);
    try std.testing.expectEqual(renderer.RenderStatus.rendered, result);
    const output = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, output, "\x1b_Ga=p") == null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b_Ga=t") == null);
    try std.testing.expect(std.mem.findScalar(u8, output, 'X') != null);
    try std.testing.expect(std.mem.find(u8, output, "█") != null);
}

test "renderer - split scrollback images remain addressable before and across pinning" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const image_handle: u32 = 1;

    for ([_]bool{ false, true }) |sixel| {
        for ([_]u32{ 0, 2, 5, 6 }) |seed_rows| {
            for ([_]u32{ 1, 4, 6, 7 }) |height| {
                var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 3, &pools.graphemes, &pools.links);
                defer test_renderer.deinit();
                test_renderer.renderer.terminal.caps.kitty_graphics = !sixel;
                test_renderer.renderer.terminal.caps.sixel = sixel;
                const snapshot = try OptimizedBuffer.init(std.testing.allocator, 4, height + 2, .{ .pool = &pools.graphemes, .link_pool = &pools.links });
                defer snapshot.deinit();
                try snapshot.drawText("top", 0, 0, .{ 255, 255, 255, 255 }, null, 0);
                try std.testing.expect(try snapshot.drawImage(value, image_handle, 0, 1, 2, height, 4, height * 2, 0, 0, 1, 1, .auto));
                try snapshot.drawText("end", 0, @intCast(height + 1), .{ 255, 255, 255, 255 }, null, 0);
                _ = test_renderer.renderer.resetSplitScrollback(seed_rows, 6);

                const result = test_renderer.commitSplit(snapshot, 4, true, true, 6, false);
                try std.testing.expectEqual(renderer.RenderStatus.rendered, result);
                const output = test_renderer.memory.lastWrite();
                const placement = std.mem.find(u8, output, if (sixel) "\x1bP0;1;0q" else "\x1b_Ga=p");
                try std.testing.expectEqual(height <= 6, placement != null);
                try std.testing.expectEqual(height > 6, std.mem.find(u8, output, "\xe2\x96\x88") != null);
                if (placement) |index| {
                    try std.testing.expect(std.mem.find(u8, output, "top").? < index);
                    try std.testing.expect(index < std.mem.find(u8, output, "end").?);
                    var terminal: ghostty_vt.vt.Terminal = try .init(std.testing.io, std.testing.allocator, .{
                        .cols = 4,
                        .rows = 9,
                    });
                    defer terminal.deinit(std.testing.allocator);
                    var stream = terminal.vtStream();
                    defer stream.deinit();
                    stream.nextSlice(output[0..index]);
                    try std.testing.expectEqual(@as(u16, 0), terminal.screens.active.cursor.x);
                    try std.testing.expectEqual(@min(@max(seed_rows, 1) + height, 6) - height, terminal.screens.active.cursor.y);
                }
            }
        }
    }
}

test "renderer - failed Kitty scrollback preparation does not publish the batch" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 3, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{
        255, 0, 0, 255, 0, 0, 255, 255,
    }, 2, 1, 8);
    defer value.deinit();
    const image_handle: u32 = 1;
    test_renderer.renderer.terminal.processCapabilityResponse("\x1bP>|kitty(0.40.1)\x1b\\\x1b_Gi=31337;OK\x1b\\");
    var snapshot = try OptimizedBuffer.init(std.testing.allocator, 1, 1, .{ .pool = &pools.graphemes, .link_pool = &pools.links });
    defer snapshot.deinit();
    try std.testing.expect(try snapshot.drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));
    _ = test_renderer.renderer.resetSplitScrollback(2, 2);
    test_renderer.renderer.kittyHistoryNextImageId = std.math.maxInt(u32);
    const split_scrollback = test_renderer.renderer.splitScrollback;
    const render_offset = test_renderer.renderer.renderOffset;

    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0 });
    test_renderer.renderer.allocator = failing.allocator();
    const result = test_renderer.commitSplit(snapshot, 1, false, true, 2, false);
    test_renderer.renderer.allocator = std.testing.allocator;

    try std.testing.expect(failing.has_induced_failure);
    try std.testing.expectEqual(renderer.RenderStatus.failed, result);
    try std.testing.expectEqual(@as(usize, 0), test_renderer.memory.lastWrite().len);
    try std.testing.expectEqualDeep(split_scrollback, test_renderer.renderer.splitScrollback);
    try std.testing.expectEqual(render_offset, test_renderer.renderer.renderOffset);
    try std.testing.expectEqual(@as(usize, 1), snapshot.image_placements.items.len);
    try std.testing.expectEqual(@as(?u32, std.math.maxInt(u32)), test_renderer.renderer.kittyHistoryNextImageId);

    const retry = test_renderer.commitSplit(snapshot, 1, false, true, 2, false);
    try std.testing.expectEqual(renderer.RenderStatus.rendered, retry);
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1b_Ga=t") != null);
}

test "renderer - split scrollback emits native Sixel images when placement geometry is available" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 3, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const image_handle: u32 = 1;
    test_renderer.renderer.terminal.caps.sixel = true;
    var snapshot = try OptimizedBuffer.init(std.testing.allocator, 1, 1, .{ .pool = &pools.graphemes, .link_pool = &pools.links });
    defer snapshot.deinit();
    try std.testing.expect(try snapshot.drawImage(value, image_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    _ = test_renderer.renderer.resetSplitScrollback(2, 2);

    const result = test_renderer.commitSplit(snapshot, 1, false, true, 2, false);
    try std.testing.expectEqual(renderer.RenderStatus.rendered, result);

    const output = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, output, "\x1bP0;1;0q") != null);
    try std.testing.expect(std.mem.find(u8, output, ansi.ANSI.saveCursorState) != null);
    try std.testing.expect(std.mem.find(u8, output, ansi.ANSI.restoreCursorState) != null);
    try std.testing.expect(std.mem.find(u8, output, "█") == null);

    var covered = try OptimizedBuffer.init(std.testing.allocator, 1, 1, .{ .pool = &pools.graphemes, .link_pool = &pools.links });
    defer covered.deinit();
    try std.testing.expect(try covered.drawImage(value, image_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    try covered.drawText("X", 0, 0, .{ 255, 255, 255, 255 }, null, 0);
    const covered_result = test_renderer.commitSplit(covered, 1, false, true, 2, false);
    try std.testing.expectEqual(renderer.RenderStatus.rendered, covered_result);
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q") == null);
    try std.testing.expect(std.mem.findScalar(u8, test_renderer.memory.lastWrite(), 'X') != null);
}

test "renderer - split commit settling phase moves footer downward" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        12,
        3,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    _ = cli_renderer.resetSplitScrollback(0, 3);

    const next_buffer = cli_renderer.getNextBuffer();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

    var snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        6,
        1,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .width_method = .unicode, .respectAlpha = false },
    );
    defer snapshot.deinit();

    snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 32);
    try snapshot.drawText("settle", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    const appended = "settle";
    // During settling we intentionally avoid bounded DECSTBM and instead clear rows
    // that transition from footer surface to scrollback before append.
    _ = test_cli_renderer.commitSplit(snapshot, 6, false, true, 3, false);

    const output = test_cli_renderer.lastOutput();
    const settling_clear_index = std.mem.find(u8, output, "\x1b[1;1H\x1b[J");
    const stale_footer_clear_top_index = std.mem.find(u8, output, "\x1b[1;1H\x1b[2K");
    const stale_footer_clear_next_index = std.mem.find(u8, output, "\x1b[2;1H\x1b[2K");
    const append_index = std.mem.find(u8, output, appended);
    const scroll_region_reset_index = std.mem.find(u8, output, "\x1b[r");
    const footer_clear_index = std.mem.find(u8, output, "\x1b[3;1H\x1b[2K");
    const footer_erase_below_index = std.mem.find(u8, output, "\x1b[3;1H\x1b[J");
    const sync_index = std.mem.find(u8, output, ansi.ANSI.syncSet);

    try std.testing.expectEqual(@as(u32, 2), cli_renderer.renderOffset);
    try std.testing.expect(settling_clear_index == null);
    try std.testing.expect(stale_footer_clear_top_index != null);
    try std.testing.expect(stale_footer_clear_next_index != null);
    try std.testing.expect(append_index != null);
    try std.testing.expect(scroll_region_reset_index == null);
    try std.testing.expect(footer_clear_index == null);
    try std.testing.expect(footer_erase_below_index == null);
    try std.testing.expect(sync_index != null);
    try std.testing.expect(sync_index.? < append_index.?);
    try std.testing.expect(stale_footer_clear_top_index.? < append_index.?);
}

test "renderer - split commit multiline settling enables bounded scroll at pin" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        12,
        3,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    _ = cli_renderer.resetSplitScrollback(1, 3);

    const next_buffer = cli_renderer.getNextBuffer();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

    var snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        6,
        2,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .width_method = .unicode, .respectAlpha = false },
    );
    defer snapshot.deinit();

    snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 32);
    try snapshot.drawText("line-a", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try snapshot.drawText("line-b", 0, 1, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = test_cli_renderer.commitSplit(snapshot, 6, false, true, 3, false);

    const output = test_cli_renderer.lastOutput();
    const expanded_region_index = std.mem.find(u8, output, "\x1b[1;3r");
    const collapsed_region_index = std.mem.find(u8, output, "\x1b[r");

    try std.testing.expectEqual(@as(u32, 3), cli_renderer.renderOffset);
    try std.testing.expect(expanded_region_index != null);
    try std.testing.expect(collapsed_region_index != null);
    try std.testing.expect(expanded_region_index.? < collapsed_region_index.?);
}

test "renderer - split commit multiline short final row keeps continuation column" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        20,
        4,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    _ = cli_renderer.resetSplitScrollback(2, 2);

    const next_buffer = cli_renderer.getNextBuffer();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

    var first_snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        16,
        3,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .width_method = .unicode, .respectAlpha = false },
    );
    defer first_snapshot.deinit();

    first_snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try first_snapshot.drawText("1234567890123456", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try first_snapshot.drawText("short", 0, 2, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = test_cli_renderer.commitSplit(first_snapshot, 16, false, false, 2, false);

    try std.testing.expectEqual(@as(u32, 5), cli_renderer.splitScrollback.tail_column);

    var second_snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        1,
        1,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .width_method = .unicode, .respectAlpha = false },
    );
    defer second_snapshot.deinit();

    second_snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try second_snapshot.drawText(",", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = test_cli_renderer.commitSplit(second_snapshot, 1, false, false, 2, false);

    const output = test_cli_renderer.lastOutput();
    const move_index = std.mem.find(u8, output, "\x1b[2;6H");
    const comma_index = std.mem.find(u8, output, ",");

    try std.testing.expect(move_index != null);
    try std.testing.expect(comma_index != null);
    try std.testing.expect(move_index.? < comma_index.?);
    try std.testing.expect(std.mem.find(u8, output, "\x1b[2;17H") == null);
}

test "renderer - split commit exact-width continuation preserves autowrap" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        20,
        4,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    _ = cli_renderer.resetSplitScrollback(2, 2);

    const next_buffer = cli_renderer.getNextBuffer();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

    var first_snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        1,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .width_method = .unicode, .respectAlpha = false },
    );
    defer first_snapshot.deinit();

    first_snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try first_snapshot.drawText("12345678901234567890", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = test_cli_renderer.commitSplit(first_snapshot, 20, false, false, 2, false);

    var second_snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        8,
        1,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .width_method = .unicode, .respectAlpha = false },
    );
    defer second_snapshot.deinit();

    second_snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try second_snapshot.drawText(" letters", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = test_cli_renderer.commitSplit(second_snapshot, 8, false, false, 2, false);

    const output = test_cli_renderer.lastOutput();
    const wrap_index = std.mem.find(u8, output, "\x1b[2;20H\r\n");
    const text_index = std.mem.find(u8, output, " letters");

    try std.testing.expectEqual(@as(u32, 8), cli_renderer.splitScrollback.tail_column);
    try std.testing.expect(wrap_index != null);
    try std.testing.expect(text_index != null);
    try std.testing.expect(wrap_index.? < text_index.?);
}

test "renderer - split commit does not emit continuation spaces for wide graphemes" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        12,
        4,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    _ = cli_renderer.resetSplitScrollback(2, 2);

    const next_buffer = cli_renderer.getNextBuffer();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

    var snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        2,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .width_method = .unicode, .respectAlpha = false },
    );
    defer snapshot.deinit();

    snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try snapshot.drawText("│甲│乙│丙│", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try snapshot.drawText("│😀│🚀│🧪│", 0, 1, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = test_cli_renderer.commitSplit(snapshot, 10, false, false, 2, false);

    const output = test_cli_renderer.lastOutput();

    try std.testing.expect(std.mem.find(u8, output, "│甲│乙│丙│") != null);
    try std.testing.expect(std.mem.find(u8, output, "│😀│🚀│🧪│") != null);
    try std.testing.expect(std.mem.find(u8, output, "甲 ") == null);
    try std.testing.expect(std.mem.find(u8, output, "乙 ") == null);
    try std.testing.expect(std.mem.find(u8, output, "丙 ") == null);
    try std.testing.expect(std.mem.find(u8, output, "😀 ") == null);
    try std.testing.expect(std.mem.find(u8, output, "🚀 ") == null);
    try std.testing.expect(std.mem.find(u8, output, "🧪 ") == null);
}

test "renderer - split repaint writes the footer and its pending transition in one ordered frame" {
    const Case = struct {
        height: u32,
        reset: [2]u32,
        render_offset: ?u32 = null,
        viewport_scroll: u32 = 0,
        transition: renderer.SplitFooterTransition = .{},
        pinned: u32,
        // Each sequence's first occurrence follows the previous one's.
        ordered: []const []const u8,
        absent: []const []const u8 = &.{},
        output_offset: ?u32 = null,
    };
    const cases = [_]Case{
        // No append payload: the footer repaints without clearing its rows.
        .{ .height = 3, .reset = .{ 2, 2 }, .pinned = 2, .ordered = &.{ ansi.ANSI.syncSet, "FOOT" }, .absent = &.{ "\x1b[3;1H\x1b[2K", "\x1b[3;1H\x1b[J" } },
        .{
            .height = 1,
            .reset = .{ 4, 4 },
            .render_offset = 3,
            .transition = .{ .mode = .viewport_scroll, .source_top_line = 4, .source_height = 2, .target_top_line = 5, .target_height = 1, .scroll_lines = 1 },
            .pinned = 4,
            .ordered = &.{ ansi.ANSI.syncSet, "\x1b[1T", "\x1b[5;1H", "FOOT" },
        },
        // A gap that already exists scrolls by the explicit split delta.
        .{
            .height = 8,
            .reset = .{ 6, 6 },
            .render_offset = 6,
            .viewport_scroll = 2,
            .transition = .{ .mode = .viewport_scroll, .source_top_line = 7, .source_height = 4, .target_top_line = 3, .target_height = 8, .scroll_lines = 2 },
            .pinned = 2,
            .ordered = &.{"\x1b[2S"},
            .absent = &.{"\x1b[4S"},
            .output_offset = 2,
        },
        .{
            .height = 3,
            .reset = .{ 1, 7 },
            .transition = .{ .mode = .clear_stale_rows, .source_top_line = 2, .source_height = 4, .target_top_line = 2, .target_height = 3, .scroll_lines = 0 },
            .pinned = 7,
            .ordered = &.{ ansi.ANSI.syncSet, "\x1b[5;1H\x1b[2K", "FOOT" },
        },
    };
    for (cases, 0..) |case, index| {
        errdefer std.debug.print("split repaint case {d}\n", .{index});
        var pools = TestPools.init(std.testing.allocator);
        defer pools.deinit();
        var test_cli_renderer = try TestRenderer.create(std.testing.allocator, 12, case.height, &pools.graphemes, &pools.links);
        defer test_cli_renderer.deinit();
        const cli_renderer = test_cli_renderer.renderer;
        _ = cli_renderer.resetSplitScrollback(case.reset[0], case.reset[1]);
        if (case.viewport_scroll != 0) cli_renderer.splitScrollback.noteViewportScroll(case.viewport_scroll);
        if (case.render_offset) |offset| cli_renderer.renderOffset = offset;
        cli_renderer.pendingSplitFooterTransition = case.transition;
        try cli_renderer.getNextBuffer().drawText("FOOT", 0, 0, ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0), ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 0);

        _ = test_cli_renderer.repaintSplit(case.pinned, true);

        const output = test_cli_renderer.lastOutput();
        var previous: usize = 0;
        for (case.ordered, 0..) |sequence, position| {
            const found = std.mem.find(u8, output, sequence) orelse return error.TestUnexpectedResult;
            if (position != 0) try std.testing.expect(previous < found);
            previous = found;
        }
        for (case.absent) |sequence| try std.testing.expect(std.mem.find(u8, output, sequence) == null);
        try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, output, ansi.ANSI.syncSet));
        try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, output, ansi.ANSI.syncReset));
        if (case.output_offset) |offset| try std.testing.expectEqual(offset, cli_renderer.getSplitOutputOffset(case.pinned));
    }
}

test "renderer - split repaint frames record frame cost" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_cli_renderer = try TestRenderer.create(std.testing.allocator, 12, 3, &pools.graphemes, &pools.links);
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    _ = cli_renderer.resetSplitScrollback(2, 2);
    const stale = std.math.maxInt(u32);
    cli_renderer.lastFrameCostUs = stale;
    const frames = cli_renderer.renderStats.frameCount;
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_cli_renderer.repaintSplit(2, true));
    try std.testing.expectEqual(frames + 1, cli_renderer.renderStats.frameCount);
    try std.testing.expect(cli_renderer.lastFrameCostUs != stale);
}

test "renderer - split commit appends styled snapshot with snapshot links before footer repaint" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    var snapshot_links = link.LinkPool.init(std.testing.allocator);
    defer snapshot_links.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        16,
        4,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.rgb = true;
    cli_renderer.terminal.caps.ansi256 = true;
    cli_renderer.terminal.caps.hyperlinks = true;

    const renderer_link_id = try pools.links.acquire("https://renderer.invalid");
    const snapshot_link_id = try snapshot_links.acquire("https://snapshot.example");
    try std.testing.expectEqual(renderer_link_id, snapshot_link_id);

    _ = cli_renderer.resetSplitScrollback(2, 2);

    const next_buffer = cli_renderer.getNextBuffer();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

    var snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        8,
        2,
        .{ .pool = &pools.graphemes, .link_pool = &snapshot_links, .width_method = .unicode, .respectAlpha = false },
    );
    defer snapshot.deinit();

    snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 32);
    try snapshot.drawText("SNAP", 0, 0, ansi.rgbaFromFloats(1.0, 0.5, 0.0, 1.0), ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), ansi.TextAttributes.BOLD);
    const link_attributes = ansi.TextAttributes.setLinkId(0, snapshot_link_id);
    try snapshot.drawText("SHOT", 0, 1, ansi.rgbaFromFloats(0.2, 0.8, 0.9, 1.0), ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), link_attributes);

    _ = test_cli_renderer.commitSplit(snapshot, 8, true, true, 2, false);

    const output = test_cli_renderer.lastOutput();
    const snapshot_text_index = std.mem.find(u8, output, "SNAP");
    const orange_fg_index = std.mem.find(u8, output, "\x1b[38;2;255;128;0m");
    const bold_index = std.mem.find(u8, output, "\x1b[1m");
    const sync_index = std.mem.find(u8, output, ansi.ANSI.syncSet);
    const footer_clear_index = std.mem.find(u8, output, "\x1b[3;1H\x1b[2K");

    try std.testing.expect(snapshot_text_index != null);
    try std.testing.expect(orange_fg_index != null);
    try std.testing.expect(bold_index != null);
    try std.testing.expect(sync_index != null);
    try std.testing.expect(sync_index.? < snapshot_text_index.?);
    try std.testing.expect(footer_clear_index == null);
    try std.testing.expect(std.mem.find(u8, output, ";https://snapshot.example\x1b\\") != null);
    try std.testing.expect(std.mem.find(u8, output, "https://renderer.invalid") == null);
}

test "renderer - split commit preserves indexed and default color tags" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        8,
        4,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.rgb = true;
    cli_renderer.terminal.caps.ansi256 = true;

    _ = cli_renderer.resetSplitScrollback(2, 2);

    var snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        2,
        1,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .width_method = .unicode, .respectAlpha = false },
    );
    defer snapshot.deinit();

    snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    snapshot.set(0, 0, .{
        .char = 'A',
        .fg = ansi.defaultColor(255, 255, 255, 255),
        .bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0),
        .attributes = 0,
    });
    snapshot.set(1, 0, .{
        .char = 'B',
        .fg = ansi.indexedColor(6, 51, 102, 153),
        .bg = ansi.defaultColor(0, 0, 0, 255),
        .attributes = 0,
    });

    _ = test_cli_renderer.commitSplit(snapshot, 2, true, false, 2, false);

    const output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.find(u8, output, "A") != null);
    try std.testing.expect(std.mem.find(u8, output, "B") != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b[39m") != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b[38;5;6m") != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b[49m") != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b[38;2;51;102;153m") == null);
}

test "renderer - split commit does not emit NUL padding for short rows" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        20,
        4,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    _ = cli_renderer.resetSplitScrollback(2, 2);

    const next_buffer = cli_renderer.getNextBuffer();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

    var snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        16,
        2,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .width_method = .unicode, .respectAlpha = false },
    );
    defer snapshot.deinit();

    snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 32);
    try snapshot.drawText("[tool:bash] Shell", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try snapshot.drawText("$ pwd", 0, 1, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = test_cli_renderer.commitSplit(snapshot, 16, true, true, 2, false);

    const output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.findScalar(u8, output, 0) == null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b[0m\r\n\x1b[K") != null);
}

test "renderer - batched split commits share single sync frame" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        16,
        4,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    _ = cli_renderer.resetSplitScrollback(2, 2);

    const next_buffer = cli_renderer.getNextBuffer();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

    var first_snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        1,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .width_method = .unicode, .respectAlpha = false },
    );
    defer first_snapshot.deinit();
    first_snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 32);
    try first_snapshot.drawText("FIRST", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    var second_snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        1,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .width_method = .unicode, .respectAlpha = false },
    );
    defer second_snapshot.deinit();
    second_snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 32);
    try second_snapshot.drawText("SECOND", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    const snapshots = [_]renderer.SplitSnapshot{
        .{ .snapshot = first_snapshot, .row_columns = 10, .start_on_new_line = true },
        .{ .snapshot = second_snapshot, .row_columns = 10, .start_on_new_line = true },
    };
    _ = test_cli_renderer.renderSplit(.{ .snapshots = &snapshots, .pinned_render_offset = 2, .paint_footer = true, .suspended = false }, false);

    const output = test_cli_renderer.lastOutput();
    // Batching should keep both commits inside one synchronized update envelope.
    try std.testing.expect(std.mem.find(u8, output, "FIRST") != null);
    try std.testing.expect(std.mem.find(u8, output, "SECOND") != null);
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, output, ansi.ANSI.syncSet));
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, output, ansi.ANSI.syncReset));
}

test "renderer - unchanged frame with unchanged cursor emits no output" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        12,
        4,
        &pools.graphemes,
        &pools.links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.setCursorPosition(3, 2, true);
    _ = test_cli_renderer.render(false);

    _ = test_cli_renderer.render(false);
    const output = test_cli_renderer.lastOutput();

    // No-op frames must be byte-empty; otherwise repeated sync/cursor toggles can
    // produce visible shimmer in terminals that animate cursor or repaint eagerly.
    try std.testing.expectEqual(@as(usize, 0), output.len);
}

// ---- FeedBackend tests ----

test "FeedBackend - shouldSkipFrame when span queue saturated" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    // Create a feed with a very small span queue so we can saturate it easily.
    var opts = native_span_feed.defaultOptions();
    opts.span_queue_capacity = 2;
    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    var cli_renderer = try CliRenderer.createWithOptions(std.testing.allocator, 80, 24, &pools.graphemes, .{
        .link_pool = &pools.links,
        .remote_mode = .remote,
        .feed = feed,
    });
    // LIFO: renderer destroys first.
    defer feed.destroy();
    defer cli_renderer.destroyStorage();

    // Present two frames, then let two raw writes the host has not consumed
    // fill the span queue.
    const fg = RGBA{ 1.0, 1.0, 1.0, 1.0 };
    const bg = RGBA{ 0.0, 0.0, 0.0, 1.0 };
    const next_buffer = cli_renderer.getNextBuffer();
    try next_buffer.drawText("A", 0, 0, fg, bg, 0);
    _ = try renderPresented(cli_renderer, false, discard);

    try next_buffer.drawText("B", 0, 0, fg, bg, 0);
    _ = try renderPresented(cli_renderer, false, discard);

    try feed.writeAtomic("raw");
    try feed.writeAtomic("raw");
    try std.testing.expect(cli_renderer.backend.shouldSkipFrame());

    // Catch-up semantics: a skipped render must NOT advance lastRenderTime,
    // so the next non-skipped frame sees the full accumulated delta.
    const before = cli_renderer.lastRenderTime;
    try next_buffer.drawText("C", 0, 0, fg, bg, 0);
    const status = try cli_renderer.renderDeferred(false);
    try std.testing.expectEqual(before, cli_renderer.lastRenderTime);
    try std.testing.expectEqual(renderer.RenderStatus.skipped, status);

    const current_cell = cli_renderer.getCurrentBuffer().get(0, 0).?;
    const next_cell = cli_renderer.getNextBuffer().get(0, 0).?;
    try std.testing.expectEqual(@as(u32, 'B'), current_cell.char);
    try std.testing.expect(next_cell.char != @as(u32, 'C'));
}

test "FeedBackend - high water includes drained spans until all consumers release them" {
    var opts = native_span_feed.defaultOptions();
    opts.span_queue_capacity = 2;
    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    defer feed.destroy();
    var backend = renderer.FeedBackend.createWithIo(io, feed);
    defer backend.deinit();

    // Two spans in one chunk exercise refcounts, not just the number of chunks.
    try feed.write("first");
    try feed.commit();
    try std.testing.expectEqual(.ok, backend.prepareFrame());
    try feed.write("second");
    try feed.commit();
    try std.testing.expectEqual(.skipped, backend.prepareFrame());

    var spans: [2]native_span_feed.SpanInfo = undefined;
    try std.testing.expectEqual(@as(u32, 2), feed.drainSpans(&spans));
    try std.testing.expectEqual(@as(u32, 0), feed.getStats().pending_spans);
    try std.testing.expectEqual(spans[0].chunk_index, spans[1].chunk_index);
    try std.testing.expectEqual(.skipped, backend.prepareFrame());

    // Control writes may grow the feed but must not overwrite committed spans.
    backend.writeOut("shutdown");
    try std.testing.expectEqualStrings("first", spans[0].slice());
    try std.testing.expectEqualStrings("second", spans[1].slice());
    feed.markSpanConsumed(spans[1]);
    try std.testing.expectEqual(.skipped, backend.prepareFrame());
    feed.markSpanConsumed(spans[0]);
    try std.testing.expectEqual(.ok, backend.prepareFrame());
    try std.testing.expectEqual(@as(u32, 1), feed.drainSpans(&spans));
    try std.testing.expectEqualStrings("shutdown", spans[0].slice());
    feed.markSpanConsumed(spans[0]);
    try std.testing.expectEqual(.ok, backend.prepareFrame());
}

test "FeedBackend - prepareFrame commits existing pending bytes before new frames" {
    var opts = native_span_feed.defaultOptions();
    opts.chunk_size = 64;
    opts.initial_chunks = 1;
    opts.auto_commit_on_full = 0;

    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    defer feed.destroy();

    var backend = renderer.FeedBackend.createWithIo(io, feed);

    try feed.write("pending");
    try std.testing.expect(feed.hasPendingBytes());
    try std.testing.expectEqual(.skipped, backend.prepareFrame());

    var span_out: [4]native_span_feed.SpanInfo = undefined;
    const count = feed.drainSpans(&span_out);
    try std.testing.expectEqual(@as(u32, 1), count);
    try std.testing.expectEqualStrings("pending", span_out[0].slice());
    feed.markSpanConsumed(span_out[0]);

    try std.testing.expectEqual(.ok, backend.prepareFrame());
}

test "FeedBackend - failed frame publishes no partial bytes" {
    var opts = native_span_feed.defaultOptions();
    opts.chunk_size = 32;
    opts.initial_chunks = 1;
    opts.max_bytes = 32;
    opts.growth_policy = @backingInt(native_span_feed.GrowthPolicy.block);
    opts.auto_commit_on_full = 0;

    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    defer feed.destroy();

    var backend = renderer.FeedBackend.createWithIo(io, feed);
    defer backend.deinit();

    backend.beginFrame();
    var failed_writer = backend.writer();
    try failed_writer.writeAll("pending");
    try failed_writer.writeAll("this-write-is-too-large-for-the-current-chunk");
    try std.testing.expectEqual(@as(usize, 52), backend.oversizeBytes);
    try std.testing.expectEqual(.failed, backend.endFrame());

    var span_out: [4]native_span_feed.SpanInfo = undefined;
    const count = feed.drainSpans(&span_out);
    try std.testing.expectEqual(@as(u32, 0), count);
}

test "FeedBackend - failed split batch restores unpublished scrollback state" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var opts = native_span_feed.defaultOptions();
    opts.chunk_size = 64;
    opts.initial_chunks = 1;
    opts.max_bytes = 64;
    opts.growth_policy = @backingInt(native_span_feed.GrowthPolicy.block);
    opts.auto_commit_on_full = 0;
    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    var cli_renderer = try CliRenderer.createWithOptions(std.testing.allocator, 40, 4, &pools.graphemes, .{
        .link_pool = &pools.links,
        .remote_mode = .remote,
        .feed = feed,
    });
    defer feed.destroy();
    defer cli_renderer.destroyStorage();

    var snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        32,
        1,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .width_method = .unicode, .respectAlpha = false },
    );
    defer snapshot.deinit();
    try snapshot.drawText("first split batch row", 0, 0, .{ 255, 255, 255, 255 }, null, 0);

    _ = cli_renderer.resetSplitScrollback(1, 3);
    const before_scrollback = cli_renderer.splitScrollback;
    const before_offset = cli_renderer.renderOffset;

    const snapshots = [_]renderer.SplitSnapshot{ .{ .snapshot = snapshot, .row_columns = 32 }, .{ .snapshot = snapshot, .row_columns = 32 } };
    const split: renderer.SplitRender = .{ .snapshots = &snapshots, .pinned_render_offset = 3, .paint_footer = true, .suspended = false };
    try std.testing.expectEqual(renderer.RenderStatus.failed, try cli_renderer.renderSplitDeferred(split, false));

    try std.testing.expectEqual(before_scrollback, cli_renderer.splitScrollback);
    try std.testing.expectEqual(before_offset, cli_renderer.renderOffset);
    var spans: [4]native_span_feed.SpanInfo = undefined;
    try std.testing.expectEqual(@as(u32, 0), feed.drainSpans(&spans));
}

test "FeedBackend - skipped split repaint restores unpublished transition state" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var opts = native_span_feed.defaultOptions();
    opts.chunk_size = 32;
    opts.initial_chunks = 4;
    opts.max_bytes = 128;
    opts.growth_policy = @backingInt(native_span_feed.GrowthPolicy.block);
    opts.auto_commit_on_full = 0;
    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    var cli_renderer = try CliRenderer.createWithOptions(std.testing.allocator, 4, 2, &pools.graphemes, .{
        .link_pool = &pools.links,
        .remote_mode = .remote,
        .feed = feed,
    });
    defer feed.destroy();
    defer cli_renderer.destroyStorage();

    _ = cli_renderer.resetSplitScrollback(2, 2);
    cli_renderer.pendingSplitFooterTransition = .{ .mode = .viewport_scroll, .source_top_line = 1, .source_height = 1, .target_top_line = 2, .target_height = 1, .scroll_lines = 1 };
    const before_scrollback = cli_renderer.splitScrollback;
    const before_offset = cli_renderer.renderOffset;
    const before_transition = cli_renderer.pendingSplitFooterTransition;

    const blocker: [65]u8 = @splat('x');
    try feed.writeAtomic(&blocker);
    const repaint: renderer.SplitRender = .{ .snapshots = &.{}, .pinned_render_offset = 2, .paint_footer = true, .suspended = false };
    try std.testing.expectEqual(renderer.RenderStatus.skipped, try cli_renderer.renderSplitDeferred(repaint, true));
    try std.testing.expectEqual(before_scrollback, cli_renderer.splitScrollback);
    try std.testing.expectEqual(before_offset, cli_renderer.renderOffset);
    try std.testing.expectEqual(before_transition, cli_renderer.pendingSplitFooterTransition);
}

test "FeedBackend - skipped split repaint retries its transition" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var opts = native_span_feed.defaultOptions();
    opts.chunk_size = 32;
    opts.initial_chunks = 8;
    opts.max_bytes = 256;
    opts.growth_policy = @backingInt(native_span_feed.GrowthPolicy.block);
    opts.auto_commit_on_full = 0;
    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    var cli_renderer = try CliRenderer.createWithOptions(std.testing.allocator, 4, 2, &pools.graphemes, .{
        .link_pool = &pools.links,
        .remote_mode = .remote,
        .feed = feed,
    });
    defer feed.destroy();
    defer cli_renderer.destroyStorage();

    _ = cli_renderer.resetSplitScrollback(2, 2);
    cli_renderer.pendingSplitFooterTransition = .{ .mode = .viewport_scroll, .source_top_line = 1, .source_height = 1, .target_top_line = 2, .target_height = 1, .scroll_lines = 1 };
    const before_scrollback = cli_renderer.splitScrollback;
    const before_offset = cli_renderer.renderOffset;
    const before_transition = cli_renderer.pendingSplitFooterTransition;

    const blocker: [193]u8 = @splat('x');
    try feed.writeAtomic(&blocker);
    const repaint: renderer.SplitRender = .{ .snapshots = &.{}, .pinned_render_offset = 2, .paint_footer = true, .suspended = false };
    try std.testing.expectError(error.SplitRenderPending, cli_renderer.renderDeferred(true));
    try std.testing.expectEqual(renderer.RenderStatus.skipped, try cli_renderer.renderSplitDeferred(repaint, true));
    try std.testing.expectEqual(before_scrollback, cli_renderer.splitScrollback);
    try std.testing.expectEqual(before_offset, cli_renderer.renderOffset);
    try std.testing.expectEqual(before_transition, cli_renderer.pendingSplitFooterTransition);

    var spans: [8]native_span_feed.SpanInfo = undefined;
    var count = feed.drainSpans(&spans);
    for (spans[0..count]) |span| feed.markSpanConsumed(span);

    try std.testing.expectEqual(renderer.RenderStatus.rendered, try cli_renderer.renderSplitDeferred(repaint, true));
    try cli_renderer.completePresentation(.presented);
    count = feed.drainSpans(&spans);
    var output: [256]u8 = undefined;
    var output_len: usize = 0;
    for (spans[0..count]) |span| {
        const bytes = span.slice();
        @memcpy(output[output_len .. output_len + bytes.len], bytes);
        output_len += bytes.len;
        feed.markSpanConsumed(span);
    }
    try std.testing.expect(std.mem.find(u8, output[0..output_len], "\x1b[1T") != null);
}

test "FeedBackend - skipped frame keeps the published hit grid and clears its paint" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var opts = native_span_feed.defaultOptions();
    opts.chunk_size = 32;
    opts.initial_chunks = 8;
    opts.max_bytes = 256;
    opts.growth_policy = @backingInt(native_span_feed.GrowthPolicy.block);
    opts.auto_commit_on_full = 0;
    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    var cli_renderer = try CliRenderer.createWithOptions(std.testing.allocator, 1, 1, &pools.graphemes, .{
        .link_pool = &pools.links,
        .remote_mode = .remote,
        .feed = feed,
    });
    defer feed.destroy();
    defer cli_renderer.destroyStorage();

    cli_renderer.scene_work = .{ .work_frame_id = 11 };
    try std.testing.expectEqual(renderer.RenderStatus.rendered, try renderPresented(cli_renderer, true, discard));
    try std.testing.expectEqual(@as(u64, 11), cli_renderer.presented_hits_frame);
    const cleared_char = cli_renderer.getNextBuffer().buffer.char[0];

    cli_renderer.scene_work = .{ .work_frame_id = 22 };
    try cli_renderer.getNextBuffer().drawText("X", 0, 0, ansi.rgbColor(255, 255, 255, 255), null, 0);
    const blocker: [193]u8 = @splat('x');
    try feed.writeAtomic(&blocker);
    try std.testing.expectEqual(renderer.RenderStatus.skipped, try renderPresented(cli_renderer, true, discard));
    try std.testing.expectEqual(@as(u64, 11), cli_renderer.presented_hits_frame);
    try std.testing.expectEqual(cleared_char, cli_renderer.getNextBuffer().buffer.char[0]);

    cli_renderer.scene_work = .{ .work_frame_id = 22 };
    try std.testing.expectEqual(renderer.RenderStatus.rendered, try renderPresented(cli_renderer, true, discard));
    try std.testing.expectEqual(@as(u64, 22), cli_renderer.presented_hits_frame);
}

test "FeedBackend - skipped frame retries unsent terminal controls" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var opts = native_span_feed.defaultOptions();
    opts.chunk_size = 32;
    opts.initial_chunks = 4;
    opts.max_bytes = 128;
    opts.growth_policy = @backingInt(native_span_feed.GrowthPolicy.block);
    opts.auto_commit_on_full = 0;
    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    var cli_renderer = try CliRenderer.createWithOptions(std.testing.allocator, 1, 1, &pools.graphemes, .{
        .link_pool = &pools.links,
        .remote_mode = .remote,
        .feed = feed,
    });
    defer feed.destroy();
    defer cli_renderer.destroyStorage();

    cli_renderer.terminal.setCursorPosition(1, 1, true);
    try std.testing.expectEqual(renderer.RenderStatus.rendered, try renderPresented(cli_renderer, false, discard));

    cli_renderer.terminal.setCursorColor(ansi.rgbColor(0x12, 0x34, 0x56, 255));
    cli_renderer.terminal.setCursorStyle(.line, false);
    cli_renderer.terminal.setMousePointerStyle(.pointer);

    const blocker: [65]u8 = @splat('x');
    try feed.writeAtomic(&blocker);
    try std.testing.expectEqual(renderer.RenderStatus.skipped, try renderPresented(cli_renderer, false, discard));

    var storage: [256]u8 = undefined;
    var sink = FixedSink.init(&storage);
    try std.testing.expectEqual(renderer.RenderStatus.rendered, try renderPresented(cli_renderer, false, &sink));
    const output = sink.bytes();
    try std.testing.expect(std.mem.find(u8, output, "\x1b]12;#123456\x07") != null);
    try std.testing.expect(std.mem.find(u8, output, ansi.ANSI.cursorLine) != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b]22;pointer\x1b\\") != null);
}

// 413: a frame publishes the image uploads that fit it, in placement order, and later frames send
// the rest; a frame that fits is published byte for byte, and an upload larger than a frame draws
// as blocks. The limit is the first frame's measured cells plus the uploads in `fit`, plus `delta`.
test "FeedBackend - image uploads wait for the frames they fit" {
    const Row = struct {
        name: []const u8,
        protocol: image.RenderProtocol,
        sizes: []const u32,
        fit: u8,
        delta: i64 = 0,
        cells: bool = true,
        text: bool = false,
        resize: bool = false,
        changing: bool = false,
        // Noise rows drawn on frame 1 only; the pixel size growing by a pixel on frames 1 and 2.
        text_rows: u32 = 0,
        growing: bool = false,
        overlap: bool = false,
        // A Kitty transport (`kitty_transport.Mode`), a solid second image, the first image removed
        // from that frame on, and a transport change after the last frame that must retry the image.
        transport: u32 = 0,
        solid_second: bool = false,
        remove_first_at: ?u32 = null,
        retransport: bool = false,
        // A pixel size for every image, a crop of its middle 16x16, and text the last uploading
        // frame sends.
        pixels: ?u32 = null,
        crop: bool = false,
        sends: ?[]const u8 = null,
        // The images move a cell right from this frame on.
        move_at: ?u32 = null,
        // The 32x32 image: compressible, noise, noise as a PNG, or two rows of opaque noise
        // repeated, as a PNG (small as a PNG, large as a Sixel).
        big: enum { pixels, noise, png, rows_png } = .pixels,
        // From this frame on, the first image is 20x20 noise at a new handle. Before `opaque_at`,
        // the images are half transparent. From `kitty_at`, they are Kitty and a pixel larger.
        swap_at: ?u32 = null,
        opaque_at: ?u32 = null,
        kitty_at: ?u32 = null,
        uploads: []const []const u32,
        blocks: u32 = 0,

        fn kittyFrom(row: @This(), frame: usize) bool {
            return row.kitty_at != null and frame >= row.kitty_at.?;
        }
    };
    const rows = [_]Row{
        .{ .name = "kitty fits", .protocol = .kitty, .sizes = &.{ 16, 16 }, .fit = 0b11, .uploads = &.{&.{ 1, 2 }} },
        .{ .name = "kitty one byte over", .protocol = .kitty, .sizes = &.{ 16, 16 }, .fit = 0b11, .delta = -1, .uploads = &.{ &.{1}, &.{2} } },
        .{ .name = "kitty two of three", .protocol = .kitty, .sizes = &.{ 16, 16, 16 }, .fit = 0b011, .uploads = &.{ &.{ 1, 2 }, &.{3} } },
        .{ .name = "kitty cells first", .protocol = .kitty, .sizes = &.{ 16, 16 }, .text = true, .fit = 0b01, .delta = -1, .uploads = &.{ &.{}, &.{ 1, 2 } } },
        .{ .name = "kitty one a frame in order", .protocol = .kitty, .sizes = &.{ 16, 16, 16, 16 }, .fit = 0b0001, .uploads = &.{ &.{1}, &.{2}, &.{3}, &.{4} } },
        .{ .name = "kitty resize while one waits", .protocol = .kitty, .sizes = &.{ 16, 16, 16 }, .fit = 0b011, .resize = true, .uploads = &.{ &.{ 1, 2 }, &.{3} } },
        .{ .name = "kitty changing image does not starve", .protocol = .kitty, .sizes = &.{ 16, 16, 16 }, .fit = 0b001, .changing = true, .uploads = &.{ &.{1}, &.{2}, &.{1}, &.{3} } },
        .{ .name = "kitty alone over a frame", .protocol = .kitty, .sizes = &.{16}, .cells = false, .fit = 0b1, .delta = -1, .retransport = true, .uploads = &.{&.{}}, .blocks = 1 },
        .{ .name = "kitty alone over a frame, size changes twice", .protocol = .kitty, .sizes = &.{16}, .cells = false, .fit = 0b1, .delta = -1, .growing = true, .uploads = &.{ &.{}, &.{}, &.{}, &.{} }, .blocks = 1 },
        // 419: the full 32x32 image is over the frame, a copy at the placement's 24x24 pixels fits.
        // The copy follows size changes, and moved later, it is placed again, not sent again.
        .{ .name = "kitty copy at the placement fits", .protocol = .kitty, .sizes = &.{32}, .pixels = 24, .growing = true, .fit = 0, .delta = 3500, .sends = "f=32,s=26,v=26,", .move_at = 3, .uploads = &.{ &.{}, &.{1}, &.{1}, &.{} } },
        // Another image or opacity, or a copy by the 4x rule that grows out of it, tries the full
        // image again.
        .{ .name = "kitty copy by the rule grows out of it", .protocol = .kitty, .sizes = &.{32}, .pixels = 16, .growing = true, .fit = 0b1, .delta = 6000, .sends = "f=32,s=32,v=32,", .uploads = &.{ &.{1}, &.{1} } },
        .{ .name = "kitty copy by the rule waits, then grows out of it", .protocol = .kitty, .sizes = &.{32}, .pixels = 16, .growing = true, .text = true, .fit = 0, .delta = 500, .sends = "f=32,s=32,v=32,", .uploads = &.{ &.{}, &.{1} } },
        .{ .name = "kitty copy of a crop, then a crop that fits", .protocol = .kitty, .sizes = &.{32}, .pixels = 16, .crop = true, .swap_at = 2, .fit = 0, .delta = 3500, .sends = "f=32,s=20,v=20,", .uploads = &.{ &.{}, &.{1}, &.{1} } },
        .{ .name = "kitty copy at half opacity, then the PNG", .protocol = .kitty, .sizes = &.{32}, .pixels = 24, .big = .rows_png, .opaque_at = 2, .fit = 0, .delta = 3500, .sends = "f=100,", .uploads = &.{ &.{}, &.{1}, &.{1} } },
        // A copy that waits keeps its image under any transport or source.
        .{ .name = "kitty zlib copy waits behind a changing image", .protocol = .kitty, .sizes = &.{ 16, 32 }, .pixels = 24, .big = .noise, .changing = true, .transport = 1, .fit = 0b01, .delta = 2000, .uploads = &.{ &.{1}, &.{2}, &.{1}, &.{1} } },
        .{ .name = "kitty PNG copy waits behind a frame of cells", .protocol = .kitty, .sizes = &.{32}, .pixels = 24, .big = .png, .text_rows = 2, .fit = 0, .delta = 3500, .uploads = &.{ &.{}, &.{}, &.{1} } },
        .{ .name = "kitty zlib copy alone just over a frame", .protocol = .kitty, .sizes = &.{32}, .pixels = 24, .big = .noise, .transport = 1, .cells = false, .fit = 0, .delta = 3120, .uploads = &.{ &.{}, &.{}, &.{} }, .blocks = 1 },
        .{ .name = "kitty alone without a pixel size", .protocol = .kitty, .sizes = &.{32}, .pixels = 0, .cells = false, .fit = 0b1, .delta = -1, .uploads = &.{&.{}}, .blocks = 1 },
        .{ .name = "kitty waits behind a frame of cells", .protocol = .kitty, .sizes = &.{ 16, 16, 16 }, .fit = 0b011, .text_rows = 2, .uploads = &.{ &.{ 1, 2 }, &.{}, &.{3} } },
        .{ .name = "kitty file transport cells first", .protocol = .kitty, .sizes = &.{ 16, 16 }, .text = true, .fit = 0b01, .delta = -1, .transport = 2, .uploads = &.{ &.{}, &.{ 1, 2 } } },
        .{ .name = "kitty zlib neighbor of a removed oversize image", .protocol = .kitty, .sizes = &.{ 16, 16 }, .fit = 0b10, .transport = 1, .solid_second = true, .remove_first_at = 2, .uploads = &.{ &.{2}, &.{}, &.{1} } },
        .{ .name = "sixel fits", .protocol = .sixel, .sizes = &.{ 16, 16 }, .fit = 0b11, .uploads = &.{&.{ 1, 2 }} },
        .{ .name = "sixel one byte over", .protocol = .sixel, .sizes = &.{ 16, 16 }, .fit = 0b11, .delta = -1, .uploads = &.{ &.{1}, &.{2} } },
        .{ .name = "sixel later waits behind a waiting one", .protocol = .sixel, .sizes = &.{ 16, 32, 16 }, .fit = 0b101, .uploads = &.{ &.{1}, &.{}, &.{3} }, .blocks = 1 },
        .{ .name = "sixel waits over an overlapped one", .protocol = .sixel, .sizes = &.{ 16, 16 }, .fit = 0b01, .overlap = true, .uploads = &.{ &.{1}, &.{2} } },
        // A smaller placement than the image: Sixel never takes the Kitty retry, and its oversize
        // mark, or the blocks after it, never stand for a full Kitty image that was too large.
        .{ .name = "sixel alone over a frame", .protocol = .sixel, .sizes = &.{32}, .pixels = 24, .cells = false, .fit = 0b1, .delta = -1, .uploads = &.{&.{}}, .blocks = 1 },
        .{ .name = "sixel over a frame, then the Kitty PNG", .protocol = .sixel, .sizes = &.{32}, .pixels = 24, .big = .rows_png, .kitty_at = 1, .cells = false, .fit = 0b1, .delta = -1, .sends = "f=100,", .uploads = &.{ &.{}, &.{1} } },
        .{ .name = "sixel over a frame, blocks, then the Kitty PNG", .protocol = .sixel, .sizes = &.{32}, .pixels = 24, .big = .rows_png, .kitty_at = 2, .cells = false, .fit = 0b1, .delta = -1, .sends = "f=100,", .uploads = &.{ &.{}, &.{}, &.{1} } },
    };
    const Scene = struct {
        fn draw(cli: *CliRenderer, images: []const *image.Image, swap: *image.Image, row: Row, frame: u32) !void {
            const next = cli.getNextBuffer();
            const noisy: usize = if (row.text) next.height else if (frame == 1) row.text_rows else 0;
            for (next.height - noisy..next.height) |y| for (0..next.width) |x| {
                const shade: u8 = @truncate(x * 7 + y * 31);
                next.set(@intCast(x), @intCast(y), .{ .char = 'x', .fg = ansi.rgbColor(shade, 255 - shade, 9, 255), .bg = ansi.rgbColor(9, shade, 255 - shade, 255), .attributes = 0 });
            };
            if (row.opaque_at != null and frame < row.opaque_at.?) try next.pushOpacity(0.5);
            defer if (row.opaque_at != null and frame < row.opaque_at.?) next.popOpacity();
            for (images, row.sizes, 0..) |first, first_size, index| {
                if (index == 0 and row.remove_first_at != null and frame >= row.remove_first_at.?) continue;
                const swapped = index == 0 and row.swap_at != null and frame >= row.swap_at.?;
                const value = if (swapped) swap else first;
                const size = if (swapped) value.width() else first_size;
                const handle: u32 = @intCast(index + 1 + if (row.changing and index == 0) frame * 16 else if (swapped) @as(u32, 64) else 0);
                const pixels = (row.pixels orelse size) + @intFromBool(row.kittyFrom(frame)) + if (row.growing) @min(frame, 2) else 0;
                const crop: u32 = if (row.crop) (size - 16) / 2 else 0;
                const moved: i32 = if (row.move_at != null and frame >= row.move_at.?) 1 else 0;
                _ = try next.drawImage(value, handle, moved + if (row.overlap) 0 else @as(i32, @intCast(index * 9)), 0, size / 4, size / 8, pixels, pixels, crop, crop, size - 2 * crop, size - 2 * crop, if (row.kittyFrom(frame)) .kitty else row.protocol);
            }
        }
    };
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    var pixels: [32 * 32 * 4]u8 = undefined;
    for (&pixels, 0..) |*byte, index| byte.* = @truncate((index *% 2654435761) >> 11);
    const small = try image.createFromRgba(std.testing.allocator, &pixels, 16, 16, 16 * 4);
    defer small.deinit();
    const big = try image.createFromRgba(std.testing.allocator, &pixels, 32, 32, 32 * 4);
    defer big.deinit();
    const solid = try image.createFromRgba(std.testing.allocator, utils.repeat(u8, &.{ 200, 30, 30, 255 }, 16 * 16), 16, 16, 16 * 4);
    defer solid.deinit();
    var random = std.Random.DefaultPrng.init(413);
    random.random().bytes(pixels[0 .. 16 * 16 * 4]);
    const noisy = try image.createFromRgba(std.testing.allocator, pixels[0 .. 16 * 16 * 4], 16, 16, 16 * 4);
    defer noisy.deinit();
    random.random().bytes(&pixels);
    const twenty = try image.createFromRgba(std.testing.allocator, pixels[0 .. 20 * 20 * 4], 20, 20, 20 * 4);
    defer twenty.deinit();
    var bigs = [_]*image.Image{ big, undefined, undefined, undefined };
    for (bigs[1..], 1..) |*value, kind| {
        if (kind == 3) for (0..32 * 32) |index| {
            pixels[index * 4 ..][0..4].* = .{ pixels[index % 64 * 4], pixels[index % 64 * 4 + 1], pixels[index % 64 * 4 + 2], 255 };
        };
        value.* = try image.createFromRgba(std.testing.allocator, &pixels, 32, 32, 32 * 4);
        if (kind >= 2) _ = try value.*.ensureEncodedPng();
    }
    defer for (bigs[1..]) |value| value.deinit();

    for (rows) |row| {
        errdefer std.debug.print("row: {s}\n", .{row.name});
        var drawn: [4]*image.Image = undefined;
        if (row.transport == 2 and @import("builtin").os.tag == .windows) continue;
        for (row.sizes, 0..) |size, index| drawn[index] = if (size == 32) bigs[@backingInt(row.big)] else if (row.solid_second) (if (index == 1) solid else noisy) else small;
        // Measure the first frame and each upload without a limit.
        var roomy = try TestRenderer.create(std.testing.allocator, 40, 6, &pools.graphemes, &pools.links);
        defer roomy.deinit();
        roomy.renderer.terminal.caps.sixel = true;
        for ([_]*CliRenderer{roomy.renderer}) |target| {
            _ = target.setKittyImageTransport(row.transport);
            if (row.transport == 2) target.kittyTransport.file_state = .ready;
        }
        try Scene.draw(roomy.renderer, drawn[0..row.sizes.len], twenty, row, 0);
        try std.testing.expectEqual(renderer.RenderStatus.rendered, roomy.render(false));
        var cells: i64 = @intCast(roomy.lastOutput().len);
        var limit: i64 = row.delta;
        for (roomy.renderer.backend.uploads.items) |upload| {
            const bytes: i64 = @intCast(upload.end - upload.start);
            cells -= bytes;
            if (row.fit & (@as(u8, 1) << @intCast(upload.placement_id - 1)) != 0) limit += bytes;
        }
        if (row.cells) limit += cells;

        var opts = native_span_feed.defaultOptions();
        opts.chunk_size = 1;
        opts.max_bytes = @intCast(limit);
        opts.span_queue_capacity = @intCast(limit);
        opts.auto_commit_on_full = 0;
        const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
        defer feed.destroy();
        const cli = try CliRenderer.createWithOptions(std.testing.allocator, 40, 6, &pools.graphemes, .{ .link_pool = &pools.links, .feed = feed, .env_map = roomy.env_map });
        defer cli.destroyStorage();
        cli.terminal.caps.sixel = true;
        cli.imageIdSalt = roomy.renderer.imageIdSalt;
        _ = cli.setKittyImageTransport(row.transport);
        if (row.transport == 2) cli.kittyTransport.file_state = .ready;
        var output: std.ArrayListUnmanaged(u8) = .empty;
        defer output.deinit(std.testing.allocator);
        const Sink = struct {
            list: *std.ArrayListUnmanaged(u8),
            pub fn write(self: @This(), data: []const u8) void {
                self.list.appendSlice(std.testing.allocator, data) catch unreachable;
            }
        };
        var sent = row.sends == null;
        // A final frame sends nothing, unless an image keeps changing.
        for (0..row.uploads.len + @intFromBool(!row.changing)) |frame| {
            if (row.resize and frame == 1) try cli.resize(41, 6);
            try Scene.draw(cli, drawn[0..row.sizes.len], twenty, row, @intCast(frame));
            output.clearRetainingCapacity();
            try std.testing.expectEqual(renderer.RenderStatus.rendered, try renderPresented(cli, false, Sink{ .list = &output }));
            // Uploads that cannot join the kept ones are cut while staging, so staging stays bounded.
            try std.testing.expect(cli.backend.frameBytes.capacity <= 2 * limit);
            var kept: [4]u32 = undefined;
            var count: usize = 0;
            for (cli.backend.uploads.items) |upload| if (upload.state == .kept and upload.end > upload.start) {
                kept[count] = upload.placement_id;
                count += 1;
            };
            const expected: []const u32 = if (frame < row.uploads.len) row.uploads[frame] else &.{};
            try std.testing.expectEqualSlices(u32, expected, kept[0..count]);
            const escapes = std.mem.count(u8, output.items, if (row.protocol == .kitty or row.kittyFrom(frame)) "\x1b_Ga=t" else "\x1bP");
            try std.testing.expectEqual(count, escapes);
            if (count != 0) sent = std.mem.find(u8, output.items, row.sends orelse "") != null;
            if (frame == 0 and count == row.sizes.len) try std.testing.expectEqualStrings(roomy.lastOutput(), output.items);
            // Trimming uploads keeps the frame's own controls.
            if (output.items.len != 0) try std.testing.expect(std.mem.find(u8, output.items, ansi.ANSI.hideCursor) != null);
            // A frame keeps nothing it left out: a file upload's lease goes too.
            if (frame == 0 and row.transport == 2) try std.testing.expectEqual(@as(u32, 0), cli.kittyTransport.pendingCount());
            // An image alone over a frame asks for the frame that draws it as blocks.
            if (frame == 0 and row.blocks != 0 and row.sizes.len == 1) try std.testing.expectEqual(@as(u32, 1), cli.imageUploadsPending());
            // Adaptive image sizes see a frame that left uploads out as the costliest.
            try std.testing.expectEqual(cli.imageUploadsPending() != 0, cli.imageFrameCostUs() == std.math.maxInt(u32));
        }
        if (!row.changing) try std.testing.expectEqual(@as(u32, 0), cli.imageUploadsPending());
        try std.testing.expect(sent);
        var blocks: u32 = 0;
        for (cli.currentImages.items) |committed| blocks += @intFromBool(committed.protocol == .fallback);
        try std.testing.expectEqual(row.blocks, blocks);
        if (row.retransport) {
            // A new transport may send the image: it is tried again.
            _ = cli.setKittyImageTransport(1);
            try Scene.draw(cli, drawn[0..row.sizes.len], twenty, row, @intCast(row.uploads.len + 1));
            _ = try renderPresented(cli, false, discard);
            try std.testing.expectEqual(@as(usize, 1), cli.backend.uploads.items.len);
        }
    }
}

// 413: a frame whose cells or scrollback commit exceed one frame of output fails with its full size,
// once per content: the same frame again fails without encoding, and a changed one is tried again.
// Scrollback frames are not held, because the host drops the commit.
test "FeedBackend - a frame larger than one frame of output is dropped once per content" {
    // `limit`: the frame's size, one byte less, half, or between a full repaint of content 1 and its
    // diff from content 0 (`checker`: content 0 uniform, content 1 a checkerboard of characters).
    // `images`: a Sixel and a blocks image over the text; the Sixel upload is left out of the size,
    // and the blocks cells hash like their placement. `overlay`: the debug overlay on an 80x24 screen.
    // Steps: draw content N (`d`), a scrollback commit over it (`c`), a blank frame that fits (`b`),
    // or a draw skipped behind queued output (`s`); then the status and the dropped count.
    const Step = struct { do: u8, seed: u32 = 0, status: renderer.RenderStatus, dropped: u32 };
    const Row = struct {
        name: []const u8,
        split: bool = false,
        limit: enum { size, under, half, between },
        images: bool = false,
        overlay: bool = false,
        checker: bool = false,
        steps: []const Step,
    };
    const held: []const Step = &.{ .{ .do = 'd', .status = .failed, .dropped = 1 }, .{ .do = 'd', .status = .failed, .dropped = 1 }, .{ .do = 'd', .seed = 1, .status = .failed, .dropped = 2 } };
    const rows = [_]Row{
        .{ .name = "text fits", .limit = .size, .steps = &.{.{ .do = 'd', .status = .rendered, .dropped = 0 }} },
        // One byte over, the last content fits as a diff after a frame that fits.
        .{ .name = "text one byte over", .limit = .under, .steps = held ++ &[_]Step{ .{ .do = 'b', .status = .rendered, .dropped = 2 }, .{ .do = 'd', .seed = 1, .status = .rendered, .dropped = 2 } } },
        .{ .name = "text twice the limit", .limit = .half, .steps = held },
        .{ .name = "text held across a skipped frame", .limit = .half, .steps = &.{ .{ .do = 'd', .status = .failed, .dropped = 1 }, .{ .do = 's', .seed = 1, .status = .skipped, .dropped = 1 }, .{ .do = 'd', .status = .failed, .dropped = 1 } } },
        .{ .name = "text held across a scrollback commit", .limit = .half, .steps = &.{ .{ .do = 'd', .status = .failed, .dropped = 1 }, .{ .do = 'c', .status = .failed, .dropped = 2 }, .{ .do = 'd', .status = .failed, .dropped = 2 } } },
        .{ .name = "text and images twice the limit", .limit = .half, .images = true, .steps = held },
        .{ .name = "text with the debug overlay", .limit = .half, .overlay = true, .steps = held },
        // A diff larger than the full repaint is not held: the full repaint is tried and fits.
        .{ .name = "a diff larger than its full repaint", .limit = .between, .checker = true, .steps = &.{ .{ .do = 'd', .status = .rendered, .dropped = 0 }, .{ .do = 'd', .seed = 1, .status = .failed, .dropped = 0 }, .{ .do = 'd', .seed = 1, .status = .rendered, .dropped = 0 } } },
        .{ .name = "scrollback fits", .split = true, .limit = .size, .steps = &.{.{ .do = 'd', .status = .rendered, .dropped = 0 }} },
        .{ .name = "scrollback one byte over", .split = true, .limit = .under, .steps = &.{ .{ .do = 'd', .status = .failed, .dropped = 1 }, .{ .do = 'd', .status = .failed, .dropped = 2 }, .{ .do = 'd', .seed = 1, .status = .failed, .dropped = 3 } } },
        .{ .name = "scrollback twice the limit", .split = true, .limit = .half, .steps = &.{ .{ .do = 'd', .status = .failed, .dropped = 1 }, .{ .do = 'd', .status = .failed, .dropped = 2 }, .{ .do = 'd', .seed = 1, .status = .failed, .dropped = 3 } } },
    };
    var pixels: [16 * 16 * 4]u8 = undefined;
    for (&pixels, 0..) |*byte, index| byte.* = @truncate((index *% 2654435761) >> 11);
    const picture = try image.createFromRgba(std.testing.allocator, &pixels, 16, 16, 16 * 4);
    defer picture.deinit();
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    var snapshot = try OptimizedBuffer.init(std.testing.allocator, 40, 8, .{ .link_pool = &pools.links, .pool = &pools.graphemes, .width_method = .unicode, .respectAlpha = false });
    defer snapshot.deinit();
    const Scene = struct {
        fn noise(target: *OptimizedBuffer, seed: u32) void {
            for (0..target.height) |y| for (0..target.width) |x| {
                const shade: u8 = @truncate(x * 7 + y * 31 + seed);
                target.set(@intCast(x), @intCast(y), .{ .char = 'x', .fg = ansi.rgbColor(shade, 255 - shade, 9, 255), .bg = ansi.rgbColor(9, shade, 255 - shade, 255), .attributes = 0 });
            };
        }
        fn render(cli: *CliRenderer, row: Row, source: *image.Image, commit: *OptimizedBuffer, seed: u32, split: bool) !renderer.RenderStatus {
            cli.terminal.caps.sixel = true;
            const next = cli.getNextBuffer();
            if (row.checker) {
                for (0..next.height) |y| for (0..next.width) |x| {
                    const char: u32 = if (seed == 1 and (x + y) % 2 == 0) 'o' else 'x';
                    next.set(@intCast(x), @intCast(y), .{ .char = char, .fg = ansi.rgbColor(200, 200, 200, 255), .bg = ansi.rgbColor(9, 9, 9, 255), .attributes = 0 });
                };
            } else if (!row.split) noise(next, if (row.images) 0 else seed);
            // With images, a new seed changes only their source: a source change is a content change.
            if (row.images) for ([_]image.RenderProtocol{ .sixel, .blocks }, 0..) |protocol, index| {
                _ = try next.drawImage(source, @intCast(index + 1 + seed * 16), @intCast(index * 10), 1, 4, 2, 16, 16, 0, 0, 16, 16, protocol);
            };
            const snapshots = [_]renderer.SplitSnapshot{.{ .snapshot = commit, .row_columns = 40, .start_on_new_line = true }};
            return if (split)
                try cli.renderSplitDeferred(.{ .snapshots = &snapshots, .pinned_render_offset = 2, .paint_footer = true, .suspended = false }, false)
            else
                try cli.renderDeferred(false);
        }
        fn present(cli: *CliRenderer, feed: *native_span_feed.Stream, status: renderer.RenderStatus) !void {
            test_renderer_mod.deliverFeed(feed, discard);
            if (status == .rendered) try cli.completePresentation(.presented);
        }
    };
    Scene.noise(snapshot, 0);
    for (rows) |row| {
        errdefer std.debug.print("row: {s}\n", .{row.name});
        const width: u32 = if (row.overlay) 80 else 40;
        const height: u32 = if (row.overlay) 24 else 6;
        var roomy = try TestRenderer.create(std.testing.allocator, width, height, &pools.graphemes, &pools.links);
        defer roomy.deinit();
        roomy.renderer.setDebugOverlay(row.overlay, .topLeft);
        const measured = if (row.split) roomy.commitSplit(snapshot, 40, true, true, 2, false) else roomy.present(Scene.render(roomy.renderer, row, picture, snapshot, 0, false));
        try std.testing.expectEqual(renderer.RenderStatus.rendered, measured);
        var size = roomy.lastOutput().len;
        for (roomy.renderer.backend.uploads.items) |upload| size -= upload.end - upload.start;
        var limit = switch (row.limit) {
            .size, .between => size,
            .under => size - 1,
            .half => size / 2,
        };
        if (row.limit == .between) {
            try std.testing.expectEqual(renderer.RenderStatus.rendered, roomy.present(Scene.render(roomy.renderer, row, picture, snapshot, 1, false)));
            const diff = roomy.lastOutput().len;
            var fresh = try TestRenderer.create(std.testing.allocator, width, height, &pools.graphemes, &pools.links);
            defer fresh.deinit();
            try std.testing.expectEqual(renderer.RenderStatus.rendered, fresh.present(Scene.render(fresh.renderer, row, picture, snapshot, 1, false)));
            const full = fresh.lastOutput().len;
            try std.testing.expect(full < diff);
            limit = (full + diff) / 2;
        }

        var opts = native_span_feed.defaultOptions();
        opts.chunk_size = 1;
        opts.max_bytes = limit;
        opts.span_queue_capacity = @intCast(limit);
        opts.auto_commit_on_full = 0;
        const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
        defer feed.destroy();
        const cli = try CliRenderer.createWithOptions(std.testing.allocator, width, height, &pools.graphemes, .{ .link_pool = &pools.links, .feed = feed, .env_map = roomy.env_map });
        defer cli.destroyStorage();
        cli.setDebugOverlay(row.overlay, .topLeft);
        for (row.steps, 0..) |step, index| {
            const status = switch (step.do) {
                'd', 'c' => try Scene.render(cli, row, picture, snapshot, step.seed, row.split or step.do == 'c'),
                's' => blk: {
                    const blocker = try std.testing.allocator.alloc(u8, limit);
                    defer std.testing.allocator.free(blocker);
                    @memset(blocker, 'x');
                    try feed.writeAtomic(blocker);
                    break :blk try Scene.render(cli, row, picture, snapshot, step.seed, false);
                },
                else => blk: {
                    cli.getNextBuffer().clear(ansi.rgbColor(0, 0, 0, 255), null);
                    break :blk try cli.renderDeferred(false);
                },
            };
            try Scene.present(cli, feed, status);
            try std.testing.expectEqual(step.status, status);
            try std.testing.expectEqual(step.dropped, cli.dropped_frames);
            // Every failure here is a size drop and says so, held or not.
            try std.testing.expectEqual(status == .failed, cli.dropped_frame_bytes != 0);
            if (index == 0 and status == .failed) try std.testing.expectEqual(size, cli.dropped_frame_bytes);
        }
    }
}

test "FeedBackend - writeOut publishes nothing when the queue is blocked" {
    var opts = native_span_feed.defaultOptions();
    opts.chunk_size = 64;
    opts.initial_chunks = 2;
    opts.span_queue_capacity = 1;
    opts.auto_commit_on_full = 0;
    opts.growth_policy = @backingInt(native_span_feed.GrowthPolicy.block);

    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    defer feed.destroy();

    var backend = renderer.FeedBackend.createWithIo(io, feed);

    try feed.write("queued");
    try feed.commit();
    try std.testing.expect(backend.shouldSkipFrame());

    backend.writeOut("shutdown");
    try std.testing.expect(!feed.hasPendingBytes());

    var span_out: [4]native_span_feed.SpanInfo = undefined;
    var count = feed.drainSpans(&span_out);
    try std.testing.expectEqual(@as(u32, 1), count);
    feed.markSpanConsumed(span_out[0]);

    try std.testing.expectEqual(.ok, backend.prepareFrame());
    count = feed.drainSpans(&span_out);
    try std.testing.expectEqual(@as(u32, 0), count);
}

test "two renderers have independent output" {
    var link_pool_storage = link.LinkPool.init(std.testing.allocator);
    defer link_pool_storage.deinit();
    const link_pool = &link_pool_storage;
    // Independent output buffers prevent concurrent renderers from clobbering
    // each other's output.
    var pool_storage = gp.GraphemePool.init(std.testing.allocator);
    defer pool_storage.deinit();
    const pool = &pool_storage;

    var test_r1 = try TestRenderer.create(std.testing.allocator, 80, 24, pool, link_pool);
    defer test_r1.deinit();
    const r1 = test_r1.renderer;
    var test_r2 = try TestRenderer.create(std.testing.allocator, 80, 24, pool, link_pool);
    defer test_r2.deinit();
    const r2 = test_r2.renderer;

    const fg = RGBA{ 1.0, 1.0, 1.0, 1.0 };
    const bg = RGBA{ 0.0, 0.0, 0.0, 1.0 };

    const b1 = r1.getNextBuffer();
    try b1.drawText("AAA", 0, 0, fg, bg, 0);
    _ = test_r1.render(false);

    const b2 = r2.getNextBuffer();
    try b2.drawText("BBB", 0, 0, fg, bg, 0);
    _ = test_r2.render(false);

    const out1 = test_r1.lastOutput();
    const out2 = test_r2.lastOutput();

    try std.testing.expect(std.mem.find(u8, out1, "AAA") != null);
    try std.testing.expect(std.mem.find(u8, out1, "BBB") == null);
    try std.testing.expect(std.mem.find(u8, out2, "BBB") != null);
    try std.testing.expect(std.mem.find(u8, out2, "AAA") == null);
}

test "renderer scales kitty transmission alpha by placement opacity" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 2, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 200, 100, 50, 255 }, 1, 1, 4);
    defer value.deinit();
    const value_handle: u32 = 1;
    test_renderer.renderer.terminal.caps.kitty_graphics = true;

    var next = test_renderer.renderer.getNextBuffer();
    try next.pushOpacity(0.5);
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));
    next.popOpacity();
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    const output = test_renderer.memory.lastWrite();

    // Translucent placements transmit RGBA with the alpha channel scaled so the
    // terminal composites the fade; colors are left for kitty to blend.
    try std.testing.expect(std.mem.find(u8, output, "f=32") != null);
    const transmit_start = std.mem.find(u8, output, "\x1b_Ga=t").?;
    const transmit_end = std.mem.findPos(u8, output, transmit_start, "\x1b\\").? + 2;
    const transmitted = try terminal_image_test.decodeKittyChunks(output[transmit_start..transmit_end]);
    defer std.testing.allocator.free(transmitted);
    try std.testing.expectEqual(@as(usize, 4), transmitted.len);
    try std.testing.expectEqual(@as(u8, 200), transmitted[0]);
    try std.testing.expectEqual(@as(u8, 100), transmitted[1]);
    try std.testing.expectEqual(@as(u8, 50), transmitted[2]);
    try std.testing.expect(@abs(@as(i16, transmitted[3]) - 128) <= 1);

    // Opacity changes retransmit under the same kitty id: delete then new data.
    next = test_renderer.renderer.getNextBuffer();
    try next.pushOpacity(0.25);
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));
    next.popOpacity();
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(false));
    const second = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, second, "a=d,d=I") != null);
    const second_start = std.mem.find(u8, second, "\x1b_Ga=t").?;
    const second_end = std.mem.findPos(u8, second, second_start, "\x1b\\").? + 2;
    const retransmitted = try terminal_image_test.decodeKittyChunks(second[second_start..second_end]);
    defer std.testing.allocator.free(retransmitted);
    try std.testing.expect(@abs(@as(i16, retransmitted[3]) - 64) <= 1);
}

test "renderer bounds sixel cache entries and evicts least recently used payloads" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 2, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    test_renderer.renderer.terminal.caps.sixel = true;

    const image_count = 260;
    var images: [image_count]*image.Image = undefined;
    var initialized: usize = 0;
    defer for (images[0..initialized]) |value| value.deinit();
    for (0..image_count) |index| {
        const shade: u8 = @intCast(index % 256);
        images[index] = try image.createFromRgba(std.testing.allocator, &[_]u8{ shade, 255 - shade, @intCast((index / 4) % 256), 255 }, 1, 1, 4);
        initialized += 1;
    }

    var next = test_renderer.renderer.getNextBuffer();
    for (0..image_count) |index| {
        const image_handle: u32 = @intCast(index + 1);
        try std.testing.expect(try next.drawImage(images[index], image_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    }
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    try std.testing.expectEqual(@as(u64, image_count), test_renderer.renderer.sixelCacheMisses);
    try std.testing.expect(test_renderer.renderer.sixelCache.count() <= 256);
    try std.testing.expect(test_renderer.renderer.sixelCacheBytes > 0);

    // The first payloads were the least recently used and must have been evicted.
    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(images[0], 1, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    try std.testing.expectEqual(@as(u64, image_count + 1), test_renderer.renderer.sixelCacheMisses);

    // A recently used payload is still cached.
    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(images[image_count - 1], image_count, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    try std.testing.expectEqual(@as(u64, 1), test_renderer.renderer.sixelCacheHits);
}

test "renderer treats fully transparent sixel placements as empty without failing" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 2, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 0 }, 1, 1, 4);
    defer value.deinit();
    const value_handle: u32 = 1;
    test_renderer.renderer.terminal.caps.sixel = true;

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0") == null);
    try std.testing.expect(!test_renderer.renderer.imageRenderFailed);
    try std.testing.expect(!test_renderer.renderer.force_full_repaint);

    // The empty payload is cached; the placement stays a cheap no-op.
    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    try std.testing.expectEqual(@as(u64, 1), test_renderer.renderer.sixelCacheHits);
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0") == null);
    try std.testing.expect(!test_renderer.renderer.imageRenderFailed);
}

test "renderer retransmits sixel placements on a forced full repaint" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 2, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const value_handle: u32 = 1;
    test_renderer.renderer.terminal.caps.sixel = true;

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q") != null);

    // A full repaint (failed-frame recovery, palette change) rewrites every
    // cell, so the unchanged placement's pixels must be transmitted again.
    test_renderer.renderer.force_full_repaint = true;
    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(false));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q") != null);
}

test "renderer leaves clean text alone when graphics content changes" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 8, 4, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const first = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer first.deinit();
    const second = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 255, 0, 255 }, 1, 1, 4);
    defer second.deinit();
    const first_handle: u32 = 1;
    const second_handle: u32 = 2;
    test_renderer.renderer.terminal.caps.kitty_graphics = true;

    var next = test_renderer.renderer.getNextBuffer();
    try next.drawText("HELLO", 0, 3, .{ 255, 255, 255, 255 }, null, 0);
    try std.testing.expect(try next.drawImage(first, first_handle, 0, 0, 2, 2, 0, 0, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "HELLO") != null);

    // Replace the image while preserving text and placement geometry.
    // Kitty swaps the image server side; unchanged text must not be re-emitted
    // and the reserved cells must not be cleared again.
    next = test_renderer.renderer.getNextBuffer();
    try next.drawText("HELLO", 0, 3, .{ 255, 255, 255, 255 }, null, 0);
    try std.testing.expect(try next.drawImage(second, second_handle, 0, 0, 2, 2, 0, 0, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(false));
    const output = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, output, "\x1b_Ga=t") != null);
    try std.testing.expect(std.mem.find(u8, output, "HELLO") == null);
    try std.testing.expect(std.mem.find(u8, output, " ") == null);
}

test "renderer clears dirty sixel cells as one batched space run" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 8, 2, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const first = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer first.deinit();
    const second = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 255, 0, 255 }, 1, 1, 4);
    defer second.deinit();
    const first_handle: u32 = 1;
    const second_handle: u32 = 2;
    test_renderer.renderer.terminal.caps.sixel = true;

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(first, first_handle, 0, 0, 6, 1, 12, 2, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(second, second_handle, 0, 0, 6, 1, 12, 2, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(false));
    const output = test_renderer.memory.lastWrite();
    const sixel = std.mem.find(u8, output, "\x1bP0;1;0q") orelse return error.TestUnexpectedResult;
    // The six reserved cells clear with a single cursor move and six spaces;
    // the only other CUP before the payload positions the Sixel itself.
    try std.testing.expect(std.mem.find(u8, output[0..sixel], "\x1b[1;1H      ") != null);
    try std.testing.expectEqual(@as(usize, 2), std.mem.count(u8, output[0..sixel], "\x1b[1;1H"));
}

test "renderer downscales large kitty stills to their placement pixel size" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 8, 4, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    // 64x64 source shown at 16x16 pixels: 16x the pixel area.
    const pixels = try std.testing.allocator.alloc(u8, 64 * 64 * 4);
    defer std.testing.allocator.free(pixels);
    for (0..64 * 64) |index| {
        pixels[index * 4] = 200;
        pixels[index * 4 + 1] = @truncate(index);
        pixels[index * 4 + 2] = 30;
        pixels[index * 4 + 3] = 255;
    }
    const value = try image.createFromRgba(std.testing.allocator, pixels, 64, 64, 64 * 4);
    defer value.deinit();
    const value_handle: u32 = 1;
    test_renderer.renderer.terminal.caps.kitty_graphics = true;

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 2, 2, 16, 16, 0, 0, 64, 64, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    const output = test_renderer.memory.lastWrite();

    // The transmission carries the downscaled pixels and the placement crops
    // the full downscaled image.
    try std.testing.expect(std.mem.find(u8, output, "a=t,f=24,s=16,v=16") != null);
    try std.testing.expect(std.mem.find(u8, output, "x=0,y=0,w=16,h=16,C=1") != null);
    const transmit_start = std.mem.find(u8, output, "\x1b_Ga=t").?;
    const transmit_end = std.mem.findPos(u8, output, transmit_start, "\x1b[").?;
    const transmitted = try terminal_image_test.decodeKittyChunks(output[transmit_start..transmit_end]);
    defer std.testing.allocator.free(transmitted);
    try std.testing.expectEqual(@as(usize, 16 * 16 * 3), transmitted.len);
    try std.testing.expectEqual(@as(u8, 200), transmitted[0]);
    try std.testing.expectEqual(@as(u8, 30), transmitted[2]);

    // Changing the placement pixel size invalidates the downscaled pixels.
    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 2, 2, 20, 20, 0, 0, 64, 64, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(false));
    const second = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, second, "a=d,d=I") != null);
    try std.testing.expect(std.mem.find(u8, second, "a=t,f=24,s=20,v=20") != null);
}

test "renderer transmits small kitty images at native size" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 8, 4, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, utils.repeat(u8, &.{ 9, 8, 7, 255 }, 64), 8, 8, 32);
    defer value.deinit();
    const value_handle: u32 = 1;
    test_renderer.renderer.terminal.caps.kitty_graphics = true;

    // Displayed at 16x16 pixels (upscale): the source pixels are transmitted
    // untouched and kitty performs the scaling.
    const next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 2, 2, 16, 16, 0, 0, 8, 8, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    const output = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, output, "a=t,f=24,s=8,v=8") != null);
    try std.testing.expect(std.mem.find(u8, output, "x=0,y=0,w=8,h=8,C=1") != null);
}

test "renderer reuses the kitty transmit across source rectangle changes" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 8, 4, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    const pixels = try std.testing.allocator.alloc(u8, 64 * 64 * 4);
    defer std.testing.allocator.free(pixels);
    for (0..64 * 64) |index| {
        pixels[index * 4] = @truncate(index);
        pixels[index * 4 + 1] = 100;
        pixels[index * 4 + 2] = 200;
        pixels[index * 4 + 3] = 255;
    }
    const value = try image.createFromRgba(std.testing.allocator, pixels, 64, 64, 64 * 4);
    defer value.deinit();
    const value_handle: u32 = 1;
    test_renderer.renderer.terminal.caps.kitty_graphics = true;

    // A clipped placement transmits the full image once; the placement escape
    // selects the visible source rectangle.
    const next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 2, 2, 16, 16, 8, 12, 8, 8, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    const output = test_renderer.memory.lastWrite();

    try std.testing.expect(std.mem.find(u8, output, "a=t,f=24,s=64,v=64") != null);
    try std.testing.expect(std.mem.find(u8, output, "x=8,y=12,w=8,h=8,C=1") != null);
    const transmit_start = std.mem.find(u8, output, "\x1b_Ga=t").?;
    const transmit_end = std.mem.findPos(u8, output, transmit_start, "\x1b[").?;
    const transmitted = try terminal_image_test.decodeKittyChunks(output[transmit_start..transmit_end]);
    defer std.testing.allocator.free(transmitted);
    try std.testing.expectEqual(@as(usize, 64 * 64 * 3), transmitted.len);

    // A scroll step changes only the source rectangle: no delete-image, no new
    // transmit, just a re-placement referencing the retained image.
    const changed = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try changed.drawImage(value, value_handle, 0, 0, 2, 2, 16, 16, 16, 12, 8, 8, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(false));
    const changed_output = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, changed_output, "a=d,d=I") == null);
    try std.testing.expect(std.mem.find(u8, changed_output, "a=t") == null);
    try std.testing.expect(std.mem.find(u8, changed_output, "a=d,d=i") != null);
    try std.testing.expect(std.mem.find(u8, changed_output, "x=16,y=12,w=8,h=8,C=1") != null);
}

test "renderer does not publish a frame when image dirty preparation fails" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 2, 1, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    test_renderer.renderer.terminal.caps.sixel = true;

    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const value_handle: u32 = 1;
    try test_renderer.renderer.pendingImages.ensureTotalCapacity(std.testing.allocator, 1);
    const next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));

    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0 });
    test_renderer.renderer.allocator = failing.allocator();
    const status = test_renderer.render(true);
    test_renderer.renderer.allocator = std.testing.allocator;

    try std.testing.expect(failing.has_induced_failure);
    try std.testing.expectEqual(renderer.RenderStatus.failed, status);
    try std.testing.expectEqual(@as(usize, 0), test_renderer.renderer.currentImages.items.len);
    try std.testing.expectEqual(@as(usize, 0), test_renderer.memory.lastWrite().len);

    const retry = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try retry.drawImage(value, value_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q") != null);
    try std.testing.expectEqual(@as(usize, 1), test_renderer.renderer.currentImages.items.len);
}

test "renderer does not publish a frame when Sixel preparation fails" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 1, 1, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    test_renderer.renderer.terminal.caps.sixel = true;

    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const value_handle: u32 = 1;
    try test_renderer.renderer.imageDirty.ensureTotalCapacity(std.testing.allocator, 1);
    try test_renderer.renderer.pendingImages.ensureTotalCapacity(std.testing.allocator, 1);
    const next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));

    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0 });
    test_renderer.renderer.allocator = failing.allocator();
    const status = test_renderer.render(true);
    test_renderer.renderer.allocator = std.testing.allocator;

    try std.testing.expect(failing.has_induced_failure);
    try std.testing.expectEqual(renderer.RenderStatus.failed, status);
    try std.testing.expectEqual(@as(usize, 0), test_renderer.renderer.currentImages.items.len);
    try std.testing.expectEqual(@as(usize, 0), test_renderer.memory.lastWrite().len);

    const retry = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try retry.drawImage(value, value_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q") != null);
    try std.testing.expectEqual(@as(usize, 1), test_renderer.renderer.currentImages.items.len);
}

test "renderer does not publish Kitty output when image state staging fails" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 1, 1, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    test_renderer.renderer.terminal.caps.kitty_graphics = true;

    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    const value_handle: u32 = 1;
    try test_renderer.renderer.imageDirty.ensureTotalCapacity(std.testing.allocator, 1);
    const next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .kitty));

    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0 });
    test_renderer.renderer.allocator = failing.allocator();
    const status = test_renderer.render(true);
    test_renderer.renderer.allocator = std.testing.allocator;

    try std.testing.expect(failing.has_induced_failure);
    try std.testing.expectEqual(renderer.RenderStatus.failed, status);
    try std.testing.expectEqual(@as(usize, 0), test_renderer.renderer.currentImages.items.len);
    try std.testing.expectEqual(@as(usize, 0), test_renderer.memory.lastWrite().len);

    const retry = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try retry.drawImage(value, value_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .kitty));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1b_Ga=t") != null);
    try std.testing.expectEqual(@as(usize, 1), test_renderer.renderer.currentImages.items.len);
}

test "renderer clears an upper sixel hole when its lower image moves away" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 2, 1, &pools.graphemes, &pools.links);
    defer test_renderer.deinit();
    test_renderer.renderer.terminal.caps.sixel = true;

    const lower = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 0, 255, 255 }, 1, 1, 4);
    defer lower.deinit();
    const upper = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 0, 0, 0 }, 1, 1, 4);
    defer upper.deinit();
    const lower_handle: u32 = 1;
    const upper_handle: u32 = 2;

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(lower, lower_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(upper, upper_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(true));

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(lower, lower_handle, 1, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(upper, upper_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.render(false));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1b[1;1H") != null);
}

test "renderer resize reports allocation and dimension failures without committing geometry" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    const feed = try native_span_feed.Stream.create(std.testing.allocator, null);
    defer feed.destroy();
    const target = try CliRenderer.createWithOptions(failing.allocator(), 2, 2, &pool, .{
        .io = std.testing.io,
        .feed = feed,
        .link_pool = &links,
    });
    defer target.destroyStorage();
    try std.testing.expectError(error.InvalidDimensions, target.resize(0, 1));
    try std.testing.expectError(error.InvalidDimensions, target.resize(65536, 65536));
    failing.fail_index = failing.alloc_index;
    try std.testing.expectError(error.OutOfMemory, target.resize(4, 1));
    try std.testing.expectEqual(@as(u32, 2), target.width);
    try std.testing.expectEqual(@as(u32, 2), target.height);
    failing.fail_index = std.math.maxInt(usize);
    try target.resize(4, 1);
    try std.testing.expectEqual(@as(u32, 4), target.width);
    try std.testing.expectEqual(@as(u32, 1), target.height);
    target.nextRenderBuffer.storage.generation = std.math.maxInt(u64);
    const current = target.currentRenderBuffer.storage;
    const live_bytes = failing.allocated_bytes - failing.freed_bytes;
    try std.testing.expectError(error.GenerationExhausted, target.resize(5, 1));
    try std.testing.expectEqual(live_bytes, failing.allocated_bytes - failing.freed_bytes);
    try std.testing.expectEqual(current, target.currentRenderBuffer.storage);
    try std.testing.expectEqual(@as(u32, 4), target.width);
    try std.testing.expectEqual(@as(u32, 1), target.height);
}
