const std = @import("std");
const builtin = @import("builtin");
const clipboard_clock = @import("clock.zig");
const clipboard_windows_dib = @import("windows-dib.zig");

const Allocator = std.mem.Allocator;

const CF_DIB: u32 = 8;
const CF_UNICODETEXT: u32 = 13;
const CF_DIBV5: u32 = 17;
const GMEM_MOVEABLE: u32 = 0x2;
const OPEN_RETRY_SLEEP_NS: u64 = 5 * std.time.ns_per_ms;
const COPY_STOP_INTERVAL: usize = 4096;
const PUMP_MESSAGES_MAX: usize = 64;
const ERROR_OUTOFMEMORY: u32 = 14;
const ERROR_INVALID_DATA: u32 = 13;
const PM_REMOVE: u32 = 1;

const win32 = struct {
    const Point = extern struct { x: i32, y: i32 };
    const Message = extern struct {
        window: ?*anyopaque,
        message: u32,
        wparam: usize,
        lparam: isize,
        time: u32,
        point: Point,
        private: u32,
    };

    extern "user32" fn OpenClipboard(owner: ?*anyopaque) callconv(.winapi) i32;
    extern "user32" fn CloseClipboard() callconv(.winapi) i32;
    extern "user32" fn EmptyClipboard() callconv(.winapi) i32;
    extern "user32" fn GetClipboardData(format: u32) callconv(.winapi) ?*anyopaque;
    extern "user32" fn IsClipboardFormatAvailable(format: u32) callconv(.winapi) i32;
    extern "user32" fn RegisterClipboardFormatW(name: [*:0]const u16) callconv(.winapi) u32;
    extern "user32" fn SetClipboardData(format: u32, memory: ?*anyopaque) callconv(.winapi) ?*anyopaque;
    extern "user32" fn PeekMessageW(message: *Message, window: ?*anyopaque, minimum: u32, maximum: u32, remove: u32) callconv(.winapi) i32;
    extern "user32" fn TranslateMessage(message: *const Message) callconv(.winapi) i32;
    extern "user32" fn DispatchMessageW(message: *const Message) callconv(.winapi) isize;
    extern "user32" fn CreateWindowExW(
        extended_style: u32,
        class_name: [*:0]const u16,
        window_name: [*:0]const u16,
        style: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        parent: ?*anyopaque,
        menu: ?*anyopaque,
        instance: ?*anyopaque,
        parameter: ?*anyopaque,
    ) callconv(.winapi) ?*anyopaque;
    extern "user32" fn DestroyWindow(window: *anyopaque) callconv(.winapi) i32;

    extern "kernel32" fn GetCurrentThreadId() callconv(.winapi) u32;
    extern "kernel32" fn GetLastError() callconv(.winapi) u32;
    extern "kernel32" fn GlobalAlloc(flags: u32, size_bytes: usize) callconv(.winapi) ?*anyopaque;
    extern "kernel32" fn GlobalFree(memory: ?*anyopaque) callconv(.winapi) ?*anyopaque;
    extern "kernel32" fn GlobalLock(memory: ?*anyopaque) callconv(.winapi) ?*anyopaque;
    extern "kernel32" fn GlobalSize(memory: ?*anyopaque) callconv(.winapi) usize;
    extern "kernel32" fn GlobalUnlock(memory: ?*anyopaque) callconv(.winapi) i32;
};

pub const Status = enum {
    read,
    empty,
    written,
    cleared,
    unsupported,
    cancelled,
    timed_out,
    limit_exceeded,
    invalid_request,
    failed,
};

pub const Result = struct {
    status: Status,
    mime: []u8 = &.{},
    data: []u8 = &.{},
    error_code: u32 = 0,

    pub fn deinit(result: *Result, allocator: Allocator) void {
        if (result.status == .read) {
            allocator.free(result.mime);
            allocator.free(result.data);
        }
        result.* = .{ .status = .failed };
    }
};

pub const ReadJob = struct {
    // Same framing as host.zig: u32 count, then repeated u32 byte length and MIME bytes.
    request: []const u8,
    max_bytes: u32,
    max_image_pixels: u32,
    max_conversion_bytes: u32,
};

pub const Job = union(enum) {
    read: ReadJob,
    write: []const u8,
    clear,
};

pub const ExecuteOptions = struct {
    cancel_requested: ?*const std.atomic.Value(bool) = null,
    begin_mutation: ?*const fn (?*anyopaque) ?Status = null,
    mutation_context: ?*anyopaque = null,
    deadline_ns: i128,
};

pub const InitError = error{
    UnsupportedPlatform,
    ClipboardFormatRegistrationFailed,
    WindowCreationFailed,
};

pub const Worker = struct {
    thread_id: u32,
    png_format: u32,
    owner_window: *anyopaque,
    initialized: bool,

    pub fn init() InitError!Worker {
        if (comptime builtin.os.tag != .windows) return error.UnsupportedPlatform;

        const png_format = win32.RegisterClipboardFormatW(std.unicode.utf8ToUtf16LeStringLiteral("PNG"));
        if (png_format == 0) return error.ClipboardFormatRegistrationFailed;
        const owner_window = win32.CreateWindowExW(
            0,
            std.unicode.utf8ToUtf16LeStringLiteral("STATIC"),
            std.unicode.utf8ToUtf16LeStringLiteral("OpenTUI Clipboard"),
            0,
            0,
            0,
            0,
            0,
            null,
            null,
            null,
            null,
        ) orelse return error.WindowCreationFailed;
        return .{
            .thread_id = win32.GetCurrentThreadId(),
            .png_format = png_format,
            .owner_window = owner_window,
            .initialized = true,
        };
    }

    pub fn deinit(worker: *Worker) void {
        if (comptime builtin.os.tag != .windows) return;
        std.debug.assert(worker.initialized);
        std.debug.assert(worker.thread_id == win32.GetCurrentThreadId());
        std.debug.assert(win32.DestroyWindow(worker.owner_window) != 0);
        worker.initialized = false;
    }

    pub fn execute(worker: *Worker, allocator: Allocator, job: Job, options: ExecuteOptions) Result {
        if (comptime builtin.os.tag != .windows) return .{ .status = .unsupported };
        std.debug.assert(worker.initialized);
        std.debug.assert(worker.thread_id == win32.GetCurrentThreadId());

        if (job == .read and !validateReadRequest(job.read.request)) {
            return .{ .status = .invalid_request, .error_code = ERROR_INVALID_DATA };
        }

        var prepared: PreparedWrite = if (job == .write)
            prepareWrite(job.write, options) catch |err| {
                return preparationFailure(err);
            }
        else
            .{ .memory = null };
        defer prepared.deinit();

        if (checkStop(options)) |status| return .{ .status = status };
        if (worker.openClipboard(options)) |failure| return failure;
        var clipboard = ClipboardSession{};
        defer clipboard.close();
        if (checkStop(options)) |status| return .{ .status = status };

        return switch (job) {
            .read => |read| worker.executeRead(allocator, read, options, &clipboard),
            .write => if (beginMutation(options)) |status| .{ .status = status } else worker.executeWrite(&prepared),
            .clear => if (beginMutation(options)) |status| .{ .status = status } else executeClear(),
        };
    }

    pub fn pumpMessages(worker: *const Worker) bool {
        if (comptime builtin.os.tag != .windows) return false;
        std.debug.assert(worker.initialized);
        std.debug.assert(worker.thread_id == win32.GetCurrentThreadId());
        var message: win32.Message = undefined;
        var message_count: usize = 0;
        while (message_count < PUMP_MESSAGES_MAX) : (message_count += 1) {
            if (win32.PeekMessageW(&message, null, 0, 0, PM_REMOVE) == 0) return false;
            _ = win32.TranslateMessage(&message);
            _ = win32.DispatchMessageW(&message);
        }
        return true;
    }

    fn openClipboard(worker: *const Worker, options: ExecuteOptions) ?Result {
        while (true) {
            if (checkStop(options)) |status| return .{ .status = status };
            if (win32.OpenClipboard(worker.owner_window) != 0) return null;

            _ = worker.pumpMessages();
            if (checkStop(options)) |status| return .{ .status = status };
            const now_ns = clipboard_clock.nowNs();
            if (now_ns >= options.deadline_ns) return .{ .status = .timed_out };
            const remaining_ns: u64 = @intCast(@min(options.deadline_ns - now_ns, std.math.maxInt(u64)));
            const sleep_ns = @min(OPEN_RETRY_SLEEP_NS, remaining_ns);
            std.debug.assert(sleep_ns > 0);
            clipboard_clock.sleep(sleep_ns);
        }
    }

    fn executeRead(
        worker: *const Worker,
        allocator: Allocator,
        job: ReadJob,
        options: ExecuteOptions,
        clipboard: *ClipboardSession,
    ) Result {
        var iterator = PreferenceIterator.init(job.request) catch unreachable;
        var supported = false;
        var first_failure: ?Result = null;
        while (iterator.next() catch unreachable) |mime| {
            if (checkStop(options)) |status| return .{ .status = status };
            const result = if (std.ascii.eqlIgnoreCase(mime, "text/plain")) blk: {
                supported = true;
                if (worker.ensureClipboardOpen(options, clipboard)) |failure| return failure;
                std.debug.assert(clipboard.is_open);
                if (win32.IsClipboardFormatAvailable(CF_UNICODETEXT) == 0) continue;
                if (checkStop(options)) |status| return .{ .status = status };
                break :blk readText(allocator, mime, job.max_bytes, options);
            } else if (std.ascii.eqlIgnoreCase(mime, "image/png")) blk: {
                supported = true;
                if (worker.ensureClipboardOpen(options, clipboard)) |failure| return failure;
                break :blk worker.readImage(allocator, mime, job, options, clipboard);
            } else continue;
            switch (readCandidateAction(result)) {
                .return_result => return result,
                .continue_candidate => {},
                .remember_failure => rememberCandidateFailure(&first_failure, result),
            }
        }
        if (first_failure) |failure| return failure;
        return .{ .status = if (supported) .empty else .unsupported };
    }

    fn readImage(
        worker: *const Worker,
        allocator: Allocator,
        mime: []const u8,
        job: ReadJob,
        options: ExecuteOptions,
        clipboard: *ClipboardSession,
    ) Result {
        const formats = [_]u32{ worker.png_format, CF_DIBV5, CF_DIB };
        var first_failure: ?Result = null;
        for (formats, 0..) |format, format_index| {
            std.debug.assert(clipboard.is_open);
            if (checkStop(options)) |status| return .{ .status = status };
            if (win32.IsClipboardFormatAvailable(format) == 0) continue;
            const result = if (format == worker.png_format)
                readBytes(allocator, mime, format, job.max_bytes, options)
            else
                readDib(allocator, mime, format, job, options, clipboard);
            const action = readCandidateAction(result);
            switch (action) {
                .return_result => return result,
                .continue_candidate => {},
                .remember_failure => rememberCandidateFailure(&first_failure, result),
            }
            if (!clipboard.is_open and format_index + 1 < formats.len) {
                if (worker.ensureClipboardOpen(options, clipboard)) |failure| return failure;
            }
        }
        return first_failure orelse .{ .status = .empty };
    }

    fn ensureClipboardOpen(
        worker: *const Worker,
        options: ExecuteOptions,
        clipboard: *ClipboardSession,
    ) ?Result {
        if (clipboard.is_open) return null;
        if (worker.openClipboard(options)) |failure| return failure;
        clipboard.is_open = true;
        return null;
    }

    fn executeWrite(_: *const Worker, prepared: *PreparedWrite) Result {
        if (win32.EmptyClipboard() == 0) return lastErrorResult();
        const memory = prepared.memory orelse unreachable;
        if (win32.SetClipboardData(CF_UNICODETEXT, memory) == null) return lastErrorResult();
        prepared.memory = null; // SetClipboardData owns the HGLOBAL after success.
        return .{ .status = .written };
    }
};

const PreparedWrite = struct {
    memory: ?*anyopaque,

    fn deinit(prepared: *PreparedWrite) void {
        if (prepared.memory) |memory| std.debug.assert(win32.GlobalFree(memory) == null);
        prepared.memory = null;
    }
};

const ClipboardSession = struct {
    is_open: bool = true,

    fn close(clipboard: *ClipboardSession) void {
        if (!clipboard.is_open) return;
        clipboard.is_open = false;
        _ = win32.CloseClipboard();
    }
};

const PreferenceIterator = struct {
    request: []const u8,
    count: u32,
    index: u32 = 0,
    offset: usize = 4,

    fn init(request: []const u8) error{InvalidRequest}!PreferenceIterator {
        if (!validateReadRequest(request)) return error.InvalidRequest;
        return .{ .request = request, .count = std.mem.readInt(u32, request[0..4], .little) };
    }

    fn next(iterator: *PreferenceIterator) error{InvalidRequest}!?[]const u8 {
        if (iterator.index == iterator.count) {
            if (iterator.offset != iterator.request.len) return error.InvalidRequest;
            return null;
        }
        if (iterator.request.len - iterator.offset < 4) return error.InvalidRequest;
        const length = std.mem.readInt(u32, iterator.request[iterator.offset..][0..4], .little);
        iterator.offset += 4;
        if (length == 0 or length > iterator.request.len - iterator.offset) return error.InvalidRequest;
        const mime = iterator.request[iterator.offset..][0..length];
        iterator.offset += length;
        iterator.index += 1;
        return mime;
    }
};

const ConversionError = error{
    InvalidUtf8,
    InvalidUtf16,
    EmbeddedNul,
    MissingNul,
    LimitExceeded,
    OutOfMemory,
    Cancelled,
    TimedOut,
};

const ReadCandidateAction = enum { return_result, continue_candidate, remember_failure };

fn validateReadRequest(request: []const u8) bool {
    if (request.len < 4) return false;
    const count = std.mem.readInt(u32, request[0..4], .little);
    if (count == 0) return false;
    var iterator = PreferenceIterator{
        .request = request,
        .count = count,
    };
    while (iterator.next() catch return false) |_| {}
    return true;
}

const NormalizedUtf8Iterator = struct {
    bytes: []const u8,
    index: usize = 0,
    pending_lf: bool = false,

    fn next(iterator: *NormalizedUtf8Iterator) ConversionError!?u21 {
        if (iterator.pending_lf) {
            iterator.pending_lf = false;
            return '\n';
        }
        if (iterator.index == iterator.bytes.len) return null;
        const sequence_length = std.unicode.utf8ByteSequenceLength(iterator.bytes[iterator.index]) catch
            return error.InvalidUtf8;
        if (sequence_length > iterator.bytes.len - iterator.index) return error.InvalidUtf8;
        const codepoint = std.unicode.utf8Decode(
            iterator.bytes[iterator.index..][0..sequence_length],
        ) catch return error.InvalidUtf8;
        iterator.index += sequence_length;
        if (codepoint == 0) return error.EmbeddedNul;
        if (codepoint == '\r') {
            if (iterator.index < iterator.bytes.len and iterator.bytes[iterator.index] == '\n') iterator.index += 1;
            iterator.pending_lf = true;
            return '\r';
        }
        if (codepoint == '\n') {
            iterator.pending_lf = true;
            return '\r';
        }
        return codepoint;
    }
};

fn encodeClipboardText(
    utf8: []const u8,
    output: ?[]u16,
    options: ExecuteOptions,
) ConversionError!usize {
    var iterator = NormalizedUtf8Iterator{ .bytes = utf8 };
    var output_index: usize = 0;
    var next_stop: usize = 0;
    while (try iterator.next()) |codepoint| {
        if (iterator.index >= next_stop) {
            try checkConversionStop(options);
            next_stop = std.math.add(usize, iterator.index, COPY_STOP_INTERVAL) catch std.math.maxInt(usize);
        }
        const sequence_length = std.unicode.utf16CodepointSequenceLength(codepoint) catch unreachable;
        const next_index = std.math.add(usize, output_index, sequence_length) catch return error.LimitExceeded;
        if (output) |destination| {
            std.debug.assert(next_index < destination.len);
            if (codepoint <= 0xffff) {
                destination[output_index] = @intCast(codepoint);
            } else {
                const value = codepoint - 0x10000;
                destination[output_index] = @intCast(0xd800 + (value >> 10));
                destination[output_index + 1] = @intCast(0xdc00 + (value & 0x3ff));
            }
        }
        output_index = next_index;
    }
    try checkConversionStop(options);
    if (output) |destination| {
        std.debug.assert(output_index + 1 == destination.len);
        destination[output_index] = 0;
    }
    return output_index;
}

fn clipboardTextToUtf8(
    allocator: Allocator,
    utf16: []const u16,
    max_bytes: u32,
    options: ExecuteOptions,
) ConversionError![]u8 {
    const scan_length = @min(utf16.len, @as(usize, max_bytes) + 1);
    var nul_index: ?usize = null;
    var scan_index: usize = 0;
    while (scan_index < scan_length) : (scan_index += 1) {
        if (scan_index % COPY_STOP_INTERVAL == 0) try checkConversionStop(options);
        if (utf16[scan_index] == 0) {
            nul_index = scan_index;
            break;
        }
    }
    const terminator = nul_index orelse {
        if (utf16.len > max_bytes) return error.LimitExceeded;
        return error.MissingNul;
    };
    const text = utf16[0..terminator];
    var iterator = std.unicode.Utf16LeIterator.init(text);
    var size_bytes: usize = 0;
    var next_stop: usize = 0;
    while (iterator.nextCodepoint() catch return error.InvalidUtf16) |codepoint| {
        if (iterator.i >= next_stop) {
            try checkConversionStop(options);
            next_stop = std.math.add(usize, iterator.i, COPY_STOP_INTERVAL) catch std.math.maxInt(usize);
        }
        const sequence_length = std.unicode.utf8CodepointSequenceLength(codepoint) catch unreachable;
        size_bytes = std.math.add(usize, size_bytes, sequence_length) catch return error.LimitExceeded;
        if (size_bytes > max_bytes) return error.LimitExceeded;
    }

    const output = try allocator.alloc(u8, size_bytes);
    errdefer allocator.free(output);
    iterator = std.unicode.Utf16LeIterator.init(text);
    var offset: usize = 0;
    next_stop = 0;
    while (iterator.nextCodepoint() catch unreachable) |codepoint| {
        if (iterator.i >= next_stop) {
            try checkConversionStop(options);
            next_stop = std.math.add(usize, iterator.i, COPY_STOP_INTERVAL) catch std.math.maxInt(usize);
        }
        offset += std.unicode.utf8Encode(codepoint, output[offset..]) catch unreachable;
    }
    try checkConversionStop(options);
    std.debug.assert(offset == output.len);
    return output;
}

fn prepareWrite(data: []const u8, options: ExecuteOptions) ConversionError!PreparedWrite {
    const length = try encodeClipboardText(data, null, options);
    const length_with_nul = std.math.add(usize, length, 1) catch return error.LimitExceeded;
    const size_bytes = std.math.mul(usize, length_with_nul, @sizeOf(u16)) catch return error.LimitExceeded;
    const memory = win32.GlobalAlloc(GMEM_MOVEABLE, size_bytes) orelse return error.OutOfMemory;
    errdefer std.debug.assert(win32.GlobalFree(memory) == null);
    const pointer = win32.GlobalLock(memory) orelse return error.OutOfMemory;
    defer _ = win32.GlobalUnlock(memory);
    const destination: [*]u16 = @ptrCast(@alignCast(pointer));
    const written = try encodeClipboardText(data, destination[0..length_with_nul], options);
    std.debug.assert(written == length);
    return .{ .memory = memory };
}

fn preparationFailure(err: ConversionError) Result {
    return switch (err) {
        error.OutOfMemory => .{ .status = .failed, .error_code = ERROR_OUTOFMEMORY },
        error.LimitExceeded => .{ .status = .limit_exceeded },
        error.Cancelled => .{ .status = .cancelled },
        error.TimedOut => .{ .status = .timed_out },
        error.InvalidUtf8, error.InvalidUtf16, error.EmbeddedNul, error.MissingNul => .{ .status = .invalid_request, .error_code = ERROR_INVALID_DATA },
    };
}

fn checkStop(options: ExecuteOptions) ?Status {
    if (options.cancel_requested) |cancelled| {
        if (cancelled.load(.acquire)) return .cancelled;
    }
    if (options.deadline_ns == std.math.maxInt(i128)) return null;
    if (clipboard_clock.nowNs() >= options.deadline_ns) return .timed_out;
    return null;
}

fn checkConversionStop(options: ExecuteOptions) ConversionError!void {
    if (checkStop(options)) |status| return switch (status) {
        .cancelled => error.Cancelled,
        .timed_out => error.TimedOut,
        else => unreachable,
    };
}

fn beginMutation(options: ExecuteOptions) ?Status {
    if (checkStop(options)) |status| return status;
    const begin = options.begin_mutation orelse return .invalid_request;
    return begin(options.mutation_context);
}

fn executeClear() Result {
    if (win32.EmptyClipboard() == 0) return lastErrorResult();
    return .{ .status = .cleared };
}

fn copyBytesChecked(destination: []u8, source: []const u8, options: ExecuteOptions) ConversionError!void {
    std.debug.assert(destination.len == source.len);
    var offset: usize = 0;
    while (offset < source.len) {
        try checkConversionStop(options);
        const end = @min(source.len, offset + COPY_STOP_INTERVAL);
        @memcpy(destination[offset..end], source[offset..end]);
        offset = end;
    }
    try checkConversionStop(options);
}

fn copyBytesBounded(
    allocator: Allocator,
    source: []const u8,
    max_bytes: usize,
    options: ExecuteOptions,
) ConversionError![]u8 {
    if (source.len > max_bytes) return error.LimitExceeded;
    try checkConversionStop(options);
    const destination = allocator.alloc(u8, source.len) catch return error.OutOfMemory;
    errdefer allocator.free(destination);
    try copyBytesChecked(destination, source, options);
    return destination;
}

fn testOptions() ExecuteOptions {
    return .{ .deadline_ns = std.math.maxInt(i128) };
}

fn readText(allocator: Allocator, mime: []const u8, max_bytes: u32, options: ExecuteOptions) Result {
    const memory = win32.GetClipboardData(CF_UNICODETEXT) orelse return lastErrorResult();
    const size_bytes = win32.GlobalSize(memory);
    if (size_bytes < @sizeOf(u16) or size_bytes % @sizeOf(u16) != 0) {
        return .{ .status = .failed, .error_code = ERROR_INVALID_DATA };
    }
    const pointer = win32.GlobalLock(memory) orelse return lastErrorResult();
    defer _ = win32.GlobalUnlock(memory);
    const utf16_pointer: [*]const u16 = @ptrCast(@alignCast(pointer));
    const data = clipboardTextToUtf8(allocator, utf16_pointer[0 .. size_bytes / 2], max_bytes, options) catch |err| {
        return switch (err) {
            error.LimitExceeded => .{ .status = .limit_exceeded },
            error.Cancelled => .{ .status = .cancelled },
            error.TimedOut => .{ .status = .timed_out },
            error.OutOfMemory => .{ .status = .failed, .error_code = ERROR_OUTOFMEMORY },
            else => .{ .status = .failed, .error_code = ERROR_INVALID_DATA },
        };
    };
    return readResult(allocator, mime, data, options);
}

fn readBytes(allocator: Allocator, mime: []const u8, format: u32, max_bytes: u32, options: ExecuteOptions) Result {
    const memory = win32.GetClipboardData(format) orelse return lastErrorResult();
    const size_bytes = win32.GlobalSize(memory);
    if (size_bytes == 0) return .{ .status = .empty };
    if (size_bytes > max_bytes) return .{ .status = .limit_exceeded };
    const pointer = win32.GlobalLock(memory) orelse return lastErrorResult();
    defer _ = win32.GlobalUnlock(memory);
    const source: [*]const u8 = @ptrCast(pointer);
    const data = copyBytesBounded(allocator, source[0..size_bytes], max_bytes, options) catch |err| {
        return conversionFailure(err);
    };
    return readResult(allocator, mime, data, options);
}

fn readDib(
    allocator: Allocator,
    mime: []const u8,
    format: u32,
    job: ReadJob,
    options: ExecuteOptions,
    clipboard: *ClipboardSession,
) Result {
    const memory = win32.GetClipboardData(format) orelse return lastErrorResult();
    const size_bytes = win32.GlobalSize(memory);
    if (size_bytes == 0) return .{ .status = .empty };
    if (size_bytes > job.max_conversion_bytes) return .{ .status = .limit_exceeded };
    const pointer = win32.GlobalLock(memory) orelse return lastErrorResult();
    const source: [*]const u8 = @ptrCast(pointer);
    const dib = copyBytesBounded(allocator, source[0..size_bytes], job.max_conversion_bytes, options) catch |err| {
        _ = win32.GlobalUnlock(memory);
        return conversionFailure(err);
    };
    _ = win32.GlobalUnlock(memory);
    clipboard.close();
    defer allocator.free(dib);

    const data = clipboard_windows_dib.convertToPng(allocator, dib, .{
        .max_output_bytes = job.max_bytes,
        .max_image_pixels = job.max_image_pixels,
        .max_conversion_bytes = job.max_conversion_bytes,
        .cancel_requested = options.cancel_requested,
        .deadline_ns = options.deadline_ns,
    }) catch |err| {
        return switch (err) {
            error.Unsupported => .{ .status = .empty },
            error.LimitExceeded => .{ .status = .limit_exceeded },
            error.Cancelled => .{ .status = .cancelled },
            error.TimedOut => .{ .status = .timed_out },
            error.OutOfMemory => .{ .status = .failed, .error_code = ERROR_OUTOFMEMORY },
            error.InvalidData => .{ .status = .failed, .error_code = ERROR_INVALID_DATA },
        };
    };
    return readResult(allocator, mime, data, options);
}

fn conversionFailure(err: ConversionError) Result {
    return switch (err) {
        error.LimitExceeded => .{ .status = .limit_exceeded },
        error.Cancelled => .{ .status = .cancelled },
        error.TimedOut => .{ .status = .timed_out },
        error.OutOfMemory => .{ .status = .failed, .error_code = ERROR_OUTOFMEMORY },
        else => .{ .status = .failed, .error_code = ERROR_INVALID_DATA },
    };
}

fn readResult(allocator: Allocator, mime: []const u8, data: []u8, options: ExecuteOptions) Result {
    if (checkStop(options)) |status| {
        allocator.free(data);
        return .{ .status = status };
    }
    const owned_mime = allocator.dupe(u8, mime) catch {
        allocator.free(data);
        return .{ .status = .failed, .error_code = ERROR_OUTOFMEMORY };
    };
    if (checkStop(options)) |status| {
        allocator.free(owned_mime);
        allocator.free(data);
        return .{ .status = status };
    }
    return .{ .status = .read, .mime = owned_mime, .data = data };
}

fn readCandidateAction(result: Result) ReadCandidateAction {
    return switch (result.status) {
        .empty, .unsupported => .continue_candidate,
        .failed => if (result.error_code == ERROR_OUTOFMEMORY) .return_result else .remember_failure,
        else => .return_result,
    };
}

fn rememberCandidateFailure(first_failure: *?Result, result: Result) void {
    std.debug.assert(readCandidateAction(result) == .remember_failure);
    if (first_failure.* == null) first_failure.* = result;
}

fn lastErrorResult() Result {
    return .{ .status = .failed, .error_code = win32.GetLastError() };
}

test "Windows clipboard MIME request parsing preserves preference order" {
    const request = [_]u8{
        3,   0,   0,   0,
        9,   0,   0,   0,
        'i', 'm', 'a', 'g',
        'e', '/', 'p', 'n',
        'g', 10,  0,   0,
        0,   't', 'e', 'x',
        't', '/', 'p', 'l',
        'a', 'i', 'n', 3,
        0,   0,   0,   'f',
        'o', 'o',
    };
    var iterator = try PreferenceIterator.init(&request);
    try std.testing.expectEqualStrings("image/png", (try iterator.next()).?);
    try std.testing.expectEqualStrings("text/plain", (try iterator.next()).?);
    try std.testing.expectEqualStrings("foo", (try iterator.next()).?);
    try std.testing.expect((try iterator.next()) == null);
}

test "Windows clipboard MIME request parsing rejects malformed framing" {
    try std.testing.expect(!validateReadRequest(&.{ 0, 0, 0, 0 }));
    try std.testing.expect(!validateReadRequest(&.{ 1, 0, 0, 0, 0, 0, 0, 0 }));
    try std.testing.expect(!validateReadRequest(&.{ 1, 0, 0, 0, 2, 0, 0, 0, 'x' }));
    try std.testing.expect(!validateReadRequest(&.{ 1, 0, 0, 0, 1, 0, 0, 0, 'x', 'y' }));
}

test "Windows clipboard reads retain candidate failures while trying later preferences" {
    try std.testing.expectEqual(ReadCandidateAction.continue_candidate, readCandidateAction(.{ .status = .empty }));
    try std.testing.expectEqual(ReadCandidateAction.continue_candidate, readCandidateAction(.{ .status = .unsupported }));
    try std.testing.expectEqual(
        ReadCandidateAction.remember_failure,
        readCandidateAction(.{ .status = .failed, .error_code = ERROR_INVALID_DATA }),
    );
    try std.testing.expectEqual(
        ReadCandidateAction.return_result,
        readCandidateAction(.{ .status = .failed, .error_code = ERROR_OUTOFMEMORY }),
    );
    try std.testing.expectEqual(ReadCandidateAction.return_result, readCandidateAction(.{ .status = .limit_exceeded }));

    var first_failure: ?Result = null;
    rememberCandidateFailure(&first_failure, .{ .status = .failed, .error_code = ERROR_INVALID_DATA });
    rememberCandidateFailure(&first_failure, .{ .status = .failed, .error_code = 1 });
    try std.testing.expectEqual(ERROR_INVALID_DATA, first_failure.?.error_code);
}

test "Windows clipboard text conversion round trips Unicode and terminates UTF-16" {
    var utf16: [9]u16 = undefined;
    _ = try encodeClipboardText("plain \u{1f642}", &utf16, testOptions());
    try std.testing.expectEqual(@as(u16, 0), utf16[utf16.len - 1]);

    const utf8 = try clipboardTextToUtf8(std.testing.allocator, &utf16, 64, testOptions());
    defer std.testing.allocator.free(utf8);
    try std.testing.expectEqualStrings("plain \u{1f642}", utf8);
}

test "Windows clipboard text conversion normalizes CF_UNICODETEXT line endings" {
    var utf16: [11]u16 = undefined;
    _ = try encodeClipboardText("a\nb\r\nc\rd", &utf16, testOptions());
    const utf8 = try clipboardTextToUtf8(std.testing.allocator, &utf16, 64, testOptions());
    defer std.testing.allocator.free(utf8);
    try std.testing.expectEqualStrings("a\r\nb\r\nc\r\nd", utf8);
}

test "Windows clipboard text conversion validates NUL and UTF-16" {
    try std.testing.expectError(error.EmbeddedNul, encodeClipboardText("a\x00b", null, testOptions()));
    try std.testing.expectError(
        error.MissingNul,
        clipboardTextToUtf8(std.testing.allocator, &.{ 'a', 'b' }, 8, testOptions()),
    );
    try std.testing.expectError(
        error.InvalidUtf16,
        clipboardTextToUtf8(std.testing.allocator, &.{ 0xd800, 0 }, 8, testOptions()),
    );
}

test "Windows clipboard bounded copy accepts the exact limit" {
    const source = "bytes";
    const exact = try copyBytesBounded(std.testing.allocator, source, source.len, testOptions());
    defer std.testing.allocator.free(exact);
    try std.testing.expectEqualSlices(u8, source, exact);
    try std.testing.expectError(
        error.LimitExceeded,
        copyBytesBounded(std.testing.allocator, source, source.len - 1, testOptions()),
    );
}

test "Windows clipboard bounded helpers observe cancellation and deadlines" {
    try clipboard_clock.init();
    var cancelled = std.atomic.Value(bool).init(true);
    var options = testOptions();
    options.cancel_requested = &cancelled;
    try std.testing.expectError(
        error.Cancelled,
        copyBytesBounded(std.testing.allocator, "bytes", 5, options),
    );
    try std.testing.expectError(
        error.Cancelled,
        encodeClipboardText("text", null, options),
    );

    cancelled.store(false, .release);
    options.deadline_ns = clipboard_clock.nowNs() - 1;
    try std.testing.expectError(
        error.TimedOut,
        copyBytesBounded(std.testing.allocator, "bytes", 5, options),
    );
    try std.testing.expectError(
        error.TimedOut,
        clipboardTextToUtf8(std.testing.allocator, &.{ 't', 0 }, 1, options),
    );
}

test "Windows clipboard UTF-16 scan is bounded by output limit" {
    const exact = try clipboardTextToUtf8(std.testing.allocator, &.{ 'a', 'b', 0 }, 2, testOptions());
    defer std.testing.allocator.free(exact);
    try std.testing.expectEqualStrings("ab", exact);
    try std.testing.expectError(
        error.LimitExceeded,
        clipboardTextToUtf8(std.testing.allocator, &.{ 'a', 'b', 0 }, 1, testOptions()),
    );
}
