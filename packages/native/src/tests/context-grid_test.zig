const std = @import("std");
const testing = std.testing;
const context = @import("../context.zig");
const ansi = @import("../ansi.zig");

const border = [_]u32{ '+', '+', '+', '+', '-', '|', '+', '+', '+', '+', '+' };
const columns = [_]i32{ 0, 3, 6 };
const rows = [_]i32{ 0, 2, 4 };
const red = ansi.rgbColor(200, 0, 0, 255);
const black = ansi.rgbColor(0, 0, 0, 255);

test "Grid primitive clips and blends every border write path" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createBuffer(7, 5, .{});
    const target = try owner.raw().getBuffer(id);
    try target.pushScissorRect(1, 1, 4, 3);
    for ([_]f32{ 1, 0.5 }) |opacity| {
        target.clear(black, null);
        try target.pushOpacity(opacity);
        defer target.popOpacity();
        target.drawGrid(&border, red, red, &columns, 2, &rows, 2, true, true);
        for (target.buffer.char, 0..) |char, index| {
            const x = index % 7;
            const y = index / 7;
            const visible = x >= 1 and x < 5 and y >= 1 and y < 4;
            const expected: u32 = if (!visible) ' ' else if (x == 3 and y == 2) '+' else if (x == 3) '|' else if (y == 2) '-' else ' ';
            try testing.expectEqual(expected, char);
            if (expected != ' ' and opacity < 1) {
                try testing.expect(target.buffer.bg[index][0] > 0);
                try testing.expect(target.buffer.bg[index][0] < 200);
            }
        }
    }
}

test "Grid primitive over a transparent background matches per-cell blending" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const target = try owner.raw().getBuffer(try owner.createBuffer(7, 5, .{}));
    const expected = try owner.raw().getBuffer(try owner.createBuffer(7, 5, .{}));
    const clear = ansi.rgbColor(0, 0, 0, 0);
    const white = ansi.rgbColor(255, 255, 255, 255);
    for ([_]*@TypeOf(target.*){ target, expected }) |buffer| {
        buffer.clear(black, null);
        for (0..5) |y| {
            for (0..7) |x| {
                // Spaces over glyphs keep the glyph, so the grid also covers that rule.
                const char: u32 = if (x == 3 and y == 1) 'g' else ' ';
                buffer.setCellWithAlphaBlending(@intCast(x), @intCast(y), char, white, ansi.rgbColor(@intCast(x * 30), @intCast(y * 40), 9, 255), 0);
            }
        }
        try buffer.pushScissorRect(1, 1, 4, 3);
    }
    const spaced = [_]u32{ '+', '+', '+', '+', '-', ' ', '+', '+', '+', '+', '+' };
    target.drawGrid(&spaced, red, clear, &columns, 2, &rows, 2, true, true);
    for (0..5) |y| {
        for (0..7) |x| {
            const char: ?u32 = if (x % 3 == 0 and y % 2 == 0) '+' else if (x % 3 == 0) ' ' else if (y % 2 == 0) '-' else null;
            if (char) |value| expected.setCellWithAlphaBlending(@intCast(x), @intCast(y), value, red, clear, 0);
        }
    }
    try testing.expectEqualSlices(u32, expected.buffer.char, target.buffer.char);
    try testing.expectEqualDeep(expected.buffer.fg, target.buffer.fg);
    try testing.expectEqualDeep(expected.buffer.bg, target.buffer.bg);
    try testing.expectEqualSlices(u32, expected.buffer.attributes, target.buffer.attributes);
    try testing.expectEqual(@as(u32, 'g'), target.get(3, 1).?.char);
}

const PackedCell = extern struct {
    bg: [4]f32 = .{ 0, 0, 0, 1 },
    fg: [4]f32 = .{ 1, 0, 0, 1 },
    char: u32,
    padding: [3]u32 = .{ 0, 0, 0 },
};

test "GPU primitive packed offsets describe a source rectangle not destination bounds" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createBuffer(4, 3, .{});
    const target = try owner.raw().getBuffer(id);
    target.clear(black, null);
    const cells = [_]PackedCell{ .{ .char = 'A' }, .{ .char = 'B' }, .{ .char = 'C' }, .{ .char = 'D' } };
    const bytes = std.mem.asBytes(&cells);
    target.drawPackedBuffer(bytes.ptr, bytes.len, 1, 1, 2, 2);
    try testing.expectEqualSlices(u32, &.{ ' ', ' ', ' ', ' ', ' ', 'A', 'B', ' ', ' ', 'C', 'D', ' ' }, target.buffer.char);
}

test "Context checked grid and pixel draws reject invalid input before any write" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{ .render_cells_max = 12 });
    defer owner.deinit() catch unreachable;
    const id = try owner.createBuffer(4, 3, .{});
    const target = try owner.raw().getBuffer(id);
    const nan = std.math.nan(f32);
    // The second cell is invalid, so a single-pass draw would already have written the first.
    const packed_cells = [_]PackedCell{ .{ .char = 'A' }, .{ .char = 'B', .fg = .{ nan, 0, 0, 1 } } };
    const packed_bytes = std.mem.asBytes(&packed_cells);
    const pixels = [_]u8{255} ** 32;
    const grid: context.BufferGrid = .{ .border_chars = border, .foreground = red, .background = black, .draw_inner = true, .draw_outer = true };
    var invalid_chars: [3]context.BufferGrid = @splat(grid);
    for (&invalid_chars, [_]u32{ 0xd800, 0x110000, 0x4e2d }) |*options, char| options.border_chars[4] = char;
    const long_offsets = [_]i32{ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13 };
    try owner.clearBuffer(id, black);
    const Result = anyerror!void;
    const results = [_]Result{
        owner.drawGrid(id, null, invalid_chars[0], &columns, &rows),
        owner.drawGrid(id, null, invalid_chars[1], &columns, &rows),
        owner.drawGrid(id, null, invalid_chars[2], &columns, &rows),
        owner.drawGrid(id, null, grid, &.{ 0, 0 }, &rows),
        owner.drawGrid(id, null, grid, &columns, &.{ 2, 1 }),
        owner.drawGrid(id, null, grid, &long_offsets, &rows),
        owner.drawPackedBuffer(id, null, packed_bytes[0 .. packed_bytes.len - 1], 0, 0, 2, 1),
        owner.drawPackedBuffer(id, null, packed_bytes, 0, 0, 2, 1),
        owner.drawSuperSampleBuffer(id, null, &pixels, 0, 0, 2, 16),
        owner.drawSuperSampleBuffer(id, null, &pixels, 0, 0, 1, 0),
        owner.drawSuperSampleBuffer(id, null, &pixels, 0, 0, 1, 6),
        owner.drawSuperSampleBuffer(id, null, pixels[0..24], 0, 0, 1, 16),
        owner.drawGrayscaleBuffer(id, null, &.{ 1, 1, 1 }, 0, 0, 2, 2, null, null, false),
        owner.drawGrayscaleBuffer(id, null, &.{ 1, nan }, 0, 0, 2, 1, null, null, false),
        owner.drawGrayscaleBuffer(id, null, &.{ 1, 1 }, 0, 0, 2, 1, ansi.withMeta(red, 0x300), null, false),
    };
    for (results, 0..) |result, index| {
        errdefer std.debug.print("row {d}\n", .{index});
        try testing.expect(std.meta.isError(result));
    }
    for (target.buffer.char) |char| try testing.expectEqual(@as(u32, ' '), char);

    // Fewer than two offsets, or offsets wholly left of the buffer, draw nothing; leading
    // offsets left of column 0 do not shift the visible columns.
    try owner.drawGrid(id, null, grid, &.{0}, &rows);
    try owner.drawGrid(id, null, grid, &.{ -9, -5 }, &rows);
    for (target.buffer.char) |char| try testing.expectEqual(@as(u32, ' '), char);
    try owner.drawGrid(id, null, grid, &.{ -3, 0, 3 }, &rows);
    const shifted = target.buffer.char[0..12].*;
    try testing.expectEqual(@as(u32, '+'), shifted[0]);
    target.clear(black, null);
    try owner.drawGrid(id, null, grid, &.{ 0, 3 }, &rows);
    try testing.expectEqualSlices(u32, target.buffer.char, &shifted);
}

test "GPU primitive supersampling reads BGRA as RGBA with red and blue swapped" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const rgba = try owner.createBuffer(2, 1, .{});
    const bgra = try owner.createBuffer(2, 1, .{});
    // Two cells of 2x2 pixels, one row of them short: missing neighbors are transparent.
    const rgba_pixels = [_]u8{ 250, 10, 30, 255, 20, 200, 40, 255, 5, 6, 220, 255, 90, 80, 70, 128 };
    var bgra_pixels = rgba_pixels;
    for (0..4) |pixel| std.mem.swap(u8, &bgra_pixels[pixel * 4], &bgra_pixels[pixel * 4 + 2]);
    try owner.drawSuperSampleBuffer(rgba, null, &rgba_pixels, 0, 0, 1, 16);
    try owner.drawSuperSampleBuffer(bgra, null, &bgra_pixels, 0, 0, 0, 16);
    const expected = try owner.raw().getBuffer(rgba);
    const actual = try owner.raw().getBuffer(bgra);
    try testing.expectEqualSlices(u32, expected.buffer.char, actual.buffer.char);
    try testing.expectEqualDeep(expected.buffer.fg, actual.buffer.fg);
    try testing.expectEqualDeep(expected.buffer.bg, actual.buffer.bg);
    try testing.expect(expected.buffer.char[0] != ' ');
}

test "GPU primitive supersampling never samples the next row as a right neighbor" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const target = try owner.raw().getBuffer(try owner.createBuffer(1, 1, .{}));
    const expected = try owner.raw().getBuffer(try owner.createBuffer(1, 1, .{}));
    target.clear(black, null);
    expected.clear(black, null);
    const narrow = [_]u8{ 255, 255, 255, 255, 0, 0, 0, 255 };
    const padded = [_]u8{ 255, 255, 255, 255, 255, 0, 255, 0, 0, 0, 0, 255, 255, 0, 255, 0 };
    target.drawSuperSampleBuffer(0, 0, &narrow, narrow.len, 1, 4);
    expected.drawSuperSampleBuffer(0, 0, &padded, padded.len, 1, 8);
    try testing.expectEqualDeep(expected.get(0, 0).?, target.get(0, 0).?);
}
