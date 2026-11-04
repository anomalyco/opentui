//! Deterministic output simulation. A real Context, Session, renderer and scene stream a
//! scene like the slow-link harness's app, on virtual time, into a model of the far side of
//! fd 1 (output-sim/link.zig): a pty with a write lock, outside writers, an ssh-like socket and
//! link, and a Ghostty VT as the far terminal. The owner actor mirrors the JS driver: one pump
//! and one write per turn, a 1 ms retry after a 0-byte drain, one frame in flight, input,
//! replies, resizes, suspend, and the end of the run (close, exit, crash).
//!
//! Output modes: `sync_drain` (fd 1 today: `drainOutput` with `SimSink` on the owner, which
//! blocks the owner while the pty is full), `ticket` (a Writable: `readOutput`, an asynchronous
//! host write, `completeOutput`), and `writer` (fd 1 with the stdout writer: the owner posts and
//! polls, and a stepped writer "thread" picks, writes and publishes as separate world events).
//! Every run checks the invariants listed at `Stats`; the 388 stall (I1) is recorded in
//! `sync_drain` and must be zero in `writer`.
//!
//! Replay one run: OUTPUT_SIM_SEED=<n> OUTPUT_SIM_PRESET=<name> [OUTPUT_SIM_MODE=ticket]
//! [OUTPUT_SIM_SIZE=100x32] [OUTPUT_SIM_EVENTS=<n>] [OUTPUT_SIM_TRACE=1]
//! bun run test:native -Dtest-filter="OUTPUT SIM". OUTPUT_SIM_SEEDS=<n> runs n seeds of every
//! CI plan; OUTPUT_SIM_SUMMARY=1 prints each preset's totals.
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
const stdout_writer = @import("../stdout-writer.zig");

const ms = std.time.ns_per_ms;
/// The model's own storage. The Context's goes through `ContextAllocator`.
const gpa = std.heap.smp_allocator;
/// Leak checks without per-allocation stack traces, which would dominate the run's time, and
/// I4's limit: the feed's 8 MiB plus a fixed allowance for the renderer and scene.
const ContextAllocator = std.heap.DebugAllocator(.{ .stack_trace_frames = 0, .enable_memory_limit = true });
const context_bytes_max = 12 * 1024 * 1024;
const frame_interval_ns: u64 = std.time.ns_per_s / 60;
/// 50 tokens a second, as the harness app streams.
const token_period_ns: u64 = 20 * ms;
/// The driver's drain budget and Writable copy size (`zig.ts`, `NativeSession.ts`).
const drain_budget: u32 = 65_536;
/// The driver's graceful close timeout (`closeTimeoutMs`).
const close_timeout_ns: u64 = 1000 * ms;
const background = ansi.rgbColor(30, 30, 46, 255);
/// The far terminal's reply to the startup queries: focus, bracketed paste, a cursor report,
/// Kitty keyboard, and DA1. (DECRQM 2026 belongs to the synchronized-output model.)
const replies = "\x1b[?1004;1$y\x1b[?2004;2$y\x1b[1;1R\x1b[?0u\x1b[?62;22c";
const lines_max = 30;
const words_per_line = 6;
const words_max = lines_max * words_per_line;

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
    /// I1 in writer mode: owner sink writes before the run's end (exit may still drain).
    owner_running_writes: u32 = 0,
    /// Writer mode: polls that found the copy still in flight, and copies taken back at exit.
    writer_polls: u64 = 0,
    writer_reclaims: u32 = 0,
    /// Writers created while the run ends: exit after a take-back starts no new thread.
    exit_writers: u32 = 0,
    /// I12: a collect that left the writer idle while output was queued.
    writer_idle_gaps: u32 = 0,
    keys_sent: u64 = 0,
    keys_seen: u64 = 0,
    keys_delayed: u64 = 0,
    key_wait_max_ns: u64 = 0,
    /// I2: a paint accepted while a frame was in flight, a count out of step, or a frame
    /// presented before all its bytes were in the pty (R5).
    second_frames: u32 = 0,
    /// I4: queued feed bytes above the limit, and the Context's peak live bytes (the limit
    /// itself is `context_bytes_max`).
    feed_overflows: u32 = 0,
    live_peak_bytes: u64 = 0,
    /// I5: outside bytes inside a Session escape sequence or scalar.
    cut_tokens: u32 = 0,
    /// I5 strict: cuts after an owner write that stopped inside its span. Blocking writes of
    /// whole spans never do; only partial and non-blocking writes may.
    cuts_mid_span: u32 = 0,
    /// I6: decoded screens that differ from the frame they end, or from the presented frame
    /// at quiescence.
    frame_mismatches: u32 = 0,
    quiescent_mismatches: u32 = 0,
    decoded_frames: u64 = 0,
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
    /// Hangups while a frame was in flight.
    hangups_in_frame: u32 = 0,
    discontinuities: u32 = 0,
    /// I13: replies lost or rejected, or capabilities and far-terminal modes that differ from
    /// the replies.
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
const invariant_fields = [_][]const u8{ "second_frames", "feed_overflows", "cut_tokens", "cuts_mid_span", "frame_mismatches", "quiescent_mismatches", "restore_missing", "modes_left", "stale_bytes", "slow_drains", "bad_failures", "discontinuities", "reply_errors", "input_mismatches", "writer_idle_gaps" };

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
    /// The writer thread's steps, each a world event with its own tiebreak.
    writer_pick,
    writer_write,
    writer_publish,

    fn owner(kind: Kind) bool {
        return @backingInt(kind) < @backingInt(Kind.tick);
    }
};

const Event = struct { at_ns: u64, order: u64, kind: Kind, arg: u64 = 0 };

fn earlier(_: void, a: Event, b: Event) std.math.Order {
    if (a.at_ns != b.at_ns) return std.math.order(a.at_ns, b.at_ns);
    return std.math.order(a.order, b.order);
}

const Queue = std.PriorityQueue(Event, void, earlier);

/// An event kind that has at most one live event: later posts supersede earlier ones.
const Slot = struct {
    generation: u64 = 0,
    at: ?u64 = null,

    /// Whether the event is the live one; it clears the slot.
    fn take(slot: *Slot, event: Event) bool {
        if (event.arg != slot.generation) return false;
        slot.at = null;
        return true;
    }
};

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
        /// Replies that came while active turned the detected modes on (I13).
        replied,
    },
};

/// One decoded input event, for I14.
const Decoded = struct { kind: u8, code: u32, modifiers: u8, raw: u64 };

const Phase = enum { running, settling, ending, done };

const VtStream = @typeInfo(@TypeOf(vt_decode.Terminal.vtStream)).@"fn".return_type.?;

const Sim = struct {
    env: presets.Env,
    random: std.Random,
    debug: *ContextAllocator,
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
    // Scene: a ring of words, each a vocabulary index and a color.
    body: context.Handle = undefined,
    status: context.Handle = undefined,
    words: [words_max][2]u8 = undefined,
    /// Words streamed so far, the history included: word `i` is `words[i % words_max]`.
    word_count: u32 = words_max,
    tokens: u32 = 0,
    spinner: u32 = 0,
    /// Timers on a grid, as the harness app's: a stalled owner catches up on its next turn.
    next_token_ns: u64 = 0,
    next_produce_ns: u64 = 0,
    // Driver.
    turn_slot: Slot = .{},
    render_slot: Slot = .{},
    tick_slot: Slot = .{},
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
    snapshots: std.ArrayList(?vt_decode.Cells) = .empty,
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
    /// An error from world events run inside a blocking sink write, which drainOutput would
    /// otherwise take for a transport failure.
    inner_error: ?anyerror = null,
    // Writer mode: the writer the Session holds, or one cancel left writing (it frees itself on
    // its publish); its step chain's generation; its blocking write in the pty's queue; and the
    // owner's poll backoff.
    writer: ?*SimWriter = null,
    writer_orphan: bool = false,
    writer_generation: u64 = 0,
    writer_queued: ?struct { limit: usize, hangup_after: ?presets.FaultKind, span_left: usize } = null,
    writer_ok: bool = false,
    post_since: u64 = 0,
    polls: u32 = 0,

    fn init(sim: *Sim, env: presets.Env, random: std.Random, debug: *ContextAllocator, script_events: u32, print_trace: bool) !void {
        const f = try fixture.Fixture.init(debug.allocator(), env.cols, env.rows, .{
            .output = .{ .chunk_size = env.chunk_size, .chunk_count = 8 * 1024 * 1024 / env.chunk_size, .span_capacity = 128, .control_capacity = 4096 },
            .renderer = .{ .remote_mode = .remote, .forwarded_env = &.{} },
        });
        errdefer f.deinit();
        sim.* = .{
            .env = env,
            .random = random,
            .debug = debug,
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
        sim.next_token_ns = sim.jittered(token_period_ns);
        try sim.post(.token, sim.next_token_ns, 0);
        try sim.post(.spinner, sim.jittered(83 * ms), 0);
        try sim.post(.key_send, sim.jittered(env.events.key_period_ns), 0);
        // A Writable sink owns its channel (an ssh channel, a socket): no outside writer shares it.
        if (env.external != null and env.output_mode == .sync_drain) try sim.post(.external, sim.jittered(env.external.?.period_ns), 0);
        // Inside the run's first two seconds: a run streams `script_events` tokens, 20 ms apart.
        for (0..env.events.resizes) |_| try sim.post(.resize, 200 * ms + random.uintLessThan(u64, 1600 * ms), 0);
        for (0..env.events.suspends) |_| try sim.post(.suspend_start, 400 * ms + random.uintLessThan(u64, 1600 * ms), 0);
        sim.next_produce_ns = sim.jittered(sim.producePeriod());
        if (env.events.producers) try sim.post(.produce, sim.next_produce_ns, 0);
    }

    fn deinit(self: *Sim) void {
        self.far_stream.deinit();
        self.far.deinit(testing.allocator);
        self.link.deinit();
        for (self.snapshots.items) |maybe| if (maybe) |snapshot| freeCells(snapshot);
        inline for (.{ &self.checkpoints, &self.snapshots, &self.input, &self.pieces, &self.decoded, &self.reply_seen }) |list| list.deinit(gpa);
        self.owner_queue.deinit(gpa);
        self.world_queue.deinit(gpa);
        gpa.free(self.host_buffer);
        // A run that stopped early leaves the Session busy; cancel it so the Context can go.
        self.cancel();
        self.f.deinit();
        if (self.writer_orphan) if (self.writer) |writer| gpa.destroy(writer);
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

    /// One pending event per slot, the earliest asked for; a superseded one does nothing.
    fn schedule(self: *Sim, slot: *Slot, kind: Kind, at_ns: u64) !void {
        if (slot.at) |at| if (at <= at_ns) return;
        slot.generation += 1;
        slot.at = at_ns;
        try self.post(kind, at_ns, slot.generation);
    }

    fn scheduleTurn(self: *Sim, at_ns: u64) !void {
        try self.schedule(&self.turn_slot, .turn, at_ns);
    }

    fn requestRender(self: *Sim) !void {
        self.dirty = true;
        if (self.render_slot.at != null) return;
        try self.schedule(&self.render_slot, .render, if (self.last_frame_ns) |last| @max(self.now, last + frame_interval_ns) else self.now);
    }

    fn wakeLink(self: *Sim) !void {
        try self.schedule(&self.tick_slot, .tick, self.link.nextWake(self.now) orelse return);
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
        for (&self.words) |*word| word.* = .{ self.random.uintLessThan(u8, vocabulary.len), self.random.int(u8) };
        try self.setBody();
        try self.setStatus();
    }

    const vocabulary = [_][]const u8{ "the", "stream", "renders", "tokens", "across", "a", "slow", "link", "while", "keys", "wait", "frames" };

    /// The last lines, whole: a word changes only the last line, and a new line scrolls.
    fn setBody(self: *Sim) !void {
        var text: [words_max * 8]u8 = undefined;
        var chunks: [words_max]context.StyledTextChunk = undefined;
        const count = words_max - words_per_line + self.word_count % words_per_line;
        var len: usize = 0;
        for (chunks[0..count], self.word_count - count..) |*chunk, index| {
            const word = self.words[index % words_max];
            const bytes = vocabulary[word[0]];
            @memcpy(text[len..][0..bytes.len], bytes);
            text[len + bytes.len] = if (index % words_per_line == words_per_line - 1) '\n' else ' ';
            len += bytes.len + 1;
            const color = word[1];
            chunk.* = .{ .byte_count = @intCast(bytes.len + 1), .foreground = ansi.rgbColor(120 + color % 128, 200 - color % 100, 80 + color / 2, 255) };
        }
        try self.f.owner.sceneSetStyledText(self.body, text[0..len], chunks[0..count]);
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

    /// Script events run until the run's tokens are spent.
    fn running(self: *const Sim) bool {
        return self.phase == .running and self.script_left != 0;
    }

    fn producePeriod(self: *const Sim) u64 {
        return if (self.env.events.flood) 50 * ms else 300 * ms;
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
                std.debug.print("OUTPUT SIM deadlock at {d} ns: phase {t}, transition {t}, dirty {}, render {?d}, drained {}, link {}, fed {d}/{d}, input {d}/{d}, lifecycle {t}\n", .{ self.now, self.phase, self.transition, self.dirty, self.render_slot.at, value.isDrained(), self.link.drained(), self.fed, self.link.wire.items.len, self.read_input, self.input.items.len, value.lifecycle.phase });
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
        if (self.print_trace) std.debug.print("{d:>12} {t} {d}\n", .{ self.now, event.kind, event.arg });
        for ([_]u64{ self.now, @backingInt(event.kind), event.arg }) |word| {
            self.stats.trace = (self.stats.trace ^ word) *% 0x100000001b3;
        }
    }

    fn runWorld(self: *Sim, event: Event) anyerror!void {
        switch (event.kind) {
            .tick => {
                if (!self.tick_slot.take(event)) return;
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
                    self.collectFinished();
                }
                try self.post(.external, self.jittered(external.period_ns), 0);
            },
            .key_send => {
                if (!self.running()) return;
                self.stats.keys_sent += 1;
                try self.sendInput(if (self.random.uintLessThan(u32, 3) == 0) "\x1b[A" else "x", self.now);
                try self.post(.key_send, self.jittered(self.env.events.key_period_ns), 0);
            },
            .writer_pick, .writer_write, .writer_publish => try self.writerStep(event),
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
                if (!self.turn_slot.take(event)) return;
                try self.turn();
            },
            .render => {
                if (!self.render_slot.take(event)) return;
                try self.render();
            },
            .token => {
                if (!self.running()) return;
                // Every token due since the last turn, as the harness app appends them.
                while (self.next_token_ns <= self.now and self.script_left != 0) {
                    self.words[self.word_count % words_max] = .{ self.random.uintLessThan(u8, vocabulary.len), self.random.int(u8) };
                    self.word_count += 1;
                    self.tokens += 1;
                    self.script_left -= 1;
                    self.next_token_ns += token_period_ns / 2 + self.random.uintLessThan(u64, token_period_ns);
                }
                try self.setBody();
                try self.mutated();
                try self.post(.token, self.next_token_ns, 0);
            },
            .spinner => {
                if (!self.running()) return;
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
                if (!self.running() or self.transition != .none or self.failed) return;
                try self.f.owner.suspendSession(self.f.id);
                self.transition = .suspending;
                try self.scheduleTurn(self.now);
            },
            .resume_start => {
                try self.f.owner.resumeSession(self.f.id);
                self.transition = .resuming;
                try self.scheduleTurn(self.now);
            },
            .produce => {
                if (!self.running()) return;
                while (self.next_produce_ns <= self.now) : (self.next_produce_ns += self.jittered(self.producePeriod()) - self.now) try self.produce();
                try self.post(.produce, self.next_produce_ns, 0);
            },
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
        self.stats.live_peak_bytes = @max(self.stats.live_peak_bytes, self.debug.total_requested_bytes);
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
        return !self.dirty and self.render_slot.at == null and value.isDrained() and self.host == null and
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
            if (host.failed) return self.onError(error.SessionFailed);
            try self.afterOutput();
        };
        const expired = if (self.close_deadline) |deadline| self.now >= deadline else false;
        // Writer mode, as the driver: collect (and start the next copy) before the pump, so the
        // pump sees output the writer finished, even on a late turn.
        if (self.env.output_mode == .writer and self.sessionValue().pending_post) {
            if (!try self.postWriter(drain_budget)) return;
            if (self.sessionValue().pending_post) {
                if (expired) {
                    self.cancel();
                    self.stats.restore_missing += 1;
                    return self.endAfterOwner();
                }
                return self.schedulePoll();
            }
        }
        const result = owner.pumpSession(self.f.id, self.now, 1) catch |err| return self.onError(err);
        if (expired and result.status != .closed) {
            // The driver cancels without restoration when graceful close times out.
            self.cancel();
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
                // The stop waits for the rest of a split key: split gaps stay below the parser's timeout.
                if (self.pieces.getLastOrNull()) |last| if (last.at_ns >= self.now) return self.scheduleTurn(last.at_ns + 1);
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
            .writer => {
                if (!try self.postWriter(drain_budget)) return;
                if (self.sessionValue().pending_post) return self.schedulePoll();
                try self.scheduleTurn(self.now);
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

    // Writer mode: the driver's post and poll, and the writer thread's steps.

    /// One post as the driver's: collect a finished copy and start the next. False: the
    /// transport failed and `onError` took it.
    fn postWriter(self: *Sim, max_bytes: u32) !bool {
        const value = self.sessionValue();
        const was_posted = value.pending_post;
        const result = value.postStdout(SimWriter, SimCreate{ .sim = self }, max_bytes, false) catch |err| {
            self.syncWriter();
            try self.onError(err);
            return false;
        };
        self.syncWriter();
        // I12: collecting starts the next copy in the same call when output is queued.
        if (result.written != 0 and !result.in_flight and max_bytes != 0 and (value.span != null or value.output.hasPendingSpans())) {
            self.stats.writer_idle_gaps += 1;
        }
        if (result.written != 0) try self.afterOutput();
        if (result.in_flight) {
            if (!was_posted or result.written != 0) {
                try self.startedWriter();
            } else {
                self.polls += 1;
                self.stats.writer_polls += 1;
            }
        }
        return true;
    }

    fn startedWriter(self: *Sim) !void {
        self.writer_generation += 1;
        try self.post(.writer_pick, self.now, self.writer_generation);
        self.post_since = self.now;
        self.polls = 0;
        self.stats.owner_writes += 1;
        self.noteWrite();
    }

    /// The driver's backoff: the next turn for the first 64 polls within 0.5 ms, then an eighth
    /// of the copy's age, from 1 ms to 50 ms.
    fn schedulePoll(self: *Sim) !void {
        const age = self.now - self.post_since;
        const delay: u64 = if (self.polls < 64 and age < ms / 2) 0 else std.math.clamp(age / 8, ms, 50 * ms);
        try self.scheduleTurn(self.now + delay);
    }

    /// The writer the Session holds; a writer that cancel left writing stays until its publish.
    fn syncWriter(self: *Sim) void {
        if (self.writer_orphan) return;
        self.writer = if (self.sessionValue().stdout_post) |held| @ptrCast(@alignCast(held.ptr)) else null;
    }

    fn cancel(self: *Sim) void {
        if (self.writer) |writer| if (!self.writer_orphan and writer.state.load(.acquire) == .writing) {
            self.writer_orphan = true;
        };
        self.f.owner.cancelSession(self.f.id) catch {};
        self.syncWriter();
    }

    fn writerStep(self: *Sim, event: Event) !void {
        if (event.arg != self.writer_generation) return;
        const writer = self.writer orelse return;
        switch (event.kind) {
            .writer_pick => {
                if (self.env.writer_stops_ns) |at| if (self.now >= at) return;
                if (writer.pick()) try self.post(.writer_write, self.now, event.arg);
            },
            // As the thread: after a cancel only a write already inside the kernel goes on.
            .writer_write => switch (if (self.writer_queued == null and writer.state.load(.acquire) == .stop) .failed else writer.writeStep()) {
                .more => {
                    const wake = self.link.nextWake(self.now) orelse self.now;
                    try self.post(.writer_write, @max(wake, self.now + 1), event.arg);
                },
                .written, .failed => |step| {
                    if (self.inner_error) |err| return err;
                    self.writer_ok = step == .written;
                    try self.post(.writer_publish, self.now, event.arg);
                },
            },
            .writer_publish => if (!writer.publish(self.writer_ok)) {
                // Cancel stopped it while it wrote: the thread frees it.
                writer.allocator.destroy(writer);
                self.writer = null;
                self.writer_orphan = false;
            },
            else => unreachable,
        }
    }

    /// The exit wait: the world runs (the writer steps included) until the writer's state
    /// changes. A bounded wait gives up after the grace a real exit gives a thread to start.
    fn waitWriter(self: *Sim, expected: stdout_writer.State, bounded: bool) void {
        const limit = self.now + 100 * ms;
        var steps: u32 = 0;
        while (self.writer) |writer| : (steps += 1) {
            if (steps > 4_000_000) @panic("OUTPUT SIM: the exit wait made no progress");
            if (writer.state.load(.acquire) != expected) return;
            const next = self.world_queue.peek() orelse {
                if (bounded) return;
                @panic("OUTPUT SIM: the exit wait has no event left");
            };
            if (bounded and next.at_ns > limit) {
                self.now = @max(self.now, limit);
                return;
            }
            const event = self.world_queue.pop().?;
            // A wait while the run runs would be the owner waiting on output (I1).
            if (!self.ended and self.phase != .ending) self.stats.blocked_ns += event.at_ns -| self.now;
            self.now = @max(self.now, event.at_ns);
            self.traceEvent(event);
            self.runWorld(event) catch |err| {
                self.inner_error = err;
                return;
            };
        }
    }

    fn afterOutput(self: *Sim) !void {
        const frame = self.frame orelse return;
        if (self.sessionValue().frame_end_offset != null) return;
        self.frame = null;
        if (self.failed) return;
        // R5: a frame presents only once all its bytes are in the pty.
        if (self.link.session_end < frame.end) self.stats.second_frames += 1;
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
            try self.snapshots.append(gpa, try copyCells(.of(self.f.cli.currentRenderBuffer)));
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

    /// One producer call; a flood sends a title and a 1 MiB OSC 52 each time. What each gets at
    /// the limit is recorded: accepted, refused (`false`), or an error other than OOM.
    fn produce(self: *Sim) !void {
        const owner = self.f.owner;
        const id = self.f.id;
        var title: [32]u8 = undefined;
        const kinds: []const u32 = if (self.env.events.flood) &.{ 0, 5 } else &.{self.random.uintLessThan(u32, 5)};
        for (kinds) |kind| {
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
            } else |err| {
                if (err == error.OutOfMemory) return err;
                self.stats.produce_errors += 1;
            }
        }
        try self.scheduleTurn(self.now);
    }

    // Input: pieces arrive, the owner reads what has arrived when it runs.

    fn sendInput(self: *Sim, bytes: []const u8, at_ns: u64) !void {
        var cut: usize = bytes.len;
        var gap: u64 = 0;
        if (self.env.events.split_gap_ns) |gap_max| if (bytes.len > 1) {
            cut = 1 + self.random.uintLessThan(usize, bytes.len - 1);
            gap = self.random.uintAtMost(u64, gap_max);
        };
        for ([_][]const u8{ bytes[0..cut], bytes[cut..] }, [_]u64{ at_ns, at_ns + gap }) |piece, sent_at| {
            if (piece.len == 0) continue;
            // One ordered stream: a piece arrives after the one before it, never with it.
            const at = if (self.pieces.getLastOrNull()) |last| @max(sent_at, last.at_ns + 1) else sent_at;
            try self.input.appendSlice(gpa, piece);
            try self.pieces.append(gpa, .{ .end = @intCast(self.input.items.len), .at_ns = at });
            try self.post(.input_arrive, at, self.pieces.items.len - 1);
        }
    }

    fn readInput(self: *Sim) !void {
        const start = self.read_input;
        if (start == self.arrived_input) return;
        if (self.print_trace) std.debug.print("  read {any}\n", .{self.input.items[start..self.arrived_input]});
        // From the oldest unread byte's arrival, only the owner's time inside output writes
        // counts (I1), not a stop.
        self.read_wait_ns = for (self.pieces.items) |piece| {
            if (piece.end <= start) continue;
            std.debug.assert(self.stats.blocked_ns - piece.blocked_ns <= self.now - piece.at_ns);
            break self.stats.blocked_ns - piece.blocked_ns;
        } else 0;
        self.read_input = self.arrived_input;
        try self.feed(self.input.items[start..self.read_input]);
    }

    fn feed(self: *Sim, bytes: []const u8) !void {
        var rest = bytes;
        while (true) {
            var sink: input_parser.Sink = .{ .events = &self.events, .payload = &self.payload };
            const result = self.f.owner.sessionInputFeed(self.f.id, rest, self.now, &sink) catch |err| {
                // A closing Session takes no input: I14 compares only what was fed.
                if (err == error.SessionClosed and self.transition == .closing) {
                    self.read_input -= @intCast(rest.len);
                    return;
                }
                return self.onError(err);
            };
            for (self.events[0..sink.count]) |event| try self.onInput(event, sink.raw(event));
            if (result.consumed == 0 and rest.len != 0) return error.InputSinkFull;
            rest = rest[result.consumed..];
            if (result.deadline_ns) |deadline| try self.post(.input_deadline, deadline, 0);
            if (rest.len == 0) return;
        }
    }

    fn onInput(self: *Sim, event: input_parser.Event, raw: []const u8) !void {
        if (self.print_trace) std.debug.print("  input kind {d} code {d} raw {any}\n", .{ event.kind, event.code, raw });
        try self.decoded.append(gpa, .{ .kind = event.kind, .code = event.code, .modifiers = event.modifiers, .raw = std.hash.Wyhash.hash(0, raw) });
        switch (@as(input_parser.Kind, @fromBackingInt(@intCast(event.kind)))) {
            .key => {
                self.stats.keys_seen += 1;
                self.stats.key_wait_max_ns = @max(self.stats.key_wait_max_ns, self.read_wait_ns);
                if (self.read_wait_ns != 0) self.stats.keys_delayed += 1;
                try self.setStatus();
                try self.mutated();
            },
            .reply => {
                try self.reply_seen.appendSlice(gpa, raw);
                // As the TS driver: a fragment is not a reply to apply.
                if (event.flags & input_parser.flags.reply_fragment != 0) {
                    self.stats.reply_errors += 1;
                    return;
                }
                self.f.owner.controlSession(self.f.id, .{ .capability_response = raw }) catch |err| switch (err) {
                    error.SessionClosed, error.SessionFailed => {},
                    else => {
                        self.stats.reply_errors += 1;
                    },
                };
                // The last reply (DA1) while active: the modes it enables follow it at once.
                if (raw[raw.len - 1] == 'c' and self.sessionValue().lifecycle.phase == .active) try self.checkpoint(.replied);
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
            // Outside writes are OSC markers that I5 counts; the decoder sees only the Session's
            // stream, so a cut does not hide later screens.
            if (segment.source == .session) {
                if (self.checkpoint_head < self.checkpoints.items.len) {
                    end = @min(end, self.fed + (self.checkpoints.items[self.checkpoint_head].offset - self.fed_session));
                }
                self.far_stream.nextSlice(self.link.wire.items[self.fed..end]);
                self.fed_session += end - self.fed;
            }
            self.fed = end;
        }
    }

    fn reach(self: *Sim, point: Checkpoint) !void {
        switch (point.kind) {
            .frame => |frame| {
                const snapshot = self.snapshots.items[frame.index].?;
                defer {
                    freeCells(snapshot);
                    self.snapshots.items[frame.index] = null;
                }
                if (frame.full) self.synced = true;
                if (!self.synced or snapshot.width != self.far.cols or snapshot.height != self.far.rows) return;
                self.stats.decoded_frames += 1;
                if (vt_decode.mismatch(&self.far, snapshot)) |found| {
                    if (self.print_trace) std.debug.print("  frame {d} differs at {d},{d}: {s}\n", .{ frame.index, found.x, found.y, found.field });
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
            .replied => if (!self.detectedModes()) {
                self.stats.reply_errors += 1;
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

    /// Counts a write or ticket that starts inside the frame in flight (I3).
    fn noteWrite(self: *Sim) void {
        const frame = &(self.frame orelse return);
        const at = self.sessionValue().completed_bytes;
        if (at >= frame.start and at < frame.end) frame.writes += 1;
    }

    fn nonblocking(self: *Sim) bool {
        for (self.env.faults) |fault| if (fault.kind == .eagain) switch (fault.at) {
            .ns => |at| if (self.now >= at and self.now < at + fault.duration_ns) return true,
            else => {},
        };
        return false;
    }

    /// I7: every byte the Session published is in the pty.
    fn expectAllWritten(self: *Sim) !void {
        if (self.link.session_end != self.published()) self.stats.restore_missing += 1;
    }

    /// I6 and I13 at quiescence: the screen, the replies, and the modes they turned on at the
    /// far terminal.
    fn checkQuiescent(self: *Sim) !void {
        if (self.synced and vt_decode.mismatch(&self.far, .of(self.f.cli.currentRenderBuffer)) != null) self.stats.quiescent_mismatches += 1;
        if (!self.replies_sent) return;
        const caps = self.f.cli.terminal.caps;
        if (!std.mem.eql(u8, self.reply_seen.items, replies)) self.stats.reply_errors += 1;
        if (!caps.focus_tracking or !caps.bracketed_paste or !caps.kitty_keyboard) self.stats.reply_errors += 1;
        if (!self.detectedModes()) self.stats.reply_errors += 1;
    }

    /// The modes the replies report, on at the far terminal.
    fn detectedModes(self: *Sim) bool {
        const modes = &self.far.modes;
        return modes.get(.focus_event) and modes.get(.bracketed_paste) and self.far.screens.active.kitty_keyboard.current().int() != 0;
    }

    fn onError(self: *Sim, err: anyerror) !void {
        switch (err) {
            error.SessionFailed => {
                // I10: only a hangup fails the transport, at once: the Session is failed, its
                // frame finished, and it takes no more output.
                const value = self.sessionValue();
                if (self.link.hangup == null or value.state != .failed or value.frame_end_offset != null) self.stats.bad_failures += 1;
                if (!self.failed) {
                    self.stats.hangups += 1;
                    self.stats.hangups_in_frame += @intFromBool(self.frame != null);
                }
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
                if (try self.restoreOnExit()) {
                    try self.expectAllWritten();
                    try self.checkpoint(.restored);
                } else if (!self.failed) self.stats.restore_missing += 1;
                try self.endAfterOwner();
            },
            .crash => {
                self.stats.crashes += 1;
                self.cancel();
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
        // The writer: wait for the running copy without a limit, then deliver the rest through it.
        var via_writer = self.env.output_mode == .writer and self.sessionValue().stdout_post != null;
        if (via_writer) {
            const posted = self.sessionValue().pending_post;
            const done = self.sessionValue().postStdout(SimWriter, SimCreate{ .sim = self }, 0, true) catch return false;
            self.syncWriter();
            if (self.inner_error) |err| return err;
            // A copy the thread never picked up came back: drain from here, without a new writer.
            if (posted and done.written == 0) {
                self.stats.writer_reclaims += 1;
                via_writer = false;
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
            if (via_writer) {
                const value = self.sessionValue();
                const started = value.postStdout(SimWriter, SimCreate{ .sim = self }, drain_budget, false) catch return false;
                self.syncWriter();
                if (started.in_flight) {
                    try self.startedWriter();
                    const done = value.postStdout(SimWriter, SimCreate{ .sim = self }, 0, true) catch return false;
                    self.syncWriter();
                    if (self.inner_error) |err| return err;
                    if (done.written != 0) continue;
                    // The thread never picked the copy up: it is back in the queue.
                    self.stats.writer_reclaims += 1;
                }
                via_writer = false;
            }
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
        var rest: u64 = if (self.host) |host| host.ticket.len - host.done else 0;
        if (self.writer_orphan) if (self.writer) |writer| {
            rest += writer.len - writer.done;
        };
        self.closed_at = self.link.session_end + rest;
        self.stats.virtual_ns = self.now;
        // The owner is done; the link drains on its own.
        try self.wakeLink();
    }

    fn finish(self: *Sim) !void {
        try self.link.advance(self.now);
        try self.feedTerminal();
        // I8: nothing from the Session entered the pty after close or cancel.
        if (self.closed_at) |at| if (self.link.session_end > at) {
            self.stats.stale_bytes += 1;
        };
        self.stats.cut_tokens = self.link.cut_tokens;
        self.stats.cuts_mid_span = self.link.cuts_mid_span;
        self.stats.discontinuities = self.link.discontinuities;
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
            if (!std.meta.eql(expected, actual)) {
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
        if (!sim.ended and sim.phase != .ending) sim.stats.owner_running_writes += 1;
        link.expectContinuous(sim.sessionValue().completed_bytes);
        if (link.hangup) |kind| return if (kind == .epipe) error.BrokenPipe else error.InputOutput;
        const fault = sim.hangupLimit(@min(bytes.len, sim.env.partial_max orelse bytes.len));
        if (fault.now) |kind| {
            link.hangup = kind;
            return if (kind == .epipe) error.BrokenPipe else error.InputOutput;
        }
        const limit = fault.limit;
        const hangup_after = fault.after;
        // What is left of the Session's span: a write that stops short of it ends mid-span.
        const value = sim.sessionValue();
        const span_left = value.span.?.len - value.span_offset;
        if (sim.nonblocking()) {
            const count = try link.writeNow(bytes[0..limit]);
            try sim.wakeLink();
            if (count == limit) link.hangup = hangup_after;
            if (count == 0) return error.WouldBlock;
            // A write cut short by a hangup ends the output; it leaves no span to enter.
            link.mid_span = count < span_left and link.hangup == null;
            sim.noteWrite();
            return count;
        }
        try link.enqueue(.{ .kind = .owner, .bytes = bytes, .limit = limit });
        try sim.wakeLink();
        // The JS thread is inside write(2): only the world moves until the pty takes the bytes.
        // The stall accrues as time passes, so input that arrives meanwhile sees only its share.
        const done = while (true) {
            if (takeOwner(link)) |writer| break writer.done;
            const event = sim.world_queue.pop() orelse return error.Deadlock;
            sim.stats.blocked_ns += event.at_ns -| sim.now;
            sim.now = @max(sim.now, event.at_ns);
            sim.traceEvent(event);
            try sim.runWorld(event);
        };
        if (done == limit) link.hangup = hangup_after;
        link.mid_span = done < span_left and link.hangup == null;
        sim.noteWrite();
        return done;
    }

    fn takeOwner(link: *link_model.Link) ?link_model.Writer {
        for (link.finished.items, 0..) |writer, index| if (writer.kind == .owner) return link.finished.orderedRemove(index);
        return null;
    }
};

/// The writer thread's fd 1 in the model. A blocking write waits in the pty's queue, holding
/// its write lock, until the pty takes the bytes; the stepped thread asks again on each step
/// (WouldBlock until then). A non-blocking one takes what fits, as the writer does after EAGAIN.
const WriterSink = struct {
    sim: *Sim,

    pub fn write(self: WriterSink, bytes: []const u8) stdout_writer.SinkError!usize {
        return self.writeOrFail(bytes) catch |err| switch (err) {
            error.WouldBlock, error.Failed => |e| e,
            else => {
                self.sim.inner_error = err;
                return error.Failed;
            },
        };
    }

    pub fn waitWritable(_: WriterSink) void {}

    fn writeOrFail(self: WriterSink, bytes: []const u8) anyerror!usize {
        const sim = self.sim;
        const link = &sim.link;
        if (sim.writer_queued) |queued| {
            const writer = SimSink.takeOwner(link) orelse return error.WouldBlock;
            sim.writer_queued = null;
            return finish(sim, writer.done, queued.limit, queued.hangup_after, queued.span_left);
        }
        const value = sim.sessionValue();
        const done = sim.writer.?.done;
        link.expectContinuous(value.completed_bytes + done);
        if (link.hangup != null) return error.Failed;
        const fault = sim.hangupLimit(@min(bytes.len, sim.env.partial_max orelse bytes.len));
        if (fault.now) |kind| {
            link.hangup = kind;
            return error.Failed;
        }
        // What is left of the Session's span after this write: a write that stops short of
        // it ends mid-span (I5's strict count).
        const span_left = value.span.?.len - value.span_offset - done;
        if (sim.nonblocking()) {
            const count = try link.writeNow(bytes[0..fault.limit]);
            try sim.wakeLink();
            if (count == 0) return error.WouldBlock;
            return finish(sim, count, fault.limit, fault.after, span_left);
        }
        try link.enqueue(.{ .kind = .owner, .bytes = bytes, .limit = fault.limit });
        try sim.wakeLink();
        sim.writer_queued = .{ .limit = fault.limit, .hangup_after = fault.after, .span_left = span_left };
        return self.writeOrFail(bytes);
    }

    fn finish(sim: *Sim, count: usize, limit: usize, hangup_after: ?presets.FaultKind, span_left: usize) usize {
        if (count == limit) sim.link.hangup = hangup_after;
        sim.link.mid_span = count < span_left and sim.link.hangup == null;
        return count;
    }
};

/// The stepped runner: no thread. The world runs the writer's steps; the exit wait runs the
/// world until the writer's state changes.
const SimRunner = struct {
    pub const threaded = false;
    pub const hook = null;
    sim: *Sim,

    pub fn waitChange(self: SimRunner, _: anytype, expected: stdout_writer.State, bounded: bool) void {
        self.sim.waitWriter(expected, bounded);
    }
};

const SimWriter = stdout_writer.Writer(WriterSink, SimRunner);

const SimCreate = struct {
    sim: *Sim,

    pub fn create(self: SimCreate) error{UnsupportedResource}!*SimWriter {
        if (self.sim.phase == .ending) self.sim.stats.exit_writers += 1;
        return SimWriter.create(gpa, .{ .sim = self.sim }, .{ .sim = self.sim });
    }
};

fn copyCells(cells: vt_decode.Cells) !vt_decode.Cells {
    var copy = cells;
    copy.char = try gpa.dupe(u32, cells.char);
    copy.fg = try gpa.dupe(ansi.RGBA, cells.fg);
    copy.bg = try gpa.dupe(ansi.RGBA, cells.bg);
    copy.attributes = try gpa.dupe(u32, cells.attributes);
    return copy;
}

fn freeCells(cells: vt_decode.Cells) void {
    gpa.free(cells.char);
    gpa.free(cells.fg);
    gpa.free(cells.bg);
    gpa.free(cells.attributes);
}

/// CI's screen: presets are written at the harness's 100x32 and scaled down (`presets.scaled`).
const ci_size = [2]u16{ 60, 16 };

const Run = struct {
    name: []const u8,
    mode: presets.OutputMode,
    seed: u64,
    /// Tokens streamed, 20 ms apart: the run's length.
    events: u32 = 200,
    size: [2]u16 = ci_size,
    print_trace: bool = false,
};

/// One seeded run. Every invariant is checked per run, so a failure names its seed and trace,
/// and a replay of that seed fails the same way.
fn runOne(run: Run) !Stats {
    var scaled_faults: [8]presets.Fault = undefined;
    const base = presets.scaled(presets.find(run.name) orelse return error.UnknownPreset, run.size[0], run.size[1], &scaled_faults);
    var prng = std.Random.DefaultPrng.init(run.seed);
    const random = prng.random();
    var faults: [8]presets.Fault = undefined;
    var env = presets.jitter(base, random, &faults);
    env.output_mode = run.mode;
    var debug: ContextAllocator = .init;
    debug.requested_memory_limit = context_bytes_max;
    defer if (debug.deinit() == .leak) @panic("OUTPUT SIM leaked Context memory");
    var sim: Sim = undefined;
    try sim.init(env, random, &debug, run.events, run.print_trace);
    defer sim.deinit();
    errdefer std.debug.print("OUTPUT SIM {s} {t} seed {d} failed at {d} ns, trace {x}\n", .{ run.name, run.mode, run.seed, sim.now, sim.stats.trace });
    try sim.run();
    inline for (invariant_fields) |field| {
        if (@field(sim.stats, field) != 0 and !allowed(run.name, run.mode, field)) {
            std.debug.print("OUTPUT SIM {s}: {d}\n", .{ field, @field(sim.stats, field) });
            return error.InvariantFailed;
        }
    }
    return sim.stats;
}

fn add(total: *Stats, stats: Stats) void {
    inline for (@typeInfo(Stats).@"struct".field_names) |name| {
        if (comptime std.mem.endsWith(u8, name, "_max_ns") or std.mem.endsWith(u8, name, "_max") or std.mem.endsWith(u8, name, "_peak_bytes")) {
            @field(total, name) = @max(@field(total, name), @field(stats, name));
        } else if (comptime std.mem.eql(u8, name, "trace")) {
            total.trace = std.hash.Wyhash.hash(total.trace, std.mem.asBytes(&stats.trace));
        } else @field(total, name) += @field(stats, name);
    }
}

fn printStats(name: []const u8, mode: presets.OutputMode, stats: Stats) void {
    const seconds = @as(f64, @floatFromInt(stats.virtual_ns)) / std.time.ns_per_s;
    std.debug.print("{s:<16} {t:<10} runs {d:>3} fps {d:>5.1} B/frame {d:>6} max {d:>6} mut/frame {d:>4.2} multi {d:>4} blocked {d:>5.1}% keys {d}/{d} delayed {d} wait max {d} ms peak {d} KiB produced {d}/{d}/{d}\n", .{
        name,                                                                                         mode,
        stats.runs,                                                                                   @as(f64, @floatFromInt(stats.presented)) / seconds,
        stats.frame_bytes / @max(1, stats.presented),                                                 stats.frame_bytes_max,
        @as(f64, @floatFromInt(stats.mutations)) / @as(f64, @floatFromInt(@max(1, stats.presented))), stats.multi_ticket_frames,
        @as(f64, @floatFromInt(stats.blocked_ns)) * 100 / @as(f64, @floatFromInt(stats.virtual_ns)),  stats.keys_seen,
        stats.keys_sent,                                                                              stats.keys_delayed,
        stats.key_wait_max_ns / ms,                                                                   stats.live_peak_bytes / 1024,
        stats.produced,                                                                               stats.produce_refused,
        stats.produce_errors,
    });
    inline for (invariant_fields) |field| if (@field(stats, field) != 0) std.debug.print("    {s}: {d}\n", .{ field, @field(stats, field) });
}

fn environment(arena: std.mem.Allocator, key: []const u8) ?[]const u8 {
    return std.testing.environ.getAlloc(arena, key) catch null;
}

fn environmentInt(comptime T: type, arena: std.mem.Allocator, key: []const u8) !?T {
    return try std.fmt.parseInt(T, environment(arena, key) orelse return null, 10);
}

test "OUTPUT SIM seeds" {
    if (!@import("ghostty_vt_options").available) return error.SkipZigTest;
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    if (try environmentInt(u64, arena, "OUTPUT_SIM_SEED")) |seed| {
        var run: Run = .{ .name = environment(arena, "OUTPUT_SIM_PRESET") orelse "ssh_slow", .mode = .sync_drain, .seed = seed, .print_trace = environment(arena, "OUTPUT_SIM_TRACE") != null };
        if (environment(arena, "OUTPUT_SIM_MODE")) |text| run.mode = std.meta.stringToEnum(presets.OutputMode, text) orelse return error.UnknownMode;
        if (try environmentInt(u32, arena, "OUTPUT_SIM_EVENTS")) |events| run.events = events;
        if (environment(arena, "OUTPUT_SIM_SIZE")) |text| {
            var parts = std.mem.splitScalar(u8, text, 'x');
            run.size = .{ try std.fmt.parseInt(u16, parts.first(), 10), try std.fmt.parseInt(u16, parts.next() orelse return error.InvalidSize, 10) };
        }
        const stats = try runOne(run);
        printStats(run.name, run.mode, stats);
        std.debug.print("trace {x}\n", .{stats.trace});
        return;
    }
    const summary = environment(arena, "OUTPUT_SIM_SUMMARY") != null;
    const seeds = try environmentInt(u64, arena, "OUTPUT_SIM_SEEDS");
    const Plan = struct { presets: []const presets.Preset, mode: presets.OutputMode, seeds: ?u64 };
    const plans = [_]Plan{
        .{ .presets = &presets.named, .mode = .sync_drain, .seeds = 6 },
        .{ .presets = &presets.sweep, .mode = .sync_drain, .seeds = null },
        .{ .presets = &presets.ticket, .mode = .ticket, .seeds = 2 },
        .{ .presets = &presets.named, .mode = .writer, .seeds = 6 },
        .{ .presets = &presets.sweep, .mode = .writer, .seeds = null },
        .{ .presets = &presets.writer_only, .mode = .writer, .seeds = null },
    };
    var failures: u32 = 0;
    var cuts: u64 = 0;
    var traces: [presets.named.len][4]u64 = undefined;
    var replays: usize = traces[0].len;
    for (plans) |plan| for (plan.presets, 0..) |preset, index| {
        var total: Stats = .{};
        const ci_seeds = plan.seeds orelse preset.ci_seeds;
        for (0..seeds orelse ci_seeds) |seed| {
            const stats = try runOne(.{ .name = preset.name, .mode = plan.mode, .seed = seed });
            if (plan.presets.ptr == &presets.named and plan.mode == .sync_drain and seed < replays) traces[index][seed] = stats.trace;
            add(&total, stats);
        }
        if (plan.presets.ptr == &presets.named) replays = @min(replays, seeds orelse ci_seeds);
        if (summary) printStats(preset.name, plan.mode, total);
        if (plan.mode == .sync_drain and preset.env.external != null) cuts += total.cut_tokens;
        // Known defects and coverage minimums hold over the CI seeds, not over fewer.
        if ((seeds orelse ci_seeds) < ci_seeds) continue;
        inline for (invariant_fields) |field| if (findKnown(preset.name, plan.mode, field)) |row| {
            if (row.required and @field(total, field) == 0) {
                std.debug.print("OUTPUT SIM {s} {t}: {s} = 0, a known defect no longer reproduces\n", .{ preset.name, plan.mode, field });
                failures += 1;
            }
        };
        try expectMinimums(preset.name, plan.mode, total);
    };
    try testing.expectEqual(@as(u32, 0), failures);
    // D1 reproduces on the presets with outside writers.
    if (seeds == null) try testing.expect(cuts > 0);
    // I11: the named presets' first seeds replay to the traces they had above.
    for (presets.named, traces) |preset, expected| for (expected[0..replays], 0..) |trace, seed| {
        try testing.expectEqual(trace, (try runOne(.{ .name = preset.name, .mode = .sync_drain, .seed = seed })).trace);
    };
    // A split arrow key typed at 58.1 ms, while the split startup replies are in flight.
    _ = try runOne(.{ .name = "split_input", .mode = .sync_drain, .seed = 22, .events = 10 });
    // An arrow key cut after ESC [ at 518 ms, while a suspend is under way.
    _ = try runOne(.{ .name = "split_input", .mode = .ticket, .seed = 73, .events = 30 });
}

/// Known `main` defects, recorded until their fix run deletes the row. A required row that
/// no longer reproduces fails, so a fix shows up here.
const Known = struct { preset: []const u8, field: []const u8, required: bool = true, mode: presets.OutputMode = .sync_drain };

const known = [_]Known{
    // D2: exit with fd 1 non-blocking gives up on a 0-byte drain, so the restore never leaves.
    .{ .preset = "exit_nonblocking", .field = "restore_missing" },
    // D3, an effect of the 388 stall: the owner, inside a write, reads the rest of a split input
    // sequence after the prefix's 20 ms deadline, and feedInput expires the prefix first (as
    // documented): an arrow key decodes as ESC, '[' and 'A', or ESC '[' as a reply fragment.
    .{ .preset = "split_input", .field = "input_mismatches" },
    .{ .preset = "split_input", .field = "reply_errors", .required = false },
    // Outside writers inside a span: as `main` does when someone else makes fd 1 non-blocking
    // (the 1 ms retry returns to the loop mid-span), and the XNU model, which lets another
    // writer into a blocking write.
    .{ .preset = "nonblock_flip", .field = "cuts_mid_span", .required = false },
    .{ .preset = "exit_nonblocking", .field = "cuts_mid_span", .required = false },
    .{ .preset = "macos_chunked", .field = "cuts_mid_span" },
    // The writer on a non-blocking fd writes what fits and polls, as the drain did: outside
    // writers may enter mid-span, and the XNU model lets them into a blocking write. D2 and D3
    // have no writer row: exit waits for the writer and restores (R30), and keys are read at once.
    .{ .preset = "nonblock_flip", .field = "cuts_mid_span", .required = false, .mode = .writer },
    .{ .preset = "exit_nonblocking", .field = "cuts_mid_span", .required = false, .mode = .writer },
    .{ .preset = "macos_chunked", .field = "cuts_mid_span", .required = false, .mode = .writer },
};

/// The ticket path runs without known rows.
fn findKnown(name: []const u8, mode: presets.OutputMode, field: []const u8) ?Known {
    for (known) |row| {
        if (row.mode == mode and std.mem.eql(u8, row.preset, name) and std.mem.eql(u8, row.field, field)) return row;
    }
    return null;
}

/// D1: an output publication larger than one feed chunk (a large frame, a long OSC 52) drains
/// in several write(2) calls, and an outside writer that waits for the tty lock enters between
/// them, inside an escape sequence. It may show wherever outside writers share fd 1.
fn allowed(name: []const u8, mode: presets.OutputMode, field: []const u8) bool {
    if (findKnown(name, mode, field) != null) return true;
    return std.mem.eql(u8, field, "cut_tokens") and presets.find(name).?.external != null;
}

/// I3 and coverage: each preset reaches what its invariants need.
fn expectMinimums(name: []const u8, mode: presets.OutputMode, total: Stats) !void {
    errdefer printStats(name, mode, total);
    const env = presets.find(name).?;
    if (mode == .writer) {
        // I1 in writer mode: the owner never writes while the run runs, and no key waits.
        try testing.expectEqual(@as(u32, 0), total.owner_running_writes);
        try testing.expectEqual(@as(u64, 0), total.blocked_ns);
        try testing.expectEqual(@as(u64, 0), total.keys_delayed);
        try testing.expectEqual(@as(u64, 0), total.key_wait_max_ns);
    }
    if (env.writer_stops_ns != null) {
        // The thread stops; every exit takes the posted copy back and still restores (R8).
        try testing.expectEqual(total.runs, total.exits);
        try testing.expectEqual(total.runs, total.writer_reclaims);
        try testing.expectEqual(@as(u32, 0), total.exit_writers);
        return;
    }
    try testing.expect(total.presented > 0 and total.commits >= total.presented);
    // Frames that span several writes or tickets occur. A writer copy holds a whole 64 KiB
    // chunk, so only seeds with 4 KiB chunks split frames: the named presets' six have some.
    if (mode != .writer or total.runs >= 6) try testing.expect(total.multi_ticket_frames > 0);
    if (env.faults.len != 0 and env.faults[0].kind == .eio) {
        // Every run hangs up, inside a frame in some, and the Session fails at once (I10).
        try testing.expectEqual(total.runs, total.hangups);
        try testing.expect(total.hangups_in_frame > 0);
        return;
    }
    try testing.expect(total.decoded_frames > 0 and total.suspends > 0);
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
    // A flood reaches the feed's limit: producers are refused (R23).
    if (env.events.flood) try testing.expect(total.produce_refused + total.produce_errors > 0);
}
