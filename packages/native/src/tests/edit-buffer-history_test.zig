const std = @import("std");
const TestPools = @import("test-pools.zig").TestPools;
const edit_buffer = @import("../edit-buffer.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");

const EditBuffer = edit_buffer.EditBuffer;
const EditState = @import("edit-buffer-atomicity_test.zig").EditState;

comptime {
    _ = @import("edit-buffer-atomicity_test.zig");
}

test "EditBuffer - text replacements keep cursor undo metadata" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    const eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode, null);
    defer eb.deinit();
    const clean_id = try eb.setTextOwned("old\nabcdef", null);
    try eb.setCursor(1, 6);
    try eb.insertText("!");
    eb.moveUp();
    const cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 3), cursor.col);
    try std.testing.expectEqual(@as(u32, 7), cursor.desired_col);
    const slots = eb.tb.memRegistry().getUsedSlots();
    try eb.replaceText("\u{754c}\r\nx");
    try eb.replaceText("\u{754c}\r\nx");
    try std.testing.expectEqual(slots, eb.tb.memRegistry().getUsedSlots());
    var actual: [32]u8 = undefined;
    _ = try eb.undo();
    try std.testing.expectEqualStrings("\u{754c}\nx", actual[0..eb.getText(&actual)]);
    _ = try eb.undo();
    try std.testing.expectEqualStrings("old\nabcdef!", actual[0..eb.getText(&actual)]);
    try std.testing.expectEqualDeep(cursor, eb.getPrimaryCursor());
    _ = try eb.redo();
    _ = try eb.redo();
    try std.testing.expectEqualStrings("\u{754c}\nx", actual[0..eb.getText(&actual)]);
    try std.testing.expectEqualDeep(edit_buffer.Cursor{ .row = 0, .col = 0 }, eb.getPrimaryCursor());
    try std.testing.expectEqual(clean_id, try eb.setTextOwned("new", clean_id));
    try std.testing.expectEqual(@as(usize, 0), eb.add_buffer.len);
    try std.testing.expect(!eb.canUndo());
    try std.testing.expect(!eb.canRedo());
    try eb.insertText("X");
    _ = try eb.undo();
    try std.testing.expectEqualStrings("new", actual[0..eb.getText(&actual)]);
    _ = try eb.redo();
    try std.testing.expectEqualStrings("Xnew", actual[0..eb.getText(&actual)]);
}

test "EditBuffer - replacement failures preserve valid history at each phase" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    inline for (.{ false, true }) |history| {
        for ([_]bool{ false, true }) |fail_rope| {
            var succeeded = false;
            for (0..64) |offset| {
                var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
                const eb = try EditBuffer.init(failing.allocator(), &pool, &links, .unicode, null);
                defer eb.deinit();
                try eb.insertText("old");
                try eb.insertText("X");
                _ = try eb.undo();
                const before = EditState.capture(eb);
                const allocator = eb.tb.rope().allocator;
                var rope_failing = std.testing.FailingAllocator.init(allocator, .{});
                eb.tb.rope().allocator = rope_failing.allocator();
                const fault = if (fail_rope) &rope_failing else &failing;
                fault.fail_index = fault.alloc_index + offset;
                fault.resize_fail_index = fault.resize_index;
                const result = if (history) eb.replaceText("replacement") else eb.setText("replacement");
                eb.tb.rope().allocator = allocator;
                fault.fail_index = std.math.maxInt(usize);
                fault.resize_fail_index = std.math.maxInt(usize);
                var actual: [32]u8 = undefined;
                if (result) |_| {
                    try std.testing.expectEqualStrings("replacement", actual[0..eb.getText(&actual)]);
                    if (history) {
                        _ = try eb.undo();
                        try std.testing.expectEqualStrings("old", actual[0..eb.getText(&actual)]);
                        try std.testing.expectEqualDeep(before.cursor, eb.getPrimaryCursor());
                    } else {
                        try std.testing.expect(!eb.canUndo() and !eb.canRedo());
                        try std.testing.expectEqual(@as(usize, 0), eb.add_buffer.len);
                    }
                    succeeded = true;
                    break;
                } else |err| {
                    try std.testing.expectEqual(error.OutOfMemory, err);
                    try std.testing.expectEqualDeep(before, EditState.capture(eb));
                    _ = try eb.redo();
                    try std.testing.expectEqualStrings("oldX", actual[0..eb.getText(&actual)]);
                }
            }
            try std.testing.expect(succeeded);
        }
    }
}

test "EditBuffer - failed clear keeps history" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const eb = try EditBuffer.init(std.testing.allocator, &pool, &links, .wcwidth, null);
    defer eb.deinit();
    try eb.setText("old");
    try eb.setCursor(0, 3);
    try eb.insertText("!");

    const allocator = eb.tb.rope().allocator;
    var clear_failure = std.testing.FailingAllocator.init(allocator, .{ .fail_index = 0 });
    eb.tb.rope().allocator = clear_failure.allocator();
    const clear_result = eb.tb.clear();
    eb.tb.rope().allocator = allocator;
    try std.testing.expectError(error.OutOfMemory, clear_result);
    var actual: [32]u8 = undefined;
    _ = try eb.undo();
    try std.testing.expectEqualStrings("old", actual[0..eb.getText(&actual)]);
    _ = try eb.redo();
    try std.testing.expectEqualStrings("old!", actual[0..eb.getText(&actual)]);
}

test "EditBuffer - owned replacement registration rejection frees the copy" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    inline for (.{ .set, .replace }) |operation| {
        inline for (.{ .full, .allocation }) |admission| {
            const eb = try EditBuffer.init(std.testing.allocator, &pool, &links, .wcwidth, null);
            defer eb.deinit();
            try eb.insertText("old");
            const registry = &eb.tb.mem_registry;
            const limit = if (admission == .full) 255 else registry.buffers.capacity;
            while (registry.buffers.items.len < limit) {
                _ = try registry.register("spare", false);
            }
            const before = eb.tb.rope().*;
            const cursor = eb.getPrimaryCursor();
            const add_len = eb.add_buffer.len;
            const epoch = eb.tb.getContentEpoch();
            const allocator = registry.allocator;
            var failing = std.testing.FailingAllocator.init(allocator, .{
                .fail_index = 0,
                .resize_fail_index = 0,
            });
            // A history replacement registers a slot only when the add buffer must grow.
            const grows = try std.testing.allocator.alloc(u8, eb.add_buffer.cap);
            defer std.testing.allocator.free(grows);
            @memset(grows, 'x');
            registry.allocator = failing.allocator();
            const result = if (operation == .set) eb.setText("replacement") else eb.replaceText(grows);
            registry.allocator = allocator;
            try std.testing.expectError(error.OutOfMemory, result);
            try std.testing.expectEqual(admission == .allocation, failing.has_induced_failure);
            try std.testing.expectEqual(limit, registry.buffers.items.len);
            try std.testing.expectEqual(@as(usize, 0), registry.free_slots.items.len);
            try std.testing.expectEqual(before.root, eb.tb.rope().root);
            try std.testing.expectEqual(before.undo_history, eb.tb.rope().undo_history);
            try std.testing.expectEqual(before.undo_depth, eb.tb.rope().undo_depth);
            try std.testing.expectEqualDeep(cursor, eb.getPrimaryCursor());
            try std.testing.expectEqual(add_len, eb.add_buffer.len);
            try std.testing.expectEqual(epoch, eb.tb.getContentEpoch());
            var actual: [32]u8 = undefined;
            try std.testing.expectEqualStrings("old", actual[0..eb.getText(&actual)]);
            if (admission == .full) try registry.unregister(254);
            if (operation == .set) {
                try eb.setText("replacement");
                try std.testing.expect(!eb.canUndo());
                try std.testing.expectEqual(@as(usize, 0), eb.add_buffer.len);
            } else {
                try eb.replaceText("replacement");
                try std.testing.expectEqual(add_len + "replacement".len, eb.add_buffer.len);
                _ = try eb.undo();
                try std.testing.expectEqualStrings("old", actual[0..eb.getText(&actual)]);
                _ = try eb.redo();
            }
            try std.testing.expectEqualStrings("replacement", actual[0..eb.getText(&actual)]);
        }
    }
}

test "EditBuffer - unchanged normalized tab width preserves cursor" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    const eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode, null);
    defer eb.deinit();

    try eb.setText("a\tb");
    try eb.setCursor(0, 2);
    const cursor = eb.getPrimaryCursor();
    eb.setTabWidth(0);
    try std.testing.expectEqualDeep(cursor, eb.getPrimaryCursor());
}

test "EditBuffer - tab width remaps multi-chunk history under each checkpoint policy" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    const eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode, null);
    defer eb.deinit();

    try eb.setText("head\n\u{754c}\tb");
    try eb.setCursor(1, 2);
    eb.setTabWidth(8);
    try std.testing.expectEqualDeep(edit_buffer.Cursor{ .row = 1, .col = 2, .desired_col = 2, .offset = 7 }, eb.getPrimaryCursor());
    eb.setTabWidth(2);
    try eb.setCursor(1, 4);
    try eb.insertText("e\u{301}\t");
    eb.setTabWidth(8);
    try std.testing.expectEqualDeep(edit_buffer.Cursor{ .row = 1, .col = 19, .desired_col = 19, .offset = 24 }, eb.getPrimaryCursor());
    try std.testing.expectEqualStrings("cursor:1:4:4", try eb.undo());
    try std.testing.expectEqualDeep(edit_buffer.Cursor{ .row = 1, .col = 10, .desired_col = 10, .offset = 15 }, eb.getPrimaryCursor());
    try std.testing.expectEqualStrings("cursor:1:19:19", try eb.redo());
    try std.testing.expectEqual(@as(u32, 19), eb.getPrimaryCursor().col);
    eb.setTabWidth(4);
    try std.testing.expectEqualStrings("cursor:1:4:4", try eb.undo());
    try std.testing.expectEqual(@as(u32, 6), eb.getPrimaryCursor().col);
    try std.testing.expectEqualStrings("cursor:1:19:19", try eb.redo());
    try std.testing.expectEqual(@as(u32, 11), eb.getPrimaryCursor().col);
    try eb.insertText("y");
    var out: [64]u8 = undefined;
    try std.testing.expectEqualStrings("head\n\u{754c}\te\u{301}\tyb", out[0..eb.getText(&out)]);

    try eb.setText("abcdefghijklmnop\na\tb");
    try eb.setCursor(0, 16);
    eb.moveDown();
    eb.setTabWidth(8);
    try std.testing.expectEqual(@as(u32, 10), eb.getPrimaryCursor().col);
    try std.testing.expectEqual(@as(u32, 16), eb.getPrimaryCursor().desired_col);
    try eb.insertText("x");
    eb.setTabWidth(2);
    _ = try eb.undo();
    try std.testing.expectEqual(@as(u32, 4), eb.getPrimaryCursor().col);
    try std.testing.expectEqual(@as(u32, 16), eb.getPrimaryCursor().desired_col);

    eb.clearHistory();
    try eb.getTextBuffer().rope().store_undo("cursor:1:1:9");
    try std.testing.expectEqualStrings("cursor:1:1:9", try eb.undo());
    try std.testing.expectEqualDeep(edit_buffer.Cursor{ .row = 1, .col = 1, .desired_col = 9, .offset = 18 }, eb.getPrimaryCursor());
}

test "EditBuffer - a width method change measures, wraps and undoes like a buffer made with it" {
    const WidthMethod = @import("../utf8.zig").WidthMethod;
    const View = @import("../text-buffer-view.zig").UnifiedTextBufferView;
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    const Built = struct {
        eb: *EditBuffer,
        view: *View,

        // Several chunks, ASCII and not, with the cursor after the wide cluster.
        fn init(p: *TestPools, method: WidthMethod) !@This() {
            const eb = try EditBuffer.init(std.testing.allocator, &p.graphemes, &p.links, method, null);
            try eb.setText("head\n\u{754c}\tb");
            try eb.setCursor(1, 0);
            try eb.insertText("a");
            try eb.insertText("\u{1f44d}\u{1f3fd}");
            const view = try View.init(std.testing.allocator, eb.tb);
            view.setWrapMode(.char);
            view.setWrapWidth(3);
            return .{ .eb = eb, .view = view };
        }

        fn deinit(self: @This()) void {
            self.view.deinit();
            self.eb.deinit();
        }

        fn expectSame(self: @This(), fresh: @This()) !void {
            try std.testing.expectEqualDeep(fresh.eb.getPrimaryCursor(), self.eb.getPrimaryCursor());
            for (0..2) |row| try std.testing.expectEqual(fresh.eb.tb.lineWidthAt(@intCast(row)), self.eb.tb.lineWidthAt(@intCast(row)));
            try std.testing.expectEqualDeep(fresh.view.getCachedLineInfo(), self.view.getCachedLineInfo());
        }
    };
    for ([_][2]WidthMethod{ .{ .unicode, .wcwidth }, .{ .wcwidth, .unicode }, .{ .unicode, .unicode_wide } }) |pair| {
        errdefer std.debug.print("from={t} to={t}\n", .{ pair[0], pair[1] });
        const changed = try Built.init(&pools, pair[0]);
        defer changed.deinit();
        const fresh = try Built.init(&pools, pair[1]);
        defer fresh.deinit();
        _ = changed.view.getCachedLineInfo();
        // Until the method changes, undo records keep main's format.
        try std.testing.expectEqualStrings("cursor:1:1:1:2", changed.eb.tb.rope().undo_history.?.meta);
        // A backward selection from inside the emoji (between its code points, byte 10) back to its start keeps
        // its text and direction: the anchor rounds toward the end, as a backward one must.
        // Under wcwidth the cell between the two code points is a cursor stop.
        const start = changed.eb.tb.weightAtByte(6, true);
        const emoji = [2]u32{ start, if (pair[0] == .wcwidth) start + 2 else changed.eb.tb.weightAtByte(10, false) };
        // Two more views: the same pair forward, and a press there (equal endpoints), which stays empty.
        const views = [3]*View{ changed.view, try View.init(std.testing.allocator, changed.eb.tb), try View.init(std.testing.allocator, changed.eb.tb) };
        defer for (views[1..]) |view| view.deinit();
        for (views, [3][2]u32{ .{ emoji[1], emoji[0] }, emoji, .{ emoji[1], emoji[1] } }) |view, ends| {
            view.selection = .{ .start = @min(ends[0], ends[1]), .end = @max(ends[0], ends[1]), .bgColor = null, .fgColor = null };
            view.selection_endpoints = .{ .anchor = ends[0], .focus = ends[1] };
        }
        changed.eb.setWidthMethod(pair[1]);
        for (views) |view| view.followWidthMethod(changed.eb.tb, pair[0]);
        try changed.expectSame(fresh);
        const moved = [2]u32{ fresh.eb.tb.weightAtByte(6, true), fresh.eb.tb.weightAtByte(10, false) };
        for (views[0..2]) |view| try std.testing.expectEqual(moved, [2]u32{ view.selection.?.start, view.selection.?.end });
        try std.testing.expectEqual(moved, [2]u32{ views[0].selection_endpoints.?.focus, views[0].selection_endpoints.?.anchor });
        try std.testing.expectEqual(moved, [2]u32{ views[1].selection_endpoints.?.anchor, views[1].selection_endpoints.?.focus });
        const press = views[2];
        try std.testing.expectEqual(press.selection.?.start, press.selection.?.end);
        try std.testing.expectEqual(press.selection_endpoints.?.anchor, press.selection_endpoints.?.focus);
        changed.view.resetSelection();
        // A redo point stored under the old method puts its cursor on the same text.
        changed.eb.setWidthMethod(pair[0]);
        for ([_]*EditBuffer{ changed.eb, fresh.eb }) |eb| try std.testing.expectEqualStrings("cursor:1:1:1", try eb.undo());
        changed.eb.setWidthMethod(pair[1]);
        try changed.expectSame(fresh);
        for ([_]*EditBuffer{ changed.eb, fresh.eb }) |eb| _ = try eb.redo();
        try changed.expectSame(fresh);
        // Records written after the change name the method; undoing one lands like the fresh buffer's.
        for ([_]*EditBuffer{ changed.eb, fresh.eb }) |eb| try eb.insertText("z");
        const tag: [2]u8 = .{ ':', '0' + @as(u8, @backingInt(pair[1])) };
        try std.testing.expect(std.mem.endsWith(u8, changed.eb.tb.rope().undo_history.?.meta, &tag));
        try std.testing.expectEqualStrings(try fresh.eb.undo(), try changed.eb.undo());
        try changed.expectSame(fresh);

        // An edit after the emoji made before the first change: undone after it, the cursor lands after the emoji.
        const early = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, pair[0], null);
        defer early.deinit();
        const late = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, pair[1], null);
        defer late.deinit();
        for ([_]*EditBuffer{ early, late }) |eb| {
            try eb.setText("\u{1f44d}\u{1f3fd}abc");
            try eb.setCursor(0, eb.tb.weightAtByte(8, true));
            try eb.insertText("X");
        }
        const written = early.tb.weightAtByte(8, true);
        early.setWidthMethod(pair[1]);
        var record: [32]u8 = undefined;
        try std.testing.expectEqualStrings(try std.fmt.bufPrint(&record, "cursor:0:{d}:{d}", .{ written, written }), try early.undo());
        _ = try late.undo();
        try std.testing.expectEqualDeep(late.getPrimaryCursor(), early.getPrimaryCursor());
    }
}

test "EditBuffer - tab width changes preserve live and undo cursor text boundaries" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode, null);
    defer eb.deinit();

    try eb.setText("a\tb");
    try eb.setCursor(0, 4);
    try eb.insertText("x");

    eb.setTabWidth(8);
    try std.testing.expectEqual(@as(u32, 11), eb.getPrimaryCursor().col);

    _ = try eb.undo();

    try std.testing.expectEqual(@as(u32, 10), eb.getPrimaryCursor().col);
    try eb.insertText("y");

    var out_buffer: [16]u8 = undefined;
    const written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("a\tby", out_buffer[0..written]);
}

test "EditBuffer - random edit sequences match an undo history model" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const seed = 0x0505;
    var prng = std.Random.DefaultPrng.init(seed);
    const random = prng.random();
    const pieces = [_][]const u8{ "a", "Hello", " ", "\t", "\n", "x\ny", "\u{754c}", "e\u{301}", "\u{1f44d}\u{1f3fd}", "\u{1f1fa}\u{1f1f8}" };
    // Mirrors the rope: undo restores `undo.pop()` and pushes `current` (or the live state) for redo.
    const Entry = struct { text: []const u8, cursor: edit_buffer.Cursor };
    for ([_]@import("../utf8.zig").WidthMethod{ .unicode, .wcwidth }) |method| {
        const eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, method, null);
        defer eb.deinit();
        var undo: std.ArrayListUnmanaged(Entry) = .empty;
        var redo: std.ArrayListUnmanaged(Entry) = .empty;
        var current: ?Entry = null;
        var text: []const u8 = "";
        var scratch: [4096]u8 = undefined;
        for (0..400) |step| {
            errdefer std.debug.print("history model failed: seed 0x{x} {s} step {d}\n", .{ seed, @tagName(method), step });
            const before: Entry = .{ .text = text, .cursor = eb.getPrimaryCursor() };
            const epoch = eb.tb.getContentEpoch();
            const piece = pieces[random.uintLessThan(usize, pieces.len)];
            const Change = enum { none, if_changed, stored, reset, restored };
            var change: Change = .if_changed;
            switch (random.uintLessThan(u8, 13)) {
                0, 1, 2 => {
                    const prefix = scratch[0..try eb.getTextRange(0, before.cursor.offset, &scratch)];
                    try std.testing.expectEqualStrings(prefix, text[0..prefix.len]);
                    text = try std.mem.concat(allocator, u8, &.{ prefix, piece, text[prefix.len..] });
                    try eb.insertText(piece);
                    change = .stored;
                },
                3 => try eb.backspace(),
                4 => try eb.deleteForward(),
                5 => try eb.deleteLine(),
                6 => try eb.deleteRange(.{ .row = before.cursor.row, .col = 0 }, before.cursor),
                7 => {
                    if (random.boolean()) eb.moveLeft() else eb.moveRight();
                    change = .none;
                },
                8 => {
                    try eb.gotoLine(random.uintLessThan(u32, eb.tb.lineCount() + 1));
                    change = .none;
                },
                9 => {
                    change = .restored;
                    const entry = undo.pop() orelse {
                        try std.testing.expectError(error.Stop, eb.undo());
                        continue;
                    };
                    try redo.append(allocator, current orelse before);
                    current = entry;
                    try expectMeta(entry.cursor, try eb.undo());
                },
                10 => {
                    change = .restored;
                    const entry = redo.pop() orelse {
                        try std.testing.expectError(error.Stop, eb.redo());
                        continue;
                    };
                    try undo.append(allocator, current.?);
                    current = entry;
                    try expectMeta(entry.cursor, try eb.redo());
                },
                11 => {
                    try eb.replaceText(piece);
                    text = piece;
                    change = .stored;
                },
                12 => {
                    if (random.boolean()) try eb.setText(piece) else eb.clearHistory();
                    text = scratch[0..eb.getText(&scratch)];
                    change = .reset;
                },
                else => unreachable,
            }
            const actual = scratch[0..eb.getText(&scratch)];
            switch (change) {
                .none => {},
                .if_changed => if (!std.mem.eql(u8, text, actual)) {
                    text = try allocator.dupe(u8, actual);
                    change = .stored;
                },
                .stored => {},
                .reset => {
                    text = try allocator.dupe(u8, text);
                    undo.clearRetainingCapacity();
                    redo.clearRetainingCapacity();
                    current = null;
                },
                .restored => {
                    text = current.?.text;
                    if (!std.mem.eql(u8, text, before.text)) try std.testing.expect(eb.tb.getContentEpoch() != epoch);
                    try std.testing.expectEqualDeep(current.?.cursor, eb.getPrimaryCursor());
                },
            }
            if (change == .stored) {
                try undo.append(allocator, before);
                redo.clearRetainingCapacity();
                current = null;
            }
            try std.testing.expectEqualStrings(text, actual);
            try std.testing.expectEqual(undo.items.len > 0, eb.canUndo());
            try std.testing.expectEqual(redo.items.len > 0, eb.canRedo());
            try std.testing.expectEqual(std.mem.count(u8, text, "\n") + 1, eb.tb.lineCount());
            const cursor = eb.getPrimaryCursor();
            try std.testing.expect(cursor.col <= eb.tb.lineWidthAt(cursor.row));
            try std.testing.expectEqual(@import("../text-buffer-iterators.zig").coordsToOffset(eb.tb.rope(), cursor.row, cursor.col).?, cursor.offset);
            if (eb.tb.cursorUnitBoundsAtOffset(cursor.offset)) |bounds| try std.testing.expectEqual(cursor.offset, bounds.start);
        }
    }
}

fn expectMeta(cursor: edit_buffer.Cursor, meta: []const u8) !void {
    var expected: [64]u8 = undefined;
    try std.testing.expectEqualStrings(try std.fmt.bufPrint(&expected, "cursor:{d}:{d}:{d}", .{ cursor.row, cursor.col, cursor.desired_col }), meta);
}
