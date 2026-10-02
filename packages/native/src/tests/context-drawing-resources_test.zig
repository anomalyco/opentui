const std = @import("std");
const testing = std.testing;
const context = @import("../context.zig");
const gp = @import("../grapheme.zig");
const ansi = @import("../ansi.zig");
const foreground = ansi.rgbColor(255, 255, 255, 255);
const background = ansi.rgbColor(0, 0, 0, 255);

test "Context encoded Unicode owns display cells until explicit destruction" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const peer = try context.Context.init(testing.allocator, testing.io, .{});
    defer peer.deinit() catch unreachable;
    const encoded = try owner.createUnicode("A\u{4e2d}e\u{301}\t", .unicode);
    const data = (try owner.raw().getUnicode(encoded)).chars;
    try testing.expectEqual(@as(usize, 4), data.len);
    try testing.expectEqual(@as(u32, 'A'), data[0].char);
    try testing.expectEqual(@as(u8, 2), data[1].width);
    try testing.expectEqual(@as(u8, 1), data[2].width);
    try testing.expectEqual(@as(u8, 2), data[3].width);
    const id = gp.graphemeIdFromChar(data[1].char);
    try testing.expectEqualStrings("\u{4e2d}", try owner.graphemes.get(id));
    try testing.expectEqual(@as(u32, 1), try owner.graphemes.getRefcount(id));
    const target = try owner.createBuffer(6, 1, .{});
    const foreign = try peer.createUnicode("\u{8a9e}", .unicode);
    try testing.expectError(error.WrongContext, peer.raw().getUnicode(encoded));
    try testing.expectError(error.WrongKind, owner.raw().getUnicode(target));
    try testing.expectError(error.WrongContext, peer.drawBufferUnicode(target, null, encoded, 1, 0, 0, foreground, background, 0));
    try testing.expectError(error.WrongContext, owner.drawBufferUnicode(target, null, foreign, 0, 0, 0, foreground, background, 0));
    try testing.expectError(error.InvalidOptions, owner.drawBufferUnicode(target, null, encoded, 4, 0, 0, foreground, background, 0));
    try testing.expectError(error.InvalidOptions, owner.drawBufferUnicode(target, null, encoded, 1, 0, 0, foreground, background, 0x100));
    try owner.drawBufferUnicode(target, null, encoded, 1, 0, 0, foreground, background, 0);
    try testing.expect(gp.isContinuationChar((try owner.raw().getBuffer(target)).get(1, 0).?.char));
    try testing.expectEqual(@as(u32, 2), try owner.graphemes.getRefcount(id));
    try owner.destroy(encoded);
    try testing.expectError(error.StaleHandle, owner.raw().getUnicode(encoded));
    try testing.expectEqualStrings("\u{4e2d}", try owner.graphemes.get(id));
    try owner.destroy(target);
    try testing.expectError(error.InvalidId, owner.graphemes.get(id));
    const empty = try owner.createUnicode("", .unicode);
    try testing.expectEqual(@as(usize, 0), (try owner.raw().getUnicode(empty)).chars.len);
    try testing.expect(encoded.generation != empty.generation or encoded.slot != empty.slot);
}

test "Context encoded Unicode releases every provisional allocation" {
    const Probe = struct {
        fn run(allocator: std.mem.Allocator) !void {
            const owner = try context.Context.init(allocator, testing.io, .{ .object_capacity = 4 });
            defer owner.deinit() catch unreachable;
            const encoded = try owner.createUnicode("\u{4e2d}e\u{301}\u{4e2d}", .unicode);
            const target = try owner.createBuffer(5, 1, .{});
            try owner.drawBufferUnicode(target, null, encoded, 0, 0, 0, foreground, background, 0);
        }
    };
    try testing.checkAllAllocationFailures(testing.allocator, Probe.run, .{});
}

test "Context encoded Unicode drawing rejection preserves cells and producer references" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const owner = try context.Context.init(failing.allocator(), testing.io, .{});
    defer owner.deinit() catch unreachable;
    const encoded = try owner.createUnicode("\u{4e2d}", .unicode);
    const target = try owner.createBuffer(2, 1, .{});
    const value = try owner.raw().getBuffer(target);
    const before = value.buffer.char[0..2].*;
    const glyph = gp.graphemeIdFromChar((try owner.raw().getUnicode(encoded)).chars[0].char);
    failing.fail_index = failing.alloc_index;
    try testing.expectError(error.OutOfMemory, owner.drawBufferUnicode(target, null, encoded, 0, 0, 0, foreground, background, 0));
    failing.fail_index = std.math.maxInt(usize);
    try testing.expectEqualSlices(u32, &before, value.buffer.char);
    try testing.expectEqual(@as(u32, 1), try owner.graphemes.getRefcount(glyph));
    try owner.drawBufferUnicode(target, null, encoded, 0, 0, 0, foreground, background, 0);
    try testing.expectEqual(@as(u32, 2), try owner.graphemes.getRefcount(glyph));
}

test "Context embedded terminal owns parsing and retains composed glyphs after teardown" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const terminal = try owner.createEmbeddedTerminal(8, 3, 4096);
    const target = try owner.createBuffer(8, 3, .{});
    try owner.embeddedTerminalWrite(terminal, "A\u{4e2d}B\x1b[6n");
    var bytes: [64]u8 = undefined;
    const count = try owner.embeddedTerminalDrainResponses(terminal, &bytes);
    try testing.expectEqualStrings("\x1b[1;5R", bytes[0..count]);
    try owner.embeddedTerminalSetSelection(terminal, 0, 0, 3, 0);
    const selected = try owner.embeddedTerminalGetSelectedText(terminal, &bytes);
    try testing.expectEqualStrings("A\u{4e2d}B", bytes[0..selected]);
    try owner.embeddedTerminalCompose(terminal, target, null, 0, 0);
    const value = try owner.raw().getBuffer(target);
    const glyph = gp.graphemeIdFromChar(value.get(1, 0).?.char);
    try owner.destroy(terminal);
    try testing.expectError(error.StaleHandle, owner.embeddedTerminalWrite(terminal, "stale"));
    try testing.expectEqualStrings("\u{4e2d}", try owner.graphemes.get(glyph));
}

test "Context embedded terminal releases failed construction" {
    const Probe = struct {
        fn run(allocator: std.mem.Allocator) !void {
            const owner = try context.Context.init(allocator, testing.io, .{ .object_capacity = 4 });
            defer owner.deinit() catch unreachable;
            _ = try owner.createEmbeddedTerminal(8, 3, 4096);
        }
    };
    try testing.checkAllAllocationFailures(testing.allocator, Probe.run, .{});
}

test "Context embedded terminal VT column modes cannot resize the caller viewport" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{ .render_cells_max = 24 });
    defer owner.deinit() catch unreachable;
    const id = try owner.createEmbeddedTerminal(8, 3, 0);
    const target = try owner.createBuffer(8, 3, .{});
    const terminal = try owner.raw().getEmbeddedTerminal(id);
    for ([_][]const u8{ "\x1b[?40h\x1b[?3h", "\x1b[?3l", "\x1b[?3s\x1b[?3h\x1b[?3r", "\x1bc\x1b[?40;3h" }) |input| {
        try owner.embeddedTerminalWrite(id, input);
        try testing.expectEqual(@as(u16, 8), terminal.terminal.cols);
        try testing.expectEqual(@as(u16, 3), terminal.terminal.rows);
        try owner.embeddedTerminalWrite(id, "\x1b[Husable");
        try owner.embeddedTerminalCompose(id, target, null, 0, 0);
        try testing.expectEqual(@as(u32, 'u'), (try owner.raw().getBuffer(target)).get(0, 0).?.char);
    }
    try owner.embeddedTerminalResize(id, 6, 4);
    try testing.expectEqual(@as(u16, 6), terminal.terminal.cols);
    try testing.expectEqual(@as(u16, 4), terminal.terminal.rows);
}
