const std = @import("std");
const c = @import("context_abi_c");
const abi = @import("context-abi.zig");
const audio = @import("audio.zig");
const ContextHandle = abi.ContextHandle;

fn fail(owner: *ContextHandle, status: c.ot_status) c.ot_status {
    owner.last_error = status;
    return status;
}

// Maps an audio.zig status. Only play's err_no_space means the voice limit.
fn result(owner: *ContextHandle, status: i32) c.ot_status {
    return switch (status) {
        audio.Status.ok => c.OT_OK,
        audio.Status.err_no_space => fail(owner, c.OT_OUT_OF_MEMORY),
        audio.Status.err_decode => fail(owner, c.OT_AUDIO_DECODE_FAILED),
        audio.Status.err_not_found => fail(owner, c.OT_STALE_HANDLE),
        audio.Status.err_device => fail(owner, c.OT_AUDIO_DEVICE_FAILED),
        else => fail(owner, c.OT_INVALID_ARGUMENT),
    };
}

// Resolves an engine for one call; on null, status holds the call's result.
fn acquire(context: ?*ContextHandle, id: ?*const c.ot_handle, status: *c.ot_status) ?*audio.Engine {
    status.* = abi.sessionContextStatus(context);
    if (status.* != c.OT_OK) return null;
    const owner = context.?;
    const handle = id orelse {
        status.* = fail(owner, c.OT_INVALID_ARGUMENT);
        return null;
    };
    return owner.core.raw().getAudioEngine(abi.handleFromC(handle.*)) catch |err| {
        status.* = abi.sessionError(owner, err);
        return null;
    };
}

// Rejects NaN too.
fn validVolume(volume: f32) bool {
    return volume >= 0 and volume <= 4;
}

pub fn ot_audio_create(context: ?*ContextHandle, out_ptr: ?*c.ot_handle) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const out = out_ptr orelse return fail(owner, c.OT_INVALID_ARGUMENT);
    // With default options, the engine fails only when an allocation fails.
    const handle = owner.core.createAudioEngine(null) catch |err|
        return abi.sessionError(owner, if (err == error.InvalidOptions) error.OutOfMemory else err);
    out.* = abi.handleToC(handle);
    return c.OT_OK;
}

pub fn ot_audio_destroy(context: ?*ContextHandle, id: ?*const c.ot_handle) callconv(.c) c.ot_status {
    return abi.destroyKind(context, id, .audio_engine);
}

pub fn ot_audio_start(context: ?*ContextHandle, id: ?*const c.ot_handle, flags: u32) callconv(.c) c.ot_status {
    var status: c.ot_status = undefined;
    const engine = acquire(context, id, &status) orelse return status;
    if (flags > c.OT_AUDIO_START_NO_DEVICE) return fail(context.?, c.OT_INVALID_ARGUMENT);
    if (flags != 0 and engine.has_device) return fail(context.?, c.OT_INVALID_PHASE);
    return result(context.?, if (flags == 0) audio.start(engine, null) else audio.startMixer(engine));
}

pub fn ot_audio_stop(context: ?*ContextHandle, id: ?*const c.ot_handle) callconv(.c) c.ot_status {
    var status: c.ot_status = undefined;
    const engine = acquire(context, id, &status) orelse return status;
    return result(context.?, audio.stop(engine));
}

pub fn ot_audio_load(context: ?*ContextHandle, id: ?*const c.ot_handle, bytes: ?[*]const u8, byte_count: u64, out_sound: ?*u32) callconv(.c) c.ot_status {
    var status: c.ot_status = undefined;
    const engine = acquire(context, id, &status) orelse return status;
    const count = std.math.cast(usize, byte_count) orelse return fail(context.?, c.OT_INVALID_ARGUMENT);
    return result(context.?, audio.load(engine, bytes, count, out_sound));
}

pub fn ot_audio_play(context: ?*ContextHandle, id: ?*const c.ot_handle, sound: u32, volume: f32, out_voice: ?*u32) callconv(.c) c.ot_status {
    var status: c.ot_status = undefined;
    const engine = acquire(context, id, &status) orelse return status;
    if (!validVolume(volume)) return fail(context.?, c.OT_INVALID_ARGUMENT);
    const options: audio.VoiceOptions = .{ .volume = volume, .pan = 0, .loop = false, .group_id = 0 };
    const played = audio.play(engine, sound, &options, out_voice);
    if (played == audio.Status.err_no_space) return fail(context.?, c.OT_OBJECT_LIMIT);
    return result(context.?, played);
}

pub fn ot_audio_stop_voice(context: ?*ContextHandle, id: ?*const c.ot_handle, voice: u32) callconv(.c) c.ot_status {
    var status: c.ot_status = undefined;
    const engine = acquire(context, id, &status) orelse return status;
    return result(context.?, audio.stopVoice(engine, voice));
}

pub fn ot_audio_set_volume(context: ?*ContextHandle, id: ?*const c.ot_handle, volume: f32) callconv(.c) c.ot_status {
    var status: c.ot_status = undefined;
    const engine = acquire(context, id, &status) orelse return status;
    if (!validVolume(volume)) return fail(context.?, c.OT_INVALID_ARGUMENT);
    return result(context.?, audio.setMasterVolume(engine, volume));
}

pub fn ot_audio_mix(context: ?*ContextHandle, id: ?*const c.ot_handle, samples: ?[*]f32, frame_count: u32, channels: u32) callconv(.c) c.ot_status {
    var status: c.ot_status = undefined;
    const engine = acquire(context, id, &status) orelse return status;
    if (channels != 1 and channels != 2) return fail(context.?, c.OT_INVALID_ARGUMENT);
    if (engine.has_device) return fail(context.?, c.OT_INVALID_PHASE);
    return result(context.?, audio.mixToBuffer(engine, samples, frame_count, @intCast(channels)));
}

test "Context audio ABI rejects the no-device mixer while a device plays" {
    const context = try abi.createTestContext(.{ .object_capacity = 1, .render_cells_max = 1 });
    defer std.testing.expectEqual(c.OT_OK, abi.ot_context_destroy(context)) catch unreachable;
    var id: c.ot_handle = undefined;
    try std.testing.expectEqual(c.OT_OK, ot_audio_create(context, &id));
    // The flag stands in for a started device; no device opens.
    const engine = try context.core.raw().getAudioEngine(abi.handleFromC(id));
    engine.has_device = true;
    defer engine.has_device = false;
    var samples: [2]f32 = undefined;
    try std.testing.expectEqual(c.OT_INVALID_PHASE, ot_audio_mix(context, &id, &samples, 1, 2));
    try std.testing.expectEqual(c.OT_INVALID_PHASE, ot_audio_start(context, &id, c.OT_AUDIO_START_NO_DEVICE));
}

test "Context audio ABI maps every engine status" {
    const context = try abi.createTestContext(.{ .object_capacity = 1, .render_cells_max = 1 });
    defer std.testing.expectEqual(c.OT_OK, abi.ot_context_destroy(context)) catch unreachable;
    for ([_]struct { i32, c.ot_status }{
        .{ audio.Status.ok, c.OT_OK },
        .{ audio.Status.err_invalid, c.OT_INVALID_ARGUMENT },
        .{ audio.Status.err_no_space, c.OT_OUT_OF_MEMORY },
        .{ audio.Status.err_decode, c.OT_AUDIO_DECODE_FAILED },
        .{ audio.Status.err_not_found, c.OT_STALE_HANDLE },
        .{ audio.Status.err_device, c.OT_AUDIO_DEVICE_FAILED },
    }) |row| {
        context.last_error = c.OT_OK;
        try std.testing.expectEqual(row[1], result(context, row[0]));
        try std.testing.expectEqual(row[1], context.last_error);
    }
}
