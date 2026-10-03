const std = @import("std");
const TestPools = @import("test-pools.zig").TestPools;
const buffer_mod = @import("../buffer.zig");
const text_buffer = @import("../text-buffer.zig");
const text_buffer_view = @import("../text-buffer-view.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");
const ansi = @import("../ansi.zig");
const test_renderer_mod = @import("test-renderer.zig");
const image = @import("../image.zig");
const edit_buffer = @import("../edit-buffer.zig");
const editor_view = @import("../editor-view.zig");

const OptimizedBuffer = buffer_mod.OptimizedBuffer;
const TextBuffer = text_buffer.UnifiedTextBuffer;
const TextBufferView = text_buffer_view.UnifiedTextBufferView;
const RGBA = buffer_mod.RGBA;
const TestRenderer = test_renderer_mod.TestRenderer;

test "OptimizedBuffer clear and opaque fills preserve every plane at vector boundaries" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    for ([_]u32{ 1, 3, 4, 7, 8, 15, 16, 17, 33 }) |width| {
        const target = try OptimizedBuffer.init(std.testing.allocator, width, 3, .{ .pool = &pool, .link_pool = &links });
        defer target.deinit();
        const background = ansi.indexedColor(6, 17, 23, 41);
        target.clear(background, '#');
        @memset(target.buffer.attributes, 1);
        @memset(target.buffer.fg, background);
        try target.pushScissorRect(1, 1, width - 1, 1);
        const fill = ansi.rgbColor(19, 37, 53, 255);
        target.fillRect(0, 0, width, 3, fill);
        for (0..3) |y| {
            for (0..width) |x| {
                const cell = target.get(@intCast(x), @intCast(y)).?;
                const filled = y == 1 and x > 0;
                try std.testing.expectEqual(@as(u32, if (filled) ' ' else '#'), cell.char);
                try std.testing.expectEqual(@as(u32, if (filled) 0 else 1), cell.attributes);
                try std.testing.expectEqualDeep(if (filled) ansi.rgbColor(255, 255, 255, 255) else background, cell.fg);
                try std.testing.expectEqualDeep(if (filled) fill else background, cell.bg);
            }
        }
        target.clear(fill, 0);
        for (target.buffer.char) |value| try std.testing.expectEqual(@as(u32, 0), value);
        for (target.buffer.attributes) |value| try std.testing.expectEqual(@as(u32, 0), value);
        for (target.buffer.fg) |value| try std.testing.expectEqualDeep(ansi.rgbColor(255, 255, 255, 255), value);
        for (target.buffer.bg) |value| try std.testing.expectEqualDeep(fill, value);
    }
}

test "OptimizedBuffer draws image reservation markers" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 2, 2, .{ .pool = &pool, .link_pool = &link_pool });
    defer target.deinit();
    const source = try image.createFromRgba(std.testing.allocator, &[_]u8{
        255, 0, 0,   255, 0,   255, 0,   255,
        0,   0, 255, 255, 255, 255, 255, 255,
    }, 2, 2, 8);
    defer source.deinit();
    const before = target.get(0, 0).?;
    try std.testing.expect(try target.drawImage(source, 1, 0, 0, 1, 1, 0, 0, 0, 0, 2, 2, .auto));
    const marker = target.get(0, 0).?;
    try std.testing.expect(gp.isImageChar(marker.char));
    try std.testing.expectEqual(@as(u4, 0), gp.imageFallbackFromChar(marker.char));
    try std.testing.expect(buffer_mod.rgbaEqual(before.fg, marker.fg));
    try std.testing.expect(buffer_mod.rgbaEqual(before.bg, marker.bg));
}

test "OptimizedBuffer materializes block fallback on demand" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 1, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer target.deinit();
    const source = try image.createFromRgba(std.testing.allocator, &[_]u8{
        255, 0, 0,   255, 0,   255, 0,   255,
        0,   0, 255, 255, 255, 255, 255, 255,
    }, 2, 2, 8);
    defer source.deinit();

    try std.testing.expect(try target.drawImage(source, 1, 0, 0, 1, 1, 0, 0, 0, 0, 2, 2, .auto));
    try target.materializeImageFallback(1);
    const cell = target.get(0, 0).?;
    try std.testing.expect(gp.isImageChar(cell.char));
    try std.testing.expect(gp.imageFallbackFromChar(cell.char) != 0);
}

test "OptimizedBuffer flattens image placements into owned block cells" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 1, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer target.deinit();
    const source = try image.createFromRgba(std.testing.allocator, &[_]u8{
        255, 0, 0,   255, 0,   255, 0,   255,
        0,   0, 255, 255, 255, 255, 255, 255,
    }, 2, 2, 8);
    defer source.deinit();

    try std.testing.expect(try target.drawImage(source, 1, 0, 0, 1, 1, 0, 0, 0, 0, 2, 2, .kitty));
    try std.testing.expectEqual(@as(u32, 2), source.ref_count);

    try target.materializeImageFallbacks();

    const cell = target.get(0, 0).?;
    try std.testing.expect(!gp.isImageChar(cell.char));
    try std.testing.expect(std.mem.findScalar(u32, &buffer_mod.quadrantChars, cell.char) != null);
    try std.testing.expectEqual(@as(usize, 0), target.image_placements.items.len);
    try std.testing.expectEqual(@as(u32, 1), source.ref_count);
}

test "OptimizedBuffer clips image placements and source crop to scissor" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 4, 2, .{ .pool = &pool, .link_pool = &link_pool });
    defer target.deinit();
    const source = try image.createFromRgba(std.testing.allocator, &([_]u8{ 255, 0, 0, 255 } ** 16), 4, 4, 16);
    defer source.deinit();
    try target.pushScissorRect(1, 0, 2, 2);
    try std.testing.expect(try target.drawImage(source, 1, -1, 0, 4, 2, 40, 20, 0, 0, 4, 4, .auto));
    const placement = target.image_placements.items[0];
    try std.testing.expectEqual(@as(i32, 1), placement.x);
    try std.testing.expectEqual(@as(u32, 2), placement.width);
    try std.testing.expectEqual(@as(u32, 2), placement.source_x);
    try std.testing.expectEqual(@as(u32, 2), placement.source_width);
    try std.testing.expectEqual(@as(u32, 20), placement.pixel_width);
}

test "OptimizedBuffer retains image data for deferred protocol rendering" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 1, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer target.deinit();
    const source = try image.createFromRgba(std.testing.allocator, &[_]u8{ 7, 8, 9, 255 }, 1, 1, 4);
    try std.testing.expect(try target.drawImage(source, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .auto));
    source.deinit();
    try std.testing.expectEqual(@as(u8, 7), target.image_placements.items[0].image.pixels[0]);
}

test "OptimizedBuffer blocks fallback composites transparent images over lower placements" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 1, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer target.deinit();
    const lower = try image.createFromRgba(std.testing.allocator, &[_]u8{ 0, 0, 255, 255 }, 1, 1, 4);
    defer lower.deinit();
    const upper = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 0 }, 1, 1, 4);
    defer upper.deinit();
    try std.testing.expect(try target.drawImage(lower, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .blocks));
    try std.testing.expect(try target.drawImage(upper, 2, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .blocks));

    try target.materializeImageFallback(1);
    try target.materializeImageFallback(2);

    const cell = target.get(0, 0).?;
    try std.testing.expectEqual(@as(u32, 2), gp.imageIdFromChar(cell.char));
    try std.testing.expectEqual(ansi.rgbColor(0, 0, 255, 255), cell.fg);
    try std.testing.expectEqual(ansi.rgbColor(0, 0, 255, 255), cell.bg);
}

test "OptimizedBuffer copies transparent image reservation markers from frame buffers" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    const source_buffer = try OptimizedBuffer.init(std.testing.allocator, 1, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer source_buffer.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 1, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer target.deinit();
    const source = try image.createFromRgba(std.testing.allocator, &[_]u8{ 7, 8, 9, 255 }, 1, 1, 4);
    defer source.deinit();

    try std.testing.expect(try source_buffer.drawImage(source, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .auto));
    target.drawFrameBuffer(0, 0, source_buffer, null, null, null, null);
    try std.testing.expect(gp.isImageChar(target.get(0, 0).?.char));
    try std.testing.expectEqual(@as(usize, 1), target.image_placements.items.len);
}

test "OptimizedBuffer flattening a framebuffer copy preserves source image ownership" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    const source_buffer = try OptimizedBuffer.init(std.testing.allocator, 1, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer source_buffer.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 1, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer target.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 7, 8, 9, 255 }, 1, 1, 4);
    defer value.deinit();

    try std.testing.expect(try source_buffer.drawImage(value, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .auto));
    target.drawFrameBuffer(0, 0, source_buffer, null, null, null, null);
    try std.testing.expectEqual(@as(u32, 3), value.ref_count);

    try target.materializeImageFallbacks();

    try std.testing.expect(!gp.isImageChar(target.get(0, 0).?.char));
    try std.testing.expectEqual(@as(usize, 0), target.image_placements.items.len);
    try std.testing.expect(gp.isImageChar(source_buffer.get(0, 0).?.char));
    try std.testing.expectEqual(@as(usize, 1), source_buffer.image_placements.items.len);
    try std.testing.expectEqual(@as(u32, 2), value.ref_count);
}

test "OptimizedBuffer copies malformed image markers as fallback cells" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    const source_buffer = try OptimizedBuffer.init(std.testing.allocator, 2, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer source_buffer.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 2, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer target.deinit();
    const source = try image.createFromRgba(std.testing.allocator, &[_]u8{ 7, 8, 9, 255 }, 1, 1, 4);
    defer source.deinit();
    try std.testing.expect(try source_buffer.drawImage(source, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .auto));
    source_buffer.setRaw(1, 0, .{
        .char = gp.packImageCell(100, 15),
        .fg = ansi.rgbColor(1, 2, 3, 255),
        .bg = ansi.rgbColor(4, 5, 6, 255),
        .attributes = 0,
    });

    target.drawFrameBuffer(0, 0, source_buffer, null, null, null, null);

    try std.testing.expect(gp.isImageChar(target.get(0, 0).?.char));
    try std.testing.expectEqual(@as(u32, 0x2588), target.get(1, 0).?.char);
}

test "OptimizedBuffer copies ordinary cells when image bookkeeping allocation fails" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    const source_buffer = try OptimizedBuffer.init(std.testing.allocator, 2, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer source_buffer.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 2, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer target.deinit();
    const source = try image.createFromRgba(std.testing.allocator, &[_]u8{ 7, 8, 9, 255 }, 1, 1, 4);
    defer source.deinit();
    try std.testing.expect(try source_buffer.drawImage(source, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .auto));
    source_buffer.setRaw(1, 0, .{
        .char = 'X',
        .fg = ansi.rgbColor(1, 2, 3, 255),
        .bg = ansi.rgbColor(4, 5, 6, 255),
        .attributes = 0,
    });

    for (0..2) |fail_index| {
        target.clear(ansi.rgbColor(0, 0, 0, 255), null);
        var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = fail_index });
        target.allocator = failing.allocator();
        target.storage.allocator = failing.allocator();
        target.drawFrameBuffer(0, 0, source_buffer, null, null, null, null);
        target.allocator = std.testing.allocator;
        target.storage.allocator = std.testing.allocator;

        try std.testing.expect(failing.has_induced_failure);
        try std.testing.expectEqual(@as(u32, 'X'), target.get(1, 0).?.char);
        try std.testing.expect(!gp.isImageChar(target.get(0, 0).?.char));
        try std.testing.expectEqual(failing.allocated_bytes, failing.freed_bytes);
    }
}

test "OptimizedBuffer clips image geometry without signed overflow" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 2, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer target.deinit();
    const source = try image.createFromRgba(std.testing.allocator, &[_]u8{ 7, 8, 9, 255 }, 1, 1, 4);
    defer source.deinit();

    try std.testing.expect(!try target.drawImage(
        source,
        1,
        std.math.maxInt(i32),
        std.math.maxInt(i32),
        std.math.maxInt(u32),
        std.math.maxInt(u32),
        0,
        0,
        0,
        0,
        1,
        1,
        .auto,
    ));
}

test "OptimizedBuffer plane fills ignore color alpha over image markers" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    const source = try image.createFromRgba(std.testing.allocator, &[_]u8{ 7, 8, 9, 255 }, 1, 1, 4);
    defer source.deinit();

    for ([_]u8{ 0, 128, 255 }) |alpha| {
        const target = try OptimizedBuffer.init(std.testing.allocator, 2, 1, .{ .pool = &pool, .link_pool = &link_pool });
        defer target.deinit();
        try std.testing.expect(try target.drawImage(source, 1, 0, 0, 2, 1, 0, 0, 0, 0, 1, 1, .auto));

        target.fillRect(0, 0, 1, 1, ansi.rgbColor(10, 20, 30, alpha));

        const covered = target.get(0, 0).?;
        try std.testing.expectEqual(@as(u32, ' '), covered.char);
        try std.testing.expectEqual(ansi.rgbColor(10, 20, 30, 255), covered.bg);
        try std.testing.expect(gp.isImageChar(target.get(1, 0).?.char));
        try std.testing.expectEqual(@as(usize, 1), target.image_placements.items.len);
    }
}

test "OptimizedBuffer transparent drawChar only writes over an image marker" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 2, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer target.deinit();
    const source = try image.createFromRgba(std.testing.allocator, &[_]u8{ 7, 8, 9, 255 }, 1, 1, 4);
    defer source.deinit();
    target.setRaw(1, 0, .{
        .char = 'B',
        .fg = ansi.rgbColor(1, 2, 3, 255),
        .bg = ansi.rgbColor(4, 5, 6, 255),
        .attributes = 0,
    });
    try std.testing.expect(try target.drawImage(source, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));

    target.drawChar('X', 0, 0, ansi.rgbColor(40, 50, 60, 0), ansi.rgbColor(10, 20, 30, 0), 0);
    target.drawChar('X', 1, 0, ansi.rgbColor(40, 50, 60, 0), ansi.rgbColor(10, 20, 30, 0), 0);

    const covered = target.get(0, 0).?;
    try std.testing.expectEqual(@as(u32, 'X'), covered.char);
    try std.testing.expectEqual(@as(u8, 255), ansi.alpha(covered.fg));
    try std.testing.expectEqual(@as(u8, 255), ansi.alpha(covered.bg));
    try std.testing.expectEqual(@as(u32, 'B'), target.get(1, 0).?.char);
}

test "OptimizedBuffer transparent text space covers an image marker" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 1, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer target.deinit();
    const source = try image.createFromRgba(std.testing.allocator, &[_]u8{ 7, 8, 9, 255 }, 1, 1, 4);
    defer source.deinit();
    try std.testing.expect(try target.drawImage(source, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));

    try target.drawText(" ", 0, 0, ansi.rgbColor(40, 50, 60, 64), ansi.rgbColor(10, 20, 30, 0), 0);

    const cell = target.get(0, 0).?;
    try std.testing.expectEqual(@as(u32, ' '), cell.char);
    try std.testing.expectEqual(ansi.rgbColor(10, 20, 30, 255), cell.bg);
    try std.testing.expectEqual(ansi.rgbColor(40, 50, 60, 255), cell.fg);
}

test "OptimizedBuffer text ignores foreground alpha over an image marker" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 1, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer target.deinit();
    const source = try image.createFromRgba(std.testing.allocator, &[_]u8{ 7, 8, 9, 255 }, 1, 1, 4);
    defer source.deinit();
    try std.testing.expect(try target.drawImage(source, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));

    try target.drawText("X", 0, 0, ansi.rgbColor(40, 50, 60, 64), ansi.rgbColor(10, 20, 30, 255), 0);

    const cell = target.get(0, 0).?;
    try std.testing.expectEqual(@as(u32, 'X'), cell.char);
    try std.testing.expectEqual(ansi.rgbColor(10, 20, 30, 255), cell.bg);
    try std.testing.expectEqual(ansi.rgbColor(40, 50, 60, 255), cell.fg);
}

test "OptimizedBuffer transparent tab covers only clipped image markers" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 2, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer target.deinit();
    const source = try image.createFromRgba(std.testing.allocator, &[_]u8{ 7, 8, 9, 255 }, 1, 1, 4);
    defer source.deinit();
    try std.testing.expect(try target.drawImage(source, 1, 0, 0, 2, 1, 0, 0, 0, 0, 1, 1, .auto));
    try target.pushScissorRect(0, 0, 1, 1);

    try target.drawText("\t", 0, 0, ansi.rgbColor(40, 50, 60, 0), ansi.rgbColor(10, 20, 30, 0), 0);

    try std.testing.expectEqual(@as(u32, ' '), target.get(0, 0).?.char);
    try std.testing.expectEqual(ansi.rgbColor(10, 20, 30, 255), target.get(0, 0).?.bg);
    try std.testing.expect(gp.isImageChar(target.get(1, 0).?.char));
}

test "OptimizedBuffer transparent tab covers image markers after its clipped start" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 2, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer target.deinit();
    const source = try image.createFromRgba(std.testing.allocator, &[_]u8{ 7, 8, 9, 255 }, 1, 1, 4);
    defer source.deinit();
    try std.testing.expect(try target.drawImage(source, 1, 0, 0, 2, 1, 0, 0, 0, 0, 1, 1, .auto));
    try target.pushScissorRect(1, 0, 1, 1);

    try target.drawText("\t", 0, 0, ansi.rgbColor(40, 50, 60, 0), ansi.rgbColor(10, 20, 30, 0), 0);

    try std.testing.expect(gp.isImageChar(target.get(0, 0).?.char));
    try std.testing.expectEqual(@as(u32, ' '), target.get(1, 0).?.char);
    try std.testing.expectEqual(ansi.rgbColor(10, 20, 30, 255), target.get(1, 0).?.bg);
}

test "OptimizedBuffer transparent box border covers only clipped image markers" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 2, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer target.deinit();
    const source = try image.createFromRgba(std.testing.allocator, &[_]u8{ 7, 8, 9, 255 }, 1, 1, 4);
    defer source.deinit();
    try std.testing.expect(try target.drawImage(source, 1, 0, 0, 2, 1, 0, 0, 0, 0, 1, 1, .auto));
    try target.pushScissorRect(0, 0, 1, 1);
    const border_chars = [_]u32{ '┌', '┐', '└', '┘', '─', '│', '┬', '┴', '├', '┤', '┼' };

    try target.drawBox(0, 0, 2, 1, &border_chars, .{ .top = true }, ansi.rgbColor(40, 50, 60, 0), ansi.rgbColor(10, 20, 30, 0), ansi.rgbColor(40, 50, 60, 0), false, null, 0, null, 0);

    try std.testing.expect(!gp.isImageChar(target.get(0, 0).?.char));
    try std.testing.expectEqual(ansi.rgbColor(10, 20, 30, 255), target.get(0, 0).?.bg);
    try std.testing.expectEqual(ansi.rgbColor(40, 50, 60, 255), target.get(0, 0).?.fg);
    try std.testing.expect(gp.isImageChar(target.get(1, 0).?.char));
}

test "OptimizedBuffer clipped wide text does not cover image markers" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 2, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer target.deinit();
    const source = try image.createFromRgba(std.testing.allocator, &[_]u8{ 7, 8, 9, 255 }, 1, 1, 4);
    defer source.deinit();
    try std.testing.expect(try target.drawImage(source, 1, 0, 0, 2, 1, 0, 0, 0, 0, 1, 1, .auto));
    try target.pushScissorRect(0, 0, 1, 1);

    try target.drawText("界", 0, 0, ansi.rgbColor(40, 50, 60, 0), ansi.rgbColor(10, 20, 30, 0), 0);

    try std.testing.expect(gp.isImageChar(target.get(0, 0).?.char));
    try std.testing.expect(gp.isImageChar(target.get(1, 0).?.char));
}

test "OptimizedBuffer wide text is opaque when its continuation covers an image marker" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 2, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer target.deinit();
    const source = try image.createFromRgba(std.testing.allocator, &[_]u8{ 7, 8, 9, 255 }, 1, 1, 4);
    defer source.deinit();
    try std.testing.expect(try target.drawImage(source, 1, 1, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));

    try target.drawText("界", 0, 0, ansi.rgbColor(40, 50, 60, 64), ansi.rgbColor(10, 20, 30, 0), 0);

    try std.testing.expect(gp.isGraphemeChar(target.get(0, 0).?.char));
    try std.testing.expect(gp.isContinuationChar(target.get(1, 0).?.char));
    try std.testing.expectEqual(@as(u8, 255), ansi.alpha(target.get(0, 0).?.fg));
    try std.testing.expectEqual(@as(u8, 255), ansi.alpha(target.get(0, 0).?.bg));
}

test "OptimizedBuffer clipped wide text buffer does not cover image markers" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    var text = try TextBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode);
    defer text.deinit();
    try text.setText("界");
    var view = try TextBufferView.init(std.testing.allocator, text);
    defer view.deinit();

    const target = try OptimizedBuffer.init(std.testing.allocator, 2, 1, .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "clipped-wide-text-buffer" });
    defer target.deinit();
    const source = try image.createFromRgba(std.testing.allocator, &[_]u8{ 7, 8, 9, 255 }, 1, 1, 4);
    defer source.deinit();
    try std.testing.expect(try target.drawImage(source, 1, 0, 0, 2, 1, 0, 0, 0, 0, 1, 1, .auto));
    try target.pushScissorRect(0, 0, 1, 1);

    target.drawTextBuffer(view, 0, 0);

    try std.testing.expect(gp.isImageChar(target.get(0, 0).?.char));
    try std.testing.expect(gp.isImageChar(target.get(1, 0).?.char));
}

test "OptimizedBuffer text buffer does not draw a wide grapheme past its viewport" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    var text = try TextBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode);
    defer text.deinit();
    try text.setText("界");
    var view = try TextBufferView.init(std.testing.allocator, text);
    defer view.deinit();
    view.setViewport(.{ .x = 0, .y = 0, .width = 1, .height = 1 });

    const target = try OptimizedBuffer.init(std.testing.allocator, 2, 1, .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "wide-text-buffer-viewport" });
    defer target.deinit();
    const source = try image.createFromRgba(std.testing.allocator, &[_]u8{ 7, 8, 9, 255 }, 1, 1, 4);
    defer source.deinit();
    try std.testing.expect(try target.drawImage(source, 1, 0, 0, 2, 1, 0, 0, 0, 0, 1, 1, .auto));

    target.drawTextBuffer(view, 0, 0);

    try std.testing.expect(gp.isImageChar(target.get(0, 0).?.char));
    try std.testing.expect(gp.isImageChar(target.get(1, 0).?.char));
}

test "OptimizedBuffer text buffer tab covers image markers after its clipped start" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    var text = try TextBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode);
    defer text.deinit();
    try text.setText("\t");
    var view = try TextBufferView.init(std.testing.allocator, text);
    defer view.deinit();

    const target = try OptimizedBuffer.init(std.testing.allocator, 2, 1, .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "clipped-text-buffer-tab" });
    defer target.deinit();
    const source = try image.createFromRgba(std.testing.allocator, &[_]u8{ 7, 8, 9, 255 }, 1, 1, 4);
    defer source.deinit();
    try std.testing.expect(try target.drawImage(source, 1, 0, 0, 2, 1, 0, 0, 0, 0, 1, 1, .auto));
    try target.pushScissorRect(1, 0, 1, 1);

    target.drawTextBuffer(view, 0, 0);

    try std.testing.expect(gp.isImageChar(target.get(0, 0).?.char));
    try std.testing.expectEqual(@as(u32, ' '), target.get(1, 0).?.char);
}

test "OptimizedBuffer text buffer tab clips a negative draw origin" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    var text = try TextBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode);
    defer text.deinit();
    try text.setText("\t");
    var view = try TextBufferView.init(std.testing.allocator, text);
    defer view.deinit();

    const target = try OptimizedBuffer.init(std.testing.allocator, 1, 1, .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "negative-text-buffer-tab" });
    defer target.deinit();
    const source = try image.createFromRgba(std.testing.allocator, &[_]u8{ 7, 8, 9, 255 }, 1, 1, 4);
    defer source.deinit();
    try std.testing.expect(try target.drawImage(source, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));

    target.drawTextBuffer(view, -1, 0);

    try std.testing.expectEqual(@as(u32, ' '), target.get(0, 0).?.char);
}

test "OptimizedBuffer text buffer clips width-1 text at a negative draw origin" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    var text = try TextBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode);
    defer text.deinit();
    try text.setText("AB");
    var view = try TextBufferView.init(std.testing.allocator, text);
    defer view.deinit();

    const target = try OptimizedBuffer.init(std.testing.allocator, 1, 1, .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "negative-width1-text" });
    defer target.deinit();

    target.drawTextBuffer(view, -1, 0);

    try std.testing.expectEqual(@as(u32, 'B'), target.get(0, 0).?.char);
}

test "OptimizedBuffer image-free frame buffer copy does not allocate" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    const source = try OptimizedBuffer.init(std.testing.allocator, 1, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer source.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 1, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer target.deinit();

    source.set(0, 0, .{
        .char = 'X',
        .fg = ansi.rgbColor(1, 2, 3, 255),
        .bg = ansi.rgbColor(4, 5, 6, 255),
        .attributes = 7,
    });
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0 });
    target.allocator = failing.allocator();
    target.drawFrameBuffer(0, 0, source, null, null, null, null);
    target.allocator = std.testing.allocator;

    try std.testing.expect(!failing.has_induced_failure);
    try std.testing.expectEqual(@as(u32, 'X'), target.get(0, 0).?.char);
}

test "OptimizedBuffer image-free alpha frame buffer copy does not allocate" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    const source = try OptimizedBuffer.init(std.testing.allocator, 1, 1, .{
        .pool = &pool,
        .link_pool = &link_pool,
        .respectAlpha = true,
    });
    defer source.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 1, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer target.deinit();

    source.set(0, 0, .{
        .char = 'X',
        .fg = ansi.rgbColor(1, 2, 3, 255),
        .bg = ansi.rgbColor(4, 5, 6, 255),
        .attributes = 7,
    });
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0 });
    target.allocator = failing.allocator();
    target.drawFrameBuffer(0, 0, source, null, null, null, null);
    target.allocator = std.testing.allocator;

    try std.testing.expect(!failing.has_induced_failure);
    try std.testing.expectEqual(@as(u32, 'X'), target.get(0, 0).?.char);
}

fn initBufferForOomRegression(allocator: std.mem.Allocator) !void {
    var local_pool = gp.GraphemePool.initWithOptions(allocator, .{});
    defer local_pool.deinit();

    var local_link_pool = link.LinkPool.init(allocator);
    defer local_link_pool.deinit();

    var buf = try OptimizedBuffer.init(
        allocator,
        1,
        1,
        .{ .pool = &local_pool, .id = "oom-regression", .link_pool = &local_link_pool },
    );
    defer buf.deinit();
}

test "OptimizedBuffer - init frees allocations on OOM" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, initBufferForOomRegression, .{});
}

test "OptimizedBuffer - init and deinit" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        10,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    try std.testing.expectEqual(@as(u32, 10), buf.getWidth());
    try std.testing.expectEqual(@as(u32, 10), buf.getHeight());
}

test "OptimizedBuffer - clear fills with default char" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        5,
        5,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    buf.clear(bg, null);

    var y: u32 = 0;
    while (y < 5) : (y += 1) {
        var x: u32 = 0;
        while (x < 5) : (x += 1) {
            const cell = buf.get(x, y).?;
            try std.testing.expectEqual(@as(u32, 32), cell.char);
        }
    }
}

test "OptimizedBuffer - drawText with ASCII" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        5,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    buf.clear(bg, null);

    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    try buf.drawText("Hello", 0, 0, fg, bg, 0);

    const cell_h = buf.get(0, 0).?;
    try std.testing.expectEqual(@as(u32, 'H'), cell_h.char);

    const cell_e = buf.get(1, 0).?;
    try std.testing.expectEqual(@as(u32, 'e'), cell_e.char);
}

test "OptimizedBuffer drawTextBufferChecked returns errors at every drawing allocation" {
    for ([_]bool{ false, true }) |fail_metadata| {
        var failures: usize = 0;
        var succeeded = false;
        for (0..96) |fail_after| {
            var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
            const allocator = failing.allocator();
            var pool = gp.GraphemePool.initWithOptions(allocator, .{ .slots_per_page = .{ 1, 1, 1, 1, 1 } });
            defer pool.deinit();
            var links = link.LinkPool.init(allocator);
            defer links.deinit();
            const target = try OptimizedBuffer.init(allocator, 16, 2, .{ .pool = &pool, .link_pool = &links });
            defer target.deinit();
            const text = try TextBuffer.init(allocator, &pool, &links, .unicode);
            defer text.deinit();
            const view = try TextBufferView.init(allocator, text);
            defer view.deinit();
            try text.setText("\u{3a9}\u{4e16}e\u{301}\tZ\u{3b1}\u{3b2}\u{3b3}\u{3b4}\u{3b5}\nlast");
            view.setViewport(.{ .x = 0, .y = 0, .width = 16, .height = 2 });
            _ = view.getVirtualLines();
            const kept = try pool.acquire("\u{3a9}");
            defer pool.decref(kept) catch unreachable;
            const kept_link = try links.acquire("https://kept.example");
            defer links.decref(kept_link) catch unreachable;
            text.setDefaultAttributes(ansi.TextAttributes.setLinkId(1, kept_link));
            const old_allocator = text.allocator;
            var metadata = std.testing.FailingAllocator.init(old_allocator, .{});
            text.allocator = metadata.allocator();
            defer text.allocator = old_allocator;
            const injected = if (fail_metadata) &metadata else &failing;
            injected.fail_index = injected.alloc_index + fail_after;
            injected.resize_fail_index = injected.resize_index;
            const result = target.drawTextBufferChecked(view, 0, 0);
            injected.fail_index = std.math.maxInt(usize);
            injected.resize_fail_index = std.math.maxInt(usize);
            if (result) |_| {
                try std.testing.expect(!injected.has_induced_failure);
                succeeded = true;
            } else |err| {
                try std.testing.expectEqual(error.OutOfMemory, err);
                try std.testing.expect(injected.has_induced_failure);
                failures += 1;
            }
            // Checked view drawing can leave partial cells; its scene owner clears on error.
            target.clear(ansi.rgbColor(0, 0, 0, 255), null);
            try std.testing.expectEqual(@as(u32, 1), try pool.getRefcount(kept));
            try std.testing.expectEqual(@as(u32, 1), try links.getRefcount(kept_link));
            try std.testing.expectEqual(@as(u32, 1), pool.interned_live_ids.count());
            var allocated: usize = 0;
            for (pool.classes) |class| allocated += class.num_slots - class.free_list.items.len;
            try std.testing.expectEqual(@as(usize, 1), allocated);
            try target.drawTextBufferChecked(view, 0, 0);
            try std.testing.expectEqualStrings("\u{3a9}", try pool.get(gp.graphemeIdFromChar(target.get(0, 0).?.char)));
            try std.testing.expectEqual(@as(u32, 'l'), target.get(0, 1).?.char);
            if (succeeded) break;
        }
        try std.testing.expect(succeeded);
        try std.testing.expect(failures > 0);
    }
}

test "OptimizedBuffer drawTextBuffer transparent glyphs reclaim pending slots and preserve live references" {
    for ([_]bool{ false, true }) |checked| {
        var pool = gp.GraphemePool.initWithOptions(std.testing.allocator, .{ .slots_per_page = .{ 1, 1, 1, 1, 1 } });
        defer pool.deinit();
        var links = link.LinkPool.init(std.testing.allocator);
        defer links.deinit();
        const target = try OptimizedBuffer.init(std.testing.allocator, 4, 1, .{ .pool = &pool, .link_pool = &links });
        defer target.deinit();
        target.clear(ansi.rgbColor(0, 0, 0, 255), null);
        const text = try TextBuffer.init(std.testing.allocator, &pool, &links, .unicode);
        defer text.deinit();
        const view = try TextBufferView.init(std.testing.allocator, text);
        defer view.deinit();
        try text.setText("\u{754c}\u{4e16}");
        text.setDefaultFg(ansi.rgbColor(200, 100, 50, 0));
        text.setDefaultBg(ansi.rgbColor(10, 20, 30, 0));
        view.setViewport(.{ .x = 0, .y = 0, .width = 4, .height = 1 });
        const kept = try pool.acquire("\u{4e16}");
        defer pool.decref(kept) catch unreachable;
        for (0..400) |_| {
            if (checked) try target.drawTextBufferChecked(view, 0, 0) else target.drawTextBuffer(view, 0, 0);
            try std.testing.expectEqual(@as(u32, 1), try pool.getRefcount(kept));
            var allocated: usize = 0;
            for (pool.classes) |class| allocated += class.num_slots - class.free_list.items.len;
            try std.testing.expectEqual(@as(usize, 1), allocated);
        }
        try std.testing.expectEqualSlices(u32, &.{ ' ', ' ', ' ', ' ' }, target.buffer.char);
        try std.testing.expectEqual(@as(u32, 0), target.grapheme_tracker.getGraphemeCount());
    }
}

test "OptimizedBuffer drawTextChecked validates all input before drawing and enforces text limits" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 4, 1, .{ .pool = &pool, .link_pool = &links });
    defer target.deinit();
    const fg = ansi.rgbColor(255, 128, 64, 255);
    const bg = ansi.rgbColor(1, 2, 3, 255);
    target.clear(bg, null);
    const link_id = try links.acquire("https://kept.example");
    try target.drawText("\u{3a9}old", 0, 0, fg, bg, ansi.TextAttributes.setLinkId(1, link_id));
    try links.decref(link_id);
    const old_id = gp.graphemeIdFromChar(target.buffer.char[0]);
    const chars = target.buffer.char[0..4].*;
    const foreground = target.buffer.fg[0..4].*;
    const background = target.buffer.bg[0..4].*;
    const attributes = target.buffer.attributes[0..4].*;
    for ([_][]const u8{ "ok\xff", "\x80", "\xc0\xaf", "\xed\xa0\x80", "\xf4\x90\x80\x80", "\xf0\x9f" }) |text| {
        try std.testing.expectError(error.InvalidUnicode, target.drawTextChecked(text, 0, 0, fg, bg, 0));
        try std.testing.expectError(error.InvalidUnicode, target.drawTextChecked(text, std.math.maxInt(i32), 0, fg, bg, 0));
    }
    for ([_]u32{ 0x100, 0x8000_0000, std.math.maxInt(u32) }) |style| {
        try std.testing.expectError(error.InvalidOptions, target.drawTextChecked("bad", 0, 0, fg, bg, style));
    }
    for ([_]RGBA{ .{ 256, 0, 0, 255 }, .{ 0, 0, 0, 256 }, ansi.withMeta(fg, 0x300), ansi.withMeta(bg, 0x201) }) |color| {
        try std.testing.expectError(error.InvalidOptions, target.drawTextChecked("bad", 0, 0, color, bg, 0));
        try std.testing.expectError(error.InvalidOptions, target.drawTextChecked("bad", 0, 0, fg, color, 0));
    }
    for ([_]buffer_mod.ClipRect{
        .{ .x = 0, .y = 0, .width = std.math.maxInt(u32), .height = 1 },
        .{ .x = 0, .y = 0, .width = 1, .height = std.math.maxInt(u32) },
        .{ .x = std.math.maxInt(i32), .y = 0, .width = 1, .height = 1 },
        .{ .x = 0, .y = std.math.maxInt(i32), .width = 1, .height = 1 },
    }) |clip| {
        try target.pushScissorRect(clip.x, clip.y, clip.width, clip.height);
        try std.testing.expectError(error.InvalidOptions, target.drawTextChecked("bad", 0, 0, fg, bg, 0));
        target.clearScissorRects();
    }
    const over_limit = "x" ** (buffer_mod.text_bytes_max + 1);
    try std.testing.expectError(error.TextLimit, target.drawTextChecked(over_limit, 0, 0, fg, bg, 0));
    try std.testing.expectError(error.InvalidUnicode, target.drawTextChecked("x" ** (buffer_mod.text_bytes_max - 1) ++ "\xff", 0, 0, fg, bg, 0));
    try std.testing.expectEqualSlices(u32, &chars, target.buffer.char);
    try std.testing.expectEqualSlices(RGBA, &foreground, target.buffer.fg);
    try std.testing.expectEqualSlices(RGBA, &background, target.buffer.bg);
    try std.testing.expectEqualSlices(u32, &attributes, target.buffer.attributes);
    try std.testing.expectEqual(1, pool.interned_live_ids.count());
    try std.testing.expectEqual(1, try pool.getRefcount(old_id));
    try std.testing.expectEqual(1, try links.getRefcount(link_id));

    try target.drawTextChecked("x" ** buffer_mod.text_bytes_max, 0, 0, fg, bg, 0xff);
    try std.testing.expectEqualSlices(u32, &.{ 'x', 'x', 'x', 'x' }, target.buffer.char);
    try std.testing.expectEqualSlices(u32, &.{ 0xff, 0xff, 0xff, 0xff }, target.buffer.attributes);
    try target.drawTextChecked("\u{e9}" ++ "\u{301}" ** 63, 0, 0, fg, bg, 0);
    try std.testing.expectEqual(128, (try pool.get(gp.graphemeIdFromChar(target.buffer.char[0]))).len);
}

test "OptimizedBuffer drawTextChecked copies input before its supplied pool grows" {
    var moving = std.testing.FailingAllocator.init(std.testing.allocator, .{ .resize_fail_index = 0 });
    var pool = gp.GraphemePool.initWithOptions(moving.allocator(), .{ .slots_per_page = .{ 1, 1, 1, 1, 1 } });
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const text = "e" ++ "\u{301}" ** 4 ++ "X";
    // The source and its first drawn cluster share the 16-byte class.
    try pool.classes[1].slots.ensureTotalCapacityPrecise(moving.allocator(), pool.classes[1].slot_size_bytes);
    const source = try pool.acquire(text);
    defer pool.decref(source) catch unreachable;
    const target = try OptimizedBuffer.init(std.testing.allocator, 2, 1, .{ .pool = &pool, .link_pool = &links });
    defer target.deinit();
    const borrowed = try pool.get(source);
    const old_address = @intFromPtr(borrowed.ptr);
    try target.drawTextChecked(borrowed, 0, 0, ansi.rgbColor(255, 255, 255, 255), ansi.rgbColor(0, 0, 0, 255), 0);
    try std.testing.expect(old_address != @intFromPtr((try pool.get(source)).ptr));
    try std.testing.expectEqualStrings(text, try pool.get(source));
    try std.testing.expectEqualStrings(text[0 .. text.len - 1], try pool.get(gp.graphemeIdFromChar(target.buffer.char[0])));
    try std.testing.expectEqual(@as(u32, 'X'), target.buffer.char[1]);
}

test "OptimizedBuffer drawTextChecked rejects image targets without materializing or releasing them" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 2, 1, .{ .pool = &pool, .link_pool = &links });
    defer target.deinit();
    const source = try image.createFromRgba(std.testing.allocator, &.{ 255, 0, 0, 255 }, 1, 1, 4);
    defer source.deinit();
    try std.testing.expect(try target.drawImage(source, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));
    const before = target.get(0, 0).?;
    const placement = target.image_placements.items[0];
    const fg = ansi.rgbColor(255, 255, 255, 255);
    for ([_][]const u8{ "\u{e9}", "" }) |text| {
        try std.testing.expectError(error.UnsupportedResource, target.drawTextChecked(text, 0, 0, fg, null, 0));
        try std.testing.expectEqualDeep(before, target.get(0, 0).?);
        try std.testing.expectEqualDeep(placement, target.image_placements.items[0]);
        try std.testing.expectEqual(1, target.image_placements.items.len);
        try std.testing.expectEqual(2, source.ref_count);
        try std.testing.expectEqual(0, pool.interned_live_ids.count());
    }
}

test "OptimizedBuffer drawTextChecked skips complete zero width UTF-8 codepoints" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 8, 1, .{ .pool = &pool, .link_pool = &links });
    defer target.deinit();
    const fg = ansi.rgbColor(255, 255, 255, 255);
    const bg = ansi.rgbColor(0, 0, 0, 255);
    target.clear(bg, null);
    try target.drawTextChecked("\u{200b}\u{200d}" ++ "\u{301}" ** 1024, 0, 0, fg, bg, 0);
    try std.testing.expectEqualSlices(u32, &([_]u32{' '} ** 8), target.buffer.char);
    try std.testing.expectEqual(0, pool.interned_live_ids.count());
    try target.drawTextChecked("\u{200b}A\u{200b}\t\u{200d}\u{4e2d}\u{200b}Z", 0, 0, fg, bg, 0);
    try std.testing.expectEqual(@as(u32, 'A'), target.buffer.char[0]);
    try std.testing.expectEqual(@as(u32, ' '), target.buffer.char[1]);
    try std.testing.expectEqual(@as(u32, ' '), target.buffer.char[2]);
    try std.testing.expectEqualStrings("\u{4e2d}", try pool.get(gp.graphemeIdFromChar(target.buffer.char[3])));
    try std.testing.expect(gp.isContinuationChar(target.buffer.char[4]));
    try std.testing.expectEqual(@as(u32, 'Z'), target.buffer.char[5]);
}

/// A cluster that a cell cannot hold and the text that every checked draw must render in its place.
const UnprintableText = struct { bytes: []const u8, blank: []const u8, line_break: bool = false };
const unprintable_texts = [_]UnprintableText{
    .{ .bytes = "\x00", .blank = "" },
    .{ .bytes = "\x07", .blank = "" },
    .{ .bytes = "\x1b", .blank = "" },
    .{ .bytes = "\x7f", .blank = "" },
    .{ .bytes = "\u{85}", .blank = "" },
    .{ .bytes = "\u{9b}", .blank = "" },
    .{ .bytes = "\n", .blank = "", .line_break = true },
    .{ .bytes = "\r", .blank = "", .line_break = true },
    .{ .bytes = "\r\n", .blank = "", .line_break = true },
    // The grapheme pool stores at most 128 bytes; a longer cluster keeps its cell width.
    .{ .bytes = "e" ++ "\u{301}" ** 64, .blank = " " },
    .{ .bytes = "e" ++ "\u{301}" ** 100, .blank = " " },
    .{ .bytes = "\u{4e2d}" ++ "\u{301}" ** 63, .blank = "  " },
};

const CheckedTextPath = enum { text, box_title, text_view, editor_view };

fn drawCheckedText(path: CheckedTextPath, target: *OptimizedBuffer, pools: *TestPools, text: []const u8) !void {
    const fg = ansi.rgbColor(250, 240, 230, 255);
    const bg = ansi.rgbColor(10, 20, 30, 255);
    switch (path) {
        .text => try target.drawTextChecked(text, 0, 0, fg, bg, 0),
        .box_title => {
            const border_chars = [_]u32{ 0x250c, 0x2510, 0x2514, 0x2518, 0x2500, 0x2502, 0, 0, 0, 0, 0 };
            const sides: buffer_mod.BorderSides = .{ .top = true, .right = true, .bottom = true, .left = true };
            try target.drawBoxChecked(0, 0, target.width, 3, &border_chars, sides, fg, bg, fg, false, text, 0, null, 0);
        },
        .text_view => {
            const content = try TextBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode);
            defer content.deinit();
            const view = try TextBufferView.init(std.testing.allocator, content);
            defer view.deinit();
            try content.setText(text);
            content.setDefaultFg(fg);
            content.setDefaultBg(bg);
            try target.drawTextBufferChecked(view, 0, 0);
        },
        .editor_view => {
            const content = try edit_buffer.EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode, null);
            defer content.deinit();
            const view = try editor_view.EditorView.init(std.testing.allocator, content, target.width, 1);
            defer view.deinit();
            try content.setText(text);
            content.getTextBuffer().setDefaultFg(fg);
            content.getTextBuffer().setDefaultBg(bg);
            try target.drawEditorViewChecked(view, 0, 0);
        },
    }
}

/// No checked draw may store a code point that moves the terminal cursor when the renderer prints it.
fn expectNoControlCells(target: *OptimizedBuffer) !void {
    for (target.buffer.char) |char| {
        if (gp.isContinuationChar(char) or gp.isImageChar(char)) continue;
        if (gp.isGraphemeChar(char)) {
            const bytes = try target.pool.get(gp.graphemeIdFromChar(char));
            var codepoints = (try std.unicode.Utf8View.init(bytes)).iterator();
            while (codepoints.nextCodepoint()) |codepoint| {
                try std.testing.expect(codepoint >= 0x20 and (codepoint < 0x7f or codepoint > 0x9f));
            }
        } else {
            try std.testing.expect(char >= 0x20 and (char < 0x7f or char > 0x9f));
        }
    }
}

test "OptimizedBuffer checked text draws skip controls and blank clusters a cell cannot hold" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    // The blank rule starts where the pool stops storing a cluster.
    const longest = try pools.graphemes.acquire("\u{e9}" ++ "\u{301}" ** 63);
    try pools.graphemes.decref(longest);
    try std.testing.expectError(error.GraphemeTooLong, pools.graphemes.acquire(unprintable_texts[9].bytes));

    const actual = try OptimizedBuffer.init(std.testing.allocator, 12, 3, .{ .pool = &pools.graphemes, .link_pool = &pools.links });
    defer actual.deinit();
    const expected = try OptimizedBuffer.init(std.testing.allocator, 12, 3, .{ .pool = &pools.graphemes, .link_pool = &pools.links });
    defer expected.deinit();
    const Position = enum { start, middle, end };
    // The second clip cuts the wide blank in the middle row of the text and box paths.
    const clips = [_]?buffer_mod.ClipRect{ null, .{ .x = 3, .y = 0, .width = 2, .height = 3 } };
    var with_buffer: [256]u8 = undefined;
    var blank_buffer: [256]u8 = undefined;
    for (std.enums.values(CheckedTextPath)) |path| {
        for (unprintable_texts) |unprintable| {
            // Text resources split lines at line breaks; they are not glyphs there.
            if (unprintable.line_break and (path == .text_view or path == .editor_view)) continue;
            for (std.enums.values(Position)) |position| {
                const prefix, const suffix = switch (position) {
                    .start => .{ "", "abcd" },
                    .middle => .{ "ab", "cd" },
                    .end => .{ "abcd", "" },
                };
                const with = try std.fmt.bufPrint(&with_buffer, "{s}{s}{s}", .{ prefix, unprintable.bytes, suffix });
                const blank = try std.fmt.bufPrint(&blank_buffer, "{s}{s}{s}", .{ prefix, unprintable.blank, suffix });
                for (clips) |clip| {
                    errdefer std.debug.print("path={t} text={any} position={t} clip={any}\n", .{ path, unprintable.bytes, position, clip });
                    for ([_]*OptimizedBuffer{ actual, expected }) |target| {
                        target.clear(ansi.rgbColor(0, 0, 0, 255), null);
                        if (clip) |rect| try target.pushScissorRect(rect.x, rect.y, rect.width, rect.height);
                    }
                    defer for ([_]*OptimizedBuffer{ actual, expected }) |target| target.clearScissorRects();
                    try drawCheckedText(path, actual, &pools, with);
                    try drawCheckedText(path, expected, &pools, blank);
                    try std.testing.expectEqualSlices(u32, expected.buffer.char, actual.buffer.char);
                    try std.testing.expectEqualSlices(u32, expected.buffer.attributes, actual.buffer.attributes);
                    for (expected.buffer.fg, actual.buffer.fg) |want, got| try std.testing.expect(buffer_mod.rgbaEqual(want, got));
                    for (expected.buffer.bg, actual.buffer.bg) |want, got| try std.testing.expect(buffer_mod.rgbaEqual(want, got));
                    try expectNoControlCells(actual);
                }
            }
        }
    }
}

test "OptimizedBuffer checked grapheme draws write blank cells for clusters a cell cannot hold" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    const actual = try OptimizedBuffer.init(std.testing.allocator, 6, 1, .{ .pool = &pools.graphemes, .link_pool = &pools.links });
    defer actual.deinit();
    const expected = try OptimizedBuffer.init(std.testing.allocator, 6, 1, .{ .pool = &pools.graphemes, .link_pool = &pools.links });
    defer expected.deinit();
    const fg = ansi.rgbColor(250, 240, 230, 255);
    const bg = ansi.rgbColor(10, 20, 30, 255);
    const attributes = ansi.TextAttributes.BOLD;
    const Glyph = struct { bytes: []const u8, width: u8 };
    const glyphs = [_]Glyph{
        .{ .bytes = "\x7f", .width = 1 },
        .{ .bytes = "\x1b", .width = 1 },
        .{ .bytes = "\t", .width = 1 },
        .{ .bytes = "\u{85}", .width = 1 },
        .{ .bytes = "\u{9b}", .width = 2 },
        .{ .bytes = "e" ++ "\u{301}" ** 64, .width = 1 },
        .{ .bytes = "\u{4e2d}" ++ "\u{301}" ** 63, .width = 2 },
    };
    for (glyphs) |glyph| {
        for ([_]u32{ 0, 2, 6 - glyph.width }) |x| {
            // The authoritative width draws all cells of a glyph or none of them.
            const clips = [_]?buffer_mod.ClipRect{ null, .{ .x = 0, .y = 0, .width = 6, .height = 1 }, .{ .x = @intCast(x + 1), .y = 0, .width = 6, .height = 1 } };
            for (clips, 0..) |clip, clip_index| {
                errdefer std.debug.print("glyph={any} x={d} clip={any}\n", .{ glyph.bytes, x, clip });
                for ([_]*OptimizedBuffer{ actual, expected }) |target| {
                    target.clear(ansi.rgbColor(0, 0, 0, 255), null);
                    target.set(5, 0, .{ .char = 'Z', .fg = fg, .bg = bg, .attributes = 0 });
                    if (clip) |rect| try target.pushScissorRect(rect.x, rect.y, rect.width, rect.height);
                }
                defer for ([_]*OptimizedBuffer{ actual, expected }) |target| target.clearScissorRects();
                try actual.drawGraphemeChecked(glyph.bytes, glyph.width, x, 0, fg, bg, attributes);
                if (clip_index != 2) {
                    for (0..glyph.width) |offset| try expected.drawGraphemeChecked(" ", 1, x + @as(u32, @intCast(offset)), 0, fg, bg, attributes);
                }
                try std.testing.expectEqualSlices(u32, expected.buffer.char, actual.buffer.char);
                try std.testing.expectEqualSlices(u32, expected.buffer.attributes, actual.buffer.attributes);
                for (expected.buffer.fg, actual.buffer.fg) |want, got| try std.testing.expect(buffer_mod.rgbaEqual(want, got));
                for (expected.buffer.bg, actual.buffer.bg) |want, got| try std.testing.expect(buffer_mod.rgbaEqual(want, got));
                try expectNoControlCells(actual);
            }
        }
    }
    try std.testing.expectEqual(0, pools.graphemes.interned_live_ids.count());
}

fn expectSameCells(expected: *OptimizedBuffer, actual: *OptimizedBuffer) !void {
    for (expected.buffer.char, actual.buffer.char) |want, got| {
        if (gp.isGraphemeChar(want) and gp.isGraphemeChar(got)) {
            try std.testing.expectEqualStrings(try expected.pool.get(gp.graphemeIdFromChar(want)), try actual.pool.get(gp.graphemeIdFromChar(got)));
        } else {
            try std.testing.expectEqual(want, got);
        }
    }
    try std.testing.expectEqualSlices(u32, expected.buffer.attributes, actual.buffer.attributes);
    for (expected.buffer.fg, actual.buffer.fg) |want, got| try std.testing.expect(buffer_mod.rgbaEqual(want, got));
    for (expected.buffer.bg, actual.buffer.bg) |want, got| try std.testing.expect(buffer_mod.rgbaEqual(want, got));
}

test "OptimizedBuffer text views attach a combining mark only to the glyph drawn before it" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    const fg = ansi.rgbColor(200, 100, 50, 255);
    const bg = ansi.rgbColor(10, 20, 30, 255);
    // A mark in its own chunk combines with the glyph before it, like the same cluster in one chunk.
    for ([_]f32{ 1.0, 0.5 }) |opacity| {
        const one_chunk = try OptimizedBuffer.init(std.testing.allocator, 4, 1, .{ .pool = &pools.graphemes, .link_pool = &pools.links });
        defer one_chunk.deinit();
        const two_chunks = try OptimizedBuffer.init(std.testing.allocator, 4, 1, .{ .pool = &pools.graphemes, .link_pool = &pools.links });
        defer two_chunks.deinit();
        for ([_]*OptimizedBuffer{ one_chunk, two_chunks }, [_][]const []const u8{ &.{"a\u{301}b"}, &.{ "a", "\u{301}b" } }) |target, chunks| {
            target.clear(ansi.rgbColor(0, 0, 0, 255), null);
            const content = try TextBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode);
            defer content.deinit();
            const view = try TextBufferView.init(std.testing.allocator, content);
            defer view.deinit();
            try content.setText(chunks[0]);
            for (chunks[1..]) |chunk| try content.append(chunk);
            content.setDefaultFg(fg);
            content.setDefaultBg(bg);
            try target.pushOpacity(opacity);
            try target.drawTextBufferChecked(view, 0, 0);
        }
        try std.testing.expectEqualStrings("a\u{301}", try pools.graphemes.get(gp.graphemeIdFromChar(two_chunks.buffer.char[0])));
        try expectSameCells(one_chunk, two_chunks);
    }

    // A mark whose base glyph this draw did not write leaves the cell left of the view unchanged.
    const target = try OptimizedBuffer.init(std.testing.allocator, 6, 1, .{ .pool = &pools.graphemes, .link_pool = &pools.links });
    defer target.deinit();
    const Case = struct { chunks: []const []const u8, scroll_x: u32 };
    for ([_]Case{
        .{ .chunks = &.{"\u{301}ab"}, .scroll_x = 0 },
        .{ .chunks = &.{ "x", "\u{301}ab" }, .scroll_x = 1 },
        .{ .chunks = &.{ "\u{4e2d}", "\u{301}ab" }, .scroll_x = 2 },
    }) |case| {
        target.clear(ansi.rgbColor(0, 0, 0, 255), null);
        target.set(1, 0, .{ .char = 'Z', .fg = fg, .bg = bg, .attributes = 0 });
        const content = try TextBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode);
        defer content.deinit();
        const view = try TextBufferView.init(std.testing.allocator, content);
        defer view.deinit();
        try content.setText(case.chunks[0]);
        for (case.chunks[1..]) |chunk| try content.append(chunk);
        view.setViewport(.{ .x = case.scroll_x, .y = 0, .width = 4, .height = 1 });
        try target.drawTextBufferChecked(view, 2, 0);
        try std.testing.expectEqualSlices(u32, &.{ ' ', 'Z', 'a', 'b', ' ', ' ' }, target.buffer.char);
    }
    try std.testing.expectEqual(0, pools.graphemes.interned_live_ids.count());
}

test "OptimizedBuffer - drawGrapheme preserves authoritative width" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(std.testing.allocator, 4, 1, .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "grapheme-width-buffer" });
    defer buf.deinit();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);

    try buf.drawGrapheme("A", 2, 0, 0, fg, bg, 0);
    try std.testing.expect(gp.isGraphemeChar(buf.get(0, 0).?.char));
    try std.testing.expect(gp.isContinuationChar(buf.get(1, 0).?.char));
}

test "OptimizedBuffer - alpha blending downgrades blended metadata to rgb" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        4,
        1,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "tag-blend-buffer" },
    );
    defer buf.deinit();

    const base_bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    buf.clear(base_bg, null);

    buf.setCellWithAlphaBlending(
        0,
        0,
        'B',
        ansi.packRGBA8(255, 0, 0, 128, ansi.packMeta(.indexed, 3)),
        base_bg,
        0,
    );

    const fg_blended_cell = buf.get(0, 0).?;
    try std.testing.expectEqual(ansi.ColorIntent.rgb, ansi.intent(fg_blended_cell.fg));
    try std.testing.expectEqual(ansi.ColorIntent.rgb, ansi.intent(fg_blended_cell.bg));

    // Establish a destination foreground, then blend background alpha over it.
    buf.set(0, 0, .{
        .char = 'A',
        .fg = ansi.indexedColor(1, 255, 255, 255),
        .bg = ansi.indexedColor(2, 0, 0, 0),
        .attributes = 0,
    });

    buf.setCellWithAlphaBlending(
        0,
        0,
        'C',
        ansi.indexedColor(5, 255, 0, 0),
        ansi.packRGBA8(0, 255, 0, 128, ansi.packMeta(.indexed, 6)),
        0,
    );

    const bg_blended_cell = buf.get(0, 0).?;
    try std.testing.expectEqual(ansi.ColorIntent.indexed, ansi.intent(bg_blended_cell.fg));
    try std.testing.expectEqual(@as(u8, 5), ansi.slot(bg_blended_cell.fg));
    try std.testing.expectEqual(ansi.ColorIntent.rgb, ansi.intent(bg_blended_cell.bg));
}

test "OptimizedBuffer - blending cell setters skip coordinates outside the buffer" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(std.testing.allocator, 2, 2, .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "outside-cell-setters" });
    defer buf.deinit();

    const base_bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    buf.clear(base_bg, null);
    const opaque_fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const translucent_bg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 0.5);

    // A u32 coordinate at or above 2^31 has no i32 value for the scissor check.
    const outside = [_]u32{ 2, std.math.maxInt(i32) + 1, std.math.maxInt(u32) };
    for ([_]bool{ false, true }) |scissored| {
        if (scissored) try buf.pushScissorRect(0, 0, 2, 2);
        for (outside) |coordinate| {
            const points = [_][2]u32{ .{ coordinate, 0 }, .{ 0, coordinate } };
            for (points) |point| {
                buf.drawChar('X', point[0], point[1], opaque_fg, base_bg, 0);
                buf.drawChar('X', point[0], point[1], opaque_fg, translucent_bg, 0);
                buf.setCellWithAlphaBlending(point[0], point[1], 'X', opaque_fg, translucent_bg, 0);
                buf.setCellWithAlphaBlendingRaw(point[0], point[1], 'X', opaque_fg, translucent_bg, 0);
            }
        }
    }

    for (0..2) |y| {
        for (0..2) |x| {
            try std.testing.expectEqual(buffer_mod.DEFAULT_SPACE_CHAR, buf.get(@intCast(x), @intCast(y)).?.char);
        }
    }
}

fn expectRowChars(buf: *OptimizedBuffer, y: u32, expected: []const u8) !void {
    for (expected, 0..) |char, x| {
        try std.testing.expectEqual(@as(u32, char), buf.get(@intCast(x), y).?.char);
    }
}

test "OptimizedBuffer - text and rectangles at signed positions draw their visible part" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(std.testing.allocator, 4, 5, .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "signed-draw-positions" });
    defer buf.deinit();

    const black = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const white = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const min = std.math.minInt(i32);
    buf.clear(black, null);

    // Opaque printable ASCII uses the byte fast path. Text without a background uses the cluster path.
    try buf.drawTextClipped("ABCDE", -2, 0, white, black, 0);
    // The wide glyph covers columns -1 and 0, so it is clipped and column 0 keeps its cell.
    try buf.drawTextClipped("A世BC", -2, 1, white, null, 0);
    try buf.drawTextClipped("\tX", -1, 2, white, red, 0);
    try buf.drawTextClipped("e\u{301}XY", -1, 3, white, null, 0);
    try buf.pushScissorRect(1, 4, 2, 1);
    try buf.drawTextClipped("WXYZ", -1, 4, white, null, 0);
    buf.popScissorRect();
    // These draws have no cell inside the buffer.
    try buf.drawTextClipped("ZZZZ", 0, -1, white, black, 0);
    try buf.drawTextClipped("ZZZZ", min, 0, white, black, 0);
    try buf.drawTextClipped("Z世ZZ", min, 0, white, null, 0);

    try expectRowChars(buf, 0, "CDE ");
    try expectRowChars(buf, 1, " BC ");
    try expectRowChars(buf, 2, " X  ");
    try std.testing.expect(buffer_mod.rgbaEqual(red, buf.get(0, 2).?.bg));
    try expectRowChars(buf, 3, "XY  ");
    try expectRowChars(buf, 4, " YZ ");

    buf.fillRectClipped(-1, -1, 2, 2, red);
    buf.fillRectClipped(std.math.maxInt(i32), min, std.math.maxInt(u32), std.math.maxInt(u32), white);
    buf.fillRectClipped(min, 4, std.math.maxInt(u32), 1, red);

    try std.testing.expect(buffer_mod.rgbaEqual(red, buf.get(0, 0).?.bg));
    try std.testing.expect(buffer_mod.rgbaEqual(black, buf.get(1, 0).?.bg));
    try std.testing.expect(buffer_mod.rgbaEqual(black, buf.get(0, 1).?.bg));
    try std.testing.expect(buffer_mod.rgbaEqual(red, buf.get(3, 4).?.bg));
}

test "OptimizedBuffer - pixel buffers at signed positions draw their visible part" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(std.testing.allocator, 2, 1, .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "signed-pixel-buffers" });
    defer buf.deinit();
    const black = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);

    // Two cells of 2x2 RGBA pixels: a red cell, then a blue cell.
    const red = [4]u8{ 255, 0, 0, 255 };
    const blue = [4]u8{ 0, 0, 255, 255 };
    const pixels = red ++ red ++ blue ++ blue ++ red ++ red ++ blue ++ blue;

    buf.drawSuperSampleBuffer(0, 0, &pixels, pixels.len, 1, 16);
    const blue_cell = buf.get(1, 0).?;
    buf.clear(black, null);
    // The visible cells of the first two draws map past the end of the pixels.
    buf.drawSuperSampleBuffer(std.math.minInt(i32), 0, &pixels, pixels.len, 1, std.math.maxInt(u32));
    buf.drawSuperSampleBuffer(0, std.math.minInt(i32), &pixels, pixels.len, 1, std.math.maxInt(u32));
    buf.drawSuperSampleBuffer(-1, 0, &pixels, pixels.len, 1, 16);

    const cell = buf.get(0, 0).?;
    try std.testing.expectEqual(blue_cell.char, cell.char);
    try std.testing.expect(buffer_mod.rgbaEqual(blue_cell.fg, cell.fg));
    try std.testing.expect(buffer_mod.rgbaEqual(blue_cell.bg, cell.bg));

    // Each packed cell is bg(4 f32), fg(4 f32), char(u32), and 12 padding bytes.
    const packed_cells = [2][12]f32{
        .{ 0, 0, 0, 1, 1, 1, 1, 1, @bitCast(@as(u32, 'A')), 0, 0, 0 },
        .{ 0, 0, 0, 1, 1, 1, 1, 1, @bitCast(@as(u32, 'B')), 0, 0, 0 },
    };
    const packed_bytes = std.mem.sliceAsBytes(&packed_cells);

    buf.clear(black, null);
    buf.drawPackedBuffer(packed_bytes.ptr, packed_bytes.len, -1, 0, 2, 1);
    buf.drawPackedBuffer(packed_bytes.ptr, packed_bytes.len, 0, -1, 2, 1);
    buf.drawPackedBuffer(packed_bytes.ptr, packed_bytes.len, 0, 0, 0, 1);

    try expectRowChars(buf, 0, "B ");
}

test "OptimizedBuffer - checked text at signed positions clips like drawTextClipped" {
    const black = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const white = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const min = std.math.minInt(i32);
    const Draw = struct { text: []const u8, x: i32, y: i32, bg: ?RGBA, scissor: bool = false };
    const draws = [_]Draw{
        .{ .text = "ABCDE", .x = -2, .y = 0, .bg = black },
        .{ .text = "A\u{4e16}BC", .x = -2, .y = 1, .bg = null },
        .{ .text = "\tX", .x = -1, .y = 2, .bg = red },
        .{ .text = "\tY", .x = -2, .y = 2, .bg = red },
        .{ .text = "e\u{301}XY", .x = -1, .y = 3, .bg = null },
        .{ .text = "WXYZ", .x = -1, .y = 4, .bg = null, .scissor = true },
        .{ .text = "AB\u{4e16}", .x = -1, .y = 5, .bg = null },
        .{ .text = "ZZZZ", .x = 0, .y = -1, .bg = black },
        .{ .text = "ZZZZ", .x = min, .y = 0, .bg = black },
        .{ .text = "Z\u{4e16}ZZ", .x = min, .y = 0, .bg = null },
        // Sparse cluster metadata omits zero-width code points and controls.
        .{ .text = "\u{200b}A\u{200d}\u{4e2d}Z", .x = 0, .y = 6, .bg = black },
        .{ .text = "a\x1b\u{4e2d}\u{85}b", .x = 0, .y = 7, .bg = null },
        .{ .text = "x" ++ "e" ++ "\u{301}" ** 64 ++ "y\tz", .x = -1, .y = 8, .bg = black },
    };

    for (std.enums.values(@import("../utf8.zig").WidthMethod)) |width_method| {
        errdefer std.debug.print("width_method={t}\n", .{width_method});
        var expected_pools = TestPools.init(std.testing.allocator);
        defer expected_pools.deinit();
        var checked_pools = TestPools.init(std.testing.allocator);
        defer checked_pools.deinit();
        const expected = try OptimizedBuffer.init(std.testing.allocator, 4, 9, .{ .link_pool = &expected_pools.links, .pool = &expected_pools.graphemes, .width_method = width_method });
        defer expected.deinit();
        const checked = try OptimizedBuffer.init(std.testing.allocator, 4, 9, .{ .link_pool = &checked_pools.links, .pool = &checked_pools.graphemes, .width_method = width_method });
        defer checked.deinit();

        for ([_]*OptimizedBuffer{ expected, checked }) |target| target.clear(black, null);
        for (draws) |draw| {
            if (draw.scissor) {
                try expected.pushScissorRect(1, 4, 2, 1);
                try checked.pushScissorRect(1, 4, 2, 1);
            }
            try expected.drawTextClipped(draw.text, draw.x, draw.y, white, draw.bg, 0);
            try checked.drawTextChecked(draw.text, draw.x, draw.y, white, draw.bg, 0);
            if (draw.scissor) {
                expected.popScissorRect();
                checked.popScissorRect();
            }
        }

        try expectRowChars(checked, 0, "CDE ");
        // The wide glyph after a clipped prefix keeps its columns.
        try std.testing.expectEqual(@as(u32, 'B'), checked.get(0, 5).?.char);
        try std.testing.expect(gp.isGraphemeChar(checked.get(1, 5).?.char));
        try expectRowChars(checked, 8, " y  ");
        try expectSameCells(expected, checked);
        try expectNoControlCells(expected);
    }
}

test "OptimizedBuffer - a scissor never moves the text glyphs it leaves visible" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    const black = ansi.rgbColor(0, 0, 0, 255);
    const white = ansi.rgbColor(255, 255, 255, 255);
    const texts = [_][]const u8{
        "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}XY",
        "\u{1f1fa}\u{1f1f8}XY",
        "a\u{4e2d}b\tc",
        "e\u{301}\u{4e2d}XY",
        "\u{200b}A\u{200d}\u{4e2d}Z",
    };
    for (std.enums.values(@import("../utf8.zig").WidthMethod)) |width_method| {
        const whole = try OptimizedBuffer.init(std.testing.allocator, 8, 1, .{ .pool = &pools.graphemes, .link_pool = &pools.links, .width_method = width_method });
        defer whole.deinit();
        const clipped = try OptimizedBuffer.init(std.testing.allocator, 8, 1, .{ .pool = &pools.graphemes, .link_pool = &pools.links, .width_method = width_method });
        defer clipped.deinit();
        for (texts) |text| {
            for ([_]bool{ false, true }) |checked| {
                for (0..8) |clip_start| {
                    for (clip_start + 1..9) |clip_end| {
                        errdefer std.debug.print("width_method={t} text={s} checked={} clip=[{d},{d})\n", .{ width_method, text, checked, clip_start, clip_end });
                        whole.clear(black, null);
                        clipped.clear(black, null);
                        try clipped.pushScissorRect(@intCast(clip_start), 0, @intCast(clip_end - clip_start), 1);
                        defer clipped.popScissorRect();
                        for ([_]*OptimizedBuffer{ whole, clipped }) |target| {
                            if (checked) try target.drawTextChecked(text, 0, 0, white, black, 0) else try target.drawTextClipped(text, 0, 0, white, black, 0);
                        }
                        // A cell inside the scissor shows the unclipped glyph if the whole glyph is inside it.
                        var x: u32 = 0;
                        while (x < 8) {
                            const width = gp.encodedCharWidth(whole.buffer.char[x]);
                            const inside = x >= clip_start and x + width <= clip_end;
                            for (x..@min(x + width, 8)) |column| {
                                const expected: u32 = if (inside) whole.buffer.char[column] else ' ';
                                try std.testing.expectEqual(expected, clipped.buffer.char[column]);
                            }
                            x += width;
                        }
                    }
                }
            }
        }
    }
}

test "OptimizedBuffer - transparent framebuffer cell background stays transparent over backdrop" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var src = try OptimizedBuffer.init(
        std.testing.allocator,
        1,
        1,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .respectAlpha = true, .id = "transparent-src-buffer" },
    );
    defer src.deinit();

    var dst = try OptimizedBuffer.init(
        std.testing.allocator,
        1,
        1,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "transparent-dst-buffer" },
    );
    defer dst.deinit();

    const transparent_bg = ansi.rgbColor(0, 0, 0, 0);
    src.clear(transparent_bg, null);
    dst.clear(transparent_bg, null);
    dst.setBlendBackdropColor(ansi.rgbColor(0, 0, 0, 255));

    src.set(0, 0, .{
        .char = 'X',
        .fg = ansi.rgbColor(255, 255, 255, 255),
        .bg = transparent_bg,
        .attributes = 0,
    });

    dst.drawFrameBuffer(0, 0, src, null, null, null, null);

    const cell = dst.get(0, 0).?;
    try std.testing.expectEqual(@as(u32, 'X'), cell.char);
    try std.testing.expectEqual(@as(u8, 0), ansi.alpha(cell.bg));
}

test "OptimizedBuffer - drawFrameBuffer preserves packed metadata on opaque copy" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var src = try OptimizedBuffer.init(
        std.testing.allocator,
        2,
        1,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "src-tag-copy-buffer" },
    );
    defer src.deinit();

    var dst = try OptimizedBuffer.init(
        std.testing.allocator,
        2,
        1,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "dst-tag-copy-buffer" },
    );
    defer dst.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    src.clear(bg, null);
    dst.clear(bg, null);

    src.set(0, 0, .{
        .char = 'X',
        .fg = ansi.defaultColor(255, 255, 255, 255),
        .bg = ansi.indexedColor(6, 0, 128, 128),
        .attributes = 0,
    });

    dst.drawFrameBuffer(0, 0, src, null, null, null, null);

    const copied = dst.get(0, 0).?;
    try std.testing.expectEqual(ansi.ColorIntent.default, ansi.intent(copied.fg));
    try std.testing.expectEqual(ansi.ColorIntent.indexed, ansi.intent(copied.bg));
    try std.testing.expectEqual(@as(u8, 6), ansi.slot(copied.bg));
}

test "OptimizedBuffer - drawTextBuffer transparent fast path preserves destination background metadata" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode);
    defer tb.deinit();
    try tb.setText("A");
    tb.setDefaultFg(ansi.defaultColor(255, 255, 255, 255));
    tb.setDefaultBg(ansi.defaultColor(0, 0, 0, 0));

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        1,
        1,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "transparent-text-fast-tags" },
    );
    defer buf.deinit();

    const stale_bg = ansi.indexedColor(6, 0, 0, 255);
    buf.set(0, 0, .{
        .char = 'Z',
        .fg = ansi.indexedColor(1, 255, 0, 0),
        .bg = stale_bg,
        .attributes = ansi.TextAttributes.BOLD,
    });

    buf.drawTextBuffer(view, 0, 0);

    const cell = buf.get(0, 0).?;
    try std.testing.expectEqual(@as(u32, 'A'), cell.char);
    try std.testing.expectEqual(ansi.ColorIntent.default, ansi.intent(cell.fg));
    try std.testing.expectEqual(ansi.ColorIntent.indexed, ansi.intent(cell.bg));
    try std.testing.expectEqual(@as(u8, 6), ansi.slot(cell.bg));
    try std.testing.expectEqual(stale_bg, cell.bg);
}

test "OptimizedBuffer - drawTextBuffer transparent non-ascii preserves destination background metadata" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode);
    defer tb.deinit();
    try tb.setText("·");
    tb.setDefaultFg(ansi.defaultColor(255, 255, 255, 255));
    tb.setDefaultBg(ansi.defaultColor(0, 0, 0, 0));

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        1,
        1,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "transparent-text-non-ascii-tags" },
    );
    defer buf.deinit();

    const stale_bg = ansi.indexedColor(6, 0, 0, 255);
    buf.set(0, 0, .{
        .char = 'Z',
        .fg = ansi.indexedColor(1, 255, 0, 0),
        .bg = stale_bg,
        .attributes = ansi.TextAttributes.BOLD,
    });

    buf.drawTextBuffer(view, 0, 0);

    const cell = buf.get(0, 0).?;
    try std.testing.expect(gp.isGraphemeChar(cell.char));
    try std.testing.expectEqual(ansi.ColorIntent.default, ansi.intent(cell.fg));
    try std.testing.expectEqual(ansi.ColorIntent.indexed, ansi.intent(cell.bg));
    try std.testing.expectEqual(@as(u8, 6), ansi.slot(cell.bg));
    try std.testing.expectEqual(stale_bg, cell.bg);
}

/// Appends one random glyph: ASCII, wide, multi-code-point, zero-width, control, unique, or too long for a cell.
fn appendRandomGlyph(random: std.Random, text: *std.ArrayListUnmanaged(u8)) !void {
    const glyphs = [_][]const u8{
        "a",                                           "Z",                  "  ",       "\t",
        "\u{4e2d}",                                    "\u{1f31f}",          "\u{2022}", "e\u{301}",
        "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}", "\u{1f1fa}\u{1f1f8}", "\u{200b}", "\u{301}",
        "\x1b",                                        "\u{85}",             "\n",       "e" ++ "\u{301}" ** 64,
    };
    const choice = random.uintLessThan(usize, glyphs.len + 1);
    if (choice < glyphs.len) return text.appendSlice(std.testing.allocator, glyphs[choice]);
    // A fresh code point makes the pool allocate and reuse slots.
    var encoded: [4]u8 = undefined;
    const length = try std.unicode.utf8Encode(0x4e00 + random.uintLessThan(u21, 256), &encoded);
    try text.appendSlice(std.testing.allocator, encoded[0..length]);
}

test "OptimizedBuffer seeded drawing keeps trackers and pool references consistent" {
    const invariants = @import("buffer-invariants.zig");
    const fg = ansi.rgbColor(250, 240, 230, 255);
    const backgrounds = [_]?RGBA{ null, ansi.rgbColor(10, 20, 30, 255), ansi.rgbColor(10, 20, 30, 128), ansi.rgbColor(0, 0, 0, 0) };
    for ([_]u64{ 1, 2, 3, 4, 5, 6, 7, 8 }) |seed| {
        errdefer std.debug.print("seed={d}\n", .{seed});
        var prng = std.Random.DefaultPrng.init(seed);
        const random = prng.random();
        // One slot per page makes nearly every new glyph grow the pool.
        var pool = gp.GraphemePool.initWithOptions(std.testing.allocator, .{ .slots_per_page = @splat(1) });
        defer pool.deinit();
        var links = link.LinkPool.init(std.testing.allocator);
        defer links.deinit();
        const link_ids = [_]u32{ try links.acquire("https://a.invalid"), try links.acquire("https://b.invalid") };
        defer for (link_ids) |id| links.decref(id) catch unreachable;
        {
            const next = try OptimizedBuffer.init(std.testing.allocator, 12, 4, .{ .pool = &pool, .link_pool = &links });
            defer next.deinit();
            const current = try OptimizedBuffer.init(std.testing.allocator, 12, 4, .{ .pool = &pool, .link_pool = &links });
            defer current.deinit();
            const content = try TextBuffer.init(std.testing.allocator, &pool, &links, .wcwidth);
            defer content.deinit();
            const view = try TextBufferView.init(std.testing.allocator, content);
            defer view.deinit();
            var text: std.ArrayListUnmanaged(u8) = .empty;
            defer text.deinit(std.testing.allocator);

            for (0..400) |_| {
                text.clearRetainingCapacity();
                for (0..random.uintLessThan(usize, 9)) |_| try appendRandomGlyph(random, &text);
                const target = if (random.boolean()) next else current;
                const x = random.intRangeAtMost(i32, -3, 12);
                const y = random.intRangeAtMost(i32, -1, 4);
                const bg = backgrounds[random.uintLessThan(usize, backgrounds.len)];
                const style: u32 = if (random.boolean()) ansi.TextAttributes.BOLD else 0;
                // Only unchecked and text-resource draws take link IDs.
                const linked: u32 = if (random.boolean()) ansi.TextAttributes.setLinkId(style, link_ids[random.uintLessThan(usize, 2)]) else style;
                const scissored = random.uintLessThan(u8, 4) == 0;
                if (scissored) try target.pushScissorRect(random.intRangeAtMost(i32, 0, 8), 0, random.intRangeAtMost(u32, 0, 6), 4);
                defer if (scissored) target.popScissorRect();
                const opacity = random.uintLessThan(u8, 5) == 0;
                if (opacity) try target.pushOpacity(0.5);
                defer if (opacity) target.popOpacity();
                const operation = random.uintLessThan(u8, 9);
                errdefer std.debug.print("operation={d} text={any} x={d} y={d}\n", .{ operation, text.items, x, y });
                switch (operation) {
                    0 => try target.drawTextChecked(text.items, x, y, fg, bg, style),
                    1 => try target.drawTextClipped(text.items, x, y, fg, bg, linked),
                    2 => {
                        try content.setText(text.items);
                        content.setDefaultAttributes(linked);
                        view.setWrapMode(if (random.boolean()) .char else .none);
                        view.setWrapWidth(random.intRangeAtMost(u32, 1, 12));
                        _ = view.getVirtualLines();
                        if (random.boolean()) try target.drawTextBufferChecked(view, x, y) else target.drawTextBuffer(view, x, y);
                    },
                    3 => {
                        text.clearRetainingCapacity();
                        try appendRandomGlyph(random, &text);
                        const width = random.intRangeAtMost(u8, 1, 2);
                        try target.drawGraphemeChecked(text.items, width, @intCast(@max(x, 0)), @intCast(@max(y, 0)), fg, bg orelse fg, style);
                    },
                    4 => {
                        // The renderer syncs every cell of an equally sized buffer from left to right.
                        const source = other(next, current, target);
                        if (source.width == target.width and source.height == target.height) {
                            for (0..target.height) |row| {
                                for (0..target.width) |column| {
                                    target.syncCell(@intCast(column), @intCast(row), source.get(@intCast(column), @intCast(row)).?);
                                }
                            }
                        }
                    },
                    5 => target.fillRectClipped(x, y, random.uintLessThan(u32, 6), random.uintLessThan(u32, 3), bg orelse fg),
                    6 => target.drawFrameBuffer(x, y, other(next, current, target), null, null, null, null),
                    7 => target.clear(ansi.rgbColor(0, 0, 0, 255), null),
                    8 => try target.resize(random.intRangeAtMost(u32, 1, 12), random.intRangeAtMost(u32, 1, 4)),
                    else => unreachable,
                }
                try invariants.expectBufferInvariants(next);
                try invariants.expectBufferInvariants(current);
                // Between draws only the buffer trackers hold glyph references, one per buffer.
                var live = pool.interned_live_ids.valueIterator();
                while (live.next()) |id| {
                    var trackers: u32 = 0;
                    for ([_]*OptimizedBuffer{ next, current }) |buffer| trackers += @intFromBool(buffer.grapheme_tracker.contains(id.*));
                    try std.testing.expectEqual(trackers, try pool.getRefcount(id.*));
                }
            }
        }
        // Releasing every owner releases every glyph.
        try std.testing.expectEqual(0, pool.interned_live_ids.count());
    }
}

fn other(first: *OptimizedBuffer, second: *OptimizedBuffer, target: *OptimizedBuffer) *OptimizedBuffer {
    return if (target == first) second else first;
}

test "OptimizedBuffer - set should not clear newly written adjacent grapheme continuation" {
    var link_pool_storage = link.LinkPool.init(std.testing.allocator);
    defer link_pool_storage.deinit();
    const link_pool = &link_pool_storage;
    var local_pool = gp.GraphemePool.initWithOptions(std.testing.allocator, .{});
    defer local_pool.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        8,
        1,
        .{ .link_pool = link_pool, .pool = &local_pool, .id = "set-adjacent-grapheme" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    buf.clear(bg, null);

    const old_gid = try local_pool.acquire("🌟");
    const old_start = gp.packGraphemeStart(old_gid & gp.GRAPHEME_ID_MASK, 2);
    buf.set(3, 0, .{ .char = old_start, .fg = fg, .bg = bg, .attributes = 0 });

    const new_gid = try local_pool.acquire("🔥");
    const new_start = gp.packGraphemeStart(new_gid & gp.GRAPHEME_ID_MASK, 2);

    // Simulate renderer's left-to-right in-place update:
    // - x=2 writes a new grapheme (which writes continuation at x=3)
    // - x=3 would be skipped by char-equality
    // - x=4 overwrites an old continuation from the previous frame
    // The overwrite at x=4 must not clear the new continuation at x=3.
    buf.set(2, 0, .{ .char = new_start, .fg = fg, .bg = bg, .attributes = 0 });
    buf.set(4, 0, .{ .char = ' ', .fg = fg, .bg = bg, .attributes = 0 });

    const c2 = buf.get(2, 0).?;
    const c3 = buf.get(3, 0).?;
    const c4 = buf.get(4, 0).?;

    try std.testing.expect(gp.isGraphemeChar(c2.char));
    try std.testing.expect(gp.graphemeIdFromChar(c2.char) == (new_gid & gp.GRAPHEME_ID_MASK));

    try std.testing.expect(gp.isContinuationChar(c3.char));
    try std.testing.expect(gp.graphemeIdFromChar(c3.char) == (new_gid & gp.GRAPHEME_ID_MASK));

    try std.testing.expect(c4.char == ' ');
}

test "OptimizedBuffer - set span cleanup keeps shared link refcounts consistent" {
    var local_pool = gp.GraphemePool.initWithOptions(std.testing.allocator, .{});
    defer local_pool.deinit();

    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        1,
        .{ .pool = &local_pool, .id = "set-span-link-refcount", .link_pool = &local_link_pool },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    buf.clear(bg, null);

    const link_id = try local_link_pool.acquire("https://example.com");
    const linked_attr = ansi.TextAttributes.setLinkId(0, link_id);

    const gid = try local_pool.acquire("你");
    const start = gp.packGraphemeStart(gid & gp.GRAPHEME_ID_MASK, 2);

    // Create three linked cells total:
    // - a 2-cell grapheme span at x=2..3
    // - one additional linked cell at x=6
    buf.set(2, 0, .{ .char = start, .fg = fg, .bg = bg, .attributes = linked_attr });
    buf.set(6, 0, .{ .char = 'X', .fg = fg, .bg = bg, .attributes = linked_attr });
    try local_link_pool.decref(link_id);
    try local_pool.decref(gid);

    try std.testing.expectEqual(@as(u32, 3), buf.link_tracker.used_ids.get(link_id).?);
    try std.testing.expectEqual(@as(u32, 1), try local_link_pool.getRefcount(link_id));

    // Overwrite the continuation cell at x=3 with a non-grapheme char.
    // set() will run span cleanup and clear x=2..3. The independent linked
    // cell at x=6 must remain tracked.
    buf.set(3, 0, .{ .char = ' ', .fg = fg, .bg = bg, .attributes = 0 });

    try std.testing.expectEqual(@as(u32, 1), buf.link_tracker.getLinkCount());
    try std.testing.expectEqual(@as(u32, 1), buf.link_tracker.used_ids.get(link_id).?);
    try std.testing.expectEqual(@as(u32, 1), try local_link_pool.getRefcount(link_id));
}

test "OptimizedBuffer - syncCell updates grapheme tracker for start transitions" {
    var local_pool = gp.GraphemePool.initWithOptions(std.testing.allocator, .{});
    defer local_pool.deinit();

    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        1,
        .{ .pool = &local_pool, .id = "sync-cell-grapheme-tracker", .link_pool = &local_link_pool },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    buf.clear(bg, null);

    const gid_old = try local_pool.acquire("你");
    const gid_new = try local_pool.acquire("好");
    const old_id = gid_old & gp.GRAPHEME_ID_MASK;
    const new_id = gid_new & gp.GRAPHEME_ID_MASK;
    const start_old = gp.packGraphemeStart(old_id, 2);
    const start_new = gp.packGraphemeStart(new_id, 2);

    buf.syncCell(1, 0, .{ .char = start_old, .fg = fg, .bg = bg, .attributes = 0 });
    try std.testing.expectEqual(@as(u32, 1), buf.grapheme_tracker.getGraphemeCount());
    try std.testing.expect(buf.grapheme_tracker.contains(old_id));

    buf.syncCell(1, 0, .{ .char = start_new, .fg = fg, .bg = bg, .attributes = 0 });
    try std.testing.expectEqual(@as(u32, 1), buf.grapheme_tracker.getGraphemeCount());
    try std.testing.expect(!buf.grapheme_tracker.contains(old_id));
    try std.testing.expect(buf.grapheme_tracker.contains(new_id));

    buf.syncCell(1, 0, .{ .char = ' ', .fg = fg, .bg = bg, .attributes = 0 });
    try std.testing.expectEqual(@as(u32, 0), buf.grapheme_tracker.getGraphemeCount());
    try std.testing.expect(!buf.grapheme_tracker.contains(new_id));
}

test "OptimizedBuffer - drawTextBuffer with negative y coordinate should not panic" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    try tb.setText("Line 1\nLine 2\nLine 3\nLine 4\nLine 5");

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        80,
        25,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    buf.clear(bg, null);

    // Draw text buffer at negative y coordinate (-2)
    // This simulates a scenario where content is scrolled partially off-screen
    // The first 2 lines should be clipped, and lines 3, 4, 5 should be visible
    buf.drawTextBuffer(view, 0, -2);

    // Verify that content is properly clipped when drawn at negative y
    // Lines that are off-screen (negative y) should be skipped
    // Line 3 should appear at y=0, Line 4 at y=1, Line 5 at y=2

    // Check that Line 3 is rendered at y=0
    const cell_y0 = buf.get(0, 0).?;
    try std.testing.expectEqual(@as(u32, 'L'), cell_y0.char);

    // Check that Line 4 is rendered at y=1
    const cell_y1 = buf.get(0, 1).?;
    try std.testing.expectEqual(@as(u32, 'L'), cell_y1.char);

    // Check that Line 5 is rendered at y=2
    const cell_y2 = buf.get(0, 2).?;
    try std.testing.expectEqual(@as(u32, 'L'), cell_y2.char);

    // Verify the full content of the first visible line (Line 3)
    try std.testing.expectEqual(@as(u32, 'L'), buf.get(0, 0).?.char);
    try std.testing.expectEqual(@as(u32, 'i'), buf.get(1, 0).?.char);
    try std.testing.expectEqual(@as(u32, 'n'), buf.get(2, 0).?.char);
    try std.testing.expectEqual(@as(u32, 'e'), buf.get(3, 0).?.char);
    try std.testing.expectEqual(@as(u32, ' '), buf.get(4, 0).?.char);
    try std.testing.expectEqual(@as(u32, '3'), buf.get(5, 0).?.char);
}

test "OptimizedBuffer - cells are initialized after resize grow" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        10,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    try buf.resize(20, 20);

    // Verify new cells have default values (space = 32), not garbage
    const cell = buf.get(15, 15);
    try std.testing.expect(cell != null);
    try std.testing.expectEqual(@as(u32, 32), cell.?.char);
}

test "OptimizedBuffer - link encoding round-trip" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        5,
        .{ .pool = &pools.graphemes, .id = "test-buffer", .link_pool = &pools.links },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    buf.clear(bg, null);

    // Allocate a link
    const link_id = try pools.links.acquire("https://example.com");
    const attributes = ansi.TextAttributes.setLinkId(ansi.TextAttributes.BOLD, link_id);

    // Draw text with link
    try buf.drawText("Click", 0, 0, fg, bg, attributes);

    // Verify cell has correct char and attributes
    const cell = buf.get(0, 0).?;
    try std.testing.expectEqual(@as(u32, 'C'), cell.char);
    try std.testing.expectEqual(ansi.TextAttributes.BOLD, ansi.TextAttributes.getBaseAttributes(cell.attributes));
    try std.testing.expectEqual(link_id, ansi.TextAttributes.getLinkId(cell.attributes));

    // Verify link tracker has the link
    try std.testing.expect(buf.link_tracker.hasAny());
    try std.testing.expectEqual(@as(u32, 1), buf.link_tracker.getLinkCount());
}

test "OptimizedBuffer - link tracker per-cell counting" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        5,
        .{ .pool = &pools.graphemes, .id = "test-buffer", .link_pool = &pools.links },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    buf.clear(bg, null);

    // Allocate a link
    const link_id = try pools.links.acquire("https://example.com");
    const attributes = ansi.TextAttributes.setLinkId(0, link_id);

    // Draw text covering 3 cells
    try buf.drawText("ABC", 0, 0, fg, bg, attributes);
    try pools.links.decref(link_id);

    // Verify link tracker has 1 unique link
    // Pool refcount is 1 (tracker owns one ref, tracks 3 cells internally)
    try std.testing.expectEqual(@as(u32, 1), buf.link_tracker.getLinkCount());
    const pool_refcount = try pools.links.getRefcount(link_id);
    try std.testing.expectEqual(@as(u32, 1), pool_refcount);

    // Verify tracker knows about 3 cells
    const cell_count = buf.link_tracker.used_ids.get(link_id).?;
    try std.testing.expectEqual(@as(u32, 3), cell_count);

    // Overwrite one cell without link
    try buf.drawText("X", 0, 0, fg, bg, 0);

    // Tracker cell count should drop to 2, pool refcount stays 1
    const cell_count2 = buf.link_tracker.used_ids.get(link_id).?;
    try std.testing.expectEqual(@as(u32, 2), cell_count2);
    const pool_refcount2 = try pools.links.getRefcount(link_id);
    try std.testing.expectEqual(@as(u32, 1), pool_refcount2);

    // Clear all - refcount should be 0 and link freed
    buf.clear(bg, null);
    try std.testing.expectEqual(@as(u32, 0), buf.link_tracker.getLinkCount());
}

test "OptimizedBuffer - fillRect removes links" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        5,
        .{ .pool = &pools.graphemes, .id = "test-buffer", .link_pool = &pools.links },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    buf.clear(bg, null);

    // Allocate a link
    const link_id = try pools.links.acquire("https://example.com");
    const attributes = ansi.TextAttributes.setLinkId(0, link_id);

    // Draw linked text
    try buf.drawText("Linked", 0, 0, fg, bg, attributes);
    try buf.drawText("Text", 10, 0, fg, bg, attributes);

    // Verify links exist
    try std.testing.expect(ansi.TextAttributes.hasLink(buf.get(0, 0).?.attributes));
    try std.testing.expect(ansi.TextAttributes.hasLink(buf.get(10, 0).?.attributes));

    // Fill rect over first link
    buf.fillRect(0, 0, 6, 1, bg);

    // Cells in rect should have no link
    try std.testing.expect(!ansi.TextAttributes.hasLink(buf.get(0, 0).?.attributes));
    try std.testing.expect(!ansi.TextAttributes.hasLink(buf.get(5, 0).?.attributes));

    // Cells outside rect should preserve link
    try std.testing.expect(ansi.TextAttributes.hasLink(buf.get(10, 0).?.attributes));
}

test "OptimizedBuffer - fillRect alpha path preserves underlying text without trackers" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        6,
        3,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    buf.clear(bg, null);
    try buf.drawText("X", 1, 1, fg, bg, 0);

    try std.testing.expect(!buf.grapheme_tracker.hasAny());
    try std.testing.expect(!buf.link_tracker.hasAny());

    const overlay_bg = ansi.rgbaFromFloats(0.0, 0.0, 1.0, 0.5);
    buf.fillRect(0, 0, 3, 3, overlay_bg);

    const preserved = buf.get(1, 1).?;
    try std.testing.expectEqual(@as(u32, 'X'), preserved.char);
    try std.testing.expect(ansi.blueF(preserved.bg) > 0.1);
    try std.testing.expect(ansi.blueF(preserved.fg) > 0.5);

    const filled = buf.get(0, 0).?;
    try std.testing.expectEqual(@as(u32, buffer_mod.DEFAULT_SPACE_CHAR), filled.char);
    try std.testing.expect(ansi.blueF(filled.bg) > 0.1);
    try std.testing.expect(ansi.redF(filled.fg) > 0.9);
}

test "OptimizedBuffer - fillRect transparent path is a no-op without trackers" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        6,
        3,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    const red_bg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const yellow_fg = ansi.rgbaFromFloats(1.0, 1.0, 0.0, 1.0);
    const green_fg = ansi.rgbaFromFloats(0.0, 1.0, 0.0, 1.0);
    const blue_bg = ansi.rgbaFromFloats(0.0, 0.0, 1.0, 1.0);
    buf.clear(red_bg, null);
    try buf.drawText("X", 1, 1, yellow_fg, red_bg, ansi.TextAttributes.BOLD);
    try buf.drawText(" ", 0, 1, green_fg, blue_bg, ansi.TextAttributes.UNDERLINE);

    try std.testing.expect(!buf.grapheme_tracker.hasAny());
    try std.testing.expect(!buf.link_tracker.hasAny());

    const transparent_bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0);
    buf.fillRect(0, 0, 3, 3, transparent_bg);

    const preserved = buf.get(1, 1).?;
    try std.testing.expectEqual(@as(u32, 'X'), preserved.char);
    try std.testing.expectEqual(ansi.redF(yellow_fg), ansi.redF(preserved.fg));
    try std.testing.expectEqual(ansi.greenF(yellow_fg), ansi.greenF(preserved.fg));
    try std.testing.expectEqual(ansi.blueF(yellow_fg), ansi.blueF(preserved.fg));
    try std.testing.expectEqual(ansi.redF(red_bg), ansi.redF(preserved.bg));
    try std.testing.expectEqual(ansi.greenF(red_bg), ansi.greenF(preserved.bg));
    try std.testing.expectEqual(ansi.blueF(red_bg), ansi.blueF(preserved.bg));
    try std.testing.expectEqual(ansi.TextAttributes.BOLD, preserved.attributes);

    const unchangedSpace = buf.get(0, 1).?;
    try std.testing.expectEqual(@as(u32, buffer_mod.DEFAULT_SPACE_CHAR), unchangedSpace.char);
    try std.testing.expectEqual(ansi.redF(green_fg), ansi.redF(unchangedSpace.fg));
    try std.testing.expectEqual(ansi.greenF(green_fg), ansi.greenF(unchangedSpace.fg));
    try std.testing.expectEqual(ansi.blueF(green_fg), ansi.blueF(unchangedSpace.fg));
    try std.testing.expectEqual(ansi.redF(blue_bg), ansi.redF(unchangedSpace.bg));
    try std.testing.expectEqual(ansi.greenF(blue_bg), ansi.greenF(unchangedSpace.bg));
    try std.testing.expectEqual(ansi.blueF(blue_bg), ansi.blueF(unchangedSpace.bg));
    try std.testing.expectEqual(ansi.TextAttributes.UNDERLINE, unchangedSpace.attributes);
}

test "OptimizedBuffer - drawBox transparent border preserves destination background metadata without trackers" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        4,
        4,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    const red_bg = ansi.indexedColor(6, 255, 0, 0);
    const yellow_fg = ansi.defaultColor(255, 255, 0, 255);
    const green_fg = ansi.indexedColor(4, 0, 255, 0);
    const transparent_bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0);
    buf.clear(red_bg, null);
    buf.set(0, 1, .{
        .char = 'A',
        .fg = yellow_fg,
        .bg = red_bg,
        .attributes = ansi.TextAttributes.BOLD,
    });

    try std.testing.expect(!buf.grapheme_tracker.hasAny());
    try std.testing.expect(!buf.link_tracker.hasAny());

    const border_chars = [_]u32{ 0x250c, 0x2510, 0x2514, 0x2518, 0x2500, 0x2502, 0, 0, 0, 0, 0 };
    try buf.drawBox(0, 0, 4, 4, &border_chars, .{ .left = true }, green_fg, transparent_bg, green_fg, false, null, 0, null, 0);

    const cell = buf.get(0, 1).?;
    try std.testing.expectEqual(@as(u32, 0x2502), cell.char);
    try std.testing.expectEqual(ansi.redF(green_fg), ansi.redF(cell.fg));
    try std.testing.expectEqual(ansi.greenF(green_fg), ansi.greenF(cell.fg));
    try std.testing.expectEqual(ansi.blueF(green_fg), ansi.blueF(cell.fg));
    try std.testing.expectEqual(ansi.ColorIntent.indexed, ansi.intent(cell.fg));
    try std.testing.expectEqual(@as(u8, 4), ansi.slot(cell.fg));
    try std.testing.expectEqual(ansi.redF(red_bg), ansi.redF(cell.bg));
    try std.testing.expectEqual(ansi.greenF(red_bg), ansi.greenF(cell.bg));
    try std.testing.expectEqual(ansi.blueF(red_bg), ansi.blueF(cell.bg));
    try std.testing.expectEqual(ansi.ColorIntent.indexed, ansi.intent(cell.bg));
    try std.testing.expectEqual(@as(u8, 6), ansi.slot(cell.bg));
    try std.testing.expectEqual(@as(u32, 0), cell.attributes);
}

test "OptimizedBuffer - drawBox transparent border respects partial scissor clipping" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(std.testing.allocator, 4, 4, .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "clipped-border" });
    defer buf.deinit();
    const background = ansi.rgbColor(100, 0, 0, 255);
    const foreground = ansi.rgbColor(0, 200, 0, 255);
    const transparent = ansi.rgbColor(0, 0, 0, 0);
    const border_chars = [_]u32{ 0x250c, 0x2510, 0x2514, 0x2518, 0x2500, 0x2502, 0, 0, 0, 0, 0 };
    for ([_]buffer_mod.ClipRect{
        .{ .x = 1, .y = 0, .width = 2, .height = 4 },
        .{ .x = 0, .y = 1, .width = 4, .height = 2 },
        .{ .x = 1, .y = 1, .width = 2, .height = 2 },
    }) |clip| {
        buf.clear(background, null);
        const before = buf.get(0, 0).?;
        try buf.pushScissorRect(clip.x, clip.y, clip.width, clip.height);
        try buf.drawBox(0, 0, 4, 4, &border_chars, .{ .left = true, .top = true, .right = true, .bottom = true }, foreground, transparent, foreground, false, null, 0, null, 0);
        for (0..4) |y| {
            for (0..4) |x| {
                const inside = x >= @as(u32, @intCast(clip.x)) and x < @as(u32, @intCast(clip.x)) + clip.width and
                    y >= @as(u32, @intCast(clip.y)) and y < @as(u32, @intCast(clip.y)) + clip.height;
                const cell = buf.get(@intCast(x), @intCast(y)).?;
                if (inside and (x == 0 or x == 3 or y == 0 or y == 3)) {
                    try std.testing.expect(cell.char != before.char);
                    try std.testing.expectEqual(foreground, cell.fg);
                    try std.testing.expectEqual(background, cell.bg);
                } else try std.testing.expectEqualDeep(before, cell);
            }
        }
        buf.popScissorRect();
    }
}

test "OptimizedBuffer - drawBox transparent border foreground blends against box background" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        4,
        4,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    const transparent = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0);
    const panel = ansi.rgbColor(0x12, 0x34, 0x56, 255);
    buf.clear(transparent, null);

    const border_chars = [_]u32{ 0x250c, 0x2510, 0x2514, 0x2518, 0x2500, 0x2502, 0, 0, 0, 0, 0 };
    try buf.drawBox(0, 0, 4, 4, &border_chars, .{ .left = true }, transparent, panel, transparent, true, null, 0, null, 0);

    const cell = buf.get(0, 1).?;
    try std.testing.expectEqual(@as(u32, 0x2502), cell.char);
    try std.testing.expectEqual(ansi.red(panel), ansi.red(cell.fg));
    try std.testing.expectEqual(ansi.green(panel), ansi.green(cell.fg));
    try std.testing.expectEqual(ansi.blue(panel), ansi.blue(cell.fg));
    try std.testing.expectEqual(ansi.alpha(panel), ansi.alpha(cell.fg));
    try std.testing.expectEqual(ansi.red(panel), ansi.red(cell.bg));
    try std.testing.expectEqual(ansi.green(panel), ansi.green(cell.bg));
    try std.testing.expectEqual(ansi.blue(panel), ansi.blue(cell.bg));
    try std.testing.expectEqual(ansi.alpha(panel), ansi.alpha(cell.bg));
}

test "OptimizedBuffer - link reuse after free" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        5,
        .{ .pool = &pools.graphemes, .id = "test-buffer", .link_pool = &pools.links },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);

    // Allocate first link
    const link_id1 = try pools.links.acquire("https://first.com");
    const attr1 = ansi.TextAttributes.setLinkId(0, link_id1);
    try buf.drawText("A", 0, 0, fg, bg, attr1);

    // Clear - should free the link
    buf.clear(bg, null);

    // Allocate second link - should reuse same slot but different generation
    const link_id2 = try pools.links.acquire("https://second.com");
    try std.testing.expect(link_id1 != link_id2); // Different due to generation

    const attr2 = ansi.TextAttributes.setLinkId(0, link_id2);
    try buf.drawText("B", 0, 0, fg, bg, attr2);

    const url = try pools.links.get(link_id2);
    try std.testing.expect(std.mem.eql(u8, url, "https://second.com"));
}

test "OptimizedBuffer - alpha blending preserves overlay link not dest link" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        5,
        .{ .pool = &pools.graphemes, .id = "test-buffer", .link_pool = &pools.links },
    );
    defer buf.deinit();

    const bg_opaque = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const bg_alpha = ansi.rgbaFromFloats(0.5, 0.5, 0.5, 0.5);
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    buf.clear(bg_opaque, null);

    // Draw underlying text with link A
    const link_id_a = try pools.links.acquire("https://underlying.com");
    const attr_a = ansi.TextAttributes.setLinkId(ansi.TextAttributes.BOLD, link_id_a);
    try buf.drawText("X", 5, 0, fg, bg_opaque, attr_a);

    // Verify dest cell has link A
    const dest_cell = buf.get(5, 0).?;
    try std.testing.expectEqual(link_id_a, ansi.TextAttributes.getLinkId(dest_cell.attributes));
    try std.testing.expectEqual(@as(u32, 'X'), dest_cell.char);

    // Draw space with alpha and link B over it (will preserve 'X' but blend colors)
    const link_id_b = try pools.links.acquire("https://overlay.com");
    const attr_b = ansi.TextAttributes.setLinkId(0, link_id_b);
    try buf.drawText(" ", 5, 0, fg, bg_alpha, attr_b);

    // Result: char should be preserved 'X', but link should be from overlay (B), not dest (A)
    const result_cell = buf.get(5, 0).?;
    try std.testing.expectEqual(@as(u32, 'X'), result_cell.char);
    try std.testing.expectEqual(link_id_b, ansi.TextAttributes.getLinkId(result_cell.attributes));
    try std.testing.expect(ansi.TextAttributes.getLinkId(result_cell.attributes) != link_id_a);
}

test "OptimizedBuffer - alpha blending with no link clears underlying link" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        5,
        .{ .pool = &pools.graphemes, .id = "test-buffer", .link_pool = &pools.links },
    );
    defer buf.deinit();

    const bg_opaque = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const bg_alpha = ansi.rgbaFromFloats(0.5, 0.5, 0.5, 0.5);
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    buf.clear(bg_opaque, null);

    // Draw underlying text with link
    const link_id = try pools.links.acquire("https://underlying.com");
    const attr_link = ansi.TextAttributes.setLinkId(ansi.TextAttributes.BOLD, link_id);
    try buf.drawText("X", 5, 0, fg, bg_opaque, attr_link);

    // Verify dest cell has link
    const dest_cell = buf.get(5, 0).?;
    try std.testing.expectEqual(link_id, ansi.TextAttributes.getLinkId(dest_cell.attributes));

    // Draw space with alpha but NO link over it (will preserve 'X')
    try buf.drawText(" ", 5, 0, fg, bg_alpha, 0);

    // Result: char 'X' preserved, but link should be CLEARED (0), not preserved
    const result_cell = buf.get(5, 0).?;
    try std.testing.expectEqual(@as(u32, 'X'), result_cell.char);
    try std.testing.expectEqual(@as(u32, 0), ansi.TextAttributes.getLinkId(result_cell.attributes));

    // Link should no longer be tracked
    try std.testing.expect(!ansi.TextAttributes.hasLink(result_cell.attributes));
}

test "OptimizedBuffer - drawGrayscaleBuffer basic rendering" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        5,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    buf.clear(bg, null);

    // Create a 3x3 intensity buffer with varying values
    const intensities = [_]f32{
        0.0,  0.5,  1.0,
        0.25, 0.75, 0.0,
        1.0,  0.0,  0.5,
    };

    buf.drawGrayscaleBuffer(2, 1, &intensities, 3, 3, null, bg);

    const cell_0_0 = buf.get(2, 1).?;
    try std.testing.expectEqual(@as(u32, 32), cell_0_0.char);

    const cell_1_0 = buf.get(3, 1).?;
    try std.testing.expect(cell_1_0.char != 32);
    try std.testing.expect(ansi.redF(cell_1_0.fg) > 0.3);

    const cell_2_0 = buf.get(4, 1).?;
    try std.testing.expect(cell_2_0.char != 32);
    try std.testing.expect(ansi.redF(cell_2_0.fg) > 0.9);
}

test "OptimizedBuffer - drawGrayscaleBuffer negative position clipping" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        5,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    buf.clear(bg, null);

    // Create a 4x4 intensity buffer
    const intensities = [_]f32{
        0.5, 0.5, 0.5, 0.5,
        0.5, 0.5, 0.5, 0.5,
        0.5, 0.5, 0.5, 0.5,
        0.5, 0.5, 0.5, 0.5,
    };

    buf.drawGrayscaleBuffer(-1, -1, &intensities, 4, 4, null, bg);

    const cell_0_0 = buf.get(0, 0).?;
    try std.testing.expect(cell_0_0.char != 32);

    const cell_2_0 = buf.get(2, 0).?;
    try std.testing.expect(cell_2_0.char != 32);
}

test "OptimizedBuffer - drawGrayscaleBuffer negative position fully clipped" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        6,
        3,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    buf.clear(bg, null);

    const intensities = [_]f32{
        1.0, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    };

    buf.drawGrayscaleBuffer(-10, -10, &intensities, 4, 4, null, bg);

    const cell = buf.get(0, 0).?;
    try std.testing.expectEqual(@as(u32, 32), cell.char);
}

test "OptimizedBuffer - drawGrayscaleBuffer respects scissor rect" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        5,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    buf.clear(bg, null);

    try buf.pushScissorRect(0, 0, 2, 2);

    const intensities = [_]f32{
        1.0, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    };

    buf.drawGrayscaleBuffer(0, 0, &intensities, 4, 4, null, bg);

    const cell_0_0 = buf.get(0, 0).?;
    const cell_1_1 = buf.get(1, 1).?;
    try std.testing.expect(cell_0_0.char != 32);
    try std.testing.expect(cell_1_1.char != 32);

    const cell_3_3 = buf.get(3, 3).?;
    try std.testing.expectEqual(@as(u32, 32), cell_3_3.char);

    buf.popScissorRect();
}

test "OptimizedBuffer - drawGrayscaleBuffer intensity to character mapping" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        5,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    buf.clear(bg, null);

    const intensities = [_]f32{
        0.005,
        0.02,
        0.5,
        1.0,
    };

    buf.drawGrayscaleBuffer(0, 0, &intensities, 4, 1, null, bg);

    const cell_0 = buf.get(0, 0).?;
    try std.testing.expectEqual(@as(u32, 32), cell_0.char);

    const cell_1 = buf.get(1, 0).?;
    try std.testing.expect(cell_1.char != 32);

    const cell_3 = buf.get(3, 0).?;
    try std.testing.expect(ansi.redF(cell_3.fg) > 0.9);
    try std.testing.expect(ansi.greenF(cell_3.fg) > 0.9);
    try std.testing.expect(ansi.blueF(cell_3.fg) > 0.9);
}

test "OptimizedBuffer - drawGrayscaleBuffer alpha blending preserves underlying bg" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        5,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    const red_bg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    buf.clear(red_bg, null);

    const initial_cell = buf.get(1, 1).?;
    try std.testing.expectEqual(@as(u8, 255), ansi.red(initial_cell.bg));
    try std.testing.expectEqual(@as(u8, 0), ansi.green(initial_cell.bg));
    try std.testing.expectEqual(@as(u8, 0), ansi.blue(initial_cell.bg));

    const semi_transparent_bg = ansi.rgbaFromFloats(0.0, 0.0, 1.0, 0.5);
    const intensities = [_]f32{
        1.0, 1.0, 1.0,
        1.0, 1.0, 1.0,
        1.0, 1.0, 1.0,
    };

    buf.drawGrayscaleBuffer(0, 0, &intensities, 3, 3, null, semi_transparent_bg);

    const cell = buf.get(1, 1).?;
    try std.testing.expect(ansi.redF(cell.bg) > 0.1);
    try std.testing.expect(ansi.blueF(cell.bg) > 0.1);

    try std.testing.expect(ansi.redF(cell.fg) > 0.9);
    try std.testing.expect(ansi.greenF(cell.fg) > 0.9);
    try std.testing.expect(ansi.blueF(cell.fg) > 0.9);
}

test "OptimizedBuffer - drawGrayscaleBuffer fully transparent bg preserves underlying" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        5,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    const green_bg = ansi.rgbaFromFloats(0.0, 1.0, 0.0, 1.0);
    buf.clear(green_bg, null);

    const transparent_bg = ansi.rgbaFromFloats(0.0, 0.0, 1.0, 0.0);
    const intensities = [_]f32{
        1.0, 1.0, 1.0,
        1.0, 1.0, 1.0,
        1.0, 1.0, 1.0,
    };

    buf.drawGrayscaleBuffer(0, 0, &intensities, 3, 3, null, transparent_bg);

    const cell = buf.get(1, 1).?;
    try std.testing.expectEqual(@as(u8, 0), ansi.red(cell.bg));
    try std.testing.expectEqual(@as(u8, 255), ansi.green(cell.bg));
    try std.testing.expectEqual(@as(u8, 0), ansi.blue(cell.bg));

    try std.testing.expect(ansi.redF(cell.fg) > 0.9);
}

test "OptimizedBuffer - drawGrayscaleBuffer opaque bg overwrites underlying" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        5,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    const red_bg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    buf.clear(red_bg, null);

    const blue_bg = ansi.rgbaFromFloats(0.0, 0.0, 1.0, 1.0);
    const intensities = [_]f32{
        1.0, 1.0, 1.0,
        1.0, 1.0, 1.0,
        1.0, 1.0, 1.0,
    };

    buf.drawGrayscaleBuffer(0, 0, &intensities, 3, 3, null, blue_bg);

    const cell = buf.get(1, 1).?;
    try std.testing.expectEqual(@as(u8, 0), ansi.red(cell.bg));
    try std.testing.expectEqual(@as(u8, 0), ansi.green(cell.bg));
    try std.testing.expectEqual(@as(u8, 255), ansi.blue(cell.bg));
}

test "OptimizedBuffer - drawGrayscaleBuffer with opacity stack" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        5,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    const red_bg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    buf.clear(red_bg, null);

    try buf.pushOpacity(0.5);

    const blue_bg = ansi.rgbaFromFloats(0.0, 0.0, 1.0, 1.0);
    const intensities = [_]f32{
        1.0, 1.0, 1.0,
        1.0, 1.0, 1.0,
        1.0, 1.0, 1.0,
    };

    buf.drawGrayscaleBuffer(0, 0, &intensities, 3, 3, null, blue_bg);

    buf.popOpacity();

    const cell = buf.get(1, 1).?;
    try std.testing.expect(ansi.redF(cell.bg) > 0.1);
    try std.testing.expect(ansi.blueF(cell.bg) > 0.1);
}

test "OptimizedBuffer - drawGrayscaleBufferSupersampled alpha blending" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        5,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    const red_bg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    buf.clear(red_bg, null);

    const intensities = [_]f32{
        1.0, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    };

    const semi_transparent_bg = ansi.rgbaFromFloats(0.0, 0.0, 1.0, 0.5);
    buf.drawGrayscaleBufferSupersampled(0, 0, &intensities, 4, 4, null, semi_transparent_bg);

    const cell = buf.get(0, 0).?;
    try std.testing.expect(ansi.redF(cell.bg) > 0.1);
    try std.testing.expect(ansi.blueF(cell.bg) > 0.1);
}

test "OptimizedBuffer - drawGrayscaleBufferSupersampled fully transparent preserves bg" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        5,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    const green_bg = ansi.rgbaFromFloats(0.0, 1.0, 0.0, 1.0);
    buf.clear(green_bg, null);

    const intensities = [_]f32{
        1.0, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    };

    const transparent_bg = ansi.rgbaFromFloats(0.0, 0.0, 1.0, 0.0);
    buf.drawGrayscaleBufferSupersampled(0, 0, &intensities, 4, 4, null, transparent_bg);

    const cell = buf.get(0, 0).?;
    try std.testing.expectEqual(@as(u8, 0), ansi.red(cell.bg));
    try std.testing.expectEqual(@as(u8, 255), ansi.green(cell.bg));
    try std.testing.expectEqual(@as(u8, 0), ansi.blue(cell.bg));
}

test "OptimizedBuffer - drawGrayscaleBufferSupersampled respects scissor" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        6,
        4,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    buf.clear(bg, null);

    try buf.pushScissorRect(0, 0, 1, 1);

    const intensities = [_]f32{
        1.0, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    };

    buf.drawGrayscaleBufferSupersampled(0, 0, &intensities, 4, 4, null, bg);

    const inCell = buf.get(0, 0).?;
    const outCell = buf.get(2, 2).?;
    try std.testing.expect(inCell.char != 32);
    try std.testing.expectEqual(@as(u32, 32), outCell.char);

    buf.popScissorRect();
}

test "OptimizedBuffer - drawGrayscaleBufferSupersampled with opacity stack" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        5,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    const red_bg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    buf.clear(red_bg, null);

    try buf.pushOpacity(0.5);

    const intensities = [_]f32{
        1.0, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    };

    const blue_bg = ansi.rgbaFromFloats(0.0, 0.0, 1.0, 1.0);
    buf.drawGrayscaleBufferSupersampled(0, 0, &intensities, 4, 4, null, blue_bg);

    buf.popOpacity();

    const cell = buf.get(0, 0).?;
    try std.testing.expect(ansi.redF(cell.bg) > 0.1);
    try std.testing.expect(ansi.blueF(cell.bg) > 0.1);
}

test "OptimizedBuffer - blendColors with transparent destination" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        2,
        2,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    const transparent_bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0);
    buf.clear(transparent_bg, null);

    const semi_white = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 0.5);
    const transparent_fg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0);
    buf.setCellWithAlphaBlending(0, 0, 'X', semi_white, transparent_fg, 0);

    const cell = buf.get(0, 0).?;
    try std.testing.expectEqual(@as(u8, 255), ansi.red(cell.fg));
    try std.testing.expectEqual(@as(u8, 255), ansi.green(cell.fg));
    try std.testing.expectEqual(@as(u8, 255), ansi.blue(cell.fg));
    try std.testing.expectEqual(@as(u8, 128), ansi.alpha(cell.fg));
}

test "OptimizedBuffer - blend backdrop flattens transparent destination" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        2,
        2,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer", .blendBackdropColor = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0) },
    );
    defer buf.deinit();

    const transparent_bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0);
    buf.clear(transparent_bg, null);

    const opaque_fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const semi_black_bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.5);
    buf.setCellWithAlphaBlending(0, 0, buffer_mod.DEFAULT_SPACE_CHAR, opaque_fg, semi_black_bg, 0);

    const cell = buf.get(0, 0).?;
    try std.testing.expectEqual(@as(u8, 127), ansi.red(cell.bg));
    try std.testing.expectEqual(@as(u8, 127), ansi.green(cell.bg));
    try std.testing.expectEqual(@as(u8, 127), ansi.blue(cell.bg));
    try std.testing.expectEqual(@as(u8, 255), ansi.alpha(cell.bg));
}

test "OptimizedBuffer - drawGrayscaleBuffer with custom fg color" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        5,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    const black_bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    buf.clear(black_bg, null);

    const intensities = [_]f32{
        1.0, 1.0, 1.0,
        1.0, 1.0, 1.0,
        1.0, 1.0, 1.0,
    };

    const red_fg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    buf.drawGrayscaleBuffer(0, 0, &intensities, 3, 3, red_fg, black_bg);

    const cell = buf.get(1, 1).?;
    try std.testing.expect(ansi.redF(cell.fg) > 0.9);
    try std.testing.expect(ansi.greenF(cell.fg) < 0.1);
    try std.testing.expect(ansi.blueF(cell.fg) < 0.1);
}

test "OptimizedBuffer - drawGrayscaleBuffer custom fg with partial intensity" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        5,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    const blue_bg = ansi.rgbaFromFloats(0.0, 0.0, 1.0, 1.0);
    buf.clear(blue_bg, null);

    const intensities = [_]f32{
        0.5, 0.5, 0.5,
        0.5, 0.5, 0.5,
        0.5, 0.5, 0.5,
    };

    const green_fg = ansi.rgbaFromFloats(0.0, 1.0, 0.0, 1.0);
    const transparent_bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0);
    buf.drawGrayscaleBuffer(0, 0, &intensities, 3, 3, green_fg, transparent_bg);

    const cell = buf.get(1, 1).?;
    try std.testing.expect(ansi.greenF(cell.fg) > 0.2);
    try std.testing.expect(ansi.blueF(cell.fg) > 0.2);
}

test "OptimizedBuffer - drawGrayscaleBufferSupersampled with custom fg color" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        5,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .id = "test-buffer" },
    );
    defer buf.deinit();

    const black_bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    buf.clear(black_bg, null);

    const intensities = [_]f32{
        1.0, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    };

    const cyan_fg = ansi.rgbaFromFloats(0.0, 1.0, 1.0, 1.0);
    buf.drawGrayscaleBufferSupersampled(0, 0, &intensities, 4, 4, cyan_fg, black_bg);

    const cell = buf.get(0, 0).?;
    try std.testing.expect(ansi.redF(cell.fg) < 0.1);
    try std.testing.expect(ansi.greenF(cell.fg) > 0.9);
    try std.testing.expect(ansi.blueF(cell.fg) > 0.9);
}

// Overwriting a grapheme cell with the same ID but different extent bits must
// not free the pool slot (which would allow reuse and generation bump).
test "buffer - set same grapheme ID with different extents keeps slot alive" {
    var local_pool = gp.GraphemePool.initWithOptions(std.testing.allocator, .{
        .slots_per_page = .{ 1, 1, 1, 1, 1 },
    });
    defer local_pool.deinit();

    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var buf = try OptimizedBuffer.init(std.testing.allocator, 10, 2, .{
        .pool = &local_pool,
        .link_pool = &local_link_pool,
        .width_method = .unicode,
    });
    defer buf.deinit();

    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);

    const emoji = "👋";

    const gid = local_pool.acquire(emoji) catch @panic("alloc failed");
    const packed_w2 = gp.packGraphemeStart(gid & gp.GRAPHEME_ID_MASK, 2);
    buf.set(0, 0, .{ .char = packed_w2, .fg = fg, .bg = bg, .attributes = 0 });
    try local_pool.decref(gid);
    try std.testing.expectEqual(@as(u32, 1), try local_pool.getRefcount(gid));

    const id_from_char = gp.graphemeIdFromChar(packed_w2);
    try std.testing.expect(buf.grapheme_tracker.contains(id_from_char));

    // Same grapheme ID, different width → different packed char
    const packed_w1 = gp.packGraphemeStart(gid & gp.GRAPHEME_ID_MASK, 1);
    buf.set(0, 0, .{ .char = packed_w1, .fg = fg, .bg = bg, .attributes = 0 });

    try std.testing.expect(buf.grapheme_tracker.contains(id_from_char));

    const bytes = local_pool.get(gid) catch @panic("get failed - slot was freed");
    try std.testing.expectEqualSlices(u8, emoji, bytes);
    try std.testing.expectEqual(@as(u32, 1), try local_pool.getRefcount(gid));
    buf.clear(bg, null);
    try std.testing.expectError(error.InvalidId, local_pool.get(gid));
}

// Exercises grapheme pool slot reuse across multiple render frames with
// alternating dialog/form content to stress the alloc→set→render cycle.
test "renderer - grapheme WrongGeneration repro with pool slot reuse" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(
        std.testing.allocator,
        40,
        5,
        &pools.graphemes,
        &pools.links,
    );
    defer test_renderer.deinit();
    const cli_renderer = test_renderer.renderer;

    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);

    {
        const next = cli_renderer.getNextBuffer();
        try next.drawText("╭────────────────────────────────────╮", 0, 0, fg, bg, 0);
        try next.drawText("│ ◇ Select Files                    │", 0, 1, fg, bg, 0);
        try next.drawText("│ ▫ src/    ▪ file.ts                │", 0, 2, fg, bg, 0);
        try next.drawText("│ ↑↓ navigate  ⏎ select  esc close   │", 0, 3, fg, bg, 0);
        try next.drawText("╰────────────────────────────────────╯", 0, 4, fg, bg, 0);
        _ = cli_renderer.render(false);
    }

    {
        const next = cli_renderer.getNextBuffer();
        try next.drawText("  Your Name                              ", 0, 0, fg, bg, 0);
        try next.drawText("  John Doe                               ", 0, 1, fg, bg, 0);
        try next.drawText("                                         ", 0, 2, fg, bg, 0);
        try next.drawText("  Select Files                           ", 0, 3, fg, bg, 0);
        try next.drawText("  Enter file path...                     ", 0, 4, fg, bg, 0);
        _ = cli_renderer.render(false);
    }

    {
        const next = cli_renderer.getNextBuffer();
        try next.drawText("╭────────────────────────────────────╮", 0, 0, fg, bg, 0);
        try next.drawText("│ ◇ Select Files                    │", 0, 1, fg, bg, 0);
        try next.drawText("│ ▫ src/    ▪ file.ts                │", 0, 2, fg, bg, 0);
        try next.drawText("│ ↑↓ navigate  ⏎ select  esc close   │", 0, 3, fg, bg, 0);
        try next.drawText("╰────────────────────────────────────╯", 0, 4, fg, bg, 0);
        _ = cli_renderer.render(false);
    }

    {
        const next = cli_renderer.getNextBuffer();
        try next.drawText("  Your Name                              ", 0, 0, fg, bg, 0);
        try next.drawText("  John Doe                               ", 0, 1, fg, bg, 0);
        try next.drawText("                                         ", 0, 2, fg, bg, 0);
        try next.drawText("  Select Files                           ", 0, 3, fg, bg, 0);
        try next.drawText("  Enter file path...                     ", 0, 4, fg, bg, 0);
        _ = cli_renderer.render(false);
    }

    {
        const next = cli_renderer.getNextBuffer();
        try next.drawText("╭────────────────────────────────────╮", 0, 0, fg, bg, 0);
        try next.drawText("│ Filter: s                          │", 0, 1, fg, bg, 0);
        try next.drawText("│ ▫ src/                             │", 0, 2, fg, bg, 0);
        try next.drawText("│ ↑↓ navigate  ⏎/tab select          │", 0, 3, fg, bg, 0);
        try next.drawText("╰────────────────────────────────────╯", 0, 4, fg, bg, 0);
        _ = cli_renderer.render(false);
    }
}

// Issue #723: CJK grapheme continuation cells are destroyed when graphemes
// shift left (e.g. after backspace). The renderer's diff loop calls
// currentRenderBuffer.set() left-to-right, and set()'s span cleanup at
// position N+2 destroys the continuation cell at N+1 that was just written
// by set() at position N, because both share the same stable grapheme pool ID.
test "renderer - CJK graphemes shifting left must preserve continuation cells (#723)" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var test_renderer = try TestRenderer.create(
        std.testing.allocator,
        20,
        1,
        &pools.graphemes,
        &pools.links,
    );
    defer test_renderer.deinit();
    const cli_renderer = test_renderer.renderer;

    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);

    // Frame 1: "abcd你好世" — CJK chars start at column 4
    // Layout: a(0) b(1) c(2) d(3) 你(4,5) 好(6,7) 世(8,9) spaces(10..19)
    {
        const next = cli_renderer.getNextBuffer();
        try next.drawText("abcd你好世          ", 0, 0, fg, bg, 0);
        _ = cli_renderer.render(false);
    }

    // Frame 2: "abc你好世" — backspace deleted 'd', CJK chars shift left by 1
    // Layout: a(0) b(1) c(2) 你(3,4) 好(5,6) 世(7,8) spaces(9..19)
    {
        const next = cli_renderer.getNextBuffer();
        try next.drawText("abc你好世           ", 0, 0, fg, bg, 0);
        _ = cli_renderer.render(false);
    }

    // After frame 2, currentRenderBuffer should match the frame 2 layout exactly.
    // The bug: span cleanup in set() destroys continuation cells (positions 4, 6, 8)
    // leaving spaces instead of proper continuation chars.
    const current = cli_renderer.getCurrentBuffer();

    // Check that position 3 is a grapheme start (你)
    const cell3 = current.get(3, 0).?;
    try std.testing.expect(gp.isGraphemeChar(cell3.char));
    try std.testing.expectEqual(@as(u32, 1), gp.charRightExtent(cell3.char));

    // Check that position 4 is a continuation cell for the same grapheme (你)
    const cell4 = current.get(4, 0).?;
    try std.testing.expect(gp.isContinuationChar(cell4.char));
    const id3 = gp.graphemeIdFromChar(cell3.char);
    const id4 = gp.graphemeIdFromChar(cell4.char);
    try std.testing.expectEqual(id3, id4);

    // Check that position 5 is a grapheme start (好)
    const cell5 = current.get(5, 0).?;
    try std.testing.expect(gp.isGraphemeChar(cell5.char));

    // Check that position 6 is a continuation cell for the same grapheme (好)
    const cell6 = current.get(6, 0).?;
    try std.testing.expect(gp.isContinuationChar(cell6.char));
    const id5 = gp.graphemeIdFromChar(cell5.char);
    const id6 = gp.graphemeIdFromChar(cell6.char);
    try std.testing.expectEqual(id5, id6);

    // Check that position 7 is a grapheme start (世)
    const cell7 = current.get(7, 0).?;
    try std.testing.expect(gp.isGraphemeChar(cell7.char));

    // Check that position 8 is a continuation cell for the same grapheme (世)
    const cell8 = current.get(8, 0).?;
    try std.testing.expect(gp.isContinuationChar(cell8.char));
    const id7 = gp.graphemeIdFromChar(cell7.char);
    const id8 = gp.graphemeIdFromChar(cell8.char);
    try std.testing.expectEqual(id7, id8);
}

test "OptimizedBuffer merges frame buffer placements with clipping scissor and opacity" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    const source_buffer = try OptimizedBuffer.init(std.testing.allocator, 6, 4, .{ .pool = &pool, .link_pool = &link_pool });
    defer source_buffer.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 4, 4, .{ .pool = &pool, .link_pool = &link_pool });
    defer target.deinit();

    const wide = try image.createFromRgba(std.testing.allocator, &([_]u8{ 10, 20, 30, 255 } ** 32), 8, 4, 32);
    defer wide.deinit();
    const dot = try image.createFromRgba(std.testing.allocator, &[_]u8{ 1, 2, 3, 255 }, 1, 1, 4);
    defer dot.deinit();

    // Placement A covers cells (1,1)-(4,2) of the frame buffer; placement B
    // sits at (5,3) and will fall entirely outside the destination clip.
    try std.testing.expect(try source_buffer.drawImage(wide, 41, 1, 1, 4, 2, 8, 4, 0, 0, 8, 4, .auto));
    try std.testing.expect(try source_buffer.drawImage(dot, 42, 5, 3, 1, 1, 1, 1, 0, 0, 1, 1, .auto));

    // The target already owns a direct placement, so merged ids must shift.
    try std.testing.expect(try target.drawImage(dot, 43, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .auto));

    try target.pushScissorRect(0, 0, 4, 2);
    try target.pushOpacity(0.5);
    target.drawFrameBuffer(2, 0, source_buffer, null, null, null, null);
    target.popOpacity();
    target.popScissorRect();

    try std.testing.expectEqual(@as(usize, 2), target.image_placements.items.len);
    const direct = target.image_placements.items[0];
    try std.testing.expectEqual(@as(u32, 1), direct.placement_id);
    try std.testing.expectEqual(@as(u32, 43), direct.image_handle);

    const merged = target.image_placements.items[1];
    try std.testing.expectEqual(@as(u32, 2), merged.placement_id);
    try std.testing.expectEqual(@as(u32, 41), merged.image_handle);
    try std.testing.expectEqual(@as(i32, 3), merged.x);
    try std.testing.expectEqual(@as(i32, 1), merged.y);
    try std.testing.expectEqual(@as(u32, 1), merged.width);
    try std.testing.expectEqual(@as(u32, 1), merged.height);
    try std.testing.expectEqual(@as(u32, 2), merged.pixel_width);
    try std.testing.expectEqual(@as(u32, 2), merged.pixel_height);
    try std.testing.expectEqual(@as(u32, 0), merged.source_x);
    try std.testing.expectEqual(@as(u32, 0), merged.source_y);
    try std.testing.expectEqual(@as(u32, 2), merged.source_width);
    try std.testing.expectEqual(@as(u32, 2), merged.source_height);
    try std.testing.expectEqual(@as(u8, 128), merged.opacity);

    // Cells: the direct placement keeps id 1, the merged visible cell maps to
    // id 2, and cells outside the scissor were not copied.
    try std.testing.expectEqual(@as(u32, 1), gp.imageIdFromChar(target.get(0, 0).?.char));
    try std.testing.expectEqual(@as(u32, 2), gp.imageIdFromChar(target.get(3, 1).?.char));
    try std.testing.expect(!gp.isImageChar(target.get(3, 2).?.char));

    // Placement B was clipped away entirely.
    for (target.image_placements.items) |placement| {
        try std.testing.expect(placement.image_handle != 42);
    }
}

test "OptimizedBuffer frame buffer merge multiplies nested placement opacity" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    const source_buffer = try OptimizedBuffer.init(std.testing.allocator, 2, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer source_buffer.deinit();
    const target = try OptimizedBuffer.init(std.testing.allocator, 2, 1, .{ .pool = &pool, .link_pool = &link_pool });
    defer target.deinit();
    const dot = try image.createFromRgba(std.testing.allocator, &[_]u8{ 1, 2, 3, 255 }, 1, 1, 4);
    defer dot.deinit();

    try source_buffer.pushOpacity(0.5);
    try std.testing.expect(try source_buffer.drawImage(dot, 44, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .auto));
    source_buffer.popOpacity();
    try std.testing.expectEqual(@as(u8, 128), source_buffer.image_placements.items[0].opacity);

    try target.pushOpacity(0.5);
    target.drawFrameBuffer(0, 0, source_buffer, null, null, null, null);
    target.popOpacity();
    try std.testing.expectEqual(@as(usize, 1), target.image_placements.items.len);
    // 0.5 * 0.5 = 0.25 -> 64 of 255.
    try std.testing.expect(@abs(@as(i16, target.image_placements.items[0].opacity) - 64) <= 1);
}

test "OptimizedBuffer drawTextChecked warm draws avoid heap allocation" {
    const foreground = ansi.rgbColor(84, 171, 224, 255);
    const background = ansi.rgbColor(28, 32, 38, 255);
    // Frozen wide-driver inputs, at its last panel/hook positions in a 140x44 frame.
    const cases = [_]struct { text: []const u8, x: u32, y: u32, bg: ?RGBA }{
        .{ .text = "busy 23", .x = 117, .y = 30, .bg = background },
        .{
            .text = "alpha \u{4e16}\u{754c} e\u{301} \u{1f469}\u{200d}\u{1f4bb} \u{1f1fa}\u{1f1f3} wrap at the cell boundary ",
            .x = 106,
            .y = 36,
            .bg = null,
        },
        .{
            .text = "bravo \u{65e5}\u{672c} a\u{308} \u{1f468}\u{200d}\u{1f680} \u{1f1ef}\u{1f1f5} different wrapped text ",
            .x = 106,
            .y = 36,
            .bg = null,
        },
    };
    for (cases) |case| {
        var expected_pool = gp.GraphemePool.init(std.testing.allocator);
        defer expected_pool.deinit();
        var expected_links = link.LinkPool.init(std.testing.allocator);
        defer expected_links.deinit();
        const expected = try OptimizedBuffer.init(std.testing.allocator, 140, 44, .{ .pool = &expected_pool, .link_pool = &expected_links });
        defer expected.deinit();
        expected.clear(background, null);
        try expected.pushScissorRect(0, 0, 140, 44);
        try expected.pushOpacity(1.0);
        try expected.drawText(case.text, case.x, case.y, foreground, case.bg, 0);

        var requests = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        const allocator = requests.allocator();
        var pool = gp.GraphemePool.init(allocator);
        defer pool.deinit();
        var links = link.LinkPool.init(allocator);
        defer links.deinit();
        const target = try OptimizedBuffer.init(allocator, 140, 44, .{ .pool = &pool, .link_pool = &links });
        defer target.deinit();
        target.clear(background, null);
        try target.pushScissorRect(0, 0, 140, 44);
        try target.pushOpacity(1.0);
        for (0..8) |_| try target.drawTextChecked(case.text, @intCast(case.x), @intCast(case.y), foreground, case.bg, 0);
        const allocations = requests.allocations;
        const resizes = requests.resize_index;
        for (0..64) |_| try target.drawTextChecked(case.text, @intCast(case.x), @intCast(case.y), foreground, case.bg, 0);
        try std.testing.expectEqual(allocations, requests.allocations);
        try std.testing.expectEqual(resizes, requests.resize_index);
        try std.testing.expectEqualSlices(RGBA, expected.buffer.fg, target.buffer.fg);
        try std.testing.expectEqualSlices(RGBA, expected.buffer.bg, target.buffer.bg);
        try std.testing.expectEqualSlices(u32, expected.buffer.attributes, target.buffer.attributes);
        for (expected.buffer.char, target.buffer.char) |expected_char, actual_char| {
            if (gp.isClusterChar(expected_char)) {
                try std.testing.expectEqual(expected_char & ~gp.GRAPHEME_ID_MASK, actual_char & ~gp.GRAPHEME_ID_MASK);
                const id = gp.graphemeIdFromChar(actual_char);
                try std.testing.expectEqualStrings(try expected_pool.get(gp.graphemeIdFromChar(expected_char)), try pool.get(id));
                try std.testing.expectEqual(@as(u32, 1), try pool.getRefcount(id));
            } else {
                try std.testing.expectEqual(expected_char, actual_char);
            }
        }
        try std.testing.expectEqual(expected.grapheme_tracker.getGraphemeCount(), target.grapheme_tracker.getGraphemeCount());
        try std.testing.expectEqual(expected_pool.interned_live_ids.count(), pool.interned_live_ids.count());
        try std.testing.expectEqual(@as(u32, 0), target.link_tracker.getLinkCount());
        target.clear(background, null);
        try std.testing.expectEqual(@as(u32, 0), pool.interned_live_ids.count());
        try std.testing.expectEqual(@as(u32, 0), target.grapheme_tracker.getGraphemeCount());
    }
}

test "OptimizedBuffer drawTextChecked preserves cells and references at every allocation failure" {
    // Exercise pool/tracker growth and each independent heap fallback.
    for ([_]struct { text: []const u8, visible_columns: u32, width: u32 = 512 }{
        .{ .text = "\u{e9}\u{4e2d}e\u{301}\tZ\u{3b1}\u{3b2}\u{3b3}\u{3b4}\u{3f5}", .visible_columns = 12, .width = 12 },
        .{ .text = "x" ** 4097, .visible_columns = 4 },
        .{ .text = "\u{e9}" ** 512, .visible_columns = 4 },
        .{ .text = "x" ** 512, .visible_columns = 512 },
    }) |case| {
        const text = case.text;
        var failures: usize = 0;
        var succeeded = false;
        for (0..64) |fail_after| {
            var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
            const allocator = failing.allocator();
            var pool = gp.GraphemePool.initWithOptions(allocator, if (case.width == 12)
                .{ .slots_per_page = .{ 1, 1, 1, 1, 1 } }
            else
                .{});
            defer pool.deinit();
            var links = link.LinkPool.init(allocator);
            defer links.deinit();
            const target = try OptimizedBuffer.init(allocator, case.width, 1, .{ .pool = &pool, .link_pool = &links });
            defer target.deinit();
            const fg = ansi.rgbColor(220, 180, 140, 255);
            const bg = ansi.rgbColor(20, 40, 60, 255);
            target.clear(bg, null);
            if (case.width == 512) try target.pushScissorRect(0, 0, case.visible_columns, 1);
            const link_id = try links.acquire("https://kept.example");
            try target.drawText("\u{3a9}old", 0, 0, fg, bg, ansi.TextAttributes.setLinkId(1, link_id));
            try links.decref(link_id);
            const old_id = gp.graphemeIdFromChar(target.buffer.char[0]);
            const chars = try std.testing.allocator.dupe(u32, target.buffer.char);
            defer std.testing.allocator.free(chars);
            const foreground = try std.testing.allocator.dupe(RGBA, target.buffer.fg);
            defer std.testing.allocator.free(foreground);
            const background = try std.testing.allocator.dupe(RGBA, target.buffer.bg);
            defer std.testing.allocator.free(background);
            const attributes = try std.testing.allocator.dupe(u32, target.buffer.attributes);
            defer std.testing.allocator.free(attributes);
            const tracker_capacity = target.grapheme_tracker.used_ids.capacity();

            failing.fail_index = failing.alloc_index + fail_after;
            failing.resize_fail_index = failing.resize_index;
            const result = target.drawTextChecked(text, 0, 0, fg, bg, 8);
            failing.fail_index = std.math.maxInt(usize);
            failing.resize_fail_index = std.math.maxInt(usize);
            if (result) |_| {
                succeeded = true;
            } else |err| {
                try std.testing.expectEqual(error.OutOfMemory, err);
                failures += 1;
                try std.testing.expectEqualSlices(u32, chars, target.buffer.char);
                try std.testing.expectEqualSlices(RGBA, foreground, target.buffer.fg);
                try std.testing.expectEqualSlices(RGBA, background, target.buffer.bg);
                try std.testing.expectEqualSlices(u32, attributes, target.buffer.attributes);
                try std.testing.expectEqual(1, target.grapheme_tracker.getGraphemeCount());
                try std.testing.expectEqual(1, target.link_tracker.getLinkCount());
                try std.testing.expectEqual(1, try pool.getRefcount(old_id));
                try std.testing.expectEqual(1, try links.getRefcount(link_id));
                try std.testing.expectEqual(1, pool.interned_live_ids.count());
                var live_slots: usize = 0;
                for (pool.classes) |class| live_slots += @as(usize, class.num_slots) - class.free_list.items.len;
                try std.testing.expectEqual(1, live_slots);
                try target.drawTextChecked(text, 0, 0, fg, bg, 8);
            }
            if (text[0] == 'x') {
                try std.testing.expectEqual(@as(u32, 'x'), target.buffer.char[0]);
            } else {
                try std.testing.expectEqualStrings("\u{e9}", try pool.get(gp.graphemeIdFromChar(target.buffer.char[0])));
            }
            if (case.width == 12) {
                try std.testing.expect(target.grapheme_tracker.used_ids.capacity() > tracker_capacity);
                try std.testing.expectEqual(@as(u32, 'Z'), target.buffer.char[6]);
            }
            target.clear(bg, null);
            try std.testing.expectEqual(0, pool.interned_live_ids.count());
            try std.testing.expectEqual(0, links.getLiveSlotCount());
            for (pool.classes) |class| try std.testing.expectEqual(class.num_slots, class.free_list.items.len);
            if (succeeded) break;
        }
        try std.testing.expect(succeeded);
        try std.testing.expect(failures >= if (case.width == 12) @as(usize, 5) else 1);
    }
}
