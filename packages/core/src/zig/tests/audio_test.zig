const std = @import("std");
const testing = std.testing;
const audio = @import("../audio.zig");

const TEST_SAMPLE_RATE: u32 = 48_000;

fn expectStatusOk(status: i32) !void {
    try testing.expectEqual(audio.Status.ok, status);
}

fn createEngine(options_ptr: ?*const audio.CreateOptions) !*audio.Engine {
    return audio.create(testing.allocator, options_ptr) orelse error.TestUnexpectedResult;
}

fn buildPcm16Wav(allocator: std.mem.Allocator, channels: u16, sample_rate: u32, samples: []const i16) ![]u8 {
    if (channels == 0 or samples.len == 0) return error.InvalidInput;
    if (samples.len % @as(usize, channels) != 0) return error.InvalidInput;

    const bytes_per_sample: usize = @sizeOf(i16);
    const data_size = try std.math.mul(usize, samples.len, bytes_per_sample);
    const total_size = 44 + data_size;

    const out = try allocator.alloc(u8, total_size);
    var stream = std.io.fixedBufferStream(out);
    const writer = stream.writer();

    const channels_u32: u32 = channels;
    const byte_rate: u32 = sample_rate * channels_u32 * 2;
    const block_align: u16 = channels * 2;

    try writer.writeAll("RIFF");
    try writer.writeInt(u32, @intCast(total_size - 8), .little);
    try writer.writeAll("WAVE");
    try writer.writeAll("fmt ");
    try writer.writeInt(u32, 16, .little);
    try writer.writeInt(u16, 1, .little);
    try writer.writeInt(u16, channels, .little);
    try writer.writeInt(u32, sample_rate, .little);
    try writer.writeInt(u32, byte_rate, .little);
    try writer.writeInt(u16, block_align, .little);
    try writer.writeInt(u16, 16, .little);
    try writer.writeAll("data");
    try writer.writeInt(u32, @intCast(data_size), .little);

    for (samples) |sample| {
        try writer.writeInt(i16, sample, .little);
    }

    return out;
}

fn loadSoundFromSamples(engine: *audio.Engine, channels: u16, samples: []const i16) !u32 {
    const wav = try buildPcm16Wav(testing.allocator, channels, TEST_SAMPLE_RATE, samples);
    defer testing.allocator.free(wav);

    var sound_id: u32 = 0;
    try expectStatusOk(audio.load(engine, wav.ptr, wav.len, &sound_id));
    try testing.expect(sound_id > 0);
    return sound_id;
}

fn createGroup(engine: *audio.Engine, name: []const u8) !u32 {
    var group_id: u32 = 0;
    try expectStatusOk(audio.createGroup(engine, name.ptr, name.len, &group_id));
    return group_id;
}

fn playLoop(engine: *audio.Engine, sound_id: u32, group_id: u32, pan: f32) !u32 {
    var voice_id: u32 = 0;
    const options = audio.VoiceOptions{
        .volume = 0.8,
        .pan = pan,
        .loop = true,
        .group_id = group_id,
    };
    try expectStatusOk(audio.play(engine, sound_id, &options, &voice_id));
    try testing.expect(voice_id > 0);
    return voice_id;
}

fn hasSignal(samples: []const f32) bool {
    for (samples) |sample| {
        if (@abs(sample) > 0.0005) return true;
    }
    return false;
}

test "audio - create initializes engine with defaults" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);

    try testing.expectEqual(audio.default_sample_rate, engine.sample_rate);
    try testing.expectEqual(@as(u8, 2), engine.output_channels);
    try testing.expect(!engine.started);
}

test "audio - create applies custom sample rate and playback channels" {
    var options = audio.CreateOptions{
        .sample_rate = 44_100,
        .playback_channels = 4,
    };
    const engine = try createEngine(&options);
    defer audio.destroy(engine);

    try testing.expectEqual(@as(u32, 44_100), engine.sample_rate);
    try testing.expectEqual(@as(u8, 4), engine.output_channels);
}

test "audio - destroy works after create" {
    const engine = try createEngine(null);
    audio.destroy(engine);
}

test "audio - start requires playback device" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);

    var options = audio.StartOptions{
        .period_size_in_frames = 128,
        .periods = 2,
        .performance_profile = 1,
        .share_mode = 0,
    };

    const status = audio.start(engine, &options);
    if (status == audio.Status.ok) {
        try testing.expect(engine.started);
        try testing.expect(engine.has_device);
    } else {
        try testing.expectEqual(audio.Status.err_device, status);
        try testing.expect(!engine.started);
        try testing.expect(!engine.has_device);
        return;
    }

    try expectStatusOk(audio.stop(engine));
    try testing.expect(!engine.started);
    try testing.expect(!engine.has_device);
}

test "audio - startMixer enables mixing without playback device" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);

    try expectStatusOk(audio.startMixer(engine));
    try testing.expect(engine.started);
    try testing.expect(!engine.has_device);

    try expectStatusOk(audio.stop(engine));
    try testing.expect(!engine.started);
    try testing.expect(!engine.has_device);
}

test "audio - load valid wav returns sound id" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);

    const mono_samples = [_]i16{ 0, 8000, -8000, 12_000, -12_000, 0 };
    const sound_id = try loadSoundFromSamples(engine, 1, &mono_samples);
    try testing.expectEqual(@as(u32, 1), sound_id);

    var stats: audio.Stats = undefined;
    try expectStatusOk(audio.getStats(engine, &stats));
    try testing.expectEqual(@as(u32, 1), stats.sounds_loaded);
}

test "audio - unload frees loaded sound and invalidates handle" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);

    const mono_samples = [_]i16{ 0, 8000, -8000, 12_000, -12_000, 0 };
    const sound_id = try loadSoundFromSamples(engine, 1, &mono_samples);

    try expectStatusOk(audio.unload(engine, sound_id));

    var stats: audio.Stats = undefined;
    try expectStatusOk(audio.getStats(engine, &stats));
    try testing.expectEqual(@as(u32, 0), stats.sounds_loaded);

    var voice_id: u32 = 0;
    const options = audio.VoiceOptions{ .volume = 1, .pan = 0, .loop = false, .group_id = 0 };
    try testing.expectEqual(audio.Status.err_not_found, audio.play(engine, sound_id, &options, &voice_id));
    try testing.expectEqual(audio.Status.err_not_found, audio.unload(engine, sound_id));
}

test "audio - unload stops active voices for sound" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);

    const mono_samples = [_]i16{ 2000, -2000, 4000, -4000, 2000, -2000 };
    const sound_id = try loadSoundFromSamples(engine, 1, &mono_samples);
    try expectStatusOk(audio.startMixer(engine));

    const voice_id = try playLoop(engine, sound_id, 0, 0);
    try testing.expect(engine.voices[voice_id - 1].active);

    try expectStatusOk(audio.unload(engine, sound_id));
    try testing.expect(!engine.voices[voice_id - 1].active);

    var stats: audio.Stats = undefined;
    try expectStatusOk(audio.getStats(engine, &stats));
    try testing.expectEqual(@as(u32, 0), stats.sounds_loaded);
    try testing.expectEqual(@as(u32, 0), stats.voices_active);
}

test "audio - unloaded sound id is not reused by later loads" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);

    const first_samples = [_]i16{ 0, 8000, -8000, 0 };
    const first_sound_id = try loadSoundFromSamples(engine, 1, &first_samples);
    try expectStatusOk(audio.unload(engine, first_sound_id));

    const second_samples = [_]i16{ 1000, -1000, 5000, -5000 };
    const second_sound_id = try loadSoundFromSamples(engine, 1, &second_samples);
    try testing.expect(second_sound_id != first_sound_id);

    try expectStatusOk(audio.startMixer(engine));

    var voice_id: u32 = 0;
    const options = audio.VoiceOptions{ .volume = 1, .pan = 0, .loop = false, .group_id = 0 };
    try testing.expectEqual(audio.Status.err_not_found, audio.play(engine, first_sound_id, &options, &voice_id));
    try expectStatusOk(audio.play(engine, second_sound_id, &options, &voice_id));
    try testing.expect(voice_id > 0);
}

test "audio - createGroup creates and deduplicates group" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);

    const first = try createGroup(engine, "effects");
    const second = try createGroup(engine, "effects");
    try testing.expectEqual(first, second);
}

test "audio - play valid sound returns voice id" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);

    const mono_samples = [_]i16{ 3000, -3000, 6000, -6000, 3000, -3000 };
    const sound_id = try loadSoundFromSamples(engine, 1, &mono_samples);
    try expectStatusOk(audio.startMixer(engine));

    var voice_id: u32 = 0;
    const options = audio.VoiceOptions{ .volume = 1, .pan = 0, .loop = true, .group_id = 0 };
    try expectStatusOk(audio.play(engine, sound_id, &options, &voice_id));
    try testing.expect(voice_id > 0);
    try testing.expect(engine.voices[voice_id - 1].active);
}

test "audio - stopVoice stops active voice" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);

    const mono_samples = [_]i16{ 2000, -2000, 4000, -4000, 2000, -2000 };
    const sound_id = try loadSoundFromSamples(engine, 1, &mono_samples);
    try expectStatusOk(audio.startMixer(engine));

    const voice_id = try playLoop(engine, sound_id, 0, 0);
    try expectStatusOk(audio.stopVoice(engine, voice_id));
    try testing.expect(!engine.voices[voice_id - 1].active);
}

test "audio - setVoiceGroup moves voice between groups" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);

    const mono_samples = [_]i16{ 1500, -1500, 5000, -5000, 1500, -1500 };
    const sound_id = try loadSoundFromSamples(engine, 1, &mono_samples);
    const group_a = try createGroup(engine, "group-a");
    const group_b = try createGroup(engine, "group-b");
    try expectStatusOk(audio.startMixer(engine));

    const voice_id = try playLoop(engine, sound_id, group_a, 0);
    try expectStatusOk(audio.setVoiceGroup(engine, voice_id, group_b));
    try testing.expectEqual(group_b, engine.voices[voice_id - 1].group_id);
}

test "audio - setGroupVolume applies clamped volume" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);

    const group_id = try createGroup(engine, "mix-group");
    try expectStatusOk(audio.setGroupVolume(engine, group_id, 2.5));
    try testing.expectApproxEqAbs(@as(f32, 2.5), engine.groups.items[group_id].volume, 0.0001);

    try expectStatusOk(audio.setGroupVolume(engine, group_id, 8));
    try testing.expectApproxEqAbs(@as(f32, 4), engine.groups.items[group_id].volume, 0.0001);
}

test "audio - setMasterVolume applies clamped volume" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);

    try expectStatusOk(audio.setMasterVolume(engine, 1.7));
    try testing.expectApproxEqAbs(@as(f32, 1.7), engine.master_volume, 0.0001);

    try expectStatusOk(audio.setMasterVolume(engine, -3));
    try testing.expectApproxEqAbs(@as(f32, 0), engine.master_volume, 0.0001);
}

test "audio - mixToBuffer returns mixed samples" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);

    const mono_samples = [_]i16{ 4000, -2000, 7000, -7000, 5000, -3000 };
    const sound_id = try loadSoundFromSamples(engine, 1, &mono_samples);
    try expectStatusOk(audio.startMixer(engine));
    _ = try playLoop(engine, sound_id, 0, 0.2);

    var out: [128]f32 = [_]f32{0} ** 128;
    try expectStatusOk(audio.mixToBuffer(engine, out[0..].ptr, 64, 2));
    try testing.expect(hasSignal(&out));
}

test "audio - mixToBuffer mono downmix averages stereo" {
    const stereo_engine = try createEngine(null);
    defer audio.destroy(stereo_engine);
    const mono_engine = try createEngine(null);
    defer audio.destroy(mono_engine);

    const mono_samples = [_]i16{ 5000, -2000, 8000, -8000, 5000, -2000 };
    const stereo_sound_id = try loadSoundFromSamples(stereo_engine, 1, &mono_samples);
    const mono_sound_id = try loadSoundFromSamples(mono_engine, 1, &mono_samples);
    try expectStatusOk(audio.startMixer(stereo_engine));
    try expectStatusOk(audio.startMixer(mono_engine));

    _ = try playLoop(stereo_engine, stereo_sound_id, 0, 0.7);
    _ = try playLoop(mono_engine, mono_sound_id, 0, 0.7);

    var stereo_warmup: [64]f32 = [_]f32{0} ** 64;
    var mono_warmup: [32]f32 = [_]f32{0} ** 32;
    try expectStatusOk(audio.mixToBuffer(stereo_engine, stereo_warmup[0..].ptr, 32, 2));
    try expectStatusOk(audio.mixToBuffer(mono_engine, mono_warmup[0..].ptr, 32, 1));

    var stereo: [128]f32 = [_]f32{0} ** 128;
    var mono: [64]f32 = [_]f32{0} ** 64;
    try expectStatusOk(audio.mixToBuffer(stereo_engine, stereo[0..].ptr, 64, 2));
    try expectStatusOk(audio.mixToBuffer(mono_engine, mono[0..].ptr, 64, 1));

    for (0..64) |i| {
        const expected = std.math.clamp((stereo[i * 2] + stereo[i * 2 + 1]) * 0.5, -1, 1);
        try testing.expectApproxEqAbs(expected, mono[i], 0.0001);
    }
}

test "audio - mixToBuffer multichannel keeps extra channels zero" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);

    const mono_samples = [_]i16{ 2500, -1500, 7000, -7000, 2500, -1500 };
    const sound_id = try loadSoundFromSamples(engine, 1, &mono_samples);
    try expectStatusOk(audio.startMixer(engine));
    _ = try playLoop(engine, sound_id, 0, 0);

    var quad: [256]f32 = [_]f32{0} ** 256;
    try expectStatusOk(audio.mixToBuffer(engine, quad[0..].ptr, 64, 4));

    for (0..64) |frame| {
        const base = frame * 4;
        try testing.expectEqual(@as(f32, 0), quad[base + 2]);
        try testing.expectEqual(@as(f32, 0), quad[base + 3]);
    }
}

test "audio - enableTap and readTap return captured frames" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);

    const mono_samples = [_]i16{ 1000, -1000, 4000, -4000, 1000, -1000 };
    const sound_id = try loadSoundFromSamples(engine, 1, &mono_samples);
    try expectStatusOk(audio.startMixer(engine));
    _ = try playLoop(engine, sound_id, 0, 0.35);

    try expectStatusOk(audio.enableTap(engine, true, 256));

    var mixed: [256]f32 = [_]f32{0} ** 256;
    try expectStatusOk(audio.mixToBuffer(engine, mixed[0..].ptr, 128, 2));

    var tapped: [128]f32 = [_]f32{0} ** 128;
    var frames_read: u32 = 0;
    try expectStatusOk(audio.readTap(engine, tapped[0..].ptr, 64, 2, &frames_read));
    try testing.expect(frames_read > 0);
    try testing.expect(hasSignal(tapped[0 .. @as(usize, frames_read) * 2]));

    try expectStatusOk(audio.enableTap(engine, false, 0));
}

test "audio - refresh and playback device selection APIs" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);

    const refresh_status = audio.refreshPlaybackDevices(engine);
    if (refresh_status != audio.Status.ok) return error.SkipZigTest;

    const count = audio.getPlaybackDeviceCount(engine);
    try testing.expectEqual(@as(u32, @intCast(engine.playback_devices.items.len)), count);
    if (count == 0) return error.SkipZigTest;

    var name_buf: [256]u8 = [_]u8{0} ** 256;
    const copied = audio.getPlaybackDeviceName(engine, 0, name_buf[0..].ptr, name_buf.len);
    try testing.expect(copied <= name_buf.len);

    _ = audio.isPlaybackDeviceDefault(engine, 0);

    try expectStatusOk(audio.selectPlaybackDevice(engine, 0));
    try testing.expectEqual(@as(?u32, 0), engine.selected_playback_index);

    audio.clearPlaybackDeviceSelection(engine);
    try testing.expectEqual(@as(?u32, null), engine.selected_playback_index);
}

test "audio - getStats returns current counters" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);

    const mono_samples = [_]i16{ 3000, -3000, 9000, -9000, 3000, -3000 };
    const sound_id = try loadSoundFromSamples(engine, 1, &mono_samples);

    var before: audio.Stats = undefined;
    try expectStatusOk(audio.getStats(engine, &before));

    try expectStatusOk(audio.startMixer(engine));
    const voice_id = try playLoop(engine, sound_id, 0, 0);

    var out: [128]f32 = [_]f32{0} ** 128;
    try expectStatusOk(audio.mixToBuffer(engine, out[0..].ptr, 64, 2));

    var after: audio.Stats = undefined;
    try expectStatusOk(audio.getStats(engine, &after));

    try testing.expectEqual(@as(u32, 1), after.sounds_loaded);
    try testing.expect(after.voices_active >= 1);
    try testing.expect(after.frames_mixed > before.frames_mixed);
    try testing.expect(after.last_peak > 0);
    try testing.expect(after.last_rms > 0);

    try expectStatusOk(audio.stopVoice(engine, voice_id));
}
