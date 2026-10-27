//! Native scene frames: preparation, paint, encode, and presentation, timed and counted.
//! The scenes are investigation 61's (§1.2). `tests/scene_frame_test.zig` pins their work
//! counts at small sizes; this bench reports time next to the same counts at full size.
const std = @import("std");
const c = @import("context_abi_c");
const bench_utils = @import("../bench-utils.zig");
const context = @import("../context.zig");
const scene = @import("../scene.zig");
const renderer = @import("../renderer.zig");

pub const benchName = "Scene Frame";

const options: scene.FrameOptions = .{
    .background = .{ 0, 0, 0, 255 },
    .use_mouse = true,
    .excluded_hit_num = 0,
    .max_layout_rounds = 8,
    .max_host_requests = 1 << 20,
};

pub const Shape = enum { ui, boxes, scroll, wrapped_scroll, scroll_node };

/// A frame kind: what changes before the frame.
pub const Change = enum { unchanged, glyph, background, scroll, append, update_hook, paint_hook, reply_text };

/// One Session with a built scene and the nodes its frame kinds change.
pub const Scene = struct {
    owner: *context.Context,
    id: context.Handle,
    root: context.Handle,
    /// The node whose glyph, background, or hook changes.
    target: context.Handle,
    /// The scroll content, the scroll node, or the root.
    content: context.Handle,
    scroll_node: bool = false,
    next_num: u32,
    frames: u32 = 0,

    pub fn init(allocator: std.mem.Allocator, io: std.Io, shape: Shape, size: u32) !Scene {
        const width: u32 = if (shape == .boxes) 140 else 200;
        const height: u32 = if (shape == .boxes) 44 else 50;
        const owner = try context.Context.init(allocator, io, .{ .object_capacity = 4 * size + 1024 });
        errdefer owner.deinit() catch unreachable;
        const id = try owner.createSession(.{ .chunk_size = 64 * 1024, .chunk_count = 16, .span_capacity = 16 });
        try owner.attachSessionRenderer(id, width, height, .{ .remote_mode = .remote });
        const root = try owner.sceneCreateNode(id, c.OT_SCENE_ROOT, 1);
        var self: Scene = .{ .owner = owner, .id = id, .root = root, .target = root, .content = root, .next_num = 2 };
        switch (shape) {
            .ui => try self.buildUi(),
            .boxes => try self.buildBoxes(size),
            .scroll => try self.buildScroll(size, 0, 0),
            .wrapped_scroll => try self.buildScroll(size, 6, 2),
            .scroll_node => try self.buildScrollNode(size),
        }
        // The first frame lays out and paints everything; frame kinds measure the next ones.
        _ = try self.frame(.unchanged);
        return self;
    }

    pub fn deinit(self: *Scene) void {
        self.owner.deinit() catch unreachable;
    }

    fn node(self: *Scene, kind: u32, parent: context.Handle) !context.Handle {
        const created = try self.owner.sceneCreateNode(self.id, kind, self.next_num);
        self.next_num += 1;
        const count = (try self.owner.raw().getRenderable(parent)).scene_node.?.children.items.len;
        try self.owner.sceneMoveNode(created, parent, @intCast(count));
        return created;
    }

    fn text(self: *Scene, parent: context.Handle, bytes: []const u8) !context.Handle {
        const created = try self.node(c.OT_SCENE_TEXT, parent);
        try self.owner.sceneSetText(created, bytes);
        return created;
    }

    fn dimension(self: *Scene, target: context.Handle, kind: u32, value: f32) !void {
        try self.owner.sceneSetStyle(target, c.OT_STYLE_DIMENSION, kind, 0, c.OT_UNIT_POINT, value, 1);
    }

    fn float(self: *Scene, target: context.Handle, kind: u32, value: f32) !void {
        try self.owner.sceneSetStyle(target, c.OT_STYLE_FLOAT, kind, 0, 0, value, 0);
    }

    /// 87 nodes: a filled header with text, 40 row boxes with 70-column texts, and a
    /// bordered filled footer with a prompt and a one-cell spinner.
    fn buildUi(self: *Scene) !void {
        const header = try self.node(c.OT_SCENE_BOX, self.root);
        try self.dimension(header, 1, 1);
        try self.owner.sceneSetPaint(header, .{ .background = .{ 30, 30, 60, 255 } });
        _ = try self.text(header, "session: native scene frame bench");
        const body = try self.node(c.OT_SCENE_BOX, self.root);
        try self.float(body, c.OT_STYLE_FLOAT_FLEX_GROW, 1);
        for (0..40) |_| {
            _ = try self.text(try self.node(c.OT_SCENE_BOX, body), "a" ** 70);
        }
        const footer = try self.node(c.OT_SCENE_BOX, self.root);
        try self.dimension(footer, 1, 3);
        try self.owner.sceneSetPaint(footer, .{ .borderSides = c.OT_BORDER_ALL, .shouldFill = 1, .background = .{ 20, 20, 20, 255 } });
        try self.owner.sceneSetStyle(footer, c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_FLEX_DIRECTION, 0, 0, c.OT_FLEX_DIRECTION_ROW, 0);
        _ = try self.text(footer, "> prompt");
        self.target = try self.text(footer, "|");
    }

    /// `size` absolute 1×1 boxes; every hundredth is filled.
    fn buildBoxes(self: *Scene, size: u32) !void {
        for (0..size) |index| {
            const box = try self.node(c.OT_SCENE_BOX, self.root);
            try self.dimension(box, 0, 1);
            try self.dimension(box, 1, 1);
            try self.owner.sceneSetStyle(box, c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_POSITION_TYPE, 0, 0, c.OT_POSITION_ABSOLUTE, 0);
            const x: f32 = @floatFromInt(index % 140);
            const y: f32 = @floatFromInt((index / 140) % 44);
            try self.owner.sceneSetPositions(box, 3, .{ 1, 1, 0, 0 }, .{ x, y, 0, 0 });
            if (index % 100 == 0) {
                try self.owner.sceneSetPaint(box, .{ .background = .{ 200, 0, 0, 255 } });
                self.target = box;
            }
        }
    }

    /// An overflow-hidden viewport whose content holds `size` one-row texts, `wrappers` boxes
    /// above the viewport, each row inside `depth` boxes, and a status text beside it.
    fn buildScroll(self: *Scene, size: u32, wrappers: u32, depth: u32) !void {
        try self.owner.sceneSetStyle(self.root, c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_FLEX_DIRECTION, 0, 0, c.OT_FLEX_DIRECTION_ROW, 0);
        var parent = self.root;
        for (0..wrappers) |_| {
            parent = try self.node(c.OT_SCENE_BOX, parent);
            try self.float(parent, c.OT_STYLE_FLOAT_FLEX_GROW, 1);
        }
        const viewport = try self.node(c.OT_SCENE_BOX, parent);
        try self.float(viewport, c.OT_STYLE_FLOAT_FLEX_GROW, 1);
        try self.owner.sceneSetStyle(viewport, c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_OVERFLOW, 0, 0, c.OT_OVERFLOW_HIDDEN, 0);
        self.content = try self.node(c.OT_SCENE_BOX, viewport);
        try self.float(self.content, c.OT_STYLE_FLOAT_FLEX_SHRINK, 0);
        try self.owner.sceneSetViewport(self.content, viewport);
        self.target = try self.text(self.root, "*");
        for (0..size) |_| try self.addRow(depth);
    }

    /// The scroll shape as one culled scroll node that follows its bottom.
    fn buildScrollNode(self: *Scene, size: u32) !void {
        try self.owner.sceneSetStyle(self.root, c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_FLEX_DIRECTION, 0, 0, c.OT_FLEX_DIRECTION_ROW, 0);
        self.content = try self.node(c.OT_SCENE_BOX, self.root);
        self.scroll_node = true;
        try self.float(self.content, c.OT_STYLE_FLOAT_FLEX_GROW, 1);
        try self.owner.sceneSetScroll(self.content, .{ .follow = c.OT_SCENE_SCROLL_FOLLOW_BOTTOM, .culling = true });
        self.target = try self.text(self.root, "*");
        for (0..size) |_| try self.addRow(0);
    }

    fn addRow(self: *Scene, depth: u32) !void {
        var parent = self.content;
        for (0..depth) |_| parent = try self.node(c.OT_SCENE_BOX, parent);
        var bytes: [32]u8 = undefined;
        const line = try self.text(parent, std.fmt.bufPrint(&bytes, "log line {d} with some text", .{self.next_num}) catch unreachable);
        try self.float(line, c.OT_STYLE_FLOAT_FLEX_SHRINK, 0);
    }

    /// Applies one change, then paints, commits, and drains a frame. Returns its work.
    pub fn frame(self: *Scene, change: Change) !renderer.FrameWork {
        self.frames += 1;
        const odd = self.frames % 2 == 1;
        switch (change) {
            .unchanged => {},
            .glyph => try self.owner.sceneSetText(self.target, if (odd) "/" else "|"),
            .background => try self.owner.scenePatchPaint(self.target, c.OT_SCENE_PROPERTY_BACKGROUND, .{ .background = .{ if (odd) 100 else 200, 0, 0, 255 } }),
            .scroll => if (self.scroll_node) {
                _ = try self.owner.sceneScrollTo(self.content, .{ 0, if (odd) -1 else 1 }, .{ true, true });
            } else try self.owner.scenePatchPaint(self.content, c.OT_SCENE_PROPERTY_TRANSLATE_Y, .{ .translateY = if (odd) -1 else 0 }),
            .append => try self.addRow(0),
            .update_hook, .paint_hook, .reply_text => if (self.frames == 2) {
                const flags: u32 = if (change == .paint_hook) c.OT_SCENE_HOOK_RENDER_AFTER else c.OT_SCENE_HOOK_UPDATE;
                try self.owner.sceneSetHooks(self.target, flags, 1, 1, 1);
            },
        }
        var request: ?scene.FrameRequest = null;
        while (true) {
            const record: ?[]const u8 = if (request != null and request.?.kind == c.OT_SCENE_FRAME_RECORD) &.{} else null;
            request = try self.owner.sceneFrameStepWithRecording(self.id, request, options, record);
            if (request.?.kind == 0) break;
            // The reply sends the target's text again: a mark that changes nothing.
            if (change == .reply_text and request.?.kind == c.OT_SCENE_FRAME_UPDATE) {
                var bytes: [64]u8 = undefined;
                try self.owner.sceneSetText(self.target, bytes[0..try self.owner.sceneGetText(self.target, &bytes)]);
            }
        }
        _ = try self.owner.sceneFrameCommit(self.id, request.?, false);
        var bytes: [64 * 1024]u8 = undefined;
        while (try self.owner.readOutput(self.id, &bytes)) |ticket| try self.owner.completeOutput(self.id, ticket, .written);
        return (try self.owner.sceneGetStats(self.id)).frameWork;
    }
};

const Scenario = struct { name: []const u8, shape: Shape, size: u32, change: Change };

const scenarios = [_]Scenario{
    .{ .name = "ui-90 unchanged", .shape = .ui, .size = 0, .change = .unchanged },
    .{ .name = "ui-90 spinner glyph", .shape = .ui, .size = 0, .change = .glyph },
    .{ .name = "ui-90 unchanged with UPDATE hook", .shape = .ui, .size = 0, .change = .update_hook },
    .{ .name = "ui-90 unchanged with paint hook", .shape = .ui, .size = 0, .change = .paint_hook },
    .{ .name = "boxes-10000 unchanged", .shape = .boxes, .size = 10_000, .change = .unchanged },
    .{ .name = "boxes-10000 one background", .shape = .boxes, .size = 10_000, .change = .background },
    .{ .name = "boxes-10000 unchanged with UPDATE hook", .shape = .boxes, .size = 10_000, .change = .update_hook },
    .{ .name = "scroll-10000 unchanged", .shape = .scroll, .size = 10_000, .change = .unchanged },
    .{ .name = "scroll-10000 status glyph", .shape = .scroll, .size = 10_000, .change = .glyph },
    .{ .name = "scroll-10000 scroll by one row", .shape = .scroll, .size = 10_000, .change = .scroll },
    .{ .name = "scroll-10000 append", .shape = .scroll, .size = 10_000, .change = .append },
    .{ .name = "scroll-1000-w6d2 unchanged", .shape = .wrapped_scroll, .size = 1000, .change = .unchanged },
    .{ .name = "scroll-node-10000 unchanged", .shape = .scroll_node, .size = 10_000, .change = .unchanged },
    .{ .name = "scroll-node-10000 scroll by one row", .shape = .scroll_node, .size = 10_000, .change = .scroll },
    .{ .name = "scroll-node-10000 append", .shape = .scroll_node, .size = 10_000, .change = .append },
};

const SAMPLES: usize = 40;
const WARMUP_SAMPLES: usize = 5;

pub fn run(io: std.Io, allocator: std.mem.Allocator, show_mem: bool, bench_filter: ?[]const u8) ![]bench_utils.BenchResult {
    _ = show_mem;
    var results: std.ArrayListUnmanaged(bench_utils.BenchResult) = .empty;
    for (scenarios) |scenario| {
        if (!bench_utils.matchesBenchFilter(scenario.name, bench_filter)) continue;
        // Results use the caller's arena; the scene frees as it goes.
        var target = try Scene.init(std.heap.smp_allocator, io, scenario.shape, scenario.size);
        defer target.deinit();
        var stats: bench_utils.BenchStats = .{};
        var work: renderer.FrameWork = .{};
        for (0..WARMUP_SAMPLES + SAMPLES) |sample| {
            const timer = bench_utils.BenchTimer.start(io);
            work = try target.frame(scenario.change);
            if (sample >= WARMUP_SAMPLES) stats.record(timer.read());
        }
        const counters = try allocator.alloc(bench_utils.Counter, std.meta.fields(renderer.FrameWork).len - 1);
        inline for (std.meta.fields(renderer.FrameWork)[1..], 0..) |field, index| {
            counters[index] = .{ .name = field.name, .value = @field(work, field.name) };
        }
        try results.append(allocator, .{
            .name = scenario.name,
            .min_ns = stats.min_ns,
            .avg_ns = stats.avg(),
            .max_ns = stats.max_ns,
            .total_ns = stats.total_ns,
            .iterations = stats.count,
            .stddev_ns = stats.standardDeviation(),
            .rme_95 = stats.relativeMarginOfError95(),
            .mem_stats = null,
            .counters = counters,
        });
    }
    return results.toOwnedSlice(allocator);
}
