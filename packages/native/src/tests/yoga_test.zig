const std = @import("std");

const yoga = @import("../yoga.zig");
const CompatibilityOwner = @import("../compatibility-context.zig").CompatibilityOwner;
const yoga_c = @import("yoga");

test "Yoga cache predicate matches eager reference across modes rounding margins and undefined dimensions" {
    const nan = std.math.nan(f32);
    const inf = std.math.inf(f32);
    // Each tuple is available, last available, computed, margin. Cross both axes
    // and all sizing modes so width rejection cannot conceal a height mismatch.
    const dimensions = [_][4]f32{
        .{ nan, nan, 0, 0 },
        .{ nan, 0, nan, 0 },
        .{ 0, nan, 0, 0 },
        .{ 0, -0.0, 0, 0 },
        .{ 1, 1, -1, 0 },
        .{ 139.0071, 140, 139, 0 },
        .{ 139, 139.0071, 139, 0 },
        .{ 140, 139, 139, 0 },
        .{ 0.4998, 0.5, 0.5, 0 },
        .{ 0.5, 0.5002, 0.5, 0 },
        .{ -0.5, -0.4998, 0, 0 },
        .{ 4, 8, 3, 1 },
        .{ 4, 8, 4, 1 },
        .{ 4, 8, 5, -1 },
        .{ 4, 4, 4, nan },
        .{ inf, inf, 1, 0 },
        .{ 1, inf, inf, 0 },
        .{ -inf, 1, 0, 0 },
        .{ 1, 1, -inf, 0 },
        .{ std.math.floatMax(f32), 0, 1, 0 },
    };
    var accepted: usize = 0;
    var rejected: usize = 0;
    for ([_]f32{ 0, 1, 2 }) |scale| {
        for (0..81) |modes| {
            for (dimensions) |width| {
                for (dimensions) |height| {
                    const w: yoga_c.OTYogaCacheAxis = .{
                        .mode = @intCast(modes % 3),
                        .last_mode = @intCast(modes / 3 % 3),
                        .available = width[0],
                        .last_available = width[1],
                        .computed = width[2],
                        .margin = width[3],
                    };
                    const h: yoga_c.OTYogaCacheAxis = .{
                        .mode = @intCast(modes / 9 % 3),
                        .last_mode = @intCast(modes / 27),
                        .available = height[0],
                        .last_available = height[1],
                        .computed = height[2],
                        .margin = height[3],
                    };
                    var reference: u32 = undefined;
                    var rounds: u32 = undefined;
                    const actual = yoga_c.otYogaTestCacheMeasurement(&w, &h, scale, &reference, &rounds);
                    try std.testing.expectEqual(reference, actual);
                    try std.testing.expect(rounds <= 4);
                    if (actual == 0) rejected += 1 else accepted += 1;
                }
            }
        }
    }
    try std.testing.expectEqual(@as(usize, 97_200), accepted + rejected);
    try std.testing.expect(accepted > 0 and rejected > 0);
}

test "Yoga cache predicate skips rounding for mismatched modes and rejected width" {
    const SizingMode = struct {
        const stretch = 0;
        const max_content = 1;
        const fit = 2;
    };
    var width: yoga_c.OTYogaCacheAxis = .{
        .mode = SizingMode.fit,
        .last_mode = SizingMode.stretch,
        .available = 1,
        .last_available = 10,
        .computed = 10,
        .margin = 0,
    };
    var height: yoga_c.OTYogaCacheAxis = .{
        .mode = SizingMode.stretch,
        .last_mode = SizingMode.max_content,
        .available = 1,
        .last_available = 10,
        .computed = 1,
        .margin = 0,
    };
    var reference: u32 = undefined;
    var rounds: u32 = undefined;
    try std.testing.expectEqual(@as(u32, 0), yoga_c.otYogaTestCacheMeasurement(&width, &height, 1, &reference, &rounds));
    try std.testing.expectEqual(@as(u32, 0), reference);
    try std.testing.expectEqual(@as(u32, 0), rounds);

    width.mode = SizingMode.stretch;
    try std.testing.expectEqual(@as(u32, 0), yoga_c.otYogaTestCacheMeasurement(&width, &height, 1, &reference, &rounds));
    try std.testing.expectEqual(@as(u32, 2), rounds);

    width.last_mode = SizingMode.max_content;
    width.computed = 1;
    try std.testing.expectEqual(@as(u32, 1), yoga_c.otYogaTestCacheMeasurement(&width, &height, 1, &reference, &rounds));
    try std.testing.expectEqual(@as(u32, 1), reference);
    try std.testing.expectEqual(@as(u32, 0), rounds);

    height.last_mode = SizingMode.stretch;
    try std.testing.expectEqual(@as(u32, 1), yoga_c.otYogaTestCacheMeasurement(&width, &height, 1, &reference, &rounds));
    try std.testing.expectEqual(@as(u32, 2), rounds);
    width.last_mode = SizingMode.stretch;
    try std.testing.expectEqual(@as(u32, 1), yoga_c.otYogaTestCacheMeasurement(&width, &height, 1, &reference, &rounds));
    try std.testing.expectEqual(@as(u32, 4), rounds);
    try std.testing.expectEqual(@as(u32, 1), yoga_c.otYogaTestCacheMeasurement(&width, &height, 0, &reference, &rounds));
    try std.testing.expectEqual(@as(u32, 0), rounds);
}

test "Yoga layout wrapper work follows ancestor depth rather than connected tree size" {
    var first: yoga.Config = undefined;
    try first.init(std.testing.allocator, .{});
    defer first.deinit();
    var second: yoga.Config = undefined;
    try second.init(std.testing.allocator, .{});
    defer second.deinit();
    const root = try first.createNode();
    defer yoga.yogaNodeFreeRecursive(root);
    const subtree = try second.createNode();
    try yoga.check(yoga.yogaNodeInsertChildChecked(root, subtree, 0));
    try yoga.check(yoga.yogaNodeInsertChildChecked(subtree, try first.createNode(), 0));
    for (1..1001) |index| {
        try yoga.check(yoga.yogaNodeInsertChildChecked(root, try second.createNode(), @intCast(index)));
    }
    try yoga.check(yoga.yogaNodeCalculateLayoutChecked(root, 100, 100, 1));
    for ([_]yoga.YGNodeRef{ root, subtree }) |node| {
        for ([_]f32{ 100, 101 }) |width| {
            first.test_work_count = 0;
            second.test_work_count = 0;
            try yoga.check(yoga.yogaNodeCalculateLayoutChecked(node, width, 100, 1));
            try std.testing.expectEqual(if (node == root) @as(u64, 1) else 2, first.test_work_count + second.test_work_count);
        }
    }
    try yoga.check(yoga.yogaNodeStyleSetFloatChecked(subtree, 0, 1));
    first.test_work_count = 0;
    second.test_work_count = 0;
    yoga.testFailAfter(0);
    defer yoga.testFailAfter(-1);
    try std.testing.expectEqual(yoga.Status.out_of_memory, yoga.yogaNodeCalculateLayoutChecked(subtree, 102, 100, 1));
    try std.testing.expect(first.test_work_count + second.test_work_count >= 1003);
    try std.testing.expectEqual(yoga.Status.poisoned, yoga.yogaNodeCalculateLayoutChecked(root, 100, 100, 1));
}

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

test "Yoga compound appends preserve geometric child capacity growth" {
    var config: yoga.Config = undefined;
    try config.init(std.testing.allocator, .{});
    defer config.deinit();
    const parent = try config.createNode();
    defer yoga.yogaNodeFree(parent);
    var children: [4]yoga.YGNodeRef = undefined;
    for (&children) |*child| child.* = try config.createNode();
    defer for (children) |child| yoga.yogaNodeFree(child);
    for (children[0..3], 0..) |child, index| try yoga.check(yoga.yogaNodeMoveChildChecked(parent, child, @intCast(index)));
    yoga.testFailAfter(0);
    defer yoga.testFailAfter(-1);
    try std.testing.expectEqual(yoga.Status.ok, yoga.yogaNodeMoveChildChecked(parent, children[3], 3));
    try std.testing.expectEqual(@as(u64, 0), yoga.testAllocationCount());
    for (children, 0..) |child, index| {
        var actual: yoga.YGNodeRef = null;
        try yoga.check(yoga.yogaNodeGetChildChecked(parent, @intCast(index), &actual));
        try std.testing.expectEqual(child, actual);
        try std.testing.expectEqual(parent, yoga.yogaNodeGetParent(child));
    }
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
    var edge: f32 = 123;
    try std.testing.expectEqual(invalid, yoga.yogaNodeLayoutGetEdgeChecked(node, 0, 6, &edge));
    try std.testing.expectEqual(invalid, yoga.yogaNodeLayoutGetEdgeChecked(node, 3, 0, &edge));
    try std.testing.expectEqual(@as(f32, 123), edge);
    try std.testing.expectEqual(invalid, yoga.yogaNodeMarkDirtyChecked(node));
    try std.testing.expectEqual(invalid, yoga.yogaNodeCalculateLayoutChecked(node, 1, 1, 3));
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

test "Yoga checked display contents insertion failure leaves topology retryable" {
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
    try yoga.check(yoga.yogaNodeResetChecked(node));
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

test "Yoga checked frees 10000 owned nodes iteratively at the depth limit with faults armed" {
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
    for (yoga.depth_max..10_000) |index| {
        const child = try config.createNode();
        try yoga.check(yoga.yogaNodeInsertChildChecked(root, child, @intCast(index - yoga.depth_max + 1)));
    }
    var node_count: u32 = 0;
    var cursor = config.nodes;
    while (cursor) |node| : (cursor = node.config_next) node_count += 1;
    try std.testing.expectEqual(@as(u32, 10_000), node_count);
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

test "Yoga compatibility owner retains config until unregistered native nodes are freed" {
    const owner = try std.testing.allocator.create(CompatibilityOwner);
    defer std.testing.allocator.destroy(owner);
    owner.init();
    const config = try owner.getYogaConfig();
    try std.testing.expect(config == try owner.getYogaConfig());
    const root = try config.createNode();
    const child = yoga.yogaNodeCreateWithConfig(config.ref);
    yoga.yogaNodeInsertChild(root, child, 0);
    try std.testing.expect(owner.registry.isEmpty());
    try std.testing.expectError(error.LiveYogaNodes, owner.deinit());
    try std.testing.expect(config.hasLiveNodes());
    yoga.yogaNodeFree(root);
    try std.testing.expectError(error.LiveYogaNodes, owner.deinit());
    yoga.yogaNodeFree(child);
    try std.testing.expect(!config.hasLiveNodes());
    try std.testing.expect(!yoga.yogaConfigFree(config.ref));
    try std.testing.expectEqual(std.heap.Check.ok, try owner.deinit());
}

test "Yoga public config free rejects a live node and permits retry" {
    const config = yoga.yogaConfigCreate();
    const node = yoga.yogaNodeCreateWithConfig(config);
    try std.testing.expect(!yoga.yogaConfigFree(config));
    yoga.yogaNodeFree(node);
    try std.testing.expect(yoga.yogaConfigFree(config));
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

test "OpenTUI Yoga nodes use the native fixed config" {
    const first = yoga.yogaNodeCreateForOpenTUI();
    defer yoga.yogaNodeFree(first);
    const second = yoga.yogaNodeCreateForOpenTUI();
    defer yoga.yogaNodeFree(second);

    const first_config = yoga.yogaNodeGetConfig(first);
    const second_config = yoga.yogaNodeGetConfig(second);
    try std.testing.expect(first_config == second_config);
    try std.testing.expect(!yoga.yogaConfigGetUseWebDefaults(first_config));
    try std.testing.expectEqual(@as(f32, 1), yoga.yogaConfigGetPointScaleFactor(first_config));
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

test "Yoga host callback owners use config context and cannot clear another owner" {
    const Host = struct {
        var first_dirtied: u32 = 0;
        var second_dirtied: u32 = 0;
        fn first(node: ?*anyopaque, _: f32, _: u32, _: f32, _: u32) callconv(.c) void {
            yoga.yogaStoreMeasureResult(yoga.yogaNodeGetConfig(@ptrCast(node)), 3, 1);
        }
        fn second(node: ?*anyopaque, _: f32, _: u32, _: f32, _: u32) callconv(.c) void {
            yoga.yogaStoreMeasureResult(yoga.yogaNodeGetConfig(@ptrCast(node)), 7, 2);
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
    try std.testing.expect(yoga.yogaConfigClearCallbacks(second.ref, Host.second));
}
