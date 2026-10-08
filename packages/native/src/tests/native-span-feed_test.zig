const std = @import("std");
const testing = std.testing;
const raw = @import("../native-span-feed.zig");
const utils = @import("../utils.zig");

fn testOptions(chunk_size: u32, initial_chunks: u32, auto_commit: bool) raw.Options {
    return testOptionsFull(chunk_size, initial_chunks, 0, auto_commit);
}

fn testOptionsFull(chunk_size: u32, initial_chunks: u32, max_bytes: u64, auto_commit: bool) raw.Options {
    return .{
        .chunk_size = chunk_size,
        .initial_chunks = initial_chunks,
        .max_bytes = max_bytes,
        .growth_policy = @backingInt(raw.GrowthPolicy.grow),
        .auto_commit_on_full = if (auto_commit) 1 else 0,
        .span_queue_capacity = 0,
    };
}

fn drainAllSpans(stream: *raw.Stream) u64 {
    var buf: [256]raw.SpanInfo = undefined;
    var total: u64 = 0;
    while (true) {
        const count = stream.drainSpans(&buf);
        if (count == 0) break;
        var i: u32 = 0;
        while (i < count) : (i += 1) {
            total += buf[i].len;
            stream.markSpanConsumed(buf[i]);
        }
    }
    return total;
}

test "Stream - create and destroy with testing allocator" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(1024, 2, true));
    defer stream.destroy();

    const stats = stream.getStats();
    try testing.expectEqual(@as(u32, 2), stats.chunks);
    try testing.expectEqual(@as(u64, 0), stats.bytes_written);
    try testing.expectEqual(@as(u64, 0), stats.spans_committed);
}

test "Stream - atomic write spans chunks without changing bytes" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(64, 1, true));
    defer stream.destroy();
    const input: [150]u8 = @splat('x');

    try stream.writeAtomic(&input);

    var spans: [4]raw.SpanInfo = undefined;
    const count = stream.drainSpans(&spans);
    try testing.expectEqual(@as(u32, 3), count);
    var output: [input.len]u8 = undefined;
    var offset: usize = 0;
    for (spans[0..count]) |span| {
        @memcpy(output[offset .. offset + span.len], span.slice());
        offset += span.len;
        stream.markSpanConsumed(span);
    }
    try testing.expectEqualSlices(u8, &input, &output);
}

test "Stream - failed atomic write publishes nothing" {
    var options = testOptionsFull(32, 1, 32, true);
    options.growth_policy = @backingInt(raw.GrowthPolicy.block);
    const stream = try raw.Stream.create(testing.allocator, options);
    defer stream.destroy();
    const input: [33]u8 = @splat('x');

    try testing.expectError(error.NoSpace, stream.writeAtomic(&input));

    var spans: [2]raw.SpanInfo = undefined;
    try testing.expectEqual(@as(u32, 0), stream.drainSpans(&spans));
    try testing.expectEqual(@as(u64, 0), stream.getStats().bytes_written);
}

test "Stream - reserved control keeps its slot when normal ring growth fails" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    var options = testOptions(16, 2, false);
    options.span_queue_capacity = 2;
    const stream = try raw.Stream.create(failing.allocator(), options);
    defer stream.destroy();
    try stream.reserveControlCapacity(1);
    try stream.setControlSequenceReservation(.{ .bytes = 7, .spans = 1 });
    try stream.write("a");
    try stream.commit();
    failing.fail_index = failing.alloc_index;
    failing.resize_fail_index = failing.resize_index;
    try stream.write("b");
    try testing.expectError(error.OutOfMemory, stream.commit());
    try testing.expectError(error.Busy, stream.writeReservedControlAtomic("restore"));
    try testing.expectEqual(@as(u64, 1), drainAllSpans(stream));
    try stream.commit();
    try stream.writeReservedControlAtomic("restore");
    var spans: [2]raw.SpanInfo = undefined;
    const count = stream.drainSpans(&spans);
    defer for (spans[0..count]) |span| stream.markSpanConsumed(span);
    try testing.expectEqual(@as(u32, 2), count);
    try testing.expectEqualStrings("b", spans[0].slice());
    try testing.expectEqualStrings("restore", spans[1].slice());
}

test "Stream - control sequence spans multiple packets at counter exhaustion" {
    const stream = try raw.Stream.create(testing.allocator, blockOptions(8, 4, false));
    defer stream.destroy();
    try stream.reserveControlCapacity(16);
    try stream.write("earlier");
    try stream.commit();
    stream.stats.bytes_written = std.math.maxInt(u64) - 17;
    stream.span_ring.next_id = std.math.maxInt(u64) - 4;
    try stream.setControlSequenceReservation(.{ .bytes = 16, .spans = 3 });
    try stream.writeAtomic("n");

    const before = stream.getStats();
    try testing.expectError(error.NoSpace, stream.writeAtomic("c"));
    try testing.expectEqualDeep(before, stream.getStats());
    try stream.writeReservedControlAtomic("123456789");
    try testing.expectEqualDeep(raw.ControlSequenceReservation{ .bytes = 7, .spans = 1 }, stream.control_sequence);

    var spans: [4]raw.SpanInfo = undefined;
    const count = stream.drainSpans(&spans);
    defer for (spans[0..count]) |span| stream.markSpanConsumed(span);
    try testing.expectEqual(@as(u32, 4), count);
    for ([_][]const u8{ "earlier", "n", "12345678", "9" }, spans) |expected, span| {
        try testing.expectEqualStrings(expected, span.slice());
    }
    try stream.releaseSpan(spans[2].slot_index, spans[2].release_id);
    const retained = stream.getStats();
    try testing.expectError(error.Busy, stream.writeReservedControlAtomic("restore"));
    try testing.expectError(error.Busy, stream.setControlSequenceReservation(.{}));
    try testing.expectEqualDeep(retained, stream.getStats());
    try testing.expectEqualDeep(raw.ControlSequenceReservation{ .bytes = 7, .spans = 1 }, stream.control_sequence);
    try testing.expectEqualStrings("9", spans[3].slice());
    try stream.releaseSpan(spans[3].slot_index, spans[3].release_id);

    try stream.writeReservedControlAtomic("restore");
    try testing.expectEqual(std.math.maxInt(u64), stream.stats.bytes_written);
    try testing.expectEqual(std.math.maxInt(u64), stream.span_ring.next_id);
    try testing.expectEqualDeep(raw.ControlSequenceReservation{}, stream.control_sequence);
    try testing.expectEqual(@as(u64, 7), drainAllSpans(stream));
    try testing.expectEqualStrings("earlier", spans[0].slice());
    try testing.expectEqualStrings("n", spans[1].slice());
    try testing.expectError(error.NoSpace, stream.writeReservedControlAtomic("x"));
    try stream.writeReservedControlAtomic("");
}

test "Stream - control sequence setup and publication reject unfinished producers" {
    const stream = try raw.Stream.create(testing.allocator, blockOptions(8, 3, false));
    defer stream.destroy();
    try stream.reserveControlCapacity(8);
    const reservation: raw.ControlSequenceReservation = .{ .bytes = 7, .spans = 1 };
    try stream.setControlSequenceReservation(reservation);
    for (0..4) |state| {
        switch (state) {
            0 => stream.producing = true,
            1 => try stream.setStagedBytes(1),
            2 => _ = try stream.reserve(1),
            3 => try stream.write("q"),
            else => unreachable,
        }
        const before = stream.getStats();
        try testing.expectError(error.Busy, stream.setControlSequenceReservation(.{}));
        try testing.expectError(error.Busy, stream.writeReservedControlAtomic("restore"));
        try testing.expectEqualDeep(before, stream.getStats());
        try testing.expectEqualDeep(reservation, stream.control_sequence);
        switch (state) {
            0 => stream.producing = false,
            1 => try stream.setStagedBytes(0),
            2 => try stream.commitReserved(0),
            3 => try stream.commit(),
            else => unreachable,
        }
    }
    try stream.writeReservedControlAtomic("restore");
    try testing.expectEqual(@as(u64, 8), drainAllSpans(stream));
    try stream.close();
    try testing.expectError(error.Invalid, stream.setControlSequenceReservation(reservation));
    try testing.expectError(error.Invalid, stream.writeReservedControlAtomic("x"));
}

test "Stream - control sequence survives ordinary allocation failures without allocating" {
    for ([_]u32{ 2, 4 }) |capacity| {
        var failing = testing.FailingAllocator.init(testing.allocator, .{});
        var options = testOptions(8, 2, true);
        options.span_queue_capacity = capacity;
        const stream = try raw.Stream.create(failing.allocator(), options);
        defer stream.destroy();
        try stream.reserveControlCapacity(8);
        try stream.writeAtomic("earlier");
        const reservation: raw.ControlSequenceReservation = .{ .bytes = 9, .spans = 2 };
        failing.fail_index = failing.alloc_index;
        failing.resize_fail_index = failing.resize_index;
        try stream.setControlSequenceReservation(reservation);
        const before = stream.getStats();
        const next_id = stream.span_ring.next_id;
        try testing.expectError(error.OutOfMemory, stream.writeAtomic("normal"));
        try testing.expectEqualDeep(before, stream.getStats());
        try testing.expectEqual(next_id, stream.span_ring.next_id);
        try testing.expectEqualDeep(reservation, stream.control_sequence);
        try testing.expect(failing.has_induced_failure);
        failing.has_induced_failure = false;

        try stream.writeReservedControlAtomic("restore");
        var spans: [2]raw.SpanInfo = undefined;
        const count = stream.drainSpans(&spans);
        defer for (spans[0..count]) |span| stream.markSpanConsumed(span);
        try testing.expectEqual(@as(u32, 2), count);
        try testing.expectEqualStrings("earlier", spans[0].slice());
        try testing.expectEqualStrings("restore", spans[1].slice());
        try stream.releaseSpan(spans[1].slot_index, spans[1].release_id);
        try stream.writeReservedControlAtomic("ok");
        try testing.expectEqual(@as(u64, 2), drainAllSpans(stream));
        try testing.expectEqualDeep(raw.ControlSequenceReservation{}, stream.control_sequence);
        try testing.expectEqualStrings("earlier", spans[0].slice());
        try testing.expect(!failing.has_induced_failure);
    }
}

test "Stream - chunk notification cannot change unfinished atomic admission" {
    const Callback = struct {
        var armed = false;
        var write_status: i32 = 0;
        var commit_status: i32 = 0;
        fn notify(ptr: usize, event: u32, _: usize, _: u64) callconv(.c) void {
            if (!armed or event != @backingInt(raw.EventId.ChunkAdded)) return;
            armed = false;
            const stream: *raw.Stream = @ptrFromInt(ptr);
            write_status = raw.streamWrite(stream, "c", 1);
            commit_status = raw.streamCommit(stream);
        }
    };
    for ([_]u64{ 16, 0 }) |max_bytes| {
        var options = testOptionsFull(8, 1, max_bytes, false);
        options.span_queue_capacity = 2;
        const stream = try raw.Stream.create(testing.allocator, options);
        defer stream.destroy();
        stream.setCallback(&Callback.notify);
        try stream.attach();
        try stream.write("a");
        try stream.commit();
        Callback.armed = true;
        if (max_bytes != 0) {
            try testing.expectError(error.NoSpace, stream.writeAtomic("123456789"));
            try testing.expect(Callback.armed);
            try testing.expectEqual(@as(u64, 1), stream.getStats().bytes_written);
        }
        try stream.writeAtomic("b");
        try testing.expectEqual(raw.Status.err_busy, Callback.write_status);
        try testing.expectEqual(raw.Status.err_busy, Callback.commit_status);
        var spans: [3]raw.SpanInfo = undefined;
        const count = stream.drainSpans(&spans);
        defer for (spans[0..count]) |span| stream.markSpanConsumed(span);
        try testing.expectEqual(@as(u32, 2), count);
        try testing.expectEqualStrings("a", spans[0].slice());
        try testing.expectEqualStrings("b", spans[1].slice());
        try testing.expect(!stream.hasPendingBytes());
    }
}

test "Stream - bounded admission retains drained spans until completion" {
    var options = testOptionsFull(32, 1, 64, false);
    options.span_queue_capacity = 2;
    const stream = try raw.Stream.create(testing.allocator, options);
    defer stream.destroy();

    var spans: [2]raw.SpanInfo = undefined;
    var retained: usize = 0;
    defer for (spans[0..retained]) |span| stream.markSpanConsumed(span);
    for (0..2) |index| {
        try stream.write("x");
        try stream.commit();
        try testing.expectEqual(@as(u32, 1), stream.drainSpans(spans[index..][0..1]));
        retained += 1;
    }
    try testing.expectEqual(@as(u32, 0), stream.getStats().pending_spans);
    try testing.expectError(error.NoSpace, stream.write("y"));
    try testing.expectError(error.NoSpace, stream.reserve(1));
    try testing.expectError(error.NoSpace, stream.writeAtomic("y"));
    try testing.expectEqual(@as(u32, 1), stream.getStats().chunks);

    stream.markSpanConsumed(spans[1]);
    try stream.write("y");
    try stream.commit();
    try testing.expectEqual(@as(u32, 1), stream.drainSpans(spans[1..]));
    try testing.expectEqualStrings("x", spans[0].slice());
    try testing.expectEqualStrings("y", spans[1].slice());
}

test "Stream - duplicate completion cannot release a reused chunk" {
    const stream = try raw.Stream.create(testing.allocator, testOptionsFull(8, 1, 8, true));
    defer stream.destroy();
    var spans: [1]raw.SpanInfo = undefined;

    try stream.writeAtomic("original");
    try testing.expectEqual(@as(u32, 1), stream.drainSpans(&spans));
    const old_span = spans[0];
    stream.markSpanConsumed(old_span);

    try stream.writeAtomic("retained");
    try testing.expectEqual(@as(u32, 1), stream.drainSpans(&spans));
    defer stream.markSpanConsumed(spans[0]);
    try testing.expectError(error.Invalid, stream.releaseSpan(old_span.slot_index, old_span.release_id));
    try testing.expectError(error.Invalid, stream.releaseSpan(std.math.maxInt(u32), spans[0].release_id));
    stream.markSpanConsumed(old_span);
    try testing.expectError(error.MaxBytes, stream.writeAtomic("replaced"));
    try testing.expectEqualStrings("retained", spans[0].slice());
}

test "Stream - checked destruction waits for drained output after close" {
    const stream = try raw.Stream.create(testing.allocator, testOptionsFull(8, 1, 8, true));
    try stream.writeAtomic("retained");
    var spans: [1]raw.SpanInfo = undefined;
    try testing.expectEqual(@as(u32, 1), stream.drainSpans(&spans));
    try testing.expectEqual(raw.Status.err_busy, raw.destroyNativeSpanFeed(stream));
    try testing.expect(!stream.closed);
    try stream.close();
    try testing.expectEqual(raw.Status.err_busy, raw.destroyNativeSpanFeed(stream));
    try testing.expectEqualStrings("retained", spans[0].slice());
    try testing.expectEqual(raw.Status.ok, raw.streamReleaseSpan(stream, spans[0].slot_index, spans[0].release_id));
    try testing.expectEqual(raw.Status.err_invalid, raw.streamReleaseSpan(stream, spans[0].slot_index, spans[0].release_id));
    try testing.expectEqual(raw.Status.ok, raw.destroyNativeSpanFeed(stream));
}

test "Stream - destruction from a native notification reports Busy" {
    const Callback = struct {
        var status: i32 = raw.Status.ok;
        fn notify(ptr: usize, event: u32, _: usize, _: u64) callconv(.c) void {
            if (event == @backingInt(raw.EventId.Closed)) {
                status = raw.destroyNativeSpanFeed(@ptrFromInt(ptr));
            }
        }
    };
    const stream = try raw.Stream.create(testing.allocator, testOptions(8, 1, true));
    defer stream.destroy();
    Callback.status = raw.Status.ok;
    stream.setCallback(&Callback.notify);
    try stream.close();
    try testing.expectEqual(raw.Status.err_busy, Callback.status);
}

test "Stream - finite initial byte limit is checked before allocation" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{ .fail_index = 0 });
    try testing.expectError(error.MaxBytes, raw.Stream.create(
        failing.allocator(),
        testOptionsFull(8, std.math.maxInt(u32), 8, true),
    ));
    try testing.expectEqual(@as(usize, 0), failing.alloc_index);
}

test "Stream - retained bytes limit chunks until release" {
    const stream = try raw.Stream.create(testing.allocator, testOptionsFull(8, 1, 16, true));
    defer stream.destroy();
    var spans: [2]raw.SpanInfo = undefined;
    var retained: usize = 0;
    defer for (spans[0..retained]) |span| stream.markSpanConsumed(span);
    for (0..2) |index| {
        try stream.writeAtomic("retained");
        try testing.expectEqual(@as(u32, 1), stream.drainSpans(spans[index..][0..1]));
        retained += 1;
    }
    for (0..20) |_| {
        try testing.expectError(error.MaxBytes, stream.writeAtomic("blocked!"));
        try testing.expectEqual(@as(u32, 2), stream.getStats().chunks);
    }
    try testing.expectEqual(@as(u32, 2), stream.getStats().outstanding_spans);
    try testing.expectEqual(@as(u64, 16), stream.getStats().outstanding_bytes);
    stream.markSpanConsumed(spans[1]);
    try stream.writeAtomic("retried!");
    try testing.expectEqual(@as(u32, 1), stream.drainSpans(spans[1..]));
    try testing.expectEqualStrings("retained", spans[0].slice());
    try testing.expectEqualStrings("retried!", spans[1].slice());
}

test "FeedBackend - retained bytes and spans skip a frame that fits after release" {
    const FeedBackend = @import("../renderer-output.zig").FeedBackend;
    for ([_]struct { max_bytes: u64, spans: u32, frame: []const u8 }{
        .{ .max_bytes = 32, .spans = 3, .frame = "1234567812345678" },
        .{ .max_bytes = 16, .spans = 8, .frame = "12345678" },
    }) |case| {
        var options = testOptionsFull(8, 1, case.max_bytes, true);
        options.span_queue_capacity = case.spans;
        const stream = try raw.Stream.create(testing.allocator, options);
        defer stream.destroy();
        var backend = FeedBackend.create(stream);
        defer backend.deinit();
        var spans: [1]raw.SpanInfo = undefined;

        try stream.writeAtomic("retained");
        try testing.expectEqual(@as(u32, 1), stream.drainSpans(&spans));
        defer stream.markSpanConsumed(spans[0]);
        backend.beginFrame();
        const writer = backend.writer();
        try writer.writeAll(case.frame);
        try testing.expectEqual(case.frame.len, stream.staged_bytes);
        try testing.expectError(error.Busy, stream.close());
        try testing.expectError(error.BufferFull, writer.writeAll("x"));
        try testing.expectEqual(.skipped, backend.prepareFrame());
        try testing.expectEqual(.skipped, backend.endFrame());
        try testing.expectEqual(@as(usize, 0), stream.staged_bytes);
        try testing.expect(!stream.hasPendingSpans());
        try testing.expect(backend.frameBytes.capacity <= case.max_bytes);
        try testing.expectEqualStrings("retained", spans[0].slice());
    }
}

test "FeedBackend - formatted frame bounds and retry preserve atomic output" {
    const FeedBackend = @import("../renderer-output.zig").FeedBackend;
    const stream = try raw.Stream.create(testing.allocator, testOptionsFull(32, 1, 64, true));
    defer stream.destroy();
    var backend = FeedBackend.create(stream);
    defer backend.deinit();

    for ([_]usize{ 63, 64, 65, 1024 }) |size| {
        backend.beginFrame();
        const text = utils.repeat(u8, "x", 1024);
        if (size <= 64) {
            try backend.writer().print("{s}", .{text[0..size]});
            try testing.expectEqual(size, stream.staged_bytes);
            try testing.expect(!stream.hasPendingSpans());
            try testing.expectEqual(.ok, backend.endFrame());
            try testing.expectEqual(size, drainAllSpans(stream));
        } else {
            try testing.expectError(error.BufferFull, backend.writer().print("{s}", .{text[0..size]}));
            try testing.expectEqual(.failed, backend.endFrame());
            try testing.expect(!stream.hasPendingSpans());
        }
        try testing.expectEqual(@as(usize, 0), stream.staged_bytes);
        try testing.expect(backend.frameBytes.capacity <= 64);
    }

    backend.beginFrame();
    try backend.writer().print("\x1b[{d};{d}H", .{ 12, 34 });
    try testing.expectEqual(.ok, backend.endFrame());
    var spans: [2]raw.SpanInfo = undefined;
    const count = stream.drainSpans(&spans);
    defer for (spans[0..count]) |span| stream.markSpanConsumed(span);
    try testing.expectEqual(@as(u32, 1), count);
    try testing.expectEqualStrings("\x1b[12;34H", spans[0].slice());
}

test "FeedBackend - failed staging allocation releases admission for retry" {
    const FeedBackend = @import("../renderer-output.zig").FeedBackend;
    for ([_]bool{ false, true }) |reserve_sequence| {
        var failing = testing.FailingAllocator.init(testing.allocator, .{});
        const options = if (reserve_sequence) testOptionsFull(8, 2, 16, true) else testOptionsFull(8, 1, 8, true);
        const stream = try raw.Stream.create(failing.allocator(), options);
        defer stream.destroy();
        var backend = FeedBackend.create(stream);
        defer backend.deinit();
        if (reserve_sequence) {
            try stream.reserveControlCapacity(8);
            stream.stats.bytes_written = std.math.maxInt(u64) - 12;
            stream.span_ring.next_id = std.math.maxInt(u64) - 2;
            try stream.setControlSequenceReservation(.{ .bytes = 7, .spans = 1 });
        }
        const reservation = stream.control_sequence;
        const before = stream.getStats();
        failing.fail_index = failing.alloc_index;
        backend.beginFrame();
        try testing.expectError(error.BufferFull, backend.writer().writeAll("frame"));
        try testing.expectEqual(.failed, backend.endFrame());
        try testing.expectEqual(@as(usize, 0), stream.staged_bytes);
        try testing.expectEqualDeep(reservation, stream.control_sequence);
        try testing.expectEqualDeep(before, stream.getStats());
        failing.fail_index = std.math.maxInt(usize);
        backend.beginFrame();
        try backend.writer().writeAll("retry");
        try testing.expectEqual(.ok, backend.endFrame());
        try testing.expectEqual(@as(u64, 5), drainAllSpans(stream));
        if (reserve_sequence) {
            try stream.writeReservedControlAtomic("restore");
            try testing.expectEqual(@as(u64, 7), drainAllSpans(stream));
            try testing.expectEqual(std.math.maxInt(u64), stream.stats.bytes_written);
            try testing.expectEqual(std.math.maxInt(u64), stream.span_ring.next_id);
        }
    }
}

test "FeedBackend - raw controls cannot overtake a staged frame" {
    const FeedBackend = @import("../renderer-output.zig").FeedBackend;
    const stream = try raw.Stream.create(testing.allocator, testOptionsFull(32, 2, 64, true));
    defer stream.destroy();
    var backend = FeedBackend.create(stream);
    defer backend.deinit();

    backend.beginFrame();
    try backend.writer().writeAll("frame");
    backend.writeOut("raw");
    backend.writeOutMultiple(&.{ "raw", "control" });
    try testing.expect(!stream.hasPendingSpans());
    try testing.expectEqual(.ok, backend.endFrame());
    var spans: [4]raw.SpanInfo = undefined;
    const count = stream.drainSpans(&spans);
    defer for (spans[0..count]) |span| stream.markSpanConsumed(span);
    try testing.expectEqual(@as(u32, 1), count);
    try testing.expectEqualStrings("frame", spans[0].slice());
}

test "FeedBackend - unbounded controls cancel an unfinished frame rather than disappearing" {
    const FeedBackend = @import("../renderer-output.zig").FeedBackend;
    const stream = try raw.Stream.create(testing.allocator, testOptions(32, 1, true));
    defer stream.destroy();
    var backend = FeedBackend.create(stream);
    defer backend.deinit();
    backend.beginFrame();
    try backend.writer().writeAll("unpublished");
    backend.writeOut("first");
    backend.writeOutMultiple(&.{ "sec", "ond" });
    try testing.expectEqual(.failed, backend.endFrame());
    var spans: [3]raw.SpanInfo = undefined;
    const count = stream.drainSpans(&spans);
    defer for (spans[0..count]) |span| stream.markSpanConsumed(span);
    try testing.expectEqual(@as(u32, 2), count);
    try testing.expectEqualStrings("first", spans[0].slice());
    try testing.expectEqualStrings("second", spans[1].slice());
}

test "FeedBackend - published frame notification can enqueue ordered controls" {
    const FeedBackend = @import("../renderer-output.zig").FeedBackend;
    const Callback = struct {
        var backend: ?*FeedBackend = null;
        fn notify(_: usize, event: u32, _: usize, _: u64) callconv(.c) void {
            if (event != @backingInt(raw.EventId.DataAvailable)) return;
            const target = backend orelse return;
            backend = null;
            target.writeOut("shutdown");
            target.writeOutMultiple(&.{ "raw", "control" });
        }
    };
    for ([_]u64{ 128, 0 }) |max_bytes| {
        const stream = try raw.Stream.create(testing.allocator, testOptionsFull(32, 1, max_bytes, true));
        defer stream.destroy();
        var backend = FeedBackend.create(stream);
        defer backend.deinit();
        Callback.backend = &backend;
        defer Callback.backend = null;
        stream.setCallback(&Callback.notify);
        try stream.attach();
        backend.beginFrame();
        try backend.writer().writeAll("frame");
        try testing.expectEqual(.ok, backend.endFrame());
        var spans: [4]raw.SpanInfo = undefined;
        const count = stream.drainSpans(&spans);
        defer for (spans[0..count]) |span| stream.markSpanConsumed(span);
        try testing.expectEqual(@as(u32, 3), count);
        try testing.expectEqualStrings("frame", spans[0].slice());
        try testing.expectEqualStrings("shutdown", spans[1].slice());
        try testing.expectEqualStrings("rawcontrol", spans[2].slice());
    }
}

const Borrow = struct { span: raw.SpanInfo, start: usize };

fn expectRejection(options: raw.Options, err: raw.StreamError) !void {
    switch (err) {
        // Block storage reports exhaustion as NoSpace; only growth stops at max_bytes.
        error.MaxBytes => try testing.expect(options.growth_policy == @backingInt(raw.GrowthPolicy.grow) and options.max_bytes != 0),
        error.NoSpace => {},
        else => return err,
    }
}

/// Accepted bytes are the FIFO model: drained, then queued, then pending bytes.
fn expectStreamModel(stream: *raw.Stream, accepted: []const u8, drained: []const u8, borrowed: []const Borrow) !void {
    stream.assertInvariants();
    var queued: [16384]u8 = undefined;
    const queued_len = stream.copyQueuedPrefix(&queued);
    try testing.expect(queued_len < queued.len);
    const published = drained.len + queued_len;
    try testing.expectEqual(accepted.len, published + stream.pending_len);
    try testing.expectEqualSlices(u8, accepted[0..drained.len], drained);
    try testing.expectEqualSlices(u8, accepted[drained.len..published], queued[0..queued_len]);
    var borrowed_bytes: u64 = 0;
    for (borrowed) |entry| {
        // Releases and later writes must never overwrite a borrowed span.
        try testing.expectEqualSlices(u8, drained[entry.start..][0..entry.span.len], entry.span.slice());
        borrowed_bytes += entry.span.len;
    }
    const stats = stream.getStats();
    try testing.expectEqual(@as(u64, accepted.len), stats.bytes_written);
    try testing.expectEqual(borrowed_bytes + queued_len, stats.outstanding_bytes);
    try testing.expectEqual(@as(u32, @intCast(borrowed.len)) + stats.pending_spans, stats.outstanding_spans);
}

fn drainModel(stream: *raw.Stream, drained: *std.ArrayList(u8), borrowed: *std.ArrayList(Borrow), max: usize) !void {
    var spans: [4]raw.SpanInfo = undefined;
    const count = stream.drainSpans(spans[0..max]);
    for (spans[0..count]) |span| {
        try borrowed.append(testing.allocator, .{ .span = span, .start = drained.items.len });
        try drained.appendSlice(testing.allocator, span.slice());
    }
}

fn runStreamModel(options: raw.Options, random: std.Random) !void {
    const allocator = testing.allocator;
    const stream = try raw.Stream.create(allocator, options);
    var accepted: std.ArrayList(u8) = .empty;
    var drained: std.ArrayList(u8) = .empty;
    var borrowed: std.ArrayList(Borrow) = .empty;
    defer {
        for (borrowed.items) |entry| stream.markSpanConsumed(entry.span);
        stream.destroy();
        accepted.deinit(allocator);
        drained.deinit(allocator);
        borrowed.deinit(allocator);
    }
    const chunk = options.chunk_size;
    var data: [128]u8 = undefined;
    for (0..200) |_| {
        random.bytes(&data);
        const len = random.uintAtMost(usize, 3 * chunk);
        const before = stream.getStats();
        // An unbounded stream grows its chunks and span ring instead of rejecting output.
        const grows = !stream.bounded();
        switch (random.uintLessThan(u8, 7)) {
            0 => {
                // Ordinary writes may accept a prefix before they fail.
                const result = stream.write(data[0..len]);
                const count = stream.getStats().bytes_written - before.bytes_written;
                try testing.expect(count <= len);
                try accepted.appendSlice(allocator, data[0..count]);
                if (result) |_| try testing.expectEqual(len, count) else |err| {
                    try testing.expect(!grows or stream.options.auto_commit_on_full == 0);
                    try expectRejection(options, err);
                }
            },
            1 => if (stream.writeAtomic(data[0..len])) |_| {
                try accepted.appendSlice(allocator, data[0..len]);
            } else |err| {
                // Atomic output never interleaves with an unfinished ordinary span.
                if (stream.pending_len != 0) try testing.expectEqual(error.Busy, err) else {
                    try testing.expect(!grows);
                    try expectRejection(options, err);
                }
                try testing.expectEqualDeep(before, stream.getStats());
            },
            2 => stream.commit() catch |err| try expectRejection(options, err),
            3 => {
                const min_len = random.intRangeAtMost(u32, 1, chunk);
                if (stream.pending_len != 0) {
                    try testing.expectError(error.Busy, stream.reserve(min_len));
                } else if (stream.reserve(min_len)) |info| {
                    try testing.expect(info.len >= min_len);
                    const count = random.uintAtMost(u32, info.len);
                    @memcpy(info.slice()[0..count], data[0..count]);
                    try stream.commitReserved(count);
                    try accepted.appendSlice(allocator, data[0..count]);
                } else |err| try expectRejection(options, err);
            },
            4 => try drainModel(stream, &drained, &borrowed, random.intRangeAtMost(usize, 1, 4)),
            5 => if (borrowed.items.len != 0) {
                const entry = borrowed.swapRemove(random.uintLessThan(usize, borrowed.items.len));
                try stream.releaseSpan(entry.span.slot_index, entry.span.release_id);
            },
            6 => {
                var next = stream.options;
                next.auto_commit_on_full = @intFromBool(random.boolean());
                try stream.setOptions(next);
            },
            else => unreachable,
        }
        try expectStreamModel(stream, accepted.items, drained.items, borrowed.items);
    }

    // Draining everything returns the stream to idle with every accepted byte in order.
    for (0..2) |_| {
        while (stream.hasPendingSpans()) try drainModel(stream, &drained, &borrowed, 4);
        for (borrowed.items) |entry| try stream.releaseSpan(entry.span.slot_index, entry.span.release_id);
        borrowed.clearRetainingCapacity();
        try stream.commit();
    }
    try testing.expectEqualSlices(u8, accepted.items, drained.items);
    try expectStreamModel(stream, accepted.items, drained.items, borrowed.items);

    // An idle stream reuses its storage for the largest atomic write it admits.
    const capacity: usize = if (stream.bounded()) @intCast(stream.atomicByteLimit()) else 3 * chunk;
    try stream.writeAtomic(data[0..capacity]);
    try accepted.appendSlice(allocator, data[0..capacity]);
    while (stream.hasPendingSpans()) try drainModel(stream, &drained, &borrowed, 4);
    try expectStreamModel(stream, accepted.items, drained.items, borrowed.items);
}

test "Stream - seeded operations preserve byte order, borrowed bytes, and accounting" {
    for (0..64) |seed| {
        var prng = std.Random.DefaultPrng.init(seed);
        const random = prng.random();
        const chunk_size = ([_]u32{ 4, 8, 16 })[random.uintLessThan(usize, 3)];
        const initial_chunks = random.intRangeAtMost(u32, 1, 3);
        const options: raw.Options = .{
            .chunk_size = chunk_size,
            .initial_chunks = initial_chunks,
            .max_bytes = switch (random.uintLessThan(u8, 3)) {
                0 => 0,
                1 => chunk_size * initial_chunks,
                else => chunk_size * (initial_chunks + 3),
            },
            .growth_policy = random.uintLessThan(u8, 2),
            .auto_commit_on_full = @intFromBool(random.boolean()),
            .span_queue_capacity = ([_]u32{ 2, 5, 64 })[random.uintLessThan(usize, 3)],
        };
        runStreamModel(options, random) catch |err| {
            std.debug.print("stream model failed: seed {d}, options {any}\n", .{ seed, options });
            return err;
        };
    }
}

test "Stream - closed, reserved, and pending states reject conflicting operations" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(64, 1, false));
    defer stream.destroy();
    try testing.expectEqual(@as(u32, 4096), stream.span_ring.capacity);
    var spans: [2]raw.SpanInfo = undefined;
    try stream.write("");
    try stream.commit();
    try testing.expectEqual(@as(u32, 0), stream.drainSpans(&spans));
    try testing.expectError(error.Invalid, stream.commitReserved(0));
    try testing.expectError(error.NoSpace, stream.reserve(65));
    // Without auto-commit, a write larger than the free chunk space is rejected whole.
    try testing.expectError(error.NoSpace, stream.write(&@as([65]u8, @splat('x'))));
    try testing.expectEqual(@as(u64, 0), stream.getStats().bytes_written);

    const info = try stream.reserve(1);
    try testing.expectError(error.Busy, stream.reserve(1));
    try testing.expectError(error.Busy, stream.write("x"));
    try testing.expectError(error.Busy, stream.commit());
    try testing.expectError(error.Busy, stream.close());
    try testing.expectError(error.NoSpace, stream.commitReserved(info.len + 1));
    try stream.commitReserved(0);
    try testing.expectEqual(@as(u64, 0), stream.getStats().spans_committed);

    try stream.write("pending");
    try testing.expectError(error.Busy, stream.reserve(1));
    try stream.setOptions(testOptions(128, 1, true));
    try testing.expectEqual(@as(u32, 64), stream.options.chunk_size);
    try stream.close();
    try stream.close();
    try testing.expectEqual(@as(u64, 1), stream.getStats().spans_committed);
    try testing.expectError(error.Invalid, stream.write("x"));
    try testing.expectError(error.Invalid, stream.writeAtomic("x"));
    try testing.expectError(error.Invalid, stream.reserve(1));
    try testing.expectError(error.Invalid, stream.commit());
    try testing.expectError(error.Invalid, stream.commitReserved(0));
    try testing.expectError(error.Invalid, stream.setOptions(testOptions(128, 1, true)));
    try testing.expectEqual(@as(u32, 1), stream.drainSpans(&spans));
    defer stream.markSpanConsumed(spans[0]);
    try testing.expectEqualStrings("pending", spans[0].slice());
}

test "Stream - commit after small write should allow reuse of remaining chunk space" {
    // Regression: commit must not burn remaining chunk space.

    const chunk_size: u32 = 256;
    const stream = try raw.Stream.create(testing.allocator, testOptions(chunk_size, 1, false));
    defer stream.destroy();

    try stream.write("0123456789");
    try stream.commit();

    var stats = stream.getStats();
    try testing.expectEqual(@as(u64, 10), stats.bytes_written);
    try testing.expectEqual(@as(u64, 1), stats.spans_committed);
    try testing.expectEqual(@as(u32, 1), stats.chunks);

    var buf: [16]raw.SpanInfo = undefined;
    const count = stream.drainSpans(&buf);
    try testing.expectEqual(@as(u32, 1), count);
    stream.markSpanConsumed(buf[0]);

    try stream.write("abcdefghij");
    try stream.commit();

    stats = stream.getStats();
    try testing.expectEqual(@as(u64, 20), stats.bytes_written);
    try testing.expectEqual(@as(u64, 2), stats.spans_committed);
    try testing.expectEqual(@as(u32, 1), stats.chunks);

    const count2 = stream.drainSpans(&buf);
    try testing.expectEqual(@as(u32, 1), count2);
    const span = buf[0];
    try testing.expectEqual(@as(u32, 10), span.offset);
    try testing.expectEqual(@as(u32, 10), span.len);
    stream.markSpanConsumed(buf[0]);
}

test "Stream - repeated small write+commit should not force chunk growth" {
    // Regression: small write+commit should not force chunk growth.

    const chunk_size: u32 = 1024;
    const stream = try raw.Stream.create(testing.allocator, testOptions(chunk_size, 1, false));
    defer stream.destroy();

    var i: u32 = 0;
    while (i < 4) : (i += 1) {
        try stream.write("12345678");
        try stream.commit();
    }

    const stats = stream.getStats();
    try testing.expectEqual(@as(u64, 32), stats.bytes_written);
    try testing.expectEqual(@as(u64, 4), stats.spans_committed);

    try testing.expectEqual(@as(u32, 1), stats.chunks);

    const drained = drainAllSpans(stream);
    try testing.expectEqual(@as(u64, 32), drained);
}

test "Stream - auto_commit with max_bytes should handle write spanning chunk boundary" {
    // Regression: auto_commit must not fail when continuing across a boundary.

    const stream = try raw.Stream.create(testing.allocator, testOptionsFull(32, 2, 64, true));
    defer stream.destroy();

    const data: [64]u8 = @splat('X');
    try stream.write(&data);

    try testing.expectEqual(@as(u64, 64), stream.getStats().bytes_written);
    try testing.expect(stream.getStats().spans_committed >= 1);

    _ = drainAllSpans(stream);
}

fn blockOptions(chunk_size: u32, initial_chunks: u32, auto_commit: bool) raw.Options {
    return .{
        .chunk_size = chunk_size,
        .initial_chunks = initial_chunks,
        .max_bytes = 0,
        .growth_policy = @backingInt(raw.GrowthPolicy.block),
        .auto_commit_on_full = if (auto_commit) 1 else 0,
        .span_queue_capacity = 0,
    };
}

test "Stream - pending data survives failed commit and close allocation" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    var opts = testOptions(64, 1, false);
    opts.span_queue_capacity = 2;
    const stream = try raw.Stream.create(failing.allocator(), opts);
    defer stream.destroy();

    var i: u32 = 0;
    while (i < 2) : (i += 1) {
        try stream.write("x");
        try stream.commit();
    }

    try stream.write("important");
    failing.fail_index = failing.alloc_index;
    const result = stream.commit();
    try testing.expectError(raw.StreamError.OutOfMemory, result);
    try testing.expectError(raw.StreamError.OutOfMemory, stream.close());
    try testing.expect(!stream.closed);
    try testing.expect(stream.hasPendingBytes());

    _ = drainAllSpans(stream);
    try stream.close();

    const stats = stream.getStats();
    try testing.expectEqual(@as(u64, 2 + 9), stats.bytes_written);
    try testing.expectEqual(@as(u64, 3), stats.spans_committed);

    var buf: [16]raw.SpanInfo = undefined;
    const count = stream.drainSpans(&buf);
    try testing.expectEqual(@as(u32, 1), count);
    const slice = buf[0].slice();
    try testing.expectEqualStrings("important", slice);
    stream.markSpanConsumed(buf[0]);
}

test "Stream - destroy without close commits pending data" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(256, 1, false));

    try stream.write("before destroy");

    const stats = stream.getStats();
    try testing.expectEqual(@as(u64, 14), stats.bytes_written);
    try testing.expectEqual(@as(u64, 0), stats.spans_committed);

    stream.destroy();
}

var data_available_count: u32 = 0;

fn countingCallback(_: usize, event_id: u32, _: usize, _: u64) callconv(.c) void {
    if (event_id == @backingInt(raw.EventId.DataAvailable)) {
        data_available_count += 1;
    }
}

test "Stream - write returning NoSpace emits DataAvailable exactly once" {
    // Regression: NoSpace path must not double-emit DataAvailable.
    data_available_count = 0;
    const stream = try raw.Stream.create(testing.allocator, testOptions(64, 2, false));
    defer stream.destroy();

    stream.setCallback(&countingCallback);
    try stream.attach();
    data_available_count = 0;
    const first: [64]u8 = @splat('A');
    try stream.write(&first);
    const result = stream.write(&@as([65]u8, @splat('B')));
    try testing.expectError(raw.StreamError.NoSpace, result);
    try testing.expectEqual(@as(u32, 1), data_available_count);
}

var drain_during_write_stream: ?*raw.Stream = null;
var drain_during_write_total: u64 = 0;

fn drainingCallback(stream_ptr: usize, event_id: u32, _: usize, _: u64) callconv(.c) void {
    if (event_id != @backingInt(raw.EventId.DataAvailable)) return;
    const s = drain_during_write_stream orelse return;
    if (@intFromPtr(s) != stream_ptr) return;

    var buf: [64]raw.SpanInfo = undefined;
    while (true) {
        const count = s.drainSpans(&buf);
        if (count == 0) break;
        var i: u32 = 0;
        while (i < count) : (i += 1) {
            drain_during_write_total += buf[i].len;
            s.markSpanConsumed(buf[i]);
        }
    }
}

test "Stream - synchronous drain during write does not corrupt state" {
    drain_during_write_stream = null;
    drain_during_write_total = 0;

    const chunk_size: u32 = 64;
    const stream = try raw.Stream.create(testing.allocator, testOptions(chunk_size, 2, true));
    defer stream.destroy();

    stream.setCallback(&drainingCallback);
    try stream.attach();
    drain_during_write_stream = stream;
    drain_during_write_total = 0;

    const data: [256]u8 = @splat('D');
    try stream.write(&data);

    try stream.commit();
    var buf: [64]raw.SpanInfo = undefined;
    while (true) {
        const count = stream.drainSpans(&buf);
        if (count == 0) break;
        var i: u32 = 0;
        while (i < count) : (i += 1) {
            drain_during_write_total += buf[i].len;
            stream.markSpanConsumed(buf[i]);
        }
    }

    try testing.expectEqual(@as(u64, 256), drain_during_write_total);
    try testing.expectEqual(@as(u64, 256), stream.getStats().bytes_written);

    drain_during_write_stream = null;
}

test "Stream - release identities survive ring growth beyond u32" {
    var options = testOptions(256, 2, false);
    options.span_queue_capacity = 3;
    const stream = try raw.Stream.create(testing.allocator, options);
    defer stream.destroy();

    const near_max: u64 = std.math.maxInt(u32) - 5;
    stream.span_ring.next_id = near_max;
    try stream.write("first");
    try stream.commit();
    var first: [1]raw.SpanInfo = undefined;
    try testing.expectEqual(@as(u32, 1), stream.drainSpans(&first));
    defer stream.markSpanConsumed(first[0]);

    var i: u32 = 0;
    while (i < 10) : (i += 1) {
        try stream.write("data");
        try stream.commit();
    }

    try testing.expectEqual(@as(u32, 10), stream.span_ring.count());

    var buf: [16]raw.SpanInfo = undefined;
    const count = stream.drainSpans(&buf);
    try testing.expectEqual(@as(u32, 10), count);

    try testing.expectEqual(@as(u32, 0), stream.span_ring.count());
    try testing.expectEqual(near_max + 11, stream.span_ring.next_id);
    try testing.expectEqual(near_max + 10, buf[9].release_id);

    try testing.expectEqualStrings("data", buf[9].slice());
    for (buf[0..count]) |span| {
        stream.markSpanConsumed(span);
    }
    try testing.expectEqualStrings("first", first[0].slice());
}

test "Stream - chunk storage growth preserves active span refcounts" {
    const chunk_size: u32 = 64;
    const stream = try raw.Stream.create(testing.allocator, testOptions(chunk_size, 1, false));
    defer stream.destroy();

    const first: [64]u8 = @splat('F');
    try stream.write(&first);
    try stream.commit();

    try testing.expectEqual(@as(u8, 1), stream.chunks.items[0].refcount);
    const first_ptr = stream.chunks.items[0].ptr;
    const initial_capacity = stream.chunks.capacity;

    var i: usize = 0;
    while (i < initial_capacity) : (i += 1) {
        const filler: [64]u8 = @splat(@intCast(i + 0x10));
        try stream.write(&filler);
        try stream.commit();
    }

    try testing.expect(stream.chunks.capacity > initial_capacity);
    try testing.expectEqual(first_ptr, stream.chunks.items[0].ptr);
    try testing.expectEqual(@as(u8, 'F'), first_ptr[0]);
    try testing.expectEqual(@as(u8, 1), stream.chunks.items[0].refcount);

    const drained = drainAllSpans(stream);
    try testing.expectEqual(@as(u64, (initial_capacity + 1) * chunk_size), drained);

    try testing.expectEqual(@as(u8, 0), stream.chunks.items[0].refcount);
}

test "Stream - chunk refcount caps at 255 and advances to new chunk" {
    // Refcount saturation should force a new chunk.
    const chunk_size: u32 = 4096;
    const stream = try raw.Stream.create(testing.allocator, testOptions(chunk_size, 1, false));
    defer stream.destroy();

    var i: u32 = 0;
    while (i < 260) : (i += 1) {
        try stream.write("x");
        try stream.commit();
    }

    try testing.expectEqual(@as(u8, 255), stream.chunks.items[0].refcount);
    try testing.expect(stream.getStats().chunks >= 2);
    var buf: [64]raw.SpanInfo = undefined;
    var drain_count: u32 = 0;
    while (true) {
        const count = stream.drainSpans(&buf);
        if (count == 0) break;
        var j: u32 = 0;
        while (j < count) : (j += 1) {
            stream.markSpanConsumed(buf[j]);
            drain_count += 1;

            if (drain_count == 254) {
                try testing.expectEqual(@as(u8, 1), stream.chunks.items[0].refcount);
            }
        }
    }

    try testing.expectEqual(@as(u32, 260), drain_count);
    try testing.expectEqual(@as(u8, 0), stream.chunks.items[0].refcount);
}

test "Stream - refcount saturation must not cause data corruption" {
    // Regression: refcount saturation must not allow reuse that corrupts data.

    const chunk_size: u32 = 256;
    const stream = try raw.Stream.create(testing.allocator, testOptions(chunk_size, 1, false));
    defer stream.destroy();

    var i: u32 = 0;
    while (i < 256) : (i += 1) {
        const byte = [1]u8{@intCast(i % 256)};
        try stream.write(&byte);
        try stream.commit();
    }

    try testing.expectEqual(@as(u8, 255), stream.chunks.items[0].refcount);

    var buf: [64]raw.SpanInfo = undefined;
    var drained: u32 = 0;
    var data_index: u32 = 0;
    while (drained < 255) {
        const want: u32 = @intCast(@min(buf.len, 255 - drained));
        const count = stream.drainSpans(buf[0..want]);
        if (count == 0) break;
        var j: u32 = 0;
        while (j < count) : (j += 1) {
            const slice = buf[j].slice();
            try testing.expectEqual(@as(usize, 1), slice.len);
            try testing.expectEqual(@as(u8, @intCast(data_index % 256)), slice[0]);
            stream.markSpanConsumed(buf[j]);
            data_index += 1;
            drained += 1;
        }
    }
    try testing.expectEqual(@as(u32, 255), drained);

    try testing.expectEqual(@as(u8, 0), stream.chunks.items[0].refcount);
    const overwrite: [128]u8 = @splat('Z');
    try stream.write(&overwrite);
    try stream.commit();

    const count = stream.drainSpans(&buf);
    try testing.expect(count >= 1);

    var found = false;
    var j: u32 = 0;
    while (j < count) : (j += 1) {
        const slice = buf[j].slice();
        if (slice.len == 1) {
            try testing.expectEqual(@as(u8, 255), slice[0]);
            found = true;
            stream.markSpanConsumed(buf[j]);
        } else {
            stream.markSpanConsumed(buf[j]);
        }
    }
    try testing.expect(found);
}

// Regression: addChunkLocked error paths must not leak or desync state.

test "addChunkLocked must not leak chunk data when ArrayList append fails" {
    // Sweep failing allocations to ensure no leaks.
    const chunk_size: u32 = 64;
    const initial_chunks: u32 = 9;

    var counter = std.testing.FailingAllocator.init(std.heap.page_allocator, .{});
    {
        const s = raw.Stream.create(counter.allocator(), testOptions(chunk_size, initial_chunks, false)) catch
            return error.TestUnexpectedResult;
        s.destroy();
    }
    const create_allocs = counter.allocations;

    const configs = [_]struct { resize_fail: usize }{
        .{ .resize_fail = std.math.maxInt(usize) },
        .{ .resize_fail = 0 },
    };

    for (configs) |cfg| {
        var fi: usize = 0;
        while (fi <= create_allocs + 2) : (fi += 1) {
            var fa = std.testing.FailingAllocator.init(testing.allocator, .{
                .fail_index = fi,
                .resize_fail_index = cfg.resize_fail,
            });

            const result = raw.Stream.create(fa.allocator(), testOptions(chunk_size, initial_chunks, false));
            if (result) |stream| {
                stream.destroy();
            } else |_| {}
        }
    }
}

test "addChunkLocked must not leak chunk data during initial create" {
    // Regression: failing append must not leak chunk data.

    var failing = std.testing.FailingAllocator.init(testing.allocator, .{
        .fail_index = 3,
    });

    const result = raw.Stream.create(failing.allocator(), testOptions(64, 1, false));
    try testing.expectError(raw.StreamError.OutOfMemory, result);
}

test "addChunkLocked failure preserves existing chunk ownership" {
    var failing = std.testing.FailingAllocator.init(testing.allocator, .{});

    const stream = raw.Stream.create(failing.allocator(), testOptions(64, 1, false)) catch
        return error.TestUnexpectedResult;
    defer stream.destroy();

    stream.write(&@as([64]u8, @splat('A'))) catch return error.TestUnexpectedResult;
    stream.commit() catch return error.TestUnexpectedResult;
    failing.fail_index = failing.alloc_index;
    const result = stream.write("x");
    try testing.expectError(raw.StreamError.OutOfMemory, result);
    try testing.expectEqual(@as(usize, 1), stream.chunks.items.len);
    try testing.expectEqual(@as(u8, 1), stream.chunks.items[0].refcount);
}
