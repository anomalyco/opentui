const std = @import("std");
const text_buffer = @import("../text-buffer.zig");
const text_buffer_view = @import("../text-buffer-view.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");

const TextBuffer = text_buffer.TextBuffer;
const TextBufferView = text_buffer_view.TextBufferView;

const ViewPair = struct {
    tb: *TextBuffer,
    view: *TextBufferView,
};

fn initView(text: []const u8) !ViewPair {
    const pool = gp.initGlobalPool(std.testing.allocator);
    errdefer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    errdefer link.deinitGlobalLinkPool();

    const tb = try TextBuffer.init(std.testing.allocator, pool, link_pool, .unicode);
    errdefer tb.deinit();
    const view = try TextBufferView.init(std.testing.allocator, tb);
    errdefer view.deinit();
    try tb.setText(text);
    return .{ .tb = tb, .view = view };
}

fn deinitView(pair: ViewPair) void {
    pair.view.deinit();
    pair.tb.deinit();
    gp.deinitGlobalPool();
    link.deinitGlobalLinkPool();
}

fn expectSelected(
    view: *TextBufferView,
    range: ?text_buffer_view.SelectionRange,
    expected: []const u8,
) !void {
    const found = range orelse return error.TestUnexpectedResult;
    var out: [128]u8 = undefined;
    const len = view.getTextBuffer().getTextRange(found.start, found.end, &out);
    try std.testing.expectEqualStrings(expected, out[0..len]);
}

test "selectWord - alpha beta click on b selects beta" {
    const pair = try initView("alpha beta");
    defer deinitView(pair);

    try expectSelected(pair.view, pair.view.selectWord(6), "beta");
}

test "selectWord - click on space selects one space" {
    const pair = try initView("alpha beta");
    defer deinitView(pair);

    try expectSelected(pair.view, pair.view.selectWord(5), " ");
}

test "selectWord - empty padding past the line returns no range" {
    const pair = try initView("alpha beta");
    defer deinitView(pair);

    try std.testing.expect(pair.view.selectWord(10) == null);
    try std.testing.expect(pair.view.selectWord(11) == null);
}

test "selectWord - newline returns no range" {
    const pair = try initView("alpha\nbeta");
    defer deinitView(pair);

    try std.testing.expect(pair.view.selectWord(5) == null);
}

test "selectWord - wide glyph 日本語abc is one word" {
    const pair = try initView("日本語abc");
    defer deinitView(pair);

    // 日=2, 本=2, 語=2, a=1, b=1, c=1. Click either cell of 本 (offsets 2 or 3).
    try expectSelected(pair.view, pair.view.selectWord(2), "日本語abc");
    try expectSelected(pair.view, pair.view.selectWord(3), "日本語abc");
}

test "selectWord - zero-width prefix does not hang" {
    const pair = try initView("\u{200B}hello");
    defer deinitView(pair);

    try expectSelected(pair.view, pair.view.selectWord(0), "\u{200B}hello");
    try expectSelected(pair.view, pair.view.selectLine(0), "\u{200B}hello");
}

test "selectWord - slash is not a boundary unlike wrap breaks" {
    const pair = try initView("foo/bar");
    defer deinitView(pair);

    try expectSelected(pair.view, pair.view.selectWord(0), "foo/bar");
    try expectSelected(pair.view, pair.view.selectWord(3), "foo/bar");
}

test "selectWord - wrapped hello world still selects world" {
    const pair = try initView("hello world");
    defer deinitView(pair);
    pair.view.setWrapMode(.char);
    pair.view.setWrapWidth(5);

    try expectSelected(pair.view, pair.view.selectWord(6), "world");
}

test "selectWordBetween - from alpha across spaces onto padding past beta" {
    const pair = try initView("alpha beta");
    defer deinitView(pair);

    try expectSelected(pair.view, pair.view.selectWordBetween(0, 10), "alpha");
    try expectSelected(pair.view, pair.view.selectWordBetween(10, 0), "beta");
}

test "selectLine - hello world keeps interior spaces and trims ends" {
    const pair = try initView("  hello world  ");
    defer deinitView(pair);

    try expectSelected(pair.view, pair.view.selectLine(4), "hello world");
}

test "selectLine - wrapped source line selected as one line" {
    const pair = try initView("hello world");
    defer deinitView(pair);
    pair.view.setWrapMode(.char);
    pair.view.setWrapWidth(5);

    try expectSelected(pair.view, pair.view.selectLine(0), "hello world");
    try expectSelected(pair.view, pair.view.selectLine(6), "hello world");
}

test "selectLine - blank line selected in full" {
    const pair = try initView("alpha\n   \nbeta");
    defer deinitView(pair);

    try expectSelected(pair.view, pair.view.selectLine(6), "   ");
}

test "selectLine - selected bytes match a whole visual-line drag" {
    const pair = try initView("hello\nworld");
    defer deinitView(pair);

    try expectSelected(pair.view, pair.view.selectLine(0), "hello");
}

fn expectViewSelected(view: *TextBufferView, expected: []const u8) !void {
    var out: [128]u8 = undefined;
    const len = view.getSelectedTextIntoBuffer(&out);
    try std.testing.expectEqualStrings(expected, out[0..len]);
}

test "behavior - word press on one cell produces a non-empty range" {
    const pair = try initView("alpha beta gamma");
    defer deinitView(pair);

    _ = pair.view.setLocalSelectionBehavior(6, 0, 6, 0, null, null, .word);
    try expectViewSelected(pair.view, "beta");
}

test "behavior - word press on padding produces zero-width" {
    const pair = try initView("alpha beta");
    defer deinitView(pair);

    _ = pair.view.setLocalSelectionBehavior(10, 0, 10, 0, null, null, .word);
    try expectViewSelected(pair.view, "");
    try std.testing.expectEqual(@as(u64, 0xFFFFFFFF_FFFFFFFF), pair.view.packSelectionInfo());
}

test "behavior - word drag beta to gamma selects both words" {
    const pair = try initView("alpha beta gamma");
    defer deinitView(pair);

    _ = pair.view.setLocalSelectionBehavior(6, 0, 6, 0, null, null, .word);
    _ = pair.view.updateLocalSelectionBehavior(6, 0, 12, 0, null, null, .word);
    try expectViewSelected(pair.view, "beta gamma");
}

test "behavior - word drag backward matches forward" {
    const pair = try initView("alpha beta gamma");
    defer deinitView(pair);

    _ = pair.view.setLocalSelectionBehavior(6, 0, 12, 0, null, null, .word);
    try expectViewSelected(pair.view, "beta gamma");

    pair.view.resetLocalSelection();
    _ = pair.view.setLocalSelectionBehavior(12, 0, 6, 0, null, null, .word);
    try expectViewSelected(pair.view, "beta gamma");
}

test "behavior - line drag across two source lines unions them" {
    const pair = try initView("hello\nworld");
    defer deinitView(pair);

    _ = pair.view.setLocalSelectionBehavior(0, 0, 0, 0, null, null, .line);
    _ = pair.view.updateLocalSelectionBehavior(0, 0, 0, 1, null, null, .line);
    try expectViewSelected(pair.view, "hello\nworld");
}

test "behavior - cell press still zero-width" {
    const pair = try initView("alpha beta");
    defer deinitView(pair);

    _ = pair.view.setLocalSelection(6, 0, 6, 0, null, null);
    try expectViewSelected(pair.view, "");
    try std.testing.expectEqual(@as(u64, 0xFFFFFFFF_FFFFFFFF), pair.view.packSelectionInfo());
}

test "behavior - set and update agree for word and line" {
    const pair = try initView("alpha beta gamma\nnext");
    defer deinitView(pair);

    _ = pair.view.setLocalSelectionBehavior(6, 0, 12, 0, null, null, .word);
    var set_out: [128]u8 = undefined;
    const set_len = pair.view.getSelectedTextIntoBuffer(&set_out);

    pair.view.resetLocalSelection();
    _ = pair.view.setLocalSelectionBehavior(6, 0, 6, 0, null, null, .word);
    _ = pair.view.updateLocalSelectionBehavior(6, 0, 12, 0, null, null, .word);
    var update_out: [128]u8 = undefined;
    const update_len = pair.view.getSelectedTextIntoBuffer(&update_out);
    try std.testing.expectEqualStrings(set_out[0..set_len], update_out[0..update_len]);
    try std.testing.expectEqualStrings("beta gamma", set_out[0..set_len]);

    pair.view.resetLocalSelection();
    _ = pair.view.setLocalSelectionBehavior(0, 0, 0, 1, null, null, .line);
    const line_set_len = pair.view.getSelectedTextIntoBuffer(&set_out);

    pair.view.resetLocalSelection();
    _ = pair.view.setLocalSelectionBehavior(0, 0, 0, 0, null, null, .line);
    _ = pair.view.updateLocalSelectionBehavior(0, 0, 0, 1, null, null, .line);
    const line_update_len = pair.view.getSelectedTextIntoBuffer(&update_out);
    try std.testing.expectEqualStrings(set_out[0..line_set_len], update_out[0..line_update_len]);
    try std.testing.expectEqualStrings("alpha beta gamma\nnext", set_out[0..line_set_len]);
}

test "behavior - convert word range to cell keeps text and later drag is cell-granular" {
    const pair = try initView("alpha beta gamma");
    defer deinitView(pair);

    _ = pair.view.setLocalSelectionBehavior(6, 0, 6, 0, null, null, .word);
    try expectViewSelected(pair.view, "beta");
    try std.testing.expect(pair.view.convertSelectionToCell());
    try expectViewSelected(pair.view, "beta");

    _ = pair.view.updateLocalSelectionBehavior(6, 0, 10, 0, null, null, .cell);
    try expectViewSelected(pair.view, "beta ");
}

test "behavior - convert word range keeps exclusive end under boundary occupancy" {
    const pair = try initView("alpha beta gamma");
    defer deinitView(pair);
    pair.view.setSelectionOccupancy(.boundary);

    _ = pair.view.setLocalSelectionBehavior(6, 0, 6, 0, null, null, .word);
    try expectViewSelected(pair.view, "beta");
    try std.testing.expect(pair.view.convertSelectionToCell());
    try expectViewSelected(pair.view, "beta");

    _ = pair.view.updateLocalSelectionBehavior(6, 0, 11, 0, null, null, .cell);
    try expectViewSelected(pair.view, "beta ");
}

test "behavior - convert line range keeps text when the start is above the viewport" {
    const pair = try initView("hello world");
    defer deinitView(pair);
    pair.view.setWrapMode(.char);
    pair.view.setWrapWidth(5);
    pair.view.setViewport(.{ .x = 0, .y = 1, .width = 5, .height = 1 });

    _ = pair.view.setLocalSelectionBehavior(1, 0, 1, 0, null, null, .line);
    try expectViewSelected(pair.view, "hello world");
    try std.testing.expect(pair.view.convertSelectionToCell());
    try expectViewSelected(pair.view, "hello world");
}
