const std = @import("std");
const testing = std.testing;
const context = @import("../context.zig");
const scene = @import("../scene.zig");
const ansi = @import("../ansi.zig");
const c = @import("context_abi_c");
const fixture = @import("scene_fixture_test.zig");
const Fixture = fixture.Fixture;

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

fn frame(f: Fixture, updates: []const context.Handle) !void {
    var request: ?scene.FrameRequest = null;
    for (updates) |child| {
        request = try f.step(request, frame_options, 1, child);
    }
    _ = try f.step(request, frame_options, 0, null);
}

fn expectTop(f: Fixture, child: context.Handle) !void {
    const node = (try f.owner.raw().getRenderable(child)).scene_node.?;
    for (0..2) |x| {
        const cell = f.cli.getNextBuffer().get(@intCast(x), 0).?;
        try testing.expectEqual(@as(u32, ' '), cell.char);
        try testing.expectEqual(ansi.rgbColor(@intCast(node.num), 0, 0, 255), cell.bg);
        try testing.expectEqual(node.token, f.draftHit(x));
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

test "Scene equal-z siblings paint in attachment order however z reached them" {
    // A is attached before B and both end at z 2, as in a fresh scene where B is on top.
    for ([_]enum { fresh, between, reply, history }{ .fresh, .between, .reply, .history }) |when| {
        const f = try Fixture.init(testing.allocator, 2, 1, .{});
        defer f.deinit();
        const a = try box(f.owner, f.id, 2, if (when == .history) 0 else 2);
        const b = try box(f.owner, f.id, 3, if (when == .fresh) 2 else 0);
        const hook = try box(f.owner, f.id, 4, -1);
        for ([_]context.Handle{ a, b, hook }, 0..) |child, index| try f.owner.sceneMoveNode(child, f.root, @intCast(index));
        try f.owner.sceneSetHooks(hook, 1, 1, 2, 1);
        if (when == .history) {
            try frame(f, &.{hook});
            try expectTop(f, b);
            try f.owner.scenePatchPaint(a, c.OT_SCENE_PROPERTY_Z_INDEX, .{ .zIndex = 2 });
            try frame(f, &.{hook});
            try expectTop(f, a);
        }
        if (when == .between or when == .history) try f.owner.scenePatchPaint(b, c.OT_SCENE_PROPERTY_Z_INDEX, .{ .zIndex = 2 });
        // The reply lands after feedback sorted; the paint list sorts again.
        const request = try f.step(null, frame_options, 1, hook);
        if (when == .reply) try f.owner.scenePatchPaint(b, c.OT_SCENE_PROPERTY_Z_INDEX, .{ .zIndex = 2 });
        _ = try f.step(request, frame_options, 0, null);
        try expectTop(f, b);
        try frame(f, &.{hook});
        try expectTop(f, b);
    }
}

test "Scene ordered equal-z append skips settled sibling rank and sort work" {
    for ([_]bool{ false, true }) |hooks| {
        const f = try Fixture.init(testing.allocator, 2, 1, .{});
        defer f.deinit();
        var children: [68]context.Handle = undefined;
        for (children[0..64], 0..) |*child, index| {
            child.* = try box(f.owner, f.id, @intCast(index + 2), 0);
            try f.owner.sceneMoveNode(child.*, f.root, @intCast(index));
            if (hooks) try f.owner.sceneSetHooks(child.*, 1, 1, 2, 1);
        }
        try frame(f, if (hooks) children[0..64] else &.{});
        try expectTop(f, children[63]);
        for (64..children.len) |index| {
            f.state.test_sort_steps = 0;
            children[index] = try box(f.owner, f.id, @intCast(index + 2), 0);
            try f.owner.sceneMoveNode(children[index], children[0], 0);
            try f.owner.sceneMoveNode(children[index], f.root, @intCast(index));
            if (hooks) try f.owner.sceneSetHooks(children[index], 1, 1, 2, 1);
            try frame(f, if (hooks) children[0 .. index + 1] else &.{});
            try expectTop(f, children[index]);
            try testing.expectEqual(@as(u64, 0), f.state.test_sort_steps);
        }
    }
}
