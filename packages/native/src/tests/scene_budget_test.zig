const std = @import("std");
const testing = std.testing;
const Fixture = @import("scene_fixture_test.zig").Fixture;
const context = @import("../context.zig");
const scene = @import("../scene.zig");
const transport: @import("../session.zig").Options = .{ .chunk_size = 4096, .control_capacity = 4096 };
const ansi = @import("../ansi.zig");
const c = @import("context_abi_c");

const options: scene.FrameOptions = .{
    .background = .{ 0, 0, 0, 255 },
    .use_mouse = true,
    .excluded_hit_num = 0,
    .max_layout_rounds = 8,
    .max_host_requests = 64,
};

fn box(owner: *context.Context, id: context.Handle, parent: context.Handle, num: u32, index: u32) !context.Handle {
    const child = try owner.sceneCreateNode(id, 1, num);
    try owner.sceneSetStyle(child, 4, 0, 0, 1, 1, 1);
    try owner.sceneSetStyle(child, 4, 1, 0, 1, 1, 1);
    try owner.sceneSetStyle(child, 0, 6, 0, 0, 2, 0);
    try owner.sceneSetPaint(child, .{ .translateX = @floatFromInt(index), .background = .{ @intCast(num), 0, 0, 255 } });
    try owner.sceneMoveNode(child, parent, index);
    return child;
}

test "Scene warmed preparation cannot bypass the work budget" {
    const f = try Fixture.init(testing.allocator, 12, 3, .{ .output = transport });
    defer f.deinit();
    for (0..3) |index| _ = try box(f.owner, f.id, f.root, @intCast(index + 2), @intCast(index));
    for ([_]u32{ 1, 16 }, 0..) |budget, index| {
        try @import("scene_fixture_test.zig").repaint(f.owner, f.id, options.background, true, 0);
        try f.owner.sceneFrameCancel(f.id, f.state.last_frame_id);
        f.state.test_prepare_steps = 0;
        const request = try f.owner.sceneFrameStepWorkBudgeted(f.id, null, options, budget);
        try testing.expectEqual(@as(u32, if (index == 0) c.OT_SCENE_FRAME_YIELD else c.OT_SCENE_FRAME_DONE), request.kind);
        try testing.expect(f.state.test_prepare_steps > 0);
        try testing.expectEqual(@as(usize, 0), f.state.work.items.len);
        try f.owner.sceneFrameCancel(f.id, request.frame_id);
        try testing.expect(f.state.attempt == null);
    }
}

test "Scene work budget restarts once after a yielded mutation and completes without further yields" {
    const f = try Fixture.init(testing.allocator, 12, 3, .{ .output = transport });
    defer f.deinit();
    const child = try box(f.owner, f.id, f.root, 2, 0);
    var limited = options;
    limited.max_layout_rounds = 2;
    var request = try f.owner.sceneFrameStepWorkBudgeted(f.id, null, limited, 1);
    try testing.expectEqual(@as(u32, c.OT_SCENE_FRAME_YIELD), request.kind);
    try f.owner.sceneSetStyle(child, 4, 0, 0, 1, 2, 1);
    request = try f.owner.sceneFrameStepWorkBudgeted(f.id, request, limited, 1);
    try testing.expectEqual(@as(u32, 0), request.kind);
    try testing.expectEqual(@as(f32, 2), (try f.owner.sceneGetLayout(child, false)).width);
    const painted = f.cli.getNextBuffer();
    try testing.expectEqual(ansi.rgbColor(2, 0, 0, 255), painted.get(1, 0).?.bg);
    try testing.expectEqual(ansi.rgbColor(0, 0, 0, 255), painted.get(2, 0).?.bg);
    try f.owner.sceneFrameCancel(f.id, request.frame_id);
}

test "Scene work budget unchanged yields keep the quota and exhaust no layout rounds" {
    const f = try Fixture.init(testing.allocator, 12, 3, .{ .output = transport });
    defer f.deinit();
    for (0..3) |index| _ = try box(f.owner, f.id, f.root, @intCast(index + 2), @intCast(index));
    var limited = options;
    limited.max_layout_rounds = 1;
    var previous: ?scene.FrameRequest = null;
    var yields: u32 = 0;
    const done = for (0..64) |_| {
        const request = try f.owner.sceneFrameStepWorkBudgeted(f.id, previous, limited, 1);
        if (request.kind == 0) break request;
        try testing.expectEqual(@as(u32, c.OT_SCENE_FRAME_YIELD), request.kind);
        yields += 1;
        previous = request;
    } else return error.TestUnexpectedResult;
    try testing.expect(yields > 1);
    try f.owner.sceneFrameCancel(f.id, done.frame_id);
}

test "Scene work budget rejects late invalid transforms before publishing prepared geometry" {
    const f = try Fixture.init(testing.allocator, 12, 3, .{ .output = transport });
    defer f.deinit();
    _ = try box(f.owner, f.id, f.root, 2, 0);
    var request = try f.owner.sceneFrameStepWorkBudgeted(f.id, null, options, 1);
    try f.owner.sceneSetPaint(f.root, .{ .translateX = @as(f64, std.math.maxInt(i32)) + 1 });
    for (0..16) |_| {
        request = f.owner.sceneFrameStepWorkBudgeted(f.id, request, options, 1) catch |err| {
            try testing.expectEqual(error.InvalidDimensions, err);
            break;
        };
        try testing.expectEqual(@as(u32, c.OT_SCENE_FRAME_YIELD), request.kind);
    } else return error.TestUnexpectedResult;
    try testing.expectEqual(@as(f32, 0), (try f.owner.sceneGetLayout(f.root, false)).width);
    try testing.expectEqual(@as(f64, std.math.maxInt(i32)) + 1, (try f.owner.sceneGetLayout(f.root, false)).screenX);
}

fn workAllocationFailures(allocator: std.mem.Allocator) !void {
    const f = try Fixture.init(allocator, 12, 3, .{ .output = transport });
    defer f.deinit();
    _ = try box(f.owner, f.id, f.root, 2, 0);
    const text = try f.owner.sceneCreateNode(f.id, 2, 3);
    try f.owner.sceneSetText(text, "e\xcc\x81 wide");
    try f.owner.sceneMoveNode(text, f.root, 1);
    try f.owner.sceneSetHooks(f.root, 5, 1, 0, 0);
    var previous: ?scene.FrameRequest = null;
    for (0..64) |_| {
        const request = try f.owner.sceneFrameStepWorkBudgeted(f.id, previous, options, 1);
        if (request.kind == 0) {
            try f.owner.sceneFrameCancel(f.id, request.frame_id);
            return;
        }
        previous = request;
    }
    return error.TestUnexpectedResult;
}

test "Scene work budget releases failed preparation ownership and reuses warmed cursor storage" {
    try testing.checkAllAllocationFailures(testing.allocator, workAllocationFailures, .{});
    const f = try Fixture.init(testing.allocator, 12, 3, .{ .output = transport });
    defer f.deinit();
    for (0..3) |index| _ = try box(f.owner, f.id, f.root, @intCast(index + 2), @intCast(index));
    try f.owner.sceneSetHooks(f.root, 1, 1, 12, 3);
    var failing = testing.FailingAllocator.init(testing.allocator, .{ .fail_index = 0 });
    defer f.state.allocator = testing.allocator;
    for (0..2) |pass| {
        if (pass == 1) f.state.allocator = failing.allocator();
        var previous: ?scene.FrameRequest = null;
        for (0..64) |_| {
            const request = try f.owner.sceneFrameStepWorkBudgeted(f.id, previous, options, 1);
            if (request.kind == 0) {
                try f.owner.sceneFrameCancel(f.id, request.frame_id);
                break;
            }
            previous = request;
        } else return error.TestUnexpectedResult;
        try testing.expectEqual(@as(usize, 0), f.state.prepared.items.len);
        try testing.expectEqual(@as(usize, 0), f.state.preparation_stack.items.len);
    }
    try testing.expect(!failing.has_induced_failure);
}

test "Scene work budget hook replies cannot replenish feedback quota or consume host limits" {
    const f = try Fixture.init(testing.allocator, 12, 3, .{ .output = transport });
    defer f.deinit();
    _ = try box(f.owner, f.id, f.root, 2, 0);
    try f.owner.sceneSetHooks(f.root, 1, 1, 12, 3);
    var limited = options;
    limited.max_host_requests = 1;
    var previous: ?scene.FrameRequest = null;
    const update = for (0..32) |_| {
        const request = try f.owner.sceneFrameStepWorkBudgeted(f.id, previous, limited, 1);
        if (request.kind == 1) break request;
        try testing.expectEqual(@as(u32, c.OT_SCENE_FRAME_YIELD), request.kind);
        previous = request;
    } else return error.TestUnexpectedResult;
    const yielded = try f.owner.sceneFrameStepWorkBudgeted(f.id, update, limited, 100);
    try testing.expectEqual(@as(u32, c.OT_SCENE_FRAME_YIELD), yielded.kind);
    try testing.expectEqual(@as(u32, 1), f.state.attempt.?.requests);
    const done = try f.owner.sceneFrameStepWorkBudgeted(f.id, yielded, limited, 100);
    try testing.expectEqual(@as(u32, 0), done.kind);
    try f.owner.sceneFrameCancel(f.id, done.frame_id);
}

test "Scene work budget changed transforms never mix saved parents with live children" {
    for ([_]bool{ false, true }) |change_during_preparation| {
        const f = try Fixture.init(testing.allocator, 12, 3, .{ .output = transport });
        defer f.deinit();
        const child = try box(f.owner, f.id, f.root, 2, 0);
        var previous: ?scene.FrameRequest = null;
        if (change_during_preparation) {
            try f.owner.sceneSetPaint(f.root, .{ .translateX = -2 });
            previous = try f.owner.sceneFrameStepWorkBudgeted(f.id, null, options, 1);
            try testing.expectEqual(@as(u32, c.OT_SCENE_FRAME_YIELD), previous.?.kind);
        }
        try f.owner.sceneSetPaint(f.root, .{});
        try f.owner.sceneSetPaint(child, .{ .translateX = -2147483647, .background = .{ 2, 0, 0, 255 } });
        const done = for (0..32) |_| {
            const request = try f.owner.sceneFrameStepWorkBudgeted(f.id, previous, options, 1);
            if (request.kind == 0) break request;
            try testing.expectEqual(@as(u32, c.OT_SCENE_FRAME_YIELD), request.kind);
            previous = request;
        } else return error.TestUnexpectedResult;
        try testing.expectEqual(@as(f64, -2147483647), (try f.owner.sceneGetPaintLayout(child)).screenX);
        try testing.expectEqual(ansi.rgbColor(0, 0, 0, 255), (try f.owner.raw().getSessionRenderer(f.id)).getNextBuffer().get(0, 0).?.bg);
        try f.owner.sceneFrameCancel(f.id, done.frame_id);
    }
}
