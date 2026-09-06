const std = @import("std");
const testing = std.testing;
const context = @import("../context.zig");
const session = @import("../session.zig");
const renderer = @import("../renderer.zig");
const ansi = @import("../ansi.zig");
const image = @import("../image.zig");
const gp = @import("../grapheme.zig");

test "Session painted snapshot copy replaces transparent cells and retains references" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const handle = try owner.createSession(.{});
    defer owner.cancelSession(handle) catch unreachable;
    try owner.attachSessionRenderer(handle, 8, 1, .{ .remote_mode = .remote, .forwarded_env = &.{} });
    _ = try owner.sceneCreateNode(handle, 0, 1);
    const value = try owner.getSession(handle);
    const frame = try owner.sceneFrameStep(handle, null, .{
        .background = .{ 0, 0, 0, 0 },
        .use_mouse = false,
        .excluded_hit_num = 0,
        .max_layout_rounds = 8,
        .max_host_requests = 64,
    });
    const source = value.renderer.?.getNextBuffer();
    const target = try owner.getBuffer(try owner.createBuffer(8, 1, .{}));
    const link = try owner.links.acquire("https://snapshot.example");
    defer owner.links.decref(link) catch unreachable;
    const fg = ansi.rgbColor(17, 34, 51, 128);
    const transparent = ansi.rgbColor(0, 0, 0, 0);
    try source.drawText("e\xcc\x81e\xcc\x81界", 0, 0, fg, null, ansi.TextAttributes.setLinkId(ansi.TextAttributes.BOLD, link));
    const grapheme = gp.graphemeIdFromChar(source.buffer.char[0]);
    target.clear(ansi.rgbColor(200, 100, 50, 255), 'X');

    for (0..2) |_| {
        try value.copySceneFrame(frame, target);
        try testing.expectEqualSlices(u32, source.buffer.char, target.buffer.char);
        try testing.expectEqualSlices(ansi.RGBA, source.buffer.fg, target.buffer.fg);
        try testing.expectEqualSlices(ansi.RGBA, source.buffer.bg, target.buffer.bg);
        try testing.expectEqualSlices(u32, source.buffer.attributes, target.buffer.attributes);
        try testing.expectEqual(@as(u32, 2), try owner.graphemes.getRefcount(grapheme));
        try testing.expectEqual(@as(u32, 3), try owner.links.getRefcount(link));
    }
    source.clear(transparent, null);
    var text: [64]u8 = undefined;
    try testing.expectEqualStrings("e\xcc\x81e\xcc\x81界    ", text[0..try target.writeResolvedChars(&text, false)]);
    try testing.expectEqual(@as(u32, 2), try owner.links.getRefcount(link));
    target.clear(transparent, null);
    try testing.expectError(error.InvalidId, owner.graphemes.getRefcount(grapheme));
    try testing.expectEqual(@as(u32, 1), try owner.links.getRefcount(link));
}

test "Session split output rejects pressure without mutating image snapshots" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const handle = try owner.createSession(.{ .chunk_size = 4096, .chunk_count = 2, .span_capacity = 2 });
    defer owner.cancelSession(handle) catch unreachable;
    try owner.attachSessionRenderer(handle, 8, 2, .{ .remote_mode = .remote, .forwarded_env = &.{} });
    const value = try owner.getSession(handle);
    const buffer_handle = try owner.createBuffer(8, 1, .{});
    const snapshot = try owner.getBuffer(buffer_handle);
    const decoded = try image.createFromRgba(testing.allocator, &.{ 255, 0, 0, 255 }, 1, 1, 4);
    defer decoded.deinit();
    const pixels = try owner.getImage(try owner.importImage(decoded));
    try testing.expect(try snapshot.drawImage(pixels, 1, 0, 0, 8, 1, 0, 0, 0, 0, 1, 1, .kitty));
    const before = snapshot.buffer.char[0..8].*;
    const refs = pixels.ref_count;
    const commits = [_]renderer.SplitSnapshot{.{ .snapshot = snapshot, .row_columns = 8 }};
    try value.write(&([_]u8{'x'} ** 8192));
    try testing.expectEqual(session.RenderStatus.skipped, try value.renderSplit(null, &commits, 5, true));
    try testing.expectEqualSlices(u32, &before, snapshot.buffer.char);
    try testing.expectEqual(@as(usize, 1), snapshot.image_placements.items.len);
    try testing.expectEqual(refs, pixels.ref_count);
    try testing.expectEqual(@as(u32, 0), value.renderer.?.splitScrollback.published_rows);
    var out: [8192]u8 = undefined;
    while (try owner.readOutput(handle, &out)) |ticket| try owner.completeOutput(handle, ticket, .written);
    try testing.expectEqual(session.RenderStatus.pending, try value.renderSplit(null, &commits, 5, true));
    try testing.expectEqualSlices(u32, &before, snapshot.buffer.char);
    try testing.expectEqual(refs, pixels.ref_count);
    while (try owner.readOutput(handle, &out)) |ticket| try owner.completeOutput(handle, ticket, .written);
    try testing.expectEqualSlices(u32, &before, snapshot.buffer.char);
    try testing.expect(value.renderer.?.splitScrollback.published_rows > 0);
}

test "Session snapshot-only output preserves footer cells and invalidates the next repaint" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const handle = try owner.createSession(.{});
    defer owner.cancelSession(handle) catch unreachable;
    try owner.attachSessionRenderer(handle, 8, 1, .{ .remote_mode = .remote, .forwarded_env = &.{} });
    const value = try owner.getSession(handle);
    const cli = value.renderer.?;
    try cli.getNextBuffer().drawTextChecked("footer", 0, 0, ansi.rgbColor(255, 255, 255, 255), null, 0);
    _ = try value.render(true);
    var out: [4096]u8 = undefined;
    while (try owner.readOutput(handle, &out)) |ticket| try owner.completeOutput(handle, ticket, .written);
    try testing.expect(!cli.force_full_repaint);
    const snapshot = try owner.getBuffer(try owner.createBuffer(8, 1, .{}));
    try snapshot.drawTextChecked("snapshot", 0, 0, ansi.rgbColor(255, 255, 255, 255), null, 0);
    const commits = [_]renderer.SplitSnapshot{.{ .snapshot = snapshot, .row_columns = 8 }};
    _ = try value.renderSplit(null, &commits, 5, false);
    while (try owner.readOutput(handle, &out)) |ticket| try owner.completeOutput(handle, ticket, .written);
    try testing.expectEqual(@as(u32, 'f'), cli.getCurrentBuffer().buffer.char[0]);
    try testing.expect(cli.force_full_repaint);
}

fn copyWithAllocationFailures(allocator: std.mem.Allocator, split: bool) !void {
    const owner = try context.Context.init(allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const handle = try owner.createSession(.{});
    defer owner.cancelSession(handle) catch unreachable;
    try owner.attachSessionRenderer(handle, 8, 1, .{ .remote_mode = .remote, .forwarded_env = &.{} });
    _ = try owner.sceneCreateNode(handle, 0, 1);
    const value = try owner.getSession(handle);
    const frame = try owner.sceneFrameStep(handle, null, .{
        .background = .{ 0, 0, 0, 255 },
        .use_mouse = false,
        .excluded_hit_num = 0,
        .max_layout_rounds = 8,
        .max_host_requests = 64,
    });
    const source = value.renderer.?.getNextBuffer();
    const link = try owner.links.acquire("https://example.com");
    defer owner.links.decref(link) catch unreachable;
    try source.drawTextChecked("e\xcc\x81", 0, 0, ansi.rgbColor(255, 255, 255, 255), null, 0);
    try source.storage.ensureTrackerCapacity(9, 9);
    var cell = source.get(0, 0).?;
    cell.attributes = ansi.TextAttributes.setLinkId(0, link);
    source.set(0, 0, cell);
    const target_handle = try owner.createBuffer(8, 1, .{});
    const target = try owner.getBuffer(target_handle);
    if (split) {
        try context.Context.drawContextBuffer(target, source, 0, 0, .{});
        const commits = [_]renderer.SplitSnapshot{.{ .snapshot = target, .row_columns = 8 }};
        if (try value.renderSplit(frame, &commits, 5, true) == .failed) return error.OutOfMemory;
    } else {
        try value.copySceneFrame(frame, target);
        try testing.expectEqual(source.buffer.char[0], target.buffer.char[0]);
        try testing.expectEqual(source.buffer.attributes[0], target.buffer.attributes[0]);
    }
}

test "Session painted snapshot copy returns allocation failures without leaking trackers" {
    try testing.checkAllAllocationFailures(testing.allocator, copyWithAllocationFailures, .{false});
}

test "Session split snapshot copy returns allocation failures without leaking trackers" {
    try testing.checkAllAllocationFailures(testing.allocator, copyWithAllocationFailures, .{true});
}
