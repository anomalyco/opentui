const std = @import("std");
const testing = std.testing;
const raw = @import("../native-span-feed.zig");

fn testOptions(chunk_size: u32, initial_chunks: u32, auto_commit: bool) raw.Options {
    return testOptionsFull(chunk_size, initial_chunks, 0, auto_commit);
}

fn testOptionsFull(chunk_size: u32, initial_chunks: u32, max_bytes: u64, auto_commit: bool) raw.Options {
    return .{
        .chunk_size = chunk_size,
        .initial_chunks = initial_chunks,
        .max_bytes = max_bytes,
        .growth_policy = @intFromEnum(raw.GrowthPolicy.grow),
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

test "Stream - create with default options" {
    const stream = try raw.Stream.create(testing.allocator, null);
    defer stream.destroy();

    const stats = stream.getStats();
    try testing.expect(stats.chunks >= 1);
}

test "Stream - write and commit produces span with correct byte count" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(1024, 2, false));
    defer stream.destroy();

    const data = "hello world";
    try stream.write(data);
    try stream.commit();

    const stats = stream.getStats();
    try testing.expectEqual(@as(u64, data.len), stats.bytes_written);
    try testing.expectEqual(@as(u64, 1), stats.spans_committed);

    const drained = drainAllSpans(stream);
    try testing.expectEqual(@as(u64, data.len), drained);
}

test "Stream - write with auto_commit fills chunk and commits automatically" {
    const chunk_size: u32 = 64;
    const stream = try raw.Stream.create(testing.allocator, testOptions(chunk_size, 2, true));
    defer stream.destroy();

    const data = [_]u8{'A'} ** 64;
    try stream.write(&data);

    const stats = stream.getStats();
    try testing.expectEqual(@as(u64, 64), stats.bytes_written);
    try testing.expectEqual(@as(u64, 1), stats.spans_committed);
}

test "Stream - write spanning multiple chunks with auto_commit" {
    const chunk_size: u32 = 64;
    const stream = try raw.Stream.create(testing.allocator, testOptions(chunk_size, 2, true));
    defer stream.destroy();

    const data = [_]u8{'B'} ** 150;
    try stream.write(&data);

    const stats = stream.getStats();
    try testing.expectEqual(@as(u64, 150), stats.bytes_written);
    try testing.expectEqual(@as(u64, 2), stats.spans_committed);

    try stream.commit();
    const stats2 = stream.getStats();
    try testing.expectEqual(@as(u64, 3), stats2.spans_committed);

    const drained = drainAllSpans(stream);
    try testing.expectEqual(@as(u64, 150), drained);
}

test "Stream - write returns NoSpace when auto_commit disabled and data exceeds chunk" {
    const chunk_size: u32 = 64;
    const stream = try raw.Stream.create(testing.allocator, testOptions(chunk_size, 2, false));
    defer stream.destroy();

    const data = [_]u8{'C'} ** 65;
    const result = stream.write(&data);
    try testing.expectError(raw.StreamError.NoSpace, result);
}

test "Stream - write exactly fills chunk without auto_commit succeeds" {
    const chunk_size: u32 = 64;
    const stream = try raw.Stream.create(testing.allocator, testOptions(chunk_size, 2, false));
    defer stream.destroy();

    const exact = [_]u8{'A'} ** 64;
    try stream.write(&exact);

    const stats = stream.getStats();
    try testing.expectEqual(@as(u64, 64), stats.bytes_written);

    try stream.commit();
    _ = drainAllSpans(stream);

    try stream.write("B");
    try stream.commit();

    const stats2 = stream.getStats();
    try testing.expectEqual(@as(u64, 65), stats2.bytes_written);
    try testing.expectEqual(@as(u64, 2), stats2.spans_committed);
}

test "Stream - written data matches drained span content" {
    const chunk_size: u32 = 256;
    const stream = try raw.Stream.create(testing.allocator, testOptions(chunk_size, 2, false));
    defer stream.destroy();

    const data = "the quick brown fox jumps over the lazy dog";
    try stream.write(data);
    try stream.commit();

    var buf: [16]raw.SpanInfo = undefined;
    const count = stream.drainSpans(&buf);
    try testing.expectEqual(@as(u32, 1), count);

    const span = buf[0];
    const slice = span.slice();
    try testing.expectEqualStrings(data, slice);
    stream.markSpanConsumed(buf[0]);
}

test "Stream - reserve and commitReserved round-trip" {
    const chunk_size: u32 = 256;
    const stream = try raw.Stream.create(testing.allocator, testOptions(chunk_size, 2, false));
    defer stream.destroy();

    const info = try stream.reserve(10);
    try testing.expect(info.len >= 10);

    const dest = info.slice();
    @memcpy(dest[0..5], "hello");

    try stream.commitReserved(5);

    const stats = stream.getStats();
    try testing.expectEqual(@as(u64, 5), stats.bytes_written);
    try testing.expectEqual(@as(u64, 1), stats.spans_committed);

    const drained = drainAllSpans(stream);
    try testing.expectEqual(@as(u64, 5), drained);
}

test "Stream - reserve returns Busy if already reserved" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(256, 2, false));
    defer stream.destroy();

    _ = try stream.reserve(1);
    const result = stream.reserve(1);
    try testing.expectError(raw.StreamError.Busy, result);

    try stream.commitReserved(0);
}

test "Stream - reserve returns Busy if pending data exists" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(256, 2, false));
    defer stream.destroy();

    try stream.write("some data");
    const result = stream.reserve(1);
    try testing.expectError(raw.StreamError.Busy, result);
}

test "Stream - write returns Busy while reservation is active" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(256, 2, false));
    defer stream.destroy();

    _ = try stream.reserve(1);
    const result = stream.write("data");
    try testing.expectError(raw.StreamError.Busy, result);

    try stream.commitReserved(0);
}

test "Stream - write to closed stream returns Invalid" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(256, 2, false));
    defer stream.destroy();

    try stream.close();
    const result = stream.write("data");
    try testing.expectError(raw.StreamError.Invalid, result);
}

test "Stream - double close does not error" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(256, 2, false));
    defer stream.destroy();

    try stream.close();
    try stream.close();
}

test "Stream - consecutive writes without auto_commit preserves all data" {
    // Regression: auto_commit off must not drop pending data across writes.

    const chunk_size: u32 = 64;
    const stream = try raw.Stream.create(testing.allocator, testOptions(chunk_size, 2, false));
    defer stream.destroy();

    const first = [_]u8{'A'} ** 64;
    try stream.write(&first);

    var stats = stream.getStats();
    try testing.expectEqual(@as(u64, 64), stats.bytes_written);

    const second = "BBBB";
    try stream.write(second);

    stats = stream.getStats();
    try testing.expectEqual(@as(u64, 68), stats.bytes_written);
    try testing.expectEqual(@as(u64, 1), stats.spans_committed);
    try stream.commit();
    stats = stream.getStats();
    try testing.expectEqual(@as(u64, 2), stats.spans_committed);

    const drained = drainAllSpans(stream);
    try testing.expectEqual(@as(u64, 68), drained);
}

test "Stream - write that exactly fills chunk then write more (no auto_commit)" {
    const chunk_size: u32 = 32;
    const stream = try raw.Stream.create(testing.allocator, testOptions(chunk_size, 2, false));
    defer stream.destroy();

    const fill = [_]u8{'X'} ** 32;
    try stream.write(&fill);

    try stream.write("Y");
    try stream.commit();

    const stats = stream.getStats();
    try testing.expectEqual(@as(u64, 33), stats.bytes_written);
    try testing.expectEqual(@as(u64, 2), stats.spans_committed);
    var buf: [16]raw.SpanInfo = undefined;
    const count = stream.drainSpans(&buf);
    try testing.expectEqual(@as(u32, 2), count);

    const span1 = buf[0].slice();
    try testing.expectEqual(@as(usize, 32), span1.len);
    try testing.expectEqual(@as(u8, 'X'), span1[0]);
    try testing.expectEqual(@as(u8, 'X'), span1[31]);

    const span2 = buf[1].slice();
    try testing.expectEqualStrings("Y", span2);

    stream.markSpanConsumed(buf[0]);
    stream.markSpanConsumed(buf[1]);
}

test "Stream - multiple chunk transitions without auto_commit" {
    const chunk_size: u32 = 16;
    const stream = try raw.Stream.create(testing.allocator, testOptions(chunk_size, 1, false));
    defer stream.destroy();

    try stream.write("AAAAAAAAAAAAAAAA");
    try stream.write("BBBBBBBBBBBBBBBB");
    try stream.write("CCCCCCCC");

    var stats = stream.getStats();
    try testing.expectEqual(@as(u64, 40), stats.bytes_written);
    try testing.expectEqual(@as(u64, 2), stats.spans_committed);
    try stream.commit();
    stats = stream.getStats();
    try testing.expectEqual(@as(u64, 3), stats.spans_committed);

    const drained = drainAllSpans(stream);
    try testing.expectEqual(@as(u64, 40), drained);
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

test "Stream - max_bytes returns MaxBytes when limit is reached" {
    const stream = try raw.Stream.create(testing.allocator, testOptionsFull(32, 2, 64, false));
    defer stream.destroy();

    try testing.expectEqual(@as(u32, 2), stream.getStats().chunks);

    const fill1 = [_]u8{'A'} ** 32;
    try stream.write(&fill1);
    try stream.commit();

    const fill2 = [_]u8{'B'} ** 32;
    try stream.write(&fill2);
    try stream.commit();

    const result = stream.write("C");
    try testing.expectError(raw.StreamError.MaxBytes, result);
}

test "Stream - max_bytes allows reuse after draining" {
    const stream = try raw.Stream.create(testing.allocator, testOptionsFull(32, 2, 64, false));
    defer stream.destroy();

    const fill1 = [_]u8{'A'} ** 32;
    try stream.write(&fill1);
    try stream.commit();
    const fill2 = [_]u8{'B'} ** 32;
    try stream.write(&fill2);
    try stream.commit();

    _ = drainAllSpans(stream);
    const fill3 = [_]u8{'C'} ** 32;
    try stream.write(&fill3);
    try stream.commit();

    try testing.expectEqual(@as(u64, 96), stream.getStats().bytes_written);
    try testing.expectEqual(@as(u32, 2), stream.getStats().chunks);
}

test "Stream - auto_commit with max_bytes works when consumer keeps up" {
    const stream = try raw.Stream.create(testing.allocator, testOptionsFull(32, 2, 64, true));
    defer stream.destroy();

    const fill1 = [_]u8{'A'} ** 32;
    try stream.write(&fill1);

    _ = drainAllSpans(stream);

    const fill2 = [_]u8{'B'} ** 32;
    try stream.write(&fill2);

    _ = drainAllSpans(stream);

    const fill3 = [_]u8{'C'} ** 32;
    try stream.write(&fill3);

    try testing.expectEqual(@as(u64, 96), stream.getStats().bytes_written);
    try testing.expectEqual(@as(u32, 2), stream.getStats().chunks);

    _ = drainAllSpans(stream);
}

test "Stream - auto_commit with max_bytes should handle write spanning chunk boundary" {
    // Regression: auto_commit must not fail when continuing across a boundary.

    const stream = try raw.Stream.create(testing.allocator, testOptionsFull(32, 2, 64, true));
    defer stream.destroy();

    const data = [_]u8{'X'} ** 64;
    try stream.write(&data);

    try testing.expectEqual(@as(u64, 64), stream.getStats().bytes_written);
    try testing.expect(stream.getStats().spans_committed >= 1);

    _ = drainAllSpans(stream);
}

test "Stream - memory growth under pressure allocates new chunks" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(64, 1, true));
    defer stream.destroy();

    try testing.expectEqual(@as(u32, 1), stream.getStats().chunks);

    var i: usize = 0;
    while (i < 10) : (i += 1) {
        const data = [_]u8{@intCast(i)} ** 64;
        try stream.write(&data);
    }

    const stats = stream.getStats();
    try testing.expectEqual(@as(u64, 640), stats.bytes_written);
    try testing.expect(stats.chunks >= 10);

    const drained = drainAllSpans(stream);
    try testing.expectEqual(@as(u64, 640), drained);
}

fn blockOptions(chunk_size: u32, initial_chunks: u32, auto_commit: bool) raw.Options {
    return .{
        .chunk_size = chunk_size,
        .initial_chunks = initial_chunks,
        .max_bytes = 0,
        .growth_policy = @intFromEnum(raw.GrowthPolicy.block),
        .auto_commit_on_full = if (auto_commit) 1 else 0,
        .span_queue_capacity = 0,
    };
}

test "Stream - growth_policy=block prevents new chunk allocation" {
    const chunk_size: u32 = 64;
    const stream = try raw.Stream.create(testing.allocator, blockOptions(chunk_size, 2, false));
    defer stream.destroy();

    try testing.expectEqual(@as(u32, 2), stream.getStats().chunks);

    const fill1 = [_]u8{'A'} ** 64;
    try stream.write(&fill1);
    try stream.commit();

    const fill2 = [_]u8{'B'} ** 64;
    try stream.write(&fill2);
    try stream.commit();

    const result = stream.write("C");
    try testing.expectError(raw.StreamError.NoSpace, result);

    try testing.expectEqual(@as(u32, 2), stream.getStats().chunks);
}

test "Stream - growth_policy=block allows reuse after draining" {
    const chunk_size: u32 = 64;
    const stream = try raw.Stream.create(testing.allocator, blockOptions(chunk_size, 2, false));
    defer stream.destroy();

    try stream.write(&([_]u8{'A'} ** 64));
    try stream.commit();
    try stream.write(&([_]u8{'B'} ** 64));
    try stream.commit();

    _ = drainAllSpans(stream);
    try stream.write(&([_]u8{'C'} ** 64));
    try stream.commit();

    try testing.expectEqual(@as(u64, 192), stream.getStats().bytes_written);
    try testing.expectEqual(@as(u32, 2), stream.getStats().chunks);
}

test "Stream - growth_policy=block with auto_commit returns NoSpace when pool exhausted" {
    const chunk_size: u32 = 32;
    const stream = try raw.Stream.create(testing.allocator, blockOptions(chunk_size, 2, true));
    defer stream.destroy();

    try stream.write(&([_]u8{'X'} ** 64));

    const result = stream.write("Y");
    try testing.expectError(raw.StreamError.NoSpace, result);

    try testing.expectEqual(@as(u32, 2), stream.getStats().chunks);
}

test "Stream - span ring grows when capacity is reached" {
    const chunk_size: u32 = 4096;
    const stream = try raw.Stream.create(testing.allocator, testOptions(chunk_size, 1, false));
    defer stream.destroy();

    var i: u32 = 0;
    while (i < 4096) : (i += 1) {
        try stream.write("x");
        try stream.commit();
    }

    try testing.expectEqual(@as(u32, 4096), stream.getStats().pending_spans);

    try stream.write("y");
    try stream.commit();
    try testing.expectEqual(@as(u32, 4097), stream.getStats().pending_spans);
}

test "Stream - span ring recovers after draining" {
    const chunk_size: u32 = 4096;
    const stream = try raw.Stream.create(testing.allocator, testOptions(chunk_size, 1, false));
    defer stream.destroy();

    var i: u32 = 0;
    while (i < 4096) : (i += 1) {
        try stream.write("x");
        try stream.commit();
    }

    _ = drainAllSpans(stream);
    try testing.expectEqual(@as(u32, 0), stream.getStats().pending_spans);

    try stream.write("z");
    try stream.commit();
    try testing.expectEqual(@as(u32, 1), stream.getStats().pending_spans);

    _ = drainAllSpans(stream);
}

test "Stream - custom span_queue_capacity can grow" {
    var opts = testOptions(4096, 1, false);
    opts.span_queue_capacity = 8;
    const stream = try raw.Stream.create(testing.allocator, opts);
    defer stream.destroy();

    var i: u32 = 0;
    while (i < 8) : (i += 1) {
        try stream.write("x");
        try stream.commit();
    }
    try testing.expectEqual(@as(u32, 8), stream.getStats().pending_spans);

    try stream.write("y");
    try stream.commit();
    try testing.expectEqual(@as(u32, 9), stream.getStats().pending_spans);

    _ = drainAllSpans(stream);
    try testing.expectEqual(@as(u32, 0), stream.getStats().pending_spans);

    try stream.write("z");
    try stream.commit();
    try testing.expectEqual(@as(u32, 1), stream.getStats().pending_spans);
}

test "Stream - large span_queue_capacity works" {
    var opts = testOptions(4096, 1, false);
    opts.span_queue_capacity = 8192;
    const stream = try raw.Stream.create(testing.allocator, opts);
    defer stream.destroy();

    var i: u32 = 0;
    while (i < 5000) : (i += 1) {
        try stream.write("x");
        try stream.commit();
    }
    try testing.expectEqual(@as(u32, 5000), stream.getStats().pending_spans);

    _ = drainAllSpans(stream);
    try testing.expectEqual(@as(u32, 0), stream.getStats().pending_spans);
}

test "Stream - span_queue_capacity zero defaults to 4096" {
    var opts = testOptions(4096, 1, false);
    opts.span_queue_capacity = 0;
    const stream = try raw.Stream.create(testing.allocator, opts);
    defer stream.destroy();

    var i: u32 = 0;
    while (i < 4096) : (i += 1) {
        try stream.write("x");
        try stream.commit();
    }
    try testing.expectEqual(@as(u32, 4096), stream.getStats().pending_spans);

    try stream.write("y");
    try stream.commit();
    try testing.expectEqual(@as(u32, 4097), stream.getStats().pending_spans);
}

test "Stream - data integrity across many chunks with auto_commit" {
    const chunk_size: u32 = 64;
    const stream = try raw.Stream.create(testing.allocator, testOptions(chunk_size, 1, true));
    defer stream.destroy();

    var source: [1024]u8 = undefined;
    for (&source, 0..) |*b, idx| {
        b.* = @intCast(idx % 256);
    }

    try stream.write(&source);
    try stream.commit();
    var received: [1024]u8 = undefined;
    var offset: usize = 0;

    var buf: [256]raw.SpanInfo = undefined;
    while (true) {
        const count = stream.drainSpans(&buf);
        if (count == 0) break;
        var i: u32 = 0;
        while (i < count) : (i += 1) {
            const span = buf[i];
            const slice = span.slice();
            @memcpy(received[offset .. offset + slice.len], slice);
            offset += slice.len;
            stream.markSpanConsumed(buf[i]);
        }
    }

    try testing.expectEqual(@as(usize, 1024), offset);
    try testing.expectEqualSlices(u8, &source, &received);
}

test "Stream - data integrity with reserve across multiple chunks" {
    const chunk_size: u32 = 64;
    const stream = try raw.Stream.create(testing.allocator, testOptions(chunk_size, 1, false));
    defer stream.destroy();

    var written: [256]u8 = undefined;
    var w_offset: usize = 0;

    while (w_offset < 256) {
        const info = try stream.reserve(1);
        const dest = info.slice();
        const to_write = @min(dest.len, 256 - w_offset);
        var j: usize = 0;
        while (j < to_write) : (j += 1) {
            const val: u8 = @intCast((w_offset + j) % 256);
            dest[j] = val;
            written[w_offset + j] = val;
        }
        try stream.commitReserved(@intCast(to_write));
        w_offset += to_write;
    }

    var received: [256]u8 = undefined;
    var r_offset: usize = 0;

    var buf: [64]raw.SpanInfo = undefined;
    while (true) {
        const count = stream.drainSpans(&buf);
        if (count == 0) break;
        var i: u32 = 0;
        while (i < count) : (i += 1) {
            const slice = buf[i].slice();
            @memcpy(received[r_offset .. r_offset + slice.len], slice);
            r_offset += slice.len;
            stream.markSpanConsumed(buf[i]);
        }
    }

    try testing.expectEqual(@as(usize, 256), r_offset);
    try testing.expectEqualSlices(u8, &written, &received);
}

test "Stream - reserve on closed stream returns Invalid" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(256, 1, false));
    defer stream.destroy();

    try stream.close();
    const result = stream.reserve(1);
    try testing.expectError(raw.StreamError.Invalid, result);
}

test "Stream - commit on closed stream returns Invalid" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(256, 1, false));
    defer stream.destroy();

    try stream.close();
    const result = stream.commit();
    try testing.expectError(raw.StreamError.Invalid, result);
}

test "Stream - commitReserved on closed stream returns Invalid" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(256, 1, false));
    defer stream.destroy();

    try stream.close();
    const result = stream.commitReserved(0);
    try testing.expectError(raw.StreamError.Invalid, result);
}

test "Stream - commitReserved with len exceeding reserved returns NoSpace" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(256, 1, false));
    defer stream.destroy();

    const info = try stream.reserve(1);
    const result = stream.commitReserved(info.len + 1);
    try testing.expectError(raw.StreamError.NoSpace, result);
}

test "Stream - commitReserved without active reservation returns Invalid" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(256, 1, false));
    defer stream.destroy();

    const result = stream.commitReserved(0);
    try testing.expectError(raw.StreamError.Invalid, result);
}

test "Stream - reserve with min_len larger than chunk returns NoSpace" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(64, 1, false));
    defer stream.destroy();

    const result = stream.reserve(65);
    try testing.expectError(raw.StreamError.NoSpace, result);
}

test "Stream - empty write is a no-op" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(256, 1, false));
    defer stream.destroy();

    try stream.write("");
    try testing.expectEqual(@as(u64, 0), stream.getStats().bytes_written);
}

test "Stream - commit with no pending data is a no-op" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(256, 1, false));
    defer stream.destroy();

    try stream.commit();
    try testing.expectEqual(@as(u64, 0), stream.getStats().spans_committed);
}

test "Stream - drain with no spans returns zero" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(256, 1, false));
    defer stream.destroy();

    var buf: [16]raw.SpanInfo = undefined;
    const count = stream.drainSpans(&buf);
    try testing.expectEqual(@as(u32, 0), count);
}

test "Stream - close with pending data auto-commits" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(256, 1, false));
    defer stream.destroy();

    try stream.write("pending data");
    try stream.close();

    try testing.expectEqual(@as(u64, 1), stream.getStats().spans_committed);

    const drained = drainAllSpans(stream);
    try testing.expectEqual(@as(u64, 12), drained);
}

test "Stream - setOptions on closed stream returns Invalid" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(256, 1, false));
    defer stream.destroy();

    try stream.close();
    const result = stream.setOptions(testOptions(128, 1, true));
    try testing.expectError(raw.StreamError.Invalid, result);
}

test "Stream - setOptions ignores chunk_size (immutable after creation)" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(64, 1, true));
    defer stream.destroy();

    const fill1 = [_]u8{'A'} ** 64;
    try stream.write(&fill1);

    try stream.setOptions(testOptions(128, 1, true));

    const fill2 = [_]u8{'B'} ** 64;
    try stream.write(&fill2);

    try stream.commit();

    const stats = stream.getStats();
    try testing.expectEqual(@as(u64, 128), stats.bytes_written);

    const drained = drainAllSpans(stream);
    try testing.expectEqual(@as(u64, 128), drained);
}

test "Stream - setOptions enables auto_commit mid-stream" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(64, 2, false));
    defer stream.destroy();

    try stream.write(&([_]u8{'A'} ** 32));
    try testing.expectEqual(@as(u64, 0), stream.getStats().spans_committed);
    try stream.commit();
    try testing.expectEqual(@as(u64, 1), stream.getStats().spans_committed);

    _ = drainAllSpans(stream);
    try stream.setOptions(testOptions(64, 2, true));
    try stream.write(&([_]u8{'B'} ** 64));
    try testing.expectEqual(@as(u64, 2), stream.getStats().spans_committed);

    _ = drainAllSpans(stream);
}

test "Stream - pending data survives failed commit (ring full)" {
    var opts = testOptions(4096, 2, false);
    opts.span_queue_capacity = 2;
    opts.growth_policy = @intFromEnum(raw.GrowthPolicy.block);
    const stream = try raw.Stream.create(testing.allocator, opts);
    defer stream.destroy();

    var i: u32 = 0;
    while (i < 2) : (i += 1) {
        try stream.write("x");
        try stream.commit();
    }

    try stream.write("important");
    const result = stream.commit();
    try testing.expectError(raw.StreamError.NoSpace, result);

    _ = drainAllSpans(stream);
    try stream.commit();

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

test "Stream - close with active reservation returns Busy" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(256, 1, false));
    defer stream.destroy();

    _ = try stream.reserve(1);

    const result = stream.close();
    try testing.expectError(raw.StreamError.Busy, result);

    try testing.expectEqual(false, stream.closed);
    try stream.commitReserved(0);
    try stream.close();
}

test "Stream - destroy without close commits pending data" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(256, 1, false));

    try stream.write("before destroy");

    const stats = stream.getStats();
    try testing.expectEqual(@as(u64, 14), stats.bytes_written);
    try testing.expectEqual(@as(u64, 0), stats.spans_committed);

    stream.destroy();
}

test "Stream - write error mid-loop preserves already-committed spans" {
    const stream = try raw.Stream.create(testing.allocator, testOptionsFull(32, 2, 64, true));
    defer stream.destroy();

    const data = [_]u8{'Z'} ** 96;
    const result = stream.write(&data);
    try testing.expectError(raw.StreamError.MaxBytes, result);

    const stats = stream.getStats();
    try testing.expectEqual(@as(u64, 2), stats.spans_committed);

    const drained = drainAllSpans(stream);
    try testing.expectEqual(@as(u64, 64), drained);
}

test "Stream - bytes_written matches total drained across all operations" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(64, 1, true));
    defer stream.destroy();

    try stream.write("short");
    try stream.commit();
    try stream.write(&([_]u8{'M'} ** 64));
    try stream.write(&([_]u8{'L'} ** 200));

    try stream.commit();

    const stats = stream.getStats();
    const drained = drainAllSpans(stream);

    try testing.expectEqual(stats.bytes_written, drained);
}

var data_available_count: u32 = 0;

fn countingCallback(_: usize, event_id: u32, _: usize, _: u64) callconv(.c) void {
    if (event_id == @intFromEnum(raw.EventId.DataAvailable)) {
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
    const first = [_]u8{'A'} ** 64;
    try stream.write(&first);
    const result = stream.write(&([_]u8{'B'} ** 65));
    try testing.expectError(raw.StreamError.NoSpace, result);
    try testing.expectEqual(@as(u32, 1), data_available_count);
}

test "Stream - hasPendingSpans reflects state correctly" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(256, 1, false));
    defer stream.destroy();

    try testing.expect(!stream.hasPendingSpans());

    try stream.write("data");
    try stream.commit();
    try testing.expect(stream.hasPendingSpans());

    _ = drainAllSpans(stream);
    try testing.expect(!stream.hasPendingSpans());
}

var drain_during_write_stream: ?*raw.Stream = null;
var drain_during_write_total: u64 = 0;

fn drainingCallback(stream_ptr: usize, event_id: u32, _: usize, _: u64) callconv(.c) void {
    if (event_id != @intFromEnum(raw.EventId.DataAvailable)) return;
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

    const data = [_]u8{'D'} ** 256;
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

test "Stream - span ring wrapping near u32 max" {
    // Position near u32 max to exercise wrapping without huge loops.
    const stream = try raw.Stream.create(testing.allocator, testOptions(256, 2, false));
    defer stream.destroy();

    const near_max: u32 = std.math.maxInt(u32) - 5;
    stream.span_ring.head = near_max;
    stream.span_ring.tail = near_max;

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
    try testing.expectEqual(near_max +% 10, stream.span_ring.head);
    try testing.expectEqual(near_max +% 10, stream.span_ring.tail);

    try testing.expectEqualStrings("data", buf[9].slice());
    for (buf[0..count]) |span| {
        stream.markSpanConsumed(span);
    }
}

test "Stream - commitReserved with zero length produces no span" {
    const stream = try raw.Stream.create(testing.allocator, testOptions(256, 1, false));
    defer stream.destroy();

    _ = try stream.reserve(1);
    try stream.commitReserved(0);

    try testing.expectEqual(@as(u64, 0), stream.getStats().spans_committed);
    try testing.expectEqual(@as(u64, 0), stream.getStats().bytes_written);
    try testing.expect(!stream.hasPendingSpans());

    try stream.write("after");
    try stream.commit();

    try testing.expectEqual(@as(u64, 1), stream.getStats().spans_committed);
    try testing.expectEqual(@as(u64, 5), stream.getStats().bytes_written);

    const drained = drainAllSpans(stream);
    try testing.expectEqual(@as(u64, 5), drained);
}

test "Stream - write exactly chunk_size * N with auto_commit commits all, no dangling pending" {
    const chunk_size: u32 = 64;
    const n: usize = 5;
    const total = chunk_size * n;
    const stream = try raw.Stream.create(testing.allocator, testOptions(chunk_size, 2, true));
    defer stream.destroy();

    const data = [_]u8{'E'} ** total;
    try stream.write(&data);

    const stats = stream.getStats();

    try testing.expectEqual(@as(u64, n), stats.spans_committed);
    try testing.expectEqual(@as(u64, total), stats.bytes_written);

    try stream.commit();
    try testing.expectEqual(@as(u64, n), stream.getStats().spans_committed);

    const drained = drainAllSpans(stream);
    try testing.expectEqual(@as(u64, total), drained);
}

test "Stream - state buffer reallocation preserves active span refcounts" {
    const chunk_size: u32 = 64;
    const stream = try raw.Stream.create(testing.allocator, testOptions(chunk_size, 1, false));
    defer stream.destroy();

    const first = [_]u8{'F'} ** 64;
    try stream.write(&first);
    try stream.commit();

    try testing.expectEqual(@as(u8, 1), stream.stateBuffer()[0]);

    var i: usize = 0;
    while (i < 3) : (i += 1) {
        const filler = [_]u8{@intCast(i + 0x10)} ** 64;
        try stream.write(&filler);
        try stream.commit();
    }

    try testing.expect(stream.getStats().chunks >= 4);
    try testing.expectEqual(@as(u8, 1), stream.stateBuffer()[0]);

    const drained = drainAllSpans(stream);
    try testing.expectEqual(@as(u64, 256), drained);

    try testing.expectEqual(@as(u8, 0), stream.stateBuffer()[0]);
}

test "Stream - state_buffer caps at 255 and advances to new chunk" {
    // Refcount saturation should force a new chunk.
    const chunk_size: u32 = 4096;
    const stream = try raw.Stream.create(testing.allocator, testOptions(chunk_size, 1, false));
    defer stream.destroy();

    var i: u32 = 0;
    while (i < 260) : (i += 1) {
        try stream.write("x");
        try stream.commit();
    }

    try testing.expectEqual(@as(u8, 255), stream.stateBuffer()[0]);
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
                try testing.expectEqual(@as(u8, 1), stream.stateBuffer()[0]);
            }
        }
    }

    try testing.expectEqual(@as(u32, 260), drain_count);
    try testing.expectEqual(@as(u8, 0), stream.stateBuffer()[0]);
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

    try testing.expectEqual(@as(u8, 255), stream.stateBuffer()[0]);

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

    try testing.expectEqual(@as(u8, 0), stream.stateBuffer()[0]);
    const overwrite = [_]u8{'Z'} ** 128;
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
        .fail_index = 4,
    });

    const result = raw.Stream.create(failing.allocator(), testOptions(64, 1, false));
    try testing.expectError(raw.StreamError.OutOfMemory, result);
}

test "addChunkLocked must keep state buffer consistent with chunk count" {
    // Invariant: state_capacity must track chunks.items.len.

    var failing = std.testing.FailingAllocator.init(std.heap.page_allocator, .{
        .fail_index = 6,
    });

    const stream = raw.Stream.create(failing.allocator(), testOptions(64, 1, false)) catch
        return error.TestUnexpectedResult;
    defer stream.destroy();

    stream.write(&([_]u8{'A'} ** 64)) catch return error.TestUnexpectedResult;
    stream.commit() catch return error.TestUnexpectedResult;
    const result = stream.write("x");
    try testing.expectError(raw.StreamError.OutOfMemory, result);
    try testing.expect(stream.state_capacity >= stream.chunks.items.len);
}
