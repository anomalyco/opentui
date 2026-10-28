//! Runs the shared text corpus (fixtures/text-corpus.json); src/tests/text-corpus.test.ts in
//! packages/core runs the same rows. The file's "format" entry documents the row keys.
const std = @import("std");
const TestPools = @import("test-pools.zig").TestPools;
const utf8 = @import("../utf8.zig");
const TextBuffer = @import("../text-buffer.zig").UnifiedTextBuffer;
const text_buffer_view = @import("../text-buffer-view.zig");
const TextBufferView = text_buffer_view.UnifiedTextBufferView;
const EditBuffer = @import("../edit-buffer.zig").EditBuffer;
const OptimizedBuffer = @import("../buffer.zig").OptimizedBuffer;
const EncodedUnicode = @import("../encoded-unicode.zig").EncodedUnicode;
const expectGraphemeBoundaries = @import("text-buffer-view_test.zig").expectGraphemeBoundaries;
const TestRenderer = @import("test-renderer.zig").TestRenderer;
const ansi = @import("../ansi.zig");
const ghostty_vt = @import("../ghostty-vt.zig");
const Value = std.json.Value;
const gpa = std.testing.allocator;

const Run = struct {
    arena: std.mem.Allocator,
    pools: *TestPools,
    row: std.json.ObjectMap,
    method: utf8.WidthMethod,
    counts: *std.StringArrayHashMapUnmanaged(i64),
    /// One flag per `bug` entry: set when a check that the entry names runs in this method.
    exercised: []bool,

    fn get(self: Run, key: []const u8) ?Value {
        const value = self.row.get(key) orelse return null;
        return if (value == .object) value.object.get(@tagName(self.method)) else value;
    }

    fn int(self: Run, key: []const u8, default: i64) u32 {
        return @intCast(if (self.get(key)) |value| value.integer else default);
    }

    /// A check named by a `bug` entry for this method must fail; every other check must pass.
    fn check(self: Run, name: []const u8, ok: bool) !void {
        const entry = try self.counts.getOrPutValue(self.arena, name, 0);
        entry.value_ptr.* += 1;
        const bug = for (bugs(self.row), 0..) |item, i| {
            const fields = item.array.items;
            if (!std.mem.eql(u8, fields[0].string, name) or !self.covers(item)) continue;
            self.exercised[i] = true;
            break fields[1].string;
        } else null;
        if (ok == (bug == null)) return;
        std.debug.print("{s} {s} {s}: {s}{s}\n", .{ self.row.get("id").?.string, name, @tagName(self.method), bug orelse "failed", if (bug != null) " passes" else "" });
        return error.CorpusMismatch;
    }

    fn covers(self: Run, entry: Value) bool {
        const fields = entry.array.items;
        return fields.len < 3 or contains(fields[2].array.items, @tagName(self.method));
    }

    fn load(self: Run, parts: []const []const u8) !*TextBuffer {
        const control: utf8.ControlDisplay = if (self.row.get("control")) |c| std.meta.stringToEnum(utf8.ControlDisplay, c.string).? else .hidden;
        const tb = try TextBuffer.initWithOptions(gpa, &self.pools.graphemes, &self.pools.links, self.method, .{ .control_display = control });
        tb.setTabWidth(@intCast(self.int("tab", 4)));
        for (parts) |part| try tb.append(part);
        try expectGraphemeBoundaries(tb);
        return tb;
    }

    fn view(self: Run, tb: *TextBuffer, cols: ?u32) !*TextBufferView {
        const v = try TextBufferView.init(gpa, tb);
        const mode = if (self.row.get("wrap")) |w| std.meta.stringToEnum(text_buffer_view.WrapMode, w.string).? else .none;
        v.setWrapMode(mode);
        v.setWrapWidth(cols);
        v.setFirstLineOffset(self.int("offset", 0));
        return v;
    }
};

fn bugs(row: std.json.ObjectMap) []const Value {
    return if (row.get("bug")) |b| b.array.items else &.{};
}

fn contains(list: []const Value, name: []const u8) bool {
    for (list) |item| if (std.mem.eql(u8, item.string, name)) return true;
    return false;
}

/// The lines hold every byte of the input in order. Only between lines may bytes be missing:
/// line breaks, and in word wrap the spaces and tabs where the line wrapped.
fn retains(input: []const u8, lines: []const []const u8, word: bool) bool {
    var i: usize = 0;
    for (lines, 0..) |line, n| {
        while (!std.mem.startsWith(u8, input[i..], line)) i = if (n > 0) skipBreak(input, i, word) orelse return false else return false;
        i += line.len;
    }
    while (skipBreak(input, i, word)) |next| i = next;
    return i == input.len;
}

/// A line may be wider than the wrap width only when one grapheme takes all of its cells.
fn oneGraphemeWithCells(bytes: []const u8, tb: *TextBuffer, method: utf8.WidthMethod) bool {
    var state: @import("uucode").grapheme.BreakState = .default;
    var previous: ?u21 = null;
    var start: usize = 0;
    var with_cells: u32 = 0;
    var pos: usize = 0;
    while (pos <= bytes.len) : (pos += if (pos < bytes.len) utf8.decodeUtf8Unchecked(bytes, pos).len else 1) {
        const cp: ?u21 = if (pos < bytes.len) utf8.decodeUtf8Unchecked(bytes, pos).cp else null;
        if (previous != null and (cp == null or utf8.isGraphemeBreak(previous, cp.?, &state, .unicode))) {
            if (utf8.calculateTextWidth(bytes[start..pos], tb.tabWidth(), tb.controlDisplay(), false, method) > 0) with_cells += 1;
            start = pos;
        }
        previous = cp;
    }
    return with_cells <= 1;
}

fn skipBreak(input: []const u8, i: usize, word: bool) ?usize {
    if (i >= input.len) return null;
    if (input[i] == '\n' or input[i] == '\r' or (word and (input[i] == ' ' or input[i] == '\t'))) return i + 1;
    return null;
}

fn plainText(arena: std.mem.Allocator, tb: *TextBuffer) ![]const u8 {
    const out = try arena.alloc(u8, tb.getByteSize() + 2 * tb.lineCount());
    return out[0..tb.getPlainTextIntoBuffer(out)];
}

/// Virtual lines as `[source line, source column, width, bytes]` rows, to compare and print.
fn layoutKey(arena: std.mem.Allocator, v: *TextBufferView, tb: *TextBuffer) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    for (v.getVirtualLines()) |line| {
        try out.print(arena, "[{d},{d},{d},\"", .{ line.source_line, line.source_col_start, line.width_cols });
        for (line.chunks.items) |chunk| try out.appendSlice(arena, chunk.chunk.getBytes(tb.memRegistry())[chunk.byte_start_in_chunk..][0..chunk.byte_len]);
        try out.appendSlice(arena, "\"]");
    }
    return out.items;
}

fn expectedKey(arena: std.mem.Allocator, lines: Value) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    for (lines.array.items) |line| {
        const l = line.array.items;
        try out.print(arena, "[{d},{d},{d},\"{s}\"]", .{ l[0].integer, l[1].integer, l[2].integer, l[3].string });
    }
    return out.items;
}

/// Screen rows of a draw, each trimmed at the end; empty rows are dropped.
fn drawRows(run: Run, v: *TextBufferView, width: u32, height: u32) ![]const u8 {
    const screen = try OptimizedBuffer.init(gpa, width, height, .{ .pool = &run.pools.graphemes, .link_pool = &run.pools.links, .width_method = run.method });
    defer screen.deinit();
    screen.clear(.{ 0, 0, 0, 1 }, 32);
    screen.drawTextBuffer(v, 0, 0);
    const raw = try run.arena.alloc(u8, screen.getRealCharSize() + height);
    var rows: std.ArrayList(u8) = .empty;
    var it = std.mem.splitScalar(u8, raw[0..try screen.writeResolvedChars(raw, true)], '\n');
    while (it.next()) |row| {
        const trimmed = std.mem.trimEnd(u8, row, " ");
        if (trimmed.len > 0) try rows.print(run.arena, "{s}\n", .{trimmed});
    }
    return rows.items;
}

fn joinRows(arena: std.mem.Allocator, rows: []const Value) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    for (rows) |row| if (row.string.len > 0) try out.print(arena, "{s}\n", .{row.string});
    return out.items;
}

/// Layout checks of the buffer loaded from `input` at `cols`; with `compare_fresh`, also against `input` loaded as one chunk.
fn layoutChecks(run: Run, tb: *TextBuffer, input: []const u8, compare_fresh: bool) !void {
    const cols: ?u32 = if (run.row.get("cols") != null) run.int("cols", 0) else null;
    const v = try run.view(tb, cols);
    defer v.deinit();
    const key = try layoutKey(run.arena, v, tb);
    if (run.get("lines")) |lines| try run.check("lines", std.mem.eql(u8, key, try expectedKey(run.arena, lines)));
    if (run.row.get("truncate") == null) {
        const word = if (run.row.get("wrap")) |w| std.mem.eql(u8, w.string, "word") else false;
        var lines: std.ArrayList([]const u8) = .empty;
        var widths_ok = true;
        var fits = true;
        for (v.getVirtualLines()) |line| {
            var bytes: std.ArrayList(u8) = .empty;
            for (line.chunks.items) |chunk| {
                const chunk_bytes = chunk.chunk.getBytes(tb.memRegistry())[chunk.byte_start_in_chunk..][0..chunk.byte_len];
                try bytes.appendSlice(run.arena, chunk_bytes);
                if (std.mem.indexOfScalar(u8, chunk_bytes, '\t') == null) widths_ok = widths_ok and chunk.width_cols == utf8.calculateTextWidth(chunk_bytes, tb.tabWidth(), tb.controlDisplay(), false, run.method);
            }
            try lines.append(run.arena, if (word) try std.mem.replaceOwned(u8, run.arena, bytes.items, "\u{200b}", "") else bytes.items);
            if (cols) |width| fits = fits and (line.width_cols <= width or oneGraphemeWithCells(bytes.items, tb, run.method));
        }
        // Word wrap may drop U+200B anywhere; it takes no cell.
        try run.check("retain", retains(if (word) try std.mem.replaceOwned(u8, run.arena, input, "\u{200b}", "") else input, lines.items, word));
        try run.check("chunk_widths", widths_ok);
        if (cols != null and run.row.get("wrap") != null) try run.check("fit", fits);
    }
    if (cols) |width| if (run.row.get("wrap") != null) {
        const measured = try v.measureForDimensions(width, 1 << 20);
        var widest: u32 = 0;
        for (v.getVirtualLines()) |line| widest = @max(widest, line.width_cols);
        try run.check("measure", measured.line_count == v.getVirtualLines().len and measured.width_cols_max == widest);
        // A width change alone keeps the retained word layout; the layout must equal a new view's.
        v.setWrapWidth(width + 2);
        _ = v.getVirtualLines();
        v.setWrapWidth(width);
        const again = try run.view(tb, width);
        defer again.deinit();
        try run.check("resize", std.mem.eql(u8, try layoutKey(run.arena, v, tb), try layoutKey(run.arena, again, tb)));
    };
    if (!compare_fresh) return;
    const fresh_tb = try run.load(&.{input});
    defer fresh_tb.deinit();
    const fresh = try run.view(fresh_tb, cols);
    defer fresh.deinit();
    try run.check("fresh", std.mem.eql(u8, key, try layoutKey(run.arena, fresh, fresh_tb)));
}

fn runRow(run: Run) !void {
    const row = run.row;
    var parts: std.ArrayList([]const u8) = .empty;
    if (row.get("text")) |t| try parts.append(run.arena, t.string);
    if (row.get("parts")) |p| for (p.array.items) |part| try parts.append(run.arena, part.string);
    var eb: ?*EditBuffer = null;
    defer if (eb) |e| e.deinit();
    const tb = if (row.get("ops")) |ops| blk: {
        const e = try EditBuffer.init(gpa, &run.pools.graphemes, &run.pools.links, run.method, null);
        eb = e;
        e.getTextBuffer().setTabWidth(@intCast(run.int("tab", 4)));
        for (ops.array.items) |op| try applyOp(e, op.array.items);
        try expectGraphemeBoundaries(e.getTextBuffer());
        break :blk e.getTextBuffer();
    } else try run.load(parts.items);
    defer if (eb == null) tb.deinit();
    const text = try plainText(run.arena, tb);

    if (run.get("width")) |w| {
        var ok = utf8.calculateTextWidth(text, @intCast(run.int("tab", 4)), tb.controlDisplay(), false, run.method) == w.integer;
        if (utf8.isAsciiOnly(text)) ok = ok and utf8.calculateTextWidth(text, @intCast(run.int("tab", 4)), tb.controlDisplay(), true, run.method) == w.integer;
        if (tb.lineCount() == 1) ok = ok and tb.lineWidthAt(0) == w.integer;
        try run.check("width", ok);
    }
    if (run.get("line_widths")) |widths| {
        var ok = widths.array.items.len == tb.lineCount();
        for (widths.array.items, 0..) |w, i| ok = ok and i < tb.lineCount() and tb.lineWidthAt(@intCast(i)) == w.integer;
        try run.check("line_widths", ok);
    }
    if (run.get("max")) |m| try run.check("max", tb.lineWidthColsMax() == m.integer);
    try run.check("widest", try widestHolds(tb));
    if (run.get("result")) |r| try run.check("result", std.mem.eql(u8, text, r.string));
    const joined = try std.mem.concat(run.arena, u8, parts.items);
    try layoutChecks(run, tb, if (eb != null) text else joined, eb != null or parts.items.len > 1);

    if (run.get("draw")) |rows| {
        const v = try run.view(tb, if (row.get("cols") == null) null else run.int("cols", 0));
        defer v.deinit();
        const width = run.int("cols", 80);
        if (row.get("truncate") != null) {
            v.setTruncate(true);
            v.setViewport(.{ .x = 0, .y = 0, .width = width, .height = @intCast(rows.array.items.len) });
        }
        try run.check("draw", std.mem.eql(u8, try drawRows(run, v, width, @intCast(v.getVirtualLines().len)), try joinRows(run.arena, rows.array.items)));
    }
    if (run.get("draw_at")) |cases| for (cases.array.items) |case| {
        const v = try run.view(tb, null);
        defer v.deinit();
        v.setViewport(.{ .x = @intCast(case.array.items[0].integer), .y = 0, .width = run.int("cols", 80), .height = 1 });
        try run.check("draw_at", std.mem.eql(u8, try drawRows(run, v, run.int("cols", 80), 1), try joinRows(run.arena, case.array.items[1..])));
    };
    if (row.get("draw_text") != null) {
        const v = try run.view(tb, null);
        defer v.deinit();
        const encoded = try EncodedUnicode.init(gpa, &run.pools.graphemes, text, run.method);
        defer encoded.deinit(gpa, &run.pools.graphemes);
        // At cols too, so a glyph that does not fit at the right edge is left out by every drawer.
        for ([_]u32{ 80, run.int("cols", 80) }) |width| {
            const screen = try OptimizedBuffer.init(gpa, width, 1, .{ .pool = &run.pools.graphemes, .link_pool = &run.pools.links, .width_method = run.method });
            defer screen.deinit();
            // The rows keep their trailing blanks, so a glyph drawn in other columns shows.
            var rows: [3][]const u8 = undefined;
            for (&rows, 0..) |*drawn, i| {
                screen.clear(.{ 0, 0, 0, 1 }, 32);
                if (i == 0) screen.drawTextBuffer(v, 0, 0) else if (i == 1) try screen.drawText(text, 0, 0, .{ 1, 1, 1, 1 }, null, 0) else {
                    // An encodeUnicode caller puts each glyph after the one before; one that does not fit is not drawn.
                    var x: u32 = 0;
                    for (encoded.chars) |char| {
                        if (x + char.width <= width) screen.drawChar(char.char, x, 0, .{ 1, 1, 1, 1 }, .{ 0, 0, 0, 1 }, 0);
                        x += char.width;
                    }
                }
                const raw = try run.arena.alloc(u8, screen.getRealCharSize());
                drawn.* = raw[0..try screen.writeResolvedChars(raw, false)];
            }
            try run.check("draw_text", std.mem.eql(u8, rows[0], rows[1]));
            try run.check("encode", std.mem.eql(u8, rows[0], rows[2]));
        }
    }
    if (row.get("overdraw") != null) {
        const v = try run.view(tb, null);
        defer v.deinit();
        const encoded = try EncodedUnicode.init(gpa, &run.pools.graphemes, text, run.method);
        defer encoded.deinit(gpa, &run.pools.graphemes);
        const screen = try OptimizedBuffer.init(gpa, 80, 1, .{ .pool = &run.pools.graphemes, .link_pool = &run.pools.links, .width_method = run.method });
        defer screen.deinit();
        var same = true;
        // A mark (X or the two-cell 中) clears each glyph it covers: the row equals the other glyphs, then the mark.
        for (0..utf8.calculateTextWidth(text, 4, .hidden, false, run.method)) |x| for ([_]struct { []const u8, u32 }{ .{ "X", 1 }, .{ "\u{4e2d}", 2 } }) |mark| {
            var rows: [2][]const u8 = undefined;
            for (&rows, 0..) |*drawn, i| {
                screen.clear(.{ 0, 0, 0, 1 }, 32);
                if (i == 0) screen.drawTextBuffer(v, 0, 0) else {
                    var glyph_x: u32 = 0;
                    for (encoded.chars) |char| {
                        if (glyph_x + char.width <= x or glyph_x >= x + mark[1]) screen.drawChar(char.char, glyph_x, 0, .{ 1, 1, 1, 1 }, .{ 0, 0, 0, 1 }, 0);
                        glyph_x += char.width;
                    }
                }
                try screen.drawText(mark[0], @intCast(x), 0, .{ 1, 1, 1, 1 }, null, 0);
                const raw = try run.arena.alloc(u8, screen.getRealCharSize());
                drawn.* = raw[0..try screen.writeResolvedChars(raw, false)];
            }
            same = same and std.mem.eql(u8, rows[0], rows[1]);
        };
        try run.check("overdraw", same);
        if (run.method == .wcwidth or run.method == .unicode) for ([_]bool{ false, true }) |explicit| {
            try run.check("terminal", try terminalShowsFrames(run, text, explicit));
        };
    }
    if (run.get("select")) |cases| for (cases.array.items) |case| {
        const v = try run.view(tb, null);
        defer v.deinit();
        const c = case.array.items;
        v.setSelection(@intCast(c[0].integer), @intCast(c[1].integer), null, null);
        var out: [256]u8 = undefined;
        try run.check("select", std.mem.eql(u8, out[0..v.getSelectedTextIntoBuffer(&out)], c[2].string));
    };
    if (run.get("range")) |cases| for (cases.array.items) |case| {
        const c = case.array.items;
        var out: [256]u8 = undefined;
        try run.check("range", std.mem.eql(u8, out[0..tb.getTextRange(@intCast(c[0].integer), @intCast(c[1].integer), &out)], c[2].string));
    };
    if (run.get("stops")) |stops| {
        const e = eb.?;
        try e.setCursor(0, 0);
        var seen: std.ArrayList(u8) = .empty;
        var last: ?[2]u32 = null;
        for (0..text.len + 2) |_| {
            const cursor = e.getPrimaryCursor();
            if (last) |l| if (l[0] == cursor.row and l[1] == cursor.col) break;
            last = .{ cursor.row, cursor.col };
            try seen.print(run.arena, "[{d},{d}]", .{ cursor.row, cursor.col });
            e.moveRight();
        }
        var want: std.ArrayList(u8) = .empty;
        for (stops.array.items) |s| try want.print(run.arena, "[{d},{d}]", .{ s.array.items[0].integer, s.array.items[1].integer });
        try run.check("stops", std.mem.eql(u8, seen.items, want.items));
    }
    if (row.get("split") != null) try splitChecks(run, joined);
}

/// For each cell x of the text, renders a forced frame of the text, then diff frames with X over x, in other
/// colors, and empty. libghostty-vt reads the output (mode 2027 off for wcwidth, on for unicode) and must show
/// each frame as drawn.
fn terminalShowsFrames(run: Run, text: []const u8, explicit_cursor_positioning: bool) !bool {
    const white = ansi.rgbColor(255, 255, 255, 255);
    const black = ansi.rgbColor(0, 0, 0, 255);
    var test_renderer = try TestRenderer.create(gpa, 80, 1, &run.pools.graphemes, &run.pools.links);
    defer test_renderer.deinit();
    const cli = test_renderer.renderer;
    cli.terminal.caps.unicode = run.method;
    cli.terminal.caps.explicit_cursor_positioning = explicit_cursor_positioning;
    cli.syncWidthMethod();
    var terminal: ghostty_vt.vt.Terminal = try .init(std.testing.io, gpa, .{ .cols = 80, .rows = 1 });
    defer terminal.deinit(gpa);
    var stream = terminal.vtStream();
    defer stream.deinit();
    stream.nextSlice(if (run.method == .wcwidth) "\x1b[?2027l" else "\x1b[?2027h");
    var shown = true;
    for (0..utf8.calculateTextWidth(text, 4, .hidden, false, run.method)) |x| for (0..4) |frame| {
        const next = cli.getNextBuffer();
        if (frame < 3) try next.drawText(text, 0, 0, if (frame == 2) black else white, if (frame == 2) white else black, 0);
        if (frame == 1) try next.drawText("X", @intCast(x), 0, white, black, 0);
        const written = test_renderer.memory.bytes.items.len;
        _ = test_renderer.render(frame == 0);
        stream.nextSlice(test_renderer.memory.bytes.items[written..]);
        const screen = try terminal.plainString(run.arena);
        const raw = try run.arena.alloc(u8, cli.currentRenderBuffer.getRealCharSize());
        const drawn = raw[0..try cli.currentRenderBuffer.writeResolvedChars(raw, false)];
        shown = shown and std.mem.eql(u8, std.mem.trimEnd(u8, screen, " "), std.mem.trimEnd(u8, drawn, " "));
    };
    return shown;
}

fn applyOp(e: *EditBuffer, op: []const Value) !void {
    const name = op[0].string;
    if (std.mem.eql(u8, name, "repeat")) {
        var out: [256]u8 = undefined;
        var before = try gpa.dupe(u8, out[0..e.getText(&out)]);
        defer gpa.free(before);
        for (0..before.len + 1) |_| {
            try applyOp(e, op[1].array.items);
            const now = out[0..e.getText(&out)];
            if (std.mem.eql(u8, now, before)) break;
            gpa.free(before);
            before = try gpa.dupe(u8, now);
        }
    } else if (std.mem.eql(u8, name, "set")) try e.setText(op[1].string) else if (std.mem.eql(u8, name, "cursor")) try e.setCursor(@intCast(op[1].integer), @intCast(op[2].integer)) else if (std.mem.eql(u8, name, "insert")) try e.insertText(op[1].string) else if (std.mem.eql(u8, name, "delete")) try e.deleteForward() else if (std.mem.eql(u8, name, "backspace")) try e.backspace() else if (std.mem.eql(u8, name, "right")) e.moveRight() else if (std.mem.eql(u8, name, "undo_all")) {
        while (true) _ = e.undo() catch |err| if (err == error.Stop) break else return err;
    } else return error.UnknownOp;
}

/// The widest-line metric equals the widest line, unwrapped measure included, however the chunks fall.
fn widestHolds(tb: *TextBuffer) !bool {
    var widest: u32 = 0;
    for (0..tb.lineCount()) |row| widest = @max(widest, tb.lineWidthAt(@intCast(row)));
    const v = try TextBufferView.init(gpa, tb);
    defer v.deinit();
    v.setWrapMode(.none);
    const measured = try v.measureForDimensions(80, 1 << 20);
    return tb.lineWidthColsMax() == widest and measured.width_cols_max == widest and measured.line_count == tb.lineCount();
}

/// Every split of the text into 2 or 3 chunks at code-point boundaries lays out like one chunk.
fn splitChecks(run: Run, text: []const u8) !void {
    var cuts: std.ArrayList(usize) = .empty;
    var pos: usize = 0;
    while (pos < text.len) : (pos += utf8.decodeUtf8Unchecked(text, pos).len) if (pos > 0) try cuts.append(run.arena, pos);
    var same = true;
    var widest = true;
    for (cuts.items) |a| for (cuts.items) |b| {
        if (b < a) continue;
        const parts: []const []const u8 = if (a == b) &.{ text[0..a], text[a..] } else &.{ text[0..a], text[a..b], text[b..] };
        const tb = try run.load(parts);
        defer tb.deinit();
        const fresh = try run.load(&.{text});
        defer fresh.deinit();
        const cols: ?u32 = if (run.row.get("cols") == null) null else run.int("cols", 0);
        const v = try run.view(tb, cols);
        defer v.deinit();
        const f = try run.view(fresh, cols);
        defer f.deinit();
        same = same and std.mem.eql(u8, try layoutKey(run.arena, v, tb), try layoutKey(run.arena, f, fresh));
        widest = widest and try widestHolds(tb);
    };
    try run.check("split", same);
    try run.check("widest", widest);
}

/// Rows use only known keys, exactly one input, and known width methods; `bug` entries name a check that can be reversed.
fn validate(row: std.json.ObjectMap, keys: []const Value) !void {
    for (row.keys()) |key| if (!contains(keys, key)) return error.UnknownKey;
    if (@as(u8, @intFromBool(row.contains("text"))) + @intFromBool(row.contains("parts")) + @intFromBool(row.contains("ops")) != 1) return error.InputKey;
    var names: std.ArrayList(Value) = .empty;
    defer names.deinit(gpa);
    if (row.get("methods")) |m| try names.appendSlice(gpa, m.array.items);
    for (bugs(row)) |entry| {
        const fields = entry.array.items;
        if (fields.len < 2 or fields.len > 3) return error.BugEntry;
        for ([_][]const u8{ "retain", "chunk_widths", "fit", "measure", "resize", "widest" }) |never| if (std.mem.eql(u8, fields[0].string, never)) return error.BugEntry;
        if (fields.len == 3) try names.appendSlice(gpa, fields[2].array.items);
    }
    for (names.items) |name| _ = std.meta.stringToEnum(utf8.WidthMethod, name.string) orelse return error.UnknownMethod;
}

test "text corpus: retention allows missing bytes only between lines" {
    try std.testing.expect(retains("a b\tc", &.{ "a", "b", "c" }, true));
    try std.testing.expect(retains("a\n  b", &.{ "a", "  b" }, true));
    try std.testing.expect(!retains("a b", &.{"ab"}, true));
    try std.testing.expect(!retains("a b", &.{ "a", "b" }, false));
    try std.testing.expect(!retains("ab", &.{"a"}, true));
}

test "text corpus: every row gives its expected result in every width method" {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const corpus = try std.json.parseFromSliceLeaky(Value, arena, @embedFile("fixtures/text-corpus.json"), .{});
    var pools = TestPools.init(gpa);
    defer pools.deinit();
    var counts: std.StringArrayHashMapUnmanaged(i64) = .empty;
    var failed = false;
    const keys = corpus.object.get("keys").?.array.items;
    for (corpus.object.get("rows").?.array.items) |row| {
        errdefer std.debug.print("row {s}: malformed\n", .{if (row.object.get("id")) |id| id.string else "?"});
        try validate(row.object, keys);
        const methods = if (row.object.get("methods")) |m| m.array.items else &.{};
        for (std.enums.values(utf8.WidthMethod)) |method| {
            if (methods.len > 0 and !contains(methods, @tagName(method))) continue;
            const run: Run = .{ .arena = arena, .pools = &pools, .row = row.object, .method = method, .counts = &counts, .exercised = try arena.alloc(bool, bugs(row.object).len) };
            @memset(run.exercised, false);
            runRow(run) catch |err| {
                if (@as(anyerror, err) != error.CorpusMismatch) return err;
                failed = true;
            };
            // Every entry that names this method must have reversed a check that ran; only TypeScript runs text.
            for (bugs(row.object), run.exercised) |entry, used| if (run.covers(entry) and !used and !std.mem.eql(u8, entry.array.items[0].string, "text")) {
                std.debug.print("{s} {s}: bug entry {s} never ran\n", .{ row.object.get("id").?.string, @tagName(method), entry.array.items[0].string });
                failed = true;
            };
        }
    }
    try std.testing.expect(!failed);
    // Each check kind runs as often as the file says, so a runner change cannot skip one silently.
    const expected = corpus.object.get("checks").?.object.get("zig").?.object;
    var ok = expected.count() == counts.count();
    for (counts.keys(), counts.values()) |name, count| {
        const want = if (expected.get(name)) |w| w.integer else -1;
        if (want != count) std.debug.print("checks.zig.{s}: {d}, expected {d}\n", .{ name, count, want });
        ok = ok and want == count;
    }
    try std.testing.expect(ok);
}
