const std = @import("std");
const testing = std.testing;
const Fixture = @import("scene_fixture_test.zig").Fixture;
const context = @import("../context.zig");
const scene = @import("../scene.zig");
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

test "Scene frame authority checks every field in layout update prefix paint and work phases" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const peer = try context.Context.init(testing.allocator, testing.io, .{});
    defer peer.deinit() catch unreachable;
    const id = try setup(owner);
    const other = try setup(owner);
    const foreign = try setup(peer);
    const state = (try owner.getSession(id)).scene.?;
    const root = state.root.?.scene_node.?.handle;
    try owner.sceneSetHooks(root, 5, 1, 4, 1);
    for (0..2) |index| {
        const child = try owner.sceneCreateNode(id, 1, @intCast(index + 2));
        try owner.sceneSetStyle(child, 4, 0, 0, 1, 1, 1);
        try owner.sceneSetStyle(child, 4, 1, 0, 1, 1, 1);
        try owner.sceneMoveNode(child, root, @intCast(index));
        if (index == 0) try owner.sceneSetHooks(child, 59, 1, 0, 0);
    }
    var seen = [_]bool{false} ** 8;
    var work_yield = false;
    var paint_yield = false;
    var previous: ?scene.FrameRequest = null;
    for (0..128) |_| {
        const request = try owner.sceneFrameStepWorkBudgeted(id, previous, options, 1, 1);
        seen[request.kind] = true;
        if (request.kind == 6) {
            work_yield = work_yield or state.prefix == null;
            paint_yield = paint_yield or state.prefix != null;
        }
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
            try testing.expectError(expected, owner.sceneFrameStepWorkBudgeted(id, forged, options, 1, 1));
        }
        var wrong_context = request;
        wrong_context.session.context_id += 1;
        try testing.expectError(error.WrongContext, owner.sceneFrameStep(id, wrong_context, options));
        if (previous) |consumed| try testing.expectError(error.StaleFrame, owner.sceneFrameStep(id, consumed, options));
        if (request.kind == 0 or request.kind == 4 or request.kind == 5 or request.kind == 7) {
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
    try testing.expect(work_yield and paint_yield);
}

test "Scene frame resize retires storage without replacing painted or prefix tickets" {
    for ([_]bool{ false, true }) |painted| {
        const f = try Fixture.init(testing.allocator, 4, 1, .{});
        defer f.deinit();
        if (!painted) _ = try prefix(f.owner, f.id);
        var frame = try f.step(null, options, if (painted) 0 else 4, null);
        const original = frame;
        const lease = try f.owner.sceneFrameAcquireBufferLease(f.id, frame, .next);
        const before = try f.owner.bufferLeaseSnapshot(lease);
        before.buffer.char[0] = 'A';
        try f.owner.resizeSessionRenderer(f.id, 4, 1);
        try testing.expectEqualDeep(before, try f.owner.bufferLeaseSnapshot(lease));
        try f.owner.resizeSessionRenderer(f.id, 5, 1);
        try testing.expectError(error.StaleLease, f.owner.bufferLeaseSnapshot(lease));
        before.buffer.char[0] = 'Z';
        if (painted) {
            try testing.expectError(error.FrameBusy, f.owner.sceneFrameCommit(f.id, frame, true));
        } else try testing.expectError(error.FrameBusy, f.owner.sceneFrameStep(f.id, frame, options));
        const replacement = try f.owner.sceneFrameAcquireBufferLease(f.id, frame, .next);
        const after = try f.owner.bufferLeaseSnapshot(replacement);
        try testing.expectEqual(before.generation + 1, after.generation);
        try testing.expectEqual(@as(u32, 5), after.width);
        try testing.expectEqual(@as(u32, ' '), after.buffer.char[0]);
        after.buffer.char[4] = 'B';
        try f.owner.releaseBufferLease(lease);
        try f.owner.releaseBufferLease(replacement);
        if (!painted) {
            frame = try f.step(frame, options, 5, null);
            frame = try f.step(frame, options, 0, null);
        }
        try testing.expectEqual(original.frame_id, frame.frame_id);
        try testing.expectEqual(original.layout_epoch, frame.layout_epoch);
        _ = try f.owner.sceneFrameCommit(f.id, frame, true);
        try drain(f.owner, f.id);
        try testing.expectEqual(@as(u32, 'B'), f.cli.getCurrentBuffer().buffer.char[4]);
    }
}

test "Scene frame cancellation revokes painted and prefix authority but pins scratch cells until release" {
    for ([_]bool{ false, true }) |hooked| {
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
        const pending = if (hooked) try prefix(f.owner, f.id) else null;
        const frame = try f.step(null, options, if (hooked) 4 else 0, pending);
        const lease = try f.owner.sceneFrameAcquireBufferLease(f.id, frame, .next);
        const snapshot = try f.owner.bufferLeaseSnapshot(lease);
        snapshot.buffer.char[0] = 'Z';
        if (pending) |node| try f.owner.sceneDestroyNode(node);
        _ = try f.owner.bufferLeaseSnapshot(lease);
        try f.owner.sceneFrameCancel(f.id, frame.frame_id);
        try testing.expectEqual(@as(u32, 2), try f.owner.sceneHitTest(f.id, 0, 0));
        try testing.expectEqual(@as(u32, 0), try f.owner.sceneHitTest(f.id, 1, 0));
        for ((try f.owner.getSessionRenderer(f.id)).nextHitGrid) |hit| try testing.expectEqual(@as(u32, 0), hit);
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
        const commits = [_]@import("../renderer.zig").SplitSnapshot{.{ .snapshot = try f.owner.getBuffer(retained), .row_columns = 4 }};
        try testing.expectEqual(.pending, try (try f.owner.getSession(f.id)).renderSplit(null, &commits, 0, true));
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
        const frame = try f.owner.sceneFrameStep(f.id, null, options);
        try testing.expectError(expected, f.owner.sceneFrameAcquireBufferLease(f.id, frame, .next));
        try testing.expectEqual(@as(u32, 0), f.owner.lease_count);
        try testing.expectEqual(@as(u64, 0), f.owner.lease_bytes);
        _ = try f.owner.sceneFrameCommit(f.id, frame, true);
        try drain(f.owner, f.id);
    }
}

test "Scene painted commit rejection revokes the draft without publishing output or replaying it" {
    const f = try Fixture.init(testing.allocator, 4, 1, .{ .output = transport });
    defer f.deinit();
    const frame = try f.owner.sceneFrameStep(f.id, null, options);
    f.cli.splitBatchActive = true;
    try testing.expectError(error.SplitRenderPending, f.owner.sceneFrameCommit(f.id, frame, true));
    f.cli.splitBatchActive = false;
    try testing.expectError(error.StaleFrame, f.owner.sceneFrameCommit(f.id, frame, true));
    try testing.expectError(error.StaleFrame, f.owner.renderSession(f.id, true));
    try testing.expectEqual(@as(u64, 0), (try f.owner.getSession(f.id)).getStats().bytes_written);
    const retry = try f.owner.sceneFrameStep(f.id, null, options);
    _ = try f.owner.sceneFrameCommit(f.id, retry, true);
    try drain(f.owner, f.id);
}

fn prefix(owner: *context.Context, id: context.Handle) !context.Handle {
    const root = (try owner.getSession(id)).scene.?.root.?.scene_node.?.handle;
    const child = try owner.sceneCreateNode(id, 1, 2);
    try owner.sceneSetStyle(child, 4, 0, 0, 1, 1, 1);
    try owner.sceneSetHooks(child, 8 | 16, 1, 1, 1);
    try owner.sceneMoveNode(child, root, 0);
    return child;
}

test "Scene frame terminal transitions retain painted and prefix scopes but forbid new paint or capture" {
    for ([_]bool{ false, true }) |painted| {
        for ([_]bool{ false, true }) |should_suspend| {
            const f = try Fixture.init(testing.allocator, 4, 1, .{ .output = transport });
            defer f.deinit();
            defer f.owner.cancelSession(f.id) catch unreachable;
            if (should_suspend) {
                try f.owner.setupSessionTerminal(f.id, .{});
                for (0..32) |_| {
                    try drain(f.owner, f.id);
                    if ((try f.owner.pumpSession(f.id, 0, 8)).status == .idle) break;
                } else return error.TestUnexpectedResult;
            }
            if (!painted) _ = try prefix(f.owner, f.id);
            const before = try f.step(null, options, if (painted) 0 else 4, null);
            const lease = try f.owner.sceneFrameAcquireBufferLease(f.id, before, .next);
            errdefer f.owner.releaseBufferLease(lease) catch {};
            const snapshot = try f.owner.bufferLeaseSnapshot(lease);
            if (should_suspend) try f.owner.suspendSession(f.id) else try f.owner.setupSessionTerminal(f.id, .{});
            try testing.expectEqualDeep(snapshot, try f.owner.bufferLeaseSnapshot(lease));
            try testing.expectError(error.TerminalInactive, f.owner.sceneFrameAcquireBufferLease(f.id, before, .next));
            try f.owner.releaseBufferLease(lease);
            if (painted) {
                try testing.expectError(error.TerminalInactive, f.owner.sceneFrameCommit(f.id, before, true));
            } else try testing.expectError(error.TerminalInactive, f.owner.sceneFrameStep(f.id, before, options));
            try f.owner.sceneFrameCancel(f.id, before.frame_id);
        }
    }
}

test "Scene prefix root destruction retains scoped cells until explicit cancellation" {
    const f = try Fixture.init(testing.allocator, 4, 1, .{ .output = transport });
    defer f.deinit();
    _ = try prefix(f.owner, f.id);
    const before = try f.owner.sceneFrameStep(f.id, null, options);
    const lease = try f.owner.sceneFrameAcquireBufferLease(f.id, before, .next);
    defer f.owner.releaseBufferLease(lease) catch unreachable;
    const snapshot = try f.owner.bufferLeaseSnapshot(lease);
    snapshot.buffer.char[0] = 'A';
    try f.owner.sceneDestroyNode(f.root);
    try testing.expectEqualDeep(snapshot, try f.owner.bufferLeaseSnapshot(lease));
    const nested = try f.owner.sceneFrameAcquireBufferLease(f.id, before, .next);
    defer f.owner.releaseBufferLease(nested) catch unreachable;
    try testing.expectEqual(@as(u32, 'A'), (try f.owner.bufferLeaseSnapshot(nested)).buffer.char[0]);
    try f.owner.sceneFrameCancel(f.id, before.frame_id);
    try testing.expectError(error.StaleLease, f.owner.bufferLeaseSnapshot(lease));
}

test "Scene idle update consumes its traversal position without retroactive activation" {
    for ([_]u32{ 0, 64 }) |initial_flags| for ([_]bool{ false, true }) |activate_before| {
        const f = try Fixture.init(testing.allocator, 4, 1, .{ .output = transport });
        defer f.deinit();
        const idle = try f.owner.sceneCreateNode(f.id, 1, 2);
        const sibling = try f.owner.sceneCreateNode(f.id, 1, 3);
        try f.owner.sceneMoveNode(if (activate_before) sibling else idle, f.root, 0);
        try f.owner.sceneMoveNode(if (activate_before) idle else sibling, f.root, 1);
        try f.owner.sceneSetHooks(idle, initial_flags, 1, 0, 0);
        try f.owner.sceneSetHooks(sibling, 1, 1, 0, 0);
        var request = try f.step(null, options, 1, sibling);
        try f.owner.sceneSetHooks(idle, 1, 2, 0, 0);
        var updates: u32 = 0;
        for (0..8) |_| {
            request = try f.owner.sceneFrameStep(f.id, request, options);
            if (request.kind == 0) break;
            try testing.expectEqual(@as(u32, 1), request.kind);
            try testing.expectEqual(idle, request.node);
            updates += 1;
        } else return error.TestUnexpectedResult;
        try testing.expectEqual(@as(u32, @intFromBool(activate_before or initial_flags == 0)), updates);
        try f.owner.sceneFrameCancel(f.id, request.frame_id);
        var previous: ?scene.FrameRequest = null;
        updates = 0;
        for (0..8) |_| {
            request = try f.owner.sceneFrameStep(f.id, previous, options);
            if (request.kind == 0) break;
            if (std.meta.eql(request.node, idle)) updates += 1;
            previous = request;
        } else return error.TestUnexpectedResult;
        try testing.expectEqual(@as(u32, 1), updates);
        try f.owner.sceneFrameCancel(f.id, request.frame_id);
    };
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
    try testing.expectEqual(@as(u64, 1), (try f.owner.getRenderable(child)).scene_node.?.hook_generation);
    const frame = try f.step(null, options, 0, null);
    try testing.expectEqual(@as(usize, 0), f.state.feedback.capacity);
    for ([_]context.Handle{ f.root, child }) |node| try testing.expectEqual(frame.frame_id, (try f.owner.getRenderable(node)).scene_node.?.update_frame);
    try f.owner.sceneFrameCancel(f.id, frame.frame_id);
    try f.owner.scenePaint(f.id, options.background, true, 0);
    try f.owner.sceneSetHooks(child, 64 | 8, 2, 0, 0);
    try testing.expectEqual(@as(u32, 1), f.state.hook_count);
    try testing.expectEqual(@as(u32, 0), f.state.layout_hook_count);
    try f.owner.sceneDestroyNode(child);
    try f.owner.sceneDestroyNode(f.root);
    try testing.expectEqual(@as(u32, 0), f.state.hook_count);
    try testing.expectEqual(@as(u32, 0), f.state.layout_hook_count);
}
