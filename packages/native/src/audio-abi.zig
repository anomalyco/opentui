const c = @import("context_abi_c");
const abi = @import("context-abi.zig");
const ContextHandle = abi.ContextHandle;
const native_audio = @import("audio.zig");

fn acquireAudioEngine(context: ?*ContextHandle) ?*native_audio.Engine {
    if (abi.sessionContextStatus(context) != c.OT_OK) return null;
    var cursor: usize = 0;
    const handle = context.?.core.objects.next(.audio_engine, &cursor) orelse return null;
    return context.?.core.raw().getAudioEngine(handle) catch |err| {
        _ = abi.sessionError(context.?, err);
        return null;
    };
}

export fn createAudioEngine(context: ?*ContextHandle, options_ptr: ?*const native_audio.CreateOptions) i32 {
    if (abi.sessionContextStatus(context) != c.OT_OK) return native_audio.Status.err_invalid;
    _ = context.?.core.createAudioEngine(options_ptr) catch return native_audio.Status.err_invalid;
    return native_audio.Status.ok;
}

export fn audioRefreshPlaybackDevices(context: ?*ContextHandle) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.refreshPlaybackDevices(object_ptr);
}

export fn audioGetPlaybackDeviceCount(context: ?*ContextHandle) u32 {
    const object_ptr = acquireAudioEngine(context) orelse return 0;
    return native_audio.getPlaybackDeviceCount(object_ptr);
}

export fn audioGetPlaybackDeviceName(context: ?*ContextHandle, index: u32, out_ptr: [*]u8, max_len: u32) u32 {
    const object_ptr = acquireAudioEngine(context) orelse return 0;
    return @intCast(native_audio.getPlaybackDeviceName(object_ptr, index, out_ptr, @as(usize, max_len)));
}

export fn audioIsPlaybackDeviceDefault(context: ?*ContextHandle, index: u32) bool {
    const object_ptr = acquireAudioEngine(context) orelse return false;
    return native_audio.isPlaybackDeviceDefault(object_ptr, index);
}

export fn audioSelectPlaybackDevice(context: ?*ContextHandle, index: u32) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.selectPlaybackDevice(object_ptr, index);
}

export fn audioClearPlaybackDeviceSelection(context: ?*ContextHandle) void {
    const object_ptr = acquireAudioEngine(context) orelse return;
    native_audio.clearPlaybackDeviceSelection(object_ptr);
}

export fn audioRefreshCaptureDevices(context: ?*ContextHandle) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.refreshCaptureDevices(object_ptr);
}

export fn audioGetCaptureDeviceCount(context: ?*ContextHandle) u32 {
    const object_ptr = acquireAudioEngine(context) orelse return 0;
    return native_audio.getCaptureDeviceCount(object_ptr);
}

export fn audioGetCaptureDeviceName(context: ?*ContextHandle, index: u32, out_ptr: [*]u8, max_len: u32) u32 {
    const object_ptr = acquireAudioEngine(context) orelse return 0;
    return @intCast(native_audio.getCaptureDeviceName(object_ptr, index, out_ptr, @as(usize, max_len)));
}

export fn audioIsCaptureDeviceDefault(context: ?*ContextHandle, index: u32) bool {
    const object_ptr = acquireAudioEngine(context) orelse return false;
    return native_audio.isCaptureDeviceDefault(object_ptr, index);
}

export fn audioSelectCaptureDevice(context: ?*ContextHandle, index: u32) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.selectCaptureDevice(object_ptr, index);
}

export fn audioClearCaptureDeviceSelection(context: ?*ContextHandle) void {
    const object_ptr = acquireAudioEngine(context) orelse return;
    native_audio.clearCaptureDeviceSelection(object_ptr);
}

export fn audioStartCapture(
    context: ?*ContextHandle,
    options_ptr: ?*const native_audio.StartOptions,
    channels: u32,
    capacity_frames: u32,
) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.startCapture(object_ptr, options_ptr, channels, capacity_frames);
}

export fn audioStopCapture(context: ?*ContextHandle) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.stopCapture(object_ptr);
}

export fn audioIsCaptureRunning(context: ?*ContextHandle) bool {
    const object_ptr = acquireAudioEngine(context) orelse return false;
    return native_audio.isCaptureRunning(object_ptr);
}

export fn audioReadCapture(
    context: ?*ContextHandle,
    out_ptr: ?[*]f32,
    out_sample_capacity: u32,
    frame_count: u32,
    out_frames_read: ?*u32,
) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.readCapture(object_ptr, out_ptr, out_sample_capacity, frame_count, out_frames_read);
}

export fn audioGetCaptureStats(context: ?*ContextHandle, out_stats: ?*native_audio.CaptureStats) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.getCaptureStats(object_ptr, out_stats);
}

export fn audioStart(context: ?*ContextHandle, options_ptr: ?*const native_audio.StartOptions) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.start(object_ptr, options_ptr);
}

export fn audioStartMixer(context: ?*ContextHandle) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.startMixer(object_ptr);
}

export fn audioStop(context: ?*ContextHandle) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.stop(object_ptr);
}

export fn audioCreateStream(
    context: ?*ContextHandle,
    options_ptr: ?*const native_audio.StreamOptions,
    out_stream_id: ?*u32,
) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.createStream(object_ptr, options_ptr, out_stream_id);
}

export fn audioWriteStream(
    context: ?*ContextHandle,
    stream_id: u32,
    data_ptr: ?[*]const u8,
    data_len: u32,
) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.writeStream(object_ptr, stream_id, data_ptr, data_len);
}

export fn audioEndStream(context: ?*ContextHandle, stream_id: u32) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.endStream(object_ptr, stream_id);
}

export fn audioRestartStream(context: ?*ContextHandle, stream_id: u32) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.restartStream(object_ptr, stream_id);
}

export fn audioSetStreamVolume(context: ?*ContextHandle, stream_id: u32, volume: f32) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.setStreamVolume(object_ptr, stream_id, volume);
}

export fn audioSetStreamPan(context: ?*ContextHandle, stream_id: u32, pan: f32) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.setStreamPan(object_ptr, stream_id, pan);
}

export fn audioSetStreamGroup(context: ?*ContextHandle, stream_id: u32, group_id: u32) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.setStreamGroup(object_ptr, stream_id, group_id);
}

export fn audioGetStreamStats(context: ?*ContextHandle, stream_id: u32, out_stats: ?*native_audio.StreamStats) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.getStreamStats(object_ptr, stream_id, out_stats);
}

export fn audioCloseStream(
    context: ?*ContextHandle,
    stream_id: u32,
    reason: u32,
    out_final_stats: ?*native_audio.StreamStats,
) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.closeStream(object_ptr, stream_id, reason, out_final_stats);
}

export fn audioLoad(context: ?*ContextHandle, data_ptr: ?[*]const u8, data_len: u32, out_sound_id: ?*u32) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.load(object_ptr, data_ptr, @as(usize, data_len), out_sound_id);
}

export fn audioUnload(context: ?*ContextHandle, sound_id: u32) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.unload(object_ptr, sound_id);
}

export fn audioPlay(context: ?*ContextHandle, sound_id: u32, options_ptr: ?*const native_audio.VoiceOptions, out_voice_id: ?*u32) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.play(object_ptr, sound_id, options_ptr, out_voice_id);
}

export fn audioStopVoice(context: ?*ContextHandle, voice_id: u32) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.stopVoice(object_ptr, voice_id);
}

export fn audioSetVoiceGroup(context: ?*ContextHandle, voice_id: u32, group_id: u32) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.setVoiceGroup(object_ptr, voice_id, group_id);
}

export fn audioCreateGroup(context: ?*ContextHandle, name_ptr: ?[*]const u8, name_len: u32, out_group_id: ?*u32) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.createGroup(object_ptr, name_ptr, @as(usize, name_len), out_group_id);
}

export fn audioSetGroupVolume(context: ?*ContextHandle, group_id: u32, volume: f32) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.setGroupVolume(object_ptr, group_id, volume);
}

export fn audioSetMasterVolume(context: ?*ContextHandle, volume: f32) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.setMasterVolume(object_ptr, volume);
}

export fn audioMixToBuffer(context: ?*ContextHandle, out_ptr: ?[*]f32, frame_count: u32, channels: u8) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.mixToBuffer(object_ptr, out_ptr, frame_count, channels);
}

export fn audioEnableTap(context: ?*ContextHandle, enabled: u8, capacity_frames: u32) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.enableTap(object_ptr, enabled == 1, capacity_frames);
}

export fn audioReadTap(context: ?*ContextHandle, out_ptr: ?[*]f32, frame_count: u32, channels: u8, out_frames_read: ?*u32) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.readTap(object_ptr, out_ptr, frame_count, channels, out_frames_read);
}

export fn audioGetStats(context: ?*ContextHandle, out_stats: ?*native_audio.Stats) i32 {
    const object_ptr = acquireAudioEngine(context) orelse return native_audio.Status.err_invalid;
    return native_audio.getStats(object_ptr, out_stats);
}
