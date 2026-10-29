//! Output simulation environments: a link, faults, writers outside OpenTUI, and an event mix.
//! A run's seed jitters its preset (see `jitter`), so one preset covers many interleavings.
const std = @import("std");

const ms = std.time.ns_per_ms;

pub const Window = struct { start_ns: u64, end_ns: u64 };

pub const FaultKind = enum {
    /// The shared description is non-blocking for `duration_ns`, as when a child sets O_NONBLOCK.
    eagain,
    /// Hangup (EIO) or a closed reader (EPIPE): the write that crosses the offset accepts the
    /// bytes before it, later ones fail. A partial count (EINTR) is `partial_max`'s path.
    eio,
    epipe,
};

pub const Fault = struct {
    at: union(enum) { ns: u64, byte_offset: u64 },
    kind: FaultKind,
    duration_ns: u64 = 0,
};

pub const Atomicity = union(enum) {
    /// Linux: a blocking tty write holds the write lock, so no other writer enters it.
    whole,
    /// The XNU model under test: another writer can enter every n bytes above the high-water mark.
    chunked: u32,
};

pub const External = struct { period_ns: u64, size: u32, atomicity: Atomicity };

pub const End = enum { close, exit, crash };

pub const Mix = struct {
    key_period_ns: u64 = 250 * ms,
    resizes: u32 = 1,
    suspends: u32 = 1,
    end: End = .close,
    /// Each input sequence arrives split at a seeded byte, with up to this gap between pieces.
    /// Below the parser's 20 ms timeout, so every split must decode as the whole sequence.
    split_gap_ns: ?u64 = null,
    /// Seeded producers besides frames: title, mouse, OSC 52, notifications, raw writes.
    producers: bool = true,
    /// Producers at their limits: a title and a 1 MiB OSC 52 every 50 ms.
    flood: bool = false,
    /// Settle before the end: no new events until the screen and the link are quiet (I6, I9).
    /// Off for exits while the link is congested.
    settle: bool = true,
};

pub const OutputMode = enum {
    /// Today's fd 1 path: `drainOutput` on the owner with a blocking or non-blocking sink.
    sync_drain,
    /// Today's Writable path: `readOutput`, an asynchronous host write, `completeOutput`.
    ticket,
};

pub const Env = struct {
    /// The slow-link harness's screen. `scaled` shrinks it for CI.
    cols: u16 = 100,
    rows: u16 = 32,
    /// Null: unlimited.
    rate_bps: ?u64,
    latency_ns: u64 = 0,
    pty_capacity: u32 = 18_944,
    socket_capacity: u32 = 65_536,
    /// The most bytes one write accepts.
    partial_max: ?u32 = null,
    stalls: []const Window = &.{},
    faults: []const Fault = &.{},
    external: ?External = null,
    events: Mix = .{},
    output_mode: OutputMode = .sync_drain,
    /// The Session's output chunk size. The driver's default is 64 KiB; half the seeds use
    /// 4 KiB, which splits frames into several tickets.
    chunk_size: u32 = 65_536,
};

pub const Preset = struct {
    name: []const u8,
    env: Env,
    /// CI runs this many seeds of a sweep preset.
    ci_seeds: u8 = 4,
};

const ssh_link: Env = .{ .rate_bps = 48_000, .latency_ns = 20 * ms, .external = .{ .period_ns = 200 * ms, .size = 24, .atomicity = .whole } };

fn with(base: Env, comptime changes: anytype) Env {
    var env = base;
    inline for (std.meta.fields(@TypeOf(changes))) |field| @field(env, field.name) = @field(changes, field.name);
    return env;
}

const no_settle: Mix = .{ .settle = false };

/// The CI presets.
pub const named = [_]Preset{
    .{ .name = "local_fast", .env = .{ .rate_bps = null } },
    .{ .name = "ssh_slow", .env = ssh_link },
    // EIO or EPIPE inside a multi-ticket frame, once the link is congested.
    .{ .name = "hangup_mid_frame", .env = with(ssh_link, .{ .chunk_size = 4096, .faults = &[_]Fault{.{ .at = .{ .byte_offset = 130_000 }, .kind = .eio }} }) },
};

const split_input: Preset = .{ .name = "split_input", .env = with(ssh_link, .{ .events = Mix{ .key_period_ns = 100 * ms, .split_gap_ns = 19 * ms } }) };
// A cancel while output is queued or a Writable write runs.
const crash_mid: Preset = .{ .name = "crash_mid", .env = with(ssh_link, .{ .events = Mix{ .end = .crash, .settle = false } }), .ci_seeds = 2 };

/// Kept for sweeps; the CI test runs fewer seeds of each.
pub const sweep = [_]Preset{
    .{ .name = "ssh_16k", .env = with(ssh_link, .{ .rate_bps = 16_000 }) },
    .{ .name = "nonblock_flip", .env = with(ssh_link, .{ .faults = &[_]Fault{
        .{ .at = .{ .ns = 1500 * ms }, .kind = .eagain, .duration_ns = 800 * ms },
        .{ .at = .{ .ns = 3500 * ms }, .kind = .eagain, .duration_ns = 800 * ms },
    } }) },
    .{ .name = "macos_chunked", .env = with(ssh_link, .{ .external = External{ .period_ns = 50 * ms, .size = 24, .atomicity = .{ .chunked = 100 } } }) },
    .{ .name = "exit_blocked", .env = with(ssh_link, .{ .events = Mix{ .end = .exit, .settle = false } }), .ci_seeds = 2 },
    // fd 1 turns non-blocking, then the link stalls over the exit: the pty is full at exit.
    .{ .name = "exit_nonblocking", .env = with(ssh_link, .{
        .events = Mix{ .end = .exit, .settle = false },
        .faults = &[_]Fault{.{ .at = .{ .ns = 2000 * ms }, .kind = .eagain, .duration_ns = 3600 * std.time.ns_per_s }},
        .stalls = &[_]Window{.{ .start_ns = 3000 * ms, .end_ns = 6000 * ms }},
    }), .ci_seeds = 2 },
    crash_mid,
    // A graceful close while output is queued.
    .{ .name = "close_mid", .env = with(ssh_link, .{ .events = no_settle }), .ci_seeds = 2 },
    split_input,
    .{ .name = "producer_flood", .env = with(ssh_link, .{ .rate_bps = 16_000, .events = Mix{ .flood = true, .end = .crash, .settle = false } }), .ci_seeds = 2 },
    .{ .name = "partial_writes", .env = .{ .rate_bps = null, .partial_max = 512, .events = .{ .end = .exit } }, .ci_seeds = 2 },
};

/// The `ticket` (Writable) plan: the named presets, split input, and a cancel mid-write.
pub const ticket = named ++ [_]Preset{ split_input, crash_mid };

/// The same environment on a smaller screen, with every byte rate and capacity scaled by the
/// cell ratio, so the link stays as congested as at full size: CI runs 60x16 for time.
pub fn scaled(env: Env, cols: u16, rows: u16, faults: []Fault) Env {
    var result = env;
    const cells: u64 = @as(u64, cols) * rows;
    const full: u64 = @as(u64, env.cols) * env.rows;
    result.cols = cols;
    result.rows = rows;
    if (env.rate_bps) |rate| result.rate_bps = rate * cells / full;
    result.pty_capacity = @intCast(env.pty_capacity * cells / full);
    result.socket_capacity = @intCast(env.socket_capacity * cells / full);
    for (env.faults, faults[0..env.faults.len]) |fault, *moved| {
        moved.* = fault;
        if (fault.at == .byte_offset) moved.at = .{ .byte_offset = fault.at.byte_offset * cells / full };
    }
    result.faults = faults[0..env.faults.len];
    return result;
}

pub fn find(name: []const u8) ?Env {
    // `ticket` holds no preset of its own.
    for (named ++ sweep) |preset| if (std.mem.eql(u8, preset.name, name)) return preset.env;
    return null;
}

/// The preset as one seed runs it: rate within ±25 %, faults and windows moved within their
/// range, the end kind and a few toggles drawn. `faults` receives the moved copies.
pub fn jitter(env: Env, random: std.Random, faults: []Fault) Env {
    var result = env;
    if (env.rate_bps) |rate| result.rate_bps = rate * random.intRangeAtMost(u64, 75, 125) / 100;
    for (env.faults, faults[0..env.faults.len]) |fault, *moved| {
        moved.* = fault;
        switch (fault.at) {
            .ns => |at| moved.at = .{ .ns = at * random.intRangeAtMost(u64, 50, 150) / 100 },
            .byte_offset => |at| moved.at = .{ .byte_offset = at * random.intRangeAtMost(u64, 75, 125) / 100 },
        }
        if (fault.kind == .eio and random.boolean()) moved.kind = .epipe;
    }
    result.faults = faults[0..env.faults.len];
    if (random.boolean()) result.chunk_size = 4096;
    return result;
}
