const std = @import("std");
const context = @import("../context.zig");
const buffer = @import("../buffer.zig");
const gp = @import("../grapheme.zig");
const LinkTracker = @import("../link.zig").LinkTracker;
const ansi = @import("../ansi.zig");

test "Context Session lease keeps both planes under one renderer owner during presentation" {
    const owner = try context.Context.init(std.testing.allocator, std.testing.io, .{ .object_capacity = 4 });
    defer owner.deinit() catch unreachable;
    const session = try owner.createSession(.{ .chunk_size = 1024 });
    defer owner.cancelSession(session) catch unreachable;
    try std.testing.expectError(error.RendererNotAttached, owner.acquireSessionBufferLease(session, .next));
    try owner.attachSessionRenderer(session, 4, 1, .{ .remote_mode = .remote });
    const next = try owner.acquireSessionBufferLease(session, .next);
    defer owner.releaseBufferLease(next) catch unreachable;
    const current = try owner.acquireSessionBufferLease(session, .current);
    defer owner.releaseBufferLease(current) catch unreachable;
    try std.testing.expectEqual(3, owner.objects.live_count);
    const draw = try owner.bufferLeaseSnapshot(next);
    const comparison = try owner.bufferLeaseSnapshot(current);
    draw.buffer.char[0] = 'T';
    try std.testing.expect(comparison.buffer.char.ptr != draw.buffer.char.ptr);
    try std.testing.expectEqual(.pending, try owner.renderSession(session, true));
    for ([_]context.RendererBuffer{ .current, .next }) |which| {
        try std.testing.expectError(error.PresentationPending, owner.acquireSessionBufferLease(session, which));
    }
    // Encoding changes both planes before presentation, without retiring storage.
    try std.testing.expectEqualDeep(draw, try owner.bufferLeaseSnapshot(next));
    try std.testing.expectEqual(buffer.DEFAULT_SPACE_CHAR, draw.buffer.char[0]);
    try std.testing.expectEqual(@as(u32, 'T'), comparison.buffer.char[0]);
    try std.testing.expectEqual(2, owner.lease_count);
}

test "Context Session lease rejects terminal transitions and cancelled sessions" {
    const owner = try context.Context.init(std.testing.allocator, std.testing.io, .{ .object_capacity = 2 });
    defer owner.deinit() catch unreachable;
    const session = try owner.createSession(.{ .chunk_size = 4096, .control_capacity = 4096 });
    defer owner.cancelSession(session) catch unreachable;
    try owner.attachSessionRenderer(session, 1, 1, .{ .remote_mode = .remote });
    try owner.setupSessionTerminal(session, .{});
    try std.testing.expectError(error.TerminalInactive, owner.acquireSessionBufferLease(session, .next));
    try owner.cancelSession(session);
    try std.testing.expectError(error.SessionCancelled, owner.acquireSessionBufferLease(session, .current));
    try std.testing.expectEqual(0, owner.lease_count);
}

test "Context link retirement preserves all slots on destroy and final lease release" {
    for ([_]bool{ false, true }) |leased| {
        var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        const owner = try context.Context.init(std.testing.allocator, std.testing.io, .{ .object_capacity = 2 });
        var alive = true;
        defer if (alive) owner.deinit() catch unreachable;
        owner.links.allocator = failing.allocator();
        const first_id = try owner.links.acquire("https://retirement.invalid/first");
        const link_count: u32 = @intCast(owner.links.free_list.capacity + 1);
        const renderer = try owner.createSession(.{});
        try owner.attachSessionRenderer(renderer, link_count, 1, .{ .remote_mode = .remote });
        const target = (try owner.raw().getSessionRenderer(renderer)).getNextBuffer();
        for (0..link_count) |index| {
            var url: [64]u8 = undefined;
            const id = if (index == 0) first_id else try owner.links.acquire(
                try std.fmt.bufPrint(&url, "https://retirement.invalid/{d}", .{index}),
            );
            target.set(@intCast(index), 0, .{
                .char = 'A',
                .fg = ansi.rgbColor(255, 255, 255, 255),
                .bg = ansi.rgbColor(0, 0, 0, 255),
                .attributes = ansi.TextAttributes.setLinkId(0, id),
            });
            try owner.links.decref(id);
        }
        const num_slots = owner.links.num_slots;
        try std.testing.expect(num_slots > owner.links.slots_per_page);
        try std.testing.expectEqual(link_count, target.link_tracker.getLinkCount());
        try std.testing.expectEqual(link_count, owner.links.interned_live_ids.count());
        try std.testing.expectEqual(num_slots - link_count, owner.links.getFreeSlotCount());
        var lease = if (leased) try owner.acquireSessionBufferLease(renderer, .next) else null;
        defer if (lease) |handle| owner.releaseBufferLease(handle) catch unreachable;
        const alloc_index = failing.alloc_index;
        const resize_index = failing.resize_index;
        failing.fail_index = alloc_index;
        failing.resize_fail_index = resize_index;
        try owner.destroy(renderer);
        if (lease) |handle| {
            try std.testing.expectError(error.StaleLease, owner.bufferLeaseSnapshot(handle));
            try std.testing.expectEqual(link_count, owner.links.getLiveSlotCount());
            try std.testing.expectEqual(link_count, owner.links.interned_live_ids.count());
            try owner.releaseBufferLease(handle);
            lease = null;
        }
        try std.testing.expectEqual(num_slots, owner.links.getFreeSlotCount());
        try std.testing.expectEqual(@as(u64, 0), owner.links.getLiveSlotCount());
        try std.testing.expectEqual(@as(u32, 0), owner.links.interned_live_ids.count());
        try std.testing.expectEqual(@as(u32, 0), try owner.links.getRefcount(first_id));
        try std.testing.expectEqual(alloc_index, failing.alloc_index);
        try std.testing.expectEqual(resize_index, failing.resize_index);
        try std.testing.expect(!failing.has_induced_failure);

        failing.fail_index = std.math.maxInt(usize);
        failing.resize_fail_index = std.math.maxInt(usize);
        {
            var recovered = LinkTracker.init(std.testing.allocator, &owner.links);
            defer recovered.deinit();
            for (0..num_slots) |index| {
                var url: [64]u8 = undefined;
                const id = try owner.links.acquire(try std.fmt.bufPrint(&url, "https://recovery.invalid/{d}", .{index}));
                recovered.addCellRef(id);
                try owner.links.decref(id);
            }
            try std.testing.expectEqual(num_slots, owner.links.num_slots);
            try std.testing.expectEqual(@as(u64, 0), owner.links.getFreeSlotCount());
            try std.testing.expectEqual(num_slots, owner.links.interned_live_ids.count());
            failing.fail_index = failing.alloc_index;
            failing.resize_fail_index = failing.resize_index;
            recovered.clear();
            try std.testing.expectEqual(num_slots, owner.links.getFreeSlotCount());
            try std.testing.expectEqual(@as(u64, 0), owner.links.getLiveSlotCount());
            try std.testing.expectEqual(@as(u32, 0), owner.links.interned_live_ids.count());
            try std.testing.expect(!failing.has_induced_failure);
        }
        try owner.deinit();
        alive = false;
        try std.testing.expectEqual(failing.allocated_bytes, failing.freed_bytes);
    }
}

test "Context lease charges distinct current and retired storage once and enforces limits" {
    const owner = try context.Context.init(std.testing.allocator, std.testing.io, .{
        .object_capacity = 4,
        .lease_count_max = 2,
        .render_cells_max = 4,
    });
    defer owner.deinit() catch unreachable;
    const renderer = try owner.createSession(.{});
    try owner.attachSessionRenderer(renderer, 2, 1, .{ .remote_mode = .remote });
    const value = try owner.raw().getSessionRenderer(renderer);
    const first = try owner.acquireSessionBufferLease(renderer, .next);
    const bytes = owner.lease_bytes;
    try std.testing.expectEqual(value.getNextBuffer().storage.retained_bytes, bytes);
    owner.lease_bytes_max = bytes;
    const second = try owner.acquireSessionBufferLease(renderer, .next);
    try std.testing.expectEqual(bytes, owner.lease_bytes);
    try std.testing.expectError(error.LeaseLimit, owner.acquireSessionBufferLease(renderer, .next));
    const snapshot = try owner.bufferLeaseSnapshot(first);
    for ([_][2]u32{ .{ 0, 1 }, .{ 1, 0 }, .{ 5, 1 }, .{ 65536, 65536 } }) |dimensions| {
        try std.testing.expectError(error.InvalidDimensions, owner.resizeSessionRenderer(renderer, dimensions[0], dimensions[1]));
        try std.testing.expectEqualDeep(snapshot, try owner.bufferLeaseSnapshot(first));
    }
    try owner.releaseBufferLease(first);
    try std.testing.expectEqual(bytes, owner.lease_bytes);
    try std.testing.expectError(error.LeaseBytesLimit, owner.acquireSessionBufferLease(renderer, .current));
    try std.testing.expectEqualDeep(snapshot, try owner.bufferLeaseSnapshot(second));
    try owner.resizeSessionRenderer(renderer, 4, 1);
    try std.testing.expectEqual(bytes, owner.lease_bytes);
    try std.testing.expectError(error.LeaseBytesLimit, owner.acquireSessionBufferLease(renderer, .next));
    try std.testing.expectEqual(@as(u32, 1), owner.lease_count);
    try owner.releaseBufferLease(second);
    try std.testing.expectEqual(@as(u64, 0), owner.lease_bytes);
    owner.lease_bytes_max = std.math.maxInt(u64);
    const replacement = try owner.acquireSessionBufferLease(renderer, .next);
    try std.testing.expectEqual(value.getNextBuffer().storage.retained_bytes, owner.lease_bytes);
    try owner.destroy(replacement);
    try std.testing.expectEqual(@as(u64, 0), owner.lease_bytes);
    try std.testing.expectEqual(@as(u32, 0), owner.lease_count);
}

test "Context lease accounts for future tracker growth before admitting storage" {
    var counter = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    const owner = try context.Context.init(counter.allocator(), std.testing.io, .{ .object_capacity = 3 });
    defer owner.deinit() catch unreachable;
    const renderer = try owner.createSession(.{});
    try owner.attachSessionRenderer(renderer, 32, 1, .{ .remote_mode = .remote });
    const target = (try owner.raw().getSessionRenderer(renderer)).getNextBuffer();
    const empty_bytes = target.storage.retained_bytes;
    owner.lease_bytes_max = empty_bytes;
    try std.testing.expectError(error.LeaseBytesLimit, owner.acquireSessionBufferLease(renderer, .next));
    try std.testing.expectEqual(@as(u32, 0), owner.lease_count);
    try std.testing.expectEqual(@as(u32, 1), owner.objects.live_count);
    try std.testing.expectEqual(@as(u32, 1), target.storage.ref_count);
    try std.testing.expectEqual(@as(u64, 0), owner.lease_bytes);
    try std.testing.expect(target.storage.retained_bytes > empty_bytes);

    owner.lease_bytes_max = target.storage.retained_bytes;
    counter.fail_index = counter.alloc_index;
    const lease = try owner.acquireSessionBufferLease(renderer, .next);
    defer owner.releaseBufferLease(lease) catch unreachable;
    try std.testing.expect(!counter.has_induced_failure);
    counter.fail_index = std.math.maxInt(usize);
    const bytes = owner.lease_bytes;
    var ids: [33]u32 = undefined;
    var links: [33]u32 = undefined;
    for (&ids, &links, 0..) |*id, *link, index| {
        var text: [32]u8 = undefined;
        id.* = try owner.graphemes.acquire(try std.fmt.bufPrint(&text, "g{d}", .{index}));
        link.* = try owner.links.acquire(try std.fmt.bufPrint(&text, "https://lease.invalid/{d}", .{index}));
    }
    defer for (ids) |id| owner.graphemes.decref(id) catch unreachable;
    defer for (links) |link| owner.links.decref(link) catch unreachable;
    const allocated_before = counter.allocated_bytes;
    counter.fail_index = counter.alloc_index;
    defer counter.fail_index = std.math.maxInt(usize);
    // Replacing one of 32 distinct IDs needs a transient 33rd tracker entry.
    for (ids, links, 0..) |id, link, index| {
        target.set(@intCast(index % 32), 0, .{
            .char = gp.packGraphemeStart(id, 1),
            .fg = ansi.rgbColor(255, 255, 255, 255),
            .bg = ansi.rgbColor(0, 0, 0, 255),
            .attributes = ansi.TextAttributes.setLinkId(0, link),
        });
    }
    try std.testing.expectEqual(allocated_before, counter.allocated_bytes);
    try std.testing.expect(!counter.has_induced_failure);
    try std.testing.expectEqual(bytes, target.storage.retained_bytes);
    try std.testing.expectEqual(bytes, owner.lease_bytes);
    const snapshot = try owner.bufferLeaseSnapshot(lease);
    try std.testing.expectEqual(gp.packGraphemeStart(ids[32], 1), snapshot.buffer.char[0]);
}

test "Context leases charge each leased storage once through seeded resize, draw, and destroy" {
    const Handle = @import("../context-handles.zig").Handle;
    const glyphs = [_][]const u8{ "a", "\u{4e2d}", "e\u{301}", "\u{1f31f}", "\u{1f1fa}\u{1f1f8}" };
    const cell_bytes = 2 * @sizeOf(u32) + 2 * @sizeOf(buffer.RGBA);
    for ([_]u64{ 1, 2, 3, 4, 5, 6 }) |seed| {
        errdefer std.debug.print("seed={d}\n", .{seed});
        var prng = std.Random.DefaultPrng.init(seed);
        const random = prng.random();
        const owner = try context.Context.init(std.testing.allocator, std.testing.io, .{
            .object_capacity = 16,
            .render_cells_max = 48,
            .lease_count_max = 5,
        });
        defer owner.deinit() catch unreachable;
        var buffers: [3]?Handle = @splat(null);
        const Lease = struct { handle: Handle, storage: *buffer.BufferStorage, buffer: usize };
        var leases: [5]Lease = undefined;
        var lease_count: usize = 0;
        defer for (leases[0..lease_count]) |lease| owner.releaseBufferLease(lease.handle) catch unreachable;
        var text: [64]u8 = undefined;

        for (0..300) |_| {
            const slot = random.uintLessThan(usize, buffers.len);
            const width = random.intRangeAtMost(u32, 1, 8);
            const height = random.intRangeAtMost(u32, 1, 8);
            switch (random.uintLessThan(u8, 7)) {
                0 => if (buffers[slot] == null) {
                    buffers[slot] = owner.createBuffer(width, height, .{}) catch |err| blk: {
                        try std.testing.expectEqual(error.InvalidDimensions, err);
                        try std.testing.expect(width * height > 48);
                        break :blk null;
                    };
                },
                1 => if (buffers[slot]) |handle| {
                    try owner.destroy(handle);
                    buffers[slot] = null;
                },
                2 => if (buffers[slot]) |handle| {
                    owner.resizeBuffer(handle, width, height) catch |err| {
                        try std.testing.expectEqual(error.InvalidDimensions, err);
                        try std.testing.expect(width * height > 48);
                    };
                },
                3 => if (buffers[slot]) |handle| {
                    if (owner.acquireOwnedBufferLease(handle)) |lease| {
                        leases[lease_count] = .{ .handle = lease, .storage = try owner.objects.get(lease, .buffer_lease, buffer.BufferStorage), .buffer = slot };
                        lease_count += 1;
                    } else |err| {
                        try std.testing.expectEqual(error.LeaseLimit, err);
                        try std.testing.expectEqual(leases.len, lease_count);
                    }
                },
                4 => if (lease_count != 0) {
                    const index = random.uintLessThan(usize, lease_count);
                    try owner.releaseBufferLease(leases[index].handle);
                    lease_count -= 1;
                    leases[index] = leases[lease_count];
                },
                5 => if (buffers[slot]) |handle| {
                    var length: usize = 0;
                    for (0..random.uintLessThan(usize, 8)) |_| {
                        const glyph = glyphs[random.uintLessThan(usize, glyphs.len)];
                        @memcpy(text[length..][0..glyph.len], glyph);
                        length += glyph.len;
                    }
                    const fg = ansi.rgbColor(255, 255, 255, 255);
                    try owner.drawBufferText(handle, text[0..length], random.intRangeAtMost(i32, -2, 8), random.intRangeAtMost(i32, 0, 8), fg, null, 0);
                },
                6 => if (buffers[slot]) |handle| try owner.clearBuffer(handle, ansi.rgbColor(0, 0, 0, 255)),
                else => unreachable,
            }

            // The Context charges every distinct leased storage once, current or retired.
            var expected_bytes: u64 = 0;
            for (leases[0..lease_count], 0..) |lease, index| {
                const first = for (leases[0..index]) |earlier| {
                    if (earlier.storage == lease.storage) break false;
                } else true;
                if (first) expected_bytes += lease.storage.retained_bytes;
                const current = if (buffers[lease.buffer]) |handle| (try owner.raw().getBuffer(handle)).storage == lease.storage else false;
                if (current) {
                    _ = try owner.bufferLeaseSnapshot(lease.handle);
                } else {
                    try std.testing.expectError(error.StaleLease, owner.bufferLeaseSnapshot(lease.handle));
                }
            }
            try std.testing.expectEqual(@as(u32, @intCast(lease_count)), owner.lease_count);
            try std.testing.expectEqual(expected_bytes, owner.lease_bytes);
            // Storage keeps at most half again its cells, and an unleased resize retains only its arrays.
            for (buffers) |maybe| {
                const target = try owner.raw().getBuffer(maybe orelse continue);
                const cells = target.width * target.height;
                try std.testing.expectEqual(cells, @as(u32, @intCast(target.buffer.char.len)));
                try std.testing.expect(cells <= target.storage.capacity and target.storage.capacity <= cells + cells / 2);
                if (target.storage.lease_budget == null and target.grapheme_tracker.used_ids.capacity() == 0 and
                    target.link_tracker.used_ids.capacity() == 0 and target.image_placements.capacity == 0)
                {
                    try std.testing.expectEqual(@sizeOf(buffer.BufferStorage) + @as(u64, target.storage.capacity) * cell_bytes, target.storage.retained_bytes);
                }
            }
        }
        for (leases[0..lease_count]) |lease| try owner.releaseBufferLease(lease.handle);
        lease_count = 0;
        try std.testing.expectEqual(@as(u64, 0), owner.lease_bytes);
        try std.testing.expectEqual(@as(u32, 0), owner.lease_count);
    }
}

fn leaseWithAllocationFailures(allocator: std.mem.Allocator) !void {
    const owner = try context.Context.init(allocator, std.testing.io, .{ .object_capacity = 4 });
    defer owner.deinit() catch unreachable;
    const handle = try owner.createSession(.{ .chunk_size = 64 });
    try owner.attachSessionRenderer(handle, 2, 1, .{ .remote_mode = .remote });
    const first = try owner.acquireSessionBufferLease(handle, .next);
    defer owner.releaseBufferLease(first) catch unreachable;
    const second = try owner.acquireSessionBufferLease(handle, .next);
    defer owner.releaseBufferLease(second) catch unreachable;
    try owner.resizeSessionRenderer(handle, 4, 2);
    const current = try owner.acquireSessionBufferLease(handle, .current);
    defer owner.releaseBufferLease(current) catch unreachable;
    try owner.destroy(handle);
}

test "Context lease allocation failures clean up ownership and preserve resize snapshots" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, leaseWithAllocationFailures, .{});
    // Two storage headers, eight arrays, then two hit grids precede resize commit.
    for (0..12) |fail_index| {
        var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        const owner = try context.Context.init(failing.allocator(), std.testing.io, .{ .object_capacity = 3 });
        defer owner.deinit() catch unreachable;
        const renderer = try owner.createSession(.{});
        try owner.attachSessionRenderer(renderer, 2, 1, .{ .remote_mode = .remote });
        const current = try owner.acquireSessionBufferLease(renderer, .current);
        defer owner.releaseBufferLease(current) catch unreachable;
        const next = try owner.acquireSessionBufferLease(renderer, .next);
        defer owner.releaseBufferLease(next) catch unreachable;
        const before_current = try owner.bufferLeaseSnapshot(current);
        const before_next = try owner.bufferLeaseSnapshot(next);
        const bytes = failing.allocated_bytes - failing.freed_bytes;
        const leased_bytes = owner.lease_bytes;
        failing.fail_index = failing.alloc_index + fail_index;
        try std.testing.expectError(error.OutOfMemory, owner.resizeSessionRenderer(renderer, 4, 2));
        try std.testing.expectEqual(bytes, failing.allocated_bytes - failing.freed_bytes);
        try std.testing.expectEqual(leased_bytes, owner.lease_bytes);
        try std.testing.expectEqualDeep(before_current, try owner.bufferLeaseSnapshot(current));
        try std.testing.expectEqualDeep(before_next, try owner.bufferLeaseSnapshot(next));
        failing.fail_index = std.math.maxInt(usize);
        try owner.resizeSessionRenderer(renderer, 4, 2);
        try std.testing.expectError(error.StaleLease, owner.bufferLeaseSnapshot(current));
        try std.testing.expectError(error.StaleLease, owner.bufferLeaseSnapshot(next));
    }
}
