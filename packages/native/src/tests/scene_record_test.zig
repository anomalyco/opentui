const std = @import("std");
const testing = std.testing;
const c = @import("context_abi_c");
const Fixture = @import("scene_fixture_test.zig").Fixture;
const context = @import("../context.zig");
const scene = @import("../scene.zig");
const ansi = @import("../ansi.zig");
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

/// Builds an 8-byte aligned paint recording.
pub const Recording = struct {
    bytes: [1024]u8 align(8) = undefined,
    len: usize = 0,

    pub fn slot(self: *Recording, index: u32, phase: u32) void {
        self.append(c.ot_scene_record_slot{ .header = .{ .size = 0, .operation = c.OT_SCENE_RECORD_SLOT }, .slot = index, .phase = phase }, &.{});
    }

    pub fn text(self: *Recording, value: []const u8, x: i32, y: i32) void {
        const draw: c.ot_buffer_draw_text_record = .{
            .header = .{ .struct_size = @sizeOf(c.ot_buffer_draw_text_record), .abi_version = c.OT_CONTEXT_ABI_VERSION, .operation = c.OT_BUFFER_DRAW_TEXT, .flags = 0 },
            .x = x,
            .y = y,
            .attributes = 0,
            .foreground = .{ 255, 255, 255, 255 },
            .background = .{ 0, 0, 0, 0 },
        };
        var payload: [64]u8 = undefined;
        @memcpy(payload[0..@sizeOf(@TypeOf(draw))], std.mem.asBytes(&draw));
        @memcpy(payload[@sizeOf(@TypeOf(draw))..][0..value.len], value);
        self.append(c.ot_scene_record_draw{
            .header = .{ .size = 0, .operation = c.OT_SCENE_RECORD_DRAW },
            .source = std.mem.zeroes(c.ot_handle),
            .text_length = @intCast(value.len),
            .bottom_length = 0,
        }, payload[0 .. @sizeOf(@TypeOf(draw)) + value.len]);
    }

    pub fn fill(self: *Recording, x: i32, y: i32, width: u32, background: [4]u16) void {
        const draw: c.ot_buffer_draw_fill = .{
            .header = .{ .struct_size = @sizeOf(c.ot_buffer_draw_fill), .abi_version = c.OT_CONTEXT_ABI_VERSION, .operation = c.OT_BUFFER_DRAW_FILL, .flags = 0 },
            .x = x,
            .y = y,
            .width = width,
            .height = 1,
            .background = background,
        };
        self.append(c.ot_scene_record_draw{
            .header = .{ .size = 0, .operation = c.OT_SCENE_RECORD_DRAW },
            .source = std.mem.zeroes(c.ot_handle),
            .text_length = 0,
            .bottom_length = 0,
        }, std.mem.asBytes(&draw));
    }

    pub fn compose(self: *Recording, source: context.Handle, x: i32) void {
        const draw: c.ot_buffer_draw_compose = .{
            .header = .{ .struct_size = @sizeOf(c.ot_buffer_draw_compose), .abi_version = c.OT_CONTEXT_ABI_VERSION, .operation = c.OT_BUFFER_DRAW_COMPOSE, .flags = 0 },
            .x = x,
            .y = 0,
            .source_x = 0,
            .source_y = 0,
            .source_width = 0,
            .source_height = 0,
        };
        self.append(c.ot_scene_record_draw{
            .header = .{ .size = 0, .operation = c.OT_SCENE_RECORD_DRAW },
            .source = .{ .context_id = source.context_id, .slot = source.slot, .generation = source.generation },
            .text_length = 0,
            .bottom_length = 0,
        }, std.mem.asBytes(&draw));
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
    cases[7].text("\x07", 0, 0);
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
