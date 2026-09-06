const std = @import("std");
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

test "Scene retained surface binding rejects before replacing and releases each reference" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const other = try context.Context.init(testing.allocator, testing.io, .{});
    defer other.deinit() catch unreachable;
    const id = try session(owner, 8, 2);
    const root = try owner.sceneCreateNode(id, 0, 1);
    const node_handle = try owner.sceneCreateNode(id, 6, 2);
    const node = try owner.getRenderable(node_handle);
    const first_handle = try owner.createBuffer(4, 1, .{});
    const first = try owner.getBuffer(first_handle);
    const second_handle = try owner.createBuffer(4, 1, .{});
    const second = try owner.getBuffer(second_handle);
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

test "Scene custom arrow owns bytes and releases entered nodes on completion and cancellation" {
    for ([_]bool{ false, true }) |cancel| {
        const f = try Fixture.init(testing.allocator, 8, 2, .{});
        defer f.deinit();
        const arrow = try f.owner.sceneCreateNode(f.id, 4, 2);
        try dimensions(f.owner, arrow, 4, 1);
        try f.owner.sceneMoveNode(arrow, f.root, 0);
        var bytes = "arrow".*;
        const fg = ansi.indexedColor(6, 0, 128, 128);
        try f.owner.sceneSetArrow(arrow, .{ .text = &bytes, .foreground = fg });
        @memset(&bytes, 'x');
        try testing.expectError(error.InvalidUnicode, f.owner.sceneSetArrow(arrow, .{ .text = "bad\n" }));
        try f.owner.sceneSetHooks(arrow, 8, 1, 4, 1);
        var request = try f.step(null, frame_options, 4, null);
        try f.owner.sceneDestroyNode(arrow);
        if (cancel) {
            try f.owner.sceneFrameCancel(f.id, request.frame_id);
        } else {
            request = try f.step(request, frame_options, 0, null);
            const target = (try f.owner.getSessionRenderer(f.id)).getNextBuffer();
            try testing.expectEqual(fg, target.get(0, 0).?.fg);
            var output: [64]u8 = undefined;
            const length = try target.writeResolvedChars(&output, false);
            try testing.expect(std.mem.startsWith(u8, output[0..length], "arrow"));
        }
    }
}

test "Scene snapshot keeps explicit trailing spaces distinct from unwritten suffix cells" {
    const f = try Fixture.init(testing.allocator, 20, 2, .{});
    defer f.deinit();
    const text = try f.owner.sceneCreateNode(f.id, 2, 2);
    try dimensions(f.owner, text, 20, 1);
    try f.owner.sceneMoveNode(text, f.root, 0);
    var options = frame_options;
    options.preserve_unwritten = true;
    for ([_][]const u8{ "seventeen letters", "spaces  " }) |content| {
        try f.owner.sceneSetText(text, content);
        const frame = try f.owner.sceneFrameStep(f.id, null, options);
        const target = (try f.owner.getSessionRenderer(f.id)).getNextBuffer();
        for (content, 0..) |char, x| try testing.expectEqual(@as(u32, char), target.get(@intCast(x), 0).?.char);
        for (content.len..20) |x| try testing.expectEqual(@as(u32, 0), target.get(@intCast(x), 0).?.char);
        try f.owner.sceneFrameCancel(f.id, frame.frame_id);
    }
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
    for ([_]scene.Paint{
        .{},
        .{ .background = .{ 0, 200, 0, 255 }, .shouldFill = 0 },
        .{ .background = .{ 0, 200, 0, 255 } },
        .{ .borderSides = 8, .shouldFill = 0 },
    }, [_]u64{ 1, 1, 2, 2 }, 0..) |paint, setups, index| {
        try f.owner.sceneSetPaint(peer, paint);
        f.state.test_paint_setups = 0;
        try f.owner.scenePaint(f.id, frame_options.background, true, 0);
        const next = f.cli.getNextBuffer();
        const red = ansi.red(next.get(0, 0).?.bg);
        try testing.expect(red > 0 and red < 200);
        try testing.expectEqual(black, next.get(3, 0).?.bg);
        try testing.expectEqual(@as(u32, 0), f.cli.nextHitGrid[3]);
        try testing.expectEqual((try f.owner.getRenderable(child)).scene_node.?.token, f.cli.nextHitGrid[2]);
        try testing.expectEqual((try f.owner.getRenderable(parent)).scene_node.?.token, f.cli.nextHitGrid[8]);
        try testing.expectEqual((try f.owner.getRenderable(peer)).scene_node.?.token, f.cli.nextHitGrid[4]);
        switch (index) {
            0, 1 => try testing.expectEqual(black, next.get(4, 0).?.bg),
            2 => try testing.expectEqual(ansi.rgbColor(0, 200, 0, 255), next.get(4, 0).?.bg),
            3 => try testing.expect(next.get(4, 0).?.char != ' '),
            else => unreachable,
        }
        try testing.expectEqual(@as(usize, 0), next.scissor_stack.items.len);
        try testing.expectEqual(@as(usize, 0), next.opacity_stack.items.len);
        try testing.expectEqual(setups, f.state.test_paint_setups);
    }
}

test "Scene geometry cache retries a failed third solve in one frame with clean Yoga" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const box = try f.owner.sceneCreateNode(f.id, 1, 2);
    try dimensions(f.owner, box, 3, 1);
    try f.owner.sceneMoveNode(box, f.root, 0);
    try f.owner.sceneSetHooks(f.root, 4, 1, 0, 0);
    const node = &(try f.owner.getRenderable(box)).scene_node.?;
    var request = try f.step(null, frame_options, 3, null);
    try testing.expectEqual(@as(u32, 1), node.prepared_round);
    const frame_id = request.frame_id;
    const epoch = request.layout_epoch;
    try dimensions(f.owner, box, 4, 1);
    request = try f.step(request, frame_options, 3, null);
    try testing.expectEqual(frame_id, request.frame_id);
    try testing.expectEqual(epoch + 1, request.layout_epoch);
    try testing.expectEqual(@as(u32, 2), node.prepared_round);
    try testing.expectEqual(@as(u64, 4), f.state.test_geometry_reads);
    try testing.expectEqual(@as(f32, 3), (try f.owner.sceneGetLayout(box, false)).width);

    try dimensions(f.owner, box, 5, 1);
    // This accepted transform fails preparation only after the third Yoga solve.
    try f.owner.sceneSetPaint(box, .{ .translateX = 2147483648 });
    try testing.expectError(error.InvalidDimensions, f.owner.sceneFrameStep(f.id, request, frame_options));
    try testing.expect(f.state.attempt == null and f.state.work.items.len == 0 and f.state.feedback.items.len == 0);
    try testing.expectEqual(epoch + 2, f.state.layout_epoch);
    try testing.expectEqual(frame_id, node.prepared_frame);
    try testing.expectEqual(@as(u32, 2), node.prepared_round);
    try testing.expectEqual(@as(u64, 6), f.state.test_geometry_reads);
    var dirty: u32 = 1;
    try yoga.check(yoga.yogaNodeIsDirtyChecked((try f.owner.getRenderable(f.root)).yoga_node, &dirty));
    try testing.expectEqual(@as(u32, 0), dirty);
    try testing.expectEqual(@as(f32, 4), (try f.owner.sceneGetLayout(box, false)).width);

    try f.owner.sceneSetPaint(box, .{ .background = .{ 200, 0, 0, 255 } });
    request = try f.step(null, frame_options, 3, null);
    try testing.expectEqual(frame_id + 1, request.frame_id);
    try testing.expectEqual(epoch + 2, request.layout_epoch);
    try testing.expectEqual(@as(u64, 8), f.state.test_geometry_reads);
    try testing.expectEqual(@as(f32, 4), (try f.owner.sceneGetLayout(box, false)).width);
    try testing.expectEqual(@as(u32, 0), (try f.owner.sceneFrameStep(f.id, request, frame_options)).kind);
    try testing.expectEqual(@as(f32, 5), (try f.owner.sceneGetLayout(box, false)).width);
    try testing.expectEqual(ansi.rgbColor(200, 0, 0, 255), f.cli.getNextBuffer().get(4, 0).?.bg);
    try testing.expectEqual(node.token, f.cli.nextHitGrid[4]);
    try testing.expectEqual(@as(u32, 0), f.cli.nextHitGrid[5]);
    try f.owner.sceneFrameCancel(f.id, request.frame_id);
    try testing.expectEqual(@as(u32, 0), (try f.owner.sceneFrameStep(f.id, null, frame_options)).kind);
    try testing.expectEqual(@as(u64, 8), f.state.test_geometry_reads);
}

test "Scene geometry cache preserves stamp limits and rootless frames" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    try f.owner.sceneSetHooks(f.root, 4, 1, 0, 0);
    f.state.last_frame_id = std.math.maxInt(u64) - 3;
    f.state.layout_epoch = std.math.maxInt(u64) - 1;
    var options = frame_options;
    options.max_layout_rounds = std.math.maxInt(u32);
    const request = try f.step(null, options, 3, null);
    try testing.expectEqual(std.math.maxInt(u64), request.layout_epoch);
    const node = &(try f.owner.getRenderable(f.root)).scene_node.?;
    try testing.expectEqual(request.frame_id, node.prepared_frame);
    try testing.expectEqual(@as(u32, 1), node.prepared_round);

    f.state.attempt.?.rounds = std.math.maxInt(u32);
    try dimensions(f.owner, f.root, 7, 4);
    try testing.expectError(error.LayoutLimit, f.owner.sceneFrameStep(f.id, request, options));
    try testing.expectEqual(request.frame_id, node.prepared_frame);
    try testing.expectEqual(@as(u32, 1), node.prepared_round);
    try testing.expectEqual(@as(u64, 1), f.state.test_geometry_reads);
    try testing.expectError(error.RequestLimit, f.owner.sceneFrameStep(f.id, null, options));
    try testing.expectEqual(request.frame_id, node.prepared_frame);
    try testing.expectEqual(@as(u64, 1), f.state.test_geometry_reads);

    try f.owner.sceneDestroyNode(f.root);
    const empty = try f.step(null, options, 0, null);
    try testing.expectEqual(std.math.maxInt(u64), empty.frame_id);
    try testing.expectEqual(request.layout_epoch, empty.layout_epoch);
    try testing.expectEqual(@as(u64, 1), f.state.test_geometry_reads);
    try f.owner.sceneFrameCancel(f.id, empty.frame_id);
    try testing.expectError(error.RequestLimit, f.owner.sceneFrameStep(f.id, null, options));
    try testing.expect(f.state.attempt == null and f.state.work.items.len == 0 and f.state.feedback.items.len == 0);
}

test "Scene geometry cache reuses completed locals across unchanged color and translation frames" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const parent = try f.owner.sceneCreateNode(f.id, 1, 2);
    const child = try f.owner.sceneCreateNode(f.id, 1, 3);
    try dimensions(f.owner, parent, 8, 3);
    try f.owner.sceneSetStyle(parent, 4, 0, 0, 2, 100, 0);
    try dimensions(f.owner, child, 4, 1);
    try f.owner.sceneSetStyle(child, 4, 0, 0, 2, 50, 0);
    try f.owner.sceneMoveNode(parent, f.root, 0);
    try f.owner.sceneMoveNode(child, parent, 0);
    const token = (try f.owner.getRenderable(child)).scene_node.?.token;
    const red: ansi.RGBA = .{ 200, 0, 0, 255 };
    const green: ansi.RGBA = .{ 0, 200, 0, 255 };
    try f.owner.sceneSetPaint(child, .{ .background = red });
    try f.owner.scenePaint(f.id, frame_options.background, true, 0);
    try testing.expectEqual(@as(u64, 3), f.state.test_geometry_reads);
    try testing.expectEqual(ansi.rgbColor(200, 0, 0, 255), f.cli.getNextBuffer().get(0, 0).?.bg);
    try testing.expectEqual(token, f.cli.nextHitGrid[3]);
    const epoch = f.state.layout_epoch;

    f.state.test_geometry_reads = 0;
    f.state.test_style_reads = 0;
    try f.owner.scenePaint(f.id, frame_options.background, true, 0);
    try testing.expectEqual(@as(u64, 0), f.state.test_geometry_reads);
    try testing.expectEqual(@as(u64, 0), f.state.test_style_reads);
    try f.owner.sceneSetPaint(child, .{ .background = green });
    try f.owner.scenePaint(f.id, frame_options.background, true, 0);
    try testing.expectEqual(@as(u64, 0), f.state.test_geometry_reads);
    try testing.expectEqual(@as(u64, 0), f.state.test_style_reads);
    try testing.expectEqual(ansi.rgbColor(0, 200, 0, 255), f.cli.getNextBuffer().get(0, 0).?.bg);

    try f.owner.sceneSetPaint(parent, .{ .translateX = 1.0000000001, .translateY = 1 });
    try f.owner.sceneSetPaint(child, .{ .background = green, .translateX = 0.9999999998 });
    try testing.expectEqual(@as(usize, 0), f.state.work.items.len);
    f.state.test_prepare_steps = 0;
    try f.owner.scenePaint(f.id, frame_options.background, true, 0);
    try testing.expectEqual(@as(u64, 3), f.state.test_prepare_steps);
    try testing.expectEqual(@as(u64, 0), f.state.test_geometry_reads);
    try testing.expectEqual(@as(u64, 0), f.state.test_style_reads);
    try testing.expectEqual(epoch, f.state.layout_epoch);
    try testing.expectEqual(@as(f64, 1.0000000001) + 0.9999999998, (try f.owner.sceneGetLayout(child, false)).screenX);
    try testing.expectEqual(ansi.rgbColor(0, 200, 0, 255), f.cli.getNextBuffer().get(1, 1).?.bg);
    try testing.expectEqual(token, f.cli.nextHitGrid[8 + 1]);
    try testing.expectEqual(@as(u32, 0), f.cli.nextHitGrid[0]);

    try f.owner.resizeSessionRenderer(f.id, 12, 4);
    try f.owner.scenePaint(f.id, frame_options.background, true, 0);
    try testing.expectEqual(@as(u64, 3), f.state.test_geometry_reads);
    try testing.expectEqual(epoch + 1, f.state.layout_epoch);
    try testing.expectEqual(@as(f32, 6), (try f.owner.sceneGetLayout(child, false)).width);
    try testing.expectEqual(token, f.cli.nextHitGrid[12 + 6]);
    try testing.expectEqual(ansi.rgbColor(0, 200, 0, 255), f.cli.getNextBuffer().get(6, 1).?.bg);

    try dimensions(f.owner, child, 2, 1);
    try f.owner.scenePaint(f.id, frame_options.background, true, 0);
    try testing.expectEqual(@as(u64, 6), f.state.test_geometry_reads);
    try testing.expectEqual(@as(f32, 2), (try f.owner.sceneGetLayout(child, false)).width);
    try testing.expectEqual(token, f.cli.nextHitGrid[12 + 2]);
    try testing.expectEqual((try f.owner.getRenderable(parent)).scene_node.?.token, f.cli.nextHitGrid[12 + 3]);
    try testing.expectEqual(ansi.rgbColor(0, 0, 0, 255), f.cli.getNextBuffer().get(3, 1).?.bg);
    try f.owner.scenePaint(f.id, frame_options.background, true, 0);
    try testing.expectEqual(@as(u64, 6), f.state.test_geometry_reads);
    f.state.cancelFrame();
    try testing.expect(f.state.work.items.len == 0);
}

test "Scene retained preparation refreshes display and overflow after measured and hidden layout changes" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const parent = try f.owner.sceneCreateNode(f.id, 1, 2);
    const child = try f.owner.sceneCreateNode(f.id, 1, 3);
    try dimensions(f.owner, parent, 2, 2);
    try dimensions(f.owner, child, 4, 1);
    try f.owner.sceneMoveNode(parent, f.root, 0);
    try f.owner.sceneMoveNode(child, parent, 0);
    const red = ansi.rgbColor(200, 0, 0, 255);
    const black = ansi.rgbColor(0, 0, 0, 255);
    try f.owner.sceneSetPaint(child, .{ .background = red });
    const token = (try f.owner.getRenderable(child)).scene_node.?.token;
    try f.owner.scenePaint(f.id, frame_options.background, true, 0);
    try testing.expectEqual(red, f.cli.getNextBuffer().get(3, 0).?.bg);
    try testing.expectEqual(token, f.cli.nextHitGrid[3]);

    // Bypass the Context setter's work clear to exercise the solve stamp independently.
    try yoga.check(yoga.yogaNodeStyleSetEnumChecked((try f.owner.getRenderable(parent)).yoga_node, 8, 1));
    try f.state.measureLayout(&f.owner.objects, f.cli, f.root);
    f.state.test_prepare_steps = 0;
    try f.owner.scenePaint(f.id, frame_options.background, true, 0);
    try testing.expectEqual(@as(u64, 3), f.state.test_prepare_steps);
    try testing.expectEqual(red, f.cli.getNextBuffer().get(1, 0).?.bg);
    try testing.expectEqual(black, f.cli.getNextBuffer().get(2, 0).?.bg);
    try testing.expectEqual(token, f.cli.nextHitGrid[1]);
    try testing.expectEqual(@as(u32, 0), f.cli.nextHitGrid[2]);

    try f.owner.sceneSetStyle(parent, 0, 9, 0, 0, 1, 0);
    try f.owner.scenePaint(f.id, frame_options.background, true, 0);
    try testing.expectEqual(black, f.cli.getNextBuffer().get(0, 0).?.bg);
    for (f.cli.nextHitGrid) |hit| try testing.expectEqual(@as(u32, 0), hit);
    try dimensions(f.owner, child, 5, 1);
    try f.owner.sceneSetStyle(parent, 0, 8, 0, 0, 0, 0);
    try f.state.measureLayout(&f.owner.objects, f.cli, f.root);
    try f.owner.scenePaint(f.id, frame_options.background, true, 0);
    try testing.expectEqual(@as(f32, 4), (try f.owner.sceneGetLayout(child, false)).width);
    try f.owner.sceneSetStyle(parent, 0, 9, 0, 0, 0, 0);
    try f.owner.scenePaint(f.id, frame_options.background, true, 0);
    try testing.expectEqual(@as(f32, 5), (try f.owner.sceneGetLayout(child, false)).width);
    try testing.expectEqual(red, f.cli.getNextBuffer().get(4, 0).?.bg);
    try testing.expectEqual(token, f.cli.nextHitGrid[4]);
    f.state.test_style_reads = 0;
    try f.owner.scenePaint(f.id, frame_options.background, true, 0);
    try testing.expectEqual(@as(u64, 0), f.state.test_style_reads);
}

test "Scene paint-only hooks skip hidden roots until reveal" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const child = try f.owner.sceneCreateNode(f.id, 1, 2);
    try dimensions(f.owner, child, 2, 1);
    try f.owner.sceneMoveNode(child, f.root, 0);
    try f.owner.sceneSetHooks(child, 24, 1, 2, 1);
    try f.owner.sceneSetStyle(f.root, 0, 9, 0, 0, 1, 0);
    const hidden = try f.step(null, frame_options, 0, null);
    try testing.expectEqualDeep(scene.Layout{}, try f.owner.sceneGetLayout(child, false));
    for (f.cli.nextHitGrid) |hit| try testing.expectEqual(@as(u32, 0), hit);
    try f.owner.sceneFrameCancel(f.id, hidden.frame_id);
    try f.owner.sceneSetStyle(f.root, 0, 9, 0, 0, 0, 0);
    const before = try f.step(null, frame_options, 4, child);
    const after = try f.step(before, frame_options, 5, child);
    _ = try f.step(after, frame_options, 0, null);
    try testing.expectEqual(@as(f32, 2), (try f.owner.sceneGetLayout(child, false)).width);
    try testing.expectEqual((try f.owner.getRenderable(child)).scene_node.?.token, f.cli.nextHitGrid[1]);
}

test "Scene paint-only hooks preserve completed tie order after failed preparation" {
    const f = try Fixture.init(testing.allocator, 2, 1, .{});
    defer f.deinit();
    const colors = [_]ansi.RGBA{ .{ 200, 0, 0, 255 }, .{ 0, 200, 0, 255 } };
    var children: [2]context.Handle = undefined;
    for (&children, 0..) |*child, index| {
        child.* = try f.owner.sceneCreateNode(f.id, 1, @intCast(index + 2));
        try dimensions(f.owner, child.*, 1, 1);
        try f.owner.sceneSetStyle(child.*, 0, 6, 0, 0, 2, 0);
        try f.owner.sceneSetPaint(child.*, .{ .background = colors[index] });
        try f.owner.sceneSetHooks(child.*, 24, 1, 1, 1);
        try f.owner.sceneMoveNode(child.*, f.root, @intCast(index));
    }
    for (0..2) |attempt| {
        if (attempt == 1) {
            try f.owner.sceneSetPaint(children[0], .{ .zIndex = 1, .background = colors[0] });
            try f.owner.sceneSetPaint(children[1], .{ .translateX = 2147483648, .background = colors[1] });
            try testing.expectError(error.InvalidDimensions, f.owner.sceneFrameStep(f.id, null, frame_options));
            try testing.expect(f.state.attempt == null and f.state.work.items.len == 0 and f.state.feedback.items.len == 0);
            try testing.expectEqual(ansi.rgbColor(0, 200, 0, 255), f.cli.getCurrentBuffer().get(0, 0).?.bg);
            try testing.expectEqual(@as(u32, 3), try f.owner.sceneHitTest(f.id, 0, 0));
            for (children, colors) |child, background| try f.owner.sceneSetPaint(child, .{ .background = background });
        }
        var request: ?scene.FrameRequest = null;
        for (children) |child| {
            for ([_]u32{ 4, 5 }) |kind| {
                request = try f.owner.sceneFrameStep(f.id, request, frame_options);
                try testing.expectEqual(child, request.?.node);
                try testing.expectEqual(kind, request.?.kind);
            }
        }
        const done = try f.step(request, frame_options, 0, null);
        try testing.expectEqual(ansi.rgbColor(0, 200, 0, 255), f.cli.getNextBuffer().get(0, 0).?.bg);
        try testing.expectEqual((try f.owner.getRenderable(children[1])).scene_node.?.token, f.cli.nextHitGrid[0]);
        try testing.expectEqual(@as(u32, 0), f.cli.nextHitGrid[1]);
        _ = try f.owner.sceneFrameCommit(f.id, done, true);
        try drain(f.owner, f.id);
    }
    try testing.expectEqual(@as(usize, 0), f.state.feedback.capacity);
    try testing.expectEqual(@as(u64, 0), f.state.test_visibility_steps);
}

test "Scene viewport append refreshes 10000 plain Text children without queued filtered refresh" {
    const count = 10000;
    const f = try Fixture.init(testing.allocator, 4, 4, .{ .limits = .{ .object_capacity = count + 3 } });
    defer f.deinit();
    const content = try f.owner.sceneCreateNode(f.id, 1, 2);
    try dimensions(f.owner, content, 4, count);
    try f.owner.sceneSetPaint(content, .{ .translateY = -(count - 4) });
    try f.owner.sceneMoveNode(content, f.root, 0);
    try f.owner.sceneSetViewport(content, f.root);
    var children: [count]context.Handle = undefined;
    for (&children, 0..) |*child, index| {
        if (index == count - 1) {
            try f.owner.scenePaint(f.id, frame_options.background, true, 0);
            f.state.test_filtered_refresh_steps = 0;
        }
        child.* = try f.owner.sceneCreateNode(f.id, 2, @intCast(index + 3));
        try dimensions(f.owner, child.*, 4, 1);
        try f.owner.sceneSetStyle(child.*, 0, 6, 0, 0, 2, 0);
        try f.owner.sceneSetPositions(child.*, 3, .{ 1, 1, 0, 0 }, .{ 0, @floatFromInt(index), 0, 0 });
        try f.owner.sceneSetText(child.*, "log!");
        try f.owner.sceneMoveNode(child.*, content, @intCast(index));
    }
    try f.owner.scenePaint(f.id, frame_options.background, true, 0);
    for (children, 0..) |child, index| {
        const node = &(try f.owner.getRenderable(child)).scene_node.?;
        const layout = try f.owner.sceneGetLayout(child, false);
        try testing.expectEqual(@as(f32, 4), layout.width);
        try testing.expectEqual(@as(f32, 1), layout.height);
        try testing.expectEqual(@as(f32, @floatFromInt(index)), layout.top);
        try testing.expectEqual(@as(f64, @floatFromInt(index)) - (count - 4), layout.screenY);
        try testing.expectEqual(f.state.last_frame_id, node.observed_frame);
        try testing.expectEqual(@as(u32, 4), node.text.?.view.getViewport().?.width);
        try testing.expectEqual(@as(u32, 1), node.text.?.view.getViewport().?.height);
    }
    for (children[count - 4 ..], 0..) |child, row| {
        for ("log!", 0..) |char, column| {
            try testing.expectEqual(@as(u32, char), f.cli.getNextBuffer().get(@intCast(column), @intCast(row)).?.char);
            try testing.expectEqual((try f.owner.getRenderable(child)).scene_node.?.token, f.cli.nextHitGrid[row * 4 + column]);
        }
    }
    try testing.expectEqual(@as(u64, 0), f.state.test_filtered_refresh_steps);
}

test "Scene viewport cutoff refreshes every direct child before selected updates including mounted hidden children" {
    for ([_]usize{ 15, 16 }) |count| {
        const f = try Fixture.init(testing.allocator, 8, 4, .{});
        defer f.deinit();
        const content = try f.owner.sceneCreateNode(f.id, 1, 2);
        try dimensions(f.owner, content, 8, 32);
        try f.owner.sceneMoveNode(content, f.root, 0);
        var children: [16]context.Handle = undefined;
        try filterChildren(f.owner, f.id, content, children[0..count]);
        const descendant = try f.owner.sceneCreateNode(f.id, 1, 3);
        try dimensions(f.owner, descendant, 2, 1);
        try f.owner.sceneMoveNode(descendant, children[5], 0);
        const hidden_descendant = try f.owner.sceneCreateNode(f.id, 1, 4);
        try dimensions(f.owner, hidden_descendant, 2, 1);
        try f.owner.sceneMoveNode(hidden_descendant, children[14], 0);
        try f.owner.scenePaint(f.id, frame_options.background, true, 0);
        try f.owner.sceneSetViewport(content, f.root);
        try f.owner.sceneSetHooks(content, 1, 1, 8, 32);
        for (children[0..count], 0..) |child, index| {
            try f.owner.sceneSetPaint(child, .{ .zIndex = -@as(i32, @intCast(index)) });
            try f.owner.sceneSetHooks(child, 3, 1, 2, 2);
            try dimensions(f.owner, child, 3, 2);
        }
        try f.owner.sceneSetStyle(children[14], 0, 9, 0, 0, 1, 0);
        try dimensions(f.owner, descendant, 4, 1);
        try f.owner.sceneSetHooks(descendant, 3, 1, 2, 1);
        try dimensions(f.owner, hidden_descendant, 4, 1);
        try f.owner.sceneSetHooks(hidden_descendant, 3, 1, 2, 1);
        var request = try f.step(null, frame_options, 1, content);
        var index = count;
        while (index != 0) {
            index -= 1;
            if (index == 14) continue;
            request = try f.step(request, frame_options, 2, children[index]);
        }
        var updates: u32 = 0;
        var descendant_updates: u32 = 0;
        var descendant_resizes: u32 = 0;
        while (true) {
            request = try f.owner.sceneFrameStep(f.id, request, frame_options);
            if (request.kind == 0) break;
            try testing.expect(updates < 16);
            for (children[0..count], 0..) |child, child_index| {
                try testing.expectEqual(@as(f32, if (child_index == 14) 1 else 3), (try f.owner.sceneGetLayout(child, false)).width);
            }
            if (std.meta.eql(request.node, descendant)) {
                if (request.kind == 1) descendant_updates += 1 else descendant_resizes += 1;
            } else {
                try testing.expectEqual(@as(u32, 1), request.kind);
                const expected_index = (if (count == 15) @as(u32, 13) else 1) - updates;
                try testing.expectEqual(children[expected_index], request.node);
                updates += 1;
            }
        }
        try testing.expectEqual(@as(u32, if (count == 15) 14 else 2), updates);
        try testing.expectEqual(@as(u32, if (count == 15) 1 else 0), descendant_updates);
        try testing.expectEqual(descendant_updates, descendant_resizes);
        try testing.expectEqual(@as(f32, if (count == 15) 4 else 2), (try f.owner.sceneGetLayout(descendant, false)).width);
        try testing.expectEqual(@as(f32, 4), (try f.owner.sceneGetLayout(descendant, true)).width);
        try testing.expectEqual(@as(f32, 2), (try f.owner.sceneGetLayout(hidden_descendant, false)).width);
    }
}

test "Scene viewport without host hooks preserves culled descendant geometry and text viewport until reveal" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const content = try f.owner.sceneCreateNode(f.id, 1, 2);
    try dimensions(f.owner, content, 8, 32);
    try f.owner.sceneMoveNode(content, f.root, 0);
    var children: [16]context.Handle = undefined;
    try filterChildren(f.owner, f.id, content, &children);
    const text = try f.owner.sceneCreateNode(f.id, 2, 3);
    try dimensions(f.owner, text, 4, 2);
    try f.owner.sceneSetTextOptions(text, .{ .wrap_mode = .char });
    try f.owner.sceneSetText(text, "abcdefgh");
    try f.owner.sceneMoveNode(text, children[6], 0);
    try f.owner.scenePaint(f.id, frame_options.background, true, 0);
    const view = (try f.owner.getRenderable(text)).scene_node.?.text.?.view;
    try testing.expectEqual(@as(u32, 4), view.getViewport().?.width);
    try testing.expectEqual(@as(u32, 2), (try f.owner.sceneGetTextInfo(text)).virtual_line_count);
    try f.owner.sceneSetViewport(content, f.root);
    try dimensions(f.owner, text, 2, 4);
    try f.owner.scenePaint(f.id, frame_options.background, true, 0);
    try testing.expectEqual(@as(f32, 2), (try f.owner.sceneGetLayout(text, true)).width);
    try testing.expectEqual(@as(f32, 4), (try f.owner.sceneGetLayout(text, false)).width);
    try testing.expectEqual(@as(u32, 4), view.getViewport().?.width);
    try testing.expectEqual(@as(u32, 2), (try f.owner.sceneGetTextInfo(text)).virtual_line_count);
    var lines: [4]scene.TextLine = undefined;
    try testing.expectEqual(@as(u32, 2), try f.owner.sceneGetTextLines(text, &lines));
    try testing.expectEqual(@as(u32, 4), lines[0].width_cols);
    f.state.test_geometry_reads = 0;
    try f.owner.scenePaint(f.id, frame_options.background, true, 0);
    try testing.expectEqual(@as(u64, 0), f.state.test_geometry_reads);
    try testing.expectEqual(@as(f32, 4), (try f.owner.sceneGetLayout(text, false)).width);
    try f.owner.sceneSetPaint(content, .{ .translateY = -12 });
    try f.owner.scenePaint(f.id, frame_options.background, true, 0);
    try testing.expectEqual(@as(u64, 0), f.state.test_geometry_reads);
    try testing.expectEqual(@as(f32, 2), (try f.owner.sceneGetLayout(text, false)).width);
    try testing.expectEqual(@as(u32, 2), view.getViewport().?.width);
    try testing.expectEqual(@as(u32, 4), (try f.owner.sceneGetTextInfo(text)).virtual_line_count);
    try testing.expectEqual(@as(u32, 'a'), (try f.owner.getSessionRenderer(f.id)).getNextBuffer().get(0, 0).?.char);
    try f.owner.sceneSetViewport(content, null);
    try testing.expectEqual(@as(u32, 0), (try f.owner.getSession(f.id)).scene.?.filter_count);
}

test "Scene viewport refresh rechecks ancestor visibility after a host reply" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const parent = try f.owner.sceneCreateNode(f.id, 1, 2);
    const content = try f.owner.sceneCreateNode(f.id, 1, 3);
    try dimensions(f.owner, parent, 8, 4);
    try dimensions(f.owner, content, 8, 32);
    try f.owner.sceneMoveNode(parent, f.root, 0);
    try f.owner.sceneMoveNode(content, parent, 0);
    var children: [16]context.Handle = undefined;
    try filterChildren(f.owner, f.id, content, &children);
    try f.owner.scenePaint(f.id, frame_options.background, true, 0);
    try f.owner.sceneSetViewport(content, f.root);
    for (children[0..2]) |child| {
        try dimensions(f.owner, child, 3, 2);
        try f.owner.sceneSetHooks(child, 2, 1, 2, 2);
    }
    var request = try f.step(null, frame_options, 2, children[0]);
    try f.owner.sceneSetStyle(parent, 0, 9, 0, 0, 1, 0);
    try testing.expectEqual(@as(u32, 0), (try f.owner.sceneFrameStep(f.id, request, frame_options)).kind);
    try testing.expectEqual(@as(f32, 2), (try f.owner.sceneGetLayout(children[1], false)).width);
    for ((try f.owner.getSessionRenderer(f.id)).nextHitGrid) |hit| try testing.expectEqual(@as(u32, 0), hit);
    try f.owner.sceneFrameCancel(f.id, request.frame_id);
    try f.owner.sceneSetStyle(parent, 0, 9, 0, 0, 0, 0);
    request = try f.step(null, frame_options, 2, children[1]);
    try testing.expectEqual(@as(f32, 3), (try f.owner.sceneGetLayout(children[1], false)).width);
    try testing.expectEqual(@as(u32, 0), (try f.owner.sceneFrameStep(f.id, request, frame_options)).kind);
}

test "Scene stale viewport bindings cancel frames without publishing and can be replaced" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const content = try f.owner.sceneCreateNode(f.id, 1, 2);
    const viewport = try f.owner.sceneCreateNode(f.id, 1, 3);
    try dimensions(f.owner, content, 2, 2);
    try dimensions(f.owner, viewport, 8, 4);
    try f.owner.sceneMoveNode(content, f.root, 0);
    try f.owner.sceneMoveNode(viewport, f.root, 1);
    try f.owner.sceneSetViewport(content, viewport);
    try f.owner.scenePaint(f.id, frame_options.background, true, 0);
    _ = try f.owner.renderSession(f.id, true);
    try drain(f.owner, f.id);
    const stats = try f.owner.sceneGetStats(f.id);
    const hit = try f.owner.sceneHitTest(f.id, 0, 0);
    const written = (try f.owner.getSession(f.id)).getStats().bytes_written;
    try f.owner.sceneSetHooks(content, 1, 1, 2, 2);
    const request = try f.step(null, frame_options, 1, content);
    try f.owner.sceneDestroyNode(viewport);
    const replacement = try f.owner.sceneCreateNode(f.id, 1, 4);
    try testing.expectEqual(viewport.slot, replacement.slot);
    try testing.expect(viewport.generation != replacement.generation);
    try testing.expectError(error.StaleHandle, f.owner.sceneSetViewport(content, viewport));
    try testing.expectError(error.StaleHandle, f.owner.sceneFrameStep(f.id, request, frame_options));
    try testing.expectError(error.StaleHandle, f.owner.sceneFrameStep(f.id, null, frame_options));
    try testing.expect(f.state.attempt == null and f.state.work.items.len == 0);
    try testing.expectEqual(stats.frameCount, (try f.owner.sceneGetStats(f.id)).frameCount);
    try testing.expectEqual(hit, try f.owner.sceneHitTest(f.id, 0, 0));
    try testing.expectEqual(written, (try f.owner.getSession(f.id)).getStats().bytes_written);
    try f.owner.sceneSetHooks(content, 0, 2, 2, 2);
    try f.owner.sceneSetViewport(content, f.root);
    try f.owner.scenePaint(f.id, frame_options.background, true, 0);
    try f.owner.sceneSetViewport(content, null);
    try f.owner.sceneDestroyNode(content);
    try testing.expectEqual(@as(u32, 0), f.state.filter_count);
}

test "Scene viewport uses both flex axes strict primary overlap cross touching and full border bounds" {
    for (0..4) |direction| {
        const f = try Fixture.init(testing.allocator, 12, 12, .{});
        defer f.deinit();
        const viewport = try f.owner.sceneCreateNode(f.id, 1, 2);
        const content = try f.owner.sceneCreateNode(f.id, 1, 3);
        try dimensions(f.owner, viewport, 6, 6);
        try f.owner.sceneSetPaint(viewport, .{ .borderSides = 15, .translateX = 2, .translateY = 2 });
        try f.owner.sceneSetStyle(viewport, 0, 8, 0, 0, 1, 0);
        try f.owner.sceneMoveNode(viewport, f.root, 0);
        try dimensions(f.owner, content, 40, 40);
        try f.owner.sceneSetPaint(content, .{ .translateX = -1, .translateY = -1 });
        try f.owner.sceneSetStyle(content, 0, 1, 0, 0, @floatFromInt(direction), 0);
        try f.owner.sceneMoveNode(content, viewport, 0);
        try f.owner.sceneSetViewport(content, viewport);
        var children: [16]context.Handle = undefined;
        try filterChildren(f.owner, f.id, content, &children);
        // Rectangles are primary start/size, cross start/size. The cutoff includes child 15.
        const rects = [_][4]f32{
            .{ -2, 2, 1, 1 }, .{ 0, 1, 0, 1 }, .{ 5, 1, 1, 1 },  .{ 6, 1, 1, 1 },
            .{ 2, 1, -2, 2 }, .{ 3, 1, 6, 1 }, .{ 2, 1, -3, 2 }, .{ 3, 1, 7, 1 },
        };
        const row = direction >= 2;
        for (children, 0..) |child, index| {
            const rect = if (index < rects.len) rects[index] else [4]f32{ @floatFromInt(30 + index), 1, 0, 1 };
            try dimensions(f.owner, child, if (row) rect[1] else rect[3], if (row) rect[3] else rect[1]);
            try f.owner.sceneSetPositions(child, 3, .{ 1, 1, 0, 0 }, .{ if (row) rect[0] else rect[2], if (row) rect[2] else rect[0], 0, 0 });
            try f.owner.sceneSetHooks(child, 1, 1, 0, 0);
            try f.owner.sceneSetPaint(child, .{ .background = .{ 200, 0, 0, 255 } });
        }
        try f.owner.sceneSetStyle(children[15], 0, 9, 0, 0, 1, 0);
        var request: ?scene.FrameRequest = null;
        for ([_]usize{ 1, 2, 4, 5 }) |index| {
            request = try f.step(request, frame_options, 1, children[index]);
        }
        try testing.expectEqual(@as(u32, 0), (try f.owner.sceneFrameStep(f.id, request, frame_options)).kind);
        try testing.expectEqual(@as(u32, 0x250c), f.cli.getNextBuffer().get(2, 2).?.char);
        try testing.expectEqual((try f.owner.getRenderable(viewport)).scene_node.?.token, f.cli.nextHitGrid[2 * 12 + 2]);
    }
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

test "Scene viewport selects after resize callbacks using current transforms parentage and completed local geometry" {
    for ([_]bool{ false, true }) |reparent| {
        const f = try Fixture.init(testing.allocator, 8, 4, .{});
        defer f.deinit();
        const content = try f.owner.sceneCreateNode(f.id, 1, 2);
        const source = try f.owner.sceneCreateNode(f.id, 1, 3);
        const destination = try f.owner.sceneCreateNode(f.id, 1, 4);
        for ([_]context.Handle{ source, destination }, 0..) |parent, index| {
            try dimensions(f.owner, parent, 8, 32);
            try f.owner.sceneSetStyle(parent, 0, 6, 0, 0, 2, 0);
            try f.owner.sceneMoveNode(parent, f.root, @intCast(index));
        }
        try f.owner.sceneSetPaint(source, .{ .translateY = if (reparent) 20 else 0 });
        try dimensions(f.owner, content, 8, 32);
        try f.owner.sceneMoveNode(content, source, 0);
        var children: [16]context.Handle = undefined;
        try filterChildren(f.owner, f.id, content, &children);
        try f.owner.scenePaint(f.id, frame_options.background, true, 0);
        try f.owner.sceneSetViewport(content, f.root);
        for (children) |child| try f.owner.sceneSetHooks(child, 3, 1, 2, 2);
        try dimensions(f.owner, children[10], 3, 2);
        var options = frame_options;
        if (!reparent) options.max_layout_rounds = 1;
        var request = try f.step(null, options, 2, children[10]);
        if (reparent) try f.owner.sceneMoveNode(content, destination, 0) else try f.owner.sceneSetPaint(content, .{ .translateY = -20 });
        for (if (reparent) children[0..2] else children[10..12]) |child| {
            request = try f.step(request, options, 1, child);
        }
        try testing.expectEqual(@as(u32, 0), (try f.owner.sceneFrameStep(f.id, request, options)).kind);
    }
}

test "Scene viewport never reculls queued updates and final paint sorts newly entered parents" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const content = try f.owner.sceneCreateNode(f.id, 1, 2);
    try dimensions(f.owner, content, 8, 32);
    try f.owner.sceneMoveNode(content, f.root, 0);
    var children: [16]context.Handle = undefined;
    try filterChildren(f.owner, f.id, content, &children);
    var nested: [2]context.Handle = undefined;
    for (&nested, 0..) |*child, index| {
        child.* = try f.owner.sceneCreateNode(f.id, 1, @intCast(index + 3));
        try dimensions(f.owner, child.*, 1, 1);
        try f.owner.sceneSetStyle(child.*, 0, 6, 0, 0, 2, 0);
        try f.owner.sceneSetPaint(child.*, .{ .zIndex = if (index == 0) 1 else 0, .background = if (index == 0) .{ 200, 0, 0, 255 } else .{ 0, 200, 0, 255 } });
        try f.owner.sceneMoveNode(child.*, children[10], @intCast(index));
    }
    try f.owner.scenePaint(f.id, frame_options.background, true, 0);
    try f.owner.sceneSetViewport(content, f.root);
    for (children) |child| try f.owner.sceneSetHooks(child, 1, 1, 2, 2);
    var request = try f.owner.sceneFrameStep(f.id, null, frame_options);
    try testing.expectEqual(children[0], request.node);
    try f.owner.sceneSetPaint(content, .{ .translateY = -20 });
    try f.owner.sceneSetPaint(nested[0], .{ .zIndex = -1, .background = .{ 200, 0, 0, 255 } });
    request = try f.owner.sceneFrameStep(f.id, request, frame_options);
    try testing.expectEqual(children[1], request.node);
    for (children[10..12]) |child| {
        request = try f.step(request, frame_options, 1, child);
    }
    try testing.expectEqual(@as(u32, 0), (try f.owner.sceneFrameStep(f.id, request, frame_options)).kind);
    try testing.expectEqual(ansi.rgbColor(0, 200, 0, 255), (try f.owner.getSessionRenderer(f.id)).getNextBuffer().get(0, 0).?.bg);
}

test "Scene viewport late reveal settles Slider refresh and resize feedback before paint without replaying updates" {
    for ([_]bool{ false, true }) |resize_again| {
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
        try f.owner.scenePaint(f.id, frame_options.background, true, 0);
        try f.owner.sceneSetPaint(content, .{});
        try f.owner.scenePaint(f.id, frame_options.background, true, 0);
        try dimensions(f.owner, slider, 8, 1);
        for (children) |child| try f.owner.sceneSetHooks(child, 1, 1, 10, 2);
        try f.owner.sceneSetHooks(slider, 3, 1, 2, 1);
        f.state.test_geometry_reads = 0;
        var request = try f.step(null, frame_options, 1, children[0]);
        try testing.expectEqual(@as(f32, 2), (try f.owner.sceneGetLayout(slider, false)).width);
        try testing.expectEqual(@as(f32, 8), (try f.owner.sceneGetLayout(slider, true)).width);
        try f.owner.sceneSetPaint(content, .{ .translateY = -20 });
        for ([_]context.Handle{ children[1], children[10], slider }) |child| {
            request = try f.step(request, frame_options, 1, child);
            try testing.expect(f.state.feedback.items.len <= @as(usize, f.state.count) * 4);
        }
        try testing.expectEqual(@as(f32, 2), (try f.owner.sceneGetLayout(slider, false)).width);
        request = try f.step(request, frame_options, 2, slider);
        try testing.expectEqual(@as(u32, 8), request.width);
        try testing.expectEqual(@as(f32, 8), (try f.owner.sceneGetLayout(slider, false)).width);
        try testing.expectEqualDeep(scene.SliderThumb{ .size = 1, .start = 8 }, try f.owner.sceneGetSliderThumb(slider));
        if (resize_again) try dimensions(f.owner, slider, 6, 1);
        request = try f.step(request, frame_options, 1, children[11]);
        if (resize_again) {
            request = try f.step(request, frame_options, 2, slider);
            try testing.expectEqual(@as(u32, 6), request.width);
        }
        try testing.expectEqual(@as(u32, if (resize_again) 3 else 2), f.state.attempt.?.rounds);
        try testing.expectEqual(@as(u32, 0), (try f.owner.sceneFrameStep(f.id, request, frame_options)).kind);
        try testing.expectEqual(@as(u64, if (resize_again) 38 else 19), f.state.test_geometry_reads);
        const width: u32 = if (resize_again) 6 else 8;
        const layout = try f.owner.sceneGetLayout(slider, false);
        try testing.expectEqual(@as(f32, @floatFromInt(width)), layout.width);
        try testing.expectEqual(@as(f64, 0), layout.screenY);
        try testing.expectEqualDeep(scene.SliderThumb{ .size = 1, .start = @floatFromInt(width) }, try f.owner.sceneGetSliderThumb(slider));
        try testing.expectEqual(@as(u32, 0x258c), f.cli.getNextBuffer().get(width / 2, 0).?.char);
        try testing.expectEqual((try f.owner.getRenderable(slider)).scene_node.?.token, f.cli.nextHitGrid[width - 1]);
        try testing.expectEqual((try f.owner.getRenderable(children[10])).scene_node.?.token, f.cli.nextHitGrid[width]);
        try testing.expect(f.state.attempt == null and f.state.feedback.items.len == 0 and f.state.work.items.len == 0);
    }
}

test "Scene viewport late translations use the eight round budget and retain completed presentation on exhaustion" {
    for ([_]bool{ false, true }) |exhaust| {
        const f = try Fixture.init(testing.allocator, 8, 4, .{});
        defer f.deinit();
        const content = try f.owner.sceneCreateNode(f.id, 1, 2);
        try dimensions(f.owner, content, 8, 32);
        try f.owner.sceneMoveNode(content, f.root, 0);
        try f.owner.sceneSetViewport(content, f.root);
        var children: [16]context.Handle = undefined;
        try filterChildren(f.owner, f.id, content, &children);
        try f.owner.sceneSetPaint(children[0], .{ .background = .{ 60, 80, 100, 255 } });
        try f.owner.scenePaint(f.id, frame_options.background, true, 0);
        _ = try f.owner.renderSession(f.id, true);
        try drain(f.owner, f.id);
        const before = f.cli.getCurrentBuffer().get(0, 0).?;
        const written = (try f.owner.getSession(f.id)).getStats().bytes_written;
        const stats = try f.owner.sceneGetStats(f.id);
        for (children) |child| try f.owner.sceneSetHooks(child, 1, 1, 2, 2);
        var request: ?scene.FrameRequest = null;
        for (children, 0..) |child, index| {
            request = try f.step(request, frame_options, 1, child);
            try testing.expectEqual(@as(u32, @intCast(index / 2 + 1)), f.state.attempt.?.rounds);
            try testing.expect(f.state.feedback.items.len <= @as(usize, f.state.count) * 4);
            if (index % 2 == 0) {
                const offset: f64 = if (index < 14) @floatFromInt((index + 2) * 2) else if (exhaust) 0 else 28;
                try f.owner.sceneSetPaint(content, .{ .translateY = -offset });
            }
        }
        if (exhaust) {
            try testing.expectError(error.LayoutLimit, f.owner.sceneFrameStep(f.id, request, frame_options));
        } else {
            try testing.expectEqual(@as(u32, 0), (try f.owner.sceneFrameStep(f.id, request, frame_options)).kind);
            try testing.expectEqual((try f.owner.getRenderable(children[14])).scene_node.?.token, f.cli.nextHitGrid[0]);
        }
        try testing.expect(f.state.attempt == null and f.state.feedback.items.len == 0 and f.state.work.items.len == 0);
        try testing.expectEqual(stats.frameCount, (try f.owner.sceneGetStats(f.id)).frameCount);
        try testing.expectEqual(written, (try f.owner.getSession(f.id)).getStats().bytes_written);
        try testing.expectEqual(@as(u32, 10), try f.owner.sceneHitTest(f.id, 0, 0));
        try testing.expectEqualDeep(before, f.cli.getCurrentBuffer().get(0, 0).?);
    }
}

test "Scene viewport midbatch refresh preserves observed prefix and queued suffix across host mutations" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const content = try f.owner.sceneCreateNode(f.id, 1, 2);
    const destination = try f.owner.sceneCreateNode(f.id, 1, 3);
    for ([_]context.Handle{ content, destination }, 0..) |node, index| {
        try dimensions(f.owner, node, 8, 32);
        try f.owner.sceneSetStyle(node, 0, 6, 0, 0, 2, 0);
        try f.owner.sceneMoveNode(node, f.root, @intCast(index));
    }
    var children: [16]context.Handle = undefined;
    for (&children, 0..) |*child, index| {
        const text = index == 0 or index == 15;
        child.* = try f.owner.sceneCreateNode(f.id, if (text) 2 else 1, @intCast(index + 10));
        try dimensions(f.owner, child.*, 2, 2);
        try f.owner.sceneSetStyle(child.*, 0, 6, 0, 0, 2, 0);
        try f.owner.sceneSetPositions(child.*, 3, .{ 1, 1, 0, 0 }, .{ 0, @floatFromInt(index * 2), 0, 0 });
        if (text) try f.owner.sceneSetText(child.*, "abcd");
        try f.owner.sceneMoveNode(child.*, content, @intCast(index));
    }
    try f.owner.scenePaint(f.id, frame_options.background, false, 0);
    try f.owner.sceneSetViewport(content, f.root);
    try f.owner.sceneSetViewport(destination, f.root);
    try f.owner.sceneSetHooks(destination, 1, 1, 8, 32);
    for (children) |child| try dimensions(f.owner, child, 3, 2);
    try f.owner.sceneSetHooks(children[0], 1, 1, 2, 2);
    for ([_]usize{ 8, 9, 10, 11, 12, 14 }) |index| {
        try f.owner.sceneSetHooks(children[index], 2, 1, 2, 2);
    }
    var request = try f.step(null, frame_options, 2, children[8]);
    for (children, 0..) |child, index| {
        try testing.expectEqual(@as(f32, if (index <= 8) 3 else 2), (try f.owner.sceneGetLayout(child, false)).width);
    }
    const first_view = (try f.owner.getRenderable(children[0])).scene_node.?.text.?.view;
    const last_view = (try f.owner.getRenderable(children[15])).scene_node.?.text.?.view;
    try testing.expectEqual(@as(u32, 3), first_view.getViewport().?.width);
    try testing.expectEqual(@as(u32, 2), last_view.getViewport().?.width);
    try f.owner.sceneMoveNode(children[9], destination, 0);
    try f.owner.sceneDestroyNode(children[10]);
    const replacement = try f.owner.sceneCreateNode(f.id, 1, 100);
    try testing.expectEqual(children[10].slot, replacement.slot);
    try testing.expect(children[10].generation != replacement.generation);
    try dimensions(f.owner, replacement, 5, 2);
    for ([_]usize{ 11, 15 }) |index| try f.owner.sceneSetStyle(children[index], 0, 9, 0, 0, 1, 0);
    try f.owner.sceneSetPaint(children[14], .{ .zIndex = -1 });
    for ([_]usize{ 12, 14 }) |index| {
        request = try f.step(request, frame_options, 2, children[index]);
    }
    request = try f.step(request, frame_options, 1, children[0]);
    for (children, 0..) |child, index| {
        if (index == 10) continue;
        try testing.expectEqual(@as(f32, if (index == 9) 2 else 3), (try f.owner.sceneGetLayout(child, false)).width);
    }
    try testing.expectEqual(@as(u32, 2), last_view.getViewport().?.width);
    try testing.expectEqual(@as(f32, 0), (try f.owner.sceneGetLayout(replacement, false)).width);
    request = try f.step(request, frame_options, 1, destination);
    try testing.expectEqual(@as(f32, 2), (try f.owner.sceneGetLayout(children[9], false)).width);
    request = try f.step(request, frame_options, 2, children[9]);
    try testing.expectEqual(@as(f32, 3), (try f.owner.sceneGetLayout(children[9], false)).width);
    try testing.expectEqual(@as(u32, 0), (try f.owner.sceneFrameStep(f.id, request, frame_options)).kind);
    try testing.expectEqual(@as(f32, 1), (try f.owner.sceneGetLayout(children[15], false)).width);
    try testing.expectEqual(@as(u32, 2), last_view.getViewport().?.width);
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
    try f.owner.scenePaint(f.id, frame_options.background, false, 0);
    var failing = testing.FailingAllocator.init(testing.allocator, .{ .fail_index = 0 });
    f.state.allocator = failing.allocator();
    const painted = f.owner.scenePaint(f.id, frame_options.background, false, 0);
    f.state.allocator = f.owner.allocator;
    try painted;
    try testing.expect(!failing.has_induced_failure);
    try testing.expectEqual(ansi.rgbColor(0, 170, 255, 255), (try f.owner.getSessionRenderer(f.id)).getNextBuffer().get(0, 0).?.fg);
    f.state.last_frame_id = std.math.maxInt(u64);
    try testing.expectError(error.RequestLimit, f.owner.sceneFrameStep(f.id, null, frame_options));
    try testing.expect(f.state.attempt == null);
}

test "Scene Slider preserves legacy half-cell endpoints and finite zero or inverted ranges" {
    const Case = struct { min: f64 = 0, max: f64 = 7, value: f64, viewport: f64 = 3, size: f64, start: f64, cells: [5]u2 };
    const cases = [_]Case{
        .{ .value = 0, .size = 3, .start = 0, .cells = .{ 1, 2, 0, 0, 0 } },
        .{ .value = 1, .size = 3, .start = 1, .cells = .{ 3, 1, 0, 0, 0 } },
        .{ .value = 3.5, .size = 3, .start = 4, .cells = .{ 0, 0, 1, 2, 0 } },
        .{ .value = 7, .size = 3, .start = 7, .cells = .{ 0, 0, 0, 3, 1 } },
        .{ .value = -1.5, .size = 3, .start = -1, .cells = .{ 1, 0, 0, 0, 0 } },
        .{ .value = 8, .size = 3, .start = 8, .cells = .{ 0, 0, 0, 0, 1 } },
        .{ .value = 10, .size = 3, .start = 10, .cells = .{ 0, 0, 0, 0, 0 } },
        .{ .value = 7, .viewport = -5, .size = 1, .start = 9, .cells = .{ 0, 0, 0, 0, 3 } },
        .{ .min = 5, .max = 5, .value = -1e300, .size = 10, .start = 0, .cells = .{ 1, 1, 1, 1, 1 } },
        .{ .min = 7, .max = 0, .value = 4, .size = 10, .start = 0, .cells = .{ 1, 1, 1, 1, 1 } },
    };
    for (0..2) |orientation| {
        const owner = try context.Context.init(testing.allocator, testing.io, .{});
        defer owner.deinit() catch unreachable;
        const width: u32 = if (orientation == 0) 5 else 2;
        const height: u32 = if (orientation == 0) 2 else 5;
        const id = try session(owner, width, height);
        const root = try owner.sceneCreateNode(id, 0, 1);
        const slider = try owner.sceneCreateNode(id, 3, 2);
        try dimensions(owner, slider, @floatFromInt(width), @floatFromInt(height));
        try owner.sceneMoveNode(slider, root, 0);
        try owner.scenePaint(id, frame_options.background, true, 0);
        const defaults = (try owner.getSessionRenderer(id)).getNextBuffer();
        try testing.expectEqual(@as(u32, 0x258c), defaults.get(0, 0).?.char);
        for (defaults.buffer.char, 0..) |char, index| try testing.expectEqual(@as(u32, if (index % width == 0) 0x258c else ' '), char);
        try testing.expectEqual(ansi.rgbColor(154, 158, 163, 255), defaults.get(0, 0).?.fg);
        for (defaults.buffer.bg) |bg| try testing.expectEqual(ansi.rgbColor(37, 37, 39, 255), bg);
        for (cases) |case| {
            try owner.sceneSetSlider(slider, .{
                .orientation = @intCast(orientation),
                .min = case.min,
                .max = case.max,
                .value = case.value,
                .viewport_size = case.viewport,
            });
            try owner.scenePaint(id, frame_options.background, false, 0);
            try testing.expectEqualDeep(scene.SliderThumb{ .size = case.size, .start = case.start }, try owner.sceneGetSliderThumb(slider));
            const chars = [_]u32{ ' ', 0x2588, if (orientation == 0) 0x258c else 0x2580, if (orientation == 0) 0x2590 else 0x2584 };
            const next = (try owner.getSessionRenderer(id)).getNextBuffer();
            for (0..height) |y| {
                for (0..width) |x| {
                    try testing.expectEqual(chars[case.cells[if (orientation == 0) x else y]], next.get(@intCast(x), @intCast(y)).?.char);
                }
            }
        }
    }
}

test "Scene Slider thumb uses exact constructor dimensions then observed feedback geometry" {
    const f = try Fixture.init(testing.allocator, 12, 2, .{});
    defer f.deinit();
    const slider = try f.owner.sceneCreateNode(f.id, 3, 2);
    try f.owner.sceneSetSlider(slider, .{ .min = 0, .max = 0 });
    try testing.expectEqual(@as(f64, 0), (try f.owner.sceneGetSliderThumb(slider)).size);
    const initial_width: f64 = 10.0000000001;
    try dimensions(f.owner, slider, @floatCast(initial_width), 1);
    try f.owner.sceneSetHooks(slider, 0, 1, initial_width, 1);
    try testing.expectEqual(initial_width * 2, (try f.owner.sceneGetSliderThumb(slider)).size);
    try dimensions(f.owner, slider, 4, 1);
    try testing.expectEqual(initial_width * 2, (try f.owner.sceneGetSliderThumb(slider)).size);
    try f.owner.sceneMoveNode(slider, f.root, 0);
    try f.owner.scenePaint(f.id, frame_options.background, false, 0);
    try testing.expectEqual(@as(f64, 8), (try f.owner.sceneGetSliderThumb(slider)).size);
    try f.owner.sceneSetHooks(slider, 3, 2, initial_width, 1);
    try dimensions(f.owner, slider, 6, 1);
    var request = try f.step(null, frame_options, 1, null);
    try testing.expectEqual(@as(f32, 6), (try f.owner.sceneGetLayout(slider, true)).width);
    try testing.expectEqual(@as(f64, 8), (try f.owner.sceneGetSliderThumb(slider)).size);
    request = try f.step(request, frame_options, 2, null);
    try testing.expectEqual(@as(f64, 12), (try f.owner.sceneGetSliderThumb(slider)).size);
    try testing.expectEqual(@as(u32, 0), (try f.owner.sceneFrameStep(f.id, request, frame_options)).kind);
    const next = (try f.owner.getSessionRenderer(f.id)).getNextBuffer();
    try testing.expectEqualSlices(u32, &@as([6]u32, @splat(0x2588)), next.buffer.char[0..6]);
}

test "Scene Slider rounding matches JavaScript at negative ties and just below positive ties" {
    const f = try Fixture.init(testing.allocator, 2, 1, .{});
    defer f.deinit();
    const slider = try f.owner.sceneCreateNode(f.id, 3, 2);
    try f.owner.sceneSetHooks(slider, 0, 1, 1, 1);
    for ([_]f64{ -0.5, -1.5, 0.49999999999999994, 0.5 }, [_]f64{ -0.0, -1, 0, 1 }) |value, expected| {
        try f.owner.sceneSetSlider(slider, .{ .min = 0, .max = 1, .value = value, .viewport_size = 1 });
        const thumb = try f.owner.sceneGetSliderThumb(slider);
        try testing.expectEqual(@as(u64, @bitCast(expected)), @as(u64, @bitCast(thumb.start)));
    }
}

test "Scene Slider negative left and top origins retain partially visible tracks and alpha with offscreen thumbs" {
    for (0..2) |orientation| {
        const f = try Fixture.init(testing.allocator, 4, 4, .{});
        defer f.deinit();
        const slider = try f.owner.sceneCreateNode(f.id, 3, 2);
        try dimensions(f.owner, slider, if (orientation == 0) 5 else 2, if (orientation == 0) 2 else 5);
        try f.owner.sceneMoveNode(slider, f.root, 0);
        try f.owner.sceneSetPaint(slider, .{
            .translateX = if (orientation == 0) -2 else 0,
            .translateY = if (orientation == 1) -2 else 0,
        });
        const reference = try f.owner.getBuffer(try f.owner.createBuffer(4, 4, .{}));
        const foreground = ansi.rgbColor(210, 140, 70, 96);
        for ([_]u8{ 255, 128 }) |alpha| {
            const track = ansi.rgbColor(37, 37, 39, alpha);
            for ([_]f64{ 0, 7, 10 }) |value| {
                try f.owner.sceneSetSlider(slider, .{
                    .orientation = @intCast(orientation),
                    .max = 7,
                    .value = value,
                    .viewport_size = 3,
                    .foreground = .{ 210, 140, 70, 96 },
                    .background = .{ 37, 37, 39, alpha },
                });
                try f.owner.scenePaint(f.id, .{ 32, 48, 64, 255 }, true, 0);
                reference.clear(ansi.rgbColor(32, 48, 64, 255), null);
                reference.fillRect(0, 0, if (orientation == 0) 3 else 2, if (orientation == 0) 2 else 3, track);
                if (value == 7) {
                    for (0..2) |across| {
                        for (1..3) |along| {
                            const x = if (orientation == 0) along else across;
                            const y = if (orientation == 0) across else along;
                            const char: u32 = if (along == 2) 0x2588 else if (orientation == 0) 0x2590 else 0x2584;
                            reference.setCellWithAlphaBlending(@intCast(x), @intCast(y), char, foreground, track, 0);
                        }
                    }
                }
                const next = (try f.owner.getSessionRenderer(f.id)).getNextBuffer();
                try testing.expectEqualSlices(u32, reference.buffer.char, next.buffer.char);
                try testing.expectEqualSlices(ansi.RGBA, reference.buffer.fg, next.buffer.fg);
                try testing.expectEqualSlices(ansi.RGBA, reference.buffer.bg, next.buffer.bg);
            }
        }
    }
}

test "Scene Slider bounds huge tracks and finite off-track thumbs to clipped framebuffer work" {
    const f = try Fixture.init(testing.allocator, 4, 2, .{});
    defer f.deinit();
    const slider = try f.owner.sceneCreateNode(f.id, 3, 2);
    try dimensions(f.owner, slider, 1000000000, 1000000000);
    try f.owner.sceneSetPaint(slider, .{ .translateX = -999999996, .translateY = -999999998 });
    try f.owner.sceneSetSlider(slider, .{ .min = 0, .max = 0 });
    try f.owner.sceneMoveNode(slider, f.root, 0);
    try f.owner.scenePaint(f.id, frame_options.background, false, 0);
    const next = (try f.owner.getSessionRenderer(f.id)).getNextBuffer();
    for (next.buffer.char) |char| try testing.expectEqual(@as(u32, 0x2588), char);
    for ([_]f64{ -1e200, 1e200 }) |value| {
        try f.owner.sceneSetSlider(slider, .{ .max = 1, .value = value, .viewport_size = 1 });
        try f.owner.scenePaint(f.id, frame_options.background, false, 0);
        for (next.buffer.char) |char| try testing.expectEqual(@as(u32, ' '), char);
    }
    try f.owner.sceneSetSlider(slider, .{ .min = 0, .max = 0 });
    try f.owner.sceneSetPaint(slider, .{ .translateX = std.math.minInt(i32), .translateY = std.math.minInt(i32) });
    try f.owner.scenePaint(f.id, frame_options.background, false, 0);
    for (next.buffer.char) |char| try testing.expectEqual(@as(u32, ' '), char);
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
        try f.owner.scenePaint(f.id, frame_options.background, false, 0);
        try testing.expectEqual(@as(u32, 0x2588), (try f.owner.getSessionRenderer(f.id)).getNextBuffer().get(0, 0).?.char);
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
    try owner.scenePaint(id, frame_options.background, false, 0);
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
    try testing.expectEqualDeep(accepted, (try owner.getRenderable(slider)).scene_node.?.control.slider);
    try testing.expectEqualDeep(accepted_arrow, (try owner.getRenderable(arrow)).scene_node.?.control.arrow);
}

test "Scene Slider rejects nonfinite arithmetic introduced by layout before publishing geometry" {
    const f = try Fixture.init(testing.allocator, 4, 1, .{});
    defer f.deinit();
    const slider = try f.owner.sceneCreateNode(f.id, 3, 2);
    try dimensions(f.owner, slider, 1, 1);
    try f.owner.sceneMoveNode(slider, f.root, 0);
    try f.owner.sceneSetSlider(slider, .{ .max = 1, .value = std.math.floatMax(f64), .viewport_size = 1 });
    try f.owner.scenePaint(f.id, frame_options.background, false, 0);
    try dimensions(f.owner, slider, 2, 1);
    try testing.expectError(error.InvalidOptions, f.owner.scenePaint(f.id, frame_options.background, true, 0));
    try testing.expectEqual(@as(f32, 1), (try f.owner.sceneGetLayout(slider, false)).width);
    try testing.expectEqual(@as(usize, 0), f.cli.getNextBuffer().scissor_stack.items.len);
    try testing.expectEqual(@as(usize, 0), f.cli.getNextBuffer().opacity_stack.items.len);
    for (f.cli.nextHitGrid) |hit| try testing.expectEqual(@as(u32, 0), hit);
    try dimensions(f.owner, slider, 1, 1);
    try f.owner.scenePaint(f.id, frame_options.background, false, 0);
}

test "Scene feedback rejects unsupported hooks and generation changes atomically" {
    const f = try Fixture.init(testing.allocator, 6, 3, .{});
    defer f.deinit();
    const text = try f.owner.sceneCreateNode(f.id, 2, 2);
    try f.owner.sceneSetHooks(f.root, 1, 1, 0, 0);
    try testing.expectError(error.StaleFrame, f.owner.sceneSetHooks(f.root, 0, 1, 0, 0));
    try f.owner.sceneSetHooks(text, 2, 1, 0, 0);
    try f.owner.sceneSetHooks(text, 0, 2, 0, 0);
    try testing.expectError(error.InvalidOptions, f.owner.sceneSetHooks(text, 4, 1, 0, 0));
    try testing.expectError(error.InvalidOptions, f.owner.sceneSetHooks(f.root, 8, 2, 0, 0));
    try testing.expectError(error.InvalidDimensions, f.owner.sceneSetHooks(f.root, 0, 2, std.math.nan(f64), 0));
    const box = try f.owner.sceneCreateNode(f.id, 1, 3);
    for ([_]u32{ 8, 24, 25, 3, 27, 24, 0 }, 0..) |flags, index| {
        try f.owner.sceneSetHooks(box, flags, index + 1, 0, 0);
        try testing.expectEqual(@as(u32, 1) + @intFromBool(flags != 0), f.state.hook_count);
        try testing.expectEqual(@as(u32, 1) + @intFromBool(flags & 7 != 0), f.state.layout_hook_count);
    }
    try f.owner.sceneSetHooks(box, 27, 8, 0, 0);
    try f.owner.sceneDestroyNode(box);
    try testing.expectEqual(@as(u32, 1), f.state.hook_count);
    try testing.expectEqual(@as(u32, 1), f.state.layout_hook_count);
    const request = try f.owner.sceneFrameStep(f.id, null, frame_options);
    try testing.expectEqual(@as(u64, 1), request.hook_generation);
    try f.owner.sceneFrameCancel(f.id, request.frame_id);
    try f.owner.sceneSetHooks(f.root, 0, 2, 0, 0);
    try f.owner.scenePaint(f.id, frame_options.background, false, 0);
}

test "Scene feedback paint-only changes preserve fixed limits and update current frame options" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    for (0..16) |index| {
        const box = try f.owner.sceneCreateNode(f.id, 1, @intCast(index + 2));
        try dimensions(f.owner, box, 1, 1);
        try f.owner.sceneMoveNode(box, f.root, @intCast(index));
        try f.owner.sceneSetHooks(box, 1, 1, 1, 1);
    }
    var options = frame_options;
    options.max_layout_rounds = 1;
    var request = try f.owner.sceneFrameStep(f.id, null, options);
    try testing.expectEqual(@as(u64, 17), f.state.test_geometry_reads);
    var changed = options;
    changed.max_layout_rounds += 1;
    try testing.expectError(error.InvalidOptions, f.owner.sceneFrameStep(f.id, request, changed));
    changed = options;
    changed.max_host_requests += 1;
    try testing.expectError(error.InvalidOptions, f.owner.sceneFrameStep(f.id, request, changed));
    changed = options;
    changed.background[0] = 255;
    changed.use_mouse = false;
    changed.excluded_hit_num = 2;
    var stale = request;
    stale.request_id += 1;
    try testing.expectError(error.StaleFrame, f.owner.sceneFrameStep(f.id, stale, changed));
    try testing.expectEqualDeep(options, (try f.owner.getSession(f.id)).scene.?.attempt.?.options);
    options = changed;
    var count: u32 = 0;
    while (request.kind != 0) : (count += 1) {
        try testing.expect(count < 16);
        try f.owner.sceneSetPaint(request.node, .{ .translateX = 1, .zIndex = 1, .background = .{ 10, 20, 30, 255 } });
        request = try f.owner.sceneFrameStep(f.id, request, options);
    }
    try testing.expectEqual(@as(u32, 16), count);
    try testing.expectEqual(@as(u64, 17), f.state.test_geometry_reads);
    try testing.expectEqual(ansi.rgbColor(255, 0, 0, 255), f.cli.getNextBuffer().get(0, 0).?.bg);
    try testing.expectEqual(ansi.rgbColor(10, 20, 30, 255), f.cli.getNextBuffer().get(1, 0).?.bg);
    for (f.cli.nextHitGrid) |hit| try testing.expectEqual(@as(u32, 0), hit);
}

test "Scene feedback compatibility new child prepass uses placement order before z ordered updates" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const parent = try f.owner.sceneCreateNode(f.id, 1, 2);
    try dimensions(f.owner, parent, 8, 4);
    try f.owner.sceneMoveNode(parent, f.root, 0);
    try f.owner.scenePaint(f.id, frame_options.background, false, 0);
    const first = try f.owner.sceneCreateNode(f.id, 1, 3);
    const second = try f.owner.sceneCreateNode(f.id, 1, 4);
    for ([_]context.Handle{ first, second }) |child| {
        try f.owner.sceneSetStyle(child, 4, 0, 0, 2, 50, 0);
        try f.owner.sceneSetStyle(child, 4, 1, 0, 1, 1, 1);
        try f.owner.sceneSetHooks(child, 3, 1, 0, 1);
        try f.owner.sceneMoveNode(child, parent, 0);
    }
    try f.owner.sceneSetPaint(first, .{ .zIndex = 10 });
    try f.owner.sceneSetHooks(parent, 1, 1, 8, 4);
    var request = try f.owner.sceneFrameStep(f.id, null, frame_options);
    try testing.expectEqual(parent, request.node);
    try testing.expectEqual(@as(f32, 0), (try f.owner.sceneGetLayout(first, false)).width);
    try testing.expectEqual(@as(f32, 4), (try f.owner.sceneGetLayout(first, true)).width);
    for ([_]context.Handle{ first, second }) |child| {
        request = try f.step(request, frame_options, 2, child);
        try testing.expectEqual(@as(f32, 4), (try f.owner.sceneGetLayout(child, false)).width);
        if (std.meta.eql(child, first)) try testing.expectEqual(@as(f32, 0), (try f.owner.sceneGetLayout(second, false)).width);
    }
    for ([_]context.Handle{ second, first }) |child| {
        request = try f.step(request, frame_options, 1, child);
        try testing.expectEqual(@as(f32, 4), (try f.owner.sceneGetLayout(child, false)).width);
    }
    try testing.expectEqual(@as(u32, 0), (try f.owner.sceneFrameStep(f.id, request, frame_options)).kind);
}

test "Scene feedback child order is chosen after parent preparation callbacks" {
    const Stage = enum { update, resize, prepass };
    for ([_]Stage{ .update, .resize, .prepass }) |stage| {
        const f = try Fixture.init(testing.allocator, 8, 4, .{});
        defer f.deinit();
        const parent = try f.owner.sceneCreateNode(f.id, 1, 2);
        const first = try f.owner.sceneCreateNode(f.id, 1, 3);
        const second = try f.owner.sceneCreateNode(f.id, 1, 4);
        try dimensions(f.owner, parent, 6, 3);
        try f.owner.sceneMoveNode(parent, f.root, 0);
        for ([_]context.Handle{ first, second }, 0..) |child, index| {
            try dimensions(f.owner, child, 1, 1);
            try f.owner.sceneSetPaint(child, .{ .zIndex = @intCast(index) });
            try f.owner.sceneMoveNode(child, parent, @intCast(index));
        }
        try f.owner.scenePaint(f.id, frame_options.background, false, 0);
        try f.owner.sceneSetHooks(first, if (stage == .prepass) 3 else 1, 1, 1, 1);
        try f.owner.sceneSetHooks(second, 1, 1, 1, 1);
        switch (stage) {
            .update => try f.owner.sceneSetHooks(parent, 1, 1, 6, 3),
            .resize => {
                try f.owner.sceneSetHooks(parent, 2, 1, 6, 3);
                try dimensions(f.owner, parent, 7, 3);
            },
            .prepass => {
                try dimensions(f.owner, first, 2, 1);
                try f.owner.sceneMoveNode(first, parent, 0);
            },
        }
        var options = frame_options;
        options.max_layout_rounds = 1;
        var request = try f.step(null, options, if (stage == .update) 1 else 2, if (stage == .prepass) first else parent);
        try f.owner.sceneSetPaint(first, .{ .zIndex = 2 });
        for ([_]context.Handle{ second, first }) |child| {
            request = try f.step(request, options, 1, child);
        }
        try testing.expectEqual(@as(u32, 0), (try f.owner.sceneFrameStep(f.id, request, options)).kind);
    }
}

test "Scene feedback sibling order stays fixed after descent including self destruction" {
    for ([_]bool{ false, true }) |destroy_first| {
        const f = try Fixture.init(testing.allocator, 8, 4, .{});
        defer f.deinit();
        var children: [3]context.Handle = undefined;
        for (&children, 0..) |*child, index| {
            child.* = try f.owner.sceneCreateNode(f.id, 1, @intCast(index + 2));
            try dimensions(f.owner, child.*, 1, 1);
            try f.owner.sceneSetPaint(child.*, .{ .zIndex = @intCast(index) });
            try f.owner.sceneMoveNode(child.*, f.root, @intCast(index));
            try f.owner.sceneSetHooks(child.*, 1, 1, 1, 1);
        }
        var options = frame_options;
        options.max_layout_rounds = if (destroy_first) 2 else 1;
        var request = try f.owner.sceneFrameStep(f.id, null, options);
        try testing.expectEqual(children[0], request.node);
        try f.owner.sceneSetPaint(children[2], .{ .zIndex = -1 });
        if (destroy_first) try f.owner.sceneDestroyNode(children[0]);
        for (children[1..]) |child| {
            request = try f.step(request, options, 1, child);
        }
        try testing.expectEqual(@as(u32, 0), (try f.owner.sceneFrameStep(f.id, request, options)).kind);
    }
}

test "Scene feedback compatibility listener added after Yoga retains pending resize baseline" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const box = try f.owner.sceneCreateNode(f.id, 1, 2);
    try dimensions(f.owner, box, 2, 1);
    try f.owner.sceneMoveNode(box, f.root, 0);
    try f.owner.scenePaint(f.id, frame_options.background, false, 0);
    try f.owner.sceneSetHooks(f.root, 4, 1, 8, 4);
    try testing.expectEqual(@as(usize, 0), (try f.owner.getSession(f.id)).scene.?.work.items.len);
    try dimensions(f.owner, box, 4, 1);
    var request = try f.step(null, frame_options, 3, null);
    try f.owner.sceneSetHooks(box, 2, 1, 2, 1);
    request = try f.step(request, frame_options, 2, box);
    try testing.expectEqual(@as(u32, 4), request.width);
    try testing.expectEqual(@as(u32, 0), (try f.owner.sceneFrameStep(f.id, request, frame_options)).kind);

    try f.owner.sceneFrameCancel(f.id, request.frame_id);
    const equal = try f.owner.sceneCreateNode(f.id, 1, 3);
    try dimensions(f.owner, equal, 3, 1);
    try f.owner.sceneMoveNode(equal, f.root, 1);
    request = try f.step(null, frame_options, 3, null);
    try f.owner.sceneSetHooks(equal, 2, 1, 3, 1);
    try testing.expectEqual(@as(u32, 0), (try f.owner.sceneFrameStep(f.id, request, frame_options)).kind);
}

test "Scene text reports a checked error for a 129-byte grapheme" {
    const f = try Fixture.init(testing.allocator, 4, 2, .{});
    defer f.deinit();
    const node = try f.owner.sceneCreateNode(f.id, 2, 2);
    try dimensions(f.owner, node, 1, 1);
    try f.owner.sceneMoveNode(node, f.root, 0);
    const accepted = "e" ++ "\u{301}" ** 63;
    try f.owner.sceneSetText(node, accepted);
    try f.owner.scenePaint(f.id, .{ 0, 0, 0, 255 }, false, 0);
    const next = (try f.owner.getSessionRenderer(f.id)).getNextBuffer();
    const char = next.get(0, 0).?.char;
    try testing.expect(gp.isGraphemeChar(char));
    try testing.expectEqualStrings(accepted, try f.owner.graphemes.get(gp.graphemeIdFromChar(char)));

    const rejected = "e" ++ "\u{301}" ** 64;
    try testing.expectEqual(@as(usize, 129), rejected.len);
    const result: anyerror!void = if (f.owner.sceneSetText(node, rejected)) |_|
        f.owner.scenePaint(f.id, .{ 0, 0, 0, 255 }, false, 0)
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
    const text_buffer = (try f.owner.getRenderable(text)).scene_node.?.text.?.buffer;
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

test "Scene text selection preparation OOM preserves accepted state and reset needs no allocation" {
    for ([_]u32{ 1, 2 }) |operation| {
        var failures: u32 = 0;
        for (0..64) |fail_offset| {
            var failing = testing.FailingAllocator.init(testing.allocator, .{});
            const f = try Fixture.init(failing.allocator(), 8, 2, .{});
            defer f.deinit();
            const node = try f.owner.sceneCreateNode(f.id, 2, 2);
            try dimensions(f.owner, node, 8, 2);
            try f.owner.sceneSetTextOptions(node, .{ .wrap_mode = .none });
            try f.owner.sceneSetText(node, "  e\u{301}\u{4e16}\u{754c} tail  \nnext");
            _ = try f.owner.sceneSetTextSelection(node, .{ .operation = 1, .focus_x = 4, .background = .{ 1, 2, 3, 255 } });
            const text = (try f.owner.getRenderable(node)).scene_node.?.text.?;
            const selection = text.view.selection;
            const endpoints = text.view.selection_endpoints;
            try f.owner.sceneSetTextOptions(node, .{
                .wrap_mode = if (operation == 1) .char else .none,
                .truncate = operation == 2,
                .first_line_offset = 1,
            });
            failing.fail_index = failing.alloc_index + fail_offset;
            failing.resize_fail_index = failing.resize_index;
            const result = f.owner.sceneSetTextSelection(node, .{ .operation = operation, .behavior = 1, .focus_x = 5 });
            failing.fail_index = std.math.maxInt(usize);
            failing.resize_fail_index = std.math.maxInt(usize);
            if (result) |_| break else |err| {
                try testing.expectEqual(error.OutOfMemory, err);
                failures += 1;
                try testing.expectEqualDeep(selection, text.view.selection);
                try testing.expectEqualDeep(endpoints, text.view.selection_endpoints);
                try testing.expectEqual(.cell, text.view.selection_behavior);
                var bytes: [64]u8 = undefined;
                try testing.expect((try f.owner.sceneGetSelectedText(node, &bytes)) > 0);
                failing.fail_index = failing.alloc_index;
                failing.resize_fail_index = failing.resize_index;
                try testing.expect(try f.owner.sceneSetTextSelection(node, .{ .operation = 0 }));
                try testing.expectEqual(std.math.maxInt(u64), try f.owner.sceneGetTextSelection(node));
                failing.fail_index = std.math.maxInt(usize);
                failing.resize_fail_index = std.math.maxInt(usize);
                _ = try f.owner.sceneSetTextSelection(node, .{ .operation = 1, .behavior = 2, .focus_x = 5 });
            }
        }
        try testing.expect(failures > 0 and failures < 64);
    }
}

test "Scene text selection cold markers reject OOM before publishing endpoints" {
    const line = "  e\u{301}\u{4e16} tail  ";
    const input = (line ++ "\n") ** 2;
    for ([_]bool{ false, true }) |styled| {
        for ([_]u32{ 1, 2 }) |operation| {
            for ([_]u32{ 1, 2 }) |behavior| {
                var failing = testing.FailingAllocator.init(testing.allocator, .{});
                const f = try Fixture.init(failing.allocator(), 16, 2, .{});
                defer f.deinit();
                const node = try f.owner.sceneCreateNode(f.id, 2, 2);
                try dimensions(f.owner, node, 16, 2);
                try f.owner.sceneSetTextOptions(node, .{ .wrap_mode = .none });
                try f.owner.sceneSetText(node, line);
                _ = try f.owner.sceneSetTextSelection(node, .{ .operation = 1, .anchor_x = 2, .focus_x = 3 });
                const text = (try f.owner.getRenderable(node)).scene_node.?.text.?;
                const selection = text.view.selection;
                const endpoints = text.view.selection_endpoints;
                if (styled) {
                    try f.owner.sceneSetStyledText(node, input, &.{.{ .byte_count = input.len }});
                } else {
                    try f.owner.sceneSetText(node, input);
                }
                _ = try f.owner.sceneGetTextInfo(node);
                try testing.expectEqual(@as(usize, 3), text.view.virtual_lines.items.len);
                const rope = text.buffer.rope();
                try testing.expect(rope.marker_cache.version != rope.version);
                // Fail the cache allocation itself, independent of spare rope-arena capacity.
                const previous_cache = rope.marker_cache;
                rope.marker_cache = @TypeOf(rope.marker_cache).init(failing.allocator());
                defer {
                    rope.marker_cache.deinit();
                    rope.marker_cache = previous_cache;
                }
                const options: context.SceneTextSelectionOptions = .{
                    .operation = operation,
                    .behavior = behavior,
                    .anchor_x = 8,
                    .focus_x = 8,
                };
                failing.fail_index = failing.alloc_index;
                failing.resize_fail_index = failing.resize_index;
                const result = f.owner.sceneSetTextSelection(node, options);
                failing.fail_index = std.math.maxInt(usize);
                failing.resize_fail_index = std.math.maxInt(usize);
                try testing.expect(failing.has_induced_failure);
                try testing.expectError(error.OutOfMemory, result);
                try testing.expectEqualDeep(selection, text.view.selection);
                try testing.expectEqualDeep(endpoints, text.view.selection_endpoints);
                try testing.expectEqual(.cell, text.view.selection_behavior);
                try testing.expect(try f.owner.sceneSetTextSelection(node, options));
                const start: u64 = if (operation == 1 and behavior == 1) 6 else 2;
                try testing.expectEqual((start << 32) | 10, try f.owner.sceneGetTextSelection(node));
            }
        }
    }
}

test "Scene text replacement failures preserve plain and styled content measurement and layout" {
    const red: context.StyledTextChunk = .{
        .byte_count = 6,
        .foreground = .{ 255, 0, 0, 255 },
        .attributes = 1,
        .link_url = "https://before.test",
    };
    for ([_]bool{ false, true }) |styled| {
        var failures: usize = 0;
        const limit: usize = if (styled) 256 else 128;
        for (0..limit) |fail_offset| {
            var failing = testing.FailingAllocator.init(testing.allocator, .{});
            const f = try Fixture.init(failing.allocator(), 8, 4, .{});
            defer f.deinit();
            const node = try f.owner.sceneCreateNode(f.id, 2, 2);
            if (styled) try f.owner.sceneSetStyledText(node, "before", &.{red}) else try f.owner.sceneSetText(node, "before");
            try f.owner.sceneMoveNode(node, f.root, 0);
            try f.owner.scenePaint(f.id, .{ 0, 0, 0, 255 }, true, 0);
            const value = try f.owner.getRenderable(node);
            const text = value.scene_node.?.text.?;
            const style = text.owned_style;
            _ = try f.owner.sceneSetTextSelection(node, .{ .operation = 1, .anchor_x = 1, .focus_x = 2 });
            const selection = text.view.selection;
            const endpoints = text.view.selection_endpoints;
            const epoch = text.buffer.getContentEpoch();
            const layout = try f.owner.sceneGetLayout(node, false);
            const target = (try f.owner.getSessionRenderer(f.id)).getNextBuffer();
            const cell_before = target.get(0, 0).?;
            const link_id = ansi.TextAttributes.getLinkId(cell_before.attributes);
            if (styled) try testing.expect(link_id != 0);
            const refs = if (styled) try f.owner.links.getRefcount(link_id) else 0;
            const live_slots = f.owner.links.getLiveSlotCount();
            const input = "updated\r\n\u{4e16}\u{754c}\n" ** 12;
            const chunks: []const context.StyledTextChunk = &.{
                .{ .byte_count = 7, .background = .{ 20, 40, 60, 255 }, .link_url = "https://updated.test" },
                .{ .byte_count = input.len - 7, .link_url = "https://updated.test" },
            };
            failing.fail_index = failing.alloc_index + fail_offset;
            failing.resize_fail_index = failing.resize_index;
            const result = if (styled) f.owner.sceneSetStyledText(node, input, chunks) else f.owner.sceneSetText(node, input);
            failing.fail_index = std.math.maxInt(usize);
            failing.resize_fail_index = std.math.maxInt(usize);
            try testing.expectEqualDeep(selection, text.view.selection);
            try testing.expectEqualDeep(endpoints, text.view.selection_endpoints);
            if (result) |_| {
                try testing.expect(failures > 0);
                break;
            } else |err| {
                try testing.expectEqual(error.OutOfMemory, err);
                try testing.expect(failing.has_induced_failure);
                failures += 1;
                try testing.expectEqual(style, text.owned_style);
                try testing.expectEqual(style, text.buffer.syntax_style);
                try testing.expectEqual(epoch, text.buffer.getContentEpoch());
                try testing.expectEqual(live_slots, f.owner.links.getLiveSlotCount());
                if (styled) {
                    try testing.expectEqual(refs, try f.owner.links.getRefcount(link_id));
                    try testing.expectEqualStrings(red.link_url.?, try f.owner.links.get(link_id));
                }
                try testing.expectEqualDeep(cell_before, target.get(0, 0).?);
                try testing.expectEqualDeep(layout, try f.owner.sceneGetLayout(node, false));
                var bytes: [16]u8 = undefined;
                const count = try f.owner.sceneGetText(node, &bytes);
                try testing.expectEqualStrings("before", bytes[0..count]);
                var dirty: u32 = 1;
                try yoga.check(yoga.yogaNodeIsDirtyChecked(value.yoga_node, &dirty));
                try testing.expectEqual(@as(u32, 0), dirty);
                try testing.expectEqual(text.view, value.measure_target.text_buffer_view);
                try f.owner.scenePaint(f.id, .{ 0, 0, 0, 255 }, true, 0);
                const cell = (try f.owner.getSessionRenderer(f.id)).getNextBuffer().get(0, 0).?;
                try testing.expectEqualDeep(cell_before, cell);
                if (styled) try f.owner.sceneSetStyledText(node, input, chunks) else try f.owner.sceneSetText(node, input);
                try f.owner.sceneSetText(node, "plain");
                try testing.expectEqual(null, text.owned_style);
                try testing.expectEqual(null, text.buffer.syntax_style);
                try f.owner.sceneDestroyNode(node);
            }
        }
        try testing.expect(failures > 0 and failures < limit);
    }
}

test "Scene styled text links use isolated width and preserve raw URL bytes and length boundaries" {
    const f = try Fixture.init(testing.allocator, 8, 2, .{});
    defer f.deinit();
    const node = try f.owner.sceneCreateNode(f.id, 2, 2);
    try f.owner.sceneMoveNode(node, f.root, 0);
    const raw_url = "\xff\x00\x1b\r\nnot a parsed URL";
    try f.owner.sceneSetStyledText(node, "a\u{301}b", &.{
        .{ .byte_count = 1, .link_url = raw_url },
        .{ .byte_count = 2, .link_url = "https://zero-width.test" },
        .{ .byte_count = 1, .link_url = "" },
    });
    try testing.expectEqual(@as(u64, 1), f.owner.links.getLiveSlotCount());
    try f.owner.scenePaint(f.id, frame_options.background, false, 0);
    const target = (try f.owner.getSessionRenderer(f.id)).getNextBuffer();
    const raw_id = ansi.TextAttributes.getLinkId(target.get(0, 0).?.attributes);
    try testing.expectEqualStrings(raw_url, try f.owner.links.get(raw_id));
    try testing.expectEqual(@as(u32, 0), target.get(1, 0).?.attributes);
    try f.owner.sceneSetStyledText(node, "ab", &.{
        .{ .byte_count = 1, .link_url = "x" ** 512 },
        .{ .byte_count = 1, .link_url = "x" ** 513 },
    });
    try f.owner.scenePaint(f.id, frame_options.background, false, 0);
    const max_id = ansi.TextAttributes.getLinkId(target.get(0, 0).?.attributes);
    try testing.expectEqualStrings("x" ** 512, try f.owner.links.get(max_id));
    try testing.expectEqual(@as(u32, 0), target.get(1, 0).?.attributes);
    try testing.expectEqual(@as(u64, 1), f.owner.links.getLiveSlotCount());
}

test "Scene styled text links stay context-local and survive node destruction through painted leases" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const peer = try context.Context.init(testing.allocator, testing.io, .{});
    defer peer.deinit() catch unreachable;
    const id = try session(owner, 8, 2);
    const peer_id = try session(peer, 8, 2);
    const root = try owner.sceneCreateNode(id, 0, 1);
    _ = try peer.sceneCreateNode(peer_id, 0, 1);
    const node = try owner.sceneCreateNode(id, 2, 2);
    const peer_node = try peer.sceneCreateNode(peer_id, 2, 2);
    try owner.sceneSetStyledText(node, "link", &.{.{ .byte_count = 4, .link_url = "https://owner.test" }});
    try peer.sceneSetStyledText(peer_node, "peer", &.{.{ .byte_count = 4, .link_url = "https://peer.test" }});
    try owner.sceneMoveNode(node, root, 0);
    const frame = try owner.sceneFrameStep(id, null, frame_options);
    const lease = try owner.sceneFrameAcquireBufferLease(id, frame, .next);
    var lease_active = true;
    defer if (lease_active) owner.releaseBufferLease(lease) catch unreachable;
    const snapshot = try owner.bufferLeaseSnapshot(lease);
    const link_id = ansi.TextAttributes.getLinkId(snapshot.buffer.attributes[0]);
    try testing.expectEqualStrings("https://owner.test", try owner.links.get(link_id));
    try testing.expectEqualStrings("https://peer.test", try peer.links.get(link_id));
    try owner.sceneDestroyNode(node);
    try testing.expectEqual(@as(u32, 1), try owner.links.getRefcount(link_id));
    try testing.expectEqual(link_id, ansi.TextAttributes.getLinkId((try owner.bufferLeaseSnapshot(lease)).buffer.attributes[0]));
    try owner.sceneDestroyNode(root);
    _ = try owner.bufferLeaseSnapshot(lease);
    try owner.sceneFrameCancel(id, frame.frame_id);
    try owner.resizeSessionRenderer(id, 9, 2);
    try testing.expectError(error.StaleLease, owner.bufferLeaseSnapshot(lease));
    try testing.expectEqualStrings("https://owner.test", try owner.links.get(link_id));
    try owner.releaseBufferLease(lease);
    lease_active = false;
    try owner.destroy(id);
    try testing.expectEqual(@as(u64, 0), owner.links.getLiveSlotCount());
    try testing.expectEqual(@as(u64, 1), peer.links.getLiveSlotCount());
}

test "Scene text direct Context teardown releases stable measure targets after native failure" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const f = try Fixture.init(failing.allocator(), 8, 4, .{});
    defer f.deinit();
    const text = try f.owner.sceneCreateNode(f.id, 2, 2);
    const detached = try f.owner.sceneCreateNode(f.id, 2, 3);
    try f.owner.sceneSetText(text, "word tail wrapped");
    try f.owner.sceneSetText(detached, "detached");
    _ = try f.owner.sceneSetTextSelection(text, .{ .operation = 1, .focus_x = 2 });
    _ = try f.owner.sceneSetTextSelection(detached, .{ .operation = 1, .behavior = 1 });
    try f.owner.sceneMoveNode(text, f.root, 0);
    try f.cli.getNextBuffer().scissor_stack.ensureTotalCapacity(f.owner.allocator, 1);
    try f.cli.getNextBuffer().opacity_stack.ensureTotalCapacity(f.owner.allocator, 1);
    try (try f.owner.getSession(f.id)).scene.?.work.ensureTotalCapacity(f.owner.allocator, 3);
    failing.fail_index = failing.alloc_index;
    try testing.expectError(error.OutOfMemory, f.owner.scenePaint(f.id, .{ 0, 0, 0, 255 }, true, 0));
    try testing.expectEqual(@as(usize, 0), f.cli.getNextBuffer().scissor_stack.items.len);
    try testing.expectEqual(@as(usize, 0), f.cli.getNextBuffer().opacity_stack.items.len);
    try testing.expectError(error.YogaPoisoned, f.owner.sceneSetText(text, "rejected"));
    try testing.expectError(error.YogaPoisoned, f.owner.sceneSetTextSelection(text, .{ .operation = 1 }));
    try testing.expect(try f.owner.sceneSetTextSelection(text, .{ .operation = 0 }));
    try testing.expectEqual(@as(u32, 17), try f.owner.sceneGetText(text, &.{}));
    // Teardown below must not allocate, including the detached text resource.
    failing.resize_fail_index = failing.resize_index;
}

test "Scene text fully clipped coordinates never enter signed drawing arithmetic" {
    const f = try Fixture.init(testing.allocator, 4, 2, .{});
    defer f.deinit();
    const text = try f.owner.sceneCreateNode(f.id, 2, 2);
    try f.owner.sceneSetText(text, "offscreen");
    try dimensions(f.owner, text, 3, 1);
    try f.owner.sceneMoveNode(text, f.root, 0);
    try f.owner.sceneSetPaint(text, .{ .translateY = std.math.minInt(i32) });
    try f.owner.scenePaint(f.id, .{ 0, 0, 0, 255 }, true, 0);
    for (f.cli.getNextBuffer().buffer.char) |char| try testing.expectEqual(@as(u32, ' '), char);
    for (f.cli.nextHitGrid) |hit| try testing.expectEqual(@as(u32, 0), hit);
}

test "Scene owns and iteratively destroys 10000 registered nodes including detached boxes" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const f = try Fixture.init(failing.allocator(), 2, 2, .{ .limits = .{ .object_capacity = 10001 } });
    defer f.deinit();
    var last = f.root;
    for (1..10000) |index| {
        last = try f.owner.sceneCreateNode(f.id, 1, @intCast(index + 1));
        if (index % 2 == 0) try f.owner.sceneMoveNode(last, f.root, @intCast(index / 2 - 1));
    }
    try testing.expectError(error.ObjectLimit, f.owner.sceneCreateNode(f.id, 1, 10001));
    failing.fail_index = failing.alloc_index;
    failing.resize_fail_index = failing.resize_index;
    yoga.testFailAfter(0);
    defer yoga.testFailAfter(-1);
    try f.owner.destroy(f.id);
    try testing.expectEqual(@as(u32, 0), f.owner.objects.live_count);
    try testing.expectError(error.StaleHandle, f.owner.getRenderable(last));
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

test "Scene compound paint prepares all borders before accepting paint properties" {
    defer yoga.testFailAfter(-1);
    var failures: usize = 0;
    for (0..64) |fail_after| {
        yoga.testFailAfter(-1);
        const f = try Fixture.init(testing.allocator, 8, 4, .{});
        defer f.deinit();
        const box = try f.owner.sceneCreateNode(f.id, 1, 2);
        for (2..7) |kind| try f.owner.sceneSetStyle(box, 2, @intCast(kind), 0, 1, 3.25, 0);
        const before = (try f.owner.getRenderable(box)).scene_node.?.paint;
        const layout_before = try f.owner.sceneGetLayout(box, false);
        yoga.testFailAfter(@intCast(fail_after));
        const outcome = f.owner.sceneSetPaint(box, .{ .borderSides = 15, .zIndex = 10, .translateX = 7, .background = .{ 255, 0, 0, 255 } });
        yoga.testFailAfter(-1);
        if (outcome) |_| break else |err| {
            try testing.expectEqual(error.OutOfMemory, err);
            failures += 1;
            try testing.expectEqualDeep(before, (try f.owner.getRenderable(box)).scene_node.?.paint);
            try testing.expectEqualDeep(layout_before, try f.owner.sceneGetLayout(box, false));
            for (0..4) |edge| try testing.expectEqual(@as(f32, 0), (try f.owner.sceneGetStyle(box, 3, 0, @intCast(edge))).value);
            try f.owner.sceneSetPaint(box, .{ .borderSides = 15 });
            for (0..4) |edge| try testing.expectEqual(@as(f32, 1), (try f.owner.sceneGetStyle(box, 3, 0, @intCast(edge))).value);
        }
    }
    try testing.expect(failures > 0 and failures < 64);
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
    try testing.expect((try owner.getRenderable(box)).scene_node.?.parent == null);
    try testing.expect(yoga.yogaNodeGetParent((try owner.getRenderable(box)).yoga_node) == null);
    try owner.sceneMoveNode(box, root, 0);
    try owner.scenePaint(id, .{ 0, 0, 0, 255 }, true, 0);
    const before = try owner.sceneGetLayout(box, false);
    try dimensions(owner, box, 4, 2);
    yoga.testFailAfter(0);
    try testing.expectError(error.OutOfMemory, owner.scenePaint(id, .{ 0, 0, 0, 255 }, true, 0));
    yoga.testFailAfter(-1);
    try testing.expectEqualDeep(before, try owner.sceneGetLayout(box, false));
    try testing.expectError(error.YogaPoisoned, owner.scenePaint(id, .{ 0, 0, 0, 255 }, true, 0));
    try testing.expectError(error.YogaPoisoned, owner.sceneGetLayout(box, true));
    try testing.expectEqual(@as(u64, 0), (try owner.getSession(id)).getStats().bytes_written);
    try testing.expectEqual(@as(u32, 0), try owner.sceneHitTest(id, 0, 0));
    try owner.sceneDestroyNode(root);
    try owner.sceneDestroyNode(box);
}

test "Scene immediate transform queries reject ancestor overflow without changing local geometry" {
    const f = try Fixture.init(testing.allocator, 4, 2, .{});
    defer f.deinit();
    const child = try f.owner.sceneCreateNode(f.id, 1, 2);
    try dimensions(f.owner, child, 1, 1);
    try f.owner.sceneMoveNode(child, f.root, 0);
    try f.owner.scenePaint(f.id, frame_options.background, true, 0);
    const local = try f.owner.sceneGetLayout(child, true);
    try f.owner.sceneSetPaint(f.root, .{ .translateX = std.math.floatMax(f64) });
    try f.owner.sceneSetPaint(child, .{ .translateX = std.math.floatMax(f64) });
    try testing.expectError(error.InvalidDimensions, f.owner.sceneGetLayout(child, false));
    try testing.expectEqualDeep(local, try f.owner.sceneGetLayout(child, true));
    try f.owner.sceneSetPaint(child, .{});
    try testing.expect(std.math.isFinite((try f.owner.sceneGetLayout(child, false)).screenX));
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
        try f.owner.scenePaint(f.id, .{ 0, 0, 0, 255 }, true, 0);
        try testing.expectEqual(ansi.rgbColor(0, 200, 0, 255), f.cli.getNextBuffer().get(0, 0).?.bg);
        _ = try f.owner.renderSession(f.id, true);
        try drain(f.owner, f.id);
        try testing.expectEqual(@as(u32, 3), try f.owner.sceneHitTest(f.id, 0, 0));
    }
}
