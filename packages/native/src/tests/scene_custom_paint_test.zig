const std = @import("std");
const testing = std.testing;
const Fixture = @import("scene_fixture_test.zig").Fixture;
const context = @import("../context.zig");
const scene = @import("../scene.zig");
const transport: @import("../session.zig").Options = .{ .chunk_size = 4096, .control_capacity = 4096 };
const ansi = @import("../ansi.zig");

const options: scene.FrameOptions = .{
    .background = .{ 0, 0, 0, 255 },
    .use_mouse = true,
    .excluded_hit_num = 0,
    .max_layout_rounds = 8,
    .max_host_requests = 64,
};

pub fn node(owner: *context.Context, id: context.Handle, parent: context.Handle, kind: u32, num: u32, index: u32) !context.Handle {
    const child = try owner.sceneCreateNode(id, kind, num);
    try owner.sceneSetStyle(child, 4, 0, 0, 1, 2, 1);
    try owner.sceneSetStyle(child, 4, 1, 0, 1, 1, 1);
    try owner.sceneSetStyle(child, 0, 6, 0, 0, 2, 0);
    try owner.sceneSetPaint(child, .{ .background = .{ @intCast(num), 0, 0, 255 } });
    try owner.sceneMoveNode(child, parent, index);
    return child;
}

test "Scene custom paint self ticket leases survive hook replacement but not acknowledgement or cancellation" {
    const f = try Fixture.init(testing.allocator, 8, 1, .{ .output = transport });
    defer f.deinit();
    const child = try node(f.owner, f.id, f.state.root.?.scene_node.?.handle, 6, 2, 0);
    try f.owner.sceneSetHooks(child, 48, 1, 2, 1);
    const self = try f.step(null, options, 7, null);
    try f.owner.sceneSetHooks(child, 16, 2, 2, 1);
    const lease = try f.owner.sceneFrameAcquireBufferLease(f.id, self, .next);
    (try f.owner.bufferLeaseSnapshot(lease)).buffer.char[0] = 'S';
    try testing.expectError(error.FrameBusy, f.owner.sceneFrameStep(f.id, self, options));
    try f.owner.releaseBufferLease(lease);
    const after = try f.step(self, options, 5, null);
    try testing.expectEqual(@as(u64, 2), after.hook_generation);
    try testing.expectError(error.StaleFrame, f.state.checkFrameAccess(self));
    try testing.expectError(error.StaleFrame, f.owner.sceneFrameStep(f.id, self, options));
    try f.owner.sceneFrameCancel(f.id, after.frame_id);
    try testing.expectError(error.StaleFrame, f.state.checkFrameAccess(after));
    try testing.expectEqual(@as(usize, 0), f.cli.getNextBuffer().scissor_stack.items.len);
    try testing.expectEqual(@as(usize, 0), f.cli.getNextBuffer().opacity_stack.items.len);
    for (f.cli.nextHitGrid) |hit| try testing.expectEqual(@as(u32, 0), hit);
    try testing.expectError(error.StaleFrame, f.owner.renderSession(f.id, true));
}

test "Scene custom paint entered destruction retains self after and lease authority without retaining the node" {
    for ([_]u32{ 1, 6 }) |kind| {
        const f = try Fixture.init(testing.allocator, 8, 1, .{ .output = transport });
        defer f.deinit();
        const child = try node(f.owner, f.id, f.root, kind, 2, 0);
        if (kind == 1) try f.owner.sceneSetBoxDetails(child, .{ .title = "owned title" });
        const token = (try f.owner.raw().getRenderable(child)).scene_node.?.token;
        try f.owner.sceneSetHooks(child, 56, 1, 2, 1);
        const before = try f.step(null, options, 4, null);
        try f.owner.sceneSetHooks(child, 56, 2, 2, 1);
        try f.owner.sceneDestroyNode(child);
        const replacement = try node(f.owner, f.id, f.root, kind, 3, 0);
        try f.owner.sceneSetHooks(replacement, 56, 1, 2, 1);
        try testing.expectEqual(child.slot, replacement.slot);
        try testing.expect(child.generation != replacement.generation);
        const self = try f.step(before, options, 7, child);
        try testing.expectEqual(@as(u64, 2), self.hook_generation);
        const lease = try f.owner.sceneFrameAcquireBufferLease(f.id, self, .next);
        (try f.owner.bufferLeaseSnapshot(lease)).buffer.char[0] = 'D';
        try f.owner.releaseBufferLease(lease);
        const after = try f.step(self, options, 5, child);
        _ = try f.state.checkFrameAccess(after);
        const done = try f.step(after, options, 0, null);
        try testing.expectEqual(@as(u32, 'D'), f.cli.getNextBuffer().get(0, 0).?.char);
        try testing.expectEqual(token, f.cli.nextHitGrid[0]);
        try testing.expect(f.state.tokens.get(token) == null);
        try f.owner.sceneFrameCancel(f.id, done.frame_id);
    }
}

test "Scene custom paint root destruction invalidates resume not the outstanding self scope" {
    const f = try Fixture.init(testing.allocator, 8, 1, .{ .output = transport });
    defer f.deinit();
    const child = try node(f.owner, f.id, f.root, 6, 2, 0);
    try f.owner.sceneSetHooks(child, 48, 1, 2, 1);
    const self = try f.owner.sceneFrameStep(f.id, null, options);
    const lease = try f.owner.sceneFrameAcquireBufferLease(f.id, self, .next);
    try f.owner.sceneDestroyNode(f.root);
    _ = try f.owner.sceneCreateNode(f.id, 0, 3);
    _ = try f.owner.bufferLeaseSnapshot(lease);
    try testing.expectError(error.FrameBusy, f.owner.sceneFrameStep(f.id, self, options));
    try f.owner.releaseBufferLease(lease);
    try testing.expectError(error.StaleFrame, f.owner.sceneFrameStep(f.id, self, options));
    try testing.expect(f.state.prefix == null and f.state.attempt == null);
    try testing.expectError(error.StaleFrame, f.state.checkFrameAccess(self));
    try testing.expectError(error.StaleFrame, f.owner.renderSession(f.id, true));
}

fn allocationFailures(allocator: std.mem.Allocator) !void {
    const f = try Fixture.init(allocator, 8, 1, .{ .output = transport });
    defer f.deinit();
    const child = try node(f.owner, f.id, f.state.root.?.scene_node.?.handle, 1, 2, 0);
    try f.owner.sceneSetBoxDetails(child, .{ .title = "owned until cancel", .bottom_title = "bottom" });
    try f.owner.sceneSetHooks(child, 56, 1, 2, 1);
    const before = try f.owner.sceneFrameStep(f.id, null, options);
    try f.owner.sceneDestroyNode(child);
    const self = try f.owner.sceneFrameStep(f.id, before, options);
    const lease = try f.owner.sceneFrameAcquireBufferLease(f.id, self, .next);
    _ = try f.owner.bufferLeaseSnapshot(lease);
    try f.owner.releaseBufferLease(lease);
    // A throwing host callback cancels instead of acknowledging its self request.
    try f.owner.sceneFrameCancel(f.id, self.frame_id);
}

test "Scene custom paint releases entered decorations and self leases on allocation failure or host cancellation" {
    try testing.checkAllAllocationFailures(testing.allocator, allocationFailures, .{});
}
