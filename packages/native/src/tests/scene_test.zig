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
const utils = @import("../utils.zig");
const c = @import("context_abi_c");

test {
    _ = @import("scene_editor_test.zig");
    _ = @import("scene_scroll_test.zig");
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
    try testing.expectEqual(@as(u32, 0), f.draftHit(3));
    try testing.expectEqual((try f.owner.raw().getRenderable(child)).scene_node.?.token, f.draftHit(2));
    try testing.expectEqual((try f.owner.raw().getRenderable(parent)).scene_node.?.token, f.draftHit(8));
    try testing.expectEqual((try f.owner.raw().getRenderable(peer)).scene_node.?.token, f.draftHit(4));

    try f.owner.sceneSetPaint(peer, .{ .background = .{ 0, 200, 0, 255 } });
    try repaint(f.owner, f.id, frame_options.background, true, 0);
    try testing.expectEqual(ansi.rgbColor(0, 200, 0, 255), f.cli.getNextBuffer().get(4, 0).?.bg);
    try testing.expectEqual(@as(usize, 0), f.cli.getNextBuffer().scissor_stack.items.len);
    try testing.expectEqual(@as(usize, 0), f.cli.getNextBuffer().opacity_stack.items.len);
}

// GitHub #1852: Yoga shrinks a one-row text above a 20-row sibling in a 4-row column to zero
// rows. It keeps its one-cell public height but paints and hits no cell under the sibling.
test "Scene node that flex shrink sizes to zero paints and hits no cell" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const header = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_TEXT, 2);
    try f.owner.sceneSetText(header, "header");
    const list = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_BOX, 3);
    try f.owner.sceneSetStyle(list, c.OT_STYLE_DIMENSION, c.OT_DIMENSION_HEIGHT, 0, c.OT_UNIT_POINT, 20, 0);
    for ([_]context.Handle{ header, list }, 0..) |node, index| {
        try f.owner.sceneSetStyle(node, c.OT_STYLE_FLOAT, c.OT_STYLE_FLOAT_FLEX_SHRINK, 0, 0, 1, 0);
        try f.owner.sceneMoveNode(node, f.root, @intCast(index));
    }
    try repaint(f.owner, f.id, frame_options.background, true, 0);
    try testing.expectEqual(@as(f32, 0), (try f.owner.sceneGetPaintLayout(header)).height);
    try testing.expectEqual(@as(f32, 1), (try f.owner.sceneGetLayout(header, false)).height);
    try testing.expectEqual(@as(u32, ' '), f.cli.getNextBuffer().get(0, 0).?.char);
    const token = (try f.owner.raw().getRenderable(header)).scene_node.?.token;
    for (f.state.hits.items) |hit| try testing.expect(hit.token != token);
    // A host draws its body as paint would: nothing.
    const target = try f.owner.createBuffer(8, 1, .{});
    try f.owner.drawSceneBody(target, null, header, 0, 0);
    try testing.expect((try f.owner.raw().getBuffer(target)).get(0, 0).?.char != 'h');
}

test "Scene hit walk answers what a grid overwritten in paint order holds" {
    var prng = std.Random.DefaultPrng.init(0x316);
    const random = prng.random();
    var hits: [24]scene.Hit = undefined;
    var grid: [9 * 5]u32 = undefined;
    for (0..2000) |_| {
        const count = random.uintAtMost(usize, hits.len);
        @memset(&grid, 0);
        for (hits[0..count], 0..) |*hit, index| {
            const x = random.uintLessThan(u32, 9);
            const y = random.uintLessThan(u32, 5);
            // Ties between tokens and full or one-cell rects are common.
            hit.* = .{ .x = x, .y = y, .width = random.intRangeAtMost(u32, 1, 9 - x), .height = random.intRangeAtMost(u32, 1, 5 - y), .token = random.intRangeAtMost(u32, 1, 4) + @as(u32, @intCast(index % 2)) };
            for (hit.y..hit.y + hit.height) |row| @memset(grid[row * 9 + hit.x ..][0..hit.width], hit.token);
        }
        for (grid, 0..) |token, cell| {
            const found = scene.topmostHit(hits[0..count], @intCast(cell % 9), @intCast(cell / 9));
            try testing.expectEqual(token, if (found) |index| hits[index].token else 0);
        }
    }
}

test "Scene geometry cache retries a failed third solve in one frame with clean Yoga" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const box = try f.owner.sceneCreateNode(f.id, 1, 2);
    try dimensions(f.owner, box, 3, 1);
    try f.owner.sceneMoveNode(box, f.root, 0);
    const slider = try f.owner.sceneCreateNode(f.id, 3, 3);
    try dimensions(f.owner, slider, 4, 1);
    // The thumb offset of this accepted value fits width 4 and overflows at width 5.
    try f.owner.sceneSetSlider(slider, .{ .max = 1, .value = 4e307, .viewport_size = 1 });
    try f.owner.sceneMoveNode(slider, f.root, 1);
    try f.owner.sceneSetHooks(f.root, 4, 1, 0, 0);
    const node = (try f.owner.raw().getRenderable(box)).scene_node.?;
    var request = try f.step(null, frame_options, 3, null);
    try testing.expectEqual(f.state.candidates_gen, node.prepared_gen);
    const gen = node.prepared_gen;
    const frame_id = request.frame_id;
    const epoch = request.layout_epoch;
    try dimensions(f.owner, box, 4, 1);
    request = try f.step(request, frame_options, 3, null);
    try testing.expectEqual(frame_id, request.frame_id);
    try testing.expectEqual(epoch + 1, request.layout_epoch);
    try testing.expectEqual(gen + 1, node.prepared_gen);
    try testing.expectEqual(@as(f32, 3), (try f.owner.sceneGetLayout(box, false)).width);

    try dimensions(f.owner, box, 5, 1);
    // The slider fails preparation only after the third Yoga solve.
    try dimensions(f.owner, slider, 5, 1);
    try testing.expectError(error.InvalidOptions, f.owner.sceneFrameStep(f.id, request, frame_options));
    try testing.expect(f.state.attempt == null and f.state.candidates.items.len == 0 and f.state.feedback.items.len == 0);
    try testing.expectEqual(epoch + 2, f.state.layout_epoch);
    // The failed walk stamped nothing, so the next one reads the third solve's geometry.
    try testing.expectEqual(gen + 1, node.prepared_gen);
    try testing.expectEqual(epoch + 1, node.geometry_epoch);
    var dirty: u32 = 1;
    try yoga.check(yoga.yogaNodeIsDirtyChecked((try f.owner.raw().getRenderable(f.root)).yoga_node, &dirty));
    try testing.expectEqual(@as(u32, 0), dirty);
    try testing.expectEqual(@as(f32, 4), (try f.owner.sceneGetLayout(box, false)).width);

    try f.owner.sceneSetPaint(box, .{ .background = .{ 200, 0, 0, 255 } });
    try f.owner.sceneSetSlider(slider, .{});
    request = try f.step(null, frame_options, 3, null);
    try testing.expectEqual(frame_id + 1, request.frame_id);
    try testing.expectEqual(epoch + 2, request.layout_epoch);
    try testing.expectEqual(@as(f32, 4), (try f.owner.sceneGetLayout(box, false)).width);
    try testing.expectEqual(@as(u32, 0), (try f.owner.sceneFrameStep(f.id, request, frame_options)).kind);
    try testing.expectEqual(@as(f32, 5), (try f.owner.sceneGetLayout(box, false)).width);
    try testing.expectEqual(ansi.rgbColor(200, 0, 0, 255), f.cli.getNextBuffer().get(4, 0).?.bg);
    try testing.expectEqual(node.token, f.draftHit(4));
    try testing.expectEqual(@as(u32, 0), f.draftHit(5));
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

/// One random change to a culled scene, the same in both twins. Frame 0 builds it: a filtering
/// parent (a content box bound to a viewport box, or a culling scroll node) with 24 children
/// in flow, absolute (spanning or out of order), hidden, translated, or with z ties.
fn cullStep(f: Fixture, random: std.Random, nodes: []context.Handle, frame: usize) !void {
    // Window and parent positions: small, fractional, at the 2^24 bound, near 2^55, f32's limit.
    const shifts = [_]f64{ 0, 0.1, -0.5, -0.75, -20, -(1 << 24) + 2, -(1 << 24) - 2, 1 << 24, (1 << 55) - 4, 1 << 55, -(1 << 60), -3.4e38, 3.4e38 };
    const parent = nodes[nodes.len - 2];
    const viewport = nodes[nodes.len - 1];
    const rows = nodes[0 .. nodes.len - 2];
    const shift = shifts[random.uintLessThan(usize, shifts.len)];
    if (frame == 0) {
        if (random.uintLessThan(u32, 4) == 0) {
            try f.owner.sceneSetScroll(parent, .{ .axes = 3, .culling = true });
            try dimensions(f.owner, parent, 8, 4);
        } else {
            try dimensions(f.owner, viewport, 8, 4);
            try f.owner.sceneSetStyle(parent, c.OT_STYLE_FLOAT, c.OT_STYLE_FLOAT_FLEX_SHRINK, 0, 0, 0, 0);
            try f.owner.sceneSetViewport(parent, viewport);
        }
        // The viewport box updates before the parent selects, so its replies come first.
        try f.owner.sceneMoveNode(viewport, f.root, 0);
        try f.owner.sceneSetHooks(viewport, c.OT_SCENE_HOOK_UPDATE, 1, 0, 0);
        try f.owner.sceneMoveNode(parent, f.root, 0);
        const direction = if (random.boolean()) 0 else random.uintLessThan(u32, 4);
        try f.owner.sceneSetStyle(parent, c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_FLEX_DIRECTION, 0, 0, @floatFromInt(direction), 0);
        if (random.uintLessThan(u32, 8) == 0) try f.owner.sceneSetStyle(parent, c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_FLEX_WRAP, 0, 0, 1, 0);
        for (rows, 0..) |*row, index| {
            row.* = try f.owner.sceneCreateNode(f.id, 1, @intCast(index + 10));
            const size: f32 = @floatFromInt(random.intRangeAtMost(u32, 1, 3));
            try dimensions(f.owner, row.*, size, size);
            try f.owner.sceneSetStyle(row.*, c.OT_STYLE_FLOAT, c.OT_STYLE_FLOAT_FLEX_SHRINK, 0, 0, 0, 0);
            try f.owner.sceneSetPaint(row.*, .{ .background = .{ @intCast(index * 10), 0, 0, 255 } });
            if (random.uintLessThan(u32, 4) != 0) try f.owner.sceneSetHooks(row.*, c.OT_SCENE_HOOK_UPDATE, 1, 0, 0);
            try f.owner.sceneMoveNode(row.*, parent, @intCast(index));
        }
        // A spanning child before the rest, as a tall log row, or one Yoga cannot add up.
        if (random.boolean()) try dimensions(f.owner, rows[0], 8, 40);
        if (random.uintLessThan(u32, 8) == 0) try dimensions(f.owner, rows[random.uintLessThan(usize, rows.len)], 3e38, 3e38);
    }
    const row = rows[random.uintLessThan(usize, rows.len)];
    switch (random.uintLessThan(u32, 12)) {
        0 => try f.owner.sceneSetStyle(row, c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_DISPLAY, 0, 0, @floatFromInt(random.uintLessThan(u32, 2)), 0),
        // One axis or both: a patch may move a row on either axis alone.
        1 => try f.owner.scenePatchPaint(row, ([_]u32{ c.OT_SCENE_PROPERTY_TRANSLATE_Y, c.OT_SCENE_PROPERTY_TRANSLATE_X, c.OT_SCENE_PROPERTY_TRANSLATE_Y | c.OT_SCENE_PROPERTY_TRANSLATE_X })[random.uintLessThan(usize, 3)], if (random.uintLessThan(u32, 4) == 0) .{} else .{
            .translateX = @floatFromInt(random.intRangeAtMost(i32, -2, 2)),
            .translateY = @as(f64, @floatFromInt(random.intRangeAtMost(i32, -48, 48))) / 2,
        }),
        2 => try f.owner.scenePatchPaint(row, c.OT_SCENE_PROPERTY_Z_INDEX, .{ .zIndex = random.intRangeAtMost(i32, -1, 1) }),
        // Inserted before a sibling, or prepended as a backfilled row: it paints last.
        3 => try cullMove(f, random, row, parent),
        4 => if (random.uintLessThan(u32, 3) == 0) {
            try f.owner.sceneSetStyle(row, c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_POSITION_TYPE, 0, 0, c.OT_POSITION_ABSOLUTE, 0);
            try f.owner.sceneSetPositions(row, 3, .{ 1, 1, 0, 0 }, .{ @floatFromInt(random.intRangeAtMost(i32, -2, 30)), @floatFromInt(random.intRangeAtMost(i32, -2, 30)), 0, 0 });
        } else try dimensions(f.owner, row, 2, @floatFromInt(random.intRangeAtMost(u32, 1, 4))),
        5, 6 => if ((try f.owner.raw().getRenderable(parent)).scene_node.?.scroll != null) {
            _ = try f.owner.sceneScrollTo(parent, .{ @floatFromInt(random.uintLessThan(u32, 40)), @floatFromInt(random.uintLessThan(u32, 40)) }, .{ false, false }, false);
        } else {
            // Half the time back home, where the index serves.
            const at = if (random.boolean()) shift else 0;
            try f.owner.scenePatchPaint(viewport, c.OT_SCENE_PROPERTY_TRANSLATE_Y | c.OT_SCENE_PROPERTY_TRANSLATE_X, .{ .translateX = at, .translateY = at });
        },
        // A tenth of a cell: sums that round apart from the window's edges.
        else => try f.owner.scenePatchPaint(parent, c.OT_SCENE_PROPERTY_TRANSLATE_Y | c.OT_SCENE_PROPERTY_TRANSLATE_X, .{
            .translateX = shift / 4,
            .translateY = if (random.uintLessThan(u32, 4) == 0) shift else -@as(f64, @floatFromInt(random.uintLessThan(u32, 600))) / 10,
        }),
    }
}

/// Moves a child within its parent, into it, or out to the root.
fn cullMove(f: Fixture, random: std.Random, row: context.Handle, parent: context.Handle) !void {
    if (random.uintLessThan(u32, 4) == 0) return f.owner.sceneMoveNode(row, f.root, 0);
    const node = (try f.owner.raw().getRenderable(parent)).scene_node.?;
    const inside = (try f.owner.raw().getRenderable(row)).scene_node.?.parent == try f.owner.raw().getRenderable(parent);
    const count: u32 = @intCast(node.children.items.len - @intFromBool(inside));
    try f.owner.sceneMoveNode(row, parent, if (random.boolean()) 0 else random.uintAtMost(u32, count));
}

/// The first of the 24 rows from `start` that is not in the parent, or `start`.
fn cullOutside(f: Fixture, nodes: []const context.Handle, start: usize) !usize {
    const parent = try f.owner.raw().getRenderable(nodes[24]);
    for (0..24) |offset| {
        const slot = (start + offset) % 24;
        if ((try f.owner.raw().getRenderable(nodes[slot])).scene_node.?.parent != parent) return slot;
    }
    return start;
}

// Exact culling (B2b): the index only narrows which children a filtering parent tests, so the
// requests, the paint list, and the cells equal those of the full path, which tests them all.
// Replies, before the parent selects and after, move, destroy, add, and raise or lower rows, and
// turn the parent's main axis.
test "Scene viewport culling selects and paints what the full path's scan does" {
    for (0..400) |seed| {
        const twins = [2]Fixture{ try Fixture.init(testing.allocator, 8, 4, .{}), try Fixture.init(testing.allocator, 8, 4, .{}) };
        defer for (twins) |f| f.deinit();
        try twins[0].owner.sceneSetDebugFlags(twins[0].id, c.OT_SCENE_DEBUG_FULL_FRAME);
        var prngs = [2]std.Random.DefaultPrng{ .init(seed), .init(seed) };
        var nodes: [2][26]context.Handle = undefined;
        for (twins, &nodes) |f, *twin_nodes| {
            twin_nodes[24] = try f.owner.sceneCreateNode(f.id, 1, 2);
            twin_nodes[25] = try f.owner.sceneCreateNode(f.id, 1, 3);
        }
        for (0..16) |frame| {
            var logs: [2][64]u32 = undefined;
            var counts: [2]usize = .{ 0, 0 };
            for (twins, &prngs, &nodes, &logs, &counts) |f, *prng, *twin_nodes, *log, *count| {
                const random = prng.random();
                try cullStep(f, random, &twin_nodes.*, frame);
                var request = try f.owner.sceneFrameStep(f.id, null, frame_options);
                while (request.kind != 0) : (request = try f.owner.sceneFrameStep(f.id, request, frame_options)) {
                    log[count.*] = request.num;
                    count.* += 1;
                    const slot = random.uintLessThan(usize, 24);
                    // The viewport box's reply comes before the parent selects: it moves, raises or lowers
                    // a row, or turns the parent's main axis.
                    switch (if (request.num == 3) ([_]u32{ 0, 1, 3 })[random.uintLessThan(usize, 3)] else random.uintLessThan(u32, 6)) {
                        // From the viewport box, a row outside the parent, prepared where it was, moves in.
                        0 => try cullMove(f, random, twin_nodes[if (request.num == 3) try cullOutside(f, twin_nodes, slot) else slot], twin_nodes[24]),
                        // A destroyed row's place is taken by a new one, which moves in.
                        2 => {
                            try f.owner.sceneDestroyNode(twin_nodes[slot]);
                            twin_nodes[slot] = try f.owner.sceneCreateNode(f.id, 1, @intCast(100 + slot));
                            try cullMove(f, random, twin_nodes[slot], twin_nodes[24]);
                        },
                        1 => try f.owner.sceneSetStyle(twin_nodes[24], c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_FLEX_DIRECTION, 0, 0, @floatFromInt(2 * random.uintLessThan(u32, 2)), 0),
                        // Children stay unsorted until paint: selection follows the old order.
                        3 => try f.owner.scenePatchPaint(twin_nodes[slot], c.OT_SCENE_PROPERTY_Z_INDEX, .{ .zIndex = random.intRangeAtMost(i32, -1, 1) }),
                        else => {},
                    }
                }
                _ = try f.owner.sceneFrameCommit(f.id, request, false);
                try drain(f.owner, f.id);
            }
            try testing.expectEqualSlices(u32, logs[0][0..counts[0]], logs[1][0..counts[1]]);
            try twins[0].expectSameCells(twins[1]);
            const members = .{ twins[0].state.members.items, twins[1].state.members.items };
            try testing.expectEqual(members[0].len, members[1].len);
            for (members[0], members[1]) |expected, actual| {
                try testing.expectEqual(expected.node.scene_node.?.num, actual.node.scene_node.?.num);
                try testing.expect(std.mem.eql(u8, std.mem.asBytes(&expected.layout), std.mem.asBytes(&actual.layout)));
            }
        }
    }
}

// The index's 2^24 bounds: beyond them the scan's f64 sums round apart from the index's local
// positions by more than its cell of slack. Rows: the window near -2^54, where the spacing is 4,
// and row 19 three cells tall ends inside it only after rounding; a row at -2^60 that is 2^60
// tall ends at 0 in local terms but at 256 on screen, past the window's start at 20.
test "Scene viewport culling falls back to the scan beyond 2^24" {
    const rows = [_]struct { content: f64, viewport: f64, row: usize, top: f32, size: f32 }{
        .{ .content = -(1 << 54) - 40, .viewport = -(1 << 54) + 2, .row = 19, .top = 38, .size = 3 },
        .{ .content = 200, .viewport = 220, .row = 0, .top = -(1 << 60), .size = 1 << 60 },
    };
    for (rows) |case| {
        const twins = [2]Fixture{ try Fixture.init(testing.allocator, 8, 4, .{}), try Fixture.init(testing.allocator, 8, 4, .{}) };
        defer for (twins) |f| f.deinit();
        try twins[0].owner.sceneSetDebugFlags(twins[0].id, c.OT_SCENE_DEBUG_FULL_FRAME);
        var logs: [2][64]u32 = undefined;
        var counts: [2]usize = .{ 0, 0 };
        for (twins, &logs, &counts) |f, *log, *count| {
            const viewport = try f.owner.sceneCreateNode(f.id, 1, 3);
            const content = try f.owner.sceneCreateNode(f.id, 1, 2);
            for ([_]context.Handle{ viewport, content }, [_]f32{ 4, 130 }, [_]f64{ case.viewport, case.content }) |node, height, y| {
                try dimensions(f.owner, node, 8, height);
                try f.owner.sceneSetStyle(node, 0, 6, 0, 0, 2, 0);
                try f.owner.sceneSetPositions(node, 3, .{ 1, 1, 0, 0 }, .{ 0, 0, 0, 0 });
                try f.owner.sceneSetPaint(node, .{ .translateY = y });
                try f.owner.sceneMoveNode(node, f.root, 0);
            }
            try f.owner.sceneSetViewport(content, viewport);
            var children: [24]context.Handle = undefined;
            try filterChildren(f.owner, f.id, content, &children);
            try dimensions(f.owner, children[case.row], 8, case.size);
            try f.owner.sceneSetPositions(children[case.row], 3, .{ 1, 1, 0, 0 }, .{ 0, case.top, 0, 0 });
            try f.owner.sceneSetPaint(children[case.row], .{ .background = .{ 200, 0, 0, 255 } });
            for (children) |child| try f.owner.sceneSetHooks(child, 1, 1, 0, 0);
            var request = try f.owner.sceneFrameStep(f.id, null, frame_options);
            while (request.kind != 0) : (request = try f.owner.sceneFrameStep(f.id, request, frame_options)) {
                log[count.*] = request.num;
                count.* += 1;
            }
            _ = try f.owner.sceneFrameCommit(f.id, request, false);
            try drain(f.owner, f.id);
        }
        try testing.expectEqualSlices(u32, logs[0][0..counts[0]], logs[1][0..counts[1]]);
        try twins[0].expectSameCells(twins[1]);
    }
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
    // Feedback skips a hidden viewport child: no update request and no text view refresh.
    const hidden = try f.owner.sceneCreateNode(f.id, 2, 4);
    try f.owner.sceneSetText(hidden, "hidden");
    try f.owner.sceneSetStyle(hidden, 0, 9, 0, 0, 1, 0);
    try f.owner.sceneMoveNode(hidden, content, 16);
    try f.owner.sceneSetPaint(content, .{ .translateY = -20 });
    try repaint(f.owner, f.id, frame_options.background, true, 0);
    try f.owner.sceneSetPaint(content, .{});
    try repaint(f.owner, f.id, frame_options.background, true, 0);
    try dimensions(f.owner, slider, 8, 1);
    for (children) |child| try f.owner.sceneSetHooks(child, 1, 1, 10, 2);
    try f.owner.sceneSetHooks(hidden, 1, 1, 0, 0);
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
    try testing.expectEqual((try f.owner.raw().getRenderable(slider)).scene_node.?.token, f.draftHit(7));
    try testing.expectEqual((try f.owner.raw().getRenderable(children[10])).scene_node.?.token, f.draftHit(8));
    try testing.expect(f.state.attempt == null and f.state.feedback.items.len == 0);
    try testing.expect((try f.owner.raw().getRenderable(hidden)).scene_node.?.text.?.view.getViewport() == null);
}

fn viewportAllocationFailures(allocator: std.mem.Allocator) !void {
    const f = try Fixture.init(allocator, 8, 4, .{ .limits = .{ .object_capacity = 24 } });
    defer f.deinit();
    // A scroll node owns two Yoga nodes and its state; a child moves into its content node.
    const scroll = try f.owner.sceneCreateNode(f.id, 1, 4);
    try f.owner.sceneSetScroll(scroll, .{ .culling = true });
    try f.owner.sceneSetScrollArrow(scroll, 1, 0, .{ .text = "^" });
    try f.owner.sceneMoveNode(scroll, f.root, 0);
    try f.owner.sceneMoveNode(try f.owner.sceneCreateNode(f.id, 2, 5), scroll, 0);
    try f.owner.sceneSetHooks(scroll, c.OT_SCENE_HOOK_SCROLL, 1, 0, 0);
    const content = try f.owner.sceneCreateNode(f.id, 1, 2);
    try dimensions(f.owner, content, 8, 32);
    try f.owner.sceneMoveNode(content, f.root, 1);
    var children: [16]context.Handle = undefined;
    try filterChildren(f.owner, f.id, content, &children);
    const text = try f.owner.sceneCreateNode(f.id, 2, 3);
    try f.owner.sceneSetText(text, "e\xcc\x81 wrapped text");
    try f.owner.sceneMoveNode(text, children[0], 0);
    try f.owner.sceneSetViewport(content, f.root);
    try f.owner.sceneSetFocus(text, true);
    try f.owner.sceneSetHooks(children[0], 3, 1, 0, 0);
    var request: ?scene.FrameRequest = null;
    for (0..4) |_| {
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

test "Scene text draws a 129-byte grapheme as a blank cell" {
    const f = try Fixture.init(testing.allocator, 4, 2, .{});
    defer f.deinit();
    const node = try f.owner.sceneCreateNode(f.id, 2, 2);
    try dimensions(f.owner, node, 1, 1);
    try f.owner.sceneMoveNode(node, f.root, 0);
    const accepted = "e" ++ utils.repeat(u8, "\u{301}", 63);
    try f.owner.sceneSetText(node, accepted);
    try repaint(f.owner, f.id, .{ 0, 0, 0, 255 }, false, 0);
    const next = (try f.owner.raw().getSessionRenderer(f.id)).getNextBuffer();
    const char = next.get(0, 0).?.char;
    try testing.expect(gp.isGraphemeChar(char));
    try testing.expectEqualStrings(accepted, try f.owner.graphemes.get(gp.graphemeIdFromChar(char)));

    // The grapheme pool cannot hold this cluster, so it draws as a space instead of failing the frame.
    const blank = "e" ++ utils.repeat(u8, "\u{301}", 64);
    try testing.expectEqual(@as(usize, 129), blank.len);
    try f.owner.sceneSetText(node, blank);
    try repaint(f.owner, f.id, .{ 0, 0, 0, 255 }, false, 0);
    try testing.expectEqual(@as(u32, ' '), next.get(0, 0).?.char);
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
    try f.owner.sceneSetText(node, "\xe4\xb8\xad tail\n" ++ utils.repeat(u8, "x", 65536));
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

test "Scene cell layout keeps in-range axes and the truncated visible cells of the rest" {
    const inf = std.math.inf(f64);
    const nan = std.math.nan(f64);
    // start, size -> clamped start, size. Paint covers trunc(start) .. trunc(start) + trunc(size).
    for ([_][4]f64{
        .{ -2147483648, 2147483520, -2147483648, 2147483520 },
        .{ 2.5, 3.75, 2.5, 3.75 },
        .{ -3e9 + 2.5, 3e9, -4194304, 4194307 },
        .{ -2e9, 3e9, -4194304, 8388608 },
        .{ 1e9, 2e9, 4194303, 1 },
        .{ -3e9, 1e10, -4194304, 8388608 },
        .{ nan, 4, -4194304, 1 },
        .{ 5, nan, 5, 1 },
        .{ -inf, inf, -4194304, 1 },
        .{ 3, inf, 3, 4194301 },
        // A zero size stays zero, so the node paints no cell.
        .{ 3e9, 0, 4194303, 0 },
    }) |row| {
        const cells = scene.cellLayout(.{ .screenX = row[0], .width = @floatCast(row[1]) });
        try testing.expectEqual([2]f64{ row[2], row[3] }, [2]f64{ cells.screenX, cells.width });
    }
}

test "Scene text fully clipped coordinates never enter signed drawing arithmetic" {
    const f = try Fixture.init(testing.allocator, 4, 2, .{});
    defer f.deinit();
    const text = try f.owner.sceneCreateNode(f.id, 2, 2);
    try f.owner.sceneSetText(text, "offscreen");
    try dimensions(f.owner, text, 3, 1);
    try f.owner.sceneMoveNode(text, f.root, 0);
    const max = std.math.floatMax(f32);
    try testing.expectError(error.InvalidOptions, f.owner.sceneSetPaint(text, .{ .translateX = @as(f64, max) * 2 }));
    // Translations beyond the i32 cell range clamp instead of failing the frame.
    for ([_][2]f64{ .{ 0, std.math.minInt(i32) }, .{ 0, std.math.maxInt(i32) }, .{ -max, 0 }, .{ max, -max } }) |translate| {
        try f.owner.sceneSetPaint(text, .{ .translateX = translate[0], .translateY = translate[1] });
        try repaint(f.owner, f.id, .{ 0, 0, 0, 255 }, true, 0);
        for (f.cli.getNextBuffer().buffer.char) |char| try testing.expectEqual(@as(u32, ' '), char);
        try testing.expectEqual(@as(usize, 0), f.state.hits.items.len);
    }
}

test "Scene owns and iteratively destroys registered nodes including detached boxes" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const f = try Fixture.init(failing.allocator(), 2, 2, .{ .limits = .{ .object_capacity = 513 } });
    defer f.deinit();
    f.owner.objects.slot_count_max = 513;
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
