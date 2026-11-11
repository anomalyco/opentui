const std = @import("std");

const yoga = @import("../yoga.zig");

test "Yoga mixed-config activity guards nodes and configs outside the requested subtree" {
    const Probe = struct {
        configs: [4]*yoga.Config = undefined,
        nodes: [4]yoga.YGNodeRef = undefined,
        unrelated: yoga.YGNodeRef = null,
        mutations: [4]yoga.Status = @splat(.ok),
        settings: [3][4]yoga.Status = @splat(@splat(.ok)),
        unrelated_layout: yoga.Status = .busy,
        unrelated_config: yoga.Status = .busy,
        callbacks: u32 = 0,

        fn measure(data: ?*anyopaque, _: yoga.YGNodeConstRef, _: f32, _: u32, _: f32, _: u32) yoga.ExternalYogaSize {
            const self: *@This() = @ptrCast(@alignCast(data.?));
            self.callbacks += 1;
            self.unrelated_layout = yoga.yogaNodeCalculateLayoutChecked(self.unrelated, 4, 4, 1);
            self.unrelated_config = yoga.yogaConfigSetPointScaleFactorChecked(self.configs[3].ref, 2);
            for (self.nodes, 0..) |node, index| self.mutations[index] = yoga.yogaNodeStyleSetFloatChecked(node, 0, 1);
            for (self.configs[0..3], 0..) |config, index| {
                self.settings[index] = .{
                    yoga.yogaConfigSetUseWebDefaultsChecked(config.ref, 1),
                    yoga.yogaConfigSetPointScaleFactorChecked(config.ref, 2),
                    yoga.yogaConfigSetErrataChecked(config.ref, 1),
                    yoga.yogaConfigSetExperimentalFeatureEnabledChecked(config.ref, 0, 1),
                };
            }
            return .{ .width = 3, .height = 1 };
        }
    };
    var probe: Probe = .{};
    var configs: [4]yoga.Config = undefined;
    for (&configs, 0..) |*config, index| {
        try config.init(std.testing.allocator, .{ .user_data = &probe, .measure = Probe.measure });
        probe.configs[index] = config;
    }
    defer for (&configs) |*config| config.deinit();
    const root = try configs[0].createNode();
    defer yoga.yogaNodeFreeRecursive(root);
    const subtree = try configs[1].createNode();
    const leaf = try configs[0].createNode();
    const sibling = try configs[2].createNode();
    try yoga.check(yoga.yogaNodeInsertChildChecked(root, subtree, 0));
    try yoga.check(yoga.yogaNodeInsertChildChecked(root, sibling, 1));
    try yoga.check(yoga.yogaNodeInsertChildChecked(subtree, leaf, 0));
    try yoga.check(yoga.yogaNodeSetMeasureFuncChecked(leaf, 1));
    probe.nodes = .{ root, subtree, leaf, sibling };
    // Each config list starts with an unrelated node, before the active tree.
    var unrelated: [3]yoga.YGNodeRef = undefined;
    for (0..3) |index| unrelated[index] = try configs[index].createNode();
    defer for (unrelated) |node| yoga.yogaNodeFree(node);
    probe.unrelated = unrelated[2];
    try yoga.check(yoga.yogaNodeCalculateLayoutChecked(subtree, std.math.nan(f32), std.math.nan(f32), 1));
    try std.testing.expect(probe.callbacks != 0);
    try std.testing.expectEqual(yoga.Status.ok, probe.unrelated_layout);
    try std.testing.expectEqual(yoga.Status.ok, probe.unrelated_config);
    for (probe.mutations) |status| try std.testing.expectEqual(yoga.Status.busy, status);
    for (probe.settings) |settings| for (settings) |status| try std.testing.expectEqual(yoga.Status.busy, status);
    for (probe.configs[0..3]) |config| {
        try std.testing.expect(!yoga.yogaConfigGetUseWebDefaults(config.ref));
        try std.testing.expectEqual(@as(f32, 1), yoga.yogaConfigGetPointScaleFactor(config.ref));
    }
    for (&configs) |*config| try yoga.check(yoga.yogaConfigSetPointScaleFactorChecked(config.ref, 1));
    try yoga.check(yoga.yogaNodeStyleSetFloatChecked(sibling, 0, 1));
}

const CompoundStyleProbe = struct {
    dimension: u32 = 0,
    positions: bool = false,
    calls: u32 = 0,
    values: [4]u64 = @splat(0),
    shrink: f32 = -1,

    fn dirty(target: ?*anyopaque, node: yoga.YGNodeConstRef) void {
        const self: *@This() = @ptrCast(@alignCast(target.?));
        self.calls += 1;
        if (self.positions) {
            for (0..4) |edge| self.values[edge] = yoga.yogaNodeStyleGetValue(node, 9, @intCast(edge));
        } else {
            self.values[0] = yoga.yogaNodeStyleGetValue(node, self.dimension, 0);
            yoga.check(yoga.yogaNodeStyleGetFloatChecked(node, 2, &self.shrink)) catch unreachable;
        }
    }
};

fn packedStyle(unit: u32, value: f32) u64 {
    return (@as(u64, @as(u32, @bitCast(value))) << 32) | unit;
}

fn setCompoundStyle(node: yoga.YGNodeRef, kind: u32) yoga.Status {
    return if (kind == 9)
        yoga.yogaNodeStyleSetPositionsChecked(node, 15, &.{ 1, 2, 1, 2 }, &.{ 1.25, 2.25, 3.25, 4.25 })
    else
        yoga.yogaNodeStyleSetDimensionChecked(node, kind, 2, 25.5, 1);
}

test "Yoga compound style prepares every field before notifying and rolls back allocation failures" {
    var probe: CompoundStyleProbe = .{};
    var config: yoga.Config = undefined;
    try config.init(std.testing.allocator, .{ .user_data = &probe, .dirtied = CompoundStyleProbe.dirty });
    defer config.deinit();
    defer yoga.testFailAfter(-1);
    for ([_]u32{ 0, 1, 9 }) |kind| {
        for ([_]u32{ 4, 5 }) |seed_count| {
            var succeeded = false;
            for (0..8) |offset| {
                yoga.testFailAfter(-1);
                const node = try config.createNode();
                defer yoga.yogaNodeFree(node);
                for (2..2 + seed_count) |seed| try yoga.check(yoga.yogaNodeStyleSetValueChecked(node, @intCast(seed), 0, 1, 3.25));
                try yoga.check(yoga.yogaNodeStyleSetFloatChecked(node, 2, 1));
                try yoga.check(yoga.yogaNodeSetDirtiedFuncChecked(node, 1));
                try yoga.check(yoga.yogaNodeCalculateLayoutChecked(node, 100, 100, 1));
                probe = .{ .dimension = kind, .positions = kind == 9 };
                CompoundStyleProbe.dirty(&probe, node);
                const before = probe;
                probe.calls = 0;
                yoga.testFailAfter(@intCast(offset));
                const status = setCompoundStyle(node, kind);
                if (status != .ok) {
                    try std.testing.expectEqual(yoga.Status.out_of_memory, status);
                    try std.testing.expectEqual(@as(u32, 0), probe.calls);
                    CompoundStyleProbe.dirty(&probe, node);
                    try std.testing.expectEqualDeep(before, probe);
                    probe.calls = 0;
                    var dirty: u32 = 1;
                    try yoga.check(yoga.yogaNodeIsDirtyChecked(node, &dirty));
                    try std.testing.expectEqual(@as(u32, 0), dirty);
                    yoga.testFailAfter(-1);
                    try yoga.check(setCompoundStyle(node, kind));
                }
                try std.testing.expectEqual(@as(u32, 1), probe.calls);
                if (kind == 9) {
                    for ([_]u32{ 1, 2, 1, 2 }, [_]f32{ 1.25, 2.25, 3.25, 4.25 }, probe.values) |unit, value, actual| {
                        try std.testing.expectEqual(packedStyle(unit, value), actual);
                    }
                } else {
                    try std.testing.expectEqual(packedStyle(2, 25.5), probe.values[0]);
                    try std.testing.expectEqual(@as(f32, 0), probe.shrink);
                }
                yoga.testFailAfter(0);
                try yoga.check(setCompoundStyle(node, kind));
                if (status == .ok) {
                    succeeded = true;
                    break;
                }
            }
            try std.testing.expect(succeeded);
        }
    }
}

test "Yoga compound style validates complete inputs and preserves unselected properties" {
    var config: yoga.Config = undefined;
    try config.init(std.testing.allocator, .{});
    defer config.deinit();
    const node = try config.createNode();
    defer yoga.yogaNodeFree(node);
    try yoga.check(yoga.yogaNodeStyleSetFloatChecked(node, 2, 1));
    try yoga.check(yoga.yogaNodeStyleSetDimensionChecked(node, 0, 1, 10, 0));
    var shrink: f32 = 0;
    try yoga.check(yoga.yogaNodeStyleGetFloatChecked(node, 2, &shrink));
    try std.testing.expectEqual(@as(f32, 1), shrink);
    const invalid = yoga.Status.invalid_argument;
    for ([_][3]u32{ .{ 2, 1, 1 }, .{ 0, 4, 1 }, .{ 0, 1, 2 } }) |args| {
        try std.testing.expectEqual(invalid, yoga.yogaNodeStyleSetDimensionChecked(node, args[0], args[1], 20, args[2]));
    }
    try std.testing.expectEqual(packedStyle(1, 10), yoga.yogaNodeStyleGetValue(node, 0, 0));
    try yoga.check(yoga.yogaNodeStyleGetFloatChecked(node, 2, &shrink));
    try std.testing.expectEqual(@as(f32, 1), shrink);
    const values = [_]f32{ 1, 2, 3, 4 };
    try yoga.check(yoga.yogaNodeStyleSetPositionsChecked(node, 15, &.{ 1, 1, 1, 1 }, &values));
    try std.testing.expectEqual(invalid, yoga.yogaNodeStyleSetPositionsChecked(node, 15, &.{ 1, 1, 1, 4 }, &.{ 5, 6, 7, 8 }));
    try std.testing.expectEqual(invalid, yoga.yogaNodeStyleSetPositionsChecked(node, 16, &.{ 1, 1, 1, 1 }, &values));
    try std.testing.expectEqual(invalid, yoga.yogaNodeStyleSetPositionsChecked(node, 1, null, &values));
    for (0..4) |edge| try std.testing.expectEqual(packedStyle(1, values[edge]), yoga.yogaNodeStyleGetValue(node, 9, @intCast(edge)));
    try yoga.check(yoga.yogaNodeStyleSetPositionsChecked(node, 5, &.{ 3, 99, 0, 99 }, &values));
    try std.testing.expectEqual(@as(u32, 3), @as(u32, @truncate(yoga.yogaNodeStyleGetValue(node, 9, 0))));
    try std.testing.expectEqual(@as(u32, 0), @as(u32, @truncate(yoga.yogaNodeStyleGetValue(node, 9, 2))));
    for ([_]u32{ 1, 3 }) |edge| try std.testing.expectEqual(packedStyle(1, values[edge]), yoga.yogaNodeStyleGetValue(node, 9, edge));
    yoga.testFailAfter(0);
    defer yoga.testFailAfter(-1);
    try yoga.check(yoga.yogaNodeStyleSetPositionsChecked(node, 0, &.{ 99, 99, 99, 99 }, &values));
}

const MoveProbe = struct {
    source: yoga.YGNodeRef,
    destination: yoga.YGNodeRef,
    child: yoga.YGNodeRef,
    expected: []const yoga.YGNodeRef,
    calls: u32 = 0,
    accepted: bool = true,
    notified: [3]yoga.YGNodeConstRef = @splat(null),

    fn dirty(target: ?*anyopaque, node: yoga.YGNodeConstRef) void {
        const self: *@This() = @ptrCast(@alignCast(target.?));
        if (self.calls < self.notified.len) self.notified[self.calls] = node;
        self.calls += 1;
        self.accepted = self.accepted and yoga.yogaNodeGetParent(self.child) == self.destination;
        for (self.expected, 0..) |expected, index| {
            var actual: yoga.YGNodeRef = null;
            self.accepted = self.accepted and yoga.yogaNodeGetChildChecked(self.destination, @intCast(index), &actual) == .ok and actual == expected;
        }
        for ([_]yoga.YGNodeRef{ self.source, self.destination }) |parent| {
            if (parent == null) continue;
            var is_dirty: u32 = 0;
            self.accepted = self.accepted and yoga.yogaNodeIsDirtyChecked(parent, &is_dirty) == .ok and is_dirty == 1;
        }
    }
};

test "Yoga compound move reserves before detached insertion or mixed-config reparenting" {
    defer yoga.testFailAfter(-1);
    for ([_]bool{ false, true }) |attached| {
        for (0..2) |fail_after| {
            yoga.testFailAfter(-1);
            var probe: MoveProbe = undefined;
            var first: yoga.Config = undefined;
            try first.init(std.testing.allocator, .{ .user_data = &probe, .dirtied = MoveProbe.dirty });
            defer first.deinit();
            var second: yoga.Config = undefined;
            try second.init(std.testing.allocator, .{ .user_data = &probe, .dirtied = MoveProbe.dirty });
            defer second.deinit();
            const source = try first.createNode();
            defer yoga.yogaNodeFree(source);
            const destination = try second.createNode();
            defer yoga.yogaNodeFree(destination);
            const child = try first.createNode();
            defer yoga.yogaNodeFree(child);
            const sibling = try second.createNode();
            defer yoga.yogaNodeFree(sibling);
            try yoga.check(yoga.yogaNodeStyleSetEnumChecked(child, 9, 2));
            if (attached) try yoga.check(yoga.yogaNodeInsertChildChecked(source, child, 0));
            try yoga.check(yoga.yogaNodeInsertChildChecked(destination, sibling, 0));
            for ([_]yoga.YGNodeRef{ source, destination }) |node| {
                try yoga.check(yoga.yogaNodeCalculateLayoutChecked(node, 20, 10, 1));
                try yoga.check(yoga.yogaNodeSetDirtiedFuncChecked(node, 1));
            }
            var before: yoga.ExternalYogaLayout = undefined;
            try yoga.check(yoga.yogaNodeGetComputedLayoutChecked(child, &before));
            probe = .{ .source = if (attached) source else null, .destination = destination, .child = child, .expected = &.{ sibling, child } };
            yoga.testFailAfter(@intCast(fail_after));
            const status = yoga.yogaNodeMoveChildChecked(destination, child, 1);
            if (fail_after == 0) {
                try std.testing.expectEqual(yoga.Status.out_of_memory, status);
                try std.testing.expectEqual(if (attached) source else null, yoga.yogaNodeGetParent(child));
                try std.testing.expectEqual(@as(u32, @intFromBool(attached)), yoga.testContentsChildCount(source));
                try std.testing.expectEqual(@as(u32, 0), yoga.testContentsChildCount(destination));
                var out = child;
                try yoga.check(yoga.yogaNodeGetChildChecked(destination, 1, &out));
                try std.testing.expectEqual(null, out);
                try yoga.check(yoga.yogaNodeGetChildChecked(destination, 0, &out));
                try std.testing.expectEqual(sibling, out);
                if (attached) {
                    try yoga.check(yoga.yogaNodeGetChildChecked(source, 0, &out));
                    try std.testing.expectEqual(child, out);
                }
                var after: yoga.ExternalYogaLayout = undefined;
                try yoga.check(yoga.yogaNodeGetComputedLayoutChecked(child, &after));
                try std.testing.expectEqualSlices(u8, std.mem.asBytes(&before), std.mem.asBytes(&after));
                try std.testing.expectEqual(@as(u32, 0), probe.calls);
                for ([_]yoga.YGNodeRef{ source, destination }) |node| {
                    var dirty: u32 = 1;
                    try yoga.check(yoga.yogaNodeIsDirtyChecked(node, &dirty));
                    try std.testing.expectEqual(@as(u32, 0), dirty);
                }
                yoga.testFailAfter(1);
                try yoga.check(yoga.yogaNodeMoveChildChecked(destination, child, 1));
            } else try yoga.check(status);
            try std.testing.expectEqual(@as(u64, 1), yoga.testAllocationCount());
            try std.testing.expect(probe.accepted);
            try std.testing.expectEqual(if (attached) @as(u32, 2) else 1, probe.calls);
            try std.testing.expectEqual(@as(u32, 0), yoga.testContentsChildCount(source));
            try std.testing.expectEqual(@as(u32, 1), yoga.testContentsChildCount(destination));
        }
    }
}

test "Yoga compound move keeps both trees busy through dirtied callbacks" {
    const Probe = struct {
        move: MoveProbe,
        independent: yoga.YGNodeRef,

        fn dirty(target: ?*anyopaque, node: yoga.YGNodeConstRef) void {
            const self: *@This() = @ptrCast(@alignCast(target.?));
            MoveProbe.dirty(&self.move, node);
            // Stop before C++ can reuse the queued destination if teardown succeeds.
            std.testing.expectEqual(yoga.Status.busy, yoga.yogaNodeFreeChecked(self.move.destination)) catch
                @panic("move callback released its queued destination");
            for ([_]yoga.YGNodeRef{ self.move.source, self.move.child }) |ref| {
                std.testing.expectEqual(yoga.Status.busy, yoga.yogaNodeFreeChecked(ref)) catch unreachable;
            }
            for ([_]yoga.YGNodeRef{ self.move.source, self.move.destination }) |ref| {
                std.testing.expectEqual(yoga.Status.busy, yoga.yogaNodeCalculateLayoutChecked(ref, 20, 10, 1)) catch unreachable;
                std.testing.expectEqual(yoga.Status.busy, yoga.yogaConfigSetPointScaleFactorChecked(@constCast(yoga.yogaNodeGetConfig(ref)), 2)) catch unreachable;
            }
            yoga.check(yoga.yogaNodeStyleSetDimensionChecked(self.independent, 0, 1, 7, 0)) catch unreachable;
            yoga.check(yoga.yogaNodeCalculateLayoutChecked(self.independent, 20, 10, 1)) catch unreachable;
            yoga.check(yoga.yogaConfigSetPointScaleFactorChecked(@constCast(yoga.yogaNodeGetConfig(self.independent)), 2)) catch unreachable;
        }
    };
    var probe: Probe = undefined;
    var first: yoga.Config = undefined;
    try first.init(std.testing.allocator, .{ .user_data = &probe, .dirtied = Probe.dirty });
    defer first.deinit();
    var second: yoga.Config = undefined;
    try second.init(std.testing.allocator, .{ .user_data = &probe, .dirtied = Probe.dirty });
    defer second.deinit();
    var independent: yoga.Config = undefined;
    try independent.init(std.testing.allocator, .{});
    defer independent.deinit();
    const source = try first.createNode();
    defer yoga.yogaNodeFree(source);
    const destination = try second.createNode();
    defer yoga.yogaNodeFree(destination);
    const child = try first.createNode();
    defer yoga.yogaNodeFree(child);
    const other = try independent.createNode();
    defer yoga.yogaNodeFree(other);
    try yoga.check(yoga.yogaNodeInsertChildChecked(source, child, 0));
    for ([_]yoga.YGNodeRef{ source, destination }) |node| {
        try yoga.check(yoga.yogaNodeCalculateLayoutChecked(node, 20, 10, 1));
        try yoga.check(yoga.yogaNodeSetDirtiedFuncChecked(node, 1));
    }
    probe = .{
        .move = .{ .source = source, .destination = destination, .child = child, .expected = &.{child} },
        .independent = other,
    };
    try yoga.check(yoga.yogaNodeMoveChildChecked(destination, child, 0));
    try std.testing.expect(probe.move.accepted);
    try std.testing.expectEqual(@as(u32, 2), probe.move.calls);
    try std.testing.expectEqualSlices(yoga.YGNodeConstRef, &.{ source, destination }, probe.move.notified[0..2]);
    for ([_]yoga.YGNodeRef{ source, destination }) |node| {
        try yoga.check(yoga.yogaNodeUnsetDirtiedFuncChecked(node));
        try yoga.check(yoga.yogaNodeCalculateLayoutChecked(node, 20, 10, 1));
    }
    try std.testing.expectEqual(destination, yoga.yogaNodeGetParent(child));
}

test "Yoga compound move reorders using the final index without allocation" {
    var probe: MoveProbe = undefined;
    var config: yoga.Config = undefined;
    try config.init(std.testing.allocator, .{ .user_data = &probe, .dirtied = MoveProbe.dirty });
    defer config.deinit();
    const parent = try config.createNode();
    defer yoga.yogaNodeFreeRecursive(parent);
    const children = [_]yoga.YGNodeRef{ try config.createNode(), try config.createNode(), try config.createNode() };
    for (children, 0..) |child, index| try yoga.check(yoga.yogaNodeInsertChildChecked(parent, child, @intCast(index)));
    try yoga.check(yoga.yogaNodeSetDirtiedFuncChecked(parent, 1));
    for ([_]u32{ 2, 0 }) |index| {
        try yoga.check(yoga.yogaNodeCalculateLayoutChecked(parent, 20, 10, 1));
        probe = .{ .source = parent, .destination = parent, .child = children[0], .expected = if (index == 2) &.{ children[1], children[2], children[0] } else &children };
        yoga.testFailAfter(0);
        defer yoga.testFailAfter(-1);
        try yoga.check(yoga.yogaNodeMoveChildChecked(parent, children[0], index));
        try std.testing.expect(probe.accepted);
        try std.testing.expectEqual(@as(u32, 1), probe.calls);
        try std.testing.expectEqual(@as(u64, 0), yoga.testAllocationCount());
        yoga.testFailAfter(-1);
        try yoga.check(yoga.yogaNodeCalculateLayoutChecked(parent, 20, 10, 1));
        yoga.testFailAfter(0);
        try yoga.check(yoga.yogaNodeMoveChildChecked(parent, children[0], index));
        try std.testing.expectEqual(@as(u32, 1), probe.calls);
        var dirty: u32 = 1;
        try yoga.check(yoga.yogaNodeIsDirtyChecked(parent, &dirty));
        try std.testing.expectEqual(@as(u32, 0), dirty);
    }
    try std.testing.expectEqual(yoga.Status.invalid_argument, yoga.yogaNodeMoveChildChecked(parent, children[0], 3));
    try std.testing.expectEqual(yoga.Status.invalid_argument, yoga.yogaNodeMoveChildChecked(children[0], parent, 0));
    try yoga.check(yoga.yogaNodeSetMeasureFuncChecked(children[1], 1));
    try std.testing.expectEqual(yoga.Status.invalid_argument, yoga.yogaNodeMoveChildChecked(children[1], children[0], 0));
    try std.testing.expectEqual(parent, yoga.yogaNodeGetParent(children[0]));
    try yoga.check(yoga.yogaNodeUnsetDirtiedFuncChecked(parent));
}

test "Yoga compound move notifies a common ancestor once after both parents are dirty" {
    var probe: MoveProbe = undefined;
    var config: yoga.Config = undefined;
    try config.init(std.testing.allocator, .{ .user_data = &probe, .dirtied = MoveProbe.dirty });
    defer config.deinit();
    const root = try config.createNode();
    defer yoga.yogaNodeFreeRecursive(root);
    const source = try config.createNode();
    const destination = try config.createNode();
    const child = try config.createNode();
    try yoga.check(yoga.yogaNodeInsertChildChecked(root, source, 0));
    try yoga.check(yoga.yogaNodeInsertChildChecked(root, destination, 1));
    try yoga.check(yoga.yogaNodeInsertChildChecked(source, child, 0));
    for ([_]yoga.YGNodeRef{ root, source, destination }) |node| try yoga.check(yoga.yogaNodeSetDirtiedFuncChecked(node, 1));
    try yoga.check(yoga.yogaNodeCalculateLayoutChecked(root, 20, 10, 1));
    probe = .{ .source = source, .destination = destination, .child = child, .expected = &.{child} };
    try yoga.check(yoga.yogaNodeMoveChildChecked(destination, child, 0));
    try std.testing.expect(probe.accepted);
    try std.testing.expectEqual(@as(u32, 3), probe.calls);
    try std.testing.expectEqualSlices(yoga.YGNodeConstRef, &.{ source, root, destination }, &probe.notified);
}

test "Yoga checked creation cleans up C++ and callback allocation failures" {
    yoga.testFailAfter(0);
    defer yoga.testFailAfter(-1);
    var config: yoga.Config = undefined;
    try std.testing.expectError(error.OutOfMemory, config.init(std.testing.allocator, .{}));
    yoga.testFailAfter(-1);

    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    try config.init(failing.allocator(), .{});
    defer config.deinit();
    failing.fail_index = failing.alloc_index;
    try std.testing.expectError(error.OutOfMemory, config.createNode());
    try std.testing.expect(!config.hasLiveNodes());
    failing.fail_index = std.math.maxInt(usize);
    yoga.testFailAfter(0);
    try std.testing.expectError(error.OutOfMemory, config.createNode());
    try std.testing.expect(!config.hasLiveNodes());
    try std.testing.expectEqual(failing.allocated_bytes, failing.freed_bytes);
    yoga.testFailAfter(-1);

    const node = try config.createNode();
    defer yoga.yogaNodeFree(node);
    var out = node;
    yoga.testFailAfter(0);
    try std.testing.expectEqual(yoga.Status.out_of_memory, yoga.yogaNodeCreateWithConfigChecked(config.ref, &out));
    try std.testing.expectEqual(node, out);
    try std.testing.expect(yoga.yogaNodeHasContext(node));
    failing.fail_index = failing.alloc_index;
    try std.testing.expectEqual(yoga.Status.ok, yoga.yogaNodeResetChecked(node));
    try std.testing.expect(yoga.yogaNodeHasContext(node));
    try std.testing.expectEqual(yoga.Status.ok, yoga.yogaNodeSetMeasureFuncChecked(node, 1));
}

test "Yoga checked malformed valid-pointer calls reject before upstream assertions" {
    var config: yoga.Config = undefined;
    try config.init(std.testing.allocator, .{});
    defer config.deinit();
    const node = try config.createNode();
    defer yoga.yogaNodeFree(node);
    const child = try config.createNode();
    defer yoga.yogaNodeFree(child);
    const invalid = yoga.Status.invalid_argument;
    try std.testing.expectEqual(invalid, yoga.yogaConfigSetPointScaleFactorChecked(config.ref, -1));
    try std.testing.expectEqual(invalid, yoga.yogaConfigSetPointScaleFactorChecked(config.ref, std.math.nan(f32)));
    try std.testing.expectEqual(invalid, yoga.yogaConfigSetExperimentalFeatureEnabledChecked(config.ref, 1, 1));
    var flag: u32 = 123;
    try std.testing.expectEqual(invalid, yoga.yogaConfigIsExperimentalFeatureEnabledChecked(config.ref, 1, &flag));
    try std.testing.expectEqual(@as(u32, 123), flag);
    for (0..13) |kind| {
        try std.testing.expectEqual(invalid, yoga.yogaNodeStyleSetEnumChecked(node, @intCast(kind), std.math.maxInt(u32)));
    }
    // Only the scene's config, which rounds from absolute edges, has list rules.
    try std.testing.expectEqual(invalid, yoga.yogaNodeStyleSetEnumChecked(node, @backingInt(yoga.YogaEnumKind.layout_mode), 1));
    try std.testing.expectEqual(invalid, yoga.yogaNodeStyleGetEnumChecked(node, 12, &flag));
    try std.testing.expectEqual(@as(u32, 123), flag);
    try std.testing.expectEqual(invalid, yoga.yogaNodeStyleSetFloatChecked(node, 4, 1));
    try std.testing.expectEqual(invalid, yoga.yogaNodeStyleSetFloatChecked(node, 0, std.math.inf(f32)));
    try yoga.check(yoga.yogaNodeStyleSetFloatChecked(node, 0, 1e30));
    var large: f32 = 0;
    try yoga.check(yoga.yogaNodeStyleGetFloatChecked(node, 0, &large));
    try std.testing.expectEqual(@as(f32, 1e30), large);
    try std.testing.expectEqual(invalid, yoga.yogaNodeStyleSetBorderChecked(node, 9, 1));
    try std.testing.expectEqual(invalid, yoga.yogaNodeStyleSetValueChecked(node, 11, 0, 1, 1));
    try std.testing.expectEqual(invalid, yoga.yogaNodeStyleSetValueChecked(node, 7, 9, 1, 1));
    try std.testing.expectEqual(invalid, yoga.yogaNodeStyleSetValueChecked(node, 10, 3, 1, 1));
    try std.testing.expectEqual(invalid, yoga.yogaNodeStyleSetValueChecked(node, 8, 0, 3, 1));
    try std.testing.expectEqual(invalid, yoga.yogaNodeStyleSetValueChecked(node, 0, 0, 4, 1));
    const inf = std.math.inf(f32);
    try std.testing.expectEqual(invalid, yoga.yogaNodeStyleSetValueChecked(node, 0, 0, 1, inf));
    try std.testing.expectEqual(invalid, yoga.yogaNodeStyleSetDimensionChecked(node, 0, 1, inf, 0));
    try std.testing.expectEqual(invalid, yoga.yogaNodeStyleSetPositionsChecked(node, 1, &.{ 1, 1, 1, 1 }, &.{ -inf, 0, 0, 0 }));
    var edge: f32 = 123;
    try std.testing.expectEqual(invalid, yoga.yogaNodeLayoutGetEdgeChecked(node, 0, 6, &edge));
    try std.testing.expectEqual(invalid, yoga.yogaNodeLayoutGetEdgeChecked(node, 3, 0, &edge));
    try std.testing.expectEqual(@as(f32, 123), edge);
    try std.testing.expectEqual(invalid, yoga.yogaNodeMarkDirtyChecked(node));
    try std.testing.expectEqual(invalid, yoga.yogaNodeCalculateLayoutChecked(node, 1, 1, 3));
    try std.testing.expectEqual(invalid, yoga.yogaNodeCalculateLayoutChecked(node, inf, 1, 1));
    try std.testing.expectEqual(invalid, yoga.yogaNodeCalculateLayoutChecked(node, 1, -1, 1));
    try std.testing.expectEqual(invalid, yoga.yogaNodeInsertChildChecked(node, child, 1));
    try std.testing.expectEqual(yoga.Status.ok, yoga.yogaNodeSetMeasureFuncChecked(node, 1));
    try std.testing.expectEqual(invalid, yoga.yogaNodeInsertChildChecked(node, child, 0));
    try std.testing.expectEqual(yoga.Status.ok, yoga.yogaNodeUnsetMeasureFuncChecked(node));
    try std.testing.expectEqual(yoga.Status.ok, yoga.yogaNodeInsertChildChecked(node, child, 0));
    try std.testing.expectEqual(invalid, yoga.yogaNodeSetMeasureFuncChecked(node, 1));
    try std.testing.expectEqual(invalid, yoga.yogaNodeResetChecked(node));
    try std.testing.expectEqual(invalid, yoga.yogaNodeResetChecked(child));
    try std.testing.expect(yoga.yogaNodeHasContext(node) and yoga.yogaNodeHasContext(child));
    try std.testing.expectEqual(invalid, yoga.yogaNodeInsertChildChecked(child, node, 0));
    var out = node;
    try std.testing.expectEqual(invalid, yoga.yogaNodeGetChildChecked(null, 0, &out));
    try std.testing.expectEqual(invalid, yoga.yogaNodeGetChildChecked(node, 0, null));
    try std.testing.expectEqual(node, out);
    try yoga.check(yoga.yogaNodeGetChildChecked(node, 1, &out));
    try std.testing.expectEqual(null, out);
    try yoga.check(yoga.yogaNodeGetChildChecked(node, std.math.maxInt(u32), &out));
    try std.testing.expectEqual(null, out);
    try yoga.check(yoga.yogaNodeRemoveChildChecked(node, child));
    try yoga.check(yoga.yogaNodeResetChecked(node));
}

fn setAllocatingStyle(node: yoga.YGNodeRef, family: u32) yoga.Status {
    return switch (family) {
        0 => yoga.yogaNodeStyleSetFloatChecked(node, 0, 9.25),
        1 => yoga.yogaNodeStyleSetValueChecked(node, 6, 0, 1, 9.25),
        2 => yoga.yogaNodeStyleSetBorderChecked(node, 0, 9.25),
        else => unreachable,
    };
}

test "Yoga checked spill style and inner vector allocations roll back and retry" {
    var config: yoga.Config = undefined;
    try config.init(std.testing.allocator, .{});
    defer config.deinit();
    defer yoga.testFailAfter(-1);
    for (0..3) |family| {
        for ([_]u32{ 4, 5 }) |seed_count| {
            var failures: u32 = 0;
            for (0..8) |fail_after| {
                yoga.testFailAfter(-1);
                const node = try config.createNode();
                defer yoga.yogaNodeFree(node);
                for (0..seed_count) |kind| {
                    try yoga.check(yoga.yogaNodeStyleSetValueChecked(node, @intCast(kind), 0, 1, 3.25));
                }
                try yoga.check(yoga.yogaNodeCalculateLayoutChecked(node, 100, 100, 1));
                const before = yoga.yogaNodeStyleGetValue(node, 6, 0);
                yoga.testFailAfter(@intCast(fail_after));
                const status = setAllocatingStyle(node, @intCast(family));
                if (status == .ok) break;
                try std.testing.expectEqual(yoga.Status.out_of_memory, status);
                try std.testing.expectEqual(@as(u64, fail_after), yoga.testAllocationCount());
                failures += 1;
                try std.testing.expectEqual(before, yoga.yogaNodeStyleGetValue(node, 6, 0));
                var value: f32 = 0;
                try yoga.check(yoga.yogaNodeStyleGetFloatChecked(node, 0, &value));
                try std.testing.expect(std.math.isNan(value));
                try yoga.check(yoga.yogaNodeStyleGetBorderChecked(node, 0, &value));
                try std.testing.expect(std.math.isNan(value));
                var dirty: u32 = 1;
                try yoga.check(yoga.yogaNodeIsDirtyChecked(node, &dirty));
                try std.testing.expectEqual(@as(u32, 0), dirty);
                yoga.testFailAfter(-1);
                try yoga.check(setAllocatingStyle(node, @intCast(family)));
                yoga.testFailAfter(0);
                try yoga.check(setAllocatingStyle(node, @intCast(family)));
                try yoga.check(yoga.yogaNodeStyleSetEnumChecked(node, 1, 2));
            }
            // Overflow object, value vector, and vector<bool>; a spilled copy
            // also exercises the next value-vector growth after the copy.
            try std.testing.expect(failures >= if (seed_count == 4) @as(u32, 3) else 4);
            try std.testing.expect(failures < 8);
        }
    }
}

test "Yoga checked copy style preserves destination through every allocation failure" {
    var config: yoga.Config = undefined;
    try config.init(std.testing.allocator, .{});
    defer config.deinit();
    const source = try config.createNode();
    defer yoga.yogaNodeFree(source);
    defer yoga.testFailAfter(-1);
    for (0..5) |kind| try yoga.check(yoga.yogaNodeStyleSetValueChecked(source, @intCast(kind), 0, 1, 3.25));
    for (0..3) |fail_after| {
        const node = try config.createNode();
        defer yoga.yogaNodeFree(node);
        try yoga.check(yoga.yogaNodeStyleSetValueChecked(node, 0, 0, 1, 10));
        const before = yoga.yogaNodeStyleGetValue(node, 0, 0);
        yoga.testFailAfter(@intCast(fail_after));
        try std.testing.expectEqual(yoga.Status.out_of_memory, yoga.yogaNodeCopyStyleChecked(node, source));
        try std.testing.expectEqual(before, yoga.yogaNodeStyleGetValue(node, 0, 0));
        yoga.testFailAfter(-1);
        try yoga.check(yoga.yogaNodeCopyStyleChecked(node, source));
        try std.testing.expectEqual(yoga.yogaNodeStyleGetValue(source, 0, 0), yoga.yogaNodeStyleGetValue(node, 0, 0));
        yoga.testFailAfter(0);
        try yoga.check(yoga.yogaNodeCopyStyleChecked(node, source));
        yoga.testFailAfter(-1);
    }
}

test "Yoga checked display contents insertion failure leaves topology retryable and reuse keeps storage" {
    var config: yoga.Config = undefined;
    try config.init(std.testing.allocator, .{});
    defer config.deinit();
    const node = try config.createNode();
    defer yoga.yogaNodeFree(node);
    const child = try config.createNode();
    defer yoga.yogaNodeFree(child);
    try yoga.check(yoga.yogaNodeStyleSetEnumChecked(child, 9, 2));
    yoga.testFailAfter(0);
    defer yoga.testFailAfter(-1);
    try std.testing.expectEqual(yoga.Status.out_of_memory, yoga.yogaNodeInsertChildChecked(node, child, 0));
    try std.testing.expectEqual(@as(u32, 0), yoga.testContentsChildCount(node));
    try std.testing.expect(yoga.yogaNodeGetParent(child) == null);
    var out = child;
    try yoga.check(yoga.yogaNodeGetChildChecked(node, 0, &out));
    try std.testing.expectEqual(null, out);
    yoga.testFailAfter(-1);
    try yoga.check(yoga.yogaNodeInsertChildChecked(node, child, 0));
    try yoga.check(yoga.yogaNodeGetChildChecked(node, 0, &out));
    try std.testing.expectEqual(@as(u32, 1), yoga.testContentsChildCount(node));
    try std.testing.expectEqual(child, out);
    try yoga.check(yoga.yogaNodeCalculateLayoutChecked(node, 20, 10, 1));
    yoga.testFailAfter(0);
    try yoga.check(yoga.yogaNodeRemoveChildChecked(node, child));
    try std.testing.expectEqual(@as(u32, 0), yoga.testContentsChildCount(node));
    // Reset keeps the detached child storage, so reinsertion does not allocate.
    const bytes = yoga.nodeStorageBytes(node);
    try yoga.check(yoga.yogaNodeResetChecked(node));
    try std.testing.expectEqual(bytes, yoga.nodeStorageBytes(node));
    try yoga.check(yoga.yogaNodeInsertChildChecked(node, child, 0));
    try std.testing.expectEqual(@as(u32, 1), yoga.testContentsChildCount(node));
    try yoga.check(yoga.yogaNodeRemoveAllChildrenChecked(node));
    try std.testing.expectEqual(@as(u32, 0), yoga.testContentsChildCount(node));
}

test "Yoga checked nonroot layout failure poisons only the connected mixed-config tree" {
    defer yoga.testFailAfter(-1);
    var first: yoga.Config = undefined;
    try first.init(std.testing.allocator, .{});
    defer first.deinit();
    var second: yoga.Config = undefined;
    try second.init(std.testing.allocator, .{});
    defer second.deinit();
    const root = try first.createNode();
    defer yoga.yogaNodeFreeRecursive(root);
    const child = try second.createNode();
    const grandchild = try first.createNode();
    const sibling = try second.createNode();
    const unrelated = try first.createNode();
    defer yoga.yogaNodeFree(unrelated);
    try yoga.check(yoga.yogaNodeInsertChildChecked(root, child, 0));
    try yoga.check(yoga.yogaNodeInsertChildChecked(root, sibling, 1));
    try yoga.check(yoga.yogaNodeInsertChildChecked(child, grandchild, 0));
    yoga.testFailAfter(0);
    try std.testing.expectEqual(yoga.Status.out_of_memory, yoga.yogaNodeCalculateLayoutChecked(child, 100, 100, 1));
    for ([_]yoga.YGNodeRef{ root, child, grandchild, sibling }) |node| {
        var geometry: yoga.ExternalYogaLayout = .{ .left = 123, .top = 123, .right = 123, .bottom = 123, .width = 123, .height = 123 };
        try std.testing.expectEqual(yoga.Status.poisoned, yoga.yogaNodeGetComputedLayoutChecked(node, &geometry));
        try std.testing.expectEqual(@as(f32, 123), geometry.width);
        try std.testing.expectEqual(yoga.Status.poisoned, yoga.yogaNodeCalculateLayoutChecked(node, 10, 10, 1));
        try std.testing.expectEqual(yoga.Status.poisoned, yoga.yogaNodeStyleSetFloatChecked(node, 0, 1));
        try std.testing.expectEqual(yoga.Status.poisoned, yoga.yogaNodeStyleSetDimensionChecked(node, 0, 1, 1, 1));
        try std.testing.expectEqual(yoga.Status.poisoned, yoga.yogaNodeStyleSetPositionsChecked(node, 1, &.{ 1, 1, 1, 1 }, &.{ 1, 1, 1, 1 }));
        try std.testing.expectEqual(yoga.Status.poisoned, yoga.yogaNodeSetHasNewLayoutChecked(node, 0));
        try std.testing.expectEqual(yoga.Status.poisoned, yoga.yogaNodeStyleGetFloatChecked(node, 0, &geometry.width));
        try std.testing.expectEqual(yoga.Status.poisoned, yoga.yogaNodeLayoutGetEdgeChecked(node, 0, 0, &geometry.width));
        yoga.yogaNodeGetComputedLayout(node, &geometry);
        try std.testing.expect(std.math.isNan(geometry.width));
        try yoga.check(yoga.yogaNodeUnsetMeasureFuncChecked(node));
        try yoga.check(yoga.yogaNodeUnsetDirtiedFuncChecked(node));
    }
    try yoga.check(yoga.yogaNodeCalculateLayoutChecked(unrelated, 20, 10, 1));
    try std.testing.expectEqual(root, yoga.yogaNodeGetParent(child));
    try std.testing.expectEqual(yoga.Status.poisoned, yoga.yogaNodeMoveChildChecked(unrelated, child, 0));
    try std.testing.expectEqual(root, yoga.yogaNodeGetParent(child));
    try yoga.check(yoga.yogaNodeRemoveChildChecked(child, grandchild));
    yoga.yogaNodeFree(grandchild);
    // Leave the fault armed through both mixed-config and recursive teardown.
    yoga.yogaNodeFreeRecursive(child);
    try yoga.check(yoga.yogaConfigSetPointScaleFactorChecked(first.ref, 1));
    try yoga.check(yoga.yogaConfigSetPointScaleFactorChecked(second.ref, 1));
}

test "Yoga checked native editor measurement OOM is not a successful one-cell layout" {
    const native = @import("../native-renderable.zig");
    const editor = @import("../editor-view.zig");
    const edit = @import("../edit-buffer.zig");
    const grapheme = @import("../grapheme.zig");
    const link = @import("../link.zig");
    var graphemes = grapheme.GraphemePool.init(std.testing.allocator);
    defer graphemes.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const buffer = try edit.EditBuffer.init(std.testing.allocator, &graphemes, &links, .unicode, null);
    defer buffer.deinit();
    try buffer.setText("word tail");
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    const view = try editor.EditorView.init(failing.allocator(), buffer, 8, 4);
    defer view.deinit();
    view.getTextBufferView().setWrapMode(.word);
    var config: yoga.Config = undefined;
    try config.init(std.testing.allocator, .{});
    defer config.deinit();
    var renderable = try native.NativeRenderable.initWithConfig(&config);
    defer renderable.deinit();
    try renderable.setMeasureTarget(.{ .editor_view = view });
    failing.fail_index = failing.alloc_index;
    try std.testing.expectEqual(yoga.Status.out_of_memory, yoga.yogaNodeCalculateLayoutChecked(renderable.yoga_node, 8, std.math.nan(f32), 1));
    try std.testing.expect(failing.has_induced_failure);
    try std.testing.expectEqual(yoga.Status.poisoned, yoga.yogaNodeCalculateLayoutChecked(renderable.yoga_node, 8, 4, 1));
}

test "Yoga checked frees owned nodes iteratively at the depth limit with faults armed" {
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    var config: yoga.Config = undefined;
    try config.init(failing.allocator(), .{});
    defer config.deinit();
    defer yoga.testFailAfter(-1);
    const root = try config.createNode();
    var parent = root;
    for (1..yoga.depth_max) |_| {
        const child = try config.createNode();
        try yoga.check(yoga.yogaNodeInsertChildChecked(parent, child, 0));
        parent = child;
    }
    try yoga.check(yoga.yogaNodeStyleSetDimensionChecked(parent, 0, 1, 7, 0));
    try yoga.check(yoga.yogaNodeStyleSetDimensionChecked(parent, 1, 1, 3, 0));
    try yoga.check(yoga.yogaNodeCalculateLayoutChecked(root, std.math.nan(f32), std.math.nan(f32), 1));
    for ([_]yoga.YGNodeRef{ root, parent }) |node| {
        var result: yoga.ExternalYogaLayout = undefined;
        try yoga.check(yoga.yogaNodeGetComputedLayoutChecked(node, &result));
        try std.testing.expectEqual(@as(f32, 7), result.width);
        try std.testing.expectEqual(@as(f32, 3), result.height);
    }
    try yoga.check(yoga.yogaNodeCalculateLayoutChecked(root, std.math.nan(f32), std.math.nan(f32), 1));
    const beyond = try config.createNode();
    try std.testing.expectEqual(yoga.Status.depth_limit, yoga.yogaNodeInsertChildChecked(parent, beyond, 0));
    const source = try config.createNode();
    try yoga.check(yoga.yogaNodeInsertChildChecked(source, beyond, 0));
    try std.testing.expectEqual(yoga.Status.depth_limit, yoga.yogaNodeMoveChildChecked(parent, beyond, 0));
    try std.testing.expectEqual(source, yoga.yogaNodeGetParent(beyond));
    try yoga.check(yoga.yogaNodeFreeRecursiveChecked(source));
    var node_count: u32 = 0;
    var cursor = config.nodes;
    while (cursor) |node| : (cursor = node.config_next) node_count += 1;
    try std.testing.expectEqual(@as(u32, yoga.depth_max), node_count);
    failing.fail_index = failing.alloc_index;
    yoga.testFailAfter(0);
    try yoga.check(yoga.yogaNodeFreeRecursiveChecked(root));
    try std.testing.expect(!config.hasLiveNodes());
    try std.testing.expectEqual(failing.allocated_bytes, failing.freed_bytes);
    try std.testing.expectEqual(@as(u64, 0), yoga.testAllocationCount());
}

test "Yoga checked recursive teardown preserves first-child dirtied callback order" {
    const Recorder = struct {
        nodes: [3]yoga.YGNodeConstRef = @splat(null),
        live_counts: [3]usize = @splat(0),
        config: *yoga.Config = undefined,
        count: usize = 0,
        fn dirty(target: ?*anyopaque, node: yoga.YGNodeConstRef) void {
            const self: *@This() = @ptrCast(@alignCast(target.?));
            std.debug.assert(self.count < self.nodes.len);
            self.nodes[self.count] = node;
            var cursor = self.config.nodes;
            while (cursor) |live| : (cursor = live.config_next) self.live_counts[self.count] += 1;
            self.count += 1;
        }
    };
    var recorder: Recorder = .{};
    var config: yoga.Config = undefined;
    try config.init(std.testing.allocator, .{ .user_data = &recorder, .dirtied = Recorder.dirty });
    defer config.deinit();
    recorder.config = &config;
    const root = try config.createNode();
    const first = try config.createNode();
    const second = try config.createNode();
    try yoga.check(yoga.yogaNodeInsertChildChecked(root, first, 0));
    try yoga.check(yoga.yogaNodeInsertChildChecked(root, second, 1));
    for ([_]yoga.YGNodeRef{ first, second }) |branch| {
        try yoga.check(yoga.yogaNodeInsertChildChecked(branch, try config.createNode(), 0));
    }
    for ([_]yoga.YGNodeRef{ root, first, second }) |node| try yoga.check(yoga.yogaNodeSetDirtiedFuncChecked(node, 1));
    try yoga.check(yoga.yogaNodeCalculateLayoutChecked(root, 20, 10, 1));
    try yoga.check(yoga.yogaNodeFreeRecursiveChecked(root));
    // Yoga dirties a removed child without its callback (facebook/yoga#1868), so only the root
    // reports, before any node is freed.
    try std.testing.expectEqualSlices(yoga.YGNodeConstRef, &.{ root, null, null }, &recorder.nodes);
    try std.testing.expectEqualSlices(usize, &.{ 5, 0, 0 }, &recorder.live_counts);
}

// Upstream's removal dirties the detached child (facebook/yoga#1868); the scene's index removal must too.
test "Yoga removal by node and by index both leave the detached child dirty" {
    for (0..2) |by_index| {
        const root = yoga.yogaNodeCreate();
        defer yoga.yogaNodeFree(root);
        const child = yoga.yogaNodeCreate();
        defer yoga.yogaNodeFree(child);
        yoga.yogaNodeInsertChild(root, child, 0);
        yoga.yogaNodeCalculateLayout(root, 10, 10, @backingInt(yoga.YogaDirection.ltr));
        if (by_index == 1) yoga.yogaNodeRemoveChildAt(root, child, 0) else yoga.yogaNodeRemoveChild(root, child);
        var dirty: u32 = 0;
        try yoga.check(yoga.yogaNodeIsDirtyChecked(child, &dirty));
        try std.testing.expectEqual(@as(u32, 1), dirty);
    }
}

test "Yoga checked host callback fallback remains recoverable and rejects layout mutation" {
    const Host = struct {
        var recover = false;
        var mutation: yoga.Status = .ok;
        var compound: [3]yoga.Status = @splat(.ok);
        fn measure(node: ?*anyopaque, _: f32, _: u32, _: f32, _: u32) callconv(.c) void {
            const ref: yoga.YGNodeRef = @ptrCast(node);
            mutation = yoga.yogaNodeStyleSetFloatChecked(ref, 0, 1);
            compound = .{
                yoga.yogaNodeStyleSetDimensionChecked(ref, 0, 1, 1, 1),
                yoga.yogaNodeStyleSetPositionsChecked(ref, 1, &.{ 1, 1, 1, 1 }, &.{ 1, 1, 1, 1 }),
                yoga.yogaNodeMoveChildChecked(ref, ref, 0),
            };
            if (recover) yoga.yogaStoreMeasureResult(yoga.yogaNodeGetConfig(ref), 7, 2);
        }
        fn dirty(_: ?*anyopaque) callconv(.c) void {}
    };
    Host.recover = false;
    var config: yoga.Config = undefined;
    try config.init(std.testing.allocator, .{});
    defer config.deinit();
    const node = try config.createNode();
    defer yoga.yogaNodeFree(node);
    try std.testing.expect(yoga.yogaConfigSetCallbacks(config.ref, Host.measure, Host.dirty));
    try yoga.check(yoga.yogaNodeSetMeasureFuncChecked(node, 1));
    try yoga.check(yoga.yogaNodeCalculateLayoutChecked(node, std.math.nan(f32), std.math.nan(f32), 1));
    try std.testing.expectEqual(yoga.Status.busy, Host.mutation);
    for (Host.compound) |status| try std.testing.expectEqual(yoga.Status.busy, status);
    Host.recover = true;
    try yoga.check(yoga.yogaNodeMarkDirtyChecked(node));
    try yoga.check(yoga.yogaNodeCalculateLayoutChecked(node, std.math.nan(f32), std.math.nan(f32), 1));
    var result: yoga.ExternalYogaLayout = undefined;
    try yoga.check(yoga.yogaNodeGetComputedLayoutChecked(node, &result));
    try std.testing.expectEqual(@as(f32, 7), result.width);
}

test "OpenTUI default Yoga nodes are independent of Context and heap-owned configs" {
    const context = @import("../context.zig");
    const first = yoga.yogaNodeCreateForOpenTUI();
    defer yoga.yogaNodeFree(first);
    const owner = try context.Context.init(std.testing.allocator, std.testing.io, .{
        .object_capacity = 1,
        .render_cells_max = 1,
    });
    try owner.deinit();
    const owned = yoga.yogaConfigCreate();
    const node = yoga.yogaNodeCreateWithConfig(owned);
    try std.testing.expect(yoga.yogaNodeGetConfig(first) != owned);
    try std.testing.expect(!yoga.yogaConfigFree(owned));
    yoga.yogaNodeFree(node);
    try std.testing.expect(yoga.yogaConfigFree(owned));
    const second = yoga.yogaNodeCreateForOpenTUI();
    defer yoga.yogaNodeFree(second);
    const shared = yoga.yogaNodeGetConfig(first);
    try std.testing.expect(shared == yoga.yogaNodeGetConfig(second));
    try std.testing.expect(!yoga.yogaConfigGetUseWebDefaults(shared));
    try std.testing.expectEqual(@as(f32, 1), yoga.yogaConfigGetPointScaleFactor(shared));
}

test "OpenTUI default Yoga config links nodes from concurrent threads" {
    const Worker = struct {
        gate: *std.Io.Event,
        running: *std.atomic.Value(u32),
        status: yoga.Status = .ok,

        fn run(self: *@This()) void {
            defer _ = self.running.fetchSub(1, .release);
            self.gate.waitUncancelable(std.testing.io);
            var live: [8]yoga.YGNodeRef = @splat(null);
            defer for (live) |node| if (node != null) yoga.yogaNodeFree(node);
            for (0..20_000) |index| {
                const slot = &live[(index * 7) % live.len];
                if (slot.* != null) self.status = yoga.yogaNodeFreeChecked(slot.*);
                slot.* = null;
                if (self.status == .ok) self.status = yoga.yogaNodeCreateForOpenTUIChecked(slot);
                if (self.status != .ok) return;
            }
        }
    };
    const node = yoga.yogaNodeCreateForOpenTUI();
    const ref: yoga.YGConfigRef = @constCast(yoga.yogaNodeGetConfig(node));
    var gate: std.Io.Event = .unset;
    var workers: [4]Worker = undefined;
    var running: std.atomic.Value(u32) = .init(workers.len);
    var threads: [workers.len]std.Thread = undefined;
    var spawned: usize = 0;
    defer {
        gate.set(std.testing.io);
        for (threads[0..spawned]) |thread| thread.join();
    }
    for (&workers, &threads) |*worker, *thread| {
        worker.* = .{ .gate = &gate, .running = &running };
        thread.* = try std.Thread.spawn(.{}, Worker.run, .{worker});
        spawned += 1;
    }
    gate.set(std.testing.io);
    // Setters walk every node of the config while the workers link and unlink.
    while (running.load(.acquire) != 0) try yoga.check(yoga.yogaConfigSetPointScaleFactorChecked(ref, 1));
    for (workers) |worker| try yoga.check(worker.status);
    yoga.yogaNodeFree(node);
    const config: *yoga.Config = @ptrCast(@alignCast(@import("yoga").YGConfigGetContext(ref)));
    try std.testing.expect(!config.hasLiveNodes());
}

test "Yoga wrapper computes basic flex layout" {
    const config = yoga.yogaConfigCreate();
    defer std.debug.assert(yoga.yogaConfigFree(config));

    const root = yoga.yogaNodeCreateWithConfig(config);
    defer yoga.yogaNodeFree(root);

    yoga.yogaNodeStyleSetEnum(root, @backingInt(yoga.YogaEnumKind.flex_direction), @backingInt(yoga.YogaFlexDirection.row));
    yoga.yogaNodeStyleSetValue(root, @backingInt(yoga.YogaValueKind.width), 0, @backingInt(yoga.YogaUnit.point), 100);
    yoga.yogaNodeStyleSetValue(root, @backingInt(yoga.YogaValueKind.height), 0, @backingInt(yoga.YogaUnit.point), 100);

    const child = yoga.yogaNodeCreateWithConfig(config);
    defer yoga.yogaNodeFree(child);
    yoga.yogaNodeStyleSetFloat(child, @backingInt(yoga.YogaFloatKind.flex_grow), 1);
    yoga.yogaNodeInsertChild(root, child, 0);

    yoga.yogaNodeCalculateLayout(root, std.math.nan(f32), std.math.nan(f32), @backingInt(yoga.YogaDirection.ltr));

    var layout: yoga.ExternalYogaLayout = undefined;
    yoga.yogaNodeGetComputedLayout(child, &layout);
    try std.testing.expectApproxEqAbs(@as(f32, 100), layout.width, 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 100), layout.height, 0.001);
}

test "Yoga wrapper packs style values" {
    const node = yoga.yogaNodeCreate();
    defer yoga.yogaNodeFree(node);

    yoga.yogaNodeStyleSetValue(node, @backingInt(yoga.YogaValueKind.flex_basis), 0, @backingInt(yoga.YogaUnit.point), 10);
    const packed_value = yoga.yogaNodeStyleGetValue(node, @backingInt(yoga.YogaValueKind.flex_basis), 0);
    const unit: u32 = @intCast(packed_value & 0xffffffff);
    const value_bits: u32 = @intCast((packed_value >> 32) & 0xffffffff);
    const value: f32 = @bitCast(value_bits);

    try std.testing.expectEqual(@as(u32, @backingInt(yoga.YogaUnit.point)), unit);
    try std.testing.expectApproxEqAbs(@as(f32, 10), value, 0.001);
}

test "Yoga finite-percent patch keeps a deep percent chain and its margins finite" {
    const config = yoga.yogaConfigCreate();
    defer std.debug.assert(yoga.yogaConfigFree(config));
    var nodes: [131]yoga.YGNodeRef = undefined;
    defer for (0..nodes.len) |index| yoga.yogaNodeFree(nodes[nodes.len - 1 - index]);
    const point = @backingInt(yoga.YogaUnit.point);
    const percent = @backingInt(yoga.YogaUnit.percent);
    for (&nodes, 0..) |*node, index| {
        node.* = yoga.yogaNodeCreateWithConfig(config);
        // Each level doubles its owner's width: 10 * 2^130 overflows f32 without the clamp.
        yoga.yogaNodeStyleSetEnum(node.*, @backingInt(yoga.YogaEnumKind.position_type), @backingInt(yoga.YogaPositionType.absolute));
        yoga.yogaNodeStyleSetValue(node.*, @backingInt(yoga.YogaValueKind.width), 0, if (index == 0) point else percent, if (index == 0) 10 else 200);
        yoga.yogaNodeStyleSetValue(node.*, @backingInt(yoga.YogaValueKind.height), 0, point, 4);
        if (index != 0) yoga.yogaNodeInsertChild(nodes[index - 1], node.*, 0);
    }
    const leaf = nodes[nodes.len - 1];
    yoga.yogaNodeStyleSetEnum(leaf, @backingInt(yoga.YogaEnumKind.position_type), @backingInt(yoga.YogaPositionType.relative));
    yoga.yogaNodeStyleSetValue(leaf, @backingInt(yoga.YogaValueKind.margin), @import("context_abi_c").OT_EDGE_ALL, percent, -100);
    yoga.yogaNodeStyleSetFloat(leaf, @backingInt(yoga.YogaFloatKind.flex_grow), 1);
    try yoga.check(yoga.yogaNodeCalculateLayoutChecked(nodes[0], std.math.nan(f32), std.math.nan(f32), 1));
    var layout: yoga.ExternalYogaLayout = undefined;
    yoga.yogaNodeGetComputedLayout(leaf, &layout);
    try std.testing.expectEqual(@as(f32, -1e30), layout.left);
    yoga.yogaNodeGetComputedLayout(nodes[nodes.len - 2], &layout);
    try std.testing.expectEqual(@as(f32, 1e30), layout.width);
    try std.testing.expect(std.math.isFinite(layout.top));
}

// When every item of an overflowing row freezes at its minimum, float cancellation left the shrink
// total near zero or positive, and dividing by it gave the items millions of cells. An item's width
// is its minimum unless the row names another.
test "Yoga flex-shrink residue patch takes the zero-total fallback only for float residues" {
    const point = @backingInt(yoga.YogaUnit.point);
    const Item = struct { basis: f32, min: f32, padding: f32 = 0, shrink: f32 = 1, width: ?f32 = null };
    for ([_]struct { f32, []const Item }{
        // The total cancels to exactly 0, as upstream already handles.
        .{ 2, &.{ .{ .basis = 4, .min = 3 }, .{ .basis = 4, .min = 3 } } },
        // facebook/yoga#2038: the shrink total cancels to +6.1e-5.
        .{ 350, &.{ .{ .basis = 100.1, .min = 90 }, .{ .basis = 200.3, .min = 190 }, .{ .basis = 300.7, .min = 290 } } },
        // facebook/yoga#1665: the padding gives each item a basis near 1.19.
        .{ 393, &.{ .{ .basis = 0, .min = 160, .padding = 0.594443 }, .{ .basis = 0, .min = 160, .padding = 0.594442 }, .{ .basis = 0, .min = 160, .padding = 0.594442 }, .{ .basis = 0, .min = 160, .padding = 0.594442 } } },
        // Issue 404: a text measured at an "at most" width of 0.2 beside a box with a minimum width.
        .{ 0.2, &.{ .{ .basis = 4, .min = 4 }, .{ .basis = 0.2, .min = 0 } } },
        // Residues of -9.5e-7 and near -1e-6 take the fallback, basis * (1 - shrink), as 0 does.
        .{ 0, &.{ .{ .basis = 10.3, .min = 1, .shrink = 0.5, .width = 5 }, .{ .basis = 20.9, .min = 1, .shrink = 0.5, .width = 11 } } },
        .{ 0, &.{ .{ .basis = 2.03, .min = 1, .shrink = 0.5 }, .{ .basis = 3.07, .min = 1, .shrink = 0.5, .width = 2 }, .{ .basis = 4.11, .min = 1, .shrink = 0.5, .width = 2 } } },
        // A small total of an item that is not frozen still divides: 4 + 1 fills the row.
        .{ 5, &.{ .{ .basis = 4, .min = 4 }, .{ .basis = 2, .min = 0, .shrink = 1e-4, .width = 1 } } },
    }) |row| {
        const config = yoga.yogaConfigCreate();
        defer std.debug.assert(yoga.yogaConfigFree(config));
        const root = yoga.yogaNodeCreateWithConfig(config);
        defer yoga.yogaNodeFreeRecursive(root);
        yoga.yogaNodeStyleSetEnum(root, @backingInt(yoga.YogaEnumKind.flex_direction), @backingInt(yoga.YogaFlexDirection.row));
        var children: [4]yoga.YGNodeRef = undefined;
        for (row[1], children[0..row[1].len], 0..) |item, *child, index| {
            child.* = yoga.yogaNodeCreateWithConfig(config);
            yoga.yogaNodeInsertChild(root, child.*, @intCast(index));
            yoga.yogaNodeStyleSetFloat(child.*, @backingInt(yoga.YogaFloatKind.flex_shrink), item.shrink);
            yoga.yogaNodeStyleSetValue(child.*, @backingInt(yoga.YogaValueKind.flex_basis), 0, point, item.basis);
            yoga.yogaNodeStyleSetValue(child.*, @backingInt(yoga.YogaValueKind.min_width), 0, point, item.min);
            yoga.yogaNodeStyleSetValue(child.*, @backingInt(yoga.YogaValueKind.padding), @import("context_abi_c").OT_EDGE_ALL, point, item.padding);
        }
        yoga.yogaNodeCalculateLayout(root, row[0], 1, @backingInt(yoga.YogaDirection.ltr));
        for (row[1], children[0..row[1].len]) |item, child| {
            var layout: yoga.ExternalYogaLayout = undefined;
            yoga.yogaNodeGetComputedLayout(child, &layout);
            try std.testing.expectEqual(item.width orelse item.min, layout.width);
        }
    }
}

test "Yoga absolute-edge rounding patch is opt-in per config and keeps children inside their parents" {
    const api = @import("context_abi_c");
    for ([_]u32{ 0, 1 }) |enabled| {
        const config = yoga.yogaConfigCreate();
        defer std.debug.assert(yoga.yogaConfigFree(config));
        yoga.configSetRoundsPositionsFromAbsoluteEdges(config, enabled);
        const root = yoga.yogaNodeCreateWithConfig(config);
        defer yoga.yogaNodeFreeRecursive(root);
        const parent = yoga.yogaNodeCreateWithConfig(config);
        const child = yoga.yogaNodeCreateWithConfig(config);
        yoga.yogaNodeInsertChild(root, parent, 0);
        yoga.yogaNodeInsertChild(parent, child, 0);
        // The parent's edges round from 0.5 to 1; the child's absolute edges from 1.1 to 1.
        for ([_]struct { node: yoga.YGNodeRef, margin: f32, size: f32 }{
            .{ .node = parent, .margin = 0.5, .size = 20 },
            .{ .node = child, .margin = 0.6, .size = 5 },
        }) |item| {
            for ([_]u32{ api.OT_EDGE_LEFT, api.OT_EDGE_TOP }) |edge| {
                yoga.yogaNodeStyleSetValue(item.node, @backingInt(yoga.YogaValueKind.margin), edge, @backingInt(yoga.YogaUnit.point), item.margin);
            }
            yoga.yogaNodeStyleSetValue(item.node, @backingInt(yoga.YogaValueKind.width), 0, @backingInt(yoga.YogaUnit.point), item.size);
            yoga.yogaNodeStyleSetValue(item.node, @backingInt(yoga.YogaValueKind.height), 0, @backingInt(yoga.YogaUnit.point), item.size);
        }
        yoga.yogaNodeCalculateLayout(root, 40, 40, @backingInt(yoga.YogaDirection.ltr));

        var layout: yoga.ExternalYogaLayout = undefined;
        yoga.yogaNodeGetComputedLayout(child, &layout);
        // Upstream rounds the child's 0.6 offset on its own, to 1.
        const offset: f32 = if (enabled != 0) 0 else 1;
        try std.testing.expectEqual([_]f32{ offset, offset, 5, 5 }, [_]f32{ layout.left, layout.top, layout.width, layout.height });
    }
}

test "Yoga cache patches compare sizes without positive margins, round only comparable axes, and reuse sizes for larger height caps" {
    // 9.99995 is inexactly equal to 10: a size at the old cap may have been clamped.
    const values = [_]f32{ std.math.nan(f32), -1, 0, 9.6, 9.99995, 10, 10.4, 11 };
    const scales = [_]f32{ 0, 1, 2, 0.5 };
    var prng = std.Random.DefaultPrng.init(0x0707);
    const random = prng.random();
    var cached: u32 = 0;
    var larger_cap: u32 = 0;
    for (0..10_000) |_| {
        var axes: [2]yoga.TestCacheAxis = undefined;
        for (&axes) |*axis| {
            // Repeat the previous mode or size half the time, as relayout does.
            const mode = random.uintLessThan(u32, 3);
            const available = values[random.uintLessThan(usize, values.len)];
            axis.* = .{
                .mode = mode,
                .last_mode = if (random.boolean()) mode else random.uintLessThan(u32, 3),
                .available = available,
                .last_available = if (random.boolean()) available else values[random.uintLessThan(usize, values.len)],
                .computed = values[random.uintLessThan(usize, values.len)],
                .margin = @floatFromInt(random.intRangeAtMost(i32, -1, 1)),
            };
        }
        const point_scale = scales[random.uintLessThan(usize, scales.len)];
        var references: u32 = 0;
        var rounding_count: u32 = 0;
        const actual = yoga.testCacheMeasurement(&axes[0], &axes[1], point_scale, &references, &rounding_count);
        // Upstream rejects a negative cached size before it compares either axis.
        const negative = axes[0].computed < 0 or axes[1].computed < 0;
        try std.testing.expectEqual(@intFromBool(!negative and references == 3), actual);
        // An axis rounds only when its sizing modes match. An incompatible
        // width skips the height axis.
        var expected: u32 = 0;
        if (!negative and point_scale != 0) {
            if (axes[0].mode == axes[0].last_mode) expected += 2;
            if (references & 1 != 0 and axes[1].mode == axes[1].last_mode) expected += 2;
        }
        try std.testing.expectEqual(expected, rounding_count);
        cached += actual;
        // The same width input, "at most" heights, a larger cap, and a cached height below the
        // old cap, which the margin shrinks too.
        const width, const height = axes;
        const fit = 2;
        const cap = height.last_available - height.margin;
        const larger = width.mode == width.last_mode and width.available == width.last_available and
            height.mode == fit and height.last_mode == fit and height.available - height.margin > cap and
            height.computed < cap and !(cap - height.computed < 0.0001);
        try std.testing.expectEqual(@intFromBool(larger), yoga.testLargerHeightCap(&axes[0], &axes[1]));
        larger_cap += @intFromBool(larger);
    }
    try std.testing.expect(cached > 500 and cached < 9500);
    try std.testing.expect(larger_cap > 8);
    // Width, last width, height, last height, cached height, height margin; "at most" heights.
    for ([_]struct { [6]f32, u32 }{
        .{ .{ 10, 10, 12, 10, 9.6, 0 }, 1 },
        .{ .{ 10, 10, 12, 10, 10, 0 }, 0 }, // the old cap may have clamped this size
        .{ .{ 10, 10, 12, 10, 9.99995, 0 }, 0 },
        .{ .{ 10, 10, 9.8, 10, 9.6, 0 }, 0 }, // a smaller cap
        .{ .{ 10, 10.4, 12, 10, 9.6, 0 }, 0 }, // another width
        .{ .{ 10, 10, 12, 11, 9.6, 1 }, 1 }, // the margin shrinks the old cap to 10
        .{ .{ 10, 10, 12, 11, 10, 1 }, 0 },
    }) |row| {
        const v = row[0];
        const width: yoga.TestCacheAxis = .{ .mode = 0, .last_mode = 0, .available = v[0], .last_available = v[1], .computed = v[0], .margin = 0 };
        const height: yoga.TestCacheAxis = .{ .mode = 2, .last_mode = 2, .available = v[2], .last_available = v[3], .computed = v[4], .margin = v[5] };
        try std.testing.expectEqual(row[1], yoga.testLargerHeightCap(&width, &height));
    }
}

const Leaf = struct {
    len: u32 = 0,
    absolute: bool = false,
    calls: u64 = 0,
    // NativeRenderable.measure over a text of `len` cells that wraps at any cell.
    fn measure(target: ?*anyopaque, width: f32, width_mode: u32, _: f32, _: u32) callconv(.c) yoga.ExternalYogaSize {
        const self: *@This() = @ptrCast(@alignCast(target.?));
        self.calls += 1;
        const wrap: u32 = if (width_mode == @backingInt(yoga.YogaMeasureMode.undefined)) 0 else @min(@import("../native-renderable.zig").measureCells(width), 1_000_000);
        const lines = if (wrap == 0) 1 else (self.len + wrap - 1) / wrap;
        var size: yoga.ExternalYogaSize = .{ .width = @floatFromInt(@max(1, if (wrap == 0) self.len else @min(self.len, wrap))), .height = @floatFromInt(@max(1, lines)) };
        if (width_mode == @backingInt(yoga.YogaMeasureMode.at_most) and !self.absolute) size.width = @min(width, size.width);
        return size;
    }
};

// Twin trees take the same random styles, texts, and sizes; only the first twin's leaves
// reuse a size for a larger height cap. Every layout must stay byte for byte the same.
test "Yoga larger-height-cap reuse keeps every layout of random trees, texts, and sizes" {
    const api = @import("context_abi_c");
    const Twins = struct {
        nodes: [2]yoga.YGNodeRef,
        fn value(self: @This(), kind: yoga.YogaValueKind, edge: u32, unit: u32, v: f32) void {
            for (self.nodes) |node| yoga.yogaNodeStyleSetValue(node, @backingInt(kind), edge, unit, v);
        }
        fn enumValue(self: @This(), kind: yoga.YogaEnumKind, v: u32) void {
            for (self.nodes) |node| yoga.yogaNodeStyleSetEnum(node, @backingInt(kind), v);
        }
        fn float(self: @This(), kind: yoga.YogaFloatKind, v: f32) void {
            for (self.nodes) |node| yoga.yogaNodeStyleSetFloat(node, @backingInt(kind), v);
        }
    };
    const max_nodes = 40;
    const point = @backingInt(yoga.YogaUnit.point);
    const percent = @backingInt(yoga.YogaUnit.percent);
    const edges = [_]u32{ api.OT_EDGE_TOP, api.OT_EDGE_BOTTOM, api.OT_EDGE_ALL };
    const widths = [_]f32{ 20, 37.5, 40, 61 };
    var prng = std.Random.DefaultPrng.init(0x352);
    const random = prng.random();
    var calls = [2]u64{ 0, 0 };
    for (0..300) |_| {
        var configs: [2]yoga.YGConfigRef = undefined;
        var nodes: [2][max_nodes]yoga.YGNodeRef = undefined;
        var leaves: [2][max_nodes]Leaf = @splat(@splat(.{}));
        var children: [max_nodes]u32 = @splat(0);
        var is_leaf: [max_nodes]bool = @splat(false);
        var count: usize = 1;
        const rounding = random.boolean();
        for (&configs, &nodes) |*config, *list| {
            config.* = yoga.yogaConfigCreate();
            yoga.configSetRoundsPositionsFromAbsoluteEdges(config.*, @intFromBool(rounding));
            list[0] = yoga.yogaNodeCreateWithConfig(config.*);
        }
        defer for (configs, nodes) |config, list| {
            yoga.yogaNodeFreeRecursive(list[0]);
            std.debug.assert(yoga.yogaConfigFree(config));
        };
        for (0..40) |_| {
            const index = random.uintLessThan(usize, count);
            const twins: Twins = .{ .nodes = .{ nodes[0][index], nodes[1][index] } };
            switch (if (count < 6) 0 else random.uintLessThan(u32, 4)) {
                // A leaf of random text or a box, appended to a random box.
                0 => if (count < max_nodes) {
                    var parent = random.uintLessThan(usize, count);
                    while (is_leaf[parent]) parent = random.uintLessThan(usize, count);
                    const leaf = random.uintLessThan(u32, 3) != 0;
                    for (&nodes, configs, 0..) |*list, config, twin| {
                        list[count] = yoga.yogaNodeCreateWithConfig(config);
                        yoga.yogaNodeInsertChild(list[parent], list[count], children[parent]);
                        if (leaf) try yoga.check(yoga.yogaNodeSetNativeMeasureFunc(list[count], &leaves[twin][count], &Leaf.measure, twin == 0));
                    }
                    const added: Twins = .{ .nodes = .{ nodes[0][count], nodes[1][count] } };
                    if (random.boolean()) added.enumValue(.flex_direction, @backingInt(yoga.YogaFlexDirection.row));
                    added.float(.flex_shrink, @floatFromInt(random.uintLessThan(u32, 2)));
                    if (random.uintLessThan(u32, 4) == 0) added.float(.flex_grow, 1);
                    if (random.uintLessThan(u32, 4) == 0) added.value(.margin, edges[random.uintLessThan(usize, 3)], if (random.boolean()) point else percent, if (random.boolean()) 1 else 2.5);
                    if (random.uintLessThan(u32, 4) == 0) added.value(.padding, edges[random.uintLessThan(usize, 3)], if (random.boolean()) point else percent, if (random.boolean()) 1 else 5);
                    if (random.uintLessThan(u32, 6) == 0) added.value(.min_height, 0, if (random.boolean()) point else percent, @floatFromInt(random.intRangeAtMost(u32, 2, 60)));
                    if (random.uintLessThan(u32, 6) == 0) added.value(.max_height, 0, if (random.boolean()) point else percent, @floatFromInt(random.intRangeAtMost(u32, 2, 60)));
                    switch (random.uintLessThan(u32, 4)) {
                        0 => added.value(.width, 0, percent, 100),
                        1 => added.value(.width, 0, point, @floatFromInt(random.intRangeAtMost(u32, 5, 30))),
                        else => {},
                    }
                    if (random.uintLessThan(u32, 4) == 0) added.enumValue(.overflow, api.OT_OVERFLOW_HIDDEN);
                    if (random.uintLessThan(u32, 4) == 0) added.enumValue(.align_self, random.intRangeAtMost(u32, api.OT_ALIGN_FLEX_START, api.OT_ALIGN_STRETCH));
                    if (random.uintLessThan(u32, 6) == 0) added.value(.gap, api.OT_GUTTER_ALL, point, 1);
                    const absolute = random.uintLessThan(u32, 10) == 0;
                    if (absolute) added.enumValue(.position_type, api.OT_POSITION_ABSOLUTE);
                    const len = random.uintAtMost(u32, 120);
                    for (&leaves) |*twin| twin[count] = .{ .len = len, .absolute = absolute };
                    children[parent] += 1;
                    is_leaf[count] = leaf;
                    count += 1;
                },
                // A text grows or shrinks.
                1 => if (is_leaf[index]) {
                    const len = random.uintAtMost(u32, 120);
                    for (&leaves, twins.nodes) |*twin, node| {
                        twin[index].len = len;
                        yoga.yogaNodeInvalidateMeasure(node);
                    }
                },
                // A box's height becomes fixed, a percent, or its content.
                2 => if (!is_leaf[index]) switch (random.uintLessThan(u32, 3)) {
                    0 => twins.value(.height, 0, point, @floatFromInt(random.intRangeAtMost(u32, 3, 30))),
                    1 => twins.value(.height, 0, percent, 50),
                    else => twins.value(.height, 0, @backingInt(yoga.YogaUnit.auto), 0),
                },
                else => if (index != 0) twins.enumValue(.display, random.uintLessThan(u32, 2)),
            }
            const height: f32 = if (random.boolean()) std.math.nan(f32) else @floatFromInt(random.intRangeAtMost(u32, 5, 40));
            const width = widths[random.uintLessThan(usize, widths.len)];
            for (nodes) |list| yoga.yogaNodeCalculateLayout(list[0], width, height, @backingInt(yoga.YogaDirection.ltr));
            for (nodes[0][0..count], nodes[1][0..count]) |first, second| {
                var layouts: [2]yoga.ExternalYogaLayout = undefined;
                yoga.yogaNodeGetComputedLayout(first, &layouts[0]);
                yoga.yogaNodeGetComputedLayout(second, &layouts[1]);
                try std.testing.expectEqualSlices(u8, std.mem.asBytes(&layouts[1]), std.mem.asBytes(&layouts[0]));
                // Margin, padding, and border of each edge, which only a measure call writes.
                for (0..3) |kind| for (0..4) |edge| {
                    var values: [2]f32 = undefined;
                    for ([_]yoga.YGNodeRef{ first, second }, &values) |node, *out| try yoga.check(yoga.yogaNodeLayoutGetEdgeChecked(node, @intCast(kind), @intCast(edge), out));
                    try std.testing.expectEqual(values[1], values[0]);
                };
            }
        }
        for (&calls, leaves) |*total, twin| {
            for (twin[0..count]) |leaf| total.* += leaf.calls;
        }
    }
    try std.testing.expect(calls[0] + 500 < calls[1]);
}

// Yoga's "stricter size" cache rule compared a new size without the margin with an old size
// with it, so a leaf that grew by less than its margin kept its old size, and its rules compared
// the size after min and max, so a leaf widened by its minimum kept a narrower text's height. A
// subtree that a layout-cache hit skipped rounded again from rounded positions, and a box with
// percent-bounded children kept a layout for another owner size. Random nested measured leaves
// and static or relative boxes, with point or percent bounds, under a root whose size walks by
// up to 3 cells a solve; after each solve a fresh copy of the tree, solved once, must give every
// node the same layout.
test "Yoga incremental solves of measured leaves with margins equal fresh solves" {
    const api = @import("context_abi_c");
    const ltr = @backingInt(yoga.YogaDirection.ltr);
    const point = @backingInt(yoga.YogaUnit.point);
    const percent = @backingInt(yoga.YogaUnit.percent);
    const config = yoga.yogaConfigCreate();
    defer std.debug.assert(yoga.yogaConfigFree(config));
    yoga.configSetRoundsPositionsFromAbsoluteEdges(config, 1);
    const edges = [_]u32{ api.OT_EDGE_LEFT, api.OT_EDGE_RIGHT, api.OT_EDGE_TOP, api.OT_EDGE_BOTTOM, api.OT_EDGE_ALL };
    const bounds = [_]yoga.YogaValueKind{ .min_width, .max_width, .min_height, .max_height };
    // A measured root with a minimum width of 14, wrapped at 10 and then at 14, as fresh.
    var root_layouts: [2]yoga.ExternalYogaLayout = undefined;
    for (&root_layouts, [_]f32{ 10, 14 }) |*layout, first| {
        var text: Leaf = .{ .len = 80 };
        const root = yoga.yogaNodeCreateWithConfig(config);
        defer yoga.yogaNodeFreeRecursive(root);
        try yoga.check(yoga.yogaNodeSetNativeMeasureFunc(root, &text, &Leaf.measure, true));
        yoga.yogaNodeStyleSetValue(root, @backingInt(yoga.YogaValueKind.min_width), 0, point, 14);
        for ([_]f32{ first, 14 }) |width| yoga.yogaNodeCalculateLayout(root, width, std.math.nan(f32), ltr);
        yoga.yogaNodeGetComputedLayout(root, layout);
    }
    try std.testing.expectEqual(root_layouts[1], root_layouts[0]);
    // A text stretched or at most under a root that steps by less than 1e-4 across its wrap at
    // 10 - 1e-4, either way, as fresh.
    for ([_][2]f32{ .{ 9.99988, 9.99995 }, .{ 9.99995, 9.99988 } }) |widths| for ([_]u32{ api.OT_ALIGN_FLEX_START, api.OT_ALIGN_STRETCH }) |align_items| {
        var layouts: [2]yoga.ExternalYogaLayout = undefined;
        for (&layouts, [_][]const f32{ &widths, widths[1..] }) |*layout, steps| {
            var text: Leaf = .{ .len = 40 };
            const root = yoga.yogaNodeCreateWithConfig(config);
            defer yoga.yogaNodeFreeRecursive(root);
            const leaf = yoga.yogaNodeCreateWithConfig(config);
            yoga.yogaNodeInsertChild(root, leaf, 0);
            try yoga.check(yoga.yogaNodeSetNativeMeasureFunc(leaf, &text, &Leaf.measure, true));
            yoga.yogaNodeStyleSetEnum(root, @backingInt(yoga.YogaEnumKind.align_items), align_items);
            for (steps) |width| yoga.yogaNodeCalculateLayout(root, width, std.math.nan(f32), ltr);
            yoga.yogaNodeGetComputedLayout(leaf, layout);
        }
        try std.testing.expectEqual(layouts[1], layouts[0]);
    };
    // Static boxes centered on both axes over an absolute child at left 0, top 0, as the root grows by a cell.
    var chain_layouts: [2][4]yoga.ExternalYogaLayout = undefined;
    for (&chain_layouts, [_]f32{ 10, 11 }) |*layouts, first| {
        var chain: [4]yoga.YGNodeRef = undefined;
        for (&chain, 0..) |*node, i| {
            node.* = yoga.yogaNodeCreateWithConfig(config);
            if (i > 0) yoga.yogaNodeInsertChild(chain[i - 1], node.*, 0);
            for ([_]yoga.YogaValueKind{ .width, .height }) |kind| yoga.yogaNodeStyleSetValue(node.*, @backingInt(kind), 0, point, ([_]f32{ 10, 5, 4, 1 })[i]);
        }
        defer yoga.yogaNodeFreeRecursive(chain[0]);
        for (chain[0..2]) |node| {
            yoga.yogaNodeStyleSetEnum(node, @backingInt(yoga.YogaEnumKind.justify_content), api.OT_JUSTIFY_CENTER);
            yoga.yogaNodeStyleSetEnum(node, @backingInt(yoga.YogaEnumKind.align_items), api.OT_ALIGN_CENTER);
        }
        for (chain[1..3]) |node| yoga.yogaNodeStyleSetEnum(node, @backingInt(yoga.YogaEnumKind.position_type), api.OT_POSITION_STATIC);
        yoga.yogaNodeStyleSetEnum(chain[3], @backingInt(yoga.YogaEnumKind.position_type), api.OT_POSITION_ABSOLUTE);
        for ([_]u32{ api.OT_EDGE_LEFT, api.OT_EDGE_TOP }) |edge| yoga.yogaNodeStyleSetValue(chain[3], @backingInt(yoga.YogaValueKind.position), edge, point, 0);
        for ([_]f32{ first, 11 }) |size| {
            for ([_]yoga.YogaValueKind{ .width, .height }) |kind| yoga.yogaNodeStyleSetValue(chain[0], @backingInt(kind), 0, point, size);
            yoga.yogaNodeCalculateLayout(chain[0], std.math.nan(f32), std.math.nan(f32), ltr);
        }
        for (chain, layouts) |node, *layout| yoga.yogaNodeGetComputedLayout(node, layout);
    }
    try std.testing.expectEqual(chain_layouts[1], chain_layouts[0]);
    // A cached column in a baseline row, its child centered 1.5 cells down, as a sibling grows from 2
    // to 6, on both configs: the row's baseline adds the child's unrounded top.
    for ([_]u32{ 0, 1 }) |enabled| {
        yoga.configSetRoundsPositionsFromAbsoluteEdges(config, enabled);
        var baseline_layouts: [2][4]yoga.ExternalYogaLayout = undefined;
        for (&baseline_layouts, [_]f32{ 2, 6 }) |*layouts, first| {
            var nodes: [4]yoga.YGNodeRef = undefined;
            for (&nodes, 0..) |*node, i| {
                node.* = yoga.yogaNodeCreateWithConfig(config);
                if (i == 0) continue;
                yoga.yogaNodeInsertChild(nodes[if (i < 3) 0 else 2], node.*, if (i == 2) 1 else 0);
                yoga.yogaNodeStyleSetValue(node.*, @backingInt(yoga.YogaValueKind.width), 0, point, 2);
                yoga.yogaNodeStyleSetValue(node.*, @backingInt(yoga.YogaValueKind.height), 0, point, ([_]f32{ first, 5, 2 })[i - 1]);
            }
            defer yoga.yogaNodeFreeRecursive(nodes[0]);
            yoga.yogaNodeStyleSetEnum(nodes[0], @backingInt(yoga.YogaEnumKind.flex_direction), @backingInt(yoga.YogaFlexDirection.row));
            yoga.yogaNodeStyleSetEnum(nodes[0], @backingInt(yoga.YogaEnumKind.align_items), api.OT_ALIGN_BASELINE);
            yoga.yogaNodeStyleSetEnum(nodes[2], @backingInt(yoga.YogaEnumKind.justify_content), api.OT_JUSTIFY_CENTER);
            for ([_]f32{ first, 6 }) |height| {
                yoga.yogaNodeStyleSetValue(nodes[1], @backingInt(yoga.YogaValueKind.height), 0, point, height);
                yoga.yogaNodeCalculateLayout(nodes[0], 10, 10, ltr);
            }
            for (nodes, layouts) |node, *layout| yoga.yogaNodeGetComputedLayout(node, layout);
        }
        try std.testing.expectEqual(baseline_layouts[1], baseline_layouts[0]);
        try std.testing.expectEqual(3, baseline_layouts[0][2].top);
    }
    // A cached box 64 cells past a spacer that grows from 0.499899 to 0.499901, on each axis: the two
    // unrounded origins round to different cells but are the same float, so rounding must compare them
    // as doubles.
    for ([_]yoga.YogaFlexDirection{ .row, .column }) |direction| {
        var leaf_layouts: [2]yoga.ExternalYogaLayout = undefined;
        for (&leaf_layouts, [_]f32{ 0.499899, 0.499901 }) |*leaf_layout, first| {
            var nodes: [5]yoga.YGNodeRef = undefined;
            for (&nodes, 0..) |*node, i| {
                node.* = yoga.yogaNodeCreateWithConfig(config);
                if (i > 0) yoga.yogaNodeInsertChild(nodes[if (i < 3) 0 else i - 1], node.*, if (i == 2) 1 else 0);
            }
            defer yoga.yogaNodeFreeRecursive(nodes[0]);
            yoga.yogaNodeStyleSetEnum(nodes[0], @backingInt(yoga.YogaEnumKind.flex_direction), @backingInt(direction));
            for (nodes[2..], [_]f32{ 80, 10, 5 }, [_]f32{ 0, 64, 0.05 }) |node, size, margin| {
                for ([_]yoga.YogaValueKind{ .width, .height }) |kind| yoga.yogaNodeStyleSetValue(node, @backingInt(kind), 0, point, size);
                for ([_]u32{ api.OT_EDGE_LEFT, api.OT_EDGE_TOP }) |edge| yoga.yogaNodeStyleSetValue(node, @backingInt(yoga.YogaValueKind.margin), edge, point, margin);
            }
            for ([_]f32{ first, 0.499901 }) |spacer| {
                for ([_]yoga.YogaValueKind{ .width, .height }) |kind| yoga.yogaNodeStyleSetValue(nodes[1], @backingInt(kind), 0, point, spacer);
                yoga.yogaNodeCalculateLayout(nodes[0], std.math.nan(f32), std.math.nan(f32), ltr);
            }
            yoga.yogaNodeGetComputedLayout(nodes[4], leaf_layout);
        }
        try std.testing.expectEqual(leaf_layouts[1], leaf_layouts[0]);
    }
    // Trees whose skipped subtrees once held values a full pass would change; the test build's
    // fixed-point check is the oracle. A box made inside a display: none box (directly or one box
    // deeper, in a panel whose layout is cached) gets a laid-out subtree with fractional offsets (a
    // third of a 19-wide row, holding a row of thirds), or a new box, at once or after a restyle and
    // a solve; then a sibling's margin relayouts the root. Each node under the display: none box
    // reads 0 × 0, as on a fresh solve, on both configs.
    for ([_]u32{ 0, 1 }) |enabled| for (0..2) |depth| for ([_]enum { move, insert, restyle }{ .move, .insert, .restyle }) |change| {
        yoga.configSetRoundsPositionsFromAbsoluteEdges(config, enabled);
        const root = yoga.yogaNodeCreateWithConfig(config);
        defer yoga.yogaNodeFreeRecursive(root);
        var rows: [2]yoga.YGNodeRef = undefined;
        var moving: yoga.YGNodeRef = undefined;
        for (&rows, 0..) |*row, level| {
            row.* = yoga.yogaNodeCreateWithConfig(config);
            yoga.yogaNodeInsertChild(if (level == 0) root else moving, row.*, 0);
            yoga.yogaNodeStyleSetEnum(row.*, @backingInt(yoga.YogaEnumKind.flex_direction), @backingInt(yoga.YogaFlexDirection.row));
            yoga.yogaNodeStyleSetFloat(row.*, @backingInt(yoga.YogaFloatKind.flex_grow), 1);
            for (0..3) |i| {
                const third = yoga.yogaNodeCreateWithConfig(config);
                yoga.yogaNodeInsertChild(row.*, third, @intCast(i));
                yoga.yogaNodeStyleSetFloat(third, @backingInt(yoga.YogaFloatKind.flex_grow), 1);
                if (level == 0 and i == 1) moving = third;
            }
        }
        var parent = root;
        var hidden = root;
        // A panel whose layout is cached, `depth` boxes, the display: none box, and a box in it.
        for (0..depth + 3) |level| {
            const box = yoga.yogaNodeCreateWithConfig(config);
            yoga.yogaNodeInsertChild(parent, box, if (parent == root) 1 else 0);
            if (level == depth + 1) yoga.yogaNodeStyleSetEnum(box, @backingInt(yoga.YogaEnumKind.display), 1);
            if (level == depth + 1) hidden = box;
            parent = box;
        }
        yoga.yogaNodeCalculateLayout(root, 19, 10, ltr);
        if (change == .restyle) {
            yoga.yogaNodeStyleSetValue(parent, @backingInt(yoga.YogaValueKind.width), 0, point, 3);
            yoga.yogaNodeCalculateLayout(root, 19, 10, ltr);
        }
        if (change == .move) try yoga.check(yoga.yogaNodeMoveChildChecked(parent, moving, 0));
        if (change != .move) yoga.yogaNodeInsertChild(parent, yoga.yogaNodeCreateWithConfig(config), 0);
        yoga.yogaNodeStyleSetValue(rows[0], @backingInt(yoga.YogaValueKind.margin), api.OT_EDGE_LEFT, point, 0.5);
        yoga.yogaNodeCalculateLayout(root, 19, 10, ltr);
        var stack: [8]yoga.YGNodeRef = undefined;
        stack[0] = hidden;
        var len: usize = 1;
        while (len > 0) {
            len -= 1;
            const node = stack[len];
            var layout: yoga.ExternalYogaLayout = undefined;
            yoga.yogaNodeGetComputedLayout(node, &layout);
            try std.testing.expectEqual([2]f32{ 0, 0 }, [2]f32{ layout.width, layout.height });
            var index: u32 = 0;
            while (true) : (index += 1) {
                try yoga.check(yoga.yogaNodeGetChildChecked(node, index, &stack[len]));
                if (stack[len] == null) break;
                len += 1;
            }
        }
    };
    // A display: contents box under an infinite unrounded origin (two 3e38 offsets overflow a float):
    // a wider root measures its parent again, which zeroes the box without a flag, and then reuses
    // the parent's layout. A full pass rounds the zeros to NaN; the check skips that box.
    {
        const nodes = [_]yoga.YGNodeRef{ yoga.yogaNodeCreateWithConfig(config), yoga.yogaNodeCreateWithConfig(config), yoga.yogaNodeCreateWithConfig(config), yoga.yogaNodeCreateWithConfig(config) };
        defer yoga.yogaNodeFreeRecursive(nodes[0]);
        for (nodes[1..], nodes[0..3]) |node, owner| yoga.yogaNodeInsertChild(owner, node, 0);
        yoga.yogaNodeStyleSetEnum(nodes[0], @backingInt(yoga.YogaEnumKind.flex_direction), @backingInt(yoga.YogaFlexDirection.row));
        for ([_]yoga.YogaValueKind{ .margin, .position }) |kind| yoga.yogaNodeStyleSetValue(nodes[1], @backingInt(kind), api.OT_EDGE_LEFT, point, 3e38);
        yoga.yogaNodeStyleSetEnum(nodes[2], @backingInt(yoga.YogaEnumKind.display), 2);
        for ([_]yoga.YogaValueKind{ .width, .height }) |kind| yoga.yogaNodeStyleSetValue(nodes[3], @backingInt(kind), 0, point, 1);
        for ([_]f32{ 100, 101 }) |width| yoga.yogaNodeCalculateLayout(nodes[0], width, 10, ltr);
    }
    for (0..300) |tree| {
        var prng = std.Random.DefaultPrng.init(0x374000 + tree);
        const random = prng.random();
        var nodes: [40]yoga.YGNodeRef = undefined;
        var leaves: [40]Leaf = @splat(.{});
        var measured: [40]bool = @splat(false);
        var parents: [40]usize = @splat(0);
        var kids: [40]u32 = @splat(0);
        var count: usize = 1;
        nodes[0] = yoga.yogaNodeCreateWithConfig(config);
        defer yoga.yogaNodeFreeRecursive(nodes[0]);
        if (random.boolean()) yoga.yogaNodeStyleSetEnum(nodes[0], @backingInt(yoga.YogaEnumKind.flex_direction), @backingInt(yoga.YogaFlexDirection.row));
        var width: f32 = @floatFromInt(random.intRangeAtMost(u32, 10, 80));
        var height: f32 = @floatFromInt(random.intRangeAtMost(u32, 5, 40));
        for (0..40) |_| {
            const index = random.uintLessThan(usize, count);
            switch (if (count < 6) 0 else random.uintLessThan(u32, 3)) {
                // A measured leaf or a box, nested in a random box, static or relative.
                0 => if (count < nodes.len) {
                    const added = yoga.yogaNodeCreateWithConfig(config);
                    var parent = random.uintLessThan(usize, count);
                    while (measured[parent]) parent = random.uintLessThan(usize, count);
                    parents[count] = parent;
                    yoga.yogaNodeInsertChild(nodes[parent], added, kids[parent]);
                    kids[parent] += 1;
                    yoga.yogaNodeStyleSetEnum(added, @backingInt(yoga.YogaEnumKind.position_type), random.intRangeAtMost(u32, api.OT_POSITION_STATIC, api.OT_POSITION_RELATIVE));
                    yoga.yogaNodeStyleSetEnum(added, @backingInt(yoga.YogaEnumKind.justify_content), random.uintAtMost(u32, api.OT_JUSTIFY_FLEX_END));
                    if (random.boolean()) yoga.yogaNodeStyleSetEnum(added, @backingInt(yoga.YogaEnumKind.flex_direction), @backingInt(yoga.YogaFlexDirection.row));
                    leaves[count].len = random.uintAtMost(u32, 120);
                    measured[count] = random.uintLessThan(u32, 3) != 0;
                    if (measured[count]) try yoga.check(yoga.yogaNodeSetNativeMeasureFunc(added, &leaves[count], &Leaf.measure, true));
                    yoga.yogaNodeStyleSetFloat(added, @backingInt(yoga.YogaFloatKind.flex_shrink), @floatFromInt(random.uintLessThan(u32, 2)));
                    if (random.uintLessThan(u32, 4) == 0) yoga.yogaNodeStyleSetFloat(added, @backingInt(yoga.YogaFloatKind.flex_grow), 1);
                    if (random.uintLessThan(u32, 6) == 0) yoga.yogaNodeStyleSetValue(added, @backingInt(yoga.YogaValueKind.width), 0, point, @floatFromInt(random.intRangeAtMost(u32, 5, 30)));
                    if (random.uintLessThan(u32, 4) == 0) yoga.yogaNodeStyleSetValue(added, @backingInt(bounds[random.uintLessThan(usize, bounds.len)]), 0, if (random.boolean()) point else percent, @floatFromInt(random.intRangeAtMost(u32, 1, 100)));
                    if (random.boolean()) yoga.yogaNodeStyleSetEnum(added, @backingInt(yoga.YogaEnumKind.align_self), random.intRangeAtMost(u32, api.OT_ALIGN_FLEX_START, api.OT_ALIGN_STRETCH));
                    nodes[count] = added;
                    count += 1;
                },
                1 => if (measured[index]) {
                    leaves[index].len = random.uintAtMost(u32, 120);
                    yoga.yogaNodeInvalidateMeasure(nodes[index]);
                },
                else => if (index != 0) yoga.yogaNodeStyleSetValue(nodes[index], @backingInt(yoga.YogaValueKind.margin), edges[random.uintLessThan(usize, edges.len)], point, @floatFromInt(random.uintAtMost(u32, 3))),
            }
            width = std.math.clamp(width + @as(f32, @floatFromInt(random.intRangeAtMost(i32, -3, 3))), 5, 90);
            height = std.math.clamp(height + @as(f32, @floatFromInt(random.intRangeAtMost(i32, -3, 3))), 3, 50);
            yoga.yogaNodeCalculateLayout(nodes[0], width, height, ltr);
            var fresh: [40]yoga.YGNodeRef = undefined;
            var fresh_leaves = leaves;
            var fresh_kids: [40]u32 = @splat(0);
            for (nodes[0..count], parents[0..count], 0..) |node, parent, i| {
                fresh[i] = yoga.yogaNodeCreateWithConfig(config);
                if (i > 0) {
                    yoga.yogaNodeInsertChild(fresh[parent], fresh[i], fresh_kids[parent]);
                    fresh_kids[parent] += 1;
                }
                try yoga.check(yoga.yogaNodeCopyStyleChecked(fresh[i], node));
                if (measured[i]) try yoga.check(yoga.yogaNodeSetNativeMeasureFunc(fresh[i], &fresh_leaves[i], &Leaf.measure, true));
            }
            defer yoga.yogaNodeFreeRecursive(fresh[0]);
            yoga.yogaNodeCalculateLayout(fresh[0], width, height, ltr);
            for (nodes[0..count], fresh[0..count]) |node, fresh_node| {
                var layouts: [2]yoga.ExternalYogaLayout = undefined;
                yoga.yogaNodeGetComputedLayout(fresh_node, &layouts[0]);
                yoga.yogaNodeGetComputedLayout(node, &layouts[1]);
                try std.testing.expectEqual(layouts[0], layouts[1]);
            }
        }
    }
}

// Random trees over the styles where a list box keeps flex's result (fuzz.cpp in
// tracks/d6-list-layout): texts, column and row boxes, and nested lists as rows; point, percent,
// min and max widths; point heights; aspect ratios; margins; insets; alignment; display: none;
// absolute children; RTL; and stretch, flex-start, row, and scroll-content parents. Twin trees
// take the same styles, and only the first twin's list boxes are lists.
const ListTwins = struct {
    const max = 160;
    const edges = [_]u32{ 0, 1, 2, 3 };
    random: std.Random,
    config: yoga.YGConfigRef,
    nodes: [2][max]yoga.YGNodeRef = undefined,
    leaves: [2][max]Leaf = @splat(@splat(.{})),
    parents: [max]usize = @splat(0),
    kids: [max]u32 = @splat(0),
    lists: [max]bool = @splat(false),
    texts: [max]bool = @splat(false),
    count: usize = 0,
    direction: u32 = @backingInt(yoga.YogaDirection.ltr),
    // 1 builds the list tree alone.
    twins: usize = 2,
    // Every list box gets overflow: scroll.
    scroll: bool = false,

    fn pick(t: *ListTwins, n: u32) u32 {
        return t.random.uintLessThan(u32, n);
    }

    fn chance(t: *ListTwins, in_100: u32) bool {
        return t.pick(100) < in_100;
    }

    fn point(t: *ListTwins, lo: i32, hi: i32) f32 {
        const v: f32 = @floatFromInt(lo + @as(i32, @intCast(t.pick(@intCast(hi - lo + 1)))));
        return if (t.chance(25)) v + 0.25 * @as(f32, @floatFromInt(1 + t.pick(3))) else v;
    }

    fn add(t: *ListTwins, parent: usize, text: bool) usize {
        const i = t.count;
        t.count += 1;
        t.parents[i] = parent;
        t.texts[i] = text;
        const len = 1 + t.pick(300);
        for (t.nodes[0..t.twins], t.leaves[0..t.twins]) |*twin, *leaves| {
            twin[i] = yoga.yogaNodeCreateWithConfig(t.config);
            if (i > 0) yoga.yogaNodeInsertChild(twin[parent], twin[i], t.kids[parent]);
            leaves[i].len = len;
            if (text) yoga.check(yoga.yogaNodeSetNativeMeasureFunc(twin[i], &leaves[i], &Leaf.measure, true)) catch unreachable;
        }
        if (i > 0) t.kids[parent] += 1;
        return i;
    }

    fn value(t: *ListTwins, i: usize, kind: yoga.YogaValueKind, edge: u32, unit: yoga.YogaUnit, v: f32) void {
        for (t.nodes[0..t.twins]) |twin| yoga.yogaNodeStyleSetValue(twin[i], @backingInt(kind), edge, @backingInt(unit), v);
    }

    fn enumValue(t: *ListTwins, i: usize, kind: yoga.YogaEnumKind, v: u32) void {
        for (t.nodes[0..t.twins]) |twin| yoga.yogaNodeStyleSetEnum(twin[i], @backingInt(kind), v);
    }

    fn float(t: *ListTwins, i: usize, kind: yoga.YogaFloatKind, v: f32) void {
        for (t.nodes[0..t.twins]) |twin| yoga.yogaNodeStyleSetFloat(twin[i], @backingInt(kind), v);
    }

    fn percent(t: *ListTwins, n: u32) f32 {
        return @floatFromInt(10 * (1 + t.pick(n)));
    }

    // A row: a text, a column box, a row box, or a nested list.
    fn row(t: *ListTwins, list: usize, depth: u32) void {
        var kind = t.pick(if (depth < 2) 5 else 4);
        if (t.count + 12 > max) kind = 0;
        const r = t.add(list, kind <= 1);
        if (kind == 2) t.enumValue(r, .flex_direction, @backingInt(yoga.YogaFlexDirection.row));
        if (kind == 4) t.listBox(r, false, depth + 1);
        switch (t.pick(6)) {
            0 => t.value(r, .width, 0, .point, t.point(1, 60)),
            1 => t.value(r, .width, 0, .percent, t.percent(10)),
            else => {},
        }
        // A min above its max is outside the rules: Yoga's steps apply them in different orders.
        var min: f32 = 0;
        if (t.chance(15)) min = t.point(0, 40);
        if (min != 0) t.value(r, .min_width, 0, .point, min);
        if (t.chance(15)) t.value(r, .max_width, 0, .point, @max(min, t.point(5, 80)));
        if (t.chance(5)) t.value(r, .max_width, 0, .percent, t.percent(10));
        const has_height = t.chance(20);
        if (has_height) t.value(r, .height, 0, .point, t.point(0, 8));
        min = 0;
        if (t.chance(10)) min = t.point(0, 5);
        if (min != 0) t.value(r, .min_height, 0, .point, min);
        if (t.chance(10)) t.value(r, .max_height, 0, .point, @max(min, t.point(1, 6)));
        if (t.chance(8)) t.float(r, .aspect_ratio, 0.5 * @as(f32, @floatFromInt(1 + t.pick(6))));
        // Point, percent, and negative margins; auto ones only on the cross axis.
        for (edges) |edge| switch (t.pick(10)) {
            0 => t.value(r, .margin, edge, .percent, @floatFromInt(t.pick(15))),
            1, 2 => t.value(r, .margin, edge, .point, t.point(-1, 3)),
            3 => if (edge % 2 == 0) t.value(r, .margin, edge, .auto, 0),
            else => {},
        };
        if (t.chance(15)) t.value(r, .padding, edges[t.pick(4)], .point, t.point(0, 2));
        if (t.chance(20)) t.enumValue(r, .align_self, t.pick(5));
        if (t.chance(10)) t.value(r, .position, 0, .point, t.point(-2, 3));
        if (t.chance(10)) t.value(r, .position, 1, .point, t.point(-2, 3));
        if (t.chance(5)) t.enumValue(r, .display, 1);
        if (kind == 2 or kind == 3) {
            // Texts that grow or shrink, and boxes with percent heights where a row's height is
            // definite or the row is a row box.
            for (0..t.pick(4)) |_| {
                if (t.chance(50)) {
                    const text = t.add(r, true);
                    if (t.chance(40)) t.float(text, .flex_grow, @floatFromInt(1 + t.pick(2)));
                    if (t.chance(40)) t.float(text, .flex_shrink, 1);
                } else {
                    const box = t.add(r, false);
                    if (t.chance(50)) t.value(box, .width, 0, .point, t.point(1, 20));
                    if (t.chance(40) and (has_height or kind == 2)) {
                        t.value(box, .height, 0, .percent, t.percent(10));
                    } else t.value(box, .height, 0, .point, t.point(0, 4));
                }
            }
        }
    }

    // A list box's styles and rows. A percent gap needs a definite height.
    fn listBox(t: *ListTwins, list: usize, definite_height: bool, depth: u32) void {
        t.lists[list] = true;
        if (t.chance(40)) {
            t.value(list, .gap, 1, .point, t.point(0, 2));
        } else if (definite_height and t.chance(30)) t.value(list, .gap, 1, .percent, @floatFromInt(t.pick(20)));
        if (t.chance(30)) t.value(list, .padding, edges[t.pick(4)], .point, t.point(0, 3));
        if (t.chance(10)) t.value(list, .padding, edges[t.pick(4)], .percent, @floatFromInt(t.pick(10)));
        if (t.chance(20)) {
            const edge = edges[t.pick(4)];
            const width: f32 = @floatFromInt(1 + t.pick(2));
            for (t.nodes[0..t.twins]) |twin| yoga.check(yoga.yogaNodeStyleSetBorderChecked(twin[list], edge, width)) catch unreachable;
        }
        if (t.chance(40)) t.enumValue(list, .align_items, 1 + t.pick(4));
        if (t.scroll) t.enumValue(list, .overflow, 2);
        for (0..1 + t.pick(7)) |_| t.row(list, depth);
        if (t.chance(15)) {
            const text = t.chance(50);
            const absolute = t.add(list, text);
            for (t.leaves[0..t.twins]) |*leaves| leaves[absolute].absolute = true;
            t.enumValue(absolute, .position_type, @backingInt(yoga.YogaPositionType.absolute));
            if (t.chance(50)) {
                t.value(absolute, .position, 1, .percent, @floatFromInt(t.pick(50)));
            } else if (t.chance(50)) t.value(absolute, .position, edges[t.pick(4)], .point, t.point(0, 5));
            if (!text) t.value(absolute, .width, 0, .point, t.point(1, 10));
            if (!text) t.value(absolute, .height, 0, .point, t.point(1, 4));
        }
    }

    fn build(t: *ListTwins) void {
        if (t.chance(15)) t.direction = @backingInt(yoga.YogaDirection.rtl);
        const root = t.add(0, false);
        t.value(root, .width, 0, .point, t.point(40, 200));
        if (t.chance(50)) t.value(root, .height, 0, .point, t.point(10, 80));
        var list: usize = undefined;
        switch (t.pick(4)) {
            0 => list = t.add(root, false),
            1 => {
                t.enumValue(root, .align_items, 1);
                list = t.add(root, false);
            },
            2 => {
                t.enumValue(root, .flex_direction, @backingInt(yoga.YogaFlexDirection.row));
                // A baseline reads the list's first row, also through a column wrapper.
                if (t.chance(30)) t.enumValue(root, .align_items, 5);
                list = t.add(if (t.chance(20)) t.add(root, false) else root, false);
                if (t.chance(50)) t.float(list, .flex_grow, 1);
            },
            else => {
                // ScrollBox content, with and without scrollX.
                const viewport = t.add(root, false);
                t.value(viewport, .height, 0, .point, t.point(5, 60));
                t.enumValue(viewport, .overflow, 1);
                list = t.add(viewport, false);
                t.enumValue(list, .align_self, 1);
                t.value(list, .min_width, 0, .percent, 100);
                t.value(list, .min_height, 0, .percent, 100);
                if (t.chance(50)) t.value(list, .max_width, 0, .percent, 100);
            },
        }
        if (t.chance(25)) t.value(list, .width, 0, .point, t.point(10, 120));
        const definite_height = t.chance(20);
        if (definite_height) t.value(list, .height, 0, .point, t.point(5, 60));
        if (t.chance(10)) t.value(list, .max_height, 0, .point, t.point(5, 60));
        if (t.chance(10)) t.enumValue(list, .overflow, 1 + t.pick(2));
        if (t.chance(10)) t.value(list, .min_width, 0, .point, t.point(0, 80));
        t.listBox(list, definite_height, 0);
        for (0..t.count) |i| if (t.lists[i]) t.setList(i, true);
    }

    fn setList(t: *ListTwins, i: usize, on: bool) void {
        yoga.check(yoga.yogaNodeStyleSetEnumChecked(t.nodes[0][i], @backingInt(yoga.YogaEnumKind.layout_mode), @intFromBool(on))) catch unreachable;
    }

    fn solve(t: *ListTwins, twin: usize) void {
        yoga.yogaNodeCalculateLayout(t.nodes[twin][0], std.math.nan(f32), std.math.nan(f32), t.direction);
    }

    // The first twin's subtree from `node`, copied into a fresh tree: each node's style, list
    // mode, and text.
    fn copy(t: *ListTwins, node: yoga.YGNodeRef, leaves: *[max]Leaf, out: *[max]yoga.YGNodeRef) !yoga.YGNodeRef {
        const i = std.mem.indexOfScalar(yoga.YGNodeRef, t.nodes[0][0..t.count], node).?;
        out[i] = yoga.yogaNodeCreateWithConfig(t.config);
        try yoga.check(yoga.yogaNodeCopyStyleChecked(out[i], node));
        if (yoga.yogaNodeStyleGetEnum(node, @backingInt(yoga.YogaEnumKind.layout_mode)) == 1) {
            try yoga.check(yoga.yogaNodeStyleSetEnumChecked(out[i], @backingInt(yoga.YogaEnumKind.layout_mode), 1));
        }
        var index: u32 = 0;
        var child: yoga.YGNodeRef = undefined;
        while (true) : (index += 1) {
            try yoga.check(yoga.yogaNodeGetChildChecked(node, index, &child));
            if (child == null) break;
            yoga.yogaNodeInsertChild(out[i], try t.copy(child, leaves, out), index);
        }
        if (t.texts[i]) {
            leaves[i] = t.leaves[0][i];
            try yoga.check(yoga.yogaNodeSetNativeMeasureFunc(out[i], &leaves[i], &Leaf.measure, true));
        }
        return out[i];
    }
};

// D6, invariants 2-5: on the styles a list keeps, list layout equals flex bit for bit; a mode
// change dirties the box; and random mutations of list trees, solved again, equal fresh copies.
// A list gives its rows no height cap, as flex does in a column with overflow: scroll, so both
// twins' list boxes scroll.
test "Yoga list layout equals flex where its rules keep flex's result, and incremental list solves equal fresh ones" {
    const exact = yoga.yogaConfigCreate();
    defer std.debug.assert(yoga.yogaConfigFree(exact));
    yoga.configSetRoundsPositionsFromAbsoluteEdges(exact, 1);
    try yoga.check(yoga.yogaConfigSetPointScaleFactorChecked(exact, 0));
    for (0..20_000) |seed| {
        var prng = std.Random.DefaultPrng.init(0xd6_0000 + seed);
        var t: ListTwins = .{ .random = prng.random(), .config = exact, .scroll = true };
        t.build();
        defer for (t.nodes) |twin| yoga.yogaNodeFreeRecursive(twin[0]);
        for (0..2) |twin| t.solve(twin);
        for (t.nodes[0][0..t.count], t.nodes[1][0..t.count]) |list, flex| try expectSameLayout(list, flex, true);
    }
    // Mutations of list trees with rounding on, so the test build's fixed-point check runs on each
    // solve: a text, display: none, a move to another box or index, a position type, a mode toggle,
    // the root's width by a scrollbar or a fraction and its height, an appended text, a list's
    // style, a node's max width, a measure function set or unset, the config's errata, and the
    // direction. A quarter of the solves follow two mutations. With the row memo on, and again
    // checking each reuse (invariants 6 and 7), each solve equals a fresh solve with the memo off.
    const rounded = yoga.yogaConfigCreate();
    defer std.debug.assert(yoga.yogaConfigFree(rounded));
    yoga.configSetRoundsPositionsFromAbsoluteEdges(rounded, 1);
    defer yoga.testSetListMemo(1);
    for ([_]u32{ 1, 2 }) |memo| for (0..1_000) |seed| {
        var prng = std.Random.DefaultPrng.init(0xd6_8000 + seed);
        var t: ListTwins = .{ .random = prng.random(), .config = rounded, .twins = 1 };
        t.build();
        defer yoga.yogaNodeFreeRecursive(t.nodes[0][0]);
        defer yoga.check(yoga.yogaConfigSetErrataChecked(rounded, 0)) catch unreachable;
        yoga.testSetListMemo(memo);
        t.solve(0);
        var root: yoga.ExternalYogaLayout = undefined;
        yoga.yogaNodeGetComputedLayout(t.nodes[0][0], &root);
        var margin: f32 = 0;
        for (0..8) |_| {
            // A config or direction change dirties nothing; another change, here the root's bottom
            // margin, makes the next frame solve.
            var force = false;
            for (0..@as(u32, if (t.chance(25)) 2 else 1)) |_| {
                const i = 1 + t.pick(@intCast(t.count - 1));
                const node = t.nodes[0][i];
                switch (t.pick(14)) {
                    0 => if (t.texts[i]) {
                        t.leaves[0][i].len = 1 + t.pick(300);
                        yoga.yogaNodeInvalidateMeasure(node);
                    },
                    1 => yoga.yogaNodeStyleSetEnum(node, @backingInt(yoga.YogaEnumKind.display), t.pick(2)),
                    2 => {
                        const parent: usize = t.pick(@intCast(t.count));
                        var ancestor = parent;
                        while (ancestor != 0 and ancestor != i) ancestor = t.parents[ancestor];
                        if (t.texts[parent] or ancestor == i or parent == i) continue;
                        const same = t.parents[i] == parent;
                        try yoga.check(yoga.yogaNodeMoveChildChecked(t.nodes[0][parent], node, t.pick(t.kids[parent] + @intFromBool(!same))));
                        t.kids[t.parents[i]] -= 1;
                        t.kids[parent] += 1;
                        t.parents[i] = parent;
                    },
                    3 => yoga.yogaNodeStyleSetEnum(node, @backingInt(yoga.YogaEnumKind.position_type), t.pick(3)),
                    4 => if (!t.texts[i]) {
                        t.lists[i] = !t.lists[i];
                        t.setList(i, t.lists[i]);
                    },
                    5 => if (t.count < ListTwins.max and !t.texts[i]) {
                        _ = t.add(i, true);
                    },
                    6 => if (t.lists[i]) switch (t.pick(4)) {
                        0 => yoga.yogaNodeStyleSetEnum(node, @backingInt(yoga.YogaEnumKind.align_items), t.pick(5)),
                        1 => yoga.yogaNodeStyleSetValue(node, @backingInt(yoga.YogaValueKind.gap), 1, @backingInt(yoga.YogaUnit.percent), @floatFromInt(t.pick(20))),
                        2 => try yoga.check(yoga.yogaNodeCopyStyleChecked(node, t.nodes[0][1 + t.pick(@intCast(t.count - 1))])),
                        else => yoga.yogaNodeStyleSetValue(node, @backingInt(yoga.YogaValueKind.padding), 1, @backingInt(yoga.YogaUnit.point), @floatFromInt(t.pick(3))),
                    },
                    7 => yoga.yogaNodeStyleSetValue(node, @backingInt(yoga.YogaValueKind.max_width), 0, @backingInt(yoga.YogaUnit.point), t.point(5, 120)),
                    13 => {
                        t.direction = 3 - t.direction;
                        force = true;
                    },
                    // Classic errata change how flex boxes inside rows lay out.
                    8 => {
                        try yoga.check(yoga.yogaConfigSetErrataChecked(rounded, if (t.chance(50)) 0 else 2147483646));
                        force = true;
                    },
                    9 => if (t.texts[i] or (t.kids[i] == 0 and !t.lists[i])) {
                        t.texts[i] = !t.texts[i];
                        try yoga.check(yoga.yogaNodeSetNativeMeasureFunc(node, if (t.texts[i]) &t.leaves[0][i] else null, if (t.texts[i]) &Leaf.measure else null, true));
                        yoga.yogaNodeInvalidateMeasure(node);
                    },
                    10 => yoga.yogaNodeStyleSetValue(t.nodes[0][0], @backingInt(yoga.YogaValueKind.height), 0, @backingInt(yoga.YogaUnit.point), t.point(10, 80)),
                    else => {
                        root.width = @max(10, root.width + ([_]f32{ -1, 1, 0.005, -0.005 })[t.pick(4)]);
                        yoga.yogaNodeStyleSetValue(t.nodes[0][0], @backingInt(yoga.YogaValueKind.width), 0, @backingInt(yoga.YogaUnit.point), root.width);
                    },
                }
            }
            if (force) {
                margin = 1 - margin;
                yoga.yogaNodeStyleSetValue(t.nodes[0][0], @backingInt(yoga.YogaValueKind.margin), 3, @backingInt(yoga.YogaUnit.point), margin);
            }
            // As the scene does: a clean root's cache hit writes its unrounded size.
            var dirty: u32 = 0;
            try yoga.check(yoga.yogaNodeIsDirtyChecked(t.nodes[0][0], &dirty));
            if (dirty != 0) t.solve(0);
            var fresh: [ListTwins.max]yoga.YGNodeRef = @splat(null);
            var fresh_leaves: [ListTwins.max]Leaf = @splat(.{});
            const fresh_root = try t.copy(t.nodes[0][0], &fresh_leaves, &fresh);
            defer yoga.yogaNodeFreeRecursive(fresh_root);
            yoga.testSetListMemo(0);
            yoga.yogaNodeCalculateLayout(fresh_root, std.math.nan(f32), std.math.nan(f32), t.direction);
            yoga.testSetListMemo(memo);
            try expectSameLaidOut(t.nodes[0][0], fresh_root);
        }
    };
    const point = @backingInt(yoga.YogaUnit.point);
    // A row that flex wrapped to line 1 leads a list after a move and a mode change; the baseline
    // of a row parent reads it as a fresh tree does.
    var heights: [2]f32 = undefined;
    for (&heights, [_]bool{ false, true }) |*height, live| {
        const root = yoga.yogaNodeCreateWithConfig(rounded);
        defer yoga.yogaNodeFreeRecursive(root);
        const box = yoga.yogaNodeCreateWithConfig(rounded);
        var nodes: [4]yoga.YGNodeRef = undefined;
        for (&nodes, 0..) |*node, i| {
            node.* = yoga.yogaNodeCreateWithConfig(rounded);
            yoga.yogaNodeInsertChild(if (i == 0) root else box, node.*, @intCast(i -| 1));
            yoga.yogaNodeStyleSetValue(node.*, @backingInt(yoga.YogaValueKind.width), 0, point, 15);
            yoga.yogaNodeStyleSetValue(node.*, @backingInt(yoga.YogaValueKind.height), 0, point, ([_]f32{ 1, 1, 5, 7 })[i]);
        }
        yoga.yogaNodeInsertChild(root, box, 1);
        yoga.yogaNodeStyleSetEnum(root, @backingInt(yoga.YogaEnumKind.flex_direction), @backingInt(yoga.YogaFlexDirection.row));
        yoga.yogaNodeStyleSetEnum(root, @backingInt(yoga.YogaEnumKind.align_items), 5);
        yoga.yogaNodeStyleSetValue(nodes[0], @backingInt(yoga.YogaValueKind.margin), 1, point, 10);
        yoga.yogaNodeStyleSetValue(box, @backingInt(yoga.YogaValueKind.width), 0, point, 20);
        yoga.yogaNodeStyleSetValue(box, @backingInt(yoga.YogaValueKind.padding), 1, point, 3);
        yoga.yogaNodeStyleSetEnum(box, @backingInt(yoga.YogaEnumKind.flex_direction), @backingInt(yoga.YogaFlexDirection.row));
        yoga.yogaNodeStyleSetEnum(box, @backingInt(yoga.YogaEnumKind.flex_wrap), 1);
        if (live) yoga.yogaNodeCalculateLayout(root, 100, std.math.nan(f32), 1);
        try yoga.check(yoga.yogaNodeMoveChildChecked(box, nodes[1], 2));
        try yoga.check(yoga.yogaNodeStyleSetEnumChecked(box, @backingInt(yoga.YogaEnumKind.layout_mode), 1));
        yoga.yogaNodeCalculateLayout(root, 100, std.math.nan(f32), 1);
        var layout: yoga.ExternalYogaLayout = undefined;
        yoga.yogaNodeGetComputedLayout(root, &layout);
        height.* = layout.height;
    }
    try std.testing.expectEqual(heights[0], heights[1]);
    // A width change that measures a list again but reuses its layout rounds no hidden row (B6).
    {
        const root = yoga.yogaNodeCreateWithConfig(rounded);
        defer yoga.yogaNodeFreeRecursive(root);
        var text: Leaf = .{ .len = 20 };
        // The list and a sibling in the root; a text and a hidden row of ten boxes in the list.
        var nodes: [14]yoga.YGNodeRef = undefined;
        for (&nodes, 0..) |*node, i| {
            node.* = yoga.yogaNodeCreateWithConfig(rounded);
            const parent = if (i < 2) root else if (i < 4) nodes[0] else nodes[3];
            yoga.yogaNodeInsertChild(parent, node.*, @intCast(if (i < 4) i % 2 else i - 4));
        }
        yoga.yogaNodeStyleSetEnum(root, @backingInt(yoga.YogaEnumKind.flex_direction), @backingInt(yoga.YogaFlexDirection.row));
        try yoga.check(yoga.yogaNodeStyleSetEnumChecked(nodes[0], @backingInt(yoga.YogaEnumKind.layout_mode), 1));
        try yoga.check(yoga.yogaNodeSetNativeMeasureFunc(nodes[2], &text, &Leaf.measure, true));
        yoga.yogaNodeStyleSetEnum(nodes[3], @backingInt(yoga.YogaEnumKind.display), 1);
        for ([_]yoga.YogaValueKind{ .width, .height }) |kind| yoga.yogaNodeStyleSetValue(nodes[1], @backingInt(kind), 0, point, 1);
        for ([_]f32{ 100, 90 }) |width| yoga.yogaNodeCalculateLayout(root, width, 20, 1);
        _ = yoga.testTakeRoundedNodes();
        yoga.yogaNodeCalculateLayout(root, 80, 20, 1);
        try std.testing.expectEqual(3, yoga.testTakeRoundedNodes());
    }
}

// Each node that a solve laid out (all but the children of display: none nodes) is clean and
// has the fresh copy's layout.
fn expectSameLaidOut(live: yoga.YGNodeRef, fresh: yoga.YGNodeRef) !void {
    var dirty: u32 = 1;
    try yoga.check(yoga.yogaNodeIsDirtyChecked(live, &dirty));
    try std.testing.expectEqual(0, dirty);
    try expectSameLayout(live, fresh, false);
    if (yoga.yogaNodeStyleGetEnum(live, @backingInt(yoga.YogaEnumKind.display)) == 1) return;
    var index: u32 = 0;
    var children: [2]yoga.YGNodeRef = undefined;
    while (true) : (index += 1) {
        for ([_]yoga.YGNodeRef{ live, fresh }, &children) |node, *child| try yoga.check(yoga.yogaNodeGetChildChecked(node, index, child));
        if (children[0] == null) return;
        try expectSameLaidOut(children[0], children[1]);
    }
}

// The documented differences: rows never grow or shrink, ignore their flex basis, the box's
// justification, flex direction, and wrap, and main-axis auto margins, and resolve percent heights,
// vertical insets, and a percent gap against an indefinite height; and rows get no height cap, as
// in a flex column with overflow: scroll.
test "Yoga list layout differs from flex as documented" {
    const Set = struct { kind: enum { value, enumeration, float }, id: u32, edge: u32 = 0, unit: u32 = 1, v: f32 };
    const Row = struct { height: f32 = 20, width: f32 = 80, rows: u32 = 1, len: u32 = 10, step: u32 = 0, box: bool = false, list: ?Set = null, list2: ?Set = null, row: ?Set = null, inner: ?Set = null, node: usize, field: usize, flex: f32, list_value: f32 };
    const left = 0;
    const top = 1;
    const width_10: Set = .{ .kind = .value, .id = @backingInt(yoga.YogaValueKind.width), .v = 10 };
    const height = 5;
    const config = yoga.yogaConfigCreate();
    defer std.debug.assert(yoga.yogaConfigFree(config));
    yoga.configSetRoundsPositionsFromAbsoluteEdges(config, 1);
    try yoga.check(yoga.yogaConfigSetPointScaleFactorChecked(config, 0));
    for ([_]Row{
        .{ .row = .{ .kind = .float, .id = @backingInt(yoga.YogaFloatKind.flex_grow), .v = 1 }, .node = 2, .field = height, .flex = 20, .list_value = 1 },
        .{ .width = 10, .height = 4, .rows = 3, .len = 30, .row = .{ .kind = .float, .id = @backingInt(yoga.YogaFloatKind.flex_shrink), .v = 1 }, .node = 2, .field = height, .flex = 4.0 / 3.0, .list_value = 3 },
        .{ .row = .{ .kind = .value, .id = @backingInt(yoga.YogaValueKind.flex_basis), .v = 5 }, .node = 2, .field = height, .flex = 5, .list_value = 1 },
        .{ .list = .{ .kind = .enumeration, .id = @backingInt(yoga.YogaEnumKind.justify_content), .v = 1 }, .node = 2, .field = top, .flex = 9.5, .list_value = 0 },
        .{ .list = .{ .kind = .enumeration, .id = @backingInt(yoga.YogaEnumKind.flex_direction), .v = 2 }, .height = std.math.nan(f32), .rows = 2, .node = 1, .field = height, .flex = 1, .list_value = 2 },
        // Baseline alignment in a row-direction box: a list's rows stay at the start.
        .{ .list = .{ .kind = .enumeration, .id = @backingInt(yoga.YogaEnumKind.flex_direction), .v = 2 }, .list2 = .{ .kind = .enumeration, .id = @backingInt(yoga.YogaEnumKind.align_items), .v = 5 }, .rows = 2, .row = width_10, .node = 3, .field = left, .flex = 10, .list_value = 0 },
        .{ .list = .{ .kind = .enumeration, .id = @backingInt(yoga.YogaEnumKind.flex_wrap), .v = 2 }, .row = width_10, .node = 2, .field = left, .flex = 70, .list_value = 0 },
        .{ .row = .{ .kind = .value, .id = @backingInt(yoga.YogaValueKind.position), .edge = 1, .unit = 2, .v = 50 }, .node = 2, .field = top, .flex = 10, .list_value = 0 },
        .{ .row = .{ .kind = .value, .id = @backingInt(yoga.YogaValueKind.margin), .edge = 1, .unit = 3, .v = 0 }, .node = 2, .field = top, .flex = 19, .list_value = 0 },
        .{ .box = true, .row = .{ .kind = .value, .id = @backingInt(yoga.YogaValueKind.height), .unit = 2, .v = 50 }, .node = 2, .field = height, .flex = 10, .list_value = 0 },
        .{ .row = .{ .kind = .value, .id = @backingInt(yoga.YogaValueKind.min_height), .unit = 2, .v = 50 }, .node = 2, .field = height, .flex = 25, .list_value = 1 },
        // A box row holding a box with a percent height or min height in a 10-high list, and one
        // holding a 3-high box in a 0-high list, which flex measures at a height of 0.
        .{ .height = 10, .box = true, .inner = .{ .kind = .value, .id = @backingInt(yoga.YogaValueKind.height), .unit = 2, .v = 100 }, .node = 2, .field = height, .flex = 10, .list_value = 0 },
        .{ .height = 10, .box = true, .inner = .{ .kind = .value, .id = @backingInt(yoga.YogaValueKind.min_height), .unit = 2, .v = 50 }, .node = 2, .field = height, .flex = 5, .list_value = 0 },
        .{ .height = 0, .box = true, .inner = .{ .kind = .value, .id = @backingInt(yoga.YogaValueKind.height), .v = 3 }, .node = 2, .field = height, .flex = 0, .list_value = 3 },
        .{ .height = std.math.nan(f32), .rows = 4, .len = 30, .step = 50, .list = .{ .kind = .value, .id = @backingInt(yoga.YogaValueKind.gap), .edge = 1, .unit = 2, .v = 10 }, .node = 1, .field = height, .flex = 13.6, .list_value = 7 },
    }) |case| {
        var values: [2]f32 = undefined;
        for (&values, [_]bool{ false, true }) |*out, list_mode| {
            var leaves: [4]Leaf = @splat(.{});
            const root = yoga.yogaNodeCreateWithConfig(config);
            defer yoga.yogaNodeFreeRecursive(root);
            var nodes: [6]yoga.YGNodeRef = .{ root, yoga.yogaNodeCreateWithConfig(config), null, null, null, null };
            yoga.yogaNodeInsertChild(root, nodes[1], 0);
            yoga.yogaNodeStyleSetValue(nodes[1], @backingInt(yoga.YogaValueKind.width), 0, 1, case.width);
            yoga.yogaNodeStyleSetValue(nodes[1], @backingInt(yoga.YogaValueKind.height), 0, 1, case.height);
            try yoga.check(yoga.yogaNodeStyleSetEnumChecked(nodes[1], @backingInt(yoga.YogaEnumKind.layout_mode), @intFromBool(list_mode)));
            for (nodes[2..][0..case.rows], leaves[0..case.rows], 0..) |*row, *leaf, i| {
                row.* = yoga.yogaNodeCreateWithConfig(config);
                yoga.yogaNodeInsertChild(nodes[1], row.*, @intCast(i));
                leaf.len = case.len + case.step * @as(u32, @intCast(i));
                if (!case.box) try yoga.check(yoga.yogaNodeSetNativeMeasureFunc(row.*, leaf, &Leaf.measure, true));
            }
            if (case.inner != null) {
                nodes[5] = yoga.yogaNodeCreateWithConfig(config);
                yoga.yogaNodeInsertChild(nodes[2], nodes[5], 0);
            }
            for ([_]?Set{ case.list, case.list2, case.row, case.inner }, [_][]const yoga.YGNodeRef{ nodes[1..2], nodes[1..2], nodes[2..][0..case.rows], nodes[5..6] }) |maybe, targets| {
                const set = maybe orelse continue;
                for (targets) |target| switch (set.kind) {
                    .value => yoga.yogaNodeStyleSetValue(target, set.id, set.edge, set.unit, set.v),
                    .enumeration => yoga.yogaNodeStyleSetEnum(target, set.id, @intFromFloat(set.v)),
                    .float => yoga.yogaNodeStyleSetFloat(target, set.id, set.v),
                };
            }
            yoga.yogaNodeCalculateLayout(root, 200, 50, @backingInt(yoga.YogaDirection.ltr));
            var layout: yoga.ExternalYogaLayout = undefined;
            yoga.yogaNodeGetComputedLayout(nodes[case.node], &layout);
            out.* = @as(*const [6]f32, @ptrCast(&layout))[case.field];
        }
        try std.testing.expectApproxEqAbs(case.flex, values[0], 1e-4);
        try std.testing.expectEqual(case.list_value, values[1]);
    }
}

// D6 PR 1b, invariant 8: a same-height title change, an appended text row, and a box row appended
// to growing ScrollBox content each visit one row per pass. A twin with the row memo off visits
// every row in each pass and lays out the same.
test "Yoga list layout visits only the rows that change" {
    const Select = struct {
        config: yoga.YGConfigRef,
        root: yoga.YGNodeRef = null,
        list: yoga.YGNodeRef = null,
        rows: u32 = 0,
        leaves: [2003]Leaf = @splat(.{ .len = 12 }),
        texts: [2003]yoga.YGNodeRef = undefined,
        count: usize = 0,

        fn node(s: *@This(), parent: yoga.YGNodeRef, index: u32) yoga.YGNodeRef {
            const child = yoga.yogaNodeCreateWithConfig(s.config);
            yoga.yogaNodeInsertChild(parent, child, index);
            return child;
        }

        fn text(s: *@This(), parent: yoga.YGNodeRef, index: u32) !void {
            s.texts[s.count] = s.node(parent, index);
            try yoga.check(yoga.yogaNodeSetNativeMeasureFunc(s.texts[s.count], &s.leaves[s.count], &Leaf.measure, true));
            yoga.yogaNodeStyleSetFloat(s.texts[s.count], @backingInt(yoga.YogaFloatKind.flex_grow), 1);
            s.count += 1;
        }

        fn row(s: *@This(), box: bool) !void {
            s.rows += 1;
            if (!box) return s.text(s.list, s.rows - 1);
            const r = s.node(s.list, s.rows - 1);
            yoga.yogaNodeStyleSetFloat(r, @backingInt(yoga.YogaFloatKind.flex_shrink), 0);
            yoga.yogaNodeStyleSetEnum(r, @backingInt(yoga.YogaEnumKind.flex_direction), @backingInt(yoga.YogaFlexDirection.row));
            try s.text(r, 0);
            try s.text(r, 1);
        }
    };
    const config = yoga.yogaConfigCreate();
    defer std.debug.assert(yoga.yogaConfigFree(config));
    yoga.configSetRoundsPositionsFromAbsoluteEdges(config, 1);
    defer yoga.testSetListMemo(1);
    for ([_]u32{ 100, 1000 }) |size| {
        var selects: [2]Select = @splat(.{ .config = config });
        for (&selects) |*s| {
            s.root = yoga.yogaNodeCreateWithConfig(config);
            yoga.yogaNodeStyleSetEnum(s.root, @backingInt(yoga.YogaEnumKind.overflow), 2);
            s.list = s.node(s.root, 0);
            yoga.yogaNodeStyleSetFloat(s.list, @backingInt(yoga.YogaFloatKind.flex_shrink), 0);
            yoga.yogaNodeStyleSetValue(s.list, @backingInt(yoga.YogaValueKind.min_height), 0, @backingInt(yoga.YogaUnit.percent), 100);
            try yoga.check(yoga.yogaNodeStyleSetEnumChecked(s.list, @backingInt(yoga.YogaEnumKind.layout_mode), 1));
            for (0..size) |_| try s.row(true);
        }
        defer for (selects) |s| yoga.yogaNodeFreeRecursive(s.root);
        for (0..4) |change| {
            var visits: [2]u32 = undefined;
            for (&selects, &visits, [_]u32{ 1, 0 }) |*s, *out, memo| {
                switch (change) {
                    0 => {},
                    1 => {
                        s.leaves[0].len = 13;
                        yoga.yogaNodeInvalidateMeasure(s.texts[0]);
                    },
                    2 => try s.row(false),
                    else => try s.row(true),
                }
                yoga.testSetListMemo(memo);
                _ = yoga.testTakeListVisits();
                yoga.yogaNodeCalculateLayout(s.root, 80, 30, @backingInt(yoga.YogaDirection.ltr));
                out.* = yoga.testTakeListVisits();
            }
            try expectSameLaidOut(selects[0].root, selects[1].root);
            if (change == 0) continue;
            try std.testing.expectEqual(0, visits[1] % selects[1].rows);
            try std.testing.expectEqual(visits[1] / selects[1].rows, visits[0]);
        }
    }
}

// D6 PR 1b, carbon's review trees: a baseline parent reads a list row that a measure pass at
// another width measured (probe5, and R5-E through a column wrapper), and a row moves back to the
// index of a removed entry (R5-C); a copied list style, a clean static row's absolute child, and
// a forgotten measurement. Each lays out as a fresh tree with the memo off.
test "Yoga list layout keeps the review trees of its row memo" {
    const config = yoga.yogaConfigCreate();
    defer std.debug.assert(yoga.yogaConfigFree(config));
    yoga.configSetRoundsPositionsFromAbsoluteEdges(config, 1);
    defer yoga.testSetListMemo(1);
    const point = @backingInt(yoga.YogaUnit.point);
    const Probe = struct {
        outer: yoga.YGNodeRef = null,
        texts: [2]yoga.YGNodeRef = undefined,
        leaves: [2]Leaf = .{ .{ .len = 240 }, .{ .len = 10 } },

        fn node(config_: yoga.YGConfigRef, parent: yoga.YGNodeRef, index: u32) yoga.YGNodeRef {
            const child = yoga.yogaNodeCreateWithConfig(config_);
            if (parent != null) yoga.yogaNodeInsertChild(parent, child, index);
            return child;
        }

        fn build(p: *@This(), config_: yoga.YGConfigRef, wrap: bool) !void {
            p.outer = node(config_, null, 0);
            const row = node(config_, p.outer, 0);
            const tall = node(config_, p.outer, 1);
            const sib = node(config_, row, 0);
            const half = node(config_, row, 1);
            const list = if (wrap) node(config_, half, 0) else half;
            yoga.yogaNodeStyleSetEnum(row, @backingInt(yoga.YogaEnumKind.flex_direction), @backingInt(yoga.YogaFlexDirection.row));
            yoga.yogaNodeStyleSetEnum(row, @backingInt(yoga.YogaEnumKind.align_items), 5);
            for ([_]yoga.YGNodeRef{ row, tall }) |n| yoga.yogaNodeStyleSetFloat(n, @backingInt(yoga.YogaFloatKind.flex_shrink), 1);
            yoga.yogaNodeStyleSetValue(tall, @backingInt(yoga.YogaValueKind.height), 0, point, 9);
            yoga.yogaNodeStyleSetValue(sib, @backingInt(yoga.YogaValueKind.width), 0, point, 80);
            yoga.yogaNodeStyleSetValue(sib, @backingInt(yoga.YogaValueKind.height), 0, point, 1);
            yoga.yogaNodeStyleSetValue(sib, @backingInt(yoga.YogaValueKind.margin), 1, point, 2);
            yoga.yogaNodeStyleSetValue(half, @backingInt(yoga.YogaValueKind.width), 0, @backingInt(yoga.YogaUnit.percent), 50);
            try yoga.check(yoga.yogaNodeStyleSetEnumChecked(list, @backingInt(yoga.YogaEnumKind.layout_mode), 1));
            for (&p.texts, &p.leaves, 0..) |*text, *leaf, i| {
                text.* = node(config_, list, @intCast(i));
                try yoga.check(yoga.yogaNodeSetNativeMeasureFunc(text.*, leaf, &Leaf.measure, true));
            }
        }

        fn solve(p: *@This(), width: f32, height: f32) void {
            yoga.yogaNodeStyleSetValue(p.outer, @backingInt(yoga.YogaValueKind.width), 0, @backingInt(yoga.YogaUnit.point), width);
            yoga.yogaNodeStyleSetValue(p.outer, @backingInt(yoga.YogaValueKind.height), 0, @backingInt(yoga.YogaUnit.point), height);
            yoga.yogaNodeCalculateLayout(p.outer, std.math.nan(f32), std.math.nan(f32), @backingInt(yoga.YogaDirection.ltr));
        }
    };
    for ([_]bool{ false, true }) |wrap| {
        var live: Probe = .{};
        try live.build(config, wrap);
        defer yoga.yogaNodeFreeRecursive(live.outer);
        live.solve(120, 10);
        live.solve(40, 100);
        live.leaves[1].len = 12;
        yoga.yogaNodeInvalidateMeasure(live.texts[1]);
        live.solve(120, 10);
        var fresh: Probe = .{};
        fresh.leaves[1].len = 12;
        try fresh.build(config, wrap);
        defer yoga.yogaNodeFreeRecursive(fresh.outer);
        yoga.testSetListMemo(0);
        fresh.solve(120, 10);
        yoga.testSetListMemo(1);
        try expectSameLaidOut(live.outer, fresh.outer);
    }
    // R5-C: [r0, r1] solved, r0 moved out and solved, then moved back to index 0.
    const root = yoga.yogaNodeCreateWithConfig(config);
    defer yoga.yogaNodeFreeRecursive(root);
    const list = Probe.node(config, root, 0);
    try yoga.check(yoga.yogaNodeStyleSetEnumChecked(list, @backingInt(yoga.YogaEnumKind.layout_mode), 1));
    var rows: [2]yoga.YGNodeRef = undefined;
    for (&rows, 0..) |*row, i| {
        row.* = Probe.node(config, list, @intCast(i));
        yoga.yogaNodeStyleSetValue(row.*, @backingInt(yoga.YogaValueKind.height), 0, point, 10);
    }
    yoga.yogaNodeCalculateLayout(root, 20, std.math.nan(f32), @backingInt(yoga.YogaDirection.ltr));
    for ([_]yoga.YGNodeRef{ root, list }, [_]u32{ 1, 0 }) |parent, index| {
        try yoga.check(yoga.yogaNodeMoveChildChecked(parent, rows[0], index));
        yoga.yogaNodeCalculateLayout(root, 20, std.math.nan(f32), @backingInt(yoga.YogaDirection.ltr));
    }
    var layout: yoga.ExternalYogaLayout = undefined;
    yoga.yogaNodeGetComputedLayout(rows[1], &layout);
    try std.testing.expectEqual(10, layout.top);
    // A copied style centers the clean rows.
    const centered = yoga.yogaNodeCreateWithConfig(config);
    defer yoga.yogaNodeFree(centered);
    yoga.yogaNodeStyleSetEnum(centered, @backingInt(yoga.YogaEnumKind.align_items), 2);
    try yoga.check(yoga.yogaNodeCopyStyleChecked(list, centered));
    yoga.yogaNodeCalculateLayout(root, 20, std.math.nan(f32), @backingInt(yoga.YogaDirection.ltr));
    yoga.yogaNodeGetComputedLayout(rows[1], &layout);
    try std.testing.expectEqual(10, layout.left);
    // STEP 11 places a clean static row's absolute child against the list, which a text grows.
    var roots: [2]yoga.YGNodeRef = undefined;
    var texts: [2]Leaf = .{ .{ .len = 10 }, .{ .len = 30 } };
    for (&roots, &texts, [_]u32{ 1, 0 }) |*out, *text, memo| {
        out.* = yoga.yogaNodeCreateWithConfig(config);
        const static_list = Probe.node(config, out.*, 0);
        try yoga.check(yoga.yogaNodeStyleSetEnumChecked(static_list, @backingInt(yoga.YogaEnumKind.layout_mode), 1));
        const leaf = Probe.node(config, static_list, 0);
        try yoga.check(yoga.yogaNodeSetNativeMeasureFunc(leaf, text, &Leaf.measure, true));
        const static = Probe.node(config, static_list, 1);
        yoga.yogaNodeStyleSetEnum(static, @backingInt(yoga.YogaEnumKind.position_type), @backingInt(yoga.YogaPositionType.static));
        const absolute = Probe.node(config, static, 0);
        yoga.yogaNodeStyleSetEnum(absolute, @backingInt(yoga.YogaEnumKind.position_type), @backingInt(yoga.YogaPositionType.absolute));
        yoga.yogaNodeStyleSetValue(absolute, @backingInt(yoga.YogaValueKind.position), 1, @backingInt(yoga.YogaUnit.percent), 50);
        yoga.testSetListMemo(memo);
        yoga.yogaNodeCalculateLayout(out.*, 20, std.math.nan(f32), @backingInt(yoga.YogaDirection.ltr));
        if (memo == 0) continue;
        text.len = 30;
        yoga.yogaNodeInvalidateMeasure(leaf);
        yoga.yogaNodeCalculateLayout(out.*, 20, std.math.nan(f32), @backingInt(yoga.YogaDirection.ltr));
    }
    defer for (roots) |r| yoga.yogaNodeFreeRecursive(r);
    try expectSameLaidOut(roots[0], roots[1]);
    // A forgotten measurement of a leaf in a box row dirties nothing; the next frame's solve,
    // here for the root's margin, measures the leaf again.
    var forget_roots: [2]yoga.YGNodeRef = undefined;
    var forget_texts: [2]Leaf = .{ .{ .len = 10 }, .{ .len = 30 } };
    for (&forget_roots, &forget_texts, [_]u32{ 1, 0 }) |*out, *text, memo| {
        out.* = yoga.yogaNodeCreateWithConfig(config);
        const forget_list = Probe.node(config, out.*, 0);
        try yoga.check(yoga.yogaNodeStyleSetEnumChecked(forget_list, @backingInt(yoga.YogaEnumKind.layout_mode), 1));
        const leaf = Probe.node(config, Probe.node(config, forget_list, 0), 0);
        try yoga.check(yoga.yogaNodeSetNativeMeasureFunc(leaf, text, &Leaf.measure, true));
        _ = Probe.node(config, forget_list, 1);
        if (memo == 0) yoga.yogaNodeStyleSetValue(out.*, @backingInt(yoga.YogaValueKind.margin), 3, point, 1);
        yoga.testSetListMemo(memo);
        yoga.yogaNodeCalculateLayout(out.*, 20, std.math.nan(f32), @backingInt(yoga.YogaDirection.ltr));
        if (memo == 0) continue;
        text.len = 30;
        yoga.yogaNodeForgetMeasurements(leaf);
        yoga.yogaNodeStyleSetValue(out.*, @backingInt(yoga.YogaValueKind.margin), 3, point, 1);
        yoga.yogaNodeCalculateLayout(out.*, 20, std.math.nan(f32), @backingInt(yoga.YogaDirection.ltr));
    }
    defer for (forget_roots) |r| yoga.yogaNodeFreeRecursive(r);
    try expectSameLaidOut(forget_roots[0], forget_roots[1]);
    // carbon-1: a measure pass at another width remeasures a clean static row, whose measured
    // width then centers its absolute child in STEP 11 (LTR and RTL).
    for ([_]u32{ 1, 2 }) |direction| {
        var static_roots: [2]yoga.YGNodeRef = undefined;
        for (&static_roots, [_]u32{ 1, 0 }) |*out, memo| {
            out.* = yoga.yogaNodeCreateWithConfig(config);
            yoga.yogaNodeStyleSetEnum(out.*, @backingInt(yoga.YogaEnumKind.flex_direction), @backingInt(yoga.YogaFlexDirection.row));
            yoga.yogaNodeStyleSetValue(out.*, @backingInt(yoga.YogaValueKind.width), 0, point, 48);
            const static_list = Probe.node(config, out.*, 0);
            try yoga.check(yoga.yogaNodeStyleSetEnumChecked(static_list, @backingInt(yoga.YogaEnumKind.layout_mode), 1));
            const static = Probe.node(config, static_list, 0);
            yoga.yogaNodeStyleSetEnum(static, @backingInt(yoga.YogaEnumKind.position_type), @backingInt(yoga.YogaPositionType.static));
            yoga.yogaNodeStyleSetEnum(static, @backingInt(yoga.YogaEnumKind.align_items), 2);
            const absolute = Probe.node(config, static, 0);
            yoga.yogaNodeStyleSetEnum(absolute, @backingInt(yoga.YogaEnumKind.position_type), @backingInt(yoga.YogaPositionType.absolute));
            const wide = Probe.node(config, static_list, 1);
            for ([_]yoga.YGNodeRef{ absolute, absolute, wide, wide }, [_]yoga.YogaValueKind{ .width, .height, .width, .height }, [_]f32{ 4, 4, 96, 2 }) |n, kind, v| {
                yoga.yogaNodeStyleSetValue(n, @backingInt(kind), 0, point, v);
            }
            yoga.testSetListMemo(memo);
            if (memo == 1) yoga.yogaNodeCalculateLayout(out.*, std.math.nan(f32), std.math.nan(f32), direction);
            yoga.yogaNodeStyleSetValue(out.*, @backingInt(yoga.YogaValueKind.height), 0, point, 90);
            yoga.yogaNodeCalculateLayout(out.*, std.math.nan(f32), std.math.nan(f32), direction);
        }
        defer for (static_roots) |r| yoga.yogaNodeFreeRecursive(r);
        try expectSameLaidOut(static_roots[0], static_roots[1]);
    }
    // A list with a display: contents child lays out without its memo.
    yoga.testSetListMemo(1);
    const contents_root = yoga.yogaNodeCreateWithConfig(config);
    defer yoga.yogaNodeFreeRecursive(contents_root);
    const contents_list = Probe.node(config, contents_root, 0);
    try yoga.check(yoga.yogaNodeStyleSetEnumChecked(contents_list, @backingInt(yoga.YogaEnumKind.layout_mode), 1));
    const contents = Probe.node(config, contents_list, 0);
    yoga.yogaNodeStyleSetEnum(contents, @backingInt(yoga.YogaEnumKind.display), 2);
    yoga.yogaNodeStyleSetValue(Probe.node(config, contents, 0), @backingInt(yoga.YogaValueKind.height), 0, point, 3);
    yoga.yogaNodeCalculateLayout(contents_root, 20, std.math.nan(f32), @backingInt(yoga.YogaDirection.ltr));
    yoga.yogaNodeGetComputedLayout(contents_list, &layout);
    try std.testing.expectEqual(3, layout.height);
    // An allocation failure leaves the node in flex mode.
    yoga.testFailAfter(0);
    defer yoga.testFailAfter(-1);
    try std.testing.expectEqual(yoga.Status.out_of_memory, yoga.yogaNodeStyleSetEnumChecked(root, @backingInt(yoga.YogaEnumKind.layout_mode), 1));
    yoga.testFailAfter(-1);
    try std.testing.expectEqual(0, yoga.yogaNodeStyleGetEnum(root, @backingInt(yoga.YogaEnumKind.layout_mode)));
}

// Equal layouts; `all` adds right, bottom, and the edges, which flex itself keeps from an earlier
// solve within Yoga's tolerances.
fn expectSameLayout(actual: yoga.YGNodeRef, expected: yoga.YGNodeRef, all: bool) !void {
    var layouts: [2]yoga.ExternalYogaLayout = undefined;
    yoga.yogaNodeGetComputedLayout(actual, &layouts[0]);
    yoga.yogaNodeGetComputedLayout(expected, &layouts[1]);
    if (!all) for (&layouts) |*layout| {
        layout.right = 0;
        layout.bottom = 0;
    };
    try std.testing.expectEqualSlices(u8, std.mem.asBytes(&layouts[1]), std.mem.asBytes(&layouts[0]));
    if (all) for (0..3) |kind| for (0..4) |edge| {
        var values: [2]f32 = undefined;
        for ([_]yoga.YGNodeRef{ actual, expected }, &values) |node, *out| try yoga.check(yoga.yogaNodeLayoutGetEdgeChecked(node, @intCast(kind), @intCast(edge), out));
        try std.testing.expectEqual(values[1], values[0]);
    };
}

test "Yoga host callback owners use config context and cannot clear another owner" {
    const Host = struct {
        var first_dirtied: u32 = 0;
        var second_dirtied: u32 = 0;
        fn first(node: ?*anyopaque, _: f32, _: u32, _: f32, _: u32) callconv(.c) void {
            yoga.yogaStoreMeasureResult(yoga.yogaNodeGetConfig(@ptrCast(node)), 3, 1);
        }
        // Half the offered height: a host measure may use the cap beyond clamping.
        fn second(node: ?*anyopaque, _: f32, _: u32, height: f32, _: u32) callconv(.c) void {
            yoga.yogaStoreMeasureResult(yoga.yogaNodeGetConfig(@ptrCast(node)), 7, if (std.math.isNan(height)) 2 else height / 2);
        }
        fn dirtyFirst(_: ?*anyopaque) callconv(.c) void {
            first_dirtied += 1;
        }
        fn dirtySecond(_: ?*anyopaque) callconv(.c) void {
            second_dirtied += 1;
        }
    };
    var first: yoga.Config = undefined;
    try first.init(std.testing.allocator, .{});
    defer first.deinit();
    var second: yoga.Config = undefined;
    try second.init(std.testing.allocator, .{});
    defer second.deinit();
    const first_node = try first.createNode();
    defer yoga.yogaNodeFree(first_node);
    const second_node = try second.createNode();
    defer yoga.yogaNodeFree(second_node);

    try std.testing.expect(yoga.yogaConfigSetCallbacks(first.ref, Host.first, Host.dirtyFirst));
    try std.testing.expect(yoga.yogaConfigSetCallbacks(second.ref, Host.second, Host.dirtySecond));
    try std.testing.expect(!yoga.yogaConfigSetCallbacks(first.ref, Host.second, Host.dirtySecond));
    try std.testing.expect(!yoga.yogaConfigClearCallbacks(first.ref, Host.second));
    yoga.yogaNodeSetMeasureFunc(first_node, true);
    yoga.yogaNodeSetMeasureFunc(second_node, true);
    yoga.yogaNodeSetDirtiedFunc(first_node, true);
    yoga.yogaNodeSetDirtiedFunc(second_node, true);
    yoga.yogaNodeCalculateLayout(first_node, std.math.nan(f32), std.math.nan(f32), 1);
    yoga.yogaNodeCalculateLayout(second_node, std.math.nan(f32), std.math.nan(f32), 1);
    var layout: yoga.ExternalYogaLayout = undefined;
    yoga.yogaNodeGetComputedLayout(first_node, &layout);
    try std.testing.expectEqual(@as(f32, 3), layout.width);
    try std.testing.expect(yoga.yogaConfigClearCallbacks(first.ref, Host.first));
    yoga.yogaNodeMarkDirty(first_node);
    yoga.yogaNodeMarkDirty(second_node);
    try std.testing.expectEqual(@as(u32, 0), Host.first_dirtied);
    try std.testing.expectEqual(@as(u32, 1), Host.second_dirtied);
    yoga.yogaNodeCalculateLayout(second_node, std.math.nan(f32), std.math.nan(f32), 1);
    yoga.yogaNodeGetComputedLayout(second_node, &layout);
    try std.testing.expectEqual(@as(f32, 7), layout.width);
    // A larger cap measures a host leaf again.
    const parent = try second.createNode();
    defer yoga.yogaNodeFreeRecursive(parent);
    const leaf = try second.createNode();
    yoga.yogaNodeInsertChild(parent, leaf, 0);
    yoga.yogaNodeSetMeasureFunc(leaf, true);
    for ([_]f32{ 10, 20 }) |height| {
        yoga.yogaNodeCalculateLayout(parent, 20, height, 1);
        yoga.yogaNodeGetComputedLayout(leaf, &layout);
        try std.testing.expectEqual(height / 2, layout.height);
    }
    try std.testing.expect(yoga.yogaConfigClearCallbacks(second.ref, Host.second));
}
