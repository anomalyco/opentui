const std = @import("std");
const testing = std.testing;
const context = @import("../context.zig");
const gp = @import("../grapheme.zig");
const ansi = @import("../ansi.zig");
const utf8 = @import("../utf8.zig");
const scene = @import("../scene.zig");
const foreground = ansi.rgbColor(255, 255, 255, 255);
const background = ansi.rgbColor(0, 0, 0, 255);

test "Context drawing preserves indexed and default color intent" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const target = try owner.createBuffer(256, 2, .{});
    const value = try owner.getBuffer(target);
    const default = ansi.defaultColor(11, 22, 33, 255);
    const indexed = ansi.indexedColor(255, 44, 55, 66);
    try owner.clearBuffer(target, default);
    try testing.expectEqualDeep(default, value.get(255, 1).?.bg);
    try owner.fillBufferRect(target, 0, 1, 256, 1, indexed);
    try testing.expectEqualDeep(indexed, value.get(255, 1).?.bg);
    for (0..256) |slot| {
        const color = ansi.indexedColor(@intCast(slot), 12, 34, 56);
        try owner.drawBuffer(target, null, .{ .operation = .cell, .x = @intCast(slot), .foreground = default, .background = color }, "", "");
        try testing.expectEqualDeep(default, value.get(@intCast(slot), 0).?.fg);
        try testing.expectEqualDeep(color, value.get(@intCast(slot), 0).?.bg);
    }
    try owner.drawBufferText(target, "text", 0, 1, indexed, default, 0);
    try testing.expectEqualDeep(indexed, value.get(0, 1).?.fg);
    try testing.expectEqualDeep(default, value.get(0, 1).?.bg);
    const encoded = try owner.createUnicode("e\u{301}", .unicode);
    try owner.drawBufferUnicode(target, null, encoded, 0, 4, 1, indexed, default, 0);
    try testing.expectEqualDeep(indexed, value.get(4, 1).?.fg);
    try testing.expectEqualDeep(default, value.get(4, 1).?.bg);
    try value.drawGraphemeChecked("e\u{301}", 1, 5, 1, indexed, default, 0);
    try testing.expectEqualDeep(indexed, value.get(5, 1).?.fg);
    try testing.expectEqualDeep(default, value.get(5, 1).?.bg);
    try owner.drawGrayscaleBuffer(target, null, &.{1}, 6, 1, 1, 1, indexed, default, false);
    try testing.expectEqualDeep(indexed, value.get(6, 1).?.fg);
    try testing.expectEqualDeep(default, value.get(6, 1).?.bg);
}

test "Context encoded Unicode owns display cells until explicit destruction" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const peer = try context.Context.init(testing.allocator, testing.io, .{});
    defer peer.deinit() catch unreachable;
    const encoded = try owner.createUnicode("A\u{4e2d}e\u{301}\t", .unicode);
    const data = (try owner.getUnicode(encoded)).chars;
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
    try testing.expectError(error.WrongContext, peer.getUnicode(encoded));
    try testing.expectError(error.WrongKind, owner.getUnicode(target));
    try testing.expectError(error.WrongContext, peer.drawBufferUnicode(target, null, encoded, 1, 0, 0, foreground, background, 0));
    try testing.expectError(error.WrongContext, owner.drawBufferUnicode(target, null, foreign, 0, 0, 0, foreground, background, 0));
    try testing.expectError(error.InvalidOptions, owner.drawBufferUnicode(target, null, encoded, 4, 0, 0, foreground, background, 0));
    try testing.expectError(error.InvalidOptions, owner.drawBufferUnicode(target, null, encoded, 1, 0, 0, foreground, background, 0x100));
    try owner.drawBufferUnicode(target, null, encoded, 1, 0, 0, foreground, background, 0);
    try testing.expect(gp.isContinuationChar((try owner.getBuffer(target)).get(1, 0).?.char));
    try testing.expectEqual(@as(u32, 2), try owner.graphemes.getRefcount(id));
    try owner.destroy(encoded);
    try testing.expectError(error.StaleHandle, owner.getUnicode(encoded));
    try testing.expectEqualStrings("\u{4e2d}", try owner.graphemes.get(id));
    try owner.destroy(target);
    try testing.expectError(error.InvalidId, owner.graphemes.get(id));
    const empty = try owner.createUnicode("", .unicode);
    try testing.expectEqual(@as(usize, 0), (try owner.getUnicode(empty)).chars.len);
    try testing.expect(encoded.generation != empty.generation or encoded.slot != empty.slot);
}

test "Context encoded Unicode preserves width modes and rejects invalid input without publishing" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    inline for (std.meta.tags(utf8.WidthMethod)) |method| {
        const encoded = try owner.createUnicode("\u{301}A\u{1f469}\u{200d}\u{1f4bb}B", method);
        const data = (try owner.getUnicode(encoded)).chars;
        try testing.expectEqual(@as(u32, 'A'), data[0].char);
        try testing.expectEqual(@as(u32, 'B'), data[data.len - 1].char);
        for (data) |cell| try testing.expect(cell.width > 0);
        try owner.destroy(encoded);
    }
    try testing.expectError(error.InvalidUnicode, owner.createUnicode("\xff", .unicode));
    try testing.expectError(error.InvalidUnicode, owner.createUnicode("\x1b", .unicode));
    try testing.expectError(error.TextLimit, owner.createUnicode("e" ++ ("\u{301}" ** 64), .unicode));
    try testing.expectError(error.TextLimit, owner.createUnicode("x" ** 65537, .unicode));
    try testing.expectEqual(@as(u32, 0), owner.objects.live_count);
    try testing.expectEqual(@as(u32, 0), owner.graphemes.interned_live_ids.count());
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
    const value = try owner.getBuffer(target);
    const before = value.buffer.char[0..2].*;
    const glyph = gp.graphemeIdFromChar((try owner.getUnicode(encoded)).chars[0].char);
    failing.fail_index = failing.alloc_index;
    try testing.expectError(error.OutOfMemory, owner.drawBufferUnicode(target, null, encoded, 0, 0, 0, foreground, background, 0));
    failing.fail_index = std.math.maxInt(usize);
    try testing.expectEqualSlices(u32, &before, value.buffer.char);
    try testing.expectEqual(@as(u32, 1), try owner.graphemes.getRefcount(glyph));
    try owner.drawBufferUnicode(target, null, encoded, 0, 0, 0, foreground, background, 0);
    try testing.expectEqual(@as(u32, 2), try owner.graphemes.getRefcount(glyph));
}

test "Context encoded Unicode clips the whole display span before drawing" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const target = try owner.createBuffer(4, 1, .{});
    const value = try owner.getBuffer(target);
    const encoded = try owner.createUnicode("\u{4e2d}", .unicode);
    try owner.drawBufferText(target, "ABCD", 0, 0, foreground, background, 0);
    const outside = value.get(2, 0).?;
    try value.pushScissorRect(1, 0, 1, 1);
    try owner.drawBufferUnicode(target, null, encoded, 0, 1, 0, foreground, background, 0);
    value.popScissorRect();
    try testing.expectEqualDeep(outside, value.get(2, 0).?);
    try testing.expectEqualSlices(u32, &.{ 'A', 'B', 'C', 'D' }, value.buffer.char);
    try owner.drawBufferUnicode(target, null, encoded, 0, 3, 0, foreground, background, 0);
    try testing.expectEqualSlices(u32, &.{ 'A', 'B', 'C', 'D' }, value.buffer.char);
    try value.pushScissorRect(1, 0, 2, 1);
    try owner.drawBufferUnicode(target, null, encoded, 0, 1, 0, foreground, background, 0);
    value.popScissorRect();
    try testing.expect(gp.isGraphemeChar(value.get(1, 0).?.char));
    try testing.expect(gp.isContinuationChar(value.get(2, 0).?.char));
}

test "Context synchronous text drawing reports failed preparation without retaining mutation authority" {
    inline for ([_]bool{ false, true }) |is_editor| {
        const draw = if (is_editor) context.Context.drawEditorView else context.Context.drawSceneText;
        const owner = try context.Context.init(testing.allocator, testing.io, .{});
        defer owner.deinit() catch unreachable;
        const session = try owner.createSession(.{});
        try owner.attachSessionRenderer(session, 4, 1, .{ .remote_mode = .remote });
        _ = try owner.sceneCreateNode(session, 0, 1);
        const node = try owner.sceneCreateNode(session, 2, 2);
        const edit = try owner.createEditBuffer(.unicode);
        const source = if (is_editor) try owner.createEditorView(edit, 4, 1) else node;
        const view = if (is_editor) (try owner.getEditorView(source)).view.getTextBufferView() else (try owner.getRenderable(node)).scene_node.?.text.?.view;
        if (is_editor) try owner.editSetText(edit, "text", false) else try owner.sceneSetText(node, "text");
        const target = try owner.createBuffer(4, 1, .{});
        try draw(owner, target, null, source, 0, 0);
        try owner.clearBuffer(target, background);
        const arena = view.virtual_lines_arena;
        _ = arena.reset(.free_all);
        const allocator = arena.child_allocator;
        var failing = testing.FailingAllocator.init(allocator, .{ .fail_index = 0 });
        arena.child_allocator = failing.allocator();
        defer arena.child_allocator = allocator;
        view.virtual_lines_dirty = true;
        try testing.expectError(error.OutOfMemory, draw(owner, target, null, source, 0, 0));
        try testing.expect(!owner.mutating);
        try testing.expectEqual(@as(u32, ' '), (try owner.getBuffer(target)).get(0, 0).?.char);
        arena.child_allocator = allocator;
        try draw(owner, target, null, source, 0, 0);
        try testing.expectEqual(@as(u32, 't'), (try owner.getBuffer(target)).get(0, 0).?.char);
    }
}

test "Context editor background fill clips large extents and negative origins before narrowing" {
    const cases = [_]struct {
        x: i32,
        y: i32,
        width: u32,
        height: u32,
        columns: [2]u32,
        rows: [2]u32,
    }{
        .{ .x = 2, .y = 0, .width = std.math.maxInt(i32), .height = 1, .columns = .{ 2, 8 }, .rows = .{ 0, 1 } },
        .{ .x = 2, .y = 2, .width = 1, .height = std.math.maxInt(i32), .columns = .{ 2, 3 }, .rows = .{ 2, 4 } },
        .{ .x = 2, .y = 0, .width = 3, .height = 1, .columns = .{ 2, 5 }, .rows = .{ 0, 1 } },
        .{ .x = -2, .y = 0, .width = 5, .height = 1, .columns = .{ 0, 3 }, .rows = .{ 0, 1 } },
        .{ .x = -2, .y = -2, .width = 5, .height = 5, .columns = .{ 0, 3 }, .rows = .{ 0, 3 } },
        .{ .x = -2, .y = 0, .width = 2, .height = 1, .columns = .{ 0, 0 }, .rows = .{ 0, 1 } },
        .{ .x = std.math.minInt(i32), .y = 0, .width = std.math.maxInt(i32), .height = 1, .columns = .{ 0, 0 }, .rows = .{ 0, 1 } },
        .{ .x = 0, .y = 0, .width = 0, .height = 0, .columns = .{ 0, 0 }, .rows = .{ 0, 0 } },
    };
    const owner = try context.Context.init(testing.allocator, testing.io, .{ .object_capacity = 3, .render_cells_max = 32 });
    defer owner.deinit() catch unreachable;
    const edit = try owner.createEditBuffer(.unicode);
    const color = ansi.rgbColor(80, 120, 160, 255);
    (try owner.getEditBuffer(edit)).buffer.getTextBuffer().setDefaultBg(color);
    try owner.editSetText(edit, "x", false);
    for (cases, 0..) |case, index| {
        const view = try owner.createEditorView(edit, case.width, case.height);
        defer owner.destroy(view) catch unreachable;
        const target = try owner.createBuffer(8, if (case.height > 1) 4 else 1, .{});
        defer owner.destroy(target) catch unreachable;
        const buffer = try owner.getBuffer(target);
        buffer.clear(background, null);
        try owner.drawEditorView(target, null, view, case.x, case.y);
        if (index == 0) try testing.expectEqual(@as(u32, 'x'), buffer.get(2, 0).?.char);
        for (buffer.buffer.bg, 0..) |actual, cell| {
            const column = cell % 8;
            const row = cell / 8;
            const filled = column >= case.columns[0] and column < case.columns[1] and row >= case.rows[0] and row < case.rows[1];
            try testing.expectEqualDeep(if (filled) color else background, actual);
        }
    }
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
    const value = try owner.getBuffer(target);
    const glyph = gp.graphemeIdFromChar(value.get(1, 0).?.char);
    try owner.destroy(terminal);
    try testing.expectError(error.StaleHandle, owner.embeddedTerminalWrite(terminal, "stale"));
    try testing.expectEqualStrings("\u{4e2d}", try owner.graphemes.get(glyph));
}

test "Context embedded terminal rejects dimensions and stale generations before mutation" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{ .render_cells_max = 8, .object_capacity = 2 });
    defer owner.deinit() catch unreachable;
    try testing.expectError(error.InvalidDimensions, owner.createEmbeddedTerminal(0, 1, 0));
    try testing.expectError(error.InvalidDimensions, owner.createEmbeddedTerminal(3, 3, 0));
    const id = try owner.createEmbeddedTerminal(4, 2, 0);
    try testing.expectError(error.InvalidDimensions, owner.embeddedTerminalResize(id, 3, 3));
    try testing.expectEqual(@as(u16, 4), (try owner.getEmbeddedTerminal(id)).cols);
    try owner.destroy(id);
    const replacement = try owner.createEmbeddedTerminal(4, 2, 0);
    try testing.expectEqual(id.slot, replacement.slot);
    try testing.expect(id.generation != replacement.generation);
    try testing.expectError(error.StaleHandle, owner.getEmbeddedTerminal(id));
    try testing.expectError(error.StaleHandle, owner.destroy(id));
    const encoded = try owner.createUnicode("A", .unicode);
    try testing.expectError(error.ObjectLimit, owner.createEmbeddedTerminal(1, 1, 0));
    try testing.expectError(error.ObjectLimit, owner.createUnicode("B", .unicode));
    try owner.destroy(encoded);
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

test "Context embedded terminal output sizing and rejection preserve mouse motion retry" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const owner = try context.Context.init(failing.allocator(), testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createEmbeddedTerminal(8, 3, 0);
    try owner.embeddedTerminalWrite(id, "\x1b[?1003h\x1b[?1006h");
    var output: [32]u8 = @splat('X');
    const mouse: context.EmbeddedTerminalMouse = .{ .action = 2, .x = 1, .y = 1 };
    const required = try owner.embeddedTerminalEncodeMouse(id, mouse, &.{});
    try testing.expect(required > 0);
    try testing.expectError(error.BufferTooSmall, owner.embeddedTerminalEncodeMouse(id, mouse, output[0..1]));
    try testing.expectEqual(@as(u8, 'X'), output[0]);
    failing.fail_index = failing.alloc_index;
    try testing.expectError(error.OutOfMemory, owner.embeddedTerminalEncodeMouse(id, mouse, &output));
    failing.fail_index = std.math.maxInt(usize);
    try testing.expectEqual(required, try owner.embeddedTerminalEncodeMouse(id, mouse, &output));
    try testing.expectEqualStrings("\x1b[<35;2;2M", output[0..required]);
    try testing.expectEqual(@as(u32, 0), try owner.embeddedTerminalEncodeMouse(id, mouse, &output));
    try testing.expectError(error.InvalidOptions, owner.embeddedTerminalEncodeMouse(id, .{ .action = 2, .x = std.math.nan(f32), .y = 1 }, &output));
    try testing.expectError(error.InvalidOptions, owner.embeddedTerminalEncodeKey(id, .{ .mods = 64 }, &output));
    try testing.expectError(error.InvalidOptions, owner.embeddedTerminalSetSelection(id, 8, 0, 0, 0));
    try testing.expectError(error.InvalidDimensions, owner.embeddedTerminalResize(id, 65536, 1));
    try testing.expectError(error.TextLimit, owner.embeddedTerminalWrite(id, "x" ** (context.terminal_input_bytes_max + 1)));
    try testing.expect(!owner.mutating);
}

test "Context embedded terminal clamps extreme outside releases before coordinate conversion" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createEmbeddedTerminal(8, 3, 0);
    try owner.embeddedTerminalWrite(id, "\x1b[?1000h\x1b[?1006h");
    var output: [64]u8 = undefined;
    const count = try owner.embeddedTerminalEncodeMouse(id, .{ .action = 1, .button = 1, .x = 65536, .y = 65536 }, &output);
    try testing.expectEqualStrings("\x1b[<0;8;3m", output[0..count]);
    try testing.expectEqual(@as(u32, 0), try owner.embeddedTerminalEncodeMouse(id, .{ .action = 0, .button = 1, .x = 65536, .y = 65536 }, &output));
    const negative = try owner.embeddedTerminalEncodeMouse(id, .{ .action = 1, .button = 1, .x = -1e30, .y = -1e30 }, &output);
    try testing.expectEqualStrings("\x1b[<0;1;1m", output[0..negative]);
}

test "Context embedded terminal rejects unencodable UTF8 mouse coordinates" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createEmbeddedTerminal(65535, 1, 0);
    try owner.embeddedTerminalWrite(id, "\x1b[?1000h\x1b[?1005h");
    var output: [64]u8 = @splat('X');
    try testing.expectError(error.InvalidOptions, owner.embeddedTerminalEncodeMouse(id, .{ .action = 1, .button = 1, .x = 55263, .y = 0 }, &output));
    try testing.expectEqual(@as(u8, 'X'), output[0]);
    const count = try owner.embeddedTerminalEncodeMouse(id, .{ .action = 1, .button = 1, .x = 1, .y = 0 }, &output);
    try testing.expect(count > 0);
    const tall = try owner.createEmbeddedTerminal(1, 65535, 0);
    try owner.embeddedTerminalWrite(tall, "\x1b[?1000h\x1b[?1005h");
    try testing.expectError(error.InvalidOptions, owner.embeddedTerminalEncodeMouse(tall, .{ .action = 1, .button = 1, .x = 0, .y = 65534 }, &output));
}

test "Context embedded terminal VT column modes cannot resize the caller viewport" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{ .render_cells_max = 24 });
    defer owner.deinit() catch unreachable;
    const id = try owner.createEmbeddedTerminal(8, 3, 0);
    const target = try owner.createBuffer(8, 3, .{});
    const terminal = try owner.getEmbeddedTerminal(id);
    for ([_][]const u8{ "\x1b[?40h\x1b[?3h", "\x1b[?3l", "\x1b[?3s\x1b[?3h\x1b[?3r", "\x1bc\x1b[?40;3h" }) |input| {
        try owner.embeddedTerminalWrite(id, input);
        try testing.expectEqual(@as(u16, 8), terminal.terminal.cols);
        try testing.expectEqual(@as(u16, 3), terminal.terminal.rows);
        try owner.embeddedTerminalWrite(id, "\x1b[Husable");
        try owner.embeddedTerminalCompose(id, target, null, 0, 0);
        try testing.expectEqual(@as(u32, 'u'), (try owner.getBuffer(target)).get(0, 0).?.char);
    }
    try owner.embeddedTerminalResize(id, 6, 4);
    try testing.expectEqual(@as(u16, 6), terminal.terminal.cols);
    try testing.expectEqual(@as(u16, 4), terminal.terminal.rows);
}
