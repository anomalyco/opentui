const std = @import("std");
const testing = std.testing;
const Fixture = @import("scene_fixture_test.zig").Fixture;
const context = @import("../context.zig");
const scene = @import("../scene.zig");
const c = @import("context_abi_c");
const ansi = @import("../ansi.zig");
const Recording = @import("scene_record_test.zig").Recording;
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

test "Scene hit tests answer from the last presented scene frame" {
    const f = try Fixture.init(testing.allocator, 4, 1, .{});
    defer f.deinit();
    const box = try f.owner.sceneCreateNode(f.id, 1, 2);
    try f.owner.sceneSetStyle(box, 4, 0, 0, 1, 2, 1);
    try f.owner.sceneMoveNode(box, f.root, 0);
    const commits = [_]@import("../renderer.zig").SplitSnapshot{.{ .snapshot = f.cli.getCurrentBuffer(), .row_columns = 4 }};
    const Step = enum { present, excluded, draft, pending, cancel, skip, raw, split, resize_draft, resize };
    // Each row moves the box to x, runs one outcome, and expects the box's number at the
    // listed column of the presented frame (0 for none).
    const rows = [_]struct { step: Step, x: f64, hits: [4]u32 }{
        .{ .step = .present, .x = 0, .hits = .{ 2, 2, 0, 0 } },
        // The captured node's number leaves it out of the frame's hits.
        .{ .step = .excluded, .x = 0, .hits = .{ 0, 0, 0, 0 } },
        .{ .step = .present, .x = 0, .hits = .{ 2, 2, 0, 0 } },
        // A frame presented while no hit test ran stays current while the next one is drafted.
        .{ .step = .draft, .x = 1, .hits = .{ 0, 2, 2, 0 } },
        .{ .step = .pending, .x = 2, .hits = .{ 0, 0, 2, 2 } },
        .{ .step = .cancel, .x = 0, .hits = .{ 0, 0, 2, 2 } },
        .{ .step = .skip, .x = 0, .hits = .{ 0, 0, 2, 2 } },
        .{ .step = .present, .x = 1, .hits = .{ 0, 2, 2, 0 } },
        // A non-scene render publishes no hits.
        .{ .step = .raw, .x = 1, .hits = .{ 0, 0, 0, 0 } },
        .{ .step = .present, .x = 0, .hits = .{ 2, 2, 0, 0 } },
        .{ .step = .split, .x = 0, .hits = .{ 2, 2, 0, 0 } },
        // Resize retires the hits of a painted draft, even after its later commit.
        .{ .step = .resize_draft, .x = 2, .hits = .{ 0, 0, 0, 0 } },
        .{ .step = .present, .x = 2, .hits = .{ 0, 0, 2, 2 } },
        .{ .step = .resize, .x = 2, .hits = .{ 0, 0, 0, 0 } },
    };
    var width: u32 = 4;
    for (rows) |row| {
        try f.owner.sceneSetPaint(box, .{ .translateX = row.x });
        switch (row.step) {
            .present => {
                _ = try f.owner.sceneFrameCommit(f.id, try f.owner.scenePaint(f.id, options.background, true, 0), false);
                try drain(f.owner, f.id);
            },
            .excluded => {
                _ = try f.owner.sceneFrameCommit(f.id, try f.owner.scenePaint(f.id, options.background, true, 2), false);
                try drain(f.owner, f.id);
            },
            .draft => {
                _ = try f.owner.sceneFrameCommit(f.id, try f.owner.scenePaint(f.id, options.background, true, 0), false);
                try drain(f.owner, f.id);
                try f.owner.sceneSetPaint(box, .{ .translateX = row.x + 1 });
                const draft = try f.owner.scenePaint(f.id, options.background, true, 0);
                for (row.hits, 0..) |num, x| try testing.expectEqual(num, try f.owner.sceneHitTest(f.id, @intCast(x), 0));
                try f.owner.sceneFrameCancel(f.id, draft.frame_id);
            },
            .pending => {
                try testing.expectEqual(.pending, try f.owner.sceneFrameCommit(f.id, try f.owner.scenePaint(f.id, options.background, true, 0), true));
                // The pending frame's hits wait for its output.
                try testing.expectEqual(@as(u32, 0), try f.owner.sceneHitTest(f.id, 3, 0));
                try testing.expectEqual(@as(u32, 2), try f.owner.sceneHitTest(f.id, 1, 0));
                try drain(f.owner, f.id);
            },
            .cancel => try f.owner.sceneFrameCancel(f.id, (try f.owner.scenePaint(f.id, options.background, true, 0)).frame_id),
            .skip => {
                try f.owner.writeSession(f.id, &([_]u8{'x'} ** 8192));
                try testing.expectEqual(.skipped, try f.owner.sceneFrameCommit(f.id, try f.owner.scenePaint(f.id, options.background, true, 0), false));
                try drain(f.owner, f.id);
            },
            .raw => {
                _ = try f.owner.renderSession(f.id, false);
                try drain(f.owner, f.id);
            },
            .split => {
                _ = try (try f.owner.raw().getSession(f.id)).renderSplit(null, &commits, 0, true);
                try drain(f.owner, f.id);
            },
            .resize_draft => {
                const draft = try f.owner.scenePaint(f.id, options.background, true, 0);
                width = 5;
                try f.owner.resizeSessionRenderer(f.id, width, 1);
                _ = try f.owner.sceneFrameCommit(f.id, draft, false);
                try drain(f.owner, f.id);
            },
            .resize => {
                width = 4;
                try f.owner.resizeSessionRenderer(f.id, width, 1);
            },
        }
        for (row.hits, 0..) |num, x| try testing.expectEqual(num, try f.owner.sceneHitTest(f.id, @intCast(x), 0));
        try testing.expectEqual(@as(u32, 0), try f.owner.sceneHitTest(f.id, @intCast(width), 0));
    }
    // A hit test walks presented members from the top and stops at the first that covers the
    // cell; a cell outside the screen walks none. Rows: x, y, number, members walked.
    const top = try f.owner.sceneCreateNode(f.id, 1, 3);
    try f.owner.sceneSetStyle(top, 4, 0, 0, 1, 1, 1);
    try f.owner.sceneMoveNode(top, box, 0);
    try f.owner.sceneSetPaint(box, .{});
    _ = try f.owner.sceneFrameCommit(f.id, try f.owner.scenePaint(f.id, options.background, true, 0), false);
    try drain(f.owner, f.id);
    for ([_][4]u32{ .{ 0, 0, 3, 1 }, .{ 1, 0, 2, 2 }, .{ 3, 0, 0, 2 }, .{ 4, 0, 0, 0 }, .{ 0, 1, 0, 0 } }) |query| {
        const before = f.state.test_hit_steps;
        try testing.expectEqual(query[2], try f.owner.sceneHitTest(f.id, @intCast(query[0]), @intCast(query[1])));
        try testing.expectEqual(@as(u64, query[3]), f.state.test_hit_steps - before);
    }
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

/// The steady work of the two-member scene below. A frame with damage repaints both
/// members; one without skips paint.
fn plainWork(frame_id: u64, visits: u64, reads: u64, solves: u64, rows_compared: u64, rows_diffed: u64, reasons: u32, damage: u32) FrameWork {
    const painted = damage != 0;
    return .{
        .work_frame_id = frame_id,
        .candidate_visits = visits,
        .geometry_reads = reads,
        .yoga_solves = solves,
        .view_preparations = 3,
        .members_painted = if (painted) 2 else 0,
        .member_cells = if (painted) 10 else 0,
        .cells_cleared = if (painted) 16 else 0,
        .rows_compared = rows_compared,
        .rows_diffed = rows_diffed,
        .full_path_reasons = reasons,
        .layout_rounds = 1,
        .damage_rows = damage,
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
    // The forced first frame merges the scene's reasons with the encoder's. Without the flag,
    // the next frame has no retained work to reuse; unchanged and paint-only frames reuse it.
    // Unchanged frames paint nothing and diff no row; a changed member's row is the only one diffed.
    try f.owner.sceneSetDebugFlags(f.id, c.OT_SCENE_DEBUG_FULL_FRAME);
    try testing.expectEqual(plainWork(1, 3, 3, 1, 0, 2, FrameWork.full_path_forced | FrameWork.full_path_screen | FrameWork.full_path_unretained, 2), try presentWork(f, .{}));
    try testing.expectEqual(plainWork(2, 3, 0, 0, 2, 0, FrameWork.full_path_forced, 2), try presentWork(f, .{}));
    try f.owner.sceneSetDebugFlags(f.id, 0);
    try testing.expectEqual(plainWork(3, 3, 0, 0, 0, 0, 0, 0), try presentWork(f, .{}));
    try testing.expectEqual(plainWork(4, 0, 0, 0, 0, 0, 0, 0), try presentWork(f, .{}));
    try f.owner.scenePatchPaint(fill, c.OT_SCENE_PROPERTY_BACKGROUND, .{ .background = .{ 3, 0, 0, 255 } });
    try testing.expectEqual(plainWork(5, 0, 0, 0, 1, 1, 0, 1), try presentWork(f, .{}));
    try f.owner.sceneSetText(text, "ho");
    try testing.expectEqual(plainWork(6, 3, 3, 1, 1, 1, 0, 1), try presentWork(f, .{}));
    // A measurement outside the frame solves; the frame reads geometry without solving.
    try f.owner.sceneSetText(text, "hey");
    try f.owner.sceneMeasureLayout(f.id, f.root);
    try testing.expectEqual(plainWork(7, 3, 3, 0, 1, 1, 0, 1), try presentWork(f, .{}));
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
    // After the snapshot it encodes every row. The cancel, the skipped frame, and the raw render
    // before it lost the retained frame, so it repaints in full.
    try testing.expectEqual(plainWork(split.frame_id, 0, 0, 0, 0, 2, FrameWork.full_path_screen | FrameWork.full_path_tainted | FrameWork.full_path_unretained, 2), try work(f));
    try testing.expectEqual(@as(u32, 2), try f.owner.sceneHitTest(f.id, 0, 0));
    // A frame without mouse hits presents none, and a changed frame option repaints in full.
    try testing.expectEqual(plainWork(11, 0, 0, 0, 2, 0, FrameWork.full_path_options, 2), try presentWork(f, .{ .use_mouse = false }));
    try testing.expectEqual(@as(u32, 0), try f.owner.sceneHitTest(f.id, 0, 0));
    // A resize clears more cells and repaints in full.
    try f.owner.resizeSessionRenderer(f.id, 8, 3);
    var resized = plainWork(12, 3, 3, 1, 1, 3, FrameWork.full_path_unretained, 3);
    resized.cells_cleared = 24;
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

const Retained = enum { unchanged, focus, blur, register, destroy_style, unbind, rebind, select, reset, styled_text, text_options, view_paint_off, view_paint_on, box_details, arrow, editor_select, editor_rebind, editor_unbind, z_order, surface_write, resend, same_width, sub_cell, palette, draft_write, session_draw, lease_next, lease_current, raw_render, skipped_commit, width_method, preserve, recorded, image };

/// A node at a fixed place, painted after its earlier siblings.
fn placedAt(f: Fixture, parent: context.Handle, kind: u32, num: u32, left: f32, top: f32, width: f32, height: f32) !context.Handle {
    const node = try f.owner.sceneCreateNode(f.id, kind, num);
    try f.owner.sceneSetStyle(node, 4, 0, 0, 1, width, 1);
    try f.owner.sceneSetStyle(node, 4, 1, 0, 1, height, 1);
    try f.owner.sceneSetStyle(node, 0, 6, 0, 0, 2, 0);
    try f.owner.sceneSetPositions(node, 3, .{ 1, 1, 0, 0 }, .{ left, top, 0, 0 });
    try f.owner.sceneMoveNode(node, parent, @intCast((try f.owner.raw().getRenderable(parent)).scene_node.?.children.items.len));
    return node;
}

// Retained paint (B3) on a 10 x 9 screen: a box (rows 0-2), a text (row 3), a text view of a
// styled shared buffer (row 4), an editor (row 5), a surface taller than its node (rows 6-7),
// an arrow (row 8), and at column 8 a parent (row 0) whose child (rows 2-3) paints under a
// later sibling. Each row changes one input and expects the rows it damages and the full-path
// reasons. The table runs without VERIFY, then with it: VERIFY must pass and change no count.
test "Scene frame retained paint damages the rows of changed inputs only" {
    var results: [2][std.meta.fields(Retained).len + 6]FrameWork = undefined;
    for ([_]bool{ false, true }, &results) |verify, *counts| try retainedTable(verify, counts);
    try testing.expectEqualSlices(FrameWork, &results[0], &results[1]);
}

fn retainedTable(verify: bool, counts: []FrameWork) !void {
    const f = try Fixture.init(testing.allocator, 10, 9, .{});
    defer f.deinit();
    if (verify) try f.owner.sceneSetDebugFlags(f.id, c.OT_SCENE_DEBUG_VERIFY);
    const box = try placedAt(f, f.root, c.OT_SCENE_BOX, 2, 0, 0, 6, 3);
    const text = try placedAt(f, f.root, c.OT_SCENE_TEXT, 3, 0, 3, 6, 1);
    const view_node = try placedAt(f, f.root, c.OT_SCENE_TEXT_VIEW, 4, 0, 4, 6, 1);
    const editor_node = try placedAt(f, f.root, c.OT_SCENE_EDITOR, 5, 0, 5, 6, 1);
    const custom = try placedAt(f, f.root, c.OT_SCENE_CUSTOM, 6, 0, 6, 2, 1);
    const parent = try placedAt(f, f.root, c.OT_SCENE_BOX, 7, 8, 0, 1, 1);
    _ = try placedAt(f, parent, c.OT_SCENE_BOX, 8, 0, 2, 2, 2);
    const above = try placedAt(f, f.root, c.OT_SCENE_BOX, 9, 8, 2, 2, 2);
    const arrow = try placedAt(f, f.root, c.OT_SCENE_ARROW, 11, 0, 8, 1, 1);
    try f.owner.sceneSetPaint(box, .{ .borderSides = c.OT_BORDER_ALL, .focusable = true });
    try f.owner.sceneSetPaint(above, .{ .background = .{ 0, 90, 0, 255 } });
    try f.owner.sceneSetPaint((try f.owner.raw().getRenderable(parent)).scene_node.?.children.items[0].scene_node.?.handle, .{ .background = .{ 90, 0, 0, 255 } });
    try f.owner.sceneSetText(text, "hello");
    const shared = try f.owner.createTextBuffer(.unicode);
    try f.owner.textBufferSetText(shared, "styled");
    var style: ?context.Handle = try f.owner.createSyntaxStyle();
    try f.owner.textBufferSetSyntaxStyle(shared, style);
    _ = try f.owner.syntaxStyleRegister(style.?, "name", .{ .fg = ansi.rgbColor(255, 0, 0, 255), .bg = null, .attributes = 0 });
    try f.owner.textBufferHighlight(shared, .{ .add_range = .{ .start = 0, .end = 3, .style_id = 1 } });
    var view = try f.owner.createTextBufferView(shared);
    try f.owner.sceneSetTextView(view_node, view);
    const edit = try f.owner.createEditBuffer(.unicode);
    const editor = try f.owner.createEditorView(edit, 6, 1);
    var fresh_editor: context.Handle = undefined;
    try f.owner.sceneSetEditorView(editor_node, editor);
    try f.owner.editSetText(edit, "edit", false);
    try f.owner.editSetSyntaxStyle(edit, style);
    const surface = try f.owner.createBuffer(2, 2, .{});
    try f.owner.sceneSetSurface(custom, surface);
    const scratch = try f.owner.createBuffer(2, 1, .{});
    try f.owner.drawBufferText(scratch, "zz", 0, 0, ansi.rgbColor(255, 255, 255, 255), null, 0);
    _ = try presentWork(f, .{});
    const lost = FrameWork.full_path_tainted | FrameWork.full_path_unretained;
    const rows = [_]struct { change: Retained, damage: u32, reasons: u32 = 0 }{
        // The surface's rows repaint on every frame: its cells are not fingerprinted.
        .{ .change = .unchanged, .damage = 2 },
        .{ .change = .focus, .damage = 5 },
        .{ .change = .blur, .damage = 5 },
        // Both borrowers of the style repaint.
        .{ .change = .register, .damage = 4 },
        .{ .change = .destroy_style, .damage = 4 },
        .{ .change = .unbind, .damage = 3 },
        .{ .change = .rebind, .damage = 3 },
        // A view no mutation gate touched still repaints when destroyed.
        .{ .change = .unbind, .damage = 3 },
        .{ .change = .rebind, .damage = 3 },
        .{ .change = .select, .damage = 3 },
        .{ .change = .reset, .damage = 3 },
        .{ .change = .styled_text, .damage = 3 },
        .{ .change = .text_options, .damage = 3 },
        .{ .change = .view_paint_off, .damage = 3 },
        .{ .change = .view_paint_on, .damage = 3 },
        .{ .change = .box_details, .damage = 5 },
        .{ .change = .arrow, .damage = 3 },
        .{ .change = .editor_select, .damage = 3 },
        .{ .change = .editor_rebind, .damage = 3 },
        .{ .change = .editor_unbind, .damage = 3 },
        // Paint order is an input: the reordered child, the sibling it now covers, and the
        // arrow after them repaint.
        .{ .change = .z_order, .damage = 6 },
        .{ .change = .surface_write, .damage = 2 },
        // Equal values and layout-only setters that keep the layout change nothing.
        .{ .change = .resend, .damage = 2 },
        .{ .change = .same_width, .damage = 2 },
        // Layout compares bit-exact: a sub-cell move repaints its rows although no cell moves.
        .{ .change = .sub_cell, .damage = 5 },
        // A palette change re-encodes every row of the kept frame.
        .{ .change = .palette, .damage = 2, .reasons = FrameWork.full_path_screen },
        // A write after paint reaches the terminal, and the next frame repaints in full.
        .{ .change = .draft_write, .damage = 9, .reasons = lost },
        .{ .change = .session_draw, .damage = 9, .reasons = lost },
        .{ .change = .lease_next, .damage = 9, .reasons = lost },
        // A write to the presented cells keeps the kept frame and re-encodes every row.
        .{ .change = .lease_current, .damage = 2 },
        .{ .change = .raw_render, .damage = 9, .reasons = lost },
        .{ .change = .skipped_commit, .damage = 9, .reasons = FrameWork.full_path_unretained },
        .{ .change = .width_method, .damage = 9, .reasons = FrameWork.full_path_unretained },
        // Leaving unwritten cells as they are is a frame option: both changes repaint in full.
        .{ .change = .preserve, .damage = 9, .reasons = FrameWork.full_path_options },
        // A hook draws outside its node's rows; the frame after a recorded one repaints in full.
        .{ .change = .recorded, .damage = 9, .reasons = FrameWork.full_path_unretained },
        // The first image takes the full path although only its rows changed.
        .{ .change = .image, .damage = 9, .reasons = FrameWork.full_path_images },
    };
    var image_node: context.Handle = undefined;
    comptime std.debug.assert(rows.len + 3 <= std.meta.fields(Retained).len + 6);
    for (rows, 0..) |row, row_index| {
        errdefer std.debug.print("row {s}, verify {}\n", .{ @tagName(row.change), verify });
        switch (row.change) {
            .unchanged => {},
            .focus => try f.owner.sceneSetFocus(box, true),
            .blur => try f.owner.sceneSetFocus(box, false),
            .register => _ = try f.owner.syntaxStyleRegister(style.?, "name", .{ .fg = ansi.rgbColor(0, 255, 0, 255), .bg = null, .attributes = 0 }),
            .destroy_style => {
                try f.owner.destroy(style.?);
                style = null;
            },
            .unbind => try f.owner.destroy(view),
            .rebind => {
                view = try f.owner.createTextBufferView(shared);
                try f.owner.sceneSetTextView(view_node, view);
            },
            .select => try testing.expect(try f.owner.sceneSetTextSelection(text, .{ .operation = c.OT_SCENE_TEXT_SELECTION_SET, .focus_x = 3, .background = ansi.rgbColor(0, 0, 255, 255) })),
            .reset => try testing.expect(try f.owner.sceneSetTextSelection(text, .{ .operation = c.OT_SCENE_TEXT_SELECTION_RESET })),
            .styled_text => try f.owner.sceneSetStyledText(text, "hello", &.{.{ .byte_count = 5, .foreground = ansi.rgbColor(0, 255, 255, 255) }}),
            .text_options => try f.owner.sceneSetTextOptions(text, .{ .attributes = ansi.TextAttributes.BOLD }),
            .view_paint_off, .view_paint_on => try f.owner.sceneSetTextViewPaint(view_node, row.change == .view_paint_on),
            .box_details => try f.owner.sceneSetBoxDetails(box, .{ .title = "t" }),
            .arrow => try f.owner.sceneSetArrow(arrow, .{ .direction = 1 }),
            .editor_rebind => {
                fresh_editor = try f.owner.createEditorView(edit, 6, 1);
                try f.owner.sceneSetEditorView(editor_node, fresh_editor);
            },
            .editor_unbind => try f.owner.destroy(fresh_editor),
            .editor_select => _ = try f.owner.editorSelect(editor, .{ .operation = .local, .focus_x = 2, .background = ansi.rgbColor(0, 0, 255, 255) }),
            .z_order => try f.owner.scenePatchPaint(parent, c.OT_SCENE_PROPERTY_Z_INDEX, .{ .zIndex = 1 }),
            .surface_write => try f.owner.drawBufferText(surface, "s", 0, 1, ansi.rgbColor(255, 255, 255, 255), null, 0),
            .resend => try f.owner.sceneSetPaint(box, .{ .borderSides = c.OT_BORDER_ALL, .focusable = true }),
            .same_width => try f.owner.sceneSetStyle(text, 4, 0, 0, 1, 6, 1),
            .sub_cell => try f.owner.scenePatchPaint(box, c.OT_SCENE_PROPERTY_TRANSLATE_X, .{ .translateX = 0.25 }),
            .palette => f.cli.setPaletteState(&.{ansi.rgbColor(0, 0, 0, 255)}, ansi.rgbColor(255, 255, 255, 255), ansi.rgbColor(0, 0, 0, 255), 7),
            .draft_write => {
                const done = try f.owner.scenePaint(f.id, options.background, true, 0);
                try testing.expectEqual(@as(u32, 2), f.state.frame_work.damage_rows);
                try f.owner.sceneFrameDrawBuffer(f.id, done, scratch, 4, 7);
                _ = try f.owner.sceneFrameCommit(f.id, done, false);
                try drain(f.owner, f.id);
                try testing.expectEqual(@as(u32, 'z'), f.cli.currentRenderBuffer.get(4, 7).?.char);
            },
            .session_draw => try f.owner.drawSessionBuffer(f.id, scratch, 4, 7),
            .lease_next, .lease_current => {
                const lease = try f.owner.acquireSessionBufferLease(f.id, if (row.change == .lease_next) .next else .current);
                const snapshot = try f.owner.bufferLeaseSnapshot(lease);
                // Raw users find next blank, as before scene frames kept it.
                if (row.change == .lease_next) for (snapshot.buffer.char) |char| try testing.expectEqual(@as(u32, ' '), char);
                snapshot.buffer.bg[0] = ansi.rgbColor(0, 200, 0, 255);
                try f.owner.releaseBufferLease(lease);
            },
            .raw_render => {
                try f.owner.drawSessionBuffer(f.id, scratch, 4, 7);
                _ = try f.owner.renderSession(f.id, false);
                try drain(f.owner, f.id);
            },
            .skipped_commit => {
                try f.owner.writeSession(f.id, &([_]u8{'x'} ** 8192));
                try testing.expectEqual(.skipped, try f.owner.sceneFrameCommit(f.id, try f.owner.scenePaint(f.id, options.background, true, 0), false));
                try drain(f.owner, f.id);
            },
            .preserve => {
                var preserving = options;
                preserving.preserve_unwritten = true;
                const done = try f.step(null, preserving, c.OT_SCENE_FRAME_DONE, null);
                try testing.expectEqual(@as(u32, 9), f.state.frame_work.damage_rows);
                try testing.expect(f.state.frame_work.full_path_reasons & FrameWork.full_path_options != 0);
                _ = try f.owner.sceneFrameCommit(f.id, done, false);
                try drain(f.owner, f.id);
            },
            .width_method => {
                f.cli.terminal.caps.unicode = if (f.cli.nextRenderBuffer.width_method == .wcwidth) .unicode else .wcwidth;
                f.cli.syncWidthMethod();
            },
            .recorded => {
                try f.owner.sceneSetHooks(text, c.OT_SCENE_HOOK_RENDER_AFTER, 1, 6, 1);
                const request = try f.step(null, options, c.OT_SCENE_FRAME_RECORD, null);
                const slots = try f.owner.sceneFramePaintSlots(f.id, request);
                const index = for (slots, 0..) |slot, position| {
                    if (slot.num == 3) break position;
                } else unreachable;
                var recording: Recording = .{};
                recording.slot(@intCast(index), c.OT_SCENE_RECORD_PHASE_AFTER);
                recording.text("h", 9, 7);
                const done = try f.owner.sceneFrameStepWithRecording(f.id, request, options, recording.view());
                _ = try f.owner.sceneFrameCommit(f.id, done, false);
                try drain(f.owner, f.id);
                try testing.expectEqual(@as(u32, 'h'), f.cli.currentRenderBuffer.get(9, 7).?.char);
                try f.owner.sceneSetHooks(text, 0, 2, 6, 1);
            },
            .image => {
                const pixels = [_]u8{ 200, 40, 0, 255 } ** 4;
                image_node = try placedAt(f, f.root, c.OT_SCENE_IMAGE, 10, 4, 7, 2, 1);
                try f.owner.sceneSetImage(image_node, try f.owner.createImagePixels(&pixels, 2, 2, .{ .stride = 8 }), .fit, .blocks, null);
            },
        }
        const result = try presentWork(f, .{});
        counts[row_index] = result;
        try testing.expectEqual(row.damage, result.damage_rows);
        try testing.expectEqual(row.reasons, result.full_path_reasons);
        switch (row.change) {
            .draft_write => try testing.expectEqual(@as(u32, ' '), f.cli.currentRenderBuffer.get(4, 7).?.char),
            .recorded => try testing.expectEqual(@as(u32, ' '), f.cli.currentRenderBuffer.get(9, 7).?.char),
            .unbind => try testing.expectEqual(@as(u32, ' '), f.cli.currentRenderBuffer.get(0, 4).?.char),
            .editor_unbind => try testing.expectEqual(@as(u32, ' '), f.cli.currentRenderBuffer.get(0, 5).?.char),
            .lease_current => {
                try testing.expectEqual(@as(u64, 9), result.rows_compared);
                try testing.expectEqual(f.cli.nextRenderBuffer.buffer.bg[0], f.cli.currentRenderBuffer.buffer.bg[0]);
            },
            else => {},
        }
    }
    // Frames retain again once no image is placed or shown.
    try f.owner.sceneDestroyNode(image_node);
    counts[rows.len] = try presentWork(f, .{});
    counts[rows.len + 1] = try presentWork(f, .{});
    counts[rows.len + 2] = try presentWork(f, .{});
    try testing.expectEqual(FrameWork.full_path_images | FrameWork.full_path_unretained, counts[rows.len].full_path_reasons);
    try testing.expectEqual(FrameWork.full_path_unretained, counts[rows.len + 1].full_path_reasons);
    try testing.expectEqual(@as(u32, 2), counts[rows.len + 2].damage_rows);
    for (counts[rows.len + 3 ..]) |*unused| unused.* = .{};
    // A presented frame that differs from what paint produces fails a verified frame.
    if (!verify) return;
    try f.cli.currentRenderBuffer.drawText("X", 9, 3, ansi.rgbColor(255, 255, 255, 255), null, 0);
    try testing.expectError(error.RetainedMismatch, f.owner.scenePaint(f.id, options.background, true, 0));
}

// A skipped commit clears next, so the next frame repaints in full although nothing changed.
// The debug overlay draws after paint, so every frame under it encodes and repaints in full.
test "Scene frame retained paint repaints in full after a skipped commit and under the debug overlay" {
    const f = try Fixture.init(testing.allocator, 44, 14, .{});
    defer f.deinit();
    try f.owner.sceneSetDebugFlags(f.id, c.OT_SCENE_DEBUG_VERIFY);
    const text = try placedAt(f, f.root, c.OT_SCENE_TEXT, 2, 0, 0, 4, 1);
    try f.owner.sceneSetText(text, "kept");
    _ = try presentWork(f, .{});
    // A verified unchanged frame paints to check, but reports the work of the skip.
    const unchanged = try presentWork(f, .{});
    try testing.expectEqual(@as(u32, 0), unchanged.damage_rows);
    try testing.expectEqual(@as(u64, 0), unchanged.members_painted);
    try testing.expectEqual(@as(u64, 0), unchanged.cells_cleared);
    try f.owner.writeSession(f.id, &([_]u8{'x'} ** 8192));
    const skipped = try f.owner.scenePaint(f.id, options.background, true, 0);
    try testing.expectEqual(@as(u32, 0), f.state.frame_work.damage_rows);
    try testing.expectEqual(.skipped, try f.owner.sceneFrameCommit(f.id, skipped, false));
    try drain(f.owner, f.id);
    const full = try presentWork(f, .{});
    try testing.expectEqual(@as(u32, 14), full.damage_rows);
    try testing.expectEqual(FrameWork.full_path_unretained, full.full_path_reasons);
    try testing.expectEqual(@as(u32, 'k'), f.cli.currentRenderBuffer.get(0, 0).?.char);
    f.cli.setDebugOverlay(true, .bottomRight);
    _ = try presentWork(f, .{});
    const result = try presentWork(f, .{});
    try testing.expectEqual(@as(u32, 14), result.damage_rows);
    try testing.expectEqual(FrameWork.full_path_tainted | FrameWork.full_path_unretained, result.full_path_reasons);
}

const Lifecycle = enum { unchanged, unbind_view, unbind_editor, failed_hooks, failed_background, failed_recording, cancel_skip, surface_image };

// Frames that end without a presented paint, and resources that end without a mutation: the
// frame after each repaints what changed. The text (row 0), a view and an editor created over
// filled buffers and never mutated (rows 1-2), and a box (row 3) skip paint when unchanged.
// The table runs without VERIFY, then with it: VERIFY must pass and change no count.
test "Scene frame retained paint repaints after failed, cancelled, and unbinding frames" {
    var results: [2][std.meta.fields(Lifecycle).len]FrameWork = undefined;
    for ([_]bool{ false, true }, &results) |verify, *counts| try lifecycleTable(verify, counts);
    try testing.expectEqualSlices(FrameWork, &results[0], &results[1]);
}

fn lifecycleTable(verify: bool, counts: []FrameWork) !void {
    const f = try Fixture.init(testing.allocator, 10, 5, .{});
    defer f.deinit();
    if (verify) try f.owner.sceneSetDebugFlags(f.id, c.OT_SCENE_DEBUG_VERIFY);
    const text = try placedAt(f, f.root, c.OT_SCENE_TEXT, 2, 0, 0, 6, 1);
    try f.owner.sceneSetText(text, "kept");
    const view_node = try placedAt(f, f.root, c.OT_SCENE_TEXT_VIEW, 3, 0, 1, 6, 1);
    const shared = try f.owner.createTextBuffer(.unicode);
    try f.owner.textBufferSetText(shared, "view");
    const view = try f.owner.createTextBufferView(shared);
    try f.owner.sceneSetTextView(view_node, view);
    const editor_node = try placedAt(f, f.root, c.OT_SCENE_EDITOR, 4, 0, 2, 6, 1);
    const edit = try f.owner.createEditBuffer(.unicode);
    try f.owner.editSetText(edit, "edit", false);
    const editor = try f.owner.createEditorView(edit, 6, 1);
    try f.owner.sceneSetEditorView(editor_node, editor);
    const box = try placedAt(f, f.root, c.OT_SCENE_BOX, 5, 0, 3, 6, 1);
    try f.owner.sceneSetPaint(box, .{ .background = .{ 0, 0, 90, 255 } });
    const scratch = try f.owner.createBuffer(2, 1, .{});
    _ = try presentWork(f, .{});
    const rows = [_]struct { change: Lifecycle, damage: u32, reasons: u32 = 0, force: bool = false }{
        .{ .change = .unchanged, .damage = 0 },
        .{ .change = .unbind_view, .damage = 1 },
        .{ .change = .unbind_editor, .damage = 1 },
        // A rejected one-call paint clears next; a forced commit after it must not show that.
        .{ .change = .failed_hooks, .damage = 5, .reasons = FrameWork.full_path_screen | FrameWork.full_path_unretained, .force = true },
        .{ .change = .failed_background, .damage = 5, .reasons = FrameWork.full_path_screen | FrameWork.full_path_unretained, .force = true },
        // A failed recorded frame keeps the reasons it consumed.
        .{ .change = .failed_recording, .damage = 5, .reasons = FrameWork.full_path_tainted | FrameWork.full_path_unretained },
        .{ .change = .cancel_skip, .damage = 5, .reasons = FrameWork.full_path_unretained },
        // The first image placement in a surface takes the full path.
        .{ .change = .surface_image, .damage = 5, .reasons = FrameWork.full_path_images },
    };
    for (rows, counts) |row, *count| {
        errdefer std.debug.print("row {s}, verify {}\n", .{ @tagName(row.change), verify });
        switch (row.change) {
            .unchanged => {},
            .unbind_view => try f.owner.destroy(view),
            .unbind_editor => try f.owner.destroy(editor),
            .failed_hooks => {
                try f.owner.sceneSetHooks(text, c.OT_SCENE_HOOK_RENDER_AFTER, 1, 6, 1);
                try testing.expectError(error.UnsupportedResource, f.owner.scenePaint(f.id, options.background, true, 0));
                try f.owner.sceneSetHooks(text, 0, 2, 6, 1);
            },
            .failed_background => try testing.expectError(error.InvalidOptions, f.owner.scenePaint(f.id, .{ 0x4000, 0, 0, 255 }, true, 0)),
            .failed_recording => {
                try f.owner.drawSessionBuffer(f.id, scratch, 0, 4);
                try f.owner.sceneSetHooks(text, c.OT_SCENE_HOOK_RENDER_AFTER, 3, 6, 1);
                const request = try f.step(null, options, c.OT_SCENE_FRAME_RECORD, null);
                var recording: Recording = .{};
                recording.slot(0, c.OT_SCENE_RECORD_PHASE_AFTER);
                recording.stack(99, 0, 0, 1);
                try testing.expect(std.meta.isError(f.owner.sceneFrameStepWithRecording(f.id, request, options, recording.view())));
                try f.owner.sceneSetHooks(text, 0, 4, 6, 1);
            },
            .cancel_skip => {
                const draft = try f.owner.scenePaint(f.id, options.background, true, 0);
                try testing.expectEqual(@as(u32, 0), f.state.frame_work.damage_rows);
                try f.owner.sceneFrameCancel(f.id, draft.frame_id);
            },
            .surface_image => {
                const custom = try placedAt(f, f.root, c.OT_SCENE_CUSTOM, 6, 8, 4, 2, 1);
                const surface = try f.owner.createBuffer(2, 1, .{});
                const pixels = [_]u8{ 200, 40, 0, 255 } ** 4;
                _ = try f.owner.drawBufferImage(surface, null, try f.owner.createImagePixels(&pixels, 2, 2, .{ .stride = 8 }), .{ .width = 2, .height = 1, .protocol = .kitty });
                try testing.expect((try f.owner.raw().getBuffer(surface)).image_placements.items.len != 0);
                try f.owner.sceneSetSurface(custom, surface);
            },
        }
        count.* = try presentWork(f, .{ .force = row.force });
        try testing.expectEqual(row.damage, count.damage_rows);
        try testing.expectEqual(row.reasons, count.full_path_reasons);
        if (row.change == .unbind_view) try testing.expectEqual(@as(u32, ' '), f.cli.currentRenderBuffer.get(0, 1).?.char);
        if (row.change == .unbind_editor) try testing.expectEqual(@as(u32, ' '), f.cli.currentRenderBuffer.get(0, 2).?.char);
        try testing.expectEqual(@as(u32, 'k'), f.cli.currentRenderBuffer.get(0, 0).?.char);
    }
}

test "Scene frame work solves Yoga only for text writes that can change the measured size" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const label = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_TEXT, 2);
    try f.owner.sceneSetText(label, "ab");
    try f.owner.sceneMoveNode(label, f.root, 0);
    const style = try f.owner.createSyntaxStyle();
    const text = try f.owner.createTextBuffer(.unicode);
    try f.owner.textBufferSetText(text, "c\td");
    const view = try f.owner.createTextBufferView(text);
    const node = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_TEXT_VIEW, 3);
    try f.owner.sceneSetTextView(node, view);
    try f.owner.sceneMoveNode(node, f.root, 1);
    const red: context.StyledTextChunk = .{ .byte_count = 3, .foreground = .{ 1, 0, 0, 1 } };
    const Write = enum { none, scene_same, scene_styled_same, same, styled_same, batch_same, batch_new, defaults, highlight, syntax_style, scene_new, styled_new, tab_width, wrap_mode, clear, append, stale_slot };
    // `batch_new` and `scene_new` keep the byte count, so only the byte comparison sees the change.
    // After a clear or an append, the replacement slot still holds "c\tde" but the text does not.
    const rows = [_]struct { Write, u64 }{
        .{ .none, 0 },       .{ .scene_same, 0 }, .{ .scene_styled_same, 0 }, .{ .same, 0 },       .{ .styled_same, 0 },
        .{ .batch_same, 0 }, .{ .batch_new, 1 },  .{ .defaults, 0 },          .{ .highlight, 0 },  .{ .syntax_style, 0 },
        .{ .scene_new, 1 },  .{ .styled_new, 1 }, .{ .tab_width, 1 },         .{ .wrap_mode, 1 },  .{ .clear, 1 },
        .{ .append, 1 },     .{ .stale_slot, 1 }, .{ .clear, 1 },             .{ .stale_slot, 1 },
    };
    _ = try presentWork(f, .{});
    var expected: [rows.len]u64 = undefined;
    var actual: [rows.len]u64 = undefined;
    for (rows, 0..) |row, index| {
        switch (row[0]) {
            .none => {},
            .scene_same => try f.owner.sceneSetText(label, "ab"),
            .scene_styled_same => try f.owner.sceneSetStyledText(label, "ab", &.{.{ .byte_count = 2, .foreground = .{ 1, 0, 0, 1 } }}),
            .same => try f.owner.textBufferSetText(text, "c\td"),
            .styled_same => try f.owner.textBufferSetStyledText(text, "c\td", &.{red}),
            .batch_same, .batch_new => {
                var info: [1]context.Context.TextReplacementInfo = undefined;
                const bytes = if (row[0] == .batch_same) "c\td" else "c\nd";
                try f.owner.textBufferReplaceStyledBatch(&.{.{ .buffer = text, .view = view, .bytes = bytes, .chunks = &.{red} }}, &info);
            },
            .defaults => try f.owner.textBufferSetDefaults(text, .{ .fields = .{ .foreground = true }, .foreground = .{ 0, 1, 0, 1 } }),
            .highlight => try f.owner.textBufferHighlight(text, .{ .add_range = .{ .start = 0, .end = 1, .style_id = 1 } }),
            .syntax_style => try f.owner.textBufferSetSyntaxStyle(text, style),
            .scene_new => try f.owner.sceneSetStyledText(label, "a\n", &.{.{ .byte_count = 2 }}),
            .styled_new => try f.owner.textBufferSetStyledText(text, "c\tde", &.{.{ .byte_count = 4 }}),
            .tab_width => try f.owner.textBufferSetTabWidth(text, 8),
            .wrap_mode => try f.owner.textViewCommand(view, .{ .wrap_mode = .char }),
            .clear => try f.owner.textBufferClear(text, false),
            .append => try f.owner.textBufferAppend(text, "wxyz"),
            .stale_slot => try f.owner.textBufferSetText(text, "c\tde"),
        }
        expected[index] = row[1];
        actual[index] = (try presentWork(f, .{})).yoga_solves;
    }
    try testing.expectEqualSlices(u64, &expected, &actual);
}

// A reply changes the visibility of a member whose feedback already started. The visibility
// stamp must give way to the walk: no request may reach a node the reply hid.
test "Scene feedback visibility follows replies that hide, detach, or move a started member" {
    for (std.enums.values(enum { hide_parent, detach, into_hidden, hide_root })) |reply| {
        const f = try Fixture.init(testing.allocator, 8, 4, .{});
        defer f.deinit();
        const hidden = try f.owner.sceneCreateNode(f.id, 1, 9);
        try f.owner.sceneMoveNode(hidden, f.root, 0);
        try f.owner.sceneSetStyle(hidden, c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_DISPLAY, 0, 0, c.OT_DISPLAY_NONE, 0);
        const holder = try f.owner.sceneCreateNode(f.id, 1, 4);
        try f.owner.sceneMoveNode(holder, f.root, 1);
        const parent = try f.owner.sceneCreateNode(f.id, 1, 2);
        try f.owner.sceneMoveNode(parent, holder, 0);
        const child = try f.owner.sceneCreateNode(f.id, 1, 3);
        try f.owner.sceneMoveNode(child, parent, 0);
        try f.owner.sceneSetHooks(parent, c.OT_SCENE_HOOK_UPDATE, 1, 0, 0);
        try f.owner.sceneSetHooks(child, c.OT_SCENE_HOOK_UPDATE, 1, 0, 0);
        var request: scene.FrameRequest = undefined;
        if (reply == .hide_root) {
            // Round 2 solves without the hidden root and stamps nothing for it.
            try f.owner.sceneSetHooks(f.root, c.OT_SCENE_HOOK_LAYOUT_CHANGED, 1, 0, 0);
            request = try f.step(null, options, c.OT_SCENE_FRAME_LAYOUT_CHANGED, f.root);
            request = try f.step(request, options, c.OT_SCENE_FRAME_UPDATE, parent);
            try f.owner.sceneSetStyle(f.root, c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_DISPLAY, 0, 0, c.OT_DISPLAY_NONE, 0);
        } else {
            request = try f.step(null, options, c.OT_SCENE_FRAME_UPDATE, parent);
            switch (reply) {
                .hide_parent => try f.owner.sceneSetStyle(holder, c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_DISPLAY, 0, 0, c.OT_DISPLAY_NONE, 0),
                .detach => try f.owner.sceneMoveNode(parent, null, 0),
                .into_hidden => try f.owner.sceneMoveNode(parent, hidden, 0),
                .hide_root => unreachable,
            }
        }
        const done = try f.step(request, options, c.OT_SCENE_FRAME_DONE, null);
        try f.owner.sceneFrameCancel(f.id, done.frame_id);
    }
}

/// Drives one frame through every host request, replying with `reply`, then presents it.
fn presentStepped(f: Fixture, reply: anytype) !FrameWork {
    var request = try f.owner.sceneFrameStep(f.id, null, options);
    while (request.kind != c.OT_SCENE_FRAME_DONE) {
        try reply.apply(f, request);
        request = try f.owner.sceneFrameStep(f.id, request, options);
    }
    _ = try f.owner.sceneFrameCommit(f.id, request, false);
    try drain(f.owner, f.id);
    return work(f);
}

const NoReply = struct {
    fn apply(_: NoReply, _: Fixture, _: scene.FrameRequest) !void {}
};

/// A RESIZE reply that changes text options on `target`, or destroys it.
const StaleReply = struct {
    target: context.Handle,
    truncate: bool = true,
    destroy: bool = false,
    fn apply(self: StaleReply, f: Fixture, request: scene.FrameRequest) !void {
        if (request.kind != c.OT_SCENE_FRAME_RESIZE) return;
        if (self.destroy) return f.owner.sceneDestroyNode(self.target);
        try f.owner.sceneSetTextOptions(self.target, .{ .truncate = self.truncate });
    }
};

// A viewport of 4 x 2 cells over a column of N one-line text rows; 2 rows show. Each row is
// one frame kind; columns are viewport child refreshes, visibility steps, view preparations,
// host requests, and layout rounds of that frame. Frames that change no painted row skip paint,
// which prepares the two shown rows' views again (B3).
test "Scene frame work counts viewport refresh and culling work" {
    const Frame = enum { first, unchanged, scroll, grow, options_prepare, options_color, measure_text, measure_same_text, editor_cursor, hidden, hidden_unchanged, cancelled, stale_reply, stale_requester, placed_reply, destroy_reply };
    const sizes = [_]u32{ 16, 256, 4096 };
    const expected = [sizes.len][std.meta.fields(Frame).len][5]u64{
        .{
            .{ 16, 0, 24, 0, 1 }, // first
            .{ 0, 0, 8, 0, 1 }, // unchanged
            .{ 0, 0, 10, 0, 1 }, // scroll
            .{ 16, 0, 24, 0, 1 }, // grow
            .{ 16, 0, 22, 0, 1 }, // options_prepare
            .{ 0, 0, 8, 0, 1 }, // options_color
            .{ 16, 0, 22, 0, 1 }, // measure_text
            .{ 0, 0, 8, 0, 1 }, // measure_same_text
            .{ 16, 0, 22, 0, 1 }, // editor_cursor
            .{ 16, 0, 23, 0, 1 }, // hidden
            .{ 0, 0, 8, 0, 1 }, // hidden_unchanged
            .{ 16, 0, 23, 0, 1 }, // cancelled
            .{ 32, 0, 44, 1, 2 }, // stale_reply
            .{ 32, 0, 44, 1, 2 }, // stale_requester
            .{ 32, 0, 44, 1, 2 }, // placed_reply
            .{ 31, 60, 54, 1, 2 }, // destroy_reply
        },
        .{
            .{ 256, 0, 264, 0, 1 }, // first
            .{ 0, 0, 8, 0, 1 }, // unchanged
            .{ 0, 0, 10, 0, 1 }, // scroll
            .{ 256, 0, 264, 0, 1 }, // grow
            .{ 256, 0, 262, 0, 1 }, // options_prepare
            .{ 0, 0, 8, 0, 1 }, // options_color
            .{ 256, 0, 262, 0, 1 }, // measure_text
            .{ 0, 0, 8, 0, 1 }, // measure_same_text
            .{ 256, 0, 262, 0, 1 }, // editor_cursor
            .{ 256, 0, 263, 0, 1 }, // hidden
            .{ 0, 0, 8, 0, 1 }, // hidden_unchanged
            .{ 256, 0, 263, 0, 1 }, // cancelled
            .{ 512, 0, 524, 1, 2 }, // stale_reply
            .{ 512, 0, 524, 1, 2 }, // stale_requester
            .{ 512, 0, 524, 1, 2 }, // placed_reply
            .{ 511, 12, 522, 1, 2 }, // destroy_reply
        },
        .{
            .{ 4096, 0, 4104, 0, 1 }, // first
            .{ 0, 0, 8, 0, 1 }, // unchanged
            .{ 0, 0, 10, 0, 1 }, // scroll
            .{ 4096, 0, 4104, 0, 1 }, // grow
            .{ 4096, 0, 4102, 0, 1 }, // options_prepare
            .{ 0, 0, 8, 0, 1 }, // options_color
            .{ 4096, 0, 4102, 0, 1 }, // measure_text
            .{ 0, 0, 8, 0, 1 }, // measure_same_text
            .{ 4096, 0, 4102, 0, 1 }, // editor_cursor
            .{ 4096, 0, 4103, 0, 1 }, // hidden
            .{ 0, 0, 8, 0, 1 }, // hidden_unchanged
            .{ 4096, 0, 4103, 0, 1 }, // cancelled
            .{ 8192, 0, 8204, 1, 2 }, // stale_reply
            .{ 8192, 0, 8204, 1, 2 }, // stale_requester
            .{ 8192, 0, 8204, 1, 2 }, // placed_reply
            .{ 8191, 12, 8202, 1, 2 }, // destroy_reply
        },
    };
    // VERIFY changes no count.
    for ([_]bool{ false, true }) |verify| {
        var all: [sizes.len][std.meta.fields(Frame).len][5]u64 = undefined;
        for (sizes, &all) |n, *actual| {
            const f = try Fixture.init(testing.allocator, 8, 4, .{ .limits = .{ .object_capacity = 8192 } });
            defer f.deinit();
            if (verify) try f.owner.sceneSetDebugFlags(f.id, c.OT_SCENE_DEBUG_VERIFY);
            const viewport = try f.owner.sceneCreateNode(f.id, 1, 2);
            try f.owner.sceneSetStyle(viewport, 4, 0, 0, 1, 4, 1);
            try f.owner.sceneSetStyle(viewport, 4, 1, 0, 1, 2, 1);
            try f.owner.sceneSetStyle(viewport, 0, c.OT_STYLE_ENUM_OVERFLOW, 0, 0, c.OT_OVERFLOW_HIDDEN, 0);
            try f.owner.sceneMoveNode(viewport, f.root, 0);
            const content = try f.owner.sceneCreateNode(f.id, 1, 3);
            try f.owner.sceneSetStyle(content, c.OT_STYLE_FLOAT, c.OT_STYLE_FLOAT_FLEX_SHRINK, 0, 0, 0, 0);
            try f.owner.sceneMoveNode(content, viewport, 0);
            try f.owner.sceneSetViewport(content, viewport);
            const rows = try testing.allocator.alloc(context.Handle, n);
            defer testing.allocator.free(rows);
            // One culled row is an editor.
            const edit = try f.owner.createEditBuffer(.unicode);
            try f.owner.editSetText(edit, "ab", false);
            for (rows, 0..) |*row_handle, index| {
                const editor = index == n / 2 + 2;
                const row = try f.owner.sceneCreateNode(f.id, if (editor) c.OT_SCENE_EDITOR else c.OT_SCENE_TEXT, @intCast(4 + index));
                row_handle.* = row;
                if (editor) {
                    try f.owner.sceneSetEditorView(row, try f.owner.createEditorView(edit, 1, 1));
                } else try f.owner.sceneSetText(row, &.{'a' + @as(u8, @intCast(index % 26))});
                try f.owner.sceneSetStyle(row, c.OT_STYLE_FLOAT, c.OT_STYLE_FLOAT_FLEX_SHRINK, 0, 0, 0, 0);
                try f.owner.sceneSetStyle(row, 4, 0, 0, 1, 8, 1);
                try f.owner.sceneMoveNode(row, content, @intCast(index));
            }
            const culled = rows[n / 2];
            for (std.enums.values(Frame)) |frame| {
                const w = switch (frame) {
                    .first, .unchanged, .hidden_unchanged => try presentWork(f, .{}),
                    .scroll => blk: {
                        try f.owner.scenePatchPaint(content, c.OT_SCENE_PROPERTY_TRANSLATE_Y, .{ .translateY = -1 });
                        break :blk try presentWork(f, .{});
                    },
                    // A culled row grows: the frame solves.
                    .grow => blk: {
                        try f.owner.sceneSetStyle(rows[n - 1], 4, 1, 0, 1, 2, 1);
                        break :blk try presentWork(f, .{});
                    },
                    .options_prepare => blk: {
                        try f.owner.sceneSetTextOptions(culled, .{ .truncate = true });
                        break :blk try presentWork(f, .{});
                    },
                    // A color change on a culled row prepares nothing.
                    .options_color => blk: {
                        try f.owner.sceneSetTextOptions(culled, .{ .truncate = true, .foreground = .{ 1, 2, 3, 255 } });
                        break :blk try presentWork(f, .{});
                    },
                    // Text replaced on a culled row without a Yoga measure function does not solve.
                    .measure_text => blk: {
                        try f.owner.sceneSetMeasure(rows[n / 2 + 1], null);
                        _ = try presentWork(f, .{});
                        try f.owner.sceneSetText(rows[n / 2 + 1], "zz");
                        break :blk try presentWork(f, .{});
                    },
                    // The same bytes again: the write keeps the Yoga measure (no solve) and leaves the view
                    // prepared, so nothing is stale.
                    .measure_same_text => blk: {
                        try f.owner.sceneSetText(rows[n / 2 + 1], "zz");
                        const result = try presentWork(f, .{});
                        try testing.expect(!(try f.owner.raw().getRenderable(rows[n / 2 + 1])).scene_node.?.text.?.view.virtual_lines_dirty);
                        try testing.expectEqual(@as(u64, 0), result.yoga_solves);
                        break :blk result;
                    },
                    // A cursor move in a culled editor between frames.
                    .editor_cursor => blk: {
                        try f.owner.editSetCursor(edit, 0, 1);
                        break :blk try presentWork(f, .{});
                    },
                    // A hidden row at the top overlaps the viewport with its zeroed layout.
                    .hidden => blk: {
                        try f.owner.scenePatchPaint(content, c.OT_SCENE_PROPERTY_TRANSLATE_Y, .{ .translateY = 0 });
                        try f.owner.sceneSetStyle(rows[0], c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_DISPLAY, 0, 0, c.OT_DISPLAY_NONE, 0);
                        break :blk try presentWork(f, .{});
                    },
                    // A culled row's RESIZE request, cancelled; the next frame does not solve.
                    .cancelled => blk: {
                        try f.owner.sceneSetHooks(rows[n - 2], c.OT_SCENE_HOOK_RESIZE, 1, 8, 1);
                        try f.owner.sceneSetStyle(rows[n - 2], 4, 1, 0, 1, 2, 1);
                        const request = try f.step(null, options, c.OT_SCENE_FRAME_RESIZE, rows[n - 2]);
                        try f.owner.sceneFrameCancel(f.id, request.frame_id);
                        break :blk try presentStepped(f, NoReply{});
                    },
                    // A culled row's RESIZE reply changes text options on an already refreshed row.
                    .stale_reply => blk: {
                        try f.owner.sceneSetStyle(rows[n - 2], 4, 1, 0, 1, 3, 1);
                        break :blk try presentStepped(f, StaleReply{ .target = culled, .truncate = false });
                    },
                    // ... or on the requesting row itself.
                    .stale_requester => blk: {
                        try f.owner.sceneSetTextOptions(rows[n - 2], .{});
                        try f.owner.sceneSetStyle(rows[n - 2], 4, 1, 0, 1, 1, 1);
                        break :blk try presentStepped(f, StaleReply{ .target = rows[n - 2] });
                    },
                    // ... or destroys the last row, whose refresh is still queued.
                    // ... or on a row moved in place, which refreshes as placed before the batch.
                    .placed_reply => blk: {
                        try f.owner.sceneSetTextOptions(rows[n - 2], .{});
                        try f.owner.sceneSetStyle(rows[n - 2], 4, 1, 0, 1, 2, 1);
                        try f.owner.sceneMoveNode(rows[n - 2], content, @intCast(n - 2));
                        const result = try presentStepped(f, StaleReply{ .target = rows[n - 2] });
                        try testing.expect((try f.owner.raw().getRenderable(rows[n - 2])).scene_node.?.text.?.view.truncation_applied);
                        break :blk result;
                    },
                    .destroy_reply => blk: {
                        try f.owner.sceneSetStyle(rows[n - 2], 4, 1, 0, 1, 3, 1);
                        break :blk try presentStepped(f, StaleReply{ .target = rows[n - 1], .destroy = true });
                    },
                };
                actual[@intFromEnum(frame)] = .{ w.viewport_child_refreshes, w.visibility_steps, w.view_preparations, w.host_requests, w.layout_rounds };
            }
        }
        try testing.expectEqual(expected, all);
    }
}

// The bench's scenes at small sizes. Columns: every FrameWork field after work_frame_id, in
// declaration order (candidate visits through damage rows). Track B steps change these rows.
// Unchanged frames paint and diff nothing (B3); the scroll scene's status text is as tall as
// the screen, so its glyph damages every row. A recorded frame follows a recorded frame, so it
// has no retained frame to compare with.
test "Scene frame bench scenes pin each frame kind's work at small sizes" {
    const bench = @import("../bench/scene-frame_bench.zig");
    const rows = [_]struct { shape: bench.Shape, size: u32, change: bench.Change, work: [18]u64 }{
        .{ .shape = .ui, .size = 0, .change = .unchanged, .work = .{ 0, 0, 87, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0 } },
        .{ .shape = .ui, .size = 0, .change = .glyph, .work = .{ 87, 0, 87, 87, 1, 0, 0, 0, 0, 86, 9009, 10000, 1, 1, 0, 0, 1, 1 } },
        .{ .shape = .ui, .size = 0, .change = .update_hook, .work = .{ 87, 87, 174, 0, 0, 348, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0 } },
        .{ .shape = .ui, .size = 0, .change = .paint_hook, .work = .{ 87, 87, 87, 0, 0, 0, 0, 0, 0, 86, 9009, 10000, 50, 0, 16, 1, 1, 50 } },
        .{ .shape = .boxes, .size = 100, .change = .unchanged, .work = .{ 0, 0, 101, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0 } },
        .{ .shape = .boxes, .size = 100, .change = .background, .work = .{ 0, 0, 101, 0, 0, 0, 0, 0, 0, 100, 1, 6160, 1, 1, 0, 0, 1, 1 } },
        .{ .shape = .scroll, .size = 100, .change = .unchanged, .work = .{ 104, 104, 58, 0, 0, 217, 0, 0, 200, 0, 0, 0, 0, 0, 0, 0, 1, 0 } },
        .{ .shape = .scroll, .size = 100, .change = .glyph, .work = .{ 104, 104, 158, 104, 1, 217, 0, 100, 200, 53, 10000, 10000, 50, 1, 0, 0, 1, 50 } },
        .{ .shape = .scroll, .size = 100, .change = .scroll, .work = .{ 104, 104, 108, 0, 0, 217, 0, 0, 200, 53, 10000, 10000, 50, 50, 0, 0, 1, 50 } },
        .{ .shape = .scroll, .size = 100, .change = .append, .work = .{ 106, 106, 160, 106, 1, 219, 0, 102, 204, 53, 10000, 10000, 50, 0, 0, 0, 1, 50 } },
        .{ .shape = .wrapped_scroll, .size = 20, .change = .unchanged, .work = .{ 70, 70, 80, 0, 0, 281, 0, 0, 40, 0, 0, 0, 0, 0, 0, 0, 1, 0 } },
    };
    for (rows) |row| {
        var target = try bench.Scene.init(testing.allocator, testing.io, row.shape, row.size);
        defer target.deinit();
        // The second changed frame: the first one also settles hooks registered by the change.
        _ = try target.frame(row.change);
        const w = try target.frame(row.change);
        var actual: [18]u64 = undefined;
        inline for (std.meta.fields(FrameWork)[1..], 0..) |field, index| actual[index] = @field(w, field.name);
        try testing.expectEqual(row.work, actual);
    }
}
