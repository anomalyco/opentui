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
    try f.owner.sceneFrameCancel(f.id, (try f.drive(null, options, 1)).frame_id);
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
        try f.owner.sceneFrameCancel(f.id, (try f.drive(null, options, 1)).frame_id);
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

/// A random scene that two fixtures build identically from one seed.
const Model = struct {
    const node_max = 16;
    nodes: [node_max]context.Handle = undefined,
    boxes: [node_max]bool = undefined,
    alive: [node_max]bool = undefined,
    count: usize = 0,

    fn build(self: *Model, f: Fixture, random: std.Random) !void {
        if (random.boolean()) try f.owner.sceneSetHooks(f.root, c.OT_SCENE_HOOK_UPDATE | c.OT_SCENE_HOOK_LAYOUT_CHANGED * @as(u32, @intFromBool(random.boolean())), 1, 12, 4);
        for (0..3 + random.uintLessThan(usize, 9)) |_| try self.add(f, random);
    }

    fn add(self: *Model, f: Fixture, random: std.Random) !void {
        const index = self.count;
        const kind: u32 = switch (random.uintLessThan(u8, 6)) {
            0 => c.OT_SCENE_TEXT,
            1 => c.OT_SCENE_CUSTOM,
            else => c.OT_SCENE_BOX,
        };
        const handle = try f.owner.sceneCreateNode(f.id, kind, @intCast(index + 2));
        self.nodes[index] = handle;
        self.boxes[index] = kind == c.OT_SCENE_BOX;
        self.alive[index] = true;
        self.count += 1;
        // Custom nodes take half their parent's width, so resizing the parent resizes them.
        const width: f32 = if (kind == c.OT_SCENE_CUSTOM) 50 else @floatFromInt(1 + random.uintLessThan(u32, 6));
        try f.owner.sceneSetStyle(handle, 4, 0, 0, if (kind == c.OT_SCENE_CUSTOM) 2 else 1, width, 1);
        try f.owner.sceneSetStyle(handle, 4, 1, 0, 1, @floatFromInt(1 + random.uintLessThan(u32, 3)), 1);
        if (random.boolean()) try f.owner.sceneSetStyle(handle, 0, 6, 0, 0, 2, 0);
        if (random.uintLessThan(u8, 5) == 0) try f.owner.sceneSetStyle(handle, 0, 9, 0, 0, 1, 0);
        if (kind == c.OT_SCENE_TEXT) try f.owner.sceneSetText(handle, "ab cd ef");
        if (kind == c.OT_SCENE_CUSTOM) try f.owner.sceneSetHooks(handle, c.OT_SCENE_HOOK_RESIZE, 1, 0, 0);
        if (kind == c.OT_SCENE_BOX) {
            if (random.uintLessThan(u8, 3) == 0) try f.owner.sceneSetStyle(handle, 0, 8, 0, 0, 1, 0);
            if (random.uintLessThan(u8, 6) == 0) try f.owner.sceneSetViewport(handle, handle);
        }
        // Equal z-indices keep insertion order; a frame never re-sorts siblings it already ordered.
        try f.owner.sceneSetPaint(handle, .{
            .translateX = @floatFromInt(random.uintLessThan(u32, 8)),
            .translateY = @floatFromInt(random.uintLessThan(u32, 3)),
            .borderSides = if (kind == c.OT_SCENE_BOX and random.boolean()) c.OT_BORDER_ALL else 0,
            .background = .{ @intCast(index * 15 + 10), @intCast(250 - index * 15), 0, 255 },
        });
        var parents: [node_max + 1]context.Handle = undefined;
        parents[0] = f.root;
        var parent_count: usize = 1;
        for (0..index) |candidate| {
            if (!self.alive[candidate] or !self.boxes[candidate]) continue;
            parents[parent_count] = self.nodes[candidate];
            parent_count += 1;
        }
        try f.owner.sceneMoveNode(handle, parents[random.uintLessThan(usize, parent_count)], 0);
    }

    fn mutate(self: *Model, f: Fixture, random: std.Random) !void {
        const index = random.uintLessThan(usize, self.count);
        const handle = self.nodes[index];
        if (!self.alive[index]) return;
        switch (random.uintLessThan(u8, 7)) {
            0 => try f.owner.sceneSetStyle(handle, 4, 0, 0, 1, @floatFromInt(1 + random.uintLessThan(u32, 6)), 1),
            1 => try f.owner.scenePatchPaint(handle, c.OT_SCENE_PROPERTY_TRANSLATE_X, .{ .translateX = @floatFromInt(random.uintLessThan(u32, 8)) }),
            2 => try f.owner.sceneSetStyle(handle, 0, 9, 0, 0, @floatFromInt(random.uintLessThan(u32, 2)), 0),
            3 => try f.owner.scenePatchPaint(handle, c.OT_SCENE_PROPERTY_BACKGROUND, .{ .background = .{ 0, 0, 200, 255 } }),
            4 => try f.owner.sceneMoveNode(handle, if (random.boolean()) f.root else null, 0),
            5 => {
                try f.owner.sceneDestroyNode(handle);
                self.alive[index] = false;
            },
            else => if (self.count < node_max) try self.add(f, random),
        }
    }
};

fn expectSameFrame(bounded: Fixture, synchronous: Fixture, models: *const [2]Model) !void {
    const expected = synchronous.cli.getNextBuffer().buffer;
    const actual = bounded.cli.getNextBuffer().buffer;
    try testing.expectEqualSlices(u32, expected.char, actual.char);
    try testing.expectEqualSlices(ansi.RGBA, expected.fg, actual.fg);
    try testing.expectEqualSlices(ansi.RGBA, expected.bg, actual.bg);
    try testing.expectEqualSlices(u32, expected.attributes, actual.attributes);
    try testing.expectEqualSlices(u32, synchronous.cli.nextHitGrid, bounded.cli.nextHitGrid);
    for (models[0].nodes[0..models[0].count], models[1].nodes[0..models[0].count], models[0].alive[0..models[0].count]) |handle, twin, alive| {
        if (!alive) continue;
        // Hidden and detached nodes keep stale prepared geometry; only painted members must agree.
        const token = (try bounded.owner.raw().getRenderable(handle)).scene_node.?.token;
        if (std.mem.indexOfScalar(u32, bounded.cli.nextHitGrid, token) == null) continue;
        try testing.expectEqualDeep(try synchronous.owner.sceneGetPaintLayout(twin), try bounded.owner.sceneGetPaintLayout(handle));
        try testing.expectEqualDeep(try synchronous.owner.sceneGetLayout(twin, false), try bounded.owner.sceneGetLayout(handle, false));
    }
}

/// Paints one random scene with a work budget, mutating it at yields, and compares the
/// result with a synchronous frame of a twin scene that received the same mutations first.
fn expectBoundedMatchesSynchronous(seed: u64) !void {
    var drive = std.Random.DefaultPrng.init(seed ^ 0x9e3779b97f4a7c15);
    var mutations: [2]std.Random.DefaultPrng = .{ .init(seed), .init(seed) };
    var models: [2]Model = .{ .{}, .{} };
    const fixtures = [2]Fixture{
        try Fixture.init(testing.allocator, 12, 4, .{ .output = transport }),
        try Fixture.init(testing.allocator, 12, 4, .{ .output = transport }),
    };
    defer for (fixtures) |f| f.deinit();
    for (fixtures, &models, &mutations) |f, *model, *random| {
        try model.build(f, random.random());
        // After a first frame, preparation refreshes moved and resized nodes, not only new placements.
        try f.owner.sceneFrameCancel(f.id, (try f.drive(null, options, std.math.maxInt(u32))).frame_id);
        for (0..seed % 4) |_| try model.mutate(f, random.random());
    }
    const bounded = fixtures[0];
    // Unchanged yields consume no layout round; a yielded mutation restarts preparation once.
    const mutating = drive.random().boolean();
    var limits = options;
    limits.max_layout_rounds = if (mutating) 2 else 1;
    limits.max_host_requests = 256;
    var applied: u32 = 0;
    var previous: ?scene.FrameRequest = null;
    const budgets = [_]u32{ 1, 2, 3, 7, std.math.maxInt(u32) };
    const done = for (0..4096) |_| {
        const budget = budgets[drive.random().uintLessThan(usize, budgets.len)];
        const request = try bounded.owner.sceneFrameStepWorkBudgeted(bounded.id, previous, limits, budget);
        if (request.kind == c.OT_SCENE_FRAME_DONE) break request;
        if (mutating and request.kind == c.OT_SCENE_FRAME_YIELD and applied < 8 and drive.random().boolean()) {
            try models[0].mutate(bounded, mutations[0].random());
            applied += 1;
        }
        previous = request;
    } else return error.TestUnexpectedResult;
    for (0..applied) |_| try models[1].mutate(fixtures[1], mutations[1].random());
    const synchronous = try fixtures[1].drive(null, limits, std.math.maxInt(u32));
    try expectSameFrame(bounded, fixtures[1], &models);
    try bounded.owner.sceneFrameCancel(bounded.id, done.frame_id);
    try fixtures[1].owner.sceneFrameCancel(fixtures[1].id, synchronous.frame_id);
}

test "Scene work budget paints the same frame as synchronous preparation after yielded mutations" {
    for (0..96) |seed| {
        expectBoundedMatchesSynchronous(seed) catch |err| {
            std.debug.print("bounded preparation differs from synchronous preparation for seed {d}\n", .{seed});
            return err;
        };
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
            previous = try f.owner.sceneFrameStepWorkBudgeted(f.id, null, options, 1);
            try testing.expectEqual(@as(u32, c.OT_SCENE_FRAME_YIELD), previous.?.kind);
        }
        try f.owner.sceneSetPaint(f.root, .{});
        try f.owner.sceneSetPaint(child, .{ .translateX = -2147483647, .background = .{ 2, 0, 0, 255 } });
        const done = try f.drive(previous, options, 1);
        try testing.expectEqual(@as(f64, -2147483647), (try f.owner.sceneGetPaintLayout(child)).screenX);
        try testing.expectEqual(ansi.rgbColor(0, 0, 0, 255), f.cli.getNextBuffer().get(0, 0).?.bg);
        try f.owner.sceneFrameCancel(f.id, done.frame_id);
    }
}
