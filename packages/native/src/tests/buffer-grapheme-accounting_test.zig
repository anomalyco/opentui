const std = @import("std");
const buffer = @import("../buffer.zig");
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
        const first_id = try pool.acquire("\xf0\x9f\x98\x80");
        const second_id = try pool.acquire("e\xcc\x81");
        const old_link = try links.acquire("https://old.invalid");
        const new_link = try links.acquire("https://new.invalid");
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
        try pool.decref(first_id);
        try pool.decref(second_id);
        try links.decref(old_link);
        try links.decref(new_link);
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
