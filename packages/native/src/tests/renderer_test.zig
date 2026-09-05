const std = @import("std");
const io = std.testing.io;
const renderer = @import("../renderer.zig");
const text_buffer = @import("../text-buffer.zig");
const text_buffer_view = @import("../text-buffer-view.zig");
const buffer = @import("../buffer.zig");
const gp = @import("../grapheme.zig");
const ss = @import("../syntax-style.zig");
const link = @import("../link.zig");
const ansi = @import("../ansi.zig");
const image = @import("../image.zig");
const handles = @import("../handles.zig");
const ghostty_vt = @import("../ghostty-vt.zig");
const test_renderer_mod = @import("test-renderer.zig");
const terminal_image_test = @import("terminal-image_test.zig");

const CliRenderer = renderer.CliRenderer;
const TextBuffer = text_buffer.TextBuffer;
const TextBufferView = text_buffer_view.TextBufferView;
const OptimizedBuffer = buffer.OptimizedBuffer;
const RGBA = text_buffer.RGBA;
const TestMemoryOutput = test_renderer_mod.TestMemoryOutput;
const TestRenderer = test_renderer_mod.TestRenderer;

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

const CountingOutput = struct {
    writes: u32 = 0,

    fn bufferedOutput(self: *CountingOutput) @import("../renderer-output.zig").BufferedOutput {
        return .{ .ctx = self, .write_fn = write, .thread_safe = true };
    }

    fn write(ctx: *anyopaque, data: []const u8) void {
        const self: *CountingOutput = @ptrCast(@alignCast(ctx));
        _ = data;
        self.writes += 1;
    }
};

const SlowThreadSafeOutput = struct {
    delay_ns: u64,
    writes: std.atomic.Value(u32) = std.atomic.Value(u32).init(0),
    payloads: [2][64]u8 = [_][64]u8{[_]u8{0} ** 64} ** 2,
    lengths: [2]usize = [_]usize{0} ** 2,

    fn bufferedOutput(self: *SlowThreadSafeOutput) @import("../renderer-output.zig").BufferedOutput {
        return .{ .ctx = self, .write_fn = write, .thread_safe = true };
    }

    fn write(ctx: *anyopaque, data: []const u8) void {
        const self: *SlowThreadSafeOutput = @ptrCast(@alignCast(ctx));
        const index = self.writes.fetchAdd(1, .monotonic);
        if (index < self.payloads.len) {
            self.lengths[index] = @min(data.len, self.payloads[index].len);
            @memcpy(self.payloads[index][0..self.lengths[index]], data[0..self.lengths[index]]);
        }
        io.sleep(.fromNanoseconds(self.delay_ns), .awake) catch unreachable;
    }
};
test "renderer emits Kitty image once and leaves unchanged frame empty" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 2, pool);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const image_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    test_renderer.renderer.terminal.caps.kitty_graphics = true;
    test_renderer.renderer.terminal.multiplexer = .none;

    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1b_Ga=t,f=24,s=1,v=1,i=") != null);
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "c=1,r=1,x=0,y=0,w=1,h=1,C=1,z=-1499999999") != null);

    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(false));
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
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 2, pool);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const image_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    test_renderer.renderer.terminal.caps.sixel = true;
    test_renderer.renderer.terminal.multiplexer = .none;

    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q") != null);
    try std.testing.expectEqual(@as(u64, 1), test_renderer.renderer.sixelCacheMisses);
    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q") != null);
    try std.testing.expectEqual(@as(u64, 1), test_renderer.renderer.sixelCacheHits);

    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 1, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    try std.testing.expectEqual(@as(u64, 2), test_renderer.renderer.sixelCacheHits);

    try test_renderer.renderer.getNextBuffer().pushOpacity(0.5);
    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 1, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    test_renderer.renderer.getNextBuffer().popOpacity();
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    try std.testing.expectEqual(@as(u64, 2), test_renderer.renderer.sixelCacheMisses);
}

test "renderer separates translucent Sixel cache entries by cell geometry" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var cached_renderer = try TestRenderer.create(std.testing.allocator, 2, 4, pool);
    defer cached_renderer.deinit();
    var fresh_renderer = try TestRenderer.create(std.testing.allocator, 2, 4, pool);
    defer fresh_renderer.deinit();
    const pixels = [_]u8{ 255, 255, 255, 255 } ** 16;
    const value = try image.createFromRgba(std.testing.allocator, &pixels, 4, 4, 16);
    const image_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    cached_renderer.renderer.terminal.caps.sixel = true;
    fresh_renderer.renderer.terminal.caps.sixel = true;

    try drawTranslucentSixelGeometry(cached_renderer.renderer.getNextBuffer(), value, image_handle, 1, 4);
    try std.testing.expectEqual(renderer.RenderStatus.rendered, cached_renderer.renderer.render(true));
    try drawTranslucentSixelGeometry(cached_renderer.renderer.getNextBuffer(), value, image_handle, 2, 2);
    try std.testing.expectEqual(renderer.RenderStatus.rendered, cached_renderer.renderer.render(true));
    try std.testing.expectEqual(@as(u64, 0), cached_renderer.renderer.sixelCacheHits);
    try std.testing.expectEqual(@as(u64, 2), cached_renderer.renderer.sixelCacheMisses);

    try drawTranslucentSixelGeometry(fresh_renderer.renderer.getNextBuffer(), value, image_handle, 2, 2);
    try std.testing.expectEqual(renderer.RenderStatus.rendered, fresh_renderer.renderer.render(true));

    try std.testing.expectEqualSlices(
        u8,
        try lastSixelFrame(fresh_renderer.memory.lastWrite()),
        try lastSixelFrame(cached_renderer.memory.lastWrite()),
    );
}

test "renderer does not copy identity Sixel geometry" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 1, 1, pool);
    defer test_renderer.deinit();

    var source_allocator = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    const value = try image.createFromRgba(source_allocator.allocator(), &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const image_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    // A full-image extract consumes two allocations. Fail if rendering tries
    // to allocate a second image copy for the identity resize.
    source_allocator.fail_index = source_allocator.alloc_index + 2;
    const source_allocations_before_render = source_allocator.allocations;
    test_renderer.renderer.terminal.caps.sixel = true;

    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    try std.testing.expect(!source_allocator.has_induced_failure);
    try std.testing.expectEqual(source_allocations_before_render, source_allocator.allocations);
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q") != null);
}

test "renderer repaints unchanged upper Sixel after an overlapping lower image changes" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 1, 1, pool);
    defer test_renderer.deinit();

    const red = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const blue = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 0, 255, 255 }, 1, 1, 4);
    const green = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 255, 0, 255 }, 1, 1, 4);
    const red_handle = try handles.insert(.image, @ptrCast(red));
    const blue_handle = try handles.insert(.image, @ptrCast(blue));
    const green_handle = try handles.insert(.image, @ptrCast(green));
    defer for ([_]u32{ green_handle, blue_handle, red_handle }) |handle| {
        const token = handles.beginDestroy(handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    };
    test_renderer.renderer.terminal.caps.sixel = true;
    test_renderer.renderer.terminal.multiplexer = .none;

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(blue, blue_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(green, green_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(blue, blue_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(false));

    const output = test_renderer.memory.lastWrite();
    try std.testing.expectEqual(@as(usize, 2), std.mem.count(u8, output, "\x1bP0;1;0q"));
    try expectSinglePaintedSixelColor(output, .{ 0, 2 }, .{ 0, 2 }, .{ 95, 100 });
}

test "renderer repaints overlapping Sixel images when their order changes" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 1, 1, pool);
    defer test_renderer.deinit();

    const red = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const blue = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 0, 255, 255 }, 1, 1, 4);
    const red_handle = try handles.insert(.image, @ptrCast(red));
    const blue_handle = try handles.insert(.image, @ptrCast(blue));
    defer for ([_]u32{ blue_handle, red_handle }) |handle| {
        const token = handles.beginDestroy(handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    };
    test_renderer.renderer.terminal.caps.sixel = true;
    test_renderer.renderer.terminal.multiplexer = .none;

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(blue, blue_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(blue, blue_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(false));

    const output = test_renderer.memory.lastWrite();
    try std.testing.expectEqual(@as(usize, 2), std.mem.count(u8, output, "\x1bP0;1;0q"));
    try expectSinglePaintedSixelColor(output, .{ 95, 100 }, .{ 0, 2 }, .{ 0, 2 });
}

test "renderer propagates Sixel repaint through an overlap chain" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 6, 1, pool);
    defer test_renderer.deinit();
    test_renderer.renderer.terminal.caps.sixel = true;

    const red = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const green = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 255, 0, 255 }, 1, 1, 4);
    const blue = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 0, 255, 255 }, 1, 1, 4);
    const white = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 255, 255, 255 }, 1, 1, 4);
    const red_handle = try handles.insert(.image, @ptrCast(red));
    const green_handle = try handles.insert(.image, @ptrCast(green));
    const blue_handle = try handles.insert(.image, @ptrCast(blue));
    const white_handle = try handles.insert(.image, @ptrCast(white));
    defer for ([_]u32{ white_handle, blue_handle, green_handle, red_handle }) |handle| {
        const token = handles.beginDestroy(handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    };

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 2, 1, 2, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(blue, blue_handle, 1, 0, 2, 1, 2, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(white, white_handle, 2, 0, 2, 1, 2, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(red, red_handle, 5, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(green, green_handle, 0, 0, 2, 1, 2, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(blue, blue_handle, 1, 0, 2, 1, 2, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(white, white_handle, 2, 0, 2, 1, 2, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(red, red_handle, 5, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(false));

    try std.testing.expectEqual(@as(usize, 3), std.mem.count(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q"));
}

test "renderer repaints lower Sixel after removing an overlapping upper image" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 1, 1, pool);
    defer test_renderer.deinit();

    const red = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const blue = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 0, 255, 255 }, 1, 1, 4);
    const red_handle = try handles.insert(.image, @ptrCast(red));
    const blue_handle = try handles.insert(.image, @ptrCast(blue));
    defer for ([_]u32{ blue_handle, red_handle }) |handle| {
        const token = handles.beginDestroy(handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    };
    test_renderer.renderer.terminal.caps.sixel = true;
    test_renderer.renderer.terminal.multiplexer = .none;

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(blue, blue_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(false));

    const output = test_renderer.memory.lastWrite();
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, output, "\x1bP0;1;0q"));
    try expectSinglePaintedSixelColor(output, .{ 95, 100 }, .{ 0, 2 }, .{ 0, 2 });
}

test "renderer repaints lower Sixel when an overlapping upper image becomes transparent" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 1, 1, pool);
    defer test_renderer.deinit();

    const red = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const blue = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 0, 255, 255 }, 1, 1, 4);
    const transparent = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 0, 0, 0 }, 1, 1, 4);
    const red_handle = try handles.insert(.image, @ptrCast(red));
    const blue_handle = try handles.insert(.image, @ptrCast(blue));
    const transparent_handle = try handles.insert(.image, @ptrCast(transparent));
    defer for ([_]u32{ transparent_handle, blue_handle, red_handle }) |handle| {
        const token = handles.beginDestroy(handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    };
    test_renderer.renderer.terminal.caps.sixel = true;
    test_renderer.renderer.terminal.multiplexer = .none;

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(blue, blue_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(transparent, transparent_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(false));

    const output = test_renderer.memory.lastWrite();
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, output, "\x1bP0;1;0q"));
    try expectSinglePaintedSixelColor(output, .{ 95, 100 }, .{ 0, 2 }, .{ 0, 2 });
}

test "renderer honors per-placement protocol overrides" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 2, pool);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const image_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }

    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .kitty));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1b_Ga=t") != null);

    test_renderer.renderer.terminal.caps.kitty_graphics = true;
    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .blocks));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1b_Ga=t") == null);
}

test "renderer does not send forced Sixel to Apple Terminal" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.createWithEnv(std.testing.allocator, 4, 2, pool, &.{
        .{ .key = "TERM_PROGRAM", .value = "Apple_Terminal" },
    });
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const image_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }

    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    const output = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, output, "\x1bP0;1;0q") == null);
    try std.testing.expect(std.mem.find(u8, output, "█") != null);
}

test "renderer honors forced Sixel through tmux independently of tmux DA" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.createWithEnv(std.testing.allocator, 4, 2, pool, &.{
        .{ .key = "TERM_PROGRAM", .value = "Apple_Terminal" },
    });
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const image_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    test_renderer.renderer.terminal.processCapabilityResponse("\x1bP>|tmux 3.5a\x1b\\");
    test_renderer.renderer.terminal.processCapabilityResponse("\x1b[?62;4c");

    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    const output = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, output, "\x1bPtmux;") != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b\x1bP0;1;0q") != null);
}

test "renderer does not send forced Sixel to Kitty" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 2, pool);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const image_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    test_renderer.renderer.terminal.processCapabilityResponse("\x1bP>|kitty(0.48.2)\x1b\\");

    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    const output = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, output, "\x1bP0;1;0q") == null);
    try std.testing.expect(std.mem.find(u8, output, "█") != null);
}

test "renderer honors global image protocol override for auto placements" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 2, pool);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const image_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    test_renderer.renderer.terminal.image_protocol = .kitty;
    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1b_Ga=t") != null);
}

test "renderer keeps unresolved Sixel fallback frames as no-ops" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 2, 1, pool);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const image_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    test_renderer.renderer.terminal.caps.sixel = true;
    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    const first = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, first, "\x1bP0;1;0q") == null);
    try std.testing.expect(std.mem.find(u8, first, "█") != null);
    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(false));
    try std.testing.expectEqual(@as(usize, 0), test_renderer.memory.lastWrite().len);
}

test "renderer repaints a final blocks placement over Sixel" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 2, 1, pool);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const image_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try test_renderer.renderer.getNextBuffer().drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .blocks));
    _ = test_renderer.renderer.render(true);
    const output = test_renderer.memory.lastWrite();
    const sixel = std.mem.find(u8, output, "\x1bP0;1;0q") orelse return error.TestUnexpectedResult;
    const block = std.mem.findLast(u8, output, "█") orelse return error.TestUnexpectedResult;
    try std.testing.expect(block > sixel);
}

test "renderer does not retransmit Sixel when overlay text changes" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 2, 1, pool);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const image_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    const fg = RGBA{ 1.0, 1.0, 1.0, 1.0 };
    const bg = RGBA{ 0.0, 0.0, 0.0, 1.0 };

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 2, 1, 2, 2, 0, 0, 1, 1, .sixel));
    _ = test_renderer.renderer.render(true);

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 2, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try next.drawText("1", 1, 0, fg, bg, 0);
    _ = test_renderer.renderer.render(false);
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q") == null);
    try std.testing.expect(std.mem.findScalar(u8, test_renderer.memory.lastWrite(), '1') != null);

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 2, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try next.drawText("2", 1, 0, fg, bg, 0);
    _ = test_renderer.renderer.render(false);
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q") == null);
    try std.testing.expect(std.mem.findScalar(u8, test_renderer.memory.lastWrite(), '2') != null);

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 2, 1, 2, 2, 0, 0, 1, 1, .sixel));
    _ = test_renderer.renderer.render(false);
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q") != null);
}

test "renderer replays a wide grapheme that starts before a Sixel placement" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 2, 1, pool);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const image_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }

    const next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 1, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try next.drawText("界", 0, 0, ansi.rgbColor(255, 255, 255, 0), ansi.rgbColor(0, 0, 0, 0), 0);
    _ = test_renderer.renderer.render(true);

    const output = test_renderer.memory.lastWrite();
    const sixel = std.mem.find(u8, output, "\x1bP0;1;0q") orelse return error.TestUnexpectedResult;
    const overlay = std.mem.findLast(u8, output, "界") orelse return error.TestUnexpectedResult;
    try std.testing.expect(overlay > sixel);
}

test "renderer preserves terminal semantics when replaying cells over Sixel" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 3, 1, pool);
    defer test_renderer.deinit();
    test_renderer.renderer.terminal.caps.sixel = true;
    test_renderer.renderer.terminal.caps.hyperlinks = true;
    test_renderer.renderer.terminal.caps.explicit_width = true;
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const image_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    const link_id = try link_pool.alloc("https://example.com/replayed");
    const linked_bold = ansi.TextAttributes.setLinkId(ansi.TextAttributes.BOLD, link_id);

    const next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 3, 1, 6, 2, 0, 0, 1, 1, .sixel));
    try next.drawText("界", 0, 0, ansi.rgbColor(255, 255, 255, 255), ansi.rgbColor(0, 0, 0, 255), linked_bold);
    try next.drawText("X", 2, 0, ansi.rgbColor(255, 255, 255, 255), ansi.rgbColor(0, 0, 0, 255), 0);
    _ = test_renderer.renderer.render(true);

    const output = test_renderer.memory.lastWrite();
    const sixel = std.mem.findLast(u8, output, "\x1bP0;1;0q") orelse return error.TestUnexpectedResult;
    const replay = output[sixel..];
    try std.testing.expect(std.mem.find(u8, replay, "\x1b]8;id=") != null);
    try std.testing.expect(std.mem.find(u8, replay, ";https://example.com/replayed\x1b\\") != null);
    try std.testing.expect(std.mem.find(u8, replay, "\x1b]8;;\x1b\\") != null);
    try std.testing.expect(std.mem.find(u8, replay, "\x1b]66;w=2;界\x1b\\") != null);
    try std.testing.expect(std.mem.find(u8, replay, "\x1b[0m\x1b[1;3H") != null);
}

test "renderer preserves Malayalam report after Ghostty probe replies" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 80, 1, pool);
    defer test_renderer.deinit();
    try std.testing.expect(test_renderer.renderer.setTerminalEnvVar("TERM_PROGRAM", "ghostty"));
    try std.testing.expect(test_renderer.renderer.setTerminalEnvVar("TERM_PROGRAM_VERSION", "1.3.1"));

    var writer = DiscardTerminalWriter{};
    try test_renderer.renderer.terminal.queryTerminalSend(&writer);
    test_renderer.renderer.processCapabilityResponse("\x1b[1;5R");
    test_renderer.renderer.processCapabilityResponse("\x1b[1;1R");
    test_renderer.renderer.processCapabilityResponse("\x1b[1;1R\x1bP>|ghostty 1.3.1\x1b\\");

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
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));

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
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 6, 1, pool);
    defer test_renderer.deinit();
    try std.testing.expect(test_renderer.renderer.setTerminalEnvVar("TERM_PROGRAM", "ghostty"));
    try std.testing.expect(test_renderer.renderer.setTerminalEnvVar("TERM_PROGRAM_VERSION", "1.3.1"));

    const text = "✅ X";
    const foreground = ansi.rgbColor(255, 255, 255, 255);
    const background = ansi.rgbColor(0, 0, 0, 255);
    var next = test_renderer.renderer.getNextBuffer();
    try next.drawText(text, 0, 0, foreground, background, 0);
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));

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
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(false));

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

fn expectPlaneCoversImage(protocol: image.RenderProtocol) !void {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 2, 1, pool);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const image_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 2, 1, 2, 2, 0, 0, 1, 1, protocol));
    _ = test_renderer.renderer.render(true);

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 2, 1, 2, 2, 0, 0, 1, 1, protocol));
    next.fillRect(0, 0, 1, 1, ansi.rgbaFromFloats(0.0, 0.0, 1.0, 0.5));
    try std.testing.expectEqual(@as(usize, 1), next.image_placements.items.len);
    try std.testing.expectEqual(@as(u32, ' '), next.get(0, 0).?.char);
    try std.testing.expectEqual(ansi.rgbColor(0, 0, 255, 255), next.get(0, 0).?.bg);
    try std.testing.expect(gp.isImageChar(next.get(1, 0).?.char));
    _ = test_renderer.renderer.render(false);
    const covered_output = test_renderer.memory.lastWrite();
    try std.testing.expect(covered_output.len > 0);
    try std.testing.expect(std.mem.find(u8, covered_output, "\x1b_Ga=t") == null);
    try std.testing.expect(std.mem.find(u8, covered_output, "a=p") == null);
    try std.testing.expect(std.mem.find(u8, covered_output, "a=d") == null);
    try std.testing.expect(std.mem.find(u8, covered_output, "\x1bP0;1;0q") == null);

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 2, 1, 2, 2, 0, 0, 1, 1, protocol));
    try std.testing.expectEqual(@as(usize, 1), next.image_placements.items.len);
    _ = test_renderer.renderer.render(false);
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

test "renderer keeps Kitty placement under an alpha-colored plane" {
    try expectPlaneCoversImage(.kitty);
}

test "renderer splits changed background runs around clean Kitty image cells" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 5, 1, pool);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const image_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    test_renderer.renderer.terminal.caps.kitty_graphics = true;

    var next = test_renderer.renderer.getNextBuffer();
    next.fillRect(0, 0, 5, 1, ansi.rgbColor(8, 11, 18, 255));
    try std.testing.expect(try next.drawImage(value, image_handle, 1, 0, 2, 1, 2, 2, 0, 0, 1, 1, .kitty));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));

    next = test_renderer.renderer.getNextBuffer();
    next.fillRect(0, 0, 5, 1, ansi.rgbColor(32, 43, 61, 255));
    try std.testing.expect(try next.drawImage(value, image_handle, 1, 0, 2, 1, 2, 2, 0, 0, 1, 1, .kitty));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(false));

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
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 2, 1, pool);
    defer test_renderer.deinit();
    const opaque_image = try image.createFromRgba(std.testing.allocator, &[_]u8{
        255, 0, 0, 255, 255, 0, 0, 255,
    }, 2, 1, 8);
    const replacement = try image.createFromRgba(std.testing.allocator, &[_]u8{
        0, 0, 0, 0, 0, 0, 255, 255,
    }, 2, 1, 8);
    const opaque_handle = try handles.insert(.image, @ptrCast(opaque_image));
    const replacement_handle = try handles.insert(.image, @ptrCast(replacement));
    defer {
        const replacement_token = handles.beginDestroy(replacement_handle, .image, image.Image).?;
        replacement_token.ptr.deinit();
        handles.finishDestroy(replacement_token.handle);
        const opaque_token = handles.beginDestroy(opaque_handle, .image, image.Image).?;
        opaque_token.ptr.deinit();
        handles.finishDestroy(opaque_token.handle);
    }

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(opaque_image, opaque_handle, 0, 0, 2, 1, 2, 2, 0, 0, 2, 1, .sixel));
    _ = test_renderer.renderer.render(true);

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(replacement, replacement_handle, 0, 0, 2, 1, 2, 2, 0, 0, 2, 1, .sixel));
    _ = test_renderer.renderer.render(false);
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

    var palette = [_][3]u8{.{ 0, 0, 0 }} ** 256;
    var painted = [_]bool{false} ** 256;
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
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 2, pool);
    defer test_renderer.deinit();
    const red = try image.createFromRgba(std.testing.allocator, &[_]u8{
        255, 0, 0, 255, 255, 0, 0, 255,
        255, 0, 0, 255, 255, 0, 0, 255,
    }, 2, 2, 8);
    const red_handle = try handles.insert(.image, @ptrCast(red));
    defer {
        const token = handles.beginDestroy(red_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    test_renderer.renderer.terminal.caps.sixel = true;

    // Opacity 0.4 over the default (transparent) background must stay visible,
    // dimmed toward black: red 255 * 0.4 = 102 -> 40 on the Sixel 0-100 scale.
    var next = test_renderer.renderer.getNextBuffer();
    try next.pushOpacity(0.4);
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 1, 1, 2, 2, 0, 0, 2, 2, .sixel));
    next.popOpacity();
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    try expectSinglePaintedSixelColor(test_renderer.memory.lastWrite(), .{ 35, 45 }, .{ 0, 2 }, .{ 0, 2 });

    // The same placement over an opaque blue background must dim toward blue:
    // 0.4 * red + 0.6 * blue = (102, 0, 153) -> (40, 0, 60).
    test_renderer.renderer.setBackgroundColor(ansi.rgbColor(0, 0, 255, 255));
    _ = test_renderer.renderer.render(true);
    next = test_renderer.renderer.getNextBuffer();
    try next.pushOpacity(0.4);
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 1, 1, 2, 2, 0, 0, 2, 2, .sixel));
    next.popOpacity();
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    try expectSinglePaintedSixelColor(test_renderer.memory.lastWrite(), .{ 35, 45 }, .{ 0, 2 }, .{ 55, 65 });

    // Opacity 0.75 over the same blue background: (191, 0, 64) -> (75, 0, 25).
    // Today this renders at full brightness because opacity only rescales alpha.
    next = test_renderer.renderer.getNextBuffer();
    try next.pushOpacity(0.75);
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 1, 1, 2, 2, 0, 0, 2, 2, .sixel));
    next.popOpacity();
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    try expectSinglePaintedSixelColor(test_renderer.memory.lastWrite(), .{ 70, 80 }, .{ 0, 2 }, .{ 20, 30 });

    // Full opacity is unaffected by the background: pure red (100, 0, 0).
    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(red, red_handle, 0, 0, 1, 1, 2, 2, 0, 0, 2, 2, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    try expectSinglePaintedSixelColor(test_renderer.memory.lastWrite(), .{ 95, 100 }, .{ 0, 2 }, .{ 0, 2 });
}

test "renderer materializes lazy ICC PNGs before applying Sixel opacity" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 2, pool);
    defer test_renderer.deinit();

    const encoded = std.mem.trim(u8, @embedFile("fixtures/display-p3.png.base64"), "\r\n");
    const png_len = try std.base64.standard.Decoder.calcSizeForSlice(encoded);
    const png = try std.testing.allocator.alloc(u8, png_len);
    defer std.testing.allocator.free(png);
    try std.base64.standard.Decoder.decode(png, encoded);
    const value = try image.decode(std.testing.allocator, png, .{});
    const image_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    try std.testing.expectEqual(@as(usize, 0), value.pixels.len);
    test_renderer.renderer.terminal.caps.sixel = true;

    var next = test_renderer.renderer.getNextBuffer();
    try next.pushOpacity(0.5);
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 3, 1, 3, 1, 0, 0, 3, 1, .sixel));
    next.popOpacity();
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q") != null);
    try std.testing.expectEqual(@as(usize, 0), value.pixels.len);
}

test "renderer keeps image alpha holes transparent while dimming by opacity" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 2, pool);
    defer test_renderer.deinit();
    // Left pixel opaque red, right pixel fully transparent.
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{
        255, 0, 0, 255, 0, 0, 0, 0,
    }, 2, 1, 8);
    const value_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(value_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    test_renderer.renderer.terminal.caps.sixel = true;

    var next = test_renderer.renderer.getNextBuffer();
    try next.pushOpacity(0.6);
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 2, 1, 2, 1, 0, 0, 2, 1, .sixel));
    next.popOpacity();
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));

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

test "buffered backend grows and commits a complete large frame" {
    var memory = TestMemoryOutput.init(std.testing.allocator);
    defer memory.deinit();
    var backend = try renderer.BufferedBackend.create(std.testing.allocator, memory.bufferedOutput());
    defer backend.deinit();
    backend.beginFrame();
    var writer = backend.writer();
    const oversized = try std.testing.allocator.alloc(u8, renderer.OUTPUT_BUFFER_SIZE + 1);
    defer std.testing.allocator.free(oversized);
    @memset(oversized, 42);
    try writer.writeAll(oversized);
    try std.testing.expectEqual(@import("../renderer-output.zig").WriteStatus.ok, backend.endFrame());
    try std.testing.expectEqual(oversized.len, memory.bytes.items.len);
    try std.testing.expectEqualSlices(u8, oversized, memory.bytes.items);
}

fn createWithOptionsOnce(allocator: std.mem.Allocator, width: u32, height: u32) !void {
    const pool = gp.initGlobalPool(allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();

    var memory = TestMemoryOutput.init(allocator);
    defer memory.deinit();

    var cli_renderer = try CliRenderer.createWithOptions(allocator, width, height, pool, .{
        .output = .{ .buffered = memory.bufferedOutput() },
    });
    cli_renderer.destroy();
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
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_renderer.deinit();
    const cli_renderer = test_renderer.renderer;

    try std.testing.expectEqual(@as(u32, 80), cli_renderer.width);
    try std.testing.expectEqual(@as(u32, 24), cli_renderer.height);
}

test "renderer - clipboard allocates one exact encoded sequence" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_renderer = try TestRenderer.create(std.testing.allocator, 80, 24, pool);
    defer test_renderer.deinit();

    const payload = [_]u8{'A'} ** 2048;
    try std.testing.expect(test_renderer.renderer.copyToClipboardOSC52(.clipboard, &payload));

    const output = test_renderer.lastOutput();
    try std.testing.expectEqual(std.base64.standard.Encoder.calcSize(payload.len) + 9, output.len);
    try std.testing.expect(std.mem.startsWith(u8, output, "\x1b]52;c;QUFB"));
    try std.testing.expect(std.mem.endsWith(u8, output, "QUE=\x1b\\"));
}

test "renderer - clipboard wraps OSC 52 in tmux DCS passthrough" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_renderer = try TestRenderer.createWithEnv(std.testing.allocator, 80, 24, pool, &.{
        .{ .key = "TMUX", .value = "/tmp/tmux-1000/default,12345,0" },
    });
    defer test_renderer.deinit();

    const payload = [_]u8{'A'} ** 2048;
    try std.testing.expect(test_renderer.renderer.copyToClipboardOSC52(.clipboard, &payload));

    // Envelope: "\x1bPtmux;" (7) + bare sequence (base64 + 9) with both inner
    // ESC bytes doubled (+2) + "\x1b\\" (2) = base64 + 20.
    const output = test_renderer.lastOutput();
    try std.testing.expectEqual(std.base64.standard.Encoder.calcSize(payload.len) + 20, output.len);
    try std.testing.expect(std.mem.startsWith(u8, output, "\x1bPtmux;\x1b\x1b]52;c;QUFB"));
    try std.testing.expect(std.mem.endsWith(u8, output, "QUE=\x1b\x1b\\\x1b\\"));
}

test "renderer - clipboard chunks OSC 52 in screen DCS passthrough" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_renderer = try TestRenderer.createWithEnv(std.testing.allocator, 80, 24, pool, &.{
        .{ .key = "STY", .value = "12345.pts-0.host" },
    });
    defer test_renderer.deinit();

    const payload = [_]u8{'A'} ** 2048;
    try std.testing.expect(test_renderer.renderer.copyToClipboardOSC52(.clipboard, &payload));

    // Sequence: base64 (2732) + OSC 52 framing with BEL (8) = 2740 bytes,
    // split into 11 chunks of at most 252 bytes, each wrapped in
    // "\x1bP" .. "\x1b\\" (+4 per chunk) = 2784 total.
    const output = test_renderer.lastOutput();
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
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, pool, &local_link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello World");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);

    _ = cli_renderer.render(false);

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
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, pool, &local_link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Line 1\nLine 2\nLine 3");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);
    _ = cli_renderer.render(false);

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
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, pool, &local_link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hi 👋 there");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);
    _ = cli_renderer.render(false);

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
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, pool, &local_link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello 世界");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);
    _ = cli_renderer.render(false);

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
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, pool, &local_link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("A 😀 世");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);
    _ = cli_renderer.render(false);

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
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    try std.testing.expectEqual(@as(u32, 80), cli_renderer.width);
    try std.testing.expectEqual(@as(u32, 24), cli_renderer.height);

    try cli_renderer.resize(120, 40);

    try std.testing.expectEqual(@as(u32, 120), cli_renderer.width);
    try std.testing.expectEqual(@as(u32, 40), cli_renderer.height);
}

test "renderer - resize clears stale hit grid coordinates" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        4,
        2,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.addToCurrentHitGridClipped(2, 0, 1, 1, 99);
    try std.testing.expectEqual(@as(u32, 99), cli_renderer.checkHit(2, 0));

    try cli_renderer.resize(2, 2);

    try std.testing.expectEqual(@as(u32, 0), cli_renderer.checkHit(0, 1));

    _ = cli_renderer.render(false);
    try std.testing.expect(cli_renderer.getHitGridDirty());
}

test "renderer - background color setting" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
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
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.setBackgroundColor(ansi.rgbaFromFloats(0.1, 0.2, 0.3, 1.0));
    cli_renderer.queryThemeColors();
    try std.testing.expectEqual(ansi.rgbaFromFloats(0.1, 0.2, 0.3, 1.0), cli_renderer.backgroundColor);
}

test "renderer - empty text buffer renders correctly" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, pool, &local_link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);
    _ = cli_renderer.render(false);
}

test "renderer - multiple renders update currentRenderBuffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, pool, &local_link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    try tb.setText("Hello");
    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);
    _ = cli_renderer.render(false);

    var current_buffer = cli_renderer.getCurrentBuffer();
    var first_cell = current_buffer.get(0, 0);
    try std.testing.expect(first_cell != null);
    try std.testing.expectEqual(@as(u32, 'H'), first_cell.?.char);

    try tb.setText("World");
    const next_buffer2 = cli_renderer.getNextBuffer();
    next_buffer2.drawTextBuffer(view, 0, 0);
    _ = cli_renderer.render(false);

    current_buffer = cli_renderer.getCurrentBuffer();
    first_cell = current_buffer.get(0, 0);
    try std.testing.expect(first_cell != null);
    try std.testing.expectEqual(@as(u32, 'W'), first_cell.?.char);
}

test "renderer - 1000 frame render loop with setStyledText" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, pool, &local_link_pool, .unicode);
    defer tb.deinit();

    const style = try ss.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    tb.setSyntaxStyle(style);

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        80,
        24,
        .{ .pool = pool, .width_method = .unicode },
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

    var frame: u32 = 0;
    while (frame < 1000) : (frame += 1) {
        const text_idx = frame % frame_texts.len;
        const text = frame_texts[text_idx];

        const chunks = [_]text_buffer.StyledChunk{.{
            .text_ptr = text.ptr,
            .text_len = text.len,
            .fg_ptr = @ptrCast(&fg_color),
            .bg_ptr = @ptrCast(&bg_color),
            .attributes = 0,
        }};

        try tb.setStyledText(&chunks);
        opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
        opt_buffer.drawTextBuffer(view, 0, 0);

        const next_buffer = cli_renderer.getNextBuffer();
        next_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
        next_buffer.drawFrameBuffer(0, 0, opt_buffer, null, null, null, null);

        _ = cli_renderer.render(false);

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
    const limited_pool = gp.initGlobalPoolWithOptions(std.testing.allocator, .{
        .slots_per_page = [_]u32{ 2, 2, 2, 2, 2 },
    });
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, limited_pool, link.initGlobalLinkPool(std.testing.allocator), .unicode);
    defer tb.deinit();

    const style = try ss.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    tb.setSyntaxStyle(style);

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        limited_pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    var frame_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        80,
        24,
        .{ .pool = limited_pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer frame_buffer.deinit();

    const fg_color = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg_color = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0);

    const text_with_emoji = "👋";
    const chunks = [_]text_buffer.StyledChunk{.{
        .text_ptr = text_with_emoji.ptr,
        .text_len = text_with_emoji.len,
        .fg_ptr = @ptrCast(&fg_color),
        .bg_ptr = @ptrCast(&bg_color),
        .attributes = 0,
    }};
    try tb.setStyledText(&chunks);
    frame_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    frame_buffer.drawTextBuffer(view, 0, 0);

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.setRespectAlpha(false);
    next_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);

    next_buffer.drawFrameBuffer(0, 0, frame_buffer, null, null, null, null);

    frame_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);

    var i: usize = 0;
    while (i < 10) : (i += 1) {
        const new_text = "🎉🚀💯";
        const new_chunks = [_]text_buffer.StyledChunk{.{
            .text_ptr = new_text.ptr,
            .text_len = new_text.len,
            .fg_ptr = @ptrCast(&fg_color),
            .bg_ptr = @ptrCast(&bg_color),
            .attributes = 0,
        }};
        try tb.setStyledText(&new_chunks);
        frame_buffer.drawTextBuffer(view, 0, 0);
        frame_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    }

    _ = cli_renderer.render(false);

    const current_buffer = cli_renderer.getCurrentBuffer();
    const rendered_cell = current_buffer.get(0, 0);
    try std.testing.expect(rendered_cell != null);
}

test "renderer - unchanged grapheme should not churn IDs across frames" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        4,
        1,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);

    const first_next_buffer = cli_renderer.getNextBuffer();
    try first_next_buffer.drawText("👋", 0, 0, fg, bg, 0);
    _ = cli_renderer.render(false);

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

    _ = cli_renderer.render(false);

    const second_output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.find(u8, second_output, "👋") == null);
}

test "renderer - grows frame output instead of committing cells whose ANSI was dropped" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    const width: u32 = 1000;
    const height: u32 = 160;
    for ([_]bool{ false, true }) |threaded| {
        var test_cli_renderer = if (threaded)
            try TestRenderer.createThreadSafe(std.testing.allocator, width, height, pool)
        else
            try TestRenderer.create(std.testing.allocator, width, height, pool);
        defer test_cli_renderer.deinit();
        const cli_renderer = test_cli_renderer.renderer;
        if (threaded) cli_renderer.setUseThread(true);
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

        _ = cli_renderer.render(false);
        if (threaded) cli_renderer.setUseThread(false);
        const output = test_cli_renderer.lastOutput();
        const current = cli_renderer.getCurrentBuffer();

        // Guard that this test actually exercises the growth path: the frame
        // must not fit in the default output buffer.
        try std.testing.expect(output.len > renderer.OUTPUT_BUFFER_SIZE);
        try std.testing.expect(current.get(width - 24, height - 1).?.char == 'F');
        try std.testing.expect(std.mem.find(u8, output, "EARLY_SCROLL_CHANGED") != null);
        try std.testing.expect(std.mem.find(u8, output, "FULL_TOOL_RESULT_MARKER") != null);
    }
}

test "renderer - hyperlinks enabled with OSC 8 output" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.createWithLinkPool(
        std.testing.allocator,
        80,
        24,
        pool,
        &local_link_pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    // Enable hyperlinks capability
    cli_renderer.terminal.caps.hyperlinks = true;

    // Allocate a link
    const link_id = try local_link_pool.alloc("https://example.com");
    const attributes = ansi.TextAttributes.setLinkId(ansi.TextAttributes.BOLD, link_id);

    const next_buffer = cli_renderer.getNextBuffer();

    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("Click here", 0, 0, fg, bg, attributes);

    _ = cli_renderer.render(false);

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
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const local_link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    // Hyperlinks disabled by default
    cli_renderer.terminal.caps.hyperlinks = false;

    // Allocate a link
    const link_id = try local_link_pool.alloc("https://example.com");
    const attributes = ansi.TextAttributes.setLinkId(0, link_id);

    const next_buffer = cli_renderer.getNextBuffer();

    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("Click here", 0, 0, fg, bg, attributes);

    _ = cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();

    // Verify output does NOT contain OSC 8 sequences
    try std.testing.expect(std.mem.find(u8, output, "]8;;") == null);
    try std.testing.expect(std.mem.find(u8, output, "]8;id=") == null);
}

test "renderer - link transition mid-line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const local_link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    // Enable hyperlinks
    cli_renderer.terminal.caps.hyperlinks = true;

    const next_buffer = cli_renderer.getNextBuffer();

    // Allocate two different links
    const link_id1 = try local_link_pool.alloc("https://first.com");
    const link_id2 = try local_link_pool.alloc("https://second.com");

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

    _ = cli_renderer.render(false);

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
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    // Enable hyperlinks
    cli_renderer.terminal.caps.hyperlinks = true;

    const next_buffer = cli_renderer.getNextBuffer();

    // Allocate a single link
    const link_id = try link_pool.alloc("https://example.com/long-url");
    const attributes = ansi.TextAttributes.setLinkId(0, link_id);

    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);

    // Fill entire row 0 with linked text so link is never interrupted by empty cells
    try next_buffer.drawText("01234567890123456789012345678901234567890123456789012345678901234567890123456789", 0, 0, fg, bg, attributes);
    // Continue the same link on row 1
    try next_buffer.drawText("Here", 0, 1, fg, bg, attributes);

    _ = cli_renderer.render(false);

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
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        4,
        1,
        pool,
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

    _ = cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.find(u8, output, "\x1b[39m") != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b[38;5;6m") != null);
}

test "renderer - indexed snapshots fall back to rgb and explicit bg default resets without ansi256" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        2,
        1,
        pool,
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

    _ = cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.find(u8, output, "\x1b[38;2;51;102;153m") != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b[38;5;6m") == null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b[49m") != null);
}

test "renderer - rgb colors fall back to ANSI256 mapping when rgb is unavailable" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        2,
        1,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.rgb = false;
    cli_renderer.terminal.caps.ansi256 = true;

    const next_buffer = cli_renderer.getNextBuffer();
    try next_buffer.drawText("A", 0, 0, ansi.rgbaFromFloats(0.95, 0.1, 0.1, 1.0), ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 0);

    _ = cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.find(u8, output, "\x1b[38;5;") != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b[38;2;") == null);
}

test "renderer - rgb fallback uses published palette state" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        2,
        1,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.rgb = false;
    cli_renderer.terminal.caps.ansi256 = true;

    const target = ansi.rgbaFromFloats(0.3, 0.6, 0.9, 1.0);
    var palette = [_]RGBA{ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0)} ** 256;
    palette[42] = target;
    cli_renderer.setPaletteState(palette[0..], ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0), ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 1);

    const next_buffer = cli_renderer.getNextBuffer();
    try next_buffer.drawText("A", 0, 0, target, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 0);

    _ = cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.find(u8, output, "\x1b[38;5;42m") != null);
}

test "renderer - palette epoch changes force repaint and use new palette mapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        2,
        1,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.rgb = false;
    cli_renderer.terminal.caps.ansi256 = true;

    const target = ansi.rgbaFromFloats(0.3, 0.6, 0.9, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);

    var palette_a = [_]RGBA{ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0)} ** 256;
    palette_a[42] = target;
    cli_renderer.setPaletteState(palette_a[0..], ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0), bg, 1);

    const next_buffer = cli_renderer.getNextBuffer();
    try next_buffer.drawText("A", 0, 0, target, bg, 0);
    _ = cli_renderer.render(false);

    const first_output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.find(u8, first_output, "\x1b[38;5;42m") != null);

    try next_buffer.drawText("A", 0, 0, target, bg, 0);
    _ = cli_renderer.render(false);

    const second_output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.find(u8, second_output, "A") == null);

    var palette_b = [_]RGBA{ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0)} ** 256;
    palette_b[77] = target;
    cli_renderer.setPaletteState(palette_b[0..], ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0), bg, 2);

    try next_buffer.drawText("A", 0, 0, target, bg, 0);
    _ = cli_renderer.render(false);

    const third_output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.find(u8, third_output, "A") != null);
    try std.testing.expect(std.mem.find(u8, third_output, "\x1b[38;5;77m") != null);
}

test "renderer - transparent rgb backgrounds still emit 49 reset" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        2,
        1,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.rgb = true;

    const next_buffer = cli_renderer.getNextBuffer();
    try next_buffer.drawText("A", 0, 0, ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0), ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.find(u8, output, "\x1b[49m") != null);
}

// ============================================================================
// GRAPHEME CURSOR POSITIONING TESTS
// ============================================================================

test "renderer - default cursor style emits reset cursor ANSI" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.setCursorPosition(4, 2, true);
    _ = cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();

    try std.testing.expect(std.mem.find(u8, output, ansi.ANSI.defaultCursorStyle) != null);
    try std.testing.expect(std.mem.find(u8, output, ansi.ANSI.cursorBlock) == null);
}

test "renderer - explicit_cursor_positioning emits cursor move after wide graphemes" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, pool, &local_link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("👋X");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.explicit_cursor_positioning = true;
    cli_renderer.terminal.caps.explicit_width = false;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);

    _ = cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();

    try std.testing.expect(std.mem.find(u8, output, "\x1b[1;3H") != null);
}

test "renderer - explicit_cursor_positioning produces more cursor moves" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, pool, &local_link_pool, .unicode);
    defer tb.deinit();
    try tb.setText("👋🎉🚀");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer1 = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer1.deinit();
    const cli_renderer1 = test_cli_renderer1.renderer;

    cli_renderer1.terminal.caps.explicit_cursor_positioning = false;
    cli_renderer1.terminal.caps.explicit_width = false;

    const next_buffer1 = cli_renderer1.getNextBuffer();
    next_buffer1.drawTextBuffer(view, 0, 0);
    _ = cli_renderer1.render(false);
    const output_without = test_cli_renderer1.lastOutput();

    var test_cli_renderer2 = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer2.deinit();
    const cli_renderer2 = test_cli_renderer2.renderer;

    cli_renderer2.terminal.caps.explicit_cursor_positioning = true;
    cli_renderer2.terminal.caps.explicit_width = false;

    const next_buffer2 = cli_renderer2.getNextBuffer();
    next_buffer2.drawTextBuffer(view, 0, 0);
    _ = cli_renderer2.render(false);
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
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, pool, &local_link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("世X");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.explicit_cursor_positioning = true;
    cli_renderer.terminal.caps.explicit_width = false;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);

    _ = cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();

    try std.testing.expect(std.mem.find(u8, output, "\x1b[1;3H") != null);
}

test "renderer - commitSplitFooterSnapshot writes append before footer repaint in one output" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        12,
        3,
        pool,
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
        11,
        1,
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer snapshot.deinit();

    snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 32);
    try snapshot.drawText("append-line", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    const appended = "append-line";
    // This test documents the critical ordering contract:
    // 1) append payload is emitted in the same sync frame as repaint
    // 2) DECSTBM is active only during append when pinned
    // 3) footer repaint cursor move happens after append payload
    _ = cli_renderer.commitSplitFooterSnapshotBatched(snapshot, 11, false, true, 2, false, true, true);

    const output = test_cli_renderer.lastOutput();
    const append_index = std.mem.find(u8, output, appended);
    const scroll_region_set_index = std.mem.find(u8, output, "\x1b[1;2r");
    const scroll_region_reset_index = std.mem.find(u8, output, "\x1b[r");
    const sync_index = std.mem.find(u8, output, ansi.ANSI.syncSet);
    const footer_move_after_sync = if (sync_index) |sync_start|
        std.mem.find(u8, output[sync_start + ansi.ANSI.syncSet.len ..], "\x1b[3;1H")
    else
        null;

    try std.testing.expect(append_index != null);
    try std.testing.expect(scroll_region_set_index != null);
    try std.testing.expect(scroll_region_reset_index != null);
    try std.testing.expect(sync_index != null);
    try std.testing.expect(footer_move_after_sync != null);
    try std.testing.expect(sync_index.? < append_index.?);
    try std.testing.expect(scroll_region_set_index.? < append_index.?);
    try std.testing.expect(append_index.? < scroll_region_reset_index.?);

    var sync_count: usize = 0;
    var pos: usize = 0;
    while (std.mem.find(u8, output[pos..], ansi.ANSI.syncSet)) |found| {
        sync_count += 1;
        pos += found + ansi.ANSI.syncSet.len;
    }

    try std.testing.expectEqual(@as(usize, 1), sync_count);
}

test "renderer - pinned split scrollback repaints live native images after append" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 3, pool);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const image_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    test_renderer.renderer.terminal.caps.kitty_graphics = true;
    _ = test_renderer.renderer.resetSplitScrollback(2, 2);

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .kitty));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));

    var snapshot = try OptimizedBuffer.init(std.testing.allocator, 4, 1, .{ .pool = pool });
    defer snapshot.deinit();
    try snapshot.drawText("line", 0, 0, .{ 255, 255, 255, 255 }, null, 0);

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .kitty));
    const result = test_renderer.renderer.commitSplitFooterSnapshotBatched(snapshot, 4, false, true, 2, false, true, true);
    try std.testing.expectEqual(renderer.RenderStatus.rendered, result.status);

    const output = test_renderer.memory.lastWrite();
    const append_index = std.mem.find(u8, output, "line") orelse return error.TestUnexpectedResult;
    const placement_index = std.mem.find(u8, output, "\x1b_Ga=p") orelse return error.TestUnexpectedResult;
    try std.testing.expect(placement_index > append_index);
}

test "renderer - split scrollback materializes image fallback cells" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 3, pool);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const image_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    const snapshot = try OptimizedBuffer.init(std.testing.allocator, 2, 1, .{ .pool = pool, .link_pool = &local_link_pool });
    defer snapshot.deinit();
    try std.testing.expect(try snapshot.drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));
    try snapshot.drawText("X", 1, 0, .{ 255, 255, 255, 255 }, null, 0);
    _ = test_renderer.renderer.resetSplitScrollback(2, 2);
    _ = test_renderer.renderer.commitSplitFooterSnapshotBatched(snapshot, 2, false, true, 2, false, true, true);
    const output = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.findScalar(u8, output, 'X') != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b_G") == null);
    try std.testing.expect(std.mem.find(u8, output, "\x1bP0;1;0q") == null);
    try std.testing.expect(std.mem.find(u8, output, "█") != null);
}

test "renderer - split scrollback uses native Kitty when Kitty is selected" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 3, pool);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const image_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    test_renderer.renderer.terminal.processCapabilityResponse("\x1b_Gi=31337;OK\x1b\\");
    var snapshot = try OptimizedBuffer.init(std.testing.allocator, 1, 1, .{ .pool = pool, .link_pool = &local_link_pool });
    defer snapshot.deinit();
    snapshot.clear(ansi.rgbColor(1, 2, 3, 255), null);
    try std.testing.expect(try snapshot.drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));
    _ = test_renderer.renderer.resetSplitScrollback(2, 2);

    const result = test_renderer.renderer.commitSplitFooterSnapshotBatched(snapshot, 1, false, true, 2, false, true, true);
    try std.testing.expectEqual(renderer.RenderStatus.rendered, result.status);

    const output = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, output, "\x1b_Ga=t") != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b_Ga=p") != null);
    try std.testing.expect(std.mem.find(u8, output, ",U=1,") == null);
    try std.testing.expect(std.mem.find(u8, output, "\u{10EEEE}") == null);
    try std.testing.expect(std.mem.find(u8, output, "█") == null);
    try std.testing.expect(std.mem.find(u8, output, "48;2;1;2;3") == null);
}

test "renderer - split scrollback images remain addressable before and across pinning" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const image_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }

    for ([_]bool{ false, true }) |sixel| {
        for ([_]u32{ 0, 2, 5, 6 }) |seed_rows| {
            for ([_]u32{ 1, 4, 6, 7 }) |height| {
                var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 3, pool);
                defer test_renderer.deinit();
                test_renderer.renderer.terminal.caps.kitty_graphics = !sixel;
                test_renderer.renderer.terminal.caps.sixel = sixel;
                const snapshot = try OptimizedBuffer.init(std.testing.allocator, 4, height + 2, .{ .pool = pool, .link_pool = &local_link_pool });
                defer snapshot.deinit();
                try snapshot.drawText("top", 0, 0, .{ 255, 255, 255, 255 }, null, 0);
                try std.testing.expect(try snapshot.drawImage(value, image_handle, 0, 1, 2, height, 4, height * 2, 0, 0, 1, 1, .auto));
                try snapshot.drawText("end", 0, @intCast(height + 1), .{ 255, 255, 255, 255 }, null, 0);
                _ = test_renderer.renderer.resetSplitScrollback(seed_rows, 6);

                const result = test_renderer.renderer.commitSplitFooterSnapshotBatched(snapshot, 4, true, true, 6, false, true, true);
                try std.testing.expectEqual(renderer.RenderStatus.rendered, result.status);
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
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 3, pool);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{
        255, 0, 0, 255, 0, 0, 255, 255,
    }, 2, 1, 8);
    const image_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    test_renderer.renderer.terminal.processCapabilityResponse("\x1bP>|kitty(0.40.1)\x1b\\\x1b_Gi=31337;OK\x1b\\");
    var snapshot = try OptimizedBuffer.init(std.testing.allocator, 1, 1, .{ .pool = pool, .link_pool = &local_link_pool });
    defer snapshot.deinit();
    try std.testing.expect(try snapshot.drawImage(value, image_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));
    _ = test_renderer.renderer.resetSplitScrollback(2, 2);
    test_renderer.renderer.kittyHistoryNextImageId = std.math.maxInt(u32);
    const split_scrollback = test_renderer.renderer.splitScrollback;
    const render_offset = test_renderer.renderer.renderOffset;

    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0 });
    test_renderer.renderer.allocator = failing.allocator();
    const result = test_renderer.renderer.commitSplitFooterSnapshotBatched(snapshot, 1, false, true, 2, false, true, true);
    test_renderer.renderer.allocator = std.testing.allocator;

    try std.testing.expect(failing.has_induced_failure);
    try std.testing.expectEqual(renderer.RenderStatus.failed, result.status);
    try std.testing.expectEqual(@as(usize, 0), test_renderer.memory.lastWrite().len);
    try std.testing.expectEqualDeep(split_scrollback, test_renderer.renderer.splitScrollback);
    try std.testing.expectEqual(render_offset, test_renderer.renderer.renderOffset);
    try std.testing.expectEqual(@as(usize, 1), snapshot.image_placements.items.len);
    try std.testing.expectEqual(@as(?u32, std.math.maxInt(u32)), test_renderer.renderer.kittyHistoryNextImageId);

    const retry = test_renderer.renderer.commitSplitFooterSnapshotBatched(snapshot, 1, false, true, 2, false, true, true);
    try std.testing.expectEqual(renderer.RenderStatus.rendered, retry.status);
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1b_Ga=t") != null);
}

test "renderer - split scrollback emits native Sixel images when placement geometry is available" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 3, pool);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const image_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    test_renderer.renderer.terminal.caps.sixel = true;
    var snapshot = try OptimizedBuffer.init(std.testing.allocator, 1, 1, .{ .pool = pool, .link_pool = &local_link_pool });
    defer snapshot.deinit();
    try std.testing.expect(try snapshot.drawImage(value, image_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    _ = test_renderer.renderer.resetSplitScrollback(2, 2);

    const result = test_renderer.renderer.commitSplitFooterSnapshotBatched(snapshot, 1, false, true, 2, false, true, true);
    try std.testing.expectEqual(renderer.RenderStatus.rendered, result.status);

    const output = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, output, "\x1bP0;1;0q") != null);
    try std.testing.expect(std.mem.find(u8, output, ansi.ANSI.saveCursorState) != null);
    try std.testing.expect(std.mem.find(u8, output, ansi.ANSI.restoreCursorState) != null);
    try std.testing.expect(std.mem.find(u8, output, "█") == null);

    var covered = try OptimizedBuffer.init(std.testing.allocator, 1, 1, .{ .pool = pool, .link_pool = &local_link_pool });
    defer covered.deinit();
    try std.testing.expect(try covered.drawImage(value, image_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    try covered.drawText("X", 0, 0, .{ 255, 255, 255, 255 }, null, 0);
    const covered_result = test_renderer.renderer.commitSplitFooterSnapshotBatched(covered, 1, false, true, 2, false, true, true);
    try std.testing.expectEqual(renderer.RenderStatus.rendered, covered_result.status);
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q") == null);
    try std.testing.expect(std.mem.findScalar(u8, test_renderer.memory.lastWrite(), 'X') != null);
}

test "renderer - commitSplitFooterSnapshot settling phase moves footer downward" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        12,
        3,
        pool,
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
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer snapshot.deinit();

    snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 32);
    try snapshot.drawText("settle", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    const appended = "settle";
    // During settling we intentionally avoid bounded DECSTBM and instead clear rows
    // that transition from footer surface to scrollback before append.
    _ = cli_renderer.commitSplitFooterSnapshotBatched(snapshot, 6, false, true, 3, false, true, true);

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

test "renderer - commitSplitFooterSnapshot multiline settling enables bounded scroll at pin" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        12,
        3,
        pool,
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
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer snapshot.deinit();

    snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 32);
    try snapshot.drawText("line-a", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try snapshot.drawText("line-b", 0, 1, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = cli_renderer.commitSplitFooterSnapshotBatched(snapshot, 6, false, true, 3, false, true, true);

    const output = test_cli_renderer.lastOutput();
    const expanded_region_index = std.mem.find(u8, output, "\x1b[1;3r");
    const collapsed_region_index = std.mem.find(u8, output, "\x1b[r");

    try std.testing.expectEqual(@as(u32, 3), cli_renderer.renderOffset);
    try std.testing.expect(expanded_region_index != null);
    try std.testing.expect(collapsed_region_index != null);
    try std.testing.expect(expanded_region_index.? < collapsed_region_index.?);
}

test "renderer - commitSplitFooterSnapshot multiline short final row keeps continuation column" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        20,
        4,
        pool,
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
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer first_snapshot.deinit();

    first_snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try first_snapshot.drawText("1234567890123456", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try first_snapshot.drawText("short", 0, 2, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = cli_renderer.commitSplitFooterSnapshotBatched(first_snapshot, 16, false, false, 2, false, true, true);

    try std.testing.expectEqual(@as(u32, 5), cli_renderer.splitScrollback.tail_column);

    var second_snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        1,
        1,
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer second_snapshot.deinit();

    second_snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try second_snapshot.drawText(",", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = cli_renderer.commitSplitFooterSnapshotBatched(second_snapshot, 1, false, false, 2, false, true, true);

    const output = test_cli_renderer.lastOutput();
    const move_index = std.mem.find(u8, output, "\x1b[2;6H");
    const comma_index = std.mem.find(u8, output, ",");

    try std.testing.expect(move_index != null);
    try std.testing.expect(comma_index != null);
    try std.testing.expect(move_index.? < comma_index.?);
    try std.testing.expect(std.mem.find(u8, output, "\x1b[2;17H") == null);
}

test "renderer - commitSplitFooterSnapshot exact-width continuation preserves autowrap" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        20,
        4,
        pool,
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
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer first_snapshot.deinit();

    first_snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try first_snapshot.drawText("12345678901234567890", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = cli_renderer.commitSplitFooterSnapshotBatched(first_snapshot, 20, false, false, 2, false, true, true);

    var second_snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        8,
        1,
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer second_snapshot.deinit();

    second_snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try second_snapshot.drawText(" letters", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = cli_renderer.commitSplitFooterSnapshotBatched(second_snapshot, 8, false, false, 2, false, true, true);

    const output = test_cli_renderer.lastOutput();
    const wrap_index = std.mem.find(u8, output, "\x1b[2;20H\r\n");
    const text_index = std.mem.find(u8, output, " letters");

    try std.testing.expectEqual(@as(u32, 8), cli_renderer.splitScrollback.tail_column);
    try std.testing.expect(wrap_index != null);
    try std.testing.expect(text_index != null);
    try std.testing.expect(wrap_index.? < text_index.?);
}

test "renderer - commitSplitFooterSnapshot does not emit continuation spaces for wide graphemes" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        12,
        4,
        pool,
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
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer snapshot.deinit();

    snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try snapshot.drawText("│甲│乙│丙│", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try snapshot.drawText("│😀│🚀│🧪│", 0, 1, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = cli_renderer.commitSplitFooterSnapshotBatched(snapshot, 10, false, false, 2, false, true, true);

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

test "renderer - repaintSplitFooter repaints footer without append payload" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        12,
        3,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    _ = cli_renderer.resetSplitScrollback(2, 2);

    const next_buffer = cli_renderer.getNextBuffer();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

    _ = cli_renderer.repaintSplitFooter(2, true);

    const output = test_cli_renderer.lastOutput();
    const footer_text_index = std.mem.find(u8, output, "FOOT");
    const footer_clear_index = std.mem.find(u8, output, "\x1b[3;1H\x1b[2K");
    const footer_erase_below_index = std.mem.find(u8, output, "\x1b[3;1H\x1b[J");
    const sync_index = std.mem.find(u8, output, ansi.ANSI.syncSet);

    try std.testing.expect(footer_text_index != null);
    try std.testing.expect(footer_clear_index == null);
    try std.testing.expect(footer_erase_below_index == null);
    try std.testing.expect(sync_index != null);
    try std.testing.expect(sync_index.? < footer_text_index.?);
}

test "renderer - repaintSplitFooter applies pending viewport scroll transition in one frame" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        12,
        1,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    _ = cli_renderer.resetSplitScrollback(4, 4);
    cli_renderer.setRenderOffset(3);
    cli_renderer.setPendingSplitFooterTransition(.viewport_scroll, 4, 2, 5, 1, 1);

    const next_buffer = cli_renderer.getNextBuffer();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

    _ = cli_renderer.repaintSplitFooter(4, true);

    const output = test_cli_renderer.lastOutput();
    const sync_index = std.mem.find(u8, output, ansi.ANSI.syncSet);
    const scroll_index = std.mem.find(u8, output, "\x1b[1T");
    const footer_move_index = std.mem.find(u8, output, "\x1b[5;1H");
    const footer_text_index = std.mem.find(u8, output, "FOOT");

    try std.testing.expect(sync_index != null);
    try std.testing.expect(scroll_index != null);
    try std.testing.expect(footer_move_index != null);
    try std.testing.expect(footer_text_index != null);
    try std.testing.expect(sync_index.? < scroll_index.?);
    try std.testing.expect(scroll_index.? < footer_move_index.?);
    try std.testing.expect(footer_move_index.? < footer_text_index.?);
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, output, ansi.ANSI.syncSet));
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, output, ansi.ANSI.syncReset));
}

test "renderer - repaintSplitFooter viewport scroll uses explicit split scroll delta when gap already exists" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        12,
        8,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    _ = cli_renderer.resetSplitScrollback(6, 6);
    cli_renderer.splitScrollback.noteViewportScroll(2);
    cli_renderer.setRenderOffset(6);
    cli_renderer.setPendingSplitFooterTransition(.viewport_scroll, 7, 4, 3, 8, 2);

    const next_buffer = cli_renderer.getNextBuffer();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

    _ = cli_renderer.repaintSplitFooter(2, true);

    const output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.find(u8, output, "\x1b[2S") != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b[4S") == null);
    try std.testing.expectEqual(@as(u32, 2), cli_renderer.getSplitOutputOffset(2));
}

test "renderer - repaintSplitFooter applies pending stale row clear transition in one frame" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        12,
        3,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    _ = cli_renderer.resetSplitScrollback(1, 7);
    cli_renderer.setPendingSplitFooterTransition(.clear_stale_rows, 2, 4, 2, 3, 0);

    const next_buffer = cli_renderer.getNextBuffer();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

    _ = cli_renderer.repaintSplitFooter(7, true);

    const output = test_cli_renderer.lastOutput();
    const sync_index = std.mem.find(u8, output, ansi.ANSI.syncSet);
    const clear_index = std.mem.find(u8, output, "\x1b[5;1H\x1b[2K");
    const footer_text_index = std.mem.find(u8, output, "FOOT");

    try std.testing.expect(sync_index != null);
    try std.testing.expect(clear_index != null);
    try std.testing.expect(footer_text_index != null);
    try std.testing.expect(sync_index.? < clear_index.?);
    try std.testing.expect(clear_index.? < footer_text_index.?);
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, output, ansi.ANSI.syncSet));
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, output, ansi.ANSI.syncReset));
}

test "renderer - commitSplitFooterSnapshot appends styled snapshot with snapshot links before footer repaint" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var renderer_links = link.LinkPool.init(std.testing.allocator);
    defer renderer_links.deinit();
    var snapshot_links = link.LinkPool.init(std.testing.allocator);
    defer snapshot_links.deinit();

    var test_cli_renderer = try TestRenderer.createWithLinkPool(
        std.testing.allocator,
        16,
        4,
        pool,
        &renderer_links,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.rgb = true;
    cli_renderer.terminal.caps.ansi256 = true;
    cli_renderer.terminal.caps.hyperlinks = true;

    const renderer_link_id = try renderer_links.alloc("https://renderer.invalid");
    const snapshot_link_id = try snapshot_links.alloc("https://snapshot.example");
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
        .{ .pool = pool, .link_pool = &snapshot_links, .width_method = .unicode, .respectAlpha = false },
    );
    defer snapshot.deinit();

    snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 32);
    try snapshot.drawText("SNAP", 0, 0, ansi.rgbaFromFloats(1.0, 0.5, 0.0, 1.0), ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), ansi.TextAttributes.BOLD);
    const link_attributes = ansi.TextAttributes.setLinkId(0, snapshot_link_id);
    try snapshot.drawText("SHOT", 0, 1, ansi.rgbaFromFloats(0.2, 0.8, 0.9, 1.0), ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), link_attributes);

    _ = cli_renderer.commitSplitFooterSnapshotBatched(snapshot, 8, true, true, 2, false, true, true);

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

test "renderer - commitSplitFooterSnapshot preserves indexed and default color tags" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        8,
        4,
        pool,
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
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
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

    _ = cli_renderer.commitSplitFooterSnapshotBatched(snapshot, 2, true, false, 2, false, true, true);

    const output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.find(u8, output, "A") != null);
    try std.testing.expect(std.mem.find(u8, output, "B") != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b[39m") != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b[38;5;6m") != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b[49m") != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b[38;2;51;102;153m") == null);
}

test "renderer - commitSplitFooterSnapshot does not emit NUL padding for short rows" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        20,
        4,
        pool,
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
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer snapshot.deinit();

    snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 32);
    try snapshot.drawText("[tool:bash] Shell", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try snapshot.drawText("$ pwd", 0, 1, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = cli_renderer.commitSplitFooterSnapshotBatched(snapshot, 16, true, true, 2, false, true, true);

    const output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.findScalar(u8, output, 0) == null);
    try std.testing.expect(std.mem.find(u8, output, ansi.ANSI.eraseToEndOfLine) != null);
    try std.testing.expect(std.mem.find(u8, output, "\r\n\x1b[0m\x1b[K") != null);
}

test "renderer - batched split commits share single sync frame" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        16,
        4,
        pool,
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
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer first_snapshot.deinit();
    first_snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 32);
    try first_snapshot.drawText("FIRST", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    var second_snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        1,
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer second_snapshot.deinit();
    second_snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 32);
    try second_snapshot.drawText("SECOND", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = cli_renderer.commitSplitFooterSnapshotBatched(
        first_snapshot,
        10,
        true,
        true,
        2,
        false,
        true,
        false,
    );

    _ = cli_renderer.commitSplitFooterSnapshotBatched(
        second_snapshot,
        10,
        true,
        true,
        2,
        false,
        false,
        true,
    );

    const output = test_cli_renderer.lastOutput();
    // Batching should keep both commits inside one synchronized update envelope.
    try std.testing.expect(std.mem.find(u8, output, "FIRST") != null);
    try std.testing.expect(std.mem.find(u8, output, "SECOND") != null);
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, output, ansi.ANSI.syncSet));
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, output, ansi.ANSI.syncReset));
}

test "renderer - unchanged frame with unchanged cursor emits no output" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        12,
        4,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.setCursorPosition(3, 2, true);
    _ = cli_renderer.render(false);

    _ = cli_renderer.render(false);
    const output = test_cli_renderer.lastOutput();

    // No-op frames must be byte-empty; otherwise repeated sync/cursor toggles can
    // produce visible shimmer in terminals that animate cursor or repaint eagerly.
    try std.testing.expectEqual(@as(usize, 0), output.len);
}

test "renderer - buffered debug dump includes non-threaded last render" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        12,
        4,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;
    try std.testing.expect(!cli_renderer.backend.isUseThread());

    const fg = RGBA{ 1.0, 1.0, 1.0, 1.0 };
    const bg = RGBA{ 0.0, 0.0, 0.0, 1.0 };
    const next_buffer = cli_renderer.getNextBuffer();
    try next_buffer.drawText("DUMP", 0, 0, fg, bg, 0);

    _ = cli_renderer.render(false);

    var dump_buf: [4096]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&dump_buf);
    cli_renderer.backend.dumpTo(&writer);
    const dump = writer.buffered();

    try std.testing.expect(std.mem.find(u8, dump, "DUMP") != null);
    try std.testing.expect(std.mem.find(u8, dump, "(no output rendered yet)") == null);
}

// ---- FeedBackend tests ----

const native_span_feed = @import("../native-span-feed.zig");

test "FeedBackend - renderer writes through feed" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    _ = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    const feed = try native_span_feed.Stream.create(std.testing.allocator, null);
    var cli_renderer = try CliRenderer.createWithOptions(std.testing.allocator, 80, 24, pool, .{
        .remote_mode = .remote,
        .output = .{ .feed = feed },
    });
    // LIFO: renderer destroys first (needs the feed alive for shutdown writes).
    defer feed.destroy();
    defer cli_renderer.destroy();

    const fg = RGBA{ 1.0, 1.0, 1.0, 1.0 };
    const bg = RGBA{ 0.0, 0.0, 0.0, 1.0 };
    const next_buffer = cli_renderer.getNextBuffer();
    try next_buffer.drawText("Hello", 0, 0, fg, bg, 0);

    _ = cli_renderer.render(false);

    var span_out: [32]native_span_feed.SpanInfo = undefined;
    const count = feed.drainSpans(&span_out);
    try std.testing.expect(count > 0);

    var total_bytes: usize = 0;
    var found_hello = false;
    for (span_out[0..count]) |span| {
        total_bytes += span.len;
        const slice = span.slice();
        if (std.mem.find(u8, slice, "Hello") != null) {
            found_hello = true;
        }
    }
    try std.testing.expect(total_bytes > 0);
    try std.testing.expect(found_hello);
}

test "FeedBackend - shouldSkipFrame when span queue saturated" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    _ = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    // Create a feed with a very small span queue so we can saturate it easily.
    var opts = native_span_feed.defaultOptions();
    opts.span_queue_capacity = 2;
    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    var cli_renderer = try CliRenderer.createWithOptions(std.testing.allocator, 80, 24, pool, .{
        .remote_mode = .remote,
        .output = .{ .feed = feed },
    });
    // LIFO: renderer destroys first.
    defer feed.destroy();
    defer cli_renderer.destroy();

    // Render a few frames to build up pending spans. Each render commits one
    // span, so after 2 renders without draining we should be at capacity.
    const fg = RGBA{ 1.0, 1.0, 1.0, 1.0 };
    const bg = RGBA{ 0.0, 0.0, 0.0, 1.0 };
    const next_buffer = cli_renderer.getNextBuffer();
    try next_buffer.drawText("A", 0, 0, fg, bg, 0);
    _ = cli_renderer.render(false);

    try next_buffer.drawText("B", 0, 0, fg, bg, 0);
    _ = cli_renderer.render(false);

    try std.testing.expect(cli_renderer.backend.shouldSkipFrame());

    // Catch-up semantics: a skipped render must NOT advance lastRenderTime,
    // so the next non-skipped frame sees the full accumulated delta.
    const before = cli_renderer.lastRenderTime;
    try next_buffer.drawText("C", 0, 0, fg, bg, 0);
    const status = cli_renderer.render(false);
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
    var backend = renderer.FeedBackend.create(feed);
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

test "FeedBackend - split control batches bypass high water but retain atomic limits" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    _ = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    for ([_]bool{ false, true }) |bounded| {
        var opts = native_span_feed.defaultOptions();
        opts.chunk_size = 64;
        opts.initial_chunks = 1;
        opts.span_queue_capacity = 1;
        opts.max_bytes = if (bounded) 64 else 0;
        const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
        defer feed.destroy();
        const cli_renderer = try CliRenderer.createWithOptions(std.testing.allocator, 20, 4, pool, .{
            .remote_mode = .remote,
            .output = .{ .feed = feed },
        });
        defer cli_renderer.destroy();
        const snapshot = try OptimizedBuffer.init(std.testing.allocator, 16, 1, .{
            .pool = pool,
            .width_method = .unicode,
        });
        defer snapshot.deinit();
        const text = "captured-text";
        try snapshot.drawText(text, 0, 0, .{ 1, 1, 1, 1 }, null, 0);
        try feed.writeAtomic("held");
        var held: [1]native_span_feed.SpanInfo = undefined;
        try std.testing.expectEqual(@as(u32, 1), feed.drainSpans(&held));
        try std.testing.expectEqual(@as(u32, 0), feed.getStats().pending_spans);

        const ordinary = cli_renderer.commitSplitFooterSnapshotBatched(snapshot, text.len, false, true, 3, false, true, true);
        try std.testing.expectEqual(renderer.RenderStatus.skipped, ordinary.status);
        const before = cli_renderer.splitScrollback;
        const control = cli_renderer.commitSplitFooterSnapshotWithOptions(
            snapshot,
            text.len,
            false,
            true,
            3,
            false,
            .{ .control_output = true },
        );
        try std.testing.expectEqual(if (bounded) renderer.RenderStatus.failed else .rendered, control.status);
        try std.testing.expectEqualStrings("held", held[0].slice());
        try std.testing.expectEqual(.skipped, cli_renderer.backend.prepareFrame());

        var spans: [32]native_span_feed.SpanInfo = undefined;
        const count = feed.drainSpans(&spans);
        if (bounded) {
            try std.testing.expectEqual(@as(u32, 0), count);
            try std.testing.expectEqual(before, cli_renderer.splitScrollback);
        } else {
            var bytes: [2048]u8 = undefined;
            var writer: std.Io.Writer = .fixed(&bytes);
            for (spans[0..count]) |span| try writer.writeAll(span.slice());
            try std.testing.expect(std.mem.find(u8, writer.buffered(), text) != null);
        }
        for (spans[0..count]) |span| feed.markSpanConsumed(span);
        feed.markSpanConsumed(held[0]);
        try std.testing.expectEqual(.ok, cli_renderer.backend.prepareFrame());
    }
}

test "FeedBackend - prepareFrame commits existing pending bytes before new frames" {
    var opts = native_span_feed.defaultOptions();
    opts.chunk_size = 64;
    opts.initial_chunks = 1;
    opts.auto_commit_on_full = 0;

    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    defer feed.destroy();

    var backend = renderer.FeedBackend.create(feed);

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
    opts.growth_policy = @intFromEnum(native_span_feed.GrowthPolicy.block);
    opts.auto_commit_on_full = 0;

    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    defer feed.destroy();

    var backend = renderer.FeedBackend.create(feed);
    defer backend.deinit();

    backend.beginFrame();
    var failed_writer = backend.writer();
    try failed_writer.writeAll("pending");
    try failed_writer.writeAll("this-write-is-too-large-for-the-current-chunk");
    try std.testing.expectEqual(.failed, backend.endFrame());

    var span_out: [4]native_span_feed.SpanInfo = undefined;
    const count = feed.drainSpans(&span_out);
    try std.testing.expectEqual(@as(u32, 0), count);
}

test "FeedBackend - failed split batch restores unpublished scrollback state" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    _ = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var opts = native_span_feed.defaultOptions();
    opts.chunk_size = 64;
    opts.initial_chunks = 1;
    opts.max_bytes = 64;
    opts.growth_policy = @intFromEnum(native_span_feed.GrowthPolicy.block);
    opts.auto_commit_on_full = 0;
    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    var cli_renderer = try CliRenderer.createWithOptions(std.testing.allocator, 40, 4, pool, .{
        .remote_mode = .remote,
        .output = .{ .feed = feed },
    });
    defer feed.destroy();
    defer cli_renderer.destroy();

    var snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        32,
        1,
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer snapshot.deinit();
    try snapshot.drawText("first split batch row", 0, 0, .{ 255, 255, 255, 255 }, null, 0);

    _ = cli_renderer.resetSplitScrollback(1, 3);
    const before_scrollback = cli_renderer.splitScrollback;
    const before_offset = cli_renderer.renderOffset;

    const first = cli_renderer.commitSplitFooterSnapshotBatched(snapshot, 32, false, true, 3, false, true, false);
    try std.testing.expectEqual(renderer.RenderStatus.rendered, first.status);
    const final = cli_renderer.commitSplitFooterSnapshotBatched(snapshot, 32, false, true, 3, false, false, true);
    try std.testing.expectEqual(renderer.RenderStatus.failed, final.status);

    try std.testing.expectEqual(before_scrollback, cli_renderer.splitScrollback);
    try std.testing.expectEqual(before_offset, cli_renderer.renderOffset);
    var spans: [4]native_span_feed.SpanInfo = undefined;
    try std.testing.expectEqual(@as(u32, 0), feed.drainSpans(&spans));
}

test "FeedBackend - failed split repaint restores unpublished transition state" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    _ = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var opts = native_span_feed.defaultOptions();
    opts.chunk_size = 32;
    opts.initial_chunks = 4;
    opts.max_bytes = 128;
    opts.growth_policy = @intFromEnum(native_span_feed.GrowthPolicy.block);
    opts.auto_commit_on_full = 0;
    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    var cli_renderer = try CliRenderer.createWithOptions(std.testing.allocator, 4, 2, pool, .{
        .remote_mode = .remote,
        .output = .{ .feed = feed },
        .clearOnShutdown = false,
    });
    defer feed.destroy();
    defer cli_renderer.destroy();

    _ = cli_renderer.resetSplitScrollback(2, 2);
    cli_renderer.setPendingSplitFooterTransition(.viewport_scroll, 1, 1, 2, 1, 1);
    const before_scrollback = cli_renderer.splitScrollback;
    const before_offset = cli_renderer.renderOffset;
    const before_transition = cli_renderer.pendingSplitFooterTransition;

    const blocker = [_]u8{'x'} ** 65;
    try feed.writeAtomic(&blocker);
    const result = cli_renderer.repaintSplitFooter(2, true);
    try std.testing.expectEqual(renderer.RenderStatus.failed, result.status);
    try std.testing.expectEqual(before_scrollback, cli_renderer.splitScrollback);
    try std.testing.expectEqual(before_offset, cli_renderer.renderOffset);
    try std.testing.expectEqual(before_transition, cli_renderer.pendingSplitFooterTransition);
}

test "FeedBackend - failed ordinary render retries split transition" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    _ = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var opts = native_span_feed.defaultOptions();
    opts.chunk_size = 32;
    opts.initial_chunks = 8;
    opts.max_bytes = 256;
    opts.growth_policy = @intFromEnum(native_span_feed.GrowthPolicy.block);
    opts.auto_commit_on_full = 0;
    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    var cli_renderer = try CliRenderer.createWithOptions(std.testing.allocator, 4, 2, pool, .{
        .remote_mode = .remote,
        .output = .{ .feed = feed },
        .clearOnShutdown = false,
    });
    defer feed.destroy();
    defer cli_renderer.destroy();

    _ = cli_renderer.resetSplitScrollback(2, 2);
    cli_renderer.setPendingSplitFooterTransition(.viewport_scroll, 1, 1, 2, 1, 1);
    const before_scrollback = cli_renderer.splitScrollback;
    const before_offset = cli_renderer.renderOffset;
    const before_transition = cli_renderer.pendingSplitFooterTransition;

    const blocker = [_]u8{'x'} ** 193;
    try feed.writeAtomic(&blocker);
    try std.testing.expectEqual(renderer.RenderStatus.failed, cli_renderer.render(true));
    try std.testing.expectEqual(before_scrollback, cli_renderer.splitScrollback);
    try std.testing.expectEqual(before_offset, cli_renderer.renderOffset);
    try std.testing.expectEqual(before_transition, cli_renderer.pendingSplitFooterTransition);

    var spans: [8]native_span_feed.SpanInfo = undefined;
    var count = feed.drainSpans(&spans);
    for (spans[0..count]) |span| feed.markSpanConsumed(span);

    try std.testing.expectEqual(renderer.RenderStatus.rendered, cli_renderer.render(true));
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

test "FeedBackend - failed frame keeps the published hit grid" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    _ = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var opts = native_span_feed.defaultOptions();
    opts.chunk_size = 32;
    opts.initial_chunks = 8;
    opts.max_bytes = 256;
    opts.growth_policy = @intFromEnum(native_span_feed.GrowthPolicy.block);
    opts.auto_commit_on_full = 0;
    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    var cli_renderer = try CliRenderer.createWithOptions(std.testing.allocator, 1, 1, pool, .{
        .remote_mode = .remote,
        .output = .{ .feed = feed },
        .clearOnShutdown = false,
    });
    defer feed.destroy();
    defer cli_renderer.destroy();

    cli_renderer.addToHitGrid(0, 0, 1, 1, 11);
    try std.testing.expectEqual(renderer.RenderStatus.rendered, cli_renderer.render(true));
    var spans: [8]native_span_feed.SpanInfo = undefined;
    var count = feed.drainSpans(&spans);
    for (spans[0..count]) |span| feed.markSpanConsumed(span);
    try std.testing.expectEqual(@as(u32, 11), cli_renderer.checkHit(0, 0));

    cli_renderer.addToHitGrid(0, 0, 1, 1, 22);
    const blocker = [_]u8{'x'} ** 193;
    try feed.writeAtomic(&blocker);
    try std.testing.expectEqual(renderer.RenderStatus.failed, cli_renderer.render(true));
    try std.testing.expectEqual(@as(u32, 11), cli_renderer.checkHit(0, 0));

    count = feed.drainSpans(&spans);
    for (spans[0..count]) |span| feed.markSpanConsumed(span);
    cli_renderer.addToHitGrid(0, 0, 1, 1, 22);
    try std.testing.expectEqual(renderer.RenderStatus.rendered, cli_renderer.render(true));
    try std.testing.expectEqual(@as(u32, 22), cli_renderer.checkHit(0, 0));
}

test "FeedBackend - failed frame retries unsent terminal controls" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    _ = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var opts = native_span_feed.defaultOptions();
    opts.chunk_size = 32;
    opts.initial_chunks = 4;
    opts.max_bytes = 128;
    opts.growth_policy = @intFromEnum(native_span_feed.GrowthPolicy.block);
    opts.auto_commit_on_full = 0;
    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    var cli_renderer = try CliRenderer.createWithOptions(std.testing.allocator, 1, 1, pool, .{
        .remote_mode = .remote,
        .output = .{ .feed = feed },
        .clearOnShutdown = false,
    });
    defer feed.destroy();
    defer cli_renderer.destroy();

    cli_renderer.terminal.setCursorPosition(1, 1, true);
    try std.testing.expectEqual(renderer.RenderStatus.rendered, cli_renderer.render(false));
    var spans: [8]native_span_feed.SpanInfo = undefined;
    var count = feed.drainSpans(&spans);
    for (spans[0..count]) |span| feed.markSpanConsumed(span);

    cli_renderer.terminal.setCursorColor(ansi.rgbColor(0x12, 0x34, 0x56, 255));
    cli_renderer.terminal.setCursorStyle(.line, false);
    cli_renderer.terminal.setMousePointerStyle(.pointer);

    const blocker = [_]u8{'x'} ** 65;
    try feed.writeAtomic(&blocker);
    try std.testing.expectEqual(renderer.RenderStatus.failed, cli_renderer.render(false));

    count = feed.drainSpans(&spans);
    for (spans[0..count]) |span| feed.markSpanConsumed(span);

    try std.testing.expectEqual(renderer.RenderStatus.rendered, cli_renderer.render(false));
    count = feed.drainSpans(&spans);
    var output: [256]u8 = undefined;
    var output_len: usize = 0;
    for (spans[0..count]) |span| {
        const bytes = span.slice();
        @memcpy(output[output_len .. output_len + bytes.len], bytes);
        output_len += bytes.len;
        feed.markSpanConsumed(span);
    }

    try std.testing.expect(std.mem.find(u8, output[0..output_len], "\x1b]12;#123456\x07") != null);
    try std.testing.expect(std.mem.find(u8, output[0..output_len], ansi.ANSI.cursorLine) != null);
    try std.testing.expect(std.mem.find(u8, output[0..output_len], "\x1b]22;pointer\x07") != null);
}

test "FeedBackend - failed Sixel frame does not publish an unterminated DCS" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    _ = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var opts = native_span_feed.defaultOptions();
    opts.chunk_size = 256;
    opts.initial_chunks = 1;
    opts.max_bytes = 256;
    opts.growth_policy = @intFromEnum(native_span_feed.GrowthPolicy.block);
    opts.auto_commit_on_full = 0;
    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    var cli_renderer = try CliRenderer.createWithOptions(std.testing.allocator, 8, 4, pool, .{
        .remote_mode = .remote,
        .output = .{ .feed = feed },
    });
    defer feed.destroy();
    defer cli_renderer.destroy();
    cli_renderer.terminal.caps.sixel = true;

    const pixels = try std.testing.allocator.alloc(u8, 32 * 16 * 4);
    defer std.testing.allocator.free(pixels);
    for (0..32 * 16) |index| {
        pixels[index * 4] = @truncate(index * 17);
        pixels[index * 4 + 1] = @truncate(index * 31);
        pixels[index * 4 + 2] = @truncate(index * 47);
        pixels[index * 4 + 3] = 255;
    }
    const value = try image.createFromRgba(std.testing.allocator, pixels, 32, 16, 32 * 4);
    const image_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }

    try std.testing.expect(try cli_renderer.getNextBuffer().drawImage(
        value,
        image_handle,
        0,
        0,
        8,
        4,
        32,
        16,
        0,
        0,
        32,
        16,
        .sixel,
    ));
    try std.testing.expectEqual(renderer.RenderStatus.failed, cli_renderer.render(true));

    var spans: [8]native_span_feed.SpanInfo = undefined;
    const count = feed.drainSpans(&spans);
    try std.testing.expectEqual(@as(u32, 0), count);
}

test "FeedBackend - writeOut publishes nothing when the queue is blocked" {
    var opts = native_span_feed.defaultOptions();
    opts.chunk_size = 64;
    opts.initial_chunks = 2;
    opts.span_queue_capacity = 1;
    opts.auto_commit_on_full = 0;
    opts.growth_policy = @intFromEnum(native_span_feed.GrowthPolicy.block);

    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    defer feed.destroy();

    var backend = renderer.FeedBackend.create(feed);

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

test "FeedBackend - writeOutMultiple publishes no partial batch" {
    var opts = native_span_feed.defaultOptions();
    opts.chunk_size = 32;
    opts.initial_chunks = 1;
    opts.max_bytes = 32;
    opts.growth_policy = @intFromEnum(native_span_feed.GrowthPolicy.block);
    opts.auto_commit_on_full = 0;

    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    defer feed.destroy();

    var backend = renderer.FeedBackend.create(feed);
    const failed_batch = [_][]const u8{
        "pending",
        "this-write-is-too-large-for-the-current-chunk",
    };

    backend.writeOutMultiple(&failed_batch);
    try std.testing.expect(!feed.hasPendingBytes());
    try std.testing.expectEqual(.ok, backend.prepareFrame());

    var span_out: [4]native_span_feed.SpanInfo = undefined;
    const count = feed.drainSpans(&span_out);
    try std.testing.expectEqual(@as(u32, 0), count);
}

test "FeedBackend - supportsThreading is false" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    _ = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    const feed = try native_span_feed.Stream.create(std.testing.allocator, null);
    var cli_renderer = try CliRenderer.createWithOptions(std.testing.allocator, 80, 24, pool, .{
        .remote_mode = .remote,
        .output = .{ .feed = feed },
    });
    // LIFO: renderer destroys first.
    defer feed.destroy();
    defer cli_renderer.destroy();

    try std.testing.expect(!cli_renderer.backend.supportsThreading());
    cli_renderer.setUseThread(true); // no-op on feed backend
    try std.testing.expect(!cli_renderer.backend.isUseThread());
}

test "two renderers on buffered backend have independent buffers" {
    // Independent output buffers prevent concurrent renderers from clobbering
    // each other's output.
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    _ = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var test_r1 = try TestRenderer.create(std.testing.allocator, 80, 24, pool);
    defer test_r1.deinit();
    const r1 = test_r1.renderer;
    var test_r2 = try TestRenderer.create(std.testing.allocator, 80, 24, pool);
    defer test_r2.deinit();
    const r2 = test_r2.renderer;

    const fg = RGBA{ 1.0, 1.0, 1.0, 1.0 };
    const bg = RGBA{ 0.0, 0.0, 0.0, 1.0 };

    const b1 = r1.getNextBuffer();
    try b1.drawText("AAA", 0, 0, fg, bg, 0);
    _ = r1.render(false);

    const b2 = r2.getNextBuffer();
    try b2.drawText("BBB", 0, 0, fg, bg, 0);
    _ = r2.render(false);

    const out1 = test_r1.lastOutput();
    const out2 = test_r2.lastOutput();

    try std.testing.expect(std.mem.find(u8, out1, "AAA") != null);
    try std.testing.expect(std.mem.find(u8, out1, "BBB") == null);
    try std.testing.expect(std.mem.find(u8, out2, "BBB") != null);
    try std.testing.expect(std.mem.find(u8, out2, "AAA") == null);
}

test "threaded buffered destroy: no stale write after shutdown ANSI" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    _ = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var test_cli_renderer = try TestRenderer.createThreadSafe(std.testing.allocator, 80, 24, pool);
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.setUseThread(true);
    try std.testing.expect(cli_renderer.backend.isUseThread());

    const fg = RGBA{ 1.0, 1.0, 1.0, 1.0 };
    const bg = RGBA{ 0.0, 0.0, 0.0, 1.0 };
    const nb = cli_renderer.getNextBuffer();
    try nb.drawText("STALE", 0, 0, fg, bg, 0);
    _ = cli_renderer.render(false);

    // Toggle threading off and back on — flags must be reset so the new
    // thread waits for a real renderRequested rather than replaying the
    // stale currentOutputBuffer from the prior thread era.
    cli_renderer.setUseThread(false);
    try std.testing.expect(!cli_renderer.backend.isUseThread());

    cli_renderer.setUseThread(true);
    try std.testing.expect(cli_renderer.backend.isUseThread());

    // The protocol invariant we assert: setUseThread toggles do not panic
    // or deadlock, and internal state is clean for destroy() to run.
}

test "threaded buffered backend skips instead of blocking behind output" {
    var output = SlowThreadSafeOutput{ .delay_ns = 200 * std.time.ns_per_ms };
    var backend = try renderer.BufferedBackend.create(std.testing.allocator, output.bufferedOutput());
    defer backend.deinit();
    backend.setUseThread(true);

    backend.beginFrame();
    try backend.writer().writeAll("large graphics frame");
    try std.testing.expectEqual(@import("../renderer-output.zig").WriteStatus.ok, backend.endFrame());

    const start_time: std.Io.Timestamp = .now(io, .awake);
    try std.testing.expectEqual(@import("../renderer-output.zig").WriteStatus.skipped, backend.prepareFrame());
    try std.testing.expect(start_time.untilNow(io, .awake).toNanoseconds() < 100 * std.time.ns_per_ms);

    backend.setUseThread(false);
    try std.testing.expectEqualStrings("large graphics frame", output.payloads[0][0..output.lengths[0]]);

    backend.setUseThread(true);
    backend.beginFrame();
    try std.testing.expectEqual(@import("../renderer-output.zig").WriteStatus.ok, backend.endFrame());

    backend.beginFrame();
    try backend.writer().writeAll("next graphics frame");
    try std.testing.expectEqual(@import("../renderer-output.zig").WriteStatus.ok, backend.endFrame());
    backend.setUseThread(false);
    try std.testing.expectEqual(@as(u32, 2), output.writes.load(.monotonic));
    try std.testing.expectEqualStrings("next graphics frame", output.payloads[1][0..output.lengths[1]]);
}

test "buffered backend reports a failed frame when growth allocation fails" {
    const rout = @import("../renderer-output.zig");
    var out = CountingOutput{};
    var backend = try renderer.BufferedBackend.create(std.testing.allocator, out.bufferedOutput());
    defer backend.deinit();
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0, .resize_fail_index = 0 });
    backend.allocator = failing.allocator();
    defer backend.allocator = std.testing.allocator;

    backend.beginFrame();
    var w = backend.writer();
    const chunk = [_]u8{'x'} ** 4096;
    var write_failed = false;
    var written: usize = 0;
    while (written <= renderer.OUTPUT_BUFFER_SIZE) : (written += chunk.len) {
        w.writeAll(&chunk) catch {
            write_failed = true;
            break;
        };
    }
    try std.testing.expect(write_failed);
    try std.testing.expect(failing.has_induced_failure);

    // A frame whose bytes were dropped must be reported as failed so the
    // renderer can force a full repaint, and the truncated ANSI stream must
    // not reach the terminal.
    try std.testing.expectEqual(rout.WriteStatus.failed, backend.endFrame());
    try std.testing.expectEqual(@as(u32, 0), out.writes);

    // The failure is per-frame: a following frame that fits reports ok.
    backend.beginFrame();
    try backend.writer().writeAll("recovered");
    try std.testing.expectEqual(rout.WriteStatus.ok, backend.endFrame());
    try std.testing.expect(out.writes >= 1);
}

test "buffered backend releases oversized frame buffers after the spike passes" {
    var gpa: std.heap.DebugAllocator(.{ .enable_memory_limit = true }) = .init;
    defer std.debug.assert(gpa.deinit() == .ok);
    var out = CountingOutput{};

    var backend = try renderer.BufferedBackend.create(gpa.allocator(), out.bufferedOutput());
    defer backend.deinit();

    // One pathological frame that grows the active buffer to ~4x the default.
    backend.beginFrame();
    var w = backend.writer();
    const chunk = [_]u8{'x'} ** 4096;
    var written: usize = 0;
    while (written < 4 * renderer.OUTPUT_BUFFER_SIZE) : (written += chunk.len) {
        try w.writeAll(&chunk);
    }
    _ = backend.endFrame();
    try std.testing.expect(gpa.total_requested_bytes > 3 * renderer.OUTPUT_BUFFER_SIZE);

    // A long run of ordinary frames afterwards must release the spike memory
    // instead of pinning it for the lifetime of the renderer.
    var i: usize = 0;
    while (i < 200) : (i += 1) {
        backend.beginFrame();
        try backend.writer().writeAll("small frame");
        _ = backend.endFrame();
    }

    try std.testing.expect(gpa.total_requested_bytes <= 3 * renderer.OUTPUT_BUFFER_SIZE);
}

test "buffered backend frees grown buffers cleanly on deinit" {
    // Regression guard for the alloc/free pairing: buffers grown by frame
    // writes must be freed by the same allocator that grew them. deinit no
    // longer takes an allocator parameter, so a mismatch is unrepresentable;
    // std.testing.allocator verifies there is no leak and no invalid free.
    var out = CountingOutput{};
    var backend = try renderer.BufferedBackend.create(std.testing.allocator, out.bufferedOutput());
    defer backend.deinit();

    backend.beginFrame();
    var w = backend.writer();
    const chunk = [_]u8{'x'} ** 4096;
    var written: usize = 0;
    while (written < 2 * renderer.OUTPUT_BUFFER_SIZE) : (written += chunk.len) {
        try w.writeAll(&chunk);
    }
    try std.testing.expectEqual(@import("../renderer-output.zig").WriteStatus.ok, backend.endFrame());
}

test "renderer scales kitty transmission alpha by placement opacity" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 2, pool);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 200, 100, 50, 255 }, 1, 1, 4);
    const value_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(value_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    test_renderer.renderer.terminal.caps.kitty_graphics = true;

    var next = test_renderer.renderer.getNextBuffer();
    try next.pushOpacity(0.5);
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));
    next.popOpacity();
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
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
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(false));
    const second = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, second, "a=d,d=I") != null);
    const second_start = std.mem.find(u8, second, "\x1b_Ga=t").?;
    const second_end = std.mem.findPos(u8, second, second_start, "\x1b\\").? + 2;
    const retransmitted = try terminal_image_test.decodeKittyChunks(second[second_start..second_end]);
    defer std.testing.allocator.free(retransmitted);
    try std.testing.expect(@abs(@as(i16, retransmitted[3]) - 64) <= 1);
}

test "renderer bounds sixel cache entries and evicts least recently used payloads" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 2, pool);
    defer test_renderer.deinit();
    test_renderer.renderer.terminal.caps.sixel = true;

    const image_count = 260;
    var images: [image_count]*image.Image = undefined;
    var image_handles: [image_count]u32 = undefined;
    for (0..image_count) |index| {
        const shade: u8 = @intCast(index % 256);
        images[index] = try image.createFromRgba(std.testing.allocator, &[_]u8{ shade, 255 - shade, @intCast((index / 4) % 256), 255 }, 1, 1, 4);
        image_handles[index] = try handles.insert(.image, @ptrCast(images[index]));
    }
    defer for (image_handles) |handle| {
        const token = handles.beginDestroy(handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    };

    var next = test_renderer.renderer.getNextBuffer();
    for (0..image_count) |index| {
        try std.testing.expect(try next.drawImage(images[index], image_handles[index], 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    }
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    try std.testing.expectEqual(@as(u64, image_count), test_renderer.renderer.sixelCacheMisses);
    try std.testing.expect(test_renderer.renderer.sixelCache.count() <= 256);
    try std.testing.expect(test_renderer.renderer.sixelCacheBytes > 0);

    // The first payloads were the least recently used and must have been evicted.
    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(images[0], image_handles[0], 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    try std.testing.expectEqual(@as(u64, image_count + 1), test_renderer.renderer.sixelCacheMisses);

    // A recently used payload is still cached.
    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(images[image_count - 1], image_handles[image_count - 1], 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    try std.testing.expectEqual(@as(u64, 1), test_renderer.renderer.sixelCacheHits);
}

test "renderer treats fully transparent sixel placements as empty without failing" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 2, pool);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 0 }, 1, 1, 4);
    const value_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(value_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    test_renderer.renderer.terminal.caps.sixel = true;

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0") == null);
    try std.testing.expect(!test_renderer.renderer.imageRenderFailed);
    try std.testing.expect(!test_renderer.renderer.force_full_repaint);

    // The empty payload is cached; the placement stays a cheap no-op.
    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    try std.testing.expectEqual(@as(u64, 1), test_renderer.renderer.sixelCacheHits);
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0") == null);
    try std.testing.expect(!test_renderer.renderer.imageRenderFailed);
}

test "renderer retransmits sixel placements on a forced full repaint" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 4, 2, pool);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const value_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(value_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    test_renderer.renderer.terminal.caps.sixel = true;

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q") != null);

    // A full repaint (failed-frame recovery, palette change) rewrites every
    // cell, so the unchanged placement's pixels must be transmitted again.
    test_renderer.renderer.force_full_repaint = true;
    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(false));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q") != null);
}

test "renderer leaves clean text alone when graphics content changes" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 8, 4, pool);
    defer test_renderer.deinit();
    const first = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const second = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 255, 0, 255 }, 1, 1, 4);
    const first_handle = try handles.insert(.image, @ptrCast(first));
    const second_handle = try handles.insert(.image, @ptrCast(second));
    defer for ([_]u32{ second_handle, first_handle }) |handle| {
        const token = handles.beginDestroy(handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    };
    test_renderer.renderer.terminal.caps.kitty_graphics = true;

    var next = test_renderer.renderer.getNextBuffer();
    try next.drawText("HELLO", 0, 3, .{ 255, 255, 255, 255 }, null, 0);
    try std.testing.expect(try next.drawImage(first, first_handle, 0, 0, 2, 2, 0, 0, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "HELLO") != null);

    // Replace the image while preserving text and placement geometry.
    // Kitty swaps the image server side; unchanged text must not be re-emitted
    // and the reserved cells must not be cleared again.
    next = test_renderer.renderer.getNextBuffer();
    try next.drawText("HELLO", 0, 3, .{ 255, 255, 255, 255 }, null, 0);
    try std.testing.expect(try next.drawImage(second, second_handle, 0, 0, 2, 2, 0, 0, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(false));
    const output = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, output, "\x1b_Ga=t") != null);
    try std.testing.expect(std.mem.find(u8, output, "HELLO") == null);
    try std.testing.expect(std.mem.find(u8, output, " ") == null);
}

test "renderer clears dirty sixel cells as one batched space run" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 8, 2, pool);
    defer test_renderer.deinit();
    const first = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const second = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 255, 0, 255 }, 1, 1, 4);
    const first_handle = try handles.insert(.image, @ptrCast(first));
    const second_handle = try handles.insert(.image, @ptrCast(second));
    defer for ([_]u32{ second_handle, first_handle }) |handle| {
        const token = handles.beginDestroy(handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    };
    test_renderer.renderer.terminal.caps.sixel = true;

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(first, first_handle, 0, 0, 6, 1, 12, 2, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(second, second_handle, 0, 0, 6, 1, 12, 2, 0, 0, 1, 1, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(false));
    const output = test_renderer.memory.lastWrite();
    const sixel = std.mem.find(u8, output, "\x1bP0;1;0q") orelse return error.TestUnexpectedResult;
    // The six reserved cells clear with a single cursor move and six spaces;
    // the only other CUP before the payload positions the Sixel itself.
    try std.testing.expect(std.mem.find(u8, output[0..sixel], "\x1b[1;1H      ") != null);
    try std.testing.expectEqual(@as(usize, 2), std.mem.count(u8, output[0..sixel], "\x1b[1;1H"));
}

test "renderer downscales large kitty stills to their placement pixel size" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 8, 4, pool);
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
    const value_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(value_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    test_renderer.renderer.terminal.caps.kitty_graphics = true;

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 2, 2, 16, 16, 0, 0, 64, 64, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
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
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(false));
    const second = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, second, "a=d,d=I") != null);
    try std.testing.expect(std.mem.find(u8, second, "a=t,f=24,s=20,v=20") != null);
}

test "renderer transmits small kitty images at native size" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 8, 4, pool);
    defer test_renderer.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &([_]u8{ 9, 8, 7, 255 } ** 64), 8, 8, 32);
    const value_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(value_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    test_renderer.renderer.terminal.caps.kitty_graphics = true;

    // Displayed at 16x16 pixels (upscale): the source pixels are transmitted
    // untouched and kitty performs the scaling.
    const next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 2, 2, 16, 16, 0, 0, 8, 8, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    const output = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, output, "a=t,f=24,s=8,v=8") != null);
    try std.testing.expect(std.mem.find(u8, output, "x=0,y=0,w=8,h=8,C=1") != null);
}

test "renderer reuses the kitty transmit across source rectangle changes" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 8, 4, pool);
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
    const value_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(value_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    test_renderer.renderer.terminal.caps.kitty_graphics = true;

    // A clipped placement transmits the full image once; the placement escape
    // selects the visible source rectangle.
    const next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 2, 2, 16, 16, 8, 12, 8, 8, .auto));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
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
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(false));
    const changed_output = test_renderer.memory.lastWrite();
    try std.testing.expect(std.mem.find(u8, changed_output, "a=d,d=I") == null);
    try std.testing.expect(std.mem.find(u8, changed_output, "a=t") == null);
    try std.testing.expect(std.mem.find(u8, changed_output, "a=d,d=i") != null);
    try std.testing.expect(std.mem.find(u8, changed_output, "x=16,y=12,w=8,h=8,C=1") != null);
}

test "renderer does not publish a frame when image dirty preparation fails" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 2, 1, pool);
    defer test_renderer.deinit();
    test_renderer.renderer.terminal.caps.sixel = true;

    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const value_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(value_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    try test_renderer.renderer.pendingImages.ensureTotalCapacity(std.testing.allocator, 1);
    const next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));

    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0 });
    test_renderer.renderer.allocator = failing.allocator();
    const status = test_renderer.renderer.render(true);
    test_renderer.renderer.allocator = std.testing.allocator;

    try std.testing.expect(failing.has_induced_failure);
    try std.testing.expectEqual(renderer.RenderStatus.failed, status);
    try std.testing.expectEqual(@as(usize, 0), test_renderer.renderer.currentImages.items.len);
    try std.testing.expectEqual(@as(usize, 0), test_renderer.memory.lastWrite().len);

    const retry = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try retry.drawImage(value, value_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q") != null);
    try std.testing.expectEqual(@as(usize, 1), test_renderer.renderer.currentImages.items.len);
}

test "renderer does not publish a frame when Sixel preparation fails" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 1, 1, pool);
    defer test_renderer.deinit();
    test_renderer.renderer.terminal.caps.sixel = true;

    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const value_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(value_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    try test_renderer.renderer.imageDirty.ensureTotalCapacity(std.testing.allocator, 1);
    try test_renderer.renderer.pendingImages.ensureTotalCapacity(std.testing.allocator, 1);
    const next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));

    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0 });
    test_renderer.renderer.allocator = failing.allocator();
    const status = test_renderer.renderer.render(true);
    test_renderer.renderer.allocator = std.testing.allocator;

    try std.testing.expect(failing.has_induced_failure);
    try std.testing.expectEqual(renderer.RenderStatus.failed, status);
    try std.testing.expectEqual(@as(usize, 0), test_renderer.renderer.currentImages.items.len);
    try std.testing.expectEqual(@as(usize, 0), test_renderer.memory.lastWrite().len);

    const retry = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try retry.drawImage(value, value_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1bP0;1;0q") != null);
    try std.testing.expectEqual(@as(usize, 1), test_renderer.renderer.currentImages.items.len);
}

test "renderer does not publish Kitty output when image state staging fails" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 1, 1, pool);
    defer test_renderer.deinit();
    test_renderer.renderer.terminal.caps.kitty_graphics = true;

    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    const value_handle = try handles.insert(.image, @ptrCast(value));
    defer {
        const token = handles.beginDestroy(value_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    try test_renderer.renderer.imageDirty.ensureTotalCapacity(std.testing.allocator, 1);
    const next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(value, value_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .kitty));

    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0 });
    test_renderer.renderer.allocator = failing.allocator();
    const status = test_renderer.renderer.render(true);
    test_renderer.renderer.allocator = std.testing.allocator;

    try std.testing.expect(failing.has_induced_failure);
    try std.testing.expectEqual(renderer.RenderStatus.failed, status);
    try std.testing.expectEqual(@as(usize, 0), test_renderer.renderer.currentImages.items.len);
    try std.testing.expectEqual(@as(usize, 0), test_renderer.memory.lastWrite().len);

    const retry = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try retry.drawImage(value, value_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .kitty));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1b_Ga=t") != null);
    try std.testing.expectEqual(@as(usize, 1), test_renderer.renderer.currentImages.items.len);
}

test "renderer clears an upper sixel hole when its lower image moves away" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();
    var test_renderer = try TestRenderer.create(std.testing.allocator, 2, 1, pool);
    defer test_renderer.deinit();
    test_renderer.renderer.terminal.caps.sixel = true;

    const lower = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 0, 255, 255 }, 1, 1, 4);
    const upper = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 0, 0, 0 }, 1, 1, 4);
    const lower_handle = try handles.insert(.image, @ptrCast(lower));
    const upper_handle = try handles.insert(.image, @ptrCast(upper));
    defer for ([_]u32{ upper_handle, lower_handle }) |handle| {
        const token = handles.beginDestroy(handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    };

    var next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(lower, lower_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(upper, upper_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(true));

    next = test_renderer.renderer.getNextBuffer();
    try std.testing.expect(try next.drawImage(lower, lower_handle, 1, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try std.testing.expect(try next.drawImage(upper, upper_handle, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, .sixel));
    try std.testing.expectEqual(renderer.RenderStatus.rendered, test_renderer.renderer.render(false));
    try std.testing.expect(std.mem.find(u8, test_renderer.memory.lastWrite(), "\x1b[1;1H") != null);
}
