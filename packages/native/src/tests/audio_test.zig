const std = @import("std");
const testing = std.testing;
const audio = @import("../audio.zig");

const TEST_SAMPLE_RATE: u32 = 48_000;
const TEST_MP3_PATH = "../core/src/tests/fixtures/audio/tone-750hz-48k-mono-1s.mp3";

fn expectStatusOk(status: i32) !void {
    try testing.expectEqual(audio.Status.ok, status);
}

fn createEngine(options_ptr: ?*const audio.CreateOptions) !*audio.Engine {
    return audio.create(testing.allocator, options_ptr) orelse error.TestUnexpectedResult;
}

fn streamOptions() audio.StreamOptions {
    return .{
        .capacity_ms = 10,
        .startup_ms = 2,
        .resume_ms = 1,
        .volume = 1,
        .pan = 0,
        .group_id = 0,
        .format = audio.StreamFormat.mp3,
    };
}

fn pcmStreamOptions(sample_rate: u32, channels: u32) audio.StreamOptions {
    var options = streamOptions();
    options.format = audio.StreamFormat.pcm;
    options.sample_rate = sample_rate;
    options.channels = channels;
    return options;
}

fn encodePcm(out: []u8, samples: []const f32) void {
    std.debug.assert(out.len == samples.len * @sizeOf(f32));
    for (samples, 0..) |sample, index| {
        std.mem.writeInt(u32, out[index * 4 ..][0..4], @bitCast(sample), .little);
    }
}

test "PCM stream copies interleaved bytes and drains through the worker" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);
    try expectStatusOk(audio.startMixer(engine));
    var id: u32 = 0;
    const options = pcmStreamOptions(TEST_SAMPLE_RATE, 2);
    try expectStatusOk(audio.createStream(engine, &options, &id));
    var stats: audio.StreamStats = undefined;
    var input: [960]f32 = undefined;
    for (0..480) |frame| {
        input[frame * 2] = 0.25;
        input[frame * 2 + 1] = -0.5;
    }
    var bytes: [input.len * 4]u8 = undefined;
    encodePcm(&bytes, &input);
    try testing.expectEqual(@as(i32, bytes.len), audio.writeStream(engine, id, &bytes, bytes.len));
    @memset(&bytes, 0);
    stats = try waitForBufferedFrames(engine, id, 480);
    try testing.expectEqual(@as(u32, 1), stats.ready_generation);
    try testing.expectEqual(audio.StreamState.buffering, stats.state);
    try testing.expectEqual(@as(u32, 480), stats.buffered_frames);
    try expectStatusOk(audio.endStream(engine, id));
    try testing.expectEqual(audio.Status.err_invalid, audio.writeStream(engine, id, &bytes, bytes.len));
    var output: [256]f32 = undefined;
    try expectStatusOk(audio.mixToBuffer(engine, &output, 128, 2));
    // The shared mixer group has one frame of processing latency.
    try testing.expectApproxEqAbs(@as(f32, 0.25), output[2], 0.0001);
    try testing.expectApproxEqAbs(@as(f32, -0.5), output[3], 0.0001);
    stats = try mixStreamToEnd(engine, id);
    try testing.expectEqual(@as(u64, bytes.len), stats.bytes_received);
    try testing.expectEqual(@as(u64, 480), stats.frames_played);
    try expectStatusOk(audio.closeStream(engine, id, audio.StreamCloseReason.preserve_native_terminal, &stats));
    try testing.expectEqual(audio.Status.err_not_found, audio.writeStream(engine, id, &bytes, bytes.len));
}

test "PCM stream accepts unaligned bytes fragmented inside samples and frames" {
    for ([_]usize{ 1, 3, 7, 9, 192 }) |chunk_size| {
        const engine = try createEngine(null);
        defer audio.destroy(engine);
        try expectStatusOk(audio.startMixer(engine));
        const options = pcmStreamOptions(TEST_SAMPLE_RATE, 2);
        var id: u32 = 0;
        try expectStatusOk(audio.createStream(engine, &options, &id));
        var storage: [193]u8 align(4) = undefined;
        const bytes = storage[1..];
        encodePcm(bytes, &([_]f32{ 0.25, -0.5 } ** 24));
        var offset: usize = 0;
        while (offset < bytes.len) {
            const chunk = bytes[offset..@min(offset + chunk_size, bytes.len)];
            try testing.expectEqual(@as(i32, @intCast(chunk.len)), audio.writeStream(engine, id, chunk.ptr, @intCast(chunk.len)));
            offset += chunk.len;
            var stats: audio.StreamStats = undefined;
            try expectStatusOk(audio.getStreamStats(engine, id, &stats));
            try testing.expectEqual(@as(u64, offset), stats.bytes_received);
        }
        try expectStatusOk(audio.endStream(engine, id));
        _ = try waitForBufferedFrames(engine, id, 24);
        var output: [16]f32 = undefined;
        try expectStatusOk(audio.mixToBuffer(engine, &output, 8, 2));
        for (1..8) |frame| {
            try testing.expectApproxEqAbs(@as(f32, 0.25), output[frame * 2], 0.0001);
            try testing.expectApproxEqAbs(@as(f32, -0.5), output[frame * 2 + 1], 0.0001);
        }
        const stats = try mixStreamToEnd(engine, id);
        try testing.expectEqual(@as(u64, 24), stats.frames_played);
        try testing.expectEqual(audio.StreamState.ended, stats.state);
    }
}

test "PCM stream backpressures the shared input queue without scanning rejected bytes" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);
    var options = pcmStreamOptions(TEST_SAMPLE_RATE, 2);
    options.capacity_ms = 100;
    var id: u32 = 0;
    try expectStatusOk(audio.createStream(engine, &options, &id));
    const bytes = [_]u8{0} ** (64 * 1024);
    var total: u64 = 0;
    // Once output is full the worker cannot free further input space.
    for (0..2) |pass| {
        var accepted: i32 = 1;
        for (0..16) |_| {
            accepted = audio.writeStream(engine, id, &bytes, bytes.len);
            try testing.expect(accepted >= 0);
            total += @intCast(accepted);
            if (accepted == 0) break;
        }
        try testing.expectEqual(@as(i32, 0), accepted);
        if (pass == 0) _ = try waitForBufferedFrames(engine, id, 4800);
    }
    try testing.expect(total >= 256 * 1024);
    try testing.expect(total <= 256 * 1024 + 2048 * 8 + 4800 * 8);
    var invalid: [8]u8 = undefined;
    encodePcm(&invalid, &.{ std.math.nan(f32), 0 });
    for (0..3) |_| try testing.expectEqual(@as(i32, 0), audio.writeStream(engine, id, &invalid, invalid.len));
    var stats: audio.StreamStats = undefined;
    try expectStatusOk(audio.getStreamStats(engine, id, &stats));
    try testing.expectEqual(total, stats.bytes_received);
    try testing.expectEqual(@as(u32, 4800), stats.buffered_frames);
}

test "PCM stream rejects incomplete final frames after accepting partial bytes" {
    for ([_]u32{ 1, 2 }) |channels| {
        for (1..channels * 4) |partial| {
            const engine = try createEngine(null);
            defer audio.destroy(engine);
            const options = pcmStreamOptions(TEST_SAMPLE_RATE, channels);
            var id: u32 = 0;
            try expectStatusOk(audio.createStream(engine, &options, &id));
            const bytes = [_]u8{0} ** 7;
            try testing.expectEqual(@as(i32, @intCast(partial)), audio.writeStream(engine, id, &bytes, @intCast(partial)));
            try expectStatusOk(audio.endStream(engine, id));
            var stats = try waitForStreamState(engine, id, audio.StreamState.failed);
            try testing.expectEqual(@as(u64, partial), stats.bytes_received);
            try testing.expectEqual(@as(u64, 0), stats.frames_decoded);
            try expectStatusOk(audio.closeStream(engine, id, audio.StreamCloseReason.transport_error, &stats));
        }
    }
}

test "PCM stream EOF preserves sub-frame downsampling tails" {
    for ([_]u32{ 1, 2 }) |channels| {
        for ([_]u32{ 1, 24 }) |input_frames| {
            const engine = try createEngine(&.{ .sample_rate = 8_000 });
            defer audio.destroy(engine);
            try expectStatusOk(audio.startMixer(engine));
            const options = pcmStreamOptions(192_000, channels);
            var id: u32 = 0;
            try expectStatusOk(audio.createStream(engine, &options, &id));
            const input = [_]f32{0.5} ** 48;
            var bytes: [input.len * 4]u8 = undefined;
            encodePcm(&bytes, &input);
            const byte_count = input_frames * channels * 4;
            try testing.expectEqual(@as(i32, @intCast(byte_count)), audio.writeStream(engine, id, &bytes, byte_count));
            try expectStatusOk(audio.endStream(engine, id));
            // Retrying EOF must not append another copy of the conversion tail.
            try expectStatusOk(audio.endStream(engine, id));
            const drained = try mixStreamToEnd(engine, id);
            try testing.expectEqual(@as(u64, 2), drained.frames_decoded);
            try testing.expectEqual(drained.frames_decoded, drained.frames_played);
            try testing.expectEqual(@as(u64, input_frames) * channels * @sizeOf(f32), drained.bytes_received);
        }
    }
}

test "PCM stream accepts EOF once while full and flushes its tail without duplication" {
    const engine = try createEngine(&.{ .sample_rate = 8_000 });
    defer audio.destroy(engine);
    try expectStatusOk(audio.startMixer(engine));
    var options = pcmStreamOptions(192_000, 1);
    options.capacity_ms = 1;
    options.startup_ms = 1;
    var id: u32 = 0;
    try expectStatusOk(audio.createStream(engine, &options, &id));
    // The initial output frame plus seven 24:1 steps fills the eight-frame ring.
    const input = [_]f32{0.5} ** 169;
    var bytes: [input.len * 4]u8 = undefined;
    encodePcm(&bytes, &input);
    try testing.expectEqual(@as(i32, bytes.len), audio.writeStream(engine, id, &bytes, bytes.len));
    const full = try waitForBufferedFrames(engine, id, 8);
    try testing.expectEqual(full.capacity_frames, full.buffered_frames);
    try expectStatusOk(audio.endStream(engine, id));
    try testing.expectEqual(audio.Status.err_invalid, audio.writeStream(engine, id, &bytes, bytes.len));
    var drained = try mixStreamToEnd(engine, id);
    try testing.expectEqual(audio.StreamState.ended, drained.state);
    try testing.expectEqual(@as(u64, 9), drained.frames_decoded);
    try testing.expectEqual(drained.frames_decoded, drained.frames_played);
    try expectStatusOk(audio.endStream(engine, id));
    try expectStatusOk(audio.getStreamStats(engine, id, &drained));
    try testing.expectEqual(@as(u64, 9), drained.frames_decoded);
    try testing.expectEqual(audio.Status.err_invalid, audio.restartStream(engine, id));
}

test "PCM stream rejects invalid formats and samples and finishes empty EOF" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);
    var options = pcmStreamOptions(0, 2);
    var id: u32 = 0;
    for ([_]u32{ 0, 7999, 192001 }) |rate| {
        options.sample_rate = rate;
        try testing.expectEqual(audio.Status.err_invalid, audio.createStream(engine, &options, &id));
    }
    options.sample_rate = TEST_SAMPLE_RATE;
    for ([_]u32{ 0, 3 }) |channels| {
        options.channels = channels;
        try testing.expectEqual(audio.Status.err_invalid, audio.createStream(engine, &options, &id));
    }
    options.channels = 2;
    options.format = 99;
    try testing.expectEqual(audio.Status.err_invalid, audio.createStream(engine, &options, &id));
    options.format = audio.StreamFormat.pcm;
    for ([_]u32{ 7999, 192001 }) |rate| {
        const invalid_engine = try createEngine(&.{ .sample_rate = rate });
        defer audio.destroy(invalid_engine);
        try testing.expectEqual(audio.Status.err_invalid, audio.createStream(invalid_engine, &options, &id));
    }
    var bytes: [8]u8 = undefined;
    for ([_]f32{ std.math.nan(f32), std.math.inf(f32), -std.math.inf(f32) }) |sample| {
        try expectStatusOk(audio.createStream(engine, &options, &id));
        encodePcm(&bytes, &.{ sample, 0 });
        try testing.expectEqual(@as(i32, bytes.len), audio.writeStream(engine, id, &bytes, bytes.len));
        var failed = try waitForStreamState(engine, id, audio.StreamState.failed);
        try testing.expectEqual(@as(u64, 0), failed.frames_decoded);
        try expectStatusOk(audio.closeStream(engine, id, audio.StreamCloseReason.preserve_native_terminal, &failed));
    }
    try expectStatusOk(audio.createStream(engine, &options, &id));
    try testing.expectEqual(audio.Status.err_invalid, audio.writeStream(engine, id, null, 2));
    try testing.expectEqual(@as(i32, 0), audio.writeStream(engine, id, null, 0));
    try expectStatusOk(audio.endStream(engine, id));
    try expectStatusOk(audio.endStream(engine, id));
    const stats = try waitForStreamState(engine, id, audio.StreamState.ended);
    try testing.expectEqual(audio.StreamState.ended, stats.state);
    try testing.expectEqual(@as(u64, 0), stats.bytes_received);
    try testing.expectEqual(@as(u64, 0), stats.frames_decoded);
}

test "PCM stream converts a fragmented live frame before EOF without decoder coalescing" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);
    try expectStatusOk(audio.startMixer(engine));
    const options = pcmStreamOptions(TEST_SAMPLE_RATE, 2);
    var id: u32 = 0;
    try expectStatusOk(audio.createStream(engine, &options, &id));
    _ = try waitForStreamState(engine, id, audio.StreamState.buffering);
    var bytes: [8]u8 = undefined;
    encodePcm(&bytes, &.{ 0.25, -0.5 });
    for (bytes, 0..) |_, i| {
        try testing.expectEqual(@as(i32, 1), audio.writeStream(engine, id, bytes[i..].ptr, 1));
        testing.io.sleep(.fromMilliseconds(1), .awake) catch {};
    }
    const buffered = try waitForBufferedFrames(engine, id, 1);
    try testing.expectEqual(@as(u32, 1), buffered.ready_generation);
    try testing.expectEqual(@as(u64, 8), buffered.bytes_received);
    try expectStatusOk(audio.endStream(engine, id));
    const drained = try mixStreamToEnd(engine, id);
    try testing.expectEqual(@as(u64, 1), drained.frames_played);
}

test "PCM stream worker preserves fragmented conversion and resampling tails" {
    for ([_][2]u32{ .{ 8000, 48000 }, .{ 44100, 48000 }, .{ 48000, 44100 }, .{ 192000, 8000 } }) |rates| {
        for ([_]u32{ 1, 2 }) |channels| {
            for ([_]usize{ 1, 7, 8191, 24000 }) |chunk_size| {
                const engine = try createEngine(&.{ .sample_rate = rates[1] });
                defer audio.destroy(engine);
                try expectStatusOk(audio.startMixer(engine));
                const options = pcmStreamOptions(rates[0], channels);
                var id: u32 = 0;
                try expectStatusOk(audio.createStream(engine, &options, &id));
                const samples = [_]f32{0.5} ** 6000;
                var bytes: [samples.len * 4]u8 = undefined;
                encodePcm(&bytes, &samples);
                var offset: usize = 0;
                while (offset < bytes.len) {
                    const end = @min(offset + chunk_size, bytes.len);
                    try writeAllStreamBytes(engine, id, bytes[offset..end]);
                    offset = end;
                }
                try expectStatusOk(audio.endStream(engine, id));
                const drained = try mixStreamToEnd(engine, id);
                const nominal = (@as(u64, samples.len / channels) * rates[1] + rates[0] - 1) / rates[0];
                try testing.expect(drained.frames_decoded >= nominal);
                try testing.expect(drained.frames_decoded <= nominal + 128);
                try testing.expectEqual(drained.frames_decoded, drained.frames_played);
                try testing.expectEqual(@as(u64, bytes.len), drained.bytes_received);
            }
        }
    }
}

test "PCM stream close wakes the worker from input and output waits" {
    for ([_]bool{ false, true }) |full| {
        const engine = try createEngine(null);
        defer audio.destroy(engine);
        const options = pcmStreamOptions(TEST_SAMPLE_RATE, 2);
        var id: u32 = 0;
        try expectStatusOk(audio.createStream(engine, &options, &id));
        _ = try waitForStreamState(engine, id, audio.StreamState.buffering);
        if (full) {
            const bytes = [_]u8{0} ** (64 * 1024);
            var accepted: i32 = 1;
            for (0..16) |_| {
                accepted = audio.writeStream(engine, id, &bytes, bytes.len);
                if (accepted == 0) break;
                try testing.expect(accepted > 0);
            }
            try testing.expectEqual(@as(i32, 0), accepted);
            _ = try waitForBufferedFrames(engine, id, 480);
        }
        var stats: audio.StreamStats = undefined;
        try expectStatusOk(audio.closeStream(engine, id, audio.StreamCloseReason.disposed, &stats));
        try testing.expectEqual(audio.Status.err_not_found, audio.getStreamStats(engine, id, &stats));
    }
}

fn buildPcm16Wav(allocator: std.mem.Allocator, channels: u16, sample_rate: u32, samples: []const i16) ![]u8 {
    if (channels == 0 or samples.len == 0) return error.InvalidInput;
    if (samples.len % @as(usize, channels) != 0) return error.InvalidInput;

    const bytes_per_sample: usize = @sizeOf(i16);
    const data_size = try std.math.mul(usize, samples.len, bytes_per_sample);
    const total_size = 44 + data_size;

    const out = try allocator.alloc(u8, total_size);
    var writer = std.Io.Writer.fixed(out);

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

fn createCaptureBuffer(channels: u32, capacity_frames: u32) !*audio.CaptureBuffer {
    return audio.CaptureBuffer.create(testing.allocator, TEST_SAMPLE_RATE, channels, capacity_frames);
}

fn writeAllStreamBytes(engine: *audio.Engine, stream_id: u32, bytes: []const u8) !void {
    var offset: usize = 0;
    var attempts: usize = 0;
    while (offset < bytes.len and attempts < 5_000) : (attempts += 1) {
        const written = audio.writeStream(engine, stream_id, bytes[offset..].ptr, @intCast(bytes.len - offset));
        try testing.expect(written >= 0);
        offset += @intCast(written);
        if (written == 0) testing.io.sleep(.fromMilliseconds(1), .awake) catch {};
    }
    try testing.expectEqual(bytes.len, offset);
}

fn waitForBufferedFrames(engine: *audio.Engine, stream_id: u32, minimum: u32) !audio.StreamStats {
    var stats: audio.StreamStats = undefined;
    for (0..5_000) |_| {
        try expectStatusOk(audio.getStreamStats(engine, stream_id, &stats));
        if (stats.buffered_frames >= minimum) return stats;
        if (stats.state == audio.StreamState.failed) return error.TestUnexpectedResult;
        testing.io.sleep(.fromMilliseconds(1), .awake) catch {};
    }
    return error.TestUnexpectedResult;
}

fn waitForStreamState(engine: *audio.Engine, stream_id: u32, state: u32) !audio.StreamStats {
    var stats: audio.StreamStats = undefined;
    for (0..5_000) |_| {
        try expectStatusOk(audio.getStreamStats(engine, stream_id, &stats));
        if (stats.state == state) return stats;
        testing.io.sleep(.fromMilliseconds(1), .awake) catch {};
    }
    return error.TestUnexpectedResult;
}

fn mixStreamToEnd(engine: *audio.Engine, stream_id: u32) !audio.StreamStats {
    var mixed: [256 * 2]f32 = undefined;
    var heard_signal = false;
    var stats: audio.StreamStats = undefined;
    for (0..5_000) |_| {
        try expectStatusOk(audio.mixToBuffer(engine, &mixed, 256, 2));
        heard_signal = heard_signal or hasSignal(&mixed);
        try expectStatusOk(audio.getStreamStats(engine, stream_id, &stats));
        if (stats.state == audio.StreamState.ended) {
            try testing.expect(heard_signal);
            return stats;
        }
        if (stats.state == audio.StreamState.failed) return error.TestUnexpectedResult;
        testing.io.sleep(.fromMilliseconds(1), .awake) catch {};
    }
    return error.TestUnexpectedResult;
}

test "audio stream ABI layouts remain stable" {
    try testing.expectEqual(@as(usize, 40), @sizeOf(audio.StreamOptions));
    try testing.expectEqual(@as(usize, 0), @offsetOf(audio.StreamOptions, "capacity_ms"));
    try testing.expectEqual(@as(usize, 4), @offsetOf(audio.StreamOptions, "startup_ms"));
    try testing.expectEqual(@as(usize, 8), @offsetOf(audio.StreamOptions, "resume_ms"));
    try testing.expectEqual(@as(usize, 12), @offsetOf(audio.StreamOptions, "volume"));
    try testing.expectEqual(@as(usize, 16), @offsetOf(audio.StreamOptions, "pan"));
    try testing.expectEqual(@as(usize, 20), @offsetOf(audio.StreamOptions, "group_id"));
    try testing.expectEqual(@as(usize, 24), @offsetOf(audio.StreamOptions, "max_probe_bytes"));
    try testing.expectEqual(@as(usize, 28), @offsetOf(audio.StreamOptions, "format"));
    try testing.expectEqual(@as(usize, 32), @offsetOf(audio.StreamOptions, "sample_rate"));
    try testing.expectEqual(@as(usize, 36), @offsetOf(audio.StreamOptions, "channels"));

    try testing.expectEqual(@as(usize, 56), @sizeOf(audio.StreamStats));
    try testing.expectEqual(@as(usize, 0), @offsetOf(audio.StreamStats, "bytes_received"));
    try testing.expectEqual(@as(usize, 8), @offsetOf(audio.StreamStats, "frames_decoded"));
    try testing.expectEqual(@as(usize, 16), @offsetOf(audio.StreamStats, "frames_played"));
    try testing.expectEqual(@as(usize, 24), @offsetOf(audio.StreamStats, "state"));
    try testing.expectEqual(@as(usize, 28), @offsetOf(audio.StreamStats, "sample_rate"));
    try testing.expectEqual(@as(usize, 32), @offsetOf(audio.StreamStats, "channels"));
    try testing.expectEqual(@as(usize, 36), @offsetOf(audio.StreamStats, "buffered_frames"));
    try testing.expectEqual(@as(usize, 40), @offsetOf(audio.StreamStats, "capacity_frames"));
    try testing.expectEqual(@as(usize, 44), @offsetOf(audio.StreamStats, "underruns"));
    try testing.expectEqual(@as(usize, 48), @offsetOf(audio.StreamStats, "error_code"));
    try testing.expectEqual(@as(usize, 52), @offsetOf(audio.StreamStats, "ready_generation"));

    try testing.expectEqual(@as(usize, 40), @sizeOf(audio.CaptureStats));
    try testing.expectEqual(@as(usize, 0), @offsetOf(audio.CaptureStats, "frames_received"));
    try testing.expectEqual(@as(usize, 8), @offsetOf(audio.CaptureStats, "frames_read"));
    try testing.expectEqual(@as(usize, 16), @offsetOf(audio.CaptureStats, "frames_dropped"));
    try testing.expectEqual(@as(usize, 24), @offsetOf(audio.CaptureStats, "sample_rate"));
    try testing.expectEqual(@as(usize, 28), @offsetOf(audio.CaptureStats, "channels"));
    try testing.expectEqual(@as(usize, 32), @offsetOf(audio.CaptureStats, "buffered_frames"));
    try testing.expectEqual(@as(usize, 36), @offsetOf(audio.CaptureStats, "capacity_frames"));
}

test "audio capture buffer reads exact interleaved order with partial and empty reads" {
    const capture = try createCaptureBuffer(2, 5);
    defer capture.destroy();

    const input = [_]f32{ 1, 10, 2, 20, 3, 30 };
    capture.write(&input, 3);

    var output = [_]f32{99} ** 8;
    try testing.expectEqual(@as(u32, 2), capture.read(&output, 2));
    try testing.expectEqualSlices(f32, &.{ 1, 10, 2, 20 }, output[0..4]);
    try testing.expectEqual(@as(f32, 99), output[4]);

    @memset(&output, 99);
    try testing.expectEqual(@as(u32, 1), capture.read(&output, 4));
    try testing.expectEqualSlices(f32, &.{ 3, 30 }, output[0..2]);
    try testing.expectEqual(@as(f32, 99), output[2]);

    @memset(&output, 77);
    try testing.expectEqual(@as(u32, 0), capture.read(&output, 4));
    try testing.expectEqual(@as(f32, 77), output[0]);

    const stats = capture.snapshot();
    try testing.expectEqual(@as(u64, 3), stats.frames_received);
    try testing.expectEqual(@as(u64, 3), stats.frames_read);
    try testing.expectEqual(@as(u64, 0), stats.frames_dropped);
    try testing.expectEqual(@as(u32, 0), stats.buffered_frames);
}

test "audio capture buffer preserves order across wrap" {
    const capture = try createCaptureBuffer(1, 4);
    defer capture.destroy();

    const first = [_]f32{ 1, 2, 3 };
    capture.write(&first, 3);
    var prefix: [2]f32 = undefined;
    try testing.expectEqual(@as(u32, 2), capture.read(&prefix, 2));
    try testing.expectEqualSlices(f32, &.{ 1, 2 }, &prefix);

    const wrapped = [_]f32{ 4, 5, 6 };
    capture.write(&wrapped, 3);
    var output: [4]f32 = undefined;
    try testing.expectEqual(@as(u32, 4), capture.read(&output, 4));
    try testing.expectEqualSlices(f32, &.{ 3, 4, 5, 6 }, &output);

    const stats = capture.snapshot();
    try testing.expectEqual(@as(u64, 6), stats.frames_received);
    try testing.expectEqual(@as(u64, 6), stats.frames_read);
    try testing.expectEqual(@as(u64, 0), stats.frames_dropped);
}

test "audio capture buffer drops newest complete frames and counts overflow" {
    const capture = try createCaptureBuffer(2, 3);
    defer capture.destroy();

    const first = [_]f32{ 1, 10, 2, 20, 3, 30, 4, 40, 5, 50 };
    capture.write(&first, 5);
    var prefix: [2]f32 = undefined;
    try testing.expectEqual(@as(u32, 1), capture.read(&prefix, 1));
    try testing.expectEqualSlices(f32, &.{ 1, 10 }, &prefix);

    const second = [_]f32{ 6, 60, 7, 70 };
    capture.write(&second, 2);
    var output: [6]f32 = undefined;
    try testing.expectEqual(@as(u32, 3), capture.read(&output, 3));
    try testing.expectEqualSlices(f32, &.{ 2, 20, 3, 30, 6, 60 }, &output);

    const stats = capture.snapshot();
    try testing.expectEqual(@as(u64, 7), stats.frames_received);
    try testing.expectEqual(@as(u64, 4), stats.frames_read);
    try testing.expectEqual(@as(u64, 3), stats.frames_dropped);
    try testing.expectEqual(@as(u32, 0), stats.buffered_frames);
    try testing.expectEqual(@as(u32, 3), stats.capacity_frames);
}

test "audio capture stop is idempotent and preserves storage for draining" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);
    try expectStatusOk(audio.startMixer(engine));

    const capture = try createCaptureBuffer(1, 4);
    engine.capture = capture;
    const input = [_]f32{ 1, 2, 3 };
    capture.write(&input, 3);

    try expectStatusOk(audio.stopCapture(engine));
    try expectStatusOk(audio.stopCapture(engine));
    try testing.expect(engine.capture.? == capture);
    try testing.expect(engine.started);

    var output: [4]f32 = undefined;
    var frames_read: u32 = 99;
    try expectStatusOk(audio.readCapture(engine, &output, output.len, 4, &frames_read));
    try testing.expectEqual(@as(u32, 3), frames_read);
    try testing.expectEqualSlices(f32, &.{ 1, 2, 3 }, output[0..3]);

    var stats: audio.CaptureStats = undefined;
    try expectStatusOk(audio.getCaptureStats(engine, &stats));
    try testing.expectEqual(@as(u64, 3), stats.frames_read);
    try testing.expectEqual(@as(u32, 0), stats.buffered_frames);
}

test "audio capture read rejects a destination smaller than one interleaved frame" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);

    const capture = try audio.CaptureBuffer.create(testing.allocator, TEST_SAMPLE_RATE, 2, 4);
    engine.capture = capture;
    const input = [_]f32{ 0.25, -0.5 };
    capture.write(&input, 1);

    var output = [_]f32{ 0, 12345 };
    var frames_read: u32 = 99;
    const status = audio.readCapture(engine, output[0..1].ptr, 1, 1, &frames_read);
    try testing.expectEqual(@as(f32, 12345), output[1]);
    try testing.expectEqual(audio.Status.err_invalid, status);
    try testing.expectEqual(@as(u32, 0), frames_read);
}

test "audio capture rejects invalid and overflowing sizes before allocation" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const engine = audio.create(failing.allocator(), null) orelse return error.TestUnexpectedResult;
    defer audio.destroy(engine);

    const allocation_index = failing.alloc_index;
    failing.fail_index = allocation_index;

    try testing.expectEqual(audio.Status.err_invalid, audio.startCapture(engine, null, 0, 16));
    try testing.expectEqual(audio.Status.err_invalid, audio.startCapture(engine, null, 1, 0));
    try testing.expectEqual(audio.Status.err_invalid, audio.startCapture(engine, null, audio.max_capture_channels + 1, 16));
    try testing.expectEqual(audio.Status.err_invalid, audio.startCapture(engine, null, audio.max_capture_channels, std.math.maxInt(u32)));
    try testing.expectEqual(allocation_index, failing.alloc_index);
    try testing.expect(!failing.has_induced_failure);
    try testing.expect(engine.capture == null);

    var frames_read: u32 = 99;
    var sample = [_]f32{0};
    var stats: audio.CaptureStats = undefined;
    try testing.expectEqual(audio.Status.err_not_found, audio.readCapture(engine, &sample, sample.len, 1, &frames_read));
    try testing.expectEqual(@as(u32, 0), frames_read);
    try testing.expectEqual(audio.Status.err_invalid, audio.readCapture(engine, null, sample.len, 1, &frames_read));
    try testing.expectEqual(audio.Status.err_invalid, audio.readCapture(engine, &sample, sample.len, 1, null));
    try testing.expectEqual(audio.Status.err_not_found, audio.getCaptureStats(engine, &stats));
    try testing.expectEqual(audio.Status.err_invalid, audio.getCaptureStats(engine, null));
}

test "audio capture allocation failures clean up partial storage" {
    for (0..2) |failure_offset| {
        var failing = testing.FailingAllocator.init(testing.allocator, .{});
        const engine = audio.create(failing.allocator(), null) orelse return error.TestUnexpectedResult;
        defer audio.destroy(engine);

        const allocation_index = failing.alloc_index;
        failing.fail_index = allocation_index + failure_offset;
        try testing.expectEqual(audio.Status.err_no_space, audio.startCapture(engine, null, 1, 16));
        try testing.expect(failing.has_induced_failure);
        try testing.expect(engine.capture == null);
        try testing.expect(!engine.has_capture_device);
    }
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

test "audio - refresh and capture device selection APIs" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);

    const refresh_status = audio.refreshCaptureDevices(engine);
    if (refresh_status != audio.Status.ok) return error.SkipZigTest;

    const count = audio.getCaptureDeviceCount(engine);
    try testing.expectEqual(@as(u32, @intCast(engine.capture_devices.items.len)), count);
    if (count == 0) return error.SkipZigTest;

    var name_buf: [256]u8 = [_]u8{0} ** 256;
    const copied = audio.getCaptureDeviceName(engine, 0, name_buf[0..].ptr, name_buf.len);
    try testing.expect(copied <= name_buf.len);

    _ = audio.isCaptureDeviceDefault(engine, 0);

    try expectStatusOk(audio.selectCaptureDevice(engine, 0));
    try testing.expectEqual(@as(?u32, 0), engine.selected_capture_index);
    try testing.expect(engine.has_selected_capture_device);
    try testing.expectEqualSlices(
        u8,
        std.mem.asBytes(&engine.capture_devices.items[0].id),
        std.mem.asBytes(&engine.selected_capture_device_id),
    );

    const selected_device_id = engine.selected_capture_device_id;
    try expectStatusOk(audio.refreshCaptureDevices(engine));
    try testing.expect(engine.has_selected_capture_device);
    try testing.expectEqualSlices(
        u8,
        std.mem.asBytes(&selected_device_id),
        std.mem.asBytes(&engine.selected_capture_device_id),
    );

    audio.clearCaptureDeviceSelection(engine);
    try testing.expectEqual(@as(?u32, null), engine.selected_capture_index);
    try testing.expect(!engine.has_selected_capture_device);
}

test "audio - capture hardware honors default and provided callback sizing options" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);
    try expectStatusOk(audio.startMixer(engine));

    const default_status = audio.startCapture(engine, null, 1, 64);
    if (default_status != audio.Status.ok) {
        try testing.expectEqual(audio.Status.err_device, default_status);
        try testing.expect(!engine.has_capture_device);
        try testing.expect(engine.capture == null);
        return error.SkipZigTest;
    }

    try testing.expect(engine.has_capture_device);
    try testing.expect(audio.isCaptureRunning(engine));
    try testing.expect(engine.capture_device.noFixedSizedCallback != 0);
    try testing.expect(engine.started);
    try expectStatusOk(audio.stopCapture(engine));
    try testing.expect(!engine.has_capture_device);
    try testing.expect(!audio.isCaptureRunning(engine));
    try testing.expect(engine.capture != null);
    try testing.expect(engine.started);

    var options = audio.StartOptions{};
    options.no_fixed_sized_callback = false;
    const provided_status = audio.startCapture(engine, &options, 1, 96);
    if (provided_status != audio.Status.ok) {
        try testing.expectEqual(audio.Status.err_device, provided_status);
        return error.SkipZigTest;
    }

    try testing.expectEqual(@as(u8, 0), engine.capture_device.noFixedSizedCallback);
    var stats: audio.CaptureStats = undefined;
    try expectStatusOk(audio.getCaptureStats(engine, &stats));
    try testing.expectEqual(@as(u32, 96), stats.capacity_frames);
    try testing.expectEqual(@as(u32, 1), stats.channels);
    try testing.expectEqual(engine.sample_rate, stats.sample_rate);
    try testing.expect(engine.started);
    try expectStatusOk(audio.stopCapture(engine));
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

test "audio stream preflight rejects invalid group without allocating" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const engine = audio.create(failing.allocator(), null) orelse return error.TestUnexpectedResult;
    defer audio.destroy(engine);

    const allocation_index = failing.alloc_index;
    failing.fail_index = allocation_index;

    var options = streamOptions();
    options.group_id = std.math.maxInt(u32);
    var stream_id: u32 = 0xdeadbeef;
    try testing.expectEqual(audio.Status.err_invalid, audio.createStream(engine, &options, &stream_id));
    try testing.expectEqual(allocation_index, failing.alloc_index);
    try testing.expect(!failing.has_induced_failure);
    try testing.expectEqual(@as(u32, 0xdeadbeef), stream_id);
}

test "audio stream preflight rejects malformed options without allocating" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const engine = audio.create(failing.allocator(), null) orelse return error.TestUnexpectedResult;
    defer audio.destroy(engine);

    const allocation_index = failing.alloc_index;
    failing.fail_index = allocation_index;
    var stream_id: u32 = 0xdeadbeef;
    var options = streamOptions();

    try testing.expectEqual(audio.Status.err_invalid, audio.createStream(engine, null, &stream_id));
    try testing.expectEqual(audio.Status.err_invalid, audio.createStream(engine, &options, null));
    options.max_probe_bytes = 0;
    try testing.expectEqual(audio.Status.err_invalid, audio.createStream(engine, &options, &stream_id));
    options = streamOptions();
    options.format = 999;
    try testing.expectEqual(audio.Status.err_invalid, audio.createStream(engine, &options, &stream_id));
    options = streamOptions();
    options.capacity_ms = 0;
    try testing.expectEqual(audio.Status.err_invalid, audio.createStream(engine, &options, &stream_id));
    options = streamOptions();
    options.startup_ms = options.capacity_ms + 1;
    try testing.expectEqual(audio.Status.err_invalid, audio.createStream(engine, &options, &stream_id));
    options = streamOptions();
    options.resume_ms = options.capacity_ms + 1;
    try testing.expectEqual(audio.Status.err_invalid, audio.createStream(engine, &options, &stream_id));

    try testing.expectEqual(allocation_index, failing.alloc_index);
    try testing.expect(!failing.has_induced_failure);
    try testing.expectEqual(@as(u32, 0xdeadbeef), stream_id);
}

test "audio stream entry points reject invalid arguments without retiring a live stream" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);
    const options = streamOptions();
    var stream_id: u32 = 0;
    try expectStatusOk(audio.createStream(engine, &options, &stream_id));

    var stats = std.mem.zeroes(audio.StreamStats);
    try testing.expectEqual(audio.Status.err_invalid, audio.writeStream(engine, 0, null, 0));
    try testing.expectEqual(audio.Status.err_invalid, audio.writeStream(engine, stream_id, null, 1));
    try testing.expectEqual(@as(i32, 0), audio.writeStream(engine, stream_id, null, 0));
    try testing.expectEqual(audio.Status.err_invalid, audio.endStream(engine, 0));
    try testing.expectEqual(audio.Status.err_invalid, audio.restartStream(engine, 0));
    try testing.expectEqual(audio.Status.err_invalid, audio.setStreamVolume(engine, 0, 1));
    try testing.expectEqual(audio.Status.err_invalid, audio.setStreamPan(engine, 0, 0));
    try testing.expectEqual(audio.Status.err_invalid, audio.setStreamGroup(engine, 0, 0));
    try testing.expectEqual(audio.Status.err_invalid, audio.getStreamStats(engine, 0, &stats));
    try testing.expectEqual(audio.Status.err_invalid, audio.getStreamStats(engine, stream_id, null));
    try testing.expectEqual(
        audio.Status.err_invalid,
        audio.closeStream(engine, stream_id, audio.StreamCloseReason.disposed, null),
    );
    try testing.expectEqual(
        audio.Status.err_invalid,
        audio.closeStream(engine, stream_id, audio.StreamCloseReason.disposed + 1, &stats),
    );

    try expectStatusOk(audio.getStreamStats(engine, stream_id, &stats));
    try testing.expectEqual(audio.StreamState.initializing, stats.state);
    try expectStatusOk(audio.closeStream(engine, stream_id, audio.StreamCloseReason.disposed, &stats));
}

test "audio stream allocation failures clean up each partial allocation" {
    for (0..3) |failure_offset| {
        var failing = testing.FailingAllocator.init(testing.allocator, .{});
        const engine = audio.create(failing.allocator(), null) orelse return error.TestUnexpectedResult;
        defer audio.destroy(engine);
        const allocation_index = failing.alloc_index;
        failing.fail_index = allocation_index + failure_offset;

        const options = streamOptions();
        var stream_id: u32 = 0xdeadbeef;
        try testing.expectEqual(audio.Status.err_no_space, audio.createStream(engine, &options, &stream_id));
        try testing.expect(failing.has_induced_failure);
        try testing.expectEqual(@as(u32, 0xdeadbeef), stream_id);
        for (engine.streams) |stream| try testing.expect(stream == null);
        var stats: audio.Stats = undefined;
        try expectStatusOk(audio.getStats(engine, &stats));
        try testing.expectEqual(@as(u32, 0), stats.voices_active);
    }
}

test "audio stream preflight rejects millisecond capacity above miniaudio limit without allocating" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const engine = audio.create(failing.allocator(), null) orelse return error.TestUnexpectedResult;
    defer audio.destroy(engine);

    const allocation_index = failing.alloc_index;
    failing.fail_index = allocation_index;

    var options = streamOptions();
    options.capacity_ms = @intCast((@as(u64, audio.max_stream_pcm_capacity_frames) * 1_000) / TEST_SAMPLE_RATE + 1);
    options.startup_ms = 1;
    options.resume_ms = 1;
    var stream_id: u32 = 0xdeadbeef;
    try testing.expectEqual(audio.Status.err_invalid, audio.createStream(engine, &options, &stream_id));
    try testing.expectEqual(allocation_index, failing.alloc_index);
    try testing.expect(!failing.has_induced_failure);
    try testing.expectEqual(@as(u32, 0xdeadbeef), stream_id);
}

test "audio stream preflight accepts the largest millisecond capacity within the miniaudio bound" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const engine = audio.create(failing.allocator(), null) orelse return error.TestUnexpectedResult;
    defer audio.destroy(engine);

    const allocation_index = failing.alloc_index;
    failing.fail_index = allocation_index;

    var options = streamOptions();
    options.capacity_ms = @intCast((@as(u64, audio.max_stream_pcm_capacity_frames) * 1_000) / TEST_SAMPLE_RATE);
    options.startup_ms = 1;
    options.resume_ms = 1;
    var stream_id: u32 = 0;
    try testing.expectEqual(audio.Status.err_no_space, audio.createStream(engine, &options, &stream_id));
    try testing.expectEqual(allocation_index, failing.alloc_index);
    try testing.expect(failing.has_induced_failure);
}

test "audio stream duration conversion rounds up at 44.1kHz" {
    var create_options = audio.CreateOptions{ .sample_rate = 44_100 };
    const engine = try createEngine(&create_options);
    defer audio.destroy(engine);

    var options = streamOptions();
    options.capacity_ms = 1;
    options.startup_ms = 1;
    options.resume_ms = 1;
    var stream_id: u32 = 0;
    try expectStatusOk(audio.createStream(engine, &options, &stream_id));

    var stats: audio.StreamStats = undefined;
    try expectStatusOk(audio.getStreamStats(engine, stream_id, &stats));
    try testing.expectEqual(@as(u32, 44_100), stats.sample_rate);
    try testing.expectEqual(@as(u32, 45), stats.capacity_frames);

    try expectStatusOk(audio.closeStream(engine, stream_id, audio.StreamCloseReason.disposed, &stats));
}

test "audio stream preflight rejects shared voice exhaustion without allocating" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const engine = audio.create(failing.allocator(), null) orelse return error.TestUnexpectedResult;
    defer audio.destroy(engine);

    const mono_samples = [_]i16{ 2000, -2000, 4000, -4000, 2000, -2000 };
    const sound_id = try loadSoundFromSamples(engine, 1, &mono_samples);
    for (0..audio.max_voices) |_| {
        _ = try playLoop(engine, sound_id, 0, 0);
    }

    const allocation_index = failing.alloc_index;
    failing.fail_index = allocation_index;

    var options = streamOptions();
    var stream_id: u32 = 0xdeadbeef;
    try testing.expectEqual(audio.Status.err_no_space, audio.createStream(engine, &options, &stream_id));
    try testing.expectEqual(allocation_index, failing.alloc_index);
    try testing.expect(!failing.has_induced_failure);
    try testing.expectEqual(@as(u32, 0xdeadbeef), stream_id);
}

test "audio stream preflight rejects retired slots without allocating" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const engine = audio.create(failing.allocator(), null) orelse return error.TestUnexpectedResult;
    defer audio.destroy(engine);

    @memset(&engine.stream_generations, 0);
    const allocation_index = failing.alloc_index;
    failing.fail_index = allocation_index;

    var options = streamOptions();
    var stream_id: u32 = 0xdeadbeef;
    try testing.expectEqual(audio.Status.err_no_space, audio.createStream(engine, &options, &stream_id));
    try testing.expectEqual(allocation_index, failing.alloc_index);
    try testing.expect(!failing.has_induced_failure);
    try testing.expectEqual(@as(u32, 0xdeadbeef), stream_id);
}

test "audio stream reuses retired slot with a new generation" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);

    var options = streamOptions();
    var first_stream_id: u32 = 0;
    try expectStatusOk(audio.createStream(engine, &options, &first_stream_id));
    try testing.expect(first_stream_id != 0);
    var first_final: audio.StreamStats = undefined;
    try expectStatusOk(audio.closeStream(engine, first_stream_id, audio.StreamCloseReason.preserve_native_terminal, &first_final));
    try testing.expectEqual(audio.StreamState.cancelled, first_final.state);
    try testing.expectEqual(@as(u32, 0), first_final.buffered_frames);

    var second_stream_id: u32 = 0;
    try expectStatusOk(audio.createStream(engine, &options, &second_stream_id));
    try testing.expect(second_stream_id != 0);
    try testing.expect(first_stream_id != second_stream_id);

    const byte = [_]u8{0};
    var stale_stats: audio.StreamStats = undefined;
    var stale_final = std.mem.zeroes(audio.StreamStats);
    try testing.expectEqual(audio.Status.err_not_found, audio.writeStream(engine, first_stream_id, &byte, byte.len));
    try testing.expectEqual(audio.Status.err_not_found, audio.endStream(engine, first_stream_id));
    try testing.expectEqual(audio.Status.err_not_found, audio.restartStream(engine, first_stream_id));
    try testing.expectEqual(audio.Status.err_not_found, audio.setStreamVolume(engine, first_stream_id, 0.5));
    try testing.expectEqual(audio.Status.err_not_found, audio.setStreamPan(engine, first_stream_id, 0.5));
    try testing.expectEqual(audio.Status.err_not_found, audio.setStreamGroup(engine, first_stream_id, 0));
    try testing.expectEqual(audio.Status.err_not_found, audio.getStreamStats(engine, first_stream_id, &stale_stats));
    try testing.expectEqual(
        audio.Status.err_not_found,
        audio.closeStream(engine, first_stream_id, audio.StreamCloseReason.disposed, &stale_final),
    );

    var second_stats: audio.StreamStats = undefined;
    try expectStatusOk(audio.getStreamStats(engine, second_stream_id, &second_stats));
    try testing.expectEqual(audio.StreamState.initializing, second_stats.state);
    try testing.expectEqual(@as(u64, 0), second_stats.bytes_received);
    try testing.expectEqual(@as(u64, 0), second_stats.frames_decoded);
    try testing.expectEqual(@as(u64, 0), second_stats.frames_played);
    try testing.expectEqual(TEST_SAMPLE_RATE, second_stats.sample_rate);
    try testing.expectEqual(@as(u32, 2), second_stats.channels);
    try testing.expectEqual(@as(u32, 0), second_stats.buffered_frames);
    try testing.expectEqual(options.capacity_ms * (TEST_SAMPLE_RATE / 1_000), second_stats.capacity_frames);
    try testing.expectEqual(@as(u32, 0), second_stats.underruns);
    try testing.expectEqual(@as(i32, 0), second_stats.error_code);
    try testing.expectEqual(@as(u32, 0), second_stats.ready_generation);
    try testing.expectEqual(
        audio.Status.err_invalid,
        audio.closeStream(engine, second_stream_id, audio.StreamCloseReason.disposed + 1, &stale_final),
    );
    try expectStatusOk(audio.getStreamStats(engine, second_stream_id, &second_stats));

    var second_final: audio.StreamStats = undefined;
    try expectStatusOk(audio.closeStream(engine, second_stream_id, audio.StreamCloseReason.disposed, &second_final));
    try testing.expectEqual(audio.StreamState.cancelled, second_final.state);
    try testing.expectEqual(@as(u32, 0), second_final.buffered_frames);

    var stats: audio.Stats = undefined;
    try expectStatusOk(audio.getStats(engine, &stats));
    try testing.expectEqual(@as(u32, 0), stats.voices_active);
}

test "audio stream transport close publishes failed final state" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);

    var options = streamOptions();
    var stream_id: u32 = 0;
    try expectStatusOk(audio.createStream(engine, &options, &stream_id));

    var final_stats: audio.StreamStats = undefined;
    try expectStatusOk(audio.closeStream(engine, stream_id, audio.StreamCloseReason.transport_error, &final_stats));
    try testing.expectEqual(audio.StreamState.failed, final_stats.state);
    try testing.expectEqual(@as(u32, 0), final_stats.buffered_frames);
}

test "audio stream restart retains PCM and resumes decoding with the same id" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);
    try expectStatusOk(audio.startMixer(engine));
    const mp3 = try std.Io.Dir.cwd().readFileAlloc(testing.io, TEST_MP3_PATH, testing.allocator, .limited(16 * 1024));
    defer testing.allocator.free(mp3);

    var options = streamOptions();
    options.capacity_ms = 400;
    options.startup_ms = 6;
    options.resume_ms = 3;

    var stream_id: u32 = 0;
    try expectStatusOk(audio.createStream(engine, &options, &stream_id));
    for (0..8) |_| try writeAllStreamBytes(engine, stream_id, mp3);
    _ = try waitForBufferedFrames(engine, stream_id, 8 * 1024);

    var warmup: [512 * 2]f32 = undefined;
    try expectStatusOk(audio.mixToBuffer(engine, &warmup, 512, 2));

    var before_restart: audio.StreamStats = undefined;
    try expectStatusOk(audio.getStreamStats(engine, stream_id, &before_restart));
    try testing.expect(before_restart.frames_played > 0);
    try testing.expect(before_restart.buffered_frames > 4 * 1024);

    try expectStatusOk(audio.restartStream(engine, stream_id));

    var reconnecting: audio.StreamStats = undefined;
    try expectStatusOk(audio.getStreamStats(engine, stream_id, &reconnecting));
    try testing.expectEqual(audio.StreamState.reconnecting, reconnecting.state);
    try testing.expectEqual(before_restart.bytes_received, reconnecting.bytes_received);
    try testing.expect(reconnecting.frames_decoded >= before_restart.frames_decoded);
    try testing.expectEqual(before_restart.frames_played, reconnecting.frames_played);
    try testing.expectEqual(before_restart.ready_generation, reconnecting.ready_generation);

    var retained: [256 * 2]f32 = undefined;
    var heard_retained_pcm = false;
    var after_retained: audio.StreamStats = undefined;
    for (0..100) |_| {
        try expectStatusOk(audio.mixToBuffer(engine, &retained, 256, 2));
        heard_retained_pcm = heard_retained_pcm or hasSignal(&retained);
        try expectStatusOk(audio.getStreamStats(engine, stream_id, &after_retained));
        if (after_retained.buffered_frames == 0) break;
    }
    try testing.expect(heard_retained_pcm);
    try testing.expectEqual(@as(u32, 0), after_retained.buffered_frames);
    try testing.expectEqual(audio.StreamState.reconnecting, after_retained.state);
    try testing.expectEqual(reconnecting.frames_played + reconnecting.buffered_frames, after_retained.frames_played);

    var silence: [256 * 2]f32 = undefined;
    var reached_silence = false;
    for (0..16) |_| {
        try expectStatusOk(audio.mixToBuffer(engine, &silence, 256, 2));
        if (!hasSignal(&silence)) {
            reached_silence = true;
            break;
        }
    }
    try testing.expect(reached_silence);
    var after_silence: audio.StreamStats = undefined;
    try expectStatusOk(audio.getStreamStats(engine, stream_id, &after_silence));
    try testing.expectEqual(audio.StreamState.reconnecting, after_silence.state);
    try testing.expectEqual(after_retained.frames_played, after_silence.frames_played);

    try writeAllStreamBytes(engine, stream_id, mp3);
    try expectStatusOk(audio.endStream(engine, stream_id));

    var mixed: [256 * 2]f32 = undefined;
    var final_stats: audio.StreamStats = undefined;
    for (0..5_000) |_| {
        try expectStatusOk(audio.mixToBuffer(engine, &mixed, 256, 2));
        try expectStatusOk(audio.getStreamStats(engine, stream_id, &final_stats));
        if (final_stats.state == audio.StreamState.ended) break;
        if (final_stats.state == audio.StreamState.failed) return error.TestUnexpectedResult;
        testing.io.sleep(.fromMilliseconds(1), .awake) catch {};
    }

    try testing.expectEqual(audio.StreamState.ended, final_stats.state);
    try testing.expect(final_stats.frames_decoded > reconnecting.frames_decoded);
    try testing.expect(final_stats.frames_played > after_retained.frames_played);
    try testing.expectEqual(@as(u64, mp3.len * 9), final_stats.bytes_received);
    try testing.expect(final_stats.ready_generation != reconnecting.ready_generation);
}

test "audio stream repeatedly restarts after clean EOF with one persistent voice" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);
    try expectStatusOk(audio.startMixer(engine));
    const mp3 = try std.Io.Dir.cwd().readFileAlloc(testing.io, TEST_MP3_PATH, testing.allocator, .limited(16 * 1024));
    defer testing.allocator.free(mp3);

    const first_group = try createGroup(engine, "session-a");
    const second_group = try createGroup(engine, "session-b");
    var options = streamOptions();
    options.capacity_ms = 200;
    options.startup_ms = 6;
    options.resume_ms = 3;
    options.volume = 0.6;
    options.pan = -0.25;
    options.group_id = first_group;

    var stream_id: u32 = 0;
    try expectStatusOk(audio.createStream(engine, &options, &stream_id));
    const stream_ptr = engine.streams[0].?;
    const pcm_buffer_ptr = stream_ptr.pcm_buffer.ptr;
    try writeAllStreamBytes(engine, stream_id, mp3);
    try expectStatusOk(audio.endStream(engine, stream_id));
    const first_end = try mixStreamToEnd(engine, stream_id);
    try testing.expectEqual(@as(u64, mp3.len), first_end.bytes_received);
    try testing.expectEqual(options.capacity_ms * (TEST_SAMPLE_RATE / 1_000), first_end.capacity_frames);
    try testing.expect(first_end.ready_generation != 0);
    try testing.expect(stream_ptr.has_started_playback);

    var engine_stats: audio.Stats = undefined;
    try expectStatusOk(audio.getStats(engine, &engine_stats));
    try testing.expectEqual(@as(u32, 1), engine_stats.voices_active);

    var stopped_mix: [256 * 2]f32 = undefined;
    try expectStatusOk(audio.mixToBuffer(engine, &stopped_mix, 256, 2));
    try expectStatusOk(audio.restartStream(engine, stream_id));

    var first_restart: audio.StreamStats = undefined;
    try expectStatusOk(audio.getStreamStats(engine, stream_id, &first_restart));
    try testing.expectEqual(audio.StreamState.reconnecting, first_restart.state);
    try testing.expectEqual(first_end.bytes_received, first_restart.bytes_received);
    try testing.expectEqual(first_end.frames_decoded, first_restart.frames_decoded);
    try testing.expectEqual(first_end.frames_played, first_restart.frames_played);
    try testing.expectEqual(first_end.capacity_frames, first_restart.capacity_frames);
    try testing.expectEqual(first_end.ready_generation, first_restart.ready_generation);
    try testing.expectEqual(stream_ptr, engine.streams[0].?);
    try testing.expectEqual(pcm_buffer_ptr, stream_ptr.pcm_buffer.ptr);
    try testing.expect(stream_ptr.has_started_playback);

    var waiting_mix: [256 * 2]f32 = undefined;
    try expectStatusOk(audio.mixToBuffer(engine, &waiting_mix, 256, 2));
    try testing.expect(!hasSignal(&waiting_mix));
    var waiting_stats: audio.StreamStats = undefined;
    try expectStatusOk(audio.getStreamStats(engine, stream_id, &waiting_stats));
    try testing.expectEqual(audio.StreamState.reconnecting, waiting_stats.state);
    try testing.expectEqual(first_restart.frames_played, waiting_stats.frames_played);

    try expectStatusOk(audio.setStreamVolume(engine, stream_id, 0.8));
    try expectStatusOk(audio.setStreamPan(engine, stream_id, 0.35));
    try expectStatusOk(audio.setStreamGroup(engine, stream_id, second_group));
    try expectStatusOk(audio.getStats(engine, &engine_stats));
    try testing.expectEqual(@as(u32, 1), engine_stats.voices_active);

    try writeAllStreamBytes(engine, stream_id, mp3);
    try expectStatusOk(audio.endStream(engine, stream_id));
    const second_end = try mixStreamToEnd(engine, stream_id);
    try testing.expectEqual(@as(u64, mp3.len * 2), second_end.bytes_received);
    try testing.expect(second_end.frames_decoded > first_end.frames_decoded);
    try testing.expect(second_end.frames_played > first_end.frames_played);

    try expectStatusOk(audio.restartStream(engine, stream_id));
    try expectStatusOk(audio.setStreamVolume(engine, stream_id, 0.4));
    try expectStatusOk(audio.setStreamPan(engine, stream_id, -0.4));
    try expectStatusOk(audio.setStreamGroup(engine, stream_id, first_group));
    try writeAllStreamBytes(engine, stream_id, mp3);
    try expectStatusOk(audio.endStream(engine, stream_id));
    const third_end = try mixStreamToEnd(engine, stream_id);
    try testing.expectEqual(@as(u64, mp3.len * 3), third_end.bytes_received);
    try testing.expect(third_end.frames_decoded > second_end.frames_decoded);
    try testing.expect(third_end.frames_played > second_end.frames_played);
    try testing.expect(third_end.underruns >= first_end.underruns);
    try testing.expectEqual(first_end.capacity_frames, third_end.capacity_frames);
    try expectStatusOk(audio.getStats(engine, &engine_stats));
    try testing.expectEqual(@as(u32, 1), engine_stats.voices_active);

    try expectStatusOk(audio.restartStream(engine, stream_id));
    var final_stats: audio.StreamStats = undefined;
    try expectStatusOk(audio.closeStream(engine, stream_id, audio.StreamCloseReason.disposed, &final_stats));
    try testing.expectEqual(audio.StreamState.cancelled, final_stats.state);
    try testing.expectEqual(@as(u32, 0), final_stats.buffered_frames);
    try expectStatusOk(audio.getStats(engine, &engine_stats));
    try testing.expectEqual(@as(u32, 0), engine_stats.voices_active);
    try testing.expectEqual(audio.Status.err_not_found, audio.restartStream(engine, stream_id));
}

test "audio stream ready generation wraps to one" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);
    const mp3 = try std.Io.Dir.cwd().readFileAlloc(testing.io, TEST_MP3_PATH, testing.allocator, .limited(16 * 1024));
    defer testing.allocator.free(mp3);

    const options = streamOptions();
    var stream_id: u32 = 0;
    try expectStatusOk(audio.createStream(engine, &options, &stream_id));
    const stream = engine.streams[0] orelse return error.TestUnexpectedResult;
    @atomicStore(u32, &stream.ready_generation, std.math.maxInt(u32), .release);

    try writeAllStreamBytes(engine, stream_id, mp3);
    try expectStatusOk(audio.endStream(engine, stream_id));
    var stats: audio.StreamStats = undefined;
    for (0..5_000) |_| {
        try expectStatusOk(audio.getStreamStats(engine, stream_id, &stats));
        if (stats.ready_generation == 1) break;
        if (stats.state == audio.StreamState.failed) return error.TestUnexpectedResult;
        testing.io.sleep(.fromMilliseconds(1), .awake) catch {};
    }
    try testing.expectEqual(@as(u32, 1), stats.ready_generation);

    var final_stats: audio.StreamStats = undefined;
    try expectStatusOk(audio.closeStream(engine, stream_id, audio.StreamCloseReason.disposed, &final_stats));
}

test "audio stream restart rejects failed streams" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);

    var options = streamOptions();
    var stream_id: u32 = 0;
    try expectStatusOk(audio.createStream(engine, &options, &stream_id));

    const invalid_mp3 = "not an mp3 stream";
    try writeAllStreamBytes(engine, stream_id, invalid_mp3);
    try expectStatusOk(audio.endStream(engine, stream_id));

    var stats: audio.StreamStats = undefined;
    for (0..5_000) |_| {
        try expectStatusOk(audio.getStreamStats(engine, stream_id, &stats));
        if (stats.state == audio.StreamState.failed) break;
        testing.io.sleep(.fromMilliseconds(1), .awake) catch {};
    }
    try testing.expectEqual(audio.StreamState.failed, stats.state);
    try testing.expectEqual(audio.Status.err_invalid, audio.writeStream(engine, stream_id, invalid_mp3, invalid_mp3.len));
    try testing.expectEqual(audio.Status.err_invalid, audio.endStream(engine, stream_id));
    try testing.expectEqual(audio.Status.err_invalid, audio.restartStream(engine, stream_id));
    var final_stats: audio.StreamStats = undefined;
    try expectStatusOk(audio.closeStream(engine, stream_id, audio.StreamCloseReason.disposed, &final_stats));
    try testing.expectEqual(audio.StreamState.failed, final_stats.state);
    try testing.expectEqual(stats.error_code, final_stats.error_code);
    try testing.expectEqual(@as(u32, 0), final_stats.buffered_frames);
}

test "audio stream close wakes a restarted decoder waiting for bytes" {
    const engine = try createEngine(null);
    defer audio.destroy(engine);
    const mp3 = try std.Io.Dir.cwd().readFileAlloc(testing.io, TEST_MP3_PATH, testing.allocator, .limited(16 * 1024));
    defer testing.allocator.free(mp3);

    var options = streamOptions();
    options.capacity_ms = 200;
    options.startup_ms = 6;
    options.resume_ms = 3;

    var stream_id: u32 = 0;
    try expectStatusOk(audio.createStream(engine, &options, &stream_id));
    for (0..8) |_| try writeAllStreamBytes(engine, stream_id, mp3);
    _ = try waitForBufferedFrames(engine, stream_id, 4 * 1024);

    try expectStatusOk(audio.restartStream(engine, stream_id));
    var final_stats: audio.StreamStats = undefined;
    try expectStatusOk(audio.closeStream(engine, stream_id, audio.StreamCloseReason.disposed, &final_stats));
    try testing.expectEqual(audio.StreamState.cancelled, final_stats.state);
    try testing.expectEqual(@as(u32, 0), final_stats.buffered_frames);
    try testing.expectEqual(audio.Status.err_not_found, audio.restartStream(engine, stream_id));
}
