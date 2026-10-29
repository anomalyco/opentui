//! Deterministic output simulation. A real Context, Session, renderer and scene stream a
//! scene like the slow-link harness's app, on virtual time, into a model of the far side of
//! fd 1 (output-sim/link.zig): a pty with a write lock, outside writers, an ssh-like socket and
//! link, and a Ghostty VT as the far terminal. The owner actor mirrors the JS driver: one pump
//! and one write per turn, a 1 ms retry after a 0-byte drain, one frame in flight, input,
//! replies, resizes, suspend, and the end of the run (close, exit, crash).
//!
//! Output modes are today's two paths: `sync_drain` (fd 1: `drainOutput` with `SimSink` on the
//! owner, which blocks the owner while the pty is full) and `ticket` (a Writable: `readOutput`,
//! an asynchronous host write, `completeOutput`). Every run checks the invariants listed at
//! `Stats`; the 388 stall (I1) is recorded, not asserted.
//!
//! Replay one run: OUTPUT_SIM_SEED=<n> OUTPUT_SIM_PRESET=<name> [OUTPUT_SIM_MODE=ticket]
//! [OUTPUT_SIM_TRACE=1] bun run test:native -Dtest-filter="OUTPUT SIM".
const std = @import("std");
const testing = std.testing;
const c = @import("context_abi_c");
const context = @import("../context.zig");
const session = @import("../session.zig");
const input_parser = @import("../input-parser.zig");
const ansi = @import("../ansi.zig");
const fixture = @import("scene_fixture_test.zig");
const vt_decode = @import("vt-decode.zig");
const presets = @import("output-sim/presets.zig");
const link_model = @import("output-sim/link.zig");

const ms = std.time.ns_per_ms;
/// The model's own storage; the Context's goes through `Counting`, with leak checks.
const gpa = std.heap.smp_allocator;
const frame_interval_ns: u64 = std.time.ns_per_s / 60;
/// The driver's drain budget and Writable copy size (`zig.ts`, `NativeSession.ts`).
const drain_budget: u32 = 65_536;
/// The driver's graceful close timeout (`closeTimeoutMs`).
const close_timeout_ns: u64 = 1000 * ms;
const background = ansi.rgbColor(30, 30, 46, 255);
/// The far terminal's reply to the startup queries: focus, bracketed paste, a cursor report,
/// Kitty keyboard, and DA1. (DECRQM 2026 belongs to the synchronized-output model.)
const replies = "\x1b[?1004;1$y\x1b[?2004;2$y\x1b[1;1R\x1b[?0u\x1b[?62;22c";
const history_lines = 30;
const lines_max = 40;
const words_per_line = 6;

/// Counts per run, summed over runs. Invariant counters name their invariant.
const Stats = struct {
    runs: u32 = 0,
    virtual_ns: u64 = 0,
    mutations: u64 = 0,
    commits: u64 = 0,
    presented: u64 = 0,
    frame_bytes: u64 = 0,
    frame_bytes_max: u64 = 0,
    /// Frames whose bytes took more than one owner write or ticket (I3).
    multi_ticket_frames: u64 = 0,
    owner_writes: u64 = 0,
    /// I1, recorded: owner time inside sink writes, and keys that waited for it.
    blocked_ns: u64 = 0,
    keys_sent: u64 = 0,
    keys_seen: u64 = 0,
    keys_delayed: u64 = 0,
    key_wait_max_ns: u64 = 0,
    /// I2: a paint accepted while a frame was in flight, or a count out of step.
    second_frames: u32 = 0,
    /// I4: queued feed bytes above the limit, and the Context's peak live bytes.
    feed_overflows: u32 = 0,
    live_peak_bytes: u64 = 0,
    /// I5: outside bytes inside a Session escape sequence or scalar.
    cut_tokens: u32 = 0,
    /// I5 strict: cuts after an owner write that stopped inside its span. Blocking writes of
    /// whole spans never do; only partial and non-blocking writes may.
    cuts_mid_span: u32 = 0,
    externals: u64 = 0,
    /// Owner writes that ended inside a token, where an outside write could enter.
    mid_token_ends: u64 = 0,
    /// I6: decoded screens that differ from the frame they end, or from the presented frame
    /// at quiescence.
    frame_mismatches: u32 = 0,
    quiescent_mismatches: u32 = 0,
    decoded_frames: u64 = 0,
    /// Frames not compared because a cut escape garbled the decoder earlier (I5's effect).
    garbled_frames: u64 = 0,
    /// I7: restore bytes not in the pty when suspend or exit returns, or terminal modes left on.
    restore_missing: u32 = 0,
    modes_left: u32 = 0,
    suspends: u32 = 0,
    exits: u32 = 0,
    closes: u32 = 0,
    crashes: u32 = 0,
    /// I8: Session bytes that entered the pty after close or cancel.
    stale_bytes: u32 = 0,
    /// I9: settles that took longer than the queued bytes need.
    slow_drains: u32 = 0,
    /// I10: a failure without a hangup, a hangup that did not fail at once, or a replay.
    bad_failures: u32 = 0,
    hangups: u32 = 0,
    discontinuities: u32 = 0,
    /// I13: reply bytes seen as keys, replies lost, or capabilities that differ from the replies.
    reply_errors: u32 = 0,
    /// I14: decoded input that differs from the unsplit stream.
    input_mismatches: u32 = 0,
    /// Producers at their limits: accepted, refused with false, refused with an error.
    produced: u32 = 0,
    produce_refused: u32 = 0,
    produce_errors: u32 = 0,
    trace: u64 = 0,
};

/// Invariant counters that must stay zero, unless a known `main` defect is allowed.
const invariant_fields = [_][]const u8{ "second_frames", "feed_overflows", "cut_tokens", "cuts_mid_span", "frame_mismatches", "quiescent_mismatches", "restore_missing", "modes_left", "stale_bytes", "slow_drains", "bad_failures", "discontinuities", "reply_errors", "input_mismatches" };

const Counting = struct {
    parent: std.mem.Allocator,
    live: usize = 0,
    peak: usize = 0,

    fn allocator(self: *Counting) std.mem.Allocator {
        return .{ .ptr = self, .vtable = &.{ .alloc = alloc, .resize = resize, .remap = remap, .free = free } };
    }

    fn note(self: *Counting, old: usize, new: usize) void {
        self.live = self.live - old + new;
        self.peak = @max(self.peak, self.live);
    }

    fn alloc(ptr: *anyopaque, len: usize, alignment: std.mem.Alignment, ret: usize) ?[*]u8 {
        const self: *Counting = @ptrCast(@alignCast(ptr));
        const result = self.parent.rawAlloc(len, alignment, ret) orelse return null;
        self.note(0, len);
        return result;
    }

    fn resize(ptr: *anyopaque, memory: []u8, alignment: std.mem.Alignment, len: usize, ret: usize) bool {
        const self: *Counting = @ptrCast(@alignCast(ptr));
        if (!self.parent.rawResize(memory, alignment, len, ret)) return false;
        self.note(memory.len, len);
        return true;
    }

    fn remap(ptr: *anyopaque, memory: []u8, alignment: std.mem.Alignment, len: usize, ret: usize) ?[*]u8 {
        const self: *Counting = @ptrCast(@alignCast(ptr));
        const result = self.parent.rawRemap(memory, alignment, len, ret) orelse return null;
        self.note(memory.len, len);
        return result;
    }

    fn free(ptr: *anyopaque, memory: []u8, alignment: std.mem.Alignment, ret: usize) void {
        const self: *Counting = @ptrCast(@alignCast(ptr));
        self.parent.rawFree(memory, alignment, ret);
        self.note(memory.len, 0);
    }
};

/// Owner events run on the JS thread; world events are the link, outside writers and input.
const Kind = enum {
    turn,
    render,
    token,
    spinner,
    read_input,
    input_deadline,
    resize,
    suspend_start,
    resume_start,
    produce,
    host_done,
    tick,
    external,
    input_arrive,
    key_send,

    fn owner(kind: Kind) bool {
        return @intFromEnum(kind) < @intFromEnum(Kind.tick);
    }
};

const Event = struct { at_ns: u64, order: u64, kind: Kind, arg: u64 = 0 };

fn earlier(_: void, a: Event, b: Event) std.math.Order {
    if (a.at_ns != b.at_ns) return std.math.order(a.at_ns, b.at_ns);
    return std.math.order(a.order, b.order);
}

const Queue = std.PriorityQueue(Event, void, earlier);

/// A session offset where the far terminal checks something once its bytes have arrived.
const Checkpoint = struct {
    offset: u64,
    kind: union(enum) {
        /// The frame's cells, copied at commit; full frames resync the decoder.
        frame: struct { index: u32, full: bool },
        resize: [2]u16,
        /// The startup queries: the terminal replies.
        query,
        /// Suspend or close restored the terminal: its modes must be off.
        restored,
    },
};

const Snapshot = struct { char: []u32, fg: []ansi.RGBA, bg: []ansi.RGBA, attributes: []u32, width: u32, height: u32 };

/// One decoded input event, for I14.
const Decoded = struct { kind: u8, code: u32, modifiers: u8, raw: u64 };

const Phase = enum { running, settling, ending, done };

const VtStream = @typeInfo(@TypeOf(vt_decode.Terminal.vtStream)).@"fn".return_type.?;

const Sim = struct {
    env: presets.Env,
    random: std.Random,
    counting: *Counting,
    f: fixture.Fixture,
    link: link_model.Link,
    far: vt_decode.Terminal,
    /// One stream for the run: a sequence may arrive across several deliveries.
    far_stream: VtStream = undefined,
    owner_queue: Queue = .initContext({}),
    world_queue: Queue = .initContext({}),
    seq: u64 = 0,
    now: u64 = 0,
    stats: Stats = .{},
    print_trace: bool,
    phase: Phase = .running,
    script_left: u32,
    // Scene.
    body: context.Handle = undefined,
    status: context.Handle = undefined,
    words: std.ArrayList(u8) = .empty,
    /// Each word's end in `words` and its color index; a line ends after `words_per_line` words.
    word_ends: std.ArrayList(u32) = .empty,
    word_colors: std.ArrayList(u8) = .empty,
    text: std.ArrayList(u8) = .empty,
    chunks: std.ArrayList(context.StyledTextChunk) = .empty,
    tokens: u32 = 0,
    spinner: u32 = 0,
    // Driver.
    turn_generation: u64 = 0,
    turn_at: ?u64 = null,
    render_generation: u64 = 0,
    render_at: ?u64 = null,
    tick_generation: u64 = 0,
    tick_at: ?u64 = null,
    read_at: ?u64 = null,
    last_frame_ns: ?u64 = null,
    dirty: bool = false,
    force_next: bool = true,
    transition: enum { none, setup, suspending, resuming, closing } = .setup,
    stopped_until: u64 = 0,
    close_deadline: ?u64 = null,
    pending_resize: ?[2]u16 = null,
    /// The frame in flight: its Session byte range, and the writes or tickets that carried it.
    frame: ?struct { start: u64, end: u64, writes: u32 = 0 } = null,
    query_published: bool = false,
    ended: bool = false,
    failed: bool = false,
    /// The pty's Session bytes when the Session closed or was cancelled (I8).
    closed_at: ?u64 = null,
    settle_start: u64 = 0,
    settle_bound_ns: u64 = 0,
    // Ticket mode: the host copy and its write.
    host_buffer: []u8,
    host: ?struct { ticket: session.OutputTicket, done: usize, failed: bool = false } = null,
    // Far terminal.
    checkpoints: std.ArrayList(Checkpoint) = .empty,
    checkpoint_head: usize = 0,
    snapshots: std.ArrayList(?Snapshot) = .empty,
    segment_head: usize = 0,
    fed: u64 = 0,
    fed_session: u64 = 0,
    synced: bool = false,
    // Input.
    input: std.ArrayList(u8) = .empty,
    /// Each piece's end in `input` and its arrival time.
    pieces: std.ArrayList(struct { end: u32, at_ns: u64, blocked_ns: u64 = 0 }) = .empty,
    arrived_input: u32 = 0,
    read_input: u32 = 0,
    decoded: std.ArrayList(Decoded) = .empty,
    reply_seen: std.ArrayList(u8) = .empty,
    replies_sent: bool = false,
    events: [128]input_parser.Event = undefined,
    payload: [2 * input_parser.payload_per_byte_max]u8 = undefined,
    externals: u32 = 0,
    /// The output wait of the oldest unread input byte at the last read (I1).
    read_wait_ns: u64 = 0,
    /// The shared description is non-blocking for the rest of the run.
    nonblocking_forever: bool = false,
    /// An error from world events run inside a blocking sink write, which drainOutput would
    /// otherwise take for a transport failure.
    inner_error: ?anyerror = null,

    fn init(sim: *Sim, env: presets.Env, random: std.Random, counting: *Counting, script_events: u32, print_trace: bool) !void {
        const f = try fixture.Fixture.init(counting.allocator(), env.cols, env.rows, .{
            .output = .{ .chunk_size = env.chunk_size, .chunk_count = 8 * 1024 * 1024 / env.chunk_size, .span_capacity = 128, .control_capacity = 4096 },
            .renderer = .{ .remote_mode = .remote, .forwarded_env = &.{} },
        });
        errdefer f.deinit();
        sim.* = .{
            .env = env,
            .random = random,
            .counting = counting,
            .f = f,
            .link = .{ .allocator = gpa, .env = &sim.env },
            .far = try vt_decode.newTerminal(env.cols, env.rows),
            .print_trace = print_trace,
            .script_left = script_events,
            .host_buffer = try gpa.alloc(u8, drain_budget),
        };
        sim.far_stream = sim.far.vtStream();
        try sim.buildScene();
        try f.owner.sessionInputExpect(f.id, .{ .replies = true, .cursor_position = true });
        try f.owner.setupSessionTerminal(f.id, .{});
        try sim.scheduleTurn(0);
        try sim.post(.token, sim.jittered(20 * ms), 0);
        try sim.post(.spinner, sim.jittered(83 * ms), 0);
        if (env.events.key_period_ns) |period| try sim.post(.key_send, sim.jittered(period), 0);
        // A Writable sink owns its channel (an ssh channel, a socket): no outside writer shares it.
        if (env.external != null and env.output_mode == .sync_drain) try sim.post(.external, sim.jittered(env.external.?.period_ns), 0);
        for (0..env.events.resizes) |_| try sim.post(.resize, 500 * ms + random.uintLessThan(u64, 3000 * ms), 0);
        for (0..env.events.suspends) |_| try sim.post(.suspend_start, 800 * ms + random.uintLessThan(u64, 3000 * ms), 0);
        if (env.events.producers) try sim.post(.produce, sim.jittered(if (env.events.flood) 50 * ms else 300 * ms), 0);
        // A 1 MiB OSC 52 at the start of a flood.
        if (env.events.flood) try sim.post(.produce, 1, 1);
    }

    fn deinit(self: *Sim) void {
        self.far_stream.deinit();
        self.far.deinit(testing.allocator);
        self.link.deinit();
        for (self.snapshots.items) |maybe| if (maybe) |snapshot| freeSnapshot(snapshot);
        inline for (.{ &self.words, &self.word_ends, &self.word_colors, &self.text, &self.chunks, &self.checkpoints, &self.snapshots, &self.input, &self.pieces, &self.decoded, &self.reply_seen }) |list| list.deinit(gpa);
        self.owner_queue.deinit(gpa);
        self.world_queue.deinit(gpa);
        gpa.free(self.host_buffer);
        // A run that stopped early leaves the Session busy; cancel it so the Context can go.
        self.f.owner.cancelSession(self.f.id) catch {};
        self.f.deinit();
    }

    fn sessionValue(self: *Sim) *session.Session {
        return self.f.owner.raw().getSession(self.f.id) catch unreachable;
    }

    fn published(self: *Sim) u64 {
        return self.sessionValue().getStats().bytes_written;
    }

    fn jittered(self: *Sim, period: u64) u64 {
        return self.now + period / 2 + self.random.uintLessThan(u64, period);
    }

    fn post(self: *Sim, kind: Kind, at_ns: u64, arg: u64) !void {
        self.seq += 1;
        const event: Event = .{ .at_ns = at_ns, .order = (@as(u64, self.random.int(u32)) << 32) | self.seq, .kind = kind, .arg = arg };
        try (if (kind.owner()) &self.owner_queue else &self.world_queue).push(gpa, event);
    }

    fn scheduleTurn(self: *Sim, at_ns: u64) !void {
        if (self.turn_at) |at| if (at <= at_ns) return;
        self.turn_generation += 1;
        self.turn_at = at_ns;
        try self.post(.turn, at_ns, self.turn_generation);
    }

    fn requestRender(self: *Sim) !void {
        self.dirty = true;
        if (self.render_at != null) return;
        const at = if (self.last_frame_ns) |last| @max(self.now, last + frame_interval_ns) else self.now;
        self.render_generation += 1;
        self.render_at = at;
        try self.post(.render, at, self.render_generation);
    }

    fn wakeLink(self: *Sim) !void {
        const at = self.link.nextWake(self.now) orelse return;
        if (self.tick_at) |scheduled| if (scheduled <= at) return;
        self.tick_generation += 1;
        self.tick_at = at;
        try self.post(.tick, at, self.tick_generation);
    }

    // Scene: a header, a sticky-bottom scroll node with streamed words, and a status line.

    fn node(self: *Sim, parent: context.Handle, kind: u32, num: u32, index: u32) !context.Handle {
        const created = try self.f.owner.sceneCreateNode(self.f.id, kind, num);
        try self.f.owner.sceneMoveNode(created, parent, index);
        return created;
    }

    fn buildScene(self: *Sim) !void {
        const owner = self.f.owner;
        const header = try self.node(self.f.root, c.OT_SCENE_TEXT, 2, 0);
        try owner.sceneSetText(header, "session: slow link streaming");
        try owner.sceneSetTextOptions(header, .{ .foreground = ansi.rgbColor(137, 180, 250, 255) });
        const scroll = try self.node(self.f.root, c.OT_SCENE_BOX, 3, 1);
        try owner.sceneSetScroll(scroll, .{ .follow = c.OT_SCENE_SCROLL_FOLLOW_BOTTOM });
        try owner.sceneSetStyle(scroll, c.OT_STYLE_FLOAT, c.OT_STYLE_FLOAT_FLEX_GROW, 0, 0, 1, 0);
        try owner.sceneSetStyle(scroll, c.OT_STYLE_FLOAT, c.OT_STYLE_FLOAT_FLEX_SHRINK, 0, 0, 1, 0);
        self.body = try self.node(scroll, c.OT_SCENE_TEXT, 4, 0);
        self.status = try self.node(self.f.root, c.OT_SCENE_TEXT, 5, 2);
        for (0..history_lines * words_per_line) |_| try self.appendWord();
        try self.setBody();
        try self.setStatus();
    }

    fn appendWord(self: *Sim) !void {
        const vocabulary = [_][]const u8{ "the", "stream", "renders", "tokens", "across", "a", "slow", "link", "while", "keys", "wait", "frames" };
        try self.words.appendSlice(gpa, vocabulary[self.random.uintLessThan(usize, vocabulary.len)]);
        try self.word_ends.append(gpa, @intCast(self.words.items.len));
        try self.word_colors.append(gpa, self.random.int(u8));
        // Keep whole lines: drop the oldest line when the history is full.
        if (self.word_ends.items.len > lines_max * words_per_line) {
            const cut = self.word_ends.items[words_per_line - 1];
            self.words.replaceRangeAssumeCapacity(0, cut, &.{});
            self.word_ends.replaceRangeAssumeCapacity(0, words_per_line, &.{});
            self.word_colors.replaceRangeAssumeCapacity(0, words_per_line, &.{});
            for (self.word_ends.items) |*end| end.* -= cut;
        }
    }

    fn setBody(self: *Sim) !void {
        self.text.clearRetainingCapacity();
        self.chunks.clearRetainingCapacity();
        var start: u32 = 0;
        for (self.word_ends.items, self.word_colors.items, 0..) |end, color, index| {
            const before = self.text.items.len;
            try self.text.appendSlice(gpa, self.words.items[start..end]);
            try self.text.append(gpa, if (index % words_per_line == words_per_line - 1) '\n' else ' ');
            start = end;
            try self.chunks.append(gpa, .{
                .byte_count = @intCast(self.text.items.len - before),
                .foreground = ansi.rgbColor(120 + color % 128, 200 - color % 100, 80 + color / 2, 255),
            });
        }
        try self.f.owner.sceneSetStyledText(self.body, self.text.items, self.chunks.items);
    }

    fn setStatus(self: *Sim) !void {
        const frames = [_][]const u8{ "\u{280b}", "\u{2819}", "\u{2839}", "\u{2838}", "\u{283c}", "\u{2834}" };
        var bytes: [64]u8 = undefined;
        const line = std.fmt.bufPrint(&bytes, "{s} tok {d:0>6} key {d:0>6}", .{ frames[self.spinner % frames.len], self.tokens, self.stats.keys_seen }) catch unreachable;
        try self.f.owner.sceneSetText(self.status, line);
    }

    fn mutated(self: *Sim) !void {
        self.stats.mutations += 1;
        try self.requestRender();
    }

    fn scriptStep(self: *Sim) bool {
        if (self.phase != .running) return false;
        if (self.script_left == 0) return false;
        self.script_left -= 1;
        return true;
    }

    // The main loop.

    fn run(self: *Sim) !void {
        var steps: u32 = 0;
        while (self.phase != .done) : (steps += 1) {
            if (steps > 4_000_000) return error.RunTooLong;
            const owner_next = self.owner_queue.peek();
            const world_next = self.world_queue.peek();
            const use_owner = if (owner_next) |o| (if (world_next) |w| earlier({}, o, w) == .lt else true) else false;
            if (!use_owner and world_next == null) {
                // I9: nothing can make progress, yet the run is not over.
                if (self.ended) return self.finish();
                const value = self.sessionValue();
                std.debug.print("OUTPUT SIM deadlock at {d} ns: phase {t}, transition {t}, dirty {}, render {?d}, drained {}, link {}, fed {d}/{d}, input {d}/{d}, lifecycle {t}\n", .{ self.now, self.phase, self.transition, self.dirty, self.render_at, value.isDrained(), self.link.drained(), self.fed, self.link.wire.items.len, self.read_input, self.input.items.len, value.lifecycle.phase });
                return error.Deadlock;
            }
            const event = (if (use_owner) self.owner_queue.pop() else self.world_queue.pop()).?;
            if (use_owner and event.at_ns < self.stopped_until) {
                // SIGTSTP stopped the process: the JS thread runs nothing until SIGCONT.
                try self.post(event.kind, self.stopped_until, event.arg);
                continue;
            }
            self.now = @max(self.now, event.at_ns);
            self.traceEvent(event);
            if (self.print_trace) std.debug.print("{d:>12} {t} {d}\n", .{ self.now, event.kind, event.arg });
            if (use_owner) {
                if (self.ended) continue;
                try self.runOwner(event);
                if (self.inner_error) |err| return err;
                try self.afterOwner();
            } else {
                try self.runWorld(event);
                if (!self.ended) try self.checkSettled();
            }
        }
    }

    /// Folds an event into the run's trace: its time, kind and argument, in order.
    fn traceEvent(self: *Sim, event: Event) void {
        for ([_]u64{ self.now, @intFromEnum(event.kind), event.arg }) |word| {
            self.stats.trace = (self.stats.trace ^ word) *% 0x100000001b3;
        }
    }

    fn runWorld(self: *Sim, event: Event) anyerror!void {
        switch (event.kind) {
            .tick => {
                if (event.arg != self.tick_generation) return;
                self.tick_at = null;
                try self.link.advance(self.now);
                self.collectFinished();
                try self.hostWrite();
                try self.feedTerminal();
            },
            .external => {
                if (self.phase != .running or self.ended) return;
                const external = self.env.external.?;
                if (self.link.hangup == null) {
                    // A harmless OSC with a unique number: it may only land between tokens.
                    const bytes = try gpa.alloc(u8, external.size);
                    @memset(bytes, '0');
                    @memcpy(bytes[0..7], "\x1b]7777;");
                    _ = std.fmt.bufPrint(bytes[7 .. external.size - 1], "{d}", .{self.externals}) catch {};
                    bytes[external.size - 1] = 0x07;
                    try self.link.enqueue(.{ .kind = .external, .bytes = bytes, .limit = bytes.len, .external = self.externals });
                    self.externals += 1;
                    self.stats.externals += 1;
                    self.collectFinished();
                }
                try self.post(.external, self.jittered(external.period_ns), 0);
            },
            .key_send => {
                if (!self.scriptStep()) return;
                self.stats.keys_sent += 1;
                try self.sendInput(if (self.random.uintLessThan(u32, 3) == 0) "\x1b[A" else "x", self.now);
                try self.post(.key_send, self.jittered(self.env.events.key_period_ns.?), 0);
            },
            .input_arrive => {
                self.arrived_input = self.pieces.items[event.arg].end;
                self.pieces.items[event.arg].blocked_ns = self.stats.blocked_ns;
                if (self.read_at == null) {
                    self.read_at = self.now;
                    try self.post(.read_input, self.now, 0);
                }
            },
            else => unreachable,
        }
        try self.wakeLink();
    }

    fn collectFinished(self: *Sim) void {
        var index: usize = 0;
        while (index < self.link.finished.items.len) {
            const writer = self.link.finished.items[index];
            if (writer.kind == .external) {
                gpa.free(writer.bytes);
                _ = self.link.finished.orderedRemove(index);
            } else index += 1;
        }
    }

    fn runOwner(self: *Sim, event: Event) !void {
        switch (event.kind) {
            .turn => {
                if (event.arg != self.turn_generation) return;
                self.turn_at = null;
                try self.turn();
            },
            .render => {
                if (event.arg != self.render_generation) return;
                self.render_at = null;
                try self.render();
            },
            .token => {
                if (!self.scriptStep()) return;
                self.tokens += 1;
                try self.appendWord();
                try self.setBody();
                try self.mutated();
                try self.post(.token, self.jittered(20 * ms), 0);
            },
            .spinner => {
                if (!self.scriptStep()) return;
                self.spinner += 1;
                try self.setStatus();
                try self.mutated();
                try self.post(.spinner, self.jittered(83 * ms), 0);
            },
            .read_input => {
                self.read_at = null;
                try self.readInput();
            },
            .input_deadline => {
                self.read_wait_ns = 0;
                try self.feed("");
            },
            .resize => {
                if (self.phase != .running) return;
                self.pending_resize = .{ self.env.cols - self.random.uintLessThan(u16, 20), self.env.rows - self.random.uintLessThan(u16, 8) };
                try self.applyResize();
            },
            .suspend_start => {
                if (!self.scriptStep()) return;
                if (self.transition != .none or self.failed) return;
                try self.f.owner.suspendSession(self.f.id);
                self.transition = .suspending;
                try self.scheduleTurn(self.now);
            },
            .resume_start => {
                try self.f.owner.resumeSession(self.f.id);
                self.transition = .resuming;
                try self.scheduleTurn(self.now);
            },
            .produce => try self.produce(event.arg),
            .host_done => try self.scheduleTurn(self.now),
            else => unreachable,
        }
    }

    /// Checks after every owner event, and the move to settling and ending.
    fn afterOwner(self: *Sim) !void {
        if (self.ended) return;
        const value = self.sessionValue();
        const stats = value.getStats();
        // I4: queued feed bytes stay within the configured limit.
        if (stats.bytes_written - value.completed_bytes > value.output.options.max_bytes) self.stats.feed_overflows += 1;
        if (self.failed) return self.endAfterOwner();
        if (self.phase == .running and self.script_left == 0 and self.transition == .none and value.lifecycle.phase == .active) {
            self.phase = .settling;
            self.settle_start = self.now;
            const queued = (stats.bytes_written -| self.link.session_end) + (self.link.wire.items.len - self.link.arrived);
            const transfer = if (self.env.rate_bps) |rate| queued * std.time.ns_per_s / (rate * 3 / 4) else 0;
            // Queued bytes over the slowest jittered rate, the latency, a frame and a retry.
            self.settle_bound_ns = transfer + self.env.latency_ns + 2 * frame_interval_ns + 2 * link_model.Link.tick_ns + 2 * ms;
            if (!self.env.events.settle) return self.endRun();
        }
        try self.checkSettled();
    }

    fn checkSettled(self: *Sim) !void {
        if (self.phase == .settling and self.quiescent()) {
            if (self.now - self.settle_start > self.settle_bound_ns) {
                if (self.print_trace) std.debug.print("  settled in {d} ns, bound {d} ns\n", .{ self.now - self.settle_start, self.settle_bound_ns });
                self.stats.slow_drains += 1;
            }
            try self.checkQuiescent();
            try self.endRun();
        }
    }

    fn quiescent(self: *Sim) bool {
        const value = self.sessionValue();
        return !self.dirty and self.render_at == null and value.isDrained() and self.host == null and
            self.link.drained() and self.fed == self.link.wire.items.len and self.read_input == self.input.items.len and
            self.transition == .none and value.lifecycle.phase == .active;
    }

    // The driver: one pump and at most one write per turn, as NativeSession.turn.

    fn turn(self: *Sim) !void {
        const owner = self.f.owner;
        if (self.env.output_mode == .ticket) if (self.host) |host| {
            if (host.done < host.ticket.len) return;
            self.host = null;
            owner.completeOutput(self.f.id, host.ticket, if (host.failed) .failed else .written) catch |err| return self.onError(err);
            try self.afterOutput();
            if (host.failed) return self.onError(error.SessionFailed);
        };
        const expired = if (self.close_deadline) |deadline| self.now >= deadline else false;
        const result = owner.pumpSession(self.f.id, self.now, 1) catch |err| return self.onError(err);
        if (expired and result.status != .closed) {
            // The driver cancels without restoration when graceful close times out.
            owner.cancelSession(self.f.id) catch unreachable;
            self.stats.restore_missing += 1;
            return self.endAfterOwner();
        }
        const value = self.sessionValue();
        if (!self.query_published and value.lifecycle.step != .query and self.transition == .setup) {
            self.query_published = true;
            try self.checkpoint(.query);
        }
        switch (result.status) {
            .idle => try self.transitionDone(),
            .again => try self.scheduleTurn(self.now),
            .output_pending => try self.writeOutput(),
            .wait_until => try self.scheduleTurn(result.deadline_ns.?),
            .closed => try self.onClosed(),
        }
    }

    fn transitionDone(self: *Sim) !void {
        const phase = self.sessionValue().lifecycle.phase;
        switch (self.transition) {
            .none, .closing => {},
            .setup, .resuming => if (phase == .active) {
                self.transition = .none;
                self.force_next = true;
                if (self.pending_resize != null) try self.applyResize();
                try self.requestRender();
            },
            .suspending => if (phase == .suspended) {
                self.transition = .none;
                self.stats.suspends += 1;
                // I7: the suspend promise resolves only once the restore bytes are in the pty.
                try self.expectAllWritten();
                try self.checkpoint(.restored);
                self.stopped_until = self.now + 200 * ms + self.random.uintLessThan(u64, 400 * ms);
                try self.post(.resume_start, self.stopped_until, 0);
            },
        }
    }

    fn writeOutput(self: *Sim) !void {
        const owner = self.f.owner;
        switch (self.env.output_mode) {
            .sync_drain => {
                const written = owner.drainOutput(self.f.id, SimSink{ .sim = self }, drain_budget) catch |err| return self.onError(err);
                try self.afterOutput();
                try self.scheduleTurn(if (written == 0) self.now + ms else self.now);
            },
            .ticket => {
                self.link.expectContinuous(self.sessionValue().completed_bytes);
                const ticket = (owner.readOutput(self.f.id, self.host_buffer) catch |err| return self.onError(err)) orelse return error.NoPendingOutput;
                self.stats.owner_writes += 1;
                self.noteWrite();
                self.host = .{ .ticket = ticket, .done = 0 };
                try self.hostWrite();
                try self.wakeLink();
            },
        }
    }

    /// The Writable's asynchronous write: what fits whenever the lock is free, then its callback.
    fn hostWrite(self: *Sim) !void {
        const host = &(self.host orelse return);
        if (host.done == host.ticket.len) return;
        const fault = self.hangupLimit(host.ticket.len - host.done);
        if (fault.now) |kind| self.link.hangup = kind;
        if (self.link.hangup != null) {
            host.failed = true;
            host.done = host.ticket.len;
        } else {
            const count = try self.link.writeNow(self.host_buffer[host.done..][0..fault.limit]);
            host.done += count;
            if (count == fault.limit) self.link.hangup = fault.after;
            if (host.done != host.ticket.len) return;
        }
        try self.post(.host_done, self.now, 0);
    }

    /// A hangup at a byte offset: a write that crosses it takes the bytes before it, and the
    /// writes after fail. `now` fails this write.
    fn hangupLimit(self: *Sim, len: usize) struct { limit: usize, after: ?presets.FaultKind = null, now: ?presets.FaultKind = null } {
        const start = self.link.session_end;
        for (self.env.faults) |fault| switch (fault.at) {
            .byte_offset => |at| if (fault.kind == .eio or fault.kind == .epipe) {
                if (at < start or at >= start + len) continue;
                if (at == start) return .{ .limit = 0, .now = fault.kind };
                return .{ .limit = @intCast(at - start), .after = fault.kind };
            },
            else => {},
        };
        return .{ .limit = len };
    }

    fn afterOutput(self: *Sim) !void {
        const frame = self.frame orelse return;
        if (self.sessionValue().frame_end_offset != null) return;
        self.frame = null;
        if (self.failed) return;
        self.stats.presented += 1;
        const bytes = frame.end - frame.start;
        self.stats.frame_bytes += bytes;
        self.stats.frame_bytes_max = @max(self.stats.frame_bytes_max, bytes);
        if (frame.writes > 1) self.stats.multi_ticket_frames += 1;
        if (self.pending_resize != null) try self.applyResize();
        if (self.dirty) {
            self.dirty = false;
            try self.requestRender();
        }
    }

    fn render(self: *Sim) !void {
        const owner = self.f.owner;
        const value = self.sessionValue();
        if (value.lifecycle.phase != .active or self.transition != .none or self.failed) return;
        if (value.frame_end_offset != null) {
            // I2: no second frame is accepted while one is in flight.
            if (owner.scenePaint(self.f.id, background, false, 0)) |_| self.stats.second_frames += 1 else |err| if (err != error.PresentationPending) return err;
            return;
        }
        if (!self.dirty and !self.force_next) return;
        try fixture.repaint(owner, self.f.id, background, false, 0);
        const full = self.force_next or self.f.cli.force_full_repaint;
        const start = self.published();
        const status = try fixture.present(owner, self.f.id, self.force_next);
        self.dirty = false;
        self.force_next = false;
        self.last_frame_ns = self.now;
        const end = self.published();
        switch (status) {
            .skipped, .failed => return,
            .pending, .presented => {},
        }
        self.stats.commits += 1;
        if (self.frame != null or self.stats.commits - self.stats.presented > 1) self.stats.second_frames += 1;
        if (end > start) {
            try self.snapshots.append(gpa, try copySnapshot(self.f.cli.currentRenderBuffer));
            try self.checkpoint(.{ .frame = .{ .index = @intCast(self.snapshots.items.len - 1), .full = full } });
        }
        self.frame = .{ .start = start, .end = end };
        if (status == .presented) return self.afterOutput();
        try self.scheduleTurn(self.now);
    }

    fn applyResize(self: *Sim) !void {
        const size = self.pending_resize orelse return;
        const value = self.sessionValue();
        if (value.frame_end_offset != null or value.lifecycle.phase != .active or self.transition != .none) return;
        try self.f.owner.resizeSessionRenderer(self.f.id, size[0], size[1]);
        self.pending_resize = null;
        try self.checkpoint(.{ .resize = size });
        self.force_next = true;
        try self.requestRender();
    }

    fn produce(self: *Sim, arg: u64) !void {
        if (arg == 0 and !self.scriptStep()) return;
        const owner = self.f.owner;
        const id = self.f.id;
        const kind = if (arg == 1) 5 else if (self.env.events.flood) 0 else self.random.uintLessThan(u32, 5);
        var title: [32]u8 = undefined;
        const outcome: anyerror!bool = switch (kind) {
            0 => if (owner.controlSession(id, .{ .title = std.fmt.bufPrint(&title, "sim {d}", .{self.stats.produced}) catch unreachable })) true else |err| err,
            1 => if (owner.controlSession(id, .{ .mouse = if (self.random.boolean()) .motion else .disabled })) true else |err| err,
            2 => owner.writeSessionClipboard(id, .clipboard, "clipboard payload"),
            3 => self.sessionValue().triggerNotification("done", "sim"),
            4 => if (owner.writeSession(id, "\x1b]0;raw\x07")) true else |err| err,
            else => blk: {
                const payload = try gpa.alloc(u8, 1024 * 1024);
                defer gpa.free(payload);
                @memset(payload, 'a');
                break :blk owner.writeSessionClipboard(id, .clipboard, payload);
            },
        };
        if (outcome) |accepted| {
            if (accepted) self.stats.produced += 1 else self.stats.produce_refused += 1;
        } else |_| self.stats.produce_errors += 1;
        try self.scheduleTurn(self.now);
        if (arg == 0) try self.post(.produce, self.jittered(if (self.env.events.flood) 50 * ms else 300 * ms), 0);
    }

    // Input: pieces arrive, the owner reads what has arrived when it runs.

    fn sendInput(self: *Sim, bytes: []const u8, at_ns: u64) !void {
        var cut: usize = bytes.len;
        var gap: u64 = 0;
        if (self.env.events.split_gap_ns) |gap_max| if (bytes.len > 1) {
            cut = 1 + self.random.uintLessThan(usize, bytes.len - 1);
            gap = self.random.uintAtMost(u64, gap_max);
        };
        try self.input.appendSlice(gpa, bytes[0..cut]);
        try self.pieces.append(gpa, .{ .end = @intCast(self.input.items.len), .at_ns = at_ns });
        try self.post(.input_arrive, at_ns, self.pieces.items.len - 1);
        if (cut == bytes.len) return;
        try self.input.appendSlice(gpa, bytes[cut..]);
        try self.pieces.append(gpa, .{ .end = @intCast(self.input.items.len), .at_ns = at_ns + gap });
        try self.post(.input_arrive, at_ns + gap, self.pieces.items.len - 1);
    }

    fn readInput(self: *Sim) !void {
        const start = self.read_input;
        if (start == self.arrived_input) return;
        if (self.print_trace) std.debug.print("  read {any}\n", .{self.input.items[start..self.arrived_input]});
        // The oldest unread byte's arrival: what the stall cost the next key.
        // Only the time the owner spent inside output writes since then counts (I1), not a stop.
        self.read_wait_ns = for (self.pieces.items) |piece| {
            if (piece.end > start) break self.stats.blocked_ns - piece.blocked_ns;
        } else 0;
        self.read_input = self.arrived_input;
        try self.feed(self.input.items[start..self.read_input]);
    }

    fn feed(self: *Sim, bytes: []const u8) !void {
        var rest = bytes;
        while (true) {
            var sink: input_parser.Sink = .{ .events = &self.events, .payload = &self.payload };
            const result = self.f.owner.sessionInputFeed(self.f.id, rest, self.now, &sink) catch |err| return self.onError(err);
            for (self.events[0..sink.count]) |event| try self.onInput(event, sink.raw(event));
            if (result.consumed == 0 and rest.len != 0) return error.InputSinkFull;
            rest = rest[result.consumed..];
            if (result.deadline_ns) |deadline| try self.post(.input_deadline, deadline, 0);
            if (rest.len == 0) return;
        }
    }

    fn onInput(self: *Sim, event: input_parser.Event, raw: []const u8) !void {
        if (self.print_trace) std.debug.print("  input kind {d} code {d} flags {d} raw {any}\n", .{ event.kind, event.code, event.flags, raw });
        try self.decoded.append(gpa, .{ .kind = event.kind, .code = event.code, .modifiers = event.modifiers, .raw = std.hash.Wyhash.hash(0, raw) });
        switch (@as(input_parser.Kind, @enumFromInt(event.kind))) {
            .key => {
                self.stats.keys_seen += 1;
                self.stats.key_wait_max_ns = @max(self.stats.key_wait_max_ns, self.read_wait_ns);
                if (self.read_wait_ns != 0) self.stats.keys_delayed += 1;
                try self.setStatus();
                try self.mutated();
            },
            .reply => {
                try self.reply_seen.appendSlice(gpa, raw);
                self.f.owner.controlSession(self.f.id, .{ .capability_response = raw }) catch |err| switch (err) {
                    error.SessionClosed, error.SessionFailed => {},
                    else => {
                        if (self.print_trace) std.debug.print("  reply rejected: {t}\n", .{err});
                        self.stats.reply_errors += 1;
                    },
                };
                try self.scheduleTurn(self.now);
            },
            else => self.stats.reply_errors += 1,
        }
    }

    // The far terminal: wire bytes as they arrive, with checks at Session offsets.

    fn checkpoint(self: *Sim, kind: @FieldType(Checkpoint, "kind")) !void {
        try self.checkpoints.append(gpa, .{ .offset = self.published(), .kind = kind });
    }

    fn feedTerminal(self: *Sim) !void {
        while (true) {
            // Checks at the Session offset the terminal has reached.
            while (self.checkpoint_head < self.checkpoints.items.len and self.checkpoints.items[self.checkpoint_head].offset <= self.fed_session) {
                try self.reach(self.checkpoints.items[self.checkpoint_head]);
                self.checkpoint_head += 1;
            }
            if (self.fed == self.link.arrived) return;
            // The link may extend its last segment after the terminal read to its end.
            while (self.link.segments.items[self.segment_head].wire + self.link.segments.items[self.segment_head].len <= self.fed) self.segment_head += 1;
            const segment = self.link.segments.items[self.segment_head];
            const segment_end = segment.wire + segment.len;
            var end = @min(segment_end, self.link.arrived);
            const session_bytes = segment.source == .session;
            if (session_bytes and self.checkpoint_head < self.checkpoints.items.len) {
                end = @min(end, self.fed + (self.checkpoints.items[self.checkpoint_head].offset - self.fed_session));
            }
            self.far_stream.nextSlice(self.link.wire.items[self.fed..end]);
            if (session_bytes) self.fed_session += end - self.fed;
            self.fed = end;
        }
    }

    fn reach(self: *Sim, point: Checkpoint) !void {
        switch (point.kind) {
            .frame => |frame| {
                const snapshot = self.snapshots.items[frame.index].?;
                defer {
                    freeSnapshot(snapshot);
                    self.snapshots.items[frame.index] = null;
                }
                if (frame.full) self.synced = true;
                if (!self.synced or snapshot.width != self.far.cols or snapshot.height != self.far.rows) return;
                // A cut escape can leave the decoder in any state (an open string, a mode, a
                // link): that is I5's failure, so later screens are not compared.
                if (self.link.cutsBefore(self.fed_session) != 0) {
                    self.stats.garbled_frames += 1;
                    return;
                }
                self.stats.decoded_frames += 1;
                if (vt_decode.mismatch(&self.far, cellsOf(snapshot))) |found| {
                    if (self.stats.frame_mismatches == 0 and self.print_trace) {
                        std.debug.print("frame {d} differs at {d},{d} {s}\n", .{ frame.index, found.x, found.y, found.field });
                        const plain = try self.far.plainString(testing.allocator);
                        defer testing.allocator.free(plain);
                        std.debug.print("VT:\n{s}\nrow:", .{plain});
                        for (0..snapshot.width) |x| {
                            const char = snapshot.char[found.y * snapshot.width + x];
                            std.debug.print("{u}", .{if (char < 0x110000 and char != 0) @as(u21, @intCast(char)) else '?'});
                        }
                        std.debug.print("\n", .{});
                    }
                    self.stats.frame_mismatches += 1;
                }
            },
            .resize => |size| {
                try self.far.resize(testing.allocator, .{ .cols = size[0], .rows = size[1] });
                self.synced = false;
            },
            .query => if (!self.replies_sent) {
                self.replies_sent = true;
                // The replies cross the link back, as keys do.
                try self.sendInput(replies, self.now + self.env.latency_ns);
            },
            .restored => {
                self.synced = false;
                if (!self.restoredModes()) self.stats.modes_left += 1;
            },
        }
    }

    fn restoredModes(self: *Sim) bool {
        const modes = &self.far.modes;
        return self.far.screens.active_key == .primary and modes.get(.cursor_visible) and
            !modes.get(.mouse_event_normal) and !modes.get(.mouse_event_button) and !modes.get(.mouse_event_any) and
            !modes.get(.bracketed_paste) and !modes.get(.focus_event) and self.far.screens.active.kitty_keyboard.current().int() == 0;
    }

    // Invariants at events.

    /// I7: every byte the Session published is in the pty.
    /// Counts a write or ticket that starts inside the frame in flight (I3).
    fn noteWrite(self: *Sim) void {
        const frame = &(self.frame orelse return);
        const at = self.sessionValue().completed_bytes;
        if (at >= frame.start and at < frame.end) frame.writes += 1;
    }

    fn nonblocking(self: *Sim) bool {
        if (self.nonblocking_forever) return true;
        for (self.env.faults) |fault| if (fault.kind == .eagain) switch (fault.at) {
            .ns => |at| if (self.now >= at and self.now < at + fault.duration_ns) return true,
            else => {},
        };
        return false;
    }

    fn expectAllWritten(self: *Sim) !void {
        if (self.link.session_end != self.published()) self.stats.restore_missing += 1;
    }

    /// I6 and I13 at quiescence.
    fn checkQuiescent(self: *Sim) !void {
        const garbled = self.link.cutsBefore(self.fed_session) != 0;
        if (self.synced and !garbled and vt_decode.mismatch(&self.far, .of(self.f.cli.currentRenderBuffer)) != null) self.stats.quiescent_mismatches += 1;
        if (!self.replies_sent) return;
        const caps = self.f.cli.terminal.caps;
        if (self.print_trace) std.debug.print("  quiescent: replies {any}, caps focus {} paste {} kitty {}\n", .{ self.reply_seen.items, caps.focus_tracking, caps.bracketed_paste, caps.kitty_keyboard });
        if (!std.mem.eql(u8, self.reply_seen.items, replies)) self.stats.reply_errors += 1;
        if (!caps.focus_tracking or !caps.bracketed_paste or !caps.kitty_keyboard) self.stats.reply_errors += 1;
    }

    fn onError(self: *Sim, err: anyerror) !void {
        switch (err) {
            error.SessionFailed => {
                // I10: only a hangup fails the transport.
                if (self.link.hangup == null) self.stats.bad_failures += 1;
                if (!self.failed) self.stats.hangups += 1;
                self.failed = true;
            },
            else => return err,
        }
    }

    fn onClosed(self: *Sim) !void {
        self.stats.closes += 1;
        try self.expectAllWritten();
        try self.checkpoint(.restored);
        try self.endAfterOwner();
    }

    /// The run's end, once settled (or at once for exits while blocked).
    fn endRun(self: *Sim) !void {
        if (self.phase == .ending or self.ended) return;
        self.phase = .ending;
        if (self.failed) return self.endAfterOwner();
        const owner = self.f.owner;
        switch (self.env.events.end) {
            .close => {
                try owner.beginSessionClose(self.f.id);
                self.transition = .closing;
                self.close_deadline = self.now + close_timeout_ns;
                try self.scheduleTurn(self.now);
            },
            .exit => {
                self.stats.exits += 1;
                if (self.env.nonblocking_at_end) self.nonblocking_forever = true;
                if (try self.restoreOnExit()) {
                    try self.expectAllWritten();
                    try self.checkpoint(.restored);
                } else if (!self.failed) self.stats.restore_missing += 1;
                try self.endAfterOwner();
            },
            .crash => {
                self.stats.crashes += 1;
                owner.cancelSession(self.f.id) catch unreachable;
                try self.endAfterOwner();
            },
        }
    }

    /// NativeSession.restoreOnExit: only fd 1 delivers synchronously, and an in-flight
    /// Writable ticket refuses.
    fn restoreOnExit(self: *Sim) !bool {
        const owner = self.f.owner;
        if (self.env.output_mode == .ticket) {
            if (self.host) |host| if (host.done < host.ticket.len) return false;
            if (self.host) |host| {
                self.host = null;
                owner.completeOutput(self.f.id, host.ticket, .written) catch return false;
            }
        }
        while (true) {
            const status = owner.raw().getSession(self.f.id) catch unreachable;
            switch (status.pumpExit() catch return false) {
                .closed => return true,
                .again => continue,
                .output_pending => {},
                else => return error.UnexpectedExitStatus,
            }
            // A Writable cannot finish asynchronously at exit.
            if (self.env.output_mode == .ticket) return false;
            const written = owner.drainOutput(self.f.id, SimSink{ .sim = self }, drain_budget) catch return false;
            if (written == 0) return false;
        }
    }

    fn endAfterOwner(self: *Sim) !void {
        self.ended = true;
        self.phase = .ending;
        // A process exit ends a Writable's write with it. After a cancel, the write that was
        // running may still finish (I8), and nothing after it.
        if (self.env.events.end == .exit) self.host = null;
        const running: u64 = if (self.host) |host| host.ticket.len - host.done else 0;
        self.closed_at = self.link.session_end + running;
        self.stats.virtual_ns = self.now;
        // The owner is done; the link drains on its own.
        try self.wakeLink();
    }

    fn finish(self: *Sim) !void {
        try self.link.advance(self.now);
        try self.feedTerminal();
        // I8: nothing from the Session entered the pty after close or cancel.
        if (self.closed_at) |at| if (self.link.session_end != at) {
            self.stats.stale_bytes += 1;
        };
        self.stats.cut_tokens = @intCast(self.link.cuts.items.len);
        self.stats.cuts_mid_span = self.link.cuts_mid_span;
        self.stats.discontinuities = self.link.discontinuities;
        self.stats.live_peak_bytes = self.counting.peak;
        try self.checkInput();
        self.stats.trace = std.hash.Wyhash.hash(self.stats.trace, self.link.wire.items);
        self.stats.runs = 1;
        self.phase = .done;
    }

    /// I14: the input, decoded in the pieces the owner read, equals the input decoded whole.
    fn checkInput(self: *Sim) !void {
        var parser: input_parser.InputParser = .{};
        parser.setExpectations(.{ .replies = true, .cursor_position = true });
        var reference: std.ArrayList(Decoded) = .empty;
        defer reference.deinit(gpa);
        var rest: []const u8 = self.input.items[0..self.read_input];
        var flushed = false;
        while (true) {
            var sink: input_parser.Sink = .{ .events = &self.events, .payload = &self.payload };
            const consumed = parser.feed(rest, if (rest.len == 0) std.math.maxInt(u64) else 0, &sink);
            if (consumed == 0 and rest.len != 0) return error.InputSinkFull;
            for (self.events[0..sink.count]) |event| try reference.append(gpa, .{ .kind = event.kind, .code = event.code, .modifiers = event.modifiers, .raw = std.hash.Wyhash.hash(0, sink.raw(event)) });
            rest = rest[consumed..];
            if (rest.len != 0) continue;
            if (flushed) break;
            flushed = true;
        }
        if (!std.meta.eql(reference.items.len, self.decoded.items.len)) {
            self.stats.input_mismatches += 1;
            return;
        }
        for (reference.items, self.decoded.items) |expected, actual| {
            if (expected.kind != actual.kind or expected.code != actual.code or expected.raw != actual.raw) {
                self.stats.input_mismatches += 1;
                return;
            }
        }
    }
};

/// The fd 1 sink on the owner: today's `drainStdout` with the link's pty behind it. A blocking
/// write runs the world until the pty takes its bytes; that time is the owner's stall (I1).
const SimSink = struct {
    sim: *Sim,

    pub fn write(self: SimSink, bytes: []const u8) error{ WouldBlock, InputOutput, BrokenPipe }!usize {
        return self.writeOrFail(bytes) catch |err| switch (err) {
            error.WouldBlock, error.InputOutput, error.BrokenPipe => |e| e,
            else => {
                self.sim.inner_error = err;
                return error.InputOutput;
            },
        };
    }

    fn writeOrFail(self: SimSink, bytes: []const u8) anyerror!usize {
        const sim = self.sim;
        const link = &sim.link;
        sim.stats.owner_writes += 1;
        link.expectContinuous(sim.sessionValue().completed_bytes);
        if (link.hangup) |kind| return if (kind == .epipe) error.BrokenPipe else error.InputOutput;
        const fault = sim.hangupLimit(@min(bytes.len, sim.env.partial_max orelse bytes.len));
        if (fault.now) |kind| {
            link.hangup = kind;
            return if (kind == .epipe) error.BrokenPipe else error.InputOutput;
        }
        const limit = fault.limit;
        const hangup_after = fault.after;
        var interrupt = false;
        for (sim.env.faults) |each| switch (each.at) {
            .write_index => |index| if (each.kind == .eintr and index == sim.stats.owner_writes) {
                interrupt = true;
            },
            else => {},
        };
        // What is left of the Session's span: a write that stops short of it ends mid-span.
        const value = sim.sessionValue();
        const span_left = value.span.?.len - value.span_offset;
        if (sim.nonblocking()) {
            const count = try link.writeNow(bytes[0..limit]);
            try sim.wakeLink();
            if (count == limit) link.hangup = hangup_after;
            if (count == 0) return error.WouldBlock;
            link.mid_span = count < span_left;
            sim.noteWrite();
            if (link.tokenizer.state != .ground) sim.stats.mid_token_ends += 1;
            return count;
        }
        const start = sim.now;
        try link.enqueue(.{ .kind = .owner, .bytes = bytes, .limit = limit, .interrupt = interrupt });
        try sim.wakeLink();
        // The JS thread is inside write(2): only the world moves until the pty takes the bytes.
        const done = while (true) {
            if (takeOwner(link)) |writer| break writer.done;
            const event = sim.world_queue.pop() orelse return error.Deadlock;
            sim.now = @max(sim.now, event.at_ns);
            sim.traceEvent(event);
            try sim.runWorld(event);
        };
        sim.stats.blocked_ns += sim.now - start;
        link.mid_span = done < span_left;
        sim.noteWrite();
        if (done == limit) link.hangup = hangup_after;
        if (link.tokenizer.state != .ground) sim.stats.mid_token_ends += 1;
        return done;
    }

    fn takeOwner(link: *link_model.Link) ?link_model.Writer {
        for (link.finished.items, 0..) |writer, index| if (writer.kind == .owner) return link.finished.orderedRemove(index);
        return null;
    }
};

fn copySnapshot(target: *const @import("../buffer.zig").OptimizedBuffer) !Snapshot {
    const cells = vt_decode.Cells.of(target);
    return .{
        .char = try gpa.dupe(u32, cells.char),
        .fg = try gpa.dupe(ansi.RGBA, cells.fg),
        .bg = try gpa.dupe(ansi.RGBA, cells.bg),
        .attributes = try gpa.dupe(u32, cells.attributes),
        .width = cells.width,
        .height = cells.height,
    };
}

fn freeSnapshot(snapshot: Snapshot) void {
    gpa.free(snapshot.char);
    gpa.free(snapshot.fg);
    gpa.free(snapshot.bg);
    gpa.free(snapshot.attributes);
}

fn cellsOf(snapshot: Snapshot) vt_decode.Cells {
    return .{ .width = snapshot.width, .height = snapshot.height, .char = snapshot.char, .fg = snapshot.fg, .bg = snapshot.bg, .attributes = snapshot.attributes };
}

/// CI's screen: presets are written at the harness's 100x32 and scaled down (`presets.scaled`).
const ci_size = [2]u16{ 60, 16 };

fn runScaled(name: []const u8, base: presets.Env, mode: presets.OutputMode, seed: u64, script_events: u32) !Stats {
    var faults: [8]presets.Fault = undefined;
    return runOne(name, presets.scaled(base, ci_size[0], ci_size[1], &faults), mode, seed, script_events, false);
}

fn runOne(name: []const u8, base: presets.Env, mode: presets.OutputMode, seed: u64, script_events: u32, print_trace: bool) !Stats {
    var prng = std.Random.DefaultPrng.init(seed);
    const random = prng.random();
    var faults: [8]presets.Fault = undefined;
    var env = presets.jitter(base, random, &faults);
    env.output_mode = mode;
    // Leak checks without per-allocation stack traces, which would dominate the run's time.
    var debug: std.heap.DebugAllocator(.{ .stack_trace_frames = 0 }) = .init;
    defer if (debug.deinit() == .leak) @panic("OUTPUT SIM leaked Context memory");
    var counting: Counting = .{ .parent = debug.allocator() };
    var sim: Sim = undefined;
    try sim.init(env, random, &counting, script_events, print_trace);
    defer sim.deinit();
    sim.run() catch |err| {
        std.debug.print("OUTPUT SIM {s} {t} seed {d}: {t} at {d} ns, trace {x}\n", .{ name, mode, seed, err, sim.now, sim.stats.trace });
        return err;
    };
    return sim.stats;
}

fn add(total: *Stats, stats: Stats) void {
    inline for (std.meta.fields(Stats)) |field| {
        if (comptime std.mem.endsWith(u8, field.name, "_max_ns") or std.mem.endsWith(u8, field.name, "_max") or std.mem.endsWith(u8, field.name, "_peak_bytes")) {
            @field(total, field.name) = @max(@field(total, field.name), @field(stats, field.name));
        } else if (comptime std.mem.eql(u8, field.name, "trace")) {
            total.trace = std.hash.Wyhash.hash(total.trace, std.mem.asBytes(&stats.trace));
        } else @field(total, field.name) += @field(stats, field.name);
    }
}

fn printStats(name: []const u8, mode: presets.OutputMode, stats: Stats) void {
    const seconds = @as(f64, @floatFromInt(stats.virtual_ns)) / std.time.ns_per_s;
    std.debug.print("{s:<16} {t:<10} runs {d:>3} fps {d:>5.1} B/frame {d:>6} max {d:>6} mut/frame {d:>4.2} multi {d:>4} blocked {d:>5.1}% keys {d}/{d} delayed {d} wait max {d} ms peak {d} KiB mid-token ends {d}\n", .{
        name,                                                                                         mode,
        stats.runs,                                                                                   @as(f64, @floatFromInt(stats.presented)) / seconds,
        stats.frame_bytes / @max(1, stats.presented),                                                 stats.frame_bytes_max,
        @as(f64, @floatFromInt(stats.mutations)) / @as(f64, @floatFromInt(@max(1, stats.presented))), stats.multi_ticket_frames,
        @as(f64, @floatFromInt(stats.blocked_ns)) * 100 / @as(f64, @floatFromInt(stats.virtual_ns)),  stats.keys_seen,
        stats.keys_sent,                                                                              stats.keys_delayed,
        stats.key_wait_max_ns / ms,                                                                   stats.live_peak_bytes / 1024,
        stats.mid_token_ends,
    });
    inline for (invariant_fields) |field| if (@field(stats, field) != 0) std.debug.print("    {s}: {d}\n", .{ field, @field(stats, field) });
}

fn environment(key: []const u8) ?[]u8 {
    return std.testing.environ.getAlloc(testing.allocator, key) catch null;
}

test "OUTPUT SIM seeds" {
    if (!@import("ghostty_vt_options").available) return error.SkipZigTest;
    const script_events = 200;
    if (environment("OUTPUT_SIM_SEED")) |seed_text| {
        defer testing.allocator.free(seed_text);
        const name = environment("OUTPUT_SIM_PRESET") orelse try testing.allocator.dupe(u8, "ssh_slow");
        defer testing.allocator.free(name);
        const mode_text = environment("OUTPUT_SIM_MODE");
        defer if (mode_text) |text| testing.allocator.free(text);
        const mode = if (mode_text) |text| std.meta.stringToEnum(presets.OutputMode, text) orelse return error.UnknownMode else .sync_drain;
        const trace = environment("OUTPUT_SIM_TRACE");
        defer if (trace) |text| testing.allocator.free(text);
        var env = presets.find(name) orelse return error.UnknownPreset;
        var size: [2]u16 = ci_size;
        if (environment("OUTPUT_SIM_SIZE")) |text| {
            defer testing.allocator.free(text);
            var parts = std.mem.splitScalar(u8, text, 'x');
            size = .{ try std.fmt.parseInt(u16, parts.first(), 10), try std.fmt.parseInt(u16, parts.next() orelse return error.InvalidSize, 10) };
        }
        var scaled_faults: [8]presets.Fault = undefined;
        env = presets.scaled(env, size[0], size[1], &scaled_faults);
        const events_text = environment("OUTPUT_SIM_EVENTS");
        defer if (events_text) |text| testing.allocator.free(text);
        const events = if (events_text) |text| try std.fmt.parseInt(u32, text, 10) else script_events;
        const stats = try runOne(name, env, mode, try std.fmt.parseInt(u64, seed_text, 10), events, trace != null);
        printStats(name, mode, stats);
        std.debug.print("trace {x}\n", .{stats.trace});
        return;
    }
    const summary = environment("OUTPUT_SIM_SUMMARY");
    defer if (summary) |text| testing.allocator.free(text);
    const Plan = struct { presets: []const presets.Preset, mode: presets.OutputMode, seeds: ?u64 };
    const plans = [_]Plan{
        .{ .presets = &presets.named, .mode = .sync_drain, .seeds = 6 },
        .{ .presets = &presets.sweep, .mode = .sync_drain, .seeds = null },
        .{ .presets = &presets.named, .mode = .ticket, .seeds = 2 },
    };
    // OUTPUT_SIM_SEEDS=<n> runs n seeds of every plan: a local sweep.
    const seeds_text = environment("OUTPUT_SIM_SEEDS");
    defer if (seeds_text) |text| testing.allocator.free(text);
    const seeds: ?u64 = if (seeds_text) |text| try std.fmt.parseInt(u64, text, 10) else null;
    var failures: u32 = 0;
    var traces: [presets.named.len][4]u64 = undefined;
    for (plans) |plan| for (plan.presets, 0..) |preset, index| {
        var total: Stats = .{};
        for (0..seeds orelse plan.seeds orelse preset.ci_seeds) |seed| {
            const stats = try runScaled(preset.name, preset.env, plan.mode, seed, script_events);
            if (plan.presets.ptr == &presets.named and plan.mode == .sync_drain and seed < 4) traces[index][seed] = stats.trace;
            add(&total, stats);
        }
        if (summary != null) printStats(preset.name, plan.mode, total);
        inline for (invariant_fields) |field| {
            const count = @field(total, field);
            const row = findKnown(preset.name, plan.mode, field);
            const required = if (row) |value| value.required else false;
            // D1 may show wherever outside writers share fd 1.
            const allowed = row != null or (std.mem.eql(u8, field, "cut_tokens") and preset.env.external != null);
            if ((count != 0 and !allowed) or (count == 0 and required)) {
                std.debug.print("OUTPUT SIM {s} {t}: {s} = {d}{s}\n", .{ preset.name, plan.mode, field, count, if (count == 0) " (a known defect no longer reproduces)" else "" });
                failures += 1;
            }
        }
        try expectMinimums(preset.name, plan.mode, total);
    };
    try testing.expectEqual(@as(u32, 0), failures);
    // I11: seeds 0-3 of the named presets replay to the traces they had above.
    for (presets.named, traces) |preset, expected| for (expected, 0..) |trace, seed| {
        try testing.expectEqual(trace, (try runScaled(preset.name, preset.env, .sync_drain, seed, script_events)).trace);
    };
}

/// Known `main` defects, recorded as counts until their fix run removes the row. A row whose
/// count is zero fails too, so a fix shows up here.
const Known = struct { preset: []const u8, mode: presets.OutputMode = .sync_drain, field: []const u8, required: bool = true };

const known = [_]Known{
    // D1: an output span larger than one feed chunk (a large frame, a long OSC 52) drains in
    // several write(2) calls. An outside writer that waits for the tty lock enters between
    // them, inside an escape sequence. Every preset with outside writers on fd 1 shows it.
    .{ .preset = "ssh_slow", .field = "cut_tokens" },
    .{ .preset = "ssh_16k", .field = "cut_tokens" },
    .{ .preset = "nonblock_flip", .field = "cut_tokens" },
    .{ .preset = "macos_chunked", .field = "cut_tokens" },
    .{ .preset = "exit_blocked", .field = "cut_tokens" },
    .{ .preset = "split_input", .field = "cut_tokens" },
    .{ .preset = "producer_flood", .field = "cut_tokens" },
    .{ .preset = "exit_nonblocking", .field = "cut_tokens" },
    // D2: exit with fd 1 non-blocking gives up on a 0-byte drain, so the restore never leaves.
    .{ .preset = "exit_nonblocking", .field = "restore_missing" },
    // D3: the owner, stalled in a write, reads the rest of a split input sequence after the
    // prefix's 20 ms deadline. feedInput expires the prefix first: an arrow key decodes as
    // ESC, '[' and 'A', or ESC '[' as a reply fragment.
    .{ .preset = "split_input", .field = "input_mismatches" },
    .{ .preset = "split_input", .field = "reply_errors", .required = false },
    // Outside writers inside a span: as `main` does when someone else makes fd 1 non-blocking
    // (the 1 ms retry returns to the loop mid-span), and the XNU model, which lets another
    // writer into a blocking write.
    .{ .preset = "nonblock_flip", .field = "cuts_mid_span", .required = false },
    .{ .preset = "macos_chunked", .field = "cuts_mid_span" },
};

fn findKnown(name: []const u8, mode: presets.OutputMode, field: []const u8) ?Known {
    for (known) |row| {
        if (row.mode == mode and std.mem.eql(u8, row.preset, name) and std.mem.eql(u8, row.field, field)) return row;
    }
    return null;
}

/// I3 and coverage: each preset reaches what its invariants need.
fn expectMinimums(name: []const u8, mode: presets.OutputMode, total: Stats) !void {
    errdefer printStats(name, mode, total);
    const env = presets.find(name).?;
    try testing.expect(total.presented > 0 and total.commits >= total.presented);
    // I4: the Context's memory stays within the feed's 8 MiB and a fixed allowance for the
    // renderer and scene, at any link rate (measured peak: 10.1 MiB with a 1 MiB OSC 52 queued).
    try testing.expect(total.live_peak_bytes < 12 * 1024 * 1024);
    // Frames that span several writes or tickets occur, and the decoder compared frames.
    try testing.expect(total.multi_ticket_frames > 0 or std.mem.eql(u8, name, "hangup_mid_frame"));
    if (std.mem.eql(u8, name, "hangup_mid_frame")) {
        // Every run hangs up, and the Session fails at once (I10).
        try testing.expectEqual(total.runs, total.hangups);
        return;
    }
    try testing.expect(total.decoded_frames > 0);
    if (mode == .sync_drain) try testing.expect(total.suspends > 0);
    switch (env.events.end) {
        .close => try testing.expectEqual(total.runs, total.closes),
        .exit => try testing.expectEqual(total.runs, total.exits),
        .crash => try testing.expectEqual(total.runs, total.crashes),
    }
    if (env.rate_bps != null and mode == .sync_drain) {
        // The 388 stall, recorded (I1): the owner waits in writes, and keys wait for it. Frames
        // fold more than one mutation each on a congested link (I3).
        try testing.expect(total.blocked_ns > 0 and total.keys_delayed > 0);
        try testing.expect(total.mutations > total.presented);
    }
    if (mode == .ticket) try testing.expectEqual(@as(u64, 0), total.blocked_ns);
}
