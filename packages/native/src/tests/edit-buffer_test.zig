const std = @import("std");
const TestPools = @import("test-pools.zig").TestPools;
const edit_buffer = @import("../edit-buffer.zig");
const text_buffer_view = @import("../text-buffer-view.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");
const iter_mod = @import("../text-buffer-iterators.zig");
const utf8 = @import("../utf8.zig");
const seg_mod = @import("../text-buffer-segment.zig");

const EditBuffer = edit_buffer.EditBuffer;
const TextBufferView = text_buffer_view.TextBufferView;
const Cursor = edit_buffer.Cursor;

test "EditBuffer - deleting final line contents preserves empty line" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    const eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();
    try eb.setText("a\nb");
    try eb.setCursor(1, 0);
    try eb.deleteForward();

    var text: [16]u8 = undefined;
    try std.testing.expectEqualStrings("a\n", text[0..eb.getText(&text)]);
    try std.testing.expectEqual(@as(u32, 2), eb.tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 1), eb.tb.lineWidthAt(0));
    try std.testing.expectEqual(@as(u32, 0), eb.tb.lineWidthAt(1));
    try eb.tb.addHighlightByCharRange(1, 2, 1, 1, 0);
    try std.testing.expectEqual(@as(usize, 0), eb.tb.getHighlightCount());

    _ = try eb.undo();
    try std.testing.expectEqualStrings("a\nb", text[0..eb.getText(&text)]);
    _ = try eb.redo();
    try std.testing.expectEqualStrings("a\n", text[0..eb.getText(&text)]);
    try eb.insertText("c");
    try std.testing.expectEqualStrings("a\nc", text[0..eb.getText(&text)]);
}

test "EditBuffer - init and deinit" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    try std.testing.expectEqual(@as(u32, 0), eb.getTextBuffer().getLength());
    try std.testing.expectEqualDeep(edit_buffer.Cursor{ .row = 0, .col = 0 }, eb.getPrimaryCursor());
}

test "EditBuffer - add buffer registration failure releases initialization storage" {
    const Check = struct {
        fn init(allocator: std.mem.Allocator) !void {
            var pool = gp.GraphemePool.init(allocator);
            defer pool.deinit();
            var links = link.LinkPool.init(allocator);
            defer links.deinit();
            const eb = try EditBuffer.init(allocator, &pool, &links, .wcwidth, null);
            defer eb.deinit();
        }
    };
    try std.testing.checkAllAllocationFailures(std.testing.allocator, Check.init, .{});
}

test "EditBuffer - native notifications do not allocate" {
    const Capture = struct {
        event: ?edit_buffer.NativeEvent = null,
        count: u32 = 0,

        fn callback(data: *anyopaque, event: edit_buffer.NativeEvent) void {
            const self: *@This() = @ptrCast(@alignCast(data));
            self.event = event;
            self.count += 1;
        }
    };
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    var capture: Capture = .{};
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    const eb = try EditBuffer.init(
        failing.allocator(),
        &pool,
        &link_pool,
        .wcwidth,
        .{ .userdata = &capture, .callback = Capture.callback },
    );
    defer eb.deinit();
    // The first line lookup fills the rope's marker cache from its arena.
    _ = eb.tb.rope().markerCount(.linestart);
    failing.fail_index = failing.alloc_index;
    failing.resize_fail_index = failing.resize_index;
    try eb.setCursor(0, 0);
    try std.testing.expectEqual(edit_buffer.NativeEvent.cursor_changed, capture.event.?);
    try std.testing.expectEqual(@as(u32, 1), capture.count);
    try std.testing.expect(!failing.has_induced_failure);
}

test "EditBuffer - native notifications keep cursor content and history order" {
    const Capture = struct {
        events: [8]edit_buffer.NativeEvent = undefined,
        count: usize = 0,

        fn callback(data: *anyopaque, event: edit_buffer.NativeEvent) void {
            const self: *@This() = @ptrCast(@alignCast(data));
            self.events[self.count] = event;
            self.count += 1;
        }
    };
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    var capture: Capture = .{};
    const eb = try EditBuffer.init(std.testing.allocator, &pool, &link_pool, .wcwidth, .{
        .userdata = &capture,
        .callback = Capture.callback,
    });
    defer eb.deinit();
    try eb.insertText("a");
    _ = try eb.undo();
    try std.testing.expectEqualSlices(edit_buffer.NativeEvent, &.{
        .cursor_changed,
        .content_changed,
        .cursor_changed,
        .history_cursor_changed,
    }, capture.events[0..capture.count]);
}

test "EditBuffer - native notifications stay with their buffer" {
    const Owner = struct {
        count: u32 = 0,

        fn receive(data: *anyopaque, event: edit_buffer.NativeEvent) void {
            const self: *@This() = @ptrCast(@alignCast(data));
            std.debug.assert(event == .cursor_changed);
            self.count += 1;
        }
    };
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    var first: Owner = .{};
    var second: Owner = .{};
    const left = try EditBuffer.init(
        std.testing.allocator,
        &pool,
        &link_pool,
        .wcwidth,
        .{ .userdata = &first, .callback = Owner.receive },
    );
    defer left.deinit();
    const right = try EditBuffer.init(
        std.testing.allocator,
        &pool,
        &link_pool,
        .wcwidth,
        .{ .userdata = &second, .callback = Owner.receive },
    );
    defer right.deinit();
    try left.setCursor(0, 0);
    try right.setCursor(0, 0);
    try left.setCursor(0, 0);
    try std.testing.expectEqual(@as(u32, 2), first.count);
    try std.testing.expectEqual(@as(u32, 1), second.count);
}

test "EditBuffer - buffers without a native notify still emit cursor listeners" {
    const Listener = struct {
        fn onCursorChanged(ctx: *anyopaque) void {
            const count: *u32 = @ptrCast(@alignCast(ctx));
            count.* += 1;
        }
    };
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(std.testing.allocator);
    defer link_pool.deinit();
    const eb = try EditBuffer.init(std.testing.allocator, &pool, &link_pool, .wcwidth, null);
    defer eb.deinit();
    var count: u32 = 0;
    try eb.events.on(.cursorChanged, .{ .ctx = &count, .handle = Listener.onCursorChanged });
    try eb.setCursor(0, 0);
    try std.testing.expectEqual(@as(u32, 1), count);
}

test "EditBuffer - replacement notifications observe accepted state" {
    const Capture = struct {
        eb: *EditBuffer,
        count: usize = 0,
        accepted: bool = true,

        fn changed(data: *anyopaque) void {
            const self: *@This() = @ptrCast(@alignCast(data));
            var text: [32]u8 = undefined;
            self.accepted = self.accepted and
                std.mem.eql(u8, "replacement", text[0..self.eb.getText(&text)]) and
                self.eb.getPrimaryCursor().row == 0 and self.eb.getPrimaryCursor().col == 0 and
                !self.eb.canRedo();
            self.count += 1;
        }
    };
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const eb = try EditBuffer.init(std.testing.allocator, &pool, &links, .unicode, null);
    defer eb.deinit();
    try eb.setText("old\ntext");
    try eb.insertText("X");
    _ = try eb.undo();
    var capture: Capture = .{ .eb = eb };
    try eb.events.on(.cursorChanged, .{ .ctx = &capture, .handle = Capture.changed });
    try eb.setText("replacement");
    try eb.replaceText("replacement");
    try std.testing.expect(capture.accepted);
    try std.testing.expectEqual(@as(usize, 2), capture.count);
}

/// Text inserted piece by piece, so every piece is its own chunk; `col` moves the cursor first.
const Piece = struct { col: ?u32 = null, bytes: []const u8 };

fn insertPieces(pools: *TestPools, method: utf8.WidthMethod, pieces: []const Piece) !*EditBuffer {
    const eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, method, null);
    errdefer eb.deinit();
    for (pieces) |piece| {
        if (piece.col) |col| try eb.setCursor(0, col);
        try eb.insertText(piece.bytes);
    }
    return eb;
}

test "EditBuffer - word boundary and line end walks" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    // `next` walks from the start, `prev` from the end, until a step stops moving.
    const Case = struct { method: utf8.WidthMethod = .wcwidth, pieces: []const Piece, next: []const [2]u32, prev: []const [2]u32 };
    const cases = [_]Case{
        .{ .pieces = &.{.{ .bytes = "Hello World" }}, .next = &.{ .{ 0, 6 }, .{ 0, 11 } }, .prev = &.{ .{ 0, 6 }, .{ 0, 0 } } },
        .{ .pieces = &.{.{ .bytes = "Hello\nWorld" }}, .next = &.{ .{ 1, 0 }, .{ 1, 5 } }, .prev = &.{ .{ 0, 5 }, .{ 0, 0 } } },
        .{ .pieces = &.{.{ .bytes = "Hello\n\nWorld" }}, .next = &.{ .{ 1, 0 }, .{ 2, 0 }, .{ 2, 5 } }, .prev = &.{ .{ 1, 0 }, .{ 0, 5 }, .{ 0, 0 } } },
        .{ .pieces = &.{.{ .bytes = "self-contained" }}, .next = &.{ .{ 0, 5 }, .{ 0, 14 } }, .prev = &.{ .{ 0, 5 }, .{ 0, 0 } } },
        .{ .pieces = &.{.{ .bytes = "The quick brown fox" }}, .next = &.{ .{ 0, 4 }, .{ 0, 10 }, .{ 0, 16 }, .{ 0, 19 } }, .prev = &.{ .{ 0, 16 }, .{ 0, 10 }, .{ 0, 4 }, .{ 0, 0 } } },
        .{ .pieces = &.{.{ .bytes = "Hello\tWorld" }}, .next = &.{ .{ 0, 7 }, .{ 0, 12 } }, .prev = &.{ .{ 0, 7 }, .{ 0, 0 } } },
        .{ .pieces = &.{.{ .bytes = "\u{4f60} \u{597d}" }}, .next = &.{ .{ 0, 3 }, .{ 0, 5 } }, .prev = &.{ .{ 0, 3 }, .{ 0, 0 } } },
        .{ .pieces = &.{.{ .bytes = "\u{1f31f} ok" }}, .next = &.{ .{ 0, 3 }, .{ 0, 5 } }, .prev = &.{ .{ 0, 3 }, .{ 0, 0 } } },
        // Script transitions are word boundaries; a CJK or Hangul run is one word.
        .{ .pieces = &.{.{ .bytes = "\u{65e5}\u{672c}\u{8a9e}abc" }}, .next = &.{ .{ 0, 6 }, .{ 0, 9 } }, .prev = &.{ .{ 0, 6 }, .{ 0, 0 } } },
        .{ .pieces = &.{.{ .bytes = "\u{65e5}\u{672c}\u{8a9e}\u{6587}\u{5b57}" }}, .next = &.{.{ 0, 10 }}, .prev = &.{.{ 0, 0 }} },
        .{ .pieces = &.{.{ .bytes = "\u{d14c}\u{c2a4}\u{d2b8}test" }}, .next = &.{ .{ 0, 6 }, .{ 0, 10 } }, .prev = &.{ .{ 0, 6 }, .{ 0, 0 } } },
        .{ .pieces = &.{.{ .bytes = "\u{65e5}\u{672c}\u{8a9e}\u{3002}abc" }}, .next = &.{ .{ 0, 8 }, .{ 0, 11 } }, .prev = &.{ .{ 0, 8 }, .{ 0, 0 } } },
        .{ .pieces = &.{.{ .bytes = "\u{4e3d}abc" }}, .next = &.{ .{ 0, 2 }, .{ 0, 5 } }, .prev = &.{ .{ 0, 2 }, .{ 0, 0 } } },
        .{ .pieces = &.{.{ .bytes = "a\u{65e5}" }}, .next = &.{ .{ 0, 1 }, .{ 0, 3 } }, .prev = &.{ .{ 0, 1 }, .{ 0, 0 } } },
        .{ .pieces = &.{.{ .bytes = "\u{65e5}a" }}, .next = &.{ .{ 0, 2 }, .{ 0, 3 } }, .prev = &.{ .{ 0, 2 }, .{ 0, 0 } } },
        // The transition holds across chunks, and a combining mark keeps its base's class.
        .{ .method = .unicode, .pieces = &.{ .{ .bytes = "\u{65e5}\u{672c}" }, .{ .col = 0, .bytes = "abc" } }, .next = &.{ .{ 0, 3 }, .{ 0, 7 } }, .prev = &.{ .{ 0, 3 }, .{ 0, 0 } } },
        .{ .method = .unicode, .pieces = &.{ .{ .bytes = "\u{65e5}\u{672c}" }, .{ .col = 0, .bytes = "a\u{301}" } }, .next = &.{ .{ 0, 1 }, .{ 0, 5 } }, .prev = &.{ .{ 0, 1 }, .{ 0, 0 } } },
    };
    for (cases) |case| {
        const eb = try insertPieces(&pools, case.method, case.pieces);
        defer eb.deinit();
        const last_row = eb.tb.lineCount() - 1;
        for ([_]bool{ true, false }) |forward| {
            const expected = if (forward) case.next else case.prev;
            if (forward) try eb.setCursor(0, 0) else try eb.setCursor(last_row, eb.tb.lineWidthAt(last_row));
            var steps: usize = 0;
            while (true) : (steps += 1) {
                const cursor = if (forward) eb.getNextWordBoundary() else eb.getPrevWordBoundary();
                try std.testing.expectEqual(cursor.col, cursor.desired_col);
                try std.testing.expectEqual(iter_mod.coordsToOffset(eb.tb.rope(), cursor.row, cursor.col).?, cursor.offset);
                if (cursor.row == eb.cursor.row and cursor.col == eb.cursor.col) break;
                try std.testing.expectEqual(expected[steps], [2]u32{ cursor.row, cursor.col });
                try eb.setCursor(cursor.row, cursor.col);
            }
            try std.testing.expectEqual(expected.len, steps);
        }
        for (0..last_row + 1) |row| {
            try eb.setCursor(@intCast(row), 0);
            const eol = eb.getEOL();
            try std.testing.expectEqual([2]u32{ @intCast(row), eb.tb.lineWidthAt(@intCast(row)) }, [2]u32{ eol.row, eol.col });
        }
    }
}

test "EditBuffer - horizontal moves and backspace step over one cursor unit" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    const Case = struct { method: utf8.WidthMethod = .wcwidth, pieces: []const Piece, stops: []const u32 };
    const cases = [_]Case{
        // Tabs (width 2) at chunk edges, including text typed before and between them.
        .{ .pieces = &.{.{ .bytes = "\tHello" }}, .stops = &.{ 0, 2, 3, 4, 5, 6, 7 } },
        .{ .pieces = &.{ .{ .bytes = "\tWorld" }, .{ .col = 0, .bytes = "Hi" } }, .stops = &.{ 0, 1, 2, 4, 5, 6, 7, 8, 9 } },
        .{ .pieces = &.{.{ .bytes = "\t\tHello" }}, .stops = &.{ 0, 2, 4, 5, 6, 7, 8, 9 } },
        .{ .pieces = &.{ .{ .bytes = "\t" }, .{ .col = 0, .bytes = "a" } }, .stops = &.{ 0, 1, 3 } },
        .{ .pieces = &.{ .{ .bytes = "\t\tx" }, .{ .col = 2, .bytes = "A" } }, .stops = &.{ 0, 2, 3, 5, 6 } },
        .{ .pieces = &.{ .{ .bytes = "\t" }, .{ .bytes = "x" } }, .stops = &.{ 0, 2, 3 } },
        .{ .pieces = &.{.{ .bytes = "hello\tworld" }}, .stops = &.{ 0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12 } },
        .{ .pieces = &.{.{ .bytes = "\tx\ty" }}, .stops = &.{ 0, 2, 3, 5, 6 } },
        .{ .pieces = &.{.{ .bytes = "a\tb" }}, .stops = &.{ 0, 1, 3, 4 } },
        .{ .pieces = &.{ .{ .bytes = "\t\t" }, .{ .col = 2, .bytes = "x" } }, .stops = &.{ 0, 2, 3, 5 } },
        .{ .pieces = &.{.{ .bytes = "\t\t\t" }}, .stops = &.{ 0, 2, 4, 6 } },
        // wcwidth gives each emoji codepoint a stop; ZWJ and VS16 take none.
        .{ .pieces = &.{.{ .bytes = "\u{1f44b}\u{1f3fb}" }}, .stops = &.{ 0, 2, 4 } },
        .{ .pieces = &.{.{ .bytes = "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}" }}, .stops = &.{ 0, 2, 4, 6 } },
        .{ .pieces = &.{.{ .bytes = "\u{1f469}\u{200d}\u{1f4bb}" }}, .stops = &.{ 0, 2, 4 } },
        .{ .pieces = &.{.{ .bytes = "\u{1f469}\u{1f3fd}\u{200d}\u{1f4bb}" }}, .stops = &.{ 0, 2, 4, 6 } },
        .{ .pieces = &.{.{ .bytes = "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{200d}\u{1f466}" }}, .stops = &.{ 0, 2, 4, 6, 8 } },
        .{ .pieces = &.{.{ .bytes = "\u{1f3f3}\u{fe0f}\u{200d}\u{1f308}" }}, .stops = &.{ 0, 1, 3 } },
        .{ .pieces = &.{.{ .bytes = "\u{1f1fa}\u{1f1f8}" }}, .stops = &.{ 0, 1, 2 } },
        .{ .pieces = &.{.{ .bytes = "\u{1f4bb}\u{1f469}\u{1f3fd}" }}, .stops = &.{ 0, 2, 4, 6 } },
        .{
            .pieces = &.{.{ .bytes = "A \u{1f469}\u{1f3fd}\u{200d}\u{1f4bb} B \u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{200d}\u{1f466} C" }},
            .stops = &.{ 0, 1, 2, 4, 6, 8, 9, 10, 11, 13, 15, 17, 19, 20, 21 },
        },
        // Unicode keeps each emoji sequence one cursor unit.
        .{ .method = .unicode, .pieces = &.{.{ .bytes = "\u{1f469}\u{1f3fd}\u{200d}\u{1f4bb}a\u{1f1fa}\u{1f1f8}" }}, .stops = &.{ 0, 2, 3, 5 } },
        .{ .method = .unicode, .pieces = &.{.{ .bytes = "\u{1f44b}\u{1f3ff}" }}, .stops = &.{ 0, 2 } },
    };
    for (cases) |case| {
        const eb = try insertPieces(&pools, case.method, case.pieces);
        defer eb.deinit();
        try eb.setCursor(0, 0);
        for (case.stops[1..]) |stop| {
            eb.moveRight();
            try std.testing.expectEqual(stop, eb.getPrimaryCursor().col);
        }
        eb.moveRight();
        const end = case.stops[case.stops.len - 1];
        try std.testing.expectEqual(end, eb.getPrimaryCursor().col);
        try std.testing.expectEqual(eb.tb.lineWidthAt(0), end);
        var index = case.stops.len - 1;
        while (index > 0) {
            index -= 1;
            eb.moveLeft();
            try std.testing.expectEqual(case.stops[index], eb.getPrimaryCursor().col);
        }
        // Backspace from the end deletes one unit per step, keeping a prefix, back to an empty line.
        var text: [64]u8 = undefined;
        var full: [64]u8 = undefined;
        const full_text = full[0..eb.getText(&full)];
        try eb.setCursor(0, end);
        index = case.stops.len - 1;
        while (index > 0) {
            index -= 1;
            try eb.backspace();
            try std.testing.expectEqual(case.stops[index], eb.getPrimaryCursor().col);
            try std.testing.expectEqual(case.stops[index], eb.tb.lineWidthAt(0));
            try std.testing.expect(std.mem.startsWith(u8, full_text, text[0..eb.getText(&text)]));
        }
        try std.testing.expectEqual(@as(usize, 0), eb.getText(&text));
    }
}

test "EditBuffer - getTextRange snaps offsets to grapheme boundaries" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    const Case = struct { text: []const u8, start: u32, end: u32, expected: []const u8 };
    const mixed = "Hi \u{1f44b} \u{4e16}\u{754c} \u{928}\u{92e}\u{938}\u{94d}\u{924}\u{947}";
    const cases = [_]Case{
        .{ .text = "Hello World", .start = 0, .end = 5, .expected = "Hello" },
        .{ .text = "Hello World", .start = 0, .end = 11, .expected = "Hello World" },
        .{ .text = "Hello World", .start = 4, .end = 5, .expected = "o" },
        .{ .text = "Hello", .start = 5, .end = 5, .expected = "" },
        .{ .text = "Hello", .start = 0, .end = 1000, .expected = "Hello" },
        .{ .text = "Hello\nWorld", .start = 3, .end = 8, .expected = "lo\nWo" },
        .{ .text = "A\tB", .start = 0, .end = 10, .expected = "A\tB" },
        .{ .text = "Hello \u{1f44b} World", .start = 6, .end = 8, .expected = "\u{1f44b}" },
        .{ .text = "Hi \u{1f44b}\u{1f3fd} there", .start = 3, .end = 5, .expected = "\u{1f44b}\u{1f3fd}" },
        .{ .text = "Flag: \u{1f1fa}\u{1f1f8} here", .start = 6, .end = 8, .expected = "\u{1f1fa}\u{1f1f8}" },
        .{ .text = "Family: \u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{200d}\u{1f466} end", .start = 8, .end = 10, .expected = "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{200d}\u{1f466}" },
        .{ .text = "Say \u{928}\u{92e}\u{938}\u{94d}\u{924}\u{947} ok", .start = 4, .end = 8, .expected = "\u{928}\u{92e}\u{938}\u{94d}\u{924}\u{947}" },
        .{ .text = "Say \u{4f60}\u{597d} end", .start = 4, .end = 8, .expected = "\u{4f60}\u{597d}" },
        .{ .text = "A \u{65e5} B", .start = 2, .end = 4, .expected = "\u{65e5}" },
        // A start inside a wide grapheme snaps back to it; an end inside it includes it.
        .{ .text = "A \u{597d} B", .start = 3, .end = 5, .expected = "\u{597d} " },
        .{ .text = "A \u{597d} B", .start = 0, .end = 3, .expected = "A \u{597d}" },
        .{ .text = mixed, .start = 0, .end = 100, .expected = mixed },
        .{ .text = mixed, .start = 3, .end = 5, .expected = "\u{1f44b}" },
        .{ .text = mixed, .start = 6, .end = 10, .expected = "\u{4e16}\u{754c}" },
        .{ .text = "Line1 \u{1f44b}\nLine2 \u{1f389}\nLine3", .start = 0, .end = 100, .expected = "Line1 \u{1f44b}\nLine2 \u{1f389}\nLine3" },
    };
    for (cases) |case| {
        const eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
        defer eb.deinit();
        try eb.insertText(case.text);
        var buffer: [100]u8 = undefined;
        try std.testing.expectEqualStrings(case.expected, buffer[0..try eb.getTextRange(case.start, case.end, &buffer)]);
    }
}

test "EditBuffer - undo redo refreshes tab metrics after tab width changes" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode, null);
    defer eb.deinit();
    try eb.setText("a\tb");
    try eb.setCursor(0, eb.tb.lineWidthAt(0));
    try eb.insertText("x");

    _ = try eb.undo();
    try std.testing.expectEqual(@as(u32, 4), eb.tb.lineWidthAt(0));
    _ = try eb.redo();
    try std.testing.expectEqual(@as(u32, 5), eb.tb.lineWidthAt(0));

    eb.setTabWidth(8);
    try std.testing.expectEqual(@as(u32, 11), eb.tb.lineWidthAt(0));

    _ = try eb.undo();
    try std.testing.expectEqual(@as(u32, 10), eb.tb.lineWidthAt(0));
    var view = try TextBufferView.init(std.testing.allocator, eb.tb);
    defer view.deinit();
    try std.testing.expectEqual(@as(u32, 10), view.getVirtualLines()[0].width_cols);

    _ = try eb.redo();
    try std.testing.expectEqual(@as(u32, 11), eb.tb.lineWidthAt(0));
    try std.testing.expectEqual(@as(u32, 11), view.getVirtualLines()[0].width_cols);
}

test "EditBuffer - contiguous inserts coalesce across tab presence" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    const Flags = seg_mod.TextChunk.Flags;
    const cases = [_]struct { text: []const u8, split_byte: usize, flags: []const u8 }{
        .{ .text = "\u{754c}\t", .split_byte = 3, .flags = &.{Flags.HAS_TAB} },
        .{ .text = "\t\u{754c}", .split_byte = 1, .flags = &.{Flags.HAS_TAB} },
        .{ .text = "\u{754c}\u{754c}", .split_byte = 3, .flags = &.{0} },
        .{ .text = "abcd", .split_byte = 2, .flags = &.{Flags.ASCII_ONLY} },
        .{ .text = "ab\t", .split_byte = 2, .flags = &.{ Flags.ASCII_ONLY, Flags.HAS_TAB } },
        .{ .text = "\tab", .split_byte = 1, .flags = &.{ Flags.HAS_TAB, Flags.ASCII_ONLY } },
        .{ .text = "ab\u{754c}", .split_byte = 2, .flags = &.{ Flags.ASCII_ONLY, 0 } },
        .{ .text = "\u{754c}ab", .split_byte = 3, .flags = &.{ 0, Flags.ASCII_ONLY } },
    };

    for (cases) |case| {
        const eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode, null);
        defer eb.deinit();
        try eb.insertText(case.text[0..case.split_byte]);
        try eb.insertText(case.text[case.split_byte..]);

        for (0..2) |stage| {
            if (stage == 1) {
                try eb.setCursor(0, 2);
                try eb.insertText("\n");
                try std.testing.expectEqual(@as(u32, 2), eb.tb.lineCount());
                try eb.backspace();
            }
            var out: [16]u8 = undefined;
            try std.testing.expectEqualStrings(case.text, out[0..eb.getText(&out)]);
            try std.testing.expectEqual(@as(u32, 4), eb.tb.lineWidthAt(0));
            try std.testing.expectEqual(case.flags.len + 1, eb.tb.rope().count());
            for (case.flags, 0..) |flags, i| {
                const chunk = eb.tb.rope().get(@intCast(i + 1)).?.asText().?;
                try std.testing.expectEqual(flags, chunk.flags);
            }
        }

        const has_tab = std.mem.indexOfScalar(u8, case.text, '\t') != null;
        try std.testing.expectEqual(has_tab, eb.tb.rope().root.metrics().custom.has_tabs);
        eb.tb.setTabWidth(8);
        try std.testing.expectEqual(@as(u32, if (has_tab) 10 else 4), eb.tb.lineWidthAt(0));
    }
}

test "EditBuffer - tab presence survives splitting merging and history" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    const eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode, null);
    defer eb.deinit();
    var out: [64]u8 = undefined;

    for ([_][]const u8{ "abc\tdef", "\u{754c}x\tdef" }) |text| {
        eb.tb.setTabWidth(2);
        try eb.setText(text);
        try eb.setCursor(0, 3);
        for (0..5) |stage| {
            switch (stage) {
                0 => try eb.insertText("\n"),
                1 => try eb.backspace(),
                2 => try eb.deleteRange(.{ .row = 0, .col = 3 }, .{ .row = 0, .col = 5 }),
                3 => {
                    eb.tb.setTabWidth(8);
                    _ = try eb.undo();
                    try std.testing.expectEqual(@as(u32, 14), eb.tb.lineWidthAt(0));
                },
                4 => {
                    _ = try eb.redo();
                    try std.testing.expectEqual(@as(u32, 6), eb.tb.lineWidthAt(0));
                },
                else => unreachable,
            }
            const bytes = out[0..eb.getText(&out)];
            const has_tab = std.mem.indexOfScalar(u8, bytes, '\t') != null;
            try std.testing.expectEqual(stage != 2 and stage != 4, has_tab);
            try std.testing.expectEqual(has_tab, eb.tb.rope().root.metrics().custom.has_tabs);
            for (0..eb.tb.rope().count()) |i| {
                const segment = eb.tb.rope().get(@intCast(i)).?;
                if (segment.asText()) |chunk| {
                    const chunk_bytes = chunk.getBytes(eb.tb.memRegistry());
                    try std.testing.expectEqual(std.mem.indexOfScalar(u8, chunk_bytes, '\t') != null, chunk.hasTab());
                    if (chunk.isAsciiOnly()) try std.testing.expect(!chunk.hasTab());
                }
            }
            if (stage == 1 or stage == 3) try std.testing.expectEqualStrings(text, bytes);
        }
    }
}

test "EditBuffer - stale tab-free undo redo roots preserve Unicode widths" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode, null);
    defer eb.deinit();
    try eb.setText("界🙂alpha");
    const initial_width = eb.tb.lineWidthAt(0);
    try eb.setCursor(0, initial_width);
    try eb.insertText("x");
    const edited_width = eb.tb.lineWidthAt(0);

    _ = try eb.undo();
    try std.testing.expectEqual(initial_width, eb.tb.lineWidthAt(0));

    eb.tb.setTabWidth(8);
    _ = try eb.redo();
    try std.testing.expectEqual(edited_width, eb.tb.lineWidthAt(0));

    eb.tb.setTabWidth(4);
    _ = try eb.undo();
    try std.testing.expectEqual(initial_width, eb.tb.lineWidthAt(0));
}
