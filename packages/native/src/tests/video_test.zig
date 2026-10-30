const std = @import("std");
const testing = std.testing;
const c = @import("context_abi_c");
const audio = @import("../audio.zig");
const video = @import("../video.zig");
const image = @import("../image.zig");
const context = @import("../context.zig");
const scene = @import("../scene.zig");
const renderer = @import("../renderer.zig");
const Fixture = @import("scene_fixture_test.zig").Fixture;

const asset = "../core/src/tests/fixtures/video/testsrc-160x90-24fps-2s.mp4";
const missing = "../core/src/tests/fixtures/video/missing.mp4";
const frame_us: u32 = 41_667;

fn openAsset(external_audio: bool) !*video.Video {
    var detail: [256]u8 = undefined;
    return video.Video.open(testing.allocator, asset, external_audio, &detail);
}

// Mixing pulls the PCM stream as an output device would.
fn mix(value: *video.Video, frames: u32) !void {
    const output = try testing.allocator.alloc(f32, @as(usize, frames) * 2);
    defer testing.allocator.free(output);
    try testing.expectEqual(audio.Status.ok, value.mixOffline(output, frames));
}

// The PCM stream converts queued input on its own worker; wait until it can start.
fn prebuffer(value: *video.Video) !void {
    for (0..2000) |_| {
        _ = try value.update(0);
        if (value.audioStats().?.buffered_frames >= 12_000) return;
        std.Io.sleep(testing.io, .fromMilliseconds(1), .awake) catch {};
    }
    return error.TestUnexpectedResult;
}

test "video open reports metadata and decodes the first frame natively" {
    const value = try openAsset(false);
    defer value.deinit();
    try testing.expectEqual(@as(u32, 160), value.info.width);
    try testing.expectEqual(@as(u32, 90), value.info.height);
    try testing.expectEqual(@as(u32, 1), value.info.has_audio);
    try testing.expectEqual(@as(u32, 48_000), value.info.audio_sample_rate);
    try testing.expectEqual(@as(u32, 2), value.info.audio_channels);
    try testing.expect(value.info.duration_us >= 1_900_000 and value.info.duration_us <= 2_100_000);

    try value.configureOutput(80, 45, false);
    try testing.expect(try value.update(0));
    const state = value.getState();
    try testing.expectEqual(@as(u32, 1), state.has_frame);
    try testing.expectEqual(@as(i64, 0), state.frame_pts_us);
    const frame = value.current_image.?;
    try testing.expectEqual(@as(u32, 80), frame.width());
    try testing.expectEqual(@as(u32, 45), frame.height());
    try testing.expectEqual(@as(u32, 0), frame.metadata.has_alpha);
}

test "video open failures expose the native error detail" {
    var detail: [256]u8 = undefined;
    try testing.expectError(error.OpenFailed, video.Video.open(testing.allocator, missing, false, &detail));
    try testing.expect(std.mem.sliceTo(&detail, 0).len > 0);
    try testing.expectError(error.InvalidArgument, video.Video.open(testing.allocator, "", false, &detail));
}

test "video frames reuse pooled images and skip busy ones" {
    const value = try openAsset(true);
    defer value.deinit();
    try testing.expect(try value.update(0));
    const first = value.current_image.?;

    // A drawn frame stays busy while a buffer retains it.
    first.retain();
    try testing.expect(try value.update(frame_us));
    try testing.expect(value.current_image.? != first);
    try testing.expectEqual(@as(u32, 2), first.ref_count);
    first.deinit();

    // Released pool images are refreshed in place instead of reallocated.
    var seen = std.ArrayList(*image.Image).empty;
    defer seen.deinit(testing.allocator);
    for (2..12) |index| {
        try testing.expect(try value.update(@intCast(index * frame_us)));
        const current = value.current_image.?;
        if (std.mem.findScalar(*image.Image, seen.items, current) == null) try seen.append(testing.allocator, current);
    }
    try testing.expect(seen.items.len <= 4);
}

test "video production drops frames while every pooled image is busy" {
    const value = try openAsset(true);
    defer value.deinit();
    var held: [4]*image.Image = undefined;
    for (&held, 0..) |*slot, index| {
        try testing.expect(try value.update(@intCast(index * frame_us)));
        slot.* = value.current_image.?;
        slot.*.retain();
    }
    const serial = value.state.frame_serial;
    try testing.expect(!try value.update(4 * frame_us));
    try testing.expectEqual(serial, value.state.frame_serial);
    try testing.expect(!try value.prepare(5 * frame_us));
    for (held) |frame| frame.deinit();
    try testing.expect(try value.update(4 * frame_us));
}

test "video frame preparation runs asynchronously and the scheduler presents at its deadline" {
    const value = try openAsset(true);
    defer value.deinit();
    try testing.expect(try value.update(0));
    try testing.expect(try value.prepareNext(frame_us));
    try value.drainPreparation();
    const prepared_pts = value.state.prepared_pts_us;
    try testing.expect(prepared_pts > 0);
    const presented = value.state.frame_serial;

    try value.schedule(0, frame_us);
    try testing.expectEqual(presented, value.state.frame_serial);
    try value.schedule(prepared_pts, frame_us);
    try testing.expect(value.state.frame_serial != presented);
    try testing.expectEqual(prepared_pts, value.state.frame_pts_us);
    try testing.expectEqual(@as(i64, -1), value.state.prepared_pts_us);
}

test "video scheduler drops a stale prepared frame and seek clears the slot" {
    const value = try openAsset(true);
    defer value.deinit();
    try testing.expect(try value.update(0));
    try testing.expect(try value.prepare(frame_us));
    try value.drainPreparation();
    try testing.expect(value.prepared_image != null);
    try value.schedule(1_000_000, frame_us);
    try testing.expect(value.prepared_image == null);
    try testing.expect(value.resync_pending);

    try testing.expect(try value.prepare(frame_us));
    try value.drainPreparation();
    try value.seek(500_000);
    try testing.expect(value.prepared_image == null);
    try testing.expectEqual(@as(u32, 0), value.state.has_frame);
    try testing.expect(try value.update(500_000));
    try testing.expect(value.state.frame_pts_us <= 500_000 and value.state.frame_pts_us > 500_000 - frame_us);
}

test "video reaches the end of the stream" {
    const value = try openAsset(true);
    defer value.deinit();
    _ = try value.update(value.info.duration_us);
    try testing.expectEqual(@as(u32, 1), value.state.ended);
}

test "video audio streams PCM through the audio stream path and drives the media clock" {
    const value = try openAsset(false);
    defer value.deinit();
    value.setAudioOffline(true);
    value.play();
    try prebuffer(value);
    var state = value.getState();
    try testing.expectEqual(@as(u32, 1), state.buffering);
    try testing.expectEqual(@as(i64, 0), state.current_time_us);

    try mix(value, 4800);
    state = value.getState();
    try testing.expectEqual(@as(u32, 1), state.audio_active);
    try testing.expectEqual(@as(u64, 4800), state.audio_consumed_frames);
    try testing.expectEqual(@as(i64, 100_000), state.current_time_us);
    try testing.expect(state.audio_produced_frames >= 12_000);

    // Pausing suspends the mixer, so the clock and queued PCM hold.
    value.pause();
    value.syncAudio();
    try mix(value, 4800);
    try testing.expectEqual(@as(u64, 4800), value.getState().audio_consumed_frames);
    value.play();
    value.syncAudio();
    try mix(value, 4800);
    try testing.expectEqual(@as(i64, 200_000), value.getState().current_time_us);
}

test "video mute outputs silence while the clock advances" {
    const value = try openAsset(false);
    defer value.deinit();
    value.setAudioOffline(true);
    try value.setMuted(true);
    value.play();
    try prebuffer(value);
    var output: [9600]f32 = undefined;
    try testing.expectEqual(audio.Status.ok, value.mixOffline(&output, 4800));
    for (output) |sample| try testing.expectEqual(@as(f32, 0), sample);
    try testing.expectEqual(@as(i64, 100_000), value.getState().current_time_us);
}

test "video seek replaces queued PCM and restarts the clock at the target" {
    const value = try openAsset(false);
    defer value.deinit();
    value.setAudioOffline(true);
    value.play();
    try prebuffer(value);
    try mix(value, 4800);
    try value.seek(1_000_000);
    var state = value.getState();
    try testing.expectEqual(@as(u64, 0), state.audio_consumed_frames);
    try testing.expectEqual(@as(u64, 0), state.audio_produced_frames);
    try prebuffer(value);
    try mix(value, 4800);
    state = value.getState();
    try testing.expectEqual(@as(i64, 1_100_000), state.current_time_us);
}

// Seeks while the audio thread refills: a seek repositions the audio decoder only between
// refills, so the new stream holds every frame from the target to the end.
test "video seeks during audio refills keep every frame of the new position" {
    const value = try openAsset(false);
    defer value.deinit();
    value.setAudioOffline(true);
    value.play();
    for (0..50) |index| try value.seek(if (index % 2 == 0) 0 else 1_800_000);
    for (0..2000) |_| {
        if (value.getState().audio_produced_frames >= 9_600) break;
        sleepMs(1);
    }
    sleepMs(20);
    try testing.expectEqual(@as(u64, 9_600), value.getState().audio_produced_frames);
}

test "video external audio decodes PCM through manual reads" {
    const value = try openAsset(true);
    defer value.deinit();
    try testing.expect(value.audio_engine == null);
    var samples: [4096 * 2]f32 = undefined;
    var total: u64 = 0;
    var peak: f32 = 0;
    while (true) {
        const frames = try value.readAudio(&samples, 4096);
        if (frames == 0) break;
        for (samples[0 .. frames * 2]) |sample| peak = @max(peak, @abs(sample));
        total += frames;
    }
    try testing.expect(total >= 90_000 and total <= 100_000);
    try testing.expect(peak > 0.05);

    const owned = try openAsset(false);
    defer owned.deinit();
    try testing.expectError(error.InvalidArgument, owned.readAudio(&samples, 4096));
}

test "video output reconfiguration keeps the current frame presentable" {
    const value = try openAsset(true);
    defer value.deinit();
    try testing.expect(try value.update(0));
    const before = value.current_image.?;
    try value.configureOutput(40, 20, true);
    try testing.expectEqual(before, value.current_image.?);
    try testing.expectEqual(@as(u32, 1), value.state.has_frame);
    try testing.expect(try value.update(0));
    try testing.expectEqual(@as(u32, 40), value.current_image.?.width());
    try testing.expectEqual(@as(u32, 20), value.current_image.?.height());
}

test "video experimental hardware decoding matches software or falls back to it" {
    if (@import("builtin").os.tag == .windows) return error.SkipZigTest;
    const Environment = struct {
        extern "c" fn setenv(name: [*:0]const u8, value: [*:0]const u8, overwrite: c_int) c_int;
        extern "c" fn unsetenv(name: [*:0]const u8) c_int;
    };
    // macOS decodes through VideoToolbox; other platforms keep software decoding.
    _ = Environment.setenv("OPENTUI_EXPERIMENTAL_VIDEO_HWACCEL", "1", 1);
    const hardware = openAsset(false);
    _ = Environment.unsetenv("OPENTUI_EXPERIMENTAL_VIDEO_HWACCEL");
    const accelerated = try hardware;
    defer accelerated.deinit();
    try accelerated.configureOutput(64, 96, false);
    try testing.expect(try accelerated.update(500_000));

    // H.264 reconstruction is bit-exact, so both paths produce the same pixels.
    const software = try openAsset(false);
    defer software.deinit();
    try software.configureOutput(64, 96, false);
    try testing.expect(try software.update(500_000));
    try testing.expectEqualSlices(u8, software.current_image.?.pixels, accelerated.current_image.?.pixels);
}

const frame_options: scene.FrameOptions = .{
    .background = .{ 0, 0, 0, 255 },
    .use_mouse = false,
    .excluded_hit_num = 0,
    .max_layout_rounds = 8,
    .max_host_requests = 64,
};

fn videoNode(f: Fixture) !context.Handle {
    const node = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_VIDEO, 2);
    try f.owner.sceneSetStyle(node, 4, 0, 0, 1, 8, 1);
    try f.owner.sceneSetStyle(node, 4, 1, 0, 1, 4, 1);
    try f.owner.sceneMoveNode(node, f.root, 0);
    return node;
}

fn playerOf(f: Fixture, node: context.Handle) !*video.Player {
    return (try f.owner.raw().getRenderable(node)).scene_node.?.control.video.player.?;
}

fn paint(f: Fixture) !void {
    if (f.state.painted) |painted| try f.owner.sceneFrameCancel(f.id, painted.ticket.frame_id);
    _ = try f.step(null, frame_options, c.OT_SCENE_FRAME_DONE, null);
}

test "video scene nodes paint the current frame through the image path" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const node = try videoNode(f);
    try f.owner.sceneSetVideo(node, .fill, null);
    // Nothing paints before a source opens.
    try paint(f);
    const info = try f.owner.videoOpen(node, asset, true);
    try testing.expectEqual(@as(u32, 160), info.width);
    try paint(f);
    const value = try playerOf(f, node);
    const frame = value.video.current_image.?;
    // Without a pixel resolution a cell counts as 2x4 pixels.
    try testing.expectEqual(@as(u32, 16), frame.width());
    try testing.expectEqual(@as(u32, 16), frame.height());
    try testing.expect(frame.render_id != 0);
    // The painted buffer retains the frame, so the decoder skips it until release.
    try testing.expect(frame.ref_count > 1);
    try testing.expectEqual(@as(usize, 1), f.cli.getNextBuffer().image_placements.items.len);
}

// A playing video changes its cells without any scene input changing, so retained paint must
// never keep its rows. Its first decoded frame can arrive after paints that placed no image.
test "video scene repaints every committed frame while playing" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    try f.owner.sceneSetDebugFlags(f.id, c.OT_SCENE_DEBUG_VERIFY);
    const node = try videoNode(f);
    _ = try f.owner.videoOpen(node, asset, true);
    const value = try playerOf(f, node);
    value.video.failAudio("test");
    try f.owner.videoControl(node, video.Player.play, .{});
    var shown: [2]u32 = .{ 0, 0 };
    for (0..400) |_| {
        const done = try f.step(null, frame_options, c.OT_SCENE_FRAME_DONE, null);
        try testing.expect(f.state.frame_work.full_path_reasons & renderer.FrameWork.full_path_images != 0);
        _ = try f.owner.sceneFrameCommit(f.id, done, false);
        var bytes: [4096]u8 = undefined;
        while (try f.owner.readOutput(f.id, &bytes)) |ticket| try f.owner.completeOutput(f.id, ticket, .written);
        if (value.video.current_image) |frame| {
            if (shown[0] == 0) shown[0] = frame.render_id else if (frame.render_id != shown[0]) shown[1] = frame.render_id;
        }
        if (shown[1] != 0) break;
        sleepMs(5);
    }
    try testing.expect(shown[1] != 0);
}

test "video scene playback advances frames natively and ends without looping" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const node = try videoNode(f);
    // Without audio, a source with an audio track has no engine and follows the wall clock.
    _ = try f.owner.videoOpen(node, asset, false);
    const value = try playerOf(f, node);
    try f.owner.videoControl(node, video.Player.play, .{});
    try paint(f);
    try testing.expect(value.video.audio_engine == null and value.video.audioStats() == null);
    try testing.expectEqual(@as(u32, 0), value.video.getState().audio_active);
    const first = value.video.current_image.?.render_id;
    var advanced = false;
    for (0..200) |_| {
        std.Io.sleep(testing.io, .fromMilliseconds(5), .awake) catch {};
        try paint(f);
        if (value.video.current_image.?.render_id != first) {
            advanced = true;
            break;
        }
    }
    try testing.expect(advanced);
    try testing.expect(value.video.state.frame_pts_us > 0);

    try f.owner.videoControl(node, video.Player.seek, .{value.video.info.duration_us - 10_000});
    try paint(f);
    std.Io.sleep(testing.io, .fromMilliseconds(30), .awake) catch {};
    try paint(f);
    const state = try f.owner.videoGetState(node);
    try testing.expect(state.ended);
    try testing.expect(!state.playing);
    try testing.expectEqual(value.video.info.duration_us, state.current_time_us);
}

test "video scene loop restarts playback at the end" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const node = try videoNode(f);
    _ = try f.owner.videoOpen(node, asset, true);
    const value = try playerOf(f, node);
    value.video.failAudio("test");
    try f.owner.videoControl(node, video.Player.setLoop, .{true});
    try f.owner.videoControl(node, video.Player.play, .{});
    try f.owner.videoControl(node, video.Player.seek, .{value.video.info.duration_us - 10_000});
    std.Io.sleep(testing.io, .fromMilliseconds(30), .awake) catch {};
    try paint(f);
    const state = try f.owner.videoGetState(node);
    try testing.expect(state.playing);
    try testing.expect(!state.ended);
    try testing.expect(state.current_time_us < 500_000);
}

const gop_asset = "../core/src/tests/fixtures/video/gop-160x90-24fps-12s.mp4";
const single_frame_asset = "../core/src/tests/fixtures/video/single-frame-10us.mp4";
const oversized_asset = "../core/src/tests/fixtures/video/oversized-6000x5000.mp4";
const late_audio_asset = "../core/src/tests/fixtures/video/late-audio-160x90-0.5s.mp4";
const switch_asset = "../core/src/tests/fixtures/video/resolution-switch-160x90-to-6000x5000.mp4";

fn sleepMs(ms: i64) void {
    std.Io.sleep(testing.io, .fromMilliseconds(ms), .awake) catch {};
}

test "video scene playback keeps its audio queue filled without paints" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const node = try videoNode(f);
    _ = try f.owner.videoOpen(node, asset, true);
    const value = try playerOf(f, node);
    value.video.setAudioOffline(true);
    try f.owner.videoControl(node, video.Player.play, .{});
    try paint(f);
    // A hidden node or a slow renderer does not paint, yet the queue still fills to capacity.
    var produced: u64 = 0;
    for (0..1000) |_| {
        produced = value.video.getState().audio_produced_frames;
        if (produced >= 20_000) break;
        sleepMs(1);
    }
    try testing.expect(produced >= 20_000);
}

test "video scene playback ends and loops without paints" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const node = try videoNode(f);
    _ = try f.owner.videoOpen(node, gop_asset, true);
    const value = try playerOf(f, node);
    const total = value.video.info.duration_us;
    try f.owner.videoControl(node, video.Player.play, .{});
    try f.owner.videoControl(node, video.Player.seek, .{total - 10_000});
    sleepMs(30);
    var state = try f.owner.videoGetState(node);
    try testing.expect(state.ended);
    try testing.expect(!state.playing);
    try testing.expectEqual(total, state.current_time_us);

    try f.owner.videoControl(node, video.Player.setLoop, .{true});
    try f.owner.videoControl(node, video.Player.play, .{});
    try f.owner.videoControl(node, video.Player.seek, .{total - 10_000});
    sleepMs(30);
    state = try f.owner.videoGetState(node);
    try testing.expect(state.playing);
    try testing.expect(state.current_time_us < 500_000);
}

test "video scene loops a clip shorter than a paint without recursing" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const node = try videoNode(f);
    _ = try f.owner.videoOpen(node, single_frame_asset, true);
    try f.owner.videoControl(node, video.Player.setLoop, .{true});
    try f.owner.videoControl(node, video.Player.play, .{});
    for (0..5) |_| {
        try paint(f);
        sleepMs(2);
    }
    try testing.expect((try f.owner.videoGetState(node)).playing);
}

test "video rejects sources beyond the image limits" {
    var detail: [256]u8 = undefined;
    try testing.expectError(error.OpenFailed, video.Video.open(testing.allocator, oversized_asset, false, &detail));
    try testing.expect(std.mem.indexOf(u8, std.mem.sliceTo(&detail, 0), "limit") != null);
    // A stream whose first frames fit can switch to a size beyond the limits.
    const value = try video.Video.open(testing.allocator, switch_asset, true, &detail);
    defer value.deinit();
    try value.configureOutput(32, 18, false);
    try testing.expect(try value.update(0));
    try testing.expectError(error.DecodeFailed, value.update(1_200_000));
    try testing.expect(std.mem.indexOf(u8, value.lastError(), "6000x5000 exceeds the image limits") != null);
    // Decoding jumps to the large keyframe at 1 s; FFmpeg refuses to allocate it, so no frame
    // beyond the first decodes.
    try testing.expectEqual(@as(u64, 1), value.decodedFrames());
}

// FFmpeg logs from the decode worker and the audio thread; on a terminal app, stderr is the
// screen the renderer draws.
test "video decoding of a damaged file writes nothing to stderr" {
    if (comptime @import("builtin").os.tag == .windows) return error.SkipZigTest;
    try decodeDamagedWithStderrCaptured();
}

fn decodeDamagedWithStderrCaptured() !void {
    const bytes = try std.Io.Dir.cwd().readFileAlloc(testing.io, asset, testing.allocator, .limited(1 << 20));
    defer testing.allocator.free(bytes);
    var position: usize = 8000;
    while (position < bytes.len) : (position += 60) bytes[position] ^= 0x5a;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(testing.io, .{ .sub_path = "damaged.mp4", .data = bytes });
    const path = try tmp.dir.realPathFileAlloc(testing.io, "damaged.mp4", testing.allocator);
    defer testing.allocator.free(path);

    var pipe: [2]std.c.fd_t = undefined;
    try testing.expectEqual(@as(c_int, 0), std.c.pipe(&pipe));
    defer _ = std.c.close(pipe[0]);
    const saved = std.c.dup(2);
    try testing.expect(saved >= 0);
    try testing.expect(std.c.dup2(pipe[1], 2) >= 0);
    _ = std.c.close(pipe[1]);
    var failures: u32 = 0;
    {
        defer {
            _ = std.c.dup2(saved, 2);
            _ = std.c.close(saved);
        }
        var detail: [256]u8 = undefined;
        const value = try video.Video.open(testing.allocator, path, true, &detail);
        defer value.deinit();
        try value.configureOutput(32, 18, false);
        var target: i64 = 0;
        while (target < 2_000_000) : (target += frame_us) {
            _ = value.update(target) catch {
                failures += 1;
            };
        }
        var samples: [4096 * 2]f32 = undefined;
        while (true) {
            const frames = value.readAudio(&samples, 4096) catch {
                failures += 1;
                break;
            };
            if (frames == 0) break;
        }
    }
    var buffer: [256]u8 = undefined;
    const count = std.c.read(pipe[0], &buffer, buffer.len);
    try testing.expect(failures > 0);
    if (count > 0) std.debug.print("stderr: {s}\n", .{buffer[0..@intCast(count)]});
    try testing.expectEqual(@as(isize, 0), count);
}

test "video rejects sync offsets that would overflow the media clock" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const node = try videoNode(f);
    _ = try f.owner.videoOpen(node, gop_asset, true);
    const value = try playerOf(f, node);
    value.video.failAudio("test");
    try f.owner.videoControl(node, video.Player.play, .{});
    try paint(f);
    for ([_]i64{ std.math.minInt(i64), std.math.maxInt(i64) }) |offset| {
        try testing.expectError(error.InvalidArgument, f.owner.videoControl(node, video.Player.setAvSyncOffset, .{offset}));
        for (0..10) |_| {
            sleepMs(2);
            try paint(f);
        }
    }
    try f.owner.videoControl(node, video.Player.setAvSyncOffset, .{-video.max_av_sync_offset_us});
    try f.owner.videoControl(node, video.Player.setAvSyncOffset, .{video.max_av_sync_offset_us});
}

test "video playback recovers from a failure on play and seek" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const node = try videoNode(f);
    _ = try f.owner.videoOpen(node, gop_asset, true);
    const value = try playerOf(f, node);
    try paint(f);
    value.fail();
    try testing.expect((try f.owner.videoGetState(node)).failed);
    try f.owner.videoControl(node, video.Player.play, .{});
    var state = try f.owner.videoGetState(node);
    try testing.expect(!state.failed);
    try testing.expect(state.playing);
    value.fail();
    try f.owner.videoControl(node, video.Player.seek, .{1_000_000});
    state = try f.owner.videoGetState(node);
    try testing.expect(!state.failed);
    try testing.expectEqual(@as(i64, 1_000_000), state.current_time_us);
}

test "video playback failure keeps the position for the retry" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const node = try videoNode(f);
    _ = try f.owner.videoOpen(node, gop_asset, true);
    const value = try playerOf(f, node);
    try f.owner.videoControl(node, video.Player.play, .{});
    try paint(f);
    sleepMs(200);
    const before = (try f.owner.videoGetState(node)).current_time_us;
    try testing.expect(before >= 150_000);
    value.fail();
    const failed = try f.owner.videoGetState(node);
    try testing.expect(failed.failed);
    try testing.expect(failed.current_time_us >= before);
    try f.owner.videoControl(node, video.Player.play, .{});
    try testing.expect((try f.owner.videoGetState(node)).current_time_us >= before);
}

test "video settings apply while playback is failed" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const node = try videoNode(f);
    _ = try f.owner.videoOpen(node, gop_asset, true);
    const value = try playerOf(f, node);
    try paint(f);
    value.fail();
    try f.owner.videoControl(node, video.Player.setMuted, .{true});
    try f.owner.videoControl(node, video.Player.setLoop, .{true});
    try f.owner.videoControl(node, video.Player.setVolume, .{0.5});
    try f.owner.videoControl(node, video.Player.setMaxFps, .{24});
    try f.owner.videoControl(node, video.Player.setAvSyncOffset, .{10_000});
    try f.owner.videoControl(node, video.Player.pause, .{});
    try testing.expect(value.loop);
    try testing.expect((try f.owner.videoGetState(node)).failed);
}

test "video decode failures during playback fail the player" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const node = try videoNode(f);
    _ = try f.owner.videoOpen(node, gop_asset, true);
    const value = try playerOf(f, node);
    try f.owner.videoControl(node, video.Player.play, .{});
    try paint(f);
    // Stands in for the worker reporting a failed decode of the next frame.
    try value.video.drainPreparation();
    value.video.worker_mutex.lockUncancelable(testing.io);
    value.video.worker_result = .{ .failed = error.DecodeFailed };
    value.video.worker_mutex.unlock(testing.io);
    try paint(f);
    const state = try f.owner.videoGetState(node);
    try testing.expect(state.failed);
    try testing.expect(!state.playing);
}

test "video paused seek decodes its frame before the next paint" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const node = try videoNode(f);
    _ = try f.owner.videoOpen(node, gop_asset, true);
    const value = try playerOf(f, node);
    try paint(f);
    try f.owner.videoControl(node, video.Player.seek, .{2_000_000});
    // Decode failures surface from the seek call itself rather than a later paint.
    try testing.expectEqual(@as(i64, 2_000_000), value.video.state.frame_pts_us);
}

fn openGop() !*video.Video {
    var detail: [256]u8 = undefined;
    const value = try video.Video.open(testing.allocator, gop_asset, true, &detail);
    errdefer value.deinit();
    try value.configureOutput(32, 18, false);
    return value;
}

test "video decoding jumps to a keyframe ahead instead of decoding the gap" {
    const value = try openGop();
    defer value.deinit();
    try testing.expect(try value.update(0));
    const before = value.decodedFrames();
    // The fixture has keyframes at 0 s and 6 s; reaching 7 s needs about 24 frames from 6 s, not 168 from 0 s.
    try testing.expect(try value.update(7_000_000));
    try testing.expect(value.decodedFrames() - before <= 30);
    try testing.expect(value.state.frame_pts_us <= 7_000_000 and value.state.frame_pts_us > 7_000_000 - frame_us);
    // B-frames put the 6 s keyframe's index entry before 5.95 s; its frame still comes after.
    try value.seek(0);
    try testing.expect(try value.update(0));
    try testing.expect(try value.update(5_950_000));
    try testing.expect(value.state.frame_pts_us <= 5_950_000 and value.state.frame_pts_us > 5_950_000 - frame_us);
}

// The worker and the audio thread allocate through the Context allocator, whose test build
// checks for leaks. Destroying a node stops a long decode; destroying the Context stops a
// playing video's audio thread.
test "video scene teardown during a decode and during audio leaks nothing" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const decoding = try videoNode(f);
    _ = try f.owner.videoOpen(decoding, gop_asset, true);
    const gop = (try playerOf(f, decoding)).video;
    try gop.configureOutput(32, 18, false);
    try testing.expect(try gop.update(0));
    const before = gop.decodedFrames();
    try testing.expect(try gop.prepare(5_900_000));
    while (gop.decodedFrames() == before) std.atomic.spinLoopHint();
    try f.owner.sceneDestroyNode(decoding);

    const node = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_VIDEO, 3);
    try f.owner.sceneMoveNode(node, f.root, 0);
    _ = try f.owner.videoOpen(node, asset, true);
    const value = try playerOf(f, node);
    value.video.setAudioOffline(true);
    try f.owner.videoControl(node, video.Player.play, .{});
    try paint(f);
    try prebuffer(value.video);
}

test "video seek and teardown cancel a long decode" {
    const value = try openGop();
    defer value.deinit();
    try testing.expect(try value.update(0));
    const before = value.decodedFrames();
    // No keyframe lies between 0 s and 5.9 s, so production decodes about 141 frames.
    try testing.expect(try value.prepare(5_900_000));
    while (value.decodedFrames() == before) std.atomic.spinLoopHint();
    try value.seek(0);
    try testing.expect(value.decodedFrames() - before < 100);
    try testing.expect(try value.update(0));
    try testing.expectEqual(@as(i64, 0), value.state.frame_pts_us);
    // A new output size stops the decode first: the worker must not convert a frame while the
    // shim replaces its scaler and buffer.
    const resized = value.decodedFrames();
    try testing.expect(try value.prepare(5_900_000));
    while (value.decodedFrames() == resized) std.atomic.spinLoopHint();
    try value.configureOutput(16, 9, false);
    const stopped = value.decodedFrames();
    sleepMs(20);
    try testing.expectEqual(stopped, value.decodedFrames());
    try testing.expect(stopped - resized < 100);
}

test "video paused output reconfiguration rescales the shown frame without decoding" {
    const value = try openGop();
    defer value.deinit();
    try testing.expect(try value.update(5_500_000));
    const pts = value.state.frame_pts_us;
    const before = value.decodedFrames();
    try value.configureOutput(40, 20, true);
    try testing.expect(try value.update(5_500_000));
    // At most the lookahead frame that tells the shown frame is still current.
    try testing.expect(value.decodedFrames() - before <= 1);
    try testing.expectEqual(pts, value.state.frame_pts_us);
    try testing.expectEqual(@as(u32, 40), value.current_image.?.width());
}

test "video presents frames early by the measured output latency" {
    const value = try openAsset(true);
    defer value.deinit();
    try testing.expect(try value.update(0));
    try testing.expect(try value.prepare(frame_us * 2));
    try value.drainPreparation();
    const prepared_pts = value.state.prepared_pts_us;
    const presented = value.state.frame_serial;
    // Renderer frames take 30 ms from start until their output is written.
    value.observeOutput(1, 30_000);
    value.observeOutput(1, 90_000);
    try value.schedule(prepared_pts - 30_001, frame_us);
    try testing.expectEqual(presented, value.state.frame_serial);
    try value.schedule(prepared_pts - 30_000, frame_us);
    try testing.expectEqual(prepared_pts, value.state.frame_pts_us);
    try testing.expect(value.state.sync_lead_us >= 30_000);
}

test "video A/V sync offset shifts frame selection and presentation" {
    const value = try openAsset(true);
    defer value.deinit();
    try value.setAvSyncOffset(100_000);
    // A positive offset shows frames earlier: the frame for 100 ms is selected at 0.
    try testing.expect(try value.update(0));
    try testing.expect(value.state.frame_pts_us >= 100_000 - frame_us and value.state.frame_pts_us <= 100_000);
    try testing.expect(try value.prepare(500_000));
    try value.drainPreparation();
    const prepared_pts = value.state.prepared_pts_us;
    try value.schedule(prepared_pts - 100_001, frame_us);
    try testing.expect(value.state.frame_pts_us != prepared_pts);
    try value.schedule(prepared_pts - 100_000, frame_us);
    try testing.expectEqual(prepared_pts, value.state.frame_pts_us);
    try testing.expectError(error.InvalidArgument, value.setAvSyncOffset(video.max_av_sync_offset_us + 1));
}

test "video consecutive preparation steps one source frame at a time" {
    const value = try openAsset(true);
    defer value.deinit();
    try testing.expect(try value.update(0));
    var previous = value.state.frame_pts_us;
    for (0..6) |_| {
        try testing.expect(try value.prepareNext(frame_us));
        try value.drainPreparation();
        const next = value.state.prepared_pts_us;
        try testing.expect(next - previous >= frame_us - 1 and next - previous <= frame_us + 1);
        try value.schedule(next, frame_us);
        try testing.expectEqual(next, value.state.frame_pts_us);
        previous = next;
    }
}

test "video audio underrun holds the clock and recovers" {
    const value = try openAsset(false);
    defer value.deinit();
    value.setAudioOffline(true);
    value.play();
    try prebuffer(value);
    try mix(value, 4800);
    // Pull far more than is queued: the clock stops at the queued audio.
    try mix(value, 48_000);
    var state = value.getState();
    try testing.expect(state.audio_underruns > 0);
    const held = state.current_time_us;
    try testing.expect(held < 1_000_000);
    // The audio thread refills, and playback resumes from the held position.
    try prebuffer(value);
    try mix(value, 4800);
    state = value.getState();
    try testing.expect(state.current_time_us > held);
    try testing.expect(state.current_time_us <= held + 100_000);
}

test "video pause keeps the queued audio and the clock" {
    const value = try openAsset(false);
    defer value.deinit();
    value.setAudioOffline(true);
    value.play();
    try prebuffer(value);
    try mix(value, 4800);
    value.pause();
    value.syncAudio();
    const paused = value.getState();
    std.Io.sleep(testing.io, .fromMilliseconds(20), .awake) catch {};
    try mix(value, 4800);
    const later = value.getState();
    try testing.expectEqual(paused.audio_queued_frames, later.audio_queued_frames);
    try testing.expectEqual(paused.audio_consumed_frames, later.audio_consumed_frames);
    try testing.expectEqual(@as(u32, 0), later.playing);
}

test "video audio drains at the end of the stream" {
    const value = try openAsset(false);
    defer value.deinit();
    value.setAudioOffline(true);
    try value.seek(1_800_000);
    value.play();
    var state = value.getState();
    for (0..2000) |_| {
        try mix(value, 960);
        state = value.getState();
        if (state.audio_ended != 0 and state.audio_queued_frames == 0) break;
        std.Io.sleep(testing.io, .fromMilliseconds(1), .awake) catch {};
    }
    try testing.expectEqual(@as(u32, 1), state.audio_ended);
    try testing.expectEqual(@as(u32, 0), state.audio_queued_frames);
    // About 200 ms of PCM remained after the seek, and all of it played.
    try testing.expect(state.audio_consumed_frames >= 9_000 and state.audio_consumed_frames <= 10_500);
    try testing.expectEqual(state.audio_produced_frames, state.audio_consumed_frames);
}

// Decodes the whole track from target_us into output and returns its frame count.
fn decodeAudioFrom(target_us: i64, output: []f32) !usize {
    const value = try openAsset(true);
    defer value.deinit();
    if (target_us > 0) try value.seek(target_us);
    var total: usize = 0;
    while (true) {
        const capacity: u32 = @intCast(@min(4096, output.len / 2 - total));
        const decoded = try value.readAudio(output[total * 2 ..], capacity);
        if (decoded == 0) return total;
        total += decoded;
    }
}

test "video audio after a first seek starts at the target sample" {
    const reference = try testing.allocator.alloc(f32, 100_000 * 2);
    defer testing.allocator.free(reference);
    const sought = try testing.allocator.alloc(f32, 100_000 * 2);
    defer testing.allocator.free(sought);
    const total = try decodeAudioFrom(0, reference);
    for ([_]i64{ 1_800_000, 1_000_000, 500_000 }) |target_us| {
        const start: usize = @intCast(@divExact(target_us * 48, 1000));
        const frames = try decodeAudioFrom(target_us, sought);
        try testing.expectEqual(total - start, frames);
        // The sought PCM continues the full decode from its first sample.
        for (0..frames) |frame| {
            try testing.expectApproxEqAbs(reference[(start + frame) * 2], sought[frame * 2], 0.001);
        }
    }
    // A track that starts after the video plays silence until its first sample, so the sine
    // that starts at 0.5 s stays at 0.5 s from the start and after a later seek.
    var detail: [256]u8 = undefined;
    const late = try video.Video.open(testing.allocator, late_audio_asset, true, &detail);
    defer late.deinit();
    for ([_]i64{ 0, 250_000 }) |target_us| {
        if (target_us > 0) try late.seek(target_us);
        var frames: usize = 0;
        while (true) {
            const decoded = try late.readAudio(sought[frames * 2 ..], @intCast(@min(4096, sought.len / 2 - frames)));
            if (decoded == 0) break;
            frames += decoded;
        }
        const first = for (sought[0 .. frames * 2], 0..) |sample, index| {
            if (@abs(sample) > 0.05) break index / 2;
        } else frames;
        const expected: usize = @intCast(@divExact((500_000 - target_us) * 48, 1000));
        errdefer std.debug.print("seek {d}: first loud sample {d}, expected about {d}\n", .{ target_us, first, expected });
        try testing.expect(first >= expected and first < expected + 100);
    }
}

test "video output reconfiguration keeps the queued audio" {
    const value = try openAsset(false);
    defer value.deinit();
    value.setAudioOffline(true);
    value.play();
    try prebuffer(value);
    try mix(value, 4800);
    const before = value.getState();
    try value.configureOutput(40, 20, false);
    const after = value.getState();
    try testing.expectEqual(before.audio_consumed_frames, after.audio_consumed_frames);
    try testing.expect(after.audio_queued_frames >= before.audio_queued_frames);
    try testing.expectEqual(before.current_time_us, after.current_time_us);
}

test "video volume scales the mixed audio" {
    const value = try openAsset(false);
    defer value.deinit();
    value.setAudioOffline(true);
    value.play();
    try prebuffer(value);
    var output: [9600]f32 = undefined;
    try testing.expectEqual(audio.Status.ok, value.mixOffline(&output, 4800));
    var full: f32 = 0;
    for (output) |sample| full = @max(full, @abs(sample));
    try value.setVolume(0.25);
    value.syncAudio();
    try testing.expectEqual(audio.Status.ok, value.mixOffline(&output, 4800));
    var quiet: f32 = 0;
    for (output) |sample| quiet = @max(quiet, @abs(sample));
    try testing.expect(full > 0.05);
    try testing.expectApproxEqRel(full * 0.25, quiet, 0.05);
}

test "video scene audio failure continues playback silently from the audio position" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const node = try videoNode(f);
    _ = try f.owner.videoOpen(node, asset, true);
    const value = try playerOf(f, node);
    value.video.setAudioOffline(true);
    try f.owner.videoControl(node, video.Player.play, .{});
    try paint(f);
    try prebuffer(value.video);
    try mix(value.video, 12_000);
    try testing.expectEqual(@as(i64, 250_000), (try f.owner.videoGetState(node)).current_time_us);
    value.video.failAudio("audio decode failed");
    const state = try f.owner.videoGetState(node);
    try testing.expect(state.playing);
    try testing.expect(!state.failed);
    try testing.expect(!state.audio);
    // The wall clock takes over where the audio stopped instead of jumping to wall time since play.
    try testing.expect(state.current_time_us >= 250_000 and state.current_time_us < 350_000);
    try testing.expectEqualStrings("audio decode failed", try f.owner.videoGetError(node));
    try paint(f);
    try testing.expect(!(try f.owner.videoGetState(node)).failed);
}

test "video scene playback ends after the audio drains without paints" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const node = try videoNode(f);
    _ = try f.owner.videoOpen(node, asset, true);
    const value = try playerOf(f, node);
    value.video.setAudioOffline(true);
    try f.owner.videoControl(node, video.Player.seek, .{value.video.info.duration_us - 200_000});
    try f.owner.videoControl(node, video.Player.play, .{});
    // A device pulls the stream; only the audio thread publishes what it played.
    var output: [960 * 2]f32 = undefined;
    var state = try f.owner.videoGetState(node);
    for (0..3000) |_| {
        value.video.engine_lock.lockUncancelable(testing.io);
        _ = audio.mixToBuffer(value.video.audio_engine.?, &output, 960, 2);
        value.video.engine_lock.unlock(testing.io);
        state = try f.owner.videoGetState(node);
        if (state.ended) break;
        sleepMs(1);
    }
    try testing.expect(state.ended);
    try testing.expect(!state.playing);
}

test "video scene seek while playing continues from the target" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const node = try videoNode(f);
    _ = try f.owner.videoOpen(node, gop_asset, true);
    try f.owner.videoControl(node, video.Player.play, .{});
    try paint(f);
    try f.owner.videoControl(node, video.Player.seek, .{8_000_000});
    try paint(f);
    const value = try playerOf(f, node);
    const state = try f.owner.videoGetState(node);
    try testing.expect(state.playing);
    try testing.expect(state.current_time_us >= 8_000_000 and state.current_time_us < 8_500_000);
    try testing.expect(value.video.state.frame_pts_us >= 8_000_000 - frame_us and value.video.state.frame_pts_us < 8_500_000);
}

test "video scene max fps accepts 1 to 120 and defaults to 30" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const node = try videoNode(f);
    _ = try f.owner.videoOpen(node, asset, true);
    const value = try playerOf(f, node);
    try testing.expectEqual(@as(u32, 30), value.max_fps);
    try f.owner.videoControl(node, video.Player.setMaxFps, .{12});
    try testing.expectEqual(@as(u32, 12), value.max_fps);
    try testing.expectError(error.InvalidArgument, f.owner.videoControl(node, video.Player.setMaxFps, .{0}));
    try testing.expectError(error.InvalidArgument, f.owner.videoControl(node, video.Player.setMaxFps, .{121}));
    try testing.expectEqual(@as(u32, 12), value.max_fps);
}

test "video scene open failures keep their detail" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    const node = try videoNode(f);
    try testing.expectError(error.OpenFailed, f.owner.videoOpen(node, missing, true));
    try testing.expect((try f.owner.videoGetError(node)).len > 0);
    try testing.expectError(error.NoPlayer, f.owner.videoControl(node, video.Player.play, .{}));
    const box = try f.owner.sceneCreateNode(f.id, c.OT_SCENE_BOX, 3);
    try testing.expectError(error.WrongKind, f.owner.videoOpen(box, asset, true));
    // Closing clears the failure.
    _ = try f.owner.videoOpen(node, "", true);
    try testing.expectEqual(@as(usize, 0), (try f.owner.videoGetError(node)).len);
}

test "video quality steps down under sustained overload and recovers with backoff" {
    var quality: video.Quality = .{};
    // Frames within budget never degrade.
    for (0..200) |_| quality.sample(frame_us * 3 / 4, frame_us);
    try testing.expectEqual(@as(u8, 0), quality.tier);
    // Isolated slow frames are absorbed.
    for (0..50) |index| quality.sample(if (index % 3 == 0) frame_us * 2 else frame_us / 4, frame_us);
    try testing.expectEqual(@as(u8, 0), quality.tier);

    // Sustained overload steps down one tier at a time, holding each through a cooldown.
    var samples: usize = 0;
    while (quality.tier == 0) : (samples += 1) quality.sample(frame_us * 3 / 2, frame_us);
    try testing.expectEqual(@as(usize, 8), samples);
    samples = 0;
    while (quality.tier == 1) : (samples += 1) quality.sample(frame_us * 3 / 2, frame_us);
    try testing.expect(samples > 30);
    // A frame that takes many intervals weighs as many slow frames.
    samples = 0;
    while (quality.tier == 2) : (samples += 1) quality.sample(frame_us * 10, frame_us);
    try testing.expect(samples <= 5);
    for (0..1000) |_| quality.sample(frame_us * 10, frame_us);
    try testing.expectEqual(@as(u8, video.quality_scales.len - 1), quality.tier);

    // Headroom steps back up after a long run of cheap frames.
    samples = 0;
    while (quality.tier == video.quality_scales.len - 1) : (samples += 1) quality.sample(frame_us / 4, frame_us);
    try testing.expectEqual(@as(usize, 120), samples);
    // Overload right after stepping up steps down again and doubles the run to recover.
    while (quality.tier == video.quality_scales.len - 2) quality.sample(frame_us * 3 / 2, frame_us);
    samples = 0;
    while (quality.tier == video.quality_scales.len - 1) : (samples += 1) quality.sample(frame_us / 4, frame_us);
    try testing.expectEqual(@as(usize, 240), samples);
    // Once a step up holds, recovery is quick again.
    for (0..240) |_| quality.sample(frame_us * 3 / 4, frame_us);
    samples = 0;
    while (quality.tier == video.quality_scales.len - 2) : (samples += 1) quality.sample(frame_us / 4, frame_us);
    try testing.expectEqual(@as(usize, 120), samples);
    for (0..10_000) |_| quality.sample(frame_us / 4, frame_us);
    try testing.expectEqual(@as(u8, 0), quality.tier);
}

// Each iteration publishes a new frame and completes a renderer frame with the given cost.
fn paintWithFrameCost(f: Fixture, node: context.Handle, index: usize, cost_us: u32) !void {
    try f.owner.videoControl(node, video.Player.seek, .{@as(i64, @intCast(index % 40)) * frame_us});
    try paint(f);
    f.cli.renderStats.frameCount += 1;
    f.cli.lastFrameCostUs = cost_us;
}

test "video scene decodes Kitty output smaller while frames overrun and recovers" {
    const f = try Fixture.init(testing.allocator, 8, 4, .{});
    defer f.deinit();
    f.cli.terminal.image_protocol = .kitty;
    const node = try videoNode(f);
    try f.owner.sceneSetVideo(node, .fill, null);
    _ = try f.owner.videoOpen(node, asset, true);
    const value = try playerOf(f, node);
    value.video.failAudio("test");
    try f.owner.videoControl(node, video.Player.play, .{});
    try paint(f);
    try testing.expectEqual(@as(u32, 16), value.video.current_image.?.width());

    // A slow terminal: every frame takes several frame intervals to write.
    var index: usize = 0;
    while (index < 100 and (try f.owner.videoGetState(node)).quality_tier < 2) : (index += 1) {
        try paintWithFrameCost(f, node, index, frame_us * 4);
    }
    try testing.expectEqual(@as(u32, 2), (try f.owner.videoGetState(node)).quality_tier);
    try paint(f);
    try testing.expectEqual(@as(u32, 8), value.video.current_image.?.width());
    try testing.expectEqual(@as(u32, 8), value.video.current_image.?.height());

    // The terminal keeps up again: quality returns to the full decode size.
    index = 0;
    while (index < 1000 and (try f.owner.videoGetState(node)).quality_tier > 0) : (index += 1) {
        try paintWithFrameCost(f, node, index, frame_us / 4);
    }
    try testing.expectEqual(@as(u32, 0), (try f.owner.videoGetState(node)).quality_tier);
    try paint(f);
    try testing.expectEqual(@as(u32, 16), value.video.current_image.?.width());

    // Other protocols draw at the placement's pixel size, so they keep the full size.
    f.cli.terminal.image_protocol = .blocks;
    for (0..20) |step| try paintWithFrameCost(f, node, step, frame_us * 4);
    try testing.expectEqual(@as(u32, 0), (try f.owner.videoGetState(node)).quality_tier);
}
