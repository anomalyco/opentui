const std = @import("std");
const testing = std.testing;
const context = @import("../context.zig");
const scene = @import("../scene.zig");
const ansi = @import("../ansi.zig");
const yoga = @import("../yoga.zig");
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
        try testing.expectEqual(node.token, f.cli.nextHitGrid[x]);
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

fn orderedAppend(z_step: i32) !void {
    for ([_]bool{ false, true }) |hooks| {
        const f = try Fixture.init(testing.allocator, 2, 1, .{});
        defer f.deinit();
        var children: [68]context.Handle = undefined;
        for (children[0..64], 0..) |*child, index| {
            child.* = try box(f.owner, f.id, @intCast(index + 2), z_step * @as(i32, @intCast(index)));
            try f.owner.sceneMoveNode(child.*, f.root, @intCast(index));
            if (hooks) try f.owner.sceneSetHooks(child.*, 1, 1, 2, 1);
        }
        try frame(f, if (hooks) children[0..64] else &.{});
        try expectTop(f, children[63]);
        for (64..children.len) |index| {
            f.state.test_sort_steps = 0;
            children[index] = try box(f.owner, f.id, @intCast(index + 2), z_step * @as(i32, @intCast(index)));
            try f.owner.sceneMoveNode(children[index], f.root, @intCast(index));
            if (hooks) try f.owner.sceneSetHooks(children[index], 1, 1, 2, 1);
            try frame(f, if (hooks) children[0 .. index + 1] else &.{});
            try expectTop(f, children[index]);
            try testing.expectEqual(@as(u64, 0), f.state.test_sort_steps);
        }
    }
}

test "Scene ordered equal-z append skips settled sibling rank and sort work" {
    try orderedAppend(0);
}

const node_count_max = 16;

/// Reference tree: each node's children in Yoga order and its paint children in attachment
/// order. A frame stably sorts the paint children of every parent it visits by z.
const Model = struct {
    handles: [node_count_max]?context.Handle = @splat(null),
    parent: [node_count_max]?usize = @splat(null),
    children: [node_count_max]std.ArrayListUnmanaged(usize) = @splat(.empty),
    paint: [node_count_max]std.ArrayListUnmanaged(usize) = @splat(.empty),
    z: [node_count_max]i32 = @splat(0),
    hidden: [node_count_max]bool = @splat(false),

    fn deinit(self: *Model) void {
        for (&self.children, &self.paint) |*children, *paint| {
            children.deinit(testing.allocator);
            paint.deinit(testing.allocator);
        }
    }

    fn move(self: *Model, node: usize, parent: ?usize, index: usize) !void {
        const previous = self.parent[node];
        if (previous) |old| _ = self.children[old].orderedRemove(std.mem.indexOfScalar(usize, self.children[old].items, node).?);
        if (previous != parent) {
            if (previous) |old| _ = self.paint[old].orderedRemove(std.mem.indexOfScalar(usize, self.paint[old].items, node).?);
            if (parent) |new| try self.paint[new].append(testing.allocator, node);
        }
        if (parent) |new| try self.children[new].insert(testing.allocator, index, node);
        self.parent[node] = parent;
    }

    fn contains(self: *const Model, ancestor: usize, node: usize) bool {
        var cursor: ?usize = node;
        while (cursor) |value| : (cursor = self.parent[value]) {
            if (value == ancestor) return true;
        }
        return false;
    }

    fn zLessThan(self: *const Model, left: usize, right: usize) bool {
        return self.z[left] < self.z[right];
    }

    /// Writes the visible descendants of `node` in paint order and returns the new count.
    fn paintOrder(self: *Model, out: []usize, count: usize, node: usize) usize {
        std.mem.sort(usize, self.paint[node].items, self, zLessThan);
        var next = count;
        for (self.paint[node].items) |child| {
            if (self.hidden[child]) continue;
            out[next] = child;
            next = self.paintOrder(out, next + 1, child);
        }
        return next;
    }
};

fn expectTree(f: Fixture, model: *const Model) !void {
    var live: u32 = 0;
    for (model.handles, 0..) |maybe, index| {
        const handle = maybe orelse continue;
        live += 1;
        const value = try f.owner.raw().getRenderable(handle);
        const node = value.scene_node.?;
        try testing.expectEqual(if (model.parent[index]) |parent| try f.owner.raw().getRenderable(model.handles[parent].?) else null, node.parent);
        try testing.expectEqual(handle, f.state.tokens.get(node.token).?);
        try testing.expectEqual(model.children[index].items.len, node.children.items.len);
        for (model.children[index].items, node.children.items, 0..) |child, actual, position| {
            var yoga_child: yoga.YGNodeRef = null;
            try yoga.check(yoga.yogaNodeGetChildChecked(value.yoga_node, @intCast(position), &yoga_child));
            try testing.expectEqual(actual.yoga_node, yoga_child);
            try testing.expectEqual(model.handles[child].?, actual.scene_node.?.handle);
        }
        try testing.expectEqual(model.paint[index].items.len, node.paint_children.items.len);
    }
    try testing.expectEqual(live, f.state.count);
    try testing.expectEqual(live, f.state.tokens.count());
}

fn cellHash(f: Fixture) u64 {
    const cells = f.cli.getNextBuffer().buffer;
    var hash = std.hash.Wyhash.init(0);
    inline for (.{ cells.char, cells.fg, cells.bg, cells.attributes, f.cli.nextHitGrid }) |slice| hash.update(std.mem.sliceAsBytes(slice));
    return hash.final();
}

/// Paints a frame that may reuse the last committed paint list, checks its order against the
/// model, and compares it with a frame prepared from scratch. Returns whether work was reused.
fn expectFrame(f: Fixture, model: *Model) !bool {
    const steps = f.state.test_prepare_steps;
    try fixture.repaint(f.owner, f.id, frame_options.background, true, 0);
    const reused = f.state.test_prepare_steps == steps;
    var order: [node_count_max]usize = undefined;
    const count = model.paintOrder(&order, 0, 0);
    var painted: usize = 0;
    for (f.state.work.items) |entry| {
        if (entry.node.scene_node.?.kind == c.OT_SCENE_ROOT or !entry.visible) continue;
        try testing.expect(painted < count);
        try testing.expectEqual(model.handles[order[painted]].?, entry.node.scene_node.?.handle);
        painted += 1;
    }
    try testing.expectEqual(count, painted);
    const hash = cellHash(f);
    // Cancelling the draft drops its retained work, so this frame prepares every node.
    try fixture.repaint(f.owner, f.id, frame_options.background, true, 0);
    try testing.expectEqual(hash, cellHash(f));
    _ = try fixture.present(f.owner, f.id, true);
    var bytes: [4096]u8 = undefined;
    while (try f.owner.readOutput(f.id, &bytes)) |ticket| try f.owner.completeOutput(f.id, ticket, .written);
    return reused;
}

/// Random tree and property operations against the model. Returns the count of reused frames.
fn runModel(seed: u64) !u32 {
    var prng = std.Random.DefaultPrng.init(seed);
    const random = prng.random();
    const f = try Fixture.init(testing.allocator, 16, 4, .{});
    defer f.deinit();
    var model: Model = .{};
    defer model.deinit();
    model.handles[0] = f.root;
    var reused: u32 = 0;
    for (0..256) |step| {
        const index = random.uintLessThan(usize, node_count_max);
        const handle = model.handles[index] orelse {
            const node = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_BOX, @intCast(step + 2));
            try f.owner.sceneSetStyle(node, 0, 6, 0, 0, 2, 0);
            try f.owner.sceneSetStyle(node, 4, 0, 0, 1, @floatFromInt(random.intRangeAtMost(u32, 1, 4)), 1);
            try f.owner.sceneSetStyle(node, 4, 1, 0, 1, @floatFromInt(random.intRangeAtMost(u32, 1, 3)), 1);
            try f.owner.sceneSetPaint(node, .{ .background = .{ @intCast(step % 256), 100, 0, 255 } });
            model.handles[index] = node;
            model.z[index] = 0;
            model.hidden[index] = false;
            continue;
        };
        switch (random.uintLessThan(u32, 5)) {
            // Move, reorder, or detach, including rejected roots, cycles, and indexes.
            0, 1 => {
                // Favor the current parent and the root so reorders and painted subtrees are common.
                const target = switch (random.uintLessThan(u32, 4)) {
                    0 => model.parent[index] orelse 0,
                    1 => 0,
                    else => random.uintLessThan(usize, node_count_max + 1),
                };
                const parent: ?usize = if (target == node_count_max) null else if (model.handles[target] != null) target else continue;
                const siblings = if (parent) |value| model.children[value].items.len else 0;
                const position = random.uintLessThan(u32, @intCast(siblings + 2));
                const same = parent != null and model.parent[index] == parent;
                const valid = index != 0 and if (parent) |value| !model.contains(index, value) and position <= siblings - @intFromBool(same) else position == 0;
                const result = f.owner.sceneMoveNode(handle, if (parent) |value| model.handles[value] else null, position);
                if (!valid) {
                    try testing.expectError(error.YogaInvalidArgument, result);
                } else {
                    try result;
                    try model.move(index, parent, position);
                }
            },
            2 => if (index != 0) {
                try f.owner.sceneDestroyNode(handle);
                try model.move(index, null, 0);
                for (model.children[index].items) |child| model.parent[child] = null;
                model.children[index].clearRetainingCapacity();
                model.paint[index].clearRetainingCapacity();
                model.handles[index] = null;
                // Churn rehashes the token map before tombstones take half of its free slots.
                try testing.expect(f.state.token_tombstones < (f.state.tokens.capacity() - f.state.tokens.count()) / 2 + 1);
            },
            // Retained paint lists must observe every paint change that moves or hides cells.
            3 => if (index != 0) {
                const fields = [_]u32{ c.OT_SCENE_PROPERTY_Z_INDEX, c.OT_SCENE_PROPERTY_OPACITY, c.OT_SCENE_PROPERTY_TRANSLATE_X, c.OT_SCENE_PROPERTY_BORDER, c.OT_SCENE_PROPERTY_BACKGROUND };
                const field = fields[random.uintLessThan(usize, fields.len)];
                if (field == c.OT_SCENE_PROPERTY_Z_INDEX) model.z[index] = random.intRangeAtMost(i32, -2, 2);
                try f.owner.scenePatchPaint(handle, field, .{
                    .zIndex = model.z[index],
                    .opacity = @as(f32, @floatFromInt(random.uintLessThan(u32, 5))) / 4,
                    .translateX = @floatFromInt(random.intRangeAtMost(i32, -3, 3)),
                    .borderSides = random.uintLessThan(u32, 16),
                    .background = .{ random.int(u8), 0, 0, random.int(u8) },
                });
            },
            else => if (index != 0) switch (random.uintLessThan(u32, 4)) {
                0 => {
                    model.hidden[index] = random.boolean();
                    try f.owner.sceneSetStyle(handle, 0, 9, 0, 0, @floatFromInt(@intFromBool(model.hidden[index])), 0);
                },
                1 => try f.owner.sceneSetStyle(handle, 0, 8, 0, 0, @floatFromInt(random.uintLessThan(u32, 3)), 0),
                2 => try f.owner.sceneSetPositions(handle, 3, .{ 1, 1, 0, 0 }, .{ @floatFromInt(random.uintLessThan(u32, 14)), @floatFromInt(random.uintLessThan(u32, 4)), 0, 0 }),
                else => try f.owner.sceneSetFocus(handle, random.boolean()),
            },
        }
        try expectTree(f, &model);
        reused += @intFromBool(try expectFrame(f, &model));
    }
    return reused;
}

test "Scene tree and paint order follow a reference model and reused frames match fresh frames" {
    var reused: u32 = 0;
    for (0..32) |seed| {
        errdefer std.debug.print("seed {d}\n", .{seed});
        reused += try runModel(seed);
    }
    try testing.expect(reused > 0);
}
