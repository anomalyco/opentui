const std = @import("std");
const buffer = @import("../buffer.zig");
const gp = @import("../grapheme.zig");
const ansi = @import("../ansi.zig");

/// Checks the cell, tracker, and pool invariants that every buffer write must keep:
/// - each continuation cell belongs to a grapheme start with the same ID on its row;
/// - the grapheme tracker counts exactly the grapheme start cells per ID;
/// - the link tracker counts exactly the cells per link ID;
/// - every tracked ID is live in its pool;
/// - no cell holds a control code point or a pooled cluster with one; zero is an empty cell.
pub fn expectBufferInvariants(target: *const buffer.OptimizedBuffer) !void {
    var starts: std.AutoHashMapUnmanaged(u32, u32) = .empty;
    defer starts.deinit(std.testing.allocator);
    var links: std.AutoHashMapUnmanaged(u32, u32) = .empty;
    defer links.deinit(std.testing.allocator);

    for (target.buffer.char, target.buffer.attributes, 0..) |char, attributes, index| {
        const link_id = ansi.TextAttributes.getLinkId(attributes);
        if (link_id != 0) (try links.getOrPutValue(std.testing.allocator, link_id, 0)).value_ptr.* += 1;
        if (gp.isImageChar(char)) continue;
        if (gp.isContinuationChar(char)) {
            const left = gp.charLeftExtent(char);
            const column = index % target.width;
            try std.testing.expect(left <= column);
            const start = target.buffer.char[index - left];
            try std.testing.expect(gp.isGraphemeChar(start));
            try std.testing.expectEqual(gp.graphemeIdFromChar(start), gp.graphemeIdFromChar(char));
            continue;
        }
        if (gp.isGraphemeChar(char)) {
            const id = gp.graphemeIdFromChar(char);
            (try starts.getOrPutValue(std.testing.allocator, id, 0)).value_ptr.* += 1;
            const bytes = try target.pool.get(id);
            try std.testing.expect(bytes.len <= buffer.grapheme_bytes_max);
            var codepoints = (try std.unicode.Utf8View.init(bytes)).iterator();
            while (codepoints.nextCodepoint()) |codepoint| try std.testing.expect(!buffer.isControlCodepoint(codepoint));
            continue;
        }
        // Zero is an empty cell that no draw has written.
        if (char != 0 and buffer.isControlCodepoint(char)) {
            std.debug.print("cell {d} holds control U+{X:0>4}\n", .{ index, char });
            return error.TestUnexpectedResult;
        }
    }

    try std.testing.expectEqual(starts.count(), target.grapheme_tracker.used_ids.count());
    var tracked = target.grapheme_tracker.used_ids.iterator();
    while (tracked.next()) |entry| {
        try std.testing.expectEqual(starts.get(entry.key_ptr.*) orelse 0, entry.value_ptr.*);
        try std.testing.expect(try target.pool.getRefcount(entry.key_ptr.*) > 0);
    }
    try std.testing.expectEqual(links.count(), target.link_tracker.used_ids.count());
    var tracked_links = target.link_tracker.used_ids.iterator();
    while (tracked_links.next()) |entry| {
        try std.testing.expectEqual(links.get(entry.key_ptr.*) orelse 0, entry.value_ptr.*);
        try std.testing.expect(try target.link_pool.getRefcount(entry.key_ptr.*) > 0);
    }
}
