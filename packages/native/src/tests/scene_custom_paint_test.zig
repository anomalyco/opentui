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
        const token = (try f.owner.getRenderable(child)).scene_node.?.token;
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

test "Scene custom paint shares host limits and member budgets without replenishing on self replies" {
    const f = try Fixture.init(testing.allocator, 8, 1, .{ .output = transport });
    defer f.deinit();
    for (0..2) |index| {
        const child = try node(f.owner, f.id, f.root, 6, @intCast(index + 2), @intCast(index));
        try f.owner.sceneSetHooks(child, 56, 1, 2, 1);
    }
    _ = try node(f.owner, f.id, f.root, 1, 4, 2);
    var limited = options;
    limited.max_host_requests = 6;
    var previous: ?scene.FrameRequest = null;
    for ([_]u32{ 4, 7, 5, 6, 4, 7, 5, 6, 0 }, 0..) |kind, index| {
        const request = try f.owner.sceneFrameStepBudgeted(f.id, previous, limited, 1);
        try testing.expectEqual(kind, request.kind);
        if (kind != 0) try testing.expectEqual(@as(u64, index + 1), request.request_id);
        if (kind == 6) try testing.expectError(error.StaleFrame, f.state.checkFrameAccess(request));
        previous = request;
    }
    try f.owner.sceneFrameCancel(f.id, previous.?.frame_id);
    limited.max_host_requests = 5;
    previous = null;
    for (0..6) |_| previous = try f.owner.sceneFrameStepBudgeted(f.id, previous, limited, 1);
    try testing.expectEqual(@as(u32, 7), previous.?.kind);
    try testing.expectError(error.FrameRequestLimit, f.owner.sceneFrameStepBudgeted(f.id, previous, limited, 1));
    try testing.expect(f.state.attempt == null and f.state.prefix == null and f.state.painted == null);
    try testing.expectEqual(@as(usize, 0), f.state.paint_members.items.len);
    try testing.expectError(error.StaleFrame, f.state.checkFrameAccess(previous.?));
    for (f.cli.nextHitGrid) |hit| try testing.expectEqual(@as(u32, 0), hit);
    try testing.expectEqual(@as(usize, 0), f.cli.getNextBuffer().opacity_stack.items.len);
    try testing.expectEqual(@as(usize, 0), f.cli.getNextBuffer().scissor_stack.items.len);
}

test "Scene custom paint admits self on every nonroot kind and custom nodes have no implicit Box drawing" {
    const f = try Fixture.init(testing.allocator, 8, 1, .{ .output = transport });
    defer f.deinit();
    try testing.expectError(error.InvalidOptions, f.state.prepareInsert(9, 100));
    for ([_]u32{ 8, 16, 32, 56, 256 }) |flags| {
        try testing.expectError(error.InvalidOptions, f.owner.sceneSetHooks(f.root, flags, 1, 8, 1));
    }
    for (1..9) |kind| {
        const child = try node(f.owner, f.id, f.root, @intCast(kind), @intCast(kind + 1), 0);
        if (kind == 2) try f.owner.sceneSetText(child, "native text");
        try f.owner.sceneSetHooks(child, 32, 1, 2, 1);
        const registration = &(try f.owner.getRenderable(child)).scene_node.?;
        const hook_count = f.state.hook_count;
        for ([_]u32{ 256, 288, 312, 447 }) |flags| {
            try testing.expectError(error.InvalidOptions, f.owner.sceneSetHooks(child, flags, 2, 99, 99));
            try testing.expectEqual(@as(u32, 32), registration.hook_flags);
            try testing.expectEqual(@as(u64, 1), registration.hook_generation);
            try testing.expectEqual(@as(f64, 2), registration.resize_width);
            try testing.expectEqual(@as(f64, 1), registration.resize_height);
            try testing.expectEqual(hook_count, f.state.hook_count);
        }
        try testing.expectError(error.UnsupportedResource, f.owner.scenePaint(f.id, options.background, true, 0));
        try testing.expect(f.state.attempt == null);
        const self = try f.step(null, options, 7, null);
        const target = (try f.owner.getSessionRenderer(f.id)).getNextBuffer();
        try testing.expectEqual(@as(u32, ' '), target.get(0, 0).?.char);
        try testing.expectEqual(ansi.rgbColor(0, 0, 0, 255), target.get(0, 0).?.bg);
        const done = try f.step(self, options, 0, null);
        try testing.expectEqual(ansi.rgbColor(0, 0, 0, 255), target.get(0, 0).?.bg);
        try f.owner.sceneFrameCancel(f.id, done.frame_id);
        try f.owner.sceneDestroyNode(child);
    }
    const custom = try node(f.owner, f.id, f.root, 6, 10, 0);
    const done = try f.step(null, options, 0, null);
    try testing.expectEqual(ansi.rgbColor(0, 0, 0, 255), f.cli.getNextBuffer().get(0, 0).?.bg);
    try testing.expectEqual((try f.owner.getRenderable(custom)).scene_node.?.token, f.cli.nextHitGrid[0]);
    try f.owner.sceneFrameCancel(f.id, done.frame_id);
}

test "Scene custom paint text and editor before hooks require host self without changing rejected registration" {
    const f = try Fixture.init(testing.allocator, 8, 1, .{ .output = transport });
    defer f.deinit();
    for ([_]u32{ 2, 5, 7 }) |kind| {
        const child = try node(f.owner, f.id, f.state.root.?.scene_node.?.handle, kind, kind + 2, 0);
        if (kind == 2) try f.owner.sceneSetText(child, "T");
        try f.owner.sceneSetHooks(child, 16, 1, 2, 1);
        const registration = &(try f.owner.getRenderable(child)).scene_node.?;
        const hook_count = f.state.hook_count;
        for ([_]u32{ 8, 24 }) |flags| {
            try testing.expectError(error.InvalidOptions, f.owner.sceneSetHooks(child, flags, 2, 99, 99));
            try testing.expectEqual(@as(u32, 16), registration.hook_flags);
            try testing.expectEqual(@as(u64, 1), registration.hook_generation);
            try testing.expectEqual(@as(f64, 2), registration.resize_width);
            try testing.expectEqual(@as(f64, 1), registration.resize_height);
            try testing.expectEqual(hook_count, f.state.hook_count);
        }
        var request = try f.step(null, options, 5, null);
        if (kind == 2) try testing.expectEqual(@as(u32, 'T'), (try f.owner.getSessionRenderer(f.id)).getNextBuffer().get(0, 0).?.char);
        try f.owner.sceneFrameCancel(f.id, request.frame_id);
        try f.owner.sceneSetHooks(child, 56, 2, 2, 1);
        request = try f.step(null, options, 4, null);
        try f.owner.sceneDestroyNode(child);
        request = try f.step(request, options, 7, null);
        request = try f.step(request, options, 5, null);
        request = try f.step(request, options, 0, null);
        try f.owner.sceneFrameCancel(f.id, request.frame_id);
    }
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
