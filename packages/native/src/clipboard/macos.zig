const std = @import("std");
const clipboard_clock = @import("clock.zig");
const sync = @import("sync.zig");

const Allocator = std.mem.Allocator;
const LOCK_RETRY_SLEEP_NS: u64 = std.time.ns_per_ms;

var pasteboard_mutex: sync.Mutex = .{};

pub const MimeType = enum(u32) {
    text_plain = 1,
    image_png = 2,

    pub fn name(mime: MimeType) []const u8 {
        return switch (mime) {
            .text_plain => "text/plain",
            .image_png => "image/png",
        };
    }
};

pub const ReadJob = struct {
    request: []const u8,
    max_bytes: u32,
    max_image_pixels: u32,
    max_conversion_bytes: u32,
};

pub const WriteTextJob = struct {
    text: []const u8,
};

pub const Job = union(enum) {
    read: ReadJob,
    write_text: WriteTextJob,
    clear,
};

pub const ReadResult = struct {
    mime: MimeType,
    data: []u8,
};

pub const Result = union(enum) {
    read: ReadResult,
    empty,
    written,
    cleared,
    unsupported,
    cancelled,
    timed_out,
    failed,

    pub fn deinit(result: *Result, allocator: Allocator) void {
        switch (result.*) {
            .read => |read_result| allocator.free(read_result.data),
            else => {},
        }
        result.* = undefined;
    }
};

pub const Status = enum {
    cancelled,
    timed_out,
    failed,
};

pub const JobError = error{
    InvalidArgument,
    InvalidText,
    LimitExceeded,
    NativeFailure,
    OutOfMemory,
};

pub const ExecuteOptions = struct {
    cancel_requested: ?*const std.atomic.Value(bool) = null,
    begin_mutation: ?*const fn (?*anyopaque) ?Status = null,
    mutation_context: ?*anyopaque = null,
    deadline_ns: i128,
};

const ShimStatus = enum(i32) {
    ok = 0,
    empty = 1,
    limit_exceeded = 2,
    invalid_argument = 3,
    invalid_text = 4,
    failed = 5,
    cancelled = 6,
    timed_out = 7,
};

extern fn ot_clipboard_macos_read(
    mime: u32,
    max_bytes: u32,
    max_image_pixels: u32,
    max_conversion_bytes: u32,
    stop_callback: ?*const fn (?*const anyopaque) callconv(.c) i32,
    stop_context: ?*const anyopaque,
    out_bytes: *?[*]u8,
    out_length: *u32,
) i32;
extern fn ot_clipboard_macos_write_text(bytes: ?[*]const u8, length: u32) i32;
extern fn ot_clipboard_macos_clear() i32;
extern fn ot_clipboard_macos_free_bytes(bytes: ?[*]u8) void;
extern fn ot_clipboard_macos_test_bounded_output(
    limit: u32,
    first_count: u32,
    second_count: u32,
    out_length: *u32,
) i32;

comptime {
    std.debug.assert(@sizeOf(MimeType) == @sizeOf(u32));
}

pub fn runJob(allocator: Allocator, job: Job, options: ExecuteOptions) JobError!Result {
    return runJobWithMutex(allocator, job, options, &pasteboard_mutex);
}

fn runJobWithMutex(
    allocator: Allocator,
    job: Job,
    options: ExecuteOptions,
    mutex: *sync.Mutex,
) JobError!Result {
    if (job == .write_text and job.write_text.text.len > std.math.maxInt(u32)) return error.InvalidArgument;
    if (acquireJobLock(mutex, job, options)) |status| return statusResult(status);
    defer mutex.unlock();

    return switch (job) {
        .read => |read_job| read(allocator, read_job, options),
        .write_text => |write_job| writeText(write_job),
        .clear => clear(),
    };
}

fn read(allocator: Allocator, job: ReadJob, options: ExecuteOptions) JobError!Result {
    var iterator = PreferenceIterator.init(job.request) catch return error.InvalidArgument;
    var supported = false;
    var first_failure: ?JobError = null;
    while (iterator.next() catch return error.InvalidArgument) |name| {
        if (stopStatus(options)) |status| return statusResult(status);
        const mime: MimeType = if (std.ascii.eqlIgnoreCase(name, "text/plain"))
            .text_plain
        else if (std.ascii.eqlIgnoreCase(name, "image/png"))
            .image_png
        else
            continue;
        supported = true;
        const result = readMime(
            allocator,
            mime,
            job.max_bytes,
            job.max_image_pixels,
            job.max_conversion_bytes,
            options,
        ) catch |err| switch (err) {
            error.NativeFailure => {
                if (first_failure == null) first_failure = err;
                continue;
            },
            else => return err,
        };
        if (result != .empty) return result;
    }
    if (first_failure) |failure| return failure;
    return if (supported) .empty else .unsupported;
}

fn stopStatus(options: ExecuteOptions) ?Status {
    if (options.cancel_requested) |cancelled| {
        if (cancelled.load(.acquire)) return .cancelled;
    }
    if (options.deadline_ns == std.math.maxInt(i128)) return null;
    if (clipboard_clock.nowNs() >= options.deadline_ns) return .timed_out;
    return null;
}

fn acquirePasteboardLock(mutex: *sync.Mutex, options: ExecuteOptions) ?Status {
    while (true) {
        if (stopStatus(options)) |status| return status;
        if (mutex.tryLock()) {
            if (stopStatus(options)) |status| {
                mutex.unlock();
                return status;
            }
            return null;
        }

        const sleep_ns = if (options.deadline_ns == std.math.maxInt(i128))
            LOCK_RETRY_SLEEP_NS
        else blk: {
            const now_ns = clipboard_clock.nowNs();
            if (now_ns >= options.deadline_ns) return .timed_out;
            const remaining_ns: u64 = @intCast(@min(options.deadline_ns - now_ns, std.math.maxInt(u64)));
            break :blk @min(LOCK_RETRY_SLEEP_NS, remaining_ns);
        };
        std.debug.assert(sleep_ns > 0);
        clipboard_clock.sleep(sleep_ns);
    }
}

fn acquireJobLock(mutex: *sync.Mutex, job: Job, options: ExecuteOptions) ?Status {
    if (acquirePasteboardLock(mutex, options)) |status| return status;
    if (job != .write_text and job != .clear) return null;
    if (beginMutation(options)) |status| {
        mutex.unlock();
        return status;
    }
    return null;
}

fn readMime(
    allocator: Allocator,
    mime: MimeType,
    max_bytes: u32,
    max_image_pixels: u32,
    max_conversion_bytes: u32,
    options: ExecuteOptions,
) JobError!Result {
    var shim_bytes: ?[*]u8 = null;
    var length: u32 = 0;
    const status = shimStatus(ot_clipboard_macos_read(
        @intFromEnum(mime),
        max_bytes,
        max_image_pixels,
        max_conversion_bytes,
        shimStop,
        &options,
        &shim_bytes,
        &length,
    ));

    switch (status) {
        .empty => return .empty,
        .limit_exceeded => return error.LimitExceeded,
        .invalid_argument => return error.InvalidArgument,
        .invalid_text => return error.NativeFailure,
        .failed => return error.NativeFailure,
        .cancelled => return .cancelled,
        .timed_out => return .timed_out,
        .ok => {},
    }

    defer ot_clipboard_macos_free_bytes(shim_bytes);
    if (postShimStop(options)) |result| return result;
    if (length > max_bytes) return error.NativeFailure;
    const source: []const u8 = if (length == 0)
        ""
    else
        (shim_bytes orelse return error.NativeFailure)[0..length];
    const data = allocator.dupe(u8, source) catch return error.OutOfMemory;
    return .{ .read = .{ .mime = mime, .data = data } };
}

fn shimStop(context: ?*const anyopaque) callconv(.c) i32 {
    const options: *const ExecuteOptions = @ptrCast(@alignCast(context orelse return @intFromEnum(ShimStatus.failed)));
    const status = stopStatus(options.*) orelse return @intFromEnum(ShimStatus.ok);
    return @intFromEnum(switch (status) {
        .cancelled => ShimStatus.cancelled,
        .timed_out => ShimStatus.timed_out,
        .failed => ShimStatus.failed,
    });
}

const PreferenceIterator = struct {
    request: []const u8,
    count: u32,
    index: u32 = 0,
    offset: usize = 4,

    fn init(request: []const u8) error{InvalidRequest}!PreferenceIterator {
        if (request.len < 4) return error.InvalidRequest;
        const count = std.mem.readInt(u32, request[0..4], .little);
        if (count == 0) return error.InvalidRequest;
        return .{ .request = request, .count = count };
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

fn writeText(job: WriteTextJob) JobError!Result {
    const bytes: ?[*]const u8 = if (job.text.len == 0) null else job.text.ptr;
    return switch (shimStatus(ot_clipboard_macos_write_text(bytes, @intCast(job.text.len)))) {
        .ok => .written,
        .invalid_argument => error.InvalidArgument,
        .invalid_text => error.InvalidText,
        .empty, .limit_exceeded, .failed, .cancelled, .timed_out => error.NativeFailure,
    };
}

fn clear() JobError!Result {
    return switch (shimStatus(ot_clipboard_macos_clear())) {
        .ok => .cleared,
        .invalid_argument => error.InvalidArgument,
        .empty, .limit_exceeded, .invalid_text, .failed, .cancelled, .timed_out => error.NativeFailure,
    };
}

fn beginMutation(options: ExecuteOptions) ?Status {
    if (stopStatus(options)) |status| return status;
    const begin = options.begin_mutation orelse return .failed;
    return begin(options.mutation_context);
}

fn postShimStop(options: ExecuteOptions) ?Result {
    const status = stopStatus(options) orelse return null;
    return statusResult(status);
}

fn statusResult(status: Status) Result {
    return switch (status) {
        .cancelled => .cancelled,
        .timed_out => .timed_out,
        .failed => .failed,
    };
}

fn shimStatus(value: i32) ShimStatus {
    return std.enums.fromInt(ShimStatus, value) orelse .failed;
}

test "macOS clipboard shim initializes absent output" {
    if (comptime @import("builtin").os.tag != .macos) return error.SkipZigTest;

    var bytes: ?[*]u8 = undefined;
    var length: u32 = 99;
    const status = shimStatus(ot_clipboard_macos_read(0, 0, 0, 0, null, null, &bytes, &length));
    try std.testing.expectEqual(ShimStatus.empty, status);
    try std.testing.expect(bytes == null);
    try std.testing.expectEqual(@as(u32, 0), length);
}

test "macOS clipboard image output stops at the configured byte limit" {
    if (comptime @import("builtin").os.tag != .macos) return error.SkipZigTest;

    var length: u32 = 0;
    try std.testing.expectEqual(
        ShimStatus.ok,
        shimStatus(ot_clipboard_macos_test_bounded_output(8, 4, 4, &length)),
    );
    try std.testing.expectEqual(@as(u32, 8), length);

    try std.testing.expectEqual(
        ShimStatus.limit_exceeded,
        shimStatus(ot_clipboard_macos_test_bounded_output(7, 4, 4, &length)),
    );
    try std.testing.expectEqual(@as(u32, 4), length);
}

test "macOS clipboard MIME request parsing preserves order" {
    const request = [_]u8{ 2, 0, 0, 0, 9, 0, 0, 0 } ++ "image/png".* ++
        [_]u8{ 10, 0, 0, 0 } ++ "text/plain".*;
    var iterator = try PreferenceIterator.init(&request);
    try std.testing.expectEqualStrings("image/png", (try iterator.next()).?);
    try std.testing.expectEqualStrings("text/plain", (try iterator.next()).?);
    try std.testing.expect((try iterator.next()) == null);
}

test "macOS clipboard read results have explicit allocator ownership" {
    var result: Result = .{ .read = .{
        .mime = .image_png,
        .data = try std.testing.allocator.dupe(u8, &.{ 0x89, 0x50, 0x4e, 0x47 }),
    } };
    result.deinit(std.testing.allocator);
}

const TestMutationContext = struct {
    called: bool = false,
};

fn testBeginMutation(context: ?*anyopaque) ?Status {
    const mutation: *TestMutationContext = @ptrCast(@alignCast(context.?));
    mutation.called = true;
    return null;
}

test "macOS clipboard lock contention observes cancellation and deadline" {
    try clipboard_clock.init();
    var mutex: sync.Mutex = .{};
    mutex.lock();
    defer mutex.unlock();

    var cancelled = std.atomic.Value(bool).init(true);
    try std.testing.expectEqual(
        Status.cancelled,
        acquirePasteboardLock(&mutex, .{
            .cancel_requested = &cancelled,
            .deadline_ns = std.math.maxInt(i128),
        }).?,
    );
    cancelled.store(false, .release);
    try std.testing.expectEqual(
        Status.timed_out,
        acquirePasteboardLock(&mutex, .{
            .cancel_requested = &cancelled,
            .deadline_ns = clipboard_clock.nowNs(),
        }).?,
    );
}

test "macOS clipboard mutation callback is not called before the lock" {
    try clipboard_clock.init();
    var mutex: sync.Mutex = .{};
    mutex.lock();
    defer mutex.unlock();
    var cancelled = std.atomic.Value(bool).init(true);
    var mutation = TestMutationContext{};

    const status = acquireJobLock(
        &mutex,
        .{ .write_text = .{ .text = "text" } },
        .{
            .cancel_requested = &cancelled,
            .begin_mutation = testBeginMutation,
            .mutation_context = &mutation,
            .deadline_ns = std.math.maxInt(i128),
        },
    );
    try std.testing.expectEqual(Status.cancelled, status.?);
    try std.testing.expect(!mutation.called);
}

test "macOS clipboard shim callback maps exact terminal status" {
    try clipboard_clock.init();
    var cancelled = std.atomic.Value(bool).init(true);
    var options = ExecuteOptions{
        .cancel_requested = &cancelled,
        .deadline_ns = std.math.maxInt(i128),
    };
    try std.testing.expectEqual(ShimStatus.cancelled, shimStatus(shimStop(&options)));

    cancelled.store(false, .release);
    options.deadline_ns = clipboard_clock.nowNs();
    try std.testing.expectEqual(ShimStatus.timed_out, shimStatus(shimStop(&options)));
}
