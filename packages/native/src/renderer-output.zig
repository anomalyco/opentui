//! Output transport backends for `CliRenderer`.
//!
//! The renderer's render path writes ANSI bytes into an abstract writer
//! supplied by an `OutputBackend`. Two variants are available:
//!
//!   - `BufferedBackend`: writes into per-renderer A/B frame buffers, then
//!     flushes committed bytes to an injected `BufferedOutput`.
//!
//!   - `FeedBackend`: stages each complete frame, then atomically publishes it
//!     to a `NativeSpanFeed.Stream` whose chunks are consumed from TypeScript
//!     and piped to a user-supplied Writable (typically an SSH channel).
//!
//! The backend is a tagged union. `CliRenderer.render` performs exactly one
//! `switch` on the backend using `inline else` to pick the right variant's
//! writer type at compile time — keeping the render path generic over the
//! writer without scattering backend-specific switches across the codebase.

const std = @import("std");
const builtin = @import("builtin");
const io = if (builtin.is_test) std.testing.io else @import("root").io;
const Allocator = std.mem.Allocator;
const NativeSpanFeed = @import("native-span-feed.zig");

pub const OUTPUT_BUFFER_SIZE = 1024 * 1024 * 2; // 2 MiB, double-buffered per BufferedBackend for thread handoff
const UTF16_BUFFER_SIZE = 4096;

const WindowsConsole = struct {
    extern "kernel32" fn GetConsoleMode(
        handle: std.os.windows.HANDLE,
        mode: *std.os.windows.DWORD,
    ) callconv(.winapi) std.os.windows.BOOL;
    extern "kernel32" fn GetConsoleOutputCP() callconv(.winapi) std.os.windows.UINT;
    extern "kernel32" fn SetConsoleOutputCP(code_page: std.os.windows.UINT) callconv(.winapi) std.os.windows.BOOL;
    extern "kernel32" fn WriteConsoleW(
        handle: std.os.windows.HANDLE,
        buffer: [*]const u16,
        chars_to_write: std.os.windows.DWORD,
        chars_written: ?*std.os.windows.DWORD,
        reserved: ?*anyopaque,
    ) callconv(.winapi) std.os.windows.BOOL;
};

pub const WriteStatus = enum(u8) {
    ok = 0,
    skipped = 1,
    failed = 2,
};

pub const BufferedWriteFn = *const fn (ctx: *anyopaque, data: []const u8) void;

pub const BufferedOutput = struct {
    ctx: *anyopaque,
    write_fn: BufferedWriteFn,
    thread_safe: bool = false,

    pub fn write(self: BufferedOutput, data: []const u8) void {
        self.write_fn(self.ctx, data);
    }
};

const Utf16Chunk = struct {
    input_len: usize,
    output_len: usize,
};

fn utf8ToUtf16Chunk(output: []u16, input: []const u8) error{InvalidUtf8}!Utf16Chunk {
    std.debug.assert(output.len >= 2);

    var input_index: usize = 0;
    var output_index: usize = 0;
    while (input_index < input.len) {
        const first_byte = input[input_index];
        if (first_byte < 0x80) {
            if (output_index == output.len) break;
            output[output_index] = first_byte;
            input_index += 1;
            output_index += 1;
            continue;
        }

        const sequence_len = std.unicode.utf8ByteSequenceLength(first_byte) catch return error.InvalidUtf8;
        if (input.len - input_index < sequence_len) return error.InvalidUtf8;
        const codepoint = std.unicode.utf8Decode(input[input_index..][0..sequence_len]) catch return error.InvalidUtf8;
        const output_len: usize = if (codepoint < 0x10000) 1 else 2;
        if (output.len - output_index < output_len) break;

        if (output_len == 1) {
            output[output_index] = @intCast(codepoint);
        } else {
            const value = codepoint - 0x10000;
            output[output_index] = @intCast(0xD800 + (value >> 10));
            output[output_index + 1] = @intCast(0xDC00 + (value & 0x3FF));
        }
        input_index += sequence_len;
        output_index += output_len;
    }

    return .{ .input_len = input_index, .output_len = output_index };
}

test "stdout write failures remain observable for resource cleanup" {
    if (builtin.os.tag != .linux) return error.SkipZigTest;
    const full = try std.Io.Dir.openFileAbsolute(std.testing.io, "/dev/full", .{ .mode = .write_only });
    defer full.close(std.testing.io);
    var stdout_output = StdoutOutput.initForFile(full);
    stdout_output.bufferedOutput().write("cannot write");
    try std.testing.expect(stdout_output.failed.load(.acquire));
}

test "UTF-8 output converts to UTF-16" {
    const input = "Aé東😀";
    const expected = [_]u16{ 'A', 0x00E9, 0x6771, 0xD83D, 0xDE00 };
    var output: [expected.len]u16 = undefined;

    const result = try utf8ToUtf16Chunk(&output, input);

    try std.testing.expectEqual(input.len, result.input_len);
    try std.testing.expectEqual(expected.len, result.output_len);
    try std.testing.expectEqualSlices(u16, &expected, output[0..result.output_len]);
}

test "UTF-8 output chunking does not split surrogate pairs" {
    const input = "A😀B";
    var output: [2]u16 = undefined;

    const first = try utf8ToUtf16Chunk(&output, input);
    try std.testing.expectEqual(@as(usize, 1), first.input_len);
    try std.testing.expectEqualSlices(u16, &.{'A'}, output[0..first.output_len]);

    const second = try utf8ToUtf16Chunk(&output, input[first.input_len..]);
    try std.testing.expectEqual(@as(usize, 4), second.input_len);
    try std.testing.expectEqualSlices(u16, &.{ 0xD83D, 0xDE00 }, output[0..second.output_len]);

    const third_offset = first.input_len + second.input_len;
    const third = try utf8ToUtf16Chunk(&output, input[third_offset..]);
    try std.testing.expectEqual(@as(usize, 1), third.input_len);
    try std.testing.expectEqualSlices(u16, &.{'B'}, output[0..third.output_len]);
}

test "UTF-8 output conversion is bounded by the UTF-16 buffer" {
    const input = "x" ** (UTF16_BUFFER_SIZE + 1);
    var output: [UTF16_BUFFER_SIZE]u16 = undefined;

    const first = try utf8ToUtf16Chunk(&output, input);
    try std.testing.expectEqual(@as(usize, UTF16_BUFFER_SIZE), first.input_len);
    try std.testing.expectEqual(@as(usize, UTF16_BUFFER_SIZE), first.output_len);

    const second = try utf8ToUtf16Chunk(&output, input[first.input_len..]);
    try std.testing.expectEqual(@as(usize, 1), second.input_len);
    try std.testing.expectEqualSlices(u16, &.{'x'}, output[0..second.output_len]);
}

test "UTF-8 output rejects invalid and incomplete input" {
    var output: [8]u16 = undefined;

    try std.testing.expectError(error.InvalidUtf8, utf8ToUtf16Chunk(&output, "\xFF"));
    try std.testing.expectError(error.InvalidUtf8, utf8ToUtf16Chunk(&output, "\xF0\x9F"));
}

fn isWindowsConsole(file: std.Io.File) bool {
    if (builtin.os.tag != .windows) return false;

    var console_mode: std.os.windows.DWORD = 0;
    return WindowsConsole.GetConsoleMode(file.handle, &console_mode).toBool();
}

pub const StdoutOutput = struct {
    stdout: std.Io.File,
    stdoutBuffer: [4096]u8 = undefined,
    utf16Buffer: [UTF16_BUFFER_SIZE]u16 = undefined,
    windowsConsole: bool,
    failed: std.atomic.Value(bool) = .init(false),

    pub fn init() StdoutOutput {
        return initForFile(std.Io.File.stdout());
    }

    fn initForFile(stdout: std.Io.File) StdoutOutput {
        return .{
            .stdout = stdout,
            .windowsConsole = isWindowsConsole(stdout),
        };
    }

    pub fn bufferedOutput(self: *StdoutOutput) BufferedOutput {
        return .{
            .ctx = self,
            .write_fn = write,
            .thread_safe = true,
        };
    }

    fn write(ctx: *anyopaque, data: []const u8) void {
        if (data.len == 0) return;

        const self: *StdoutOutput = @ptrCast(@alignCast(ctx));
        if (builtin.os.tag == .windows) {
            if (self.windowsConsole) {
                self.writeWindowsConsole(data);
                return;
            }
        }

        self.writeBytes(data);
    }

    fn writeBytes(self: *StdoutOutput, data: []const u8) void {
        var stdoutWriter = self.stdout.writerStreaming(io, &self.stdoutBuffer);
        const w = &stdoutWriter.interface;
        w.writeAll(data) catch {
            self.failed.store(true, .release);
            return;
        };
        w.flush() catch {
            self.failed.store(true, .release);
        };
    }

    fn writeWindowsConsole(self: *StdoutOutput, data: []const u8) void {
        // Frames and control writes are complete UTF-8 units. Drop malformed
        // input rather than partially emitting an ANSI sequence to the console.
        if (!std.unicode.utf8ValidateSlice(data)) return;

        var input = data;
        while (input.len > 0) {
            const chunk = utf8ToUtf16Chunk(&self.utf16Buffer, input) catch unreachable;
            std.debug.assert(chunk.input_len > 0);
            if (!self.writeWindowsConsoleUtf16(self.utf16Buffer[0..chunk.output_len])) return;
            input = input[chunk.input_len..];
        }
    }

    fn writeWindowsConsoleUtf16(self: *StdoutOutput, data: []const u16) bool {
        var remaining = data;
        while (remaining.len > 0) {
            var written: std.os.windows.DWORD = 0;
            if (!WindowsConsole.WriteConsoleW(
                self.stdout.handle,
                remaining.ptr,
                @intCast(remaining.len),
                &written,
                null,
            ).toBool() or written == 0) return false;
            remaining = remaining[@intCast(written)..];
        }
        return true;
    }
};

test "StdoutOutput leaves the Windows console output code page unchanged" {
    if (builtin.os.tag != .windows) return error.SkipZigTest;
    if (!isWindowsConsole(std.Io.File.stdout())) return error.SkipZigTest;

    const original_code_page = WindowsConsole.GetConsoleOutputCP();
    if (original_code_page == 0) return error.SkipZigTest;
    defer _ = WindowsConsole.SetConsoleOutputCP(original_code_page);

    if (!WindowsConsole.SetConsoleOutputCP(437).toBool()) return error.SkipZigTest;

    const stdout_output = StdoutOutput.init();
    try std.testing.expect(stdout_output.windowsConsole);
    try std.testing.expectEqual(@as(u32, 437), WindowsConsole.GetConsoleOutputCP());
}

test "StdoutOutput preserves bytes for redirected output" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const file = try tmp.dir.createFile(std.testing.io, "stdout", .{ .read = true });
    defer file.close(std.testing.io);
    try std.testing.expect(!isWindowsConsole(file));

    var stdout_output = StdoutOutput.initForFile(file);
    const expected = "\x1b[31mAé東😀\x1b[0m";
    const split = expected.len / 2;
    stdout_output.bufferedOutput().write(expected[0..split]);
    stdout_output.bufferedOutput().write(expected[split..]);

    var actual: [expected.len]u8 = undefined;
    const actual_len = try file.readPositionalAll(std.testing.io, &actual, 0);
    try std.testing.expectEqual(expected.len, actual_len);
    try std.testing.expectEqualStrings(expected, &actual);
}

pub const MemoryOutput = struct {
    allocator: Allocator,
    bytes: std.ArrayListUnmanaged(u8) = .empty,

    pub fn init(allocator: Allocator) MemoryOutput {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *MemoryOutput) void {
        self.bytes.deinit(self.allocator);
    }

    pub fn bufferedOutput(self: *MemoryOutput) BufferedOutput {
        return .{ .ctx = self, .write_fn = write };
    }

    fn write(ctx: *anyopaque, data: []const u8) void {
        const self: *MemoryOutput = @ptrCast(@alignCast(ctx));
        self.bytes.appendSlice(self.allocator, data) catch {};
    }
};

fn BackendWriter(
    comptime Backend: type,
    comptime append: fn (*Backend, []const u8) error{BufferFull}!void,
) type {
    return struct {
        const Writer = @This();

        backend: *Backend,
        interface: std.Io.Writer,

        fn init(backend: *Backend) Writer {
            return .{
                .backend = backend,
                .interface = .{
                    .vtable = &.{ .drain = drain },
                    .buffer = &.{},
                },
            };
        }

        pub fn write(self: Writer, data: []const u8) error{BufferFull}!usize {
            var copy = self;
            return copy.interface.write(data) catch return error.BufferFull;
        }

        pub fn writeAll(self: Writer, data: []const u8) error{BufferFull}!void {
            var copy = self;
            return copy.interface.writeAll(data) catch return error.BufferFull;
        }

        pub fn writeByte(self: Writer, byte: u8) error{BufferFull}!void {
            var copy = self;
            return copy.interface.writeByte(byte) catch return error.BufferFull;
        }

        pub fn print(self: Writer, comptime format: []const u8, args: anytype) error{BufferFull}!void {
            var copy = self;
            return copy.interface.print(format, args) catch return error.BufferFull;
        }

        fn drain(w: *std.Io.Writer, data: []const []const u8, splat: usize) std.Io.Writer.Error!usize {
            const self: *Writer = @alignCast(@fieldParentPtr("interface", w));
            var written: usize = 0;

            for (data[0 .. data.len - 1]) |slice| {
                append(self.backend, slice) catch return error.WriteFailed;
                written += slice.len;
            }

            const pattern = data[data.len - 1];
            for (0..splat) |_| {
                append(self.backend, pattern) catch return error.WriteFailed;
                written += pattern.len;
            }
            return written;
        }
    };
}

/// Tagged union dispatching to BufferedBackend or FeedBackend.
pub const OutputBackend = union(enum) {
    buffered: BufferedBackend,
    feed: FeedBackend,

    /// Synchronously emit a pre-built byte sequence (setup/shutdown/query).
    pub fn writeOut(self: *OutputBackend, data: []const u8) void {
        switch (self.*) {
            inline else => |*b| b.writeOut(data),
        }
    }

    /// Synchronously emit multiple pre-built byte sequences.
    pub fn writeOutMultiple(self: *OutputBackend, data_slices: []const []const u8) void {
        switch (self.*) {
            inline else => |*b| b.writeOutMultiple(data_slices),
        }
    }

    /// Prepare the backend for a new frame. Feed backends can return skipped
    /// when the durable queue is over its high-water mark or still owns pending
    /// bytes from an earlier frame.
    pub fn prepareFrame(self: *OutputBackend) WriteStatus {
        switch (self.*) {
            inline else => |*b| return b.prepareFrame(),
        }
    }

    /// Transition batches must publish captured output before terminal state changes.
    /// Feed high water limits ordinary frames, not these ordered control writes.
    pub fn prepareControlFrame(self: *OutputBackend) WriteStatus {
        switch (self.*) {
            .feed => |*b| {
                b.feed.commit() catch return .skipped;
                return .ok;
            },
            .buffered => |*b| return b.prepareFrame(),
        }
    }

    /// Non-mutating high-water check. Rendering uses `prepareFrame()` so pending
    /// bytes from earlier writes can be committed before deciding to skip.
    pub fn shouldSkipFrame(self: *OutputBackend) bool {
        switch (self.*) {
            inline else => |*b| return b.shouldSkipFrame(),
        }
    }

    pub fn supportsThreading(self: *OutputBackend) bool {
        switch (self.*) {
            inline else => |*b| return b.supportsThreading(),
        }
    }

    pub fn setUseThread(self: *OutputBackend, use_thread: bool) void {
        switch (self.*) {
            inline else => |*b| b.setUseThread(use_thread),
        }
    }

    pub fn isUseThread(self: *OutputBackend) bool {
        switch (self.*) {
            inline else => |*b| return b.isUseThread(),
        }
    }

    /// Microseconds spent on the last write (populated after endFrame).
    pub fn getLastWriteTimeUs(self: *OutputBackend) ?f64 {
        switch (self.*) {
            inline else => |*b| return b.lastWriteTimeUs,
        }
    }

    /// Write a backend-specific debug dump into `out`. Called from the
    /// `dumpOutputBuffer` helper on `CliRenderer`; keeps backend-specific
    /// formatting internal so the renderer never switches on the tag.
    pub fn dumpTo(self: *OutputBackend, out: anytype) void {
        switch (self.*) {
            inline else => |*b| b.dumpTo(out),
        }
    }

    pub fn deinit(self: *OutputBackend) void {
        switch (self.*) {
            inline else => |*b| b.deinit(),
        }
    }
};

/// Backend that stages frame bytes in per-renderer buffers and flushes them to
/// an injected byte output when a frame is committed.
///
/// Owns the double buffers and optional render-thread state so each renderer
/// has isolated output storage.
pub const BufferedBackend = struct {
    const BufferId = enum { A, B };

    /// Number of consecutive frames that fit in the default buffer before an
    /// oversized buffer is shrunk back to OUTPUT_BUFFER_SIZE. Keeps a workload
    /// of sustained large frames from realloc-churning while still returning
    /// spike memory once frames are consistently small again.
    const SHRINK_AFTER_SMALL_FRAMES = 64;

    allocator: Allocator,
    output: BufferedOutput,
    ownedStdoutOutput: ?*StdoutOutput = null,
    ownedMemoryOutput: ?*MemoryOutput = null,

    outputA: []u8,
    outputB: []u8,
    outputLenA: usize = 0,
    outputLenB: usize = 0,
    activeBuffer: BufferId = .A,
    lastCommittedBuffer: BufferId = .A,
    hasCommittedFrame: bool = false,
    /// Set when frame bytes were dropped because a buffer could not grow.
    /// endFrame consumes it and reports the frame as failed so the renderer
    /// forces a full repaint instead of trusting the committed cell diff.
    frameWriteFailed: bool = false,
    smallFrameStreak: u32 = 0,

    useThread: bool = false,
    renderThread: ?std.Thread = null,
    renderMutex: std.Io.Mutex = .init,
    renderCondition: std.Io.Condition = .init,
    renderRequested: bool = false,
    shouldTerminate: bool = false,
    renderInProgress: bool = false,

    // Handoff buffer for the render thread
    currentOutputBuffer: []u8 = &[_]u8{},
    currentOutputLen: usize = 0,

    lastWriteTimeUs: ?f64 = null,

    pub fn create(allocator: Allocator, output: BufferedOutput) !BufferedBackend {
        const a_buf = try allocator.alloc(u8, OUTPUT_BUFFER_SIZE);
        errdefer allocator.free(a_buf);
        const b_buf = try allocator.alloc(u8, OUTPUT_BUFFER_SIZE);
        errdefer allocator.free(b_buf);

        return BufferedBackend{
            .allocator = allocator,
            .output = output,
            .outputA = a_buf,
            .outputB = b_buf,
        };
    }

    pub fn createStdout(allocator: Allocator) !BufferedBackend {
        const stdoutOutput = try allocator.create(StdoutOutput);
        errdefer allocator.destroy(stdoutOutput);
        stdoutOutput.* = StdoutOutput.init();

        var backend = try BufferedBackend.create(allocator, stdoutOutput.bufferedOutput());
        backend.ownedStdoutOutput = stdoutOutput;
        return backend;
    }

    pub fn createMemory(allocator: Allocator) !BufferedBackend {
        const memoryOutput = try allocator.create(MemoryOutput);
        errdefer allocator.destroy(memoryOutput);
        memoryOutput.* = MemoryOutput.init(allocator);

        var backend = try BufferedBackend.create(allocator, memoryOutput.bufferedOutput());
        backend.ownedMemoryOutput = memoryOutput;
        return backend;
    }

    /// Frees with the allocator captured at create time. The buffers may have
    /// been realloc-grown by frame writes, so freeing them with any other
    /// allocator would be undefined behavior.
    pub fn deinit(self: *BufferedBackend) void {
        if (self.renderThread) |thread| {
            self.renderMutex.lockUncancelable(io);
            while (self.renderInProgress) {
                self.renderCondition.waitUncancelable(io, &self.renderMutex);
            }
            self.shouldTerminate = true;
            // Do NOT set renderRequested — the thread should wake, see
            // shouldTerminate, and exit without a final spurious write of
            // the stale last-frame buffer. Previously setting renderRequested
            // here caused a stale frame to be emitted AFTER the shutdown
            // ANSI sequence had already restored the terminal.
            self.renderCondition.signal(io);
            self.renderMutex.unlock(io);
            thread.join();
            self.renderThread = null;
        }

        self.allocator.free(self.outputA);
        self.allocator.free(self.outputB);
        if (self.ownedStdoutOutput) |stdoutOutput| {
            self.allocator.destroy(stdoutOutput);
            self.ownedStdoutOutput = null;
        }
        if (self.ownedMemoryOutput) |memoryOutput| {
            memoryOutput.deinit();
            self.allocator.destroy(memoryOutput);
            self.ownedMemoryOutput = null;
        }
    }

    pub fn shouldSkipFrame(_: *BufferedBackend) bool {
        return false;
    }

    pub fn prepareFrame(self: *BufferedBackend) WriteStatus {
        if (!self.useThread) return .ok;
        if (!self.renderMutex.tryLock()) return .skipped;
        defer self.renderMutex.unlock(io);
        if (self.renderInProgress) return .skipped;
        return .ok;
    }

    pub fn supportsThreading(self: *BufferedBackend) bool {
        return self.output.thread_safe;
    }

    pub fn isUseThread(self: *BufferedBackend) bool {
        return self.useThread;
    }

    pub fn setUseThread(self: *BufferedBackend, use_thread: bool) void {
        if (use_thread and !self.supportsThreading()) return;
        if (self.useThread == use_thread) return;

        if (use_thread) {
            if (self.renderThread == null) {
                self.renderThread = std.Thread.spawn(.{}, renderThreadFn, .{self}) catch |err| {
                    std.log.warn("Failed to spawn render thread: {}, falling back to non-threaded mode", .{err});
                    self.useThread = false;
                    return;
                };
            }
        } else {
            if (self.renderThread) |thread| {
                self.renderMutex.lockUncancelable(io);
                while (self.renderInProgress) {
                    self.renderCondition.waitUncancelable(io, &self.renderMutex);
                }
                self.shouldTerminate = true;
                // Wake the thread with a terminate-only signal; do not set
                // renderRequested (that would replay the stale buffer).
                self.renderCondition.signal(io);
                self.renderMutex.unlock(io);

                thread.join();
                self.renderThread = null;
                self.shouldTerminate = false;
                // Reset request/progress flags so a future setUseThread(true)
                // does not wake on a stale request.
                self.renderRequested = false;
                self.renderInProgress = false;
            }
        }

        self.useThread = use_thread;
    }

    pub const Writer = BackendWriter(BufferedBackend, bufferWrite);

    fn bufferWrite(self: *BufferedBackend, data: []const u8) error{BufferFull}!void {
        const buffer_len = if (self.activeBuffer == .A)
            &self.outputLenA
        else
            &self.outputLenB;
        const required = std.math.add(usize, buffer_len.*, data.len) catch {
            self.frameWriteFailed = true;
            return error.BufferFull;
        };

        const buffer = if (self.activeBuffer == .A) &self.outputA else &self.outputB;

        if (required > buffer.*.len) {
            const doubled_capacity = std.math.mul(usize, buffer.*.len, 2) catch required;
            const capacity = @max(required, doubled_capacity);
            buffer.* = self.allocator.realloc(buffer.*, capacity) catch {
                self.frameWriteFailed = true;
                return error.BufferFull;
            };
        }

        @memcpy(buffer.*[buffer_len.*..][0..data.len], data);
        buffer_len.* = required;
    }

    pub fn writer(self: *BufferedBackend) Writer {
        return .init(self);
    }

    pub fn beginFrame(self: *BufferedBackend) void {
        self.frameWriteFailed = false;
        self.maybeShrinkActiveBuffer();
        if (self.activeBuffer == .A) {
            self.outputLenA = 0;
        } else {
            self.outputLenB = 0;
        }
    }

    pub fn failFrame(self: *BufferedBackend) void {
        self.frameWriteFailed = true;
    }

    /// Give spike memory back once frames have been consistently small again.
    /// Runs at frame start when the active buffer is exclusively owned by the
    /// producer: in threaded mode the render thread only ever reads the buffer
    /// handed off at the previous endFrame, which is the other one.
    fn maybeShrinkActiveBuffer(self: *BufferedBackend) void {
        if (self.smallFrameStreak < SHRINK_AFTER_SMALL_FRAMES) return;
        const buffer = if (self.activeBuffer == .A) &self.outputA else &self.outputB;
        if (buffer.*.len <= OUTPUT_BUFFER_SIZE) return;
        buffer.* = self.allocator.realloc(buffer.*, OUTPUT_BUFFER_SIZE) catch return;
    }

    fn updateSmallFrameStreak(self: *BufferedBackend, frame_len: usize) void {
        if (frame_len <= OUTPUT_BUFFER_SIZE) {
            self.smallFrameStreak +|= 1;
        } else {
            self.smallFrameStreak = 0;
        }
    }

    pub fn endFrame(self: *BufferedBackend) WriteStatus {
        const frame_len = if (self.activeBuffer == .A) self.outputLenA else self.outputLenB;

        if (self.frameWriteFailed) {
            // Frame bytes were dropped mid-frame. Flushing the truncated ANSI
            // stream could leave the terminal inside an escape sequence, so
            // drop the partial frame entirely and report failure; the renderer
            // reacts by forcing a full repaint on the next frame.
            self.frameWriteFailed = false;
            self.smallFrameStreak = 0;
            return .failed;
        }

        self.updateSmallFrameStreak(frame_len);

        if (self.useThread and frame_len == 0) {
            self.lastCommittedBuffer = self.activeBuffer;
            self.hasCommittedFrame = true;
            return .ok;
        }
        const writeStart = std.Io.Clock.awake.now(io);
        const committed_buffer = self.activeBuffer;

        if (self.useThread) {
            self.renderMutex.lockUncancelable(io);
            while (self.renderInProgress) {
                self.renderCondition.waitUncancelable(io, &self.renderMutex);
            }

            // Hand off the just-written buffer to the render thread and flip
            // active to the other one for the next frame.
            if (self.activeBuffer == .A) {
                self.activeBuffer = .B;
                self.currentOutputBuffer = self.outputA;
                self.currentOutputLen = self.outputLenA;
            } else {
                self.activeBuffer = .A;
                self.currentOutputBuffer = self.outputB;
                self.currentOutputLen = self.outputLenB;
            }

            self.renderRequested = true;
            self.renderInProgress = true;
            self.renderCondition.signal(io);
            self.renderMutex.unlock(io);
        } else {
            const to_write = if (self.activeBuffer == .A)
                self.outputA[0..self.outputLenA]
            else
                self.outputB[0..self.outputLenB];
            self.output.write(to_write);
            self.lastWriteTimeUs = @as(f64, @floatFromInt(writeStart.untilNow(io, .awake).toMicroseconds()));
        }

        self.lastCommittedBuffer = committed_buffer;
        self.hasCommittedFrame = true;
        return .ok;
    }

    fn renderThreadFn(self: *BufferedBackend) void {
        while (true) {
            self.renderMutex.lockUncancelable(io);
            while (!self.renderRequested and !self.shouldTerminate) {
                self.renderCondition.waitUncancelable(io, &self.renderMutex);
            }

            // Terminate wins: when shouldTerminate is set, exit without
            // writing even if a render was also requested. This keeps
            // shutdown-ANSI the last thing on the wire.
            if (self.shouldTerminate) {
                self.renderMutex.unlock(io);
                break;
            }

            self.renderRequested = false;

            const outputData = self.currentOutputBuffer;
            const outputLen = self.currentOutputLen;

            const writeStart = std.Io.Clock.awake.now(io);

            self.output.write(outputData[0..outputLen]);

            self.lastWriteTimeUs = @as(f64, @floatFromInt(writeStart.untilNow(io, .awake).toMicroseconds()));
            self.renderInProgress = false;
            self.renderCondition.signal(io);
            self.renderMutex.unlock(io);
        }
    }

    pub fn writeOut(self: *BufferedBackend, data: []const u8) void {
        if (data.len == 0) return;

        if (self.useThread) {
            self.renderMutex.lockUncancelable(io);
            while (self.renderInProgress) {
                self.renderCondition.waitUncancelable(io, &self.renderMutex);
            }
            self.renderMutex.unlock(io);
        }

        self.output.write(data);
    }

    pub fn writeOutMultiple(self: *BufferedBackend, data_slices: []const []const u8) void {
        if (self.useThread) {
            self.renderMutex.lockUncancelable(io);
            while (self.renderInProgress) {
                self.renderCondition.waitUncancelable(io, &self.renderMutex);
            }
            self.renderMutex.unlock(io);
        }

        var totalLen: usize = 0;
        for (data_slices) |slice| {
            totalLen += slice.len;
        }
        if (totalLen == 0) return;

        for (data_slices) |slice| {
            self.output.write(slice);
        }
    }

    /// Write a debug dump of the last rendered output into `out`. The
    /// committed-buffer marker is explicit because non-threaded rendering does
    /// not flip the active buffer after each frame.
    pub fn dumpTo(self: *BufferedBackend, out: anytype) void {
        const last = if (self.hasCommittedFrame) blk: {
            const buf = if (self.lastCommittedBuffer == .A) self.outputA else self.outputB;
            const len = if (self.lastCommittedBuffer == .A) self.outputLenA else self.outputLenB;
            break :blk buf[0..len];
        } else &.{};

        if (last.len > 0) {
            out.writeAll(last) catch return;
        } else {
            out.writeAll("(no output rendered yet)\n") catch return;
        }
        out.writeAll("\n================\n") catch return;
        out.print("Buffer size: {d} bytes\n", .{last.len}) catch return;
        const active_label: []const u8 = if (self.activeBuffer == .A) "A" else "B";
        const committed_label: []const u8 = if (self.lastCommittedBuffer == .A) "A" else "B";
        out.print("Active buffer: {s}\n", .{active_label}) catch return;
        out.print("Last committed buffer: {s}\n", .{committed_label}) catch return;
    }
};

/// Backend that atomically publishes complete frames to a
/// `NativeSpanFeed.Stream`. The feed owns its chunk memory; the staging buffer
/// exists only to keep failed frames from exposing partial ANSI sequences.
///
/// Feed writes are in-memory ring-buffer ops with no I/O, so threading adds
/// synchronization cost without latency-hiding benefit. Backpressure is
/// exposed through `prepareFrame`: when the span queue is at its high-water
/// mark, frames are skipped before diffing while already queued bytes remain
/// durable and drain in order.
///
/// Zig tests that want to exercise the feed path should drain the feed directly.
pub const FeedBackend = struct {
    feed: *NativeSpanFeed.Stream,
    frameBytes: std.ArrayListUnmanaged(u8) = .empty,

    /// Set when staging a frame fails. No bytes from a failed frame are
    /// published; the renderer forces a later full repaint.
    frameWriteFailed: bool = false,

    lastWriteTimeUs: ?f64 = null,

    pub fn create(feed: *NativeSpanFeed.Stream) FeedBackend {
        return FeedBackend{ .feed = feed };
    }

    pub fn deinit(self: *FeedBackend) void {
        // Feed memory is owned by the TypeScript side.
        self.frameBytes.deinit(self.feed.allocator);
    }

    pub fn shouldSkipFrame(self: *FeedBackend) bool {
        const cap = self.feed.options.span_queue_capacity;
        if (cap == 0) return false;

        // Draining transfers spans to consumers; only releasing their chunk
        // references returns credit. Count queued and in-flight spans once each.
        var outstanding: u64 = 0;
        for (self.feed.stateBuffer()) |refcount| {
            outstanding += refcount;
            if (outstanding >= cap) return true;
        }
        return false;
    }

    pub fn prepareFrame(self: *FeedBackend) WriteStatus {
        self.frameWriteFailed = false;

        if (self.feed.hasPendingBytes()) {
            self.feed.commit() catch return .skipped;
            // Pending bytes belonged to an earlier frame/control write. Queue
            // them first and let the caller retry the new frame after drain.
            return .skipped;
        }

        if (self.shouldSkipFrame()) return .skipped;
        return .ok;
    }

    pub fn supportsThreading(_: *FeedBackend) bool {
        return false;
    }

    pub fn setUseThread(_: *FeedBackend, _: bool) void {
        // No-op: feed writes don't benefit from threading.
    }

    pub fn isUseThread(_: *FeedBackend) bool {
        return false;
    }

    pub const Writer = BackendWriter(FeedBackend, frameWrite);

    fn frameWrite(self: *FeedBackend, data: []const u8) error{BufferFull}!void {
        self.frameBytes.appendSlice(self.feed.allocator, data) catch {
            self.frameWriteFailed = true;
            return error.BufferFull;
        };
    }

    pub fn writer(self: *FeedBackend) Writer {
        return .init(self);
    }

    pub fn beginFrame(self: *FeedBackend) void {
        self.frameWriteFailed = false;
        self.frameBytes.clearRetainingCapacity();
    }

    pub fn failFrame(self: *FeedBackend) void {
        self.frameWriteFailed = true;
    }

    pub fn endFrame(self: *FeedBackend) WriteStatus {
        const writeStart = std.Io.Clock.awake.now(io);
        var status: WriteStatus = .ok;

        if (self.frameWriteFailed) {
            status = .failed;
        } else {
            self.feed.writeAtomic(self.frameBytes.items) catch {
                status = .failed;
            };
        }

        self.lastWriteTimeUs = @as(f64, @floatFromInt(writeStart.untilNow(io, .awake).toMicroseconds()));
        return status;
    }

    pub fn writeOut(self: *FeedBackend, data: []const u8) void {
        if (data.len == 0) return;
        // High-level renderers use a growable, uncapped feed. Manually bounded
        // low-level feeds intentionally get atomic best-effort control writes.
        self.feed.writeAtomic(data) catch {};
    }

    pub fn writeOutMultiple(self: *FeedBackend, data_slices: []const []const u8) void {
        var totalLen: usize = 0;
        for (data_slices) |slice| totalLen = std.math.add(usize, totalLen, slice.len) catch return;
        if (totalLen == 0) return;

        const data = self.feed.allocator.alloc(u8, totalLen) catch return;
        defer self.feed.allocator.free(data);
        var offset: usize = 0;
        for (data_slices) |slice| {
            @memcpy(data[offset .. offset + slice.len], slice);
            offset += slice.len;
        }
        self.feed.writeAtomic(data) catch {};
    }

    /// Write a debug dump placeholder. FeedBackend has no flat previous-frame
    /// slice — callers wanting feed bytes should drain the NativeSpanFeed.
    pub fn dumpTo(_: *FeedBackend, out: anytype) void {
        out.writeAll("(feed backend — drain spans from the NativeSpanFeed for output)\n") catch return;
        out.writeAll("\n================\n") catch return;
    }
};
