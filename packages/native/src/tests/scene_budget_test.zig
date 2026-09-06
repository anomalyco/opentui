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

fn setup(owner: *context.Context) !context.Handle {
    const id = try owner.createSession(transport);
    try owner.attachSessionRenderer(id, 12, 3, .{ .remote_mode = .remote });
    _ = try owner.sceneCreateNode(id, 0, 1);
    return id;
}

fn box(owner: *context.Context, id: context.Handle, parent: context.Handle, num: u32, index: u32) !context.Handle {
    const child = try owner.sceneCreateNode(id, 1, num);
    try owner.sceneSetStyle(child, 4, 0, 0, 1, 1, 1);
    try owner.sceneSetStyle(child, 4, 1, 0, 1, 1, 1);
    try owner.sceneSetStyle(child, 0, 6, 0, 0, 2, 0);
    try owner.sceneSetPaint(child, .{ .translateX = @floatFromInt(index), .background = .{ @intCast(num), 0, 0, 255 } });
    try owner.sceneMoveNode(child, parent, index);
    return child;
}

fn drain(owner: *context.Context, id: context.Handle, output: []u8) ![]const u8 {
    var written: usize = 0;
    for (0..32) |_| {
        const ticket = try owner.readOutput(id, output[written..]) orelse return output[0..written];
        written += ticket.len;
        try owner.completeOutput(id, ticket, .written);
    }
    return error.TestUnexpectedResult;
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

test "Scene budget stale members consume quota and reparented live members retain prepared membership" {
    const f = try Fixture.init(testing.allocator, 12, 3, .{ .output = transport });
    defer f.deinit();
    var nodes: [5]context.Handle = undefined;
    for (&nodes, 0..) |*node, index| node.* = try box(f.owner, f.id, f.root, @intCast(index + 2), @intCast(index));
    var request = try f.owner.sceneFrameStepBudgeted(f.id, null, options, 1);
    try f.owner.sceneDestroyNode(nodes[1]);
    try f.owner.sceneDestroyNode(nodes[2]);
    const replacement = try box(f.owner, f.id, f.root, 8, 1);
    try f.owner.sceneSetPaint(replacement, .{ .translateX = 8, .background = .{ 80, 0, 0, 255 } });
    try f.owner.sceneMoveNode(nodes[3], nodes[0], 0);
    try f.owner.sceneSetPaint(nodes[3], .{ .translateX = 6, .background = .{ 90, 0, 0, 255 } });
    for (2..5) |cursor| {
        request = try f.owner.sceneFrameStepBudgeted(f.id, request, options, 1);
        try testing.expectEqual(@as(u32, 6), request.kind);
        try testing.expectEqual(@as(u32, @intCast(cursor)), f.state.prefix.?.cursor);
        try testing.expectEqual(ansi.rgbColor(0, 0, 0, 255), f.cli.getNextBuffer().get(8, 0).?.bg);
        if (cursor < 4) try testing.expectEqual(ansi.rgbColor(0, 0, 0, 255), f.cli.getNextBuffer().get(6, 0).?.bg);
    }
    try testing.expectEqual(ansi.rgbColor(90, 0, 0, 255), f.cli.getNextBuffer().get(6, 0).?.bg);
    request = try f.owner.sceneFrameStepBudgeted(f.id, request, options, 1);
    try testing.expectEqual(@as(u32, 0), request.kind);
    try testing.expectEqual(ansi.rgbColor(6, 0, 0, 255), f.cli.getNextBuffer().get(4, 0).?.bg);
    try f.owner.sceneFrameCancel(f.id, request.frame_id);
}

test "Scene budget resize cancellation root destruction and suspension preserve pause lifecycle" {
    for (0..4) |action| {
        const f = try Fixture.init(testing.allocator, 12, 3, .{ .output = transport });
        defer f.deinit();
        defer f.owner.cancelSession(f.id) catch unreachable;
        for (0..3) |index| _ = try box(f.owner, f.id, f.root, @intCast(index + 2), @intCast(index));
        if (action == 3) {
            try f.owner.setupSessionTerminal(f.id, .{});
            var output: [16384]u8 = undefined;
            for (0..32) |_| {
                _ = try drain(f.owner, f.id, &output);
                if ((try f.owner.pumpSession(f.id, 0, 8)).status == .idle) break;
            } else return error.TestUnexpectedResult;
        }
        var request = try f.owner.sceneFrameStepBudgeted(f.id, null, options, 1);
        switch (action) {
            0 => {
                try f.owner.resizeSessionRenderer(f.id, 12, 3);
                try testing.expectEqualDeep(request, f.state.attempt.?.pending.?);
                try testing.expectError(error.InvalidDimensions, f.owner.resizeSessionRenderer(f.id, 0, 3));
                try testing.expectEqualDeep(request, f.state.attempt.?.pending.?);
                try f.owner.resizeSessionRenderer(f.id, 14, 3);
                const before = request;
                try testing.expect(f.state.attempt == null and f.state.prefix == null and f.state.painted == null);
                try testing.expectError(error.StaleFrame, f.owner.sceneFrameStepBudgeted(f.id, before, options, 2));
                try testing.expectError(error.StaleFrame, f.owner.sceneFrameCommit(f.id, before, true));
                try testing.expectError(error.StaleFrame, f.owner.sceneFrameAcquireBufferLease(f.id, before, .next));
                try testing.expectError(error.StaleFrame, f.owner.sceneFrameCancel(f.id, before.frame_id));
                try testing.expectEqual(@as(u32, 0), f.owner.lease_count);
                var bytes: [4096]u8 = undefined;
                try testing.expect((try f.owner.readOutput(f.id, &bytes)) == null);
                request = try f.step(null, options, 0, null);
                try testing.expect(request.frame_id > before.frame_id);
                try testing.expect(request.layout_epoch > before.layout_epoch);
                try testing.expectEqual(@as(f32, 14), (try f.owner.sceneGetLayout(f.root, false)).width);
                try testing.expectEqual(ansi.rgbColor(2, 0, 0, 255), f.cli.getNextBuffer().get(0, 0).?.bg);
                try testing.expectEqual(ansi.rgbColor(3, 0, 0, 255), f.cli.getNextBuffer().get(1, 0).?.bg);
                try testing.expectEqual(ansi.rgbColor(4, 0, 0, 255), f.cli.getNextBuffer().get(2, 0).?.bg);
            },
            1 => {},
            2 => {
                try f.owner.sceneDestroyNode(f.root);
                _ = try f.owner.sceneCreateNode(f.id, 0, 10);
                try testing.expectError(error.StaleFrame, f.owner.sceneFrameStepBudgeted(f.id, request, options, 1));
                try testing.expect(f.state.attempt == null and f.state.prefix == null);
                continue;
            },
            3 => {
                try f.owner.suspendSession(f.id);
                try testing.expectError(error.TerminalInactive, f.owner.sceneFrameStepBudgeted(f.id, request, options, 1));
                try testing.expectEqual(@as(u32, 1), f.state.prefix.?.cursor);
            },
            else => unreachable,
        }
        try f.owner.sceneFrameCancel(f.id, request.frame_id);
        try testing.expectError(error.StaleFrame, f.owner.sceneFrameCancel(f.id, request.frame_id));
        try testing.expect(f.state.attempt == null and f.state.prefix == null and f.state.painted == null);
        for (f.cli.nextHitGrid) |hit| try testing.expectEqual(@as(u32, 0), hit);
        try testing.expectEqual(@as(usize, 0), f.cli.getNextBuffer().opacity_stack.items.len);
        try testing.expectEqual(@as(usize, 0), f.cli.getNextBuffer().scissor_stack.items.len);
        try testing.expectEqual(@as(u64, 0), (try f.owner.sceneGetStats(f.id)).frameCount);
    }
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
        try f.owner.scenePaint(f.id, options.background, true, 0);
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

test "Scene work budget every preparation and feedback yield revokes cleanly on cancellation resize and destruction" {
    for (0..3) |phase| for (0..4) |action| {
        const f = try Fixture.init(testing.allocator, 12, 3, .{ .output = transport });
        defer f.deinit();
        for (0..3) |index| _ = try box(f.owner, f.id, f.root, @intCast(index + 2), @intCast(index));
        try f.owner.sceneSetHooks(f.root, 1, 1, 12, 3);
        var previous: ?scene.FrameRequest = null;
        const request = for (0..64) |_| {
            const current = try f.owner.sceneFrameStepWorkBudgeted(f.id, previous, options, 1, 1);
            try testing.expect(current.kind != 0);
            const published = (try f.owner.sceneGetLayout(f.root, false)).width != 0;
            const stage: usize = if (published) 2 else if (f.state.test_geometry_reads == 4) 1 else 0;
            if (current.kind == 6 and phase == stage) break current;
            previous = current;
        } else return error.TestUnexpectedResult;
        try testing.expect(f.state.prefix == null);
        try testing.expectEqual(@as(usize, 0), f.state.work.items.len);
        var forged = request;
        forged.request_id += 1;
        try testing.expectError(error.StaleFrame, f.owner.sceneFrameStepWorkBudgeted(f.id, forged, options, 1, 1));
        try testing.expectError(error.InvalidOptions, f.owner.sceneFrameStepWorkBudgeted(f.id, request, options, 1, 0));
        try testing.expectEqualDeep(request, f.state.attempt.?.pending.?);
        try testing.expectError(error.StaleFrame, f.owner.sceneFrameAcquireBufferLease(f.id, request, .current));
        try testing.expectError(error.StaleFrame, f.owner.sceneFrameCommit(f.id, request, true));
        if (action == 3) {
            try f.owner.destroy(f.id);
            try testing.expectEqual(@as(u32, 0), f.owner.lease_count);
            continue;
        }
        switch (action) {
            0 => try f.owner.sceneFrameCancel(f.id, request.frame_id),
            1 => try f.owner.resizeSessionRenderer(f.id, 14, 3),
            2 => try f.owner.sceneDestroyNode(f.root),
            else => unreachable,
        }
        try testing.expect(f.state.attempt == null and f.state.prefix == null and f.state.painted == null);
        try testing.expectError(error.StaleFrame, f.owner.sceneFrameStepWorkBudgeted(f.id, request, options, 1, 1));
        try testing.expectError(error.StaleFrame, f.owner.sceneFrameCancel(f.id, request.frame_id));
        for (f.cli.nextHitGrid) |hit| try testing.expectEqual(@as(u32, 0), hit);
        try testing.expectEqual(@as(usize, 0), f.cli.getNextBuffer().opacity_stack.items.len);
        try testing.expectEqual(@as(usize, 0), f.cli.getNextBuffer().scissor_stack.items.len);
        var bytes: [4096]u8 = undefined;
        try testing.expect((try f.owner.readOutput(f.id, &bytes)) == null);
        try testing.expectEqual(@as(u64, 0), (try f.owner.sceneGetStats(f.id)).frameCount);
    };
}

test "Scene work budget requalifies destroyed and reparented candidates without replaying accepted updates" {
    for (0..3) |phase| {
        const f = try Fixture.init(testing.allocator, 12, 3, .{ .output = transport });
        defer f.deinit();
        var nodes: [3]context.Handle = undefined;
        for (&nodes, 0..) |*node, index| node.* = try box(f.owner, f.id, f.root, @intCast(index + 2), @intCast(index));
        try f.owner.sceneSetHooks(f.root, 1, 1, 12, 3);
        var updates: u32 = 0;
        var previous: ?scene.FrameRequest = null;
        var request = for (0..64) |_| {
            const current = try f.owner.sceneFrameStepWorkBudgeted(f.id, previous, options, 1, 1);
            if (current.kind == 1) updates += 1;
            const published = (try f.owner.sceneGetLayout(f.root, false)).width != 0;
            const stage: usize = if (published) 2 else if (f.state.test_geometry_reads == 4) 1 else 0;
            if (current.kind == 6 and phase == stage) break current;
            previous = current;
        } else return error.TestUnexpectedResult;
        try f.owner.sceneDestroyNode(nodes[1]);
        _ = try box(f.owner, f.id, f.root, 9, 1);
        try f.owner.sceneMoveNode(nodes[2], nodes[0], 0);
        try f.owner.sceneSetPaint(nodes[0], .{ .translateX = 4, .background = .{ 2, 0, 0, 255 } });
        for (0..128) |_| {
            request = try f.owner.sceneFrameStepWorkBudgeted(f.id, request, options, 1, 1);
            if (request.kind == 0) break;
            if (request.kind == 1) updates += 1;
        } else return error.TestUnexpectedResult;
        try testing.expectEqual(@as(u32, 1), updates);
        try testing.expectEqual(@as(f64, 6), (try f.owner.sceneGetLayout(nodes[2], false)).screenX);
        try testing.expectEqual(ansi.rgbColor(9, 0, 0, 255), f.cli.getNextBuffer().get(1, 0).?.bg);
        try testing.expectEqual(ansi.rgbColor(2, 0, 0, 255), f.cli.getNextBuffer().get(4, 0).?.bg);
        try testing.expectEqual(ansi.rgbColor(4, 0, 0, 255), f.cli.getNextBuffer().get(6, 0).?.bg);
        _ = try f.owner.sceneFrameCommit(f.id, request, true);
        var bytes: [4096]u8 = undefined;
        _ = try drain(f.owner, f.id, &bytes);
        try testing.expectEqual(@as(u32, 9), try f.owner.sceneHitTest(f.id, 1, 0));
        try testing.expectEqual(@as(u32, 2), try f.owner.sceneHitTest(f.id, 4, 0));
        try testing.expectEqual(@as(u32, 4), try f.owner.sceneHitTest(f.id, 6, 0));
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

test "Scene work budget preserves filtered feedback order geometry and output through a second layout" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const ids = [_]context.Handle{ try setup(owner), try setup(owner) };
    const Event = struct { kind: u32, num: u32, width: u32, height: u32 };
    var expected_events: std.ArrayListUnmanaged(Event) = .empty;
    defer expected_events.deinit(testing.allocator);
    var frames: [2]scene.FrameRequest = undefined;
    for (ids, 0..) |id, pass| {
        try testing.expectError(error.InvalidOptions, owner.sceneFrameStepWorkBudgeted(id, null, options, 0, 1));
        try testing.expectError(error.InvalidOptions, owner.sceneFrameStepWorkBudgeted(id, null, options, 1, 0));
        const root = (try owner.getSession(id)).scene.?.root.?.scene_node.?.handle;
        const parent = try box(owner, id, root, 2, 0);
        try owner.sceneSetStyle(parent, 4, 0, 0, 1, 12, 1);
        try owner.sceneSetStyle(parent, 4, 1, 0, 1, 3, 1);
        try owner.sceneSetStyle(parent, 0, 1, 0, 0, 2, 0);
        try owner.sceneSetStyle(parent, 0, 8, 0, 0, 1, 0);
        try owner.sceneSetViewport(parent, root);
        try owner.sceneSetHooks(root, 5, 1, 12, 3);
        try owner.sceneSetHooks(parent, 3, 1, 0, 0);
        var changed: context.Handle = undefined;
        for (0..16) |index| {
            const child = try box(owner, id, parent, @intCast(index + 3), @intCast(index));
            try owner.sceneSetHooks(child, 3, 1, 0, 0);
            if (index == 0) changed = child;
        }
        var cursor: usize = 0;
        var previous: ?scene.FrameRequest = null;
        frames[pass] = for (0..512) |_| {
            const request = if (pass == 0) try owner.sceneFrameStep(id, previous, options) else try owner.sceneFrameStepWorkBudgeted(id, previous, options, 2, 2);
            if (request.kind == 0) break request;
            if (request.kind != 6) {
                const event: Event = .{ .kind = request.kind, .num = request.num, .width = request.width, .height = request.height };
                if (pass == 0) {
                    try expected_events.append(testing.allocator, event);
                } else {
                    try testing.expect(cursor < expected_events.items.len);
                    try testing.expectEqualDeep(expected_events.items[cursor], event);
                }
                cursor += 1;
                if (request.kind == 2 and request.num == 3 and request.width == 1) try owner.sceneSetStyle(changed, 4, 0, 0, 1, 2, 1);
            }
            var bytes: [4096]u8 = undefined;
            try testing.expect((try owner.readOutput(id, &bytes)) == null);
            try testing.expectEqual(@as(u32, 0), try owner.sceneHitTest(id, 0, 0));
            previous = request;
        } else return error.TestUnexpectedResult;
        try testing.expectEqual(expected_events.items.len, cursor);
        try testing.expectEqual(@as(f32, 2), (try owner.sceneGetLayout(changed, false)).width);
    }
    const expected = (try owner.getSessionRenderer(ids[0])).getNextBuffer();
    const actual = (try owner.getSessionRenderer(ids[1])).getNextBuffer();
    for (0..3) |y| for (0..12) |x| {
        try testing.expectEqualDeep(expected.get(@intCast(x), @intCast(y)), actual.get(@intCast(x), @intCast(y)));
    };
    for (ids, frames) |id, frame| _ = try owner.sceneFrameCommit(id, frame, true);
    var expected_bytes: [4096]u8 = undefined;
    var actual_bytes: [4096]u8 = undefined;
    try testing.expectEqualStrings(try drain(owner, ids[0], &expected_bytes), try drain(owner, ids[1], &actual_bytes));
    for (0..3) |y| for (0..12) |x| {
        try testing.expectEqual(try owner.sceneHitTest(ids[0], @intCast(x), @intCast(y)), try owner.sceneHitTest(ids[1], @intCast(x), @intCast(y)));
    };
}

test "Scene work budget repeated observed and stale placements reach the layout round limit" {
    for ([_]bool{ false, true }) |detach| {
        for ([_]bool{ false, true }) |keep_moving| {
            const f = try Fixture.init(testing.allocator, 12, 3, .{ .output = transport });
            defer f.deinit();
            const child = try box(f.owner, f.id, f.root, 2, 0);
            try f.owner.sceneSetHooks(f.root, 1, 1, 12, 3);
            var limited = options;
            limited.max_layout_rounds = 2;
            limited.max_host_requests = 1;
            var previous: ?scene.FrameRequest = null;
            var feedback_yields: u32 = 0;
            for (0..128) |_| {
                const before = f.state.attempt;
                const request = f.owner.sceneFrameStepWorkBudgeted(f.id, previous, limited, 1, 1) catch |err| {
                    try testing.expect(keep_moving);
                    try testing.expectEqual(error.LayoutLimit, err);
                    if (detach) {
                        try testing.expectEqual(@as(u32, 2), before.?.rounds);
                        try testing.expectEqual(@as(u32, 1), before.?.requests);
                        try testing.expect(feedback_yields <= 34);
                    }
                    try testing.expect(f.state.attempt == null and f.state.feedback.items.len == 0);
                    break;
                };
                if (request.kind == 0) {
                    try testing.expect(!keep_moving);
                    try f.owner.sceneFrameCancel(f.id, request.frame_id);
                    break;
                }
                if (request.kind == 6 and f.state.attempt.?.preparing == .none) {
                    feedback_yields += 1;
                    if (keep_moving or feedback_yields <= 8) {
                        if (detach) try f.owner.sceneMoveNode(child, null, 0);
                        try f.owner.sceneMoveNode(child, f.root, 0);
                    }
                }
                previous = request;
            } else return error.TestUnexpectedResult;
            try testing.expect(feedback_yields != 0);
            var bytes: [4096]u8 = undefined;
            try testing.expect((try f.owner.readOutput(f.id, &bytes)) == null);
            try testing.expectEqual(@as(u32, 0), try f.owner.sceneHitTest(f.id, 0, 0));
        }
    }
}

test "Scene work budget unlimited hook replies cannot bypass remaining preparation quota" {
    for (0..4) |entrypoint| {
        const f = try Fixture.init(testing.allocator, 12, 3, .{ .output = transport });
        defer f.deinit();
        const child = try box(f.owner, f.id, f.root, 2, 0);
        const warm = try f.owner.sceneFrameStep(f.id, null, options);
        try f.owner.sceneFrameCancel(f.id, warm.frame_id);
        try f.owner.sceneSetHooks(f.root, 1, 1, 12, 3);
        const update = try f.owner.sceneFrameStepWorkBudgeted(f.id, null, options, 2, 12);
        try testing.expectEqual(@as(u32, 1), update.kind);
        try testing.expectEqual(@as(u32, 7), f.state.attempt.?.remaining_work);
        try f.owner.sceneSetStyle(child, 4, 0, 0, 1, 2, 1);
        const yielded = switch (entrypoint) {
            0 => try f.owner.sceneFrameStepWorkBudgeted(f.id, update, options, 2, 100),
            1 => try f.owner.sceneFrameStepWorkBudgeted(f.id, update, options, 2, std.math.maxInt(u32)),
            2 => try f.owner.sceneFrameStepBudgeted(f.id, update, options, 2),
            3 => try f.owner.sceneFrameStep(f.id, update, options),
            else => unreachable,
        };
        try testing.expectEqual(@as(u32, 6), yielded.kind);
        try testing.expectEqual(@as(f32, 1), (try f.owner.sceneGetPaintLayout(child)).width);
        try testing.expectEqual(@as(u32, 0), f.state.attempt.?.remaining_work);
        try testing.expectError(error.StaleFrame, f.owner.sceneFrameStep(f.id, update, options));
        const done = try f.step(yielded, options, 0, null);
        try testing.expectEqual(@as(f32, 2), (try f.owner.sceneGetPaintLayout(child)).width);
        try testing.expectEqual(ansi.rgbColor(2, 0, 0, 255), (try f.owner.getSessionRenderer(f.id)).getNextBuffer().get(1, 0).?.bg);
        try f.owner.sceneFrameCancel(f.id, done.frame_id);
    }
}

test "Scene work budget provisional preparation does not freeze callback or paint order" {
    for ([_]bool{ false, true }) |late_hooks| {
        const f = try Fixture.init(testing.allocator, 12, 3, .{ .output = transport });
        defer f.deinit();
        const a = try box(f.owner, f.id, f.root, 2, 0);
        const b = try box(f.owner, f.id, f.root, 3, 1);
        try f.owner.sceneSetPaint(b, .{ .zIndex = 1, .background = .{ 3, 0, 0, 255 } });
        var previous: ?scene.FrameRequest = null;
        if (late_hooks) {
            previous = try f.owner.sceneFrameStepWorkBudgeted(f.id, null, options, 10, 1);
            try testing.expectEqual(@as(u32, 6), previous.?.kind);
        }
        for ([_]context.Handle{ f.root, a, b }) |node| try f.owner.sceneSetHooks(node, 1, 1, 0, 0);
        var updates: usize = 0;
        const done = for (0..128) |_| {
            const request = try f.owner.sceneFrameStepWorkBudgeted(f.id, previous, options, 10, 1);
            if (request.kind == 0) break request;
            if (request.kind == 1) {
                try testing.expect(updates < 3);
                try testing.expectEqual(([_]u32{ 1, 3, 2 })[updates], request.num);
                updates += 1;
                if (request.num == 1) try f.owner.sceneSetPaint(a, .{ .zIndex = 2, .background = .{ 2, 0, 0, 255 } });
            } else try testing.expectEqual(@as(u32, 6), request.kind);
            previous = request;
        } else return error.TestUnexpectedResult;
        try testing.expectEqual(@as(usize, 3), updates);
        try testing.expectEqual(ansi.rgbColor(2, 0, 0, 255), (try f.owner.getSessionRenderer(f.id)).getNextBuffer().get(0, 0).?.bg);
        _ = try f.owner.sceneFrameCommit(f.id, done, true);
        var bytes: [4096]u8 = undefined;
        _ = try drain(f.owner, f.id, &bytes);
        try testing.expectEqual(@as(u32, 2), try f.owner.sceneHitTest(f.id, 0, 0));
    }
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
        try testing.expectEqual(ansi.rgbColor(0, 0, 0, 255), (try f.owner.getSessionRenderer(f.id)).getNextBuffer().get(0, 0).?.bg);
        try f.owner.sceneFrameCancel(f.id, done.frame_id);
    }
}
