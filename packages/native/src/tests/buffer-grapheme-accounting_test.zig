const std = @import("std");
const buffer = @import("../buffer.zig");
const context = @import("../context.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");
const ansi = @import("../ansi.zig");

fn expectTrackedStarts(target: *const buffer.OptimizedBuffer) !void {
    for (target.buffer.char) |char| {
        if (!gp.isGraphemeChar(char)) continue;
        try std.testing.expect(target.grapheme_tracker.contains(gp.graphemeIdFromChar(char)));
    }
    var entries = target.grapheme_tracker.used_ids.iterator();
    while (entries.next()) |entry| {
        var count: u32 = 0;
        for (target.buffer.char) |char| {
            if (gp.isGraphemeChar(char) and gp.graphemeIdFromChar(char) == entry.key_ptr.*) {
                count += 1;
            }
        }
        try std.testing.expectEqual(count, entry.value_ptr.*);
    }
}

test "grapheme accounting - renderer narrow wide cycles stay within leased tracker budget" {
    const owner = try context.Context.init(std.testing.allocator, std.testing.io, .{
        .object_capacity = 3,
    });
    defer owner.deinit() catch unreachable;
    const renderer = try owner.createSession(.{ .chunk_size = 4096 });
    try owner.attachSessionRenderer(renderer, 2, 1, .{ .remote_mode = .remote });
    const value = try owner.getSessionRenderer(renderer);
    var output: [4096]u8 = undefined;
    const current = value.getCurrentBuffer();
    const next = value.getNextBuffer();
    const fg = ansi.rgbColor(255, 255, 255, 255);
    const bg = ansi.rgbColor(0, 0, 0, 255);
    const link_id = try owner.links.alloc("https://grapheme.invalid");
    try owner.links.incref(link_id);
    defer owner.links.decref(link_id) catch unreachable;
    const attributes = ansi.TextAttributes.setLinkId(0, link_id);

    var retained_id: u32 = undefined;
    {
        const current_lease = try owner.acquireSessionBufferLease(renderer, .current);
        defer owner.releaseBufferLease(current_lease) catch unreachable;
        const next_lease = try owner.acquireSessionBufferLease(renderer, .next);
        defer owner.releaseBufferLease(next_lease) catch unreachable;
        const snapshot = try owner.bufferLeaseSnapshot(current_lease);
        const bytes = owner.lease_bytes;
        owner.lease_bytes_max = bytes;

        for (0..32) |cycle| {
            const narrow = [_]u8{ @as(u8, @intCast(cycle % 26)) + 'a', 0xcc, 0x81 };
            try next.drawText(&narrow, 1, 0, fg, bg, attributes);
            try expectTrackedStarts(next);
            const narrow_id = gp.graphemeIdFromChar(next.buffer.char[1]);
            try std.testing.expectEqual(.pending, try owner.renderSession(renderer, false));
            while (try owner.readOutput(renderer, &output)) |ticket| try owner.completeOutput(renderer, ticket, .written);
            try expectTrackedStarts(current);
            try std.testing.expectEqual(@as(u32, 1), try owner.graphemes.getRefcount(narrow_id));

            try next.drawText("\xf0\x9f\x98\x80", 0, 0, fg, bg, attributes);
            try expectTrackedStarts(next);
            const wide_id = gp.graphemeIdFromChar(next.buffer.char[0]);
            try std.testing.expectEqual(.pending, try owner.renderSession(renderer, false));
            while (try owner.readOutput(renderer, &output)) |ticket| try owner.completeOutput(renderer, ticket, .written);
            try expectTrackedStarts(current);
            try std.testing.expectError(error.InvalidId, owner.graphemes.getRefcount(narrow_id));
            try std.testing.expectEqual(@as(u32, 1), try owner.graphemes.getRefcount(wide_id));
            try std.testing.expectEqual(@as(u32, 2), current.link_tracker.used_ids.get(link_id).?);
            try std.testing.expectEqual(@as(u32, 2), try owner.links.getRefcount(link_id));
            try std.testing.expectEqual(bytes, owner.lease_bytes);
            try std.testing.expectEqual(gp.packGraphemeStart(wide_id, 2), snapshot.buffer.char[0]);
            try std.testing.expectEqual(gp.packContinuation(1, 0, wide_id), snapshot.buffer.char[1]);
        }

        retained_id = gp.graphemeIdFromChar(snapshot.buffer.char[0]);
        try owner.resizeSessionRenderer(renderer, 3, 1);
        try owner.destroy(renderer);
        try std.testing.expectError(error.StaleLease, owner.bufferLeaseSnapshot(current_lease));
        try std.testing.expectEqual(bytes, owner.lease_bytes);
        try std.testing.expectEqual(@as(u32, 1), try owner.graphemes.getRefcount(retained_id));
        try std.testing.expectEqualStrings("\xf0\x9f\x98\x80", try owner.graphemes.get(retained_id));
        try std.testing.expectEqual(@as(u32, 2), try owner.links.getRefcount(link_id));
    }
    try std.testing.expectError(error.InvalidId, owner.graphemes.getRefcount(retained_id));
    try std.testing.expectEqual(@as(u32, 1), try owner.links.getRefcount(link_id));
    try std.testing.expectEqual(@as(u64, 0), owner.lease_bytes);
}

test "grapheme accounting - overlapping continuations remove only overwritten starts" {
    inline for (.{ buffer.OptimizedBuffer.set, buffer.OptimizedBuffer.syncCell }) |write| {
        var pool = gp.GraphemePool.init(std.testing.allocator);
        defer pool.deinit();
        var links = link.LinkPool.init(std.testing.allocator);
        defer links.deinit();
        const target = try buffer.OptimizedBuffer.init(std.testing.allocator, 8, 1, .{
            .pool = &pool,
            .link_pool = &links,
        });
        defer target.deinit();
        const first_id = try pool.alloc("\xf0\x9f\x98\x80");
        const second_id = try pool.alloc("e\xcc\x81");
        const old_link = try links.alloc("https://old.invalid");
        const new_link = try links.alloc("https://new.invalid");
        var cell: buffer.Cell = .{
            .char = gp.packGraphemeStart(first_id, 2),
            .fg = ansi.rgbColor(255, 255, 255, 255),
            .bg = ansi.rgbColor(0, 0, 0, 255),
            .attributes = ansi.TextAttributes.setLinkId(0, old_link),
        };
        write(target, 1, 0, cell);
        write(target, 6, 0, cell);
        cell.char = gp.packGraphemeStart(second_id, 1);
        write(target, 3, 0, cell);
        write(target, 4, 0, cell);
        try expectTrackedStarts(target);

        cell.char = gp.packGraphemeStart(first_id, 4);
        cell.attributes = ansi.TextAttributes.setLinkId(0, new_link);
        write(target, 0, 0, cell);
        try expectTrackedStarts(target);
        try std.testing.expectEqual(@as(u32, 2), target.grapheme_tracker.used_ids.get(first_id).?);
        try std.testing.expectEqual(@as(u32, 1), target.grapheme_tracker.used_ids.get(second_id).?);
        write(target, 0, 0, cell);
        try expectTrackedStarts(target);

        // The displaced start at 6 is removed before its old continuation at 7.
        cell.char = gp.packGraphemeStart(second_id, 2);
        write(target, 5, 0, cell);
        try expectTrackedStarts(target);
        cell.char = ' ';
        cell.attributes = 0;
        write(target, 7, 0, cell);
        try expectTrackedStarts(target);
        try std.testing.expectEqual(@as(u32, 1), try pool.getRefcount(first_id));
        try std.testing.expectEqual(@as(u32, 1), try pool.getRefcount(second_id));
        try std.testing.expectEqual(@as(u32, 1), target.link_tracker.used_ids.get(old_link).?);
        try std.testing.expectEqual(@as(u32, 6), target.link_tracker.used_ids.get(new_link).?);
        try std.testing.expectEqual(@as(u32, 1), try links.getRefcount(old_link));
        try std.testing.expectEqual(@as(u32, 1), try links.getRefcount(new_link));
        try std.testing.expectEqual(gp.packContinuation(1, 0, second_id), target.buffer.char[6]);

        // Head cleanup must preserve links on independent occurrences.
        cell.char = gp.packGraphemeStart(second_id, 4);
        cell.attributes = ansi.TextAttributes.setLinkId(0, old_link);
        write(target, 0, 0, cell);
        try expectTrackedStarts(target);
        try std.testing.expectEqual(@as(u32, 5), target.link_tracker.used_ids.get(old_link).?);
        try std.testing.expectEqual(@as(u32, 2), target.link_tracker.used_ids.get(new_link).?);
        try std.testing.expectEqual(@as(u32, 1), try links.getRefcount(new_link));

        target.clear(cell.bg, null);
        try expectTrackedStarts(target);
        try std.testing.expectError(error.InvalidId, pool.getRefcount(first_id));
        try std.testing.expectError(error.InvalidId, pool.getRefcount(second_id));
        try std.testing.expectEqual(@as(u32, 0), try links.getRefcount(old_link));
        try std.testing.expectEqual(@as(u32, 0), try links.getRefcount(new_link));
    }
}

test "grapheme accounting - right edge truncation removes each overwritten start once" {
    inline for (.{ buffer.OptimizedBuffer.set, buffer.OptimizedBuffer.syncCell }) |write| {
        for ([_]u32{ 1, 2 }) |tail_width| {
            var pool = gp.GraphemePool.init(std.testing.allocator);
            defer pool.deinit();
            var links = link.LinkPool.init(std.testing.allocator);
            defer links.deinit();
            const target = try buffer.OptimizedBuffer.init(std.testing.allocator, 8, 2, .{
                .pool = &pool,
                .link_pool = &links,
            });
            defer target.deinit();
            const old_id = try pool.alloc("e\xcc\x81");
            const truncated_id = try pool.alloc("\xf0\x9f\x98\x80");
            defer pool.freeUnreferenced(truncated_id) catch unreachable;
            const old_link = try links.alloc("https://old.invalid");
            const new_link = try links.alloc("https://new.invalid");
            var cell: buffer.Cell = .{
                .char = gp.packGraphemeStart(old_id, 1),
                .fg = ansi.rgbColor(255, 255, 255, 255),
                .bg = ansi.rgbColor(0, 0, 0, 255),
                .attributes = ansi.TextAttributes.setLinkId(0, old_link),
            };
            write(target, 0, 0, cell);
            write(target, 5, 1, cell);
            cell.char = gp.packGraphemeStart(old_id, tail_width);
            write(target, 6, 1, cell);
            if (tail_width == 1) write(target, 7, 1, cell);
            try expectTrackedStarts(target);

            cell.char = gp.packGraphemeStart(truncated_id, 4);
            cell.attributes = ansi.TextAttributes.setLinkId(0, new_link);
            write(target, 5, 1, cell);
            try expectTrackedStarts(target);
            try std.testing.expectEqual(@as(u32, 1), target.grapheme_tracker.used_ids.get(old_id).?);
            try std.testing.expectEqual(@as(u32, 1), try pool.getRefcount(old_id));
            try std.testing.expectEqual(@as(u32, 0), try pool.getRefcount(truncated_id));
            for (5..8) |x| {
                const cleared = target.get(@intCast(x), 1).?;
                try std.testing.expectEqual(buffer.DEFAULT_SPACE_CHAR, cleared.char);
                try std.testing.expectEqual(cell.attributes, cleared.attributes);
            }
            try std.testing.expectEqual(@as(u32, 1), target.link_tracker.used_ids.get(old_link).?);
            try std.testing.expectEqual(@as(u32, 3), target.link_tracker.used_ids.get(new_link).?);
            try std.testing.expectEqual(@as(u32, 1), try links.getRefcount(old_link));
            try std.testing.expectEqual(@as(u32, 1), try links.getRefcount(new_link));
        }
    }
}

test "grapheme accounting - ordinary overlapping sets compose without orphan tails" {
    const LinkMode = enum { none, same, different };
    for ([_]bool{ false, true }) |respect_alpha| {
        for ([_]bool{ false, true }) |same_glyph| {
            for ([_]LinkMode{ .none, .same, .different }) |link_mode| {
                for ([_][2]u32{ .{ 1, 0 }, .{ 0, 1 }, .{ 0, 0 } }) |positions| {
                    var pool = gp.GraphemePool.init(std.testing.allocator);
                    defer pool.deinit();
                    var links = link.LinkPool.init(std.testing.allocator);
                    defer links.deinit();
                    const source = try buffer.OptimizedBuffer.init(std.testing.allocator, 3, 1, .{
                        .pool = &pool,
                        .link_pool = &links,
                        .respectAlpha = respect_alpha,
                    });
                    defer source.deinit();
                    const target = try buffer.OptimizedBuffer.init(std.testing.allocator, 3, 1, .{
                        .pool = &pool,
                        .link_pool = &links,
                    });
                    defer target.deinit();
                    const old_id = try pool.alloc("\xf0\x9f\x98\x80");
                    const new_id = if (same_glyph) old_id else try pool.alloc("\xf0\x9f\x94\xa5");
                    const old_link = if (link_mode == .none) 0 else try links.alloc("https://old.invalid");
                    const new_link = if (link_mode == .different) try links.alloc("https://new.invalid") else old_link;
                    var cell: buffer.Cell = .{
                        .char = gp.packGraphemeStart(old_id, 2),
                        .fg = ansi.rgbColor(255, 255, 255, 255),
                        .bg = ansi.rgbColor(0, 0, 0, 255),
                        .attributes = ansi.TextAttributes.setLinkId(0, old_link),
                    };
                    source.clear(cell.bg, null);
                    target.clear(cell.bg, null);
                    source.set(positions[0], 0, cell);
                    cell.char = gp.packGraphemeStart(new_id, 2);
                    cell.attributes = ansi.TextAttributes.setLinkId(0, new_link);
                    source.set(positions[1], 0, cell);
                    try expectTrackedStarts(source);
                    try std.testing.expectEqual(@as(u32, 1), try pool.getRefcount(new_id));
                    if (!same_glyph) try std.testing.expectError(error.InvalidId, pool.getRefcount(old_id));
                    if (new_link != 0) {
                        try std.testing.expectEqual(@as(u32, 2), source.link_tracker.used_ids.get(new_link).?);
                        try std.testing.expectEqual(@as(u32, 1), source.link_tracker.getLinkCount());
                        try std.testing.expectEqual(@as(u32, 1), try links.getRefcount(new_link));
                        const probe = try links.alloc("https://probe.invalid");
                        try links.incref(probe);
                        defer links.decref(probe) catch unreachable;
                        try std.testing.expect(probe & link.SLOT_MASK != new_link & link.SLOT_MASK);
                        try std.testing.expectEqualStrings(
                            if (link_mode == .same) "https://old.invalid" else "https://new.invalid",
                            try links.get(new_link),
                        );
                    }

                    target.drawFrameBuffer(0, 0, source, null, null, null, null);
                    for (0..3) |x| {
                        const copied = target.get(@intCast(x), 0).?;
                        const expected_char = if (x == positions[1])
                            gp.packGraphemeStart(new_id, 2)
                        else if (x == positions[1] + 1)
                            gp.packContinuation(1, 0, new_id)
                        else
                            buffer.DEFAULT_SPACE_CHAR;
                        try std.testing.expectEqual(expected_char, copied.char);
                        try std.testing.expectEqual(
                            if (gp.isClusterChar(expected_char)) cell.attributes else 0,
                            copied.attributes,
                        );
                        try std.testing.expectEqualDeep(source.get(@intCast(x), 0).?, copied);
                    }
                    try expectTrackedStarts(target);
                    try std.testing.expectEqual(@as(u32, 2), try pool.getRefcount(new_id));
                    if (new_link != 0) try std.testing.expectEqual(@as(u32, 2), try links.getRefcount(new_link));
                    target.clear(cell.bg, null);
                    cell.char = ' ';
                    cell.attributes = 0;
                    source.set(positions[1], 0, cell);
                    target.drawFrameBuffer(0, 0, source, null, null, null, null);
                    for (0..3) |x| {
                        const copied = target.get(@intCast(x), 0).?;
                        try std.testing.expectEqual(buffer.DEFAULT_SPACE_CHAR, copied.char);
                        try std.testing.expectEqual(@as(u32, 0), copied.attributes);
                        try std.testing.expectEqualDeep(source.get(@intCast(x), 0).?, copied);
                    }
                    try expectTrackedStarts(source);
                    try expectTrackedStarts(target);
                    try std.testing.expect(!source.link_tracker.hasAny());
                    try std.testing.expect(!target.link_tracker.hasAny());
                    try std.testing.expectError(error.InvalidId, pool.getRefcount(new_id));
                    if (new_link != 0) try std.testing.expectEqual(@as(u32, 0), try links.getRefcount(new_link));
                }
            }
        }
    }
}
