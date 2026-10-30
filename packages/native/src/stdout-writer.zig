//! Writes Session output to process stdout from a native thread, so the host's thread never
//! waits in write(2) on a slow terminal. The host hands over one copy at a time and collects it
//! on a later call; collecting completes the copy's ticket, which presents frames.
//!
//! One state word decides everything the two threads share:
//!   owner: copy into `buffer`, then `in_flight` (release), then wake;
//!   thread: `in_flight -> writing` (acquire), write, then `writing -> done_*` (acq_rel);
//!   owner: sees `done_*` (acquire), completes, back to `idle`.
//! Abandon swaps in `stop`. If it took the state from `writing`, the thread is inside write(2)
//! and frees the writer when its publish fails; the owner touches nothing after the swap but
//! the thread handle it copied before it, and detaches. Otherwise the owner joins and frees.
//!
//! The thread touches no Context memory: no Context `Io`, allocator, logger or Session. It uses
//! raw write(2) and poll(2), the process-wide futex, and memory from its own allocator, and the
//! library is pinned so a blocked writer never returns into unmapped code.
const std = @import("std");
const builtin = @import("builtin");

/// The most bytes one hand-over copies: the driver's drain budget.
pub const handover_max: u32 = 64 * 1024;

/// Other platforms keep the synchronous drain.
pub const supported = builtin.os.tag == .linux or builtin.os.tag == .macos;

pub const State = enum(u32) { idle, in_flight, writing, done_ok, done_failed, stop };

pub const SinkError = error{ WouldBlock, Interrupted, Failed };

pub const Outcome = enum { busy, written, failed, reclaimed };

/// A writer as the Session holds it: only cancel and destroy use it.
pub const Abandon = struct {
    ptr: *anyopaque,
    abandon: *const fn (*anyopaque) void,
};

/// Writers whose thread still runs, for tests that wait for a detached thread.
pub var live_threads: std.atomic.Value(u32) = .init(0);

/// The futex the thread and the owner share. Its wait and wake read no instance state.
fn io() std.Io {
    return std.Io.Threaded.global_single_threaded.io();
}

/// fd 1, or any fd in tests. Signals are blocked in the writer, so EPIPE fails the write.
pub const FdSink = struct {
    fd: std.posix.fd_t,

    pub fn write(self: FdSink, bytes: []const u8) SinkError!usize {
        const rc = std.c.write(self.fd, bytes.ptr, bytes.len);
        if (rc >= 0) return @intCast(rc);
        return switch (std.posix.errno(rc)) {
            .INTR => error.Interrupted,
            .AGAIN => error.WouldBlock,
            else => error.Failed,
        };
    }

    /// Someone else made the shared description non-blocking: wait for room. A poll error
    /// shows in the next write.
    pub fn waitWritable(self: FdSink) void {
        var fds = [_]std.posix.pollfd{.{ .fd = self.fd, .events = std.posix.POLL.OUT, .revents = 0 }};
        _ = std.c.poll(&fds, 1, -1);
    }
};

/// The production runner: one thread per writer. `after_write` runs between the write and the
/// publish; tests park there to race an abandon against the publish.
pub fn ThreadRunner(comptime after_write: ?fn () void) type {
    return struct {
        pub const threaded = true;
        pub const hook = after_write;
        thread: std.Thread = undefined,
    };
}

pub fn Writer(comptime Sink: type, comptime Runner: type) type {
    return struct {
        const Self = @This();

        state: std.atomic.Value(State) = .init(.idle),
        allocator: std.mem.Allocator,
        sink: Sink,
        runner: Runner,
        /// Thread-owned while in flight; the owner writes it only while idle.
        len: u32 = 0,
        done: u32 = 0,
        buffer: [handover_max]u8 = undefined,

        /// Starts the thread with every signal blocked but SIGTTOU (a background write still
        /// stops the process under `tostop`) and the synchronous faults.
        pub fn create(allocator: std.mem.Allocator, sink: Sink, runner: Runner) error{UnsupportedResource}!*Self {
            const self = allocator.create(Self) catch return error.UnsupportedResource;
            self.* = .{ .allocator = allocator, .sink = sink, .runner = runner };
            if (Runner.threaded) {
                var blocked = std.posix.sigfillset();
                for ([_]std.posix.SIG{ .TTOU, .SEGV, .BUS, .ILL, .FPE, .TRAP }) |sig| std.posix.sigdelset(&blocked, sig);
                var previous: std.posix.sigset_t = undefined;
                // XNU's sigprocmask sets the mask of every thread in the process.
                std.debug.assert(std.c.pthread_sigmask(std.posix.SIG.BLOCK, &blocked, &previous) == 0);
                defer std.debug.assert(std.c.pthread_sigmask(std.posix.SIG.SETMASK, &previous, &blocked) == 0);
                _ = live_threads.fetchAdd(1, .monotonic);
                self.runner.thread = std.Thread.spawn(.{}, threadMain, .{self}) catch {
                    _ = live_threads.fetchSub(1, .monotonic);
                    allocator.destroy(self);
                    return error.UnsupportedResource;
                };
            }
            return self;
        }

        pub fn handle(self: *Self) Abandon {
            return .{ .ptr = self, .abandon = abandonOpaque };
        }

        fn abandonOpaque(ptr: *anyopaque) void {
            const self: *Self = @ptrCast(@alignCast(ptr));
            self.abandon();
        }

        /// Owner: the first `len` bytes of `buffer` are the copy to write.
        pub fn start(self: *Self, len: u32) void {
            std.debug.assert(len > 0 and len <= handover_max);
            std.debug.assert(self.state.load(.monotonic) == .idle);
            self.len = len;
            self.done = 0;
            self.state.store(.in_flight, .release);
            if (Runner.threaded) io().futexWake(State, &self.state.raw, 1);
        }

        /// Owner: the result of the hand-over, once the thread published it.
        pub fn collect(self: *Self) Outcome {
            switch (self.state.load(.acquire)) {
                .in_flight, .writing => return .busy,
                .done_ok => {
                    self.state.store(.idle, .monotonic);
                    return .written;
                },
                .done_failed => {
                    self.state.store(.idle, .monotonic);
                    return .failed;
                },
                .idle, .stop => unreachable,
            }
        }

        /// Owner, at process exit: waits for a running write without a limit. A copy that the
        /// thread has not picked up within `grace_ns` is taken back unwritten (`reclaimed`);
        /// the caller then releases the writer and writes the bytes itself.
        pub fn waitCollect(self: *Self, grace_ns: u64) Outcome {
            var waited_in_flight = false;
            while (true) {
                const state = self.state.load(.acquire);
                switch (state) {
                    .done_ok, .done_failed => return self.collect(),
                    .in_flight => {
                        if (waited_in_flight) {
                            if (self.state.cmpxchgStrong(.in_flight, .stop, .acquire, .acquire) == null) return .reclaimed;
                            continue;
                        }
                        waited_in_flight = true;
                        self.waitChange(state, grace_ns);
                    },
                    .writing => self.waitChange(state, null),
                    .idle, .stop => unreachable,
                }
            }
        }

        fn waitChange(self: *Self, expected: State, timeout_ns: ?u64) void {
            if (Runner.threaded) {
                const timeout: std.Io.Timeout = if (timeout_ns) |ns| .{ .duration = .{ .raw = .fromNanoseconds(ns), .clock = .awake } } else .none;
                io().futexWaitTimeout(State, &self.state.raw, expected, timeout) catch {};
            } else self.runner.waitChange(self, expected, timeout_ns != null);
        }

        /// Owner: gives the writer up. Afterwards the owner must not use it.
        pub fn abandon(self: *Self) void {
            // The thread may free the writer as soon as the swap lands.
            const runner = self.runner;
            if (self.state.swap(.stop, .acq_rel) == .writing) {
                if (Runner.threaded) runner.thread.detach();
                return;
            }
            self.release();
        }

        /// Owner: the state is `stop` and the thread is not inside a write.
        pub fn release(self: *Self) void {
            std.debug.assert(self.state.load(.acquire) == .stop);
            if (Runner.threaded) {
                io().futexWake(State, &self.state.raw, 1);
                self.runner.thread.join();
            }
            self.allocator.destroy(self);
        }

        // The thread's steps. A stepped runner calls them one at a time.

        /// Takes the posted copy. False: the owner stopped the writer first.
        pub fn pick(self: *Self) bool {
            return self.state.cmpxchgStrong(.in_flight, .writing, .acquire, .acquire) == null;
        }

        pub const Step = enum { more, written, failed };

        /// One write attempt of the rest of the copy.
        pub fn writeStep(self: *Self) Step {
            const rest = self.buffer[self.done..self.len];
            const count = self.sink.write(rest) catch |err| switch (err) {
                error.Interrupted => return .more,
                error.WouldBlock => {
                    if (Runner.threaded) self.sink.waitWritable();
                    return .more;
                },
                error.Failed => return .failed,
            };
            if (count == 0 or count > rest.len) return .failed;
            self.done += @intCast(count);
            return if (self.done == self.len) .written else .more;
        }

        /// Publishes the result. False: the owner abandoned the writer meanwhile, and the
        /// caller must free it.
        pub fn publish(self: *Self, written: bool) bool {
            const result: State = if (written) .done_ok else .done_failed;
            if (self.state.cmpxchgStrong(.writing, result, .acq_rel, .acquire) != null) return false;
            if (Runner.threaded) io().futexWake(State, &self.state.raw, 1);
            return true;
        }

        fn threadMain(self: *Self) void {
            defer _ = live_threads.fetchSub(1, .release);
            while (true) {
                var state = self.state.load(.acquire);
                while (state == .idle or state == .done_ok or state == .done_failed) {
                    io().futexWaitUncancelable(State, &self.state.raw, state);
                    state = self.state.load(.acquire);
                }
                if (state == .stop or !self.pick()) return;
                var step: Step = .more;
                // After an abandon only a write already inside the kernel may finish: a write
                // that returned (EAGAIN, EINTR, a partial count) starts no new one.
                while (step == .more and self.state.load(.acquire) != .stop) step = self.writeStep();
                if (Runner.hook) |hook| hook();
                if (!self.publish(step == .written)) {
                    self.allocator.destroy(self);
                    return;
                }
            }
        }
    };
}

pub const StdoutWriter = Writer(FdSink, ThreadRunner(null));

/// Pins the image that holds this code, so a detached writer never returns into an unmapped
/// library. Code in the main executable cannot be unmapped and needs no pin.
pub fn pinLibrary() bool {
    if (builtin.os.tag == .macos) {
        var info: std.c.dl_info = undefined;
        if (std.c.dladdr(@ptrCast(&pinLibrary), &info) == 0) return false;
        // dyld's image 0 is the main executable.
        if (@intFromPtr(info.fbase) == @intFromPtr(std.c._dyld_get_image_header(0))) return true;
        return std.c.dlopen(info.fname, .{ .NOW = true, .NOLOAD = true, .NODELETE = true }) != null;
    }
    if (builtin.os.tag != .linux) return false;
    const Search = struct {
        address: usize,
        index: usize = 0,
        found: ?struct { index: usize, name: ?[*:0]const u8 } = null,
    };
    var search: Search = .{ .address = @intFromPtr(&pinLibrary) };
    std.posix.dl_iterate_phdr(&search, error{Found}, struct {
        fn visit(info: *std.posix.dl_phdr_info, _: usize, context: *Search) error{Found}!void {
            defer context.index += 1;
            for (info.phdr[0..info.phnum]) |phdr| {
                if (phdr.type != .LOAD) continue;
                if (segmentHolds(info.addr, phdr.vaddr, phdr.memsz, context.address)) {
                    context.found = .{ .index = context.index, .name = info.name };
                    return error.Found;
                }
            }
        }
    }.visit) catch {};
    const found = search.found orelse return false;
    if (found.index == 0) return true;
    const name = found.name orelse return false;
    return std.c.dlopen(name, .{ .NOW = true, .NOLOAD = true, .NODELETE = true }) != null;
}

/// Whether a loaded segment holds `address`. The ELF load bias is modular: a prelinked vDSO
/// or a library mapped below its link address wraps it, so the sum wraps too.
fn segmentHolds(bias: usize, vaddr: usize, size: usize, address: usize) bool {
    const start = bias +% vaddr;
    return address >= start and address - start < size;
}

/// Only a terminal on a supported platform gets a writer: pipes and files keep the
/// synchronous drain.
pub fn stdoutSupported() bool {
    if (comptime !supported) return false;
    return std.c.isatty(1) == 1;
}

// Real-thread tests. They import only std, so TSan runs them as one file:
// zig test -fllvm -fsanitize-thread -target x86_64-linux-gnu -lc src/stdout-writer.zig
// (without -fllvm the default backend ignores -fsanitize-thread).
const testing = std.testing;

/// A channel that one hand-over fills: fds[0] reads, fds[1] writes.
pub fn testPipe(capacity: c_int) ![2]std.posix.fd_t {
    var fds: [2]std.posix.fd_t = undefined;
    if (builtin.os.tag == .linux) {
        if (std.c.pipe(&fds) != 0) return error.Pipe;
        // F_SETPIPE_SZ.
        _ = std.c.fcntl(fds[1], 1031, capacity);
        return fds;
    }
    // macOS pipes hold 16 to 64 KiB and cannot shrink; a Unix stream socket holds its send buffer.
    if (std.c.socketpair(std.c.AF.UNIX, std.c.SOCK.STREAM, 0, &fds) != 0) return error.Pipe;
    _ = std.c.setsockopt(fds[1], std.c.SOL.SOCKET, std.c.SO.SNDBUF, std.mem.asBytes(&capacity), @sizeOf(c_int));
    return fds;
}

pub fn closeAll(fds: [2]std.posix.fd_t) void {
    for (fds) |fd| _ = std.c.close(fd);
}

pub fn readExactly(fd: std.posix.fd_t, out: []u8) !void {
    const deadline: Deadline = .init();
    var done: usize = 0;
    while (done < out.len) {
        var poll_fd: [1]std.c.pollfd = .{.{ .fd = fd, .events = std.c.POLL.IN, .revents = 0 }};
        if (std.c.poll(&poll_fd, 1, 10) == 0) {
            try deadline.check();
            continue;
        }
        const rc = std.c.read(fd, out[done..].ptr, out.len - done);
        if (rc <= 0) return error.ShortRead;
        done += @intCast(rc);
    }
}

/// The testing allocator, writing over memory as it frees it, so TSan sees the free of a large
/// writer (which the debug allocator unmaps without a write) race with a read.
const scribbling: std.mem.Allocator = .{ .ptr = undefined, .vtable = &.{
    .alloc = struct {
        fn alloc(_: *anyopaque, len: usize, alignment: std.mem.Alignment, ret_addr: usize) ?[*]u8 {
            return testing.allocator.rawAlloc(len, alignment, ret_addr);
        }
    }.alloc,
    .resize = std.mem.Allocator.noResize,
    .remap = std.mem.Allocator.noRemap,
    .free = struct {
        fn free(_: *anyopaque, memory: []u8, alignment: std.mem.Alignment, ret_addr: usize) void {
            @memset(memory, 0xaa);
            testing.allocator.rawFree(memory, alignment, ret_addr);
        }
    }.free,
} };

/// A test's wait on a writer thread fails after 10 s instead of hanging the test run.
pub const Deadline = struct {
    end_ns: u64,

    pub fn init() Deadline {
        return .{ .end_ns = monotonicNs() + 10 * std.time.ns_per_s };
    }

    /// Fails once the deadline has passed, else yields.
    pub fn check(self: Deadline) error{Timeout}!void {
        if (monotonicNs() > self.end_ns) return error.Timeout;
        std.Thread.yield() catch {};
    }

    fn monotonicNs() u64 {
        var now: std.c.timespec = undefined;
        _ = std.c.clock_gettime(.MONOTONIC, &now);
        return @as(u64, @intCast(now.sec)) * std.time.ns_per_s + @as(u64, @intCast(now.nsec));
    }
};

pub fn waitThreadsGone() !void {
    const deadline: Deadline = .init();
    while (live_threads.load(.acquire) != 0) try deadline.check();
}

const Script = struct {
    results: []const SinkError!usize,
    index: *std.atomic.Value(usize),

    pub fn write(self: Script, bytes: []const u8) SinkError!usize {
        const result = self.results[self.index.fetchAdd(1, .monotonic)];
        const count = result catch |err| return err;
        return @min(count, bytes.len + 1);
    }

    pub fn waitWritable(_: Script) void {}
};

test "stdout writer retries EINTR and EAGAIN, and fails a hangup, a zero count, or an overcount" {
    if (!supported) return error.SkipZigTest;
    const Row = struct { results: []const SinkError!usize, outcome: Outcome };
    const rows = [_]Row{
        .{ .results = &.{ error.Interrupted, 4 }, .outcome = .written },
        .{ .results = &.{ 1, error.WouldBlock, error.Interrupted, 3 }, .outcome = .written },
        .{ .results = &.{ 2, error.Failed }, .outcome = .failed },
        .{ .results = &.{0}, .outcome = .failed },
        .{ .results = &.{5}, .outcome = .failed },
    };
    for (rows) |row| {
        var index: std.atomic.Value(usize) = .init(0);
        const writer = try Writer(Script, ThreadRunner(null)).create(testing.allocator, .{ .results = row.results, .index = &index }, .{});
        @memcpy(writer.buffer[0..4], "abcd");
        writer.start(4);
        try testing.expectEqual(row.outcome, writer.waitCollect(std.time.ns_per_s));
        try testing.expectEqual(row.results.len, index.load(.monotonic));
        writer.abandon();
    }
    try waitThreadsGone();

    // The same on a real pipe: a closed reader is EPIPE (SIGPIPE is blocked in the writer), and a
    // full non-blocking pipe waits in poll(2) until the reader drains it.
    const closed = try testPipe(4096);
    _ = std.c.close(closed[0]);
    defer _ = std.c.close(closed[1]);
    const failing = try StdoutWriter.create(testing.allocator, .{ .fd = closed[1] }, .{});
    failing.start(16);
    try testing.expectEqual(Outcome.failed, failing.waitCollect(std.time.ns_per_s));
    failing.abandon();

    const fds = try testPipe(4096);
    defer closeAll(fds);
    _ = std.c.fcntl(fds[1], std.posix.F.SETFL, @as(c_int, @bitCast(std.posix.O{ .NONBLOCK = true })));
    const writer = try StdoutWriter.create(testing.allocator, .{ .fd = fds[1] }, .{});
    @memset(writer.buffer[0..12_000], 'x');
    writer.start(12_000);
    var read: [12_000]u8 = undefined;
    try readExactly(fds[0], &read);
    try testing.expectEqual(Outcome.written, writer.waitCollect(std.time.ns_per_s));
    writer.abandon();
    try waitThreadsGone();
}

/// Written by the writer thread before it publishes; read after the collect.
var mask_blocked: std.posix.sigset_t = undefined;

/// The calling thread's blocked signals. glibc's sigemptyset and sigprocmask write only the
/// kernel's part of the set, so the rest is zeroed for comparisons.
fn blockedSignals() std.posix.sigset_t {
    var set = std.mem.zeroes(std.posix.sigset_t);
    std.posix.sigprocmask(std.posix.SIG.BLOCK, null, &set);
    return set;
}

const MaskSink = struct {
    pub fn write(_: MaskSink, bytes: []const u8) SinkError!usize {
        mask_blocked = blockedSignals();
        return bytes.len;
    }

    pub fn waitWritable(_: MaskSink) void {}
};

test "stdout writer blocks signals from its first instruction, except SIGTTOU and faults" {
    if (!supported) return error.SkipZigTest;
    // Start from an empty mask, so a creator mask left blocked shows even after other tests.
    var saved: std.posix.sigset_t = undefined;
    std.debug.assert(std.c.pthread_sigmask(std.posix.SIG.SETMASK, &std.mem.zeroes(std.posix.sigset_t), &saved) == 0);
    defer std.debug.assert(std.c.pthread_sigmask(std.posix.SIG.SETMASK, &saved, &saved) == 0);
    const before = blockedSignals();
    const writer = try Writer(MaskSink, ThreadRunner(null)).create(testing.allocator, .{}, .{});
    defer writer.abandon();
    try testing.expectEqual(before, blockedSignals());
    writer.start(1);
    try testing.expectEqual(Outcome.written, writer.waitCollect(std.time.ns_per_s));
    for ([_]std.posix.SIG{ .INT, .WINCH, .HUP, .PIPE, .TERM, .TSTP, .CONT, .ALRM, .CHLD, .USR1, .USR2 }) |sig| {
        try testing.expect(std.posix.sigismember(&mask_blocked, sig));
    }
    for ([_]std.posix.SIG{ .TTOU, .SEGV, .BUS, .ILL, .FPE, .TRAP }) |sig| try testing.expect(!std.posix.sigismember(&mask_blocked, sig));
}

test "stdout writer abandoned inside a stuck write returns at once and frees itself afterwards" {
    if (!supported) return error.SkipZigTest;
    const fds = try testPipe(4096);
    defer closeAll(fds);
    const writer = try StdoutWriter.create(scribbling, .{ .fd = fds[1] }, .{});
    @memset(&writer.buffer, 'y');
    writer.start(handover_max);
    // Bytes in the pipe show the thread inside write(2). `.writing` alone also holds just before
    // the call, and an abandon there stops the copy unwritten.
    var ready: [1]std.c.pollfd = .{.{ .fd = fds[0], .events = std.c.POLL.IN, .revents = 0 }};
    try testing.expectEqual(1, std.c.poll(&ready, 1, 10_000));
    writer.abandon();
    // The owner is gone; the reader drains, the write returns, the publish fails, and the
    // thread frees the writer. The testing allocator reports a leak or a double free.
    var read: [handover_max]u8 = undefined;
    try readExactly(fds[0], &read);
    try waitThreadsGone();
}

var hook_parked: std.atomic.Value(u32) = .init(0);
var hook_release: std.atomic.Value(u32) = .init(0);

fn parkAfterWrite() void {
    hook_parked.store(1, .release);
    io().futexWake(u32, &hook_parked.raw, 1);
    while (hook_release.load(.acquire) == 0) io().futexWaitUncancelable(u32, &hook_release.raw, 0);
}

test "stdout writer abandoned between its write and its publish is freed exactly once" {
    if (!supported) return error.SkipZigTest;
    hook_parked.store(0, .release);
    hook_release.store(0, .release);
    const fds = try testPipe(4096);
    defer closeAll(fds);
    const writer = try Writer(FdSink, ThreadRunner(parkAfterWrite)).create(scribbling, .{ .fd = fds[1] }, .{});
    writer.start(8);
    while (hook_parked.load(.acquire) == 0) io().futexWaitUncancelable(u32, &hook_parked.raw, 0);
    writer.abandon();
    hook_release.store(1, .release);
    io().futexWake(u32, &hook_release.raw, 1);
    try waitThreadsGone();
}

fn drainUntilClosed(fd: std.posix.fd_t) void {
    var buffer: [4096]u8 = undefined;
    while (std.c.read(fd, &buffer, buffer.len) > 0) {}
}

test "stdout writer survives posts raced against abandons without a park" {
    if (!supported) return error.SkipZigTest;
    const fds = try testPipe(4096);
    const reader = try std.Thread.spawn(.{}, drainUntilClosed, .{fds[0]});
    var prng = std.Random.DefaultPrng.init(388);
    for (0..500) |round| {
        const writer = try StdoutWriter.create(scribbling, .{ .fd = fds[1] }, .{});
        writer.start(@intCast(1 + prng.random().uintLessThan(u32, 6000)));
        // Abandon at once, after a few yields, or after the publish.
        for (0..round % 4) |_| std.Thread.yield() catch {};
        if (round % 7 == 0) _ = writer.waitCollect(std.time.ns_per_s);
        writer.abandon();
    }
    try waitThreadsGone();
    _ = std.c.close(fds[1]);
    reader.join();
    _ = std.c.close(fds[0]);
}

/// A runner whose thread never runs: the exit wait takes its copy back.
pub const Parked = struct {
    pub const threaded = false;
    pub const hook = null;

    pub fn waitChange(_: Parked, _: anytype, _: State, _: bool) void {}
};

test "stdout writer needs no pin for code in the main executable" {
    if (!supported) return error.SkipZigTest;
    // The test binary holds this code itself; glibc's dlopen(RTLD_NOLOAD) of an executable fails.
    try testing.expect(pinLibrary());
}

var room_waits: std.atomic.Value(u32) = .init(0);

/// The real fd, counting the thread's waits for room.
const RoomSink = struct {
    fd: FdSink,
    pub fn write(self: RoomSink, bytes: []const u8) SinkError!usize {
        return self.fd.write(bytes);
    }
    pub fn waitWritable(self: RoomSink) void {
        _ = room_waits.fetchAdd(1, .release);
        self.fd.waitWritable();
    }
};

test "stdout writer starts no new write after an abandon, on a full non-blocking pipe" {
    if (!supported) return error.SkipZigTest;
    const fds = try testPipe(4096);
    defer closeAll(fds);
    _ = std.c.fcntl(fds[1], std.posix.F.SETFL, @as(c_int, @bitCast(std.posix.O{ .NONBLOCK = true })));
    _ = std.c.fcntl(fds[0], std.posix.F.SETFL, @as(c_int, @bitCast(std.posix.O{ .NONBLOCK = true })));
    var fill: [4096]u8 = undefined;
    @memset(&fill, 'f');
    while (std.c.write(fds[1], &fill, fill.len) > 0) {}
    room_waits.store(0, .release);
    const writer = try Writer(RoomSink, ThreadRunner(null)).create(testing.allocator, .{ .fd = .{ .fd = fds[1] } }, .{});
    @memset(writer.buffer[0..4096], 'S');
    writer.start(4096);
    // The write returned EAGAIN; abandon while the thread waits for room, then make room.
    const deadline: Deadline = .init();
    while (room_waits.load(.acquire) == 0) try deadline.check();
    writer.abandon();
    var stale: usize = 0;
    var buffer: [4096]u8 = undefined;
    for (0..2) |pass| {
        // The second pass reads what the thread wrote before it exited.
        if (pass == 1) try waitThreadsGone();
        while (true) {
            const rc = std.c.read(fds[0], &buffer, buffer.len);
            if (rc <= 0) break;
            for (buffer[0..@intCast(rc)]) |byte| stale += @intFromBool(byte == 'S');
        }
    }
    try testing.expectEqual(@as(usize, 0), stale);
}

test "stdout writer finds its segment when the load bias wraps, as a prelinked vDSO's does" {
    // dlpi_addr is the modular bias: actual address minus p_vaddr.
    const vaddr: usize = 0xffffffffff700000;
    const actual: usize = 0x7fff_f7fc_0000;
    try testing.expect(segmentHolds(actual -% vaddr, vaddr, 0x2000, actual + 0x10));
    try testing.expect(!segmentHolds(actual -% vaddr, vaddr, 0x2000, actual + 0x2000));
}
