const std = @import("std");
const testing = std.testing;
const context = @import("../context.zig");
const image = @import("../image.zig");
const scene = @import("../scene.zig");
const ansi = @import("../ansi.zig");
const grapheme = @import("../grapheme.zig");

test "Context checked image failed creation leaves capacity identities and admission intact" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const owner = try context.Context.init(failing.allocator(), testing.io, .{ .object_capacity = 1 });
    defer owner.deinit() catch unreachable;
    const pixels = [_]u8{ 1, 2, 3, 255 };
    for (0..2) |offset| {
        failing.fail_index = failing.alloc_index + offset;
        try testing.expectError(error.OutOfMemory, owner.createImagePixels(&pixels, 1, 1, .{ .stride = 4 }));
        failing.fail_index = std.math.maxInt(usize);
        try testing.expectEqual(@as(u32, 0), owner.objects.live_count);
        try testing.expectEqual(@as(u32, 0), owner.last_image_id);
        try testing.expect(!owner.mutating);
    }
    try testing.expectError(error.InvalidArgument, owner.createImagePixels(&pixels, 2, 1, .{ .stride = 4 }));
    try testing.expectError(error.UnsupportedFormat, owner.decodeImage("not an image"));
    const handle = try owner.createImagePixels(&pixels, 1, 1, .{ .stride = 4 });
    try testing.expectError(error.ObjectLimit, owner.retainImage(handle));
    try testing.expectEqual(@as(u32, 1), (try owner.raw().getImage(handle)).ref_count);
    try testing.expectError(error.ObjectLimit, owner.takeImagePixels(handle));
    try owner.destroy(handle);
    owner.last_image_id = std.math.maxInt(u32);
    try testing.expectError(error.ObjectLimit, owner.createImagePixels(&pixels, 1, 1, .{ .stride = 4 }));
}

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
    const copy = try owner.raw().getImage(first);
    try testing.expectEqual(@as(usize, 0), copy.pixels.len);
    try testing.expect(copy.encoded_png.?.ptr != lazy.encoded_png.?.ptr);
    try testing.expectEqual(owner.objects.context_id, copy.owner_context_id);
    try testing.expectEqual(owner.io.userdata, copy.io.userdata);
    const render_id = copy.render_id;
    lazy.deinit();
    try testing.expectEqualSlices(u8, &.{ 255, 0, 0, 255 }, try copy.ensurePixels());
    try testing.expectError(error.WrongContext, foreign.raw().getImage(first));
    const wrong_kind = try owner.createBuffer(1, 1, .{});
    try testing.expectError(error.WrongKind, owner.raw().getImage(wrong_kind));
    try owner.destroy(first);
    const second = try owner.importImage(original);
    try testing.expectEqual(first.slot, second.slot);
    try testing.expect(first.generation != second.generation);
    try testing.expect((try owner.raw().getImage(second)).render_id > render_id);
    try testing.expectError(error.StaleHandle, owner.raw().getImage(first));
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
    const pixels = try owner.raw().getImage(imported);
    const source = try owner.createBuffer(3, 1, .{});
    const destination = try owner.createBuffer(3, 1, .{});
    try owner.clearBuffer(destination, ansi.rgbColor(0, 0, 0, 255));
    try testing.expect(try owner.drawBufferImage(source, null, imported, .{ .width = 3, .height = 1 }));
    const target = try owner.raw().getBuffer(destination);
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
    const target = (try owner.raw().getSessionRenderer(session)).getNextBuffer();
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
    const resource = try owner.raw().getImage(imported);
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
