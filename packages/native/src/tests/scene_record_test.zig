const std = @import("std");
const testing = std.testing;
const c = @import("context_abi_c");
const Fixture = @import("scene_fixture_test.zig").Fixture;
const context = @import("../context.zig");
const scene = @import("../scene.zig");
const ansi = @import("../ansi.zig");
const scene_record = @import("../scene-record.zig");
const grapheme = @import("../grapheme.zig");
const transport: @import("../session.zig").Options = .{ .chunk_size = 4096, .control_capacity = 4096 };

const options: scene.FrameOptions = .{
    .background = .{ 0, 0, 0, 255 },
    .use_mouse = true,
    .excluded_hit_num = 0,
    .max_layout_rounds = 8,
    .max_host_requests = 64,
};
const unlimited = std.math.maxInt(u32);
const before_after = c.OT_SCENE_HOOK_RENDER_BEFORE | c.OT_SCENE_HOOK_RENDER_AFTER;
const self_after = c.OT_SCENE_HOOK_RENDER_SELF | c.OT_SCENE_HOOK_RENDER_AFTER;

pub fn node(owner: *context.Context, id: context.Handle, parent: context.Handle, kind: u32, num: u32, index: u32) !context.Handle {
    const child = try owner.sceneCreateNode(id, kind, num);
    try owner.sceneSetStyle(child, 4, 0, 0, 1, 2, 1);
    try owner.sceneSetStyle(child, 4, 1, 0, 1, 1, 1);
    try owner.sceneSetStyle(child, 0, 6, 0, 0, 2, 0);
    try owner.sceneSetPaint(child, .{ .translateX = @floatFromInt(index * 2), .background = .{ @intCast(num), 0, 0, 255 } });
    try owner.sceneMoveNode(child, parent, index);
    return child;
}

fn cHandle(value: context.Handle) c.ot_handle {
    return .{ .context_id = value.context_id, .slot = value.slot, .generation = value.generation };
}

pub fn drawHeader(comptime T: type, operation: u32) c.ot_buffer_draw_header {
    return .{ .struct_size = @sizeOf(T), .abi_version = c.OT_CONTEXT_ABI_VERSION, .operation = operation, .flags = 0 };
}

/// Builds an 8-byte aligned paint recording.
pub const Recording = struct {
    bytes: [1024]u8 align(8) = undefined,
    len: usize = 0,

    pub fn slot(self: *Recording, index: u32, phase: u32) void {
        self.append(c.ot_scene_record_slot{ .header = .{ .size = 0, .operation = c.OT_SCENE_RECORD_SLOT }, .slot = index, .phase = phase }, &.{});
    }

    pub fn text(self: *Recording, value: []const u8, x: i32, y: i32) void {
        self.draw(c.ot_buffer_draw_text_record{
            .header = drawHeader(c.ot_buffer_draw_text_record, c.OT_BUFFER_DRAW_TEXT),
            .x = x,
            .y = y,
            .attributes = 0,
            .foreground = .{ 255, 255, 255, 255 },
            .background = .{ 0, 0, 0, 0 },
        }, null, value, "");
    }

    pub fn fill(self: *Recording, x: i32, y: i32, width: u32, background: [4]u16) void {
        self.draw(c.ot_buffer_draw_fill{
            .header = drawHeader(c.ot_buffer_draw_fill, c.OT_BUFFER_DRAW_FILL),
            .x = x,
            .y = y,
            .width = width,
            .height = 1,
            .background = background,
        }, null, "", "");
    }

    pub fn compose(self: *Recording, source: context.Handle, x: i32) void {
        self.draw(c.ot_buffer_draw_compose{
            .header = drawHeader(c.ot_buffer_draw_compose, c.OT_BUFFER_DRAW_COMPOSE),
            .x = x,
            .y = 0,
            .source_x = 0,
            .source_y = 0,
            .source_width = 0,
            .source_height = 0,
        }, source, "", "");
    }

    /// Appends one DRAW record: a complete ot_buffer_draw_* record, then its title bytes.
    pub fn draw(self: *Recording, record: anytype, source: ?context.Handle, title: []const u8, bottom: []const u8) void {
        var payload: [256]u8 = undefined;
        const size = @sizeOf(@TypeOf(record));
        @memcpy(payload[0..size], std.mem.asBytes(&record));
        @memcpy(payload[size..][0..title.len], title);
        @memcpy(payload[size + title.len ..][0..bottom.len], bottom);
        self.append(c.ot_scene_record_draw{
            .header = .{ .size = 0, .operation = c.OT_SCENE_RECORD_DRAW },
            .source = if (source) |value| cHandle(value) else std.mem.zeroes(c.ot_handle),
            .text_length = @intCast(title.len),
            .bottom_length = @intCast(bottom.len),
        }, payload[0 .. size + title.len + bottom.len]);
    }

    pub fn stack(self: *Recording, operation: u32, x: i32, width: u32, opacity: f32) void {
        self.append(c.ot_scene_record_stack{
            .header = .{ .size = 0, .operation = c.OT_SCENE_RECORD_STACK },
            .operation = operation,
            .x = x,
            .y = 0,
            .width = width,
            .height = 1,
            .opacity = opacity,
        }, &.{});
    }

    pub fn append(self: *Recording, value: anytype, payload: []const u8) void {
        var record = value;
        const fixed = @sizeOf(@TypeOf(record));
        record.header.size = @intCast(std.mem.alignForward(usize, fixed + payload.len, 8));
        @memcpy(self.bytes[self.len..][0..fixed], std.mem.asBytes(&record));
        @memcpy(self.bytes[self.len + fixed ..][0..payload.len], payload);
        @memset(self.bytes[self.len + fixed + payload.len .. self.len + record.header.size], 0);
        self.len += record.header.size;
    }

    pub fn view(self: *const Recording) []const u8 {
        return self.bytes[0..self.len];
    }
};

fn submit(f: Fixture, request: scene.FrameRequest, recording: *const Recording) !scene.FrameRequest {
    return f.owner.sceneFrameStepWithRecording(f.id, request, options, unlimited, recording.view());
}

fn token(f: Fixture, handle: context.Handle) !u32 {
    return (try f.owner.raw().getRenderable(handle)).scene_node.?.token;
}

test "Scene record plays each phase at its slot around the native body" {
    const f = try Fixture.init(testing.allocator, 8, 1, .{ .output = transport });
    defer f.deinit();
    const first = try node(f.owner, f.id, f.root, 1, 2, 0);
    const second = try node(f.owner, f.id, f.root, 1, 3, 1);
    try f.owner.sceneSetHooks(first, before_after, 1, 2, 1);
    const request = try f.step(null, options, c.OT_SCENE_FRAME_RECORD, f.root);
    try testing.expectEqual(@as(u32, 0), request.num | request.width | request.height);
    try testing.expectEqual(@as(u64, 0), request.hook_generation);
    const slots = try f.owner.sceneFramePaintSlots(f.id, request);
    try testing.expectEqual(@as(usize, 1), slots.len);
    try testing.expectEqual(first, slots[0].node);
    try testing.expectEqual(@as(u32, before_after), slots[0].hooks);
    try testing.expectEqual(@as(u64, 1), slots[0].hook_generation);
    try testing.expectEqual(@as(f64, 0), slots[0].layout.screenX);
    try testing.expectEqual(@as(u32, 8), slots[0].clip.width);
    try testing.expectError(error.StaleFrame, f.owner.sceneFrameAcquireBufferLease(f.id, request, .next));
    try testing.expectError(error.FrameBusy, f.owner.renderSession(f.id, true));
    var recording: Recording = .{};
    recording.slot(0, c.OT_SCENE_RECORD_PHASE_BEFORE);
    recording.text("ab", 0, 0);
    recording.slot(0, c.OT_SCENE_RECORD_PHASE_AFTER);
    recording.text("y", 1, 0);
    recording.text("z", 2, 0);
    const done = try submit(f, request, &recording);
    try testing.expectEqual(@as(u32, c.OT_SCENE_FRAME_DONE), done.kind);
    const cells = f.cli.getNextBuffer();
    // The native box fills over before; after draws over the body; the later sibling paints over after.
    try testing.expectEqual(@as(u32, ' '), cells.get(0, 0).?.char);
    try testing.expectEqual(@as(u32, 'y'), cells.get(1, 0).?.char);
    try testing.expectEqual(@as(u32, ' '), cells.get(2, 0).?.char);
    try testing.expectEqual(ansi.rgbColor(3, 0, 0, 255), cells.get(2, 0).?.bg);
    try testing.expectEqual(try token(f, first), f.cli.nextHitGrid[0]);
    try testing.expectEqual(try token(f, second), f.cli.nextHitGrid[2]);
    try testing.expectEqual(@as(usize, 0), cells.scissor_stack.items.len);
    try testing.expectEqual(@as(usize, 0), cells.opacity_stack.items.len);
    try f.owner.sceneFrameCancel(f.id, done.frame_id);
}

test "Scene record self replaces the native body and unrecorded phases draw nothing" {
    const f = try Fixture.init(testing.allocator, 8, 1, .{ .output = transport });
    defer f.deinit();
    const child = try node(f.owner, f.id, f.root, 1, 2, 0);
    try f.owner.sceneSetHooks(child, self_after, 1, 2, 1);
    const request = try f.step(null, options, c.OT_SCENE_FRAME_RECORD, null);
    var recording: Recording = .{};
    recording.slot(0, c.OT_SCENE_RECORD_PHASE_SELF);
    recording.text("s", 1, 0);
    const done = try submit(f, request, &recording);
    const cells = f.cli.getNextBuffer();
    try testing.expectEqual(options.background, cells.get(0, 0).?.bg);
    try testing.expectEqual(@as(u32, 's'), cells.get(1, 0).?.char);
    try testing.expectEqual(try token(f, child), f.cli.nextHitGrid[0]);
    try f.owner.sceneFrameCancel(f.id, done.frame_id);
}

test "Scene record hooks mutate before paint without tearing or reviving destroyed nodes" {
    const f = try Fixture.init(testing.allocator, 8, 1, .{ .output = transport });
    defer f.deinit();
    const first = try node(f.owner, f.id, f.root, 1, 2, 0);
    const second = try node(f.owner, f.id, f.root, 1, 3, 1);
    const third = try node(f.owner, f.id, f.root, 1, 4, 2);
    try f.owner.sceneSetHooks(first, before_after, 1, 2, 1);
    try f.owner.sceneSetHooks(third, before_after, 1, 2, 1);
    const request = try f.step(null, options, c.OT_SCENE_FRAME_RECORD, null);
    const first_token = try token(f, first);
    // A hook recolors an earlier and a later member, moves one, adds a node, and destroys itself.
    try f.owner.sceneSetPaint(first, .{ .background = .{ 9, 0, 0, 255 } });
    try f.owner.sceneSetPaint(second, .{ .translateX = 6, .background = .{ 8, 0, 0, 255 } });
    _ = try node(f.owner, f.id, f.root, 1, 5, 3);
    try f.owner.sceneDestroyNode(third);
    var recording: Recording = .{};
    recording.slot(0, c.OT_SCENE_RECORD_PHASE_AFTER);
    recording.text("a", 1, 0);
    recording.slot(1, c.OT_SCENE_RECORD_PHASE_BEFORE);
    recording.text("dead", 4, 0);
    const done = try submit(f, request, &recording);
    const cells = f.cli.getNextBuffer();
    try testing.expectEqual(ansi.rgbColor(9, 0, 0, 255), cells.get(0, 0).?.bg);
    try testing.expectEqual(@as(u32, 'a'), cells.get(1, 0).?.char);
    try testing.expectEqual(ansi.rgbColor(8, 0, 0, 255), cells.get(2, 0).?.bg);
    try testing.expectEqual(options.background, cells.get(4, 0).?.bg);
    try testing.expectEqual(@as(u32, ' '), cells.get(4, 0).?.char);
    try testing.expectEqual(options.background, cells.get(6, 0).?.bg);
    try testing.expectEqual(first_token, f.cli.nextHitGrid[0]);
    try testing.expectEqual(@as(u32, 0), f.cli.nextHitGrid[4]);
    try testing.expectEqual(@as(u32, 0), f.cli.nextHitGrid[6]);
    try f.owner.sceneFrameCancel(f.id, done.frame_id);
    const next = try f.owner.sceneFrameStep(f.id, null, options);
    try testing.expectEqual(@as(u32, c.OT_SCENE_FRAME_RECORD), next.kind);
    try testing.expectEqual(@as(f64, 6), (try f.owner.sceneGetPaintLayout(second)).screenX);
    try f.owner.sceneFrameCancel(f.id, next.frame_id);
}

test "Scene record stacks start from the slot clip and reset between phases" {
    const f = try Fixture.init(testing.allocator, 8, 1, .{ .output = transport });
    defer f.deinit();
    const parent = try node(f.owner, f.id, f.root, 1, 2, 0);
    try f.owner.sceneSetStyle(parent, 4, 0, 0, 1, 4, 1);
    try f.owner.sceneSetStyle(parent, 0, 8, 0, 0, 1, 0);
    try f.owner.sceneSetPaint(parent, .{ .shouldFill = 0 });
    const child = try node(f.owner, f.id, parent, 6, 3, 0);
    try f.owner.sceneSetStyle(child, 4, 0, 0, 1, 8, 1);
    try f.owner.sceneSetPaint(child, .{ .opacity = 0.5 });
    try f.owner.sceneSetHooks(child, c.OT_SCENE_HOOK_RENDER_BEFORE | self_after, 1, 8, 1);
    const request = try f.step(null, options, c.OT_SCENE_FRAME_RECORD, null);
    const slots = try f.owner.sceneFramePaintSlots(f.id, request);
    try testing.expectEqual(@as(u32, 4), slots[0].clip.width);
    try testing.expectEqual(@as(f32, 0.5), slots[0].opacity);
    var recording: Recording = .{};
    recording.slot(0, c.OT_SCENE_RECORD_PHASE_BEFORE);
    recording.stack(c.OT_BUFFER_STACK_PUSH_SCISSOR, 0, 1, 1);
    recording.stack(c.OT_BUFFER_STACK_PUSH_OPACITY, 0, 0, 0);
    recording.slot(0, c.OT_SCENE_RECORD_PHASE_SELF);
    recording.stack(c.OT_BUFFER_STACK_CLEAR_SCISSORS, 0, 0, 1);
    recording.fill(0, 0, 8, .{ 0, 200, 0, 255 });
    recording.slot(0, c.OT_SCENE_RECORD_PHASE_AFTER);
    recording.stack(c.OT_BUFFER_STACK_PUSH_SCISSOR, 2, 1, 1);
    recording.text("xx", 1, 0);
    const done = try submit(f, request, &recording);
    const cells = f.cli.getNextBuffer();
    for (0..4) |x| try testing.expect(ansi.green(cells.get(@intCast(x), 0).?.bg) > 0);
    try testing.expectEqual(options.background, cells.get(4, 0).?.bg);
    try testing.expectEqual(@as(u32, ' '), cells.get(1, 0).?.char);
    try testing.expectEqual(@as(u32, 'x'), cells.get(2, 0).?.char);
    try f.owner.sceneFrameCancel(f.id, done.frame_id);
}

test "Scene record CLEAR and COLOR_MATRIX act on the whole frame, outside the slot clip and opacity" {
    for ([_]bool{ true, false }) |clear| {
        const f = try Fixture.init(testing.allocator, 8, 1, .{ .output = transport });
        defer f.deinit();
        const earlier = try node(f.owner, f.id, f.root, 1, 2, 0);
        try f.owner.sceneSetPaint(earlier, .{ .translateX = 6, .background = .{ 200, 0, 0, 255 } });
        const parent = try node(f.owner, f.id, f.root, 1, 3, 1);
        try f.owner.sceneSetStyle(parent, 4, 0, 0, 1, 4, 1);
        try f.owner.sceneSetStyle(parent, 0, 8, 0, 0, 1, 0);
        try f.owner.sceneSetPaint(parent, .{ .shouldFill = 0 });
        const child = try node(f.owner, f.id, parent, 6, 4, 0);
        try f.owner.sceneSetPaint(child, .{ .opacity = 0.5 });
        try f.owner.sceneSetHooks(child, c.OT_SCENE_HOOK_RENDER_AFTER, 1, 2, 1);
        const request = try f.step(null, options, c.OT_SCENE_FRAME_RECORD, null);
        try testing.expectEqual(@as(u32, 4), (try f.owner.sceneFramePaintSlots(f.id, request))[0].clip.width);
        var recording: Recording = .{};
        recording.slot(0, c.OT_SCENE_RECORD_PHASE_AFTER);
        if (clear) {
            recording.draw(c.ot_buffer_draw_clear{ .header = drawHeader(c.ot_buffer_draw_clear, c.OT_BUFFER_DRAW_CLEAR), .background = .{ 0, 0, 255, 255 } }, null, "", "");
        } else {
            // Uniform background matrix that moves red into green.
            recording.append(c.ot_scene_record_color_matrix{
                .header = .{ .size = 0, .operation = c.OT_SCENE_RECORD_COLOR_MATRIX },
                .matrix = .{ 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 },
                .strength = 1,
                .channel = 2,
                .has_mask = 0,
                .mask_count = 0,
            }, &.{});
        }
        const done = try submit(f, request, &recording);
        // The earlier sibling's cell lies outside the 4-cell slot clip and keeps no slot opacity.
        const expected = if (clear) ansi.rgbColor(0, 0, 255, 255) else ansi.rgbColor(0, 200, 0, 255);
        try testing.expectEqual(expected, f.cli.getNextBuffer().get(6, 0).?.bg);
        try f.owner.sceneFrameCancel(f.id, done.frame_id);
    }
}

test "Scene record paints nodes that a hook hides from the prepared membership until the next frame" {
    const f = try Fixture.init(testing.allocator, 8, 1, .{ .output = transport });
    defer f.deinit();
    const hidden_box = try node(f.owner, f.id, f.root, 1, 2, 0);
    const surface = try node(f.owner, f.id, f.root, 6, 3, 1);
    const hooked = try node(f.owner, f.id, f.root, 1, 4, 2);
    const cells = try f.owner.createBuffer(2, 1, .{});
    try f.owner.drawBufferText(cells, "ss", 0, 0, .{ 255, 255, 255, 255 }, null, 0);
    try f.owner.sceneSetSurface(surface, cells);
    try f.owner.sceneSetHooks(hooked, c.OT_SCENE_HOOK_RENDER_BEFORE, 1, 2, 1);
    const empty: Recording = .{};
    for ([_]bool{ true, false }) |painted| {
        const request = try f.step(null, options, c.OT_SCENE_FRAME_RECORD, null);
        if (painted) {
            for ([_]context.Handle{ hidden_box, surface }) |hidden| try f.owner.sceneSetStyle(hidden, 0, 9, 0, 0, 1, 0);
        }
        const done = try submit(f, request, &empty);
        const next = f.cli.getNextBuffer();
        try testing.expectEqual(if (painted) ansi.rgbColor(2, 0, 0, 255) else options.background, next.get(0, 0).?.bg);
        try testing.expectEqual(@as(u32, if (painted) 's' else ' '), next.get(2, 0).?.char);
        try testing.expectEqual(if (painted) try token(f, surface) else 0, f.cli.nextHitGrid[2]);
        try f.owner.sceneFrameCancel(f.id, done.frame_id);
    }
}

test "Scene record reads referenced resources at playback and skips destroyed ones" {
    const f = try Fixture.init(testing.allocator, 8, 1, .{ .output = transport });
    defer f.deinit();
    const child = try node(f.owner, f.id, f.root, 6, 2, 0);
    try f.owner.sceneSetStyle(child, 4, 0, 0, 1, 8, 1);
    try f.owner.sceneSetHooks(child, self_after, 1, 8, 1);
    const kept = try f.owner.createBuffer(2, 1, .{});
    const removed = try f.owner.createBuffer(2, 1, .{});
    try f.owner.drawBufferText(removed, "rr", 0, 0, .{ 255, 255, 255, 255 }, null, 0);
    const request = try f.step(null, options, c.OT_SCENE_FRAME_RECORD, null);
    var recording: Recording = .{};
    recording.slot(0, c.OT_SCENE_RECORD_PHASE_SELF);
    recording.compose(kept, 0);
    recording.compose(removed, 4);
    try f.owner.drawBufferText(kept, "kk", 0, 0, .{ 255, 255, 255, 255 }, null, 0);
    try f.owner.destroy(removed);
    const done = try submit(f, request, &recording);
    const cells = f.cli.getNextBuffer();
    try testing.expectEqual(@as(u32, 'k'), cells.get(0, 0).?.char);
    try testing.expectEqual(@as(u32, ' '), cells.get(4, 0).?.char);
    try f.owner.sceneFrameCancel(f.id, done.frame_id);
}

const Command = enum { box, grid, packed_cells, supersample, grayscale, color_matrix, text_view, editor_view, scene_text, image, unicode };

/// A command goes into a recording, or straight to the painted frame through its direct operation.
const Sink = union(enum) { recording: *Recording, frame: scene.FrameRequest };

const Resources = struct {
    text_view: context.Handle,
    editor_view: context.Handle,
    scene_text: context.Handle,
    image: context.Handle,
    unicode: context.Handle,

    fn init(f: Fixture) !Resources {
        const text = try f.owner.createTextBuffer(.unicode);
        try f.owner.textBufferSetText(text, "view");
        const edit = try f.owner.createEditBuffer(.unicode);
        try f.owner.editSetText(edit, "edit", false);
        const scene_text = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_TEXT, 9);
        try f.owner.sceneSetText(scene_text, "node");
        const pixels = [_]u8{ 200, 40, 0, 255 } ** 4;
        return .{
            .text_view = try f.owner.createTextBufferView(text),
            .editor_view = try f.owner.createEditorView(edit, 4, 1),
            .scene_text = scene_text,
            .image = try f.owner.createImagePixels(&pixels, 2, 2, .{ .stride = 8 }),
            .unicode = try f.owner.createUnicode("uZ", .unicode),
        };
    }
};

fn recordHeader(operation: u32) c.ot_scene_record_header {
    return .{ .size = 0, .operation = operation };
}

fn issue(command: Command, f: Fixture, resources: Resources, sink: Sink) !void {
    const white: [4]u16 = .{ 255, 255, 255, 255 };
    const blue: [4]u16 = .{ 0, 0, 200, 255 };
    const borders: [11]u32 = .{ '+', '+', '+', '+', '-', '|', '+', '+', '+', '+', '+' };
    switch (command) {
        .box => {
            const record: c.ot_buffer_draw_box = .{
                .header = drawHeader(c.ot_buffer_draw_box, c.OT_BUFFER_DRAW_BOX),
                .x = 0,
                .y = 0,
                .width = 6,
                .height = 3,
                // All sides, fill, a centered title, and a right-aligned bottom title.
                .packed_options = c.OT_BORDER_ALL | 16 | (1 << 5) | (2 << 7),
                .foreground = white,
                .background = blue,
                .title_color = white,
                .border_chars = borders,
            };
            switch (sink) {
                .recording => |recording| recording.draw(record, null, "ab", "cd"),
                .frame => |frame| {
                    var draw: context.BufferDraw = undefined;
                    try scene_record.bufferDrawFromC(&record.header, &draw);
                    try f.owner.drawBuffer(f.id, frame, &draw, "ab", "cd");
                },
            }
        },
        .grid => {
            const grid: c.ot_buffer_grid_options = .{ .struct_size = @sizeOf(c.ot_buffer_grid_options), .abi_version = c.OT_CONTEXT_ABI_VERSION, .flags = c.OT_BUFFER_GRID_INNER | c.OT_BUFFER_GRID_OUTER, .reserved = 0, .foreground = white, .background = blue, .border_chars = borders };
            const offsets = [_]i32{ 0, 4, 9, 0, 2, 3 };
            switch (sink) {
                .recording => |recording| recording.append(c.ot_scene_record_grid{ .header = recordHeader(c.OT_SCENE_RECORD_GRID), .options = grid, .column_count = 3, .row_count = 3 }, std.mem.sliceAsBytes(&offsets)),
                .frame => |frame| try f.owner.drawGrid(f.id, frame, try scene_record.gridFromC(&grid), offsets[0..3], offsets[3..]),
            }
        },
        .packed_cells => {
            const Cell = extern struct { background: [4]f32, foreground: [4]f32, char: u32, padding: [3]u32 = .{ 0, 0, 0 } };
            const cells = [_]Cell{ .{ .background = .{ 1, 0, 0, 1 }, .foreground = .{ 1, 1, 1, 1 }, .char = 'P' }, .{ .background = .{ 0, 1, 0, 0.5 }, .foreground = .{ 0, 0, 0, 1 }, .char = 0x2588 } };
            const data = std.mem.sliceAsBytes(&cells);
            switch (sink) {
                .recording => |recording| recording.append(c.ot_scene_record_packed{ .header = recordHeader(c.OT_SCENE_RECORD_PACKED), .x = 3, .y = 1, .width = 2, .height = 1, .byte_count = @intCast(data.len), .reserved = 0 }, data),
                .frame => |frame| try f.owner.drawPackedBuffer(f.id, frame, data, 3, 1, 2, 1),
            }
        },
        .supersample => {
            const pixels = [_]u8{ 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255 } ** 2;
            switch (sink) {
                .recording => |recording| recording.append(c.ot_scene_record_supersample{ .header = recordHeader(c.OT_SCENE_RECORD_SUPERSAMPLE), .x = 6, .y = 2, .format = 1, .stride = 16, .byte_count = pixels.len, .reserved = 0 }, &pixels),
                .frame => |frame| try f.owner.drawSuperSampleBuffer(f.id, frame, &pixels, 6, 2, 1, 16),
            }
        },
        .grayscale => {
            const samples = [_]f32{ 0.2, 0.6, 1.0 };
            const flags = c.OT_SCENE_RECORD_GRAYSCALE_FOREGROUND | c.OT_SCENE_RECORD_GRAYSCALE_BACKGROUND;
            switch (sink) {
                .recording => |recording| recording.append(c.ot_scene_record_grayscale{ .header = recordHeader(c.OT_SCENE_RECORD_GRAYSCALE), .x = 1, .y = 3, .width = 3, .height = 1, .flags = flags, .sample_count = samples.len, .foreground = white, .background = blue }, std.mem.sliceAsBytes(&samples)),
                .frame => |frame| try f.owner.drawGrayscaleBuffer(f.id, frame, &samples, 1, 3, 3, 1, white, blue, false),
            }
        },
        .color_matrix => {
            // Adds half of alpha to red, uniformly on backgrounds and through a mask on both planes.
            const matrix = [16]f32{ 1, 0, 0, 0.5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 };
            const mask = [_]f32{ 1, 1, 1, 5, 2, 0.5 };
            switch (sink) {
                .recording => |recording| {
                    recording.append(c.ot_scene_record_color_matrix{ .header = recordHeader(c.OT_SCENE_RECORD_COLOR_MATRIX), .matrix = matrix, .strength = 0.5, .channel = 2, .has_mask = 0, .mask_count = 0 }, &.{});
                    recording.append(c.ot_scene_record_color_matrix{ .header = recordHeader(c.OT_SCENE_RECORD_COLOR_MATRIX), .matrix = matrix, .strength = 1, .channel = 3, .has_mask = 1, .mask_count = mask.len }, std.mem.sliceAsBytes(&mask));
                },
                .frame => |frame| {
                    try f.owner.colorMatrixBuffer(f.id, frame, &matrix, null, 0.5, 2);
                    try f.owner.colorMatrixBuffer(f.id, frame, &matrix, &mask, 1, 3);
                },
            }
        },
        .text_view, .editor_view, .scene_text => {
            const source = switch (command) {
                .text_view => resources.text_view,
                .editor_view => resources.editor_view,
                else => resources.scene_text,
            };
            const operation: u32 = switch (command) {
                .text_view => c.OT_SCENE_RECORD_TEXT_VIEW,
                .editor_view => c.OT_SCENE_RECORD_EDITOR_VIEW,
                else => c.OT_SCENE_RECORD_SCENE_TEXT,
            };
            switch (sink) {
                .recording => |recording| recording.append(c.ot_scene_record_view{ .header = recordHeader(operation), .source = cHandle(source), .x = 2, .y = 1 }, &.{}),
                .frame => |frame| switch (command) {
                    .text_view => try f.owner.drawTextBufferView(f.id, frame, source, 2, 1),
                    .editor_view => try f.owner.drawEditorView(f.id, frame, source, 2, 1),
                    else => try f.owner.drawSceneText(f.id, frame, source, 2, 1),
                },
            }
        },
        .image => {
            const draw: c.ot_image_draw_options = .{ .struct_size = @sizeOf(c.ot_image_draw_options), .abi_version = c.OT_CONTEXT_ABI_VERSION, .flags = 0, .protocol = c.OT_IMAGE_PROTOCOL_BLOCKS, .x = 8, .y = 2, .width = 2, .height = 1, .pixel_width = 0, .pixel_height = 0, .source_x = 0, .source_y = 0, .source_width = 0, .source_height = 0, .reserved = .{ 0, 0 } };
            switch (sink) {
                .recording => |recording| recording.append(c.ot_scene_record_image{ .header = recordHeader(c.OT_SCENE_RECORD_IMAGE), .image = cHandle(resources.image), .options = draw }, &.{}),
                .frame => |frame| _ = try f.owner.drawBufferImage(f.id, frame, resources.image, try scene_record.imageDrawFromC(&draw)),
            }
        },
        .unicode => switch (sink) {
            .recording => |recording| recording.append(c.ot_scene_record_unicode{ .header = recordHeader(c.OT_SCENE_RECORD_UNICODE), .unicode = cHandle(resources.unicode), .index = 1, .x = 11, .y = 3, .attributes = 1, .foreground = white, .background = blue }, &.{}),
            .frame => |frame| try f.owner.drawBufferUnicode(f.id, frame, resources.unicode, 1, 11, 3, white, blue, 1),
        },
    }
}

/// Cell planes of a frame. Grapheme pool IDs differ between frames, so graphemes compare by text.
const Cells = struct {
    char: []u32,
    fg: []ansi.RGBA,
    bg: []ansi.RGBA,
    attributes: []u32,
    text: []u8,
    placements: usize,

    fn copy(target: *const @import("../buffer.zig").OptimizedBuffer) !Cells {
        const cells = target.buffer;
        const char = try testing.allocator.dupe(u32, cells.char);
        for (char) |*value| {
            if (value.* & grapheme.CHAR_FLAG_GRAPHEME != 0) value.* &= grapheme.CHAR_FLAG_CONTINUATION;
        }
        var text: [1024]u8 = undefined;
        return .{
            .char = char,
            .fg = try testing.allocator.dupe(ansi.RGBA, cells.fg),
            .bg = try testing.allocator.dupe(ansi.RGBA, cells.bg),
            .attributes = try testing.allocator.dupe(u32, cells.attributes),
            .text = try testing.allocator.dupe(u8, text[0..try target.writeResolvedChars(&text, false)]),
            .placements = target.image_placements.items.len,
        };
    }

    fn deinit(self: Cells) void {
        inline for (.{ self.char, self.fg, self.bg, self.attributes, self.text }) |plane| testing.allocator.free(plane);
    }

    fn eql(self: Cells, other: Cells) bool {
        return std.mem.eql(u32, self.char, other.char) and std.mem.eql(u32, self.attributes, other.attributes) and
            std.mem.eql(u8, std.mem.sliceAsBytes(self.fg), std.mem.sliceAsBytes(other.fg)) and
            std.mem.eql(u8, std.mem.sliceAsBytes(self.bg), std.mem.sliceAsBytes(other.bg)) and
            std.mem.eql(u8, self.text, other.text) and self.placements == other.placements;
    }
};

test "Scene record plays every command like its direct frame operation" {
    const f = try Fixture.init(testing.allocator, 12, 4, .{ .output = transport });
    defer f.deinit();
    // A full-frame slot has the whole frame as clip and opacity 1, like a direct frame draw.
    const surface = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_CUSTOM, 2);
    try f.owner.sceneSetStyle(surface, 4, 0, 0, 1, 12, 1);
    try f.owner.sceneSetStyle(surface, 4, 1, 0, 1, 4, 1);
    try f.owner.sceneMoveNode(surface, f.root, 0);
    try f.owner.sceneSetHooks(surface, c.OT_SCENE_HOOK_RENDER_SELF, 1, 12, 4);
    const resources = try Resources.init(f);
    const empty: Recording = .{};
    const blank_frame = try submit(f, try f.step(null, options, c.OT_SCENE_FRAME_RECORD, null), &empty);
    const blank = try Cells.copy(f.cli.getNextBuffer());
    defer blank.deinit();
    try f.owner.sceneFrameCancel(f.id, blank_frame.frame_id);
    for (std.enums.values(Command)) |command| {
        errdefer std.debug.print("recorded and direct {s} differ\n", .{@tagName(command)});
        var recording: Recording = .{};
        recording.slot(0, c.OT_SCENE_RECORD_PHASE_SELF);
        try issue(command, f, resources, .{ .recording = &recording });
        const recorded = try submit(f, try f.step(null, options, c.OT_SCENE_FRAME_RECORD, null), &recording);
        const expected = try Cells.copy(f.cli.getNextBuffer());
        defer expected.deinit();
        try testing.expect(!expected.eql(blank));
        try f.owner.sceneFrameCancel(f.id, recorded.frame_id);
        const direct = try submit(f, try f.step(null, options, c.OT_SCENE_FRAME_RECORD, null), &empty);
        try issue(command, f, resources, .{ .frame = direct });
        const actual = try Cells.copy(f.cli.getNextBuffer());
        defer actual.deinit();
        try testing.expect(expected.eql(actual));
        try f.owner.sceneFrameCancel(f.id, direct.frame_id);
    }
}

fn placed(f: Fixture, kind: u32, num: u32, x: f64, y: f64, width: f32) !context.Handle {
    const child = try f.owner.sceneCreateNode(f.id, kind, num);
    try f.owner.sceneSetStyle(child, 4, 0, 0, 1, width, 1);
    try f.owner.sceneSetStyle(child, 4, 1, 0, 1, if (kind == c.OT_SCENE_BOX) 3 else 1, 1);
    try f.owner.sceneSetStyle(child, 0, 6, 0, 0, 2, 0);
    try f.owner.sceneSetPaint(child, .{ .translateX = x, .translateY = y, .borderSides = if (kind == c.OT_SCENE_BOX) c.OT_BORDER_ALL else 0, .background = .{ 0, 0, 120, 255 } });
    try f.owner.sceneMoveNode(child, f.root, 0);
    return child;
}

test "Scene record paints an empty recording like a hook-free frame and plays image phases into the backing buffer" {
    const f = try Fixture.init(testing.allocator, 12, 4, .{ .output = transport });
    defer f.deinit();
    try f.owner.sceneSetBoxDetails(try placed(f, c.OT_SCENE_BOX, 2, 0, 0, 6), .{ .title = "ti" });
    try f.owner.sceneSetText(try placed(f, c.OT_SCENE_TEXT, 3, 6, 0, 5), "hello");
    try f.owner.sceneSetSlider(try placed(f, c.OT_SCENE_SLIDER, 4, 6, 1, 4), .{ .value = 40 });
    _ = try placed(f, c.OT_SCENE_ARROW, 5, 11, 0, 1);
    const pixels = [_]u8{ 200, 40, 0, 255 } ** 4;
    const picture = try f.owner.createImagePixels(&pixels, 2, 2, .{ .stride = 8 });
    try f.owner.sceneSetImage(try placed(f, c.OT_SCENE_IMAGE, 6, 0, 3, 2), picture, .fill, .blocks, null);
    const backed = try placed(f, c.OT_SCENE_IMAGE, 7, 2, 3, 2);
    try f.owner.sceneSetImage(backed, picture, .fill, .blocks, try f.owner.createBuffer(2, 1, .{}));
    const cells = try f.owner.createBuffer(2, 1, .{});
    try f.owner.drawBufferText(cells, "sf", 0, 0, .{ 255, 255, 255, 255 }, null, 0);
    try f.owner.sceneSetSurface(try placed(f, c.OT_SCENE_CUSTOM, 8, 6, 2, 2), cells);
    const text = try f.owner.createTextBuffer(.unicode);
    try f.owner.textBufferSetText(text, "tv");
    try f.owner.sceneSetTextView(try placed(f, c.OT_SCENE_TEXT_VIEW, 9, 4, 3, 4), try f.owner.createTextBufferView(text));
    const edit = try f.owner.createEditBuffer(.unicode);
    try f.owner.editSetText(edit, "ed", false);
    try f.owner.sceneSetEditorView(try placed(f, c.OT_SCENE_EDITOR, 10, 8, 2, 4), try f.owner.createEditorView(edit, 4, 1));
    const done = try f.step(null, options, c.OT_SCENE_FRAME_DONE, null);
    const hook_free = try Cells.copy(f.cli.getNextBuffer());
    defer hook_free.deinit();
    const hits = try testing.allocator.dupe(u32, f.cli.nextHitGrid);
    defer testing.allocator.free(hits);
    try f.owner.sceneFrameCancel(f.id, done.frame_id);
    // One paint hook moves the frame to the recorded path; recording nothing must not change it.
    try f.owner.sceneSetHooks(backed, c.OT_SCENE_HOOK_RENDER_AFTER, 1, 2, 1);
    const empty: Recording = .{};
    const recorded = try submit(f, try f.step(null, options, c.OT_SCENE_FRAME_RECORD, null), &empty);
    const actual = try Cells.copy(f.cli.getNextBuffer());
    defer actual.deinit();
    try testing.expect(actual.eql(hook_free));
    try testing.expectEqualSlices(u32, hits, f.cli.nextHitGrid);
    try f.owner.sceneFrameCancel(f.id, recorded.frame_id);
    // Image phases draw in buffer coordinates into the cleared backing buffer before it is composed.
    var recording: Recording = .{};
    recording.slot(0, c.OT_SCENE_RECORD_PHASE_AFTER);
    recording.text("hi", 0, 0);
    const played = try submit(f, try f.step(null, options, c.OT_SCENE_FRAME_RECORD, null), &recording);
    const frame = f.cli.getNextBuffer();
    try testing.expectEqual(@as(u32, 'h'), frame.get(2, 3).?.char);
    try testing.expectEqual(@as(u32, 'i'), frame.get(3, 3).?.char);
    try testing.expectEqual(hook_free.char[0], frame.get(0, 0).?.char);
    try f.owner.sceneFrameCancel(f.id, played.frame_id);
}

test "Scene record rejects malformed streams before presenting cells" {
    const f = try Fixture.init(testing.allocator, 8, 1, .{ .output = transport });
    defer f.deinit();
    const child = try node(f.owner, f.id, f.root, 1, 2, 0);
    try f.owner.sceneSetHooks(child, c.OT_SCENE_HOOK_RENDER_AFTER, 1, 2, 1);
    var cases: [8]Recording = .{ .{}, .{}, .{}, .{}, .{}, .{}, .{}, .{} };
    // A command before any slot.
    cases[0].text("a", 0, 0);
    // A phase the slot did not register.
    cases[1].slot(0, c.OT_SCENE_RECORD_PHASE_BEFORE);
    // A slot index out of range.
    cases[2].slot(1, c.OT_SCENE_RECORD_PHASE_AFTER);
    // A repeated phase.
    cases[3].slot(0, c.OT_SCENE_RECORD_PHASE_AFTER);
    cases[3].slot(0, c.OT_SCENE_RECORD_PHASE_AFTER);
    // An unknown operation.
    cases[4].slot(0, c.OT_SCENE_RECORD_PHASE_AFTER);
    cases[4].append(extern struct { header: c.ot_scene_record_header }{ .header = .{ .size = 0, .operation = 99 } }, &.{});
    // A size that disagrees with the declared payload.
    cases[5].slot(0, c.OT_SCENE_RECORD_PHASE_AFTER);
    cases[5].text("abc", 0, 0);
    std.mem.bytesAsValue(c.ot_scene_record_draw, cases[5].bytes[16..]).text_length = 30;
    // A truncated header.
    cases[6].slot(0, c.OT_SCENE_RECORD_PHASE_AFTER);
    cases[6].len += 4;
    // An invalid command body fails during playback.
    cases[7].slot(0, c.OT_SCENE_RECORD_PHASE_AFTER);
    cases[7].text("\xff", 0, 0);
    for (&cases, 0..) |*recording, index| {
        const request = try f.step(null, options, c.OT_SCENE_FRAME_RECORD, null);
        if (index == 6) @memset(recording.bytes[recording.len - 4 .. recording.len], 0);
        try testing.expect(std.meta.isError(submit(f, request, recording)));
        try testing.expect(f.state.attempt == null and f.state.painted == null);
        try testing.expectEqual(@as(usize, 0), f.state.paint_members.items.len);
        try testing.expectEqual(@as(usize, 0), f.cli.getNextBuffer().scissor_stack.items.len);
        for (f.cli.nextHitGrid) |hit| try testing.expectEqual(@as(u32, 0), hit);
        try testing.expectError(error.StaleFrame, f.owner.sceneFramePaintSlots(f.id, request));
    }
    const request = try f.step(null, options, c.OT_SCENE_FRAME_RECORD, null);
    var misaligned: [24]u8 align(8) = undefined;
    try testing.expectError(error.InvalidOptions, f.owner.sceneFrameStepWithRecording(f.id, request, options, unlimited, misaligned[1..17]));
    try testing.expectError(error.StaleFrame, f.owner.sceneFrameStep(f.id, request, options));
}

test "Scene record acknowledgements require the exact request and a recording only for RECORD" {
    const f = try Fixture.init(testing.allocator, 8, 1, .{ .output = transport });
    defer f.deinit();
    const child = try node(f.owner, f.id, f.root, 1, 2, 0);
    try f.owner.sceneSetHooks(child, c.OT_SCENE_HOOK_RENDER_AFTER, 1, 2, 1);
    try f.owner.sceneSetHooks(f.root, c.OT_SCENE_HOOK_UPDATE, 1, 8, 1);
    var limited = options;
    limited.max_host_requests = 2;
    const empty: Recording = .{};
    try testing.expectError(error.InvalidOptions, f.owner.sceneFrameStepWithRecording(f.id, null, limited, unlimited, empty.view()));
    const update = try f.step(null, limited, c.OT_SCENE_FRAME_UPDATE, f.root);
    try testing.expectError(error.StaleFrame, f.owner.sceneFramePaintSlots(f.id, update));
    try testing.expectError(error.InvalidOptions, f.owner.sceneFrameStepWithRecording(f.id, update, limited, unlimited, empty.view()));
    const request = try f.owner.sceneFrameStep(f.id, update, limited);
    try testing.expectEqual(@as(u32, c.OT_SCENE_FRAME_RECORD), request.kind);
    try testing.expectEqual(@as(u32, 2), f.state.attempt.?.requests);
    try testing.expectError(error.InvalidOptions, f.owner.sceneFrameStep(f.id, request, limited));
    var forged = request;
    forged.request_id += 1;
    try testing.expectError(error.StaleFrame, f.owner.sceneFrameStepWithRecording(f.id, forged, limited, unlimited, empty.view()));
    const done = try f.owner.sceneFrameStepWithRecording(f.id, request, limited, unlimited, empty.view());
    try testing.expectEqual(@as(u32, c.OT_SCENE_FRAME_DONE), done.kind);
    try testing.expectEqual(ansi.rgbColor(2, 0, 0, 255), f.cli.getNextBuffer().get(0, 0).?.bg);
    try f.owner.sceneFrameCancel(f.id, done.frame_id);
    limited.max_host_requests = 1;
    const second = try f.step(null, limited, c.OT_SCENE_FRAME_UPDATE, f.root);
    try testing.expectError(error.FrameRequestLimit, f.owner.sceneFrameStep(f.id, second, limited));
    try testing.expect(f.state.attempt == null);
}

test "Scene record root destruction cancels the pending request" {
    const f = try Fixture.init(testing.allocator, 8, 1, .{ .output = transport });
    defer f.deinit();
    const child = try node(f.owner, f.id, f.root, 1, 2, 0);
    try f.owner.sceneSetHooks(child, c.OT_SCENE_HOOK_RENDER_AFTER, 1, 2, 1);
    const request = try f.step(null, options, c.OT_SCENE_FRAME_RECORD, null);
    try f.owner.sceneDestroyNode(f.root);
    const empty: Recording = .{};
    try testing.expectError(error.StaleFrame, submit(f, request, &empty));
    try testing.expect(f.state.attempt == null and f.state.paint_slots.items.len == 0);
}

fn allocationFailures(allocator: std.mem.Allocator) !void {
    const f = try Fixture.init(allocator, 8, 1, .{ .output = transport });
    defer f.deinit();
    const child = try node(f.owner, f.id, f.root, 1, 2, 0);
    try f.owner.sceneSetBoxDetails(child, .{ .title = "t" });
    try f.owner.sceneSetHooks(child, before_after, 1, 2, 1);
    _ = try node(f.owner, f.id, f.root, 1, 3, 1);
    const request = try f.owner.sceneFrameStep(f.id, null, options);
    var recording: Recording = .{};
    recording.slot(0, c.OT_SCENE_RECORD_PHASE_AFTER);
    recording.stack(c.OT_BUFFER_STACK_PUSH_SCISSOR, 0, 1, 1);
    recording.text("a", 0, 0);
    const done = try submit(f, request, &recording);
    try f.owner.sceneFrameCancel(f.id, done.frame_id);
}

test "Scene record releases requests and slots on allocation failure" {
    try testing.checkAllAllocationFailures(testing.allocator, allocationFailures, .{});
}
