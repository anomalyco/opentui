//! The stdout writer behind a Session: hand-over, ticket ownership, failure, cancel, and the
//! exit wait, on real threads and pipes. The writer's own races are in stdout-writer.zig.
const std = @import("std");
const testing = std.testing;
const context = @import("../context.zig");
const session = @import("../session.zig");
const stdout_writer = @import("../stdout-writer.zig");

const PipeWriter = stdout_writer.Writer(stdout_writer.FdSink, stdout_writer.ThreadRunner(null));
const options: session.Options = .{ .chunk_size = 4096, .chunk_count = 16, .span_capacity = 16 };

const pipe = struct {
    fn open() ![2]std.posix.fd_t {
        return stdout_writer.testPipe(4096);
    }
}.open;
const readExactly = stdout_writer.readExactly;
const waitThreadsGone = stdout_writer.waitThreadsGone;
const Deadline = stdout_writer.Deadline;

const PipeCreate = struct {
    fd: std.posix.fd_t,
    unsupported: bool = false,

    pub fn create(self: PipeCreate) error{UnsupportedResource}!*PipeWriter {
        if (self.unsupported) return error.UnsupportedResource;
        return PipeWriter.create(testing.allocator, .{ .fd = self.fd }, .{});
    }
};

/// Collects until the copy in flight is written.
fn collect(value: *session.Session, create: PipeCreate) !u32 {
    const deadline: Deadline = .init();
    while (true) {
        const result = try value.postStdout(PipeWriter, create, 0, false);
        if (!result.in_flight) return result.written;
        try deadline.check();
    }
}

test "Session stdout writer completes output only after write(2) returns, in order, one copy at a time" {
    if (!stdout_writer.supported) return error.SkipZigTest;
    const owner = try context.Context.init(testing.allocator, std.Io.failing, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createSession(options);
    const value = try owner.raw().getSession(id);
    const fds = try pipe();
    defer for (fds) |fd| {
        _ = std.c.close(fd);
    };
    const create: PipeCreate = .{ .fd = fds[1] };
    var expected: [3 * 4096]u8 = undefined;
    for (&expected, 0..) |*byte, index| byte.* = @truncate('a' + index % 26);
    for (0..3) |part| try owner.writeSession(id, expected[part * 4096 ..][0..4096]);

    // Nothing queued, nothing to collect: wait=1 is idle without a writer.
    try testing.expectEqual(session.PostResult{}, try value.postStdout(PipeWriter, create, 0, true));
    const first = try value.postStdout(PipeWriter, create, 65_536, false);
    try testing.expect(first.in_flight and first.written == 0);
    const held = value.stdout_post.?.ptr;
    // The copy is the writer's: no host read, drain or completion touches it (R29).
    var copy: [16]u8 = undefined;
    try testing.expectError(error.Busy, owner.readOutput(id, &copy));
    try testing.expectError(error.Busy, owner.drainOutput(id, struct {
        pub fn write(_: @This(), bytes: []const u8) !usize {
            return bytes.len;
        }
    }{}, 16));
    try testing.expectError(error.StaleRequest, owner.completeOutput(id, value.pending.?, .written));
    // The pipe holds the first copy; the next waits for the reader. Nothing completes before
    // write(2) returns (R5).
    var read: [3 * 4096]u8 = undefined;
    try readExactly(fds[0], read[0..4096]);
    try testing.expectEqual(@as(u32, 4096), try collect(value, create));
    try testing.expectEqual(@as(u64, 4096), value.completed_bytes);
    for (1..3) |part| {
        // Collect-and-start: one call completes nothing yet and starts the next copy.
        const started = try value.postStdout(PipeWriter, create, 65_536, false);
        try testing.expect(started.in_flight);
        try testing.expectEqual(@as(u64, part * 4096), value.completed_bytes);
        try readExactly(fds[0], read[part * 4096 ..][0..4096]);
        try testing.expectEqual(@as(u32, 4096), try collect(value, create));
    }
    try testing.expectEqualSlices(u8, &expected, &read);
    try testing.expect(value.isDrained());
    try testing.expectEqual(session.PostResult{}, try value.postStdout(PipeWriter, create, 65_536, false));
    // R3: one writer, and one buffer, for every hand-over.
    try testing.expectEqual(held, value.stdout_post.?.ptr);
    // Destroying a drained Session stops and joins its idle writer before it returns.
    try owner.destroy(id);
    if (stdout_writer.live_threads.load(.acquire) != 0) {
        @as(*PipeWriter, @ptrCast(@alignCast(held))).abandon();
        return error.TestUnexpectedResult;
    }
}

test "Session stdout writer refuses a host ticket's output, and an unsupported writer consumes nothing" {
    if (!stdout_writer.supported) return error.SkipZigTest;
    const owner = try context.Context.init(testing.allocator, std.Io.failing, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createSession(options);
    defer owner.cancelSession(id) catch unreachable;
    const value = try owner.raw().getSession(id);
    try owner.writeSession(id, "abcdef");
    var copy: [2]u8 = undefined;
    const ticket = (try owner.readOutput(id, &copy)).?;
    try testing.expectError(error.Busy, value.postStdout(PipeWriter, PipeCreate{ .fd = -1 }, 65_536, false));
    try testing.expectError(error.Busy, value.postStdout(PipeWriter, PipeCreate{ .fd = -1 }, 0, true));
    try owner.completeOutput(id, ticket, .written);
    // R7: an unsupported writer fails before consuming output; the host drains instead.
    try testing.expectError(error.UnsupportedResource, value.postStdout(PipeWriter, PipeCreate{ .fd = -1, .unsupported = true }, 65_536, false));
    try testing.expectEqual(@as(u64, 2), value.completed_bytes);
    try testing.expect(value.stdout_post == null);
    var rest: [4]u8 = undefined;
    const tail = (try owner.readOutput(id, &rest)).?;
    try testing.expectEqualStrings("cdef", rest[0..tail.len]);
    try owner.completeOutput(id, tail, .written);
}

test "Session stdout writer fails the transport on a closed reader, without replay" {
    if (!stdout_writer.supported) return error.SkipZigTest;
    const owner = try context.Context.init(testing.allocator, std.Io.failing, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createSession(options);
    defer owner.cancelSession(id) catch unreachable;
    const value = try owner.raw().getSession(id);
    const fds = try pipe();
    _ = std.c.close(fds[0]);
    defer _ = std.c.close(fds[1]);
    try owner.writeSession(id, "hello");
    const create: PipeCreate = .{ .fd = fds[1] };
    try testing.expect((try value.postStdout(PipeWriter, create, 65_536, false)).in_flight);
    const deadline: Deadline = .init();
    while (true) {
        const result = value.postStdout(PipeWriter, create, 0, false) catch |err| {
            try testing.expectEqual(error.SessionFailed, err);
            break;
        };
        try testing.expect(result.in_flight);
        try deadline.check();
    }
    try testing.expectEqual(session.State.failed, value.state);
    try testing.expectEqual(@as(u64, 0), value.completed_bytes);
    try testing.expectError(error.SessionFailed, value.postStdout(PipeWriter, create, 65_536, false));
}

test "Session cancel with the writer stuck in write(2) returns at once; the thread frees itself later" {
    if (!stdout_writer.supported) return error.SkipZigTest;
    const owner = try context.Context.init(testing.allocator, std.Io.failing, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createSession(.{ .chunk_size = 8192, .chunk_count = 16, .span_capacity = 16 });
    const value = try owner.raw().getSession(id);
    const fds = try pipe();
    defer for (fds) |fd| {
        _ = std.c.close(fd);
    };
    var bytes: [8192]u8 = undefined;
    @memset(&bytes, 'z');
    try owner.writeSession(id, &bytes);
    // One copy twice the pipe's size: once bytes show, the thread is inside write(2) and blocked.
    // Waiting for `.writing` alone also covers the moment before the call, where a cancel stops
    // the copy unwritten.
    try testing.expect((try value.postStdout(PipeWriter, PipeCreate{ .fd = fds[1] }, 65_536, false)).in_flight);
    var ready: [1]std.c.pollfd = .{.{ .fd = fds[0], .events = std.c.POLL.IN, .revents = 0 }};
    try testing.expectEqual(1, std.c.poll(&ready, 1, 10_000));
    try owner.cancelSession(id);
    try testing.expect(value.stdout_post == null and value.pending == null);
    // The rest of the running write still lands (R9); the thread frees the writer.
    try readExactly(fds[0], &bytes);
    try waitThreadsGone();
}

const Unwritten = struct {
    pub fn write(_: Unwritten, _: []const u8) stdout_writer.SinkError!usize {
        unreachable;
    }

    pub fn waitWritable(_: Unwritten) void {}
};

const ParkedWriter = stdout_writer.Writer(Unwritten, stdout_writer.Parked);

test "Session exit wait takes back a copy the writer never picked up, for the synchronous drain" {
    const owner = try context.Context.init(testing.allocator, std.Io.failing, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createSession(options);
    defer owner.cancelSession(id) catch unreachable;
    const value = try owner.raw().getSession(id);
    try owner.writeSession(id, "restore");
    const create = struct {
        pub fn create(_: @This()) error{UnsupportedResource}!*ParkedWriter {
            return ParkedWriter.create(testing.allocator, .{}, .{});
        }
    }{};
    try testing.expect((try value.postStdout(ParkedWriter, create, 65_536, false)).in_flight);
    try testing.expectEqual(session.PostResult{}, try value.postStdout(ParkedWriter, create, 0, true));
    try testing.expect(value.stdout_post == null and value.pending == null and !value.pending_post);
    var copy: [16]u8 = undefined;
    const ticket = (try owner.readOutput(id, &copy)).?;
    try testing.expectEqualStrings("restore", copy[0..ticket.len]);
    try owner.completeOutput(id, ticket, .written);
}
