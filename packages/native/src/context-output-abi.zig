const std = @import("std");
const c = @import("context_abi_c");
const abi = @import("context-abi.zig");
const transport = @import("context-editor-abi.zig");
const session = @import("session.zig");
const renderer = @import("renderer.zig");
const fail = transport.fail;

pub fn ot_scene_measure_layout(context: ?*abi.ContextHandle, id: ?*const c.ot_handle, root: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const owner = transport.beginMutation(context) catch |err| return fail(context, err);
    defer owner.core.mutating = false;
    if (id == null or root == null) return fail(context, error.InvalidOptions);
    const value = owner.core.getSession(abi.handleFromC(id.?.*)) catch |err| return fail(context, err);
    value.checkRendering() catch |err| return fail(context, err);
    value.checkFrameIdle() catch |err| return fail(context, err);
    const attached = value.renderer orelse return fail(context, error.RendererNotAttached);
    const owned = value.scene orelse return fail(context, error.SceneNotAttached);
    if (value.frame_end_offset != null or attached.pendingPresentation != null) return fail(context, error.PresentationPending);
    if (attached.width > std.math.maxInt(i32) or attached.height > std.math.maxInt(i32)) return fail(context, error.InvalidDimensions);
    owned.measureLayout(&owner.core.objects, attached, abi.handleFromC(root.?.*)) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_scene_frame_copy_buffer(context: ?*abi.ContextHandle, id: ?*const c.ot_handle, frame_ptr: ?*const c.ot_scene_frame_request, target: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const owner = transport.beginMutation(context) catch |err| return fail(context, err);
    defer owner.core.mutating = false;
    if (id == null or target == null or frame_ptr == null) return fail(context, error.InvalidOptions);
    const frame = abi.frameRequestFromC(frame_ptr.?.*) catch |err| return fail(context, err);
    const value = owner.core.getSession(abi.handleFromC(id.?.*)) catch |err| return fail(context, err);
    const buffer = owner.core.getBuffer(abi.handleFromC(target.?.*)) catch |err| return fail(context, err);
    value.copySceneFrame(frame, buffer) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_session_render_split(context: ?*abi.ContextHandle, id: ?*const c.ot_handle, frame_ptr: ?*const c.ot_scene_frame_request, snapshots_ptr: ?[*]const c.ot_split_snapshot, count: u32, pinned_render_offset: u32, force: u32, out_status: ?*u32, out_offset: ?*u32) callconv(.c) c.ot_status {
    const owner = transport.beginMutation(context) catch |err| return fail(context, err);
    defer owner.core.mutating = false;
    if (id == null or out_status == null or out_offset == null or force > 1 or count > session.split_snapshots_max or (count != 0 and snapshots_ptr == null)) return fail(context, error.InvalidOptions);
    const value = owner.core.getSession(abi.handleFromC(id.?.*)) catch |err| return fail(context, err);
    const frame = if (frame_ptr) |record| abi.frameRequestFromC(record.*) catch |err| return fail(context, err) else null;
    var snapshots: [session.split_snapshots_max]renderer.SplitSnapshot = undefined;
    for (snapshots[0..count], 0..) |*snapshot, index| {
        const record = snapshots_ptr.?[index];
        if (record.flags & ~@as(u32, 3) != 0) return fail(context, error.InvalidOptions);
        snapshot.* = .{
            .snapshot = owner.core.getBuffer(abi.handleFromC(record.buffer)) catch |err| return fail(context, err),
            .row_columns = record.row_columns,
            .start_on_new_line = record.flags & 1 != 0,
            .trailing_newline = record.flags & 2 != 0,
        };
    }
    const result = value.renderSplit(frame, snapshots[0..count], pinned_render_offset, force == 1) catch |err| return fail(context, err);
    out_status.?.* = abi.renderStatusToC(result);
    out_offset.?.* = value.renderer.?.renderOffset;
    return c.OT_OK;
}

pub fn ot_session_split_control(context: ?*abi.ContextHandle, id: ?*const c.ot_handle, options: ?*const c.ot_split_control, out: ?*u32) callconv(.c) c.ot_status {
    const owner = transport.beginMutation(context) catch |err| return fail(context, err);
    defer owner.core.mutating = false;
    const record = transport.record(c.ot_split_control, options) catch |err| return fail(context, err);
    if (id == null or out == null) return fail(context, error.InvalidOptions);
    const used: usize = switch (record.command) {
        0 => 2,
        1, 2, 3 => 1,
        4 => 6,
        5 => 0,
        else => return fail(context, error.InvalidOptions),
    };
    for (record.arguments[used..]) |argument| if (argument != 0) return fail(context, error.InvalidOptions);
    const args = record.arguments;
    const command: session.SplitControl = switch (record.command) {
        0 => .{ .reset = .{ .seed_rows = args[0], .pinned_render_offset = args[1] } },
        1 => .{ .sync = args[0] },
        2 => .{ .output_offset = args[0] },
        3 => .{ .render_offset = args[0] },
        4 => .{ .transition = .{
            .mode = switch (args[0]) {
                1 => .viewport_scroll,
                2 => .clear_stale_rows,
                else => return fail(context, error.InvalidOptions),
            },
            .source_top_line = args[1],
            .source_height = args[2],
            .target_top_line = args[3],
            .target_height = args[4],
            .scroll_lines = args[5],
        } },
        5 => .clear_transition,
        else => unreachable,
    };
    const value = owner.core.getSession(abi.handleFromC(id.?.*)) catch |err| return fail(context, err);
    out.?.* = value.splitControl(command) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_session_set_screen(context: ?*abi.ContextHandle, id: ?*const c.ot_handle, alternate: u32, width: u32, height: u32, trailing_output: ?[*]const u8, byte_count: u32) callconv(.c) c.ot_status {
    const owner = transport.beginMutation(context) catch |err| return fail(context, err);
    defer owner.core.mutating = false;
    if (id == null or alternate > 1 or byte_count > session.control_packet_bytes_max or (byte_count != 0 and trailing_output == null)) return fail(context, error.InvalidOptions);
    owner.core.checkBufferDimensions(width, height) catch |err| return fail(context, err);
    const value = owner.core.getSession(abi.handleFromC(id.?.*)) catch |err| return fail(context, err);
    const bytes = if (trailing_output) |ptr| ptr[0..byte_count] else &.{};
    value.setScreen(alternate == 1, width, height, bytes) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_session_sync_detached(context: ?*abi.ContextHandle, id: ?*const c.ot_handle, parent: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const owner = transport.beginMutation(context) catch |err| return fail(context, err);
    defer owner.core.mutating = false;
    if (id == null or parent == null) return fail(context, error.InvalidOptions);
    const value = owner.core.getSession(abi.handleFromC(id.?.*)) catch |err| return fail(context, err);
    const source = owner.core.getSession(abi.handleFromC(parent.?.*)) catch |err| return fail(context, err);
    value.syncDetached(source) catch |err| return fail(context, err);
    return c.OT_OK;
}

test "Context output ABI holds mutation ownership through scene measurement callbacks" {
    const ctx = @import("context.zig");
    const Probe = struct {
        var active: *@This() = undefined;
        owner: *abi.ContextHandle,
        buffer: ctx.Handle,
        calls: u32 = 0,
        mutating: bool = false,
        rejection: ?anyerror = null,

        fn measure(_: u64, _: u32, _: u32, _: f32, _: u32, _: f32, _: u32, result: *@import("yoga.zig").ExternalYogaSize) callconv(.c) void {
            const self = active;
            self.calls += 1;
            self.mutating = self.owner.core.mutating;
            self.owner.core.clearBuffer(self.buffer, .{ 255, 0, 0, 255 }) catch |err| {
                self.rejection = err;
            };
            result.* = .{ .width = 2, .height = 1 };
        }
    };
    var owner: abi.ContextHandle = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = undefined, .owner_thread = std.Thread.getCurrentId() };
    defer owner.io_threaded.deinit();
    owner.core = try ctx.Context.init(std.testing.allocator, owner.io_threaded.io(), .{});
    defer owner.core.deinit() catch unreachable;
    const id = try owner.core.createSession(.{});
    try owner.core.attachSessionRenderer(id, 4, 2, .{ .remote_mode = .remote });
    const root = try owner.core.sceneCreateNode(id, 0, 1);
    const child = try owner.core.sceneCreateNode(id, 1, 2);
    try owner.core.sceneMoveNode(child, root, 0);
    var probe: Probe = .{ .owner = &owner, .buffer = try owner.core.createBuffer(1, 1, .{}) };
    Probe.active = &probe;
    try owner.core.sceneSetMeasure(child, Probe.measure);
    const session_c = abi.handleToC(id);
    const root_c = abi.handleToC(root);
    try std.testing.expectEqual(c.OT_OK, ot_scene_measure_layout(&owner, &session_c, &root_c));
    try std.testing.expect(probe.calls > 0);
    try std.testing.expectEqual(true, probe.mutating);
    try std.testing.expectEqual(@as(?anyerror, error.ContextBusy), probe.rejection);
    try std.testing.expect(!owner.core.mutating and !owner.core.scene_measuring);
    try std.testing.expectEqual(@as(f32, 1), (try owner.core.sceneGetLayout(child, true)).height);
}

test "Context output ABI preserves outer mutation ownership on every rejection" {
    const ctx = @import("context.zig");
    var owner: abi.ContextHandle = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = undefined, .owner_thread = std.Thread.getCurrentId() };
    defer owner.io_threaded.deinit();
    owner.core = try ctx.Context.init(std.testing.allocator, owner.io_threaded.io(), .{});
    defer owner.core.deinit() catch unreachable;
    for ([_]bool{ false, true }) |busy| {
        if (busy) try owner.core.beginMutation();
        defer if (busy) {
            owner.core.mutating = false;
        };
        for (0..6) |operation| {
            const status = switch (operation) {
                0 => ot_scene_measure_layout(&owner, null, null),
                1 => ot_scene_frame_copy_buffer(&owner, null, null, null),
                2 => ot_session_render_split(&owner, null, null, null, 0, 0, 0, null, null),
                3 => ot_session_split_control(&owner, null, null, null),
                4 => ot_session_set_screen(&owner, null, 0, 0, 0, null, 0),
                5 => ot_session_sync_detached(&owner, null, null),
                else => unreachable,
            };
            try std.testing.expectEqual(if (busy) c.OT_CONTEXT_BUSY else c.OT_INVALID_ARGUMENT, status);
            try std.testing.expectEqual(busy, owner.core.mutating);
        }
    }
}

test "Context output ABI rejects malformed snapshot tables and controls without output writes" {
    const context: ?*abi.ContextHandle = try abi.createTestContext(.{ .object_capacity = 16, .render_cells_max = 16 });
    defer std.testing.expectEqual(c.OT_OK, abi.ot_context_destroy(context)) catch unreachable;
    const id = abi.handleToC(try context.?.core.createSession(.{}));
    try context.?.core.attachSessionRenderer(abi.handleFromC(id), 4, 2, .{ .remote_mode = .remote });
    var status: u32 = 99;
    var offset: u32 = 99;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_render_split(context, &id, null, null, 1, 0, 0, &status, &offset));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_render_split(context, &id, null, null, 0, 0, 2, &status, &offset));
    try std.testing.expectEqual(99, status);
    try std.testing.expectEqual(99, offset);
    var control = std.mem.zeroes(c.ot_split_control);
    control.struct_size = @sizeOf(c.ot_split_control);
    control.abi_version = c.OT_CONTEXT_ABI_VERSION;
    control.command = 5;
    control.arguments[0] = 1;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_split_control(context, &id, &control, &offset));
    try std.testing.expectEqual(99, offset);
    control.arguments[0] = 0;
    try std.testing.expectEqual(c.OT_OK, ot_session_split_control(context, &id, &control, &offset));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_set_screen(context, &id, 2, 4, 2, null, 0));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_set_screen(context, &id, 0, 5, 5, null, 0));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_set_screen(context, &id, 0, 4, 2, null, 1));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_set_screen(context, &id, 0, 4, 2, "x", session.control_packet_bytes_max + 1));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_sync_detached(context, &id, &id));
}

test "Context layout-only measurement validates ownership and preserves frame preparation" {
    const context: ?*abi.ContextHandle = try abi.createTestContext(.{ .object_capacity = 32, .render_cells_max = 64 });
    defer std.testing.expectEqual(c.OT_OK, abi.ot_context_destroy(context)) catch unreachable;
    const core = context.?.core;
    const id = try core.createSession(.{});
    try core.attachSessionRenderer(id, 4, 4, .{ .remote_mode = .remote });
    const root = try core.sceneCreateNode(id, 0, 1);
    const child = try core.sceneCreateNode(id, 1, 2);
    try core.sceneSetStyle(child, 4, 1, 0, 1, 2, 1);
    try core.sceneMoveNode(child, root, 0);
    try core.scenePaint(id, .{ 0, 0, 0, 255 }, false, 0);
    try core.sceneSetStyle(child, 4, 1, 0, 1, 3, 1);
    const session_c = abi.handleToC(id);
    const root_c = abi.handleToC(root);
    const child_c = abi.handleToC(child);
    const owned = (try core.getSession(id)).scene.?;
    const frame_id = owned.last_frame_id;
    try std.testing.expectEqual(c.OT_OK, ot_scene_measure_layout(context, &session_c, &root_c));
    try std.testing.expectEqual(@as(f32, 3), (try core.sceneGetLayout(child, true)).height);
    try std.testing.expectEqual(@as(f32, 2), (try core.sceneGetLayout(child, false)).height);
    try std.testing.expectEqual(frame_id, owned.last_frame_id);
    try std.testing.expect(owned.attempt == null and owned.painted == null);
    try core.scenePaint(id, .{ 0, 0, 0, 255 }, false, 0);
    try std.testing.expectEqual(@as(f32, 3), (try core.sceneGetLayout(child, false)).height);

    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_measure_layout(context, &session_c, &child_c));
    var stale = root_c;
    stale.generation += 1;
    try std.testing.expectEqual(c.OT_STALE_HANDLE, ot_scene_measure_layout(context, &session_c, &stale));
    const peer = try core.createSession(.{});
    try core.attachSessionRenderer(peer, 4, 4, .{ .remote_mode = .remote });
    const peer_root = abi.handleToC(try core.sceneCreateNode(peer, 0, 3));
    try std.testing.expectEqual(c.OT_WRONG_SESSION, ot_scene_measure_layout(context, &session_c, &peer_root));
    const frame = try core.sceneFrameStep(id, null, .{
        .background = .{ 0, 0, 0, 255 },
        .use_mouse = false,
        .excluded_hit_num = 0,
        .max_layout_rounds = 8,
        .max_host_requests = 65536,
    });
    try std.testing.expectEqual(c.OT_FRAME_BUSY, ot_scene_measure_layout(context, &session_c, &root_c));
    try core.sceneFrameCancel(id, frame.frame_id);
}
