//! Output transport for `CliRenderer`: `FeedBackend` stages each complete
//! frame, then atomically publishes it to the Session's `NativeSpanFeed.Stream`.
//! `StdoutOutput` writes drained Session output directly to stdout.

const std = @import("std");
const builtin = @import("builtin");
const NativeSpanFeed = @import("native-span-feed.zig");
const utils = @import("utils.zig");

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
    var stdout_output = StdoutOutput.initForFile(std.testing.io, full);
    try std.testing.expect(std.meta.isError(stdout_output.writeSome("cannot write")));
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
    const input = utils.repeat(u8, "x", UTF16_BUFFER_SIZE + 1);
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
    io: std.Io,
    stdout: std.Io.File,
    utf16Buffer: [UTF16_BUFFER_SIZE]u16 = undefined,
    windowsConsole: bool,

    pub fn initWithIo(io: std.Io) StdoutOutput {
        return initForFile(io, std.Io.File.stdout());
    }

    fn initForFile(io: std.Io, stdout: std.Io.File) StdoutOutput {
        return .{
            .io = io,
            .stdout = stdout,
            .windowsConsole = isWindowsConsole(stdout),
        };
    }

    /// One direct byte write, or one bounded UTF-16 console chunk. An incomplete
    /// UTF-8 suffix stays with the caller.
    pub fn writeSome(self: *StdoutOutput, data: []const u8) !usize {
        if (data.len == 0) return 0;
        if (builtin.os.tag == .windows and self.windowsConsole) {
            const prefix = completeUtf8Prefix(data[0..@min(data.len, UTF16_BUFFER_SIZE)]);
            if (prefix.len == 0) return 0;
            const chunk = try utf8ToUtf16Chunk(&self.utf16Buffer, prefix);
            if (!self.writeWindowsConsoleUtf16(self.utf16Buffer[0..chunk.output_len])) {
                return error.WriteFailed;
            }
            return chunk.input_len;
        }
        const count = try self.stdout.writeStreaming(self.io, &.{}, &.{data}, 1);
        if (count == 0) return error.WriteFailed;
        return count;
    }

    /// Zig's standard stdout handle assumes synchronous Windows I/O. Overlapped
    /// handles can also belong to the host's completion port; leave those with
    /// their host writer instead of issuing a synchronous or APC-based write.
    pub fn supportsDirectWrite(self: *const StdoutOutput) bool {
        if (builtin.os.tag != .windows or self.windowsConsole) return true;
        const windows = std.os.windows;
        var status: windows.IO_STATUS_BLOCK = undefined;
        var mode: windows.FILE.MODE.INFORMATION = undefined;
        if (windows.ntdll.NtQueryInformationFile(
            self.stdout.handle,
            &status,
            &mode,
            @sizeOf(@TypeOf(mode)),
            .Mode,
        ) != .SUCCESS) return false;
        return mode.Mode.IO == .SYNCHRONOUS_ALERT or mode.Mode.IO == .SYNCHRONOUS_NONALERT;
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

fn completeUtf8Prefix(data: []const u8) []const u8 {
    if (data.len == 0) return data;
    var start = data.len - 1;
    while (start > 0 and data.len - start < 4 and data[start] & 0xc0 == 0x80) start -= 1;
    const length = std.unicode.utf8ByteSequenceLength(data[start]) catch return data;
    return if (length > data.len - start) data[0..start] else data;
}

test "stdout UTF-8 prefixes preserve split scalars without consuming a tail" {
    const text = "Aé東😀";
    const lengths = [_]usize{ 0, 1, 1, 3, 3, 3, 6, 6, 6, 6, 10 };
    for (lengths, 0..) |length, end| {
        try std.testing.expectEqual(length, completeUtf8Prefix(text[0..end]).len);
    }
    try std.testing.expectEqualStrings("\xff", completeUtf8Prefix("\xff"));
}

test "StdoutOutput leaves the Windows console output code page unchanged" {
    if (builtin.os.tag != .windows) return error.SkipZigTest;
    if (!isWindowsConsole(std.Io.File.stdout())) return error.SkipZigTest;

    const original_code_page = WindowsConsole.GetConsoleOutputCP();
    if (original_code_page == 0) return error.SkipZigTest;
    defer _ = WindowsConsole.SetConsoleOutputCP(original_code_page);

    if (!WindowsConsole.SetConsoleOutputCP(437).toBool()) return error.SkipZigTest;

    const stdout_output = StdoutOutput.initWithIo(std.testing.io);
    try std.testing.expect(stdout_output.windowsConsole);
    try std.testing.expectEqual(@as(u32, 437), WindowsConsole.GetConsoleOutputCP());
}

test "StdoutOutput preserves bytes for redirected output" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const file = try tmp.dir.createFile(std.testing.io, "stdout", .{ .read = true });
    defer file.close(std.testing.io);
    try std.testing.expect(!isWindowsConsole(file));

    var stdout_output = StdoutOutput.initForFile(std.testing.io, file);
    const expected = "\x1b[31mAé東😀\x1b[0m";
    const split = expected.len / 2;
    for ([_][]const u8{ expected[0..split], expected[split..] }) |part| {
        var input = part;
        while (input.len > 0) input = input[try stdout_output.writeSome(input)..];
    }

    var actual: [expected.len]u8 = undefined;
    const actual_len = try file.readPositionalAll(std.testing.io, &actual, 0);
    try std.testing.expectEqual(expected.len, actual_len);
    try std.testing.expectEqualStrings(expected, &actual);
}

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
            // Batch formatting fragments before backend admission, without retaining bytes between calls.
            var buffer: [256]u8 = undefined;
            var copy = self;
            copy.interface.buffer = &buffer;
            copy.interface.print(format, args) catch return error.BufferFull;
            copy.interface.flush() catch return error.BufferFull;
        }

        pub fn flush(self: *Writer) error{BufferFull}!void {
            self.interface.flush() catch return error.BufferFull;
        }

        fn drain(w: *std.Io.Writer, data: []const []const u8, splat: usize) std.Io.Writer.Error!usize {
            const self: *Writer = @alignCast(@fieldParentPtr("interface", w));
            var written: usize = 0;

            if (w.end > 0) {
                append(self.backend, w.buffered()) catch return error.WriteFailed;
                w.end = 0;
            }

            for (data[0 .. data.len - 1]) |slice| {
                append(self.backend, slice) catch return error.WriteFailed;
                written += slice.len;
            }

            const pattern = data[data.len - 1];
            if (pattern.len == 0) return written;
            for (0..splat) |_| {
                append(self.backend, pattern) catch return error.WriteFailed;
                written += pattern.len;
            }
            return written;
        }
    };
}

test "BackendWriter batches ANSI formatting and preserves write order" {
    const Sink = struct {
        bytes: [2048]u8 = undefined,
        len: usize = 0,
        writes: usize = 0,

        fn append(self: *@This(), data: []const u8) error{BufferFull}!void {
            if (data.len == 0) return;
            if (data.len > self.bytes.len - self.len) return error.BufferFull;
            @memcpy(self.bytes[self.len..][0..data.len], data);
            self.len += data.len;
            self.writes += 1;
        }
    };
    var sink: Sink = .{};
    const writer = BackendWriter(Sink, Sink.append).init(&sink);
    try writer.print("\x1b[{d};{d}H\x1b[38;2;{d};{d};{d}m", .{ 12, 34, 255, 128, 64 });
    const ansi = "\x1b[12;34H\x1b[38;2;255;128;64m";
    try std.testing.expectEqualStrings(ansi, sink.bytes[0..sink.len]);
    try std.testing.expectEqual(@as(usize, 1), sink.writes);

    try writer.writeAll("text");
    try writer.writeByte('!');
    try std.testing.expectEqual(@as(usize, 1), try writer.write("?"));
    try writer.print("<{s}:{d:0>300}:{s}>", .{ utils.repeat(u8, "x", 300), 1, utils.repeat(u8, "y", 300) });
    const expected = ansi ++ "text!?<" ++ utils.repeat(u8, "x", 300) ++ ":" ++ utils.repeat(u8, "0", 299) ++ "1:" ++ utils.repeat(u8, "y", 300) ++ ">";
    try std.testing.expectEqualStrings(expected, sink.bytes[0..sink.len]);
    try std.testing.expectError(error.BufferFull, writer.print("{s}", .{utils.repeat(u8, "z", 2048)}));

    sink = .{};
    var buffered = writer;
    var scratch: [256]u8 = undefined;
    buffered.interface.buffer = &scratch;
    for (0..8) |_| try buffered.interface.writeAll(ansi);
    try std.testing.expectEqual(@as(usize, 0), sink.writes);
    try buffered.flush();
    try std.testing.expectEqual(@as(usize, 1), sink.writes);
    try std.testing.expectEqualStrings(utils.repeat(u8, ansi, 8), sink.bytes[0..sink.len]);
}

/// Backend that atomically publishes complete frames to a
/// `NativeSpanFeed.Stream`. The feed owns its chunk memory; the staging buffer
/// exists only to keep failed frames from exposing partial ANSI sequences.
///
/// Feed writes are in-memory ring-buffer ops with no I/O, so threading adds
/// synchronization cost without latency-hiding benefit. Backpressure skips
/// frames: `prepareFrame` before diffing when the span queue is at its
/// high-water mark, and `endFrame` when the encoded frame exceeds only the free
/// capacity. Already queued bytes remain durable and drain in order.
///
/// Zig tests that want to exercise the feed path should drain the feed directly.
pub const FeedBackend = struct {
    io: std.Io,
    feed: *NativeSpanFeed.Stream,
    frameBytes: std.ArrayListUnmanaged(u8) = .empty,
    frameActive: bool = false,
    frameWriteCount: if (builtin.is_test) usize else void = if (builtin.is_test) 0 else {},

    /// The first staging or publication failure decides the frame: `.skipped`
    /// when the frame fits once queued output drains (output pressure), else
    /// `.failed`. Neither publishes bytes; the renderer forces a full repaint.
    frameStatus: WriteStatus = .ok,
    /// The encoded size of a frame that failed because it is larger than an empty
    /// queue, counted to its end without image uploads; 0 otherwise.
    oversizeBytes: usize = 0,

    /// Image uploads of the frame, in write order. Their bytes are staged but not
    /// charged to the feed: an upload that does not fit waits for a later frame.
    uploads: std.ArrayListUnmanaged(Upload) = .empty,
    upload: ?struct { start: usize, waited: bool, len: usize = 0, cut: bool = false } = null,
    keptUploadBytes: usize = 0,
    /// The frame writes no cells or scrollback besides its images.
    uploadsAlone: bool = false,

    lastWriteTimeUs: ?f64 = null,

    pub const Upload = struct {
        start: usize,
        end: usize,
        placement_id: u32,
        waited: bool,
        state: enum { kept, deferred, too_large },
    };

    pub fn createWithIo(io: std.Io, feed: *NativeSpanFeed.Stream) FeedBackend {
        return .{ .io = io, .feed = feed };
    }

    pub fn deinit(self: *FeedBackend) void {
        // Feed memory is owned by the TypeScript side.
        self.feed.setStagedBytes(0) catch unreachable;
        self.frameBytes.deinit(self.feed.allocator);
        self.uploads.deinit(self.feed.allocator);
    }

    pub fn shouldSkipFrame(self: *FeedBackend) bool {
        const stats = self.feed.getStats();
        const cap = self.feed.options.span_queue_capacity;
        return self.frameActive or (cap > 0 and stats.outstanding_spans >= cap) or
            !self.feed.hasAtomicCapacity();
    }

    pub fn prepareFrame(self: *FeedBackend) WriteStatus {
        if (self.frameActive) return .skipped;
        self.frameStatus = .ok;

        if (self.feed.hasPendingBytes()) {
            self.feed.commit() catch return .skipped;
            // Pending bytes belonged to an earlier frame/control write. Queue
            // them first and let the caller retry the new frame after drain.
            return .skipped;
        }

        if (self.shouldSkipFrame()) return .skipped;
        return .ok;
    }

    pub const Writer = BackendWriter(FeedBackend, frameWrite);

    fn frameWrite(self: *FeedBackend, data: []const u8) error{BufferFull}!void {
        if (builtin.is_test) self.frameWriteCount += 1;
        if (self.upload) |*upload| {
            // Cut an upload that cannot join the kept ones; endUpload classifies it by its full length.
            upload.len +|= data.len;
            if (upload.cut or self.frameStatus != .ok) return;
            if (self.keptUploadBytes +| upload.len <= self.uploadLimit()) return self.stage(data);
            self.frameBytes.shrinkRetainingCapacity(upload.start);
            upload.cut = true;
            return;
        }
        if (self.frameStatus != .ok) {
            if (self.oversizeBytes == 0) return error.BufferFull;
            // Count the rest of a frame that is too large without staging it. Accepting the
            // bytes keeps writers from stopping inside a write, so the count is exact.
            self.oversizeBytes +|= data.len;
            return;
        }
        const required = std.math.add(usize, self.frameBytes.items.len - self.keptUploadBytes, data.len) catch {
            self.failFrame();
            return error.BufferFull;
        };
        self.feed.setStagedBytes(required) catch |err| {
            self.frameStatus = self.admissionStatus(required, err);
            self.failFrame();
            if (self.oversizeBytes == 0) return error.BufferFull;
        };
        if (self.frameStatus != .ok) return;
        return self.stage(data);
    }

    fn stage(self: *FeedBackend, data: []const u8) error{BufferFull}!void {
        const required = self.frameBytes.items.len + data.len;
        const max_bytes = self.feed.byteLimit();
        if (max_bytes != 0 and required > self.frameBytes.capacity) {
            const doubled = std.math.mul(usize, self.frameBytes.capacity, 2) catch required;
            const capacity: usize = @intCast(@max(required, @min(max_bytes, @max(256, doubled))));
            self.frameBytes.ensureTotalCapacityPrecise(self.feed.allocator, capacity) catch {
                self.failFrame();
                return error.BufferFull;
            };
        }
        self.frameBytes.appendSlice(self.feed.allocator, data) catch {
            self.failFrame();
            return error.BufferFull;
        };
    }

    /// Output pressure is transient: a bounded queue rejects bytes that fit
    /// once its queued output drains. Anything else fails the frame.
    fn admissionStatus(self: *FeedBackend, frame_bytes: usize, err: NativeSpanFeed.StreamError) WriteStatus {
        if (err != error.NoSpace and err != error.MaxBytes) return .failed;
        if (!self.feed.bounded()) return .failed;
        if (frame_bytes <= self.feed.atomicByteLimit()) return .skipped;
        self.oversizeBytes = frame_bytes;
        return .failed;
    }

    fn uploadLimit(self: *FeedBackend) u64 {
        return if (self.feed.bounded()) self.feed.atomicByteLimit() else std.math.maxInt(u64);
    }

    /// Open an upload at the end of the staged frame. The caller flushes its writer first.
    /// `waited`: an earlier frame left this upload out.
    pub fn beginUpload(self: *FeedBackend, waited: bool) void {
        std.debug.assert(self.frameActive and self.upload == null);
        self.upload = .{ .start = self.frameBytes.items.len, .waited = waited };
    }

    /// Close the open upload. One larger than an empty queue is too large; one cut
    /// to keep the kept uploads within that size waits for a later frame.
    pub fn endUpload(self: *FeedBackend, placement_id: u32) void {
        const upload = self.upload.?;
        self.upload = null;
        if (self.frameStatus != .ok) return;
        const state: @FieldType(Upload, "state") = if (upload.len > self.uploadLimit())
            .too_large
        else if (upload.cut) .deferred else .kept;
        self.uploads.append(self.feed.allocator, .{
            .start = upload.start,
            .end = self.frameBytes.items.len,
            .placement_id = placement_id,
            .waited = upload.waited,
            .state = state,
        }) catch return self.failFrame();
        if (state == .kept) self.keptUploadBytes += upload.len;
    }

    /// Record an upload that waits for a later frame without writing it.
    pub fn deferUpload(self: *FeedBackend, placement_id: u32) void {
        if (self.frameStatus != .ok) return;
        const end = self.frameBytes.items.len;
        self.uploads.append(self.feed.allocator, .{ .start = end, .end = end, .placement_id = placement_id, .waited = false, .state = .deferred }) catch
            self.failFrame();
    }

    pub fn lastUploadWaits(self: *const FeedBackend) bool {
        const items = self.uploads.items;
        return items.len != 0 and items[items.len - 1].state != .kept;
    }

    /// Remove kept uploads, the last first, until the frame fits an empty queue. An
    /// upload that already waited and does not fit a frame with nothing else is too
    /// large: waiting again would repeat this frame.
    fn trimUploads(self: *FeedBackend) void {
        const others = self.frameBytes.items.len - self.keptUploadBytes;
        var index = self.uploads.items.len;
        while (self.frameBytes.items.len > self.uploadLimit() and index > 0) {
            index -= 1;
            const upload = &self.uploads.items[index];
            if (upload.state != .kept) continue;
            const tail = self.frameBytes.items[upload.end..];
            std.mem.copyForwards(u8, self.frameBytes.items[upload.start..], tail);
            self.frameBytes.shrinkRetainingCapacity(upload.start + tail.len);
            const alone = upload.waited and self.uploadsAlone;
            upload.state = if (alone and others + upload.end - upload.start > self.uploadLimit()) .too_large else .deferred;
        }
    }

    pub fn writer(self: *FeedBackend) Writer {
        return .init(self);
    }

    pub fn beginFrame(self: *FeedBackend) void {
        if (builtin.is_test) self.frameWriteCount = 0;
        self.frameStatus = .ok;
        self.frameActive = true;
        self.oversizeBytes = 0;
        self.uploads.clearRetainingCapacity();
        self.upload = null;
        self.keptUploadBytes = 0;
        self.uploadsAlone = false;
        self.feed.setStagedBytes(0) catch unreachable;
        self.frameBytes.clearRetainingCapacity();
    }

    /// Release the frame's staging. An earlier status wins: encoding errors after
    /// output pressure can be its consequence.
    pub fn failFrame(self: *FeedBackend) void {
        if (self.frameStatus == .ok) self.frameStatus = .failed;
        self.keptUploadBytes = 0;
        self.feed.setStagedBytes(0) catch unreachable;
        self.frameBytes.clearRetainingCapacity();
    }

    pub fn endFrame(self: *FeedBackend) WriteStatus {
        const writeStart = std.Io.Clock.awake.now(self.io);
        var status = self.frameStatus;
        var notify = false;
        self.feed.setStagedBytes(0) catch unreachable;

        if (status == .ok) {
            self.trimUploads();
            notify = self.feed.writeAtomicUnnotified(self.frameBytes.items) catch |err| blk: {
                status = self.admissionStatus(self.frameBytes.items.len, err);
                break :blk false;
            };
        }

        self.frameActive = false;
        self.frameBytes.clearRetainingCapacity();
        self.lastWriteTimeUs = @as(f64, @floatFromInt(writeStart.untilNow(self.io, .awake).toMicroseconds()));
        self.feed.finish(notify, 0);
        return status;
    }

    /// A control write between frames. A rejected write publishes nothing.
    pub fn writeOut(self: *FeedBackend, data: []const u8) void {
        std.debug.assert(!self.frameActive);
        self.feed.writeAtomic(data) catch {};
    }
};
