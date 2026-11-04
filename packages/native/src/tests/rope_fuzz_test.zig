const std = @import("std");
const rope_mod = @import("../rope.zig");

const TestItem = struct {
    value: u32,

    pub fn empty() TestItem {
        return .{ .value = 0 };
    }

    pub fn is_empty(self: *const TestItem) bool {
        return self.value == 0;
    }
};

fn verifyInvariants(rope: *const rope_mod.Rope(TestItem)) !void {
    const count = rope.count();

    var walked_count: u32 = 0;
    const Context = struct {
        count: *u32,
        last_seen: u32 = 0,

        fn walker(ctx: *anyopaque, data: *const TestItem, index: u32) rope_mod.Rope(TestItem).Node.WalkerResult {
            _ = index;
            _ = data;
            const self = @as(*@This(), @ptrCast(@alignCast(ctx)));
            self.count.* += 1;
            return .{};
        }
    };

    var ctx: Context = .{ .count = &walked_count };
    try rope.walk(&ctx, Context.walker);

    try std.testing.expectEqual(count, walked_count);

    // Verify depth is logarithmic (allow slack for imbalance and sequential inserts)
    const depth = rope.root.depth();
    const max_expected_depth: u32 = if (count <= 1) 1 else @as(u32, @intFromFloat(@ceil(@log2(@as(f64, @floatFromInt(count)))) * 4.5));
    try std.testing.expect(depth <= max_expected_depth);
}

test "Rope fuzz - random insert/delete sequence" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(TestItem);
    var rope = try RopeType.init(arena.allocator());

    var prng = std.Random.DefaultPrng.init(42);
    const random = prng.random();

    var i: usize = 0;
    while (i < 100) : (i += 1) {
        const op = random.intRangeAtMost(u8, 0, 2);
        const current_count = rope.count();

        switch (op) {
            0 => {
                const pos = if (current_count > 0) random.intRangeAtMost(u32, 0, current_count) else 0;
                const value = random.int(u32);
                try rope.insert(pos, .{ .value = value });
            },
            1 => {
                if (current_count > 1) {
                    const pos = random.intRangeAtMost(u32, 0, current_count - 1);
                    try rope.delete(pos);
                }
            },
            2 => {
                if (current_count > 0) {
                    const pos = random.intRangeAtMost(u32, 0, current_count - 1);
                    const value = random.int(u32);
                    try rope.replace(pos, .{ .value = value });
                }
            },
            else => unreachable,
        }

        if (i % 10 == 0) {
            try verifyInvariants(&rope);
        }
    }

    try verifyInvariants(&rope);
}

test "Rope fuzz - random bulk operations" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(TestItem);
    var rope = try RopeType.init(arena.allocator());

    var prng = std.Random.DefaultPrng.init(123);
    const random = prng.random();

    var i: usize = 0;
    while (i < 50) : (i += 1) {
        const op = random.intRangeAtMost(u8, 0, 3);
        const current_count = rope.count();

        switch (op) {
            0 => {
                const slice_len = random.intRangeAtMost(u8, 1, 10);
                var items: [10]TestItem = undefined;
                for (items[0..slice_len]) |*item| {
                    item.* = .{ .value = random.int(u32) };
                }
                const pos = if (current_count > 0) random.intRangeAtMost(u32, 0, current_count) else 0;
                try rope.insert_slice(pos, items[0..slice_len]);
            },
            1 => {
                if (current_count > 2) {
                    const start = random.intRangeAtMost(u32, 0, current_count - 2);
                    const end = random.intRangeAtMost(u32, start + 1, current_count);
                    try rope.delete_range(start, end);
                }
            },
            2 => {
                if (current_count > 1) {
                    const split_pos = random.intRangeAtMost(u32, 1, current_count - 1);
                    var right_half = try rope.split(split_pos);
                    try rope.concat(&right_half);
                }
            },
            3 => {
                const new_len = random.intRangeAtMost(u8, 1, 5);
                var items: [5]TestItem = undefined;
                for (items[0..new_len]) |*item| {
                    item.* = .{ .value = random.int(u32) };
                }
                const new_rope = try RopeType.from_slice(arena.allocator(), items[0..new_len]);
                try rope.concat(&new_rope);
            },
            else => unreachable,
        }

        if (i % 5 == 0) {
            try verifyInvariants(&rope);
        }
    }

    try verifyInvariants(&rope);
}

test "Rope fuzz - stress test with many items" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(TestItem);
    var rope = try RopeType.init(arena.allocator());

    var i: u32 = 0;
    while (i < 1000) : (i += 1) {
        try rope.append(.{ .value = i });
    }

    try verifyInvariants(&rope);

    var prng = std.Random.DefaultPrng.init(789);
    const random = prng.random();

    var j: usize = 0;
    while (j < 200) : (j += 1) {
        const op = random.intRangeAtMost(u8, 0, 1);
        const current_count = rope.count();

        switch (op) {
            0 => {
                if (current_count > 100) {
                    const pos = random.intRangeAtMost(u32, 0, current_count - 1);
                    try rope.delete(pos);
                }
            },
            1 => {
                const pos = random.intRangeAtMost(u32, 0, current_count);
                try rope.insert(pos, .{ .value = random.int(u32) });
            },
            else => unreachable,
        }
    }

    try verifyInvariants(&rope);

    const depth = rope.root.depth();
    const count = rope.count();
    const max_expected_depth: u32 = @intFromFloat(@ceil(@log2(@as(f64, @floatFromInt(count)))) * 4.0);
    try std.testing.expect(depth <= max_expected_depth);
}

test "Rope fuzz - positional operations" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(TestItem);
    var rope = try RopeType.init(arena.allocator());

    var i: u32 = 0;
    while (i < 50) : (i += 1) {
        try rope.append(.{ .value = i });
    }

    var prng = std.Random.DefaultPrng.init(456);
    const random = prng.random();

    var position: u32 = 25;

    var j: usize = 0;
    while (j < 30) : (j += 1) {
        const op = random.intRangeAtMost(u8, 0, 2);

        switch (op) {
            0 => {
                try rope.insert(position, .{ .value = random.int(u32) });
                position = position + 1;
            },
            1 => {
                if (position < rope.count()) {
                    try rope.delete(position);
                }
            },
            2 => {
                if (position < rope.count()) {
                    try rope.replace(position, .{ .value = random.int(u32) });
                }
            },
            else => unreachable,
        }

        if (random.boolean() and rope.count() > 0) {
            position = random.intRangeAtMost(u32, 0, rope.count() - 1);
        }
    }

    try verifyInvariants(&rope);
}

const TestPools = @import("test-pools.zig").TestPools;
const EditBuffer = @import("../edit-buffer.zig").EditBuffer;
const TextBuffer = @import("../text-buffer.zig").UnifiedTextBuffer;
const utf8 = @import("../utf8.zig");
const iter_mod = @import("../text-buffer-iterators.zig");
const text_work = @import("../text-work.zig");
const seg_mod = @import("../text-buffer-segment.zig");
const Segment = seg_mod.Segment;
const UnifiedRope = seg_mod.UnifiedRope;

/// Pieces that put breaks, zero-width, wide, and tab cells at chunk edges.
const text_pieces = [_][]const u8{ "a", "bc", "\t", "世", "e", "\u{0301}", "\u{200d}", "\u{200b}", "👍", "\u{1F3FD}", "\r", "\n", "\r\n", "\x01", "🇺", "🇸", "x\ty", "ab\ncd", "\n\n" };
/// Pieces whose widths do not depend on where chunks split, so edited text measures like fresh text.
const fresh_pieces = [_][]const u8{ "a", "bc", "\t", "世", "世界", "\u{200b}", "\n", "\r\n", "\n\r\n", "\n\n", "ab\ncd", "x\ty", "\x01", "", "\t\t" };

fn randomText(random: std.Random, pieces: []const []const u8, out: []u8) []const u8 {
    var len: usize = 0;
    for (0..random.uintAtMost(usize, 3)) |_| {
        const piece = pieces[random.uintLessThan(usize, pieces.len)];
        @memcpy(out[len..][0..piece.len], piece);
        len += piece.len;
    }
    return out[0..len];
}

/// Every line query of the edited buffer equals the same query on the text loaded as one chunk.
fn verifyEditedEqualsFresh(pools: *TestPools, tb: *TextBuffer, method: utf8.WidthMethod) !void {
    const text = try std.testing.allocator.alloc(u8, tb.getByteSize());
    defer std.testing.allocator.free(text);
    const fresh = try TextBuffer.initWithOptions(std.testing.allocator, &pools.graphemes, &pools.links, method, .{ .control_display = tb.controlDisplay() });
    defer fresh.deinit();
    fresh.setTabWidth(tb.tabWidth());
    try fresh.setText(text[0..tb.getPlainTextIntoBuffer(text)]);
    const rope = tb.rope();
    try std.testing.expectEqual(fresh.getLineCount(), tb.getLineCount());
    try std.testing.expectEqual(fresh.lineWidthColsMax(), tb.lineWidthColsMax());
    for (0..tb.getLineCount()) |row| {
        try std.testing.expectEqual(iter_mod.lineStart(fresh.rope(), @intCast(row)).?.weight, iter_mod.lineStart(rope, @intCast(row)).?.weight);
        try std.testing.expectEqual(fresh.lineWidthAt(@intCast(row)), tb.lineWidthAt(@intCast(row)));
    }
    try std.testing.expectEqual(fresh.textEndOffset(), tb.textEndOffset());
    for (0..tb.textEndOffset() + 2) |offset| {
        try std.testing.expectEqual(iter_mod.offsetToCoords(fresh.rope(), @intCast(offset)), iter_mod.offsetToCoords(rope, @intCast(offset)));
    }
    for (0..tb.getLength() + 2) |cell| {
        try std.testing.expectEqual(iter_mod.firstLineEndingAfter(fresh.rope(), @intCast(cell)), iter_mod.firstLineEndingAfter(rope, @intCast(cell)));
    }
}

/// Checks the line queries against positions found by walking every leaf.
fn verifyLineMetrics(tb: *TextBuffer) !void {
    const rope = tb.rope();
    const Walk = struct {
        starts: std.ArrayList(UnifiedRope.Position) = .empty,
        weight: u32 = 0,

        fn visit(ctx: *anyopaque, segment: *const Segment, index: u32) UnifiedRope.Node.WalkerResult {
            const walk: *@This() = @ptrCast(@alignCast(ctx));
            if (segment.isLineStart()) walk.starts.append(std.testing.allocator, .{ .leaf_index = index, .weight = walk.weight }) catch |err| return .{ .err = err };
            walk.weight += segment.measure().weight();
            return .{};
        }
    };
    var walk: Walk = .{};
    defer walk.starts.deinit(std.testing.allocator);
    try rope.walk(&walk, Walk.visit);
    const line_count = tb.getLineCount();
    try std.testing.expectEqual(walk.starts.items.len, line_count);
    try std.testing.expectEqual(rope.root.metrics().custom.newline_count + 1, line_count);
    try std.testing.expectEqual(null, iter_mod.lineStart(rope, line_count));
    var widest: u32 = 0;
    for (walk.starts.items, 0..) |start, row| {
        _ = text_work.take();
        try std.testing.expectEqual(start, iter_mod.lineStart(rope, @intCast(row)).?);
        try std.testing.expect(text_work.take().line_seek_nodes < rope.root.depth());
        widest = @max(widest, tb.lineWidthAt(@intCast(row)));
    }
    try std.testing.expectEqual(widest, tb.lineWidthColsMax());
    // An offset belongs to the last line that starts at or before it; a break ends its line.
    var row: u32 = 0;
    for (0..walk.weight + 1) |offset_index| {
        const offset: u32 = @intCast(offset_index);
        while (row + 1 < line_count and walk.starts.items[row + 1].weight <= offset) row += 1;
        const coords = iter_mod.offsetToCoords(rope, offset).?;
        try std.testing.expectEqual(iter_mod.Coords{ .row = row, .col = offset - walk.starts.items[row].weight }, coords);
        try std.testing.expectEqual(offset, iter_mod.coordsToOffset(rope, coords.row, coords.col).?);
    }
    try std.testing.expectEqual(null, iter_mod.offsetToCoords(rope, walk.weight + 1));
}

/// The shared leaf prefix and suffix of two roots equal a leaf-by-leaf pointer comparison.
fn verifySharedLeaves(previous: *const UnifiedRope, current: *const UnifiedRope) !void {
    const limit = @min(previous.count(), current.count());
    var prefix: u32 = 0;
    while (prefix < limit and previous.get(prefix).? == current.get(prefix).?) prefix += 1;
    var suffix: u32 = 0;
    while (suffix < limit - prefix and previous.get(previous.count() - 1 - suffix).? == current.get(current.count() - 1 - suffix).?) suffix += 1;
    try std.testing.expectEqual(prefix, current.sharedLeaves(previous.root, .start, limit).?);
    try std.testing.expectEqual(suffix, current.sharedLeaves(previous.root, .end, limit - prefix).?);
    try std.testing.expectEqual(suffix, previous.sharedLeaves(current.root, .end, limit - prefix).?);
}

fn runRandomEdits(pools: *TestPools, pieces: []const []const u8, compare_fresh: bool) !void {
    var bytes: [64]u8 = undefined;
    for (std.enums.values(utf8.WidthMethod)) |method| for (0..40) |seed| {
        const eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, method, null);
        defer eb.deinit();
        const tb = eb.getTextBuffer();
        var prng = std.Random.DefaultPrng.init(seed);
        const random = prng.random();
        for (0..60) |step| {
            errdefer std.debug.print("method {s} seed {d} step {d}\n", .{ @tagName(method), seed, step });
            const rows = tb.getLineCount();
            const row = random.uintLessThan(u32, rows);
            try eb.setCursor(row, random.uintAtMost(u32, tb.lineWidthAt(row)));
            const total = tb.textEndOffset();
            const a = random.uintAtMost(u32, total);
            const b = random.uintAtMost(u32, total);
            const ignore = struct {
                fn handle(_: *anyopaque) void {}
            };
            const previous = tb.rope().*;
            const op = random.uintLessThan(u8, 10);
            switch (op) {
                0 => try eb.setText(randomText(random, pieces, &bytes)),
                1, 2 => try eb.insertText(randomText(random, pieces, &bytes)),
                3 => try eb.backspace(),
                4 => try eb.deleteForward(),
                5 => {
                    const other = random.uintLessThan(u32, rows);
                    try eb.deleteRange(eb.getPrimaryCursor(), .{ .row = other, .col = random.uintAtMost(u32, tb.lineWidthAt(other)), .desired_col = 0, .offset = 0 });
                },
                // The buffer keeps appended bytes, so each append owns a copy.
                6 => try tb.appendWithOwnership(try std.testing.allocator.dupe(u8, randomText(random, pieces, &bytes)), true),
                7 => _ = eb.undo() catch |err| if (err != error.Stop) return err,
                8 => if (random.boolean()) {
                    _ = eb.redo() catch |err| if (err != error.Stop) return err;
                } else eb.setTabWidth(if (random.boolean()) 2 else 8),
                9 => try eb.replaceRange(@min(a, b), @max(a, b), randomText(random, pieces, &bytes), .{ .ctx = eb, .handle = ignore.handle }),
                else => unreachable,
            }
            try verifyLineMetrics(tb);
            // `setText` retires the arena that held the previous root.
            if (op != 0) try verifySharedLeaves(&previous, tb.rope());
            const cursor = eb.getPrimaryCursor();
            try std.testing.expectEqual(iter_mod.coordsToOffset(tb.rope(), cursor.row, cursor.col).?, cursor.offset);
            if (compare_fresh) try verifyEditedEqualsFresh(pools, tb, method);
        }
    };
}

test "Rope fuzz - text line queries match a walk under random edits" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    try runRandomEdits(&pools, &text_pieces, false);
}

test "Rope fuzz - edited text answers line queries like fresh text" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    try runRandomEdits(&pools, &fresh_pieces, true);
}

test "Rope fuzz - an insert next to zero-width pieces lands where it lands in one piece" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    // The marks follow "ab" or open the line; their pieces make tree shapes that one piece does not.
    for ([_][]const u8{ "\u{0301}", "\u{200b}" }) |mark| for ([_][]const u8{ "ab", "" }) |head| for (0..12) |count| for ([_]u32{ 0, 2, 4 }) |col| {
        errdefer std.debug.print("mark {any} head \"{s}\" count {d} col {d}\n", .{ mark, head, count, col });
        var text: std.ArrayList(u8) = .empty;
        defer text.deinit(std.testing.allocator);
        try text.appendSlice(std.testing.allocator, head);
        for (0..count) |_| try text.appendSlice(std.testing.allocator, mark);
        try text.appendSlice(std.testing.allocator, "cdef"[0 .. 4 - head.len]);
        var results: [2][64]u8 = undefined;
        var lens: [2]usize = undefined;
        for (0..2) |pieces| {
            const eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode, null);
            defer eb.deinit();
            if (pieces == 0) try eb.setText(text.items) else {
                try eb.setText(head);
                for (0..count) |_| try eb.getTextBuffer().append(mark);
                try eb.getTextBuffer().append("cdef"[0 .. 4 - head.len]);
            }
            try eb.setCursor(0, col);
            try eb.insertText("Z");
            lens[pieces] = eb.getText(&results[pieces]);
        }
        try std.testing.expectEqualStrings(results[0][0..lens[0]], results[1][0..lens[1]]);
    };
    // Marks typed at one place, with typing elsewhere between them, stay in typed order.
    const eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode, null);
    defer eb.deinit();
    try eb.setText("abc\ndef\nghi\njkl");
    for ([_][]const u8{ "\u{0300}", "\u{0301}", "\u{0302}" }, [_]u32{ 1, 0, 1 }) |mark, col| {
        try eb.setCursor(0, 3);
        try eb.insertText(mark);
        try eb.setCursor(1, col);
        try eb.insertText("x");
    }
    var out: [64]u8 = undefined;
    try std.testing.expectStringStartsWith(out[0..eb.getText(&out)], "abc\u{0300}\u{0301}\u{0302}\n");
}
