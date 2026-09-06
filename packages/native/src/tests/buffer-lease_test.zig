const std = @import("std");
const buffer = @import("../buffer.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");
const ansi = @import("../ansi.zig");
const context = @import("../context.zig");

test "Resolved buffer capture uses the checked Session snapshot pool and exact capacity" {
    const owner = try context.Context.init(std.testing.allocator, std.testing.io, .{
        .object_capacity = 3,
        .render_cells_max = 8,
    });
    defer owner.deinit() catch unreachable;
    const peer = try context.Context.init(std.testing.allocator, std.testing.io, .{});
    defer peer.deinit() catch unreachable;
    const session = try owner.createSession(.{ .chunk_size = 1024 });
    const source = try owner.createBuffer(2, 3, .{});
    const other = try peer.createBuffer(2, 1, .{});
    try owner.attachSessionRenderer(session, 2, 3, .{ .remote_mode = .remote });
    const foreground = ansi.rgbColor(255, 255, 255, 255);
    try owner.drawBufferText(source, "\u{754c}", 0, 0, foreground, null, 0);
    try owner.drawBufferText(source, "e\u{301}a\u{308}", 0, 1, foreground, null, 0);
    try owner.drawBufferText(source, "\u{1f469}\u{200d}\u{1f4bb}", 0, 2, foreground, null, 0);
    try peer.drawBufferText(other, "\u{8a9e}", 0, 0, foreground, null, 0);
    try owner.drawSessionBuffer(session, source, 0, 0);
    try owner.destroy(source);
    const lease = try owner.acquireSessionBufferLease(session, .next);
    defer owner.releaseBufferLease(lease) catch unreachable;
    const snapshot = try owner.bufferLeaseSnapshot(lease);
    try std.testing.expectEqual((try peer.getBuffer(other)).buffer.char[0], snapshot.buffer.char[0]);
    try peer.destroy(other);
    for ([_]bool{ false, true }) |line_breaks| {
        const expected = if (line_breaks)
            "\u{754c}\ne\u{301}a\u{308}\n\u{1f469}\u{200d}\u{1f4bb}\n"
        else
            "\u{754c}e\u{301}a\u{308}\u{1f469}\u{200d}\u{1f4bb}";
        const size = try snapshot.getRealCharSize(line_breaks);
        try std.testing.expectEqual(expected.len, size);
        var output: [64]u8 = undefined;
        for (0..size) |capacity| {
            @memset(&output, 0xaa);
            try std.testing.expectError(error.BufferTooSmall, snapshot.writeResolvedChars(output[0..capacity], line_breaks));
            for (output[capacity..]) |byte| try std.testing.expectEqual(@as(u8, 0xaa), byte);
        }
        const written = try snapshot.writeResolvedChars(output[0..size], line_breaks);
        try std.testing.expectEqual(size, written);
        try std.testing.expectEqualStrings(expected, output[0..written]);
        var lengths: [7]u8 = @splat(255);
        try std.testing.expectError(error.BufferTooSmall, snapshot.writeResolvedCells(&output, line_breaks, lengths[0..5]));
        for (lengths) |length| try std.testing.expectEqual(@as(u8, 255), length);
        try std.testing.expectEqual(written, try snapshot.writeResolvedCells(output[0..size], line_breaks, &lengths));
        try std.testing.expectEqualSlices(u8, &.{ 3, 0, 3, 3, 11, 0, 255 }, &lengths);
        try std.testing.expectEqualStrings(expected, output[0..written]);
    }
    try owner.resizeSessionRenderer(session, 3, 2);
    try std.testing.expectError(error.StaleLease, owner.bufferLeaseSnapshot(lease));
    try std.testing.expectError(error.ContextBusy, owner.deinit());
    const current = try owner.acquireSessionBufferLease(session, .next);
    defer owner.releaseBufferLease(current) catch unreachable;
    const resized = try owner.bufferLeaseSnapshot(current);
    try std.testing.expectEqual(@as(u32, 8), try resized.getRealCharSize(true));
    try owner.destroy(session);
    try std.testing.expectError(error.StaleLease, owner.bufferLeaseSnapshot(current));
}

test "Resolved buffer capture sizes replacement spaces and image fallbacks" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const target = try buffer.OptimizedBuffer.init(std.testing.allocator, 1, 4, .{
        .pool = &pool,
        .link_pool = &links,
    });
    defer target.deinit();
    @memcpy(target.buffer.char, &[_]u32{ 0, 0xd800, 0x110000, gp.packImageCell(1, 15) });
    var lease = try target.acquireLease();
    defer lease.release();
    const snapshot = try lease.snapshot();
    try std.testing.expectEqual(@as(u32, 10), try snapshot.getRealCharSize(true));
    var output: [10]u8 = undefined;
    var lengths: [4]u8 = undefined;
    const written = try snapshot.writeResolvedCells(&output, true, &lengths);
    try std.testing.expectEqualStrings(" \n \n \n\u{2588}\n", output[0..written]);
    try std.testing.expectEqualSlices(u8, &.{ 1, 1, 1, 3 }, &lengths);
}

test "Resolved buffer capture preserves independent cell boundaries and maximum pool entries" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const target = try buffer.OptimizedBuffer.init(std.testing.allocator, 3, 2, .{
        .pool = &pool,
        .link_pool = &links,
    });
    defer target.deinit();
    const foreground = ansi.rgbColor(255, 255, 255, 255);
    try target.drawText("\u{1f1fa}", 0, 0, foreground, null, 0);
    try target.drawText("\u{1f1f8}", 1, 0, foreground, null, 0);
    try target.drawText("Z", 2, 0, foreground, null, 0);
    const maximum = "\u{e9}" ++ "\u{301}" ** 63;
    try std.testing.expectEqual(@as(usize, 128), maximum.len);
    try target.drawText(maximum, 0, 1, foreground, null, 0);
    try target.drawText("\u{754c}", 1, 1, foreground, null, 0);
    var lease = try target.acquireLease();
    defer lease.release();
    const snapshot = try lease.snapshot();
    var output: [140]u8 = undefined;
    var lengths: [6]u8 = undefined;
    const written = try snapshot.writeResolvedCells(&output, false, &lengths);
    try std.testing.expectEqualStrings("\u{1f1fa}\u{1f1f8}Z" ++ maximum ++ "\u{754c}", output[0..written]);
    try std.testing.expectEqualSlices(u8, &.{ 4, 4, 1, 128, 3, 0 }, &lengths);
}

test "Buffer lease resize is transactional at every replacement allocation" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    // The replacement needs one storage header and four arrays.
    for (0..5) |fail_index| {
        var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        const target = try buffer.OptimizedBuffer.init(failing.allocator(), 2, 1, .{
            .pool = &pool,
            .link_pool = &links,
        });
        defer target.deinit();
        const grapheme_id = try pool.alloc("e\xcc\x81");
        const link_id = try links.alloc("https://oom.invalid");
        const cell: buffer.Cell = .{
            .char = gp.packGraphemeStart(grapheme_id, 1),
            .fg = ansi.rgbColor(1, 2, 3, 255),
            .bg = ansi.rgbColor(4, 5, 6, 255),
            .attributes = ansi.TextAttributes.setLinkId(0, link_id),
        };
        target.set(0, 0, cell);
        var lease = try target.acquireLease();
        defer lease.release();
        const before = try lease.snapshot();
        const bytes_before = failing.allocated_bytes - failing.freed_bytes;
        failing.fail_index = failing.alloc_index + fail_index;
        try std.testing.expectError(error.OutOfMemory, target.resize(3, 2));
        try std.testing.expectEqual(bytes_before, failing.allocated_bytes - failing.freed_bytes);
        try std.testing.expectEqualDeep(before, try lease.snapshot());
        try std.testing.expectEqual(lease.storage.?, target.storage);
        try std.testing.expectEqual(@as(u32, 2), target.storage.ref_count);
        try std.testing.expectEqual(@as(u32, 2), target.width);
        try std.testing.expectEqual(@as(u32, 1), target.height);
        try std.testing.expectEqual(target.buffer.char.ptr, before.buffer.char.ptr);
        try std.testing.expectEqual(target.buffer.fg.ptr, before.buffer.fg.ptr);
        try std.testing.expectEqual(target.buffer.bg.ptr, before.buffer.bg.ptr);
        try std.testing.expectEqual(target.buffer.attributes.ptr, before.buffer.attributes.ptr);
        try std.testing.expectEqualDeep(cell, target.get(0, 0).?);
        try std.testing.expectEqual(@as(u32, 1), try pool.getRefcount(grapheme_id));
        try std.testing.expectEqual(@as(u32, 1), try links.getRefcount(link_id));
        failing.fail_index = std.math.maxInt(usize);
        target.set(1, 0, cell);
        try target.resize(3, 2);
        try std.testing.expect(!lease.isCurrent());
        try std.testing.expectEqual(@as(u64, 2), target.storage.generation);
    }
}

test "Buffer lease validates dimensions and acquires without allocation" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    const target = try buffer.OptimizedBuffer.init(failing.allocator(), 1, 1, .{
        .pool = &pool,
        .link_pool = &links,
    });
    defer target.deinit();
    try std.testing.expectEqual(@as(usize, 1), target.buffer.char.len);
    try std.testing.expectEqual(@as(u32, 0), target.buffer.char[0]);
    try std.testing.expectEqual(ansi.rgbColor(0, 0, 0, 0), target.buffer.fg[0]);
    try std.testing.expectEqual(ansi.rgbColor(0, 0, 0, 0), target.buffer.bg[0]);
    try std.testing.expectEqual(@as(u32, 0), target.buffer.attributes[0]);
    failing.fail_index = failing.alloc_index;
    var lease = try target.acquireLease();
    defer lease.release();
    const before = try lease.snapshot();
    try target.resize(1, 1);
    try std.testing.expectEqualDeep(before, try lease.snapshot());
    try std.testing.expect(!failing.has_induced_failure);
    for ([_][2]u32{
        .{ 0, 0 },                                       .{ 0, 1 },                    .{ 1, 0 },
        .{ 65536, 65536 },                               .{ std.math.maxInt(u32), 2 }, .{ 2, std.math.maxInt(u32) },
        .{ std.math.maxInt(u32), std.math.maxInt(u32) },
    }) |dimensions| {
        try std.testing.expectError(error.InvalidDimensions, buffer.OptimizedBuffer.init(
            std.testing.failing_allocator,
            dimensions[0],
            dimensions[1],
            .{ .pool = &pool, .link_pool = &links },
        ));
        try std.testing.expectError(error.InvalidDimensions, target.resize(dimensions[0], dimensions[1]));
        try std.testing.expectEqualDeep(before, try lease.snapshot());
    }
    for ([_][2]u32{
        .{ 1, std.math.maxInt(u32) }, .{ std.math.maxInt(u32), 1 }, .{ 65535, 65537 },
    }) |dimensions| {
        try std.testing.expectError(error.OutOfMemory, buffer.OptimizedBuffer.init(
            std.testing.failing_allocator,
            dimensions[0],
            dimensions[1],
            .{ .pool = &pool, .link_pool = &links },
        ));
    }
    try std.testing.expect(!failing.has_induced_failure);
    lease.release();
    try std.testing.expectEqual(@as(u32, 1), target.storage.ref_count);
    target.storage.ref_count = std.math.maxInt(u32);
    defer target.storage.ref_count = 1;
    try std.testing.expectError(error.LeaseLimitExceeded, target.acquireLease());
    try std.testing.expectEqual(std.math.maxInt(u32), target.storage.ref_count);
}
