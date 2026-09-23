const std = @import("std");
const repaint = @import("scene_fixture_test.zig").repaint;
const present = @import("scene_fixture_test.zig").present;
const testing = std.testing;
const Fixture = @import("scene_fixture_test.zig").Fixture;
const context = @import("../context.zig");
const yoga = @import("../yoga.zig");
const ansi = @import("../ansi.zig");
const gp = @import("../grapheme.zig");
const scene = @import("../scene.zig");

test {
    _ = @import("scene_editor_test.zig");
}

const frame_options: scene.FrameOptions = .{
    .background = .{ 0, 0, 0, 255 },
    .use_mouse = true,
    .excluded_hit_num = 0,
    .max_layout_rounds = 8,
    .max_host_requests = 65536,
};

fn session(owner: *context.Context, width: u32, height: u32) !context.Handle {
    const result = try owner.createSession(.{ .chunk_size = 4096, .chunk_count = 2, .span_capacity = 2 });
    try owner.attachSessionRenderer(result, width, height, .{ .remote_mode = .remote });
    return result;
}

fn dimensions(owner: *context.Context, node: context.Handle, width: f32, height: f32) !void {
    try owner.sceneSetStyle(node, 4, 0, 0, 1, width, 1);
    try owner.sceneSetStyle(node, 4, 1, 0, 1, height, 1);
}

test "Scene checked measurement rejects busy frames and preserves layout on wrong roots" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try session(owner, 8, 2);
    const root = try owner.sceneCreateNode(id, 0, 1);
    const child = try owner.sceneCreateNode(id, 1, 2);
    try owner.sceneMoveNode(child, root, 0);
    try dimensions(owner, child, 3, 1);
    try owner.sceneMeasureLayout(id, root);
    try testing.expectEqual(@as(f32, 3), (try owner.sceneGetLayout(child, true)).width);
    const other_id = try session(owner, 4, 2);
    const other_root = try owner.sceneCreateNode(other_id, 0, 3);
    try testing.expectError(error.WrongSession, owner.sceneMeasureLayout(id, other_root));
    try testing.expect(!owner.mutating);
    try testing.expectEqual(@as(f32, 3), (try owner.sceneGetLayout(child, true)).width);
    const frame = try owner.sceneFrameStep(id, null, frame_options);
    try testing.expectError(error.FrameBusy, owner.sceneMeasureLayout(id, root));
    try owner.sceneFrameCancel(id, frame.frame_id);
    try owner.sceneMeasureLayout(id, root);
    try owner.beginMutation();
    try testing.expectError(error.ContextBusy, owner.sceneMeasureLayout(id, root));
    try testing.expect(owner.mutating);
    owner.mutating = false;
    try owner.cancelSession(id);
    try testing.expectError(error.SessionCancelled, owner.sceneMeasureLayout(id, root));
    try testing.expect(!owner.mutating);
}

test "Scene retained surface binding rejects before replacing and releases each reference" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const other = try context.Context.init(testing.allocator, testing.io, .{});
    defer other.deinit() catch unreachable;
    const id = try session(owner, 8, 2);
    const root = try owner.sceneCreateNode(id, 0, 1);
    const node_handle = try owner.sceneCreateNode(id, 6, 2);
    const node = try owner.raw().getRenderable(node_handle);
    const first_handle = try owner.createBuffer(4, 1, .{});
    const first = try owner.raw().getBuffer(first_handle);
    const second_handle = try owner.createBuffer(4, 1, .{});
    const second = try owner.raw().getBuffer(second_handle);
    const foreign = try other.createBuffer(4, 1, .{});
    try owner.sceneSetSurface(node_handle, first_handle);
    try testing.expectEqual(@as(u32, 2), first.ref_count);
    try testing.expectError(error.WrongContext, owner.sceneSetSurface(node_handle, foreign));
    try testing.expectError(error.WrongKind, owner.sceneSetSurface(root, second_handle));
    second.ref_count = std.math.maxInt(u32);
    const rejected = owner.sceneSetSurface(node_handle, second_handle);
    second.ref_count = 1;
    try testing.expectError(error.ObjectLimit, rejected);
    try testing.expectEqual(first, node.surface.?);
    try testing.expectEqual(@as(u32, 2), first.ref_count);
    try owner.sceneSetSurface(node_handle, second_handle);
    try testing.expectEqual(@as(u32, 1), first.ref_count);
    try testing.expectEqual(@as(u32, 2), second.ref_count);
    try owner.sceneSetSurface(node_handle, null);
    try testing.expectEqual(@as(u32, 1), second.ref_count);
    try testing.expectEqual(null, node.surface);
    try owner.sceneSetSurface(node_handle, second_handle);
    try owner.sceneDestroyNode(node_handle);
    try testing.expectEqual(@as(u32, 1), second.ref_count);
}

fn drain(owner: *context.Context, id: context.Handle) !void {
    var bytes: [17]u8 = undefined;
    var work: usize = 0;
    while (try owner.readOutput(id, &bytes)) |ticket| {
        try testing.expect(work < 10000);
        work += 1;
        try owner.completeOutput(id, ticket, .written);
    }
}

fn filterChildren(owner: *context.Context, id: context.Handle, parent: context.Handle, children: []context.Handle) !void {
    for (children, 0..) |*child, index| {
        child.* = try owner.sceneCreateNode(id, 1, @intCast(index + 10));
        try dimensions(owner, child.*, 2, 2);
        try owner.sceneSetStyle(child.*, 0, 6, 0, 0, 2, 0);
        try owner.sceneSetPositions(child.*, 3, .{ 1, 1, 0, 0 }, .{ 0, @floatFromInt(index * 2), 0, 0 });
        try owner.sceneMoveNode(child.*, parent, @intCast(index));
    }
}

test "Scene empty boxes skip paint setup but retain hits and descendant clipping and opacity" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const parent = try f.owner.sceneCreateNode(f.id, 1, 2);
    const child = try f.owner.sceneCreateNode(f.id, 1, 3);
    const peer = try f.owner.sceneCreateNode(f.id, 1, 4);
    for ([_]context.Handle{ parent, child, peer }, [_][4]f32{
        .{ 0, 0, 3, 2 }, .{ 0, 0, 5, 1 }, .{ 4, 0, 2, 1 },
    }) |node, rect| {
        try dimensions(f.owner, node, rect[2], rect[3]);
        try f.owner.sceneSetStyle(node, 0, 6, 0, 0, 2, 0);
        try f.owner.sceneSetPositions(node, 3, .{ 1, 1, 0, 0 }, .{ rect[0], rect[1], 0, 0 });
    }
    try f.owner.sceneMoveNode(parent, f.root, 0);
    try f.owner.sceneMoveNode(child, parent, 0);
    try f.owner.sceneMoveNode(peer, f.root, 1);
    try f.owner.sceneSetStyle(parent, 0, 8, 0, 0, 1, 0);
    try f.owner.sceneSetPaint(parent, .{ .opacity = 0.5 });
    try f.owner.sceneSetPaint(child, .{ .background = .{ 200, 0, 0, 255 } });
    const black = ansi.rgbColor(0, 0, 0, 255);
    try f.owner.sceneSetPaint(peer, .{});
    try repaint(f.owner, f.id, frame_options.background, true, 0);
    const next = f.cli.getNextBuffer();
    const red = ansi.red(next.get(0, 0).?.bg);
    try testing.expect(red > 0 and red < 200);
    try testing.expectEqual(black, next.get(3, 0).?.bg);
    try testing.expectEqual(black, next.get(4, 0).?.bg);
    try testing.expectEqual(@as(u32, 0), f.cli.nextHitGrid[3]);
    try testing.expectEqual((try f.owner.raw().getRenderable(child)).scene_node.?.token, f.cli.nextHitGrid[2]);
    try testing.expectEqual((try f.owner.raw().getRenderable(parent)).scene_node.?.token, f.cli.nextHitGrid[8]);
    try testing.expectEqual((try f.owner.raw().getRenderable(peer)).scene_node.?.token, f.cli.nextHitGrid[4]);

    try f.owner.sceneSetPaint(peer, .{ .background = .{ 0, 200, 0, 255 } });
    try repaint(f.owner, f.id, frame_options.background, true, 0);
    try testing.expectEqual(ansi.rgbColor(0, 200, 0, 255), f.cli.getNextBuffer().get(4, 0).?.bg);
    try testing.expectEqual(@as(usize, 0), f.cli.getNextBuffer().scissor_stack.items.len);
    try testing.expectEqual(@as(usize, 0), f.cli.getNextBuffer().opacity_stack.items.len);
}

test "Scene geometry cache retries a failed third solve in one frame with clean Yoga" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const box = try f.owner.sceneCreateNode(f.id, 1, 2);
    try dimensions(f.owner, box, 3, 1);
    try f.owner.sceneMoveNode(box, f.root, 0);
    try f.owner.sceneSetHooks(f.root, 4, 1, 0, 0);
    const node = (try f.owner.raw().getRenderable(box)).scene_node.?;
    var request = try f.step(null, frame_options, 3, null);
    try testing.expectEqual(@as(u32, 1), node.prepared_round);
    const frame_id = request.frame_id;
    const epoch = request.layout_epoch;
    try dimensions(f.owner, box, 4, 1);
    request = try f.step(request, frame_options, 3, null);
    try testing.expectEqual(frame_id, request.frame_id);
    try testing.expectEqual(epoch + 1, request.layout_epoch);
    try testing.expectEqual(@as(u32, 2), node.prepared_round);
    try testing.expectEqual(@as(f32, 3), (try f.owner.sceneGetLayout(box, false)).width);

    try dimensions(f.owner, box, 5, 1);
    // This accepted transform fails preparation only after the third Yoga solve.
    try f.owner.sceneSetPaint(box, .{ .translateX = 2147483648 });
    try testing.expectError(error.InvalidDimensions, f.owner.sceneFrameStep(f.id, request, frame_options));
    try testing.expect(f.state.attempt == null and f.state.work.items.len == 0 and f.state.feedback.items.len == 0);
    try testing.expectEqual(epoch + 2, f.state.layout_epoch);
    try testing.expectEqual(frame_id, node.prepared_frame);
    try testing.expectEqual(@as(u32, 2), node.prepared_round);
    var dirty: u32 = 1;
    try yoga.check(yoga.yogaNodeIsDirtyChecked((try f.owner.raw().getRenderable(f.root)).yoga_node, &dirty));
    try testing.expectEqual(@as(u32, 0), dirty);
    try testing.expectEqual(@as(f32, 4), (try f.owner.sceneGetLayout(box, false)).width);

    try f.owner.sceneSetPaint(box, .{ .background = .{ 200, 0, 0, 255 } });
    request = try f.step(null, frame_options, 3, null);
    try testing.expectEqual(frame_id + 1, request.frame_id);
    try testing.expectEqual(epoch + 2, request.layout_epoch);
    try testing.expectEqual(@as(f32, 4), (try f.owner.sceneGetLayout(box, false)).width);
    try testing.expectEqual(@as(u32, 0), (try f.owner.sceneFrameStep(f.id, request, frame_options)).kind);
    try testing.expectEqual(@as(f32, 5), (try f.owner.sceneGetLayout(box, false)).width);
    try testing.expectEqual(ansi.rgbColor(200, 0, 0, 255), f.cli.getNextBuffer().get(4, 0).?.bg);
    try testing.expectEqual(node.token, f.cli.nextHitGrid[4]);
    try testing.expectEqual(@as(u32, 0), f.cli.nextHitGrid[5]);
    try f.owner.sceneFrameCancel(f.id, request.frame_id);
    try testing.expectEqual(@as(u32, 0), (try f.owner.sceneFrameStep(f.id, null, frame_options)).kind);
}

test "Scene viewport exact overlap retains spanning children beyond the legacy 50-gap lookbehind" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const content = try f.owner.sceneCreateNode(f.id, 1, 2);
    try dimensions(f.owner, content, 8, 130);
    try f.owner.sceneSetPaint(content, .{ .translateY = -120 });
    try f.owner.sceneMoveNode(content, f.root, 0);
    try f.owner.sceneSetViewport(content, f.root);
    var children: [64]context.Handle = undefined;
    try filterChildren(f.owner, f.id, content, &children);
    try dimensions(f.owner, children[0], 2, 130);
    for (children) |child| try f.owner.sceneSetHooks(child, 1, 1, 0, 0);
    var request: ?scene.FrameRequest = null;
    for ([_]usize{ 0, 60, 61 }) |index| {
        request = try f.owner.sceneFrameStep(f.id, request, frame_options);
        try testing.expectEqual(children[index], request.?.node);
    }
    try testing.expectEqual(@as(u32, 0), (try f.owner.sceneFrameStep(f.id, request, frame_options)).kind);
}

test "Scene viewport late reveal settles Slider refresh and resize feedback before paint without replaying updates" {
    const f = try Fixture.init(testing.allocator, 12, 4, .{});
    defer f.deinit();
    const content = try f.owner.sceneCreateNode(f.id, 1, 2);
    try dimensions(f.owner, content, 10, 32);
    try f.owner.sceneMoveNode(content, f.root, 0);
    try f.owner.sceneSetViewport(content, f.root);
    var children: [16]context.Handle = undefined;
    try filterChildren(f.owner, f.id, content, &children);
    for (children) |child| try dimensions(f.owner, child, 10, 2);
    const slider = try f.owner.sceneCreateNode(f.id, 3, 3);
    try dimensions(f.owner, slider, 2, 1);
    try f.owner.sceneSetSlider(slider, .{ .value = 50 });
    try f.owner.sceneMoveNode(slider, children[10], 0);
    try f.owner.sceneSetPaint(content, .{ .translateY = -20 });
    try repaint(f.owner, f.id, frame_options.background, true, 0);
    try f.owner.sceneSetPaint(content, .{});
    try repaint(f.owner, f.id, frame_options.background, true, 0);
    try dimensions(f.owner, slider, 8, 1);
    for (children) |child| try f.owner.sceneSetHooks(child, 1, 1, 10, 2);
    try f.owner.sceneSetHooks(slider, 3, 1, 2, 1);
    try f.owner.sceneFrameCancel(f.id, f.state.last_frame_id);
    var request = try f.step(null, frame_options, 1, children[0]);
    try testing.expectEqual(@as(f32, 2), (try f.owner.sceneGetLayout(slider, false)).width);
    try testing.expectEqual(@as(f32, 8), (try f.owner.sceneGetLayout(slider, true)).width);
    try f.owner.sceneSetPaint(content, .{ .translateY = -20 });
    for ([_]context.Handle{ children[1], children[10], slider }) |child| {
        request = try f.step(request, frame_options, 1, child);
    }
    try testing.expectEqual(@as(f32, 2), (try f.owner.sceneGetLayout(slider, false)).width);
    request = try f.step(request, frame_options, 2, slider);
    try testing.expectEqual(@as(u32, 8), request.width);
    try testing.expectEqualDeep(scene.SliderThumb{ .size = 1, .start = 8 }, try f.owner.sceneGetSliderThumb(slider));
    request = try f.step(request, frame_options, 1, children[11]);
    try testing.expectEqual(@as(u32, 0), (try f.owner.sceneFrameStep(f.id, request, frame_options)).kind);
    const layout = try f.owner.sceneGetLayout(slider, false);
    try testing.expectEqual(@as(f32, 8), layout.width);
    try testing.expectEqual(@as(f64, 0), layout.screenY);
    try testing.expectEqual(@as(u32, 0x258c), f.cli.getNextBuffer().get(4, 0).?.char);
    try testing.expectEqual((try f.owner.raw().getRenderable(slider)).scene_node.?.token, f.cli.nextHitGrid[7]);
    try testing.expectEqual((try f.owner.raw().getRenderable(children[10])).scene_node.?.token, f.cli.nextHitGrid[8]);
    try testing.expect(f.state.attempt == null and f.state.feedback.items.len == 0 and f.state.work.items.len == 0);
}

fn viewportAllocationFailures(allocator: std.mem.Allocator) !void {
    const f = try Fixture.init(allocator, 8, 4, .{ .limits = .{ .object_capacity = 20 } });
    defer f.deinit();
    const content = try f.owner.sceneCreateNode(f.id, 1, 2);
    try dimensions(f.owner, content, 8, 32);
    try f.owner.sceneMoveNode(content, f.root, 0);
    var children: [16]context.Handle = undefined;
    try filterChildren(f.owner, f.id, content, &children);
    const text = try f.owner.sceneCreateNode(f.id, 2, 3);
    try f.owner.sceneSetText(text, "wrapped text");
    try f.owner.sceneMoveNode(text, children[0], 0);
    try f.owner.sceneSetViewport(content, f.root);
    try f.owner.sceneSetFocus(text, true);
    try f.owner.sceneSetHooks(children[0], 3, 1, 0, 0);
    var request: ?scene.FrameRequest = null;
    for (0..3) |_| {
        request = try f.owner.sceneFrameStep(f.id, request, frame_options);
        if (request.?.kind == 0) break;
    } else return error.TestUnexpectedResult;
    try f.owner.cancelSession(f.id);
    try f.owner.sceneSetFocus(text, false);
    try f.owner.destroy(f.id);
    try testing.expectEqual(@as(u32, 0), f.owner.objects.live_count);
}

test "Scene viewport allocation failures release filtered text and focus ownership" {
    try testing.checkAllAllocationFailures(testing.allocator, viewportAllocationFailures, .{});
}

test "Scene focus path and filtered preparation honor the Yoga depth bound without frame allocations after warmup" {
    const f = try Fixture.init(testing.allocator, 4, 3, .{ .limits = .{ .object_capacity = 300 } });
    defer f.deinit();
    const content = try f.owner.sceneCreateNode(f.id, 1, 2);
    try dimensions(f.owner, content, 4, 3);
    try f.owner.sceneSetPaint(content, .{ .borderSides = 8, .focusable = true });
    try f.owner.sceneMoveNode(content, f.root, 0);
    try f.owner.sceneSetViewport(content, f.root);
    var deepest = content;
    for (2..yoga.depth_max) |index| {
        const node = try f.owner.sceneCreateNode(f.id, 1, @intCast(index + 1));
        try dimensions(f.owner, node, 1, 1);
        try f.owner.sceneMoveNode(node, deepest, 0);
        deepest = node;
    }
    try f.owner.sceneSetFocus(deepest, true);
    const extra = try f.owner.sceneCreateNode(f.id, 1, 1000);
    try testing.expectError(error.YogaDepthLimit, f.owner.sceneMoveNode(extra, deepest, 0));
    try repaint(f.owner, f.id, frame_options.background, false, 0);
    var failing = testing.FailingAllocator.init(testing.allocator, .{ .fail_index = 0 });
    f.state.allocator = failing.allocator();
    const painted = repaint(f.owner, f.id, frame_options.background, false, 0);
    f.state.allocator = f.owner.allocator;
    try painted;
    try testing.expect(!failing.has_induced_failure);
    try testing.expectEqual(ansi.rgbColor(0, 170, 255, 255), (try f.owner.raw().getSessionRenderer(f.id)).getNextBuffer().get(0, 0).?.fg);
    try f.owner.sceneFrameCancel(f.id, f.state.last_frame_id);
    f.state.last_frame_id = std.math.maxInt(u64);
    try testing.expectError(error.RequestLimit, f.owner.sceneFrameStep(f.id, null, frame_options));
    try testing.expect(f.state.attempt == null);
}

test "Scene Slider clipping retains cells at rounded inverse-coordinate boundaries" {
    for (0..2) |orientation| {
        const f = try Fixture.init(testing.allocator, 1, 1, .{});
        defer f.deinit();
        const slider = try f.owner.sceneCreateNode(f.id, 3, 2);
        try dimensions(f.owner, slider, if (orientation == 0) 2 else 1, if (orientation == 1) 2 else 1);
        try f.owner.sceneMoveNode(slider, f.root, 0);
        try f.owner.sceneSetSlider(slider, .{ .orientation = @intCast(orientation), .max = 1, .value = 1, .viewport_size = 1 });
        const offset: f64 = -1.1102230246251565e-16;
        try f.owner.sceneSetPaint(slider, .{
            .translateX = if (orientation == 0) offset else 0,
            .translateY = if (orientation == 1) offset else 0,
        });
        try repaint(f.owner, f.id, frame_options.background, false, 0);
        try testing.expectEqual(@as(u32, 0x2588), (try f.owner.raw().getSessionRenderer(f.id)).getNextBuffer().get(0, 0).?.char);
    }
}

test "Scene Slider and Arrow reject invalid arithmetic without changing accepted options" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try session(owner, 5, 2);
    const root = try owner.sceneCreateNode(id, 0, 1);
    const slider = try owner.sceneCreateNode(id, 3, 2);
    const arrow = try owner.sceneCreateNode(id, 4, 3);
    try dimensions(owner, slider, 5, 1);
    try owner.sceneMoveNode(slider, root, 0);
    const accepted: scene.SliderOptions = .{ .max = 7, .value = 1, .viewport_size = 3 };
    const accepted_arrow: scene.ArrowOptions = .{ .direction = 3, .attributes = 7 };
    try owner.sceneSetSlider(slider, accepted);
    try owner.sceneSetArrow(arrow, accepted_arrow);
    try repaint(owner, id, frame_options.background, false, 0);
    const before = try owner.sceneGetSliderThumb(slider);
    for ([_]scene.SliderOptions{
        .{ .orientation = 2 },
        .{ .min = std.math.nan(f64) },
        .{ .max = std.math.inf(f64) },
        .{ .value = std.math.nan(f64) },
        .{ .viewport_size = -std.math.inf(f64) },
        .{ .min = -std.math.floatMax(f64), .max = std.math.floatMax(f64) },
        .{ .min = -std.math.floatMax(f64), .max = 0, .value = std.math.floatMax(f64) },
        .{ .max = std.math.floatMax(f64), .viewport_size = std.math.floatMax(f64) },
        .{ .max = 5e-324, .value = 1 },
        .{ .max = 1, .value = std.math.floatMax(f64), .viewport_size = 1 },
    }) |invalid| try testing.expectError(error.InvalidOptions, owner.sceneSetSlider(slider, invalid));
    try testing.expectError(error.InvalidOptions, owner.sceneSetArrow(arrow, .{ .direction = 4 }));
    try testing.expectError(error.InvalidOptions, owner.sceneSetArrow(arrow, .{ .attributes = 256 }));
    try testing.expectEqualDeep(before, try owner.sceneGetSliderThumb(slider));
    try testing.expectEqualDeep(accepted, (try owner.raw().getRenderable(slider)).scene_node.?.control.slider);
    try testing.expectEqualDeep(accepted_arrow, (try owner.raw().getRenderable(arrow)).scene_node.?.control.arrow);
}

test "Scene text reports a checked error for a 129-byte grapheme" {
    const f = try Fixture.init(testing.allocator, 4, 2, .{});
    defer f.deinit();
    const node = try f.owner.sceneCreateNode(f.id, 2, 2);
    try dimensions(f.owner, node, 1, 1);
    try f.owner.sceneMoveNode(node, f.root, 0);
    const accepted = "e" ++ "\u{301}" ** 63;
    try f.owner.sceneSetText(node, accepted);
    try repaint(f.owner, f.id, .{ 0, 0, 0, 255 }, false, 0);
    const next = (try f.owner.raw().getSessionRenderer(f.id)).getNextBuffer();
    const char = next.get(0, 0).?.char;
    try testing.expect(gp.isGraphemeChar(char));
    try testing.expectEqualStrings(accepted, try f.owner.graphemes.get(gp.graphemeIdFromChar(char)));

    const rejected = "e" ++ "\u{301}" ** 64;
    try testing.expectEqual(@as(usize, 129), rejected.len);
    const result: anyerror!void = if (f.owner.sceneSetText(node, rejected)) |_|
        repaint(f.owner, f.id, .{ 0, 0, 0, 255 }, false, 0)
    else |err|
        err;
    try testing.expectError(error.TextLimit, result);
}

test "Scene text bounds document counters before allocating a replacement" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const f = try Fixture.init(failing.allocator(), 8, 2, .{});
    defer f.deinit();
    const text = try f.owner.sceneCreateNode(f.id, 2, 2);
    try f.owner.sceneSetText(text, "kept");
    const text_buffer = (try f.owner.raw().getRenderable(text)).scene_node.?.text.?.buffer;
    text_buffer.setTabWidth(255);
    const bytes = try testing.allocator.alloc(u8, (std.math.maxInt(u32) - 1) / @as(u32, text_buffer.tabWidth()) + 1);
    defer testing.allocator.free(bytes);
    @memset(bytes, '\t');
    failing.fail_index = failing.alloc_index;
    try testing.expectError(error.TextLimit, f.owner.sceneSetText(text, bytes));
    failing.fail_index = std.math.maxInt(usize);
    try testing.expect(!failing.has_induced_failure);
    var output: [4]u8 = undefined;
    try testing.expectEqual(@as(u32, 4), try f.owner.sceneGetText(text, &output));
    try testing.expectEqualStrings("kept", &output);
}

test "Scene selected text copies exact bytes without allocating" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const f = try Fixture.init(failing.allocator(), 8, 2, .{});
    defer f.deinit();
    const node = try f.owner.sceneCreateNode(f.id, 2, 2);
    try dimensions(f.owner, node, 8, 2);
    try f.owner.sceneSetTextOptions(node, .{ .wrap_mode = .none });
    try f.owner.sceneSetText(node, "\xe4\xb8\xad tail\n" ++ "x" ** 65536);
    _ = try f.owner.sceneSetTextSelection(node, .{ .operation = 1, .focus_x = 1 });
    failing.fail_index = failing.alloc_index;
    failing.resize_fail_index = failing.resize_index;
    try testing.expectEqual(3, try f.owner.sceneGetSelectedText(node, &.{}));
    var output = "safe".*;
    try testing.expectError(error.BufferTooSmall, f.owner.sceneGetSelectedText(node, output[0..2]));
    try testing.expectEqualStrings("safe", &output);
    try testing.expectEqual(3, try f.owner.sceneGetSelectedText(node, output[0..3]));
    try testing.expectEqualStrings("\xe4\xb8\xad", output[0..3]);
    try testing.expect(!failing.has_induced_failure);
}

test "Scene text fully clipped coordinates never enter signed drawing arithmetic" {
    const f = try Fixture.init(testing.allocator, 4, 2, .{});
    defer f.deinit();
    const text = try f.owner.sceneCreateNode(f.id, 2, 2);
    try f.owner.sceneSetText(text, "offscreen");
    try dimensions(f.owner, text, 3, 1);
    try f.owner.sceneMoveNode(text, f.root, 0);
    try f.owner.sceneSetPaint(text, .{ .translateY = std.math.minInt(i32) });
    try repaint(f.owner, f.id, .{ 0, 0, 0, 255 }, true, 0);
    for (f.cli.getNextBuffer().buffer.char) |char| try testing.expectEqual(@as(u32, ' '), char);
    for (f.cli.nextHitGrid) |hit| try testing.expectEqual(@as(u32, 0), hit);
}

test "Scene owns and iteratively destroys registered nodes including detached boxes" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const f = try Fixture.init(failing.allocator(), 2, 2, .{ .limits = .{ .object_capacity = 513 } });
    defer f.deinit();
    var last = f.root;
    for (1..512) |index| {
        last = try f.owner.sceneCreateNode(f.id, 1, @intCast(index + 1));
        if (index % 2 == 0) try f.owner.sceneMoveNode(last, f.root, @intCast(index / 2 - 1));
    }
    try testing.expectError(error.ObjectLimit, f.owner.sceneCreateNode(f.id, 1, 513));
    failing.fail_index = failing.alloc_index;
    failing.resize_fail_index = failing.resize_index;
    yoga.testFailAfter(0);
    defer yoga.testFailAfter(-1);
    try f.owner.destroy(f.id);
    try testing.expectEqual(@as(u32, 0), f.owner.objects.live_count);
    try testing.expectError(error.StaleHandle, f.owner.raw().getRenderable(last));
    try testing.expectEqual(@as(u32, context.Context.node_pool_count_max), f.owner.node_pool_count);
    try testing.expect(!failing.has_induced_failure);
    try testing.expectEqual(@as(u64, 0), yoga.testAllocationCount());
}

test "Scene rejects cross-session parents and exhausted hit tokens" {
    const f = try Fixture.init(testing.allocator, 2, 2, .{});
    defer f.deinit();
    const other = try session(f.owner, 2, 2);
    const other_root = try f.owner.sceneCreateNode(other, 0, 3);
    const child = try f.owner.sceneCreateNode(f.id, 1, 2);
    try testing.expectError(error.WrongSession, f.owner.sceneMoveNode(child, other_root, 0));
    try f.owner.sceneMoveNode(child, f.root, 0);
    try testing.expectError(error.YogaInvalidArgument, f.owner.sceneMoveNode(f.root, child, 0));
    f.state.last_token = std.math.maxInt(u32);
    const count = f.owner.objects.live_count;
    try testing.expectError(error.ObjectLimit, f.owner.sceneCreateNode(f.id, 1, 2));
    try testing.expectEqual(count, f.owner.objects.live_count);
}

test "Scene Yoga placement rejection and poisoned layout preserve accepted state" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    defer yoga.testFailAfter(-1);
    const id = try session(owner, 8, 4);
    const root = try owner.sceneCreateNode(id, 0, 1);
    const box = try owner.sceneCreateNode(id, 1, 2);
    try dimensions(owner, box, 3, 2);
    yoga.testFailAfter(0);
    try testing.expectError(error.OutOfMemory, owner.sceneMoveNode(box, root, 0));
    yoga.testFailAfter(-1);
    try testing.expect((try owner.raw().getRenderable(box)).scene_node.?.parent == null);
    try testing.expect(yoga.yogaNodeGetParent((try owner.raw().getRenderable(box)).yoga_node) == null);
    try owner.sceneMoveNode(box, root, 0);
    try repaint(owner, id, .{ 0, 0, 0, 255 }, true, 0);
    const before = try owner.sceneGetLayout(box, false);
    try dimensions(owner, box, 4, 2);
    yoga.testFailAfter(0);
    try testing.expectError(error.OutOfMemory, repaint(owner, id, .{ 0, 0, 0, 255 }, true, 0));
    yoga.testFailAfter(-1);
    try testing.expectEqualDeep(before, try owner.sceneGetLayout(box, false));
    try testing.expectError(error.YogaPoisoned, repaint(owner, id, .{ 0, 0, 0, 255 }, true, 0));
    try testing.expectError(error.YogaPoisoned, owner.sceneGetLayout(box, true));
    try testing.expectEqual(@as(u64, 0), (try owner.raw().getSession(id)).getStats().bytes_written);
    try testing.expectEqual(@as(u32, 0), try owner.sceneHitTest(id, 0, 0));
    try owner.sceneDestroyNode(root);
    try owner.sceneDestroyNode(box);
}

test "Scene fractional border clips add insets before coordinate truncation" {
    for ([_]bool{ false, true }) |vertical| {
        const f = try Fixture.init(testing.allocator, 4, 4, .{});
        defer f.deinit();
        defer f.owner.cancelSession(f.id) catch unreachable;
        const parent = try f.owner.sceneCreateNode(f.id, 1, 2);
        const child = try f.owner.sceneCreateNode(f.id, 1, 3);
        try dimensions(f.owner, parent, if (vertical) 2 else 4, if (vertical) 4 else 2);
        try dimensions(f.owner, child, 1, 1);
        try f.owner.sceneSetStyle(parent, 0, 8, 0, 0, 1, 0);
        try f.owner.sceneSetPaint(parent, .{
            .borderSides = if (vertical) 8 else 1,
            .translateX = if (vertical) 0 else -0.5,
            .translateY = if (vertical) -0.5 else 0,
        });
        try f.owner.sceneSetPaint(child, .{ .background = .{ 0, 200, 0, 255 } });
        try f.owner.sceneMoveNode(parent, f.root, 0);
        try f.owner.sceneMoveNode(child, parent, 0);
        try repaint(f.owner, f.id, .{ 0, 0, 0, 255 }, true, 0);
        try testing.expectEqual(ansi.rgbColor(0, 200, 0, 255), f.cli.getNextBuffer().get(0, 0).?.bg);
        _ = try present(f.owner, f.id, true);
        try drain(f.owner, f.id);
        try testing.expectEqual(@as(u32, 3), try f.owner.sceneHitTest(f.id, 0, 0));
    }
}
