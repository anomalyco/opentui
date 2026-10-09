const std = @import("std");
const TestPools = @import("test-pools.zig").TestPools;
const editor_view = @import("../editor-view.zig");
const edit_buffer = @import("../edit-buffer.zig");
const text_buffer = @import("../text-buffer.zig");
const text_buffer_view = @import("../text-buffer-view.zig");
const opt_buffer_mod = @import("../buffer.zig");
const ansi = @import("../ansi.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");
const owned_styled = @import("owned-styled-text.zig");
const utf8 = @import("../utf8.zig");

const EditorView = editor_view.EditorView;
const EditBuffer = edit_buffer.EditBuffer;
const Cursor = edit_buffer.Cursor;
const Viewport = text_buffer_view.Viewport;

comptime {
    _ = @import("editor-view-owner_test.zig");
}

test "EditorView - init and deinit" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    const vp = ev.getViewport();
    try std.testing.expect(vp != null);
    try std.testing.expectEqual(@as(u32, 80), vp.?.width);
    try std.testing.expectEqual(@as(u32, 24), vp.?.height);
    try std.testing.expectEqual(@as(u32, 0), vp.?.y);
}

/// The scroll margin in lines or columns that ensureCursorVisible keeps for a viewport size.
fn marginCells(size: u32, margin: f32) u32 {
    const raw = @max(1, @as(u32, @intFromFloat(@as(f32, @floatFromInt(size)) * margin)));
    return @min(raw, if (size > 1) (size - 1) / 2 else 0);
}

test "EditorView - random edits and moves keep the cursor inside the scroll margins" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    const seed = 0xed17;
    var prng = std.Random.DefaultPrng.init(seed);
    const random = prng.random();
    const pieces = [_][]const u8{ "a", "word ", "\n", "x\ny\nz", "\t", "\u{754c}", "AAAAAAAAAABBBBBBBBBBCCCCCCCCCC", "\n\n\n\n\n\n" };
    const margins = [_]f32{ 0, 0.15, 0.3, 0.5 };
    for (0..80) |run| {
        const eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
        defer eb.deinit();
        const ev = try EditorView.init(std.testing.allocator, eb, random.intRangeAtMost(u32, 1, 24), random.intRangeAtMost(u32, 1, 10));
        defer ev.deinit();
        ev.setWrapMode(random.enumValue(text_buffer.WrapMode));
        const margin = margins[random.uintLessThan(usize, margins.len)];
        ev.setScrollMargin(margin);
        for (0..60) |step| {
            errdefer std.debug.print("viewport property failed: seed 0x{x} run {d} step {d}\n", .{ seed, run, step });
            const row_before = ev.getVisualCursor().visual_row + ev.getViewport().?.y;
            const op = random.uintLessThan(u8, 12);
            switch (op) {
                0, 1 => try eb.insertText(pieces[random.uintLessThan(usize, pieces.len)]),
                2 => try eb.backspace(),
                3 => try eb.deleteForward(),
                4 => try eb.deleteLine(),
                5 => if (random.boolean()) eb.moveLeft() else eb.moveRight(),
                6 => if (random.boolean()) eb.moveUp() else eb.moveDown(),
                7 => ev.moveUpVisual(),
                8 => ev.moveDownVisual(),
                9 => try eb.setCursor(random.uintLessThan(u32, eb.tb.lineCount() + 1), random.uintLessThan(u32, 40)),
                10 => ev.setViewportSize(random.intRangeAtMost(u32, 1, 24), random.intRangeAtMost(u32, 1, 10)),
                11 => try eb.setText(pieces[random.uintLessThan(usize, pieces.len)]),
                else => unreachable,
            }
            // getVisualCursor scrolls first, as rendering does.
            const vcursor = ev.getVisualCursor();
            const vp = ev.getViewport().?;
            const cursor = eb.getPrimaryCursor();
            try std.testing.expectEqual(cursor.row, vcursor.logical_row);
            try std.testing.expectEqual(cursor.col, vcursor.logical_col);
            const row = vcursor.visual_row + vp.y;
            const total = ev.getTotalVirtualLineCount();
            const lines = marginCells(vp.height, margin);
            try std.testing.expect(row < total);
            try std.testing.expect(row >= vp.y + @min(lines, row));
            try std.testing.expect(row + lines < vp.y + vp.height or (row < vp.y + vp.height and vp.y + vp.height >= total));
            if (op == 7) try std.testing.expectEqual(row_before -| 1, row);
            if (op == 8) try std.testing.expectEqual(@min(row_before + 1, total - 1), row);
            if (ev.text_buffer_view.wrap_mode == .none) {
                const cols = marginCells(vp.width, margin);
                try std.testing.expect(cursor.col >= vp.x + @min(cols, cursor.col));
                try std.testing.expect(cursor.col + cols < vp.x + vp.width);
            } else try std.testing.expectEqual(@as(u32, 0), vp.x);
        }
    }
}

test "EditorView - rejected text replacement preserves selection and viewport" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    inline for (.{ false, true }) |clean| {
        const eb = try EditBuffer.init(std.testing.allocator, &pool, &links, .unicode, null);
        defer eb.deinit();
        const ev = try EditorView.init(std.testing.allocator, eb, 10, 2);
        defer ev.deinit();
        const initial = "zero\none\ntwo\nthree\nfour\nfive";
        const mem_id = try eb.setTextOwned(initial, null);
        try eb.setCursor(5, 4);
        try eb.insertText("X");
        try eb.insertText("Y");
        _ = try eb.undo();
        ev.setSelection(1, 3, null, null);
        ev.desired_visual_col = 4;
        const lines = ev.getVirtualLines();
        const viewport = ev.getViewport();
        const selection = ev.getSelection();
        const cursor = ev.getPrimaryCursor();
        try std.testing.expect(viewport.?.y > 0);
        const view_id = try eb.tb.registerView();
        eb.tb.clearViewDirty(view_id);
        const before = eb.tb.rope().*;
        const add = eb.add_buffer;
        const epoch = eb.tb.getContentEpoch();
        const allocator = eb.tb.global_allocator;
        var failing = std.testing.FailingAllocator.init(allocator, .{ .fail_index = 0 });
        eb.tb.global_allocator = failing.allocator();
        const result = if (clean) eb.setTextOwned("new", mem_id) else if (eb.replaceText("new")) |_| mem_id else |err| err;
        eb.tb.global_allocator = allocator;
        try std.testing.expectError(error.OutOfMemory, result);
        try std.testing.expect(failing.has_induced_failure);
        try std.testing.expectEqual(before.root, eb.tb.rope().root);
        try std.testing.expectEqual(before.version, eb.tb.rope().version);
        try std.testing.expectEqual(before.undo_history, eb.tb.rope().undo_history);
        try std.testing.expectEqual(before.redo_history, eb.tb.rope().redo_history);
        try std.testing.expectEqual(before.curr_history, eb.tb.rope().curr_history);
        try std.testing.expectEqualDeep(add, eb.add_buffer);
        try std.testing.expectEqual(epoch, eb.tb.getContentEpoch());
        try std.testing.expect(!eb.tb.isViewDirty(view_id));
        try std.testing.expectEqualStrings(initial, eb.tb.getMemBuffer(mem_id).?);
        var actual: [64]u8 = undefined;
        try std.testing.expectEqualStrings(initial ++ "X", actual[0..eb.getText(&actual)]);
        try std.testing.expectEqualDeep(viewport, ev.getViewport());
        try std.testing.expectEqualDeep(selection, ev.getSelection());
        try std.testing.expectEqualDeep(cursor, ev.getPrimaryCursor());
        try std.testing.expectEqual(@as(?u32, 4), ev.desired_visual_col);
        try std.testing.expectEqual(lines.ptr, ev.getVirtualLines().ptr);
        try std.testing.expectEqual(lines.len, ev.getVirtualLines().len);

        _ = try eb.redo();
        try std.testing.expectEqualStrings(initial ++ "XY", actual[0..eb.getText(&actual)]);
        ev.resetSelection();
        const accepted = try if (clean) eb.setTextOwned("new", mem_id) else if (eb.replaceText("new")) |_| mem_id else |err| err;
        try std.testing.expectEqual(@as(u32, 0), ev.getViewport().?.y);
        try std.testing.expectEqualDeep(Cursor{ .row = 0, .col = 0 }, ev.getPrimaryCursor());
        try std.testing.expectEqual(@as(?u32, null), ev.desired_visual_col);
        try std.testing.expectEqual(@as(usize, 1), ev.getVirtualLines().len);
        if (clean) {
            try std.testing.expectEqual(mem_id, accepted);
            try std.testing.expect(!eb.canUndo());
            try std.testing.expect(!eb.canRedo());
            try std.testing.expectEqual(@as(usize, 0), eb.add_buffer.len);
        }
        try eb.insertText("!");
        try std.testing.expectEqualStrings("!new", actual[0..eb.getText(&actual)]);
        _ = try eb.undo();
        try std.testing.expectEqualStrings("new", actual[0..eb.getText(&actual)]);
        _ = try eb.redo();
        try std.testing.expectEqualStrings("!new", actual[0..eb.getText(&actual)]);
    }
}

test "EditorView - VisualCursor without wrapping" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.insertText("Hello World\nSecond Line\nThird Line");

    try eb.setCursor(1, 3);

    const vcursor = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 1), vcursor.visual_row);
    try std.testing.expectEqual(@as(u32, 3), vcursor.visual_col);
    try std.testing.expectEqual(@as(u32, 1), vcursor.logical_row);
    try std.testing.expectEqual(@as(u32, 3), vcursor.logical_col);
}

test "EditorView - VisualCursor with character wrapping" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    ev.setWrapMode(.char);

    try eb.setText("This is a very long line that will definitely wrap at 20 characters");

    try eb.setCursor(0, 25);

    const vcursor = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 0), vcursor.logical_row);
    try std.testing.expectEqual(@as(u32, 25), vcursor.logical_col);
    try std.testing.expect(vcursor.visual_row > 0);
    try std.testing.expect(vcursor.visual_col <= 20);
}

test "EditorView - VisualCursor with word wrapping" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    ev.setWrapMode(.word);

    try eb.setText("Hello world this is a test of word wrapping");

    const line_count = eb.getTextBuffer().getLineCount();
    try std.testing.expectEqual(@as(u32, 1), line_count);

    _ = ev.getVisualCursor();
}

test "EditorView - vertical moves keep the desired column and land on cursor-unit starts" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    const long = "This is a very long line that will definitely wrap multiple times at twenty characters";
    const empty_line = "Line with some text\n\nAnother line with text";
    // From (0, 1) into the width-2 unit at the start of line 1, and back to column 1 on ASCII lines.
    const wide = [_][2]u32{ .{ 1, 0 }, .{ 0, 1 }, .{ 1, 0 }, .{ 2, 1 }, .{ 1, 0 }, .{ 0, 1 }, .{ 1, 0 }, .{ 2, 1 }, .{ 1, 0 }, .{ 0, 1 } };
    const Case = struct { text: []const u8, wrap: text_buffer.WrapMode = .none, width: u32 = 20, placeholder: []const owned_styled.Part = &.{}, start: [2]u32, moves: []const u8, ends: []const [2]u32 };
    // u/d move the EditBuffer, U/D move the EditorView, a digit scrolls a one-row viewport to that
    // line with moveCursor, x types "x". Each end is the logical (row, col) after the move.
    const cases = [_]Case{
        .{ .text = long, .wrap = .char, .start = .{ 0, 50 }, .moves = "UD", .ends = &.{ .{ 0, 30 }, .{ 0, 50 } } },
        .{ .text = long, .wrap = .char, .start = .{ 0, 0 }, .moves = "D", .ends = &.{.{ 0, 20 }} },
        .{ .text = "Short line", .wrap = .char, .start = .{ 0, 0 }, .moves = "Uu", .ends = &.{ .{ 0, 0 }, .{ 0, 0 } } },
        .{ .text = "Short line\nSecond line", .wrap = .char, .start = .{ 1, 0 }, .moves = "Dd", .ends = &.{ .{ 1, 0 }, .{ 1, 0 } } },
        .{ .text = "1234567890" ** 5, .wrap = .char, .start = .{ 0, 15 }, .moves = "DDU", .ends = &.{ .{ 0, 35 }, .{ 0, 50 }, .{ 0, 35 } } },
        .{ .text = empty_line, .placeholder = &.{.{ .text = "hint\nhint" }}, .start = .{ 0, 10 }, .moves = "DDUU", .ends = &.{ .{ 1, 0 }, .{ 2, 10 }, .{ 1, 0 }, .{ 0, 10 } } },
        .{ .text = empty_line, .start = .{ 0, 10 }, .moves = "dduudU", .ends = &.{ .{ 1, 0 }, .{ 2, 10 }, .{ 1, 0 }, .{ 0, 10 }, .{ 1, 0 }, .{ 0, 0 } } },
        // 001: a move into a width-2 unit lands on its start; the desired column stays.
        .{ .text = "abc\n日本\nabc", .start = .{ 0, 1 }, .moves = "dUddUUDduu", .ends = &wide },
        .{ .text = "abc\n\tx\nabc", .start = .{ 0, 1 }, .moves = "dUddUUDduu", .ends = &wide },
        .{ .text = "abcd\n👍🏽👍🏽\nabcd", .start = .{ 0, 3 }, .moves = "ddUU", .ends = &.{ .{ 1, 2 }, .{ 2, 3 }, .{ 1, 2 }, .{ 0, 3 } } },
        .{ .text = "abc\n👨‍👩‍👧x\nabc", .start = .{ 0, 1 }, .moves = "dUddUUDduu", .ends = &wide },
        .{ .text = "abc\n日本\nabc", .start = .{ 0, 1 }, .moves = "1u1U1D12", .ends = &.{ .{ 1, 0 }, .{ 0, 1 }, .{ 1, 0 }, .{ 0, 1 }, .{ 1, 0 }, .{ 2, 1 }, .{ 1, 0 }, .{ 2, 1 } } },
        // #1289: cell boundaries 0, 2, 3, 5, ... above 0, 2, 4, ...
        .{ .text = "的[代码签名政策](\n因此签名批准者角色", .width = 40, .start = .{ 0, 5 }, .moves = "DUdu", .ends = &.{ .{ 1, 4 }, .{ 0, 5 }, .{ 1, 4 }, .{ 0, 5 } } },
        .{ .text = "的[代码因此签名政策", .wrap = .char, .width = 8, .start = .{ 0, 5 }, .moves = "DU", .ends = &.{ .{ 0, 11 }, .{ 0, 5 } } },
        // Down from the end of a line onto a soft-wrapped line steps back before the wrap.
        .{ .text = "0123456789\nquick brown fox", .wrap = .word, .width = 10, .start = .{ 0, 10 }, .moves = "D", .ends = &.{.{ 1, 5 }} },
        // 172: the placeholder's visual rows are not rows of the empty buffer.
        .{ .text = "", .placeholder = &.{.{ .text = "type here\nsecond line" }}, .start = .{ 0, 0 }, .moves = "UDUx", .ends = &.{ .{ 0, 0 }, .{ 0, 0 }, .{ 0, 0 }, .{ 0, 1 } } },
        .{ .text = "", .wrap = .char, .width = 10, .placeholder = &.{.{ .text = "a placeholder wider than the box" }}, .start = .{ 0, 0 }, .moves = "DDUx", .ends = &.{ .{ 0, 0 }, .{ 0, 0 }, .{ 0, 0 }, .{ 0, 1 } } },
    };
    for ([_]utf8.WidthMethod{ .unicode, .wcwidth }) |method| {
        const eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, method, null);
        defer eb.deinit();
        const ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
        defer ev.deinit();
        for (cases) |case| {
            ev.setViewport(.{ .x = 0, .y = 0, .width = case.width, .height = 10 }, false);
            ev.setWrapMode(case.wrap);
            try eb.setText(case.text);
            try eb.setCursor(case.start[0], case.start[1]);
            try owned_styled.setPlaceholder(ev, case.placeholder);
            for (case.moves, case.ends) |move, end| {
                errdefer std.debug.print("{t} {s}: {s}, move {c}\n", .{ method, case.text, case.moves, move });
                switch (move) {
                    'u' => eb.moveUp(),
                    'd' => eb.moveDown(),
                    'U' => ev.moveUpVisual(),
                    'D' => ev.moveDownVisual(),
                    'x' => try eb.insertText("x"),
                    '0'...'9' => ev.setViewport(.{ .x = 0, .y = move - '0', .width = case.width, .height = 1 }, true),
                    else => unreachable,
                }
                const cursor = ev.getPrimaryCursor();
                try std.testing.expectEqual(end, [2]u32{ cursor.row, cursor.col });
                try std.testing.expectEqual(ev.logicalToVisualCursor(cursor.row, cursor.col).offset, cursor.offset);
            }
        }
    }
}

test "EditorView - visualToLogicalCursor conversion" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    ev.setWrapMode(.char);

    try eb.setText("12345678901234567890123456789012345");

    if (ev.visualToLogicalCursor(1, 5)) |vcursor| {
        try std.testing.expectEqual(@as(u32, 1), vcursor.visual_row);
        try std.testing.expectEqual(@as(u32, 0), vcursor.logical_row);
        try std.testing.expectEqual(@as(u32, 25), vcursor.logical_col);
    }
}

test "EditorView - moveUpVisual resolves wrapped boundary with canonical conversion" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 10, 10);
    defer ev.deinit();

    ev.setWrapMode(.word);

    const text = "quick brown fox";
    try eb.setText(text);

    const line_info = ev.getCachedLineInfo();
    try std.testing.expectEqualSlices(u32, &[_]u32{ 6, 9 }, line_info.line_width_cols);

    const canonical_boundary_cursor = ev.visualToLogicalCursor(0, 6) orelse return error.MissingVisualCursor;
    try std.testing.expectEqual(@as(u32, 0), canonical_boundary_cursor.visual_row);
    try std.testing.expectEqual(@as(u32, 6), canonical_boundary_cursor.visual_col);
    try std.testing.expectEqual(@as(u32, 6), canonical_boundary_cursor.logical_col);

    const canonical_cursor_from_boundary = ev.logicalToVisualCursor(canonical_boundary_cursor.logical_row, canonical_boundary_cursor.logical_col);
    try std.testing.expectEqual(@as(u32, 1), canonical_cursor_from_boundary.visual_row);

    try eb.setCursor(0, text.len);
    var cursor = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 1), cursor.visual_row);
    try std.testing.expectEqual(@as(u32, 9), cursor.visual_col);

    ev.moveUpVisual();
    cursor = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.visual_row);
    try std.testing.expectEqual(@as(u32, 5), cursor.visual_col);
}

test "EditorView - consumed whitespace cursor columns clamp to preceding row" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode, null);
    defer eb.deinit();
    var ev = try EditorView.init(std.testing.allocator, eb, 5, 2);
    defer ev.deinit();
    ev.setWrapMode(.word);

    try eb.setText("hello  world");
    for ([_]u32{ 5, 6 }) |logical_col| {
        const cursor = ev.logicalToVisualCursor(0, logical_col);
        try std.testing.expectEqual(@as(u32, 0), cursor.visual_row);
        try std.testing.expectEqual(@as(u32, 5), cursor.visual_col);
    }
    const spaces_boundary = ev.logicalToVisualCursor(0, 7);
    try std.testing.expectEqual(@as(u32, 1), spaces_boundary.visual_row);
    try std.testing.expectEqual(@as(u32, 0), spaces_boundary.visual_col);

    eb.setTabWidth(4);
    try eb.setText("hello\tworld");
    for ([_]u32{ 5, 8 }) |logical_col| {
        const cursor = ev.logicalToVisualCursor(0, logical_col);
        try std.testing.expectEqual(@as(u32, 0), cursor.visual_row);
        try std.testing.expectEqual(@as(u32, 5), cursor.visual_col);
    }
    const tab_boundary = ev.logicalToVisualCursor(0, 9);
    try std.testing.expectEqual(@as(u32, 1), tab_boundary.visual_row);
    try std.testing.expectEqual(@as(u32, 0), tab_boundary.visual_col);

    try eb.setCursor(0, 8);
    try std.testing.expectEqual(@as(u32, 5), ev.getVisualCursor().visual_col);
    ev.moveDownVisual();
    const moved = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 1), moved.visual_row);
    try std.testing.expect(moved.visual_col <= 5);

    var opt_buffer = try opt_buffer_mod.OptimizedBuffer.init(
        std.testing.allocator,
        5,
        2,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .width_method = .unicode },
    );
    defer opt_buffer.deinit();
    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawEditorView(ev, 0, 0);
}

test "EditorView - VisualCursor with multiple logical lines and wrapping" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 20, 10);
    defer ev.deinit();

    ev.setWrapMode(.char);

    try eb.setText("Short line 1\nThis is a very long line that will wrap multiple times\nShort line 3");

    try eb.setCursor(1, 30);

    const vcursor = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 1), vcursor.logical_row);

    try std.testing.expect(vcursor.visual_row > 1);
}

test "EditorView - logicalToVisualCursor handles cursor past line end" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.setText("Short");

    const vcursor = ev.logicalToVisualCursor(0, 100);

    try std.testing.expectEqual(@as(u32, 0), vcursor.logical_row);
}

test "EditorView - getTextBufferView returns correct view" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    const tbv = ev.getTextBufferView();
    const vp = tbv.getViewport();
    try std.testing.expect(vp != null);
}

test "EditorView - getEditBuffer returns correct buffer" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    const returned_eb = ev.getEditBuffer();
    try std.testing.expect(returned_eb == eb);
}

test "EditorView - small viewport cursor movement preserves scrolling margins" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    const eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();
    const ev = try EditorView.init(std.testing.allocator, eb, 20, 1);
    defer ev.deinit();
    try eb.setText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10\nLine 11\nLine 12\nLine 13\nLine 14");

    for ([_]f32{ 0, 0.2, 0.5 }) |margin| {
        ev.setScrollMargin(margin);
        for ([_]u32{ 1, 2, 3, 10 }) |height| {
            const margin_lines = if (height == 1) 0 else @max(1, @as(u32, @intFromFloat(@as(f32, @floatFromInt(height)) * margin)));
            try eb.setCursor(14, 3);
            ev.setViewport(.{ .x = 0, .y = 0, .width = 20, .height = height }, true);
            try std.testing.expectEqual(height - margin_lines - 1, ev.getPrimaryCursor().row);
            try std.testing.expectEqual(@as(u32, 3), ev.getPrimaryCursor().col);
            try std.testing.expectEqual(@as(u32, 0), ev.getViewport().?.y);

            try eb.setCursor(0, 3);
            ev.setViewport(.{ .x = 0, .y = 3, .width = 20, .height = height }, true);
            try std.testing.expectEqual(3 + margin_lines, ev.getPrimaryCursor().row);
            try std.testing.expectEqual(@as(u32, 3), ev.getPrimaryCursor().col);
            try std.testing.expectEqual(@as(u32, 3), ev.getViewport().?.y);

            if (height == 1) {
                ev.updateBeforeRender();
                try std.testing.expectEqual(@as(u32, 3), ev.getViewport().?.y);
                ev.moveDownVisual();
                try std.testing.expectEqual(@as(u32, 4), ev.getPrimaryCursor().row);
                try std.testing.expectEqual(@as(u32, 4), ev.getViewport().?.y);
                ev.moveUpVisual();
                try std.testing.expectEqual(@as(u32, 3), ev.getPrimaryCursor().row);
                try std.testing.expectEqual(@as(u32, 3), ev.getViewport().?.y);
            }
        }
    }
}

test "EditorView - small viewport keeps a visible wrapped cursor in place" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    const eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();
    const ev = try EditorView.init(std.testing.allocator, eb, 5, 1);
    defer ev.deinit();
    ev.setScrollMargin(0.2);
    try eb.setText("abcd efgh ijkl");

    for ([_]text_buffer.WrapMode{ .char, .word }) |mode| {
        ev.setWrapMode(mode);
        try eb.setCursor(0, 1);
        ev.moveDownVisual();
        try std.testing.expectEqual(@as(u32, 1), ev.getViewport().?.y);
        const cursor = ev.getPrimaryCursor();
        ev.setViewport(ev.getViewport(), true);
        try std.testing.expectEqualDeep(cursor, ev.getPrimaryCursor());
        try std.testing.expectEqual(@as(u32, 0), ev.getVisualCursor().visual_row);
        try std.testing.expectEqual(@as(u32, 1), ev.getViewport().?.y);
        ev.moveUpVisual();
        try std.testing.expectEqual(@as(u32, 1), ev.getPrimaryCursor().col);
        try std.testing.expectEqual(@as(u32, 0), ev.getViewport().?.y);
    }
}

test "EditorView - small viewport accepts empty buffers and zero dimensions" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    const eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();
    const ev = try EditorView.init(std.testing.allocator, eb, 20, 1);
    defer ev.deinit();
    ev.setScrollMargin(0.2);

    ev.setViewport(ev.getViewport(), true);
    ev.moveDownVisual();
    ev.moveUpVisual();
    try std.testing.expectEqual(@as(u32, 0), ev.getPrimaryCursor().offset);
    try std.testing.expectEqual(@as(u32, 0), ev.getViewport().?.y);

    for ([_][]const u8{ "", "abc\ndef" }) |text| {
        try eb.setText(text);
        if (text.len > 0) try eb.setCursor(1, 2);
        const cursor = ev.getPrimaryCursor();
        for ([_]Viewport{
            .{ .x = 0, .y = 0, .width = 20, .height = 0 },
            .{ .x = 0, .y = 0, .width = 0, .height = 1 },
        }) |vp| {
            ev.setViewport(vp, true);
            ev.updateBeforeRender();
            try std.testing.expectEqualDeep(cursor, ev.getPrimaryCursor());
            try std.testing.expectEqualDeep(vp, ev.getViewport().?);
        }
        ev.setViewport(null, true);
        try std.testing.expectEqualDeep(cursor, ev.getPrimaryCursor());
        try std.testing.expectEqual(@as(?Viewport, null), ev.getViewport());
    }
}

test "EditorView - horizontal movement resets desired visual column" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.setText("Line with some text\n\nAnother line with text");

    try eb.setCursor(0, 10);

    const vcursor_initial = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 10), vcursor_initial.visual_col);

    ev.moveDownVisual();
    ev.moveDownVisual();

    const vcursor_after = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 2), vcursor_after.logical_row);
    try std.testing.expectEqual(@as(u32, 10), vcursor_after.visual_col);

    eb.moveRight();

    const vcursor_after_right = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 11), vcursor_after_right.visual_col);

    ev.moveUpVisual();
    ev.moveUpVisual();

    const vcursor_final = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 0), vcursor_final.logical_row);
    try std.testing.expectEqual(@as(u32, 11), vcursor_final.visual_col);
}

test "EditorView - inserting newlines maintains rope integrity" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Line 0\nLine 1\nLine 2");

    const rope_init = eb.getTextBuffer().rope();
    const line_count_init = eb.getTextBuffer().lineCount();
    try std.testing.expectEqual(@as(u32, 3), line_count_init);

    try eb.insertText("\n");

    const line_count_1 = eb.getTextBuffer().lineCount();
    try std.testing.expectEqual(@as(u32, 4), line_count_1);

    if (rope_init.getMarker(.linestart, 2)) |m2| {
        if (rope_init.getMarker(.linestart, 3)) |m3| {
            try std.testing.expect(m2.global_weight != m3.global_weight);
        }
    }

    try eb.insertText("\n");

    const line_count_2 = eb.getTextBuffer().lineCount();
    try std.testing.expectEqual(@as(u32, 5), line_count_2);

    if (rope_init.getMarker(.linestart, 3)) |m3| {
        if (rope_init.getMarker(.linestart, 4)) |m4| {
            try std.testing.expect(m3.global_weight != m4.global_weight);
        }
    }
}

test "EditorView - cursor positioning after wide grapheme" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.insertText("AB東CD");

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);
    try std.testing.expectEqual(@as(u32, 6), cursor.col);

    try eb.setCursor(0, 4);
    const cursor_after_move = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 4), cursor_after_move.col);

    const vcursor = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 0), vcursor.logical_row);
    try std.testing.expectEqual(@as(u32, 4), vcursor.logical_col);
    try std.testing.expectEqual(@as(u32, 4), vcursor.visual_col);
}

test "EditorView - backspace after wide grapheme updates cursor correctly" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.insertText("AB東CD");

    try eb.setCursor(0, 4);

    try eb.backspace();

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);
    try std.testing.expectEqual(@as(u32, 2), cursor.col);

    const vcursor = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 2), vcursor.logical_col);
    try std.testing.expectEqual(@as(u32, 2), vcursor.visual_col);

    var out_buffer: [100]u8 = undefined;
    const written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("ABCD", out_buffer[0..written]);
}

test "EditorView - cursor at second cell of width=2 grapheme moveLeft should jump to before grapheme" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    try eb.setText("(emoji 🌟 and CJK 世界)");

    try eb.setCursor(0, 7);
    var cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 7), cursor.col);

    // Move right - should jump over emoji to col 9
    eb.moveRight();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 9), cursor.col);

    // Manually set cursor to col 8 (second cell of emoji at 7-8)
    // TODO: setCursor should probably also snap to beginning of grapheme?
    //       When the width/cell based cursor is visual only and EditBuffer/Rope cursor is byte based
    try eb.setCursor(0, 8);
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 8), cursor.col);

    // Should jump to col 9 (after the emoji), not col 10
    eb.moveRight();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 9), cursor.col);

    try eb.setCursor(0, 8);
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 8), cursor.col);

    eb.moveLeft();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 6), cursor.col);
}

test "EditorView - cursor should be able to land after closing paren on line with wide graphemes" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    try eb.setText("(emoji 🌟 and CJK 世界)\nNext line");

    try eb.setCursor(0, 0);
    var cursor = eb.getPrimaryCursor();

    var i: u32 = 0;
    while (i < 30) : (i += 1) {
        const prev_col = cursor.col;
        const prev_row = cursor.row;
        eb.moveRight();
        cursor = eb.getPrimaryCursor();

        // Should not jump to next line until we've reached the end of the current line
        if (prev_row == 0 and cursor.row == 1) {
            // We jumped to the next line - check that we were at the end
            const iter_mod = @import("../text-buffer-iterators.zig");
            const line_width = iter_mod.lineWidthAt(eb.getTextBuffer().rope(), 0);
            try std.testing.expectEqual(line_width, prev_col);
            break;
        }

        if (i > 25) {
            break;
        }
    }

    try std.testing.expectEqual(@as(u32, 1), cursor.row);
    try std.testing.expectEqual(@as(u32, 0), cursor.col);
}

test "EditorView - visual cursor should stay on same line when moving to line end with wide graphemes" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    try eb.setText("(emoji 🌟 and CJK 世界)\nNext line");

    try eb.setCursor(0, 0);

    var i: u32 = 0;
    while (i < 30) : (i += 1) {
        eb.moveRight();
        const cursor = eb.getPrimaryCursor();
        const vcursor = ev.getVisualCursor();

        // Visual cursor should stay on row 0 until we move past the line end
        if (cursor.row == 0) {
            try std.testing.expectEqual(@as(u32, 0), vcursor.visual_row);
            try std.testing.expectEqual(cursor.col, vcursor.visual_col);
        }

        if (cursor.row == 1) {
            try std.testing.expectEqual(@as(u32, 1), vcursor.visual_row);
            break;
        }

        if (i > 25) break;
    }
}

test "EditorView - placeholder with styled text renders with correct highlights" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    const ss = @import("../syntax-style.zig");
    const style = try ss.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    eb.getTextBuffer().setSyntaxStyle(style);

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    const fg_gray = ansi.rgbaFromFloats(0.5, 0.5, 0.5, 1.0);
    const fg_blue = ansi.rgbaFromFloats(0.3, 0.5, 0.9, 1.0);

    try owned_styled.setPlaceholder(ev, &.{
        .{ .text = "Enter ", .fg = fg_gray },
        .{ .text = "something", .fg = fg_blue },
        .{ .text = " here", .fg = fg_gray },
    });

    var out_buffer: [100]u8 = undefined;
    const written = eb.getText(&out_buffer);
    try std.testing.expectEqual(@as(usize, 0), written);

    ev.updateBeforeRender();

    const tbv_ptr = ev.getTextBufferView();

    var opt_buffer = try opt_buffer_mod.OptimizedBuffer.init(
        std.testing.allocator,
        80,
        24,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .width_method = .wcwidth },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawTextBuffer(tbv_ptr, 0, 0);

    const epsilon: f32 = 0.01;

    const cell_0 = opt_buffer.get(0, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 'E'), cell_0.char);

    const cell_6 = opt_buffer.get(6, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, 's'), cell_6.char);

    const cell_15 = opt_buffer.get(15, 0) orelse unreachable;
    try std.testing.expectEqual(@as(u32, ' '), cell_15.char);

    const fg_0 = opt_buffer.buffer.fg[0];
    try std.testing.expect(@abs(ansi.redF(fg_0) - ansi.redF(fg_gray)) < epsilon);
    try std.testing.expect(@abs(ansi.greenF(fg_0) - ansi.greenF(fg_gray)) < epsilon);
    try std.testing.expect(@abs(ansi.blueF(fg_0) - ansi.blueF(fg_gray)) < epsilon);

    const fg_6 = opt_buffer.buffer.fg[6];
    try std.testing.expect(@abs(ansi.redF(fg_6) - ansi.redF(fg_blue)) < epsilon);
    try std.testing.expect(@abs(ansi.greenF(fg_6) - ansi.greenF(fg_blue)) < epsilon);
    try std.testing.expect(@abs(ansi.blueF(fg_6) - ansi.blueF(fg_blue)) < epsilon);

    const fg_15 = opt_buffer.buffer.fg[15];
    try std.testing.expect(@abs(ansi.redF(fg_15) - ansi.redF(fg_gray)) < epsilon);
    try std.testing.expect(@abs(ansi.greenF(fg_15) - ansi.greenF(fg_gray)) < epsilon);
    try std.testing.expect(@abs(ansi.blueF(fg_15) - ansi.blueF(fg_gray)) < epsilon);
}

test "EditorView - getNextWordBoundary returns VisualCursor" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.insertText("Hello World Test");
    try eb.setCursor(0, 0);

    const next_vcursor = ev.getNextWordBoundary();
    try std.testing.expectEqual(@as(u32, 0), next_vcursor.logical_row);
    try std.testing.expectEqual(@as(u32, 6), next_vcursor.logical_col);
    try std.testing.expectEqual(@as(u32, 0), next_vcursor.visual_row);
    try std.testing.expectEqual(@as(u32, 6), next_vcursor.visual_col);
}

test "EditorView - getPrevWordBoundary returns VisualCursor" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try eb.insertText("Hello World Test");
    try eb.setCursor(0, 12);

    const prev_vcursor = ev.getPrevWordBoundary();
    try std.testing.expectEqual(@as(u32, 0), prev_vcursor.logical_row);
    try std.testing.expectEqual(@as(u32, 6), prev_vcursor.logical_col);
    try std.testing.expectEqual(@as(u32, 0), prev_vcursor.visual_row);
    try std.testing.expectEqual(@as(u32, 6), prev_vcursor.visual_col);
}

test "EditorView - deleteSelectedText single line" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb_inst = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb_inst.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb_inst, 80, 24);
    defer ev.deinit();

    try eb_inst.setText("Hello World");

    ev.text_buffer_view.setSelection(0, 5, null, null);

    const sel_before = ev.text_buffer_view.getSelection();
    try std.testing.expect(sel_before != null);
    try std.testing.expectEqual(@as(u32, 0), sel_before.?.start);
    try std.testing.expectEqual(@as(u32, 5), sel_before.?.end);

    try ev.deleteSelectedText();

    var out_buffer: [100]u8 = undefined;
    const written = ev.getText(&out_buffer);
    try std.testing.expectEqualStrings(" World", out_buffer[0..written]);

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);
    try std.testing.expectEqual(@as(u32, 0), cursor.col);

    const sel_after = ev.text_buffer_view.getSelection();
    try std.testing.expect(sel_after == null);
}

test "EditorView - deleteSelectedText multi-line" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb_inst = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb_inst.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb_inst, 80, 24);
    defer ev.deinit();

    try eb_inst.setText("Line 1\nLine 2\nLine 3");

    ev.text_buffer_view.setSelection(2, 15, null, null);

    try ev.deleteSelectedText();

    var out_buffer: [100]u8 = undefined;
    const written = ev.getText(&out_buffer);
    try std.testing.expectEqualStrings("Liine 3", out_buffer[0..written]);

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);
    try std.testing.expectEqual(@as(u32, 2), cursor.col);
}

test "EditorView - deleteSelectedText with wrapping" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb_inst = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb_inst.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb_inst, 20, 10);
    defer ev.deinit();

    ev.setWrapMode(.char);

    try eb_inst.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ");

    const vline_count = ev.getTotalVirtualLineCount();
    try std.testing.expect(vline_count >= 2);

    ev.text_buffer_view.setSelection(5, 15, null, null);

    try ev.deleteSelectedText();

    var out_buffer: [100]u8 = undefined;
    const written = ev.getText(&out_buffer);
    try std.testing.expectEqualStrings("ABCDEPQRSTUVWXYZ", out_buffer[0..written]);

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);
    try std.testing.expectEqual(@as(u32, 5), cursor.col);
}

test "EditorView - deleteSelectedText with viewport scrolled" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb_inst = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb_inst.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb_inst, 40, 5);
    defer ev.deinit();

    try eb_inst.setText("Line 0\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10\nLine 11\nLine 12\nLine 13\nLine 14\nLine 15\nLine 16\nLine 17\nLine 18\nLine 19");

    try eb_inst.gotoLine(10);
    _ = ev.getVirtualLines();

    var vp = ev.getViewport().?;
    try std.testing.expect(vp.y > 0);

    ev.text_buffer_view.setSelection(50, 70, null, null);

    try ev.deleteSelectedText();

    _ = ev.getVirtualLines();
    vp = ev.getViewport().?;
    const cursor = ev.getPrimaryCursor();

    try std.testing.expect(cursor.row >= vp.y);
    try std.testing.expect(cursor.row < vp.y + vp.height);
}

test "EditorView - deleteSelectedText with no selection" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb_inst = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb_inst.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb_inst, 80, 24);
    defer ev.deinit();

    try eb_inst.setText("Hello World");

    try ev.deleteSelectedText();

    var out_buffer: [100]u8 = undefined;
    const written = ev.getText(&out_buffer);
    try std.testing.expectEqualStrings("Hello World", out_buffer[0..written]);
}

test "EditorView - deleteSelectedText entire line" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb_inst = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb_inst.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb_inst, 80, 24);
    defer ev.deinit();

    try eb_inst.setText("First\nSecond\nThird\n");

    ev.text_buffer_view.setSelection(5, 13, null, null);

    try ev.deleteSelectedText();

    var out_buffer: [100]u8 = undefined;
    const written = ev.getText(&out_buffer);
    try std.testing.expectEqualStrings("FirstThird\n", out_buffer[0..written]);

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);
    try std.testing.expectEqual(@as(u32, 5), cursor.col);
}

test "EditorView - deleteSelectedText respects selection with empty lines" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb_inst = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb_inst.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb_inst, 40, 10);
    defer ev.deinit();

    ev.setWrapMode(.word);

    try eb_inst.setText("AAAA\n\nBBBB\n\nCCCC");

    try eb_inst.setCursor(2, 0);

    _ = ev.text_buffer_view.setLocalSelection(0, 2, 4, 2, null, null);

    const sel = ev.text_buffer_view.getSelection();
    try std.testing.expect(sel != null);

    try std.testing.expectEqual(@as(u32, 6), sel.?.start);
    try std.testing.expectEqual(@as(u32, 10), sel.?.end);

    var selected_buffer: [100]u8 = undefined;
    const selected_len = ev.text_buffer_view.getSelectedTextIntoBuffer(&selected_buffer);
    const selected_text = selected_buffer[0..selected_len];
    try std.testing.expectEqualStrings("BBBB", selected_text);

    try ev.deleteSelectedText();

    var out_buffer: [100]u8 = undefined;
    const written = ev.getText(&out_buffer);
    try std.testing.expectEqualStrings("AAAA\n\n\n\nCCCC", out_buffer[0..written]);

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.row);
    try std.testing.expectEqual(@as(u32, 0), cursor.col);
}

test "EditorView - word wrapping with space insertion maintains cursor sync" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 15, 10);
    defer ev.deinit();

    ev.setWrapMode(.word);
    ev.setViewport(.{ .x = 0, .y = 0, .width = 15, .height = 10 }, true);

    try eb.setText("AAAAAAAAAAAAAAAAAAA");
    try eb.setCursor(0, 7);
    try eb.insertText(" ");

    const logical_cursor_after_space = eb.getPrimaryCursor();
    const vcursor_after_space = ev.getVisualCursor();

    try std.testing.expectEqual(@as(u32, 0), logical_cursor_after_space.row);
    try std.testing.expectEqual(@as(u32, 8), logical_cursor_after_space.col);

    try std.testing.expectEqual(@as(u32, 0), vcursor_after_space.logical_row);
    try std.testing.expectEqual(@as(u32, 1), vcursor_after_space.visual_row);

    try eb.backspace();

    const logical_cursor_after_backspace = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), logical_cursor_after_backspace.row);
    try std.testing.expectEqual(@as(u32, 7), logical_cursor_after_backspace.col);
}

test "EditorView - getVisualCursor always returns on empty buffer" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    const vcursor = ev.getVisualCursor();
    try std.testing.expectEqual(@as(u32, 0), vcursor.visual_row);
    try std.testing.expectEqual(@as(u32, 0), vcursor.visual_col);
    try std.testing.expectEqual(@as(u32, 0), vcursor.logical_row);
    try std.testing.expectEqual(@as(u32, 0), vcursor.logical_col);
}

test "EditorView - logicalToVisualCursor clamps row beyond last line" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    try eb.setText("Line 1\nLine 2\nLine 3");

    const vcursor = ev.logicalToVisualCursor(100, 0);
    try std.testing.expectEqual(@as(u32, 2), vcursor.logical_row);
    try std.testing.expectEqual(@as(u32, 0), vcursor.logical_col);
}

test "EditorView - logicalToVisualCursor clamps col beyond line width" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    try eb.setText("Hello");

    const vcursor = ev.logicalToVisualCursor(0, 100);
    try std.testing.expectEqual(@as(u32, 0), vcursor.logical_row);
    try std.testing.expectEqual(@as(u32, 5), vcursor.logical_col);
    try std.testing.expectEqual(@as(u32, 5), vcursor.visual_col);
}

test "EditorView - placeholder initialization rejection leaves no published ownership" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    var fail_offset: usize = 0;
    while (fail_offset < 64) : (fail_offset += 1) {
        var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        const eb = try EditBuffer.init(failing.allocator(), &pool, &links, .unicode, null);
        defer eb.deinit();
        const ev = try EditorView.init(failing.allocator(), eb, 10, 2);
        defer ev.deinit();
        const view = ev.getTextBufferView();
        const lines = ev.getVirtualLines();
        failing.fail_index = failing.alloc_index + fail_offset;
        const result = owned_styled.setPlaceholder(ev, &.{.{ .text = "hint", .attributes = 1 }});
        failing.fail_index = std.math.maxInt(usize);
        if (result) |_| {
            return;
        } else |err| {
            try std.testing.expectEqual(error.OutOfMemory, err);
            try std.testing.expect(ev.placeholder_buffer == null);
            try std.testing.expect(ev.placeholder_syntax_style == null);
            try std.testing.expect(!ev.placeholder_active);
            try std.testing.expectEqual(view, ev.getTextBufferView());
            try std.testing.expectEqual(eb.tb, ev.getTextBuffer());
            try std.testing.expectEqual(lines.ptr, ev.getVirtualLines().ptr);
        }
    }
    return error.TestUnexpectedResult;
}

fn setOwnedPlaceholderForTest(ev: *EditorView, bytes: []const u8, url: []const u8) !void {
    const allocator = ev.global_allocator;
    const style = try text_buffer.SyntaxStyle.init(allocator);
    errdefer style.deinit();
    var prepared_links = link.LinkTracker.init(allocator, ev.edit_buffer.tb.link_pool);
    defer prepared_links.deinit();
    const id = try prepared_links.trackUrl(url);
    const style_id = try style.registerStyle("hint", ansi.rgbaFromFloats(0.5, 0.5, 0.5, 1), null, ansi.TextAttributes.setLinkId(1, id));
    const copy = try allocator.dupe(u8, bytes);
    errdefer allocator.free(copy);
    try ev.setPlaceholderOwnedStyledText(copy, style, &.{.{
        .byte_count = @intCast(bytes.len),
        .style_id = style_id,
    }}, &prepared_links);
    std.debug.assert(prepared_links.getLinkCount() == 0);
}

test "EditorView - placeholder owned replacement preserves accepted state on allocation failure" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    for ([_]enum { absent, visible, hidden }{ .absent, .visible, .hidden }) |initial| {
        var succeeded = false;
        var fail_offset: usize = 0;
        while (fail_offset < 128) : (fail_offset += 1) {
            var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
            const allocator = failing.allocator();
            var links = link.LinkPool.init(allocator);
            defer links.deinit();
            const eb = try EditBuffer.init(allocator, &pool, &links, .unicode, null);
            defer eb.deinit();
            const ev = try EditorView.init(allocator, eb, 10, 2);
            defer ev.deinit();
            if (initial != .absent) {
                try setOwnedPlaceholderForTest(ev, "old\u{754c}", "https://example.com/old");
            }
            if (initial == .hidden) try eb.setText("document");
            const view = ev.getTextBufferView();
            ev.setSelection(0, 1, null, null);
            const lines = ev.getVirtualLines();
            const viewport = ev.getViewport();
            const selection = ev.getSelection();
            const measured = try view.measureForDimensions(10, 2);
            const old_buffer = ev.placeholder_buffer;
            const old_style = ev.placeholder_syntax_style;
            const active_buffer = ev.getTextBuffer();
            const epoch = active_buffer.getContentEpoch();
            const old_link_count = links.getLiveSlotCount();
            var dependent = try @import("../native-renderable.zig").NativeRenderable.init();
            defer dependent.deinit();
            try dependent.setMeasureTarget(.{ .editor_view = ev });

            failing.fail_index = failing.alloc_index + fail_offset;
            failing.resize_fail_index = failing.resize_index;
            const result = setOwnedPlaceholderForTest(ev, "new\u{754c}\tline\nsecond", "https://example.com/new");
            failing.fail_index = std.math.maxInt(usize);
            failing.resize_fail_index = std.math.maxInt(usize);
            if (result) |_| {
                try std.testing.expect(!failing.has_induced_failure);
                succeeded = true;
            } else |err| {
                try std.testing.expectEqual(error.OutOfMemory, err);
                try std.testing.expect(failing.has_induced_failure);
                try std.testing.expectEqual(old_buffer, ev.placeholder_buffer);
                try std.testing.expectEqual(old_style, ev.placeholder_syntax_style);
                try std.testing.expectEqual(initial == .visible, ev.placeholder_active);
                try std.testing.expectEqual(active_buffer, ev.getTextBuffer());
                try std.testing.expectEqual(epoch, active_buffer.getContentEpoch());
                try std.testing.expectEqualDeep(viewport, ev.getViewport());
                try std.testing.expectEqualDeep(selection, ev.getSelection());
                try std.testing.expectEqual(lines.ptr, ev.getVirtualLines().ptr);
                try std.testing.expectEqualDeep(measured, try view.measureForDimensions(10, 2));
                try std.testing.expectEqual(old_link_count, links.getLiveSlotCount());
                if (old_buffer) |buffer| {
                    var actual: [64]u8 = undefined;
                    try std.testing.expectEqualStrings("old\u{754c}", actual[0..buffer.getTextRange(0, std.math.maxInt(u32), &actual)]);
                    const highlight = buffer.getLineHighlightsSlice(0)[0];
                    const definition = old_style.?.resolveById(highlight.style_id).?;
                    const id = ansi.TextAttributes.getLinkId(definition.attributes);
                    try std.testing.expectEqual(@as(u32, 1), try links.getRefcount(id));
                    try std.testing.expectEqual(@as(u32, 5), highlight.col_end);
                }
                try setOwnedPlaceholderForTest(ev, "new\u{754c}\tline\nsecond", "https://example.com/new");
            }
            try std.testing.expectEqual(view, ev.getTextBufferView());
            try std.testing.expectEqual(ev, dependent.measure_target.editor_view);
            try std.testing.expectEqual(&dependent, ev.measure_dependents.?);
            try std.testing.expectEqual(@as(u64, 1), links.getLiveSlotCount());
            try std.testing.expectEqual(@as(usize, 1), ev.placeholder_buffer.?.mem_registry.buffers.items.len);
            ev.clearPlaceholder();
            try std.testing.expectEqual(eb.tb, ev.getTextBuffer());
            try std.testing.expectEqual(ev, dependent.measure_target.editor_view);
            try std.testing.expectEqual(@as(u64, 0), links.getLiveSlotCount());
            if (succeeded) break;
        }
        try std.testing.expect(succeeded);
    }
}

test "EditorView - placeholder owned rejection retains caller inputs and legacy rendering" {
    const allocator = std.testing.allocator;
    var pool = gp.GraphemePool.init(allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(allocator);
    defer links.deinit();
    const eb = try EditBuffer.init(allocator, &pool, &links, .unicode, null);
    defer eb.deinit();
    const ev = try EditorView.init(allocator, eb, 6, 2);
    defer ev.deinit();
    const background = ansi.indexedColor(254, 228, 228, 228);
    eb.tb.setDefaultBg(background);
    const style = try text_buffer.SyntaxStyle.init(allocator);
    var transferred = false;
    defer if (!transferred) style.deinit();
    var prepared_links = link.LinkTracker.init(allocator, &links);
    defer prepared_links.deinit();
    const id = try prepared_links.trackUrl("https://example.com/hint");
    const style_id = try style.registerStyle("hint", null, null, ansi.TextAttributes.setLinkId(1, id));
    const copy = try allocator.dupe(u8, "H\u{754c}");
    defer if (!transferred) allocator.free(copy);
    for ([_]bool{ false, true }) |has_previous| {
        if (has_previous) try owned_styled.setPlaceholder(ev, &.{.{ .text = "legacy", .attributes = 1 }});
        const old_buffer = ev.placeholder_buffer;
        const old_style = ev.placeholder_syntax_style;
        const active = ev.getTextBuffer();
        try std.testing.expectError(error.InvalidIndex, ev.setPlaceholderOwnedStyledText(copy, style, &.{.{
            .byte_count = @intCast(copy.len + 1),
            .style_id = style_id,
        }}, &prepared_links));
        try std.testing.expectEqual(old_buffer, ev.placeholder_buffer);
        try std.testing.expectEqual(old_style, ev.placeholder_syntax_style);
        try std.testing.expectEqual(active, ev.getTextBuffer());
        try std.testing.expectEqualStrings("H\u{754c}", copy);
        try std.testing.expectEqual(@as(u32, 1), prepared_links.getLinkCount());
        try std.testing.expectEqual(@as(u32, 1), try links.getRefcount(id));
    }
    try ev.setPlaceholderOwnedStyledText(copy, style, &.{.{
        .byte_count = @intCast(copy.len),
        .style_id = style_id,
    }}, &prepared_links);
    transferred = true;
    try std.testing.expectEqual(@as(u32, 0), prepared_links.getLinkCount());
    try std.testing.expectEqual(@as(u32, 3), ev.placeholder_buffer.?.getLength());
    var output = try opt_buffer_mod.OptimizedBuffer.init(allocator, 6, 2, .{ .pool = &pool, .link_pool = &links, .width_method = .unicode });
    defer output.deinit();
    output.clear(ansi.rgbaFromFloats(0, 0, 0, 1), 32);
    output.drawEditorView(ev, 0, 0);
    var actual: [64]u8 = undefined;
    const count = try output.writeResolvedChars(&actual, false);
    try std.testing.expect(std.mem.startsWith(u8, actual[0..count], "H\u{754c}"));
    for (0..3) |x| {
        const cell = output.get(@intCast(x), 0).?;
        try std.testing.expectEqual(id, ansi.TextAttributes.getLinkId(cell.attributes));
        try std.testing.expectEqual(background, cell.bg);
    }
    try std.testing.expectEqual(background, output.get(5, 0).?.bg);
    try std.testing.expectEqual(background, output.get(0, 1).?.bg);
    try owned_styled.setPlaceholder(ev, &.{.{ .text = "legacy", .attributes = 1 }});
    try std.testing.expectEqualStrings("legacy", actual[0..ev.getTextBuffer().getTextRange(0, std.math.maxInt(u32), &actual)]);
    ev.clearPlaceholder();
    try std.testing.expectEqual(eb.tb, ev.getTextBuffer());
}

test "EditorView - placeholder shows when empty" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try owned_styled.setPlaceholder(ev, &.{.{
        .text = "Enter text here...",
        .fg = ansi.rgbaFromFloats(0.4, 0.4, 0.4, 1.0),
    }});

    var out_buffer: [100]u8 = undefined;
    const text_len = eb.getText(&out_buffer);
    try std.testing.expectEqual(@as(usize, 0), text_len);

    try std.testing.expect(ev.placeholder_buffer != null);
    const placeholder = ev.placeholder_buffer.?;
    try std.testing.expectEqual(@as(u32, 18), placeholder.getLength());
}

test "EditorView - placeholder cleared when set to empty" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try owned_styled.setPlaceholder(ev, &.{.{
        .text = "Placeholder",
        .fg = ansi.rgbaFromFloats(0.4, 0.4, 0.4, 1.0),
    }});

    try std.testing.expect(ev.placeholder_buffer != null);

    ev.clearPlaceholder();

    try std.testing.expect(ev.placeholder_buffer == null);
}

test "EditorView - placeholder with styled text" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    const red_color = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const blue_color = ansi.rgbaFromFloats(0.0, 0.0, 1.0, 1.0);

    try owned_styled.setPlaceholder(ev, &.{
        .{ .text = "Hello ", .fg = red_color },
        .{ .text = "World", .fg = blue_color },
    });

    try std.testing.expect(ev.placeholder_buffer != null);
    const placeholder = ev.placeholder_buffer.?;
    try std.testing.expectEqual(@as(u32, 11), placeholder.getLength());
}

test "EditorView - placeholder renders to buffer when empty" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    try owned_styled.setPlaceholder(ev, &.{.{
        .text = "Type something...",
        .fg = ansi.rgbaFromFloats(0.5, 0.5, 0.5, 1.0),
    }});

    try std.testing.expect(ev.placeholder_buffer != null);
    try std.testing.expect(ev.placeholder_active);

    var opt_buffer = try opt_buffer_mod.OptimizedBuffer.init(
        std.testing.allocator,
        80,
        10,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .width_method = .wcwidth },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawEditorView(ev, 0, 0);

    var out_buffer: [1000]u8 = undefined;
    const written = try opt_buffer.writeResolvedChars(&out_buffer, false);
    const result = out_buffer[0..written];

    try std.testing.expect(std.mem.startsWith(u8, result, "Type something..."));

    try eb.insertText("Hello");

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawEditorView(ev, 0, 0);
    try std.testing.expect(!ev.placeholder_active);

    const written2 = try opt_buffer.writeResolvedChars(&out_buffer, false);
    const result2 = out_buffer[0..written2];

    try std.testing.expect(std.mem.startsWith(u8, result2, "Hello"));
    try std.testing.expect(!std.mem.startsWith(u8, result2, "Type something..."));
}

test "EditorView - placeholder shrink clears tail and preserves background" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 10);
    defer ev.deinit();

    const long_text = "Ask anything... \"Fix a TODO in the codebase\"";
    const short_text = "Run a command... \"pwd\"";
    const fg = ansi.rgbaFromFloats(0.6, 0.6, 0.6, 1.0);
    const panel_bg = ansi.rgbaFromFloats(0.14, 0.14, 0.16, 1.0);

    var opt_buffer = try opt_buffer_mod.OptimizedBuffer.init(
        std.testing.allocator,
        120,
        10,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .width_method = .wcwidth },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);

    var x: u32 = 0;
    while (x < 80) : (x += 1) {
        opt_buffer.set(x, 0, .{ .char = 32, .fg = fg, .bg = panel_bg, .attributes = 0 });
    }

    try owned_styled.setPlaceholder(ev, &.{.{ .text = long_text, .fg = fg }});
    opt_buffer.drawEditorView(ev, 0, 0);

    x = 0;
    while (x < 80) : (x += 1) {
        opt_buffer.set(x, 0, .{ .char = 32, .fg = fg, .bg = panel_bg, .attributes = 0 });
    }

    try owned_styled.setPlaceholder(ev, &.{.{ .text = short_text, .fg = fg }});
    opt_buffer.drawEditorView(ev, 0, 0);

    var out_buffer: [1600]u8 = undefined;
    const written = try opt_buffer.writeResolvedChars(&out_buffer, false);
    const line = out_buffer[0..written];

    try std.testing.expect(std.mem.find(u8, line, short_text) != null);
    try std.testing.expect(std.mem.find(u8, line, "roken tests") == null);
    try std.testing.expect(std.mem.find(u8, line, "TODO in the codebase") == null);

    const tail = opt_buffer.get(35, 0) orelse return error.TestUnexpectedResult;
    try std.testing.expectEqual(@as(u32, 32), tail.char);
    try std.testing.expectEqual(panel_bg, tail.bg);
}

test "EditorView - translucent default background fills viewport without double blending" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 6, 2);
    defer ev.deinit();

    try eb.setText("abc");
    eb.tb.setDefaultBg(ansi.rgbaFromFloats(1.0, 0.0, 0.0, 0.5));

    var opt_buffer = try opt_buffer_mod.OptimizedBuffer.init(
        std.testing.allocator,
        6,
        2,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .width_method = .wcwidth },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawEditorView(ev, 0, 0);

    const text_cell = opt_buffer.get(0, 0).?;
    const trailing_cell = opt_buffer.get(3, 0).?;
    const blank_row_cell = opt_buffer.get(0, 1).?;

    try std.testing.expectEqual(@as(u32, 'a'), text_cell.char);
    try std.testing.expectEqual(@as(u32, 32), trailing_cell.char);
    try std.testing.expectEqual(@as(u32, 32), blank_row_cell.char);
    try std.testing.expectEqual(text_cell.bg, trailing_cell.bg);
    try std.testing.expectEqual(trailing_cell.bg, blank_row_cell.bg);
}

test "EditorView - placeholder uses original default background fill" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 6, 2);
    defer ev.deinit();

    eb.tb.setDefaultBg(ansi.indexedColor(254, 228, 228, 228));
    try owned_styled.setPlaceholder(ev, &.{.{
        .text = "hint",
        .fg = ansi.rgbaFromFloats(0.5, 0.5, 0.5, 1.0),
    }});

    var opt_buffer = try opt_buffer_mod.OptimizedBuffer.init(
        std.testing.allocator,
        6,
        2,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .width_method = .wcwidth },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawEditorView(ev, 0, 0);

    const text_cell = opt_buffer.get(0, 0).?;
    const trailing_cell = opt_buffer.get(4, 0).?;
    const blank_row_cell = opt_buffer.get(0, 1).?;

    try std.testing.expectEqual(@as(u32, 'h'), text_cell.char);
    try std.testing.expectEqual(@as(u32, 32), trailing_cell.char);
    try std.testing.expectEqual(@as(u32, 32), blank_row_cell.char);
    try std.testing.expectEqual(ansi.ColorIntent.indexed, ansi.intent(text_cell.bg));
    try std.testing.expectEqual(ansi.ColorIntent.indexed, ansi.intent(trailing_cell.bg));
    try std.testing.expectEqual(ansi.ColorIntent.indexed, ansi.intent(blank_row_cell.bg));
    try std.testing.expectEqual(@as(u8, 254), ansi.slot(text_cell.bg));
    try std.testing.expectEqual(@as(u8, 255), ansi.alpha(text_cell.bg));
    try std.testing.expectEqual(@as(u8, 255), ansi.alpha(blank_row_cell.bg));
}

test "EditorView - tab indicator set and get" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    try std.testing.expect(ev.getTabIndicator() == null);
    try std.testing.expect(ev.getTabIndicatorColor() == null);

    ev.setTabIndicator('·');
    ev.setTabIndicatorColor(ansi.rgbaFromFloats(0.5, 0.5, 0.5, 1.0));

    try std.testing.expectEqual(@as(u32, '·'), ev.getTabIndicator().?);
    try std.testing.expectEqual(@as(u8, 128), ansi.red(ev.getTabIndicatorColor().?));
}

test "EditorView - tab indicator renders in buffer" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    eb.setTabWidth(4);
    try eb.insertText("A\tB");

    ev.setTabIndicator('→');
    ev.setTabIndicatorColor(ansi.rgbaFromFloats(0.3, 0.3, 0.3, 1.0));

    var opt_buffer = try opt_buffer_mod.OptimizedBuffer.init(
        std.testing.allocator,
        20,
        10,
        .{ .link_pool = &pools.links, .pool = &pools.graphemes, .width_method = .wcwidth },
    );
    defer opt_buffer.deinit();

    opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    opt_buffer.drawEditorView(ev, 0, 0);

    const cell_0 = opt_buffer.get(0, 0);
    try std.testing.expect(cell_0 != null);
    try std.testing.expectEqual(@as(u32, 'A'), cell_0.?.char);

    const cell_1 = opt_buffer.get(1, 0);
    try std.testing.expect(cell_1 != null);
    try std.testing.expectEqual(@as(u32, '→'), cell_1.?.char);
    try std.testing.expectEqual(@as(u8, 77), ansi.red(cell_1.?.fg));

    const cell_2 = opt_buffer.get(2, 0);
    try std.testing.expect(cell_2 != null);
    try std.testing.expectEqual(@as(u32, 32), cell_2.?.char);

    const cell_3 = opt_buffer.get(3, 0);
    try std.testing.expect(cell_3 != null);
    try std.testing.expectEqual(@as(u32, 32), cell_3.?.char);

    const cell_4 = opt_buffer.get(4, 0);
    try std.testing.expect(cell_4 != null);
    try std.testing.expectEqual(@as(u32, 32), cell_4.?.char);

    const cell_5 = opt_buffer.get(5, 0);
    try std.testing.expect(cell_5 != null);
    try std.testing.expectEqual(@as(u32, 'B'), cell_5.?.char);
}

test "EditorView - word wrapping during editing: typing with incremental wrapping" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 17, 10);
    defer ev.deinit();

    ev.setWrapMode(.word);

    // Type "Hello world ddddddddd" character by character
    // Width=17
    // "Hello world " = 12 chars
    // "Hello world ddddd" = 17 chars (fits exactly on one line)
    // "Hello world dddddd" = 18 chars (should wrap after "world ", moving ALL d's to next line)
    //
    // The key issue: word wrapping should keep the break point AFTER "world " consistently
    // When "Hello world dddddd" (18 chars) wraps, it should become:
    //   Line 1: "Hello world " (12 chars)
    //   Line 2: "dddddd" (6 chars)
    // NOT:
    //   Line 1: "Hello world ddddd" (17 chars)
    //   Line 2: "d" (1 char)
    const text_to_type = "Hello world ddddddddd";

    for (text_to_type, 0..) |char, i| {
        var char_buf: [1]u8 = .{char};
        try eb.insertText(&char_buf);
        _ = ev.getVirtualLines();

        const vline_count = ev.getTotalVirtualLineCount();
        const cursor = ev.getPrimaryCursor();

        // "Hello world " = 12 chars (i=11 completes this)
        // "Hello world d" through "Hello world ddddd" = 13-17 chars (i=12 to i=16)
        // "Hello world dddddd" = 18 chars (i=17) - should wrap AFTER "world "
        const current_len = i + 1;
        if (current_len <= 17) {
            // Should fit on 1 line
            try std.testing.expectEqual(@as(u32, 1), vline_count);
        } else {
            // Should wrap AFTER "world ", moving ALL d's to line 2
            try std.testing.expectEqual(@as(u32, 2), vline_count);

            // Cursor should still be on row 0 (single logical line that wrapped)
            try std.testing.expectEqual(@as(u32, 0), cursor.row);
        }
    }

    // Now we have "Hello world ddddddddd" (21 chars) with word wrapping at width=17
    // Should be: "Hello world " (12 chars) on vline 1, "ddddddddd" (9 chars) on vline 2
    var vline_count = ev.getTotalVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 2), vline_count);

    // Backspace to remove d's until only 2 remain: "Hello world dd"
    // We need to delete 7 d's (from 9 d's to 2 d's)
    var i: usize = 0;
    while (i < 7) : (i += 1) {
        try eb.backspace();
        _ = ev.getVirtualLines();
    }

    // After removing 7 d's, we should have "Hello world dd" (14 chars)
    // This should fit on one line at width=17
    vline_count = ev.getTotalVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 1), vline_count);

    var cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);
    try std.testing.expectEqual(@as(u32, 14), cursor.col);

    // Now type more d's again - should wrap correctly after "world "
    // Starting with "Hello world dd" (14 chars)
    const more_ds = "ddddddd";
    for (more_ds, 0..) |char, j| {
        var char_buf: [1]u8 = .{char};
        try eb.insertText(&char_buf);
        _ = ev.getVirtualLines();

        vline_count = ev.getTotalVirtualLineCount();

        // After each d:
        // j=0: "Hello world ddd" (15) - fits on 1 line
        // j=1: "Hello world dddd" (16) - fits on 1 line
        // j=2: "Hello world ddddd" (17) - fits exactly on 1 line
        // j=3: "Hello world dddddd" (18) - should wrap AFTER "world ", moving ALL d's to line 2
        // j=4: "Hello world ddddddd" (19) - still wrapped same way
        // j=5: "Hello world dddddddd" (20) - still wrapped same way
        // j=6: "Hello world ddddddddd" (21) - still wrapped same way
        const current_len = 14 + j + 1;
        if (current_len <= 17) {
            // Should fit on 1 line
            try std.testing.expectEqual(@as(u32, 1), vline_count);
        } else {
            // Should wrap AFTER "world ", moving ALL d's to line 2
            // This is the key: the wrap point should stay at "world " boundary
            try std.testing.expectEqual(@as(u32, 2), vline_count);

            // CRITICAL: Check that first virtual line is "Hello world " (12 chars)
            // and second virtual line has all the d's
            const vlines = ev.getVirtualLines();
            try std.testing.expect(vlines.len == 2);

            // First vline should be "Hello world " with width 12
            try std.testing.expectEqual(@as(u32, 12), vlines[0].width_cols);

            // Second vline should have all the d's (the original "dd" plus newly typed d's)
            const expected_d_count: u32 = @as(u32, 2) + @as(u32, @intCast(j + 1)); // dd + newly typed d's
            try std.testing.expectEqual(expected_d_count, vlines[1].width_cols);
        }
    }

    // After adding 7 more d's, we have "Hello world ddddddddd" (21 chars) again
    // Should wrap after "world " into 2 lines
    vline_count = ev.getTotalVirtualLineCount();
    try std.testing.expectEqual(@as(u32, 2), vline_count);

    cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);

    // Verify the text is correct
    var out_buffer: [100]u8 = undefined;
    const written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("Hello world ddddddddd", out_buffer[0..written]);
}

test "EditorView - mouse selection doesn't scroll when focus is within viewport" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 40, 10);
    defer ev.deinit();

    // Create 50 lines of text
    var i: u32 = 0;
    while (i < 50) : (i += 1) {
        if (i > 0) try eb.insertText("\n");
        try eb.insertText("Line ");
        var num_buf: [10]u8 = undefined;
        const num_str = try std.fmt.bufPrint(&num_buf, "{d}", .{i});
        try eb.insertText(num_str);
    }

    // Reset cursor to top
    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();

    const vp_initial = ev.getViewport().?;
    try std.testing.expectEqual(@as(u32, 0), vp_initial.y);

    // Simulate selection within the viewport (lines 0-5, all visible)
    _ = ev.setLocalSelection(0, 0, 5, 5, null, null, true);
    _ = ev.getVirtualLines();

    const vp_after = ev.getViewport().?;

    // Viewport should not have changed
    try std.testing.expectEqual(vp_initial.y, vp_after.y);
    try std.testing.expectEqual(vp_initial.x, vp_after.x);
}

test "EditorView - mouse selection focus outside buffer bounds clamps correctly" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 40, 10);
    defer ev.deinit();

    // Create just 10 lines
    var i: u32 = 0;
    while (i < 10) : (i += 1) {
        if (i > 0) try eb.insertText("\n");
        try eb.insertText("Line ");
        var num_buf: [10]u8 = undefined;
        const num_str = try std.fmt.bufPrint(&num_buf, "{d}", .{i});
        try eb.insertText(num_str);
    }

    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();

    // Try to select way beyond buffer (to line 100)
    _ = ev.setLocalSelection(0, 0, 5, 100, null, null, true);
    _ = ev.getVirtualLines();

    const cursor = ev.getPrimaryCursor();

    // Cursor should be clamped to last line (line 9)
    try std.testing.expectEqual(@as(u32, 9), cursor.row);
}

test "EditorView - cursor syncs to focus not selection end for inclusive forward selection" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    try eb.insertText("Hello World");
    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();

    // Forward selection from cell 0 to cell 5: inclusive end is 6, but the
    // cursor must land on the focus (5), not the extended end.
    _ = ev.setLocalSelection(0, 0, 5, 0, null, null, true);

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);
    try std.testing.expectEqual(@as(u32, 5), cursor.col);
}

test "EditorView - backward selection keeps anchor cell and cursor at focus" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    try eb.insertText("Hello World");
    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();

    // Press at cell 8, drag left to cell 6: cells 6..8 selected = "Wor",
    // cursor at the focus cell 6.
    _ = ev.setLocalSelection(8, 0, 8, 0, null, null, true);
    _ = ev.updateLocalSelection(8, 0, 6, 0, null, null, true);

    var out_buffer: [100]u8 = undefined;
    const len = ev.getSelectedTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Wor", out_buffer[0..len]);

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);
    try std.testing.expectEqual(@as(u32, 6), cursor.col);
}

test "occupancy - EditorView forwards occupancy and replays stored endpoints" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    try eb.insertText("Hello");
    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();

    try std.testing.expectEqual(text_buffer_view.SelectionOccupancy.cell, ev.getSelectionOccupancy());

    _ = ev.setLocalSelection(0, 0, 1, 0, null, null, true);
    var out: [100]u8 = undefined;
    var len = ev.getSelectedTextIntoBuffer(&out);
    try std.testing.expectEqualStrings("He", out[0..len]);

    const cursor_before = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 1), cursor_before.col);

    ev.setSelectionOccupancy(.boundary);
    try std.testing.expectEqual(text_buffer_view.SelectionOccupancy.boundary, ev.getSelectionOccupancy());
    len = ev.getSelectedTextIntoBuffer(&out);
    try std.testing.expectEqualStrings("H", out[0..len]);

    // Occupancy replay must not move the stored focus.
    const cursor_after = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 1), cursor_after.col);

    try eb.setText("\u{1F44B}\u{1F3FF}X");
    ev.resetLocalSelection();
    ev.setSelectionOccupancy(.cell);
    _ = ev.setLocalSelection(0, 0, 2, 0, null, null, true);
    try std.testing.expectEqual(@as(u32, 2), ev.getPrimaryCursor().col);
    len = ev.getSelectedTextIntoBuffer(&out);
    try std.testing.expectEqualStrings("\u{1F44B}\u{1F3FF}", out[0..len]);

    ev.resetLocalSelection();
    _ = ev.setLocalSelection(4, 0, 2, 0, null, null, true);
    try std.testing.expectEqual(@as(u32, 2), ev.getPrimaryCursor().col);

    ev.resetLocalSelection();
    _ = ev.setLocalSelection(0, 0, 2, 0, null, null, true);

    try ev.deleteSelectedText();
    len = ev.getText(&out);
    try std.testing.expectEqualStrings("X", out[0..len]);

    try eb.setText("Hello");
    try eb.setCursor(0, 4);
    _ = ev.updateLocalSelection(0, 0, 2, 0, null, null, false);
    ev.setSelectionOccupancy(.boundary);
    try std.testing.expectEqual(@as(u32, 4), ev.getPrimaryCursor().col);

    try eb.setText("abcdefgh");
    ev.resetLocalSelection();
    ev.setSelectionOccupancy(.boundary);
    _ = ev.setLocalSelection(0, 0, 8, 0, null, null, true);
    try eb.setText("abcde");
    ev.setSelectionOccupancy(.cell);
    try std.testing.expectEqual(@as(u32, 5), ev.getPrimaryCursor().col);

    ev.resetLocalSelection();
    try eb.setCursor(0, 3);
    _ = ev.setLocalSelection(0, -1, 0, -1, null, null, true);
    try std.testing.expectEqual(@as(u32, 3), ev.getPrimaryCursor().col);

    try eb.setText("\u{1F44B}\u{1F3FF}X");
    ev.setSelectionOccupancy(.cell);
    ev.setWrapMode(.char);
    ev.setViewportSize(2, 24);
    try eb.setCursor(0, 2);
    ev.gotoVisualLineEnd();
    try std.testing.expectEqual(@as(u32, 2), ev.getPrimaryCursor().col);

    try eb.setText("\u{4F60}a");
    ev.setWrapMode(.word);
    ev.setViewportSize(1, 24);
    ev.setSelectionOccupancy(.boundary);
    try eb.setCursor(0, 0);
    ev.gotoVisualLineEnd();
    // The oversized CJK grapheme remains atomic, so its visual end is after
    // the complete width-2 cursor unit rather than inside it at the viewport edge.
    try std.testing.expectEqual(@as(u32, 2), ev.getPrimaryCursor().offset);

    ev.setSelectionOccupancy(.cell);
    ev.gotoVisualLineEnd();
    try std.testing.expectEqual(@as(u32, 2), ev.getPrimaryCursor().offset);
}

test "EditorView - word press keeps cursor on the clicked grapheme" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    try eb.insertText("alpha beta");
    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();

    _ = ev.setLocalSelectionBehavior(6, 0, 6, 0, null, null, true, .word);

    var out: [32]u8 = undefined;
    const len = ev.getSelectedTextIntoBuffer(&out);
    try std.testing.expectEqualStrings("beta", out[0..len]);

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);
    try std.testing.expectEqual(@as(u32, 6), cursor.col);
}

test "EditorView - line press keeps cursor on the clicked grapheme" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    try eb.insertText("  hello world  ");
    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();

    _ = ev.setLocalSelectionBehavior(4, 0, 4, 0, null, null, true, .line);

    var out: [32]u8 = undefined;
    const len = ev.getSelectedTextIntoBuffer(&out);
    try std.testing.expectEqualStrings("hello world", out[0..len]);

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);
    try std.testing.expectEqual(@as(u32, 4), cursor.col);
}

test "EditorView - cell press still syncs cursor without selecting" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    try eb.insertText("alpha beta");
    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();

    _ = ev.setLocalSelection(6, 0, 6, 0, null, null, true);

    var out: [32]u8 = undefined;
    const len = ev.getSelectedTextIntoBuffer(&out);
    try std.testing.expectEqualStrings("", out[0..len]);

    const cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);
    try std.testing.expectEqual(@as(u32, 6), cursor.col);
}

test "EditorView - convert word selection to cell keeps the range and moves focus to the last cell" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    var ev = try EditorView.init(std.testing.allocator, eb, 80, 24);
    defer ev.deinit();

    try eb.insertText("alpha beta");
    try eb.setCursor(0, 0);
    _ = ev.getVirtualLines();

    _ = ev.setLocalSelectionBehavior(6, 0, 6, 0, null, null, true, .word);
    try std.testing.expect(ev.convertSelectionToCell());

    var converted: [32]u8 = undefined;
    const converted_len = ev.getSelectedTextIntoBuffer(&converted);
    try std.testing.expectEqualStrings("beta", converted[0..converted_len]);

    const converted_cursor = ev.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), converted_cursor.row);
    try std.testing.expectEqual(@as(u32, 9), converted_cursor.col);
}
