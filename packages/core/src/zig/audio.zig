const std = @import("std");
const c = @cImport({
    @cInclude("vendor/miniaudio/miniaudio.h");
});

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

pub const Stats = extern struct {
    sounds_loaded: u32,
    voices_active: u32,
    frames_mixed: u64,
    lock_misses: u32,
    last_peak: f32,
    last_rms: f32,
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

const SoundGroup = struct {
    name: []u8,
    volume: f32 = 1,
    node: c.ma_sound_group = undefined,
    initialized: bool = false,
};

pub const Engine = struct {
    allocator: std.mem.Allocator,
    started: bool = false,
    lock: std.Thread.Mutex = .{},
    context: c.ma_context = undefined,
    context_initialized: bool = false,
    core: c.ma_engine = undefined,
    core_initialized: bool = false,
    sounds: std.ArrayList(Sound),
    groups: std.ArrayList(*SoundGroup),
    playback_devices: std.ArrayList(c.ma_device_info),
    selected_playback_index: ?u32 = null,
    voices: [max_voices]Voice,
    master_volume: f32,
    sample_rate: u32,
    stats: Stats,
    device: c.ma_device = undefined,
    has_device: bool = false,
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
            .voices = [_]Voice{.{}} ** max_voices,
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
        self.lock.lock();
        defer self.lock.unlock();

        if (self.has_device) {
            _ = c.ma_device_stop(&self.device);
            c.ma_device_uninit(&self.device);
            self.has_device = false;
        }

        for (&self.voices) |*voice| {
            clearVoice(voice);
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

        if (self.tap_buffer) |buffer| {
            self.allocator.free(buffer);
            self.tap_buffer = null;
        }

        if (self.context_initialized) {
            _ = c.ma_context_uninit(&self.context);
            self.context_initialized = false;
        }

        if (self.core_initialized) {
            c.ma_engine_uninit(&self.core);
            self.core_initialized = false;
        }
    }

    fn updateActiveVoiceCount(self: *Engine) void {
        var active: u32 = 0;
        for (self.voices) |voice| {
            if (voice.active) active += 1;
        }
        self.stats.voices_active = active;
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

fn copyPlaybackDeviceName(device: *const c.ma_device_info, out_ptr: [*]u8, max_len: usize) usize {
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
    errdefer allocator.destroy(engine);
    engine.* = Engine.init(allocator, sample_rate, output_channels);

    var config = c.ma_engine_config_init();
    config.noDevice = c.MA_TRUE;
    config.channels = 2;
    config.sampleRate = sample_rate;

    if (c.ma_engine_init(&config, &engine.core) != c.MA_SUCCESS) return null;
    engine.core_initialized = true;
    engine.sample_rate = c.ma_engine_get_sample_rate(&engine.core);

    initDefaultGroup(engine) catch return null;
    return engine;
}

pub fn destroy(engine: *Engine) void {
    const e = engine;
    e.deinit();
    e.allocator.destroy(e);
}

pub fn refreshPlaybackDevices(engine: *Engine) i32 {
    const e = engine;
    e.lock.lock();
    defer e.lock.unlock();
    return refreshPlaybackDevicesLocked(e);
}

pub fn getPlaybackDeviceCount(engine: *Engine) u32 {
    const e = engine;
    e.lock.lock();
    defer e.lock.unlock();
    return @intCast(e.playback_devices.items.len);
}

pub fn getPlaybackDeviceName(engine: *Engine, index: u32, out_ptr: ?[*]u8, max_len: usize) usize {
    if (out_ptr == null) return 0;

    const e = engine;
    e.lock.lock();
    defer e.lock.unlock();

    const idx: usize = @intCast(index);
    if (idx >= e.playback_devices.items.len) return 0;
    return copyPlaybackDeviceName(&e.playback_devices.items[idx], out_ptr.?, max_len);
}

pub fn isPlaybackDeviceDefault(engine: *Engine, index: u32) bool {
    const e = engine;
    e.lock.lock();
    defer e.lock.unlock();

    const idx: usize = @intCast(index);
    if (idx >= e.playback_devices.items.len) return false;
    return e.playback_devices.items[idx].isDefault != c.MA_FALSE;
}

pub fn selectPlaybackDevice(engine: *Engine, index: u32) i32 {
    const e = engine;
    e.lock.lock();
    defer e.lock.unlock();

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
    e.lock.lock();
    defer e.lock.unlock();

    e.selected_playback_index = null;
    if (!e.started and e.has_device) {
        _ = c.ma_device_stop(&e.device);
        c.ma_device_uninit(&e.device);
        e.has_device = false;
    }
}

pub fn start(engine: *Engine, options_ptr: ?*const StartOptions) i32 {
    const e = engine;
    const options = if (options_ptr) |opts| opts.* else StartOptions{};
    if (e.started and e.has_device) return Status.ok;

    if (!e.has_device) {
        const context_status = ensureContextInitialized(e);
        if (context_status != Status.ok) return context_status;

        var selected_device_id: ?*const c.ma_device_id = null;
        if (e.selected_playback_index) |selected_index| {
            if (e.playback_devices.items.len == 0) {
                const refresh_status = refreshPlaybackDevicesLocked(e);
                if (refresh_status != Status.ok) return refresh_status;
            }

            const idx: usize = @intCast(selected_index);
            if (idx >= e.playback_devices.items.len) return Status.err_not_found;
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
            return Status.err_device;
        }

        e.has_device = true;
        const device_channels = e.device.playback.channels;
        const max_channels: c.ma_uint32 = @intCast(c.MA_MAX_CHANNELS);
        if (device_channels > 0 and device_channels <= max_channels) {
            e.output_channels = std.math.cast(u8, device_channels) orelse e.output_channels;
        }
    }

    const start_result = c.ma_device_start(&e.device);
    if (start_result != c.MA_SUCCESS) {
        c.ma_device_uninit(&e.device);
        e.has_device = false;
        return Status.err_device;
    }

    e.started = true;
    return Status.ok;
}

pub fn startMixer(engine: *Engine) i32 {
    engine.started = true;
    return Status.ok;
}

pub fn stop(engine: *Engine) i32 {
    const e = engine;
    if (e.has_device) {
        _ = c.ma_device_stop(&e.device);
        c.ma_device_uninit(&e.device);
        e.has_device = false;
    }
    e.started = false;
    return Status.ok;
}

pub fn load(engine: *Engine, data_ptr: ?[*]const u8, data_len: usize, out_sound_id: ?*u32) i32 {
    if (data_ptr == null or out_sound_id == null or data_len == 0) return Status.err_invalid;
    const e = engine;
    const encoded_audio = @as([*]const u8, @ptrCast(data_ptr.?))[0..data_len];
    const sound = decodeSoundFromMemory(e.allocator, encoded_audio) catch return Status.err_decode;

    e.lock.lock();
    defer e.lock.unlock();

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

    e.lock.lock();
    defer e.lock.unlock();

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

    e.lock.lock();
    defer e.lock.unlock();

    for (e.groups.items, 0..) |group, idx| {
        if (std.mem.eql(u8, group.name, name)) {
            out_group_id.?.* = @intCast(idx);
            return Status.ok;
        }
    }

    const group = e.allocator.create(SoundGroup) catch return Status.err_no_space;
    errdefer e.allocator.destroy(group);

    group.* = .{
        .name = e.allocator.dupe(u8, name) catch return Status.err_no_space,
    };
    errdefer e.allocator.free(group.name);

    const init_result = c.ma_sound_group_init(&e.core, 0, null, &group.node);
    if (init_result != c.MA_SUCCESS) return Status.err_device;
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

    e.lock.lock();
    defer e.lock.unlock();
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

    e.lock.lock();
    defer e.lock.unlock();

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

    e.lock.lock();
    defer e.lock.unlock();

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

    e.lock.lock();
    defer e.lock.unlock();

    const group_index: usize = @intCast(group_id);
    if (group_index >= e.groups.items.len) return Status.err_invalid;

    const clamped = clamp(volume, 0, 4);
    e.groups.items[group_index].volume = clamped;
    c.ma_sound_group_set_volume(&e.groups.items[group_index].node, clamped);
    return Status.ok;
}

pub fn setMasterVolume(engine: *Engine, volume: f32) i32 {
    const e = engine;

    e.lock.lock();
    defer e.lock.unlock();

    const clamped = clamp(volume, 0, 4);
    const result = c.ma_engine_set_volume(&e.core, clamped);
    if (result != c.MA_SUCCESS) return Status.err_device;

    e.master_volume = clamped;
    return Status.ok;
}

pub fn enableTap(engine: *Engine, enabled: bool, capacity_frames: u32) i32 {
    const e = engine;
    e.lock.lock();
    defer e.lock.unlock();

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
    e.lock.lock();
    defer e.lock.unlock();

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
    defer engine.lock.unlock();

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
    e.lock.lock();
    defer e.lock.unlock();

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
    e.lock.lock();
    defer e.lock.unlock();

    e.stats.lock_misses = loadLockMisses(e);
    reapFinishedVoices(e);
    out_stats.?.* = e.stats;
    return Status.ok;
}
