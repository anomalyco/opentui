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

test "Scene prefix entered destruction finishes self after and retired hits without painting a replacement" {
    const f = try Fixture.init(testing.allocator, 8, 1, .{ .output = transport });
    defer f.deinit();
    const child = try box(f.owner, f.id, f.root, 2, 0);
    const token = (try f.owner.raw().getRenderable(child)).scene_node.?.token;
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
    const token = (try f.owner.raw().getRenderable(child)).scene_node.?.token;
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
