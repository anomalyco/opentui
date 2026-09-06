const compat = &@import("compatibility-context.zig").compatDefault;
const registry = &compat.registry;
const globalAllocator = compat.gpa.allocator();
const NativeHandle = @import("handles.zig").Handle;
const INVALID_HANDLE: NativeHandle = 0;
const native_audio = @import("audio.zig");

fn acquireAudioEngine(handle: NativeHandle) ?*native_audio.Engine {
    return registry.acquire(handle, .audio_engine, native_audio.Engine);
}

export fn createAudioEngine(options_ptr: ?*const native_audio.CreateOptions) NativeHandle {
    const engine = native_audio.create(globalAllocator, options_ptr) orelse return INVALID_HANDLE;
    return registry.insert(.audio_engine, @ptrCast(engine)) catch {
        native_audio.destroy(engine);
        return INVALID_HANDLE;
    };
}

export fn destroyAudioEngine(engine_handle: NativeHandle) void {
    const token = registry.beginDestroy(engine_handle, .audio_engine, native_audio.Engine) orelse return;
    native_audio.destroy(token.ptr);
    registry.finishDestroy(token.handle);
}

export fn audioRefreshPlaybackDevices(engine_handle: NativeHandle) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.refreshPlaybackDevices(object_ptr);
}

export fn audioGetPlaybackDeviceCount(engine_handle: NativeHandle) u32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return 0;
    return native_audio.getPlaybackDeviceCount(object_ptr);
}

export fn audioGetPlaybackDeviceName(engine_handle: NativeHandle, index: u32, out_ptr: [*]u8, max_len: u32) u32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return 0;
    return @intCast(native_audio.getPlaybackDeviceName(object_ptr, index, out_ptr, @as(usize, max_len)));
}

export fn audioIsPlaybackDeviceDefault(engine_handle: NativeHandle, index: u32) bool {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return false;
    return native_audio.isPlaybackDeviceDefault(object_ptr, index);
}

export fn audioSelectPlaybackDevice(engine_handle: NativeHandle, index: u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.selectPlaybackDevice(object_ptr, index);
}

export fn audioClearPlaybackDeviceSelection(engine_handle: NativeHandle) void {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return;
    native_audio.clearPlaybackDeviceSelection(object_ptr);
}

export fn audioRefreshCaptureDevices(engine_handle: NativeHandle) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.refreshCaptureDevices(object_ptr);
}

export fn audioGetCaptureDeviceCount(engine_handle: NativeHandle) u32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return 0;
    return native_audio.getCaptureDeviceCount(object_ptr);
}

export fn audioGetCaptureDeviceName(engine_handle: NativeHandle, index: u32, out_ptr: [*]u8, max_len: u32) u32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return 0;
    return @intCast(native_audio.getCaptureDeviceName(object_ptr, index, out_ptr, @as(usize, max_len)));
}

export fn audioIsCaptureDeviceDefault(engine_handle: NativeHandle, index: u32) bool {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return false;
    return native_audio.isCaptureDeviceDefault(object_ptr, index);
}

export fn audioSelectCaptureDevice(engine_handle: NativeHandle, index: u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.selectCaptureDevice(object_ptr, index);
}

export fn audioClearCaptureDeviceSelection(engine_handle: NativeHandle) void {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return;
    native_audio.clearCaptureDeviceSelection(object_ptr);
}

export fn audioStartCapture(
    engine_handle: NativeHandle,
    options_ptr: ?*const native_audio.StartOptions,
    channels: u32,
    capacity_frames: u32,
) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.startCapture(object_ptr, options_ptr, channels, capacity_frames);
}

export fn audioStopCapture(engine_handle: NativeHandle) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.stopCapture(object_ptr);
}

export fn audioIsCaptureRunning(engine_handle: NativeHandle) bool {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return false;
    return native_audio.isCaptureRunning(object_ptr);
}

export fn audioReadCapture(
    engine_handle: NativeHandle,
    out_ptr: ?[*]f32,
    out_sample_capacity: u32,
    frame_count: u32,
    out_frames_read: ?*u32,
) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.readCapture(object_ptr, out_ptr, out_sample_capacity, frame_count, out_frames_read);
}

export fn audioGetCaptureStats(engine_handle: NativeHandle, out_stats: ?*native_audio.CaptureStats) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.getCaptureStats(object_ptr, out_stats);
}

export fn audioStart(engine_handle: NativeHandle, options_ptr: ?*const native_audio.StartOptions) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.start(object_ptr, options_ptr);
}

export fn audioStartMixer(engine_handle: NativeHandle) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.startMixer(object_ptr);
}

export fn audioStop(engine_handle: NativeHandle) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.stop(object_ptr);
}

export fn audioCreateStream(
    engine_handle: NativeHandle,
    options_ptr: ?*const native_audio.StreamOptions,
    out_stream_id: ?*u32,
) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.createStream(object_ptr, options_ptr, out_stream_id);
}

export fn audioWriteStream(
    engine_handle: NativeHandle,
    stream_id: u32,
    data_ptr: ?[*]const u8,
    data_len: u32,
) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.writeStream(object_ptr, stream_id, data_ptr, data_len);
}

export fn audioEndStream(engine_handle: NativeHandle, stream_id: u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.endStream(object_ptr, stream_id);
}

export fn audioRestartStream(engine_handle: NativeHandle, stream_id: u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.restartStream(object_ptr, stream_id);
}

export fn audioSetStreamVolume(engine_handle: NativeHandle, stream_id: u32, volume: f32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.setStreamVolume(object_ptr, stream_id, volume);
}

export fn audioSetStreamPan(engine_handle: NativeHandle, stream_id: u32, pan: f32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.setStreamPan(object_ptr, stream_id, pan);
}

export fn audioSetStreamGroup(engine_handle: NativeHandle, stream_id: u32, group_id: u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.setStreamGroup(object_ptr, stream_id, group_id);
}

export fn audioGetStreamStats(engine_handle: NativeHandle, stream_id: u32, out_stats: ?*native_audio.StreamStats) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.getStreamStats(object_ptr, stream_id, out_stats);
}

export fn audioCloseStream(
    engine_handle: NativeHandle,
    stream_id: u32,
    reason: u32,
    out_final_stats: ?*native_audio.StreamStats,
) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.closeStream(object_ptr, stream_id, reason, out_final_stats);
}

export fn audioLoad(engine_handle: NativeHandle, data_ptr: ?[*]const u8, data_len: u32, out_sound_id: ?*u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.load(object_ptr, data_ptr, @as(usize, data_len), out_sound_id);
}

export fn audioUnload(engine_handle: NativeHandle, sound_id: u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.unload(object_ptr, sound_id);
}

export fn audioPlay(engine_handle: NativeHandle, sound_id: u32, options_ptr: ?*const native_audio.VoiceOptions, out_voice_id: ?*u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.play(object_ptr, sound_id, options_ptr, out_voice_id);
}

export fn audioStopVoice(engine_handle: NativeHandle, voice_id: u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.stopVoice(object_ptr, voice_id);
}

export fn audioSetVoiceGroup(engine_handle: NativeHandle, voice_id: u32, group_id: u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.setVoiceGroup(object_ptr, voice_id, group_id);
}

export fn audioCreateGroup(engine_handle: NativeHandle, name_ptr: ?[*]const u8, name_len: u32, out_group_id: ?*u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.createGroup(object_ptr, name_ptr, @as(usize, name_len), out_group_id);
}

export fn audioSetGroupVolume(engine_handle: NativeHandle, group_id: u32, volume: f32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.setGroupVolume(object_ptr, group_id, volume);
}

export fn audioSetMasterVolume(engine_handle: NativeHandle, volume: f32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.setMasterVolume(object_ptr, volume);
}

export fn audioMixToBuffer(engine_handle: NativeHandle, out_ptr: ?[*]f32, frame_count: u32, channels: u8) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.mixToBuffer(object_ptr, out_ptr, frame_count, channels);
}

export fn audioEnableTap(engine_handle: NativeHandle, enabled: u8, capacity_frames: u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.enableTap(object_ptr, enabled == 1, capacity_frames);
}

export fn audioReadTap(engine_handle: NativeHandle, out_ptr: ?[*]f32, frame_count: u32, channels: u8, out_frames_read: ?*u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.readTap(object_ptr, out_ptr, frame_count, channels, out_frames_read);
}

export fn audioGetStats(engine_handle: NativeHandle, out_stats: ?*native_audio.Stats) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.getStats(object_ptr, out_stats);
}
