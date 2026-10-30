const std = @import("std");
const c = @import("context_abi_c");
const abi = @import("context-abi.zig");
const video = @import("video.zig");
const ContextHandle = abi.ContextHandle;

fn failure(owner: *ContextHandle, err: anyerror) c.ot_status {
    const status: c.ot_status = switch (err) {
        error.InvalidArgument => c.OT_INVALID_ARGUMENT,
        error.OpenFailed, error.DecodeFailed, error.SeekFailed, error.VideoFailed => c.OT_VIDEO_FAILED,
        error.NoPlayer => c.OT_INVALID_PHASE,
        else => return abi.sessionError(owner, err),
    };
    owner.last_error = status;
    return status;
}

// Admits a call on one node; a nonzero status is the call's result.
fn admit(context: ?*ContextHandle, node: ?*const c.ot_handle, out: *@import("context-handles.zig").Handle) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const id = node orelse return failure(context.?, error.InvalidArgument);
    out.* = abi.handleFromC(id.*);
    return c.OT_OK;
}

fn control(context: ?*ContextHandle, node: ?*const c.ot_handle, comptime operation: anytype, args: anytype) c.ot_status {
    var handle: @import("context-handles.zig").Handle = undefined;
    const admitted = admit(context, node, &handle);
    if (admitted != c.OT_OK) return admitted;
    const owner = context.?;
    owner.core.videoControl(handle, operation, args) catch |err| return failure(owner, err);
    return c.OT_OK;
}

pub fn ot_scene_set_video(context: ?*ContextHandle, node: ?*const c.ot_handle, fit: u32, buffer_ptr: ?*const c.ot_handle) callconv(.c) c.ot_status {
    var handle: @import("context-handles.zig").Handle = undefined;
    const admitted = admit(context, node, &handle);
    if (admitted != c.OT_OK) return admitted;
    const owner = context.?;
    if (fit > c.OT_IMAGE_FILL) return abi.sessionError(owner, error.InvalidOptions);
    owner.core.sceneSetVideo(handle, @fromBackingInt(@intCast(fit)), if (buffer_ptr) |id| abi.handleFromC(id.*) else null) catch |err|
        return abi.sessionError(owner, err);
    return c.OT_OK;
}

pub fn ot_video_open(context: ?*ContextHandle, node: ?*const c.ot_handle, path: ?[*]const u8, path_length: u32, flags: u32, out_ptr: ?*c.ot_video_info) callconv(.c) c.ot_status {
    var handle: @import("context-handles.zig").Handle = undefined;
    const admitted = admit(context, node, &handle);
    if (admitted != c.OT_OK) return admitted;
    const owner = context.?;
    const out = out_ptr orelse return failure(owner, error.InvalidArgument);
    if (path_length != 0 and path == null) return failure(owner, error.InvalidArgument);
    if (flags > c.OT_VIDEO_OPEN_NO_AUDIO) return failure(owner, error.InvalidArgument);
    const bytes: []const u8 = if (path_length == 0) &.{} else path.?[0..path_length];
    const info = owner.core.videoOpen(handle, bytes, flags == 0) catch |err| return failure(owner, err);
    out.* = .{
        .duration_us = info.duration_us,
        .width = info.width,
        .height = info.height,
        .fps_num = info.fps_num,
        .fps_den = info.fps_den,
        .has_audio = info.has_audio,
        .reserved = 0,
    };
    return c.OT_OK;
}

pub fn ot_video_play(context: ?*ContextHandle, node: ?*const c.ot_handle) callconv(.c) c.ot_status {
    return control(context, node, video.Player.play, .{});
}

pub fn ot_video_pause(context: ?*ContextHandle, node: ?*const c.ot_handle) callconv(.c) c.ot_status {
    return control(context, node, video.Player.pause, .{});
}

pub fn ot_video_seek(context: ?*ContextHandle, node: ?*const c.ot_handle, time_us: i64) callconv(.c) c.ot_status {
    return control(context, node, video.Player.seek, .{time_us});
}

pub fn ot_video_set_loop(context: ?*ContextHandle, node: ?*const c.ot_handle, loop: u32) callconv(.c) c.ot_status {
    if (loop > 1) return control(context, node, rejectArgument, .{});
    return control(context, node, video.Player.setLoop, .{loop != 0});
}

pub fn ot_video_set_muted(context: ?*ContextHandle, node: ?*const c.ot_handle, muted: u32) callconv(.c) c.ot_status {
    if (muted > 1) return control(context, node, rejectArgument, .{});
    return control(context, node, video.Player.setMuted, .{muted != 0});
}

pub fn ot_video_set_volume(context: ?*ContextHandle, node: ?*const c.ot_handle, volume: f32) callconv(.c) c.ot_status {
    return control(context, node, video.Player.setVolume, .{volume});
}

pub fn ot_video_set_av_sync_offset(context: ?*ContextHandle, node: ?*const c.ot_handle, offset_us: i64) callconv(.c) c.ot_status {
    return control(context, node, video.Player.setAvSyncOffset, .{offset_us});
}

pub fn ot_video_set_max_fps(context: ?*ContextHandle, node: ?*const c.ot_handle, fps: u32) callconv(.c) c.ot_status {
    return control(context, node, video.Player.setMaxFps, .{fps});
}

fn rejectArgument(_: *video.Player) !void {
    return error.InvalidArgument;
}

pub fn ot_video_get_state(context: ?*ContextHandle, node: ?*const c.ot_handle, out_ptr: ?*c.ot_video_state) callconv(.c) c.ot_status {
    var handle: @import("context-handles.zig").Handle = undefined;
    const admitted = admit(context, node, &handle);
    if (admitted != c.OT_OK) return admitted;
    const owner = context.?;
    const out = out_ptr orelse return failure(owner, error.InvalidArgument);
    const state = owner.core.videoGetState(handle) catch |err| return failure(owner, err);
    var flags: u32 = 0;
    if (state.playing) flags |= c.OT_VIDEO_PLAYING;
    if (state.ended) flags |= c.OT_VIDEO_ENDED;
    if (state.buffering) flags |= c.OT_VIDEO_BUFFERING;
    if (state.audio) flags |= c.OT_VIDEO_AUDIO;
    if (state.has_frame) flags |= c.OT_VIDEO_HAS_FRAME;
    if (state.failed) flags |= c.OT_VIDEO_ERROR;
    out.* = .{ .current_time_us = state.current_time_us, .frame_pts_us = state.frame_pts_us, .flags = flags, .quality_tier = state.quality_tier };
    return c.OT_OK;
}

pub fn ot_video_get_error(context: ?*ContextHandle, node: ?*const c.ot_handle, bytes_ptr: ?[*]u8, capacity: u32, out_count_ptr: ?*u32) callconv(.c) c.ot_status {
    var handle: @import("context-handles.zig").Handle = undefined;
    const admitted = admit(context, node, &handle);
    if (admitted != c.OT_OK) return admitted;
    const owner = context.?;
    const out = out_count_ptr orelse return failure(owner, error.InvalidArgument);
    if (capacity != 0 and bytes_ptr == null) return failure(owner, error.InvalidArgument);
    const message = owner.core.videoGetError(handle) catch |err| return failure(owner, err);
    const count = std.math.cast(u32, message.len) orelse return failure(owner, error.InvalidArgument);
    if (capacity != 0) {
        if (capacity < count) return failure(owner, error.BufferTooSmall);
        @memcpy(bytes_ptr.?[0..count], message);
    }
    out.* = count;
    return c.OT_OK;
}

test "Context video ABI checks nodes arguments and reports failures" {
    const context: ?*ContextHandle = try abi.createTestContext(.{ .object_capacity = 16, .render_cells_max = 16 });
    defer std.testing.expectEqual(c.OT_OK, abi.ot_context_destroy(context)) catch unreachable;
    const core = context.?.core;
    const session = try core.createSession(.{});
    const session_c = abi.handleToC(session);
    try core.attachSessionRenderer(session, 2, 1, .{ .remote_mode = .local });
    _ = try core.sceneCreateNode(session, c.OT_SCENE_ROOT, 1);
    var node = std.mem.zeroes(c.ot_handle);
    var box = std.mem.zeroes(c.ot_handle);
    try std.testing.expectEqual(c.OT_OK, abi.ot_scene_create_node(context, &session_c, c.OT_SCENE_VIDEO, 2, &node));
    try std.testing.expectEqual(c.OT_OK, abi.ot_scene_create_node(context, &session_c, c.OT_SCENE_BOX, 3, &box));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, abi.ot_scene_create_node(context, &session_c, c.OT_SCENE_VIDEO + 1, 4, &box));

    try std.testing.expectEqual(c.OT_OK, ot_scene_set_video(context, &node, c.OT_IMAGE_COVER, null));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_video(context, &node, c.OT_IMAGE_FILL + 1, null));
    try std.testing.expectEqual(c.OT_WRONG_KIND, ot_scene_set_video(context, &box, c.OT_IMAGE_FIT, null));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_video(null, &node, c.OT_IMAGE_FIT, null));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_set_video(context, null, c.OT_IMAGE_FIT, null));
    // A crop is all zero, for the whole source, or has a positive size.
    for ([_]struct { [4]u32, c.ot_status }{
        .{ .{ 0, 0, 0, 0 }, c.OT_OK },
        .{ .{ 3, 5, 1, 1 }, c.OT_OK },
        .{ .{ 0, 0, 0, 1 }, c.OT_INVALID_ARGUMENT },
        .{ .{ 0, 0, 1, 0 }, c.OT_INVALID_ARGUMENT },
        .{ .{ 1, 0, 0, 0 }, c.OT_INVALID_ARGUMENT },
        .{ .{ 0, 1, 0, 0 }, c.OT_INVALID_ARGUMENT },
    }) |row| {
        const crop = row[0];
        try std.testing.expectEqual(row[1], abi.ot_scene_set_crop(context, &node, crop[0], crop[1], crop[2], crop[3]));
    }

    var info: c.ot_video_info = undefined;
    const missing = "../core/src/tests/fixtures/video/missing.mp4";
    try std.testing.expectEqual(c.OT_VIDEO_FAILED, ot_video_open(context, &node, missing, missing.len, 0, &info));
    var count: u32 = 0;
    try std.testing.expectEqual(c.OT_OK, ot_video_get_error(context, &node, null, 0, &count));
    try std.testing.expect(count > 8);
    var short: [8]u8 = @splat(0xaa);
    var unchanged: u32 = 7;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_video_get_error(context, &node, &short, short.len, &unchanged));
    try std.testing.expectEqual(@as(u32, 7), unchanged);
    try std.testing.expectEqualSlices(u8, &@as([8]u8, @splat(0xaa)), &short);
    var detail: [512]u8 = undefined;
    var copied: u32 = 0;
    try std.testing.expectEqual(c.OT_OK, ot_video_get_error(context, &node, &detail, detail.len, &copied));
    try std.testing.expectEqual(count, copied);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_video_get_error(context, &node, null, 1, &count));
    try std.testing.expectEqual(c.OT_INVALID_PHASE, ot_video_play(context, &node));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_video_open(context, &node, null, 1, 0, &info));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_video_open(context, &node, missing, missing.len, 0, null));
    try std.testing.expectEqual(c.OT_WRONG_KIND, ot_video_open(context, &box, missing, missing.len, 0, &info));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_video_open(context, &node, missing, missing.len, 2, &info));

    // A source with an audio track gets an audio engine, unless the open asks for no audio.
    const asset = "../core/src/tests/fixtures/video/testsrc-160x90-24fps-2s.mp4";
    const video_state = &(try core.raw().getRenderable(abi.handleFromC(node))).scene_node.?.control.video;
    try std.testing.expectEqual(c.OT_OK, ot_video_open(context, &node, asset, asset.len, 0, &info));
    try std.testing.expect(video_state.player.?.video.audio_engine != null);
    try std.testing.expectEqual(c.OT_OK, ot_video_open(context, &node, asset, asset.len, c.OT_VIDEO_OPEN_NO_AUDIO, &info));
    try std.testing.expectEqual(@as(u32, 1), info.has_audio);
    try std.testing.expect(video_state.player.?.video.audio_engine == null);
    try std.testing.expectEqual(@as(u32, 160), info.width);
    try std.testing.expectEqual(@as(u32, 24), info.fps_num / info.fps_den);
    try std.testing.expectEqual(c.OT_OK, ot_video_set_loop(context, &node, 1));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_video_set_loop(context, &node, 2));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_video_set_muted(context, &node, 2));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_video_set_volume(context, &node, -1));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_video_set_av_sync_offset(context, &node, std.math.maxInt(i64)));
    try std.testing.expectEqual(c.OT_OK, ot_video_set_av_sync_offset(context, &node, -40_000));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_video_set_max_fps(context, &node, 0));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_video_set_max_fps(context, &node, 121));
    try std.testing.expectEqual(c.OT_OK, ot_video_set_max_fps(context, &node, 12));
    try std.testing.expectEqual(c.OT_OK, ot_video_seek(context, &node, 500_000));
    var state: c.ot_video_state = undefined;
    try std.testing.expectEqual(c.OT_OK, ot_video_get_state(context, &node, &state));
    try std.testing.expectEqual(@as(i64, 500_000), state.current_time_us);
    try std.testing.expectEqual(@as(u32, 0), state.flags & c.OT_VIDEO_PLAYING);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_video_get_state(context, &node, null));
    core.mutating = true;
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_video_pause(context, &node));
    core.mutating = false;
    // An empty path closes the player.
    try std.testing.expectEqual(c.OT_OK, ot_video_open(context, &node, null, 0, 0, &info));
    try std.testing.expectEqual(c.OT_INVALID_PHASE, ot_video_get_state(context, &node, &state));
}
