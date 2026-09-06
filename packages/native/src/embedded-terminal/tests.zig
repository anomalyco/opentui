const std = @import("std");
const ansi = @import("../ansi.zig");
const buffer = @import("../buffer.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");
const EmbeddedTerminal = @import("main.zig").EmbeddedTerminal;
const ghostty = @import("ghostty.zig");

test "embedded terminal retries every row after composition allocation failure" {
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    var pool = gp.GraphemePool.init(failing.allocator());
    defer pool.deinit();
    const target = try buffer.OptimizedBuffer.init(std.testing.allocator, 4, 3, .{ .pool = &pool });
    defer target.deinit();
    const terminal = try EmbeddedTerminal.init(std.testing.io, std.testing.allocator, .{ .cols = 4, .rows = 3 });
    defer terminal.deinit();
    try terminal.write("old0\r\nold1\r\nold2");
    try terminal.compose(target, 0, 0);
    try terminal.write("\x1b[1;1Hnew0\x1b[2;1H\xc3\xa9");

    failing.fail_index = failing.alloc_index;
    try std.testing.expectError(error.OutOfMemory, terminal.compose(target, 0, 0));
    failing.fail_index = std.math.maxInt(usize);
    try std.testing.expect(terminal.force_redraw);

    target.clear(ansi.rgbColor(1, 2, 3, 255), 'X');
    try terminal.compose(target, 0, 0);
    try std.testing.expectEqual(@as(u32, 'n'), target.get(0, 0).?.char);
    try std.testing.expectEqualStrings("\xc3\xa9", try pool.get(gp.graphemeIdFromChar(target.get(0, 1).?.char)));
    try std.testing.expectEqual(@as(u32, 'o'), target.get(0, 2).?.char);
    try std.testing.expect(!terminal.force_redraw);
}

test "embedded terminal clips extreme signed origins without overflow" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    const target = try buffer.OptimizedBuffer.init(std.testing.allocator, 4, 3, .{ .pool = &pool });
    defer target.deinit();
    const terminal = try EmbeddedTerminal.init(std.testing.io, std.testing.allocator, .{ .cols = 4, .rows = 3 });
    defer terminal.deinit();
    try terminal.write("abcd\r\nefgh");
    const origins = [_][2]i32{
        .{ std.math.minInt(i32), 0 },
        .{ std.math.maxInt(i32), 0 },
        .{ 0, std.math.minInt(i32) },
        .{ 0, std.math.maxInt(i32) },
    };
    inline for (.{ false, true }) |checked| for (origins) |origin| {
        terminal.invalidate();
        target.clear(ansi.rgbColor(1, 2, 3, 255), 'X');
        if (checked) {
            try terminal.composeChecked(target, origin[0], origin[1], 12);
        } else try terminal.compose(target, origin[0], origin[1]);
        for (target.buffer.char) |char| try std.testing.expectEqual(@as(u32, 'X'), char);
    };
}

test "embedded terminal checked composition preserves widths backgrounds and clean rows" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    const legacy = try buffer.OptimizedBuffer.init(std.testing.allocator, 8, 3, .{ .pool = &pool });
    defer legacy.deinit();
    const checked = try buffer.OptimizedBuffer.init(std.testing.allocator, 8, 3, .{ .pool = &pool, .width_method = .wcwidth });
    defer checked.deinit();
    const terminal = try EmbeddedTerminal.init(std.testing.io, std.testing.allocator, .{ .cols = 8, .rows = 3 });
    defer terminal.deinit();
    try terminal.write("\x1b[41m\u{4e2d}A\x1b[8mH\x1b[0m\r\n\u{2764}\u{fe0f}e\u{301}B");
    try terminal.setSelection(.{ .x = 2, .y = 0 }, .{ .x = 3, .y = 0 });
    try legacy.pushScissorRect(1, 0, 6, 3);
    try checked.pushScissorRect(1, 0, 6, 3);
    const bg = ansi.rgbColor(1, 2, 3, 255);
    legacy.clear(bg, 'X');
    checked.clear(bg, 'X');
    try terminal.compose(legacy, 0, 0);
    terminal.invalidate();
    try terminal.composeChecked(checked, 0, 0, 24);
    try std.testing.expectEqualSlices(u32, legacy.buffer.char, checked.buffer.char);
    try std.testing.expectEqualSlices(buffer.RGBA, legacy.buffer.fg, checked.buffer.fg);
    try std.testing.expectEqualSlices(buffer.RGBA, legacy.buffer.bg, checked.buffer.bg);
    try std.testing.expectEqualSlices(u32, legacy.buffer.attributes, checked.buffer.attributes);

    var sentinel = checked.get(2, 2).?;
    sentinel.char = 'Q';
    checked.set(2, 2, sentinel);
    try terminal.write("\x1b[1;3HZ");
    try terminal.composeChecked(checked, 0, 0, 24);
    try std.testing.expectEqual(@as(u32, 'Z'), checked.get(2, 0).?.char);
    try std.testing.expectEqual(@as(u32, 'Q'), checked.get(2, 2).?.char);

    checked.clearScissorRects();
    terminal.invalidate();
    try terminal.composeChecked(checked, 0, 0, 24);
    try std.testing.expectEqual(@as(u32, 2), gp.encodedCharWidth(checked.get(0, 0).?.char));
    try std.testing.expect(gp.isContinuationChar(checked.get(1, 0).?.char));
}

test "embedded terminal checked composition preserves parser-accepted control cells" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    const legacy = try buffer.OptimizedBuffer.init(std.testing.allocator, 4, 1, .{ .pool = &pool });
    defer legacy.deinit();
    const checked = try buffer.OptimizedBuffer.init(std.testing.allocator, 4, 1, .{ .pool = &pool });
    defer checked.deinit();
    const terminal = try EmbeddedTerminal.init(std.testing.io, std.testing.allocator, .{ .cols = 4, .rows = 1 });
    defer terminal.deinit();
    for ([_][]const u8{ "A\x7fB", "A\xc2\x85B" }) |text| {
        try terminal.write("\x1b[2J\x1b[H");
        try terminal.write(text);
        try terminal.compose(legacy, 0, 0);
        terminal.invalidate();
        try terminal.composeChecked(checked, 0, 0, 4);
        try std.testing.expectEqualSlices(u32, legacy.buffer.char, checked.buffer.char);
        try std.testing.expectEqualSlices(buffer.RGBA, legacy.buffer.fg, checked.buffer.fg);
        try std.testing.expectEqualSlices(buffer.RGBA, legacy.buffer.bg, checked.buffer.bg);
    }
}

test "embedded terminal checked composition skips oversized clipped graphemes" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    const target = try buffer.OptimizedBuffer.init(std.testing.allocator, 4, 1, .{ .pool = &pool });
    defer target.deinit();
    const terminal = try EmbeddedTerminal.init(std.testing.io, std.testing.allocator, .{ .cols = 4, .rows = 1 });
    defer terminal.deinit();
    try terminal.write("e" ++ ("\u{301}" ** 64) ++ "B");
    try target.pushScissorRect(1, 0, 3, 1);
    try terminal.composeChecked(target, 0, 0, 4);
    try std.testing.expectEqual(@as(u32, 'B'), target.get(1, 0).?.char);
}

test "embedded terminal checked composition rejects cell bounds before changing accepted cells" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    const target = try buffer.OptimizedBuffer.init(std.testing.allocator, 8, 2, .{ .pool = &pool });
    defer target.deinit();
    const terminal = try EmbeddedTerminal.init(std.testing.io, std.testing.allocator, .{ .cols = 8, .rows = 3 });
    defer terminal.deinit();
    try terminal.write("accepted");
    try terminal.composeChecked(target, 0, 0, 24);
    const chars = target.buffer.char[0..16].*;
    const fg = target.buffer.fg[0..16].*;
    const bg = target.buffer.bg[0..16].*;
    const attributes = target.buffer.attributes[0..16].*;

    try std.testing.expectError(error.InvalidDimensions, terminal.composeChecked(target, 0, 0, 16));
    try terminal.resize(4, 2);
    try std.testing.expectError(error.InvalidDimensions, terminal.composeChecked(target, 0, 0, 8));
    const dimensions = [_][2]u32{ .{ 0, 2 }, .{ 8, 0 }, .{ std.math.maxInt(u32), 2 }, .{ @as(u32, std.math.maxInt(i32)) + 1, 1 } };
    for (dimensions) |size| {
        target.width = size[0];
        target.height = size[1];
        defer target.width = 8;
        defer target.height = 2;
        try std.testing.expectError(error.InvalidDimensions, terminal.composeChecked(target, 0, 0, std.math.maxInt(u32)));
    }
    try std.testing.expectEqualSlices(u32, &chars, target.buffer.char);
    try std.testing.expectEqualSlices(buffer.RGBA, &fg, target.buffer.fg);
    try std.testing.expectEqualSlices(buffer.RGBA, &bg, target.buffer.bg);
    try std.testing.expectEqualSlices(u32, &attributes, target.buffer.attributes);
    try std.testing.expect(terminal.force_redraw);
    try terminal.composeChecked(target, 0, 0, 16);
    try std.testing.expect(!terminal.force_redraw);
}

test "embedded terminal checked composition owns cells and retries after every allocation failure" {
    var failures: usize = 0;
    var succeeded = false;
    for (0..128) |fail_after| {
        var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        const allocator = failing.allocator();
        var pool = gp.GraphemePool.initWithOptions(allocator, .{ .slots_per_page = .{ 1, 1, 1, 1, 1 } });
        defer pool.deinit();
        var links = link.LinkPool.init(allocator);
        defer links.deinit();
        const target = try buffer.OptimizedBuffer.init(allocator, 8, 3, .{ .pool = &pool, .link_pool = &links });
        defer target.deinit();
        const terminal = try EmbeddedTerminal.init(std.testing.io, allocator, .{ .cols = 8, .rows = 3 });
        defer terminal.deinit();
        try terminal.write("old0\r\nold1\r\nold2");
        try terminal.composeChecked(target, 0, 0, 24);
        const link_id = try links.alloc("https://old.example");
        try target.drawGrapheme("\u{754c}", 2, 0, 0, ansi.rgbColor(255, 255, 255, 255), ansi.rgbColor(0, 0, 0, 255), ansi.TextAttributes.setLinkId(0, link_id));
        try terminal.write("\x1b[1;1H\u{e9}\u{4e2d}\x1b[2;1He\u{301}\u{3b1}\u{3b2}\u{3b3}\u{3b4}\u{3b5}");

        failing.fail_index = failing.alloc_index + fail_after;
        failing.resize_fail_index = failing.resize_index;
        const result = terminal.composeChecked(target, 0, 0, 24);
        failing.fail_index = std.math.maxInt(usize);
        failing.resize_fail_index = std.math.maxInt(usize);
        if (result) |_| {
            succeeded = true;
            try std.testing.expect(!failing.has_induced_failure);
        } else |err| {
            try std.testing.expectEqual(error.OutOfMemory, err);
            failures += 1;
            try std.testing.expect(terminal.force_redraw);
            for (target.buffer.char) |char| {
                if (!gp.isGraphemeChar(char)) continue;
                const id = gp.graphemeIdFromChar(char);
                try std.testing.expect(target.grapheme_tracker.contains(id));
                try std.testing.expectEqual(@as(u32, 1), try pool.getRefcount(id));
            }
            target.clear(ansi.rgbColor(1, 2, 3, 255), 'X');
            try terminal.composeChecked(target, 0, 0, 24);
        }
        try std.testing.expectEqualStrings("\u{e9}", try pool.get(gp.graphemeIdFromChar(target.get(0, 0).?.char)));
        try std.testing.expectEqualStrings("e\u{301}", try pool.get(gp.graphemeIdFromChar(target.get(0, 1).?.char)));
        try std.testing.expectEqual(@as(u32, 'o'), target.get(0, 2).?.char);
        try std.testing.expect(!terminal.force_redraw);
        target.clear(ansi.rgbColor(0, 0, 0, 255), null);
        try std.testing.expectEqual(0, pool.interned_live_ids.count());
        try std.testing.expectEqual(0, links.getLiveSlotCount());
        for (pool.classes) |class| try std.testing.expectEqual(class.num_slots, class.free_list.items.len);
        if (succeeded) break;
    }
    try std.testing.expect(succeeded);
    try std.testing.expect(failures >= 5);
}

test "embedded terminal composes dirty rows into an OptimizedBuffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var target = try buffer.OptimizedBuffer.init(std.testing.allocator, 12, 4, .{ .pool = pool });
    defer target.deinit();
    target.clear(ansi.rgbColor(0, 0, 0, 255), null);

    const terminal = try EmbeddedTerminal.init(std.testing.io, std.testing.allocator, .{ .cols = 8, .rows = 2 });
    defer terminal.deinit();
    try terminal.write("A\x1b[1;32mB\x1b[0m\r\nwide: \xe7\x95\x8c");

    try terminal.compose(target, 2, 1);
    try std.testing.expectEqual(@as(u32, 'A'), target.get(2, 1).?.char);
    try std.testing.expectEqual(@as(u32, 'B'), target.get(3, 1).?.char);
    try std.testing.expect(target.get(3, 1).?.attributes & ansi.TextAttributes.BOLD != 0);
    try std.testing.expect(ansi.green(target.get(3, 1).?.fg) > ansi.red(target.get(3, 1).?.fg));
    try std.testing.expect(gp.isGraphemeChar(target.get(8, 2).?.char));
    try std.testing.expect(gp.isContinuationChar(target.get(9, 2).?.char));

    var sentinel = target.get(2, 1).?;
    sentinel.char = 'X';
    target.set(2, 1, sentinel);
    try terminal.compose(target, 2, 1);
    try std.testing.expectEqual(@as(u32, 'X'), target.get(2, 1).?.char);

    terminal.invalidate();
    try terminal.compose(target, 1, 0);
    try std.testing.expectEqual(@as(u32, 'A'), target.get(1, 0).?.char);
}

test "embedded terminal redraws changed rows and clips composition" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var target = try buffer.OptimizedBuffer.init(std.testing.allocator, 5, 2, .{ .pool = pool });
    defer target.deinit();

    const terminal = try EmbeddedTerminal.init(std.testing.io, std.testing.allocator, .{ .cols = 4, .rows = 2 });
    defer terminal.deinit();
    try terminal.write("abcd");
    try terminal.compose(target, -1, 0);
    try std.testing.expectEqual(@as(u32, 'b'), target.get(0, 0).?.char);
    try std.testing.expectEqual(@as(u32, 'd'), target.get(2, 0).?.char);

    try terminal.write("\x1b[1;2HZ");
    var sentinel = target.get(0, 1).?;
    sentinel.char = 'Q';
    target.set(0, 1, sentinel);
    try terminal.compose(target, -1, 0);
    try std.testing.expectEqual(@as(u32, 'Z'), target.get(0, 0).?.char);
    try std.testing.expectEqual(@as(u32, 'Q'), target.get(0, 1).?.char);

    try terminal.resize(5, 2);
    try terminal.compose(target, 0, 0);
    try std.testing.expectEqual(@as(u32, 'a'), target.get(0, 0).?.char);
    try std.testing.expectEqual(buffer.DEFAULT_SPACE_CHAR, target.get(0, 1).?.char);
}

test "embedded terminal exposes cursor state" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var target = try buffer.OptimizedBuffer.init(std.testing.allocator, 20, 4, .{ .pool = pool });
    defer target.deinit();

    const terminal = try EmbeddedTerminal.init(std.testing.io, std.testing.allocator, .{ .cols = 20, .rows = 4 });
    defer terminal.deinit();
    try terminal.write("\x1b[2;3H\x1b[5 q");
    try terminal.compose(target, 0, 0);

    const cursor = terminal.cursor();
    try std.testing.expect(cursor.has_value);
    try std.testing.expect(cursor.visible);
    try std.testing.expectEqual(@as(u16, 2), cursor.x);
    try std.testing.expectEqual(@as(u16, 1), cursor.y);
    try std.testing.expectEqual(@as(u8, 0), cursor.style);
}

test "embedded terminal supports lifecycle, resize, and viewport scroll" {
    const terminal = try EmbeddedTerminal.init(std.testing.io, std.testing.allocator, .{ .cols = 80, .rows = 24 });
    defer terminal.deinit();

    try terminal.write("hello");
    try terminal.resize(100, 40);
    terminal.scroll(-3);
    terminal.scroll(3);

    try std.testing.expectEqual(@as(u16, 100), terminal.cols);
    try std.testing.expectEqual(@as(u16, 40), terminal.rows);
    try std.testing.expectError(error.InvalidValue, terminal.resize(0, 40));
    try std.testing.expectError(error.InvalidValue, terminal.resize(100, 0));
    try std.testing.expectError(error.InvalidValue, EmbeddedTerminal.init(std.testing.io, std.testing.allocator, .{ .cols = 0, .rows = 24 }));
}

test "embedded terminal selects rendered cells and extracts text" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var target = try buffer.OptimizedBuffer.init(std.testing.allocator, 8, 2, .{ .pool = pool });
    defer target.deinit();

    const terminal = try EmbeddedTerminal.init(std.testing.io, std.testing.allocator, .{ .cols = 8, .rows = 2 });
    defer terminal.deinit();
    try terminal.write("hello");
    try terminal.setSelection(.{ .x = 1, .y = 0 }, .{ .x = 3, .y = 0 });

    const selected = try terminal.selectedText();
    defer terminal.freeSelectedText(selected);
    try std.testing.expectEqualStrings("ell", selected);

    try terminal.compose(target, 0, 0);
    const unselected = target.get(0, 0).?;
    const highlighted = target.get(1, 0).?;
    try std.testing.expect(ansi.red(unselected.fg) > ansi.red(unselected.bg));
    try std.testing.expect(ansi.red(highlighted.fg) < ansi.red(highlighted.bg));

    terminal.clearSelection();
    try terminal.compose(target, 0, 0);
    const cleared = target.get(1, 0).?;
    try std.testing.expect(ansi.red(cleared.fg) > ansi.red(cleared.bg));
}

test "embedded terminal selection highlights text without unused cells" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var target = try buffer.OptimizedBuffer.init(std.testing.allocator, 8, 3, .{ .pool = pool });
    defer target.deinit();

    const cases = [_]struct {
        output: []const u8,
        start: ghostty.Coordinate = .{ .x = 0, .y = 0 },
        end: ghostty.Coordinate = .{ .x = 7, .y = 2 },
        text: []const u8,
        highlight: [3][]const u8,
    }{
        .{
            .output = "hello\r\nabc",
            .start = .{ .x = 1, .y = 0 },
            .text = "ello\nabc",
            .highlight = .{ ".####...", "###.....", "........" },
        },
        .{
            .output = "hello",
            .start = .{ .x = 7, .y = 0 },
            .end = .{ .x = 7, .y = 0 },
            .text = "",
            .highlight = .{ "........", "........", "........" },
        },
        .{
            .output = "",
            .text = "",
            .highlight = .{ "........", "........", "........" },
        },
        .{
            .output = "  a\x1b[3Cb",
            .text = "  a   b",
            .highlight = .{ "#######.", "........", "........" },
        },
        .{
            // Written spaces remain text even though clipboard extraction trims them.
            .output = "a  ",
            .text = "a",
            .highlight = .{ "###.....", "........", "........" },
        },
        .{
            .output = "\x1b[44m\x1b[2J\x1b[0mhi",
            .text = "hi",
            .highlight = .{ "##......", "........", "........" },
        },
        .{
            .output = "abcdefghi",
            .text = "abcdefghi",
            .highlight = .{ "########", "#.......", "........" },
        },
        .{
            .output = "\xe7\x95\x8c",
            .start = .{ .x = 1, .y = 0 },
            .end = .{ .x = 1, .y = 0 },
            .text = "\xe7\x95\x8c",
            .highlight = .{ "##......", "........", "........" },
        },
        .{
            .output = "e\xcc\x81 \xf0\x9f\x98\x80",
            .text = "e\xcc\x81 \xf0\x9f\x98\x80",
            .highlight = .{ "####....", "........", "........" },
        },
        .{
            .output = "abcdefg\xe7\x95\x8c",
            .text = "abcdefg\xe7\x95\x8c",
            .highlight = .{ "#######.", "##......", "........" },
        },
    };

    for (cases) |case| {
        const terminal = try EmbeddedTerminal.init(std.testing.io, std.testing.allocator, .{ .cols = 8, .rows = 3 });
        defer terminal.deinit();
        try terminal.write(case.output);
        try terminal.compose(target, 0, 0);
        var original: [3][8]buffer.Cell = undefined;
        for (&original, 0..) |*row, y| {
            for (row, 0..) |*cell, x| cell.* = target.get(@intCast(x), @intCast(y)).?;
        }

        for ([_]bool{ false, true }) |reverse| {
            try terminal.setSelection(if (reverse) case.end else case.start, if (reverse) case.start else case.end);
            const selected = try terminal.selectedText();
            defer terminal.freeSelectedText(selected);
            try std.testing.expectEqualStrings(case.text, selected);
            try terminal.compose(target, 0, 0);

            for (case.highlight, 0..) |row, y| {
                for (row, 0..) |highlight, x| {
                    const cell = target.get(@intCast(x), @intCast(y)).?;
                    const before = original[y][x];
                    try std.testing.expectEqualDeep(if (highlight == '#') before.bg else before.fg, cell.fg);
                    try std.testing.expectEqualDeep(if (highlight == '#') before.fg else before.bg, cell.bg);
                }
            }

            // Moving into an unused row must repaint the previous highlight too.
            try terminal.setSelection(.{ .x = 0, .y = 2 }, .{ .x = 7, .y = 2 });
            try terminal.compose(target, 0, 0);
            for (original, 0..) |row, y| {
                for (row, 0..) |before, x| {
                    const cell = target.get(@intCast(x), @intCast(y)).?;
                    try std.testing.expectEqualDeep(before.fg, cell.fg);
                    try std.testing.expectEqualDeep(before.bg, cell.bg);
                }
            }
            terminal.clearSelection();
            try terminal.compose(target, 0, 0);
        }
    }
}

test "embedded terminal preserves parser state and provides mode-aware input" {
    const terminal = try EmbeddedTerminal.init(std.testing.io, std.testing.allocator, .{ .cols = 20, .rows = 4 });
    defer terminal.deinit();

    try terminal.write("\x1b[?20");
    try terminal.write("04h\x1b[?1004h\x1b[?1000h\x1b[?1006h");

    const paste = try terminal.encodePaste("one\ntwo");
    defer terminal.freeEncoded(paste);
    try std.testing.expectEqualStrings("\x1b[200~one\ntwo\x1b[201~", paste);

    const focus = try terminal.encodeFocus(true);
    defer terminal.freeEncoded(focus);
    try std.testing.expectEqualStrings("\x1b[I", focus);

    const key = try terminal.encodeKey(.{ .key = .enter });
    defer terminal.freeEncoded(key);
    try std.testing.expectEqualStrings("\r", key);

    const mouse = try terminal.encodeMouse(.{
        .action = .press,
        .button = .left,
        .x = 0,
        .y = 0,
        .any_button_pressed = true,
    });
    defer terminal.freeEncoded(mouse);
    try std.testing.expectEqualStrings("\x1b[<0;1;1M", mouse);
}

test "embedded terminal encodes long Kitty associated text" {
    const terminal = try EmbeddedTerminal.init(std.testing.io, std.testing.allocator, .{ .cols = 20, .rows = 4 });
    defer terminal.deinit();
    try terminal.write("\x1b[>19u");
    try std.testing.expectEqual(@as(u5, 19), terminal.terminal.screens.active.kitty_keyboard.current().int());

    const text = "x" ** 2048;
    const encoded = try terminal.encodeKey(.{ .key = .unidentified, .utf8 = text });
    defer terminal.freeEncoded(encoded);
    try std.testing.expectEqualStrings(text, encoded);
}

test "embedded terminal encodes Kitty key releases" {
    const terminal = try EmbeddedTerminal.init(std.testing.io, std.testing.allocator, .{ .cols = 20, .rows = 4 });
    defer terminal.deinit();
    try terminal.write("\x1b[>3u");
    try std.testing.expectEqual(@as(u5, 3), terminal.terminal.screens.active.kitty_keyboard.current().int());

    const encoded = try terminal.encodeKey(.{ .action = .release, .key = .key_a, .unshifted_codepoint = 'a' });
    defer terminal.freeEncoded(encoded);
    try std.testing.expectEqualStrings("\x1b[97;1:3u", encoded);
}

test "embedded terminal drains generated PTY responses incrementally" {
    const terminal = try EmbeddedTerminal.init(std.testing.io, std.testing.allocator, .{ .cols = 20, .rows = 4 });
    defer terminal.deinit();

    try terminal.write("\x1b[5n");
    var first: [2]u8 = undefined;
    var rest: [16]u8 = undefined;
    const first_len = try terminal.drainResponses(&first);
    const rest_len = try terminal.drainResponses(&rest);

    var combined: [18]u8 = undefined;
    @memcpy(combined[0..first_len], first[0..first_len]);
    @memcpy(combined[first_len .. first_len + rest_len], rest[0..rest_len]);
    try std.testing.expectEqualStrings("\x1b[0n", combined[0 .. first_len + rest_len]);
}

test "embedded terminal preserves queued responses when the bound is reached" {
    const terminal = try EmbeddedTerminal.init(std.testing.io, std.testing.allocator, .{ .cols = 20, .rows = 4 });
    defer terminal.deinit();

    const query = "\x1b[5n";
    const count = @import("main.zig").response_limit / query.len + 1;
    const input = try std.testing.allocator.alloc(u8, count * query.len);
    defer std.testing.allocator.free(input);
    for (0..count) |index| @memcpy(input[index * query.len ..][0..query.len], query);

    try terminal.write(input);
    var byte: [1]u8 = undefined;
    try std.testing.expectError(error.ResponseOverflow, terminal.drainResponses(&byte));

    var preserved: [16]u8 = undefined;
    const preserved_len = try terminal.drainResponses(&preserved);
    try std.testing.expect(preserved_len > 0);
}

test "embedded terminal reports semantic failures per write" {
    const terminal = try EmbeddedTerminal.init(std.testing.io, std.testing.allocator, .{ .cols = 20, .rows = 4 });
    defer terminal.deinit();

    terminal.stream.handler.base.semantic_failure = true;
    try terminal.write("ok");
    try std.testing.expect(!terminal.stream.handler.base.semantic_failure);
}

test "embedded terminal resets mouse motion deduplication after resize" {
    const terminal = try EmbeddedTerminal.init(std.testing.io, std.testing.allocator, .{ .cols = 20, .rows = 4 });
    defer terminal.deinit();
    try terminal.write("\x1b[?1003h\x1b[?1006h");

    const mouse: ghostty.Mouse = .{ .action = .motion, .x = 0, .y = 0 };
    const first = try terminal.encodeMouse(mouse);
    defer terminal.freeEncoded(first);
    try std.testing.expect(first.len > 0);

    const duplicate = try terminal.encodeMouse(mouse);
    defer terminal.freeEncoded(duplicate);
    try std.testing.expectEqual(@as(usize, 0), duplicate.len);

    try terminal.resize(10, 4);
    const after_resize = try terminal.encodeMouse(mouse);
    defer terminal.freeEncoded(after_resize);
    try std.testing.expect(after_resize.len > 0);
}

comptime {
    _ = ghostty;
}
