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

test "Context lease pins stale generations through renderer resize, destroy, and slot reuse" {
    const owner = try context.Context.init(std.testing.allocator, std.testing.io, .{ .object_capacity = 5 });
    defer owner.deinit() catch unreachable;
    const renderer = try owner.createSession(.{});
    try owner.attachSessionRenderer(renderer, 2, 1, .{ .remote_mode = .remote });
    const target = (try owner.getSessionRenderer(renderer)).getNextBuffer();
    const grapheme_id = try owner.graphemes.alloc("e\xcc\x81");
    const link_id = try owner.links.alloc("https://lease.invalid");
    target.set(0, 0, .{
        .char = gp.packGraphemeStart(grapheme_id, 2),
        .fg = ansi.rgbColor(1, 2, 3, 255),
        .bg = ansi.rgbColor(4, 5, 6, 255),
        .attributes = ansi.TextAttributes.setLinkId(0, link_id),
    });
    const first = try owner.acquireSessionBufferLease(renderer, .next);
    defer owner.releaseBufferLease(first) catch unreachable;
    const second = try owner.acquireSessionBufferLease(renderer, .next);
    const before = try owner.bufferLeaseSnapshot(first);
    const pinned_bytes = owner.lease_bytes;
    try std.testing.expectEqualDeep(before, try owner.bufferLeaseSnapshot(second));
    try owner.resizeSessionRenderer(renderer, 2, 1);
    try std.testing.expectEqualDeep(before, try owner.bufferLeaseSnapshot(first));
    try owner.resizeSessionRenderer(renderer, 3, 1);
    try std.testing.expectError(error.StaleLease, owner.bufferLeaseSnapshot(first));
    try std.testing.expectError(error.StaleLease, owner.bufferLeaseSnapshot(second));
    const current = try owner.acquireSessionBufferLease(renderer, .next);
    defer owner.releaseBufferLease(current) catch unreachable;
    const after = try owner.bufferLeaseSnapshot(current);
    try std.testing.expectEqual(before.generation + 1, after.generation);
    try std.testing.expect(before.buffer.char.ptr != after.buffer.char.ptr);
    try std.testing.expectEqual(@as(u32, 3), after.width);
    try std.testing.expect(owner.lease_bytes > pinned_bytes);
    try owner.releaseBufferLease(second);
    try owner.destroy(renderer);
    try std.testing.expectError(error.StaleLease, owner.bufferLeaseSnapshot(current));
    try std.testing.expectError(error.StaleHandle, owner.acquireSessionBufferLease(renderer, .next));
    const replacement = try owner.createSession(.{});
    try owner.attachSessionRenderer(replacement, 2, 1, .{ .remote_mode = .remote });
    try std.testing.expectEqual(renderer.slot, replacement.slot);
    try std.testing.expect(renderer.generation != replacement.generation);
    try std.testing.expectError(error.StaleLease, owner.bufferLeaseSnapshot(first));
    try std.testing.expectError(error.StaleLease, owner.bufferLeaseSnapshot(current));
    try std.testing.expectEqual(gp.packGraphemeStart(grapheme_id, 2), before.buffer.char[0]);
    try std.testing.expect(gp.isContinuationChar(before.buffer.char[1]));
    try std.testing.expectEqual(ansi.rgbColor(1, 2, 3, 255), before.buffer.fg[0]);
    try std.testing.expectEqual(ansi.rgbColor(4, 5, 6, 255), before.buffer.bg[0]);
    try std.testing.expectEqual(link_id, ansi.TextAttributes.getLinkId(before.buffer.attributes[0]));
    try std.testing.expectEqualStrings("e\xcc\x81", try owner.graphemes.get(grapheme_id));
    try std.testing.expectEqualStrings("https://lease.invalid", try owner.links.get(link_id));
    try std.testing.expectEqual(buffer.DEFAULT_SPACE_CHAR, after.buffer.char[0]);
}

test "Context link retirement preserves all slots on destroy and final lease release" {
    for ([_]bool{ false, true }) |leased| {
        var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        const owner = try context.Context.init(std.testing.allocator, std.testing.io, .{ .object_capacity = 2 });
        var alive = true;
        defer if (alive) owner.deinit() catch unreachable;
        owner.links.allocator = failing.allocator();
        const first_id = try owner.links.alloc("https://retirement.invalid/first");
        const link_count: u32 = @intCast(owner.links.free_list.capacity + 1);
        const renderer = try owner.createSession(.{});
        try owner.attachSessionRenderer(renderer, link_count, 1, .{ .remote_mode = .remote });
        const target = (try owner.getSessionRenderer(renderer)).getNextBuffer();
        for (0..link_count) |index| {
            var url: [64]u8 = undefined;
            const id = if (index == 0) first_id else try owner.links.alloc(
                try std.fmt.bufPrint(&url, "https://retirement.invalid/{d}", .{index}),
            );
            target.set(@intCast(index), 0, .{
                .char = 'A',
                .fg = ansi.rgbColor(255, 255, 255, 255),
                .bg = ansi.rgbColor(0, 0, 0, 255),
                .attributes = ansi.TextAttributes.setLinkId(0, id),
            });
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
                const id = try owner.links.alloc(try std.fmt.bufPrint(&url, "https://recovery.invalid/{d}", .{index}));
                recovered.addCellRef(id);
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
    const value = try owner.getSessionRenderer(renderer);
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

test "Context lease checked counts ignore raw leases and release order" {
    const Lifetime = enum { current, resized, destroyed };
    for ([_]Lifetime{ .current, .resized, .destroyed }) |lifetime| {
        for ([_]bool{ false, true }) |raw_first| {
            const owner = try context.Context.init(std.testing.allocator, std.testing.io, .{ .object_capacity = 3 });
            defer owner.deinit() catch unreachable;
            const renderer = try owner.createSession(.{});
            try owner.attachSessionRenderer(renderer, 1, 1, .{ .remote_mode = .remote });
            const target = (try owner.getSessionRenderer(renderer)).getNextBuffer();
            var raw = try target.acquireLease();
            defer raw.release();
            const storage = raw.storage.?;
            const snapshot = try raw.snapshot();
            snapshot.buffer.char[0] = 'A';
            const leases = [_]context.Handle{
                try owner.acquireSessionBufferLease(renderer, .next),
                try owner.acquireSessionBufferLease(renderer, .next),
            };
            const bytes = owner.lease_bytes;
            try std.testing.expectEqual(@as(u32, 4), storage.ref_count);
            try std.testing.expectEqual(@as(u32, 2), storage.lease_budget.?.checked_ref_count);
            switch (lifetime) {
                .current => {},
                .resized => try owner.resizeSessionRenderer(renderer, 2, 1),
                .destroyed => try owner.destroy(renderer),
            }
            if (raw_first) raw.release();
            try std.testing.expectEqual(@as(u32, 2), storage.lease_budget.?.checked_ref_count);
            const order: [2]usize = if (raw_first) .{ 1, 0 } else .{ 0, 1 };
            try owner.releaseBufferLease(leases[order[0]]);
            try std.testing.expectEqual(@as(u32, 1), storage.lease_budget.?.checked_ref_count);
            try std.testing.expectEqual(bytes, owner.lease_bytes);
            if (lifetime == .current) {
                _ = try owner.bufferLeaseSnapshot(leases[order[1]]);
            } else {
                try std.testing.expectError(error.StaleLease, owner.bufferLeaseSnapshot(leases[order[1]]));
            }
            try owner.releaseBufferLease(leases[order[1]]);
            try std.testing.expectEqual(@as(u32, 0), owner.lease_count);
            try std.testing.expectEqual(@as(u64, 0), owner.lease_bytes);
            if (lifetime == .current or !raw_first) {
                try std.testing.expect(storage.lease_budget == null);
            }
            if (!raw_first) {
                try std.testing.expectEqual(@as(u32, 'A'), snapshot.buffer.char[0]);
                try std.testing.expectEqual(@as(u32, if (lifetime == .current) 2 else 1), storage.ref_count);
            }
            if (lifetime == .current) {
                const replacement = try owner.acquireSessionBufferLease(renderer, .next);
                try std.testing.expectEqual(@as(u32, 1), storage.lease_budget.?.checked_ref_count);
                try std.testing.expectEqual(bytes, owner.lease_bytes);
                try owner.releaseBufferLease(replacement);
            }
            // Raw borrowers remain the caller's responsibility after the last
            // checked release; release them before the context frees its pools.
            raw.release();
        }
    }
}

test "Context lease accounts for future tracker growth before admitting storage" {
    var counter = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    const owner = try context.Context.init(counter.allocator(), std.testing.io, .{ .object_capacity = 3 });
    defer owner.deinit() catch unreachable;
    const renderer = try owner.createSession(.{});
    try owner.attachSessionRenderer(renderer, 32, 1, .{ .remote_mode = .remote });
    const target = (try owner.getSessionRenderer(renderer)).getNextBuffer();
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
        id.* = try owner.graphemes.alloc(try std.fmt.bufPrint(&text, "g{d}", .{index}));
        try owner.graphemes.incref(id.*);
        link.* = try owner.links.alloc(try std.fmt.bufPrint(&text, "https://lease.invalid/{d}", .{index}));
        try owner.links.incref(link.*);
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
