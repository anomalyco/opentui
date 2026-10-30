const std = @import("std");
const builtin = @import("builtin");
const io = if (builtin.is_test) std.testing.io else @import("root").io;
const audio = @import("audio.zig");
const image = @import("image.zig");

const Allocator = std.mem.Allocator;

const Decoder = opaque {};
pub const audio_sample_rate: u32 = 48_000;
const audio_capacity_frames: u32 = 24_000;
const audio_decode_frames: u32 = 4096;
const audio_capacity_ms: u32 = 500;
const audio_startup_ms: u32 = 250;
// How often the audio thread tops up the queue and publishes the clock while playing.
const audio_service_us: i64 = 5_000;
/// Bounds the A/V sync offset so clock arithmetic cannot overflow.
pub const max_av_sync_offset_us: i64 = 60_000_000;
// Current, prepared, in-flight, and frames whose published handles await release.
const frame_pool_capacity = 4;

pub const Info = extern struct {
    duration_us: i64 = 0,
    width: u32 = 0,
    height: u32 = 0,
    fps_num: u32 = 0,
    fps_den: u32 = 1,
    has_audio: u32 = 0,
    audio_sample_rate: u32 = 0,
    audio_channels: u32 = 0,
};

pub const State = extern struct {
    current_time_us: i64 = 0,
    frame_pts_us: i64 = -1,
    frame_serial: u64 = 0,
    has_frame: u32 = 0,
    ended: u32 = 0,
    playing: u32 = 0,
    buffering: u32 = 0,
    audio_active: u32 = 0,
    audio_ended: u32 = 0,
    audio_failed: u32 = 0,
    audio_queued_frames: u32 = 0,
    audio_consumed_frames: u64 = 0,
    audio_produced_frames: u64 = 0,
    audio_underruns: u64 = 0,
    prepared_pts_us: i64 = -1,
    sync_lead_us: u32 = 0,
    prepare_time_us: u32 = 0,
};

const latency_window_size = 30;

pub const LatencyWindow = struct {
    samples: [latency_window_size]u32 = [_]u32{0} ** latency_window_size,
    count: u8 = 0,
    cursor: u8 = 0,

    pub fn add(self: *LatencyWindow, sample: u32) void {
        self.samples[self.cursor] = sample;
        self.cursor = @intCast((@as(usize, self.cursor) + 1) % latency_window_size);
        if (self.count < latency_window_size) self.count += 1;
    }

    pub fn maximum(self: *const LatencyWindow) u32 {
        var result: u32 = 0;
        for (self.samples[0..self.count]) |sample| result = @max(result, sample);
        return result;
    }

    fn reset(self: *LatencyWindow) void {
        self.* = .{};
    }
};

/// Adaptive quality: each tier scales the decoded frame size, which Kitty sends
/// as is, so a lower tier cuts transport bytes and conversion work by its area.
pub const quality_scales = [_]f64{ 1, 0.75, 0.5, 0.35, 0.25 };
const quality_overload_limit = 8;
const quality_cooldown = 30;
const quality_recovery = 120;
const quality_recovery_max = quality_recovery * 8;

/// Steps down after sustained frame costs above the frame interval and back up
/// after a long run with cost below half of it. A step down soon after a step up
/// doubles the run required to recover, so a tier that does not fit is not retried
/// every few seconds.
pub const Quality = struct {
    tier: u8 = 0,
    overload: u8 = 0,
    headroom: u32 = 0,
    cooldown: u8 = 0,
    recovery: u32 = quality_recovery,
    since_upgrade: ?u32 = null,

    pub fn scale(self: Quality) f64 {
        return quality_scales[self.tier];
    }

    fn settle(self: *Quality) void {
        self.overload = 0;
        self.headroom = 0;
        self.cooldown = quality_cooldown;
    }

    /// Counts in frame intervals, so a frame that took several intervals weighs as
    /// much as that many slow frames and a slow pipeline still adapts promptly.
    pub fn sample(self: *Quality, cost_us: u32, interval_us: u32) void {
        const intervals: u8 = @intCast(@min(cost_us / @max(interval_us, 1), quality_overload_limit));
        if (cost_us > interval_us) self.overload +|= @max(intervals, 1) else self.overload -|= 2;
        if (cost_us < interval_us / 2) self.headroom +|= 1 else self.headroom -|= 4;
        if (self.since_upgrade) |samples| {
            self.since_upgrade = samples + 1;
            if (samples + 1 >= self.recovery) {
                self.since_upgrade = null;
                self.recovery = quality_recovery;
            }
        }
        if (self.cooldown > 0) {
            self.cooldown -|= @max(intervals, 1);
            self.overload = 0;
            return;
        }
        if (self.overload >= quality_overload_limit and self.tier + 1 < quality_scales.len) {
            self.tier += 1;
            if (self.since_upgrade != null) self.recovery = @min(self.recovery * 2, quality_recovery_max);
            self.since_upgrade = null;
            self.settle();
        } else if (self.headroom >= self.recovery and self.tier > 0) {
            self.tier -= 1;
            self.since_upgrade = 0;
            self.settle();
        }
    }
};

const PreparedFrame = struct {
    value: *image.Image,
    pts_us: i64,
    serial: u64,
};

const ProduceRequest = struct {
    target_us: i64,
    known_frame_serial: u64,
    known_prepared_serial: u64,
    slot: usize,
};

const ProduceOutcome = struct {
    frame: ?PreparedFrame = null,
    reached_end: bool = false,
    failed: ?anyerror = null,
    elapsed_us: u32 = 0,
};

const OtvLimits = extern struct { max_pixels: u64, max_width: u32, max_height: u32 };
extern fn otv_open(
    path: [*:0]const u8,
    limits: *const OtvLimits,
    out_decoder: *?*Decoder,
    out_info: *Info,
    error_out: [*]u8,
    error_cap: u32,
) c_int;
extern fn otv_close(decoder: *?*Decoder) void;
extern fn otv_seek(decoder: *Decoder, target_us: i64) c_int;
extern fn otv_set_output_size(decoder: *Decoder, width: u32, height: u32, cover: u32, crop: image.Region) c_int;
extern fn otv_decode_frame(
    decoder: *Decoder,
    target_us: i64,
    out_rgba: *?[*]const u8,
    out_width: *u32,
    out_height: *u32,
    out_stride: *u32,
    out_pts_us: *i64,
    out_serial: *u64,
) c_int;
extern fn otv_read_audio(decoder: *Decoder, out_samples: ?[*]f32, capacity_frames: u32, out_frames: *u32) c_int;
extern fn otv_last_error(decoder: *const Decoder) [*:0]const u8;
extern fn otv_stream_error(decoder: *const Decoder, audio_stream: u32) [*:0]const u8;
extern fn otv_decoded_frames(decoder: *const Decoder) u64;
extern fn otv_cancel(decoder: *Decoder, cancel: u32) void;
const otv_eof = 1;
const otv_cancelled = 2;

fn nowUs() i64 {
    return @intCast(std.Io.Clock.now(.awake, io).toMicroseconds());
}

fn elapsedSince(started: i64) u32 {
    return @intCast(std.math.clamp(nowUs() - started, 0, std.math.maxInt(u32)));
}

fn copyMessage(buffer: []u8, message: []const u8) usize {
    const length = @min(message.len, buffer.len);
    @memcpy(buffer[0..length], message[0..length]);
    return length;
}

// Requests from the owner thread to the audio thread.
const AudioControl = struct {
    playing: bool = false,
    gain: f32 = 1,
    // Each seek bumps the generation; the audio thread then replaces the stream.
    generation: u32 = 0,
    // Counts control changes, so tests can wait until the audio thread applied them.
    version: u32 = 0,
    quit: bool = false,
};

// What the audio thread last observed, read by the owner for the media clock.
const AudioStatus = struct {
    stats: audio.StreamStats = std.mem.zeroes(audio.StreamStats),
    produced_frames: u64 = 0,
    ended: bool = false,
    failed: bool = false,
    mixer_running: bool = false,
    applied_version: u32 = 0,
    // When the stream was first seen drained, so the wall clock can take over from then.
    ended_us: i64 = 0,
};

const Device = enum { idle, started, failed };

/// Decodes one media file. Frames are native images; audio plays through a private engine
/// and its PCM stream, whose played frames are the media clock.
pub const Video = struct {
    allocator: Allocator,
    decoder: *Decoder,
    info: Info,
    state: State = .{},
    // Frames are pooled images refreshed in place with image.updatePixels. Each
    // publication hands out a retained handle; a retained image is busy and is
    // skipped until its handles are released. current/prepared borrow pool images.
    frame_pool: [frame_pool_capacity]?*image.Image = @splat(null),
    current_image: ?*image.Image = null,
    prepared_image: ?*image.Image = null,
    prepared_serial: u64 = 0,
    last_produced_pts_us: i64 = -1,
    // Set when the media position no longer follows production stepping
    // (start, seek, reconfiguration, or a dropped stale frame); the next
    // preparation then re-anchors to the clock instead of stepping.
    resync_pending: bool = true,
    preparation_latency: LatencyWindow = .{},
    // Recent renderer frame costs from frame start until its output was
    // written; frames are presented that much early to land on time.
    output_latency: LatencyWindow = .{},
    last_output_frame: u64 = 0,
    // Counts presented frames; never resets, so painters can detect new pixels.
    published: u64 = 0,
    output_width: u32,
    output_height: u32,
    output_cover: bool = false,
    output_crop: ?image.Region = null,
    wants_playback: bool = false,
    muted: bool = false,
    volume: f32 = 1,
    av_sync_offset_us: i64 = 0,
    // Media time where the current PCM stream starts; owner thread only.
    audio_base_us: i64 = 0,
    audio_offline: bool = false,
    audio_engine: ?*audio.Engine = null,
    audio_buffer: ?[]f32 = null,
    // A dedicated audio thread owns the private engine: it starts the device,
    // keeps the PCM queue filled, and publishes the clock, so audio does not
    // depend on painting. audio_lock guards control and status.
    audio_thread: ?std.Thread = null,
    audio_wake: std.atomic.Value(u32) = .init(0),
    audio_lock: std.Io.Mutex = .init,
    audio_control: AudioControl = .{},
    audio_status: AudioStatus = .{},
    audio_error_buf: [256]u8 = [_]u8{0} ** 256,
    audio_error_len: usize = 0,
    // Serializes every engine entry, as audio.zig requires. Device startup
    // holds it, so the owner thread never takes it.
    engine_lock: std.Io.Mutex = .init,
    // Serializes the audio decoder between the audio thread and seeks.
    audio_decode_lock: std.Io.Mutex = .init,
    // Guarded by engine_lock.
    audio_stream: u32 = 0,
    stream_generation: u32 = 0,
    device: Device = .idle,
    mixer_running: bool = false,
    applied_gain: f32 = 1,
    audio_ended: bool = false,
    audio_produced_frames: u64 = 0,
    // Frame production runs on a dedicated worker so decode, hardware
    // readback, and scaling overlap with rendering. The worker is the only
    // thread touching the decoder's video stream; the caller keeps
    // seeking and reconfiguration, which quiesce the worker first. Results
    // hand over fully built frames under the mutex.
    worker: ?std.Thread = null,
    worker_mutex: std.Io.Mutex = .init,
    worker_wake: std.Io.Condition = .init,
    worker_done: std.Io.Condition = .init,
    worker_pending: ?ProduceRequest = null,
    worker_busy: bool = false,
    worker_quit: bool = false,
    worker_result: ?ProduceOutcome = null,
    // The last failure; cleared by seeks and recovery.
    last_error_buf: [256]u8 = [_]u8{0} ** 256,
    last_error_len: usize = 0,

    /// With external_audio the caller owns the audio: no engine is created and
    /// decoded 48 kHz stereo PCM is pulled through readAudio. A failed open
    /// writes its detail to error_out.
    pub fn open(allocator: Allocator, path: []const u8, external_audio: bool, error_out: []u8) !*Video {
        if (error_out.len > 0) error_out[0] = 0;
        if (path.len == 0 or std.mem.indexOfScalar(u8, path, 0) != null) return error.InvalidArgument;
        const path_z = try allocator.dupeZ(u8, path);
        defer allocator.free(path_z);
        var decoder: ?*Decoder = null;
        var info = Info{};
        var detail: [256]u8 = [_]u8{0} ** 256;
        const limits: image.Limits = .{};
        const shim_limits: OtvLimits = .{ .max_pixels = limits.max_pixels, .max_width = limits.max_width, .max_height = limits.max_height };
        if (otv_open(path_z.ptr, &shim_limits, &decoder, &info, &detail, detail.len) != 0 or decoder == null) {
            writeOpenError(error_out, std.mem.sliceTo(&detail, 0));
            return error.OpenFailed;
        }
        errdefer otv_close(&decoder);
        const video = try allocator.create(Video);
        errdefer allocator.destroy(video);
        video.* = .{
            .allocator = allocator,
            .decoder = decoder.?,
            .info = info,
            .output_width = info.width,
            .output_height = info.height,
        };
        if (info.has_audio != 0 and !external_audio) {
            const engine = audio.create(allocator, &.{ .sample_rate = audio_sample_rate, .playback_channels = 2 }) orelse
                return error.OutOfMemory;
            errdefer audio.destroy(engine);
            video.audio_buffer = try allocator.alloc(f32, audio_decode_frames * 2);
            errdefer allocator.free(video.audio_buffer.?);
            video.audio_engine = engine;
            // No audio thread exists yet, so this thread may enter the engine.
            try video.openAudioStream();
            _ = video.publishAudioStatus(0);
        }
        return video;
    }

    fn writeOpenError(error_out: []u8, message: []const u8) void {
        if (error_out.len == 0) return;
        const length = copyMessage(error_out[0 .. error_out.len - 1], message);
        error_out[length] = 0;
    }

    pub fn deinit(self: *Video) void {
        self.quiesceWorker();
        self.worker_mutex.lockUncancelable(io);
        self.worker_quit = true;
        self.worker_wake.broadcast(io);
        self.worker_mutex.unlock(io);
        if (self.worker) |thread| thread.join();
        self.updateControl(.{ .quit = true });
        if (self.audio_thread) |thread| thread.join();
        if (self.audio_engine) |engine| audio.destroy(engine);
        if (self.audio_buffer) |buffer| self.allocator.free(buffer);
        for (self.frame_pool) |slot| if (slot) |value| value.deinit();
        var decoder: ?*Decoder = self.decoder;
        otv_close(&decoder);
        self.allocator.destroy(self);
    }

    /// Converts the crop of each frame, or the whole frame, to width x height. Returns
    /// whether the output changed.
    pub fn configureOutput(self: *Video, width: u32, height: u32, cover: bool, crop: ?image.Region) !bool {
        if (width == 0 or height == 0) return error.InvalidArgument;
        if (width == self.output_width and height == self.output_height and cover == self.output_cover and
            std.meta.eql(crop, self.output_crop)) return false;
        self.quiesceWorker();
        const region = crop orelse image.Region{ .width = 0, .height = 0 };
        if (otv_set_output_size(self.decoder, width, height, @intFromBool(cover), region) != 0) return error.DecodeFailed;
        self.output_width = width;
        self.output_height = height;
        self.output_cover = cover;
        self.output_crop = crop;
        // The decoder keeps its position and converts the selected frame again
        // at the new size; a reseek would re-decode from the previous keyframe
        // and stall long-GOP streams on every resize or quality change.
        // The stale-sized frame stays presentable until its replacement is
        // decoded, so reconfiguring does not blank the placement.
        self.resetScheduler();
        self.state.frame_serial = 0;
        self.state.frame_pts_us = -1;
        return true;
    }

    pub fn seek(self: *Video, target_us: i64) !void {
        if (target_us < 0) return error.InvalidArgument;
        self.quiesceWorker();
        self.clearError();
        self.audio_decode_lock.lockUncancelable(io);
        const sought = otv_seek(self.decoder, target_us) == 0;
        if (sought and self.audio_engine != null) {
            // The audio thread replaces the stream, dropping the queued PCM of the old position.
            self.audio_lock.lockUncancelable(io);
            self.audio_control.generation +%= 1;
            self.audio_control.version +%= 1;
            const failed = self.audio_status.failed;
            self.audio_status = .{ .failed = failed, .applied_version = self.audio_status.applied_version };
            self.audio_lock.unlock(io);
        }
        self.audio_decode_lock.unlock(io);
        if (!sought) {
            self.setError(std.mem.span(otv_last_error(self.decoder)));
            return error.SeekFailed;
        }
        self.wakeAudio();
        self.audio_base_us = target_us;
        self.state.current_time_us = target_us;
        self.state.frame_pts_us = -1;
        self.state.ended = 0;
        self.state.frame_serial = 0;
        self.state.has_frame = 0;
        self.current_image = null;
        self.clearPrepared();
        self.last_produced_pts_us = -1;
        self.resync_pending = true;
    }

    /// Synchronously produces the frame for target_us (first frame, seek preview).
    pub fn update(self: *Video, target_us: i64) !bool {
        if (target_us < 0) return error.InvalidArgument;
        const effective_target = self.clockTime(target_us);
        var frame_target: i64 = @max(0, effective_target +| self.av_sync_offset_us);
        if (self.info.duration_us > 0) {
            frame_target = if (effective_target >= self.info.duration_us)
                self.info.duration_us
            else
                @min(frame_target, self.info.duration_us - 1);
        }
        self.state.current_time_us = effective_target;
        const outcome = self.produceBlocking(frame_target);
        self.state.prepare_time_us = outcome.elapsed_us;
        if (outcome.failed) |err| {
            self.captureVideoError();
            return err;
        }
        if (outcome.reached_end) {
            self.state.ended = 1;
            return false;
        }
        self.state.ended = 0;
        const decoded = outcome.frame orelse return false;
        self.last_produced_pts_us = decoded.pts_us;
        self.resync_pending = false;
        self.publish(decoded);
        return true;
    }

    /// Posts asynchronous frame production; the result is collected by
    /// schedule(), prepareNext(), or drainPreparation(). Never blocks.
    pub fn prepare(self: *Video, target_us: i64) !bool {
        if (target_us < 0) return error.InvalidArgument;
        const frame_target = if (self.info.duration_us > 0)
            @min(target_us, self.info.duration_us - 1)
        else
            target_us;
        self.worker_mutex.lockUncancelable(io);
        defer self.worker_mutex.unlock(io);
        if (self.worker_busy or self.worker_pending != null or self.worker_result != null) return false;
        // Every pooled frame is still on screen or held by a handle: skip this frame.
        const slot = self.freeSlot() orelse return false;
        try self.ensureWorkerLocked();
        self.worker_pending = .{
            .target_us = frame_target,
            .known_frame_serial = self.state.frame_serial,
            .known_prepared_serial = self.prepared_serial,
            .slot = slot,
        };
        self.worker_wake.signal(io);
        return true;
    }

    /// Waits for in-flight production and collects it.
    pub fn drainPreparation(self: *Video) !void {
        self.worker_mutex.lockUncancelable(io);
        while (self.worker_busy or self.worker_pending != null) self.worker_done.waitUncancelable(io, &self.worker_mutex);
        self.worker_mutex.unlock(io);
        try self.collectPrepared();
    }

    // Runs on the caller, which owns every retain and release. A free image is
    // unpublished and unreferenced, so the worker may write it exclusively.
    fn freeSlot(self: *Video) ?usize {
        for (self.frame_pool, 0..) |slot, index| {
            const value = slot orelse return index;
            if (value != self.current_image and value != self.prepared_image and value.ref_count == 1) return index;
        }
        return null;
    }

    fn ensureWorkerLocked(self: *Video) !void {
        if (self.worker != null) return;
        self.worker = std.Thread.spawn(.{}, workerMain, .{self}) catch return error.OutOfMemory;
    }

    fn workerMain(self: *Video) void {
        while (true) {
            self.worker_mutex.lockUncancelable(io);
            while (self.worker_pending == null and !self.worker_quit) self.worker_wake.waitUncancelable(io, &self.worker_mutex);
            if (self.worker_quit) {
                self.worker_mutex.unlock(io);
                return;
            }
            const request = self.worker_pending.?;
            self.worker_pending = null;
            self.worker_busy = true;
            self.worker_mutex.unlock(io);

            const started = nowUs();
            var outcome = self.produceFrame(request);
            outcome.elapsed_us = elapsedSince(started);

            self.worker_mutex.lockUncancelable(io);
            self.worker_result = outcome;
            self.worker_busy = false;
            self.worker_done.broadcast(io);
            self.worker_mutex.unlock(io);
        }
    }

    // Runs on the worker thread. Touches only the decoder's video stream and
    // the thread-safe allocator; every input is snapshotted in the request.
    fn produceFrame(self: *Video, request: ProduceRequest) ProduceOutcome {
        var pixels: ?[*]const u8 = null;
        var width: u32 = 0;
        var height: u32 = 0;
        var stride: u32 = 0;
        var pts_us: i64 = -1;
        var serial: u64 = 0;
        const result = otv_decode_frame(self.decoder, request.target_us, &pixels, &width, &height, &stride, &pts_us, &serial);
        if (result == otv_cancelled) return .{};
        if (result == otv_eof) return .{ .reached_end = true };
        if (result != 0 or pixels == null) return .{ .failed = error.DecodeFailed };
        if (serial == request.known_frame_serial or serial == request.known_prepared_serial) return .{};
        const required = @as(usize, stride) * height;
        const source = pixels.?[0..required];
        const slot = &self.frame_pool[request.slot];
        if (slot.*) |value| {
            if (value.width() == width and value.height() == height) {
                image.updatePixels(value, source, .{ .stride = stride }) catch |err| return .{ .failed = err };
                return .{ .frame = .{ .value = value, .pts_us = pts_us, .serial = serial } };
            }
            // Output geometry changed; the free image of the old size is replaced.
            value.deinit();
            slot.* = null;
        }
        const next = image.createFromRgba(self.allocator, source, width, height, stride) catch |err|
            return .{ .failed = err };
        slot.* = next;
        return .{ .frame = .{ .value = next, .pts_us = pts_us, .serial = serial } };
    }

    // Blocks the caller while the worker produces one frame.
    fn produceBlocking(self: *Video, target_us: i64) ProduceOutcome {
        self.worker_mutex.lockUncancelable(io);
        defer self.worker_mutex.unlock(io);
        // Discard any stale in-flight preparation first.
        self.cancelLocked();
        const slot = self.freeSlot() orelse return .{};
        self.ensureWorkerLocked() catch return .{ .failed = error.OutOfMemory };
        self.worker_pending = .{
            .target_us = target_us,
            .known_frame_serial = if (self.current_image != null) self.state.frame_serial else std.math.maxInt(u64),
            .known_prepared_serial = self.prepared_serial,
            .slot = slot,
        };
        self.worker_wake.signal(io);
        while (self.worker_busy or self.worker_pending != null) self.worker_done.waitUncancelable(io, &self.worker_mutex);
        const outcome = self.worker_result orelse ProduceOutcome{};
        self.worker_result = null;
        return outcome;
    }

    // Moves a finished worker result into the prepared slot on the caller.
    fn collectPrepared(self: *Video) !void {
        self.worker_mutex.lockUncancelable(io);
        const outcome = self.worker_result;
        self.worker_result = null;
        self.worker_mutex.unlock(io);
        const value = outcome orelse return;
        self.state.prepare_time_us = value.elapsed_us;
        if (value.failed) |err| {
            self.captureVideoError();
            return err;
        }
        const frame = value.frame orelse return;
        self.preparation_latency.add(value.elapsed_us);
        self.updateSyncLead();
        self.clearPrepared();
        self.prepared_image = frame.value;
        self.prepared_serial = frame.serial;
        self.state.prepared_pts_us = frame.pts_us;
        self.last_produced_pts_us = frame.pts_us;
    }

    // Drops pending work and cancels in-flight production; the caller may
    // then mutate the decoder's video stream safely.
    fn quiesceWorker(self: *Video) void {
        self.worker_mutex.lockUncancelable(io);
        defer self.worker_mutex.unlock(io);
        self.cancelLocked();
    }

    fn cancelLocked(self: *Video) void {
        self.worker_pending = null;
        if (self.worker_busy) {
            otv_cancel(self.decoder, 1);
            while (self.worker_busy) self.worker_done.waitUncancelable(io, &self.worker_mutex);
            otv_cancel(self.decoder, 0);
        }
        self.worker_result = null;
    }

    fn setError(self: *Video, message: []const u8) void {
        self.last_error_len = copyMessage(&self.last_error_buf, message);
    }

    fn clearError(self: *Video) void {
        self.last_error_len = 0;
    }

    fn captureVideoError(self: *Video) void {
        self.setError(std.mem.span(otv_stream_error(self.decoder, 0)));
    }

    /// Presents the prepared frame once the clock reaches its deadline, or drops it when stale.
    pub fn schedule(self: *Video, fallback_time_us: i64, presentation_interval_us: u32) !void {
        if (fallback_time_us < 0 or presentation_interval_us == 0) return error.InvalidArgument;
        self.state.current_time_us = self.clockTime(fallback_time_us);
        try self.collectPrepared();
        self.updateSyncLead();
        const prepared = self.prepared_image orelse return;
        const prepared_pts = self.state.prepared_pts_us;
        if (prepared_pts < self.state.current_time_us -| presentation_interval_us) {
            self.clearPrepared();
            self.resync_pending = true;
            return;
        }
        // Output takes a frame cost to reach the screen, so frames go out that much early.
        const deadline = prepared_pts -| @as(i64, self.output_latency.maximum()) -| self.av_sync_offset_us;
        if (self.state.current_time_us < deadline) return;
        self.prepared_image = null;
        self.publish(.{ .value = prepared, .pts_us = prepared_pts, .serial = self.prepared_serial });
        self.prepared_serial = 0;
        self.state.prepared_pts_us = -1;
    }

    pub fn prepareNext(self: *Video, presentation_interval_us: u32) !bool {
        if (presentation_interval_us == 0) return error.InvalidArgument;
        try self.collectPrepared();
        if (self.prepared_image != null) return false;
        self.updateSyncLead();
        // Production marches through the source deterministically: one
        // presentation step per produced frame, independent of scheduling
        // jitter. The half-step margin makes the at-or-before frame selection
        // reach the next frame across timestamp rounding. Only a resync
        // (start, seek, reconfiguration, dropped frame) consults the clock.
        const interval: i64 = presentation_interval_us;
        const source_interval: i64 = if (self.info.fps_num > 0)
            @intCast((@as(u64, 1_000_000) * self.info.fps_den + self.info.fps_num - 1) / self.info.fps_num)
        else
            interval;
        const target = if (self.resync_pending or self.last_produced_pts_us < 0)
            self.state.current_time_us +| @as(i64, self.state.sync_lead_us) +| interval +| self.av_sync_offset_us
        else
            self.last_produced_pts_us +| @max(interval, source_interval) +| @divTrunc(source_interval, 2);
        self.resync_pending = false;
        return self.prepare(@max(0, target));
    }

    /// Records the cost of a completed renderer frame, once per frame.
    pub fn observeOutput(self: *Video, frame: u64, cost_us: u32) void {
        if (frame == self.last_output_frame or cost_us == 0) return;
        self.last_output_frame = frame;
        self.output_latency.add(cost_us);
    }

    fn publish(self: *Video, decoded: PreparedFrame) void {
        self.current_image = decoded.value;
        self.state.frame_pts_us = decoded.pts_us;
        self.state.frame_serial = decoded.serial;
        self.state.has_frame = 1;
        self.published += 1;
    }

    fn clearPrepared(self: *Video) void {
        self.prepared_image = null;
        self.prepared_serial = 0;
        self.state.prepared_pts_us = -1;
    }

    fn updateSyncLead(self: *Video) void {
        self.state.sync_lead_us = self.preparation_latency.maximum() +| self.output_latency.maximum();
    }

    fn resetScheduler(self: *Video) void {
        self.clearPrepared();
        self.last_produced_pts_us = -1;
        self.resync_pending = true;
        self.preparation_latency.reset();
        self.output_latency.reset();
        self.last_output_frame = 0;
        self.state.sync_lead_us = 0;
    }

    pub fn getState(self: *Video) State {
        const status = self.audioStatus();
        if (self.audioClockActive(status)) self.state.current_time_us = self.audioTimeUs(status);
        self.state.playing = @intFromBool(self.wants_playback);
        self.state.audio_ended = @intFromBool(status.ended);
        self.state.audio_failed = @intFromBool(status.failed);
        if (self.audio_engine == null) {
            self.state.buffering = 0;
            self.state.audio_active = 0;
            self.state.audio_queued_frames = 0;
            self.state.audio_consumed_frames = 0;
            self.state.audio_produced_frames = 0;
            self.state.audio_underruns = 0;
            return self.state;
        }
        const active = self.audioClockActive(status);
        const audio_playing = status.stats.state == audio.StreamState.playing and status.mixer_running;
        self.state.audio_active = @intFromBool(active and audio_playing);
        self.state.buffering = @intFromBool(active and !audio_playing);
        self.state.audio_queued_frames = queuedAudioFrames(status.stats);
        self.state.audio_consumed_frames = status.stats.frames_played;
        self.state.audio_produced_frames = status.produced_frames;
        self.state.audio_underruns = status.stats.underruns;
        return self.state;
    }

    fn decodeAudio(self: *Video, samples: []f32, capacity_frames: u32) !u32 {
        if (self.info.has_audio == 0) return 0;
        const required = @as(usize, capacity_frames) * self.info.audio_channels;
        if (samples.len < required) return error.InvalidArgument;
        var frames: u32 = 0;
        if (otv_read_audio(self.decoder, if (samples.len == 0) null else samples.ptr, capacity_frames, &frames) < 0) {
            return error.DecodeFailed;
        }
        return frames;
    }

    pub fn readAudio(self: *Video, samples: []f32, capacity_frames: u32) !u32 {
        if (self.audio_engine != null) return error.InvalidArgument;
        return self.decodeAudio(samples, capacity_frames);
    }

    fn queuedAudioFrames(stats: audio.StreamStats) u32 {
        const received = stats.bytes_received / (2 * @sizeOf(f32));
        return @intCast(@min(received -| stats.frames_played, std.math.maxInt(u32)));
    }

    fn audioStatus(self: *Video) AudioStatus {
        self.audio_lock.lockUncancelable(io);
        defer self.audio_lock.unlock(io);
        return self.audio_status;
    }

    pub fn audioStats(self: *Video) ?audio.StreamStats {
        if (self.audio_engine == null) return null;
        return self.audioStatus().stats;
    }

    pub fn audioTimeUs(self: *const Video, status: AudioStatus) i64 {
        return self.audio_base_us +| @as(i64, @intCast(status.stats.frames_played * 1_000_000 / audio_sample_rate));
    }

    /// Media time from the audio clock when it leads, else from fallback_time_us.
    fn clockTime(self: *Video, fallback_time_us: i64) i64 {
        const status = self.audioStatus();
        return if (self.audioClockActive(status)) self.audioTimeUs(status) else fallback_time_us;
    }

    // The audio clock leads while playback wants it and the stream has not drained.
    fn audioClockActive(self: *const Video, status: AudioStatus) bool {
        if (self.audio_engine == null or !self.wants_playback or status.failed) return false;
        return status.stats.state != audio.StreamState.ended;
    }

    pub fn play(self: *Video) void {
        self.wants_playback = true;
        self.state.ended = 0;
        self.updateControl(.{ .playing = true });
        if (self.audio_engine != null and self.audio_thread == null) {
            self.audio_thread = std.Thread.spawn(.{}, audioMain, .{self}) catch blk: {
                self.failAudio("audio thread failed to start");
                break :blk null;
            };
        }
    }

    // A suspended mixer stops reading the stream, so the audio clock holds its position.
    pub fn pause(self: *Video) void {
        self.wants_playback = false;
        self.updateControl(.{ .playing = false });
    }

    pub fn setMuted(self: *Video, muted: bool) !void {
        self.muted = muted;
        self.updateControl(.{ .gain = if (self.muted) 0 else self.volume });
    }

    pub fn setVolume(self: *Video, volume: f32) !void {
        if (!std.math.isFinite(volume) or volume < 0) return error.InvalidArgument;
        self.volume = volume;
        self.updateControl(.{ .gain = if (self.muted) 0 else self.volume });
    }

    pub fn setAvSyncOffset(self: *Video, offset_us: i64) !void {
        if (offset_us < -max_av_sync_offset_us or offset_us > max_av_sync_offset_us) return error.InvalidArgument;
        self.av_sync_offset_us = offset_us;
        self.quiesceWorker();
        self.clearPrepared();
        self.resync_pending = true;
    }

    /// Tests mix the engine manually instead of opening a device.
    pub fn setAudioOffline(self: *Video, offline: bool) void {
        self.audio_offline = offline;
    }

    /// Mixes the engine as an output device would; for offline tests.
    pub fn mixOffline(self: *Video, output: []f32, frames: u32) i32 {
        const engine = self.audio_engine orelse return audio.Status.err_invalid;
        self.engine_lock.lockUncancelable(io);
        defer self.engine_lock.unlock(io);
        const status = audio.mixToBuffer(engine, output.ptr, frames, 2);
        _ = self.publishAudioStatus(self.stream_generation);
        return status;
    }

    /// Waits until the audio thread applied every control change; for tests.
    pub fn syncAudio(self: *Video) void {
        if (self.audio_thread == null) return;
        while (true) {
            self.audio_lock.lockUncancelable(io);
            const done = self.audio_status.applied_version == self.audio_control.version;
            self.audio_lock.unlock(io);
            if (done) return;
            std.Io.sleep(io, .fromMilliseconds(1), .awake) catch {};
        }
    }

    /// Stops audio and leaves the wall clock in charge; playback continues silently.
    pub fn failAudio(self: *Video, message: []const u8) void {
        self.audio_lock.lockUncancelable(io);
        defer self.audio_lock.unlock(io);
        if (self.audio_status.failed) return;
        self.audio_status.failed = true;
        self.audio_error_len = copyMessage(&self.audio_error_buf, message);
    }

    fn updateControl(self: *Video, change: anytype) void {
        self.audio_lock.lockUncancelable(io);
        inline for (std.meta.fields(@TypeOf(change))) |field| @field(self.audio_control, field.name) = @field(change, field.name);
        self.audio_control.version +%= 1;
        self.audio_lock.unlock(io);
        self.wakeAudio();
    }

    fn wakeAudio(self: *Video) void {
        _ = self.audio_wake.fetchAdd(1, .release);
        io.futexWake(u32, &self.audio_wake.raw, 1);
    }

    fn audioMain(self: *Video) void {
        while (true) {
            const seen = self.audio_wake.load(.acquire);
            self.audio_lock.lockUncancelable(io);
            const quit = self.audio_control.quit;
            self.audio_lock.unlock(io);
            if (quit) return;
            const busy = self.serviceAudio();
            const timeout: std.Io.Timeout = if (busy)
                .{ .duration = .{ .raw = .fromMicroseconds(audio_service_us), .clock = .awake } }
            else
                .none;
            io.futexWaitTimeout(u32, &self.audio_wake.raw, seen, timeout) catch {};
        }
    }

    // One audio thread pass: starts the device when first wanted, applies
    // control changes, keeps the queue filled, and publishes the clock.
    // Returns whether playback needs another pass soon.
    fn serviceAudio(self: *Video) bool {
        const engine = self.audio_engine.?;
        var control = self.readControl();
        if (control.playing and !self.audio_offline and self.device == .idle) {
            // Startup can block; it holds only the engine lock, so seeks and state reads proceed.
            self.engine_lock.lockUncancelable(io);
            const started = audio.start(engine, null) == audio.Status.ok;
            self.device = if (started) .started else .failed;
            // Starting the device starts the mixer; the pass below applies a pause meanwhile.
            self.mixer_running = started;
            self.engine_lock.unlock(io);
            if (!started) self.failAudio("audio device failed to start");
        }
        self.audio_decode_lock.lockUncancelable(io);
        defer self.audio_decode_lock.unlock(io);
        self.engine_lock.lockUncancelable(io);
        defer self.engine_lock.unlock(io);
        control = self.readControl();
        if (control.generation != self.stream_generation) self.replaceAudioStream(control.generation);
        const failed = self.audioStatus().failed;
        const wanted = control.playing and !failed and (self.audio_offline or self.device == .started);
        if (wanted != self.mixer_running) {
            if (wanted) _ = audio.startMixer(engine) else audio.suspendMixer(engine);
            self.mixer_running = wanted;
        }
        if (control.gain != self.applied_gain and audio.setMasterVolume(engine, control.gain) == audio.Status.ok) {
            self.applied_gain = control.gain;
        }
        if (wanted) self.refillAudio() catch {
            const detail = std.mem.span(otv_stream_error(self.decoder, 1));
            self.failAudio(if (detail.len > 0) detail else "audio stream failed");
        };
        const stream_state = self.publishAudioStatus(control.generation);
        self.audio_lock.lockUncancelable(io);
        self.audio_status.applied_version = control.version;
        self.audio_lock.unlock(io);
        // An ended input still drains its queue, and the clock follows it until the stream ends.
        return wanted and stream_state != audio.StreamState.ended;
    }

    fn readControl(self: *Video) AudioControl {
        self.audio_lock.lockUncancelable(io);
        defer self.audio_lock.unlock(io);
        return self.audio_control;
    }

    // Requires engine_lock.
    fn openAudioStream(self: *Video) !void {
        const options: audio.StreamOptions = .{
            .capacity_ms = audio_capacity_ms,
            .startup_ms = audio_startup_ms,
            .resume_ms = audio_startup_ms,
            .volume = 1,
            .pan = 0,
            .group_id = 0,
            .format = audio.StreamFormat.pcm,
            .sample_rate = audio_sample_rate,
            .channels = 2,
        };
        var stream_id: u32 = 0;
        if (audio.createStream(self.audio_engine.?, &options, &stream_id) != audio.Status.ok) return error.OutOfMemory;
        self.audio_stream = stream_id;
    }

    // Requires engine_lock and audio_decode_lock.
    fn replaceAudioStream(self: *Video, generation: u32) void {
        if (self.audio_stream != 0) {
            var stats: audio.StreamStats = undefined;
            _ = audio.closeStream(self.audio_engine.?, self.audio_stream, audio.StreamCloseReason.disposed, &stats);
            self.audio_stream = 0;
        }
        self.stream_generation = generation;
        self.audio_ended = false;
        self.audio_produced_frames = 0;
        self.openAudioStream() catch self.failAudio("audio stream allocation failed");
    }

    // Publishes the stream's stats unless a seek replaced it meanwhile, and
    // returns the stream state. Requires engine_lock.
    fn publishAudioStatus(self: *Video, generation: u32) u32 {
        var stats = std.mem.zeroes(audio.StreamStats);
        const known = self.audio_stream != 0 and audio.getStreamStats(self.audio_engine.?, self.audio_stream, &stats) == audio.Status.ok;
        if (known and stats.state == audio.StreamState.failed) self.failAudio("audio stream failed");
        self.audio_lock.lockUncancelable(io);
        defer self.audio_lock.unlock(io);
        if (generation != self.audio_control.generation) return stats.state;
        const drained = known and stats.state == audio.StreamState.ended;
        if (drained and self.audio_status.stats.state != audio.StreamState.ended) self.audio_status.ended_us = nowUs();
        if (known) self.audio_status.stats = stats;
        self.audio_status.produced_frames = self.audio_produced_frames;
        self.audio_status.ended = self.audio_ended;
        self.audio_status.mixer_running = self.mixer_running;
        return stats.state;
    }

    // Decodes and queues PCM up to the queue capacity. Requires engine_lock and audio_decode_lock.
    fn refillAudio(self: *Video) !void {
        const engine = self.audio_engine.?;
        const buffer = self.audio_buffer.?;
        while (!self.audio_ended and self.audio_stream != 0) {
            var stats: audio.StreamStats = undefined;
            if (audio.getStreamStats(engine, self.audio_stream, &stats) != audio.Status.ok) return error.DecodeFailed;
            const requested = @min(audio_capacity_frames -| queuedAudioFrames(stats), audio_decode_frames);
            if (requested == 0) return;
            const decoded = try self.decodeAudio(buffer, requested);
            if (decoded == 0) {
                if (audio.endStream(engine, self.audio_stream) != audio.Status.ok) return error.DecodeFailed;
                self.audio_ended = true;
                return;
            }
            // Each stream fades in over its first 5 ms, so a start mid-wave does not click.
            if (self.audio_produced_frames == 0) for (0..@min(decoded, 240)) |frame| {
                for (buffer[2 * frame ..][0..2]) |*sample| sample.* *= @as(f32, @floatFromInt(frame)) / 240;
            };
            const bytes = std.mem.sliceAsBytes(buffer[0 .. @as(usize, decoded) * 2]);
            // The queue bound keeps writes within the stream's input capacity.
            const written = audio.writeStream(engine, self.audio_stream, bytes.ptr, @intCast(bytes.len));
            if (written != @as(i32, @intCast(bytes.len))) return error.DecodeFailed;
            self.audio_produced_frames += decoded;
        }
    }

    /// Video frames decoded so far, including frames skipped on the way to a target.
    pub fn decodedFrames(self: *const Video) u64 {
        return otv_decoded_frames(self.decoder);
    }

    /// The last failure, or a non-fatal audio failure; empty when there is none.
    pub fn lastError(self: *Video) []const u8 {
        if (self.last_error_len > 0) return self.last_error_buf[0..self.last_error_len];
        self.audio_lock.lockUncancelable(io);
        defer self.audio_lock.unlock(io);
        // The audio thread sets the detail once, before publishing the failure.
        return if (self.audio_status.failed) self.audio_error_buf[0..self.audio_error_len] else "";
    }
};

pub const PlayerState = struct {
    current_time_us: i64,
    frame_pts_us: i64,
    playing: bool,
    ended: bool,
    buffering: bool,
    audio: bool,
    has_frame: bool,
    failed: bool,
    quality_tier: u32,
};

/// Playback of one video scene node: a media clock, looping, and output geometry.
/// State reads and paints advance the clock; paints also return the image to draw.
pub const Player = struct {
    allocator: Allocator,
    video: *Video,
    playing: bool = false,
    loop: bool = false,
    ended: bool = false,
    failed: bool = false,
    // Media position when the wall clock last started or stopped.
    position_us: i64 = 0,
    clock_start_us: i64 = 0,
    // Whether the audio clock led at the last tick.
    audio_clock: bool = false,
    needs_update: bool = true,
    // Set once a paint configured the output, so paused seeks can decode their frame.
    presented: bool = false,
    max_fps: u32 = 30,
    quality: Quality = .{},
    // Renderer frame count when a new frame was painted; the next completed
    // renderer frame carries that frame's cost.
    cost_frame: ?u64 = null,

    /// Without audio no engine is created, so playback opens no audio device and follows the wall clock.
    pub fn open(allocator: Allocator, path: []const u8, audio_enabled: bool, error_out: []u8) !*Player {
        const value = try Video.open(allocator, path, !audio_enabled, error_out);
        errdefer value.deinit();
        const player = try allocator.create(Player);
        player.* = .{ .allocator = allocator, .video = value };
        return player;
    }

    pub fn deinit(self: *Player) void {
        self.video.deinit();
        self.allocator.destroy(self);
    }

    fn duration(self: *const Player) i64 {
        return self.video.info.duration_us;
    }

    fn intervalUs(self: *const Player) u32 {
        const info = self.video.info;
        const source_fps: f64 = if (info.fps_num > 0 and info.fps_den > 0) @as(f64, @floatFromInt(info.fps_num)) / @as(f64, @floatFromInt(info.fps_den)) else 0;
        const fps = if (source_fps > 0) @min(source_fps, @as(f64, @floatFromInt(self.max_fps))) else @as(f64, @floatFromInt(self.max_fps));
        return @intFromFloat(@max(1, @round(1_000_000 / fps)));
    }

    fn normalize(self: *const Player, time_us: i64) i64 {
        const value = @max(0, time_us);
        const total = self.duration();
        if (total <= 0) return value;
        return if (self.loop) @mod(value, total) else @min(value, total);
    }

    fn wallTime(self: *const Player) i64 {
        return self.position_us +| (nowUs() - self.clock_start_us);
    }

    pub fn currentTime(self: *Player) i64 {
        if (!self.playing) return self.position_us;
        const state = self.video.getState();
        if (state.audio_active != 0 or state.buffering != 0) return state.current_time_us;
        return self.normalize(self.wallTime());
    }

    /// Advances the media clock to now and ends or loops playback at the end; a loop
    /// restarts at the time that ran past the end. It never decodes, so state reads
    /// keep playback moving while the node is not painted.
    fn tick(self: *Player) void {
        if (!self.playing) return;
        const state = self.video.getState();
        const audio_clock = state.audio_active != 0 or state.buffering != 0;
        if (self.audio_clock and !audio_clock) {
            // Audio drained or failed: the wall clock continues from the audio position, and
            // from the drain, so a loop also carries the time since the audio ended.
            const status = self.video.audioStatus();
            self.position_us = self.video.audioTimeUs(status);
            self.clock_start_us = if (status.stats.state == audio.StreamState.ended) status.ended_us else nowUs();
        }
        self.audio_clock = audio_clock;
        const media = if (audio_clock) state.current_time_us else self.wallTime();
        const total = self.duration();
        if (total <= 0 or media < total) return;
        if (self.loop) self.seek(@mod(media, total)) catch {} else self.finish();
    }

    pub fn snapshot(self: *Player) PlayerState {
        self.tick();
        const time = self.currentTime();
        const state = self.video.getState();
        return .{
            .current_time_us = time,
            .frame_pts_us = state.frame_pts_us,
            .playing = self.playing,
            .ended = self.ended,
            .buffering = self.playing and state.buffering != 0,
            .audio = self.playing and state.audio_active != 0,
            .has_frame = self.video.current_image != null,
            .failed = self.failed,
            .quality_tier = self.quality.tier,
        };
    }

    /// Starts playback; after a failure, it retries from the current position.
    pub fn play(self: *Player) !void {
        if (self.failed) try self.seek(self.position_us);
        if (self.playing) return;
        if (self.ended and !self.loop) try self.seek(0);
        self.playing = true;
        self.ended = false;
        self.clock_start_us = nowUs();
        self.video.play();
        self.audio_clock = self.video.audioClockActive(self.video.audioStatus());
    }

    pub fn pause(self: *Player) !void {
        if (!self.playing) return;
        self.tick();
        if (!self.playing) return;
        self.position_us = self.currentTime();
        self.playing = false;
        self.video.pause();
    }

    /// Clamps to [0, duration]; seeking past the end never wraps, even when looping.
    /// A paused seek decodes its frame now, so failures surface from the call.
    /// Only play and seek report a failure; other controls still apply.
    pub fn seek(self: *Player, time_us: i64) !void {
        const total = self.duration();
        const target = if (total > 0) std.math.clamp(time_us, 0, total) else @max(0, time_us);
        self.failed = false;
        self.video.seek(target) catch {
            self.fail();
            return error.VideoFailed;
        };
        self.position_us = target;
        self.clock_start_us = nowUs();
        self.audio_clock = self.playing and self.video.audioClockActive(self.video.audioStatus());
        self.ended = false;
        self.needs_update = true;
        if (self.playing or !self.presented) return;
        _ = self.video.update(target) catch {
            self.fail();
            return error.VideoFailed;
        };
        self.needs_update = false;
    }

    /// Feeds the adaptive quality with the cost of the renderer frame that sent the
    /// last new video frame, once that frame completed. Slow decoding counts too.
    pub fn observeFrameCost(self: *Player, completed_frames: u64, cost_us: u32) void {
        const painted = self.cost_frame orelse return;
        if (completed_frames == painted) return;
        self.cost_frame = null;
        if (!self.playing) return;
        self.quality.sample(@max(cost_us, self.video.state.prepare_time_us), self.intervalUs());
    }

    pub fn setLoop(self: *Player, loop: bool) !void {
        self.loop = loop;
    }

    pub fn setMuted(self: *Player, muted: bool) !void {
        try self.video.setMuted(muted);
    }

    pub fn setVolume(self: *Player, volume: f32) !void {
        try self.video.setVolume(volume);
    }

    pub fn setAvSyncOffset(self: *Player, offset_us: i64) !void {
        try self.video.setAvSyncOffset(offset_us);
    }

    pub fn setMaxFps(self: *Player, fps: u32) !void {
        if (fps < 1 or fps > 120) return error.InvalidArgument;
        self.max_fps = fps;
    }

    fn finish(self: *Player) void {
        self.position_us = self.duration();
        self.playing = false;
        self.ended = true;
        self.video.pause();
    }

    pub fn fail(self: *Player) void {
        self.position_us = self.currentTime();
        self.failed = true;
        self.playing = false;
        self.video.pause();
    }

    /// Advances playback to now and returns the current frame for a decode target of
    /// width x height pixels from the crop of the source. Decode failures stop playback
    /// and keep the last frame.
    pub fn frame(self: *Player, width: u32, height: u32, cover: bool, crop: ?image.Region) ?*image.Image {
        if (self.failed) return self.video.current_image;
        self.tick();
        self.present(width, height, cover, crop) catch self.fail();
        return self.video.current_image;
    }

    fn present(self: *Player, width: u32, height: u32, cover: bool, crop: ?image.Region) !void {
        if (try self.video.configureOutput(width, height, cover, crop)) self.needs_update = true;
        self.presented = true;
        if (self.needs_update or self.video.current_image == null) {
            _ = try self.video.update(self.currentTime());
            self.needs_update = false;
        }
        if (!self.playing) return;
        const interval = self.intervalUs();
        try self.video.schedule(self.currentTime(), interval);
        if (self.video.state.prepared_pts_us < 0) _ = try self.video.prepareNext(interval);
    }

    pub fn lastError(self: *const Player) []const u8 {
        return self.video.lastError();
    }
};
