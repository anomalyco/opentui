const std = @import("std");
const testing = std.testing;
const c = @import("context_abi_c");
const abi = @import("../context-abi.zig");
const context = @import("../context.zig");
const scene = @import("../scene.zig");
const yoga = @import("../yoga.zig");

comptime {
    std.debug.assert(@sizeOf(c.ot_scene_style_update) == 40);
    std.debug.assert(@sizeOf(c.ot_scene_background_update) == 32);
    std.debug.assert(@sizeOf(c.ot_scene_paint_update) == 96);
    std.debug.assert(@alignOf(c.ot_scene_style_update) == 8);
    std.debug.assert(@alignOf(c.ot_scene_background_update) == 8);
    std.debug.assert(@alignOf(c.ot_scene_paint_update) == 8);
}

const flex_grow_kind: u32 = 1;
const flex_shrink_kind: u32 = 2;

const Fixture = struct {
    owner: abi.ContextHandle = .{
        .gpa = .init,
        .io_threaded = .init_single_threaded,
        .core = undefined,
        .owner_thread = undefined,
    },
    session: context.Handle = undefined,
    root: context.Handle = undefined,
    node: context.Handle = undefined,
    other: context.Handle = undefined,

    fn init(self: *Fixture, allocator: std.mem.Allocator) !void {
        self.owner.owner_thread = std.Thread.getCurrentId();
        self.owner.core = try context.Context.init(allocator, self.owner.io_threaded.io(), .{
            .object_capacity = 4,
        });
        self.session = try self.owner.core.createSession(.{ .chunk_size = 4096 });
        try self.owner.core.attachSessionRenderer(self.session, 16, 4, .{ .remote_mode = .remote });
        self.root = try self.owner.core.sceneCreateNode(self.session, 0, 1);
        self.node = try self.owner.core.sceneCreateNode(self.session, 1, 2);
        self.other = try self.owner.core.sceneCreateNode(self.session, 1, 3);
        try self.owner.core.sceneMoveNode(self.node, self.root, 0);
        try self.owner.core.sceneMoveNode(self.other, self.root, 1);
    }

    fn deinit(self: *Fixture) void {
        self.owner.core.deinit() catch unreachable;
        self.owner.io_threaded.deinit();
    }

    fn flush(
        self: *Fixture,
        styles: []const c.ot_scene_style_update,
        backgrounds: []const c.ot_scene_background_update,
        paints: []const c.ot_scene_paint_update,
        applied: *u32,
    ) c.ot_status {
        return abi.ot_scene_flush(
            &self.owner,
            if (styles.len == 0) null else styles.ptr,
            @intCast(styles.len),
            if (backgrounds.len == 0) null else backgrounds.ptr,
            @intCast(backgrounds.len),
            if (paints.len == 0) null else paints.ptr,
            @intCast(paints.len),
            applied,
        );
    }

    fn paint(self: *Fixture, handle: context.Handle) !scene.Paint {
        return (try self.owner.core.getRenderable(handle)).scene_node.?.paint;
    }

    fn red(self: *Fixture, handle: context.Handle) !u16 {
        return (try self.paint(handle)).background[0];
    }

    fn floatStyle(self: *Fixture, handle: context.Handle, kind: u32) !f32 {
        return (try self.owner.core.sceneGetStyle(handle, 1, kind, 0)).value;
    }
};

fn floatStyleUpdate(node: context.Handle, kind: u32, value: f32) c.ot_scene_style_update {
    var entry = std.mem.zeroes(c.ot_scene_style_update);
    entry.node = abi.handleToC(node);
    entry.group = 1;
    entry.kind = kind;
    entry.value = value;
    return entry;
}

fn backgroundUpdate(node: context.Handle, red: u16) c.ot_scene_background_update {
    var entry = std.mem.zeroes(c.ot_scene_background_update);
    entry.node = abi.handleToC(node);
    entry.fields = c.OT_SCENE_UPDATE_APPLY;
    entry.background = .{ red, 0, 0, 255 };
    return entry;
}

fn paintUpdate(node: context.Handle, red: u16) c.ot_scene_paint_update {
    var entry = std.mem.zeroes(c.ot_scene_paint_update);
    entry.node = abi.handleToC(node);
    entry.paint.struct_size = @sizeOf(c.ot_scene_paint_options);
    entry.paint.abi_version = c.OT_CONTEXT_ABI_VERSION;
    entry.paint.opacity = 1;
    entry.paint.should_fill = 1;
    entry.paint.background = .{ red, 0, 0, 255 };
    entry.paint.border_color = .{ 255, 255, 255, 255 };
    entry.paint.focused_border_color = .{ 0, 170, 255, 255 };
    return entry;
}

test "Scene flush rejects malformed arrays before admission and preserves mutation ownership" {
    var fixture: Fixture = .{};
    try fixture.init(testing.allocator);
    defer fixture.deinit();
    var applied: u32 = 99;
    const status = abi.ot_scene_flush(&fixture.owner, null, 0, null, 0, null, 0, &applied);
    try testing.expectEqual(c.OT_OK, status);
    try testing.expectEqual(@as(u32, 0), applied);
    try testing.expect(!fixture.owner.core.mutating);
    const owner = &fixture.owner;
    const counts = [_][3]u32{ .{ 1, 0, 0 }, .{ 0, 1, 0 }, .{ 0, 0, 1 } };
    for (counts) |n| {
        applied = 99;
        try testing.expectEqual(c.OT_INVALID_ARGUMENT, abi.ot_scene_flush(owner, null, n[0], null, n[1], null, n[2], &applied));
        try testing.expectEqual(@as(u32, 0), applied);
        try testing.expectEqual(c.OT_INVALID_ARGUMENT, owner.last_error);
        try testing.expect(!owner.core.mutating);
    }
    const styles = [_]c.ot_scene_style_update{floatStyleUpdate(fixture.node, flex_grow_kind, 1)};
    const backgrounds = [_]c.ot_scene_background_update{backgroundUpdate(fixture.node, 1)};
    const paints = [_]c.ot_scene_paint_update{paintUpdate(fixture.node, 1)};
    for ([_]bool{ false, true }) |reserved| {
        var invalid = backgrounds[0];
        if (reserved) invalid.reserved = 1 else invalid.fields = 2;
        try testing.expectEqual(c.OT_INVALID_ARGUMENT, fixture.flush(&.{}, &.{invalid}, &.{}, &applied));
        try testing.expectEqual(@as(u32, 0), applied);
    }
    for ([_]u32{ 0, 3 }) |group| {
        var invalid = styles[0];
        invalid.group = group;
        invalid.kind = if (group == 0) 9 else 0;
        invalid.value = 2;
        try testing.expectEqual(c.OT_INVALID_ARGUMENT, fixture.flush(&.{invalid}, &.{}, &.{}, &applied));
        try testing.expectEqual(@as(u32, 0), applied);
    }
    const oversized: u32 = c.OT_SCENE_MUTATIONS_MAX + 1;
    for ([_][3]u32{ .{ oversized, 1, 1 }, .{ 1, oversized, 1 }, .{ 1, 1, oversized } }) |n| {
        applied = 99;
        try testing.expectEqual(c.OT_OBJECT_LIMIT, abi.ot_scene_flush(owner, &styles, n[0], &backgrounds, n[1], &paints, n[2], &applied));
        try testing.expectEqual(@as(u32, 0), applied);
    }
    try testing.expectEqual(c.OT_OBJECT_LIMIT, owner.last_error);
    try testing.expectEqual(@as(u16, 0), try fixture.red(fixture.node));
    try testing.expectEqual(@as(f32, 0), try fixture.floatStyle(fixture.node, flex_grow_kind));
    try testing.expect(!owner.core.mutating);
    try testing.expectEqual(
        c.OT_INVALID_ARGUMENT,
        abi.ot_scene_flush(&fixture.owner, null, 0, &backgrounds, 1, null, 0, null),
    );
    var last_error = std.mem.zeroes(c.ot_context_error);
    last_error.struct_size = @sizeOf(c.ot_context_error);
    last_error.abi_version = c.OT_CONTEXT_ABI_VERSION;
    try testing.expectEqual(c.OT_OK, abi.ot_context_get_last_error(owner, &last_error));
    try testing.expectEqual(c.OT_INVALID_ARGUMENT, last_error.status);
    try testing.expectEqual(@as(u16, 0), try fixture.red(fixture.node));
    try testing.expect(!fixture.owner.core.mutating);
    owner.core.mutating = true;
    defer owner.core.mutating = false;
    applied = 99;
    try testing.expectEqual(
        c.OT_CONTEXT_BUSY,
        abi.ot_scene_flush(owner, null, 0, &backgrounds, 1, null, 0, &applied),
    );
    try testing.expectEqual(@as(u32, 0), applied);
    try testing.expectEqual(c.OT_CONTEXT_BUSY, owner.last_error);
    try testing.expect(owner.core.mutating);
    owner.core.mutating = false;
    try testing.expectEqual(@as(u16, 0), try fixture.red(fixture.node));
}

fn expectPrefix(fixture: *Fixture, applied: usize) !void {
    const node = fixture.node;
    const expected_grow: f32 = if (applied >= 1) 5 else 0;
    const expected_shrink: f32 = if (applied >= 2) 7 else 0;
    try testing.expectEqual(expected_grow, try fixture.floatStyle(node, flex_grow_kind));
    try testing.expectEqual(expected_shrink, try fixture.floatStyle(node, flex_shrink_kind));
    var expected_node: scene.Paint = .{};
    expected_node.background = .{ if (applied >= 4) 2 else if (applied >= 3) 1 else 0, 0, 0, if (applied >= 3) 255 else 0 };
    try testing.expectEqualDeep(expected_node, try fixture.paint(node));
    const expected_other: scene.Paint = switch (applied) {
        0...4 => .{},
        5 => .{ .background = .{ 3, 0, 0, 255 } },
        else => .{ .background = .{ 4, 0, 0, 255 } },
    };
    try testing.expect(std.meta.eql(expected_other, try fixture.paint(fixture.other)));
}

test "Scene flush applies styles, backgrounds, then paints and stops at the first rejected entry" {
    var fixture: Fixture = .{};
    try fixture.init(testing.allocator);
    defer fixture.deinit();
    const core = fixture.owner.core;
    for (0..7) |failure_index| {
        var styles = [_]c.ot_scene_style_update{
            floatStyleUpdate(fixture.node, flex_grow_kind, 5),
            floatStyleUpdate(fixture.node, flex_shrink_kind, 7),
        };
        var backgrounds = [_]c.ot_scene_background_update{
            backgroundUpdate(fixture.node, 1),
            backgroundUpdate(fixture.node, 2),
        };
        var paints = [_]c.ot_scene_paint_update{
            paintUpdate(fixture.other, 3),
            paintUpdate(fixture.other, 4),
        };
        switch (failure_index) {
            0, 1 => styles[failure_index].node.generation += 1,
            2, 3 => backgrounds[failure_index - 2].node.generation += 1,
            4, 5 => paints[failure_index - 4].node.generation += 1,
            else => {},
        }
        // Reset to zero rather than Yoga defaults so every prefix is distinguishable.
        try core.sceneSetStyle(fixture.node, 1, flex_grow_kind, 0, 0, 0, 0);
        try core.sceneSetStyle(fixture.node, 1, flex_shrink_kind, 0, 0, 0, 0);
        try core.sceneSetBackground(fixture.node, .{ 0, 0, 0, 0 });
        try core.sceneSetPaint(fixture.other, .{});
        var applied: u32 = 999;
        const expected = if (failure_index == 6) c.OT_OK else c.OT_STALE_HANDLE;
        try testing.expectEqual(expected, fixture.flush(&styles, &backgrounds, &paints, &applied));
        try testing.expectEqual(failure_index, applied);
        try testing.expect(!core.mutating);
        try expectPrefix(&fixture, failure_index);
    }
}

test "Scene flush consumes skipped background entries without validating or changing them" {
    var fixture: Fixture = .{};
    try fixture.init(testing.allocator);
    defer fixture.deinit();
    try fixture.owner.core.sceneSetBackground(fixture.node, .{ 9, 0, 0, 255 });
    // A skipped entry is never inspected: an all-zero handle and an out-of-range
    // channel would both reject if it were applied.
    var skipped = std.mem.zeroes(c.ot_scene_background_update);
    skipped.background = .{ 256, 0, 0, 0 };
    var reserved_skipped = skipped;
    reserved_skipped.reserved = 1;
    const only_skipped = [_]c.ot_scene_background_update{ skipped, reserved_skipped };
    var applied: u32 = 999;
    try testing.expectEqual(c.OT_OK, fixture.flush(&.{}, &only_skipped, &.{}, &applied));
    try testing.expectEqual(@as(u32, 2), applied);
    try testing.expectEqual(@as(u16, 9), try fixture.red(fixture.node));
    const live = backgroundUpdate(fixture.node, 5);
    const mixed = [_]c.ot_scene_background_update{ skipped, live, skipped };
    try testing.expectEqual(c.OT_OK, fixture.flush(&.{}, &mixed, &.{}, &applied));
    try testing.expectEqual(@as(u32, 3), applied);
    try testing.expectEqual(@as(u16, 5), try fixture.red(fixture.node));
    try testing.expect(!fixture.owner.core.mutating);
}

test "Scene flush publishes Yoga style entries immediately" {
    var fixture: Fixture = .{};
    try fixture.init(testing.allocator);
    defer fixture.deinit();
    const core = fixture.owner.core;
    var width = std.mem.zeroes(c.ot_scene_style_update);
    width.node = abi.handleToC(fixture.node);
    width.group = 4;
    width.kind = 0;
    width.unit = 1;
    width.value = 12;
    width.flags = 1;
    const styles = [_]c.ot_scene_style_update{
        floatStyleUpdate(fixture.node, flex_grow_kind, 3.5),
        floatStyleUpdate(fixture.node, flex_shrink_kind, 1),
        width,
    };
    var applied: u32 = 999;
    try testing.expectEqual(c.OT_OK, fixture.flush(&styles, &.{}, &.{}, &applied));
    try testing.expectEqual(@as(u32, 3), applied);
    try testing.expectEqual(@as(f32, 3.5), try fixture.floatStyle(fixture.node, flex_grow_kind));
    // Dimension flags bit 0 disables flex shrink atomically with the width.
    try testing.expectEqual(@as(f32, 0), try fixture.floatStyle(fixture.node, flex_shrink_kind));
    const dimension = try core.sceneGetStyle(fixture.node, 4, 0, 0);
    try testing.expectEqual(@as(u32, 1), dimension.unit);
    try testing.expectEqual(@as(f32, 12), dimension.value);
    try testing.expect(!core.mutating);
}

test "Scene flush requires no Context allocation for a maximal batch" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    var fixture: Fixture = .{};
    try fixture.init(failing.allocator());
    defer fixture.deinit();
    const core = fixture.owner.core;
    try testing.expectError(error.ObjectLimit, core.sceneCreateNode(fixture.session, 1, 4));
    var backgrounds: [c.OT_SCENE_MUTATIONS_MAX]c.ot_scene_background_update = undefined;
    @memset(&backgrounds, backgroundUpdate(fixture.node, 17));
    var paints: [c.OT_SCENE_MUTATIONS_MAX]c.ot_scene_paint_update = undefined;
    @memset(&paints, paintUpdate(fixture.other, 18));
    failing.fail_index = failing.alloc_index;
    failing.resize_fail_index = failing.resize_index;
    var applied: u32 = 999;
    try testing.expectEqual(c.OT_OK, fixture.flush(&.{}, &backgrounds, &paints, &applied));
    try testing.expectEqual(@as(u32, 2 * c.OT_SCENE_MUTATIONS_MAX), applied);
    try testing.expectEqual(@as(u16, 17), try fixture.red(fixture.node));
    try testing.expectEqual(@as(u16, 18), try fixture.red(fixture.other));
    try testing.expect(!failing.has_induced_failure);
    try testing.expect(!fixture.owner.core.mutating);
}

test "Scene flush preserves the exact prefix through checked Yoga allocation failures" {
    defer yoga.testFailAfter(-1);
    // Cases 0..3: a bordered paint fails after that many backgrounds.
    // Case 4: a width style fails ahead of four backgrounds, so none apply.
    for (0..5) |case| {
        var fixture: Fixture = .{};
        try fixture.init(testing.allocator);
        defer fixture.deinit();
        const core = fixture.owner.core;
        for ([_]context.Handle{ fixture.node, fixture.other }) |handle| {
            for (2..7) |kind| try core.sceneSetStyle(handle, 2, @intCast(kind), 0, 1, 3.25, 0);
        }
        const style_failure = case == 4;
        var backgrounds: [4]c.ot_scene_background_update = undefined;
        for (&backgrounds, 0..) |*entry, index| {
            entry.* = backgroundUpdate(fixture.node, @intCast(index + 1));
        }
        var width = std.mem.zeroes(c.ot_scene_style_update);
        width.node = abi.handleToC(fixture.node);
        width.group = 2;
        width.unit = 1;
        width.value = 7.25;
        var bordered = paintUpdate(fixture.other, 9);
        bordered.paint.border_sides = 15;
        const styles: []const c.ot_scene_style_update = if (style_failure) &.{width} else &.{};
        const paints: []const c.ot_scene_paint_update = if (style_failure) &.{} else &.{bordered};
        const submitted = if (style_failure) backgrounds[0..] else backgrounds[0..case];
        const expected_applied: u32 = @intCast(if (style_failure) 0 else case);
        var applied: u32 = 999;
        yoga.testFailAfter(0);
        const status = fixture.flush(styles, submitted, paints, &applied);
        yoga.testFailAfter(-1);
        try testing.expectEqual(c.OT_OUT_OF_MEMORY, status);
        try testing.expectEqual(c.OT_OUT_OF_MEMORY, fixture.owner.last_error);
        try testing.expectEqual(expected_applied, applied);
        try testing.expect(!core.mutating);
        try testing.expectEqual(expected_applied, try fixture.red(fixture.node));
        try testing.expectEqual(@as(u32, 3), (try core.sceneGetStyle(fixture.node, 4, 0, 0)).unit);
        try testing.expect(std.meta.eql(scene.Paint{}, try fixture.paint(fixture.other)));
        for (0..4) |edge| {
            const border = try core.sceneGetStyle(fixture.other, 3, 0, @intCast(edge));
            try testing.expectEqual(@as(f32, 0), border.value);
        }
    }
}
