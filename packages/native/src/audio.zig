const std = @import("std");
const builtin = @import("builtin");
const c = @import("miniaudio");
const io = if (builtin.is_test) std.testing.io else @import("root").io;

pub const Status = struct {
    pub const ok: i32 = 0;
    pub const err_invalid: i32 = -1;
    pub const err_no_space: i32 = -2;
    pub const err_decode: i32 = -3;
    pub const err_not_found: i32 = -4;
    pub const err_device: i32 = -5;
};

pub const max_voices: usize = 32;
pub const default_sample_rate: u32 = 48_000;
pub const default_playback_channels: u32 = 2;
pub const max_capture_channels: u32 = @intCast(c.MA_MAX_CHANNELS);
const stream_input_capacity: u32 = 256 * 1024;
// Bounds endless invalid input during decoder setup; StreamOptions can raise it for valid metadata.
pub const default_stream_probe_bytes: u32 = 1024 * 1024;
const stream_decoder_chunk_frames: u32 = 2_048;
pub const min_pcm_sample_rate: u32 = 8_000;
pub const max_pcm_sample_rate: u32 = 192_000;
// Coalesce tiny transport fragments without waiting for miniaudio's full decoder read request.
const stream_decoder_read_granularity: usize = 2 * 1024;
const max_stream_generation: u32 = 0x00ffffff;
const stream_channels: u32 = 2;
const stream_bytes_per_frame: u32 = stream_channels * @sizeOf(f32);
const max_stream_ring_bytes: u32 = 0x7fffffff - (@as(u32, c.MA_SIMD_ALIGNMENT) - 1);
pub const max_stream_pcm_capacity_frames: u32 = max_stream_ring_bytes / stream_bytes_per_frame;
const max_capture_ring_bytes: usize = 0x7fffffff - (@as(usize, c.MA_SIMD_ALIGNMENT) - 1);

pub const CreateOptions = extern struct {
    sample_rate: u32 = default_sample_rate,
    playback_channels: u32 = default_playback_channels,
};

pub const StartOptions = extern struct {
    period_size_in_frames: u32 = 0,
    period_size_in_milliseconds: u32 = 0,
    periods: u32 = 0,
    performance_profile: u8 = 0,
    share_mode: u8 = 0,
    no_pre_silenced_output_buffer: bool = false,
    no_clip: bool = false,
    no_disable_denormals: bool = false,
    no_fixed_sized_callback: bool = false,
    wasapi_no_auto_convert_src: bool = false,
    wasapi_no_default_quality_src: bool = false,
    alsa_no_mmap: bool = false,
    alsa_no_auto_format: bool = false,
    alsa_no_auto_channels: bool = false,
    alsa_no_auto_resample: bool = false,
};

pub const VoiceOptions = extern struct {
    volume: f32,
    pan: f32,
    loop: bool,
    group_id: u32,
};

pub const StreamOptions = extern struct {
    capacity_ms: u32,
    startup_ms: u32,
    resume_ms: u32,
    volume: f32,
    pan: f32,
    group_id: u32,
    // Append fields so newer bindings preserve the previous native prefix during local rebuilds.
    max_probe_bytes: u32 = default_stream_probe_bytes,
    format: u32 = StreamFormat.mp3,
    sample_rate: u32 = 0,
    channels: u32 = 0,
};

pub const StreamFormat = struct {
    pub const mp3: u32 = 1;
    pub const flac: u32 = 2;
    pub const pcm: u32 = 3;
};

pub const StreamState = struct {
    pub const initializing: u32 = 0;
    pub const buffering: u32 = 1;
    pub const playing: u32 = 2;
    pub const ended: u32 = 3;
    pub const failed: u32 = 4;
    pub const cancelled: u32 = 5;
    pub const reconnecting: u32 = 6;
};

pub const StreamStats = extern struct {
    bytes_received: u64,
    frames_decoded: u64,
    frames_played: u64,
    state: u32,
    sample_rate: u32,
    channels: u32,
    buffered_frames: u32,
    capacity_frames: u32,
    underruns: u32,
    error_code: i32,
    ready_generation: u32,
};

pub const StreamCloseReason = struct {
    pub const preserve_native_terminal: u32 = 0;
    pub const transport_error: u32 = 1;
    pub const disposed: u32 = 2;
};

pub const Stats = extern struct {
    sounds_loaded: u32,
    voices_active: u32,
    frames_mixed: u64,
    lock_misses: u32,
    last_peak: f32,
    last_rms: f32,
};

pub const CaptureStats = extern struct {
    frames_received: u64,
    frames_read: u64,
    frames_dropped: u64,
    sample_rate: u32,
    channels: u32,
    buffered_frames: u32,
    capacity_frames: u32,
};

fn captureSampleCount(channels: u32, capacity_frames: u32) ?usize {
    if (channels == 0 or channels > max_capture_channels or capacity_frames == 0) return null;

    const bytes_per_frame = std.math.mul(usize, @as(usize, channels), @sizeOf(f32)) catch return null;
    const buffer_bytes = std.math.mul(usize, @as(usize, capacity_frames), bytes_per_frame) catch return null;
    if (buffer_bytes > max_capture_ring_bytes) return null;
    return std.math.mul(usize, @as(usize, capacity_frames), @as(usize, channels)) catch null;
}

pub const CaptureBuffer = struct {
    allocator: std.mem.Allocator,
    samples: []f32,
    ring: c.ma_pcm_rb = undefined,
    sample_rate: u32,
    channels: u32,
    capacity_frames: u32,
    frames_received: u64 = 0,
    frames_read: u64 = 0,
    frames_dropped: u64 = 0,

    pub fn create(
        allocator: std.mem.Allocator,
        sample_rate: u32,
        channels: u32,
        capacity_frames: u32,
    ) error{ InvalidArguments, OutOfMemory, DeviceInitFailed }!*CaptureBuffer {
        const sample_count = captureSampleCount(channels, capacity_frames) orelse return error.InvalidArguments;
        const capture = allocator.create(CaptureBuffer) catch return error.OutOfMemory;
        errdefer allocator.destroy(capture);

        const samples = allocator.alloc(f32, sample_count) catch return error.OutOfMemory;
        errdefer allocator.free(samples);

        capture.* = .{
            .allocator = allocator,
            .samples = samples,
            .sample_rate = sample_rate,
            .channels = channels,
            .capacity_frames = capacity_frames,
        };
        if (c.ma_pcm_rb_init(c.ma_format_f32, channels, capacity_frames, samples.ptr, null, &capture.ring) != c.MA_SUCCESS) {
            return error.DeviceInitFailed;
        }
        c.ma_pcm_rb_set_sample_rate(&capture.ring, sample_rate);
        return capture;
    }

    pub fn destroy(self: *CaptureBuffer) void {
        c.ma_pcm_rb_uninit(&self.ring);
        self.allocator.free(self.samples);
        self.allocator.destroy(self);
    }

    // This is the sole producer path. It never waits for space and drops the newest frames on overflow.
    pub fn write(self: *CaptureBuffer, input: [*]const f32, frame_count: u32) void {
        if (frame_count == 0) return;
        _ = @atomicRmw(u64, &self.frames_received, .Add, frame_count, .monotonic);

        const frames_to_write = @min(frame_count, c.ma_pcm_rb_available_write(&self.ring));
        var total_written: u32 = 0;
        while (total_written < frames_to_write) {
            var contiguous_frames = frames_to_write - total_written;
            var pcm_ptr: ?*anyopaque = null;
            if (c.ma_pcm_rb_acquire_write(&self.ring, &contiguous_frames, &pcm_ptr) != c.MA_SUCCESS or
                contiguous_frames == 0 or pcm_ptr == null)
            {
                break;
            }

            const sample_offset = @as(usize, total_written) * @as(usize, self.channels);
            const sample_count = @as(usize, contiguous_frames) * @as(usize, self.channels);
            const aligned_pcm: *align(@alignOf(f32)) anyopaque = @alignCast(pcm_ptr.?);
            const pcm = @as([*]f32, @ptrCast(aligned_pcm))[0..sample_count];
            @memcpy(pcm, input[sample_offset .. sample_offset + sample_count]);
            if (c.ma_pcm_rb_commit_write(&self.ring, contiguous_frames) != c.MA_SUCCESS) break;
            total_written += contiguous_frames;
        }

        const dropped = frame_count - total_written;
        if (dropped > 0) {
            _ = @atomicRmw(u64, &self.frames_dropped, .Add, dropped, .monotonic);
        }
    }

    // This is the sole consumer path. Native FFI entry is serialized, while the ring synchronizes with the producer.
    pub fn read(self: *CaptureBuffer, output: [*]f32, frame_count: u32) u32 {
        const frames_to_read = @min(frame_count, c.ma_pcm_rb_available_read(&self.ring));
        var total_read: u32 = 0;
        while (total_read < frames_to_read) {
            var contiguous_frames = frames_to_read - total_read;
            var pcm_ptr: ?*anyopaque = null;
            if (c.ma_pcm_rb_acquire_read(&self.ring, &contiguous_frames, &pcm_ptr) != c.MA_SUCCESS or
                contiguous_frames == 0 or pcm_ptr == null)
            {
                break;
            }

            const sample_offset = @as(usize, total_read) * @as(usize, self.channels);
            const sample_count = @as(usize, contiguous_frames) * @as(usize, self.channels);
            const aligned_pcm: *align(@alignOf(f32)) anyopaque = @alignCast(pcm_ptr.?);
            const pcm = @as([*]const f32, @ptrCast(aligned_pcm))[0..sample_count];
            @memcpy(output[sample_offset .. sample_offset + sample_count], pcm);
            if (c.ma_pcm_rb_commit_read(&self.ring, contiguous_frames) != c.MA_SUCCESS) break;
            total_read += contiguous_frames;
        }

        if (total_read > 0) {
            _ = @atomicRmw(u64, &self.frames_read, .Add, total_read, .monotonic);
        }
        return total_read;
    }

    pub fn snapshot(self: *CaptureBuffer) CaptureStats {
        return .{
            .frames_received = @atomicLoad(u64, &self.frames_received, .monotonic),
            .frames_read = @atomicLoad(u64, &self.frames_read, .monotonic),
            .frames_dropped = @atomicLoad(u64, &self.frames_dropped, .monotonic),
            .sample_rate = self.sample_rate,
            .channels = self.channels,
            .buffered_frames = c.ma_pcm_rb_available_read(&self.ring),
            .capacity_frames = self.capacity_frames,
        };
    }
};

const Sound = struct {
    loaded: bool = true,
    channels: u16,
    sample_rate: u32,
    samples: []f32,
};

const Voice = struct {
    active: bool = false,
    sound_index: usize = 0,
    volume: f32 = 1,
    pan: f32 = 0,
    loop: bool = false,
    group_id: u32 = 0,
    buffer_ref: c.ma_audio_buffer_ref = undefined,
    buffer_ready: bool = false,
    sound: c.ma_sound = undefined,
    sound_ready: bool = false,
};

const StreamDataSource = extern struct {
    base: c.ma_data_source_base = undefined,
    stream: *Stream = undefined,
};

comptime {
    std.debug.assert(@offsetOf(StreamDataSource, "base") == 0);
}

const Stream = struct {
    allocator: std.mem.Allocator,
    input_buffer: []u8,
    input_read: usize = 0,
    input_write: usize = 0,
    input_count: usize = 0,
    input_lock: std.Io.Mutex = .init,
    input_condition: std.Io.Condition = .init,
    // Keep EOF publication atomic so future decoder reads need not preserve a lock-only invariant.
    input_ended: u32 = 0,
    cancel_requested: u32 = 0,
    decoder_stop_requested: u32 = 0,
    decoder_abort: bool = false,
    probe_active: bool = true,
    probe_bytes: usize = 0,
    max_probe_bytes: usize,
    format: u32,
    decoder_finished: u32 = 0,
    pcm_buffer: []f32,
    pcm_ring: c.ma_pcm_rb = undefined,
    pcm_ring_ready: bool = false,
    source: StreamDataSource = .{},
    source_ready: bool = false,
    sound: c.ma_sound = undefined,
    sound_ready: bool = false,
    worker: ?std.Thread = null,
    startup_frames: u32,
    resume_frames: u32,
    sample_rate: u32,
    capacity_frames: u32,
    state: u32 = StreamState.initializing,
    bytes_received: u64 = 0,
    frames_decoded: u64 = 0,
    frames_played: u64 = 0,
    underruns: u32 = 0,
    error_code: i32 = 0,
    ready_generation: u32 = 0,
    has_started_playback: bool = false,
    input_sample_rate: u32 = 0,
    input_channels: u32 = 0,
};

const SoundGroup = struct {
    name: []u8,
    volume: f32 = 1,
    node: c.ma_sound_group = undefined,
    initialized: bool = false,
};

pub const Engine = struct {
    allocator: std.mem.Allocator,
    started: bool = false,
    lock: std.Io.Mutex = .init,
    context: c.ma_context = undefined,
    context_initialized: bool = false,
    core: c.ma_engine = undefined,
    core_initialized: bool = false,
    sounds: std.ArrayList(Sound),
    groups: std.ArrayList(*SoundGroup),
    playback_devices: std.ArrayList(c.ma_device_info),
    selected_playback_index: ?u32 = null,
    capture_devices: std.ArrayList(c.ma_device_info),
    selected_capture_index: ?u32 = null,
    selected_capture_device_id: c.ma_device_id = undefined,
    has_selected_capture_device: bool = false,
    voices: [max_voices]Voice,
    streams: [max_voices]?*Stream,
    stream_generations: [max_voices]u32,
    master_volume: f32,
    sample_rate: u32,
    stats: Stats,
    device: c.ma_device = undefined,
    has_device: bool = false,
    capture_device: c.ma_device = undefined,
    has_capture_device: bool = false,
    capture: ?*CaptureBuffer = null,
    output_channels: u8 = 2,
    lock_miss_count: u32 = 0,
    tap_enabled: bool = false,
    tap_channels: u8 = 2,
    tap_capacity_frames: u32 = 0,
    tap_write_frame: u32 = 0,
    tap_frame_count: u32 = 0,
    tap_buffer: ?[]f32 = null,

    pub fn init(allocator: std.mem.Allocator, sample_rate: u32, output_channels: u8) Engine {
        const normalized_sample_rate = if (sample_rate == 0) default_sample_rate else sample_rate;
        return .{
            .allocator = allocator,
            .started = false,
            .context = undefined,
            .context_initialized = false,
            .core = undefined,
            .core_initialized = false,
            .sounds = .empty,
            .groups = .empty,
            .playback_devices = .empty,
            .selected_playback_index = null,
            .capture_devices = .empty,
            .selected_capture_index = null,
            .selected_capture_device_id = undefined,
            .has_selected_capture_device = false,
            .voices = [_]Voice{.{}} ** max_voices,
            .streams = [_]?*Stream{null} ** max_voices,
            .stream_generations = [_]u32{1} ** max_voices,
            .master_volume = 1,
            .sample_rate = normalized_sample_rate,
            .stats = .{
                .sounds_loaded = 0,
                .voices_active = 0,
                .frames_mixed = 0,
                .lock_misses = 0,
                .last_peak = 0,
                .last_rms = 0,
            },
            .device = undefined,
            .has_device = false,
            .capture_device = undefined,
            .has_capture_device = false,
            .capture = null,
            .output_channels = output_channels,
            .lock_miss_count = 0,
            .tap_enabled = false,
            .tap_channels = 2,
            .tap_capacity_frames = 0,
            .tap_write_frame = 0,
            .tap_frame_count = 0,
            .tap_buffer = null,
        };
    }

    pub fn deinit(self: *Engine) void {
        stopCaptureDevice(self);
        self.lock.lockUncancelable(io);

        if (self.has_device) {
            _ = c.ma_device_stop(&self.device);
            c.ma_device_uninit(&self.device);
            self.has_device = false;
        }

        for (&self.voices) |*voice| {
            clearVoice(voice);
        }

        for (self.streams) |stream_ptr| {
            const stream = stream_ptr orelse continue;
            if (stream.sound_ready) {
                _ = c.ma_sound_stop(&stream.sound);
                c.ma_sound_uninit(&stream.sound);
                stream.sound_ready = false;
            }
            transitionStreamToTerminal(stream, StreamState.cancelled);
            requestStreamCancellation(stream);
        }
        self.lock.unlock(io);

        if (self.capture) |capture| {
            capture.destroy();
            self.capture = null;
        }

        for (&self.streams) |*stream_ptr| {
            const stream = stream_ptr.* orelse continue;
            destroyStreamStorage(stream, null);
            stream_ptr.* = null;
        }

        for (self.groups.items) |group| {
            if (group.initialized) {
                c.ma_sound_group_uninit(&group.node);
                group.initialized = false;
            }
            self.allocator.free(group.name);
            self.allocator.destroy(group);
        }

        for (self.sounds.items) |sound| {
            if (sound.loaded) {
                self.allocator.free(sound.samples);
            }
        }

        self.sounds.deinit(self.allocator);
        self.groups.deinit(self.allocator);
        self.playback_devices.deinit(self.allocator);
        self.capture_devices.deinit(self.allocator);

        if (self.tap_buffer) |buffer| {
            self.allocator.free(buffer);
            self.tap_buffer = null;
        }

        if (self.core_initialized) {
            c.ma_engine_uninit(&self.core);
            self.core_initialized = false;
        }

        if (self.context_initialized) {
            _ = c.ma_context_uninit(&self.context);
            self.context_initialized = false;
        }
    }

    fn updateActiveVoiceCount(self: *Engine) void {
        var active: u32 = 0;
        for (self.voices) |voice| {
            if (voice.active) active += 1;
        }
        for (self.streams) |stream| {
            if (stream != null) active += 1;
        }
        self.stats.voices_active = active;
    }

    fn activeVoiceAndStreamCount(self: *Engine) usize {
        var active: usize = 0;
        for (self.voices) |voice| {
            if (voice.active) active += 1;
        }
        for (self.streams) |stream| {
            if (stream != null) active += 1;
        }
        return active;
    }

    fn updateLoadedSoundCount(self: *Engine) void {
        var loaded: u32 = 0;
        for (self.sounds.items) |sound| {
            if (sound.loaded) loaded += 1;
        }
        self.stats.sounds_loaded = loaded;
    }
};

fn clamp(value: f32, min: f32, max: f32) f32 {
    return @max(min, @min(max, value));
}

fn toMaBool8(value: bool) c.ma_bool8 {
    return if (value) c.MA_TRUE else c.MA_FALSE;
}

fn toMaBool32(value: bool) c.ma_bool32 {
    return if (value) c.MA_TRUE else c.MA_FALSE;
}

fn toPerformanceProfile(value: u8) c.ma_performance_profile {
    if (value == 1) {
        return c.ma_performance_profile_conservative;
    }
    return c.ma_performance_profile_low_latency;
}

fn toShareMode(value: u8) c.ma_share_mode {
    if (value == 1) {
        return c.ma_share_mode_exclusive;
    }
    return c.ma_share_mode_shared;
}

fn decoderAsDataSource(decoder: *c.ma_decoder) *c.ma_data_source {
    return @ptrCast(decoder);
}

fn loadStreamState(stream: *const Stream) u32 {
    return @atomicLoad(u32, &stream.state, .acquire);
}

fn setStreamState(stream: *Stream, state: u32) void {
    @atomicStore(u32, &stream.state, state, .release);
}

fn transitionStreamState(stream: *Stream, from: u32, to: u32) bool {
    return @cmpxchgStrong(u32, &stream.state, from, to, .acq_rel, .acquire) == null;
}

fn isTerminalStreamState(state: u32) bool {
    return state == StreamState.ended or state == StreamState.failed or state == StreamState.cancelled;
}

fn transitionStreamToTerminal(stream: *Stream, terminal_state: u32) void {
    var state = loadStreamState(stream);
    while (!isTerminalStreamState(state)) {
        state = @cmpxchgWeak(u32, &stream.state, state, terminal_state, .acq_rel, .acquire) orelse return;
    }
}

fn failStreamWithCode(stream: *Stream, error_code: i32) void {
    @atomicStore(i32, &stream.error_code, error_code, .release);
    transitionStreamToTerminal(stream, StreamState.failed);
}

fn failStream(stream: *Stream) void {
    failStreamWithCode(stream, Status.err_decode);
}

fn decoderExitRequested(stream: *const Stream) bool {
    return @atomicLoad(u32, &stream.cancel_requested, .acquire) != 0 or
        @atomicLoad(u32, &stream.decoder_stop_requested, .acquire) != 0;
}

fn failDecoderWorker(stream: *Stream) void {
    stream.input_lock.lockUncancelable(io);
    defer stream.input_lock.unlock(io);
    if (decoderExitRequested(stream)) return;
    failStream(stream);
}

fn endStreamPlayback(stream: *Stream) void {
    transitionStreamToTerminal(stream, StreamState.ended);
}

fn requestStreamCancellation(stream: *Stream) void {
    stream.input_lock.lockUncancelable(io);
    @atomicStore(u32, &stream.cancel_requested, 1, .release);
    stream.input_condition.broadcast(io);
    stream.input_lock.unlock(io);
}

fn destroyStreamStorage(stream: *Stream, out_final_stats: ?*StreamStats) void {
    if (stream.worker) |worker| {
        worker.join();
        stream.worker = null;
    }
    if (out_final_stats) |stats| stats.* = snapshotStream(stream, true);
    if (stream.source_ready) {
        c.ma_data_source_uninit(@ptrCast(&stream.source));
        stream.source_ready = false;
    }
    if (stream.pcm_ring_ready) {
        c.ma_pcm_rb_uninit(&stream.pcm_ring);
        stream.pcm_ring_ready = false;
    }
    stream.allocator.free(stream.pcm_buffer);
    stream.allocator.free(stream.input_buffer);
    stream.allocator.destroy(stream);
}

fn streamFromDataSource(data_source: ?*anyopaque) ?*Stream {
    const source_ptr = data_source orelse return null;
    const source: *StreamDataSource = @ptrCast(@alignCast(source_ptr));
    return source.stream;
}

fn streamDataSourceRead(
    data_source: ?*anyopaque,
    frames_out: ?*anyopaque,
    frame_count: c.ma_uint64,
    frames_read_out: [*c]c.ma_uint64,
) callconv(.c) c.ma_result {
    if (frames_read_out != null) frames_read_out[0] = 0;
    const stream = streamFromDataSource(data_source) orelse return c.MA_INVALID_ARGS;
    if (frame_count == 0) return c.MA_SUCCESS;
    if (frames_out == null or frame_count > std.math.maxInt(u32)) return c.MA_NOT_IMPLEMENTED;

    const requested_frames: u32 = @intCast(frame_count);
    const sample_count = @as(usize, requested_frames) * 2;
    const aligned_output: *align(@alignOf(f32)) anyopaque = @alignCast(frames_out.?);
    const out = @as([*]f32, @ptrCast(aligned_output))[0..sample_count];
    @memset(out, 0);

    var state = loadStreamState(stream);
    if (state == StreamState.failed or state == StreamState.cancelled or state == StreamState.ended) {
        return c.MA_AT_END;
    }

    if (state == StreamState.initializing) {
        if (frames_read_out != null) frames_read_out[0] = frame_count;
        return c.MA_SUCCESS;
    }

    var available = c.ma_pcm_rb_available_read(&stream.pcm_ring);
    // Completion is one callback snapshot: a short read before EOF is published is an underrun.
    const decoder_finished = @atomicLoad(u32, &stream.decoder_finished, .acquire) != 0;

    const consume_while_reconnecting = state == StreamState.reconnecting and stream.has_started_playback;
    if (state == StreamState.reconnecting and !consume_while_reconnecting) {
        if (frames_read_out != null) frames_read_out[0] = frame_count;
        return c.MA_SUCCESS;
    }
    if (state == StreamState.buffering) {
        const threshold = if (stream.has_started_playback) stream.resume_frames else stream.startup_frames;
        if (available >= threshold or (decoder_finished and available > 0)) {
            if (transitionStreamState(stream, StreamState.buffering, StreamState.playing)) {
                stream.has_started_playback = true;
                state = StreamState.playing;
            } else {
                state = loadStreamState(stream);
            }
        } else if (decoder_finished and available == 0) {
            endStreamPlayback(stream);
            return c.MA_AT_END;
        } else {
            if (frames_read_out != null) frames_read_out[0] = frame_count;
            return c.MA_SUCCESS;
        }
    }

    if (state != StreamState.playing and !consume_while_reconnecting) {
        return c.MA_AT_END;
    }

    const frames_to_read = @min(requested_frames, available);
    var total_read: u32 = 0;
    while (total_read < frames_to_read) {
        var contiguous_frames = frames_to_read - total_read;
        var pcm_ptr: ?*anyopaque = null;
        if (c.ma_pcm_rb_acquire_read(&stream.pcm_ring, &contiguous_frames, &pcm_ptr) != c.MA_SUCCESS or contiguous_frames == 0 or pcm_ptr == null) {
            break;
        }

        const aligned_pcm: *align(@alignOf(f32)) anyopaque = @alignCast(pcm_ptr.?);
        const pcm = @as([*]const f32, @ptrCast(aligned_pcm))[0 .. @as(usize, contiguous_frames) * 2];
        const sample_offset = @as(usize, total_read) * 2;
        @memcpy(out[sample_offset .. sample_offset + pcm.len], pcm);
        if (c.ma_pcm_rb_commit_read(&stream.pcm_ring, contiguous_frames) != c.MA_SUCCESS) break;
        total_read += contiguous_frames;
    }

    if (total_read > 0) {
        _ = @atomicRmw(u64, &stream.frames_played, .Add, total_read, .monotonic);
    }

    available = c.ma_pcm_rb_available_read(&stream.pcm_ring);
    if (!consume_while_reconnecting and decoder_finished and available == 0) {
        endStreamPlayback(stream);
        if (frames_read_out != null) frames_read_out[0] = total_read;
        return if (total_read == 0) c.MA_AT_END else c.MA_SUCCESS;
    }

    if (total_read < requested_frames) {
        if (!consume_while_reconnecting and transitionStreamState(stream, StreamState.playing, StreamState.buffering)) {
            _ = @atomicRmw(u32, &stream.underruns, .Add, 1, .monotonic);
        }
        if (frames_read_out != null) frames_read_out[0] = frame_count;
        return c.MA_SUCCESS;
    }

    if (frames_read_out != null) frames_read_out[0] = total_read;
    return c.MA_SUCCESS;
}

fn streamDataSourceGetFormat(
    data_source: ?*anyopaque,
    format_out: [*c]c.ma_format,
    channels_out: [*c]c.ma_uint32,
    sample_rate_out: [*c]c.ma_uint32,
    channel_map_out: [*c]c.ma_channel,
    channel_map_capacity: usize,
) callconv(.c) c.ma_result {
    const stream = streamFromDataSource(data_source) orelse return c.MA_INVALID_ARGS;
    if (format_out != null) format_out[0] = c.ma_format_f32;
    if (channels_out != null) channels_out[0] = 2;
    if (sample_rate_out != null) sample_rate_out[0] = stream.sample_rate;
    if (channel_map_out != null) {
        _ = c.ma_channel_map_init_standard(c.ma_standard_channel_map_default, channel_map_out, channel_map_capacity, 2);
    }
    return c.MA_SUCCESS;
}

const stream_data_source_vtable = c.ma_data_source_vtable{
    .onRead = streamDataSourceRead,
    .onSeek = null,
    .onGetDataFormat = streamDataSourceGetFormat,
    .onGetCursor = null,
    .onGetLength = null,
    .onSetLooping = null,
    .flags = 0,
};

fn streamFromDecoder(decoder: ?*c.ma_decoder) ?*Stream {
    const decoder_ptr = decoder orelse return null;
    const user_data = decoder_ptr.pUserData orelse return null;
    return @ptrCast(@alignCast(user_data));
}

fn streamDecoderRead(
    decoder: ?*c.ma_decoder,
    buffer_out: ?*anyopaque,
    bytes_to_read: usize,
    bytes_read_out: [*c]usize,
) callconv(.c) c.ma_result {
    if (bytes_read_out != null) bytes_read_out[0] = 0;
    const stream = streamFromDecoder(decoder) orelse return c.MA_INVALID_ARGS;
    return readStreamInput(stream, buffer_out, bytes_to_read, bytes_read_out);
}

fn readStreamInput(stream: *Stream, buffer_out: ?*anyopaque, bytes_to_read: usize, bytes_read_out: [*c]usize) c.ma_result {
    if (bytes_read_out != null) bytes_read_out[0] = 0;
    if (bytes_to_read == 0) return c.MA_SUCCESS;
    const output_ptr = buffer_out orelse return c.MA_INVALID_ARGS;

    stream.input_lock.lockUncancelable(io);
    defer stream.input_lock.unlock(io);

    const output = @as([*]u8, @ptrCast(output_ptr))[0..bytes_to_read];
    // Raw PCM must not wait for an encoded decoder's minimum read size.
    const target_read = if (stream.format == StreamFormat.pcm) 1 else @min(bytes_to_read, stream_decoder_read_granularity);
    var total_read: usize = 0;
    while (total_read < target_read) {
        while (stream.input_count == 0 and
            @atomicLoad(u32, &stream.input_ended, .acquire) == 0 and
            @atomicLoad(u32, &stream.cancel_requested, .acquire) == 0 and
            @atomicLoad(u32, &stream.decoder_stop_requested, .acquire) == 0 and
            !stream.decoder_abort)
        {
            if (stream.probe_active and stream.probe_bytes >= stream.max_probe_bytes) {
                stream.decoder_abort = true;
                break;
            }
            stream.input_condition.waitUncancelable(io, &stream.input_lock);
        }

        if (decoderExitRequested(stream) or stream.decoder_abort) break;
        if (stream.input_count == 0 and @atomicLoad(u32, &stream.input_ended, .acquire) != 0) break;

        var copy_count = @min(bytes_to_read - total_read, stream.input_count);
        if (stream.probe_active) {
            const probe_remaining = stream.max_probe_bytes - stream.probe_bytes;
            copy_count = @min(copy_count, probe_remaining);
            if (copy_count == 0) {
                stream.decoder_abort = true;
                break;
            }
        }

        const first_count = @min(copy_count, stream.input_buffer.len - stream.input_read);
        @memcpy(output[total_read .. total_read + first_count], stream.input_buffer[stream.input_read .. stream.input_read + first_count]);
        const second_count = copy_count - first_count;
        if (second_count > 0) {
            @memcpy(output[total_read + first_count .. total_read + copy_count], stream.input_buffer[0..second_count]);
        }

        stream.input_read = (stream.input_read + copy_count) % stream.input_buffer.len;
        stream.input_count -= copy_count;
        if (stream.probe_active) stream.probe_bytes += copy_count;
        total_read += copy_count;
    }

    if (bytes_read_out != null) bytes_read_out[0] = total_read;
    if (total_read > 0) return c.MA_SUCCESS;
    if (decoderExitRequested(stream) or stream.decoder_abort) return c.MA_CANCELLED;
    return c.MA_AT_END;
}

fn streamDecoderSeek(decoder: ?*c.ma_decoder, byte_offset: c.ma_int64, origin: c.ma_seek_origin) callconv(.c) c.ma_result {
    if (origin != c.ma_seek_origin_current or byte_offset < 0) return c.MA_NOT_IMPLEMENTED;

    var remaining: u64 = @intCast(byte_offset);
    var scratch: [4096]u8 = undefined;
    while (remaining > 0) {
        const requested: usize = @intCast(@min(remaining, scratch.len));
        var bytes_read: usize = 0;
        const result = streamDecoderRead(decoder, &scratch, requested, &bytes_read);
        if (result != c.MA_SUCCESS) return result;
        if (bytes_read == 0) return c.MA_AT_END;
        remaining -= bytes_read;
    }
    return c.MA_SUCCESS;
}

fn streamDecoderWorker(stream: *Stream) void {
    const is_pcm = stream.format == StreamFormat.pcm;
    var decoder: c.ma_decoder = undefined;
    var converter: c.ma_data_converter = undefined;
    const init_result = if (is_pcm) blk: {
        const config = c.ma_data_converter_config_init(c.ma_format_f32, c.ma_format_f32, stream.input_channels, stream_channels, stream.input_sample_rate, stream.sample_rate);
        break :blk c.ma_data_converter_init(&config, null, &converter);
    } else blk: {
        var config = c.ma_decoder_config_init(c.ma_format_f32, 2, stream.sample_rate);
        config.encodingFormat = switch (stream.format) {
            StreamFormat.mp3 => c.ma_encoding_format_mp3,
            StreamFormat.flac => c.ma_encoding_format_flac,
            else => unreachable,
        };
        config.seekPointCount = 0;
        break :blk c.ma_decoder_init(streamDecoderRead, streamDecoderSeek, stream, &config, &decoder);
    };
    if (init_result != c.MA_SUCCESS) {
        failDecoderWorker(stream);
        return;
    }
    defer if (is_pcm) c.ma_data_converter_uninit(&converter, null) else {
        _ = c.ma_decoder_uninit(&decoder);
    };

    // PCM conversion history and partial input belong only to this producer.
    var samples: [stream_decoder_chunk_frames * stream_channels]f32 = undefined;
    var input_offset: usize = 0;
    var input_len: usize = 0;

    stream.input_lock.lockUncancelable(io);
    stream.probe_active = false;
    if (decoderExitRequested(stream)) {
        stream.input_lock.unlock(io);
        return;
    }
    const state = loadStreamState(stream);
    if (state == StreamState.initializing) {
        _ = transitionStreamState(stream, StreamState.initializing, StreamState.buffering);
    } else if (state == StreamState.reconnecting) {
        _ = transitionStreamState(stream, StreamState.reconnecting, StreamState.buffering);
    }
    const ready_generation = @atomicLoad(u32, &stream.ready_generation, .acquire);
    @atomicStore(u32, &stream.ready_generation, if (ready_generation == std.math.maxInt(u32)) 1 else ready_generation + 1, .release);
    stream.input_lock.unlock(io);

    while (!decoderExitRequested(stream)) {
        const writable = c.ma_pcm_rb_available_write(&stream.pcm_ring);
        if (writable == 0) {
            // Only the full-ring producer polls; this avoids synchronizing the realtime consumer.
            io.sleep(.fromMilliseconds(1), .awake) catch {};
            continue;
        }

        var contiguous_frames: u32 = @min(writable, stream_decoder_chunk_frames);
        var pcm_ptr: ?*anyopaque = null;
        if (c.ma_pcm_rb_acquire_write(&stream.pcm_ring, &contiguous_frames, &pcm_ptr) != c.MA_SUCCESS or contiguous_frames == 0 or pcm_ptr == null) {
            failDecoderWorker(stream);
            return;
        }

        var frames_read: c.ma_uint64 = 0;
        const result = if (is_pcm) blk: {
            const frame_bytes = stream.input_channels * @sizeOf(f32);
            if (input_len - input_offset < frame_bytes) {
                const bytes = std.mem.sliceAsBytes(samples[0 .. stream_decoder_chunk_frames * stream.input_channels]);
                const pending = input_len - input_offset;
                std.mem.copyForwards(u8, bytes[0..pending], bytes[input_offset..input_len]);
                var read: usize = 0;
                const status = readStreamInput(stream, bytes[pending..].ptr, bytes.len - pending, &read);
                if (status != c.MA_SUCCESS and status != c.MA_AT_END) break :blk status;
                input_offset = 0;
                input_len = pending + read;
                if (input_len < frame_bytes and input_len != 0) {
                    if (status == c.MA_AT_END) break :blk c.MA_INVALID_ARGS;
                    continue;
                }
                for (samples[0 .. input_len / frame_bytes * stream.input_channels], 0..) |*sample, index| {
                    sample.* = @bitCast(std.mem.readInt(u32, bytes[index * 4 ..][0..4], .little));
                    if (!std.math.isFinite(sample.*)) break :blk c.MA_INVALID_ARGS;
                }
            }

            frames_read = contiguous_frames;
            var input_frames: u64 = (input_len - input_offset) / frame_bytes;
            const input = if (input_frames != 0) samples[input_offset / @sizeOf(f32) ..].ptr else null;
            if (input == null) {
                const input_rate = stream.input_sample_rate;
                const received_frames = @atomicLoad(u64, &stream.bytes_received, .monotonic) / frame_bytes;
                // Round input latency separately to preserve sub-frame downsampling tails.
                const tail = (@as(u128, c.ma_data_converter_get_input_latency(&converter)) * stream.sample_rate + input_rate - 1) / input_rate;
                const target: u64 = if (received_frames == 0) 0 else @intCast((@as(u128, received_frames) * stream.sample_rate + input_rate - 1) / input_rate + tail);
                const produced = @atomicLoad(u64, &stream.frames_decoded, .monotonic);
                frames_read = @min(frames_read, target -| produced);
                if (frames_read == 0) break :blk c.MA_AT_END;
                input_frames = stream_decoder_chunk_frames;
            }
            const status = c.ma_data_converter_process_pcm_frames(&converter, input, &input_frames, pcm_ptr, &frames_read);
            if (input != null) input_offset += @intCast(input_frames * frame_bytes);
            // Downsampling may consume a batch before it can produce the next frame.
            if (status == c.MA_SUCCESS and frames_read == 0 and input != null and input_frames != 0) continue;
            break :blk status;
        } else c.ma_decoder_read_pcm_frames(&decoder, pcm_ptr, contiguous_frames, &frames_read);
        const decoded_frames = std.math.cast(u32, frames_read) orelse {
            failDecoderWorker(stream);
            return;
        };

        if (decoded_frames > 0) {
            if (c.ma_pcm_rb_commit_write(&stream.pcm_ring, decoded_frames) != c.MA_SUCCESS) {
                failDecoderWorker(stream);
                return;
            }
            _ = @atomicRmw(u64, &stream.frames_decoded, .Add, decoded_frames, .monotonic);
        }

        if (decoderExitRequested(stream)) return;
        if (result != c.MA_SUCCESS and result != c.MA_AT_END) {
            failDecoderWorker(stream);
            return;
        }
        if (frames_read == 0) {
            stream.input_lock.lockUncancelable(io);
            if (decoderExitRequested(stream)) {
                stream.input_lock.unlock(io);
                return;
            }
            if (@atomicLoad(u32, &stream.input_ended, .acquire) != 0) {
                @atomicStore(u32, &stream.decoder_finished, 1, .release);
                if (is_pcm and @atomicLoad(u64, &stream.frames_decoded, .monotonic) == 0) endStreamPlayback(stream);
                stream.input_lock.unlock(io);
                return;
            }
            stream.input_lock.unlock(io);
            failDecoderWorker(stream);
            return;
        }
    }
}

const DecodedDataSourceFormat = struct {
    channels: u16,
    sample_rate: u32,
};

fn incrementLockMisses(engine: *Engine) void {
    _ = @atomicRmw(u32, &engine.lock_miss_count, .Add, 1, .monotonic);
}

fn loadLockMisses(engine: *Engine) u32 {
    return @atomicLoad(u32, &engine.lock_miss_count, .monotonic);
}

fn ensureContextInitialized(engine: *Engine) i32 {
    if (engine.context_initialized) return Status.ok;

    if (c.ma_context_init(null, 0, null, &engine.context) != c.MA_SUCCESS) {
        return Status.err_device;
    }

    engine.context_initialized = true;
    return Status.ok;
}

fn refreshPlaybackDevicesLocked(engine: *Engine) i32 {
    const context_status = ensureContextInitialized(engine);
    if (context_status != Status.ok) return context_status;

    var playback_infos: [*c]c.ma_device_info = null;
    var playback_count: c.ma_uint32 = 0;
    const result = c.ma_context_get_devices(&engine.context, &playback_infos, &playback_count, null, null);
    if (result != c.MA_SUCCESS) return Status.err_device;

    engine.playback_devices.clearRetainingCapacity();

    if (playback_infos != null and playback_count > 0) {
        const count: usize = @intCast(playback_count);
        const devices = playback_infos[0..count];
        engine.playback_devices.appendSlice(engine.allocator, devices) catch return Status.err_no_space;
    }

    if (engine.selected_playback_index) |selected_index| {
        if (@as(usize, @intCast(selected_index)) >= engine.playback_devices.items.len) {
            engine.selected_playback_index = null;
        }
    }

    return Status.ok;
}

fn refreshCaptureDevicesLocked(engine: *Engine) i32 {
    const context_status = ensureContextInitialized(engine);
    if (context_status != Status.ok) return context_status;

    var capture_infos: [*c]c.ma_device_info = null;
    var capture_count: c.ma_uint32 = 0;
    const result = c.ma_context_get_devices(&engine.context, null, null, &capture_infos, &capture_count);
    if (result != c.MA_SUCCESS) return Status.err_device;

    engine.capture_devices.clearRetainingCapacity();

    if (capture_infos != null and capture_count > 0) {
        const count: usize = @intCast(capture_count);
        const devices = capture_infos[0..count];
        engine.capture_devices.appendSlice(engine.allocator, devices) catch return Status.err_no_space;
    }

    return Status.ok;
}

fn copyDeviceName(device: *const c.ma_device_info, out_ptr: [*]u8, max_len: usize) usize {
    if (max_len == 0) return 0;

    var name_len: usize = 0;
    while (name_len < device.name.len and device.name[name_len] != 0) : (name_len += 1) {}

    const copy_len = @min(name_len, max_len);
    for (0..copy_len) |i| {
        out_ptr[i] = @bitCast(device.name[i]);
    }

    return copy_len;
}

fn writeTapFrames(engine: *Engine, source: []const f32, frame_count: u32, channels: u8) void {
    if (!engine.tap_enabled or frame_count == 0 or channels == 0) return;
    const tap_buffer = engine.tap_buffer orelse return;
    if (engine.tap_capacity_frames == 0) return;

    const source_channels: usize = channels;
    const tap_channels: usize = engine.tap_channels;
    for (0..@as(usize, frame_count)) |frame| {
        const src = frame * source_channels;
        const left = source[src];
        const right = if (channels > 1) source[src + 1] else left;

        const dst_frame: usize = engine.tap_write_frame;
        const dst = dst_frame * tap_channels;
        tap_buffer[dst] = left;
        if (tap_channels > 1) {
            tap_buffer[dst + 1] = right;
        }

        const next = engine.tap_write_frame + 1;
        engine.tap_write_frame = if (next >= engine.tap_capacity_frames) 0 else next;
        if (engine.tap_frame_count < engine.tap_capacity_frames) {
            engine.tap_frame_count += 1;
        }
    }
}

fn clearVoice(voice: *Voice) void {
    if (voice.sound_ready) {
        c.ma_sound_uninit(&voice.sound);
        voice.sound_ready = false;
    }
    if (voice.buffer_ready) {
        c.ma_audio_buffer_ref_uninit(&voice.buffer_ref);
        voice.buffer_ready = false;
    }
    voice.active = false;
    voice.sound_index = 0;
    voice.volume = 1;
    voice.pan = 0;
    voice.loop = false;
    voice.group_id = 0;
}

fn getDataSourceFormat(data_source: *c.ma_data_source) !DecodedDataSourceFormat {
    var format: c.ma_format = c.ma_format_unknown;
    var channels: c.ma_uint32 = 0;
    var sample_rate: c.ma_uint32 = 0;

    const format_result = c.ma_data_source_get_data_format(data_source, &format, &channels, &sample_rate, null, 0);
    if (format_result != c.MA_SUCCESS) return error.DecodeFailed;
    if (channels == 0 or sample_rate == 0) return error.DecodeFailed;

    return .{
        .channels = std.math.cast(u16, channels) orelse return error.DecodeFailed,
        .sample_rate = @intCast(sample_rate),
    };
}

// Fast path when data source reports total frame length: seek to frame 0,
// allocate once for exact sample count, then trim if decoder returns fewer
// frames than advertised.
fn decodeSoundKnownLength(allocator: std.mem.Allocator, data_source: *c.ma_data_source, frame_count: c.ma_uint64, channels: u16, sample_rate: u32) !Sound {
    const channel_count: usize = channels;
    const frame_count_usize = std.math.cast(usize, frame_count) orelse return error.OutOfMemory;
    const sample_count = try std.math.mul(usize, frame_count_usize, channel_count);

    const seek_result = c.ma_data_source_seek_to_pcm_frame(data_source, 0);
    if (seek_result != c.MA_SUCCESS) return error.DecodeFailed;

    var samples = try allocator.alloc(f32, sample_count);
    errdefer allocator.free(samples);

    var frames_read: c.ma_uint64 = 0;
    const result = c.ma_data_source_read_pcm_frames(data_source, samples.ptr, frame_count, &frames_read);
    if (result != c.MA_SUCCESS and result != c.MA_AT_END) return error.DecodeFailed;

    const frames_read_usize = std.math.cast(usize, frames_read) orelse return error.OutOfMemory;
    const final_sample_count = try std.math.mul(usize, frames_read_usize, channel_count);
    if (final_sample_count != sample_count) {
        samples = try allocator.realloc(samples, final_sample_count);
    }

    return .{
        .channels = channels,
        .sample_rate = sample_rate,
        .samples = samples,
    };
}

// Fallback path when total frame length unknown: read fixed-size chunks
// until MA_AT_END, then pack all chunks into one flat sample array.
fn decodeSoundUnknownLength(allocator: std.mem.Allocator, data_source: *c.ma_data_source, channels: u16, sample_rate: u32) !Sound {
    const channel_count: usize = channels;
    const chunk_frames: c.ma_uint64 = 4096;
    const chunk_frames_usize: usize = @intCast(chunk_frames);
    const chunk_sample_count = try std.math.mul(usize, chunk_frames_usize, channel_count);
    const chunk = try allocator.alloc(f32, chunk_sample_count);
    defer allocator.free(chunk);

    var samples = std.ArrayList(f32).empty;
    errdefer samples.deinit(allocator);

    while (true) {
        var frames_read: c.ma_uint64 = 0;
        const result = c.ma_data_source_read_pcm_frames(data_source, chunk.ptr, chunk_frames, &frames_read);
        if (result != c.MA_SUCCESS and result != c.MA_AT_END) return error.DecodeFailed;

        const frames_read_usize = std.math.cast(usize, frames_read) orelse return error.OutOfMemory;
        const sample_count = try std.math.mul(usize, frames_read_usize, channel_count);
        if (sample_count > 0) {
            try samples.appendSlice(allocator, chunk[0..sample_count]);
        }

        if (result == c.MA_AT_END or frames_read == 0) break;
    }

    return .{
        .loaded = true,
        .channels = channels,
        .sample_rate = sample_rate,
        .samples = try samples.toOwnedSlice(allocator),
    };
}

fn decodeSoundFromMemory(allocator: std.mem.Allocator, bytes: []const u8) !Sound {
    var config = c.ma_decoder_config_init(c.ma_format_f32, 0, 0);
    var decoder: c.ma_decoder = undefined;
    const init_result = c.ma_decoder_init_memory(bytes.ptr, bytes.len, &config, &decoder);
    if (init_result != c.MA_SUCCESS) return error.DecodeFailed;
    defer _ = c.ma_decoder_uninit(&decoder);

    const data_source = decoderAsDataSource(&decoder);
    const decoded_format = try getDataSourceFormat(data_source);
    var frame_count: c.ma_uint64 = 0;
    const length_result = c.ma_data_source_get_length_in_pcm_frames(data_source, &frame_count);

    if (length_result == c.MA_SUCCESS) {
        return decodeSoundKnownLength(allocator, data_source, frame_count, decoded_format.channels, decoded_format.sample_rate);
    }

    return decodeSoundUnknownLength(allocator, data_source, decoded_format.channels, decoded_format.sample_rate);
}

fn initDefaultGroup(engine: *Engine) !void {
    const group = try engine.allocator.create(SoundGroup);
    errdefer engine.allocator.destroy(group);

    group.* = .{
        .name = try engine.allocator.dupe(u8, "default"),
    };
    errdefer engine.allocator.free(group.name);

    const result = c.ma_sound_group_init(&engine.core, 0, null, &group.node);
    if (result != c.MA_SUCCESS) return error.DeviceInitFailed;
    group.initialized = true;
    errdefer c.ma_sound_group_uninit(&group.node);
    c.ma_sound_group_set_volume(&group.node, 1);

    try engine.groups.append(engine.allocator, group);
}

fn reapFinishedVoices(engine: *Engine) void {
    for (&engine.voices) |*voice| {
        if (!voice.active or !voice.sound_ready) continue;

        const playing = c.ma_sound_is_playing(&voice.sound) != c.MA_FALSE;
        const at_end = c.ma_sound_at_end(&voice.sound) != c.MA_FALSE;

        if (!playing and at_end) {
            clearVoice(voice);
        }
    }
    engine.updateActiveVoiceCount();
}

fn updateStatsFromBuffer(engine: *Engine, out: []const f32, frame_count: u32, channels: u8) void {
    engine.stats.frames_mixed += frame_count;
    engine.stats.lock_misses = loadLockMisses(engine);

    if (frame_count == 0 or channels == 0 or out.len == 0) {
        engine.stats.last_peak = 0;
        engine.stats.last_rms = 0;
        return;
    }

    var peak: f32 = 0;
    var rms_acc: f64 = 0;
    for (out) |sample| {
        const abs_value = @abs(sample);
        if (abs_value > peak) peak = abs_value;
        rms_acc += @as(f64, sample) * @as(f64, sample);
    }

    const sample_count = @as(f64, @floatFromInt(frame_count)) * @as(f64, @floatFromInt(channels));
    engine.stats.last_peak = peak;
    engine.stats.last_rms = @floatCast(std.math.sqrt(rms_acc / @max(sample_count, 1)));
}

fn readEngineStereo(engine: *Engine, out_stereo: []f32, frame_count: u32) i32 {
    if (out_stereo.len < @as(usize, frame_count) * 2) return Status.err_invalid;

    var frames_read: c.ma_uint64 = 0;
    const result = c.ma_engine_read_pcm_frames(&engine.core, out_stereo.ptr, frame_count, &frames_read);
    if (result != c.MA_SUCCESS and result != c.MA_AT_END) {
        return Status.err_device;
    }

    const frames_read_usize = std.math.cast(usize, frames_read) orelse return Status.err_device;
    const requested = @as(usize, frame_count);
    if (frames_read_usize < requested) {
        const zero_start = frames_read_usize * 2;
        const zero_end = requested * 2;
        @memset(out_stereo[zero_start..zero_end], 0);
    }

    return Status.ok;
}

pub fn create(allocator: std.mem.Allocator, options_ptr: ?*const CreateOptions) ?*Engine {
    const options = if (options_ptr) |opts| opts.* else CreateOptions{};
    const sample_rate = if (options.sample_rate == 0) default_sample_rate else options.sample_rate;
    const playback_channels = if (options.playback_channels == 0) default_playback_channels else options.playback_channels;
    const max_channels: u32 = @intCast(c.MA_MAX_CHANNELS);
    if (playback_channels == 0 or playback_channels > max_channels) return null;
    const output_channels = std.math.cast(u8, playback_channels) orelse return null;

    const engine = allocator.create(Engine) catch return null;
    engine.* = Engine.init(allocator, sample_rate, output_channels);

    var config = c.ma_engine_config_init();
    config.noDevice = c.MA_TRUE;
    config.channels = 2;
    config.sampleRate = sample_rate;

    if (c.ma_engine_init(&config, &engine.core) != c.MA_SUCCESS) {
        engine.deinit();
        allocator.destroy(engine);
        return null;
    }
    engine.core_initialized = true;
    engine.sample_rate = c.ma_engine_get_sample_rate(&engine.core);

    initDefaultGroup(engine) catch {
        engine.deinit();
        allocator.destroy(engine);
        return null;
    };
    return engine;
}

pub fn destroy(engine: *Engine) void {
    const e = engine;
    e.deinit();
    e.allocator.destroy(e);
}

pub fn refreshPlaybackDevices(engine: *Engine) i32 {
    const e = engine;
    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);
    return refreshPlaybackDevicesLocked(e);
}

pub fn getPlaybackDeviceCount(engine: *Engine) u32 {
    const e = engine;
    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);
    return @intCast(e.playback_devices.items.len);
}

pub fn getPlaybackDeviceName(engine: *Engine, index: u32, out_ptr: ?[*]u8, max_len: usize) usize {
    if (out_ptr == null) return 0;

    const e = engine;
    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);

    const idx: usize = @intCast(index);
    if (idx >= e.playback_devices.items.len) return 0;
    return copyDeviceName(&e.playback_devices.items[idx], out_ptr.?, max_len);
}

pub fn isPlaybackDeviceDefault(engine: *Engine, index: u32) bool {
    const e = engine;
    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);

    const idx: usize = @intCast(index);
    if (idx >= e.playback_devices.items.len) return false;
    return e.playback_devices.items[idx].isDefault != c.MA_FALSE;
}

pub fn selectPlaybackDevice(engine: *Engine, index: u32) i32 {
    const e = engine;
    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);

    if (e.started) return Status.err_invalid;
    if (e.playback_devices.items.len == 0) {
        const refresh_status = refreshPlaybackDevicesLocked(e);
        if (refresh_status != Status.ok) return refresh_status;
    }

    const idx: usize = @intCast(index);
    if (idx >= e.playback_devices.items.len) return Status.err_not_found;

    e.selected_playback_index = index;
    if (e.has_device) {
        _ = c.ma_device_stop(&e.device);
        c.ma_device_uninit(&e.device);
        e.has_device = false;
    }
    return Status.ok;
}

pub fn clearPlaybackDeviceSelection(engine: *Engine) void {
    const e = engine;
    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);

    e.selected_playback_index = null;
    if (!e.started and e.has_device) {
        _ = c.ma_device_stop(&e.device);
        c.ma_device_uninit(&e.device);
        e.has_device = false;
    }
}

pub fn refreshCaptureDevices(engine: *Engine) i32 {
    const e = engine;
    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);
    return refreshCaptureDevicesLocked(e);
}

pub fn getCaptureDeviceCount(engine: *Engine) u32 {
    const e = engine;
    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);
    return @intCast(e.capture_devices.items.len);
}

pub fn getCaptureDeviceName(engine: *Engine, index: u32, out_ptr: ?[*]u8, max_len: usize) usize {
    if (out_ptr == null) return 0;

    const e = engine;
    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);

    const idx: usize = @intCast(index);
    if (idx >= e.capture_devices.items.len) return 0;
    return copyDeviceName(&e.capture_devices.items[idx], out_ptr.?, max_len);
}

pub fn isCaptureDeviceDefault(engine: *Engine, index: u32) bool {
    const e = engine;
    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);

    const idx: usize = @intCast(index);
    if (idx >= e.capture_devices.items.len) return false;
    return e.capture_devices.items[idx].isDefault != c.MA_FALSE;
}

pub fn selectCaptureDevice(engine: *Engine, index: u32) i32 {
    const e = engine;
    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);

    if (e.has_capture_device) return Status.err_invalid;
    if (e.capture_devices.items.len == 0) {
        const refresh_status = refreshCaptureDevicesLocked(e);
        if (refresh_status != Status.ok) return refresh_status;
    }

    const idx: usize = @intCast(index);
    if (idx >= e.capture_devices.items.len) return Status.err_not_found;

    e.selected_capture_index = index;
    e.selected_capture_device_id = e.capture_devices.items[idx].id;
    e.has_selected_capture_device = true;
    return Status.ok;
}

pub fn clearCaptureDeviceSelection(engine: *Engine) void {
    const e = engine;
    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);
    e.selected_capture_index = null;
    e.has_selected_capture_device = false;
}

fn captureCallback(
    device_ptr: ?*c.ma_device,
    output_ptr: ?*anyopaque,
    input_ptr: ?*const anyopaque,
    frame_count: c.ma_uint32,
) callconv(.c) void {
    _ = output_ptr;
    const device = device_ptr orelse return;
    const input = input_ptr orelse return;
    const user_data = device.pUserData orelse return;
    const capture: *CaptureBuffer = @ptrCast(@alignCast(user_data));
    const aligned_input: *align(@alignOf(f32)) const anyopaque = @alignCast(input);
    capture.write(@ptrCast(aligned_input), @intCast(frame_count));
}

fn stopCaptureDevice(engine: *Engine) void {
    if (!engine.has_capture_device) return;
    c.ma_device_uninit(&engine.capture_device);
    engine.has_capture_device = false;
}

pub fn isCaptureRunning(engine: *Engine) bool {
    if (!engine.has_capture_device) return false;
    const state = c.ma_device_get_state(&engine.capture_device);
    return state == c.ma_device_state_starting or state == c.ma_device_state_started;
}

pub fn startCapture(
    engine: *Engine,
    options_ptr: ?*const StartOptions,
    channels: u32,
    capacity_frames: u32,
) i32 {
    if (captureSampleCount(channels, capacity_frames) == null) return Status.err_invalid;

    const e = engine;
    if (e.has_capture_device) {
        if (isCaptureRunning(e)) return Status.ok;
        c.ma_device_uninit(&e.capture_device);
        e.has_capture_device = false;
    }

    const next_capture = CaptureBuffer.create(e.allocator, e.sample_rate, channels, capacity_frames) catch |err| switch (err) {
        error.InvalidArguments => return Status.err_invalid,
        error.OutOfMemory => return Status.err_no_space,
        error.DeviceInitFailed => return Status.err_device,
    };
    var next_capture_owned = true;
    defer if (next_capture_owned) next_capture.destroy();

    const context_status = ensureContextInitialized(e);
    if (context_status != Status.ok) return context_status;

    var selected_device_id: ?*const c.ma_device_id = null;
    if (e.has_selected_capture_device) {
        selected_device_id = &e.selected_capture_device_id;
    }

    var default_options = StartOptions{};
    default_options.no_fixed_sized_callback = true;
    const options = if (options_ptr) |opts| opts.* else default_options;
    var config = c.ma_device_config_init(c.ma_device_type_capture);
    config.sampleRate = e.sample_rate;
    config.periodSizeInFrames = options.period_size_in_frames;
    config.periodSizeInMilliseconds = options.period_size_in_milliseconds;
    config.periods = options.periods;
    config.performanceProfile = toPerformanceProfile(options.performance_profile);
    config.noPreSilencedOutputBuffer = toMaBool8(options.no_pre_silenced_output_buffer);
    config.noClip = toMaBool8(options.no_clip);
    config.noDisableDenormals = toMaBool8(options.no_disable_denormals);
    config.noFixedSizedCallback = toMaBool8(options.no_fixed_sized_callback);
    config.capture.format = c.ma_format_f32;
    config.capture.channels = channels;
    config.capture.shareMode = toShareMode(options.share_mode);
    config.capture.pDeviceID = selected_device_id;
    config.wasapi.noAutoConvertSRC = toMaBool8(options.wasapi_no_auto_convert_src);
    config.wasapi.noDefaultQualitySRC = toMaBool8(options.wasapi_no_default_quality_src);
    config.alsa.noMMap = toMaBool32(options.alsa_no_mmap);
    config.alsa.noAutoFormat = toMaBool32(options.alsa_no_auto_format);
    config.alsa.noAutoChannels = toMaBool32(options.alsa_no_auto_channels);
    config.alsa.noAutoResample = toMaBool32(options.alsa_no_auto_resample);
    config.dataCallback = captureCallback;
    config.pUserData = next_capture;

    if (c.ma_device_init(&e.context, &config, &e.capture_device) != c.MA_SUCCESS) {
        return Status.err_device;
    }
    if (c.ma_device_start(&e.capture_device) != c.MA_SUCCESS) {
        c.ma_device_uninit(&e.capture_device);
        return Status.err_device;
    }

    const previous_capture = e.capture;
    e.capture = next_capture;
    next_capture_owned = false;
    e.has_capture_device = true;
    if (previous_capture) |previous| previous.destroy();
    return Status.ok;
}

pub fn stopCapture(engine: *Engine) i32 {
    stopCaptureDevice(engine);
    return Status.ok;
}

pub fn readCapture(
    engine: *Engine,
    out_ptr: ?[*]f32,
    out_sample_capacity: u32,
    frame_count: u32,
    out_frames_read: ?*u32,
) i32 {
    const frames_read = out_frames_read orelse return Status.err_invalid;
    frames_read.* = 0;
    const output = out_ptr orelse return Status.err_invalid;

    const capture = engine.capture orelse return Status.err_not_found;
    const required_samples = std.math.mul(u32, frame_count, capture.channels) catch return Status.err_invalid;
    if (out_sample_capacity < required_samples) return Status.err_invalid;
    frames_read.* = capture.read(output, frame_count);
    return Status.ok;
}

pub fn getCaptureStats(engine: *Engine, out_stats: ?*CaptureStats) i32 {
    const stats = out_stats orelse return Status.err_invalid;
    const capture = engine.capture orelse return Status.err_not_found;
    stats.* = capture.snapshot();
    return Status.ok;
}

pub fn start(engine: *Engine, options_ptr: ?*const StartOptions) i32 {
    const e = engine;
    const options = if (options_ptr) |opts| opts.* else StartOptions{};
    e.lock.lockUncancelable(io);
    if (e.started and e.has_device) {
        e.lock.unlock(io);
        return Status.ok;
    }

    if (!e.has_device) {
        const context_status = ensureContextInitialized(e);
        if (context_status != Status.ok) {
            e.lock.unlock(io);
            return context_status;
        }

        var selected_device_id: ?*const c.ma_device_id = null;
        if (e.selected_playback_index) |selected_index| {
            if (e.playback_devices.items.len == 0) {
                const refresh_status = refreshPlaybackDevicesLocked(e);
                if (refresh_status != Status.ok) {
                    e.lock.unlock(io);
                    return refresh_status;
                }
            }

            const idx: usize = @intCast(selected_index);
            if (idx >= e.playback_devices.items.len) {
                e.lock.unlock(io);
                return Status.err_not_found;
            }
            selected_device_id = &e.playback_devices.items[idx].id;
        }

        var config = c.ma_device_config_init(c.ma_device_type_playback);
        config.sampleRate = e.sample_rate;
        config.periodSizeInFrames = options.period_size_in_frames;
        config.periodSizeInMilliseconds = options.period_size_in_milliseconds;
        config.periods = options.periods;
        config.performanceProfile = toPerformanceProfile(options.performance_profile);
        config.noPreSilencedOutputBuffer = toMaBool8(options.no_pre_silenced_output_buffer);
        config.noClip = toMaBool8(options.no_clip);
        config.noDisableDenormals = toMaBool8(options.no_disable_denormals);
        config.noFixedSizedCallback = toMaBool8(options.no_fixed_sized_callback);
        config.playback.format = c.ma_format_f32;
        config.playback.channels = @intCast(e.output_channels);
        config.playback.shareMode = toShareMode(options.share_mode);
        config.playback.pDeviceID = selected_device_id;
        config.wasapi.noAutoConvertSRC = toMaBool8(options.wasapi_no_auto_convert_src);
        config.wasapi.noDefaultQualitySRC = toMaBool8(options.wasapi_no_default_quality_src);
        config.alsa.noMMap = toMaBool32(options.alsa_no_mmap);
        config.alsa.noAutoFormat = toMaBool32(options.alsa_no_auto_format);
        config.alsa.noAutoChannels = toMaBool32(options.alsa_no_auto_channels);
        config.alsa.noAutoResample = toMaBool32(options.alsa_no_auto_resample);
        config.dataCallback = audioCallback;
        config.pUserData = e;

        const init_result = c.ma_device_init(&e.context, &config, &e.device);
        if (init_result != c.MA_SUCCESS) {
            e.lock.unlock(io);
            return Status.err_device;
        }

        e.has_device = true;
        const device_channels = e.device.playback.channels;
        const max_channels: c.ma_uint32 = @intCast(c.MA_MAX_CHANNELS);
        if (device_channels > 0 and device_channels <= max_channels) {
            e.output_channels = std.math.cast(u8, device_channels) orelse e.output_channels;
        }
    }

    // Device startup can fail after mixer-only mode is active; preserve that mode.
    const was_started = e.started;
    e.started = true;
    e.lock.unlock(io);

    const start_result = c.ma_device_start(&e.device);
    if (start_result != c.MA_SUCCESS) {
        e.lock.lockUncancelable(io);
        e.started = was_started;
        c.ma_device_uninit(&e.device);
        e.has_device = false;
        e.lock.unlock(io);
        return Status.err_device;
    }

    return Status.ok;
}

pub fn startMixer(engine: *Engine) i32 {
    engine.lock.lockUncancelable(io);
    engine.started = true;
    engine.lock.unlock(io);
    return Status.ok;
}

pub fn stop(engine: *Engine) i32 {
    const e = engine;
    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);

    e.started = false;
    if (e.has_device) {
        _ = c.ma_device_stop(&e.device);
        c.ma_device_uninit(&e.device);
        e.has_device = false;
    }
    return Status.ok;
}

const StreamFrameOptions = struct {
    capacity_frames: u32,
    startup_frames: u32,
    resume_frames: u32,
};

fn durationToFrames(duration_ms: u32, sample_rate: u32) ?u32 {
    if (duration_ms == 0 or sample_rate == 0) return null;
    const frames = (@as(u64, duration_ms) * @as(u64, sample_rate) + 999) / 1_000;
    if (frames > std.math.maxInt(u32)) return null;
    return @intCast(frames);
}

fn resolveStreamFrameOptions(options: StreamOptions, sample_rate: u32) ?StreamFrameOptions {
    const capacity = durationToFrames(options.capacity_ms, sample_rate) orelse return null;
    const startup = durationToFrames(options.startup_ms, sample_rate) orelse return null;
    const resume_frames = durationToFrames(options.resume_ms, sample_rate) orelse return null;
    if (startup > capacity or resume_frames > capacity or capacity > max_stream_pcm_capacity_frames) return null;

    return .{ .capacity_frames = capacity, .startup_frames = startup, .resume_frames = resume_frames };
}

fn streamIdForSlot(engine: *const Engine, slot_index: usize) u32 {
    const slot: u32 = @intCast(slot_index + 1);
    return (engine.stream_generations[slot_index] << 8) | slot;
}

fn streamSlotIndex(engine: *const Engine, stream_id: u32) ?usize {
    const slot: u8 = @truncate(stream_id);
    const generation = stream_id >> 8;
    if (slot == 0 or generation == 0) return null;

    const slot_index = @as(usize, slot) - 1;
    if (slot_index >= engine.streams.len or engine.stream_generations[slot_index] != generation) return null;
    return slot_index;
}

fn getStream(engine: *Engine, stream_id: u32) ?*Stream {
    const slot_index = streamSlotIndex(engine, stream_id) orelse return null;
    return engine.streams[slot_index];
}

fn retireStreamSlotLocked(engine: *Engine, slot_index: usize) void {
    engine.streams[slot_index] = null;
    const generation = engine.stream_generations[slot_index];
    engine.stream_generations[slot_index] = if (generation == max_stream_generation) 0 else generation + 1;
}

pub fn createStream(engine: *Engine, options_ptr: ?*const StreamOptions, out_stream_id: ?*u32) i32 {
    if (options_ptr == null or out_stream_id == null) return Status.err_invalid;
    const options = options_ptr.?.*;
    switch (options.format) {
        StreamFormat.mp3, StreamFormat.flac => if (options.max_probe_bytes == 0) return Status.err_invalid,
        StreamFormat.pcm => {
            if (options.channels < 1 or options.channels > 2 or
                options.sample_rate < min_pcm_sample_rate or options.sample_rate > max_pcm_sample_rate or
                engine.sample_rate < min_pcm_sample_rate or engine.sample_rate > max_pcm_sample_rate) return Status.err_invalid;
        },
        else => return Status.err_invalid,
    }
    const frame_options = resolveStreamFrameOptions(options, engine.sample_rate) orelse return Status.err_invalid;

    const e = engine;
    const preflight = blk: {
        e.lock.lockUncancelable(io);
        defer e.lock.unlock(io);

        reapFinishedVoices(e);
        const group_index: usize = @intCast(options.group_id);
        if (group_index >= e.groups.items.len) return Status.err_invalid;
        if (e.activeVoiceAndStreamCount() >= max_voices) return Status.err_no_space;

        for (e.streams, 0..) |existing_stream, slot_index| {
            if (existing_stream == null and e.stream_generations[slot_index] != 0) {
                break :blk .{ .group_index = group_index, .slot_index = slot_index };
            }
        }
        return Status.err_no_space;
    };

    const stream = e.allocator.create(Stream) catch return Status.err_no_space;
    const input_buffer = e.allocator.alloc(u8, stream_input_capacity) catch {
        e.allocator.destroy(stream);
        return Status.err_no_space;
    };
    const pcm_sample_count = std.math.mul(usize, @as(usize, frame_options.capacity_frames), 2) catch {
        e.allocator.free(input_buffer);
        e.allocator.destroy(stream);
        return Status.err_no_space;
    };
    const pcm_buffer = e.allocator.alloc(f32, pcm_sample_count) catch {
        e.allocator.free(input_buffer);
        e.allocator.destroy(stream);
        return Status.err_no_space;
    };

    stream.* = .{
        .allocator = e.allocator,
        .input_buffer = input_buffer,
        .pcm_buffer = pcm_buffer,
        .startup_frames = frame_options.startup_frames,
        .resume_frames = frame_options.resume_frames,
        .max_probe_bytes = options.max_probe_bytes,
        .format = options.format,
        .input_sample_rate = options.sample_rate,
        .input_channels = options.channels,
        .sample_rate = e.sample_rate,
        .capacity_frames = frame_options.capacity_frames,
    };
    stream.source.stream = stream;

    if (c.ma_pcm_rb_init(c.ma_format_f32, 2, frame_options.capacity_frames, pcm_buffer.ptr, null, &stream.pcm_ring) != c.MA_SUCCESS) {
        destroyStreamStorage(stream, null);
        return Status.err_device;
    }
    stream.pcm_ring_ready = true;
    c.ma_pcm_rb_set_sample_rate(&stream.pcm_ring, e.sample_rate);

    var source_config = c.ma_data_source_config_init();
    source_config.vtable = &stream_data_source_vtable;
    if (c.ma_data_source_init(&source_config, @ptrCast(&stream.source)) != c.MA_SUCCESS) {
        destroyStreamStorage(stream, null);
        return Status.err_device;
    }
    stream.source_ready = true;

    e.lock.lockUncancelable(io);
    const data_source: *c.ma_data_source = @ptrCast(&stream.source);
    const sound_flags: c.ma_uint32 = c.MA_SOUND_FLAG_NO_SPATIALIZATION | c.MA_SOUND_FLAG_NO_PITCH;
    if (c.ma_sound_init_from_data_source(&e.core, data_source, sound_flags, &e.groups.items[preflight.group_index].node, &stream.sound) != c.MA_SUCCESS) {
        e.lock.unlock(io);
        destroyStreamStorage(stream, null);
        return Status.err_device;
    }
    stream.sound_ready = true;
    c.ma_sound_set_pan(&stream.sound, clamp(options.pan, -1, 1));
    c.ma_sound_set_volume(&stream.sound, clamp(options.volume, 0, 4));
    if (c.ma_sound_start(&stream.sound) != c.MA_SUCCESS) {
        c.ma_sound_uninit(&stream.sound);
        stream.sound_ready = false;
        e.lock.unlock(io);
        destroyStreamStorage(stream, null);
        return Status.err_device;
    }

    const slot_index = preflight.slot_index;
    e.streams[slot_index] = stream;
    const stream_id = streamIdForSlot(e, slot_index);
    e.updateActiveVoiceCount();
    e.lock.unlock(io);

    stream.worker = std.Thread.spawn(.{}, streamDecoderWorker, .{stream}) catch {
        e.lock.lockUncancelable(io);
        if (stream.sound_ready) {
            _ = c.ma_sound_stop(&stream.sound);
            c.ma_sound_uninit(&stream.sound);
            stream.sound_ready = false;
        }
        retireStreamSlotLocked(e, slot_index);
        e.updateActiveVoiceCount();
        e.lock.unlock(io);
        destroyStreamStorage(stream, null);
        return Status.err_no_space;
    };

    out_stream_id.?.* = stream_id;
    return Status.ok;
}

pub fn writeStream(
    engine: *Engine,
    stream_id: u32,
    data_ptr: ?[*]const u8,
    data_len: u32,
) i32 {
    if (stream_id == 0 or (data_len > 0 and data_ptr == null)) return Status.err_invalid;

    const e = engine;
    // This pins the stream slot through the bounded copy; full input returns zero instead of waiting.
    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);
    const stream = getStream(e, stream_id) orelse return Status.err_not_found;

    stream.input_lock.lockUncancelable(io);
    defer stream.input_lock.unlock(io);
    if (@atomicLoad(u32, &stream.input_ended, .acquire) != 0 or
        @atomicLoad(u32, &stream.cancel_requested, .acquire) != 0 or
        stream.decoder_abort or isTerminalStreamState(loadStreamState(stream)))
    {
        return Status.err_invalid;
    }
    if (data_len == 0) return 0;

    const available = stream.input_buffer.len - stream.input_count;
    const write_count = @min(@as(usize, data_len), available);
    if (write_count == 0) return 0;

    const data = data_ptr.?[0..write_count];
    const first_count = @min(write_count, stream.input_buffer.len - stream.input_write);
    @memcpy(stream.input_buffer[stream.input_write .. stream.input_write + first_count], data[0..first_count]);
    const second_count = write_count - first_count;
    if (second_count > 0) {
        @memcpy(stream.input_buffer[0..second_count], data[first_count..]);
    }

    stream.input_write = (stream.input_write + write_count) % stream.input_buffer.len;
    stream.input_count += write_count;
    _ = @atomicRmw(u64, &stream.bytes_received, .Add, write_count, .monotonic);
    stream.input_condition.signal(io);
    return @intCast(write_count);
}

pub fn endStream(engine: *Engine, stream_id: u32) i32 {
    if (stream_id == 0) return Status.err_invalid;
    const e = engine;
    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);
    const stream = getStream(e, stream_id) orelse return Status.err_not_found;

    stream.input_lock.lockUncancelable(io);
    defer stream.input_lock.unlock(io);
    if (loadStreamState(stream) == StreamState.failed or @atomicLoad(u32, &stream.cancel_requested, .acquire) != 0) {
        return Status.err_invalid;
    }
    @atomicStore(u32, &stream.input_ended, 1, .release);
    stream.input_condition.broadcast(io);
    return Status.ok;
}

pub fn restartStream(engine: *Engine, stream_id: u32) i32 {
    if (stream_id == 0) return Status.err_invalid;
    const e = engine;

    e.lock.lockUncancelable(io);
    const stream = getStream(e, stream_id) orelse {
        e.lock.unlock(io);
        return Status.err_not_found;
    };

    stream.input_lock.lockUncancelable(io);
    const state = loadStreamState(stream);
    if (state == StreamState.failed or
        state == StreamState.cancelled or
        stream.format == StreamFormat.pcm or
        @atomicLoad(u32, &stream.cancel_requested, .acquire) != 0 or
        stream.worker == null)
    {
        stream.input_lock.unlock(io);
        e.lock.unlock(io);
        return Status.err_invalid;
    }

    setStreamState(stream, StreamState.reconnecting);
    @atomicStore(u32, &stream.decoder_stop_requested, 1, .release);
    stream.input_condition.broadcast(io);
    stream.input_lock.unlock(io);

    const worker = stream.worker.?;
    stream.worker = null;
    e.lock.unlock(io);

    worker.join();

    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);

    stream.input_lock.lockUncancelable(io);
    stream.input_read = 0;
    stream.input_write = 0;
    stream.input_count = 0;
    @atomicStore(u32, &stream.input_ended, 0, .release);
    @atomicStore(u32, &stream.decoder_finished, 0, .release);
    stream.decoder_abort = false;
    stream.probe_active = true;
    stream.probe_bytes = 0;
    @atomicStore(i32, &stream.error_code, 0, .release);
    @atomicStore(u32, &stream.decoder_stop_requested, 0, .release);
    stream.input_lock.unlock(io);

    if (state == StreamState.ended) {
        // start() clears atEnd only after its is-playing check; stop first so its
        // tolerated seek on this unseekable source also resets the ended latch.
        if (!stream.sound_ready or
            c.ma_sound_stop(&stream.sound) != c.MA_SUCCESS or
            c.ma_sound_start(&stream.sound) != c.MA_SUCCESS)
        {
            failStreamWithCode(stream, Status.err_device);
            return Status.err_device;
        }
    }

    stream.worker = std.Thread.spawn(.{}, streamDecoderWorker, .{stream}) catch {
        failStreamWithCode(stream, Status.err_no_space);
        return Status.err_no_space;
    };

    return Status.ok;
}

pub fn setStreamVolume(engine: *Engine, stream_id: u32, volume: f32) i32 {
    if (stream_id == 0) return Status.err_invalid;
    const e = engine;
    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);
    const stream = getStream(e, stream_id) orelse return Status.err_not_found;

    c.ma_sound_set_volume(&stream.sound, clamp(volume, 0, 4));
    return Status.ok;
}

pub fn setStreamPan(engine: *Engine, stream_id: u32, pan: f32) i32 {
    if (stream_id == 0) return Status.err_invalid;
    const e = engine;
    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);
    const stream = getStream(e, stream_id) orelse return Status.err_not_found;

    c.ma_sound_set_pan(&stream.sound, clamp(pan, -1, 1));
    return Status.ok;
}

pub fn setStreamGroup(engine: *Engine, stream_id: u32, group_id: u32) i32 {
    if (stream_id == 0) return Status.err_invalid;
    const e = engine;
    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);

    const stream = getStream(e, stream_id) orelse return Status.err_not_found;
    const group_index: usize = @intCast(group_id);
    if (group_index >= e.groups.items.len) return Status.err_invalid;

    if (c.ma_node_attach_output_bus(@ptrCast(&stream.sound), 0, @ptrCast(&e.groups.items[group_index].node), 0) != c.MA_SUCCESS) {
        return Status.err_device;
    }
    return Status.ok;
}

fn snapshotStream(stream: *Stream, final: bool) StreamStats {
    return .{
        .bytes_received = @atomicLoad(u64, &stream.bytes_received, .monotonic),
        .frames_decoded = @atomicLoad(u64, &stream.frames_decoded, .monotonic),
        .frames_played = @atomicLoad(u64, &stream.frames_played, .monotonic),
        .state = loadStreamState(stream),
        .sample_rate = stream.sample_rate,
        .channels = 2,
        .buffered_frames = if (final) 0 else c.ma_pcm_rb_available_read(&stream.pcm_ring),
        .capacity_frames = stream.capacity_frames,
        .underruns = @atomicLoad(u32, &stream.underruns, .monotonic),
        .error_code = @atomicLoad(i32, &stream.error_code, .acquire),
        .ready_generation = @atomicLoad(u32, &stream.ready_generation, .acquire),
    };
}

pub fn getStreamStats(engine: *Engine, stream_id: u32, out_stats: ?*StreamStats) i32 {
    if (stream_id == 0 or out_stats == null) return Status.err_invalid;
    // Native entry is serialized, and private audio threads never mutate stream slots.
    const stream = getStream(engine, stream_id) orelse return Status.err_not_found;

    out_stats.?.* = snapshotStream(stream, false);
    return Status.ok;
}

pub fn closeStream(engine: *Engine, stream_id: u32, reason: u32, out_final_stats: ?*StreamStats) i32 {
    if (stream_id == 0 or out_final_stats == null or reason > StreamCloseReason.disposed) return Status.err_invalid;
    const e = engine;
    e.lock.lockUncancelable(io);
    const slot_index = streamSlotIndex(e, stream_id) orelse {
        e.lock.unlock(io);
        return Status.err_not_found;
    };
    const stream = e.streams[slot_index] orelse {
        e.lock.unlock(io);
        return Status.err_not_found;
    };

    transitionStreamToTerminal(
        stream,
        if (reason == StreamCloseReason.transport_error) StreamState.failed else StreamState.cancelled,
    );

    if (stream.sound_ready) {
        _ = c.ma_sound_stop(&stream.sound);
        c.ma_sound_uninit(&stream.sound);
        stream.sound_ready = false;
    }
    retireStreamSlotLocked(e, slot_index);
    e.updateActiveVoiceCount();
    e.lock.unlock(io);

    requestStreamCancellation(stream);
    destroyStreamStorage(stream, out_final_stats);
    return Status.ok;
}

pub fn load(engine: *Engine, data_ptr: ?[*]const u8, data_len: usize, out_sound_id: ?*u32) i32 {
    if (data_ptr == null or out_sound_id == null or data_len == 0) return Status.err_invalid;
    const e = engine;
    const encoded_audio = @as([*]const u8, @ptrCast(data_ptr.?))[0..data_len];
    const sound = decodeSoundFromMemory(e.allocator, encoded_audio) catch return Status.err_decode;

    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);

    e.sounds.append(e.allocator, sound) catch {
        e.allocator.free(sound.samples);
        return Status.err_no_space;
    };

    out_sound_id.?.* = @intCast(e.sounds.items.len);
    e.updateLoadedSoundCount();
    return Status.ok;
}

pub fn unload(engine: *Engine, sound_id: u32) i32 {
    if (sound_id == 0) return Status.err_invalid;
    const e = engine;

    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);

    const sound_index: usize = @intCast(sound_id - 1);
    if (sound_index >= e.sounds.items.len) return Status.err_not_found;

    const sound = &e.sounds.items[sound_index];
    if (!sound.loaded) return Status.err_not_found;

    for (&e.voices) |*voice| {
        if (voice.active and voice.sound_index == sound_index) {
            clearVoice(voice);
        }
    }

    const empty_samples = sound.samples[0..0];
    e.allocator.free(sound.samples);
    sound.samples = empty_samples;
    sound.loaded = false;
    sound.channels = 0;
    sound.sample_rate = 0;

    e.updateActiveVoiceCount();
    e.updateLoadedSoundCount();
    return Status.ok;
}

pub fn createGroup(engine: *Engine, name_ptr: ?[*]const u8, name_len: usize, out_group_id: ?*u32) i32 {
    if (name_ptr == null or out_group_id == null) return Status.err_invalid;
    const e = engine;
    const name = @as([*]const u8, @ptrCast(name_ptr.?))[0..name_len];

    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);

    for (e.groups.items, 0..) |group, idx| {
        if (std.mem.eql(u8, group.name, name)) {
            out_group_id.?.* = @intCast(idx);
            return Status.ok;
        }
    }

    const group = e.allocator.create(SoundGroup) catch return Status.err_no_space;
    group.* = .{
        .name = e.allocator.dupe(u8, name) catch {
            e.allocator.destroy(group);
            return Status.err_no_space;
        },
    };

    const init_result = c.ma_sound_group_init(&e.core, 0, null, &group.node);
    if (init_result != c.MA_SUCCESS) {
        e.allocator.free(group.name);
        e.allocator.destroy(group);
        return Status.err_device;
    }
    group.initialized = true;
    c.ma_sound_group_set_volume(&group.node, 1);

    e.groups.append(e.allocator, group) catch {
        c.ma_sound_group_uninit(&group.node);
        e.allocator.free(group.name);
        e.allocator.destroy(group);
        return Status.err_no_space;
    };

    out_group_id.?.* = @intCast(e.groups.items.len - 1);
    return Status.ok;
}

pub fn play(engine: *Engine, sound_id: u32, options_ptr: ?*const VoiceOptions, out_voice_id: ?*u32) i32 {
    if (out_voice_id == null) return Status.err_invalid;
    const e = engine;

    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);
    reapFinishedVoices(e);

    if (sound_id == 0 or sound_id > @as(u32, @intCast(e.sounds.items.len))) return Status.err_not_found;

    const options = if (options_ptr) |opts| opts.* else VoiceOptions{
        .volume = 1,
        .pan = 0,
        .loop = false,
        .group_id = 0,
    };

    const group_index: usize = @intCast(options.group_id);
    if (group_index >= e.groups.items.len) return Status.err_invalid;
    if (e.activeVoiceAndStreamCount() >= max_voices) return Status.err_no_space;

    var free_index: ?usize = null;
    for (e.voices, 0..) |voice, idx| {
        if (!voice.active) {
            free_index = idx;
            break;
        }
    }
    if (free_index == null) return Status.err_no_space;

    const slot = &e.voices[free_index.?];
    clearVoice(slot);

    const sound = e.sounds.items[@intCast(sound_id - 1)];
    if (!sound.loaded) return Status.err_not_found;
    const frame_count: usize = sound.samples.len / @as(usize, sound.channels);

    if (c.ma_audio_buffer_ref_init(c.ma_format_f32, sound.channels, sound.samples.ptr, @intCast(frame_count), &slot.buffer_ref) != c.MA_SUCCESS) {
        return Status.err_device;
    }
    slot.buffer_ref.sampleRate = sound.sample_rate;
    slot.buffer_ready = true;

    const group_ptr = &e.groups.items[group_index].node;
    const data_source: *c.ma_data_source = @ptrCast(&slot.buffer_ref);
    const sound_flags: c.ma_uint32 = c.MA_SOUND_FLAG_NO_SPATIALIZATION | c.MA_SOUND_FLAG_NO_PITCH;
    if (c.ma_sound_init_from_data_source(&e.core, data_source, sound_flags, group_ptr, &slot.sound) != c.MA_SUCCESS) {
        clearVoice(slot);
        return Status.err_device;
    }
    slot.sound_ready = true;

    slot.active = true;
    slot.sound_index = @intCast(sound_id - 1);
    slot.volume = clamp(options.volume, 0, 4);
    slot.pan = clamp(options.pan, -1, 1);
    slot.loop = options.loop;
    slot.group_id = options.group_id;

    c.ma_sound_set_looping(&slot.sound, if (slot.loop) c.MA_TRUE else c.MA_FALSE);
    c.ma_sound_set_pan(&slot.sound, slot.pan);
    c.ma_sound_set_volume(&slot.sound, slot.volume);

    if (c.ma_sound_start(&slot.sound) != c.MA_SUCCESS) {
        clearVoice(slot);
        return Status.err_device;
    }

    out_voice_id.?.* = @intCast(free_index.? + 1);
    e.updateActiveVoiceCount();
    return Status.ok;
}

pub fn stopVoice(engine: *Engine, voice_id: u32) i32 {
    if (voice_id == 0) return Status.err_invalid;
    const e = engine;

    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);

    const idx: usize = @intCast(voice_id - 1);
    if (idx >= e.voices.len) return Status.err_not_found;
    if (!e.voices[idx].active) return Status.err_not_found;

    _ = c.ma_sound_stop(&e.voices[idx].sound);
    clearVoice(&e.voices[idx]);
    e.updateActiveVoiceCount();
    return Status.ok;
}

pub fn setVoiceGroup(engine: *Engine, voice_id: u32, group_id: u32) i32 {
    if (voice_id == 0) return Status.err_invalid;
    const e = engine;

    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);

    const voice_index: usize = @intCast(voice_id - 1);
    const group_index: usize = @intCast(group_id);
    if (voice_index >= e.voices.len or group_index >= e.groups.items.len) return Status.err_invalid;

    const voice = &e.voices[voice_index];
    if (!voice.active or !voice.sound_ready or !voice.buffer_ready) return Status.err_not_found;

    var cursor: c.ma_uint64 = 0;
    _ = c.ma_sound_get_cursor_in_pcm_frames(&voice.sound, &cursor);
    const was_playing = c.ma_sound_is_playing(&voice.sound) != c.MA_FALSE;

    c.ma_sound_uninit(&voice.sound);
    voice.sound_ready = false;

    const group_ptr = &e.groups.items[group_index].node;
    const data_source: *c.ma_data_source = @ptrCast(&voice.buffer_ref);
    const sound_flags: c.ma_uint32 = c.MA_SOUND_FLAG_NO_SPATIALIZATION | c.MA_SOUND_FLAG_NO_PITCH;
    if (c.ma_sound_init_from_data_source(&e.core, data_source, sound_flags, group_ptr, &voice.sound) != c.MA_SUCCESS) {
        clearVoice(voice);
        e.updateActiveVoiceCount();
        return Status.err_device;
    }

    voice.sound_ready = true;
    _ = c.ma_sound_seek_to_pcm_frame(&voice.sound, cursor);
    c.ma_sound_set_looping(&voice.sound, if (voice.loop) c.MA_TRUE else c.MA_FALSE);
    c.ma_sound_set_pan(&voice.sound, voice.pan);
    c.ma_sound_set_volume(&voice.sound, voice.volume);

    if (was_playing and c.ma_sound_start(&voice.sound) != c.MA_SUCCESS) {
        clearVoice(voice);
        e.updateActiveVoiceCount();
        return Status.err_device;
    }

    voice.group_id = group_id;
    return Status.ok;
}

pub fn setGroupVolume(engine: *Engine, group_id: u32, volume: f32) i32 {
    const e = engine;

    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);

    const group_index: usize = @intCast(group_id);
    if (group_index >= e.groups.items.len) return Status.err_invalid;

    const clamped = clamp(volume, 0, 4);
    e.groups.items[group_index].volume = clamped;
    c.ma_sound_group_set_volume(&e.groups.items[group_index].node, clamped);
    return Status.ok;
}

pub fn setMasterVolume(engine: *Engine, volume: f32) i32 {
    const e = engine;

    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);

    const clamped = clamp(volume, 0, 4);
    const result = c.ma_engine_set_volume(&e.core, clamped);
    if (result != c.MA_SUCCESS) return Status.err_device;

    e.master_volume = clamped;
    return Status.ok;
}

pub fn enableTap(engine: *Engine, enabled: bool, capacity_frames: u32) i32 {
    const e = engine;
    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);

    if (!enabled) {
        e.tap_enabled = false;
        e.tap_capacity_frames = 0;
        e.tap_write_frame = 0;
        e.tap_frame_count = 0;
        if (e.tap_buffer) |buffer| {
            e.allocator.free(buffer);
            e.tap_buffer = null;
        }
        return Status.ok;
    }

    if (capacity_frames == 0) return Status.err_invalid;

    const sample_count = std.math.mul(usize, @as(usize, capacity_frames), @as(usize, e.tap_channels)) catch return Status.err_no_space;
    const next_buffer = e.allocator.alloc(f32, sample_count) catch return Status.err_no_space;
    @memset(next_buffer, 0);

    if (e.tap_buffer) |buffer| {
        e.allocator.free(buffer);
    }

    e.tap_buffer = next_buffer;
    e.tap_enabled = true;
    e.tap_capacity_frames = capacity_frames;
    e.tap_write_frame = 0;
    e.tap_frame_count = 0;
    return Status.ok;
}

pub fn readTap(engine: *Engine, out_ptr: ?[*]f32, frame_count: u32, channels: u8, out_frames_read: ?*u32) i32 {
    if (out_ptr == null or out_frames_read == null) return Status.err_invalid;
    if (channels == 0) return Status.err_invalid;

    const e = engine;
    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);

    const out = @as([*]f32, @ptrCast(out_ptr.?))[0 .. @as(usize, frame_count) * @as(usize, channels)];
    @memset(out, 0);

    if (!e.tap_enabled or e.tap_capacity_frames == 0 or e.tap_frame_count == 0) {
        out_frames_read.?.* = 0;
        return Status.ok;
    }

    const tap_buffer = e.tap_buffer orelse {
        out_frames_read.?.* = 0;
        return Status.ok;
    };

    const available = @min(frame_count, e.tap_frame_count);
    if (available == 0) {
        out_frames_read.?.* = 0;
        return Status.ok;
    }

    const tap_channels: usize = e.tap_channels;
    const capacity_frames: usize = e.tap_capacity_frames;
    const start_frame_u32 = if (e.tap_write_frame >= available)
        e.tap_write_frame - available
    else
        e.tap_capacity_frames - (available - e.tap_write_frame);

    for (0..@as(usize, available)) |i| {
        const src_frame = (@as(usize, start_frame_u32) + i) % capacity_frames;
        const src = src_frame * tap_channels;
        const left = tap_buffer[src];
        const right = if (tap_channels > 1) tap_buffer[src + 1] else left;

        const dst = i * @as(usize, channels);
        if (channels == 1) {
            out[dst] = clamp((left + right) * 0.5, -1, 1);
            continue;
        }

        out[dst] = left;
        out[dst + 1] = right;
    }

    out_frames_read.?.* = available;
    return Status.ok;
}

fn audioCallback(device_ptr: ?*c.ma_device, output_ptr: ?*anyopaque, input_ptr: ?*const anyopaque, frame_count: c.ma_uint32) callconv(.c) void {
    _ = input_ptr;
    if (device_ptr == null or output_ptr == null) return;

    const device = device_ptr.?;
    const output_channels = std.math.cast(usize, device.playback.channels) orelse return;
    if (output_channels == 0) return;

    const stats_channels: u8 = if (output_channels <= std.math.maxInt(u8)) @intCast(output_channels) else std.math.maxInt(u8);
    const aligned_output: *align(@alignOf(f32)) anyopaque = @alignCast(output_ptr.?);
    const out = @as([*]f32, @ptrCast(aligned_output))[0 .. @as(usize, frame_count) * output_channels];

    const user_data = device.pUserData orelse {
        @memset(out, 0);
        return;
    };

    const engine: *Engine = @ptrCast(@alignCast(user_data));

    if (!engine.lock.tryLock()) {
        @memset(out, 0);
        incrementLockMisses(engine);
        return;
    }
    defer engine.lock.unlock(io);

    if (!engine.started) {
        @memset(out, 0);
        updateStatsFromBuffer(engine, out, @intCast(frame_count), stats_channels);
        reapFinishedVoices(engine);
        return;
    }

    if (output_channels == 2) {
        const status = readEngineStereo(engine, out, @intCast(frame_count));
        if (status != Status.ok) {
            @memset(out, 0);
        }
    } else {
        @memset(out, 0);

        var remaining: usize = frame_count;
        var frame_offset: usize = 0;
        var temp_stereo: [2048]f32 = undefined;

        while (remaining > 0) {
            const chunk_frames: usize = @min(remaining, 1024);
            const stereo_slice = temp_stereo[0 .. chunk_frames * 2];
            const status = readEngineStereo(engine, stereo_slice, @intCast(chunk_frames));
            if (status != Status.ok) {
                @memset(out, 0);
                break;
            }

            for (0..chunk_frames) |i| {
                const l = stereo_slice[i * 2];
                const r = stereo_slice[i * 2 + 1];
                const dst = (frame_offset + i) * output_channels;
                if (output_channels == 1) {
                    out[dst] = clamp((l + r) * 0.5, -1, 1);
                } else {
                    out[dst] = l;
                    out[dst + 1] = r;
                }
            }

            frame_offset += chunk_frames;
            remaining -= chunk_frames;
        }
    }

    writeTapFrames(engine, out, @intCast(frame_count), stats_channels);

    updateStatsFromBuffer(engine, out, @intCast(frame_count), stats_channels);
    reapFinishedVoices(engine);
}

pub fn mixToBuffer(engine: *Engine, out_ptr: ?[*]f32, frame_count: u32, channels: u8) i32 {
    if (out_ptr == null) return Status.err_invalid;
    if (channels == 0) return Status.err_invalid;

    const e = engine;
    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);

    const out = @as([*]f32, @ptrCast(out_ptr.?))[0 .. @as(usize, frame_count) * @as(usize, channels)];
    @memset(out, 0);

    if (!e.started or frame_count == 0) {
        updateStatsFromBuffer(e, out, frame_count, channels);
        reapFinishedVoices(e);
        return Status.ok;
    }

    if (channels == 2) {
        const status = readEngineStereo(e, out, frame_count);
        if (status != Status.ok) return status;

        writeTapFrames(e, out, frame_count, channels);

        updateStatsFromBuffer(e, out, frame_count, channels);
        reapFinishedVoices(e);
        return Status.ok;
    }

    var remaining: usize = frame_count;
    var frame_offset: usize = 0;
    var temp_stereo: [2048]f32 = undefined;

    while (remaining > 0) {
        const chunk_frames: usize = @min(remaining, 1024);
        const stereo_slice = temp_stereo[0 .. chunk_frames * 2];
        const status = readEngineStereo(e, stereo_slice, @intCast(chunk_frames));
        if (status != Status.ok) return status;

        for (0..chunk_frames) |i| {
            const l = stereo_slice[i * 2];
            const r = stereo_slice[i * 2 + 1];
            const dst = (frame_offset + i) * @as(usize, channels);

            if (channels == 1) {
                out[dst] = clamp((l + r) * 0.5, -1, 1);
            } else {
                out[dst] = l;
                out[dst + 1] = r;
            }
        }

        frame_offset += chunk_frames;
        remaining -= chunk_frames;
    }

    writeTapFrames(e, out, frame_count, channels);

    updateStatsFromBuffer(e, out, frame_count, channels);
    reapFinishedVoices(e);
    return Status.ok;
}

pub fn getStats(engine: *Engine, out_stats: ?*Stats) i32 {
    if (out_stats == null) return Status.err_invalid;

    const e = engine;
    e.lock.lockUncancelable(io);
    defer e.lock.unlock(io);

    e.stats.lock_misses = loadLockMisses(e);
    reapFinishedVoices(e);
    out_stats.?.* = e.stats;
    return Status.ok;
}
