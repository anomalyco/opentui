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
    for (0..12) |kind| {
        try std.testing.expectEqual(invalid, yoga.yogaNodeStyleSetEnumChecked(node, @intCast(kind), std.math.maxInt(u32)));
    }
    try std.testing.expectEqual(invalid, yoga.yogaNodeStyleGetEnumChecked(node, 11, &flag));
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
    try std.testing.expectEqualSlices(yoga.YGNodeConstRef, &.{ root, first, second }, &recorder.nodes);
    try std.testing.expectEqualSlices(usize, &.{ 5, 5, 5 }, &recorder.live_counts);
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

    yoga.yogaNodeStyleSetEnum(root, @intFromEnum(yoga.YogaEnumKind.flex_direction), @intFromEnum(yoga.YogaFlexDirection.row));
    yoga.yogaNodeStyleSetValue(root, @intFromEnum(yoga.YogaValueKind.width), 0, @intFromEnum(yoga.YogaUnit.point), 100);
    yoga.yogaNodeStyleSetValue(root, @intFromEnum(yoga.YogaValueKind.height), 0, @intFromEnum(yoga.YogaUnit.point), 100);

    const child = yoga.yogaNodeCreateWithConfig(config);
    defer yoga.yogaNodeFree(child);
    yoga.yogaNodeStyleSetFloat(child, @intFromEnum(yoga.YogaFloatKind.flex_grow), 1);
    yoga.yogaNodeInsertChild(root, child, 0);

    yoga.yogaNodeCalculateLayout(root, std.math.nan(f32), std.math.nan(f32), @intFromEnum(yoga.YogaDirection.ltr));

    var layout: yoga.ExternalYogaLayout = undefined;
    yoga.yogaNodeGetComputedLayout(child, &layout);
    try std.testing.expectApproxEqAbs(@as(f32, 100), layout.width, 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 100), layout.height, 0.001);
}

test "Yoga wrapper packs style values" {
    const node = yoga.yogaNodeCreate();
    defer yoga.yogaNodeFree(node);

    yoga.yogaNodeStyleSetValue(node, @intFromEnum(yoga.YogaValueKind.flex_basis), 0, @intFromEnum(yoga.YogaUnit.point), 10);
    const packed_value = yoga.yogaNodeStyleGetValue(node, @intFromEnum(yoga.YogaValueKind.flex_basis), 0);
    const unit: u32 = @intCast(packed_value & 0xffffffff);
    const value_bits: u32 = @intCast((packed_value >> 32) & 0xffffffff);
    const value: f32 = @bitCast(value_bits);

    try std.testing.expectEqual(@as(u32, @intFromEnum(yoga.YogaUnit.point)), unit);
    try std.testing.expectApproxEqAbs(@as(f32, 10), value, 0.001);
}

test "Yoga finite-percent patch keeps a deep percent chain and its margins finite" {
    const config = yoga.yogaConfigCreate();
    defer std.debug.assert(yoga.yogaConfigFree(config));
    var nodes: [131]yoga.YGNodeRef = undefined;
    defer for (0..nodes.len) |index| yoga.yogaNodeFree(nodes[nodes.len - 1 - index]);
    const point = @intFromEnum(yoga.YogaUnit.point);
    const percent = @intFromEnum(yoga.YogaUnit.percent);
    for (&nodes, 0..) |*node, index| {
        node.* = yoga.yogaNodeCreateWithConfig(config);
        // Each level doubles its owner's width: 10 * 2^130 overflows f32 without the clamp.
        yoga.yogaNodeStyleSetEnum(node.*, @intFromEnum(yoga.YogaEnumKind.position_type), @intFromEnum(yoga.YogaPositionType.absolute));
        yoga.yogaNodeStyleSetValue(node.*, @intFromEnum(yoga.YogaValueKind.width), 0, if (index == 0) point else percent, if (index == 0) 10 else 200);
        yoga.yogaNodeStyleSetValue(node.*, @intFromEnum(yoga.YogaValueKind.height), 0, point, 4);
        if (index != 0) yoga.yogaNodeInsertChild(nodes[index - 1], node.*, 0);
    }
    const leaf = nodes[nodes.len - 1];
    yoga.yogaNodeStyleSetEnum(leaf, @intFromEnum(yoga.YogaEnumKind.position_type), @intFromEnum(yoga.YogaPositionType.relative));
    yoga.yogaNodeStyleSetValue(leaf, @intFromEnum(yoga.YogaValueKind.margin), @import("context_abi_c").OT_EDGE_ALL, percent, -100);
    yoga.yogaNodeStyleSetFloat(leaf, @intFromEnum(yoga.YogaFloatKind.flex_grow), 1);
    try yoga.check(yoga.yogaNodeCalculateLayoutChecked(nodes[0], std.math.nan(f32), std.math.nan(f32), 1));
    var layout: yoga.ExternalYogaLayout = undefined;
    yoga.yogaNodeGetComputedLayout(leaf, &layout);
    try std.testing.expectEqual(@as(f32, -1e30), layout.left);
    yoga.yogaNodeGetComputedLayout(nodes[nodes.len - 2], &layout);
    try std.testing.expectEqual(@as(f32, 1e30), layout.width);
    try std.testing.expect(std.math.isFinite(layout.top));
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
                yoga.yogaNodeStyleSetValue(item.node, @intFromEnum(yoga.YogaValueKind.margin), edge, @intFromEnum(yoga.YogaUnit.point), item.margin);
            }
            yoga.yogaNodeStyleSetValue(item.node, @intFromEnum(yoga.YogaValueKind.width), 0, @intFromEnum(yoga.YogaUnit.point), item.size);
            yoga.yogaNodeStyleSetValue(item.node, @intFromEnum(yoga.YogaValueKind.height), 0, @intFromEnum(yoga.YogaUnit.point), item.size);
        }
        yoga.yogaNodeCalculateLayout(root, 40, 40, @intFromEnum(yoga.YogaDirection.ltr));

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
    // NativeRenderable.measure over a text of `len` cells that wraps at any cell; it
    // clamps to an undefined height as to a height of 1.
    fn measure(target: ?*anyopaque, width: f32, width_mode: u32, height: f32, _: u32) callconv(.c) yoga.ExternalYogaSize {
        const self: *@This() = @ptrCast(@alignCast(target.?));
        self.calls += 1;
        const wrap: u32 = if (width_mode == @intFromEnum(yoga.YogaMeasureMode.undefined) or !(width >= 1)) 0 else @intFromFloat(@min(@floor(width), 1e6));
        const lines = if (wrap == 0) 1 else (self.len + wrap - 1) / wrap;
        var size: yoga.ExternalYogaSize = .{ .width = @floatFromInt(@max(1, if (wrap == 0) self.len else @min(self.len, wrap))), .height = @floatFromInt(@max(1, lines)) };
        if (width_mode == @intFromEnum(yoga.YogaMeasureMode.at_most) and !self.absolute) {
            size.width = @min(width, size.width);
            size.height = @min(if (std.math.isNan(height)) 1 else height, size.height);
        }
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
            for (self.nodes) |node| yoga.yogaNodeStyleSetValue(node, @intFromEnum(kind), edge, unit, v);
        }
        fn enumValue(self: @This(), kind: yoga.YogaEnumKind, v: u32) void {
            for (self.nodes) |node| yoga.yogaNodeStyleSetEnum(node, @intFromEnum(kind), v);
        }
        fn float(self: @This(), kind: yoga.YogaFloatKind, v: f32) void {
            for (self.nodes) |node| yoga.yogaNodeStyleSetFloat(node, @intFromEnum(kind), v);
        }
    };
    const max_nodes = 40;
    const point = @intFromEnum(yoga.YogaUnit.point);
    const percent = @intFromEnum(yoga.YogaUnit.percent);
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
                    if (random.boolean()) added.enumValue(.flex_direction, @intFromEnum(yoga.YogaFlexDirection.row));
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
                    else => twins.value(.height, 0, @intFromEnum(yoga.YogaUnit.auto), 0),
                },
                else => if (index != 0) twins.enumValue(.display, random.uintLessThan(u32, 2)),
            }
            const height: f32 = if (random.boolean()) std.math.nan(f32) else @floatFromInt(random.intRangeAtMost(u32, 5, 40));
            const width = widths[random.uintLessThan(usize, widths.len)];
            for (nodes) |list| yoga.yogaNodeCalculateLayout(list[0], width, height, @intFromEnum(yoga.YogaDirection.ltr));
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
// with it, so a leaf that grew by less than its margin kept its old size. Random measured and
// empty leaves under a root whose size walks by up to 3 cells a solve; after each solve a fresh
// copy of the tree, solved once, must give every node the same layout.
test "Yoga incremental solves of measured leaves with margins equal fresh solves" {
    const api = @import("context_abi_c");
    const ltr = @intFromEnum(yoga.YogaDirection.ltr);
    const point = @intFromEnum(yoga.YogaUnit.point);
    const config = yoga.yogaConfigCreate();
    defer std.debug.assert(yoga.yogaConfigFree(config));
    yoga.configSetRoundsPositionsFromAbsoluteEdges(config, 1);
    const edges = [_]u32{ api.OT_EDGE_LEFT, api.OT_EDGE_RIGHT, api.OT_EDGE_TOP, api.OT_EDGE_BOTTOM, api.OT_EDGE_ALL };
    var prng = std.Random.DefaultPrng.init(0x374);
    const random = prng.random();
    for (0..300) |_| {
        var nodes: [40]yoga.YGNodeRef = undefined;
        var leaves: [40]Leaf = @splat(.{});
        var measured: [40]bool = @splat(false);
        var count: usize = 1;
        nodes[0] = yoga.yogaNodeCreateWithConfig(config);
        defer yoga.yogaNodeFreeRecursive(nodes[0]);
        if (random.boolean()) yoga.yogaNodeStyleSetEnum(nodes[0], @intFromEnum(yoga.YogaEnumKind.flex_direction), @intFromEnum(yoga.YogaFlexDirection.row));
        var width: f32 = @floatFromInt(random.intRangeAtMost(u32, 10, 80));
        var height: f32 = @floatFromInt(random.intRangeAtMost(u32, 5, 40));
        for (0..40) |_| {
            const index = random.uintLessThan(usize, count);
            switch (if (count < 6) 0 else random.uintLessThan(u32, 3)) {
                0 => if (count < nodes.len) {
                    const added = yoga.yogaNodeCreateWithConfig(config);
                    yoga.yogaNodeInsertChild(nodes[0], added, @intCast(count - 1));
                    leaves[count].len = random.uintAtMost(u32, 120);
                    measured[count] = random.uintLessThan(u32, 3) != 0;
                    if (measured[count]) try yoga.check(yoga.yogaNodeSetNativeMeasureFunc(added, &leaves[count], &Leaf.measure, true));
                    yoga.yogaNodeStyleSetFloat(added, @intFromEnum(yoga.YogaFloatKind.flex_shrink), @floatFromInt(random.uintLessThan(u32, 2)));
                    if (random.uintLessThan(u32, 4) == 0) yoga.yogaNodeStyleSetFloat(added, @intFromEnum(yoga.YogaFloatKind.flex_grow), 1);
                    if (random.uintLessThan(u32, 6) == 0) yoga.yogaNodeStyleSetValue(added, @intFromEnum(yoga.YogaValueKind.width), 0, point, @floatFromInt(random.intRangeAtMost(u32, 5, 30)));
                    if (random.boolean()) yoga.yogaNodeStyleSetEnum(added, @intFromEnum(yoga.YogaEnumKind.align_self), random.intRangeAtMost(u32, api.OT_ALIGN_FLEX_START, api.OT_ALIGN_STRETCH));
                    nodes[count] = added;
                    count += 1;
                },
                1 => if (measured[index]) {
                    leaves[index].len = random.uintAtMost(u32, 120);
                    yoga.yogaNodeInvalidateMeasure(nodes[index]);
                },
                else => if (index != 0) yoga.yogaNodeStyleSetValue(nodes[index], @intFromEnum(yoga.YogaValueKind.margin), edges[random.uintLessThan(usize, edges.len)], point, @floatFromInt(random.uintAtMost(u32, 3))),
            }
            width = std.math.clamp(width + @as(f32, @floatFromInt(random.intRangeAtMost(i32, -3, 3))), 5, 90);
            height = std.math.clamp(height + @as(f32, @floatFromInt(random.intRangeAtMost(i32, -3, 3))), 3, 50);
            yoga.yogaNodeCalculateLayout(nodes[0], width, height, ltr);
            var fresh: [40]yoga.YGNodeRef = undefined;
            var fresh_leaves = leaves;
            for (nodes[0..count], 0..) |node, i| {
                fresh[i] = yoga.yogaNodeCreateWithConfig(config);
                if (i > 0) yoga.yogaNodeInsertChild(fresh[0], fresh[i], @intCast(i - 1));
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
