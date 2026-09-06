const std = @import("std");
const testing = std.testing;
const context = @import("../context.zig");
const image = @import("../image.zig");
const scene = @import("../scene.zig");
const ansi = @import("../ansi.zig");
const grapheme = @import("../grapheme.zig");
const Fixture = @import("scene_fixture_test.zig").Fixture;

test "Context image import owns lazy PNG and rejects stale foreign and exhausted identities" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const foreign = try context.Context.init(testing.allocator, testing.io, .{});
    defer foreign.deinit() catch unreachable;
    const original = try image.createFromRgba(testing.allocator, &.{ 255, 0, 0, 255 }, 1, 1, 4);
    defer original.deinit();
    const encoded = try original.ensureEncodedPng();
    const lazy = try image.decode(testing.allocator, encoded, .{});
    const first = try owner.importImage(lazy);
    const copy = try owner.getImage(first);
    try testing.expectEqual(@as(usize, 0), copy.pixels.len);
    try testing.expect(copy.encoded_png.?.ptr != lazy.encoded_png.?.ptr);
    try testing.expectEqual(owner.objects.context_id, copy.owner_context_id);
    try testing.expectEqual(owner.io.userdata, copy.io.userdata);
    const render_id = copy.render_id;
    lazy.deinit();
    try testing.expectEqualSlices(u8, &.{ 255, 0, 0, 255 }, try copy.ensurePixels());
    try testing.expectError(error.WrongContext, foreign.getImage(first));
    const wrong_kind = try owner.createBuffer(1, 1, .{});
    try testing.expectError(error.WrongKind, owner.getImage(wrong_kind));
    try owner.destroy(first);
    const second = try owner.importImage(original);
    try testing.expectEqual(first.slot, second.slot);
    try testing.expect(first.generation != second.generation);
    try testing.expect((try owner.getImage(second)).render_id > render_id);
    try testing.expectError(error.StaleHandle, owner.getImage(first));
    owner.last_image_id = std.math.maxInt(u32);
    try testing.expectError(error.ObjectLimit, owner.importImage(original));
}

test "Context image failed imports and checked composition preserve accepted state" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const owner = try context.Context.init(failing.allocator(), testing.io, .{});
    defer owner.deinit() catch unreachable;
    const original = try image.createFromRgba(testing.allocator, &.{ 255, 0, 0, 255 }, 1, 1, 4);
    defer original.deinit();
    _ = try original.ensureEncodedPng();
    for (0..3) |offset| {
        const count = owner.objects.live_count;
        const id = owner.last_image_id;
        failing.fail_index = failing.alloc_index + offset;
        try testing.expectError(error.OutOfMemory, owner.importImage(original));
        failing.fail_index = std.math.maxInt(usize);
        try testing.expectEqual(count, owner.objects.live_count);
        try testing.expectEqual(id, owner.last_image_id);
        try testing.expect(!owner.mutating);
    }
    const imported = try owner.importImage(original);
    const pixels = try owner.getImage(imported);
    const source = try owner.createBuffer(3, 1, .{});
    const destination = try owner.createBuffer(3, 1, .{});
    try owner.clearBuffer(destination, ansi.rgbColor(0, 0, 0, 255));
    try testing.expect(try owner.drawBufferImage(source, null, imported, .{ .width = 3, .height = 1 }));
    const target = try owner.getBuffer(destination);
    const before = target.buffer.char[0..3].*;
    const refs = pixels.ref_count;
    for (0..2) |offset| {
        failing.fail_index = failing.alloc_index + offset;
        try testing.expectError(error.OutOfMemory, owner.drawBuffer(destination, null, .{ .operation = .compose, .source = source }, "", ""));
        failing.fail_index = std.math.maxInt(usize);
        try testing.expectEqualSlices(u32, &before, target.buffer.char);
        try testing.expectEqual(@as(usize, 0), target.image_placements.items.len);
        try testing.expectEqual(refs, pixels.ref_count);
    }
    try owner.drawBuffer(destination, null, .{ .operation = .compose, .source = source, .x = -1 }, "", "");
    try testing.expectEqual(@as(usize, 1), target.image_placements.items.len);
    try testing.expectEqual(@as(u32, 2), target.image_placements.items[0].width);
    try owner.destroy(imported);
    try owner.destroy(source);
    try testing.expectEqual(@as(u32, 1), pixels.ref_count);
    try owner.drawBufferText(destination, "X", 1, 0, ansi.rgbColor(255, 255, 255, 255), null, 0);
    try testing.expect(grapheme.isImageChar(target.buffer.char[0]));
    try testing.expectEqual(@as(u32, 'X'), target.buffer.char[1]);
    try target.materializeImageFallbacks();
    try testing.expectEqual(@as(usize, 0), target.image_placements.items.len);
    try testing.expect(!grapheme.isImageChar(target.buffer.char[0]));
    try owner.drawBuffer(destination, null, .{ .operation = .clear }, "", "");
}

const frame_options: scene.FrameOptions = .{
    .background = .{ 0, 0, 0, 255 },
    .use_mouse = true,
    .excluded_hit_num = 0,
    .max_layout_rounds = 8,
    .max_host_requests = 64,
};

fn imageNode(owner: *context.Context, session: context.Handle, root: context.Handle) !context.Handle {
    const node = try owner.sceneCreateNode(session, 8, 2);
    try owner.sceneSetStyle(node, 4, 0, 0, 1, 4, 1);
    try owner.sceneSetStyle(node, 4, 1, 0, 1, 4, 1);
    try owner.sceneSetPaint(node, .{ .translateX = 1, .translateY = 1 });
    try owner.sceneMoveNode(node, root, 0);
    return node;
}

test "Context image scene paints native fit cover fill and resolution with retained buffers" {
    for ([_]bool{ false, true }) |buffered| {
        const f = try Fixture.init(testing.allocator, 8, 6, .{ .output = .{} });
        defer f.deinit();
        const owner = f.owner;
        const node = try imageNode(owner, f.id, f.root);
        const rgba = [_]u8{ 255, 0, 0, 255 } ** 8;
        const original = try image.createFromRgba(testing.allocator, &rgba, 4, 2, 16);
        defer original.deinit();
        const imported = try owner.importImage(original);
        const retained = if (buffered) try owner.createBuffer(1, 1, .{ .respect_alpha = true }) else null;
        for ([_]image.Fit{ .fit, .cover, .fill }) |fit| {
            try owner.sceneSetImage(node, imported, fit, .kitty, retained);
            const frame = try owner.sceneFrameStep(f.id, null, frame_options);
            try testing.expectEqual(@as(u32, 0), frame.kind);
            const placements = f.cli.getNextBuffer().image_placements.items;
            try testing.expectEqual(@as(usize, 1), placements.len);
            try testing.expectEqual(@as(i32, 1), placements[0].x);
            try testing.expectEqual(@as(i32, if (fit == .fit) 2 else 1), placements[0].y);
            try testing.expectEqual(@as(u32, 4), placements[0].width);
            try testing.expectEqual(@as(u32, if (fit == .fit) 1 else 4), placements[0].height);
            try testing.expectEqual(@as(u32, if (fit == .cover) 1 else 4), placements[0].source_width);
            try testing.expectEqual(@as(u32, if (fit == .cover) 1 else 0), placements[0].source_x);
            if (retained) |id| {
                const local = try owner.getBuffer(id);
                try testing.expectEqual(@as(u32, 4), local.width);
                try testing.expectEqual(@as(i32, 0), local.image_placements.items[0].x);
            }
            try owner.sceneFrameCancel(f.id, frame.frame_id);
        }
        try owner.sessionSetImageResolution(f.id, 8, 6, 80, 60);
        try owner.sceneSetImage(node, imported, .fit, .sixel, retained);
        const frame = try owner.sceneFrameStep(f.id, null, frame_options);
        const placement = f.cli.getNextBuffer().image_placements.items[0];
        try testing.expectEqual(@as(u32, 4), placement.width);
        try testing.expectEqual(@as(u32, 2), placement.height);
        try testing.expectEqual(@as(u32, 40), placement.pixel_width);
        try testing.expectEqual(@as(u32, 20), placement.pixel_height);
        try owner.sceneFrameCancel(f.id, frame.frame_id);
        try owner.destroy(imported);
        if (retained) |id| try owner.destroy(id);
        const surviving = try owner.sceneFrameStep(f.id, null, frame_options);
        try testing.expectEqual(@as(usize, 1), f.cli.getNextBuffer().image_placements.items.len);
        try owner.sceneFrameCancel(f.id, surviving.frame_id);
        try owner.sceneSetImage(node, null, .fit, .auto, null);
        const empty = try owner.sceneFrameStep(f.id, null, frame_options);
        try testing.expectEqual(@as(usize, 0), f.cli.getNextBuffer().image_placements.items.len);
        try owner.sceneFrameCancel(f.id, empty.frame_id);
    }
}

test "Context image scene zero opacity preserves lower text with buffered and hooked paint" {
    for ([_]bool{ false, true }) |buffered| {
        for ([_]u32{ 0, 24 }) |hooks| {
            const f = try Fixture.init(testing.allocator, 8, 6, .{ .output = .{} });
            defer f.deinit();
            const owner = f.owner;
            const node = try imageNode(owner, f.id, f.root);
            const text = try owner.sceneCreateNode(f.id, 2, 3);
            for ([_]context.Handle{ text, node }) |child| {
                try owner.sceneSetStyle(child, 0, 6, 0, 0, 2, 0);
            }
            try owner.sceneSetText(text, "OK");
            try owner.sceneSetPaint(text, .{ .translateX = 1, .translateY = 1 });
            try owner.sceneMoveNode(text, f.root, 0);
            const original = try image.createFromRgba(testing.allocator, &.{ 255, 0, 0, 255 }, 1, 1, 4);
            defer original.deinit();
            const imported = try owner.importImage(original);
            const retained = if (buffered) try owner.createBuffer(4, 4, .{ .respect_alpha = true }) else null;
            try owner.sceneSetImage(node, imported, .fill, .blocks, retained);
            try owner.sceneSetPaint(node, .{ .translateX = 1, .translateY = 1, .opacity = 0 });
            if (hooks != 0) try owner.sceneSetHooks(node, hooks, 1, 4, 4);
            var frame = try owner.sceneFrameStep(f.id, null, frame_options);
            if (hooks != 0) {
                try testing.expectEqual(@as(u32, 4), frame.kind);
                frame = try owner.sceneFrameStep(f.id, frame, frame_options);
                try testing.expectEqual(@as(u32, 5), frame.kind);
                frame = try owner.sceneFrameStep(f.id, frame, frame_options);
            }
            try testing.expectEqual(@as(u32, 0), frame.kind);
            const target = f.cli.getNextBuffer();
            try testing.expectEqual(@as(u32, 'O'), target.get(1, 1).?.char);
            try testing.expectEqual(@as(u32, 'K'), target.get(2, 1).?.char);
            try testing.expectEqual(@as(usize, 0), target.image_placements.items.len);
        }
    }
}

test "Context image entered node destruction releases continuation ownership on cancel and completion" {
    for ([_]bool{ false, true }) |painted| {
        for ([_]bool{ false, true }) |cancelled| {
            const owner = try context.Context.init(testing.allocator, testing.io, .{});
            const session = try owner.createSession(.{});
            try owner.attachSessionRenderer(session, 8, 6, .{ .remote_mode = .remote });
            const root = try owner.sceneCreateNode(session, 0, 1);
            const node = try imageNode(owner, session, root);
            const original = try image.createFromRgba(testing.allocator, &.{ 255, 0, 0, 255 }, 1, 1, 4);
            defer original.deinit();
            const imported = try owner.importImage(original);
            const resource = try owner.getImage(imported);
            resource.retain();
            defer resource.deinit();
            const retained = try owner.createBuffer(4, 4, .{});
            try owner.sceneSetImage(node, imported, .fill, .kitty, retained);
            try owner.sceneSetHooks(node, 24, 1, 4, 4);
            var frame = try owner.sceneFrameStep(session, null, frame_options);
            if (painted) frame = try owner.sceneFrameStep(session, frame, frame_options);
            try owner.sceneDestroyNode(node);
            try owner.destroy(imported);
            try owner.destroy(retained);
            if (!cancelled) {
                while (frame.kind != 0) frame = try owner.sceneFrameStep(session, frame, frame_options);
            }
            try owner.sceneFrameCancel(session, frame.frame_id);
            try owner.deinit();
            try testing.expectEqual(@as(u32, 1), resource.ref_count);
        }
    }
}

test "Context image checked draw rejects invalid input and survives pending presentation" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const session = try owner.createSession(.{ .chunk_size = 4096 });
    defer owner.cancelSession(session) catch unreachable;
    try owner.attachSessionRenderer(session, 4, 2, .{ .remote_mode = .remote });
    _ = try owner.sceneCreateNode(session, 0, 1);
    const original = try image.createFromRgba(testing.allocator, &.{ 255, 0, 0, 255 }, 1, 1, 4);
    defer original.deinit();
    const imported = try owner.importImage(original);
    const frame = try owner.sceneFrameStep(session, null, frame_options);
    const target = (try owner.getSessionRenderer(session)).getNextBuffer();
    const before = target.buffer.char[0..8].*;
    var stale = frame;
    stale.frame_id += 1;
    try testing.expectError(error.StaleFrame, owner.drawBufferImage(session, stale, imported, .{ .width = 4, .height = 2 }));
    try testing.expectError(error.InvalidOptions, owner.drawBufferImage(session, frame, imported, .{ .width = 4, .height = 2, .source_width = 2 }));
    try testing.expectError(error.InvalidOptions, owner.drawBufferImage(session, frame, imported, .{ .width = 4, .height = 2, .source_y = std.math.maxInt(u32) }));
    try testing.expect(!try owner.drawBufferImage(session, frame, imported, .{ .width = 0, .height = 2 }));
    try testing.expect(!try owner.drawBufferImage(session, frame, imported, .{ .x = std.math.minInt(i32), .width = 4, .height = 2 }));
    try testing.expectEqualSlices(u32, &before, target.buffer.char);
    try testing.expect(try owner.drawBufferImage(session, frame, imported, .{ .width = 4, .height = 2, .protocol = .kitty }));
    const resource = try owner.getImage(imported);
    resource.retain();
    defer resource.deinit();
    const lease = try owner.sceneFrameAcquireBufferLease(session, frame, .next);
    try owner.destroy(imported);
    try testing.expectEqual(@as(u32, 2), resource.ref_count);
    try owner.releaseBufferLease(lease);
    try testing.expectEqual(.pending, try owner.sceneFrameCommit(session, frame, true));
    try testing.expectEqual(@as(u32, 2), resource.ref_count);
    var output: [8192]u8 = undefined;
    const ticket = (try owner.readOutput(session, &output)).?;
    try testing.expect(std.mem.find(u8, output[0..ticket.len], "a=t") != null);
    try owner.completeOutput(session, ticket, .written);
    try testing.expectEqual(@as(u32, 2), resource.ref_count);
}

test "Context image placement capacity is charged to checked leases and retired on resize" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const original = try image.createFromRgba(testing.allocator, &.{ 255, 0, 0, 255 }, 1, 1, 4);
    defer original.deinit();
    const imported = try owner.importImage(original);
    const resource = try owner.getImage(imported);
    const handle = try owner.createBuffer(1, 1, .{});
    const lease = try owner.acquireOwnedBufferLease(handle);
    const charged = owner.lease_bytes;
    owner.lease_bytes_max = charged;
    try testing.expectError(error.OutOfMemory, owner.drawBufferImage(handle, null, imported, .{ .width = 1, .height = 1 }));
    try testing.expectEqual(charged, owner.lease_bytes);
    try testing.expectEqual(@as(u32, 1), resource.ref_count);
    owner.lease_bytes_max += 4096;
    try testing.expect(try owner.drawBufferImage(handle, null, imported, .{ .width = 1, .height = 1 }));
    try testing.expect(owner.lease_bytes > charged);
    try owner.resizeBuffer(handle, 2, 1);
    try testing.expectError(error.StaleLease, owner.bufferLeaseSnapshot(lease));
    try testing.expectEqual(@as(u32, 2), resource.ref_count);
    try owner.releaseBufferLease(lease);
    try testing.expectEqual(@as(u64, 0), owner.lease_bytes);
    try testing.expectEqual(@as(u32, 1), resource.ref_count);
}

test "Context image transparent grid occludes image cells only and respects zero opacity" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const original = try image.createFromRgba(testing.allocator, &.{ 255, 0, 0, 255 }, 1, 1, 4);
    defer original.deinit();
    const imported = try owner.importImage(original);
    const handle = try owner.createBuffer(3, 3, .{});
    const target = try owner.getBuffer(handle);
    try owner.clearBuffer(handle, ansi.rgbColor(0, 0, 0, 255));
    try owner.drawBufferText(handle, "X", 1, 0, ansi.rgbColor(255, 255, 255, 255), null, 0);
    try testing.expect(try owner.drawBufferImage(handle, null, imported, .{ .width = 1, .height = 1 }));
    const grid: context.BufferGrid = .{
        .border_chars = .{ '+', '+', '+', '+', '-', '|', '+', '+', '+', '+', '+' },
        .foreground = ansi.rgbColor(0, 255, 0, 0),
        .background = ansi.rgbColor(0, 0, 255, 0),
        .draw_inner = true,
        .draw_outer = true,
    };
    const before = target.buffer.char[0..9].*;
    try target.pushOpacity(0);
    try owner.drawGrid(handle, null, grid, &.{ 0, 2 }, &.{ 0, 2 });
    target.popOpacity();
    try testing.expectEqualSlices(u32, &before, target.buffer.char);
    try owner.drawGrid(handle, null, grid, &.{ 0, 2 }, &.{ 0, 2 });
    try target.materializeImageFallbacks();
    try testing.expectEqual(@as(u32, '+'), target.get(0, 0).?.char);
    try testing.expectEqual(ansi.rgbColor(0, 0, 255, 255), target.get(0, 0).?.bg);
    try testing.expectEqual(@as(u32, 'X'), target.get(1, 0).?.char);
    try testing.expectEqual(ansi.rgbColor(0, 0, 0, 255), target.get(1, 0).?.bg);
}

test "Context image compose and grayscale overlays ignore unrelated glyph and link tracking" {
    for ([_]bool{ false, true }) |grayscale| {
        for (0..3) |unrelated| {
            const owner = try context.Context.init(testing.allocator, testing.io, .{});
            defer owner.deinit() catch unreachable;
            const original = try image.createFromRgba(testing.allocator, &.{ 255, 0, 0, 255 }, 1, 1, 4);
            defer original.deinit();
            const imported = try owner.importImage(original);
            const handle = try owner.createBuffer(6, 2, .{});
            const target = try owner.getBuffer(handle);
            const blue = ansi.rgbColor(0, 0, 255, 128);
            const white = ansi.rgbColor(255, 255, 255, 255);
            try owner.clearBuffer(handle, ansi.rgbColor(0, 0, 0, 255));
            try testing.expect(try owner.drawBufferImage(handle, null, imported, .{ .width = 1, .height = 1 }));
            if (unrelated == 1) try owner.drawBufferText(handle, "\u{754c}", 3, 1, white, null, 0);
            if (unrelated == 2) {
                const id = try owner.links.alloc("https://example.test/unrelated");
                target.set(3, 1, .{ .char = 'L', .fg = white, .bg = blue, .attributes = ansi.TextAttributes.setLinkId(0, id) });
            }
            if (grayscale) {
                try owner.drawGrayscaleBuffer(handle, null, &.{1}, 0, 0, 1, 1, white, blue, false);
            } else {
                const source = try owner.createBuffer(1, 1, .{ .respect_alpha = true });
                try owner.drawBuffer(source, null, .{ .operation = .cell, .char = ' ', .foreground = white, .background = blue }, "", "");
                try owner.drawBuffer(handle, null, .{ .operation = .compose, .source = source }, "", "");
            }
            try target.materializeImageFallbacks();
            try testing.expectEqual(ansi.rgbColor(0, 0, 255, 255), target.get(0, 0).?.bg);
            try testing.expectEqual(white, target.get(0, 0).?.fg);
            try testing.expectEqual(@as(u32, if (grayscale) '$' else ' '), target.get(0, 0).?.char);
        }
    }
}

test "Context image custom self keeps native clearing and composition across hook changes" {
    for ([_]bool{ false, true }) |destroyed| {
        const f = try Fixture.init(testing.allocator, 8, 6, .{ .output = .{} });
        defer f.deinit();
        const owner = f.owner;
        const node = try imageNode(owner, f.id, f.root);
        const original = try image.createFromRgba(testing.allocator, &.{ 255, 0, 0, 255 }, 1, 1, 4);
        defer original.deinit();
        const imported = try owner.importImage(original);
        const retained = try owner.createBuffer(4, 4, .{});
        try owner.drawBufferText(retained, "P", 0, 0, ansi.rgbColor(255, 255, 255, 255), null, 0);
        try owner.sceneSetImage(node, imported, .fill, .kitty, retained);
        try owner.sceneSetHooks(node, 32, 1, 4, 4);
        const body = try owner.sceneFrameStep(f.id, null, frame_options);
        try testing.expectEqual(@as(u32, 7), body.kind);
        try testing.expectEqual(@as(u32, ' '), (try owner.getBuffer(retained)).get(0, 0).?.char);
        try testing.expect(try owner.drawBufferImage(retained, null, imported, .{ .width = 4, .height = 4 }));
        try owner.sceneSetHooks(node, 0, 2, 4, 4);
        if (destroyed) try owner.sceneDestroyNode(node);
        const done = try owner.sceneFrameStep(f.id, body, frame_options);
        try testing.expectEqual(@as(u32, 0), done.kind);
        try testing.expectEqual(@as(usize, 1), f.cli.getNextBuffer().image_placements.items.len);
        try owner.sceneFrameCancel(f.id, done.frame_id);
    }
}
