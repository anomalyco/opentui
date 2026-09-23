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
