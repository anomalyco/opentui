const std = @import("std");
const testing = std.testing;
const Fixture = @import("scene_fixture_test.zig").Fixture;
const context = @import("../context.zig");
const scene = @import("../scene.zig");
const transport: @import("../session.zig").Options = .{ .chunk_size = 4096, .control_capacity = 4096 };
const ansi = @import("../ansi.zig");
const paint_tests = @import("scene_custom_paint_test.zig");

const options: scene.FrameOptions = .{
    .background = .{ 0, 0, 0, 255 },
    .use_mouse = true,
    .excluded_hit_num = 0,
    .max_layout_rounds = 8,
    .max_host_requests = 64,
};

fn box(owner: *context.Context, id: context.Handle, parent: context.Handle, num: u32, index: u32) !context.Handle {
    return paint_tests.node(owner, id, parent, 1, num, index);
}

test "Scene prefix and custom self fix prepared membership through reparent reveal insertion and slot reuse" {
    for ([_]u32{ 8, 32 }) |flags| {
        const f = try Fixture.init(testing.allocator, 8, 1, .{ .output = transport });
        defer f.deinit();
        const kind: u32 = if (flags == 8) 1 else 6;
        const source = try paint_tests.node(f.owner, f.id, f.root, kind, 2, 0);
        const child = try paint_tests.node(f.owner, f.id, source, kind, 3, 0);
        const hidden = try paint_tests.node(f.owner, f.id, source, kind, 4, 1);
        const removed = try paint_tests.node(f.owner, f.id, source, kind, 5, 2);
        const destination = try paint_tests.node(f.owner, f.id, f.root, kind, 6, 1);
        try f.owner.sceneSetPaint(source, .{ .translateX = 1, .shouldFill = 0 });
        try f.owner.sceneSetPaint(destination, .{ .translateX = 5, .shouldFill = 0 });
        for ([_]context.Handle{ source, child, hidden, removed, destination }) |node| try f.owner.sceneSetHooks(node, flags, 1, 2, 1);
        try f.owner.sceneSetStyle(hidden, 0, 9, 0, 0, 1, 0);
        var request = try f.owner.sceneFrameStep(f.id, null, options);
        try testing.expectEqual(source, request.node);
        try f.owner.sceneMoveNode(child, destination, 0);
        if (flags == 8) try f.owner.sceneMoveNode(hidden, destination, 1);
        try f.owner.sceneSetStyle(hidden, 0, 9, 0, 0, 0, 0);
        if (flags == 32) try f.owner.sceneSetPaint(destination, .{ .zIndex = -1, .translateX = 5, .shouldFill = 0 });
        try f.owner.sceneDestroyNode(removed);
        const inserted = try paint_tests.node(f.owner, f.id, destination, kind, 7, if (flags == 8) 2 else 1);
        try testing.expectEqual(removed.slot, inserted.slot);
        try testing.expect(removed.generation != inserted.generation);
        try f.owner.sceneSetHooks(inserted, flags, 1, 2, 1);
        for ([_]context.Handle{ child, destination }) |node| {
            request = try f.step(request, options, if (flags == 8) 4 else 7, node);
            if (std.meta.eql(node, child)) {
                try testing.expectEqual(@as(f64, 5), (try f.owner.sceneGetLayout(child, false)).screenX);
            }
        }
        if (flags == 8) try testing.expectEqual(ansi.rgbColor(3, 0, 0, 255), (try f.owner.getSessionRenderer(f.id)).getNextBuffer().get(1, 0).?.bg);
        request = try f.step(request, options, 0, null);
        try f.owner.sceneFrameCancel(f.id, request.frame_id);
        var previous: ?scene.FrameRequest = null;
        const next_order = if (flags == 8)
            [_]context.Handle{ source, destination, child, hidden, inserted }
        else
            [_]context.Handle{ destination, child, inserted, source, hidden };
        for (next_order) |node| {
            previous = try f.step(previous, options, if (flags == 8) 4 else 7, node);
        }
        request = try f.step(previous, options, 0, null);
        try f.owner.sceneFrameCancel(f.id, request.frame_id);
    }
}

test "Scene prefix entered destruction finishes self after and retired hits without painting a replacement" {
    const f = try Fixture.init(testing.allocator, 8, 1, .{ .output = transport });
    defer f.deinit();
    const child = try box(f.owner, f.id, f.root, 2, 0);
    const token = (try f.owner.getRenderable(child)).scene_node.?.token;
    try f.owner.sceneSetHooks(child, 24, 1, 2, 1);
    const before = try f.owner.sceneFrameStep(f.id, null, options);
    try f.owner.sceneSetPaint(child, .{ .background = .{ 200, 0, 0, 255 }, .translateX = 1 });
    try f.owner.sceneSetHooks(child, 24, 2, 2, 1);
    try f.owner.sceneDestroyNode(child);
    const replacement = try box(f.owner, f.id, f.root, 3, 0);
    try f.owner.sceneSetHooks(replacement, 24, 1, 2, 1);
    try testing.expectEqual(child.slot, replacement.slot);
    try testing.expect(child.generation != replacement.generation);
    const after = try f.step(before, options, 5, child);
    try testing.expectEqual(@as(u64, 2), after.hook_generation);
    _ = try f.state.checkFrameAccess(after);
    try testing.expectEqual(ansi.rgbColor(200, 0, 0, 255), f.cli.getNextBuffer().get(1, 0).?.bg);
    const done = try f.step(after, options, 0, null);
    try testing.expectEqual(token, f.cli.nextHitGrid[1]);
    try testing.expectEqual(@as(u32, 0), try f.owner.sceneHitTest(f.id, 1, 0));
    try f.owner.sceneFrameCancel(f.id, done.frame_id);
}

test "Scene prefix freezes clip opacity and dimensions but samples live transforms after both hooks" {
    const f = try Fixture.init(testing.allocator, 8, 1, .{ .output = transport });
    defer f.deinit();
    const parent = try box(f.owner, f.id, f.root, 2, 0);
    const child = try box(f.owner, f.id, parent, 3, 0);
    try f.owner.sceneSetStyle(parent, 4, 0, 0, 1, 4, 1);
    try f.owner.sceneSetStyle(parent, 0, 8, 0, 0, 1, 0);
    try f.owner.sceneSetPaint(parent, .{ .opacity = 0.5, .shouldFill = 0 });
    try f.owner.sceneSetPaint(child, .{ .opacity = 0.5, .background = .{ 200, 0, 0, 255 } });
    try f.owner.sceneSetHooks(parent, 24, 1, 4, 1);
    try f.owner.sceneSetHooks(child, 24, 1, 2, 1);
    var request = try f.owner.sceneFrameStep(f.id, null, options);
    try testing.expectEqual(@as(f32, 0.5), f.cli.getNextBuffer().getCurrentOpacity());
    try f.owner.sceneSetPaint(parent, .{ .opacity = 1, .shouldFill = 0, .translateX = 1 });
    try f.owner.sceneSetStyle(parent, 4, 0, 0, 1, 6, 1);
    request = try f.step(request, options, 5, null);
    try testing.expectEqual(@as(u32, 4), request.width);
    try testing.expectEqual(@as(f32, 4), (try f.owner.sceneGetLayout(parent, false)).width);
    try testing.expectEqual(@as(f64, 1), (try f.owner.sceneGetLayout(child, false)).screenX);
    request = try f.owner.sceneFrameStep(f.id, request, options);
    try testing.expectEqual(child, request.node);
    try testing.expectEqual(@as(f32, 0.25), f.cli.getNextBuffer().getCurrentOpacity());
    try testing.expectEqual(@as(u32, 4), f.cli.getNextBuffer().scissor_stack.items[0].width);
    try f.owner.sceneSetPaint(child, .{ .opacity = 1, .translateX = 2, .background = .{ 0, 200, 0, 255 } });
    request = try f.step(request, options, 5, null);
    try testing.expectEqual(@as(f64, 3), (try f.owner.sceneGetLayout(child, false)).screenX);
    try testing.expect(ansi.green(f.cli.getNextBuffer().get(3, 0).?.bg) > 0);
    try testing.expectEqual(ansi.rgbColor(0, 0, 0, 255), f.cli.getNextBuffer().get(4, 0).?.bg);
    try f.owner.sceneSetPaint(child, .{ .opacity = 1, .translateX = 0, .background = .{ 0, 200, 0, 255 } });
    const done = try f.owner.sceneFrameStep(f.id, request, options);
    const token = (try f.owner.getRenderable(child)).scene_node.?.token;
    try testing.expectEqual(token, f.cli.nextHitGrid[1]);
    try testing.expectEqual(token, f.cli.nextHitGrid[2]);
    try testing.expect(f.cli.nextHitGrid[3] != token);
    try testing.expectEqual(@as(f32, 1), f.cli.getNextBuffer().getCurrentOpacity());
    try testing.expectEqual(@as(usize, 0), f.cli.getNextBuffer().scissor_stack.items.len);
    try f.owner.sceneFrameCancel(f.id, done.frame_id);
    request = try f.owner.sceneFrameStep(f.id, null, options);
    try testing.expectEqual(@as(u32, 6), request.width);
    try f.owner.sceneFrameCancel(f.id, request.frame_id);
}

test "Scene prefix live focus changes the later box border" {
    const f = try Fixture.init(testing.allocator, 8, 1, .{ .output = transport });
    defer f.deinit();
    const child = try box(f.owner, f.id, f.state.root.?.scene_node.?.handle, 2, 0);
    try f.owner.sceneSetPaint(child, .{
        .borderSides = 8,
        .focusable = true,
        .borderColor = .{ 200, 0, 0, 255 },
        .focusedBorderColor = .{ 0, 200, 0, 255 },
    });
    try f.owner.sceneSetHooks(child, 24, 1, 2, 1);
    var request = try f.owner.sceneFrameStep(f.id, null, options);
    try f.owner.sceneSetFocus(child, true);
    request = try f.owner.sceneFrameStep(f.id, request, options);
    try testing.expectEqual(ansi.rgbColor(0, 200, 0, 255), (try f.owner.getSessionRenderer(f.id)).getNextBuffer().get(0, 0).?.fg);
    try f.owner.sceneFrameCancel(f.id, request.frame_id);
}

test "Scene prefix shares host request bounds and clears failed continuations without publishing hits" {
    const f = try Fixture.init(testing.allocator, 8, 1, .{ .output = transport });
    defer f.deinit();
    const child = try box(f.owner, f.id, f.root, 2, 0);
    try f.owner.sceneSetHooks(child, 25, 1, 2, 1);
    var limited = options;
    limited.max_host_requests = 2;
    var request = try f.step(null, limited, 1, null);
    request = try f.step(request, limited, 4, null);
    try testing.expectEqual(@as(u64, 2), request.request_id);
    try testing.expectError(error.FrameRequestLimit, f.owner.sceneFrameStep(f.id, request, limited));
    try testing.expect(f.state.attempt == null and f.state.prefix == null and f.state.painted == null);
    try testing.expectEqual(@as(usize, 0), f.state.paint_members.items.len);
    try testing.expectEqual(@as(usize, 0), f.state.work.items.len);
    for (f.cli.nextHitGrid) |token| try testing.expectEqual(@as(u32, 0), token);
    try testing.expectEqual(@as(usize, 0), f.cli.getNextBuffer().scissor_stack.items.len);
    try testing.expectEqual(@as(usize, 0), f.cli.getNextBuffer().opacity_stack.items.len);
    try testing.expectError(error.StaleFrame, f.owner.renderSession(f.id, true));
    try testing.expectError(error.StaleFrame, f.state.checkFrameAccess(request));
    request = try f.step(null, options, 1, null);
    request = try f.owner.sceneFrameStep(f.id, request, options);
    try f.owner.sceneSetPaint(child, .{ .translateX = std.math.floatMax(f64) });
    try testing.expectError(error.InvalidDimensions, f.owner.sceneFrameStep(f.id, request, options));
    try testing.expect(f.state.attempt == null and f.state.prefix == null);
    try testing.expectError(error.StaleFrame, f.owner.renderSession(f.id, true));
    try f.owner.sceneSetPaint(child, .{});
    request = try f.owner.sceneFrameStep(f.id, null, options);
    try f.owner.sceneFrameCancel(f.id, request.frame_id);
}
