const std = @import("std");
const testing = std.testing;
const context = @import("../context.zig");
const scene = @import("../scene.zig");
const ansi = @import("../ansi.zig");
const Fixture = @import("scene_fixture_test.zig").Fixture;

const frame_options: scene.FrameOptions = .{
    .background = .{ 0, 0, 0, 255 },
    .use_mouse = true,
    .excluded_hit_num = 0,
    .max_layout_rounds = 8,
    .max_host_requests = 65536,
};

fn box(owner: *context.Context, id: context.Handle, num: u32, z: i32) !context.Handle {
    const child = try owner.sceneCreateNode(id, 1, num);
    try owner.sceneSetStyle(child, 4, 0, 0, 1, 2, 1);
    try owner.sceneSetStyle(child, 4, 1, 0, 1, 1, 1);
    try owner.sceneSetStyle(child, 0, 6, 0, 0, 2, 0);
    try owner.sceneSetPaint(child, .{ .zIndex = z, .background = .{ @intCast(num), 0, 0, 255 } });
    return child;
}

fn setZ(owner: *context.Context, child: context.Handle, z: i32) !void {
    var paint = (try owner.getRenderable(child)).scene_node.?.paint;
    paint.zIndex = z;
    try owner.sceneSetPaint(child, paint);
}

fn frame(f: Fixture, updates: []const context.Handle) !void {
    var request: ?scene.FrameRequest = null;
    for (updates) |child| {
        request = try f.step(request, frame_options, 1, child);
    }
    _ = try f.step(request, frame_options, 0, null);
}

fn expectTop(f: Fixture, child: context.Handle) !void {
    const node = &(try f.owner.getRenderable(child)).scene_node.?;
    for (0..2) |x| {
        const cell = f.cli.getNextBuffer().get(@intCast(x), 0).?;
        try testing.expectEqual(@as(u32, ' '), cell.char);
        try testing.expectEqual(ansi.rgbColor(@intCast(node.num), 0, 0, 255), cell.bg);
        try testing.expectEqual(node.token, f.cli.nextHitGrid[x]);
    }
    _ = try f.owner.sceneFrameCommit(f.id, f.state.painted.?.ticket, true);
    var bytes: [4096]u8 = undefined;
    var reads: u32 = 0;
    while (try f.owner.readOutput(f.id, &bytes)) |ticket| {
        try testing.expect(reads < 2);
        reads += 1;
        try f.owner.completeOutput(f.id, ticket, .written);
    }
    for (0..2) |x| try testing.expectEqual(node.num, try f.owner.sceneHitTest(f.id, @intCast(x), 0));
}

fn orderedAppend(z_step: i32) !void {
    for ([_]bool{ false, true }) |hooks| {
        const f = try Fixture.init(testing.allocator, 2, 1, .{});
        defer f.deinit();
        var children: [68]context.Handle = undefined;
        for (children[0..64], 0..) |*child, index| {
            child.* = try box(f.owner, f.id, @intCast(index + 2), z_step * @as(i32, @intCast(index)));
            try f.owner.sceneMoveNode(child.*, f.root, @intCast(index));
            if (hooks) try f.owner.sceneSetHooks(child.*, 1, 1, 2, 1);
        }
        try frame(f, if (hooks) children[0..64] else &.{});
        try expectTop(f, children[63]);
        for (64..children.len) |index| {
            f.state.test_sort_steps = 0;
            children[index] = try box(f.owner, f.id, @intCast(index + 2), z_step * @as(i32, @intCast(index)));
            try f.owner.sceneMoveNode(children[index], f.root, @intCast(index));
            if (hooks) try f.owner.sceneSetHooks(children[index], 1, 1, 2, 1);
            try frame(f, if (hooks) children[0 .. index + 1] else &.{});
            try expectTop(f, children[index]);
            try testing.expectEqual(@as(u64, 0), f.state.test_sort_steps);
        }
    }
}

test "Scene ordered equal-z append skips settled sibling rank and sort work" {
    try orderedAppend(0);
}

test "Scene ordered increasing-z append skips settled sibling rank and sort work" {
    try orderedAppend(1);
}

test "Scene ordered attachments preserve paint ties across insertBefore reparent and detach" {
    const f = try Fixture.init(testing.allocator, 2, 1, .{});
    defer f.deinit();
    const first = try box(f.owner, f.id, 2, 0);
    const second = try box(f.owner, f.id, 3, 0);
    const third = try box(f.owner, f.id, 4, 0);
    for ([_]context.Handle{ first, second, third }) |child| {
        try f.owner.sceneSetHooks(child, 1, 1, 2, 1);
    }
    try f.owner.sceneMoveNode(first, f.root, 0);
    try f.owner.sceneMoveNode(second, f.root, 1);
    try frame(f, &.{ first, second });
    try expectTop(f, second);
    f.state.test_sort_steps = 0;

    try f.owner.sceneMoveNode(third, f.root, 0);
    try frame(f, &.{ first, second, third });
    try expectTop(f, third);
    try f.owner.sceneMoveNode(second, f.root, 0);
    try frame(f, &.{ first, second, third });
    try expectTop(f, third);

    const detached_parent = try box(f.owner, f.id, 5, 0);
    try f.owner.sceneMoveNode(first, detached_parent, 0);
    try frame(f, &.{ second, third });
    try expectTop(f, third);
    try f.owner.sceneMoveNode(first, f.root, 0);
    try frame(f, &.{ second, third, first });
    try expectTop(f, first);
    try f.owner.sceneMoveNode(first, null, 0);
    try frame(f, &.{ second, third });
    try expectTop(f, third);
    try f.owner.sceneMoveNode(first, f.root, 0);
    try frame(f, &.{ second, third, first });
    try expectTop(f, first);
    try f.owner.sceneDestroyNode(first);
    try frame(f, &.{ second, third });
    try expectTop(f, third);
    try testing.expectEqual(@as(u64, 0), f.state.test_sort_steps);
}

test "Scene ordered attachments retain lower-z sorting and preexisting dirtiness" {
    const f = try Fixture.init(testing.allocator, 2, 1, .{});
    defer f.deinit();
    const first = try box(f.owner, f.id, 2, 5);
    const second = try box(f.owner, f.id, 3, 5);
    const lower = try box(f.owner, f.id, 4, 0);
    const higher = try box(f.owner, f.id, 5, 6);
    for ([_]context.Handle{ first, second, lower, higher }) |child| {
        try f.owner.sceneSetHooks(child, 1, 1, 2, 1);
    }
    try f.owner.sceneMoveNode(first, f.root, 0);
    try f.owner.sceneMoveNode(second, f.root, 1);
    try frame(f, &.{ first, second });
    try expectTop(f, second);
    f.state.test_sort_steps = 0;

    try f.owner.sceneMoveNode(lower, f.root, 2);
    try frame(f, &.{ lower, first, second });
    try expectTop(f, second);
    try testing.expect(f.state.test_sort_steps >= 3);
    f.state.test_sort_steps = 0;

    try setZ(f.owner, first, 10);
    try f.owner.sceneMoveNode(higher, f.root, 3);
    try frame(f, &.{ lower, second, higher, first });
    try expectTop(f, first);
    try testing.expect(f.state.test_sort_steps >= 4);

    try setZ(f.owner, first, 5);
    try frame(f, &.{ lower, second, first, higher });
    try expectTop(f, higher);
}

test "Scene ordered append preserves selected siblings through z mutation and feedback" {
    const f = try Fixture.init(testing.allocator, 2, 1, .{});
    defer f.deinit();
    var children: [4]context.Handle = undefined;
    for (&children, 0..) |*child, index| {
        child.* = try box(f.owner, f.id, @intCast(index + 2), @intCast(index));
        try f.owner.sceneSetHooks(child.*, 1, 1, 2, 1);
        if (index < 3) try f.owner.sceneMoveNode(child.*, f.root, @intCast(index));
    }
    try frame(f, children[0..3]);
    try expectTop(f, children[2]);
    f.state.test_sort_steps = 0;

    var request = try f.owner.sceneFrameStep(f.id, null, frame_options);
    try testing.expectEqual(children[0], request.node);
    try testing.expectEqual(@as(u32, 1), request.kind);
    const epoch = request.layout_epoch;
    try setZ(f.owner, children[0], 10);
    try f.owner.sceneMoveNode(children[3], f.root, 0);
    for (children[1..]) |child| {
        request = try f.owner.sceneFrameStep(f.id, request, frame_options);
        try testing.expectEqual(child, request.node);
        try testing.expectEqual(@as(u32, 1), request.kind);
    }
    try testing.expectEqual(epoch + 1, request.layout_epoch);
    try testing.expectEqual(@as(u32, 2), f.state.attempt.?.rounds);
    try testing.expectEqual(@as(u32, 0), (try f.owner.sceneFrameStep(f.id, request, frame_options)).kind);
    try expectTop(f, children[3]);
    try testing.expectEqual(@as(u64, 0), f.state.test_sort_steps);

    try frame(f, &.{ children[1], children[2], children[3], children[0] });
    try expectTop(f, children[0]);
    try testing.expect(f.state.test_sort_steps >= children.len);

    for (children[1..]) |child| try f.owner.sceneSetHooks(child, 0, 2, 2, 1);
    request = try f.owner.sceneFrameStep(f.id, null, frame_options);
    try testing.expectEqual(children[0], request.node);
    try testing.expectEqual(@as(u32, 1), request.kind);
    try setZ(f.owner, children[1], 20);
    try f.owner.sceneSetHooks(children[0], 0, 2, 2, 1);
    try testing.expectEqual(@as(u32, 0), (try f.owner.sceneFrameStep(f.id, request, frame_options)).kind);
    try testing.expectEqual(@as(u32, 0), f.state.hook_count);
    try testing.expect(f.state.root.?.scene_node.?.sort_dirty);
    try testing.expectEqual(@as(usize, 0), f.state.work.items.len);
    try expectTop(f, children[0]);

    f.state.test_prepare_steps = 0;
    try frame(f, &.{});
    try testing.expect(f.state.test_prepare_steps > 0);
    try expectTop(f, children[1]);
    try testing.expect(!f.state.root.?.scene_node.?.sort_dirty);
}
