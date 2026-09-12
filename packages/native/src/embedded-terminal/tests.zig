const std = @import("std");
const ansi = @import("../ansi.zig");
const buffer = @import("../buffer.zig");
const gp = @import("../grapheme.zig");
const EmbeddedTerminal = @import("main.zig").EmbeddedTerminal;
const ghostty = @import("ghostty.zig");

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

    terminal.stream.handler.semantic_failure = true;
    try terminal.write("ok");
    try std.testing.expect(!terminal.stream.handler.semantic_failure);
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
