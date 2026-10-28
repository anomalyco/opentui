//! Scroll nodes: the layout against the equivalent box tree, the sticky rule against a
//! reference model, bars and fills, and SCROLL notifications.
const std = @import("std");
const testing = std.testing;
const c = @import("context_abi_c");
const context = @import("../context.zig");
const scene = @import("../scene.zig");
const ansi = @import("../ansi.zig");
const fixture = @import("scene_fixture_test.zig");
const Fixture = fixture.Fixture;

const frame_options: scene.FrameOptions = .{ .background = .{ 0, 0, 0, 255 }, .use_mouse = true, .excluded_hit_num = 0, .max_layout_rounds = 8, .max_host_requests = 64 };

fn style(f: Fixture, node: context.Handle, group: u32, kind: u32, edge: u32, unit: u32, value: f32, flags: u32) !void {
    try f.owner.sceneSetStyle(node, group, kind, edge, unit, value, flags);
}

fn create(f: Fixture, parent: context.Handle, kind: u32, num: u32) !context.Handle {
    const node = try f.owner.sceneCreateNode(f.id, kind, num);
    try f.owner.sceneMoveNode(node, parent, @intCast((try f.owner.raw().getRenderable(parent)).scene_node.?.children.items.len));
    return node;
}

fn present(f: Fixture) !void {
    try fixture.repaint(f.owner, f.id, frame_options.background, true, 0);
    try commit(f);
}

/// Commits the painted draft and completes its output, which publishes its hits.
fn commit(f: Fixture) !void {
    _ = try fixture.present(f.owner, f.id, false);
    var bytes: [4096]u8 = undefined;
    while (try f.owner.readOutput(f.id, &bytes)) |ticket| try f.owner.completeOutput(f.id, ticket, .written);
}

fn screenRect(layout: scene.Layout) [4]f64 {
    return .{ layout.screenX, layout.screenY, layout.width, layout.height };
}

/// The 16 cases of the D1 review's layout probe.
const LayoutCase = struct {
    row_parent: bool = false,
    parent_height: f32 = 24,
    size: ?[2]f32 = null,
    max_height: ?f32 = null,
    grow: bool = false,
    rows: u32,
    text: enum { short, words, wide } = .short,
    nowrap: bool = false,
    scroll_x: bool = false,
    center: u32 = 0,
    content_min_zero: bool = false,
    padding: f32 = 0,
    gap: u32 = 0,
    border: bool = false,
    content_padding: f32 = 0,
};

const layout_cases = [_]LayoutCase{
    .{ .size = .{ 40, 10 }, .rows = 30 },
    .{ .size = .{ 40, 10 }, .rows = 3 },
    .{ .rows = 3 },
    .{ .row_parent = true, .rows = 3 },
    .{ .max_height = 5, .rows = 3 },
    .{ .max_height = 5, .rows = 12 },
    .{ .parent_height = 20, .grow = true, .rows = 40, .text = .words },
    .{ .size = .{ 40, 10 }, .center = 2, .rows = 3 },
    .{ .size = .{ 40, 10 }, .center = 1, .rows = 30 },
    .{ .size = .{ 40, 10 }, .content_min_zero = true, .rows = 3 },
    .{ .size = .{ 40, 10 }, .padding = 1, .gap = 1, .rows = 30, .text = .words },
    .{ .size = .{ 20, 6 }, .scroll_x = true, .rows = 10, .text = .wide },
    .{ .size = .{ 20, 6 }, .scroll_x = true, .nowrap = true, .rows = 10, .text = .wide },
    .{ .size = .{ 20, 6 }, .scroll_x = true, .nowrap = true, .rows = 2, .text = .wide },
    .{ .size = .{ 40, 10 }, .border = true, .content_padding = 1, .rows = 30 },
    .{ .row_parent = true, .parent_height = 10, .grow = true, .rows = 30, .text = .words },
};

const Measured = struct { box: [4]f64, viewport: [4]f64, content: [4]f64, rows: [40]scene.Layout, visible: [2]bool };

/// One case as a scroll node, or as the box tree it stands for (row box, viewport box,
/// content box) with the scroll node's gutters.
fn measureLayout(case: LayoutCase, gutters: ?[2]f32) !Measured {
    const f = try Fixture.init(testing.allocator, 80, 30, .{});
    defer f.deinit();
    const parent = try create(f, f.root, c.OT_SCENE_BOX, 2);
    try style(f, parent, c.OT_STYLE_DIMENSION, 0, 0, c.OT_UNIT_POINT, 60, 1);
    try style(f, parent, c.OT_STYLE_DIMENSION, 1, 0, c.OT_UNIT_POINT, case.parent_height, 1);
    if (case.row_parent) try style(f, parent, c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_FLEX_DIRECTION, 0, 0, c.OT_FLEX_DIRECTION_ROW, 0);
    const box = try create(f, parent, c.OT_SCENE_BOX, 3);
    try style(f, box, c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_FLEX_DIRECTION, 0, 0, c.OT_FLEX_DIRECTION_ROW, 0);
    try style(f, box, c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_ALIGN_ITEMS, 0, 0, c.OT_ALIGN_STRETCH, 0);
    if (case.size) |size| for (size, 0..) |value, kind| try style(f, box, c.OT_STYLE_DIMENSION, @intCast(kind), 0, c.OT_UNIT_POINT, value, 1);
    if (case.max_height) |value| try style(f, box, c.OT_STYLE_VALUE, c.OT_STYLE_VALUE_MAX_HEIGHT, 0, c.OT_UNIT_POINT, value, 0);
    if (case.grow) try style(f, box, c.OT_STYLE_FLOAT, c.OT_STYLE_FLOAT_FLEX_GROW, 0, 0, 1, 0);
    if (case.grow and !case.row_parent) try style(f, box, c.OT_STYLE_VALUE, c.OT_STYLE_VALUE_MIN_HEIGHT, 0, c.OT_UNIT_POINT, 0, 0);
    if (case.border) try f.owner.sceneSetPaint(box, .{ .borderSides = c.OT_BORDER_ALL });
    const bar: scene.ScrollBarOptions = .{ .gap = case.gap };
    var viewport: ?context.Handle = null;
    var content = box;
    var flags: u32 = c.OT_STYLE_CONTENT;
    if (gutters) |values| {
        try style(f, box, c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_OVERFLOW, 0, 0, c.OT_OVERFLOW_HIDDEN, 0);
        for ([_]u32{ c.OT_EDGE_BOTTOM, c.OT_EDGE_RIGHT }, values) |edge, value| try style(f, box, c.OT_STYLE_VALUE, c.OT_STYLE_VALUE_PADDING, edge, c.OT_UNIT_POINT, value, 0);
        viewport = try create(f, box, c.OT_SCENE_BOX, 4);
        try style(f, viewport.?, c.OT_STYLE_FLOAT, c.OT_STYLE_FLOAT_FLEX_GROW, 0, 0, 1, 0);
        try style(f, viewport.?, c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_OVERFLOW, 0, 0, c.OT_OVERFLOW_HIDDEN, 0);
        for ([_]u32{ c.OT_EDGE_LEFT, c.OT_EDGE_RIGHT }) |edge| try style(f, viewport.?, c.OT_STYLE_VALUE, c.OT_STYLE_VALUE_PADDING, edge, c.OT_UNIT_POINT, case.padding, 0);
        content = try create(f, viewport.?, c.OT_SCENE_BOX, 5);
        try style(f, content, c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_ALIGN_SELF, 0, 0, c.OT_ALIGN_FLEX_START, 0);
        try style(f, content, c.OT_STYLE_FLOAT, c.OT_STYLE_FLOAT_FLEX_SHRINK, 0, 0, 0, 0);
        for ([_]u32{ c.OT_STYLE_VALUE_MIN_WIDTH, c.OT_STYLE_VALUE_MIN_HEIGHT }) |kind| try style(f, content, c.OT_STYLE_VALUE, kind, 0, c.OT_UNIT_PERCENT, 100, 0);
        if (!case.scroll_x) try style(f, content, c.OT_STYLE_VALUE, c.OT_STYLE_VALUE_MAX_WIDTH, 0, c.OT_UNIT_PERCENT, 100, 0);
        flags = 0;
    } else {
        try f.owner.sceneSetScroll(box, .{ .axes = c.OT_SCENE_SCROLL_Y | (if (case.scroll_x) c.OT_SCENE_SCROLL_X else 0), .padding = .{ case.padding, 0, case.padding, 0 }, .bars = .{ bar, bar } });
    }
    if (case.center != 0) try style(f, content, c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_JUSTIFY_CONTENT, 0, 0, c.OT_JUSTIFY_CENTER, flags);
    if (case.center == 2) try style(f, content, c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_ALIGN_ITEMS, 0, 0, c.OT_ALIGN_CENTER, flags);
    if (case.content_min_zero) try style(f, content, c.OT_STYLE_VALUE, c.OT_STYLE_VALUE_MIN_HEIGHT, 0, c.OT_UNIT_POINT, 0, flags);
    if (case.content_padding != 0) try style(f, content, c.OT_STYLE_VALUE, c.OT_STYLE_VALUE_PADDING, c.OT_EDGE_ALL, c.OT_UNIT_POINT, case.content_padding, flags);
    var rows: [40]context.Handle = undefined;
    for (rows[0..case.rows], 0..) |*row, index| {
        row.* = try create(f, content, c.OT_SCENE_TEXT, @intCast(10 + index));
        var buffer: [64]u8 = undefined;
        try f.owner.sceneSetText(row.*, switch (case.text) {
            .short => try std.fmt.bufPrint(&buffer, "Row {d}", .{index}),
            .words => try std.fmt.bufPrint(&buffer, "Row {d} {s}", .{ index, ("lorem ipsum dolor sit amet " ** 3)[0 .. 27 * (index % 3)] }),
            .wide => try std.fmt.bufPrint(&buffer, "Row {d} {s}", .{ index, "x" ** 30 }),
        });
        if (case.nowrap) try f.owner.sceneSetTextOptions(row.*, .{ .wrap_mode = .none });
    }
    try present(f);
    var result: Measured = undefined;
    const box_layout = try f.owner.sceneGetLayout(box, false);
    result.box = screenRect(box_layout);
    if (viewport) |handle| {
        result.viewport = screenRect(try f.owner.sceneGetLayout(handle, false));
        result.content = screenRect(try f.owner.sceneGetLayout(content, false));
    } else {
        const state = try f.owner.sceneGetScroll(box);
        result.viewport = state.viewport;
        result.content = .{ box_layout.screenX + state.content[0], box_layout.screenY + state.content[1], state.content[2], state.content[3] };
        result.visible = .{ state.bars[0].visible != 0, state.bars[1].visible != 0 };
    }
    for (rows[0..case.rows], result.rows[0..case.rows]) |row, *layout| layout.* = try f.owner.sceneGetLayout(row, false);
    return result;
}

test "Scene scroll node lays out as the row box, viewport box, and content box it stands for" {
    for (layout_cases, 0..) |case, index| {
        errdefer std.debug.print("layout case {d}\n", .{index});
        const actual = try measureLayout(case, null);
        var gutters: [2]f32 = undefined;
        for (actual.visible, &gutters) |visible, *gutter| gutter.* = if (visible) @floatFromInt(case.gap + 1) else 0;
        const expected = try measureLayout(case, gutters);
        try testing.expectEqual(expected.box, actual.box);
        try testing.expectEqual(expected.viewport, actual.viewport);
        try testing.expectEqual(expected.content, actual.content);
        try testing.expectEqualSlices(scene.Layout, expected.rows[0..case.rows], actual.rows[0..case.rows]);
    }
}

/// The sticky rule in twenty lines: a solve moves a stuck view to its edge and clamps; an
/// explicit scroll or a follow change recomputes stuck.
const StickyModel = struct {
    follow: u32,
    stuck: bool = true,
    offset: f64 = 0,
    max: f64 = 0,

    fn edge(self: StickyModel) f64 {
        return if (self.follow == c.OT_SCENE_SCROLL_FOLLOW_BOTTOM or self.follow == c.OT_SCENE_SCROLL_FOLLOW_RIGHT) self.max else 0;
    }
    fn restick(self: *StickyModel) void {
        if (self.follow != c.OT_SCENE_SCROLL_FOLLOW_NONE) self.stuck = self.max <= 1 or self.offset == self.edge();
    }
    fn layout(self: *StickyModel, max: f64) void {
        self.max = max;
        if (self.follow != c.OT_SCENE_SCROLL_FOLLOW_NONE and self.stuck) self.offset = self.edge();
        self.offset = std.math.clamp(self.offset, 0, max);
    }
    fn scroll(self: *StickyModel, value: f64) void {
        self.offset = std.math.clamp(@floor(value + 0.5), 0, self.max);
        self.restick();
    }
    /// A REAPPLY scroll, then a layout of `max` that applies it again: a target at or past a
    /// positive max is the end. A scroll that reached its place and left a following view stuck
    /// keeps no target; a clamped one does.
    fn reapply(self: *StickyModel, value: f64, max: f64, solves: bool) void {
        const end = value > 0 and value >= self.max;
        self.scroll(value);
        if (!solves) return;
        if (self.follow != c.OT_SCENE_SCROLL_FOLLOW_NONE and self.stuck and @floor(value + 0.5) == self.offset) return self.layout(max);
        self.max = max;
        self.scroll(if (end) max else value);
    }
};

/// `other` resizes a sibling: the scene solves, the scroll node's layout does not change.
/// `ask` is a REAPPLY scroll followed by a row count change in the same frame.
const StickyOp = union(enum) { rows: u32, size: f32, to: f64, by: f64, follow: u32, grow: struct { size: f32, rows: u32 }, other: f32, ask: struct { to: f64, by: bool = false, rows: u32 } };

/// A box of `size` cells along the axis with rows of one cell; every op is followed by a frame.
const Sticky = struct {
    f: Fixture,
    box: context.Handle,
    sibling: context.Handle,
    rows: std.ArrayListUnmanaged(context.Handle) = .empty,
    model: StickyModel,
    axis: usize,
    size: f32 = 10,

    fn init(follow: u32, horizontal: bool) !Sticky {
        const f = try Fixture.init(testing.allocator, 40, 40, .{});
        const axis: usize = @intFromBool(!horizontal);
        const box = try create(f, f.root, c.OT_SCENE_BOX, 2);
        try style(f, box, c.OT_STYLE_DIMENSION, 0, 0, c.OT_UNIT_POINT, 10, 1);
        try style(f, box, c.OT_STYLE_DIMENSION, 1, 0, c.OT_UNIT_POINT, 10, 1);
        const sibling = try create(f, f.root, c.OT_SCENE_BOX, 3);
        try style(f, sibling, c.OT_STYLE_DIMENSION, 1, 0, c.OT_UNIT_POINT, 1, 1);
        var self: Sticky = .{ .f = f, .box = box, .sibling = sibling, .model = .{ .follow = c.OT_SCENE_SCROLL_FOLLOW_NONE }, .axis = axis };
        try self.apply(.{ .follow = follow });
        if (horizontal) try style(f, box, c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_FLEX_DIRECTION, 0, 0, c.OT_FLEX_DIRECTION_ROW, c.OT_STYLE_CONTENT);
        return self;
    }

    fn deinit(self: *Sticky) void {
        self.rows.deinit(testing.allocator);
        self.f.deinit();
    }

    fn setRows(self: *Sticky, count: u32) !void {
        while (self.rows.items.len > count) try self.f.owner.sceneDestroyNode(self.rows.pop().?);
        while (self.rows.items.len < count) {
            const row = try create(self.f, self.box, c.OT_SCENE_BOX, @intCast(10 + self.rows.items.len));
            for (0..2) |kind| try style(self.f, row, c.OT_STYLE_DIMENSION, @intCast(kind), 0, c.OT_UNIT_POINT, 1, 1);
            try self.rows.append(testing.allocator, row);
        }
    }

    fn setSize(self: *Sticky, size: f32) !void {
        self.size = size;
        try style(self.f, self.box, c.OT_STYLE_DIMENSION, @intCast(self.axis), 0, c.OT_UNIT_POINT, size, 1);
    }

    fn apply(self: *Sticky, op: StickyOp) !void {
        var target: [2]f64 = .{ 0, 0 };
        const before = .{ self.rows.items.len, self.size };
        switch (op) {
            .rows => |count| try self.setRows(count),
            .size => |size| try self.setSize(size),
            .grow => |value| {
                try self.setSize(value.size);
                try self.setRows(value.rows);
            },
            .other => |width| try style(self.f, self.sibling, c.OT_STYLE_DIMENSION, 0, 0, c.OT_UNIT_POINT, width, 1),
            .to, .by => |value| {
                target[self.axis] = value;
                _ = try self.f.owner.sceneScrollTo(self.box, target, .{ op == .by, op == .by }, false);
                self.model.scroll(if (op == .by) self.model.offset + value else value);
            },
            .ask => |value| {
                const solves = value.rows != self.rows.items.len;
                target[self.axis] = value.to;
                _ = try self.f.owner.sceneScrollTo(self.box, target, .{ value.by, value.by }, true);
                try self.setRows(value.rows);
                try present(self.f);
                const max = @max(0, @as(f64, @floatFromInt(value.rows)) - self.size);
                // A relative 0 keeps the axis: no target.
                if (value.by and value.to == 0) {
                    if (solves) self.model.layout(max);
                } else self.model.reapply(if (value.by) self.model.offset + value.to else value.to, max, solves);
                return self.expectModel();
            },
            .follow => |follow| {
                try self.f.owner.sceneSetScroll(self.box, .{ .axes = @as(u32, 1) << @intCast(self.axis), .follow = follow });
                if (self.model.follow != follow) {
                    self.model.follow = follow;
                    self.model.restick();
                }
            },
        }
        try present(self.f);
        // Only a solve moves a stuck view, so a scroll in a noise range stays until one.
        if (!std.meta.eql(before, .{ self.rows.items.len, self.size })) self.model.layout(@max(0, @as(f64, @floatFromInt(self.rows.items.len)) - self.size));
        try self.expectModel();
    }

    fn expectModel(self: *Sticky) !void {
        const state = try self.f.owner.sceneGetScroll(self.box);
        try testing.expectEqual(self.model.max, state.max[self.axis]);
        try testing.expectEqual(self.model.offset, state.offset[self.axis]);
        try testing.expectEqual(self.model.stuck, state.stuck != 0);
    }
};

test "Scene scroll node follows its sticky edge as the reference model does" {
    const B = c.OT_SCENE_SCROLL_FOLLOW_BOTTOM;
    const rows = [_]struct { follow: u32 = B, horizontal: bool = false, ops: []const StickyOp, offset: f64 }{
        // #530: a reader who scrolled up stays put while content grows.
        .{ .ops = &.{ .{ .rows = 20 }, .{ .rows = 25 }, .{ .by = -3 }, .{ .rows = 30 } }, .offset = 12 },
        // #709: scrolling back to the bottom follows again.
        .{ .ops = &.{ .{ .rows = 20 }, .{ .to = 2 }, .{ .to = 10 }, .{ .rows = 30 } }, .offset = 20 },
        // #1087: following through growth in several steps, and after a shrink.
        .{ .ops = &.{ .{ .rows = 12 }, .{ .rows = 15 }, .{ .rows = 19 }, .{ .rows = 22 } }, .offset = 12 },
        .{ .ops = &.{ .{ .rows = 30 }, .{ .rows = 14 }, .{ .rows = 31 } }, .offset = 21 },
        // #1088 without its tolerance: a reader one row above the bottom stays there.
        .{ .ops = &.{ .{ .rows = 30 }, .{ .by = -1 }, .{ .rows = 31 } }, .offset = 19 },
        // The re-engage loop on the other edges.
        .{ .follow = c.OT_SCENE_SCROLL_FOLLOW_TOP, .ops = &.{ .{ .rows = 30 }, .{ .to = 5 }, .{ .to = 0 }, .{ .rows = 40 } }, .offset = 0 },
        .{ .follow = c.OT_SCENE_SCROLL_FOLLOW_RIGHT, .horizontal = true, .ops = &.{ .{ .rows = 30 }, .{ .by = -4 }, .{ .by = 4 }, .{ .rows = 35 } }, .offset = 25 },
        .{ .follow = c.OT_SCENE_SCROLL_FOLLOW_LEFT, .horizontal = true, .ops = &.{ .{ .rows = 30 }, .{ .to = 3 }, .{ .rows = 35 } }, .offset = 3 },
        // stickyStart top never follows the bottom.
        .{ .follow = c.OT_SCENE_SCROLL_FOLLOW_TOP, .ops = &.{ .{ .rows = 30 }, .{ .rows = 40 } }, .offset = 0 },
        // #1514: a shrink that clamps a reader onto the new maximum does not stick it.
        .{ .ops = &.{ .{ .rows = 40 }, .{ .to = 20 }, .{ .rows = 25 }, .{ .rows = 40 } }, .offset = 15 },
        // Review row A: a one-row range is noise, so a scroll there follows again, but only
        // once the range changes: a solve elsewhere leaves the reader at 0, as today.
        .{ .ops = &.{ .{ .rows = 11 }, .{ .to = 0 }, .{ .other = 3 }, .{ .rows = 20 } }, .offset = 10 },
        // Review row C: scrolled up, shrunk to fit, scrolled, grown: follows again.
        .{ .ops = &.{ .{ .rows = 30 }, .{ .to = 5 }, .{ .rows = 8 }, .{ .to = 0 }, .{ .rows = 25 } }, .offset = 15 },
        // Review row F: the follow edge set before any content follows the first content.
        .{ .follow = c.OT_SCENE_SCROLL_FOLLOW_NONE, .ops = &.{ .{ .follow = B }, .{ .rows = 30 } }, .offset = 20 },
        // 338: the viewport and the content grow in one frame; the range and the offset stay.
        .{ .follow = c.OT_SCENE_SCROLL_FOLLOW_NONE, .ops = &.{ .{ .rows = 15 }, .{ .to = 5 }, .{ .grow = .{ .size = 20, .rows = 25 } } }, .offset = 5 },
        .{ .follow = c.OT_SCENE_SCROLL_FOLLOW_NONE, .ops = &.{ .{ .rows = 15 }, .{ .to = 5 }, .{ .grow = .{ .size = 20, .rows = 22 } } }, .offset = 2 },
        // Infinite targets clamp.
        .{ .follow = c.OT_SCENE_SCROLL_FOLLOW_NONE, .ops = &.{ .{ .rows = 30 }, .{ .to = std.math.inf(f64) } }, .offset = 20 },
        .{ .follow = c.OT_SCENE_SCROLL_FOLLOW_NONE, .ops = &.{ .{ .rows = 30 }, .{ .to = 7 }, .{ .by = -std.math.inf(f64) } }, .offset = 0 },
        // REAPPLY: a target past the old max lands where it asked after growth in the same frame,
        // and at the end when it was at or past that max, even after growth beyond a viewport.
        .{ .follow = c.OT_SCENE_SCROLL_FOLLOW_NONE, .ops = &.{ .{ .rows = 20 }, .{ .ask = .{ .to = 7, .rows = 40 } } }, .offset = 7 },
        .{ .follow = c.OT_SCENE_SCROLL_FOLLOW_NONE, .ops = &.{ .{ .rows = 20 }, .{ .ask = .{ .to = 20, .rows = 60 } } }, .offset = 50 },
        .{ .follow = c.OT_SCENE_SCROLL_FOLLOW_NONE, .ops = &.{ .{ .rows = 20 }, .{ .ask = .{ .to = std.math.inf(f64), .rows = 60 } }, .{ .rows = 70 } }, .offset = 50 },
        .{ .ops = &.{ .{ .rows = 20 }, .{ .ask = .{ .to = 10, .rows = 60 } }, .{ .rows = 70 } }, .offset = 60 },
        .{ .follow = c.OT_SCENE_SCROLL_FOLLOW_NONE, .ops = &.{ .{ .rows = 20 }, .{ .to = 4 }, .{ .ask = .{ .to = 3, .by = true, .rows = 5 } }, .{ .rows = 30 } }, .offset = 0 },
        .{ .follow = c.OT_SCENE_SCROLL_FOLLOW_NONE, .ops = &.{ .{ .rows = 20 }, .{ .ask = .{ .to = -std.math.inf(f64), .rows = 30 } } }, .offset = 0 },
        // A target that leaves the view stuck follows the sticky rule: as row A, a scroll to 0 in
        // a noise range keeps following through growth in the same frame.
        .{ .ops = &.{ .{ .rows = 11 }, .{ .ask = .{ .to = 0, .rows = 20 } }, .{ .rows = 25 } }, .offset = 15 },
        // A target away from the edge lands against the grown range and leaves the view there.
        .{ .ops = &.{ .{ .rows = 20 }, .{ .ask = .{ .to = 3, .rows = 30 } }, .{ .rows = 35 } }, .offset = 3 },
        // The target lasts one frame: the next growth follows the sticky rule alone.
        .{ .ops = &.{ .{ .rows = 30 }, .{ .ask = .{ .to = 4, .rows = 30 } }, .{ .rows = 40 }, .{ .to = 30 }, .{ .rows = 45 } }, .offset = 35 },
    };
    for (rows, 0..) |row, index| {
        errdefer std.debug.print("sticky row {d}\n", .{index});
        var sticky = try Sticky.init(row.follow, row.horizontal);
        defer sticky.deinit();
        for (row.ops) |op| try sticky.apply(op);
        try testing.expectEqual(row.offset, sticky.model.offset);
    }
    // Random sequences: rows added and removed, the viewport resized, explicit scrolls, and
    // follow changes, each followed by a frame.
    for (0..24) |seed| {
        errdefer std.debug.print("sticky seed {d}\n", .{seed});
        var prng = std.Random.DefaultPrng.init(seed);
        const random = prng.random();
        const horizontal = seed % 4 == 3;
        var sticky = try Sticky.init(if (horizontal) c.OT_SCENE_SCROLL_FOLLOW_RIGHT else B, horizontal);
        defer sticky.deinit();
        for (0..48) |_| try sticky.apply(switch (random.uintLessThan(u32, 7)) {
            6 => .{ .ask = .{ .to = @floatFromInt(random.intRangeAtMost(i32, -2, 24)), .by = random.boolean(), .rows = random.uintLessThan(u32, 26) } },
            0, 1 => .{ .rows = random.uintLessThan(u32, 26) },
            2 => .{ .size = @floatFromInt(random.intRangeAtMost(u32, 3, 15)) },
            3 => .{ .to = @floatFromInt(random.intRangeAtMost(i32, -2, 24)) },
            4 => if (random.boolean()) .{ .by = @as(f64, @floatFromInt(random.intRangeAtMost(i32, -6, 6))) / 2 } else .{ .other = @floatFromInt(random.intRangeAtMost(u32, 1, 4)) },
            else => .{ .follow = switch (random.uintLessThan(u32, 3)) {
                0 => c.OT_SCENE_SCROLL_FOLLOW_NONE,
                1 => if (horizontal) c.OT_SCENE_SCROLL_FOLLOW_LEFT else c.OT_SCENE_SCROLL_FOLLOW_TOP,
                else => if (horizontal) c.OT_SCENE_SCROLL_FOLLOW_RIGHT else B,
            } },
        });
    }
}

test "Scene scroll node keeps huge layouts within whole cells" {
    var sticky = try Sticky.init(c.OT_SCENE_SCROLL_FOLLOW_BOTTOM, false);
    defer sticky.deinit();
    try sticky.apply(.{ .rows = 1 });
    try style(sticky.f, sticky.rows.items[0], c.OT_STYLE_DIMENSION, 1, 0, c.OT_UNIT_POINT, 1e30, 1);
    try present(sticky.f);
    const state = try sticky.f.owner.sceneGetScroll(sticky.box);
    try testing.expectEqual(@as(f64, std.math.maxInt(i32)), state.max[1]);
    try testing.expectEqual(state.max[1], state.offset[1]);
}

fn char(f: Fixture, x: u32, y: u32) u32 {
    return f.cli.currentRenderBuffer.get(x, y).?.char;
}

test "Scene scroll node paints fills under its children and bars over them, and reports changes once" {
    for ([_]bool{ false, true }) |overlay| {
        const f = try Fixture.init(testing.allocator, 6, 4, .{});
        defer f.deinit();
        const box = try create(f, f.root, c.OT_SCENE_BOX, 2);
        for (0..2) |kind| try style(f, box, c.OT_STYLE_DIMENSION, @intCast(kind), 0, c.OT_UNIT_POINT, @floatFromInt(6 - 2 * kind), 1);
        const fill = ansi.rgbColor(0, 0, 90, 255);
        try f.owner.sceneSetDebugFlags(f.id, c.OT_SCENE_DEBUG_VERIFY);
        try f.owner.sceneSetScroll(box, .{ .fills = .{ null, fill, null }, .bars = .{ .{}, .{ .arrows = true, .overlay = overlay, .gap = 1 } } });
        try f.owner.sceneSetScrollArrow(box, 1, 0, .{ .text = "^" });
        try f.owner.sceneSetScrollArrow(box, 1, 1, .{ .foreground = ansi.rgbColor(255, 0, 0, 255), .text = "v" });
        var rows: [10]context.Handle = undefined;
        for (&rows, 0..) |*row, index| {
            row.* = try create(f, box, c.OT_SCENE_TEXT, @intCast(10 + index));
            var bytes: [8]u8 = undefined;
            try f.owner.sceneSetText(row.*, try std.fmt.bufPrint(&bytes, "r{d}xxxx", .{index}));
            try f.owner.sceneSetTextOptions(row.*, .{ .wrap_mode = .none });
        }
        // A row wider than the viewport.
        try style(f, rows[3], c.OT_STYLE_DIMENSION, 0, 0, c.OT_UNIT_POINT, 6, 1);
        try f.owner.sceneSetHooks(box, c.OT_SCENE_HOOK_SCROLL, 1, 0, 0);
        // The first frame reports the new extent; a scroll in the reply paints in the same frame.
        var request = try f.step(null, frame_options, c.OT_SCENE_FRAME_SCROLL, box);
        try testing.expectEqual(@as(f64, 6), (try f.owner.sceneScrollTo(box, .{ 0, 3 }, .{ false, false }, false)).max[1]);
        request = try f.step(request, frame_options, c.OT_SCENE_FRAME_DONE, null);
        try commit(f);
        try testing.expectEqual(@as(u32, '3'), char(f, 1, 0));
        // An inset bar takes a gutter that clips the rows, an overlay bar covers their last
        // column; both paint their arrows at the track ends, and their cells hit the box.
        try testing.expectEqual(@as(f64, if (overlay) 6 else 4), (try f.owner.sceneGetScroll(box)).viewport[2]);
        try testing.expectEqual(@as(u32, '^'), char(f, 5, 0));
        try testing.expectEqual(@as(u32, 'v'), char(f, 5, 3));
        try testing.expectEqual(@as(u32, if (overlay) 'x' else ' '), char(f, 4, 0));
        try testing.expectEqual(@as(u32, 2), try f.owner.sceneHitTest(f.id, 5, 1));
        try testing.expectEqual(@as(u32, 13), try f.owner.sceneHitTest(f.id, 0, 0));
        const thumb = char(f, 5, 1);
        // An unchanged frame asks nothing; a read changes nothing it reports.
        _ = try f.step(null, frame_options, c.OT_SCENE_FRAME_DONE, null);
        try commit(f);
        // A scroll in a reply before the node's SCROLL step marks only the offset reported.
        try f.owner.sceneDestroyNode(rows[9]);
        _ = try f.owner.sceneGetScroll(box);
        try f.owner.sceneSetHooks(box, c.OT_SCENE_HOOK_SCROLL | c.OT_SCENE_HOOK_UPDATE, 2, 0, 0);
        const update = try f.step(null, frame_options, c.OT_SCENE_FRAME_UPDATE, box);
        _ = try f.owner.sceneScrollTo(box, .{ 0, 0 }, .{ true, true }, false);
        _ = try f.step(try f.step(update, frame_options, c.OT_SCENE_FRAME_SCROLL, box), frame_options, c.OT_SCENE_FRAME_DONE, null);
        try commit(f);
        try f.owner.sceneSetHooks(box, c.OT_SCENE_HOOK_SCROLL, 3, 0, 0);
        try testing.expectEqual(@as(u32, '3'), char(f, 1, 0));
        _ = try f.owner.sceneScrollTo(box, .{ 0, 0 }, .{ false, false }, false);
        _ = try f.step(null, frame_options, c.OT_SCENE_FRAME_DONE, null);
        try commit(f);
        try testing.expect(thumb != char(f, 5, 1));
        // The viewport fill shows beside a short row; the rows below it are unchanged.
        try f.owner.sceneSetText(rows[0], "r");
        _ = try f.step(null, frame_options, c.OT_SCENE_FRAME_DONE, null);
        try commit(f);
        try testing.expectEqual(fill, f.cli.currentRenderBuffer.get(2, 0).?.bg);
        try testing.expectEqual(@as(u32, '3'), char(f, 1, 3));
        // Without the hook nothing is reported; turning it on again starts from the current state,
        // and the next request names what changed.
        try f.owner.sceneSetHooks(box, 0, 4, 0, 0);
        try f.owner.sceneDestroyNode(rows[8]);
        _ = try f.step(null, frame_options, c.OT_SCENE_FRAME_DONE, null);
        try commit(f);
        try f.owner.sceneSetHooks(box, c.OT_SCENE_HOOK_SCROLL, 5, 0, 0);
        _ = try f.step(null, frame_options, c.OT_SCENE_FRAME_DONE, null);
        try commit(f);
        try f.owner.sceneDestroyNode(rows[7]);
        _ = try f.step(try f.step(null, frame_options, c.OT_SCENE_FRAME_SCROLL, box), frame_options, c.OT_SCENE_FRAME_DONE, null);
        try commit(f);
        try testing.expectEqual(@as(u32, c.OT_SCENE_SCROLL_CHANGED_CONTENT), (try f.owner.sceneGetScroll(box)).changes);
        _ = try f.owner.sceneScrollTo(box, .{ 0, 1 }, .{ false, false }, false);
        try f.owner.sceneSetStyle(box, c.OT_STYLE_DIMENSION, 1, 0, c.OT_UNIT_POINT, 3, 0);
        _ = try f.step(try f.step(null, frame_options, c.OT_SCENE_FRAME_SCROLL, box), frame_options, c.OT_SCENE_FRAME_DONE, null);
        try commit(f);
        try testing.expect((try f.owner.sceneGetScroll(box)).changes & c.OT_SCENE_SCROLL_CHANGED_VIEWPORT != 0);
    }
}

test "Scene scroll node repaints the rows its viewport fill paints past its box" {
    // 357: viewport padding makes the viewport 2 rows in a 1-row box, so the fill covers the
    // box below it, or, with the box moved off the screen, the row that the box leaves.
    for ([_]i32{ 0, -1 }) |shift| {
        const f = try Fixture.init(testing.allocator, 6, 4, .{});
        defer f.deinit();
        try f.owner.sceneSetDebugFlags(f.id, c.OT_SCENE_DEBUG_VERIFY);
        const box = try create(f, f.root, c.OT_SCENE_BOX, 2);
        const below = try create(f, f.root, c.OT_SCENE_BOX, 3);
        for ([_]context.Handle{ box, below }) |node| for (0..2) |kind| try style(f, node, c.OT_STYLE_DIMENSION, @intCast(kind), 0, c.OT_UNIT_POINT, @floatFromInt(6 - 5 * kind), 1);
        try f.owner.scenePatchPaint(box, c.OT_SCENE_PROPERTY_Z_INDEX | c.OT_SCENE_PROPERTY_TRANSLATE_Y, .{ .zIndex = 1, .translateY = @floatFromInt(shift) });
        try f.owner.sceneSetPaint(below, .{ .background = ansi.rgbColor(220, 0, 0, 255) });
        const never: scene.ScrollBarOptions = .{ .policy = c.OT_SCENE_SCROLL_BAR_NEVER };
        // Then only the fill changes, then only the box under the fill.
        for ([_]?ansi.RGBA{ ansi.rgbColor(40, 0, 222, 255), ansi.rgbColor(0, 90, 0, 255), null }) |next| {
            if (next) |color| try f.owner.sceneSetScroll(box, .{ .padding = .{ 0, 1, 0, 1 }, .fills = .{ null, color, null }, .bars = .{ never, never } });
            if (next == null) try f.owner.scenePatchPaint(below, c.OT_SCENE_PROPERTY_BACKGROUND, .{ .background = ansi.rgbColor(0, 0, 220, 255) });
            try present(f);
            try testing.expectEqual(@as(f64, 2), (try f.owner.sceneGetScroll(box)).viewport[3]);
            const fill = (try f.owner.raw().getRenderable(box)).scene_node.?.scroll.?.options.fills[1].?;
            for (0..@intCast(2 + shift)) |y| for (0..6) |x| try testing.expectEqual(fill, f.cli.currentRenderBuffer.get(@intCast(x), @intCast(y)).?.bg);
        }
    }
}

test "Scene scroll node range excludes viewport padding, and a scroll in a later reply reveals culled rows" {
    // 321: with vertical viewport padding the last row reaches the padding's edge.
    const f = try Fixture.init(testing.allocator, 10, 10, .{});
    defer f.deinit();
    const box = try create(f, f.root, c.OT_SCENE_BOX, 2);
    for (0..2) |kind| try style(f, box, c.OT_STYLE_DIMENSION, @intCast(kind), 0, c.OT_UNIT_POINT, 10, 1);
    try f.owner.sceneSetScroll(box, .{ .culling = true, .padding = .{ 0, 2, 0, 1 } });
    var rows: [20]context.Handle = undefined;
    for (&rows, 0..) |*row, index| {
        row.* = try create(f, box, c.OT_SCENE_BOX, @intCast(10 + index));
        for (0..2) |kind| try style(f, row.*, c.OT_STYLE_DIMENSION, @intCast(kind), 0, c.OT_UNIT_POINT, 1, 1);
    }
    try present(f);
    _ = try f.owner.sceneScrollTo(box, .{ 0, std.math.inf(f64) }, .{ false, false }, false);
    try present(f);
    try testing.expectEqual(@as(f64, 13), (try f.owner.sceneGetScroll(box)).max[1]);
    try testing.expectEqual(@as(f64, 8), (try f.owner.sceneGetLayout(rows[19], false)).screenY);
    // A row with an UPDATE hook below the viewport is culled. A later sibling's reply scrolls
    // after the box selected its rows; the row is revealed and updates before the frame paints.
    _ = try f.owner.sceneScrollTo(box, .{ 0, 0 }, .{ false, false }, false);
    const later = try create(f, f.root, c.OT_SCENE_BOX, 40);
    try f.owner.sceneSetHooks(rows[15], c.OT_SCENE_HOOK_UPDATE, 1, 1, 1);
    try f.owner.sceneSetHooks(later, c.OT_SCENE_HOOK_UPDATE, 1, 0, 0);
    const request = try f.step(null, frame_options, c.OT_SCENE_FRAME_UPDATE, later);
    _ = try f.owner.sceneScrollTo(box, .{ 0, 10 }, .{ false, false }, false);
    _ = try f.step(try f.step(request, frame_options, c.OT_SCENE_FRAME_UPDATE, rows[15]), frame_options, c.OT_SCENE_FRAME_DONE, null);
    try commit(f);
}

test "Scene scroll node repaints its thumb on rows that no child crosses" {
    const f = try Fixture.init(testing.allocator, 4, 4, .{});
    defer f.deinit();
    try f.owner.sceneSetDebugFlags(f.id, c.OT_SCENE_DEBUG_VERIFY);
    const box = try create(f, f.root, c.OT_SCENE_BOX, 2);
    for (0..2) |kind| try style(f, box, c.OT_STYLE_DIMENSION, @intCast(kind), 0, c.OT_UNIT_POINT, 4, 1);
    try f.owner.sceneSetScroll(box, .{});
    try style(f, box, c.OT_STYLE_VALUE, c.OT_STYLE_VALUE_PADDING, c.OT_EDGE_BOTTOM, c.OT_UNIT_POINT, 9, c.OT_STYLE_CONTENT);
    const row = try create(f, box, c.OT_SCENE_TEXT, 3);
    try f.owner.sceneSetText(row, "r");
    try present(f);
    const before = char(f, 3, 1);
    _ = try f.owner.sceneScrollTo(box, .{ 0, 1 }, .{ false, false }, false);
    try present(f);
    try testing.expect(before != char(f, 3, 1));
    // A move of the box changes the reported screen geometry, and so the generation.
    const moved = try f.owner.sceneGetScroll(box);
    try f.owner.scenePatchPaint(box, c.OT_SCENE_PROPERTY_TRANSLATE_X, .{ .translateX = 1 });
    try present(f);
    const state = try f.owner.sceneGetScroll(box);
    try testing.expectEqual(moved.viewport[0] + 1, state.viewport[0]);
    try testing.expect(moved.generation != state.generation);
    // A bar policy switched back to auto follows the range in the next frame, both ways.
    for ([_]u32{ c.OT_SCENE_SCROLL_BAR_NEVER, c.OT_SCENE_SCROLL_BAR_ALWAYS }) |policy| {
        try style(f, box, c.OT_STYLE_VALUE, c.OT_STYLE_VALUE_PADDING, c.OT_EDGE_BOTTOM, c.OT_UNIT_POINT, if (policy == c.OT_SCENE_SCROLL_BAR_NEVER) 9 else 0, c.OT_STYLE_CONTENT);
        try f.owner.sceneSetScroll(box, .{ .bars = .{ .{}, .{ .policy = policy } } });
        try present(f);
        try f.owner.sceneSetScroll(box, .{});
        try present(f);
        try testing.expectEqual(policy == c.OT_SCENE_SCROLL_BAR_NEVER, (try f.owner.sceneGetScroll(box)).bars[1].visible != 0);
    }
}

/// A 10x4 scroll node with `count` rows of one cell, the first numbered 10.
fn rowBox(f: Fixture, follow: u32, rows: []context.Handle) !context.Handle {
    const box = try create(f, f.root, c.OT_SCENE_BOX, 2);
    try style(f, box, c.OT_STYLE_DIMENSION, 0, 0, c.OT_UNIT_POINT, 10, 1);
    try style(f, box, c.OT_STYLE_DIMENSION, 1, 0, c.OT_UNIT_POINT, 4, 1);
    try f.owner.sceneSetScroll(box, .{ .follow = follow, .bars = .{ .{}, .{ .policy = c.OT_SCENE_SCROLL_BAR_NEVER } } });
    for (rows, 0..) |*row, index| row.* = try oneCell(f, box, @intCast(10 + index), index);
    return box;
}

fn oneCell(f: Fixture, parent: context.Handle, num: u32, index: usize) !context.Handle {
    const row = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_BOX, num);
    try f.owner.sceneMoveNode(row, parent, @intCast(index));
    for (0..2) |kind| try style(f, row, c.OT_STYLE_DIMENSION, @intCast(kind), 0, c.OT_UNIT_POINT, 1, 1);
    return row;
}

/// Prepends `count` rows numbered from `num`.
fn prepend(f: Fixture, box: context.Handle, num: u32, count: u32) !void {
    for (0..count) |index| _ = try oneCell(f, box, num + @as(u32, @intCast(index)), 0);
}

fn line(f: Fixture, row: context.Handle) !f64 {
    return (try f.owner.sceneGetLayout(row, false)).screenY;
}

fn offset(f: Fixture, box: context.Handle) !f64 {
    return (try f.owner.sceneGetScroll(box)).offset[1];
}

test "Scene scroll requests resolve against the layout of the next frame" {
    const f = try Fixture.init(testing.allocator, 12, 6, .{});
    defer f.deinit();
    var rows: [20]context.Handle = undefined;
    const box = try rowBox(f, c.OT_SCENE_SCROLL_FOLLOW_NONE, &rows);
    // A target set before the first layout lands after it, and a delta adds to it.
    _ = try f.owner.sceneScrollTo(box, .{ 0, 5 }, .{ false, false }, true);
    _ = try f.owner.sceneScrollTo(box, .{ 0, 3 }, .{ true, true }, true);
    try present(f);
    try testing.expectEqual(@as(f64, 8), try offset(f, box));
    // INTO_VIEW scrolls at once and again after the frame's layout: rows prepended in the
    // same frame keep the target at the inset edge (START), the far edge (END), or the
    // nearest edge (NEAREST, from below and from above), and a visible row stays.
    const cases = [_]struct { alignment: u32, inset: u32, row: usize, now: f64, line: f64 }{
        .{ .alignment = c.OT_SCENE_SCROLL_ALIGN_START, .inset = 1, .row = 12, .now = 11, .line = 1 },
        .{ .alignment = c.OT_SCENE_SCROLL_ALIGN_END, .inset = 0, .row = 12, .now = 11, .line = 3 },
        .{ .alignment = c.OT_SCENE_SCROLL_ALIGN_NEAREST, .inset = 0, .row = 19, .now = 20, .line = 3 },
        // Visible, but not inside the inset: after the prepend it is below the inset edge.
        .{ .alignment = c.OT_SCENE_SCROLL_ALIGN_NEAREST, .inset = 1, .row = 0, .now = 5, .line = 2 },
        .{ .alignment = c.OT_SCENE_SCROLL_ALIGN_NEAREST, .inset = 0, .row = 1, .now = 6, .line = 3 },
    };
    var num: u32 = 100;
    for (cases, 0..) |case, index| {
        errdefer std.debug.print("into view case {d}\n", .{index});
        const state = try f.owner.sceneScrollRequest(box, c.OT_SCENE_SCROLL_REQUEST_INTO_VIEW, rows[case.row], case.alignment, case.inset);
        try testing.expectEqual(case.now, state.offset[1]);
        try prepend(f, box, num, 2);
        num += 2;
        try present(f);
        try testing.expectEqual(case.line, try line(f, rows[case.row]));
    }
    // The request lasts one frame: a later prepend moves the row.
    try prepend(f, box, num, 1);
    num += 1;
    try present(f);
    try testing.expectEqual(@as(f64, 4), try line(f, rows[1]));
    // A row destroyed before the frame leaves the offset the request set.
    _ = try f.owner.sceneScrollRequest(box, c.OT_SCENE_SCROLL_REQUEST_INTO_VIEW, rows[2], c.OT_SCENE_SCROLL_ALIGN_START, 0);
    try f.owner.sceneDestroyNode(rows[2]);
    try present(f);
    try testing.expectEqual(@as(f64, 13), try offset(f, box));

    // An anchored row keeps its line through prepends and through growth of a row above it,
    // an explicit scroll moves the line it holds, and the limits clamp it.
    _ = try f.owner.sceneScrollTo(box, .{ 0, 20 }, .{ false, false }, false);
    try present(f);
    _ = try f.owner.sceneScrollRequest(box, c.OT_SCENE_SCROLL_REQUEST_ANCHOR, rows[10], 0, 0);
    const held = try line(f, rows[10]);
    try prepend(f, box, num, 3);
    num += 3;
    try style(f, rows[0], c.OT_STYLE_DIMENSION, 1, 0, c.OT_UNIT_POINT, 3, 1);
    try present(f);
    try testing.expectEqual(held, try line(f, rows[10]));
    try testing.expectEqual(@as(f64, 25), try offset(f, box));
    _ = try f.owner.sceneScrollTo(box, .{ 0, -1 }, .{ true, true }, false);
    try prepend(f, box, num, 1);
    num += 1;
    try present(f);
    try testing.expectEqual(held + 1, try line(f, rows[10]));
    _ = try f.owner.sceneScrollTo(box, .{ 0, 0 }, .{ false, false }, false);
    try present(f);
    try f.owner.sceneDestroyNode(rows[0]);
    try present(f);
    try testing.expectEqual(@as(f64, 0), try offset(f, box));
    // Released, or with its row moved out of the box, a prepend moves the view's rows again.
    _ = try f.owner.sceneScrollTo(box, .{ 0, 10 }, .{ false, false }, false);
    try present(f);
    _ = try f.owner.sceneScrollRequest(box, c.OT_SCENE_SCROLL_REQUEST_ANCHOR, null, 0, 0);
    try prepend(f, box, num, 1);
    num += 1;
    try present(f);
    try testing.expectEqual(@as(f64, 10), try offset(f, box));
    _ = try f.owner.sceneScrollRequest(box, c.OT_SCENE_SCROLL_REQUEST_ANCHOR, rows[12], 0, 0);
    try f.owner.sceneMoveNode(rows[12], f.root, 0);
    try prepend(f, box, num, 1);
    try present(f);
    try testing.expectEqual(@as(f64, 10), try offset(f, box));
}

test "Scene scroll anchor wins over sticky follow, inside nested boxes too" {
    const f = try Fixture.init(testing.allocator, 12, 6, .{});
    defer f.deinit();
    var rows: [20]context.Handle = undefined;
    const box = try rowBox(f, c.OT_SCENE_SCROLL_FOLLOW_BOTTOM, &rows);
    // A node inside a nested scroll node (viewport padding 1 above) in row 17.
    const outer = try oneCell(f, rows[17], 60, 0);
    try f.owner.sceneSetScroll(outer, .{ .padding = .{ 0, 1, 0, 0 } });
    const inner = try oneCell(f, outer, 61, 0);
    _ = try oneCell(f, outer, 62, 1);
    try style(f, rows[17], c.OT_STYLE_DIMENSION, 1, 0, c.OT_UNIT_POINT, 2, 1);
    try style(f, outer, c.OT_STYLE_DIMENSION, 1, 0, c.OT_UNIT_POINT, 2, 1);
    try present(f);
    try testing.expectEqual(@as(f64, 17), try offset(f, box));
    // Revealing the last row from the bottom leaves the view stuck, so it follows an append.
    _ = try f.owner.sceneScrollRequest(box, c.OT_SCENE_SCROLL_REQUEST_INTO_VIEW, rows[19], c.OT_SCENE_SCROLL_ALIGN_NEAREST, 0);
    _ = try oneCell(f, box, 90, 20);
    try present(f);
    try testing.expectEqual(@as(f64, 18), try offset(f, box));
    _ = try f.owner.sceneScrollRequest(box, c.OT_SCENE_SCROLL_REQUEST_ANCHOR, inner, 0, 0);
    const held = try line(f, inner);
    // Rows above and below it, and the nested node's own scroll, move it in the content.
    _ = try oneCell(f, box, 70, 21);
    try prepend(f, box, 80, 2);
    _ = try f.owner.sceneScrollTo(outer, .{ 0, 1 }, .{ false, false }, false);
    try present(f);
    try testing.expectEqual(held, try line(f, inner));
    const state = try f.owner.sceneGetScroll(box);
    try testing.expectEqual(@as(f64, 19), state.offset[1]);
    try testing.expectEqual(@as(u32, 0), state.stuck);
    // Released, the view stays where the anchor left it.
    _ = try f.owner.sceneScrollRequest(box, c.OT_SCENE_SCROLL_REQUEST_ANCHOR, null, 0, 0);
    _ = try oneCell(f, box, 71, 24);
    try present(f);
    try testing.expectEqual(@as(f64, 19), try offset(f, box));
}

test "Scene scroll LAYOUT request arrives once the frame's layout settles, before paint" {
    const f = try Fixture.init(testing.allocator, 12, 6, .{});
    defer f.deinit();
    var rows: [20]context.Handle = undefined;
    const box = try rowBox(f, c.OT_SCENE_SCROLL_FOLLOW_NONE, &rows);
    try present(f);
    // Without the SCROLL hook the request waits.
    _ = try f.owner.sceneScrollRequest(box, c.OT_SCENE_SCROLL_REQUEST_LAYOUT, null, 0, 0);
    try present(f);
    try f.owner.sceneSetHooks(box, c.OT_SCENE_HOOK_SCROLL, 1, 0, 0);
    // A row added before the frame is laid out when the request arrives; a scroll in the
    // reply paints in this frame, and a request made in the reply waits for the next frame.
    // The size change comes first, in its own request.
    const added = try oneCell(f, box, 40, 0);
    var request = try f.step(null, frame_options, c.OT_SCENE_FRAME_SCROLL, box);
    try testing.expectEqual(@as(u32, c.OT_SCENE_SCROLL_CHANGED_CONTENT), (try f.owner.sceneGetScroll(box)).changes);
    request = try f.step(request, frame_options, c.OT_SCENE_FRAME_SCROLL, box);
    var state = try f.owner.sceneGetScroll(box);
    try testing.expectEqual(@as(u32, c.OT_SCENE_SCROLL_CHANGED_LAYOUT), state.changes);
    try testing.expectEqual(@as(f64, 21), state.content[3]);
    _ = try f.owner.sceneScrollRequest(box, c.OT_SCENE_SCROLL_REQUEST_INTO_VIEW, added, c.OT_SCENE_SCROLL_ALIGN_START, 0);
    _ = try f.owner.sceneScrollRequest(box, c.OT_SCENE_SCROLL_REQUEST_LAYOUT, null, 0, 0);
    _ = try f.step(request, frame_options, c.OT_SCENE_FRAME_DONE, null);
    try commit(f);
    try testing.expectEqual(@as(f64, 0), try line(f, added));
    _ = try f.step(try f.step(null, frame_options, c.OT_SCENE_FRAME_SCROLL, box), frame_options, c.OT_SCENE_FRAME_DONE, null);
    try commit(f);
    state = try f.owner.sceneGetScroll(box);
    try testing.expectEqual(@as(u32, c.OT_SCENE_SCROLL_CHANGED_LAYOUT), state.changes);
    // A pending request goes with its node.
    _ = try f.owner.sceneScrollRequest(box, c.OT_SCENE_SCROLL_REQUEST_LAYOUT, null, 0, 0);
    try f.owner.sceneDestroyNode(box);
    try testing.expectEqual(@as(u32, 0), f.state.layout_callbacks);
}

test "Scene scroll requests in an outer box see a nested scroll's move in the same solve" {
    const f = try Fixture.init(testing.allocator, 24, 12, .{});
    defer f.deinit();
    // An outer 20x5 box: two rows, a sticky-bottom inner 20x3 box with 10 rows, then 8 rows.
    const outer = try create(f, f.root, c.OT_SCENE_BOX, 2);
    try style(f, outer, c.OT_STYLE_DIMENSION, 0, 0, c.OT_UNIT_POINT, 20, 1);
    try style(f, outer, c.OT_STYLE_DIMENSION, 1, 0, c.OT_UNIT_POINT, 5, 1);
    const never = [2]scene.ScrollBarOptions{ .{}, .{ .policy = c.OT_SCENE_SCROLL_BAR_NEVER } };
    try f.owner.sceneSetScroll(outer, .{ .bars = never });
    for (0..2) |index| _ = try oneCell(f, outer, @intCast(10 + index), index);
    const inner = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_BOX, 3);
    try f.owner.sceneMoveNode(inner, outer, 2);
    try style(f, inner, c.OT_STYLE_DIMENSION, 1, 0, c.OT_UNIT_POINT, 3, 1);
    try style(f, inner, c.OT_STYLE_DIMENSION, 0, 0, c.OT_UNIT_POINT, 20, 1);
    try f.owner.sceneSetScroll(inner, .{ .follow = c.OT_SCENE_SCROLL_FOLLOW_BOTTOM, .bars = never });
    var rows: [10]context.Handle = undefined;
    for (&rows, 0..) |*row, index| row.* = try oneCell(f, inner, @intCast(20 + index), index);
    for (0..8) |index| _ = try oneCell(f, outer, @intCast(40 + index), 3 + index);
    try present(f);
    _ = try f.owner.sceneScrollTo(outer, .{ 0, 2 }, .{ false, false }, false);
    try present(f);
    // The inner box follows an append in the solve that also resolves the outer anchor.
    _ = try f.owner.sceneScrollRequest(outer, c.OT_SCENE_SCROLL_REQUEST_ANCHOR, rows[8], 0, 0);
    const held = try line(f, rows[8]);
    _ = try oneCell(f, inner, 30, 10);
    try present(f);
    try testing.expectEqual(held, try line(f, rows[8]));
    try testing.expectEqual(@as(f64, 1), try offset(f, outer));
    try present(f);
    try testing.expectEqual(held, try line(f, rows[8]));
    // So does a reveal: row 9 at the outer top after the inner box follows another append.
    _ = try f.owner.sceneScrollRequest(outer, c.OT_SCENE_SCROLL_REQUEST_ANCHOR, null, 0, 0);
    _ = try f.owner.sceneScrollRequest(outer, c.OT_SCENE_SCROLL_REQUEST_INTO_VIEW, rows[9], c.OT_SCENE_SCROLL_ALIGN_START, 0);
    _ = try oneCell(f, inner, 31, 11);
    try present(f);
    try testing.expectEqual((try f.owner.sceneGetLayout(outer, false)).screenY, try line(f, rows[9]));
}

test "Scene scroll requests survive a cancelled frame and a failed delivery" {
    const f = try Fixture.init(testing.allocator, 12, 6, .{});
    defer f.deinit();
    var rows: [20]context.Handle = undefined;
    const box = try rowBox(f, c.OT_SCENE_SCROLL_FOLLOW_NONE, &rows);
    try present(f);
    try f.owner.sceneSetHooks(box, c.OT_SCENE_HOOK_SCROLL, 1, 0, 0);
    // A target set in a reply after the frame's solve, then a cancel: the next frame applies it.
    _ = try oneCell(f, box, 40, 20);
    var request = try f.step(null, frame_options, c.OT_SCENE_FRAME_SCROLL, box);
    try testing.expectEqual(@as(f64, 17), (try f.owner.sceneScrollTo(box, .{ 0, 100 }, .{ false, false }, true)).offset[1]);
    try f.owner.sceneFrameCancel(f.id, request.frame_id);
    try f.owner.sceneSetHooks(box, 0, 2, 0, 0);
    for (0..10) |index| _ = try oneCell(f, box, @intCast(50 + index), 21 + index);
    try present(f);
    try testing.expectEqual(@as(f64, 27), try offset(f, box));
    // A reveal applied by a solve whose frame is then cancelled applies again in the next frame.
    try f.owner.sceneSetHooks(box, c.OT_SCENE_HOOK_SCROLL, 3, 0, 0);
    _ = try f.owner.sceneScrollRequest(box, c.OT_SCENE_SCROLL_REQUEST_INTO_VIEW, rows[10], c.OT_SCENE_SCROLL_ALIGN_START, 0);
    try prepend(f, box, 70, 1);
    request = try f.step(null, frame_options, c.OT_SCENE_FRAME_SCROLL, box);
    try testing.expectEqual(@as(f64, 11), try offset(f, box));
    try f.owner.sceneFrameCancel(f.id, request.frame_id);
    try f.owner.sceneSetHooks(box, 0, 4, 0, 0);
    try prepend(f, box, 71, 1);
    try present(f);
    try testing.expectEqual(@as(f64, 12), try offset(f, box));
    // A LAYOUT request that the request limit stops stays pending for the next frame.
    try f.owner.sceneSetHooks(box, c.OT_SCENE_HOOK_SCROLL, 5, 0, 0);
    _ = try f.owner.sceneScrollRequest(box, c.OT_SCENE_SCROLL_REQUEST_LAYOUT, null, 0, 0);
    _ = try oneCell(f, box, 72, 0);
    var limited = frame_options;
    limited.max_host_requests = 1;
    request = try f.step(null, limited, c.OT_SCENE_FRAME_SCROLL, box);
    try testing.expectError(error.FrameRequestLimit, f.owner.sceneFrameStep(f.id, request, limited));
    try testing.expectEqual(@as(u32, 1), f.state.layout_callbacks);
    _ = try f.step(try f.step(null, frame_options, c.OT_SCENE_FRAME_SCROLL, box), frame_options, c.OT_SCENE_FRAME_DONE, null);
    try commit(f);
    try testing.expectEqual(@as(u32, c.OT_SCENE_SCROLL_CHANGED_LAYOUT), (try f.owner.sceneGetScroll(box)).changes);
}

test "Scene scroll anchor ends at a scroll to the end, and waits for an unplaced node's layout" {
    const f = try Fixture.init(testing.allocator, 12, 6, .{});
    defer f.deinit();
    var rows: [20]context.Handle = undefined;
    const box = try rowBox(f, c.OT_SCENE_SCROLL_FOLLOW_BOTTOM, &rows);
    try present(f);
    // The end while an anchor is held reaches the end and follows it.
    _ = try f.owner.sceneScrollRequest(box, c.OT_SCENE_SCROLL_REQUEST_ANCHOR, rows[12], 0, 0);
    _ = try f.owner.sceneScrollTo(box, .{ 0, std.math.inf(f64) }, .{ false, false }, true);
    for (0..5) |index| _ = try oneCell(f, box, @intCast(40 + index), 20 + index);
    try present(f);
    try testing.expectEqual(@as(f64, 21), try offset(f, box));
    _ = try oneCell(f, box, 50, 25);
    try present(f);
    try testing.expectEqual(@as(f64, 22), try offset(f, box));
    // A row anchored before its first layout keeps the view where it is.
    _ = try f.owner.sceneScrollTo(box, .{ 0, 10 }, .{ false, false }, false);
    try present(f);
    const added = try oneCell(f, box, 60, 26);
    _ = try f.owner.sceneScrollRequest(box, c.OT_SCENE_SCROLL_REQUEST_ANCHOR, added, 0, 0);
    try testing.expectEqual(@as(f64, 10), try offset(f, box));
    try present(f);
    try testing.expectEqual(@as(f64, 10), try offset(f, box));
    try prepend(f, box, 70, 2);
    try present(f);
    try testing.expectEqual(@as(f64, 12), try offset(f, box));
}
