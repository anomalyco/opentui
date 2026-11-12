const std = @import("std");
const split_scrollback = @import("../split-scrollback.zig");

const TailEvent = enum { seed, scroll, newline, one_cell, full_row, two_lines };

fn checkTail(_: void, events: []const TailEvent) !void {
    var scrollback: split_scrollback.SplitScrollback = .{};
    // A small reference terminal: each published row holds its used cell count. The last row
    // wraps only on the *next* printable cell, not on an explicit newline or viewport scroll.
    const width = 3;
    var rows: [2 + 4 * 64]u8 = undefined;
    std.debug.assert(events.len <= 64);
    var len: usize = 0;
    for (events) |event| {
        switch (event) {
            .seed => {
                scrollback.reset(2);
                len = 2;
                @memset(rows[0..len], 0);
            },
            .scroll => {
                scrollback.noteViewportScroll(2);
                const removed = @min(2, len);
                std.mem.copyForwards(u8, rows[0 .. len - removed], rows[removed..len]);
                len -= removed;
            },
            .newline, .one_cell, .full_row, .two_lines => {
                const text: []const u8 = switch (event) {
                    .newline => "\n",
                    .one_cell => "x",
                    .full_row => "xxx",
                    .two_lines => "xx\nxx\n",
                    else => unreachable,
                };
                switch (event) {
                    .newline => scrollback.noteNewline(),
                    .one_cell, .full_row => scrollback.publishRow(@intCast(text.len), width, false),
                    .two_lines => scrollback.publishSnapshotRows(2, 2, width, true),
                    else => unreachable,
                }
                for (text) |byte| {
                    if (len == 0) {
                        rows[0] = 0;
                        len = 1;
                    }
                    if (byte == '\n' or rows[len - 1] == width) {
                        rows[len] = 0;
                        len += 1;
                    }
                    if (byte != '\n') rows[len - 1] += 1;
                }
            },
        }
        if (scrollback.published_rows != len) return error.RowCount;
        if (scrollback.tail_column != (if (len == 0) 0 else rows[len - 1])) return error.TailColumn;
        if (scrollback.renderOffset(2) != @min(len, 2)) return error.FooterPosition;
    }
}

test "native transition model: split scrollback follows the terminal tail" {
    // CI: 6^5 short walks and 32 seeded walks of 64 events.
    try @import("model-walk.zig").explore(TailEvent, {}, checkTail, 5, 32, 64);
}

test "split scrollback starts empty" {
    var scrollback: split_scrollback.SplitScrollback = .{};

    try std.testing.expectEqual(@as(u32, 0), scrollback.published_rows);
    try std.testing.expectEqual(@as(u32, 0), scrollback.tail_column);
    try std.testing.expectEqual(@as(u32, 0), scrollback.renderOffset(6));
}

test "split scrollback reset seeds pinned rows" {
    var scrollback: split_scrollback.SplitScrollback = .{};

    scrollback.reset(6);
    try std.testing.expectEqual(@as(u32, 6), scrollback.published_rows);
    try std.testing.expectEqual(@as(u32, 0), scrollback.tail_column);
    try std.testing.expectEqual(@as(u32, 6), scrollback.renderOffset(6));

    scrollback.publishSnapshotRows(1, 1, 40, false);
    try std.testing.expectEqual(@as(u32, 6), scrollback.renderOffset(6));
    try std.testing.expectEqual(@as(u32, 1), scrollback.tail_column);
}

test "split scrollback render offset preserves growth-created gap until output fills it" {
    var scrollback: split_scrollback.SplitScrollback = .{};

    scrollback.reset(7);
    scrollback.noteViewportScroll(5);

    try std.testing.expectEqual(@as(u32, 2), scrollback.renderOffset(2));
    try std.testing.expectEqual(@as(u32, 2), scrollback.renderOffset(7));

    scrollback.noteNewline();
    scrollback.noteNewline();

    try std.testing.expectEqual(@as(u32, 4), scrollback.renderOffset(7));
}

test "split scrollback snapshot rows start at line boundary" {
    var scrollback: split_scrollback.SplitScrollback = .{};

    scrollback.publishSnapshotRows(1, 4, 20, false);
    try std.testing.expectEqual(@as(u32, 1), scrollback.published_rows);
    try std.testing.expectEqual(@as(u32, 4), scrollback.tail_column);

    scrollback.noteNewline();
    scrollback.publishSnapshotRows(2, 8, 20, true);

    try std.testing.expectEqual(@as(u32, 4), scrollback.published_rows);
    try std.testing.expectEqual(@as(u32, 0), scrollback.tail_column);
}

test "split scrollback snapshot rows wrap visible columns against terminal width" {
    var scrollback: split_scrollback.SplitScrollback = .{};

    scrollback.publishSnapshotRows(1, 6, 4, true);

    try std.testing.expectEqual(@as(u32, 3), scrollback.published_rows);
    try std.testing.expectEqual(@as(u32, 0), scrollback.tail_column);
}

test "split scrollback snapshot rows can omit trailing newline" {
    var scrollback: split_scrollback.SplitScrollback = .{};

    scrollback.publishSnapshotRows(1, 6, 4, false);

    try std.testing.expectEqual(@as(u32, 2), scrollback.published_rows);
    try std.testing.expectEqual(@as(u32, 2), scrollback.tail_column);
}
