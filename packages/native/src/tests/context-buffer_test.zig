const std = @import("std");
const testing = std.testing;
const context = @import("../context.zig");
const ansi = @import("../ansi.zig");
const grapheme = @import("../grapheme.zig");
const image = @import("../image.zig");
const scene = @import("../scene.zig");

const swap_red_blue = [_]f32{ 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1 };

test "Context color matrices keep masked and uniform effects allocation-free with live storage leases" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const owner = try context.Context.init(failing.allocator(), testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createBuffer(5, 2, .{});
    const foreground = ansi.rgbColor(200, 40, 20, 255);
    const background = ansi.rgbColor(10, 30, 50, 255);
    try owner.clearBuffer(id, background);
    try owner.drawBufferText(id, "A\u{754c}B", 0, 0, foreground, background, 1);
    const lease = try owner.acquireOwnedBufferLease(id);
    defer owner.releaseBufferLease(lease) catch unreachable;
    const before = try owner.bufferLeaseSnapshot(lease);
    const chars = before.buffer.char[0..10].*;
    const attributes = before.buffer.attributes[0..10].*;
    const target = try owner.getBuffer(id);
    const glyph = grapheme.graphemeIdFromChar(chars[1]);
    const references = try owner.graphemes.getRefcount(glyph);
    var matrix_bytes: [65]u8 align(4) = undefined;
    @memcpy(matrix_bytes[1..], std.mem.asBytes(&swap_red_blue));
    const matrix = std.mem.bytesAsSlice(f32, matrix_bytes[1..]);
    failing.fail_index = failing.alloc_index;
    failing.resize_fail_index = failing.resize_index;

    try owner.colorMatrixBuffer(id, null, matrix, &.{}, 1, 3);
    try testing.expectEqual(foreground, target.buffer.fg[0]);
    try testing.expectEqual(background, target.buffer.bg[0]);
    try owner.colorMatrixBuffer(id, null, matrix, null, 1, 1);
    try testing.expectEqual(ansi.rgbColor(20, 40, 200, 255), target.buffer.fg[0]);
    try testing.expectEqual(background, target.buffer.bg[0]);
    const mask = [_]f32{
        0,                 0,            0.5,
        -1,                0,            1,
        std.math.nan(f32), 0,            1,
        1,                 0,            std.math.inf(f32),
        4294967296.0,      0,            1,
        0,                 4294967296.0, 1,
        99,
    };
    var mask_bytes: [@sizeOf(@TypeOf(mask)) + 1]u8 align(4) = undefined;
    @memcpy(mask_bytes[1..], std.mem.asBytes(&mask));
    try owner.colorMatrixBuffer(id, null, matrix, std.mem.bytesAsSlice(f32, mask_bytes[1..]), 1, 2);
    try testing.expectEqual(ansi.rgbColor(30, 30, 30, 255), target.buffer.bg[0]);
    try testing.expectEqual(background, target.buffer.bg[1]);
    try testing.expectEqualSlices(u32, &chars, target.buffer.char);
    try testing.expectEqualSlices(u32, &attributes, target.buffer.attributes);
    try testing.expectEqual(references, try owner.graphemes.getRefcount(glyph));
    try testing.expectEqualDeep(before, try owner.bufferLeaseSnapshot(lease));
    try testing.expect(!failing.has_induced_failure);
}

test "Context color matrices reject invalid input before changing accepted cells" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{ .render_cells_max = 4 });
    defer owner.deinit() catch unreachable;
    const id = try owner.createBuffer(4, 1, .{});
    const target = try owner.getBuffer(id);
    const background = ansi.rgbColor(200, 40, 20, 255);
    try owner.clearBuffer(id, background);
    const before = target.buffer.bg[0..4].*;
    try testing.expectError(error.InvalidOptions, owner.colorMatrixBuffer(id, null, swap_red_blue[0..15], null, 1, 3));
    var invalid = swap_red_blue;
    invalid[15] = std.math.nan(f32);
    try testing.expectError(error.InvalidOptions, owner.colorMatrixBuffer(id, null, &invalid, null, 1, 3));
    for ([_]f32{ std.math.nan(f32), std.math.inf(f32) }) |strength| {
        try testing.expectError(error.InvalidOptions, owner.colorMatrixBuffer(id, null, &swap_red_blue, null, strength, 3));
    }
    for ([_]u32{ 0, 4, std.math.maxInt(u32) }) |channel| {
        try testing.expectError(error.InvalidOptions, owner.colorMatrixBuffer(id, null, &swap_red_blue, null, 1, channel));
    }
    const oversized = [_]f32{ 0, 0, 1 } ** 5;
    try testing.expectError(error.InvalidOptions, owner.colorMatrixBuffer(id, null, &swap_red_blue, &oversized, 1, 3));
    try testing.expectEqualSlices(ansi.RGBA, &before, target.buffer.bg);
    try testing.expect(!owner.mutating);
    try owner.destroy(id);
    try testing.expectError(error.StaleHandle, owner.colorMatrixBuffer(id, null, &swap_red_blue, null, 0, 3));
}

test "Context color matrices require the exact active frame even for zero-strength or empty masks" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const foreign = try context.Context.init(testing.allocator, testing.io, .{});
    defer foreign.deinit() catch unreachable;
    const session = try owner.createSession(.{});
    try owner.attachSessionRenderer(session, 5, 1, .{ .remote_mode = .remote });
    _ = try owner.sceneCreateNode(session, 0, 1);
    const frame = try owner.sceneFrameStep(session, null, .{ .background = .{ 200, 40, 20, 255 }, .use_mouse = false, .excluded_hit_num = 0, .max_layout_rounds = 8, .max_host_requests = 64 });
    try testing.expectError(error.WrongKind, owner.colorMatrixBuffer(session, null, &swap_red_blue, null, 1, 3));
    const peer = try foreign.createBuffer(1, 1, .{});
    try testing.expectError(error.WrongContext, owner.colorMatrixBuffer(peer, null, &swap_red_blue, null, 1, 3));
    try owner.colorMatrixBuffer(session, frame, &swap_red_blue, null, 1, 3);
    const target = (try owner.getSessionRenderer(session)).getNextBuffer();
    try testing.expectEqual(ansi.rgbColor(20, 40, 200, 255), target.buffer.bg[0]);
    var altered = frame;
    altered.frame_id += 1;
    try testing.expectError(error.StaleFrame, owner.colorMatrixBuffer(session, altered, &swap_red_blue, null, 0, 3));
    try owner.sceneFrameCancel(session, frame.frame_id);
    try testing.expectError(error.StaleFrame, owner.colorMatrixBuffer(session, frame, &swap_red_blue, &.{}, 1, 3));
}

test "Context checked character drawing rejects colliding encoded IDs from distinct pools" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const foreign = try context.Context.init(testing.allocator, testing.io, .{});
    defer foreign.deinit() catch unreachable;
    const id = try owner.createBuffer(2, 1, .{});
    const peer = try foreign.createBuffer(2, 1, .{});
    const color = ansi.rgbColor(255, 255, 255, 255);
    try owner.drawBufferText(id, "\u{754c}", 0, 0, color, null, 0);
    try foreign.drawBufferText(peer, "\u{8a9e}", 0, 0, color, null, 0);
    const target = try owner.getBuffer(id);
    const foreign_buffer = try foreign.getBuffer(peer);
    const char = foreign_buffer.buffer.char[0];
    try testing.expectEqual(char, target.buffer.char[0]);
    try testing.expectError(error.InvalidOptions, owner.drawBuffer(id, null, .{ .operation = .char, .char = char }, "", ""));
    try testing.expectEqualStrings("\u{754c}", try owner.graphemes.get(grapheme.graphemeIdFromChar(char)));
    try testing.expectEqualStrings("\u{8a9e}", try foreign.graphemes.get(grapheme.graphemeIdFromChar(char)));
}

test "Context checked Box drawing decodes partial borders with the public side masks" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createBuffer(3, 3, .{});
    const target = try owner.getBuffer(id);
    for (0..16) |mask| {
        try owner.clearBuffer(id, ansi.rgbColor(0, 0, 0, 255));
        try owner.drawBuffer(id, null, .{
            .operation = .box,
            .width = 3,
            .height = 3,
            .foreground = ansi.rgbColor(255, 255, 255, 255),
            .packed_options = @intCast(mask),
            .border_chars = .{ '+', '+', '+', '+', '-', '|', '+', '+', '+', '+', '+' },
        }, "", "");
        try testing.expectEqual(@as(u32, if (mask & 8 != 0) '-' else ' '), target.buffer.char[1]);
        try testing.expectEqual(@as(u32, if (mask & 4 != 0) '|' else ' '), target.buffer.char[5]);
        try testing.expectEqual(@as(u32, if (mask & 2 != 0) '-' else ' '), target.buffer.char[7]);
        try testing.expectEqual(@as(u32, if (mask & 1 != 0) '|' else ' '), target.buffer.char[3]);
        try testing.expectEqual(@as(u32, ' '), target.buffer.char[4]);
    }
}

test "Context fill rectangle clips unsigned extents and keeps leases current" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createBuffer(4, 2, .{});
    const lease = try owner.acquireOwnedBufferLease(id);
    defer owner.releaseBufferLease(lease) catch unreachable;
    const snapshot = try owner.bufferLeaseSnapshot(lease);
    const black = ansi.rgbColor(0, 0, 0, 255);
    const red = ansi.rgbColor(255, 0, 0, 255);
    try owner.clearBuffer(id, black);
    try owner.drawBufferText(id, "ABCD", 0, 0, red, null, 1);
    try owner.fillBufferRect(id, 2, 0, std.math.maxInt(u32), std.math.maxInt(u32), red);
    try testing.expectEqualSlices(u32, &.{ 'A', 'B', ' ', ' ', ' ', ' ', ' ', ' ' }, snapshot.buffer.char);
    try testing.expectEqual(red, snapshot.buffer.bg[7]);
    try testing.expectEqual(black, snapshot.buffer.bg[5]);
    try testing.expectEqual(@as(u32, 0), snapshot.buffer.attributes[2]);
    try testing.expectEqualDeep(snapshot, try owner.bufferLeaseSnapshot(lease));
    try owner.fillBufferRect(id, std.math.maxInt(u32), 0, 1, 1, black);
    try owner.fillBufferRect(id, 0, 0, 0, 1, black);
    try testing.expectError(error.InvalidOptions, owner.fillBufferRect(id, 0, 0, 1, 1, .{ 0, 0, 256, 255 }));
    try testing.expectEqual(@as(u32, 'A'), snapshot.buffer.char[0]);
    try owner.destroy(id);
    try testing.expectError(error.StaleHandle, owner.fillBufferRect(id, 0, 0, 1, 1, red));
}

test "Context frame buffer composition checks tickets and retains source resources" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const owner = try context.Context.init(failing.allocator(), testing.io, .{});
    defer owner.deinit() catch unreachable;
    const foreign = try context.Context.init(testing.allocator, testing.io, .{});
    defer foreign.deinit() catch unreachable;
    const session = try owner.createSession(.{ .chunk_size = 4096 });
    defer owner.cancelSession(session) catch unreachable;
    try owner.attachSessionRenderer(session, 4, 1, .{ .remote_mode = .remote });
    const root = try owner.sceneCreateNode(session, 0, 1);
    const child = try owner.sceneCreateNode(session, 1, 2);
    try owner.sceneSetStyle(child, 4, 0, 0, 1, 4, 1);
    try owner.sceneSetStyle(child, 4, 1, 0, 1, 1, 1);
    try owner.sceneMoveNode(child, root, 0);
    try owner.sceneSetPaint(child, .{ .shouldFill = 0, .opacity = 0.5 });
    try owner.sceneSetHooks(child, 8, 1, 4, 1);
    const options: scene.FrameOptions = .{ .background = .{ 0, 0, 0, 255 }, .use_mouse = false, .excluded_hit_num = 0, .max_layout_rounds = 8, .max_host_requests = 64 };
    const source = try owner.createBuffer(4, 1, .{});
    const peer = try foreign.createBuffer(4, 1, .{});
    const source_buffer = try owner.getBuffer(source);
    const link_id = try owner.links.alloc("https://example.test/frame-buffer");
    try source_buffer.drawText("\u{754c}AB", 0, 0, ansi.rgbColor(255, 255, 255, 255), ansi.rgbColor(200, 0, 0, 255), ansi.TextAttributes.setLinkId(0, link_id));
    const glyph = source_buffer.buffer.char[0] & grapheme.GRAPHEME_ID_MASK;
    const frame = try owner.sceneFrameStep(session, null, options);
    try testing.expectEqual(@as(u32, 4), frame.kind);
    const target = (try owner.getSessionRenderer(session)).getNextBuffer();
    const before = target.buffer.char[0..4].*;
    var altered = frame;
    altered.request_id += 1;
    try testing.expectError(error.StaleFrame, owner.sceneFrameDrawBuffer(session, altered, source, 0, 0));
    try testing.expectError(error.WrongContext, owner.sceneFrameDrawBuffer(session, frame, peer, 0, 0));
    try testing.expectError(error.WrongKind, owner.sceneFrameDrawBuffer(session, frame, session, 0, 0));
    try testing.expectError(error.FrameBusy, owner.drawSessionBuffer(session, source, 0, 0));
    failing.fail_index = failing.alloc_index;
    failing.resize_fail_index = failing.resize_index;
    try testing.expectError(error.OutOfMemory, owner.sceneFrameDrawBuffer(session, frame, source, 0, 0));
    try testing.expectEqualSlices(u32, &before, target.buffer.char);
    try testing.expect(!owner.mutating);
    failing.fail_index = std.math.maxInt(usize);
    failing.resize_fail_index = std.math.maxInt(usize);
    try target.pushScissorRect(0, 0, 2, 1);
    try owner.sceneFrameDrawBuffer(session, frame, source, 0, 0);
    target.popScissorRect();
    try testing.expectEqual(source_buffer.buffer.char[0], target.buffer.char[0]);
    try testing.expectEqual(@as(u32, ' '), target.buffer.char[2]);
    try testing.expect(target.buffer.bg[0][0] > 0 and target.buffer.bg[0][0] < 200);
    const done = try owner.sceneFrameStep(session, frame, options);
    try testing.expectEqual(@as(u32, 0), done.kind);
    try testing.expectError(error.StaleFrame, owner.sceneFrameDrawBuffer(session, frame, source, 0, 0));
    const pixels = try image.createFromRgba(testing.allocator, &.{ 255, 0, 0, 255 }, 1, 1, 4);
    defer pixels.deinit();
    try testing.expect(try source_buffer.drawImage(pixels, 1, 2, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));
    try testing.expectError(error.UnsupportedResource, owner.sceneFrameDrawBuffer(session, done, source, 0, 0));
    try owner.clearBuffer(source, ansi.rgbColor(0, 0, 0, 255));
    try owner.drawBufferText(source, "XY", 0, 0, ansi.rgbColor(255, 255, 255, 255), null, 0);
    try owner.sceneFrameDrawBuffer(session, done, source, 2, 0);
    try owner.destroy(source);
    try testing.expectEqualStrings("\u{754c}", try owner.graphemes.get(glyph));
    try testing.expectEqualStrings("https://example.test/frame-buffer", try owner.links.get(link_id));
    try testing.expectEqualSlices(u32, &.{ 'X', 'Y' }, target.buffer.char[2..4]);
    try testing.expectEqual(.pending, try owner.sceneFrameCommit(session, done, true));
    try testing.expectError(error.PresentationPending, owner.sceneFrameDrawBuffer(session, done, peer, 0, 0));
    try owner.cancelSession(session);
    try testing.expectError(error.SessionCancelled, owner.sceneFrameDrawBuffer(session, done, peer, 0, 0));
}

test "Context frame composition applies prefix opacity to ASCII memcpy candidates" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const session = try owner.createSession(.{});
    try owner.attachSessionRenderer(session, 4, 2, .{ .remote_mode = .remote });
    const root = try owner.sceneCreateNode(session, 0, 1);
    const child = try owner.sceneCreateNode(session, 1, 2);
    try owner.sceneSetStyle(child, 4, 0, 0, 1, 4, 1);
    try owner.sceneSetStyle(child, 4, 1, 0, 1, 2, 1);
    try owner.sceneSetPaint(child, .{ .shouldFill = 0, .opacity = 0.5 });
    try owner.sceneSetHooks(child, 8, 1, 4, 2);
    try owner.sceneMoveNode(child, root, 0);
    const source = try owner.createBuffer(4, 2, .{});
    const red = ansi.rgbColor(200, 0, 0, 255);
    for (0..2) |row| try owner.drawBufferText(source, "AAAA", 0, @intCast(row), red, red, 0);
    const frame = try owner.sceneFrameStep(session, null, .{ .background = .{ 0, 0, 0, 255 }, .use_mouse = false, .excluded_hit_num = 0, .max_layout_rounds = 8, .max_host_requests = 64 });
    defer owner.sceneFrameCancel(session, frame.frame_id) catch unreachable;
    try testing.expectEqual(@as(u32, 4), frame.kind);
    const target = (try owner.getSessionRenderer(session)).getNextBuffer();
    const source_buffer = try owner.getBuffer(source);
    try testing.expect(!source_buffer.respectAlpha and !source_buffer.grapheme_tracker.hasAny() and !source_buffer.link_tracker.hasAny());
    // Cover the contiguous and row-by-row memcpy eligibility conditions.
    for ([_]u32{ 4, 2 }) |width| {
        target.clear(ansi.rgbColor(0, 0, 0, 255), null);
        try target.pushScissorRect(0, 0, width, 2);
        defer target.popScissorRect();
        try owner.sceneFrameDrawBuffer(session, frame, source, 0, 0);
        try testing.expectEqual(@as(f32, 0.5), target.getCurrentOpacity());
        for (0..2) |row| {
            try testing.expectEqual(@as(u32, 'A'), target.get(0, @intCast(row)).?.char);
            try testing.expectEqual(@as(u8, 100), ansi.red(target.get(0, @intCast(row)).?.bg));
            if (width == 2) try testing.expectEqual(@as(u8, 0), ansi.red(target.get(2, @intCast(row)).?.bg));
        }
    }
    try testing.expectEqual(red, source_buffer.buffer.bg[0]);
}

test "Context frame composition replaces right-clipped wide glyphs without writing beyond scissor" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const session = try owner.createSession(.{});
    try owner.attachSessionRenderer(session, 4, 1, .{ .remote_mode = .remote });
    _ = try owner.sceneCreateNode(session, 0, 1);
    const source = try owner.createBuffer(2, 1, .{});
    const red = ansi.rgbColor(200, 0, 0, 255);
    const source_buffer = try owner.getBuffer(source);
    const link_id = try owner.links.alloc("https://example.test/clipped-wide");
    const attributes = ansi.TextAttributes.setLinkId(1, link_id);
    try source_buffer.drawText("\u{754c}", 0, 0, red, red, attributes);
    const source_chars = source_buffer.buffer.char[0..2].*;
    const frame = try owner.sceneFrameStep(session, null, .{ .background = .{ 0, 0, 0, 255 }, .use_mouse = false, .excluded_hit_num = 0, .max_layout_rounds = 8, .max_host_requests = 64 });
    defer owner.sceneFrameCancel(session, frame.frame_id) catch unreachable;
    const target = (try owner.getSessionRenderer(session)).getNextBuffer();
    try target.drawText("ABCD", 0, 0, red, ansi.rgbColor(0, 0, 0, 255), 0);
    const outside = target.get(2, 0).?;
    try target.pushScissorRect(1, 0, 1, 1);
    try owner.sceneFrameDrawBuffer(session, frame, source, 1, 0);
    target.popScissorRect();
    try testing.expectEqualDeep(outside, target.get(2, 0).?);
    try testing.expectEqualSlices(u32, &.{ 'A', ' ', 'C', 'D' }, target.buffer.char);
    try testing.expectEqual(red, target.get(1, 0).?.bg);
    try testing.expectEqual(attributes, target.get(1, 0).?.attributes);
    try testing.expect(!target.grapheme_tracker.hasAny());
    try testing.expectEqualSlices(u32, &source_chars, source_buffer.buffer.char);
    try owner.destroy(source);
    try testing.expectEqualStrings("https://example.test/clipped-wide", try owner.links.get(link_id));
}

test "Context frame composition fills clipped tails of repeated four-cell spans" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const session = try owner.createSession(.{});
    try owner.attachSessionRenderer(session, 8, 1, .{ .remote_mode = .remote });
    _ = try owner.sceneCreateNode(session, 0, 1);
    const source = try owner.createBuffer(8, 1, .{});
    const source_buffer = try owner.getBuffer(source);
    const red = ansi.rgbColor(200, 0, 0, 255);
    for ([_]u32{ 0, 4 }) |x| try source_buffer.drawGrapheme("wide", 4, x, 0, red, red, 1);
    const source_chars = source_buffer.buffer.char[0..8].*;
    const glyph = grapheme.graphemeIdFromChar(source_chars[0]);
    try testing.expectEqual(glyph, grapheme.graphemeIdFromChar(source_chars[4]));
    const frame = try owner.sceneFrameStep(session, null, .{ .background = .{ 0, 0, 0, 255 }, .use_mouse = false, .excluded_hit_num = 0, .max_layout_rounds = 8, .max_host_requests = 64 });
    defer owner.sceneFrameCancel(session, frame.frame_id) catch unreachable;
    const target = (try owner.getSessionRenderer(session)).getNextBuffer();
    for ([_]bool{ false, true }) |source_crop| {
        for ([_]u32{ 5, 6, 7, 8 }) |width| {
            target.clear(ansi.rgbColor(0, 0, 0, 255), 'X');
            if (source_crop) {
                target.drawFrameBuffer(0, 0, source_buffer, null, null, width, null);
            } else {
                try target.pushScissorRect(0, 0, width, 1);
                defer target.popScissorRect();
                try owner.sceneFrameDrawBuffer(session, frame, source, 0, 0);
            }
            try testing.expectEqualSlices(u32, source_chars[0..4], target.buffer.char[0..4]);
            try testing.expectEqual(@as(u32, if (width == 8) 2 else 1), target.grapheme_tracker.getGraphemeCellCount());
            for (4..8) |x| {
                const expected: u32 = if (width == 8) source_chars[x] else if (x < width) ' ' else 'X';
                try testing.expectEqual(expected, target.buffer.char[x]);
                if (x < width) try testing.expectEqual(red, target.buffer.bg[x]);
            }
            try testing.expectEqualSlices(u32, &source_chars, source_buffer.buffer.char);
        }
    }
}

test "Context buffer copy rejects invalid owners phases and tracker failure before drawing" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const owner = try context.Context.init(failing.allocator(), testing.io, .{ .render_cells_max = 16 });
    defer owner.deinit() catch unreachable;
    const foreign = try context.Context.init(testing.allocator, testing.io, .{});
    defer foreign.deinit() catch unreachable;
    const session = try owner.createSession(.{ .chunk_size = 4096 });
    defer owner.cancelSession(session) catch unreachable;
    const id = try owner.createBuffer(4, 1, .{});
    const peer = try foreign.createBuffer(4, 1, .{});
    try testing.expectError(error.RendererNotAttached, owner.drawSessionBuffer(session, id, 0, 0));
    try owner.attachSessionRenderer(session, 4, 1, .{ .remote_mode = .remote });
    const cli = try owner.getSessionRenderer(session);
    const target = cli.getNextBuffer();
    const source = try owner.getBuffer(id);
    const source_lease = try owner.acquireOwnedBufferLease(id);
    defer owner.releaseBufferLease(source_lease) catch unreachable;
    try owner.clearBuffer(id, ansi.rgbColor(0, 0, 0, 255));
    try owner.drawBufferText(id, "\u{754c}A", 0, 0, ansi.rgbColor(255, 255, 255, 255), null, 0);
    const other = try foreign.getBuffer(peer);
    try other.drawText("\u{8a9e}B", 0, 0, ansi.rgbColor(255, 255, 255, 255), null, 0);
    try testing.expectEqual(source.buffer.char[0], other.buffer.char[0]);
    const before = target.buffer.char[0..4].*;
    const source_before_rejection = source.buffer.char[0..4].*;
    const stats = (try owner.getSession(session)).getStats();
    try testing.expectError(error.WrongContext, owner.drawSessionBuffer(session, peer, 0, 0));
    try testing.expectError(error.WrongKind, owner.drawSessionBuffer(session, session, 0, 0));
    try testing.expectError(error.WrongContext, owner.clearBuffer(peer, ansi.rgbColor(0, 0, 0, 255)));
    try testing.expectError(error.InvalidOptions, owner.clearBuffer(id, .{ 0, 768, 0, 255 }));
    try testing.expectError(error.InvalidUnicode, owner.drawBufferText(id, "bad\xff", 0, 0, .{ 255, 255, 255, 255 }, null, 0));
    try testing.expectEqualSlices(u32, &source_before_rejection, source.buffer.char);
    {
        owner.mutating = true;
        defer owner.mutating = false;
        try testing.expectError(error.ContextBusy, owner.drawSessionBuffer(session, id, 0, 0));
    }
    failing.fail_index = failing.alloc_index;
    failing.resize_fail_index = failing.resize_index;
    try testing.expectError(error.OutOfMemory, owner.drawSessionBuffer(session, id, 0, 0));
    try testing.expect(failing.has_induced_failure);
    try testing.expectEqualSlices(u32, &before, target.buffer.char);
    try testing.expectEqualDeep(stats, (try owner.getSession(session)).getStats());
    try testing.expect(!owner.mutating);
    failing.fail_index = std.math.maxInt(usize);
    failing.resize_fail_index = std.math.maxInt(usize);
    try owner.drawSessionBuffer(session, id, -1, 0);
    try testing.expectEqual(@as(u32, ' '), target.buffer.char[0]);
    try testing.expectEqual(@as(u32, 'A'), target.buffer.char[1]);
    for ([_]i32{ std.math.minInt(i32), std.math.maxInt(i32) }) |coordinate| {
        try owner.drawSessionBuffer(session, id, coordinate, coordinate);
    }
    const pixels = try image.createFromRgba(testing.allocator, &.{ 255, 0, 0, 255 }, 1, 1, 4);
    defer pixels.deinit();
    for ([_]@TypeOf(source){ source, target }) |with_image| {
        try testing.expect(try with_image.drawImage(pixels, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));
        const source_before = source.buffer.char[0..4].*;
        const target_before = target.buffer.char[0..4].*;
        const references = pixels.ref_count;
        try testing.expectError(error.UnsupportedResource, owner.drawSessionBuffer(session, id, 0, 0));
        try testing.expectEqualSlices(u32, &source_before, source.buffer.char);
        try testing.expectEqualSlices(u32, &target_before, target.buffer.char);
        try testing.expectEqual(references, pixels.ref_count);
        with_image.clear(ansi.rgbColor(0, 0, 0, 255), null);
    }
    try testing.expectEqual(.pending, try owner.renderSession(session, true));
    try testing.expectError(error.PresentationPending, owner.drawSessionBuffer(session, id, 0, 0));
    try owner.cancelSession(session);
    try testing.expectError(error.SessionCancelled, owner.drawSessionBuffer(session, id, 0, 0));
}

fn bufferAllocationFailures(allocator: std.mem.Allocator) !void {
    const owner = try context.Context.init(allocator, testing.io, .{ .object_capacity = 2 });
    defer owner.deinit() catch unreachable;
    const id = try owner.createBuffer(2, 1, .{});
    const lease = try owner.acquireOwnedBufferLease(id);
    defer owner.releaseBufferLease(lease) catch unreachable;
    const before = try owner.bufferLeaseSnapshot(lease);
    before.buffer.char[0] = 'A';
    owner.resizeBuffer(id, 3, 2) catch |err| {
        try testing.expectEqualDeep(before, try owner.bufferLeaseSnapshot(lease));
        try testing.expect(!owner.mutating);
        return err;
    };
    try testing.expectError(error.StaleLease, owner.bufferLeaseSnapshot(lease));
    try testing.expectEqual(@as(u32, 'A'), before.buffer.char[0]);
}

test "Context buffer allocation failures retain accepted storage and clean provisional owners" {
    try testing.checkAllAllocationFailures(testing.allocator, bufferAllocationFailures, .{});
}
