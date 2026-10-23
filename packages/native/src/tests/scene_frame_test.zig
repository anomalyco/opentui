const std = @import("std");
const testing = std.testing;
const Fixture = @import("scene_fixture_test.zig").Fixture;
const context = @import("../context.zig");
const scene = @import("../scene.zig");
const c = @import("context_abi_c");
const transport: @import("../session.zig").Options = .{ .chunk_size = 4096, .control_capacity = 4096 };

const options: scene.FrameOptions = .{
    .background = .{ 0, 0, 0, 255 },
    .use_mouse = true,
    .excluded_hit_num = 0,
    .max_layout_rounds = 8,
    .max_host_requests = 64,
};

fn setup(owner: *context.Context) !context.Handle {
    const id = try owner.createSession(transport);
    try owner.attachSessionRenderer(id, 4, 1, .{ .remote_mode = .remote });
    _ = try owner.sceneCreateNode(id, 0, 1);
    return id;
}

fn drain(owner: *context.Context, id: context.Handle) !void {
    var bytes: [4096]u8 = undefined;
    for (0..32) |_| {
        const ticket = try owner.readOutput(id, &bytes) orelse return;
        try owner.completeOutput(id, ticket, .written);
    }
    return error.TestUnexpectedResult;
}

test "Scene frame authority checks every field in layout update record and paint phases" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const peer = try context.Context.init(testing.allocator, testing.io, .{});
    defer peer.deinit() catch unreachable;
    const id = try setup(owner);
    const other = try setup(owner);
    const foreign = try setup(peer);
    const state = (try owner.raw().getSession(id)).scene.?;
    const root = state.root.?.scene_node.?.handle;
    try owner.sceneSetHooks(root, 5, 1, 4, 1);
    for (0..2) |index| {
        const child = try owner.sceneCreateNode(id, 1, @intCast(index + 2));
        try owner.sceneSetStyle(child, 4, 0, 0, 1, 1, 1);
        try owner.sceneSetStyle(child, 4, 1, 0, 1, 1, 1);
        try owner.sceneMoveNode(child, root, @intCast(index));
        if (index == 0) try owner.sceneSetHooks(child, 59, 1, 0, 0);
    }
    var seen = [_]bool{false} ** 5;
    var previous: ?scene.FrameRequest = null;
    for (0..128) |_| {
        const recording: ?[]const u8 = if (previous != null and previous.?.kind == c.OT_SCENE_FRAME_RECORD) &.{} else null;
        const request = try owner.sceneFrameStepWithRecording(id, previous, options, recording);
        seen[request.kind] = true;
        try testing.expectError(error.WrongSession, owner.sceneFrameAcquireBufferLease(other, request, .next));
        try testing.expectError(error.WrongContext, peer.sceneFrameAcquireBufferLease(foreign, request, .next));
        try testing.expectError(error.WrongContext, peer.sceneFrameCommit(foreign, request, true));
        inline for (std.meta.fields(scene.FrameRequest)) |field| {
            var forged = request;
            if (field.type == context.Handle) {
                @field(forged, field.name).generation += 1;
            } else {
                @field(forged, field.name) += 1;
            }
            const expected = if (comptime std.mem.eql(u8, field.name, "session")) error.WrongSession else error.StaleFrame;
            try testing.expectError(expected, owner.sceneFrameAcquireBufferLease(id, forged, .next));
            try testing.expectError(expected, owner.sceneFrameCommit(id, forged, true));
            try testing.expectError(expected, owner.sceneFrameStep(id, forged, options));
        }
        var wrong_context = request;
        wrong_context.session.context_id += 1;
        try testing.expectError(error.WrongContext, owner.sceneFrameStep(id, wrong_context, options));
        if (previous) |consumed| try testing.expectError(error.StaleFrame, owner.sceneFrameStep(id, consumed, options));
        if (request.kind == c.OT_SCENE_FRAME_DONE) {
            for ([_]context.RendererBuffer{ .current, .next }) |destination| {
                const lease = try owner.sceneFrameAcquireBufferLease(id, request, destination);
                _ = try owner.bufferLeaseSnapshot(lease);
                try owner.releaseBufferLease(lease);
            }
        } else try testing.expectError(error.StaleFrame, owner.sceneFrameAcquireBufferLease(id, request, .next));
        if (request.kind == 0) {
            try testing.expectError(error.FrameBusy, owner.renderSession(id, true));
            try testing.expectError(error.FrameBusy, owner.sceneFrameStep(id, null, options));
            _ = try owner.sceneFrameCommit(id, request, true);
            try testing.expectError(error.StaleFrame, owner.sceneFrameCommit(id, request, true));
            try drain(owner, id);
            break;
        }
        previous = request;
    } else return error.TestUnexpectedResult;
    for (seen) |visited| try testing.expect(visited);
}

test "Scene frame resize retires storage without replacing painted tickets" {
    const f = try Fixture.init(testing.allocator, 4, 1, .{});
    defer f.deinit();
    const frame = try f.step(null, options, 0, null);
    const lease = try f.owner.sceneFrameAcquireBufferLease(f.id, frame, .next);
    const before = try f.owner.bufferLeaseSnapshot(lease);
    before.buffer.char[0] = 'A';
    try f.owner.resizeSessionRenderer(f.id, 4, 1);
    try testing.expectEqualDeep(before, try f.owner.bufferLeaseSnapshot(lease));
    try f.owner.resizeSessionRenderer(f.id, 5, 1);
    try testing.expectError(error.StaleLease, f.owner.bufferLeaseSnapshot(lease));
    before.buffer.char[0] = 'Z';
    try testing.expectError(error.FrameBusy, f.owner.sceneFrameCommit(f.id, frame, true));
    const replacement = try f.owner.sceneFrameAcquireBufferLease(f.id, frame, .next);
    const after = try f.owner.bufferLeaseSnapshot(replacement);
    try testing.expectEqual(before.generation + 1, after.generation);
    try testing.expectEqual(@as(u32, 5), after.width);
    try testing.expectEqual(@as(u32, ' '), after.buffer.char[0]);
    after.buffer.char[4] = 'B';
    try f.owner.releaseBufferLease(lease);
    try f.owner.releaseBufferLease(replacement);
    _ = try f.owner.sceneFrameCommit(f.id, frame, true);
    try drain(f.owner, f.id);
    try testing.expectEqual(@as(u32, 'B'), f.cli.getCurrentBuffer().buffer.char[4]);
}

test "Scene frame record requests reject resize until the recording is submitted" {
    const f = try Fixture.init(testing.allocator, 4, 1, .{});
    defer f.deinit();
    _ = try hooked(f.owner, f.id);
    const request = try f.step(null, options, c.OT_SCENE_FRAME_RECORD, null);
    try testing.expectError(error.FrameBusy, f.owner.resizeSessionRenderer(f.id, 5, 1));
    try testing.expectError(error.StaleFrame, f.owner.sceneFrameAcquireBufferLease(f.id, request, .next));
    const done = try f.owner.sceneFrameStepWithRecording(f.id, request, options, &.{});
    try testing.expectEqual(@as(u32, c.OT_SCENE_FRAME_DONE), done.kind);
    try f.owner.sceneFrameCancel(f.id, done.frame_id);
}

test "Scene frame cancellation revokes painted authority but pins scratch cells until release" {
    for ([_]bool{ false, true }) |hooked_frame| {
        const f = try Fixture.init(testing.allocator, 4, 1, .{ .output = transport });
        defer f.deinit();
        const child = try f.owner.sceneCreateNode(f.id, 1, 2);
        try f.owner.sceneSetStyle(child, 4, 0, 0, 1, 1, 1);
        try f.owner.sceneMoveNode(child, f.root, 0);
        const first = try f.owner.sceneFrameStep(f.id, null, options);
        _ = try f.owner.sceneFrameCommit(f.id, first, true);
        try drain(f.owner, f.id);
        try testing.expectEqual(@as(u32, 2), try f.owner.sceneHitTest(f.id, 0, 0));
        try f.owner.sceneSetPaint(child, .{ .translateX = 1 });
        const pending = if (hooked_frame) try hooked(f.owner, f.id) else null;
        var frame = try f.step(null, options, if (hooked_frame) c.OT_SCENE_FRAME_RECORD else c.OT_SCENE_FRAME_DONE, null);
        if (hooked_frame) frame = try f.owner.sceneFrameStepWithRecording(f.id, frame, options, &.{});
        const lease = try f.owner.sceneFrameAcquireBufferLease(f.id, frame, .next);
        const snapshot = try f.owner.bufferLeaseSnapshot(lease);
        snapshot.buffer.char[0] = 'Z';
        if (pending) |node| try f.owner.sceneDestroyNode(node);
        _ = try f.owner.bufferLeaseSnapshot(lease);
        try f.owner.sceneFrameCancel(f.id, frame.frame_id);
        try testing.expectEqual(@as(u32, 2), try f.owner.sceneHitTest(f.id, 0, 0));
        try testing.expectEqual(@as(u32, 0), try f.owner.sceneHitTest(f.id, 1, 0));
        for ((try f.owner.raw().getSessionRenderer(f.id)).nextHitGrid) |hit| try testing.expectEqual(@as(u32, 0), hit);
        try testing.expectEqual(@as(usize, 0), f.cli.getNextBuffer().scissor_stack.items.len);
        try testing.expectEqual(@as(usize, 0), f.cli.getNextBuffer().opacity_stack.items.len);
        try testing.expectError(error.StaleLease, f.owner.bufferLeaseSnapshot(lease));
        try testing.expectError(error.StaleFrame, f.owner.sceneFrameCommit(f.id, frame, true));
        try testing.expectError(error.FrameBusy, f.owner.sceneFrameStep(f.id, null, options));
        try testing.expectError(error.FrameBusy, f.owner.scenePaint(f.id, options.background, true, 0));
        try testing.expectError(error.FrameBusy, f.owner.renderSession(f.id, true));
        try testing.expectError(error.ContextBusy, f.owner.destroy(f.id));
        try testing.expectEqual(@as(u32, 'Z'), snapshot.buffer.char[0]);
        try f.owner.releaseBufferLease(lease);
        const scratch = try f.owner.acquireSessionBufferLease(f.id, .next);
        try testing.expectEqual(@as(u32, 'Z'), (try f.owner.bufferLeaseSnapshot(scratch)).buffer.char[0]);
        try f.owner.releaseBufferLease(scratch);
        try testing.expectError(error.StaleFrame, f.owner.renderSession(f.id, true));
        const retained = try f.owner.createBuffer(4, 1, .{});
        try f.owner.drawBufferText(retained, "safe", 0, 0, .{ 255, 255, 255, 255 }, null, 0);
        const commits = [_]@import("../renderer.zig").SplitSnapshot{.{ .snapshot = try f.owner.raw().getBuffer(retained), .row_columns = 4 }};
        try testing.expectEqual(.pending, try (try f.owner.raw().getSession(f.id)).renderSplit(null, &commits, 0, true));
        var bytes: [4096]u8 = undefined;
        var length: usize = 0;
        while (try f.owner.readOutput(f.id, bytes[length..])) |ticket| {
            length += ticket.len;
            try f.owner.completeOutput(f.id, ticket, .written);
        }
        try testing.expect(std.mem.indexOf(u8, bytes[0..length], "safe") != null);
        try testing.expect(std.mem.indexOf(u8, bytes[0..length], "Z") == null);
        try testing.expectEqual(@as(u32, 2), try f.owner.sceneHitTest(f.id, 0, 0));
        try testing.expectError(error.StaleFrame, f.owner.renderSession(f.id, true));
        const retry = try f.owner.sceneFrameStep(f.id, null, options);
        try testing.expectEqual(@as(f64, 1), (try f.owner.sceneGetLayout(child, false)).screenX);
        const closing = try f.owner.sceneFrameAcquireBufferLease(f.id, retry, .next);
        try f.owner.beginSessionClose(f.id);
        try testing.expectError(error.StaleLease, f.owner.bufferLeaseSnapshot(closing));
        try testing.expectError(error.ContextBusy, f.owner.destroy(f.id));
        try f.owner.releaseBufferLease(closing);
        try f.owner.destroy(f.id);
        try testing.expectEqual(@as(u32, 0), f.owner.lease_count);
        try testing.expectEqual(@as(u64, 0), f.owner.lease_bytes);
    }
}

test "Scene frame paint layout reports where a hook-free frame painted a node moved by a hook" {
    const f = try Fixture.init(testing.allocator, 8, 1, .{ .output = transport });
    defer f.deinit();
    const child = try f.owner.sceneCreateNode(f.id, 1, 2);
    try f.owner.sceneSetStyle(child, 4, 0, 0, 1, 1, 1);
    try f.owner.sceneSetPaint(child, .{ .background = .{ 2, 0, 0, 255 } });
    try f.owner.sceneMoveNode(child, f.root, 0);
    try f.owner.sceneSetHooks(f.root, c.OT_SCENE_HOOK_UPDATE, 1, 8, 1);
    const update = try f.step(null, options, c.OT_SCENE_FRAME_UPDATE, f.root);
    try f.owner.scenePatchPaint(child, c.OT_SCENE_PROPERTY_TRANSLATE_X, .{ .translateX = 3 });
    const done = try f.step(update, options, c.OT_SCENE_FRAME_DONE, null);
    try testing.expectEqual(@as(u16, 2), f.cli.getNextBuffer().get(3, 0).?.bg[0]);
    try testing.expectEqual(@as(f64, 3), (try f.owner.sceneGetPaintLayout(child)).screenX);
    try f.owner.sceneFrameCancel(f.id, done.frame_id);
}

test "Scene painted node and root destruction retains graphemes but never resurrects hit identities" {
    const f = try Fixture.init(testing.allocator, 4, 1, .{ .output = transport });
    defer f.deinit();
    const text = try f.owner.sceneCreateNode(f.id, 2, 2);
    try f.owner.sceneSetText(text, "e\xcc\x81");
    try f.owner.sceneMoveNode(text, f.root, 0);
    const frame = try f.owner.sceneFrameStep(f.id, null, options);
    const lease = try f.owner.sceneFrameAcquireBufferLease(f.id, frame, .next);
    var bytes: [8]u8 = undefined;
    try f.owner.sceneDestroyNode(text);
    try f.owner.sceneDestroyNode(f.root);
    const snapshot = try f.owner.bufferLeaseSnapshot(lease);
    try testing.expectEqualStrings("e\xcc\x81   ", bytes[0..try snapshot.writeResolvedChars(&bytes, false)]);
    try f.owner.releaseBufferLease(lease);
    const later = try f.owner.sceneFrameAcquireBufferLease(f.id, frame, .next);
    try testing.expectEqualDeep(snapshot, try f.owner.bufferLeaseSnapshot(later));
    try f.owner.releaseBufferLease(later);
    _ = try f.owner.sceneFrameCommit(f.id, frame, true);
    try drain(f.owner, f.id);
    try testing.expectEqual(@as(u32, 0), try f.owner.sceneHitTest(f.id, 0, 0));
}

fn allocationFailures(allocator: std.mem.Allocator) !void {
    const f = try Fixture.init(allocator, 4, 1, .{ .output = transport });
    defer f.deinit();
    const frame = try f.owner.sceneFrameStep(f.id, null, options);
    const next = try f.owner.sceneFrameAcquireBufferLease(f.id, frame, .next);
    defer f.owner.releaseBufferLease(next) catch unreachable;
    const current = try f.owner.sceneFrameAcquireBufferLease(f.id, frame, .current);
    defer f.owner.releaseBufferLease(current) catch unreachable;
    try f.owner.resizeSessionRenderer(f.id, 8, 2);
    try f.owner.cancelSession(f.id);
}

test "Scene painted lease limits and failed initialization release all provisional ownership" {
    try testing.checkAllAllocationFailures(testing.allocator, allocationFailures, .{});
    for ([_]context.Options{
        .{ .object_capacity = 2 },
        .{ .lease_count_max = 0 },
        .{ .lease_bytes_max = 0 },
    }, [_]context.Error{ error.ObjectLimit, error.LeaseLimit, error.LeaseBytesLimit }) |limits, expected| {
        const f = try Fixture.init(testing.allocator, 4, 1, .{ .limits = limits, .output = transport });
        defer f.deinit();
        f.owner.objects.slot_count_max = limits.object_capacity;
        const frame = try f.owner.sceneFrameStep(f.id, null, options);
        try testing.expectError(expected, f.owner.sceneFrameAcquireBufferLease(f.id, frame, .next));
        try testing.expectEqual(@as(u32, 0), f.owner.lease_count);
        try testing.expectEqual(@as(u64, 0), f.owner.lease_bytes);
        _ = try f.owner.sceneFrameCommit(f.id, frame, true);
        try drain(f.owner, f.id);
    }
}

test "Scene painted commit admission rejection retains the draft for retry" {
    const f = try Fixture.init(testing.allocator, 4, 1, .{ .output = transport });
    defer f.deinit();
    const frame = try f.owner.sceneFrameStep(f.id, null, options);
    f.cli.splitBatchActive = true;
    try testing.expectError(error.SplitRenderPending, f.owner.sceneFrameCommit(f.id, frame, true));
    f.cli.splitBatchActive = false;
    try testing.expectError(error.FrameBusy, f.owner.renderSession(f.id, true));
    try testing.expectEqual(@as(u64, 0), (try f.owner.raw().getSession(f.id)).getStats().bytes_written);
    _ = try f.owner.sceneFrameCommit(f.id, frame, true);
    try drain(f.owner, f.id);
}

fn hooked(owner: *context.Context, id: context.Handle) !context.Handle {
    const root = (try owner.raw().getSession(id)).scene.?.root.?.scene_node.?.handle;
    const child = try owner.sceneCreateNode(id, 1, 2);
    try owner.sceneSetStyle(child, 4, 0, 0, 1, 1, 1);
    try owner.sceneSetHooks(child, 8 | 16, 1, 1, 1);
    try owner.sceneMoveNode(child, root, 0);
    return child;
}

test "Scene idle update metadata keeps the native one call path and excludes host counts" {
    const f = try Fixture.init(testing.allocator, 4, 1, .{ .output = transport });
    defer f.deinit();
    const child = try f.owner.sceneCreateNode(f.id, 1, 2);
    try f.owner.sceneMoveNode(child, f.root, 0);
    for ([_]context.Handle{ f.root, child }) |node| try f.owner.sceneSetHooks(node, 64, 1, 0, 0);
    try testing.expectEqual(@as(u32, 0), f.state.hook_count);
    try testing.expectEqual(@as(u32, 0), f.state.layout_hook_count);
    try testing.expectError(error.InvalidOptions, f.owner.sceneSetHooks(child, 65, 2, 0, 0));
    try testing.expectEqual(@as(u64, 1), (try f.owner.raw().getRenderable(child)).scene_node.?.hook_generation);
    const frame = try f.step(null, options, 0, null);
    try testing.expectEqual(@as(usize, 0), f.state.feedback.capacity);
    for ([_]context.Handle{ f.root, child }) |node| try testing.expectEqual(frame.frame_id, (try f.owner.raw().getRenderable(node)).scene_node.?.update_frame);
    try f.owner.sceneFrameCancel(f.id, frame.frame_id);
    _ = try f.owner.scenePaint(f.id, options.background, true, 0);
    try f.owner.sceneSetHooks(child, 64 | 8, 2, 0, 0);
    try testing.expectEqual(@as(u32, 1), f.state.hook_count);
    try testing.expectEqual(@as(u32, 0), f.state.layout_hook_count);
    try f.owner.sceneDestroyNode(child);
    try f.owner.sceneDestroyNode(f.root);
    try testing.expectEqual(@as(u32, 0), f.state.hook_count);
    try testing.expectEqual(@as(u32, 0), f.state.layout_hook_count);
}

const FrameWork = @import("../renderer.zig").FrameWork;

fn work(f: Fixture) !FrameWork {
    return (try f.owner.sceneGetStats(f.id)).frameWork;
}

/// Paints, commits, and drains one hook-free frame; returns the published work.
fn presentWork(f: Fixture, how: struct { use_mouse: bool = true, force: bool = false }) !FrameWork {
    const done = try f.owner.scenePaint(f.id, options.background, how.use_mouse, 0);
    _ = try f.owner.sceneFrameCommit(f.id, done, how.force);
    try drain(f.owner, f.id);
    const result = try work(f);
    try testing.expectEqual(done.frame_id, result.work_frame_id);
    return result;
}

/// The steady work of the two-member scene below.
fn plainWork(frame_id: u64, visits: u64, reads: u64, solves: u64, rows_compared: u64, rows_diffed: u64, reasons: u32) FrameWork {
    return .{
        .work_frame_id = frame_id,
        .candidate_visits = visits,
        .geometry_reads = reads,
        .yoga_solves = solves,
        .view_preparations = 3,
        .members_painted = 2,
        .member_cells = 10,
        .cells_cleared = 32,
        .hit_cells_written = 10,
        .hit_cells_cleared = 32,
        .hit_cells_compared = 16,
        .rows_compared = rows_compared,
        .rows_diffed = rows_diffed,
        .full_path_reasons = reasons,
        .layout_rounds = 1,
    };
}

test "Scene frame work counts each frame kind and publishes only presented scene frames" {
    const f = try Fixture.init(testing.allocator, 8, 2, .{});
    defer f.deinit();
    try testing.expectEqual(FrameWork{}, try work(f));
    const fill = try f.owner.sceneCreateNode(f.id, 1, 2);
    try f.owner.sceneSetStyle(fill, 4, 0, 0, 1, 2, 1);
    try f.owner.sceneSetStyle(fill, 4, 1, 0, 1, 1, 1);
    try f.owner.sceneSetPaint(fill, .{ .background = .{ 2, 0, 0, 255 } });
    try f.owner.sceneMoveNode(fill, f.root, 0);
    const text = try f.owner.sceneCreateNode(f.id, 2, 3);
    try f.owner.sceneSetText(text, "hi");
    try f.owner.sceneMoveNode(text, f.root, 1);
    // The forced first frame merges the scene's reason with the encoder's. Without the flag,
    // the next frame has no retained work to reuse; unchanged and paint-only frames reuse it.
    try f.owner.sceneSetDebugFlags(f.id, c.OT_SCENE_DEBUG_FULL_FRAME);
    try testing.expectEqual(plainWork(1, 3, 3, 1, 0, 2, FrameWork.full_path_forced | FrameWork.full_path_screen), try presentWork(f, .{}));
    try testing.expectEqual(plainWork(2, 3, 0, 0, 2, 0, FrameWork.full_path_forced), try presentWork(f, .{}));
    try f.owner.sceneSetDebugFlags(f.id, 0);
    try testing.expectEqual(plainWork(3, 3, 0, 0, 2, 0, 0), try presentWork(f, .{}));
    try testing.expectEqual(plainWork(4, 0, 0, 0, 2, 0, 0), try presentWork(f, .{}));
    try f.owner.scenePatchPaint(fill, c.OT_SCENE_PROPERTY_BACKGROUND, .{ .background = .{ 3, 0, 0, 255 } });
    try testing.expectEqual(plainWork(5, 0, 0, 0, 2, 1, 0), try presentWork(f, .{}));
    try f.owner.sceneSetText(text, "ho");
    try testing.expectEqual(plainWork(6, 3, 3, 1, 2, 1, 0), try presentWork(f, .{}));
    // A measurement outside the frame solves; the frame reads geometry without solving.
    try f.owner.sceneSetText(text, "hey");
    try f.owner.sceneMeasureLayout(f.id, f.root);
    try testing.expectEqual(plainWork(7, 3, 3, 0, 2, 1, 0), try presentWork(f, .{}));
    const presented = try work(f);
    // Cancelled drafts, skipped and non-scene renders, and snapshot-only splits publish nothing.
    try f.owner.scenePatchPaint(fill, c.OT_SCENE_PROPERTY_BACKGROUND, .{ .background = .{ 4, 0, 0, 255 } });
    const cancelled = try f.owner.scenePaint(f.id, options.background, true, 0);
    try f.owner.sceneFrameCancel(f.id, cancelled.frame_id);
    try testing.expectEqual(presented, try work(f));
    try f.owner.writeSession(f.id, &([_]u8{'x'} ** 8192));
    try testing.expectEqual(.skipped, try f.owner.sceneFrameCommit(f.id, try f.owner.scenePaint(f.id, options.background, true, 0), false));
    try testing.expectEqual(presented, try work(f));
    try drain(f.owner, f.id);
    _ = try f.owner.renderSession(f.id, false);
    try drain(f.owner, f.id);
    try testing.expectEqual(presented, try work(f));
    const session = try f.owner.raw().getSession(f.id);
    const retained = try f.owner.createBuffer(8, 1, .{});
    const commits = [_]@import("../renderer.zig").SplitSnapshot{.{ .snapshot = try f.owner.raw().getBuffer(retained), .row_columns = 8 }};
    _ = try session.renderSplit(null, &commits, 0, true);
    try drain(f.owner, f.id);
    try testing.expectEqual(presented, try work(f));
    // A split render that carries a scene frame publishes like a commit.
    const split = try f.owner.scenePaint(f.id, options.background, true, 0);
    _ = try session.renderSplit(split, &commits, 0, false);
    try drain(f.owner, f.id);
    // After the snapshot it encodes every row; a frame without mouse hits writes no hit cells.
    try testing.expectEqual(plainWork(split.frame_id, 0, 0, 0, 0, 2, FrameWork.full_path_screen), try work(f));
    var no_hits = plainWork(11, 0, 0, 0, 2, 0, 0);
    no_hits.hit_cells_written = 0;
    try testing.expectEqual(no_hits, try presentWork(f, .{ .use_mouse = false }));
    // A resize clears more cells and skips the hit-grid compare.
    try f.owner.resizeSessionRenderer(f.id, 8, 3);
    var resized = plainWork(12, 3, 3, 1, 1, 3, 0);
    resized.cells_cleared = 48;
    resized.hit_cells_cleared = 48;
    resized.hit_cells_compared = 0;
    try testing.expectEqual(resized, try presentWork(f, .{}));
    const pixels = [_]u8{ 200, 40, 0, 255 } ** 4;
    const picture = try f.owner.createImagePixels(&pixels, 2, 2, .{ .stride = 8 });
    const image_node = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_IMAGE, 4);
    try f.owner.sceneSetStyle(image_node, 4, 0, 0, 1, 2, 1);
    try f.owner.sceneSetStyle(image_node, 4, 1, 0, 1, 1, 1);
    try f.owner.sceneMoveNode(image_node, f.root, 2);
    // Image placements, even drawn as blocks, are a full-path reason, merged with a forced encode's.
    try f.owner.sceneSetImage(image_node, picture, .fit, .blocks, null);
    const reasons = (try presentWork(f, .{ .force = true })).full_path_reasons;
    try testing.expectEqual(FrameWork.full_path_screen | FrameWork.full_path_images, reasons);
    // A hook frame counts its host requests.
    try f.owner.sceneSetHooks(fill, c.OT_SCENE_HOOK_UPDATE, 1, 2, 1);
    const done = try f.step(try f.step(null, options, c.OT_SCENE_FRAME_UPDATE, fill), options, c.OT_SCENE_FRAME_DONE, null);
    _ = try f.owner.sceneFrameCommit(f.id, done, false);
    try drain(f.owner, f.id);
    try testing.expectEqual(@as(u32, 1), (try work(f)).host_requests);
    // A presentation that fails at completion publishes nothing and fails the Session.
    const published = try work(f);
    try f.owner.scenePatchPaint(fill, c.OT_SCENE_PROPERTY_BACKGROUND, .{ .background = .{ 5, 0, 0, 255 } });
    try testing.expectEqual(.pending, try f.owner.sceneFrameCommit(f.id, (try f.step(try f.step(null, options, c.OT_SCENE_FRAME_UPDATE, fill), options, c.OT_SCENE_FRAME_DONE, null)), false));
    var bytes: [4096]u8 = undefined;
    try f.owner.completeOutput(f.id, (try f.owner.readOutput(f.id, &bytes)).?, .failed);
    try testing.expectEqual(published, try work(f));
    try testing.expectError(error.SessionFailed, f.owner.sceneSetDebugFlags(f.id, 0));
    (try f.owner.raw().getSession(f.id)).cancel();
}

test "Scene frame work solves Yoga only for text writes that can change the measured size" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const label = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_TEXT, 2);
    try f.owner.sceneSetText(label, "ab");
    try f.owner.sceneMoveNode(label, f.root, 0);
    // The first buffer owns its style; the other two share `style`, so a styled write to one
    // republishes the style to both.
    const style = try f.owner.createSyntaxStyle();
    var texts: [3]context.Handle = undefined;
    var views: [3]context.Handle = undefined;
    for (&texts, &views, 0..) |*text, *view, index| {
        text.* = try f.owner.createTextBuffer(.unicode);
        try f.owner.textBufferSetText(text.*, "c\td");
        if (index > 0) try f.owner.textBufferSetSyntaxStyle(text.*, style);
        view.* = try f.owner.createTextBufferView(text.*);
        const node = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_TEXT_VIEW, @intCast(3 + index));
        try f.owner.sceneSetTextView(node, view.*);
        try f.owner.sceneMoveNode(node, f.root, @intCast(1 + index));
    }
    const red: context.StyledTextChunk = .{ .byte_count = 3, .foreground = .{ 1, 0, 0, 1 } };
    const Write = enum { none, scene_same, scene_styled_same, same, styled_same, batch_same, batch_new, defaults, highlight, shared_styled_same, syntax_style, scene_new, styled_new, tab_width, wrap_mode, clear, append, stale_slot };
    // `batch_new` and `scene_new` keep the byte count, so only the byte comparison sees the change.
    // After a clear or an append, the replacement slot still holds "c\tde" but the text does not.
    const rows = [_]struct { Write, u64 }{
        .{ .none, 0 },         .{ .scene_same, 0 }, .{ .scene_styled_same, 0 }, .{ .same, 0 },      .{ .styled_same, 0 },
        .{ .batch_same, 0 },   .{ .batch_new, 1 },  .{ .defaults, 0 },          .{ .highlight, 0 }, .{ .shared_styled_same, 0 },
        .{ .syntax_style, 0 }, .{ .scene_new, 1 },  .{ .styled_new, 1 },        .{ .tab_width, 1 }, .{ .wrap_mode, 1 },
        .{ .clear, 1 },        .{ .append, 1 },     .{ .stale_slot, 1 },        .{ .clear, 1 },     .{ .stale_slot, 1 },
    };
    _ = try presentWork(f, .{});
    var expected: [rows.len]u64 = undefined;
    var actual: [rows.len]u64 = undefined;
    for (rows, 0..) |row, index| {
        switch (row[0]) {
            .none => {},
            .scene_same => try f.owner.sceneSetText(label, "ab"),
            .scene_styled_same => try f.owner.sceneSetStyledText(label, "ab", &.{.{ .byte_count = 2, .foreground = .{ 1, 0, 0, 1 } }}),
            .same => try f.owner.textBufferSetText(texts[0], "c\td"),
            .styled_same => try f.owner.textBufferSetStyledText(texts[0], "c\td", &.{red}),
            .batch_same, .batch_new => {
                var info: [1]context.Context.TextReplacementInfo = undefined;
                const bytes = if (row[0] == .batch_same) "c\td" else "c\nd";
                try f.owner.textBufferReplaceStyledBatch(&.{.{ .buffer = texts[0], .view = views[0], .bytes = bytes, .chunks = &.{red} }}, &info);
            },
            .defaults => try f.owner.textBufferSetDefaults(texts[0], .{ .fields = .{ .foreground = true }, .foreground = .{ 0, 1, 0, 1 } }),
            .highlight => try f.owner.textBufferHighlight(texts[0], .{ .add_range = .{ .start = 0, .end = 1, .style_id = 1 } }),
            .shared_styled_same => try f.owner.textBufferSetStyledText(texts[1], "c\td", &.{red}),
            .syntax_style => try f.owner.textBufferSetSyntaxStyle(texts[0], style),
            .scene_new => try f.owner.sceneSetStyledText(label, "a\n", &.{.{ .byte_count = 2 }}),
            .styled_new => try f.owner.textBufferSetStyledText(texts[0], "c\tde", &.{.{ .byte_count = 4 }}),
            .tab_width => try f.owner.textBufferSetTabWidth(texts[0], 8),
            .wrap_mode => try f.owner.textViewCommand(views[0], .{ .wrap_mode = .char }),
            .clear => try f.owner.textBufferClear(texts[0], false),
            .append => try f.owner.textBufferAppend(texts[0], "wxyz"),
            .stale_slot => try f.owner.textBufferSetText(texts[0], "c\tde"),
        }
        expected[index] = row[1];
        actual[index] = (try presentWork(f, .{})).yoga_solves;
    }
    try testing.expectEqualSlices(u64, &expected, &actual);
}

test "Scene frame work counts viewport refresh and culling work" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const viewport = try f.owner.sceneCreateNode(f.id, 1, 2);
    try f.owner.sceneSetStyle(viewport, 4, 0, 0, 1, 4, 1);
    try f.owner.sceneSetStyle(viewport, 4, 1, 0, 1, 2, 1);
    try f.owner.sceneSetStyle(viewport, 0, c.OT_STYLE_ENUM_OVERFLOW, 0, 0, c.OT_OVERFLOW_HIDDEN, 0);
    try f.owner.sceneMoveNode(viewport, f.root, 0);
    const content = try f.owner.sceneCreateNode(f.id, 1, 3);
    try f.owner.sceneSetStyle(content, c.OT_STYLE_FLOAT, c.OT_STYLE_FLOAT_FLEX_SHRINK, 0, 0, 0, 0);
    try f.owner.sceneMoveNode(content, viewport, 0);
    try f.owner.sceneSetViewport(content, viewport);
    var rows: [16]context.Handle = undefined;
    for (&rows, 0..) |*row_handle, index| {
        const row = try f.owner.sceneCreateNode(f.id, 2, @intCast(4 + index));
        row_handle.* = row;
        try f.owner.sceneSetText(row, &.{'a' + @as(u8, @intCast(index))});
        try f.owner.sceneSetStyle(row, c.OT_STYLE_FLOAT, c.OT_STYLE_FLOAT_FLEX_SHRINK, 0, 0, 0, 0);
        try f.owner.sceneSetStyle(row, 4, 0, 0, 1, 8, 1);
        try f.owner.sceneMoveNode(row, content, @intCast(index));
    }
    // Every frame refreshes and overlap-tests all 16 rows, but paints and hits only the 2 visible ones,
    // clipped to the 4-column viewport.
    var expected: FrameWork = .{
        .work_frame_id = 1,
        .candidate_visits = 19,
        .paint_visits = 19,
        .view_preparations = 24,
        .geometry_reads = 19,
        .yoga_solves = 1,
        .feedback_operations = 42,
        .visibility_steps = 14,
        .viewport_child_refreshes = 16,
        .overlap_tests = 32,
        .members_painted = 4,
        .member_cells = 8,
        .cells_cleared = 64,
        .hit_cells_written = 24,
        .hit_cells_cleared = 64,
        .hit_cells_compared = 32,
        .rows_diffed = 4,
        .full_path_reasons = FrameWork.full_path_screen,
        .layout_rounds = 1,
    };
    try testing.expectEqual(expected, try presentWork(f, .{}));
    // An unchanged frame skips the solve and geometry reads and queues less feedback.
    expected.work_frame_id = 2;
    expected.geometry_reads = 0;
    expected.yoga_solves = 0;
    expected.feedback_operations = 21;
    expected.rows_compared = 4;
    expected.rows_diffed = 0;
    expected.full_path_reasons = 0;
    try testing.expectEqual(expected, try presentWork(f, .{}));
    try f.owner.scenePatchPaint(content, c.OT_SCENE_PROPERTY_TRANSLATE_Y, .{ .translateY = -1 });
    expected.work_frame_id = 3;
    expected.rows_diffed = 2;
    try testing.expectEqual(expected, try presentWork(f, .{}));
    // A RESIZE request from the second row defers the rest of its batch to feedback; they still count as refreshes.
    try f.owner.sceneSetHooks(rows[1], c.OT_SCENE_HOOK_RESIZE, 1, 8, 1);
    try f.owner.sceneSetStyle(rows[1], 4, 0, 0, 1, 6, 1);
    const done = try f.step(try f.step(null, options, c.OT_SCENE_FRAME_RESIZE, rows[1]), options, c.OT_SCENE_FRAME_DONE, null);
    _ = try f.owner.sceneFrameCommit(f.id, done, false);
    try drain(f.owner, f.id);
    const resized = try work(f);
    try testing.expectEqual(@as(u64, 16), resized.viewport_child_refreshes);
    try testing.expectEqual(@as(u64, 35), resized.feedback_operations);
    try testing.expectEqual(@as(u32, 1), resized.host_requests);
}

// The bench's scenes at small sizes. Columns: every FrameWork field after work_frame_id, in
// declaration order (candidate visits through layout rounds). Track B steps change these rows.
test "Scene frame bench scenes pin each frame kind's work at small sizes" {
    const bench = @import("../bench/scene-frame_bench.zig");
    const rows = [_]struct { shape: bench.Shape, size: u32, change: bench.Change, work: [20]u64 }{
        .{ .shape = .ui, .size = 0, .change = .unchanged, .work = .{ 0, 0, 87, 0, 0, 0, 0, 0, 0, 86, 9009, 20000, 26209, 20000, 10000, 50, 0, 0, 0, 1 } },
        .{ .shape = .ui, .size = 0, .change = .glyph, .work = .{ 87, 0, 87, 87, 1, 0, 0, 0, 0, 86, 9009, 20000, 26209, 20000, 10000, 50, 1, 0, 0, 1 } },
        .{ .shape = .ui, .size = 0, .change = .update_hook, .work = .{ 87, 87, 174, 0, 0, 348, 299, 0, 0, 86, 9009, 20000, 26209, 20000, 10000, 50, 0, 0, 1, 1 } },
        .{ .shape = .ui, .size = 0, .change = .paint_hook, .work = .{ 87, 87, 87, 0, 0, 0, 0, 0, 0, 86, 9009, 20000, 26209, 20000, 10000, 50, 0, 0, 1, 1 } },
        .{ .shape = .boxes, .size = 100, .change = .unchanged, .work = .{ 0, 0, 101, 0, 0, 0, 0, 0, 0, 100, 1, 12320, 100, 12320, 6160, 44, 0, 0, 0, 1 } },
        .{ .shape = .boxes, .size = 100, .change = .background, .work = .{ 0, 0, 101, 0, 0, 0, 0, 0, 0, 100, 1, 12320, 100, 12320, 6160, 44, 1, 0, 0, 1 } },
        .{ .shape = .scroll, .size = 100, .change = .unchanged, .work = .{ 104, 104, 158, 0, 0, 217, 208, 100, 200, 53, 10000, 20000, 29900, 20000, 10000, 50, 0, 0, 0, 1 } },
        .{ .shape = .scroll, .size = 100, .change = .glyph, .work = .{ 104, 104, 158, 104, 1, 217, 208, 100, 200, 53, 10000, 20000, 29900, 20000, 10000, 50, 1, 0, 0, 1 } },
        .{ .shape = .scroll, .size = 100, .change = .scroll, .work = .{ 104, 104, 158, 0, 0, 217, 208, 100, 200, 53, 10000, 20000, 29900, 20000, 10000, 50, 50, 0, 0, 1 } },
        .{ .shape = .scroll, .size = 100, .change = .append, .work = .{ 106, 106, 160, 106, 1, 219, 208, 102, 204, 53, 10000, 20000, 29900, 20000, 10000, 50, 0, 0, 0, 1 } },
        .{ .shape = .wrapped_scroll, .size = 20, .change = .unchanged, .work = .{ 70, 70, 100, 0, 0, 281, 707, 20, 40, 69, 4030, 20000, 85620, 20000, 10000, 50, 0, 0, 0, 1 } },
    };
    for (rows) |row| {
        var target = try bench.Scene.init(testing.allocator, testing.io, row.shape, row.size);
        defer target.deinit();
        // The second changed frame: the first one also settles hooks registered by the change.
        _ = try target.frame(row.change);
        const w = try target.frame(row.change);
        var actual: [20]u64 = undefined;
        inline for (std.meta.fields(FrameWork)[1..], 0..) |field, index| actual[index] = @field(w, field.name);
        try testing.expectEqual(row.work, actual);
    }
}
