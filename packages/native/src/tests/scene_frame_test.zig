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

pub fn drain(owner: *context.Context, id: context.Handle) !void {
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
    f.cli.pendingSplitFooterTransition = .{ .mode = .clear_stale_rows, .source_top_line = 1, .source_height = 1, .target_top_line = 1, .target_height = 1 };
    try testing.expectError(error.SplitRenderPending, f.owner.sceneFrameCommit(f.id, frame, true));
    f.cli.pendingSplitFooterTransition = .{};
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

/// The steady work of the two-member scene below: the fill (row 0, 2 cells) and the text (row
/// 1, 8 cells). A full frame repaints both; one damaged row clears and repaints only its
/// member's row (B4); a frame without damage skips paint. Only a frame that walks prepares
/// views (B5b).
fn plainWork(frame_id: u64, visits: u64, reads: u64, solves: u64, rows_compared: u64, rows_diffed: u64, reasons: u32, damage: u32) FrameWork {
    const painted = damage != 0;
    const band: ?u64 = if (damage == 1) (if (visits == 0) 2 else 8) else null;
    return .{
        .work_frame_id = frame_id,
        .candidate_visits = visits,
        .geometry_reads = reads,
        .yoga_solves = solves,
        .view_preparations = if (visits != 0) 3 else 0,
        .members_painted = if (band != null) 1 else if (painted) 2 else 0,
        .member_cells = band orelse if (painted) 10 else 0,
        .cells_cleared = if (band != null) 8 else if (painted) 16 else 0,
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
    // The forced first frame merges the scene's reasons with the encoder's. Forced frames walk
    // but keep their lists, so the next frame reuses them, as unchanged and paint-only frames do.
    // Unchanged frames paint nothing and diff no row; a changed member's row is the only one diffed.
    try f.owner.sceneSetDebugFlags(f.id, c.OT_SCENE_DEBUG_FULL_FRAME);
    try testing.expectEqual(plainWork(1, 3, 3, 1, 0, 2, FrameWork.full_path_forced | FrameWork.full_path_screen | FrameWork.full_path_unretained, 2), try presentWork(f, .{}));
    try testing.expectEqual(plainWork(2, 3, 0, 0, 2, 0, FrameWork.full_path_forced, 2), try presentWork(f, .{}));
    try f.owner.sceneSetDebugFlags(f.id, 0);
    try testing.expectEqual(plainWork(3, 0, 0, 0, 0, 0, 0, 0), try presentWork(f, .{}));
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

const Retained = enum { unchanged, scroll, scroll_same, scroll_grow, scroll_colors, scroll_arrow, focus, blur, register, destroy_style, unbind, rebind, select, reset, styled_text, text_options, view_paint_off, view_paint_on, box_details, arrow, slider, editor_select, editor_rebind, editor_unbind, z_order, surface_write, resend, same_width, sub_cell, palette, draft_write, session_draw, lease_next, lease_current, raw_render, skipped_commit, width_method, preserve, recorded, image };

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

// Band paint (B4) on a 6 x 52 screen: a text on every third row and a translucent box under
// rows 1-4. Each row changes some members and expects the damaged rows, then the cells
// cleared, members painted, and member cells of their bands. Runs one row apart merge, and
// the sixteenth band takes every run after it. The table runs without VERIFY, then with it.
test "Scene frame band frames clear and paint only the damaged rows' members" {
    const Change = struct { texts: []const usize = &.{}, box: bool = false, work: [4]u64 };
    const all = comptime blk: {
        var indexes: [18]usize = undefined;
        for (&indexes, 0..) |*index, value| index.* = value;
        break :blk indexes;
    };
    const rows = [_]Change{
        .{ .work = .{ 0, 0, 0, 0 } },
        // One glyph: its row only.
        .{ .texts = &.{0}, .work = .{ 1, 6, 1, 6 } },
        // The box meets the text's band and paints only its row there.
        .{ .texts = &.{1}, .work = .{ 1, 6, 2, 12 } },
        .{ .texts = &.{ 0, 2 }, .work = .{ 2, 12, 2, 12 } },
        // The box (rows 1-4) and row 6 merge across row 5.
        .{ .texts = &.{2}, .box = true, .work = .{ 5, 36, 3, 36 } },
        .{ .texts = &all, .work = .{ 18, 132, 19, 114 } },
    };
    var results: [2][rows.len][4]u64 = undefined;
    for ([_]bool{ false, true }, &results) |verify, *counts| {
        const f = try Fixture.init(testing.allocator, 6, 52, .{});
        defer f.deinit();
        if (verify) try f.owner.sceneSetDebugFlags(f.id, c.OT_SCENE_DEBUG_VERIFY);
        const box = try placedAt(f, f.root, c.OT_SCENE_BOX, 2, 0, 1, 6, 4);
        try f.owner.sceneSetPaint(box, .{ .background = .{ 0, 90, 0, 128 } });
        var texts: [all.len]context.Handle = undefined;
        for (&texts, 0..) |*text, index| {
            text.* = try placedAt(f, f.root, c.OT_SCENE_TEXT, @intCast(3 + index), 0, @floatFromInt(3 * index), 6, 1);
            try f.owner.sceneSetText(text.*, "hello");
        }
        _ = try presentWork(f, .{});
        for (rows, counts, 0..) |row, *count, index| {
            for (row.texts) |text| try f.owner.sceneSetText(texts[text], ([_][]const u8{ "a", "b", "c", "d", "e", "f" })[index]);
            if (row.box) try f.owner.sceneSetPaint(box, .{ .background = .{ 0, 60, 0, 128 } });
            const w = try presentWork(f, .{});
            count.* = .{ w.damage_rows, w.cells_cleared, w.members_painted, w.member_cells };
            try testing.expectEqual(row.work, count.*);
        }
        // A kept row that a full repaint would change fails a verified band frame.
        if (!verify) continue;
        for ([_]*@import("../buffer.zig").OptimizedBuffer{ f.cli.getNextBuffer(), f.cli.currentRenderBuffer }) |target| try target.drawText("X", 0, 50, ansi.rgbColor(255, 255, 255, 255), null, 0);
        try f.owner.sceneSetText(texts[0], "z");
        try testing.expectError(error.RetainedMismatch, f.owner.scenePaint(f.id, options.background, true, 0));
    }
    try testing.expectEqual(results[0], results[1]);
    // A scroll node's bars paint on the band only, under a later box that covers them elsewhere.
    const f = try Fixture.init(testing.allocator, 4, 4, .{});
    defer f.deinit();
    try f.owner.sceneSetDebugFlags(f.id, c.OT_SCENE_DEBUG_VERIFY);
    const scroll = try placedAt(f, f.root, c.OT_SCENE_BOX, 2, 0, 0, 2, 4);
    try f.owner.sceneSetScroll(scroll, .{});
    for (0..6) |index| try f.owner.sceneSetStyle(try placedAt(f, scroll, c.OT_SCENE_BOX, @intCast(3 + index), 0, 0, 1, 1), 0, 6, 0, 0, 0, 0);
    const cover = try placedAt(f, f.root, c.OT_SCENE_BOX, 10, 1, 2, 1, 1);
    try f.owner.sceneSetPaint(cover, .{ .background = .{ 90, 0, 0, 255 } });
    const label = try placedAt(f, f.root, c.OT_SCENE_TEXT, 11, 2, 0, 2, 1);
    try f.owner.sceneSetText(label, "a");
    _ = try presentWork(f, .{});
    try f.owner.sceneSetText(label, "b");
    const w = try presentWork(f, .{});
    try testing.expectEqual(@as(u64, 4), w.cells_cleared);
    try testing.expectEqual(@as(u8, 90), ansi.red(f.cli.currentRenderBuffer.get(1, 2).?.bg));
}

const BandCase = enum { space_border_tall, space_border_tracker, hooked_body, hooked_after, surface, offscreen_view, offscreen_view_self };

/// Paints a 6 x 4 scene twice, changing one text in between, and returns the hash of the
/// second draft's cells and the presented cells, and the state of a text view below the screen.
fn bandCase(case: BandCase, flags: u32) ![3]u64 {
    const f = try Fixture.init(testing.allocator, 6, 4, .{});
    defer f.deinit();
    try f.owner.sceneSetDebugFlags(f.id, flags);
    // The text that changes: row 0, or row 2 for the shapes whose band lies below row 0.
    const row: f32 = if (case == .space_border_tall or case == .hooked_body) 0 else 2;
    const text = try placedAt(f, f.root, c.OT_SCENE_TEXT, 2, 0, row, 6, 1);
    try f.owner.sceneSetText(text, "abcdef");
    const box = try placedAt(f, f.root, c.OT_SCENE_BOX, 3, 0, row, 6, if (case == .space_border_tracker) 1 else 4 - row);
    switch (case) {
        // A transparent border of spaces over the text keeps its glyphs, also where the band
        // cuts the box's corners or a wide glyph on a kept row fills the trackers.
        .space_border_tall, .space_border_tracker => {
            try f.owner.sceneSetPaint(box, .{ .borderSides = c.OT_BORDER_TOP, .background = .{ 0, 0, 0, 0 }, .borderColor = .{ 255, 0, 0, 255 } });
            try f.owner.sceneSetBoxDetails(box, .{ .custom_border_chars = [_]u32{' '} ** 11 });
            if (case == .space_border_tracker) try f.owner.sceneSetText(try placedAt(f, f.root, c.OT_SCENE_TEXT, 4, 0, 0, 6, 1), "\u{4e16}x");
        },
        // A hooked translucent box under rows 0-3 that the band meets in part: its body and
        // phases after its BEFORE phase stay in the band.
        .hooked_body, .hooked_after, .offscreen_view, .offscreen_view_self => {
            try f.owner.sceneMoveNode(box, f.root, 0);
            try f.owner.sceneSetStyle(box, 4, 1, 0, 1, 4, 1);
            try f.owner.sceneSetPositions(box, 3, .{ 1, 1, 0, 0 }, .{ 0, 0, 0, 0 });
            try f.owner.sceneSetPaint(box, .{ .background = .{ 0, 90, 0, 128 } });
            try f.owner.sceneSetHooks(box, c.OT_SCENE_HOOK_RENDER_BEFORE | c.OT_SCENE_HOOK_RENDER_AFTER, 1, 0, 0);
            // A later box covers row 0, where the AFTER phase draws.
            if (case == .hooked_after) try f.owner.sceneSetPaint(try placedAt(f, f.root, c.OT_SCENE_BOX, 5, 0, 0, 6, 1), .{ .background = .{ 90, 0, 0, 255 } });
        },
        // A surface with transparent cells repaints with the text's band, and a later wide glyph
        // on a kept row fills the trackers: the copy does not depend on them.
        .surface => {
            const custom = try placedAt(f, f.root, c.OT_SCENE_CUSTOM, 6, 0, 1, 6, 1);
            const surface = try f.owner.createBuffer(6, 1, .{});
            try f.owner.drawBufferText(surface, "s", 2, 0, ansi.rgbColor(255, 255, 255, 255), null, 0);
            try f.owner.sceneSetSurface(custom, surface);
            try f.owner.sceneSetText(try placedAt(f, f.root, c.OT_SCENE_TEXT, 4, 0, 0, 6, 1), "\u{4e16}x");
        },
    }
    // A text view below the screen, which a RECORD reply rebinds and resizes: the recorded frame
    // prepares the view as a full repaint does, unless a SELF hook replaces its body.
    const offscreen = case == .offscreen_view or case == .offscreen_view_self;
    const shared = try f.owner.createTextBuffer(.unicode);
    try f.owner.textBufferSetText(shared, "below");
    const below = try placedAt(f, f.root, c.OT_SCENE_TEXT_VIEW, 7, 0, 10, 6, 1);
    if (offscreen) try f.owner.sceneSetTextView(below, try f.owner.createTextBufferView(shared));
    if (case == .offscreen_view_self) try f.owner.sceneSetHooks(below, c.OT_SCENE_HOOK_RENDER_SELF, 1, 0, 0);
    var hashes: [3]u64 = undefined;
    for ([_][]const u8{ "abcdef", "ghijkl" }) |value| {
        try f.owner.sceneSetText(text, value);
        var request = try f.owner.sceneFrameStep(f.id, null, options);
        while (request.kind != c.OT_SCENE_FRAME_DONE) {
            if (offscreen) {
                try f.owner.sceneSetTextView(below, try f.owner.createTextBufferView(shared));
                try f.owner.sceneSetStyle(below, 4, 0, 0, 1, if (value[0] == 'a') 5 else 6, 1);
            }
            var recording: Recording = .{};
            const slots = try f.owner.sceneFramePaintSlots(f.id, request);
            for (slots, 0..) |slot, index| if (slot.num == 3) {
                recording.slot(@intCast(index), c.OT_SCENE_RECORD_PHASE_BEFORE);
                recording.fill(0, if (case == .hooked_body) 0 else 2, 1, .{ 0, 0, 200, 255 });
                recording.slot(@intCast(index), c.OT_SCENE_RECORD_PHASE_AFTER);
                recording.text("h", 1, 0);
            };
            request = try f.owner.sceneFrameStepWithRecording(f.id, request, options, recording.view());
        }
        hashes[0] = cellsHash(f.cli.getNextBuffer());
        _ = try f.owner.sceneFrameCommit(f.id, request, false);
        try drain(f.owner, f.id);
    }
    hashes[1] = cellsHash(f.cli.currentRenderBuffer);
    hashes[2] = 0;
    if ((try f.owner.raw().getRenderable(below)).scene_node.?.control.text_view.view) |view| {
        const viewport = view.view.getViewport();
        hashes[2] = @as(u64, @intFromBool(view.view.virtual_lines_dirty)) | (if (viewport) |port| 2 | @as(u64, port.width) << 8 | @as(u64, port.height) << 24 else 0);
    }
    // The second frame is a band frame: it clears the changed text's row only, and the
    // surface's row, which repaints on every frame.
    if (flags != c.OT_SCENE_DEBUG_FULL_FRAME) try testing.expectEqual(@as(u64, if (case == .surface) 12 else 6), f.state.frame_work.cells_cleared);
    return hashes;
}

fn cellsHash(target: *const @import("../buffer.zig").OptimizedBuffer) u64 {
    var hash = std.hash.Wyhash.init(0);
    inline for (.{ target.buffer.char, target.buffer.fg, target.buffer.bg, target.buffer.attributes }) |slice| hash.update(std.mem.sliceAsBytes(slice));
    return hash.final();
}

// Band frames draw what a full repaint draws, in the draft and on the screen, with and without
// VERIFY, where a primitive's fast path depends on its scissor or on other rows' cells, and
// where a hook's phases re-enter their member's scissor.
test "Scene frame band frames paint what a full repaint paints" {
    for (std.enums.values(BandCase)) |case| {
        errdefer std.debug.print("case {s}\n", .{@tagName(case)});
        const full = try bandCase(case, c.OT_SCENE_DEBUG_FULL_FRAME);
        try testing.expectEqual(full, try bandCase(case, 0));
        try testing.expectEqual(full, try bandCase(case, c.OT_SCENE_DEBUG_VERIFY));
    }
}

// Retained paint (B3) on a 10 x 9 screen: a box (rows 0-2), a text (row 3), a text view of a
// styled shared buffer (row 4), an editor (row 5), a surface taller than its node (rows 6-7),
// an arrow and a slider (row 8), at column 8 a parent (row 0) whose child (rows 2-3) paints under a
// later sibling, and below them a scroll node (rows 4-7) of six rows. Each row changes one input and expects the rows it damages and the full-path
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
    const slider = try placedAt(f, f.root, c.OT_SCENE_SLIDER, 30, 2, 8, 4, 1);
    const scroll = try placedAt(f, f.root, c.OT_SCENE_BOX, 12, 8, 4, 2, 4);
    try f.owner.sceneSetScroll(scroll, .{});
    for (0..6) |index| {
        const row = try placedAt(f, scroll, c.OT_SCENE_BOX, @intCast(13 + index), 0, 0, 1, 1);
        try f.owner.sceneSetStyle(row, 0, 6, 0, 0, 0, 0);
        try f.owner.sceneSetPaint(row, .{ .background = .{ 0, 0, @intCast(40 * index), 255 } });
    }
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
        // A scroll repaints the scroll node's rows; a scroll that moves nothing repaints none.
        .{ .change = .scroll, .damage = 4 },
        .{ .change = .scroll_same, .damage = 2 },
        // A row added below the viewport paints nothing but moves the thumb.
        .{ .change = .scroll_grow, .damage = 4 },
        // Later options and arrows repaint the scroll node.
        .{ .change = .scroll_colors, .damage = 4 },
        .{ .change = .scroll_arrow, .damage = 4 },
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
        .{ .change = .slider, .damage = 3 },
        .{ .change = .editor_select, .damage = 3 },
        .{ .change = .editor_rebind, .damage = 3 },
        .{ .change = .editor_unbind, .damage = 3 },
        // Paint order is an input: the reordered child, the sibling it now covers, and the
        // arrow and the scroll node after them repaint.
        .{ .change = .z_order, .damage = 8 },
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
        // A hook draws outside its node's rows: removing it repaints its node's rows through
        // the last row its recording wrote.
        .{ .change = .recorded, .damage = 6 },
        // The first image takes the full path although only its rows changed.
        .{ .change = .image, .damage = 9, .reasons = FrameWork.full_path_images },
    };
    var image_node: context.Handle = undefined;
    comptime std.debug.assert(rows.len + 3 <= std.meta.fields(Retained).len + 6);
    for (rows, 0..) |row, row_index| {
        errdefer std.debug.print("row {s}, verify {}\n", .{ @tagName(row.change), verify });
        switch (row.change) {
            .unchanged => {},
            .scroll, .scroll_same => _ = try f.owner.sceneScrollTo(scroll, .{ 0, 1 }, .{ false, false }, false),
            .scroll_colors => try f.owner.sceneSetScroll(scroll, .{ .bars = .{ .{}, .{ .background = .{ 0, 60, 0, 255 } } } }),
            .scroll_arrow => try f.owner.sceneSetScrollArrow(scroll, 1, 0, .{ .text = "^" }),
            .scroll_grow => {
                const added = try placedAt(f, scroll, c.OT_SCENE_BOX, 19, 0, 0, 1, 1);
                try f.owner.sceneSetStyle(added, 0, 6, 0, 0, 0, 0);
            },
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
            .slider => try f.owner.sceneSetSlider(slider, .{ .value = 70 }),
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
                recording.text("h", 9, 8);
                const done = try f.owner.sceneFrameStepWithRecording(f.id, request, options, recording.view());
                _ = try f.owner.sceneFrameCommit(f.id, done, false);
                try drain(f.owner, f.id);
                try testing.expectEqual(@as(u32, 'h'), f.cli.currentRenderBuffer.get(9, 8).?.char);
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
            .recorded => try testing.expectEqual(@as(u32, ' '), f.cli.currentRenderBuffer.get(9, 8).?.char),
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

// 358: arrow text runs past its node's rect, here a rect wholly left of the 6 x 4 screen, more
// than the screen's width away. A 1x1 arrow at x = -7 draws "ABCDEFGH", so H is in column 0, row
// 1; a 4x2 scroll box at x = -4 draws its right arrow "ABCD" from column -1, so B is in column 0,
// row 2. A text at column 2 shares the row: changing it makes a band that clears the arrow's row.
// A text beside the screen on that row draws nothing, so its change damages no row. Each row
// expects the damaged rows.
test "Scene frame retained paint repaints arrow text outside its rect" {
    const Change = enum { none, text, color, move, band, beside };
    const rows = [_]struct { scrollbar: bool, change: Change, height: f32 = 1, damage: u32 }{
        .{ .scrollbar = false, .change = .none, .damage = 0 },
        .{ .scrollbar = false, .change = .text, .damage = 1 },
        .{ .scrollbar = false, .change = .color, .damage = 1 },
        .{ .scrollbar = false, .change = .move, .damage = 2 },
        .{ .scrollbar = false, .change = .band, .damage = 1 },
        .{ .scrollbar = false, .change = .beside, .damage = 0 },
        // Every member lays out at least one row tall, so the text stays on the rect's rows.
        .{ .scrollbar = false, .change = .text, .height = 0, .damage = 1 },
        .{ .scrollbar = true, .change = .none, .damage = 0 },
        .{ .scrollbar = true, .change = .text, .damage = 2 },
        .{ .scrollbar = true, .change = .color, .damage = 2 },
        .{ .scrollbar = true, .change = .move, .damage = 3 },
        .{ .scrollbar = true, .change = .band, .damage = 1 },
    };
    const red = ansi.rgbColor(255, 0, 0, 255);
    for (rows) |row| {
        errdefer std.debug.print("scrollbar {} change {s} height {d}\n", .{ row.scrollbar, @tagName(row.change), row.height });
        const f = try Fixture.init(testing.allocator, 6, 4, .{});
        defer f.deinit();
        try f.owner.sceneSetDebugFlags(f.id, c.OT_SCENE_DEBUG_VERIFY);
        const y: u32 = if (row.scrollbar) 2 else 1;
        const node = try placedAt(f, f.root, if (row.scrollbar) c.OT_SCENE_BOX else c.OT_SCENE_ARROW, 2, if (row.scrollbar) -4 else -7, 1, if (row.scrollbar) 4 else 1, if (row.scrollbar) 2 else row.height);
        const label = try placedAt(f, f.root, c.OT_SCENE_TEXT, 3, 2, @floatFromInt(y), 4, 1);
        try f.owner.sceneSetText(label, "a");
        const aside = try placedAt(f, f.root, c.OT_SCENE_TEXT, 4, -7, @floatFromInt(y), 6, 1);
        try f.owner.sceneSetText(aside, "a");
        if (row.scrollbar) try f.owner.sceneSetScroll(node, .{ .axes = c.OT_SCENE_SCROLL_X | c.OT_SCENE_SCROLL_Y, .bars = .{ .{ .policy = c.OT_SCENE_SCROLL_BAR_ALWAYS, .arrows = true }, .{ .policy = c.OT_SCENE_SCROLL_BAR_NEVER } } });
        const text = [_][]const u8{ if (row.scrollbar) "ABCD" else "ABCDEFGH", if (row.scrollbar) "AXCD" else "ABCDEFGZ" };
        const glyphs = [_]u32{ if (row.scrollbar) 'B' else 'H', if (row.scrollbar) 'X' else 'Z' };
        for ([_]bool{ false, true }) |changed| {
            const next = changed and row.change == .text;
            const arrow: scene.ArrowOptions = .{ .text = text[@intFromBool(next)], .foreground = if (changed and row.change == .color) red else ansi.rgbColor(255, 255, 255, 255) };
            if (!changed or row.change == .text or row.change == .color) {
                if (row.scrollbar) try f.owner.sceneSetScrollArrow(node, 0, 1, arrow) else try f.owner.sceneSetArrow(node, arrow);
            }
            if (changed and row.change == .move) try f.owner.scenePatchPaint(node, c.OT_SCENE_PROPERTY_TRANSLATE_Y, .{ .translateY = 1 });
            if (changed and row.change == .band) try f.owner.sceneSetText(label, "b");
            if (changed and row.change == .beside) try f.owner.sceneSetText(aside, "b");
            const w = try presentWork(f, .{});
            const moved = changed and row.change == .move;
            const cell = f.cli.currentRenderBuffer.get(0, y + @intFromBool(moved)).?;
            try testing.expectEqual(glyphs[@intFromBool(next)], cell.char);
            try testing.expectEqual(arrow.foreground, cell.fg);
            if (moved) try testing.expectEqual(@as(u32, ' '), f.cli.currentRenderBuffer.get(0, y).?.char);
            if (changed) try testing.expectEqual(row.damage, w.damage_rows);
        }
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
    for (std.enums.values(enum { hide_parent, detach, into_hidden, hide_root, queued_sibling })) |reply| {
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
        // A later sibling whose update is queued when the reply moves it drops that update.
        const sibling = try f.owner.sceneCreateNode(f.id, 1, 5);
        if (reply == .queued_sibling) try f.owner.sceneMoveNode(sibling, holder, 1);
        try f.owner.sceneSetHooks(sibling, c.OT_SCENE_HOOK_UPDATE, 1, 0, 0);
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
                .queued_sibling => {
                    try f.owner.sceneMoveNode(sibling, hidden, 0);
                    request = try f.step(request, options, c.OT_SCENE_FRAME_UPDATE, child);
                },
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

// Frames that keep their preparation hold node pointers across host replies. A reply that
// destroys the hooked node, or its parent, must leave no pointer to its storage, which the
// node pool gives to the next node; a list entry left behind fails on the null scene node. The
// parent's other queued child, now detached, is dropped.
test "Scene preparation drops destroyed nodes from UPDATE and RECORD replies" {
    for ([_]u32{ c.OT_SCENE_HOOK_UPDATE, c.OT_SCENE_HOOK_RENDER_AFTER }) |hook| for ([_]bool{ false, true }) |parent_destroyed| {
        const f = try Fixture.init(testing.allocator, 4, 2, .{});
        defer f.deinit();
        try f.owner.sceneSetDebugFlags(f.id, c.OT_SCENE_DEBUG_VERIFY);
        const parent = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_BOX, 2);
        try f.owner.sceneMoveNode(parent, f.root, 0);
        const target = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_TEXT, 3);
        try f.owner.sceneSetText(target, "ab");
        try f.owner.sceneMoveNode(target, parent, 0);
        try f.owner.sceneSetHooks(target, hook, 1, 2, 1);
        // A hooked sibling after it stays queued when the reply destroys the parent.
        const sibling = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_BOX, 5);
        try f.owner.sceneMoveNode(sibling, parent, 1);
        try f.owner.sceneSetHooks(sibling, hook, 1, 2, 1);
        const kind: u32 = if (hook == c.OT_SCENE_HOOK_UPDATE) c.OT_SCENE_FRAME_UPDATE else c.OT_SCENE_FRAME_RECORD;
        for (0..4) |index| {
            var request = try f.owner.sceneFrameStep(f.id, null, options);
            while (request.kind != c.OT_SCENE_FRAME_DONE) {
                if (index == 2 and request.kind == kind and (kind == c.OT_SCENE_FRAME_RECORD or std.meta.eql(request.node, target))) try f.owner.sceneDestroyNode(if (parent_destroyed) parent else target);
                const record: ?[]const u8 = if (request.kind == c.OT_SCENE_FRAME_RECORD) &.{} else null;
                request = try f.owner.sceneFrameStepWithRecording(f.id, request, options, record);
            }
            _ = try f.owner.sceneFrameCommit(f.id, request, false);
            try drain(f.owner, f.id);
            if (index != 2) continue;
            // The released storage returns as a new node in the same place.
            const next = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_TEXT, 4);
            try f.owner.sceneSetText(next, "cd");
            try f.owner.sceneMoveNode(next, f.root, 0);
        }
        try testing.expectEqual('c', f.cli.currentRenderBuffer.get(0, 0).?.char);
        if (parent_destroyed) try f.owner.sceneDestroyNode(target);
        try f.owner.sceneDestroyNode(sibling);
    };
}

/// Presents one frame; RECORD requests get an empty recording.
fn presentRecorded(f: Fixture) !FrameWork {
    var request = try f.owner.sceneFrameStep(f.id, null, options);
    while (request.kind != c.OT_SCENE_FRAME_DONE) {
        const record: ?[]const u8 = if (request.kind == c.OT_SCENE_FRAME_RECORD) &.{} else null;
        request = try f.owner.sceneFrameStepWithRecording(f.id, request, options, record);
    }
    _ = try f.owner.sceneFrameCommit(f.id, request, false);
    try drain(f.owner, f.id);
    return work(f);
}

// Kept lists equal what a fresh walk would list (VERIFY checks each kept frame), with no hook,
// layout feedback, or paint hooks only. A hidden node placed in a frame is listed once, for its
// first refresh, then dropped, and feedback no longer visits it. A z-index sort reorders the
// lists. A style change keeps them, but a measurement-only solve makes the next frame read
// geometry again.
test "Scene kept preparation drops hidden placements, follows sorts, and rereads measured solves" {
    // With UPDATE, feedback visits the root and the box (five operations each), not the texts.
    for ([_]u32{ 0, c.OT_SCENE_HOOK_UPDATE, c.OT_SCENE_HOOK_RENDER_AFTER }, [_]u64{ 0, 10, 0 }) |hook, operations| {
        const f = try Fixture.init(testing.allocator, 4, 2, .{});
        defer f.deinit();
        try f.owner.sceneSetDebugFlags(f.id, c.OT_SCENE_DEBUG_VERIFY);
        const box = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_BOX, 2);
        try f.owner.sceneMoveNode(box, f.root, 0);
        if (hook != 0) try f.owner.sceneSetHooks(box, hook, 1, 0, 0);
        var texts: [3]context.Handle = undefined;
        for (&texts, 0..) |*text, index| {
            text.* = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_TEXT, @intCast(3 + index));
            try f.owner.sceneSetText(text.*, "x");
            try f.owner.sceneMoveNode(text.*, box, @intCast(index));
        }
        try f.owner.sceneSetStyle(texts[2], c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_DISPLAY, 0, 0, @floatFromInt(c.OT_DISPLAY_NONE), 0);
        try testing.expect((try presentRecorded(f)).candidate_visits != 0);
        try testing.expectEqual(@as(usize, 4), f.state.candidates.items.len);
        for (0..2) |_| {
            const kept = try presentRecorded(f);
            try testing.expectEqual(@as(u64, 0), kept.candidate_visits);
            try testing.expectEqual(operations, kept.feedback_operations);
        }
        try f.owner.scenePatchPaint(texts[0], c.OT_SCENE_PROPERTY_Z_INDEX, .{ .zIndex = 1 });
        for (0..3) |_| _ = try presentRecorded(f);
        try testing.expectEqual(texts[0], f.state.members.items[f.state.members.items.len - 1].node.scene_node.?.handle);
        try testing.expectEqual(@as(u64, 0), (try presentRecorded(f)).candidate_visits);
        try f.owner.sceneSetStyle(box, 4, 0, 0, 1, 3, 1);
        try f.owner.sceneMeasureLayout(f.id, f.root);
        try testing.expect((try presentRecorded(f)).candidate_visits != 0);
        try testing.expectEqual(@as(f32, 3), (try f.owner.sceneGetLayout(box, false)).width);
        // Without UPDATE below it, the root is skipped: one feedback operation.
        if (hook == c.OT_SCENE_HOOK_UPDATE) {
            try f.owner.sceneSetHooks(box, c.OT_SCENE_HOOK_RESIZE, 2, 0, 0);
            _ = try presentRecorded(f);
            try testing.expectEqual(@as(u64, 1), (try presentRecorded(f)).feedback_operations);
        }
    }
}

const Reply = enum { later, later_descendant, earlier, all, all_continue, chain, show_hidden, move_inserted, move_in, move_under, refresh_mark, refresh_hook, refresh_move, refresh_all, refresh_then_select };

/// A parent P with children A, X1..Xn, Y in paint order. Nodes: P, A, X1..Xn, Y, then a child
/// of X1, a root child Z, and the viewport V of a filtering P. In a filtering P, A and Y lay out
/// first, so `shown` rows show A, Y, and then the X rows.
const FeedbackRow = struct { reply: Reply, n: u32 = 1, filter: bool = false, shown: f32 = 3, expected: []const usize };

fn feedbackNode(f: Fixture, nodes: []context.Handle, index: usize, kind: u32, parent: context.Handle, position: u32) !void {
    nodes[index] = try f.owner.sceneCreateNode(f.id, kind, @intCast(10 + index));
    for (0..2) |axis| try f.owner.sceneSetStyle(nodes[index], 4, @intCast(axis), 0, 1, 1, 1);
    try f.owner.sceneSetStyle(nodes[index], c.OT_STYLE_FLOAT, c.OT_STYLE_FLOAT_FLEX_SHRINK, 0, 0, 0, 0);
    try f.owner.sceneMoveNode(nodes[index], parent, position);
}

fn feedbackHook(f: Fixture, node: context.Handle, flags: u32) !void {
    const generation = (try f.owner.raw().getRenderable(node)).scene_node.?.hook_generation + 1;
    try f.owner.sceneSetHooks(node, flags, generation, 1, 1);
}

fn feedbackScene(f: Fixture, row: FeedbackRow, nodes: []context.Handle) !void {
    const y = 2 + row.n;
    const refresh = @intFromEnum(row.reply) >= @intFromEnum(Reply.refresh_mark);
    var parent = f.root;
    if (row.filter) {
        try feedbackNode(f, nodes, y + 3, c.OT_SCENE_BOX, f.root, 0);
        try f.owner.sceneSetStyle(nodes[y + 3], 4, 1, 0, 1, row.shown, 1);
        try f.owner.sceneSetStyle(nodes[y + 3], 0, c.OT_STYLE_ENUM_OVERFLOW, 0, 0, c.OT_OVERFLOW_HIDDEN, 0);
        parent = nodes[y + 3];
    }
    try feedbackNode(f, nodes, 0, c.OT_SCENE_BOX, parent, 0);
    try f.owner.sceneSetStyle(nodes[0], 4, 1, 0, c.OT_UNIT_AUTO, 0, 1);
    if (row.filter) try f.owner.sceneSetViewport(nodes[0], nodes[y + 3]);
    try feedbackNode(f, nodes, 1, c.OT_SCENE_BOX, nodes[0], 0);
    for (2..y) |index| try feedbackNode(f, nodes, index, if (refresh and index == 2) c.OT_SCENE_TEXT else c.OT_SCENE_BOX, nodes[0], @intCast(index - 1));
    if (refresh) try f.owner.sceneSetText(nodes[2], "xyz");
    try feedbackNode(f, nodes, y, c.OT_SCENE_BOX, nodes[0], 1);
    try feedbackNode(f, nodes, y + 1, c.OT_SCENE_BOX, nodes[if (refresh) 1 else 2], 0);
    try f.owner.sceneSetStyle(nodes[y + 1], c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_POSITION_TYPE, 0, 0, c.OT_POSITION_ABSOLUTE, 0);
    try feedbackNode(f, nodes, y + 2, c.OT_SCENE_BOX, f.root, 0);
    for ([_]usize{ 1, y }) |index| try feedbackHook(f, nodes[index], if (refresh) c.OT_SCENE_HOOK_RESIZE else c.OT_SCENE_HOOK_UPDATE);
    if (row.reply == .refresh_then_select) try feedbackHook(f, nodes[2], c.OT_SCENE_HOOK_UPDATE);
    // A's UPDATE reply runs before its own resize, which the frame owes.
    if (row.reply == .all_continue) try feedbackHook(f, nodes[1], c.OT_SCENE_HOOK_UPDATE | c.OT_SCENE_HOOK_RESIZE);
    if (row.reply == .show_hidden) {
        try f.owner.sceneSetStyle(nodes[2], c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_DISPLAY, 0, 0, c.OT_DISPLAY_NONE, 0);
        try feedbackHook(f, nodes[2], c.OT_SCENE_HOOK_UPDATE);
    }
}

/// Paints a frame; with `reply`, answers each request as the row says. Logs requested nodes.
fn feedbackFrame(f: Fixture, row: FeedbackRow, nodes: []const context.Handle, reply: bool, log: *std.ArrayListUnmanaged(usize)) !void {
    const y = 2 + row.n;
    var request: ?scene.FrameRequest = null;
    while (true) {
        request = try f.owner.sceneFrameStep(f.id, request, .{ .background = options.background, .use_mouse = true, .excluded_hit_num = 0, .max_layout_rounds = 8, .max_host_requests = 4096 });
        if (request.?.kind == 0) break;
        const index = request.?.num - 10;
        try log.append(testing.allocator, index);
        if (!reply) continue;
        const x = nodes[2];
        switch (row.reply) {
            .later => if (index == 1) try feedbackHook(f, x, c.OT_SCENE_HOOK_UPDATE),
            .later_descendant => if (index == 1) try feedbackHook(f, nodes[y + 1], c.OT_SCENE_HOOK_UPDATE),
            .earlier => if (index == y) try feedbackHook(f, x, c.OT_SCENE_HOOK_UPDATE),
            .all, .all_continue => if (index == 1 and (try f.owner.raw().getRenderable(x)).scene_node.?.hook_flags == 0) {
                for (nodes[2..y]) |node| try feedbackHook(f, node, c.OT_SCENE_HOOK_UPDATE);
            },
            .show_hidden => if (index == 1) try f.owner.sceneSetStyle(x, c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_DISPLAY, 0, 0, c.OT_DISPLAY_FLEX, 0),
            .chain => if (index + 1 < y) try feedbackHook(f, nodes[index + 1], c.OT_SCENE_HOOK_UPDATE),
            .move_inserted, .refresh_move => if (index == 1) {
                if (row.reply == .move_inserted) try feedbackHook(f, x, c.OT_SCENE_HOOK_UPDATE) else try f.owner.sceneSetTextOptions(x, .{ .truncate = true });
                try f.owner.sceneMoveNode(x, f.root, 1);
            },
            // Z shows again beside X1's absolute child with the box it had, so no walk marks it.
            .move_under => if (index == 1) {
                try f.owner.sceneMoveNode(nodes[y + 2], x, 0);
                try f.owner.sceneSetStyle(nodes[y + 2], c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_DISPLAY, 0, 0, c.OT_DISPLAY_FLEX, 0);
            },
            .move_in => if (index == y) {
                try f.owner.sceneMoveNode(nodes[y + 2], nodes[0], 0);
                try feedbackHook(f, nodes[y + 2], c.OT_SCENE_HOOK_UPDATE);
            },
            .refresh_mark => if (index == 1) try f.owner.sceneSetTextOptions(x, .{ .truncate = true }),
            .refresh_hook => if (index == 1) try feedbackHook(f, x, c.OT_SCENE_HOOK_UPDATE | c.OT_SCENE_HOOK_RESIZE),
            .refresh_all => if (index == 1) for (nodes[2..y]) |node| try feedbackHook(f, node, c.OT_SCENE_HOOK_RESIZE),
            .refresh_then_select => {},
        }
    }
    _ = try f.owner.sceneFrameCommit(f.id, request.?, false);
    try drain(f.owner, f.id);
}

/// Both twins hold the same public and observed geometry, resize sizes, and text views.
fn expectSameObservations(twins: [2]Fixture, nodes: [2][]context.Handle) !void {
    for (nodes[0], nodes[1]) |first, second| {
        for ([_]bool{ false, true }) |raw| {
            try testing.expectEqual(try twins[0].owner.sceneGetLayout(first, raw), try twins[1].owner.sceneGetLayout(second, raw));
        }
        const states = .{ (try twins[0].owner.raw().getRenderable(first)).scene_node.?, (try twins[1].owner.raw().getRenderable(second)).scene_node.? };
        // Composition reads only the box; refresh copies the paint position too.
        inline for (.{ "left", "top", "right", "bottom", "width", "height" }) |name| {
            try testing.expectEqual(@field(states[0].observed_layout, name), @field(states[1].observed_layout, name));
        }
        try testing.expectEqual(.{ states[0].resize_width, states[0].resize_height }, .{ states[1].resize_width, states[1].resize_height });
        if (states[0].text) |text| {
            try testing.expectEqualDeep(text.view.getViewport(), states[1].text.?.view.getViewport());
            try testing.expectEqual(text.view.truncation_applied, states[1].text.?.view.truncation_applied);
        }
    }
}

// A reply that makes a child need feedback while its parent's batch runs: the child runs in
// a later feedback pass of the same round, in paint order. The forced full-frame twin, which
// pops every child, defers it too, and both send the same requests. Rows: a later sibling gets UPDATE (a), or
// its child does (b), selected (c) or culled (d); an earlier one does (e); 1,000 siblings in
// one reply (h) and in 1,000 chained replies (i), also selected by a filtering parent; an
// inserted child moves away (g); a child moves into the running batch (m), or shows under a
// later sibling, or a hidden later sibling with UPDATE shows; a requester that still owes a
// RESIZE; a refresh batch meets a text change (f), a new hook (k), a move (l), and 60 new
// hooks; a due child follows a refresh batch (j).
test "Scene feedback runs children that replies mark in a later pass of the round" {
    const rows = [_]FeedbackRow{
        .{ .reply = .later, .expected = &.{ 1, 3, 2 } },
        .{ .reply = .later_descendant, .expected = &.{ 1, 3, 4 } },
        .{ .reply = .later, .n = 15, .filter = true, .expected = &.{ 1, 17, 2 } },
        .{ .reply = .later, .n = 15, .filter = true, .shown = 2, .expected = &.{ 1, 17 } },
        .{ .reply = .earlier, .expected = &.{ 1, 3, 2 } },
        .{ .reply = .move_inserted, .expected = &.{ 1, 3, 2 } },
        .{ .reply = .move_in, .expected = &.{ 1, 3, 5 } },
        .{ .reply = .move_under, .expected = &.{ 1, 3 } },
        .{ .reply = .all, .n = 1000, .expected = &.{} },
        .{ .reply = .chain, .n = 1000, .expected = &.{} },
        .{ .reply = .chain, .n = 60, .filter = true, .shown = 63, .expected = &.{} },
        .{ .reply = .all_continue, .n = 1000, .expected = &.{} },
        .{ .reply = .show_hidden, .n = 15, .expected = &.{ 1, 17, 2 } },
        .{ .reply = .all, .n = 60, .filter = true, .shown = 63, .expected = &.{} },
        .{ .reply = .refresh_mark, .n = 15, .filter = true, .shown = 2, .expected = &.{ 1, 17 } },
        .{ .reply = .refresh_hook, .n = 15, .filter = true, .shown = 2, .expected = &.{ 1, 17 } },
        .{ .reply = .refresh_move, .n = 15, .filter = true, .shown = 2, .expected = &.{ 1, 17 } },
        .{ .reply = .refresh_all, .n = 60, .filter = true, .shown = 2, .expected = &.{ 1, 62 } },
        .{ .reply = .refresh_then_select, .n = 15, .filter = true, .expected = &.{ 1, 17, 2 } },
    };
    for (rows) |row| {
        const twins = [2]Fixture{ try Fixture.init(testing.allocator, 4, 4, .{ .limits = .{ .object_capacity = 2048 } }), try Fixture.init(testing.allocator, 4, 4, .{ .limits = .{ .object_capacity = 2048 } }) };
        defer for (twins) |f| f.deinit();
        const nodes = [2][]context.Handle{ try testing.allocator.alloc(context.Handle, row.n + 6), try testing.allocator.alloc(context.Handle, row.n + 6) };
        defer for (nodes) |list| testing.allocator.free(list);
        var logs: [2]std.ArrayListUnmanaged(usize) = .{ .empty, .empty };
        defer for (&logs) |*log| log.deinit(testing.allocator);
        var steps: u64 = 0;
        for (twins, nodes, &logs, 0..) |f, list, *log, twin| {
            try f.owner.sceneSetDebugFlags(f.id, if (twin == 0) c.OT_SCENE_DEBUG_FULL_FRAME else c.OT_SCENE_DEBUG_VERIFY);
            try feedbackScene(f, row, list);
            try feedbackFrame(f, row, list, false, log);
            // Hidden, Z leaves the lists.
            if (row.reply == .move_under) {
                try f.owner.sceneSetStyle(list[row.n + 4], c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_DISPLAY, 0, 0, c.OT_DISPLAY_NONE, 0);
                try feedbackFrame(f, row, list, false, log);
            }
            log.clearRetainingCapacity();
            // A refresh row's A and Y resize, so the frame refreshes them before selection.
            if (@intFromEnum(row.reply) >= @intFromEnum(Reply.refresh_mark)) {
                for ([_]usize{ 1, 2 + row.n }) |index| try f.owner.sceneSetStyle(list[index], 4, 0, 0, 1, 2, 1);
            }
            if (row.reply == .all_continue) try f.owner.sceneSetStyle(list[1], 4, 0, 0, 1, 2, 1);
            steps = f.state.test_feedback_child_steps;
            try feedbackFrame(f, row, list, true, log);
            steps = f.state.test_feedback_child_steps - steps;
        }
        try testing.expectEqualSlices(usize, logs[0].items, logs[1].items);
        if (row.expected.len != 0) try testing.expectEqualSlices(usize, row.expected, logs[1].items);
        if (row.reply == .all or row.reply == .chain or row.reply == .all_continue) {
            // A, its RESIZE first if it owes one, then Y, then X1..Xn in a later pass.
            const head: usize = if (row.reply == .all_continue) 2 else 1;
            for (logs[1].items[head..], head..) |index, position| try testing.expectEqual(if (position == head) row.n + 2 else position - head + 1, index);
            // Linear: a later pass scans only the children that replies marked in the pass before,
            // so a chain of n replies costs a constant per reply (1,000: 7,014 child steps, 4,821
            // when marks joined the running batch). A culling parent adds its refresh batch.
            try testing.expect(steps <= @as(u64, if (row.filter) 11 else 8) * (row.n + 2) + 64);
        }
        try expectSameObservations(twins, .{ nodes[0][0 .. row.n + 5], nodes[1][0 .. row.n + 5] });
    }
}

// After a resize or a text change, culled rows' children keep their old observations until a
// frame selects the rows. Unbinding the viewport, or setting culling off, selects every row
// again: their children refresh, and their RESIZE requests come as in the forced full-frame
// twin. An UPDATE hook elsewhere keeps feedback running.
// In the tall variant every row is shown and observed first; after V shrinks, the culled text
// changes, and an unrelated translate makes a full selection set its row aside: only the
// culling change's mark, and listing set-aside rows again, reach it (VERIFY).
test "Scene feedback reaches the children of culled rows when culling stops" {
    for ([_]bool{ false, true }) |scroll_node| for ([_]bool{ false, true }) |tall| {
        const twins = [2]Fixture{ try Fixture.init(testing.allocator, 6, 4, .{}), try Fixture.init(testing.allocator, 6, 4, .{}) };
        defer for (twins) |f| f.deinit();
        var nodes: [2][43]context.Handle = undefined;
        var logs: [2]std.ArrayListUnmanaged(usize) = .{ .empty, .empty };
        defer for (&logs) |*log| log.deinit(testing.allocator);
        for (twins, &nodes, 0..) |f, *list, twin| {
            try f.owner.sceneSetDebugFlags(f.id, if (twin == 0) c.OT_SCENE_DEBUG_FULL_FRAME else c.OT_SCENE_DEBUG_VERIFY);
            try feedbackNode(f, list, 0, c.OT_SCENE_BOX, f.root, 0);
            try feedbackHook(f, list[0], c.OT_SCENE_HOOK_UPDATE);
            try feedbackNode(f, list, 1, c.OT_SCENE_BOX, f.root, 1);
            try f.owner.sceneSetStyle(list[1], 4, 0, 0, c.OT_UNIT_PERCENT, 100, 1);
            try f.owner.sceneSetStyle(list[1], 4, 1, 0, 1, if (tall) 22 else 2, 1);
            try f.owner.sceneSetStyle(list[1], 0, c.OT_STYLE_ENUM_OVERFLOW, 0, 0, c.OT_OVERFLOW_HIDDEN, 0);
            // The content: V's child with a viewport, or V itself as a culling scroll node.
            var content = list[1];
            if (scroll_node) {
                try f.owner.sceneSetScroll(list[1], .{ .culling = true });
                list[2] = list[1];
            } else {
                try feedbackNode(f, list, 2, c.OT_SCENE_BOX, list[1], 0);
                try f.owner.sceneSetStyle(list[2], 4, 0, 0, c.OT_UNIT_PERCENT, 100, 1);
                try f.owner.sceneSetStyle(list[2], 4, 1, 0, c.OT_UNIT_AUTO, 0, 1);
                try f.owner.sceneSetViewport(list[2], list[1]);
                content = list[2];
            }
            // Rows 10 and 15 hold children of fixed width, which the resize leaves alone. Row 10's
            // is a text, and row 15 scrolls: the resize changes its viewport while culled, so it
            // owes a SCROLL request.
            for (0..20) |row| {
                const index = 3 + 2 * row;
                try feedbackNode(f, list, index, c.OT_SCENE_BOX, content, @intCast(row));
                if (row == 15) try f.owner.sceneSetScroll(list[index], .{ .axes = c.OT_SCENE_SCROLL_X });
                try feedbackNode(f, list, index + 1, if (row == 10) c.OT_SCENE_TEXT else c.OT_SCENE_BOX, list[index], 0);
                for ([_]usize{ index, index + 1 }) |sized| {
                    if (sized != 24 and sized != 34) try f.owner.sceneSetStyle(list[sized], 4, 0, 0, c.OT_UNIT_PERCENT, 100, 1);
                    try feedbackHook(f, list[sized], c.OT_SCENE_HOOK_RESIZE | (if (sized == 33) c.OT_SCENE_HOOK_SCROLL else 0));
                }
            }
            try f.owner.sceneSetText(list[24], "culled");
        }
        for (0..@as(usize, if (tall) 5 else 3)) |frame| {
            for (twins, &nodes, &logs) |f, list, *log| {
                // The culled text changes without a size change, which no solve finds again.
                if (!tall and frame == 1) {
                    try f.owner.resizeSessionRenderer(f.id, 8, 4);
                    try f.owner.sceneSetTextOptions(list[24], .{ .truncate = true });
                }
                if (tall and frame == 1) try f.owner.sceneSetStyle(list[1], 4, 1, 0, 1, 2, 1);
                if (tall and frame == 2) try f.owner.sceneSetTextOptions(list[24], .{ .truncate = true });
                if (tall and frame == 3) try f.owner.scenePatchPaint(list[0], c.OT_SCENE_PROPERTY_TRANSLATE_X, .{ .translateX = 1 });
                if (frame == if (tall) @as(usize, 4) else 2) {
                    if (scroll_node) try f.owner.sceneSetScroll(list[1], .{}) else try f.owner.sceneSetViewport(list[2], null);
                }
                log.clearRetainingCapacity();
                try feedbackFrame(f, .{ .reply = .later, .n = 0, .expected = &.{} }, &list, false, log);
            }
            try testing.expectEqualSlices(usize, logs[0].items, logs[1].items);
            try expectSameObservations(twins, .{ &nodes[0], &nodes[1] });
        }
        // The last frame resized every row's child that culling hid from the resize frame.
        if (!tall) try testing.expect(logs[1].items.len >= 16);
    };
}

// Changes that no mark in a walk finds: a scroll reveals a culled child with UPDATE, which
// later frames must still visit; a content style changes only a scroll node's extent, which
// owes a SCROLL request; an editor's cursor moves outside a frame in a scene without hooks,
// and the next frame keeps its lists but must follow the cursor. A culled child with UPDATE
// stays listed through a solve, so the frames after a scroll reveals it still visit it.
test "Scene feedback follows changes that leave no layout behind" {
    for (0..4) |case| {
        const twins = [2]Fixture{ try Fixture.init(testing.allocator, 4, 4, .{}), try Fixture.init(testing.allocator, 4, 4, .{}) };
        defer for (twins) |f| f.deinit();
        var nodes: [2][21]context.Handle = undefined;
        var logs: [2]std.ArrayListUnmanaged(usize) = .{ .empty, .empty };
        defer for (&logs) |*log| log.deinit(testing.allocator);
        var edits: [2]context.Handle = undefined;
        const row: FeedbackRow = .{ .reply = .later, .n = 15, .filter = true, .shown = 2, .expected = &.{} };
        for (twins, &nodes, &edits, 0..) |f, *list, *edit, twin| {
            try f.owner.sceneSetDebugFlags(f.id, if (twin == 0) c.OT_SCENE_DEBUG_FULL_FRAME else c.OT_SCENE_DEBUG_VERIFY);
            switch (case) {
                0, 3 => {
                    try feedbackScene(f, row, list);
                    try feedbackHook(f, list[if (case == 0) 2 else 5], c.OT_SCENE_HOOK_UPDATE);
                },
                1 => {
                    try feedbackNode(f, list, 0, c.OT_SCENE_BOX, f.root, 0);
                    try feedbackHook(f, list[0], c.OT_SCENE_HOOK_UPDATE);
                    try feedbackNode(f, list, 1, c.OT_SCENE_BOX, f.root, 1);
                    try f.owner.sceneSetStyle(list[1], 4, 1, 0, 1, 2, 1);
                    try f.owner.sceneSetScroll(list[1], .{});
                    try feedbackNode(f, list, 2, c.OT_SCENE_BOX, list[1], 0);
                    try feedbackHook(f, list[1], c.OT_SCENE_HOOK_SCROLL);
                },
                2 => {
                    // From the second frame, an UPDATE hook before the editor reads it.
                    try feedbackNode(f, list, 1, c.OT_SCENE_BOX, f.root, 0);
                    edit.* = try f.owner.createEditBuffer(.unicode);
                    try f.owner.editSetText(edit.*, "a\nb\nc\nd\ne", false);
                    try feedbackNode(f, list, 0, c.OT_SCENE_EDITOR, f.root, 1);
                    try f.owner.sceneSetStyle(list[0], 4, 1, 0, 1, 2, 1);
                    try f.owner.sceneSetEditorView(list[0], try f.owner.createEditorView(edit.*, 1, 2));
                },
                else => unreachable,
            }
        }
        for (0..@as(usize, if (case == 3) 8 else 4)) |frame| {
            for (twins, &nodes, edits, &logs) |f, list, edit, *log| {
                if (frame == 1) switch (case) {
                    0 => try f.owner.scenePatchPaint(list[0], c.OT_SCENE_PROPERTY_TRANSLATE_Y, .{ .translateY = -1 }),
                    1 => try f.owner.sceneSetStyle(list[1], c.OT_STYLE_VALUE, c.OT_STYLE_VALUE_MIN_HEIGHT, 0, c.OT_UNIT_POINT, 5, c.OT_STYLE_CONTENT),
                    2 => try feedbackHook(f, list[1], c.OT_SCENE_HOOK_UPDATE),
                    else => try f.owner.sceneSetStyle(list[20], 4, 1, 0, 1, 3, 1),
                };
                if (case == 3 and frame == 2) try f.owner.scenePatchPaint(list[0], c.OT_SCENE_PROPERTY_TRANSLATE_Y, .{ .translateY = -4 });
                // The cursor moves between frames: a frame that keeps its lists prepares the
                // editor before any hook, as a walk does.
                log.clearRetainingCapacity();
                if (case == 2 and frame == 2) {
                    try f.owner.editSetCursor(edit, 4, 0);
                    const request = try f.step(null, options, c.OT_SCENE_FRAME_UPDATE, list[1]);
                    // The view itself, not getViewport, which follows the cursor when read.
                    try testing.expectEqual(@as(u32, 3), (try f.owner.raw().getRenderable(list[0])).scene_node.?.editor.?.view.text_buffer_view.getViewport().?.y);
                    _ = try f.owner.sceneFrameCommit(f.id, try f.step(request, options, c.OT_SCENE_FRAME_DONE, null), false);
                    try drain(f.owner, f.id);
                    continue;
                }
                try feedbackFrame(f, row, &list, false, log);
            }
            try testing.expectEqualSlices(usize, logs[0].items, logs[1].items);
            try twins[0].expectSameCells(twins[1]);
            const editors = .{ (try twins[0].owner.raw().getRenderable(nodes[0][0])).scene_node.?.editor, (try twins[1].owner.raw().getRenderable(nodes[1][0])).scene_node.?.editor };
            if (case == 2) try testing.expectEqualDeep(editors[0].?.view.getViewport(), editors[1].?.view.getViewport());
            // The shown child's UPDATE on every later frame, and the SCROLL after the extent change.
            if (case == 0 and frame >= 1) try testing.expect(std.mem.indexOfScalar(usize, logs[1].items, 2) != null);
            if (case == 1 and frame == 1) try testing.expect(std.mem.indexOfScalar(usize, logs[1].items, 1) != null);
            if (case == 3 and frame >= 2) try testing.expect(std.mem.indexOfScalar(usize, logs[1].items, 5) != null);
        }
    }
}

// Children sort when today's walk passes their parent, once per frame, even when feedback skips
// the parent: a reply's z-index change shows in the frame it would today, and no old order
// stays on screen. P holds two children; H's reply lowers the second one. P is a root child
// passed before H; the root itself, where H's RESIZE reply also resizes H, so a second round
// follows; a child of Q, whose selection finished before H's UPDATE reply; a child of a
// clean V with a second round, after which V must stay due until P sorts; or a child of V that
// the first round passed whole, lowered by a RESIZE reply in the second round, which visits V.
test "Scene feedback sorts children at the point today's walk passes them" {
    for ([_]enum { child, root, nested, deep, later_round }{ .child, .root, .nested, .deep, .later_round }) |scene_kind| {
        const rounds = scene_kind == .root or scene_kind == .deep or scene_kind == .later_round;
        const twins = [2]Fixture{ try Fixture.init(testing.allocator, 4, 2, .{}), try Fixture.init(testing.allocator, 4, 2, .{}) };
        defer for (twins) |f| f.deinit();
        var nodes: [2][6]context.Handle = undefined;
        for (twins, &nodes, 0..) |f, *list, twin| {
            try f.owner.sceneSetDebugFlags(f.id, if (twin == 0) c.OT_SCENE_DEBUG_FULL_FRAME else c.OT_SCENE_DEBUG_VERIFY);
            var holder = f.root;
            if (scene_kind == .nested or scene_kind == .deep or scene_kind == .later_round) {
                // Q holds a hooked R, so feedback visits Q and passes P without queueing it; or
                // V holds only P, so its subtree is clean.
                try feedbackNode(f, list, 4, c.OT_SCENE_BOX, f.root, 0);
                try f.owner.sceneSetStyle(list[4], 4, 0, 0, 1, 4, 1);
                if (scene_kind == .nested or scene_kind == .later_round) {
                    try feedbackNode(f, list, 5, c.OT_SCENE_BOX, list[4], 0);
                    try feedbackHook(f, list[5], if (scene_kind == .nested) c.OT_SCENE_HOOK_UPDATE else c.OT_SCENE_HOOK_RESIZE);
                }
                holder = list[4];
            }
            const parent = if (scene_kind == .root) f.root else blk: {
                try feedbackNode(f, list, 0, c.OT_SCENE_BOX, holder, if (scene_kind == .nested or scene_kind == .later_round) 1 else 0);
                try f.owner.sceneSetStyle(list[0], 4, 0, 0, 1, 4, 1);
                break :blk list[0];
            };
            for (1..3) |index| {
                try feedbackNode(f, list, index, c.OT_SCENE_BOX, parent, @intCast(index - 1));
                try f.owner.sceneSetStyle(list[index], c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_POSITION_TYPE, 0, 0, c.OT_POSITION_ABSOLUTE, 0);
                try f.owner.scenePatchPaint(list[index], c.OT_SCENE_PROPERTY_BACKGROUND, .{ .background = .{ @intCast(index * 100), 0, 0, 255 } });
            }
            try feedbackNode(f, list, 3, c.OT_SCENE_BOX, f.root, if (scene_kind == .root) 2 else 1);
            try feedbackHook(f, list[3], if (rounds) c.OT_SCENE_HOOK_RESIZE else c.OT_SCENE_HOOK_UPDATE);
        }
        for (0..5) |frame| {
            for (twins, nodes) |f, list| {
                if (rounds and frame == 1) try f.owner.sceneSetStyle(list[3], 4, 0, 0, 1, 2, 1);
                var request = try f.owner.sceneFrameStep(f.id, null, options);
                while (request.kind != c.OT_SCENE_FRAME_DONE) {
                    if (frame == 1 and scene_kind == .later_round) {
                        // H's reply resizes R, whose RESIZE in the second round lowers the child.
                        if (std.meta.eql(request.node, list[3])) try f.owner.sceneSetStyle(list[5], 4, 0, 0, 1, 2, 1);
                        if (std.meta.eql(request.node, list[5])) try f.owner.scenePatchPaint(list[2], c.OT_SCENE_PROPERTY_Z_INDEX, .{ .zIndex = -1 });
                    } else if (frame == 1 and std.meta.eql(request.node, list[3])) {
                        try f.owner.scenePatchPaint(list[2], c.OT_SCENE_PROPERTY_Z_INDEX, .{ .zIndex = -1 });
                        if (rounds) try f.owner.sceneSetStyle(list[3], 4, 1, 0, 1, 2, 1);
                    }
                    request = try f.owner.sceneFrameStep(f.id, request, options);
                }
                _ = try f.owner.sceneFrameCommit(f.id, request, false);
                try drain(f.owner, f.id);
            }
            try twins[0].expectSameCells(twins[1]);
            const parents = .{ (try twins[0].owner.raw().getRenderable(if (scene_kind == .root) twins[0].root else nodes[0][0])).scene_node.?, (try twins[1].owner.raw().getRenderable(if (scene_kind == .root) twins[1].root else nodes[1][0])).scene_node.? };
            for (parents[0].paint_children.items, parents[1].paint_children.items) |a, b| try testing.expectEqual(a.scene_node.?.num, b.scene_node.?.num);
            // The new order shows from the frame after the reply.
            if (frame >= 2) try testing.expectEqual(@as(u32, 12), parents[1].paint_children.items[0].scene_node.?.num);
        }
    }
}

// Under a filtering parent whose selection does not change, 1,000 culled children with UPDATE
// keep the parent visited on every frame. Feedback scans its children no more often than
// today's walk, which scans them twice: once for placements and once to select.
test "Scene feedback scans a culled wide parent no more than today's walk" {
    const f = try Fixture.init(testing.allocator, 4, 4, .{ .limits = .{ .object_capacity = 2048 } });
    defer f.deinit();
    const row: FeedbackRow = .{ .reply = .later, .n = 1000, .filter = true, .shown = 2, .expected = &.{} };
    const nodes = try testing.allocator.alloc(context.Handle, row.n + 6);
    defer testing.allocator.free(nodes);
    try feedbackScene(f, row, nodes);
    for (nodes[2 .. row.n + 2]) |node| try feedbackHook(f, node, c.OT_SCENE_HOOK_UPDATE);
    var log: std.ArrayListUnmanaged(usize) = .empty;
    defer log.deinit(testing.allocator);
    for (0..4) |frame| {
        log.clearRetainingCapacity();
        const steps = f.state.test_feedback_child_steps;
        try feedbackFrame(f, row, nodes, false, &log);
        if (frame < 2) continue;
        try testing.expectEqualSlices(usize, &.{ 1, row.n + 2 }, log.items);
        try testing.expect(f.state.test_feedback_child_steps - steps <= 2 * (row.n + 2) + 8);
    }
}

// An idle-update node uses its update where today's walk passes it, so UPDATE given later in
// the frame waits for the next one, and UPDATE given before runs in this one. Root children
// H1, M (idle update), V, H2, Q, N; P inside V, with C (UPDATE) and D. H2's reply gives M
// UPDATE and RESIZE (seed 137), shows the hidden M before or after doing so (the walk never
// stamped it), clears M's hooks, or gives M, which had UPDATE, idle update. Or it moves N into P
// after C (P's selection finished: N was not passed), first detaching C, or D, P's last child;
// moves M, which feedback passed, into Q, which it has not; or unbinds the viewport that culled
// D. Then the moved node, or D, gets UPDATE. The count is the target's UPDATE calls that frame.
test "Scene feedback uses an idle update only where the walk passed the node" {
    const Case = enum { to_update, shown_to_update, show_then_update, to_none, update_to_idle, appended, emptied, trimmed, moved, culled };
    const expected = [_]u32{ 0, 1, 1, 0, 1, 1, 1, 1, 0, 1 };
    for (std.enums.values(Case), expected) |case, count_expected| {
        const twins = [2]Fixture{ try Fixture.init(testing.allocator, 8, 4, .{}), try Fixture.init(testing.allocator, 8, 4, .{}) };
        defer for (twins) |f| f.deinit();
        var updates: [2]u32 = .{ 0, 0 };
        for (twins, &updates, 0..) |f, *count, twin| {
            try f.owner.sceneSetDebugFlags(f.id, if (twin == 0) c.OT_SCENE_DEBUG_FULL_FRAME else c.OT_SCENE_DEBUG_VERIFY);
            var list: [25]context.Handle = undefined;
            for (0..6) |index| try feedbackNode(f, &list, index, c.OT_SCENE_BOX, f.root, @intCast(index));
            try f.owner.sceneSetStyle(list[2], 4, 1, 0, 1, 1, 1);
            try f.owner.sceneSetStyle(list[2], 0, c.OT_STYLE_ENUM_OVERFLOW, 0, 0, c.OT_OVERFLOW_HIDDEN, 0);
            try feedbackNode(f, &list, 6, c.OT_SCENE_BOX, list[2], 0);
            try f.owner.sceneSetStyle(list[6], 4, 1, 0, c.OT_UNIT_AUTO, 0, 1);
            for (7..9) |index| try feedbackNode(f, &list, index, c.OT_SCENE_BOX, list[6], @intCast(index - 7));
            // C is three rows tall, so the viewport's one row culls D, and 16 more children reach
            // the culling cutoff.
            try f.owner.sceneSetStyle(list[7], 4, 1, 0, 1, 3, 1);
            if (case == .culled) {
                for (9..25) |index| try feedbackNode(f, &list, index, c.OT_SCENE_BOX, list[6], @intCast(index - 7));
                try f.owner.sceneSetViewport(list[6], list[2]);
            }
            for ([_]usize{ 0, 3, 7 }) |index| try feedbackHook(f, list[index], c.OT_SCENE_HOOK_UPDATE);
            for ([_]usize{ 1, 5, 8 }) |index| try feedbackHook(f, list[index], c.OT_SCENE_HOOK_IDLE_UPDATE);
            if (case == .update_to_idle) try feedbackHook(f, list[1], c.OT_SCENE_HOOK_UPDATE);
            if (case == .shown_to_update or case == .show_then_update) try f.owner.sceneSetStyle(list[1], c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_DISPLAY, 0, 0, c.OT_DISPLAY_NONE, 0);
            _ = try presentStepped(f, NoReply{});
            const target = switch (case) {
                .appended, .emptied, .trimmed => list[5],
                .culled => list[8],
                else => list[1],
            };
            var request = try f.owner.sceneFrameStep(f.id, null, options);
            while (request.kind != c.OT_SCENE_FRAME_DONE) {
                if (std.meta.eql(request.node, target) and request.kind == c.OT_SCENE_FRAME_UPDATE) count.* += 1;
                if (std.meta.eql(request.node, list[3])) switch (case) {
                    .to_update => try feedbackHook(f, target, c.OT_SCENE_HOOK_UPDATE | c.OT_SCENE_HOOK_RESIZE),
                    .shown_to_update, .show_then_update => {
                        if (case == .shown_to_update) try feedbackHook(f, target, c.OT_SCENE_HOOK_UPDATE);
                        try f.owner.sceneSetStyle(target, c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_DISPLAY, 0, 0, c.OT_DISPLAY_FLEX, 0);
                        if (case == .show_then_update) try feedbackHook(f, target, c.OT_SCENE_HOOK_UPDATE);
                    },
                    .to_none => try feedbackHook(f, target, 0),
                    .update_to_idle => try feedbackHook(f, target, c.OT_SCENE_HOOK_IDLE_UPDATE),
                    else => {
                        switch (case) {
                            .appended => try f.owner.sceneMoveNode(list[5], list[6], 2),
                            .emptied => {
                                for (7..9) |index| try f.owner.sceneMoveNode(list[index], list[4], @intCast(index - 7));
                                try f.owner.sceneMoveNode(list[5], list[6], 0);
                            },
                            .trimmed => {
                                try f.owner.sceneMoveNode(list[8], list[4], 0);
                                try f.owner.sceneMoveNode(list[5], list[6], 1);
                            },
                            .moved => try f.owner.sceneMoveNode(list[1], list[4], 0),
                            .culled => try f.owner.sceneSetViewport(list[6], null),
                            else => unreachable,
                        }
                        try feedbackHook(f, target, c.OT_SCENE_HOOK_UPDATE);
                    },
                };
                request = try f.owner.sceneFrameStep(f.id, request, options);
            }
            _ = try f.owner.sceneFrameCommit(f.id, request, false);
            try drain(f.owner, f.id);
        }
        errdefer std.debug.print("case {s}\n", .{@tagName(case)});
        try testing.expectEqual(updates[0], updates[1]);
        try testing.expectEqual(count_expected, updates[1]);
    }
}

// A culling parent's later scan does not undo the passing of its first: X, the first row of P
// inside viewport V, uses its idle update in the first pass. H2's reply moves X out of view,
// marks another row, and hooks H3; P scans again in the later pass. H3's reply hooks X and moves
// it back: X's UPDATE waits for the next frame. Or H2's reply also unbinds V, so P selects
// without culling, and H3's reply binds it again and hooks H4, whose reply hooks X.
test "Scene feedback keeps an idle update a culling parent passed before it scanned again" {
    for ([_]bool{ false, true }) |rebind| {
        const twins = [2]Fixture{ try Fixture.init(testing.allocator, 4, 6, .{}), try Fixture.init(testing.allocator, 4, 6, .{}) };
        defer for (twins) |f| f.deinit();
        var counts: [2]u32 = .{ 0, 0 };
        for (twins, &counts, 0..) |f, *count, twin| {
            try f.owner.sceneSetDebugFlags(f.id, if (twin == 0) c.OT_SCENE_DEBUG_FULL_FRAME else c.OT_SCENE_DEBUG_VERIFY);
            // V, H2, H3 under the root; P under V; rows 0..16 under P; H4 under the root.
            var list: [22]context.Handle = undefined;
            for (0..3) |index| try feedbackNode(f, &list, index, c.OT_SCENE_BOX, f.root, @intCast(index));
            try feedbackNode(f, &list, 21, c.OT_SCENE_BOX, f.root, 3);
            try f.owner.sceneSetStyle(list[0], 4, 1, 0, 1, 3, 1);
            try f.owner.sceneSetStyle(list[0], 0, c.OT_STYLE_ENUM_OVERFLOW, 0, 0, c.OT_OVERFLOW_HIDDEN, 0);
            try feedbackNode(f, &list, 3, c.OT_SCENE_BOX, list[0], 0);
            try f.owner.sceneSetStyle(list[3], 4, 1, 0, c.OT_UNIT_AUTO, 0, 1);
            for (4..21) |index| try feedbackNode(f, &list, index, c.OT_SCENE_BOX, list[3], @intCast(index - 4));
            try f.owner.sceneSetViewport(list[3], list[0]);
            try feedbackHook(f, list[4], c.OT_SCENE_HOOK_IDLE_UPDATE);
            for ([_]usize{ 1, 5 }) |index| try feedbackHook(f, list[index], c.OT_SCENE_HOOK_UPDATE);
            _ = try presentStepped(f, NoReply{});
            var request = try f.owner.sceneFrameStep(f.id, null, options);
            while (request.kind != c.OT_SCENE_FRAME_DONE) {
                if (std.meta.eql(request.node, list[4])) count.* += 1;
                const unhooked = (try f.owner.raw().getRenderable(list[4])).scene_node.?.hook_flags != c.OT_SCENE_HOOK_UPDATE;
                if (std.meta.eql(request.node, list[1])) {
                    try f.owner.scenePatchPaint(list[4], c.OT_SCENE_PROPERTY_TRANSLATE_X, .{ .translateX = 8 });
                    if (rebind) try f.owner.sceneSetViewport(list[3], null) else try feedbackHook(f, list[6], c.OT_SCENE_HOOK_RESIZE);
                    try feedbackHook(f, list[2], c.OT_SCENE_HOOK_UPDATE);
                }
                if (rebind and std.meta.eql(request.node, list[2]) and unhooked) {
                    try f.owner.sceneSetViewport(list[3], list[0]);
                    try feedbackHook(f, list[21], c.OT_SCENE_HOOK_UPDATE);
                }
                if (std.meta.eql(request.node, list[if (rebind) 21 else 2]) and unhooked) {
                    try feedbackHook(f, list[4], c.OT_SCENE_HOOK_UPDATE);
                    try f.owner.scenePatchPaint(list[4], c.OT_SCENE_PROPERTY_TRANSLATE_X, .{ .translateX = 0 });
                }
                request = try f.owner.sceneFrameStep(f.id, request, options);
            }
            _ = try f.owner.sceneFrameCommit(f.id, request, false);
            try drain(f.owner, f.id);
        }
        try testing.expectEqual([2]u32{ 0, 0 }, counts);
    }
}

// Re-sending a scene text's bytes rebuilds its rope, which leaves the view to prepare again
// although the text is equal. Feedback must still refresh the node, as today's walk refreshed
// every member: in a reply to the root's UPDATE, or between frames, plain or styled (VERIFY).
test "Scene feedback prepares a text whose equal bytes were sent again" {
    for ([_]bool{ false, true }) |in_reply| for ([_]bool{ false, true }) |styled| {
        const f = try Fixture.init(testing.allocator, 8, 4, .{});
        defer f.deinit();
        try f.owner.sceneSetDebugFlags(f.id, c.OT_SCENE_DEBUG_VERIFY);
        try feedbackHook(f, f.root, c.OT_SCENE_HOOK_UPDATE);
        const label = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_TEXT, 2);
        try f.owner.sceneSetText(label, "ab");
        try f.owner.sceneMoveNode(label, f.root, 0);
        const resend = struct {
            fn run(owner: anytype, node: context.Handle, with_style: bool) !void {
                if (with_style) return owner.sceneSetStyledText(node, "ab", &.{.{ .byte_count = 2 }});
                try owner.sceneSetText(node, "ab");
            }
        }.run;
        for (0..4) |frame| {
            if (!in_reply and frame == 2) try resend(f.owner, label, styled);
            var request = try f.owner.sceneFrameStep(f.id, null, options);
            while (request.kind != c.OT_SCENE_FRAME_DONE) {
                if (in_reply and frame == 2 and request.kind == c.OT_SCENE_FRAME_UPDATE) try resend(f.owner, label, styled);
                request = try f.owner.sceneFrameStep(f.id, request, options);
            }
            _ = try f.owner.sceneFrameCommit(f.id, request, false);
            try drain(f.owner, f.id);
            try testing.expect(!(try f.owner.raw().getRenderable(label)).scene_node.?.text.?.view.needsPrepare());
        }
    };
}

// A node moved into a parent that preparation already passed paints after its siblings, in
// the order the parent had then. H1's reply raises P's first child C1 before feedback passes P;
// H2's reply moves N, whose z is between C2's and C1's, into P. P sorts with C1 raised, then N
// follows; the next frame sorts N between them, though P's holder V holds no hook.
test "Scene feedback appends a node moved into a passed parent after its sorted children" {
    const twins = [2]Fixture{ try Fixture.init(testing.allocator, 4, 2, .{}), try Fixture.init(testing.allocator, 4, 2, .{}) };
    defer for (twins) |f| f.deinit();
    var parents: [2]context.Handle = undefined;
    for (twins, &parents, 0..) |f, *parent, twin| {
        try f.owner.sceneSetDebugFlags(f.id, if (twin == 0) c.OT_SCENE_DEBUG_FULL_FRAME else c.OT_SCENE_DEBUG_VERIFY);
        // H1, V, H2, N under the root; P under V; C1 and C2 under P.
        var list: [7]context.Handle = undefined;
        for ([_]usize{ 0, 1, 2, 3 }, 0..) |index, position| try feedbackNode(f, &list, index, c.OT_SCENE_BOX, f.root, @intCast(position));
        try feedbackNode(f, &list, 6, c.OT_SCENE_BOX, list[1], 0);
        for ([_]usize{ 4, 5 }, 0..) |index, position| try feedbackNode(f, &list, index, c.OT_SCENE_BOX, list[6], @intCast(position));
        try f.owner.scenePatchPaint(list[3], c.OT_SCENE_PROPERTY_Z_INDEX, .{ .zIndex = 6 });
        for ([_]usize{ 0, 2 }) |index| try feedbackHook(f, list[index], c.OT_SCENE_HOOK_UPDATE);
        _ = try presentStepped(f, NoReply{});
        var request = try f.owner.sceneFrameStep(f.id, null, options);
        while (request.kind != c.OT_SCENE_FRAME_DONE) {
            if (std.meta.eql(request.node, list[0])) try f.owner.scenePatchPaint(list[4], c.OT_SCENE_PROPERTY_Z_INDEX, .{ .zIndex = 9 });
            if (std.meta.eql(request.node, list[2])) try f.owner.sceneMoveNode(list[3], list[6], 2);
            request = try f.owner.sceneFrameStep(f.id, request, options);
        }
        _ = try f.owner.sceneFrameCommit(f.id, request, false);
        try drain(f.owner, f.id);
        parent.* = list[6];
    }
    for ([_][3]u32{ .{ 15, 14, 13 }, .{ 15, 13, 14 } }, 0..) |expected, frame| {
        if (frame == 1) for (twins) |f| {
            _ = try presentStepped(f, NoReply{});
        };
        for (twins, parents) |f, parent| {
            const children = (try f.owner.raw().getRenderable(parent)).scene_node.?.paint_children.items;
            for (expected, children) |num, child| try testing.expectEqual(num, child.scene_node.?.num);
        }
        try twins[0].expectSameCells(twins[1]);
    }
}

// A later pass skips the clean subtrees whose updates ran in the frame, not those the first
// pass could not reach. A's reply hides X1, whose child C has UPDATE, and hooks Z; Y's reply
// shows X1 again; Z's reply, in the later pass, hides it for good. The later pass must visit
// C, which no other round can reach.
test "Scene feedback passes visit hooked subtrees the first pass did not reach" {
    const twins = [2]Fixture{ try Fixture.init(testing.allocator, 4, 4, .{}), try Fixture.init(testing.allocator, 4, 4, .{}) };
    defer for (twins) |f| f.deinit();
    var logs: [2][4]u32 = undefined;
    for (twins, &logs, 0..) |f, *log, twin| {
        try f.owner.sceneSetDebugFlags(f.id, if (twin == 0) c.OT_SCENE_DEBUG_FULL_FRAME else c.OT_SCENE_DEBUG_VERIFY);
        // A, X1, Y, Z under the root; C under X1.
        var list: [5]context.Handle = undefined;
        for (0..4) |index| try feedbackNode(f, &list, index, c.OT_SCENE_BOX, f.root, @intCast(index));
        try feedbackNode(f, &list, 4, c.OT_SCENE_BOX, list[1], 0);
        for ([_]usize{ 0, 2, 4 }) |index| try feedbackHook(f, list[index], c.OT_SCENE_HOOK_UPDATE);
        _ = try presentStepped(f, NoReply{});
        var count: usize = 0;
        var request = try f.owner.sceneFrameStep(f.id, null, options);
        while (request.kind != c.OT_SCENE_FRAME_DONE) {
            const index = request.num - 10;
            log[count] = index;
            count += 1;
            const display: f32 = switch (index) {
                0, 3 => c.OT_DISPLAY_NONE,
                2 => c.OT_DISPLAY_FLEX,
                else => -1,
            };
            if (display >= 0) try f.owner.sceneSetStyle(list[1], c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_DISPLAY, 0, 0, display, 0);
            if (index == 0) try feedbackHook(f, list[3], c.OT_SCENE_HOOK_UPDATE);
            request = try f.owner.sceneFrameStep(f.id, request, options);
        }
        _ = try f.owner.sceneFrameCommit(f.id, request, false);
        try drain(f.owner, f.id);
        try testing.expectEqual(@as(usize, 4), count);
    }
    for (logs) |log| try testing.expectEqual([4]u32{ 0, 2, 4, 3 }, log);
}

// A reply that remounts a list marks nodes it destroys again: the pass's list of marked nodes
// keeps their entries until it ends. Two hooks each replace 40 rows in one frame, as a
// reconciler that renders a list again does.
test "Scene feedback lists the marks of nodes a reply destroys within its capacity" {
    const f = try Fixture.init(testing.allocator, 4, 4, .{ .limits = .{ .object_capacity = 256 } });
    defer f.deinit();
    try f.owner.sceneSetDebugFlags(f.id, c.OT_SCENE_DEBUG_VERIFY);
    var hooks: [2]context.Handle = undefined;
    for (&hooks, 0..) |*hook, index| {
        hook.* = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_BOX, @intCast(1 + index));
        try f.owner.sceneMoveNode(hook.*, f.root, @intCast(index));
        try feedbackHook(f, hook.*, c.OT_SCENE_HOOK_UPDATE);
    }
    var rows: [40]context.Handle = undefined;
    for (&rows, 0..) |*row, index| {
        row.* = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_BOX, @intCast(10 + index));
        try f.owner.sceneMoveNode(row.*, f.root, @intCast(2 + index));
    }
    _ = try presentStepped(f, NoReply{});
    for (0..2) |_| {
        var request = try f.owner.sceneFrameStep(f.id, null, options);
        while (request.kind != c.OT_SCENE_FRAME_DONE) {
            for (&rows, 0..) |*row, index| {
                try f.owner.sceneDestroyNode(row.*);
                row.* = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_BOX, @intCast(10 + index));
                try f.owner.sceneMoveNode(row.*, f.root, @intCast(2 + index));
            }
            request = try f.owner.sceneFrameStep(f.id, request, options);
        }
        _ = try f.owner.sceneFrameCommit(f.id, request, false);
        try drain(f.owner, f.id);
    }
}

// A reply that moves a culled row back into view prepares the frame again, even if no culling
// parent selected before it: feedback skipped the clean viewport content, and nothing else
// reaches it in this frame. X, a row of P inside viewport V, was moved out of view, and its
// child Y (RESIZE) grew there. H's reply, before or after V, moves X back, and may also send a
// text's equal bytes (a mark that solves nothing). Y's RESIZE comes in this frame (VERIFY).
test "Scene feedback prepares again when a reply moves a culled row into view" {
    for ([_]bool{ false, true }) |h_first| for ([_]bool{ false, true }) |resend| {
        const twins = [2]Fixture{ try Fixture.init(testing.allocator, 4, 6, .{}), try Fixture.init(testing.allocator, 4, 6, .{}) };
        defer for (twins) |f| f.deinit();
        var counts: [2]u32 = .{ 0, 0 };
        for (twins, &counts, 0..) |f, *count, twin| {
            try f.owner.sceneSetDebugFlags(f.id, if (twin == 0) c.OT_SCENE_DEBUG_FULL_FRAME else c.OT_SCENE_DEBUG_VERIFY);
            // H, V and T under the root, H first or last; P under V; 17 rows under P; Y under row 1.
            var list: [23]context.Handle = undefined;
            const order = if (h_first) [3]usize{ 0, 1, 2 } else [3]usize{ 1, 2, 0 };
            for (order, 0..) |index, position| try feedbackNode(f, &list, index, c.OT_SCENE_BOX, f.root, @intCast(position));
            try f.owner.sceneSetStyle(list[1], 4, 1, 0, 1, 3, 1);
            try f.owner.sceneSetStyle(list[1], 0, c.OT_STYLE_ENUM_OVERFLOW, 0, 0, c.OT_OVERFLOW_HIDDEN, 0);
            try feedbackNode(f, &list, 3, c.OT_SCENE_BOX, list[1], 0);
            try f.owner.sceneSetStyle(list[3], 4, 1, 0, c.OT_UNIT_AUTO, 0, 1);
            for (4..21) |index| try feedbackNode(f, &list, index, c.OT_SCENE_BOX, list[3], @intCast(index - 4));
            try f.owner.sceneSetViewport(list[3], list[1]);
            try feedbackNode(f, &list, 21, c.OT_SCENE_BOX, list[5], 0);
            list[22] = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_TEXT, 40);
            try f.owner.sceneSetText(list[22], "t");
            try f.owner.sceneMoveNode(list[22], list[2], 0);
            try feedbackHook(f, list[0], c.OT_SCENE_HOOK_UPDATE);
            try feedbackHook(f, list[21], c.OT_SCENE_HOOK_RESIZE);
            _ = try presentStepped(f, NoReply{});
            try f.owner.scenePatchPaint(list[5], c.OT_SCENE_PROPERTY_TRANSLATE_Y, .{ .translateY = 10 });
            _ = try presentStepped(f, NoReply{});
            try f.owner.sceneSetStyle(list[21], 4, 0, 0, 1, 2, 1);
            _ = try presentStepped(f, NoReply{});
            var request = try f.owner.sceneFrameStep(f.id, null, options);
            while (request.kind != c.OT_SCENE_FRAME_DONE) {
                if (std.meta.eql(request.node, list[21]) and request.kind == c.OT_SCENE_FRAME_RESIZE) count.* += 1;
                if (std.meta.eql(request.node, list[0])) {
                    try f.owner.scenePatchPaint(list[5], c.OT_SCENE_PROPERTY_TRANSLATE_Y, .{ .translateY = 0 });
                    if (resend) try f.owner.sceneSetText(list[22], "t");
                }
                request = try f.owner.sceneFrameStep(f.id, request, options);
            }
            _ = try f.owner.sceneFrameCommit(f.id, request, false);
            try drain(f.owner, f.id);
        }
        try testing.expectEqual([2]u32{ 1, 1 }, counts);
    };
}

// Later passes of a round run on its layout and count toward neither limit, so a frame needs
// no more rounds or requests than the forced full-frame twin, which pops every child in the
// first pass. A's reply hooks X1; each Xi's reply hooks the next one, and the last one's reply
// resizes it, which needs a second round. With limits at what the twin needs, both finish;
// one lower, both fail the same way.
test "Scene feedback passes keep the round and request counts at the limits" {
    const chain = 6;
    for ([_][2]u32{ .{ 2, chain + 1 }, .{ 1, chain + 1 }, .{ 2, chain } }) |limits| {
        const twins = [2]Fixture{ try Fixture.init(testing.allocator, 12, 2, .{}), try Fixture.init(testing.allocator, 12, 2, .{}) };
        defer for (twins) |f| f.deinit();
        var nodes: [2][chain + 1]context.Handle = undefined;
        var results: [2]anyerror!u32 = undefined;
        for (twins, &nodes, &results, 0..) |f, *list, *result, twin| {
            try f.owner.sceneSetDebugFlags(f.id, if (twin == 0) c.OT_SCENE_DEBUG_FULL_FRAME else c.OT_SCENE_DEBUG_VERIFY);
            for (list, 0..) |*node, index| {
                node.* = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_BOX, @intCast(10 + index));
                try f.owner.sceneSetStyle(node.*, 4, 0, 0, 1, 1, 1);
                try f.owner.sceneMoveNode(node.*, f.root, @intCast(index));
            }
            try feedbackHook(f, list[0], c.OT_SCENE_HOOK_UPDATE);
            _ = try presentStepped(f, NoReply{});
            const limited: scene.FrameOptions = .{ .background = options.background, .use_mouse = true, .excluded_hit_num = 0, .max_layout_rounds = limits[0], .max_host_requests = limits[1] };
            result.* = blk: {
                var requests: u32 = 0;
                var request = f.owner.sceneFrameStep(f.id, null, limited) catch |err| break :blk err;
                while (request.kind != c.OT_SCENE_FRAME_DONE) {
                    requests += 1;
                    const index = request.num - 10;
                    if (index + 1 < list.len) try feedbackHook(f, list[index + 1], c.OT_SCENE_HOOK_UPDATE) else try f.owner.sceneSetStyle(list[index], 4, 0, 0, 1, 2, 1);
                    request = f.owner.sceneFrameStep(f.id, request, limited) catch |err| break :blk err;
                }
                _ = try f.owner.sceneFrameCommit(f.id, request, false);
                try drain(f.owner, f.id);
                break :blk requests;
            };
        }
        try testing.expectEqual(results[0], results[1]);
        try testing.expectEqual(@as(anyerror!u32, if (limits[0] == 1) error.LayoutLimit else if (limits[1] == chain) error.FrameRequestLimit else chain + 1), results[1]);
    }
}

// Feedback that skips a clean root still passes every parent: a z-index change in a later round
// keeps the frame's order, as preparation already reached the parent. W's overflow changes
// before the frame, so the root's LAYOUT_CHANGED request comes first with no box changed; its
// reply grows W, which needs a second round but marks nothing, so the first round skips the root. The second round's LAYOUT_CHANGED
// reply lowers C2, the later of P's two overlapping children: it shows from the next frame.
test "Scene feedback passes every parent when it skips a clean root" {
    const twins = [2]Fixture{ try Fixture.init(testing.allocator, 4, 2, .{}), try Fixture.init(testing.allocator, 4, 2, .{}) };
    defer for (twins) |f| f.deinit();
    var nodes: [2][4]context.Handle = undefined;
    for (twins, &nodes, 0..) |f, *list, twin| {
        try f.owner.sceneSetDebugFlags(f.id, if (twin == 0) c.OT_SCENE_DEBUG_FULL_FRAME else c.OT_SCENE_DEBUG_VERIFY);
        // P and W under the root; C1 and C2 under P.
        for (0..2) |index| try feedbackNode(f, list, index, c.OT_SCENE_BOX, f.root, @intCast(index));
        for (2..4) |index| {
            try feedbackNode(f, list, index, c.OT_SCENE_BOX, list[0], @intCast(index - 2));
            try f.owner.sceneSetStyle(list[index], c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_POSITION_TYPE, 0, 0, c.OT_POSITION_ABSOLUTE, 0);
            try f.owner.scenePatchPaint(list[index], c.OT_SCENE_PROPERTY_BACKGROUND, .{ .background = .{ @intCast(index * 50), 0, 0, 255 } });
        }
        try f.owner.sceneSetHooks(f.root, c.OT_SCENE_HOOK_LAYOUT_CHANGED, 1, 0, 0);
        _ = try presentStepped(f, NoReply{});
    }
    for (0..2) |frame| {
        for (twins, nodes) |f, list| {
            if (frame == 0) try f.owner.sceneSetStyle(list[1], c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_OVERFLOW, 0, 0, c.OT_OVERFLOW_HIDDEN, 0);
            var replies: u32 = 0;
            var request = try f.owner.sceneFrameStep(f.id, null, options);
            while (request.kind != c.OT_SCENE_FRAME_DONE) {
                replies += 1;
                if (frame == 0 and replies == 1) try f.owner.sceneSetStyle(list[1], 4, 0, 0, 1, 3, 1);
                if (frame == 0 and replies == 2) try f.owner.scenePatchPaint(list[3], c.OT_SCENE_PROPERTY_Z_INDEX, .{ .zIndex = -1 });
                request = try f.owner.sceneFrameStep(f.id, request, options);
            }
            _ = try f.owner.sceneFrameCommit(f.id, request, false);
            try drain(f.owner, f.id);
        }
        // C2 stays on top in the reply's frame and goes below C1 in the next.
        for (twins, nodes) |f, list| {
            const top = (try f.owner.raw().getRenderable(list[0])).scene_node.?.paint_children.items[1];
            try testing.expectEqual((try f.owner.raw().getRenderable(list[if (frame == 0) 3 else 2])).scene_node.?.num, top.scene_node.?.num);
        }
        try twins[0].expectSameCells(twins[1]);
    }
}

// A viewport of 4 x 2 cells over a column of N one-line text rows; 2 rows show. Each row is
// one frame kind; columns are viewport child refreshes, visibility steps, view preparations,
// host requests, and layout rounds of that frame. Only rows whose layout, text, or view changed
// refresh, culled ones too; a frame that walks prepares the three boxes' views (B5b).
test "Scene frame work counts viewport refresh and culling work" {
    const Frame = enum { first, unchanged, scroll, grow, options_prepare, options_color, measure_text, measure_same_text, editor_cursor, hidden, hidden_unchanged, cancelled, stale_reply, stale_requester, placed_reply, destroy_reply };
    const sizes = [_]u32{ 16, 256, 4096 };
    const expected = [sizes.len][std.meta.fields(Frame).len][5]u64{
        .{
            .{ 0, 0, 22, 0, 1 }, // first
            .{ 0, 0, 0, 0, 1 }, // unchanged
            .{ 0, 0, 3, 0, 1 }, // scroll
            .{ 1, 0, 5, 0, 1 }, // grow
            .{ 1, 0, 4, 0, 1 }, // options_prepare
            .{ 0, 0, 3, 0, 1 }, // options_color
            .{ 1, 0, 4, 0, 1 }, // measure_text
            .{ 1, 0, 4, 0, 1 }, // measure_same_text
            .{ 1, 0, 1, 0, 1 }, // editor_cursor
            .{ 16, 0, 19, 0, 1 }, // hidden
            .{ 0, 0, 0, 0, 1 }, // hidden_unchanged
            .{ 1, 0, 4, 0, 1 }, // cancelled
            .{ 3, 0, 10, 1, 2 }, // stale_reply
            .{ 3, 0, 10, 1, 2 }, // stale_requester
            .{ 2, 0, 10, 1, 2 }, // placed_reply
            .{ 2, 67, 10, 1, 2 }, // destroy_reply
        },
        .{
            .{ 0, 0, 262, 0, 1 }, // first
            .{ 0, 0, 0, 0, 1 }, // unchanged
            .{ 0, 0, 3, 0, 1 }, // scroll
            .{ 1, 0, 5, 0, 1 }, // grow
            .{ 1, 0, 4, 0, 1 }, // options_prepare
            .{ 0, 0, 3, 0, 1 }, // options_color
            .{ 1, 0, 4, 0, 1 }, // measure_text
            .{ 1, 0, 4, 0, 1 }, // measure_same_text
            .{ 1, 0, 1, 0, 1 }, // editor_cursor
            .{ 256, 0, 259, 0, 1 }, // hidden
            .{ 0, 0, 0, 0, 1 }, // hidden_unchanged
            .{ 1, 0, 4, 0, 1 }, // cancelled
            .{ 3, 0, 10, 1, 2 }, // stale_reply
            .{ 3, 0, 10, 1, 2 }, // stale_requester
            .{ 2, 0, 10, 1, 2 }, // placed_reply
            .{ 2, 16, 9, 1, 2 }, // destroy_reply
        },
        .{
            .{ 0, 0, 4102, 0, 1 }, // first
            .{ 0, 0, 0, 0, 1 }, // unchanged
            .{ 0, 0, 3, 0, 1 }, // scroll
            .{ 1, 0, 5, 0, 1 }, // grow
            .{ 1, 0, 4, 0, 1 }, // options_prepare
            .{ 0, 0, 3, 0, 1 }, // options_color
            .{ 1, 0, 4, 0, 1 }, // measure_text
            .{ 1, 0, 4, 0, 1 }, // measure_same_text
            .{ 1, 0, 1, 0, 1 }, // editor_cursor
            .{ 4096, 0, 4099, 0, 1 }, // hidden
            .{ 0, 0, 0, 0, 1 }, // hidden_unchanged
            .{ 1, 0, 4, 0, 1 }, // cancelled
            .{ 3, 0, 10, 1, 2 }, // stale_reply
            .{ 3, 0, 10, 1, 2 }, // stale_requester
            .{ 2, 0, 10, 1, 2 }, // placed_reply
            .{ 2, 16, 9, 1, 2 }, // destroy_reply
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
                    // The same bytes again: the write keeps the Yoga measure (no solve), and the rebuilt
                    // rope leaves only that row's view to prepare.
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
// declaration order (candidate visits through damage rows), then the preparation entries
// stamped, the node lookups of paint planning, which no frame without a departure needs, and
// the child entries feedback scanned. Track B steps change these rows.
// Unchanged frames paint and diff nothing (B3) and keep both lists through hooks and filters
// (B5a), so they walk and stamp nothing; the scroll scene's status text is as tall as
// the screen, so its glyph damages every row. A recorded frame whose recording did not change
// paints nothing either (B7). A frame with damage clears and paints only the damaged rows'
// members (B4). A reply that sends the target's text again marks its path: the later pass
// costs that path.
test "Scene frame bench scenes pin each frame kind's work at small sizes" {
    const bench = @import("../bench/scene-frame_bench.zig");
    const rows = [_]struct { shape: bench.Shape, size: u32, change: bench.Change, work: [21]u64 }{
        .{ .shape = .ui, .size = 0, .change = .unchanged, .work = .{ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0 } },
        .{ .shape = .ui, .size = 0, .change = .glyph, .work = .{ 87, 0, 87, 87, 1, 0, 0, 0, 0, 3, 209, 200, 1, 1, 0, 0, 1, 1, 87, 0, 0 } },
        .{ .shape = .ui, .size = 0, .change = .update_hook, .work = .{ 0, 0, 0, 0, 0, 15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 4 } },
        .{ .shape = .ui, .size = 0, .change = .reply_text, .work = .{ 87, 87, 88, 0, 0, 30, 0, 0, 0, 3, 209, 200, 1, 0, 0, 1, 1, 1, 87, 0, 11 } },
        .{ .shape = .scroll, .size = 100, .change = .reply_text, .work = .{ 104, 104, 5, 0, 0, 20, 0, 0, 100, 53, 10000, 10000, 50, 0, 0, 1, 1, 50, 104, 0, 6 } },
        .{ .shape = .ui, .size = 0, .change = .paint_hook, .work = .{ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0 } },
        .{ .shape = .boxes, .size = 100, .change = .unchanged, .work = .{ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0 } },
        .{ .shape = .boxes, .size = 100, .change = .background, .work = .{ 0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 1, 140, 1, 1, 0, 0, 1, 1, 0, 0, 0 } },
        .{ .shape = .scroll, .size = 100, .change = .unchanged, .work = .{ 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0 } },
        .{ .shape = .scroll, .size = 100, .change = .glyph, .work = .{ 104, 104, 5, 104, 1, 21, 0, 0, 200, 53, 10000, 10000, 50, 1, 0, 0, 1, 50, 104, 0, 106 } },
        .{ .shape = .scroll, .size = 100, .change = .scroll, .work = .{ 104, 104, 4, 0, 0, 21, 0, 0, 200, 53, 10000, 10000, 50, 50, 0, 0, 1, 50, 104, 53, 155 } },
        .{ .shape = .scroll, .size = 100, .change = .append, .work = .{ 106, 106, 6, 106, 1, 18, 0, 0, 204, 53, 10000, 10000, 50, 0, 0, 0, 1, 50, 106, 0, 109 } },
        .{ .shape = .wrapped_scroll, .size = 20, .change = .unchanged, .work = .{ 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0 } },
        // The scroll shape as one scroll node: one node fewer, two hidden Yoga nodes read per
        // solve, a scroll is an offset without a solve, and an append follows the bottom.
        .{ .shape = .scroll_node, .size = 100, .change = .unchanged, .work = .{ 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0 } },
        .{ .shape = .scroll_node, .size = 100, .change = .scroll, .work = .{ 103, 103, 3, 0, 0, 16, 0, 0, 200, 52, 9950, 10000, 50, 50, 0, 0, 1, 50, 103, 52, 153 } },
        .{ .shape = .scroll_node, .size = 100, .change = .append, .work = .{ 105, 105, 4, 107, 1, 18, 0, 0, 204, 52, 9950, 10000, 50, 50, 0, 0, 1, 50, 105, 52, 108 } },
        .{ .shape = .boxes, .size = 100, .change = .paint_hook, .work = .{ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0 } },
        .{ .shape = .scroll, .size = 100, .change = .update_hook, .work = .{ 0, 0, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 4 } },
        // A wide parent without a filter: 100 boxes, one with an UPDATE hook.
        .{ .shape = .boxes, .size = 100, .change = .update_hook, .work = .{ 0, 0, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 2 } },
        .{ .shape = .scroll, .size = 100, .change = .paint_hook, .work = .{ 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0 } },
    };
    for (rows) |row| {
        var target = try bench.Scene.init(testing.allocator, testing.io, row.shape, row.size);
        defer target.deinit();
        const state = (try target.owner.raw().getRenderable(target.root)).scene_node.?.owner;
        // The second changed frame: the first one also settles hooks registered by the change.
        // A steady change repeats it, so retention outlives a frame's host requests; its first
        // frame also drops the children that needed feedback once the scene was built (B5b).
        _ = try target.frame(row.change);
        const steady = row.change == .unchanged or row.change == .update_hook or row.change == .paint_hook;
        if (steady) _ = try target.frame(row.change);
        for (0..@as(usize, if (steady) 2 else 1)) |_| {
            const stamps = state.test_stamp_steps;
            const lookups = state.test_record_lookups;
            const child_steps = state.test_feedback_child_steps;
            const w = try target.frame(row.change);
            var actual: [21]u64 = undefined;
            inline for (std.meta.fields(FrameWork)[1..], 0..) |field, index| actual[index] = @field(w, field.name);
            actual[18] = state.test_stamp_steps - stamps;
            actual[19] = state.test_record_lookups - lookups;
            actual[20] = state.test_feedback_child_steps - child_steps;
            try testing.expectEqual(row.work, actual);
        }
    }
}

test "Scene scroll node frames ask the host nothing and toggle bars a bounded number of times" {
    const bench = @import("../bench/scene-frame_bench.zig");
    for ([_]u32{ 16, 256, 4096 }) |size| for ([_]bench.Change{ .unchanged, .scroll, .append }) |change| {
        var target = try bench.Scene.init(testing.allocator, testing.io, .scroll_node, size);
        defer target.deinit();
        _ = try target.frame(change);
        const w = try target.frame(change);
        try testing.expectEqual(@as(u32, 0), w.host_requests);
        try testing.expectEqual(@as(u32, 1), w.layout_rounds);
        try testing.expectEqual(@as(u64, @intFromBool(change == .append)), w.yoga_solves);
        try testing.expectEqual(if (change == .append) size + 7 else 0, w.geometry_reads);
    };
    // A 4x3 scroll node whose child is as tall as it is wide: the bar narrows the child until it
    // fits, which hides the bar. The third toggle shows it again, and it may not hide after that.
    const f = try Fixture.init(testing.allocator, 4, 3, .{});
    defer f.deinit();
    const box = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_BOX, 2);
    try f.owner.sceneMoveNode(box, f.root, 0);
    for (0..2) |kind| try f.owner.sceneSetStyle(box, 4, @intCast(kind), 0, 1, @floatFromInt(4 - kind), 1);
    try f.owner.sceneSetScroll(box, .{});
    const child = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_BOX, 3);
    try f.owner.sceneMoveNode(child, box, 0);
    try f.owner.sceneSetStyle(child, 4, 0, 0, c.OT_UNIT_PERCENT, 100, 0);
    try f.owner.sceneSetStyle(child, c.OT_STYLE_FLOAT, c.OT_STYLE_FLOAT_ASPECT_RATIO, 0, 0, 1, 0);
    try f.owner.sceneSetStyle(child, c.OT_STYLE_FLOAT, c.OT_STYLE_FLOAT_FLEX_SHRINK, 0, 0, 0, 0);
    const first = try presentWork(f, .{});
    try testing.expectEqual(@as(u32, 4), first.layout_rounds);
    try testing.expectEqual(@as(u64, 4), first.yoga_solves);
    try testing.expect((try f.owner.sceneGetScroll(box)).bars[1].visible != 0);
    // From the held bar, a new frame's count starts over: it hides the bar, shows it, and holds.
    try f.owner.sceneSetStyle(child, c.OT_STYLE_VALUE, c.OT_STYLE_VALUE_MIN_WIDTH, 0, c.OT_UNIT_POINT, 0, 0);
    try testing.expectEqual(@as(u32, 3), (try presentWork(f, .{})).layout_rounds);
    // Content that first overflows solves once more, for the bar's gutter, before any hook.
    try f.owner.sceneDestroyNode(child);
    _ = try presentWork(f, .{});
    for (0..4) |index| {
        const row = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_BOX, @intCast(4 + index));
        try f.owner.sceneSetStyle(row, 4, 1, 0, 1, 1, 1);
        try f.owner.sceneMoveNode(row, box, @intCast(index));
        const work_done = try presentWork(f, .{});
        try testing.expectEqual(@as(u64, if (index == 3) 2 else 1), work_done.yoga_solves);
        try testing.expectEqual(index == 3, (try f.owner.sceneGetScroll(box)).bars[1].visible != 0);
    }
    // An overlay bar takes no gutter, so its toggle neither solves nor walks again.
    try f.owner.sceneSetScroll(box, .{ .bars = .{ .{}, .{ .overlay = true } } });
    _ = try presentWork(f, .{});
    try f.owner.sceneDestroyNode((try f.owner.raw().getRenderable(box)).scene_node.?.children.items[3].scene_node.?.handle);
    const hidden = try presentWork(f, .{});
    try testing.expectEqual(@as(u32, 1), hidden.layout_rounds);
    try testing.expect((try f.owner.sceneGetScroll(box)).bars[1].visible == 0);
    // Without culling or a SCROLL hook a scroll node adds no hook or filter: idle frames reuse
    // their work and skip paint.
    try testing.expectEqual(@as(u32, 0), f.state.hook_count + f.state.filter_count);
    const idle = try presentWork(f, .{});
    try testing.expectEqual(@as(u64, 0), idle.candidate_visits);
    try testing.expectEqual(@as(u32, 0), idle.damage_rows);
}
