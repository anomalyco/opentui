const std = @import("std");
const builtin = @import("builtin");
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
    const value = try owner.raw().getSession(handle);
    const frame = try owner.sceneFrameStep(handle, null, .{
        .background = .{ 0, 0, 0, 0 },
        .use_mouse = false,
        .excluded_hit_num = 0,
        .max_layout_rounds = 8,
        .max_host_requests = 64,
    });
    const source = value.renderer.?.getNextBuffer();
    const target = try owner.raw().getBuffer(try owner.createBuffer(8, 1, .{}));
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
    const value = try owner.raw().getSession(handle);
    const buffer_handle = try owner.createBuffer(8, 1, .{});
    const snapshot = try owner.raw().getBuffer(buffer_handle);
    const decoded = try image.createFromRgba(testing.allocator, &.{ 255, 0, 0, 255 }, 1, 1, 4);
    defer decoded.deinit();
    const pixels = try owner.raw().getImage(try owner.importImage(decoded));
    try testing.expect(try snapshot.drawImage(pixels, 1, 0, 0, 8, 1, 0, 0, 0, 0, 1, 1, .kitty));
    const before = snapshot.buffer.char[0..8].*;
    const refs = pixels.ref_count;
    const commits = [_]renderer.SplitSnapshot{.{ .snapshot = snapshot, .row_columns = 8 }};
    try value.write(&@as([8192]u8, @splat('x')));
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

test "Session pending split frame keeps its Kitty history image IDs from a file probe" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const handle = try owner.createSession(.{ .chunk_size = 4096, .chunk_count = 4, .span_capacity = 4 });
    defer owner.cancelSession(handle) catch unreachable;
    try owner.attachSessionRenderer(handle, 4, 3, .{ .forwarded_env = &.{} });
    const value = try owner.raw().getSession(handle);
    const cli = value.renderer.?;
    cli.terminal.processCapabilityResponse("\x1b_Gi=31337;OK\x1b\\");
    const snapshot = try owner.raw().getBuffer(try owner.createBuffer(2, 1, .{}));
    const decoded = try image.createFromRgba(testing.allocator, &.{ 255, 0, 0, 255 }, 1, 1, 4);
    defer decoded.deinit();
    const pixels = try owner.raw().getImage(try owner.importImage(decoded));
    for (0..2) |x| try testing.expect(try snapshot.drawImage(pixels, 1, @intCast(x), 0, 1, 1, 0, 0, 0, 0, 1, 1, .auto));
    _ = try value.splitControl(.{ .reset = .{ .seed_rows = 2, .pinned_render_offset = 2 } });
    const commits = [_]renderer.SplitSnapshot{.{ .snapshot = snapshot, .row_columns = 2 }};
    try testing.expectEqual(session.RenderStatus.pending, try value.renderSplit(null, &commits, 2, true));
    const frame_end = value.frame_end_offset.?;

    cli.kittyTransport.mode = .file;
    cli.startKittyFileProbeFromSession();
    try testing.expectEqual(.probing, cli.kittyTransport.file_state);
    const probe_ids = [_]u32{ cli.kittyTransport.query_id, cli.kittyTransport.upload_probe_id };
    var out: [16384]u8 = undefined;
    var len: usize = 0;
    while (try owner.readOutput(handle, out[len..])) |ticket| {
        len += ticket.len;
        try owner.completeOutput(handle, ticket, .written);
    }
    var frame = out[0..frame_end];
    var frame_ids: usize = 0;
    while (std.mem.find(u8, frame, ",i=")) |at| : (frame_ids += 1) {
        frame = frame[at + 3 ..];
        const end = std.mem.indexOfAny(u8, frame, ",;\x1b").?;
        const id = try std.fmt.parseInt(u32, frame[0..end], 10);
        for (probe_ids) |probe_id| try testing.expect(id != probe_id);
    }
    try testing.expect(frame_ids >= 2);
    // Completion publishes the frame without returning the probe's IDs.
    try testing.expect(cli.kittyHistoryNextImageId.? > probe_ids[1]);
}

test "Session snapshot-only output preserves footer cells and invalidates the next repaint" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const handle = try owner.createSession(.{});
    defer owner.cancelSession(handle) catch unreachable;
    try owner.attachSessionRenderer(handle, 8, 1, .{ .remote_mode = .remote, .forwarded_env = &.{} });
    const value = try owner.raw().getSession(handle);
    const cli = value.renderer.?;
    try cli.getNextBuffer().drawTextChecked("footer", 0, 0, ansi.rgbColor(255, 255, 255, 255), null, 0);
    _ = try value.render(true);
    var out: [4096]u8 = undefined;
    while (try owner.readOutput(handle, &out)) |ticket| try owner.completeOutput(handle, ticket, .written);
    try testing.expect(!cli.force_full_repaint);
    const snapshot = try owner.raw().getBuffer(try owner.createBuffer(8, 1, .{}));
    try snapshot.drawTextChecked("snapshot", 0, 0, ansi.rgbColor(255, 255, 255, 255), null, 0);
    const commits = [_]renderer.SplitSnapshot{.{ .snapshot = snapshot, .row_columns = 8 }};
    _ = try value.renderSplit(null, &commits, 5, false);
    while (try owner.readOutput(handle, &out)) |ticket| try owner.completeOutput(handle, ticket, .written);
    try testing.expectEqual(@as(u32, 'f'), cli.getCurrentBuffer().buffer.char[0]);
    try testing.expect(cli.force_full_repaint);
}

test "Session screen changes write mode packets only for an active terminal" {
    const Fixture = @import("session-terminal_test.zig").Fixture;
    const push = std.fmt.comptimePrint(ansi.ANSI.csiUPush, .{5});
    const Case = struct {
        phase: session.TerminalPhase,
        alternate: bool,
        kitty: bool = false,
        pending_frame: bool = false,
        trailing: usize = 4,
        result: ?anyerror = null,
        packet: []const u8 = "",
    };
    const cases = [_]Case{
        .{ .phase = .uninitialized, .alternate = true },
        .{ .phase = .uninitialized, .alternate = true, .pending_frame = true, .result = error.PresentationPending },
        .{ .phase = .setting_up, .alternate = false, .result = error.TerminalInactive },
        .{ .phase = .active, .alternate = true },
        .{ .phase = .active, .alternate = false, .packet = ansi.ANSI.switchToMainScreen },
        .{ .phase = .active, .alternate = false, .kitty = true, .packet = ansi.ANSI.csiUPop ++ ansi.ANSI.switchToMainScreen ++ push },
        .{ .phase = .active, .alternate = false, .trailing = session.control_packet_bytes_max, .result = error.InvalidOptions },
        .{ .phase = .suspended, .alternate = false },
    };
    const trailing: [session.control_packet_bytes_max]u8 = @splat('t');
    for (cases) |case| {
        const f = try Fixture.init(testing.allocator, testing.io, 4, 2);
        defer f.deinit();
        var bytes: [16 * 1024]u8 = undefined;
        var now: u64 = 0;
        if (case.phase != .uninitialized) try f.owner.setupSessionTerminal(f.id, .{});
        if (case.phase == .active or case.phase == .suspended) try f.drive(&now, .active);
        if (case.phase == .suspended) {
            try f.owner.suspendSession(f.id);
            try f.drive(&now, .suspended);
        }
        if (case.kitty) {
            f.cli.terminal.state.kitty_keyboard = true;
            f.cli.terminal.state.kitty_keyboard_flags = 5;
        }
        if (case.pending_frame) {
            try f.cli.getNextBuffer().drawTextChecked("x", 0, 0, ansi.rgbColor(255, 255, 255, 255), null, 0);
            try testing.expectEqual(session.RenderStatus.pending, try f.value.render(true));
        }
        const before = f.snapshot();
        const alternate_before = f.cli.useAlternateScreen;
        const result = f.value.setScreen(case.alternate, 6, 3, trailing[0..case.trailing]);
        if (case.result) |expected| {
            try testing.expectError(expected, result);
            try testing.expectEqualDeep(before, f.snapshot());
            try testing.expectEqual(alternate_before, f.cli.useAlternateScreen);
            try testing.expectEqual(@as(u32, 4), f.cli.width);
            continue;
        }
        try result;
        const output = try f.drain(&bytes);
        try testing.expectEqualStrings(case.packet, output[0..case.packet.len]);
        try testing.expectEqualStrings(trailing[0..case.trailing], output[case.packet.len..]);
        try testing.expectEqual(@as(u32, 6), f.cli.width);
        try testing.expectEqual(@as(u32, 3), f.cli.height);
        try testing.expectEqual(case.alternate, f.cli.useAlternateScreen);
        try testing.expect(f.cli.force_full_repaint and f.cli.imageScreenInvalidated);
        try testing.expectEqual(case.kitty, f.cli.terminal.state.kitty_keyboard);
        if (case.packet.len != 0) try testing.expectEqual(case.alternate, f.cli.terminal.state.alt_screen);
    }
}

test "Session detached sync copies parent terminal capabilities only into an idle child" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    var handles: [3]context.Handle = undefined;
    for (&handles) |*handle| handle.* = try owner.createSession(.{});
    defer for (handles) |handle| owner.cancelSession(handle) catch unreachable;
    for (handles[0..2]) |handle| try owner.attachSessionRenderer(handle, 4, 2, .{ .forwarded_env = &.{} });
    const parent = try owner.raw().getSession(handles[0]);
    const child = try owner.raw().getSession(handles[1]);
    const bare = try owner.raw().getSession(handles[2]);
    const other = try context.Context.init(testing.allocator, testing.io, .{});
    defer other.deinit() catch unreachable;
    const foreign_handle = try other.createSession(.{});
    defer other.cancelSession(foreign_handle) catch unreachable;
    const foreign = try other.raw().getSession(foreign_handle);

    const source = parent.renderer.?;
    source.terminal.caps.kitty_graphics = true;
    source.terminal.caps.unicode = .unicode;
    source.terminal.image_protocol = .kitty;
    source.image_resolution = .{ .terminal_width = 4, .terminal_height = 2, .pixel_width = 40, .pixel_height = 40 };
    try testing.expectError(error.InvalidOptions, child.syncDetached(child));
    try testing.expectError(error.WrongContext, child.syncDetached(foreign));
    try testing.expectError(error.RendererNotAttached, child.syncDetached(bare));
    try testing.expectError(error.RendererNotAttached, bare.syncDetached(parent));
    try child.renderer.?.getNextBuffer().drawTextChecked("x", 0, 0, ansi.rgbColor(255, 255, 255, 255), null, 0);
    try testing.expectEqual(session.RenderStatus.pending, try child.render(true));
    try testing.expectError(error.InvalidOptions, child.syncDetached(parent));
    try testing.expect(!child.renderer.?.terminal.caps.kitty_graphics);
    var out: [256]u8 = undefined;
    while (try owner.readOutput(handles[1], &out)) |ticket| try owner.completeOutput(handles[1], ticket, .written);

    try child.syncDetached(parent);
    const target = child.renderer.?;
    try testing.expectEqualDeep(source.terminal.caps, target.terminal.caps);
    try testing.expectEqual(.kitty, target.terminal.image_protocol);
    try testing.expectEqualDeep(source.image_resolution, target.image_resolution);
    try testing.expectEqual(.unicode, target.getNextBuffer().width_method);
}

fn copyWithAllocationFailures(allocator: std.mem.Allocator, split: bool) !void {
    const owner = try context.Context.init(allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const handle = try owner.createSession(.{});
    defer owner.cancelSession(handle) catch unreachable;
    try owner.attachSessionRenderer(handle, 8, 1, .{ .remote_mode = .remote, .forwarded_env = &.{} });
    _ = try owner.sceneCreateNode(handle, 0, 1);
    const value = try owner.raw().getSession(handle);
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
    const target = try owner.raw().getBuffer(target_handle);
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
