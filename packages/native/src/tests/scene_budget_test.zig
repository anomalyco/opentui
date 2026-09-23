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

fn box(owner: *context.Context, id: context.Handle, parent: context.Handle, num: u32, index: u32) !context.Handle {
    const child = try owner.sceneCreateNode(id, 1, num);
    try owner.sceneSetStyle(child, 4, 0, 0, 1, 1, 1);
    try owner.sceneSetStyle(child, 4, 1, 0, 1, 1, 1);
    try owner.sceneSetStyle(child, 0, 6, 0, 0, 2, 0);
    try owner.sceneSetPaint(child, .{ .translateX = @floatFromInt(index), .background = .{ @intCast(num), 0, 0, 255 } });
    try owner.sceneMoveNode(child, parent, index);
    return child;
}

test "Scene budget changes clamp hook continuations and replenish only yield acknowledgements" {
    const f = try Fixture.init(testing.allocator, 12, 3, .{ .output = transport });
    defer f.deinit();
    for (0..4) |index| {
        const child = try box(f.owner, f.id, f.root, @intCast(index + 2), @intCast(index));
        try f.owner.sceneSetHooks(child, 24, 1, 1, 1);
    }
    var previous: ?scene.FrameRequest = null;
    for ([_]u32{ 4, 5, 6, 4, 5, 6, 4, 5, 4, 5, 0 }, [_]u32{ 3, 1, 3, 2, 2, 1, 3, 2, 2, 2, 2 }) |kind, budget| {
        const request = try f.owner.sceneFrameStepBudgeted(f.id, previous, options, budget);
        try testing.expectEqual(kind, request.kind);
        if (kind == 4 or kind == 5) {
            var forged = request;
            forged.kind = 6;
            try testing.expectError(error.StaleFrame, f.owner.sceneFrameStepBudgeted(f.id, forged, options, 4));
        }
        previous = request;
    }
    try f.owner.sceneFrameCancel(f.id, previous.?.frame_id);
}

test "Scene budget counts an entered destroyed box once after completing its hooks" {
    const f = try Fixture.init(testing.allocator, 12, 3, .{ .output = transport });
    defer f.deinit();
    const first = try box(f.owner, f.id, f.root, 2, 0);
    _ = try box(f.owner, f.id, f.root, 3, 1);
    try f.owner.sceneSetHooks(first, 24, 1, 1, 1);
    var request = try f.owner.sceneFrameStepBudgeted(f.id, null, options, 1);
    try testing.expectEqual(@as(u32, 4), request.kind);
    try f.owner.sceneDestroyNode(first);
    request = try f.owner.sceneFrameStepBudgeted(f.id, request, options, 1);
    try testing.expectEqual(@as(u32, 5), request.kind);
    try testing.expectEqual(first, request.node);
    request = try f.owner.sceneFrameStepBudgeted(f.id, request, options, 1);
    try testing.expectEqual(@as(u32, 6), request.kind);
    try testing.expectEqual(@as(u32, 1), f.state.prefix.?.cursor);
    try testing.expectEqual(ansi.rgbColor(2, 0, 0, 255), f.cli.getNextBuffer().get(0, 0).?.bg);
    try testing.expectEqual(ansi.rgbColor(0, 0, 0, 255), f.cli.getNextBuffer().get(1, 0).?.bg);
    request = try f.owner.sceneFrameStepBudgeted(f.id, request, options, 1);
    try testing.expectEqual(@as(u32, 0), request.kind);
    try f.owner.sceneFrameCancel(f.id, request.frame_id);
}

fn allocationFailures(allocator: std.mem.Allocator) !void {
    const f = try Fixture.init(allocator, 12, 3, .{ .output = transport });
    defer f.deinit();
    for (0..3) |index| _ = try box(f.owner, f.id, f.root, @intCast(index + 2), @intCast(index));
    var previous: ?scene.FrameRequest = null;
    for (0..3) |_| previous = try f.owner.sceneFrameStepBudgeted(f.id, previous, options, 1);
    try testing.expectEqual(@as(u32, 0), previous.?.kind);
    try f.owner.sceneFrameCancel(f.id, previous.?.frame_id);
}

test "Scene budget retains fitting fast path and warmed storage with failed allocation cleanup" {
    try testing.checkAllAllocationFailures(testing.allocator, allocationFailures, .{});
    const f = try Fixture.init(testing.allocator, 12, 3, .{ .output = transport });
    defer f.deinit();
    for (0..3) |index| _ = try box(f.owner, f.id, f.root, @intCast(index + 2), @intCast(index));
    var request = try f.owner.sceneFrameStepBudgeted(f.id, null, options, 3);
    try testing.expectEqual(@as(u32, 0), request.kind);
    try testing.expectEqual(@as(usize, 0), f.state.paint_members.capacity);
    try f.owner.sceneFrameCancel(f.id, request.frame_id);
    var failing = testing.FailingAllocator.init(testing.allocator, .{ .fail_index = 0 });
    f.state.allocator = failing.allocator();
    defer f.state.allocator = testing.allocator;
    try testing.expectError(error.OutOfMemory, f.owner.sceneFrameStepBudgeted(f.id, null, options, 1));
    try testing.expect(f.state.attempt == null and f.state.prefix == null);
    f.state.allocator = testing.allocator;
    request = try f.owner.sceneFrameStepBudgeted(f.id, null, options, 1);
    const capacity = f.state.paint_members.capacity;
    try testing.expect(capacity <= f.state.count);
    failing = testing.FailingAllocator.init(testing.allocator, .{ .fail_index = 0 });
    f.state.allocator = failing.allocator();
    request = try f.owner.sceneFrameStepBudgeted(f.id, request, options, 1);
    request = try f.owner.sceneFrameStepBudgeted(f.id, request, options, 1);
    try f.owner.sceneFrameCancel(f.id, request.frame_id);
    var previous: ?scene.FrameRequest = null;
    for (0..3) |_| previous = try f.owner.sceneFrameStepBudgeted(f.id, previous, options, 1);
    try testing.expectEqual(@as(u32, 0), previous.?.kind);
    try testing.expectEqual(capacity, f.state.paint_members.capacity);
    try testing.expect(!failing.has_induced_failure);
    try f.owner.sceneFrameCancel(f.id, previous.?.frame_id);
}

test "Scene warmed preparation cannot bypass work or paint budgets" {
    const f = try Fixture.init(testing.allocator, 12, 3, .{ .output = transport });
    defer f.deinit();
    for (0..3) |index| _ = try box(f.owner, f.id, f.root, @intCast(index + 2), @intCast(index));
    const unlimited = std.math.maxInt(u32);
    for ([_][2]u32{
        .{ unlimited, 1 },
        .{ 1, unlimited },
        .{ 4, unlimited },
        .{ unlimited, 16 },
    }, 0..) |budget, index| {
        try @import("scene_fixture_test.zig").repaint(f.owner, f.id, options.background, true, 0);
        try f.owner.sceneFrameCancel(f.id, f.state.last_frame_id);
        f.state.test_prepare_steps = 0;
        const request = try f.owner.sceneFrameStepWorkBudgeted(f.id, null, options, budget[0], budget[1]);
        try testing.expectEqual(@as(u32, if (index < 2) 6 else 0), request.kind);
        try testing.expect(f.state.test_prepare_steps > 0);
        try testing.expectEqual(@as(usize, 0), f.state.work.items.len);
        if (index == 0) try testing.expect(f.state.prefix == null);
        if (index == 1) try testing.expect(f.state.prefix != null);
        try f.owner.sceneFrameCancel(f.id, request.frame_id);
        try testing.expect(f.state.attempt == null and f.state.prefix == null);
    }
}

test "Scene work budget preparation restarts consume layout rounds without rolling back mutations" {
    const f = try Fixture.init(testing.allocator, 12, 3, .{ .output = transport });
    defer f.deinit();
    const child = try box(f.owner, f.id, f.root, 2, 0);
    var limited = options;
    limited.max_layout_rounds = 2;
    var request = try f.owner.sceneFrameStepWorkBudgeted(f.id, null, limited, 1, 1);
    try f.owner.sceneSetStyle(child, 4, 0, 0, 1, 2, 1);
    request = try f.owner.sceneFrameStepWorkBudgeted(f.id, request, limited, 1, 1);
    try f.owner.sceneSetStyle(child, 4, 0, 0, 1, 3, 1);
    try testing.expectError(error.LayoutLimit, f.owner.sceneFrameStepWorkBudgeted(f.id, request, limited, 1, 1));
    try testing.expect(f.state.attempt == null and f.state.prepared.items.len == 0 and f.state.preparation_stack.items.len == 0);
    try testing.expectEqual(@as(f32, 0), (try f.owner.sceneGetLayout(child, false)).width);
    const retry = try f.owner.sceneFrameStep(f.id, null, options);
    try testing.expect(retry.frame_id > request.frame_id);
    try testing.expectEqual(@as(f32, 3), (try f.owner.sceneGetLayout(child, false)).width);
    try f.owner.sceneFrameCancel(f.id, retry.frame_id);
}

test "Scene work budget rejects late invalid transforms before publishing prepared geometry" {
    const f = try Fixture.init(testing.allocator, 12, 3, .{ .output = transport });
    defer f.deinit();
    _ = try box(f.owner, f.id, f.root, 2, 0);
    var request = try f.owner.sceneFrameStepWorkBudgeted(f.id, null, options, 1, 1);
    try f.owner.sceneSetPaint(f.root, .{ .translateX = @as(f64, std.math.maxInt(i32)) + 1 });
    for (0..16) |_| {
        request = f.owner.sceneFrameStepWorkBudgeted(f.id, request, options, 1, 1) catch |err| {
            try testing.expectEqual(error.InvalidDimensions, err);
            break;
        };
        try testing.expectEqual(@as(u32, 6), request.kind);
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
        const request = try f.owner.sceneFrameStepWorkBudgeted(f.id, previous, options, 1, 1);
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
            const request = try f.owner.sceneFrameStepWorkBudgeted(f.id, previous, options, 1, 1);
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
        const request = try f.owner.sceneFrameStepWorkBudgeted(f.id, previous, limited, 10, 1);
        if (request.kind == 1) break request;
        try testing.expectEqual(@as(u32, 6), request.kind);
        previous = request;
    } else return error.TestUnexpectedResult;
    const yielded = try f.owner.sceneFrameStepWorkBudgeted(f.id, update, limited, 10, 100);
    try testing.expectEqual(@as(u32, 6), yielded.kind);
    try testing.expectEqual(@as(u32, 1), f.state.attempt.?.requests);
    const done = try f.owner.sceneFrameStepWorkBudgeted(f.id, yielded, limited, 10, 100);
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
            previous = try f.owner.sceneFrameStepWorkBudgeted(f.id, null, options, 1, 1);
            try testing.expectEqual(@as(u32, 6), previous.?.kind);
        }
        try f.owner.sceneSetPaint(f.root, .{});
        try f.owner.sceneSetPaint(child, .{ .translateX = -2147483647, .background = .{ 2, 0, 0, 255 } });
        const done = for (0..32) |_| {
            const request = try f.owner.sceneFrameStepWorkBudgeted(f.id, previous, options, 1, 1);
            if (request.kind == 0) break request;
            try testing.expectEqual(@as(u32, 6), request.kind);
            previous = request;
        } else return error.TestUnexpectedResult;
        try testing.expectEqual(@as(f64, -2147483647), (try f.owner.sceneGetPaintLayout(child)).screenX);
        try testing.expectEqual(ansi.rgbColor(0, 0, 0, 255), (try f.owner.raw().getSessionRenderer(f.id)).getNextBuffer().get(0, 0).?.bg);
        try f.owner.sceneFrameCancel(f.id, done.frame_id);
    }
}
