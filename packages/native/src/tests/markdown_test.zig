//! The Markdown engine against the shared corpus (packages/core/src/renderables/
//! markdown.conformance.json; Core and Rust run the same rows) and its streaming properties.
//!
//! Corpus checks, listed per row in `fails` like the bindings' checks:
//! - engine-html: one append of the whole document plus finish, through the test HTML emitter,
//!   equals the row's HTML after the corpus normalization (invariant 8).
//! - engine-stream: the row streamed in its chunks (or 32 pieces of equal code point count) equals
//!   a fresh doc of the same complete lines after every append, and one append of the whole after
//!   finish (invariant 1).
//!
//! The model tests (properties named as in markdown-highlight-ssot-models.md) run 256 seeds
//! of 64 commands, 64 more with an empty hook filter, and 4 random splits of every corpus row:
//! about 6 s in a debug build. Longer runs: MODEL_SEEDS=20000 for the command model,
//! MARKDOWN_SPLITS=64 for the splits; MODEL_SEED replays one seed, MARKDOWN_ROW runs one corpus
//! row and prints its HTML.
const std = @import("std");
const markdown = @import("../markdown.zig");
const html = @import("markdown-html.zig");
const Doc = markdown.Doc;
const inline_parser = @import("../markdown-inline.zig");

/// References that resolve nothing, for inline parses without a doc.
const f_references: inline_parser.References = .{ .context = undefined, .lookup_fn = struct {
    fn lookup(_: *const anyopaque, _: []const u8) ?inline_parser.Link {
        return null;
    }
}.lookup };
const gpa = std.testing.allocator;

pub const Fixture = struct {
    scratch: std.heap.ArenaAllocator,
    doc: Doc,

    pub fn init(self: *Fixture, options: markdown.Options) !void {
        self.scratch = std.heap.ArenaAllocator.init(gpa);
        self.doc = try Doc.init(gpa, &self.scratch, options);
    }

    pub fn deinit(self: *Fixture) void {
        self.doc.deinit();
        self.scratch.deinit();
    }
};

/// Blocks, committed count and leaf output agree (ids and change history excluded).
pub fn sameDocs(arena: std.mem.Allocator, a: *const Doc, b: *const Doc) !bool {
    if (a.blocks.items.len != b.blocks.items.len) return false;
    if (a.committed_top_level_count != b.committed_top_level_count) return false;
    for (a.blocks.items, b.blocks.items) |x, y| {
        var fx = x.flags;
        var fy = y.flags;
        fx.unreported = false;
        fy.unreported = false;
        if (@as(u16, @bitCast(fx)) != @as(u16, @bitCast(fy))) return false;
        if (x.kind != y.kind or x.parent_index != y.parent_index or x.small != y.small) return false;
        if (x.source_start_byte != y.source_start_byte or x.source_end_byte != y.source_end_byte) return false;
        if (x.content_start_byte != y.content_start_byte or x.content_end_byte != y.content_end_byte) return false;
        if (!std.mem.eql(u32, &x.payload, &y.payload)) return false;
    }
    return std.mem.eql(u8, try html.render(arena, a), try html.render(arena, b));
}

/// The row's chunks, or 32 pieces of equal code point count for a one-chunk row (Core's
/// `pieces`).
pub fn pieces(arena: std.mem.Allocator, chunks: []const std.json.Value) ![]const []const u8 {
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    if (chunks.len > 1) {
        for (chunks) |c| try out.append(arena, c.string);
        return out.items;
    }
    const text = chunks[0].string;
    const count = try std.unicode.utf8CountCodepoints(text);
    if (count == 0) {
        try out.append(arena, text);
        return out.items;
    }
    const size = @max(1, (count + 31) / 32);
    var it = (try std.unicode.Utf8View.init(text)).iterator();
    var start: usize = 0;
    var n: usize = 0;
    while (it.nextCodepointSlice()) |slice| {
        n += 1;
        const end = @intFromPtr(slice.ptr) - @intFromPtr(text.ptr) + slice.len;
        if (n % size == 0) {
            try out.append(arena, text[start..end]);
            start = end;
        }
    }
    if (start < text.len) try out.append(arena, text[start..]);
    return out.items;
}

/// The doc's complete lines as a fresh doc can take them: a final "\r" that the next byte
/// already completed becomes "\n" (same length, same line), since alone it would be pending.
pub fn completeLines(arena: std.mem.Allocator, doc: *const Doc) ![]const u8 {
    const lines = doc.source.items[0..doc.line_start_byte];
    if (lines.len == 0 or lines[lines.len - 1] != '\r') return lines;
    const copy = try arena.dupe(u8, lines);
    copy[copy.len - 1] = '\n';
    return copy;
}

fn rowOptions(name: []const u8) markdown.Options {
    return .{ .math = std.mem.startsWith(u8, name, "math") };
}

fn wholeHtml(arena: std.mem.Allocator, name: []const u8, text: []const u8) ![]const u8 {
    var f: Fixture = undefined;
    try f.init(rowOptions(name));
    defer f.deinit();
    try f.doc.append(text);
    try f.doc.finish();
    // read_leaf writes the bytes the live display counts, in chunks that cover them.
    for (f.doc.blocks.items, 0..) |b, i| {
        if (!Doc.isInlineLeaf(b)) continue;
        const leaf = try f.doc.readLeaf(arena, @intCast(i));
        var covered: usize = 0;
        for (leaf.chunks.items) |chunk| covered += chunk.byte_count;
        try std.testing.expectEqual(leaf.bytes.items.len, covered);
        try std.testing.expectEqualStrings(try f.doc.leafDisplay(arena, @intCast(i)), leaf.bytes.items);
        // UNRESOLVED is what a parse with every definition says (late definitions applied).
        try std.testing.expectEqual((try f.doc.parseLeaf(arena, @intCast(i))).unresolved, b.flags.unresolved);
    }
    return html.render(arena, &f.doc);
}

fn streamAgrees(arena: std.mem.Allocator, name: []const u8, chunks: []const std.json.Value) !bool {
    return streamAgreesParts(arena, name, try pieces(arena, chunks));
}

/// Rows longer than this skip the per-append fresh parse (quadratic in the row); the final
/// comparison and the live tail check still run.
const fresh_compare_byte_count_max = 4096;

/// The live leaf's tail writes so far rebuilt what read_leaf shows of that leaf now (B).
pub fn liveShowsReadLeaf(arena: std.mem.Allocator, doc: *const Doc, sink: *const markdown.TailSink) !bool {
    const leaf = doc.live.block;
    if (leaf == markdown.none or !sink.valid or leaf >= doc.blocks.items.len) return true;
    const expected = (try doc.readLeaf(arena, leaf)).bytes.items;
    if (std.mem.eql(u8, expected, sink.mirror.items)) return true;
    std.debug.print("live leaf {d} shows '{s}', read_leaf '{s}'\n", .{ leaf, sink.mirror.items, expected });
    return false;
}

fn streamAgreesParts(arena: std.mem.Allocator, name: []const u8, parts: []const []const u8) !bool {
    var total: usize = 0;
    for (parts) |part| total += part.len;
    var streamed: Fixture = undefined;
    try streamed.init(rowOptions(name));
    defer streamed.deinit();
    var sink: markdown.TailSink = .{ .allocator = gpa };
    defer sink.deinit();
    streamed.doc.tail_sink = &sink;
    for (parts) |part| {
        try streamed.doc.append(part);
        if (total > fresh_compare_byte_count_max) continue;
        if (!try liveShowsReadLeaf(arena, &streamed.doc, &sink)) {
            std.debug.print("  in {s} after {d} bytes\n", .{ name, streamed.doc.source.items.len });
            if (environment(arena, "MARKDOWN_PARTS") != null) {
                for (parts) |p| std.debug.print("  part \"{f}\"\n", .{std.zig.fmtString(p)});
            }
            return false;
        }
        var fresh: Fixture = undefined;
        try fresh.init(rowOptions(name));
        defer fresh.deinit();
        // The same source in one append: complete lines and the pending line's layout alike.
        try fresh.doc.append(streamed.doc.source.items);
        if (!try sameDocs(arena, &streamed.doc, &fresh.doc)) return false;
    }
    try streamed.doc.finish();
    // Each live leaf's tail writes rebuilt the display a whole parse gives the leaf.
    if (sink.mismatch_count > 0 or streamed.doc.counters.live_mismatch_count > 0) return false;
    var whole: Fixture = undefined;
    try whole.init(rowOptions(name));
    defer whole.deinit();
    try whole.doc.append(streamed.doc.source.items);
    try whole.doc.finish();
    return sameDocs(arena, &streamed.doc, &whole.doc);
}

/// The text a reader sees of `doc`, as the corpus frames write it (M0: 60 columns, conceal
/// on, Core's coalesced block mode): blocks apart by a blank line, list items by a line break,
/// `- ` and right-aligned ` 1. ` markers, box-drawn tables sized to their cells, and a link's
/// target after its text. Only what the frame rows use; a test instrument, not M3's renderer.
pub fn renderFrame(arena: std.mem.Allocator, doc: *const Doc) ![]const u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    try frameChildren(arena, doc, markdown.none, "\n\n", &out);
    // Trailing spaces on each line, and trailing blank lines, are not drawn.
    var trimmed: std.ArrayListUnmanaged(u8) = .empty;
    var lines = std.mem.splitScalar(u8, out.items, '\n');
    var first = true;
    while (lines.next()) |line| {
        if (!first) try trimmed.append(arena, '\n');
        first = false;
        try trimmed.appendSlice(arena, trimSpaceEnd(line));
    }
    return std.mem.trimEnd(u8, trimmed.items, "\n");
}

/// `line` without trailing white space as JavaScript's `trimEnd` (the frames' runner) sees it:
/// spaces, tabs, NBSP and the Unicode space separators.
fn trimSpaceEnd(line: []const u8) []const u8 {
    var end = line.len;
    while (end > 0) {
        if (line[end - 1] == ' ' or line[end - 1] == '\t') {
            end -= 1;
            continue;
        }
        var start = end - 1;
        while (start > 0 and (line[start] & 0xc0) == 0x80) start -= 1;
        const cp = std.unicode.utf8Decode(line[start..end]) catch break;
        const space = cp == 0xa0 or cp == 0x1680 or (cp >= 0x2000 and cp <= 0x200a) or cp == 0x2028 or cp == 0x2029 or cp == 0x202f or cp == 0x205f or cp == 0x3000 or cp == 0xfeff;
        if (!space) break;
        end = start;
    }
    return line[0..end];
}

fn frameChildren(arena: std.mem.Allocator, doc: *const Doc, parent: u32, separator: []const u8, out: *std.ArrayListUnmanaged(u8)) anyerror!void {
    var number: u32 = 0;
    for (doc.blocks.items, 0..) |b, i| {
        if (b.parent_index != parent) continue;
        const text = try frameBlock(arena, doc, @intCast(i), number);
        number += 1;
        if (text.len == 0) continue;
        if (out.items.len > 0) try out.appendSlice(arena, separator);
        try out.appendSlice(arena, text);
    }
}

fn frameBlock(arena: std.mem.Allocator, doc: *const Doc, index: u32, position: u32) ![]const u8 {
    const b = doc.blocks.items[index];
    var out: std.ArrayListUnmanaged(u8) = .empty;
    switch (b.kind) {
        .paragraph, .heading => try frameLeaf(arena, doc, index, &out),
        .code, .html => {
            const leaf = try doc.readLeaf(arena, index);
            try out.appendSlice(arena, std.mem.trimEnd(u8, leaf.bytes.items, "\n"));
        },
        .rule => try out.appendSlice(arena, "───"),
        .quote => try frameChildren(arena, doc, index, "\n\n", &out),
        .list => {
            var tight = b.flags.tight;
            if (b.flags.open) {
                tight = true;
                for (doc.blocks.items) |child| {
                    if (child.parent_index == index and child.flags.blank_after) tight = false;
                }
            }
            try frameChildren(arena, doc, index, if (tight) "\n" else "\n\n", &out);
        },
        .item => {
            const list = doc.blocks.items[b.parent_index];
            const marker = if (list.flags.ordered) try std.fmt.allocPrint(arena, "{d: >2}. ", .{list.payload[0] + position}) else "- ";
            var body: std.ArrayListUnmanaged(u8) = .empty;
            try frameChildren(arena, doc, index, "\n\n", &body);
            var lines = std.mem.splitScalar(u8, body.items, '\n');
            var first = true;
            while (lines.next()) |line| {
                if (!first) try out.append(arena, '\n');
                try out.appendSlice(arena, if (first) marker else try blanks(arena, marker.len));
                try out.appendSlice(arena, line);
                first = false;
            }
        },
        .table => try frameTable(arena, doc, index, &out),
        .table_row, .table_cell => unreachable,
    }
    return out.items;
}

/// A prose leaf's text, each link's target after it.
fn frameLeaf(arena: std.mem.Allocator, doc: *const Doc, index: u32, out: *std.ArrayListUnmanaged(u8)) !void {
    const leaf = try doc.readLeaf(arena, index);
    var at: usize = 0;
    for (leaf.chunks.items, 0..) |chunk, n| {
        try out.appendSlice(arena, leaf.bytes.items[at .. at + chunk.byte_count]);
        at += chunk.byte_count;
        const url = leaf.urls.items[chunk.link_offset .. chunk.link_offset + chunk.link_byte_count];
        const next_same = n + 1 < leaf.chunks.items.len and leaf.chunks.items[n + 1].link_byte_count == chunk.link_byte_count and leaf.chunks.items[n + 1].link_offset == chunk.link_offset;
        if (url.len > 0 and !next_same) try out.print(arena, " ({s})", .{url});
    }
}

fn blanks(arena: std.mem.Allocator, count: usize) ![]const u8 {
    const bytes = try arena.alloc(u8, count);
    @memset(bytes, ' ');
    return bytes;
}

fn frameTable(arena: std.mem.Allocator, doc: *const Doc, index: u32, out: *std.ArrayListUnmanaged(u8)) !void {
    var rows: std.ArrayListUnmanaged([]const []const u8) = .empty;
    var widths: std.ArrayListUnmanaged(usize) = .empty;
    for (doc.blocks.items, 0..) |row, r| {
        if (row.parent_index != index) continue;
        var cells: std.ArrayListUnmanaged([]const u8) = .empty;
        for (doc.blocks.items, 0..) |cell, c| {
            if (cell.parent_index != r) continue;
            var cell_text: std.ArrayListUnmanaged(u8) = .empty;
            try frameLeaf(arena, doc, @intCast(c), &cell_text);
            const text = cell_text.items;
            if (cells.items.len >= widths.items.len) try widths.append(arena, 0);
            widths.items[cells.items.len] = @max(widths.items[cells.items.len], try std.unicode.utf8CountCodepoints(text));
            try cells.append(arena, text);
        }
        try rows.append(arena, cells.items);
    }
    if (rows.items.len == 0) return;
    const Rule = struct { left: []const u8, middle: []const u8, right: []const u8 };
    const rule = struct {
        fn write(a: std.mem.Allocator, o: *std.ArrayListUnmanaged(u8), w: []const usize, r: Rule) !void {
            try o.appendSlice(a, r.left);
            for (w, 0..) |width, n| {
                if (n > 0) try o.appendSlice(a, r.middle);
                for (0..width) |_| try o.appendSlice(a, "─");
            }
            try o.appendSlice(a, r.right);
        }
    }.write;
    try rule(arena, out, widths.items, .{ .left = "┌", .middle = "┬", .right = "┐" });
    for (rows.items, 0..) |cells, n| {
        try out.appendSlice(arena, "\n│");
        for (widths.items, 0..) |width, c| {
            if (c > 0) try out.appendSlice(arena, "│");
            const text = if (c < cells.len) cells[c] else "";
            try out.appendSlice(arena, text);
            try out.appendSlice(arena, try blanks(arena, width - try std.unicode.utf8CountCodepoints(text)));
        }
        try out.appendSlice(arena, "│\n");
        if (n + 1 < rows.items.len) {
            try rule(arena, out, widths.items, .{ .left = "├", .middle = "┼", .right = "┤" });
        } else {
            try rule(arena, out, widths.items, .{ .left = "└", .middle = "┴", .right = "┘" });
        }
    }
}

/// Whether frame `n` (from 1) of the row is what the engine draws: after each chunk, the last
/// after the stream ends.
fn framesAgree(arena: std.mem.Allocator, name: []const u8, chunks: []const std.json.Value, frames: []const std.json.Value, results: []bool) !void {
    var f: Fixture = undefined;
    try f.init(rowOptions(name));
    defer f.deinit();
    for (chunks, frames, 0..) |chunk, frame, n| {
        try f.doc.append(chunk.string);
        if (n + 1 == chunks.len) try f.doc.finish();
        const actual = try renderFrame(arena, &f.doc);
        results[n] = std.mem.eql(u8, actual, frame.string);
        if (!results[n] and environment(arena, "MARKDOWN_ROW") != null) std.debug.print("frame {d}: expected '{s}'\n          actual   '{s}'\n", .{ n + 1, frame.string, actual });
    }
}

pub fn environment(arena: std.mem.Allocator, key: []const u8) ?[]const u8 {
    return std.testing.environ.getAlloc(arena, key) catch null;
}

/// JSON string body escaping, as `JSON.stringify` writes it (retag.ts reads these lines).
fn jsonEscape(arena: std.mem.Allocator, out: *std.ArrayListUnmanaged(u8), text: []const u8) !void {
    for (text) |c| {
        switch (c) {
            '"' => try out.appendSlice(arena, "\\\""),
            '\\' => try out.appendSlice(arena, "\\\\"),
            '\n' => try out.appendSlice(arena, "\\n"),
            '\t' => try out.appendSlice(arena, "\\t"),
            '\r' => try out.appendSlice(arena, "\\r"),
            0...8, 11, 12, 14...0x1f => try out.print(arena, "\\u{x:0>4}", .{c}),
            else => try out.append(arena, c),
        }
    }
}

fn listed(fails: []const std.json.Value, check: []const u8) bool {
    for (fails) |f| {
        if (std.mem.eql(u8, f.string, check)) return true;
    }
    return false;
}

test "Markdown corpus: the engine renders and streams each row unless the row lists it" {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const corpus = try std.json.parseFromSliceLeaky(std.json.Value, arena, @embedFile("markdown_conformance"), .{});
    const only = environment(arena, "MARKDOWN_ROW");
    var unexpected: std.ArrayListUnmanaged(u8) = .empty;
    var passes = [2]u32{ 0, 0 };
    var rows: u32 = 0;
    var frame_count: u32 = 0;
    var frame_passes: u32 = 0;
    for (corpus.object.get("rows").?.array.items) |row_value| {
        const row = row_value.array.items;
        const name = row[0].string;
        if (only) |o| if (!std.mem.eql(u8, o, name)) continue;
        rows += 1;
        const chunks = row[1].array.items;
        const fails = row[3].array.items;
        var row_arena = std.heap.ArenaAllocator.init(gpa);
        defer row_arena.deinit();
        const ra = row_arena.allocator();
        var text: std.ArrayListUnmanaged(u8) = .empty;
        for (chunks) |c| try text.appendSlice(ra, c.string);
        const actual = try html.normalize(ra, try wholeHtml(ra, name, text.items));
        const expected = try html.normalize(ra, row[2].string);
        const checks = [2]struct { []const u8, bool }{
            .{ "engine-html", std.mem.eql(u8, actual, expected) },
            .{ "engine-stream", try streamAgrees(ra, name, chunks) },
        };
        for (checks, 0..) |check, i| {
            passes[i] += @intFromBool(check[1]);
            if (check[1] != listed(fails, check[0])) continue;
            try unexpected.appendSlice(arena, "    \"");
            try jsonEscape(arena, &unexpected, name);
            try unexpected.print(arena, "|{s}\",\n", .{check[0]});
            if (only != null) std.debug.print("expected {s}\nactual   {s}\n", .{ expected, actual });
        }
        // The B frames M0 wrote for the row: engine-text:N for frame N.
        if (row.len > 4) {
            const frames = row[4].array.items;
            const results = try ra.alloc(bool, frames.len);
            try framesAgree(ra, name, chunks, frames, results);
            for (results, 1..) |ok, n| {
                frame_count += 1;
                frame_passes += @intFromBool(ok);
                const check = try std.fmt.allocPrint(ra, "engine-text:{d}", .{n});
                if (ok != listed(fails, check)) continue;
                try unexpected.appendSlice(arena, "    \"");
                try jsonEscape(arena, &unexpected, name);
                try unexpected.print(arena, "|{s}\",\n", .{check});
            }
        }
    }
    if (unexpected.items.len > 0 or environment(arena, "MARKDOWN_GATES") != null) {
        std.debug.print("rows {d}, engine-html {d}, engine-stream {d}, engine-text {d} of {d} frames; checks that differ from their listing:\n{s}", .{ rows, passes[0], passes[1], frame_passes, frame_count, unexpected.items });
    }
    if (unexpected.items.len > 0) {
        return error.CorpusMismatch;
    }
}

// ---- Model test (markdown-highlight-ssot-models.md, M1 row) ----

const model = @import("model.zig");

/// Pieces the soup generator glues together: every block start, inline opener and line ending
/// the engine has a state for.
const soup = [_][]const u8{
    "- ",        "> ",  "```",      "```\n", "|",     " | ",   "| --- | --- |\n", "[x]",
    "[x]: /u\n", "**",  "*",        "_",     "`",     "$",     "10. ",            "1. ",
    "===",       "---", "\t",       "\r\n",  "\n",    "\n\n",  "word",            " ",
    "ses_",      "se",  "s_",       "# ",    "<div>", "&amp;", "](/u)",           "\\",
    "    code",  "~~",  "www.a.b ", "$$\n",  "x",     "[",     "]",               "  \n",
};

const EngineCommand = union(enum) {
    append: []const u8,
    finish,
    /// set(x): when `shared`, x starts with the current source.
    set: struct { text: []const u8, shared: bool },
    /// read_changes with capacity 0, one short of the count, or the count.
    read: u8,
    toggle_math,
    /// set_options with the other hook filter (latches again).
    swap_filter,
};

const Engine = struct {
    corpus_texts: []const []const u8,
    hook: bool = true,
    filter: []const u8 = "ses_",
    other_filter: []const u8 = "se",

    pub const Command = EngineCommand;

    pub fn generate(self: *Engine, arena: std.mem.Allocator, random: std.Random, steps: usize) ![]Command {
        var commands: std.ArrayListUnmanaged(Command) = .empty;
        // A base document to stream: a corpus row or soup.
        var base: std.ArrayListUnmanaged(u8) = .empty;
        if (random.boolean()) {
            try base.appendSlice(arena, self.corpus_texts[random.uintLessThan(usize, self.corpus_texts.len)]);
        } else {
            for (0..steps) |_| try base.appendSlice(arena, soup[random.uintLessThan(usize, soup.len)]);
        }
        var at: usize = 0;
        for (0..steps) |_| {
            const roll = random.uintLessThan(u32, 100);
            if (roll < 70 and at < base.items.len) {
                // 1 byte or a few code points; "\r\n" may split.
                var end = at + 1 + random.uintLessThan(usize, if (random.boolean()) 1 else 12);
                end = @min(end, base.items.len);
                while (end < base.items.len and (base.items[end] & 0xc0) == 0x80) end += 1;
                try commands.append(arena, .{ .append = base.items[at..end] });
                at = end;
            } else if (roll < 75) {
                try commands.append(arena, .finish);
            } else if (roll < 82) {
                const text = soup[random.uintLessThan(usize, soup.len)];
                try commands.append(arena, .{ .set = .{ .text = text, .shared = random.boolean() } });
            } else if (roll < 97) {
                try commands.append(arena, .{ .read = random.uintLessThan(u8, 3) });
            } else if (roll < 99) {
                try commands.append(arena, .toggle_math);
            } else {
                try commands.append(arena, .swap_filter);
            }
        }
        return commands.items;
    }

    /// An append keeps its first half or its second half; a shared set drops the old source.
    pub fn simplify(_: *Engine, arena: std.mem.Allocator, command: Command) ![]const Command {
        return switch (command) {
            .append => |text| if (text.len > 1) try arena.dupe(Command, &.{ .{ .append = text[0 .. text.len / 2] }, .{ .append = text[text.len / 2 ..] } }) else &.{},
            .set => |s| if (s.shared) try arena.dupe(Command, &.{.{ .set = .{ .text = s.text, .shared = false } }}) else &.{},
            else => &.{},
        };
    }

    pub fn format(_: *Engine, command: Command, writer: *std.Io.Writer) void {
        switch (command) {
            .append => |text| writer.print("append \"{f}\"", .{std.zig.fmtString(text)}) catch {},
            .finish => writer.writeAll("finish") catch {},
            .set => |s| writer.print("set {s}\"{f}\"", .{ if (s.shared) "source + " else "", std.zig.fmtString(s.text) }) catch {},
            .read => |c| writer.print("read_changes capacity {s}", .{switch (c) {
                0 => "0",
                1 => "count - 1",
                else => "count",
            }}) catch {},
            .toggle_math => writer.writeAll("set_options math toggled") catch {},
            .swap_filter => writer.writeAll("set_options filter swapped") catch {},
        }
    }

    pub fn run(self: *Engine, arena: std.mem.Allocator, commands: []const Command) !?model.Failure {
        var options: markdown.Options = .{ .hook = self.hook, .hook_filter = self.filter };
        var f: Fixture = undefined;
        try f.init(options);
        defer f.deinit();
        var sink: markdown.TailSink = .{ .allocator = gpa };
        defer sink.deinit();
        f.doc.tail_sink = &sink;
        var mirror: std.ArrayListUnmanaged(markdown.Block) = .empty;
        var committed: u32 = 0;
        var closed: std.ArrayListUnmanaged(markdown.Block) = .empty;
        // P7: the frame drawn after the last append or finish (null after a replace).
        var frame: ?[]const u8 = null;
        for (commands, 0..) |command, step| {
            const was_finished = f.doc.finished;
            // B's last exception to P7: a backtick opener drawn as a code span that never closes
            // reverts to text (its content's escapes and entities then decode).
            // The check skips a step that starts with an open prose leaf holding a backtick, and
            // a step that adds a definition (a late definition turns `[a][b]` into `a`).
            const definition_count = f.doc.definitions.items.len;
            var code_drawn = false;
            for (f.doc.blocks.items) |b| {
                const prose = b.kind == .paragraph or b.kind == .heading or b.kind == .table_cell;
                if (prose and (b.flags.open or b.source_end_byte > f.doc.line_start_byte) and std.mem.indexOfScalar(u8, f.doc.source.items[b.source_start_byte..@min(f.doc.source.items.len, b.source_end_byte)], '`') != null) code_drawn = true;
            }
            const read_before = f.doc.read_block_count;
            const before_blocks = try arena.dupe(markdown.Block, f.doc.blocks.items);
            switch (command) {
                .append => |text| try f.doc.append(text),
                .finish => try f.doc.finish(),
                .set => |s| {
                    const text = if (s.shared) try std.mem.concat(arena, u8, &.{ f.doc.source.items, s.text }) else s.text;
                    try f.doc.set(text);
                    // P2: replace equals fresh; the blocks before the removal are the old ones.
                    var fresh: Fixture = undefined;
                    try fresh.init(options);
                    defer fresh.deinit();
                    try fresh.doc.append(text);
                    if (!try sameDocs(arena, &f.doc, &fresh.doc)) return .{ .property = "P2 replace equals fresh", .step = step };
                    // Blocks a read listed stay unless at or past removed_from_index.
                    const kept = @min(@min(f.doc.removed_from_index, read_before), @as(u32, @intCast(@min(before_blocks.len, f.doc.blocks.items.len))));
                    for (before_blocks[0..kept], f.doc.blocks.items[0..kept]) |a, b| {
                        if (a.kind != b.kind or a.source_start_byte != b.source_start_byte) return .{ .property = "P2 leading blocks kept", .step = step };
                    }
                },
                .read => |capacity_kind| {
                    var count: u32 = 0;
                    for (f.doc.blocks.items) |b| count += @intFromBool(b.flags.unreported);
                    // A host reads with room for at least one record: a zero capacity only asks.
                    const capacity: u32 = switch (capacity_kind) {
                        0 => 0,
                        1 => count -| 1,
                        else => @max(count, 1),
                    };
                    const out = try arena.alloc(markdown.Doc.Change, capacity);
                    const mirror_len = mirror.items.len;
                    const read = f.doc.readChanges(out);
                    if (read.count != count) return .{ .property = "P5 change count", .step = step };
                    // Only blocks a read listed can be reported removed.
                    if (read.removed_from_index != markdown.none and read.removed_from_index >= mirror_len) return .{ .property = "P5 removal of an unread block", .step = step };
                    if (capacity > 0 and capacity >= count) {
                        if (read.removed_from_index != markdown.none and read.removed_from_index < mirror.items.len) mirror.items.len = read.removed_from_index;
                        for (out[0..count]) |change| {
                            if (change.index >= mirror.items.len) try mirror.resize(arena, change.index + 1);
                            mirror.items[change.index] = change.block;
                        }
                        // P5: the host mirror equals the engine's blocks.
                        if (mirror.items.len != f.doc.blocks.items.len) return .{ .property = "P5 host mirror", .step = step };
                        for (mirror.items, f.doc.blocks.items) |a, b| {
                            if (!sameRecord(a, b)) return .{ .property = "P5 host mirror", .step = step };
                        }
                    }
                },
                .toggle_math => {
                    options.math = !options.math;
                    try f.doc.setOptions(options);
                },
                .swap_filter => {
                    options.hook_filter = if (std.mem.eql(u8, options.hook_filter, self.filter)) self.other_filter else self.filter;
                    try f.doc.setOptions(options);
                },
            }
            // A replace, a math change and an append after finish (N2) parse afresh.
            const reopened = command == .append and was_finished;
            if (reopened or command == .set or command == .toggle_math) {
                committed = 0;
                closed.clearRetainingCapacity();
            }
            // P1: streamed equals a fresh doc of the same complete lines (or the whole document
            // plus finish once finished).
            var fresh: Fixture = undefined;
            try fresh.init(options);
            defer fresh.deinit();
            if (f.doc.finished) {
                try fresh.doc.append(f.doc.source.items);
                try fresh.doc.finish();
            } else {
                try fresh.doc.append(f.doc.source.items);
            }
            if (!try sameDocs(arena, &f.doc, &fresh.doc)) return .{ .property = "P1 streamed equals whole", .step = step };
            // P4: the committed count only grows; P4': every closed top-level prefix block is
            // committed (N1 (a): unresolved labels do not hold it).
            if (f.doc.committed_top_level_count < committed) return .{ .property = "P4 committed count monotone", .step = step };
            committed = f.doc.committed_top_level_count;
            var closed_prefix: u32 = 0;
            var i: u32 = 0;
            while (i < f.doc.blocks.items.len) {
                const b = f.doc.blocks.items[i];
                if (b.flags.open) break;
                closed_prefix += 1;
                i = f.doc.subtreeEnd(i);
            }
            if (closed_prefix != committed) return .{ .property = "P4' commit liveness", .step = step };
            // P3: a closed block keeps its kind, ranges and parent.
            for (closed.items, 0..) |snapshot, index| {
                if (index >= f.doc.blocks.items.len or !sameStructure(snapshot, f.doc.blocks.items[index])) return .{ .property = "P3 closed is final", .step = step };
            }
            closed.clearRetainingCapacity();
            for (f.doc.blocks.items) |b| {
                if (b.flags.open) break;
                try closed.append(arena, b);
            }
            // P18: a prose leaf of complete lines is hooked exactly when its source holds the
            // filter.
            if (self.hook) {
                for (f.doc.blocks.items) |b| {
                    if (!markdown.Doc.isInlineLeaf(b) or b.source_end_byte > f.doc.line_start_byte) continue;
                    const found = std.mem.indexOfPos(u8, f.doc.source.items, b.source_start_byte, options.hook_filter);
                    // An empty filter hooks every prose leaf.
                    const holds = options.hook_filter.len == 0 or (found != null and found.? < b.source_end_byte);
                    if (holds != b.flags.hooked) return .{ .property = "P18 filter latch equals substring", .step = step };
                }
            }
            // P7: no frame loses drawn text (B's exceptions aside, see framesGrow).
            if (reopened or command == .set or command == .toggle_math or command == .swap_filter) frame = null;
            if (command == .append or command == .finish) {
                const next = try renderFrame(arena, &f.doc);
                if (frame) |previous| {
                    const exempt = code_drawn or f.doc.definitions.items.len != definition_count;
                    if (!exempt and !framesGrow(previous, next, options.math)) {
                        if (std.debug.runtime_safety and model.environment(arena, "MODEL_SEED") != null) std.debug.print("frame '{s}' then '{s}'\n", .{ previous, next });
                        return .{ .property = "P7 no frame loses drawn text", .step = step };
                    }
                }
                frame = next;
            }
            if (sink.mismatch_count > 0) return .{ .property = "live tail writes equal the leaf's display", .step = step };
            if (!try liveShowsReadLeaf(arena, &f.doc, &sink)) return .{ .property = "live display equals read_leaf (B)", .step = step };
            if (f.doc.counters.live_mismatch_count > 0) return .{ .property = "live pending line guessed its leaf", .step = step };
        }
        return null;
    }
};

/// Whether every non-white-space byte `previous` drew is in `next`, in order (P7). B's
/// exceptions are left out of both: link brackets and an image's `!` (concealed when the link
/// resolves) and math delimiters (`$`, and with math on `\(` and `\)`, concealed when math
/// closes).
fn framesGrow(previous: []const u8, next: []const u8, math: bool) bool {
    var at: usize = 0;
    for (previous) |c| {
        if (frameIgnored(c) or (math and (c == '\\' or c == '(' or c == ')'))) continue;
        while (at < next.len and next[at] != c) at += 1;
        if (at == next.len) return false;
        at += 1;
    }
    return true;
}

fn frameIgnored(c: u8) bool {
    return switch (c) {
        ' ', '\t', '\n', '[', ']', '!', '$' => true,
        else => false,
    };
}

/// The fields a host sees (internal bits excluded).
fn sameRecord(a: markdown.Block, b: markdown.Block) bool {
    var fa = a.flags;
    var fb = b.flags;
    inline for (.{ "unreported", "final" }) |name| {
        @field(fa, name) = false;
        @field(fb, name) = false;
    }
    return a.kind == b.kind and a.parent_index == b.parent_index and @as(u16, @bitCast(fa)) == @as(u16, @bitCast(fb)) and
        a.source_start_byte == b.source_start_byte and a.source_end_byte == b.source_end_byte and
        a.content_start_byte == b.content_start_byte and a.content_end_byte == b.content_end_byte and
        std.mem.eql(u32, &a.payload, &b.payload) and a.small == b.small;
}

fn sameStructure(a: markdown.Block, b: markdown.Block) bool {
    return a.kind == b.kind and a.parent_index == b.parent_index and a.source_start_byte == b.source_start_byte and
        a.source_end_byte == b.source_end_byte and a.content_start_byte == b.content_start_byte and
        a.content_end_byte == b.content_end_byte;
}

fn corpusTexts(arena: std.mem.Allocator) ![]const []const u8 {
    const corpus = try std.json.parseFromSliceLeaky(std.json.Value, arena, @embedFile("markdown_conformance"), .{});
    var texts: std.ArrayListUnmanaged([]const u8) = .empty;
    for (corpus.object.get("rows").?.array.items) |row| {
        var text: std.ArrayListUnmanaged(u8) = .empty;
        for (row.array.items[1].array.items) |c| try text.appendSlice(arena, c.string);
        try texts.append(arena, text.items);
    }
    return texts.items;
}

test "Markdown model: append, set, finish and reads keep P1-P5, P18 and the live tail" {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    var engine: Engine = .{ .corpus_texts = try corpusTexts(arena_state.allocator()) };
    try model.check(Engine, &engine, .{ .seeds = 256, .steps = 64 });
    // An empty filter hooks every prose leaf.
    var hook_all: Engine = .{ .corpus_texts = engine.corpus_texts, .filter = "", .other_filter = "ses_" };
    try model.check(Engine, &hook_all, .{ .seeds = 64, .steps = 64 });
}

test "Markdown model: corpus rows split at random code points stream like one append" {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const corpus = try std.json.parseFromSliceLeaky(std.json.Value, arena, @embedFile("markdown_conformance"), .{});
    const seeds: u64 = if (model.environment(arena, "MARKDOWN_SPLITS")) |t| try std.fmt.parseInt(u64, t, 10) else 4;
    for (corpus.object.get("rows").?.array.items) |row| {
        const name = row.array.items[0].string;
        var text: std.ArrayListUnmanaged(u8) = .empty;
        for (row.array.items[1].array.items) |c| try text.appendSlice(arena, c.string);
        for (0..seeds) |seed| {
            var row_arena = std.heap.ArenaAllocator.init(gpa);
            defer row_arena.deinit();
            const ra = row_arena.allocator();
            var prng = std.Random.DefaultPrng.init(seed);
            const random = prng.random();
            var parts: std.ArrayListUnmanaged([]const u8) = .empty;
            var at: usize = 0;
            while (at < text.items.len) {
                // Seed 0 streams one code point per append (so "\r\n" splits).
                var end = at + if (seed == 0) 1 else 1 + random.uintLessThan(usize, 8);
                end = @min(end, text.items.len);
                while (end < text.items.len and (text.items[end] & 0xc0) == 0x80) end += 1;
                try parts.append(ra, text.items[at..end]);
                at = end;
            }
            if (parts.items.len < 2) continue;
            if (!try streamAgreesParts(ra, name, parts.items)) {
                std.debug.print("row {s} seed {d} streams differently\n", .{ name, seed });
                return error.StreamMismatch;
            }
        }
    }
}

test "Markdown read_leaf: display bytes, chunk styles, spans and the URL pool" {
    const Row = struct { source: []const u8, math: bool = false, block: u32, chunks: []const struct { []const u8, []const u8, []const u8 } };
    // Each chunk: its text, a scope summary and its link target.
    const rows = [_]Row{
        .{ .source = "see [docs](https://e.x/a) **now**", .block = 0, .chunks = &.{ .{ "see ", "", "" }, .{ "docs", "link", "https://e.x/a" }, .{ " ", "", "" }, .{ "now", "strong", "" } } },
        .{ .source = "| a\\|b |\n| --- |\n", .block = 2, .chunks = &.{.{ "a|b", "", "" }} },
        .{ .source = "open `ses_a` here", .block = 0, .chunks = &.{ .{ "open ", "", "" }, .{ "ses_a", "code", "" }, .{ " here", "", "" } } },
        .{ .source = "is $x^2$ ok", .math = true, .block = 0, .chunks = &.{ .{ "is ", "", "" }, .{ "x^2", "math", "" }, .{ " ok", "", "" } } },
        .{ .source = "mail a.b@c.de now", .block = 0, .chunks = &.{ .{ "mail ", "", "" }, .{ "a.b@c.de", "link", "mailto:a.b@c.de" }, .{ " now", "", "" } } },
        .{ .source = "## *a* \\* b", .block = 0, .chunks = &.{ .{ "a", "heading italic", "" }, .{ " ", "heading", "" }, .{ "*", "heading escape", "" }, .{ " b", "heading", "" } } },
        .{ .source = "- x\n\n      code\n       more\n", .block = 3, .chunks = &.{.{ "code\n more", "raw", "" }} },
        // One run closes a span and opens another (CommonMark 6.2).
        .{ .source = "*a***b**", .block = 0, .chunks = &.{ .{ "a", " italic", "" }, .{ "b", "strong", "" } } },
    };
    for (rows) |row| {
        var f: Fixture = undefined;
        try f.init(.{ .math = row.math });
        defer f.deinit();
        try f.doc.append(row.source);
        try f.doc.finish();
        var arena_state = std.heap.ArenaAllocator.init(gpa);
        defer arena_state.deinit();
        const arena = arena_state.allocator();
        const leaf = try f.doc.readLeaf(arena, row.block);
        var actual: std.ArrayListUnmanaged(u8) = .empty;
        var expected: std.ArrayListUnmanaged(u8) = .empty;
        var at: usize = 0;
        for (leaf.chunks.items) |chunk| {
            const s = chunk.scope;
            try actual.print(arena, "[{s}|{s}{s}{s}{s}{s}{s}{s}{s}|{s}]", .{
                leaf.bytes.items[at .. at + chunk.byte_count],
                if (s.heading_level > 0) "heading" else "",
                if (s.italic) " italic" else "",
                if (s.strong) "strong" else "",
                if (s.link) "link" else "",
                if (chunk.span.code) "code" else "",
                if (chunk.span.math) "math" else "",
                if (s.raw and !chunk.span.code) "raw" else "",
                if (s.escape) " escape" else "",
                leaf.urls.items[chunk.link_offset .. chunk.link_offset + chunk.link_byte_count],
            });
            at += chunk.byte_count;
        }
        for (row.chunks) |c| try expected.print(arena, "[{s}|{s}|{s}]", .{ c[0], c[1], c[2] });
        std.testing.expectEqualStrings(expected.items, actual.items) catch |err| {
            std.debug.print("row: {s}\n", .{row.source});
            return err;
        };
        try std.testing.expectEqual(leaf.bytes.items.len, at);
    }
}

fn repeat(comptime text: []const u8, comptime count: usize) *const [text.len * count]u8 {
    comptime var out: [text.len * count]u8 = undefined;
    inline for (0..count) |i| @memcpy(out[i * text.len ..][0..text.len], text);
    const result = out;
    return &result;
}

/// The doc's state a rejected call must leave as it was.
fn expectUnchanged(before_source: []const u8, before_blocks: []const markdown.Block, doc: *const Doc) !void {
    try std.testing.expectEqualStrings(before_source, doc.source.items);
    try std.testing.expectEqual(before_blocks.len, doc.blocks.items.len);
    for (before_blocks, doc.blocks.items) |a, b| try std.testing.expect(std.meta.eql(a, b));
}

test "Markdown limits: each store stays within its limit and a rejection publishes nothing" {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    // Source: the append that would pass the limit fails and changes nothing.
    {
        var f: Fixture = undefined;
        try f.init(.{ .limits = .{ .source_byte_count = 16 } });
        defer f.deinit();
        try f.doc.append("# a\n\nsome **x");
        const source = try arena.dupe(u8, f.doc.source.items);
        const blocks = try arena.dupe(markdown.Block, f.doc.blocks.items);
        try std.testing.expectError(error.SourceLimit, f.doc.append("y\n\nz"));
        try expectUnchanged(source, blocks, &f.doc);
        try f.doc.append("y\n");
        try std.testing.expectError(error.SourceLimit, f.doc.set("0123456789abcdefg"));
    }
    // Blocks: an append that opens one block too many fails as a whole, mid-line included.
    {
        var f: Fixture = undefined;
        try f.init(.{ .limits = .{ .block_count = 4 } });
        defer f.deinit();
        try f.doc.append("a\n\n> b\n");
        const source = try arena.dupe(u8, f.doc.source.items);
        const blocks = try arena.dupe(markdown.Block, f.doc.blocks.items);
        try std.testing.expectError(error.BlockLimit, f.doc.append("\nc\n\n- d\n- e\n"));
        try expectUnchanged(source, blocks, &f.doc);
        try f.doc.append("\nc\n");
        try std.testing.expectEqual(@as(usize, 4), f.doc.blocks.items.len);
        try std.testing.expectError(error.BlockLimit, f.doc.append("\n- e\n"));
        try f.doc.finish();
    }
    // Definitions: one past the limit is hidden as the spec says but resolves nothing.
    {
        var f: Fixture = undefined;
        try f.init(.{ .limits = .{ .definition_count = 2 } });
        defer f.deinit();
        try f.doc.append("[a]: /a\n[b]: /b\n[c]: /c\n\n[a] [b] [c]\n");
        try f.doc.finish();
        try std.testing.expectEqual(@as(usize, 2), f.doc.definitions.items.len);
        try std.testing.expectEqualStrings("<p><a href=\"/a\">a</a> <a href=\"/b\">b</a> [c]</p>", try html.normalize(arena, try html.render(arena, &f.doc)));
    }
    // Tokens: an opener 4,096 tokens back becomes literal, streamed or whole.
    {
        var text: std.ArrayListUnmanaged(u8) = .empty;
        try text.appendSlice(arena, "*a");
        for (0..2100) |_| try text.appendSlice(arena, " `b`");
        try text.appendSlice(arena, " c*\n");
        var whole: Fixture = undefined;
        try whole.init(.{});
        defer whole.deinit();
        try whole.doc.append(text.items);
        try whole.doc.finish();
        const rendered = try html.render(arena, &whole.doc);
        try std.testing.expect(std.mem.indexOf(u8, rendered, "<em>") == null);
        try std.testing.expect(try streamAgreesParts(arena, "tokens", &.{ text.items[0..3], text.items[3..4000], text.items[4000..] }));
        // At the boundary: the opener matches exactly when the closer is within 4,096 tokens of
        // it (an escape shifts the count by one token).
        for (2044..2050) |n| {
            for ([_][]const u8{ "", "\\." }) |shift| {
                const source = try std.mem.concat(arena, u8, &.{ "*a", text.items[2 .. 2 + 4 * n], shift, " c*" });
                const r = try inline_parser.parse(arena, source, f_references, .{});
                const closer: u32 = @intCast(r.tokens.len - 1);
                try std.testing.expectEqual(closer < inline_parser.token_count_max, r.matches.len == 1);
            }
        }
    }
    // Token storage: openers that never close keep the stack from emptying; the live leaf's
    // stores stay within twice the token limit (length and capacity) after every append, and its
    // tail writes still rebuild the leaf's display.
    {
        var f: Fixture = undefined;
        try f.init(.{});
        defer f.deinit();
        var sink: markdown.TailSink = .{ .allocator = gpa };
        defer sink.deinit();
        f.doc.tail_sink = &sink;
        const bound = 2 * inline_parser.token_count_max + 64;
        var high: usize = 0;
        for (0..6000) |n| {
            try f.doc.append(if (n % 2 == 0) "*a " else "[b ");
            const p = &f.doc.live.parser;
            high = @max(high, p.tokens.items.len);
            try std.testing.expect(p.tokens.items.len <= bound and p.tokens.capacity <= 2 * bound);
            try std.testing.expect(p.delimiters.items.len <= bound and p.delimiters.capacity <= 2 * bound);
            try std.testing.expect(p.matches.items.len <= bound and p.brackets.items.len <= inline_parser.bracket_count_max);
            try std.testing.expect(f.doc.live.display_ends.items.len <= bound and f.doc.live.display_ends.capacity <= 2 * bound);
            try std.testing.expect(f.doc.live.content.items.len <= 8 * bound);
        }
        try std.testing.expect(high > inline_parser.token_count_max);
        try std.testing.expect(try liveShowsReadLeaf(arena, &f.doc, &sink));
        try f.doc.finish();
        try std.testing.expectEqual(@as(u32, 0), sink.mismatch_count);
        try std.testing.expectEqual(@as(u32, 1), sink.checked_leaf_count);
    }
    // Filter: at most 256 bytes of items of 1 to 64 bytes.
    {
        var scratch = std.heap.ArenaAllocator.init(gpa);
        defer scratch.deinit();
        const long_item = repeat("x", 65);
        try std.testing.expectError(error.InvalidOptions, Doc.init(gpa, &scratch, .{ .hook = true, .hook_filter = long_item }));
        try std.testing.expectError(error.InvalidOptions, Doc.init(gpa, &scratch, .{ .hook = true, .hook_filter = "a\x00\x00b" }));
        const items = repeat("x" ++ repeat("x", 62) ++ "\x00", 4) ++ "y";
        try std.testing.expectError(error.InvalidOptions, Doc.init(gpa, &scratch, .{ .hook = true, .hook_filter = items }));
        var doc = try Doc.init(gpa, &scratch, .{ .hook = true, .hook_filter = items[0 .. items.len - 2] });
        doc.deinit();
    }
    // Depth: nesting stops at the limit; deeper markers are text in the innermost leaf.
    {
        var f: Fixture = undefined;
        try f.init(.{});
        defer f.deinit();
        try f.doc.append(repeat(">", 40) ++ " x\n" ++ repeat("- ", 20) ++ "y\n");
        try f.doc.finish();
        var deepest: u32 = 0;
        for (f.doc.blocks.items, 0..) |_, i| {
            var depth: u32 = 0;
            var p: u32 = @intCast(i);
            while (p != markdown.none) : (p = f.doc.blocks.items[p].parent_index) depth += 1;
            deepest = @max(deepest, depth);
        }
        try std.testing.expectEqual(markdown.depth_max, deepest);
        const leaf = try f.doc.leafDisplay(arena, @intCast(f.doc.blocks.items.len - 1));
        try std.testing.expect(std.mem.startsWith(u8, leaf, "- ") or std.mem.indexOf(u8, leaf, "y") != null);
    }
}

const Work = struct { byte_count: usize, append_count: usize, counters: markdown.Counters, hooked: bool };

/// Streams `parts` into a fresh doc (with finish) and returns its work counters.
fn work(options: markdown.Options, parts: []const []const u8) !Work {
    var f: Fixture = undefined;
    try f.init(options);
    defer f.deinit();
    var byte_count: usize = 0;
    for (parts) |part| {
        try f.doc.append(part);
        byte_count += part.len;
    }
    try f.doc.finish();
    var hooked = false;
    for (f.doc.blocks.items) |b| hooked = hooked or b.flags.hooked;
    return .{ .byte_count = byte_count, .append_count = parts.len, .counters = f.doc.counters, .hooked = hooked };
}

fn split(arena: std.mem.Allocator, text: []const u8, size: usize) ![]const []const u8 {
    var parts: std.ArrayListUnmanaged([]const u8) = .empty;
    var at: usize = 0;
    while (at < text.len) {
        var end = @min(text.len, at + size);
        while (end < text.len and (text[end] & 0xc0) == 0x80) end += 1;
        try parts.append(arena, text[at..end]);
        at = end;
    }
    return parts.items;
}

fn fixture(arena: std.mem.Allocator, name: []const u8) ![]const u8 {
    const corpus = try std.json.parseFromSliceLeaky(std.json.Value, arena, @embedFile("markdown_conformance"), .{});
    for (corpus.object.get("rows").?.array.items) |row| {
        if (std.mem.eql(u8, row.array.items[0].string, name)) return row.array.items[1].array.items[0].string;
    }
    return error.NoSuchRow;
}

test "Markdown work: every counter stays linear in the document (invariant 4)" {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var words: std.ArrayListUnmanaged(u8) = .empty;
    while (words.items.len < 8192) try words.appendSlice(arena, "word ");
    const line = words.items[0..8192];
    const xs = try arena.alloc(u8, 8192);
    @memset(xs, 'x');
    const spaces = try arena.alloc(u8, 4096);
    @memset(spaces, ' ');
    var label: std.ArrayListUnmanaged(u8) = .empty;
    try label.appendSlice(arena, "see [a][");
    while (label.items.len < 900) try label.appendSlice(arena, "label ");
    // The token limit's storage row: the delimiter stack never empties.
    var openers: std.ArrayListUnmanaged(u8) = .empty;
    for (0..6000) |n| try openers.appendSlice(arena, if (n % 2 == 0) "*a " else "[b ");
    const verbose = environment(arena, "MARKDOWN_GATES") != null;
    const Row = struct {
        name: []const u8,
        options: markdown.Options = .{},
        parts: []const []const u8,
        inline_factor: u64 = 2,
        /// Display visits: a pending word is drawn, then compared with its tokens' display
        /// (assembled once) when the word ends; the fixtures stay within 2x.
        display_factor: u64 = 3,
        /// Sent bytes: an opener drawn as closed (B) that never closes is drawn again, literal,
        /// when its leaf closes (the design's gate: at most 2x on this row).
        sent_factor: u64 = 1,
    };
    const rows = [_]Row{
        .{ .name = "list.md, 30-byte appends", .parts = try split(arena, try fixture(arena, "fixture list"), 30), .display_factor = 2 },
        .{ .name = "prose.md, 30-byte appends", .parts = try split(arena, try fixture(arena, "fixture prose"), 30), .display_factor = 2 },
        .{ .name = "an 8,192-byte line, 1-byte appends", .parts = try split(arena, line, 1) },
        .{ .name = "some **x + 8,192 one-byte appends", .parts = try std.mem.concat(arena, []const u8, &.{ &.{"some **x"}, try split(arena, xs, 1) }), .sent_factor = 2 },
        .{ .name = "a stray backtick, 1-byte appends", .parts = try std.mem.concat(arena, []const u8, &.{ &.{"a `b "}, try split(arena, line, 1) }), .sent_factor = 2 },
        .{ .name = "a pending line of spaces, 1-byte appends", .parts = try std.mem.concat(arena, []const u8, &.{ &.{"text\n"}, try split(arena, spaces, 1), &.{"x\n"} }) },
        .{ .name = "a growing reference label, 1-byte appends", .parts = try split(arena, label.items, 1) },
        // B's holds read on where they stopped: trailing spaces, an entity, an autolink and a
        // code span's trailing spaces that stay undecided for 4,096 bytes.
        .{ .name = "spaces inside a paragraph, 1-byte appends", .parts = try std.mem.concat(arena, []const u8, &.{ &.{"a"}, try split(arena, spaces, 1), &.{"b\n"} }) },
        .{ .name = "a long unfinished entity, 1-byte appends", .parts = try std.mem.concat(arena, []const u8, &.{ &.{"&"}, try split(arena, xs[0..4096], 1), &.{";\n"} }) },
        .{ .name = "a long unfinished autolink, 1-byte appends", .parts = try std.mem.concat(arena, []const u8, &.{ &.{"a <"}, try split(arena, xs[0..4096], 1), &.{">\n"} }) },
        .{ .name = "spaces in a code span, 1-byte appends", .parts = try std.mem.concat(arena, []const u8, &.{ &.{"`a"}, try split(arena, spaces, 1), &.{"`\n"} }) },
        // The leaf's close writes it again from a whole parse (expired openers show literal).
        .{ .name = "openers that never close, 3-byte appends", .parts = try split(arena, openers.items, 3), .display_factor = 4, .sent_factor = 2 },
        .{ .name = "se + s_ with the filter", .options = .{ .hook = true, .hook_filter = "ses_" }, .parts = &.{ "see se", "s_abc now\n" } },
    };
    for (rows) |row| {
        const w = try work(row.options, row.parts);
        const c = w.counters;
        const n = w.byte_count;
        if (verbose) std.debug.print("{s}: {d} bytes in {d} appends; line {d}, block {d}, hook {d}, inline {d}, display {d}, sent {d}\n", .{ row.name, n, w.append_count, c.line_byte_visits, c.block_byte_visits, c.hook_byte_visits, c.inline_byte_visits, c.display_byte_visits, c.tail_write_bytes });
        // Each counter, where its bytes are read: the line scanner reads each byte once (and the
        // last byte again per append, a pending carriage return); the filter search reads new
        // bytes plus its overlap per append.
        const bounds = [_]struct { []const u8, u64, u64 }{
            .{ "line", c.line_byte_visits, n + w.append_count + 1 },
            // A pending line's first byte is read again per append (its kind, its layout).
            .{ "block", c.block_byte_visits, 2 * n + 4 * w.append_count + 64 },
            .{ "hook", c.hook_byte_visits, n + 3 * w.append_count + 8 },
            .{ "inline", c.inline_byte_visits, row.inline_factor * n + 64 },
            .{ "display", c.display_byte_visits, row.display_factor * n + 64 },
            .{ "sent", c.tail_write_bytes, row.sent_factor * n + 64 },
        };
        for (bounds) |bound| {
            std.testing.expect(bound[1] <= bound[2]) catch |err| {
                std.debug.print("{s}: {s} counter {d} above {d}\n", .{ row.name, bound[0], bound[1], bound[2] });
                return err;
            };
        }
        if (row.options.hook) try std.testing.expect(w.hooked);
    }
    // Each counter counts: a small document's exact work.
    const small = try work(.{}, &.{ "ab *c", "d* e\n" });
    // Each byte once, and the first append's last byte again (it may be a carriage return).
    try std.testing.expectEqual(@as(u64, 11), small.counters.line_byte_visits);
    try std.testing.expect(small.counters.inline_byte_visits >= 9);
    try std.testing.expect(small.counters.block_byte_visits >= 2);
    // "ab c" (the opener drawn as closed), then "d e": each display byte sent once.
    try std.testing.expectEqual(@as(u64, 7), small.counters.tail_write_bytes);
}

/// Counts allocator calls that reach the backing allocator.
const CountingAllocator = struct {
    backing: std.mem.Allocator,
    count: u64 = 0,

    fn allocator(self: *CountingAllocator) std.mem.Allocator {
        return .{ .ptr = self, .vtable = &.{ .alloc = alloc, .resize = resize, .remap = remap, .free = free } };
    }

    fn alloc(context: *anyopaque, len: usize, alignment: std.mem.Alignment, ret: usize) ?[*]u8 {
        const self: *CountingAllocator = @ptrCast(@alignCast(context));
        self.count += 1;
        return self.backing.rawAlloc(len, alignment, ret);
    }

    fn resize(context: *anyopaque, memory: []u8, alignment: std.mem.Alignment, len: usize, ret: usize) bool {
        const self: *CountingAllocator = @ptrCast(@alignCast(context));
        self.count += 1;
        return self.backing.rawResize(memory, alignment, len, ret);
    }

    fn remap(context: *anyopaque, memory: []u8, alignment: std.mem.Alignment, len: usize, ret: usize) ?[*]u8 {
        const self: *CountingAllocator = @ptrCast(@alignCast(context));
        self.count += 1;
        return self.backing.rawRemap(memory, alignment, len, ret);
    }

    fn free(context: *anyopaque, memory: []u8, alignment: std.mem.Alignment, ret: usize) void {
        const self: *CountingAllocator = @ptrCast(@alignCast(context));
        self.backing.rawFree(memory, alignment, ret);
    }
};

test "Markdown work: no allocation per append in steady state, capacity growth counted apart" {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const prose = try fixture(arena, "fixture prose");
    // long.md: prose.md ten times (M0's note).
    var copies: [10][]const u8 = undefined;
    @memset(&copies, prose);
    const long = try std.mem.join(arena, "\n", &copies);
    var counting: CountingAllocator = .{ .backing = gpa };
    var scratch = std.heap.ArenaAllocator.init(counting.allocator());
    defer scratch.deinit();
    var doc = try Doc.init(counting.allocator(), &scratch, .{});
    defer doc.deinit();
    const parts = try split(arena, long, 30);
    const warm_up = parts.len / 2;
    for (parts[0..warm_up]) |part| try doc.append(part);
    const calls_before = counting.count;
    const growth_before = doc.counters.capacity_growth_count;
    for (parts[warm_up..]) |part| try doc.append(part);
    const calls = counting.count - calls_before;
    const growth = doc.counters.capacity_growth_count - growth_before;
    if (environment(arena, "MARKDOWN_GATES") != null) std.debug.print("steady state: {d} appends, {d} allocator calls, {d} capacity growths\n", .{ parts.len - warm_up, calls, growth });
    try std.testing.expect(calls <= growth);
}

test "Markdown stream: a leaf that changes kind or loses lines keeps its live display exact" {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const rows = [_][]const u8{
        "intro **x\na | b\n--- | ---\n1 | 2\n",
        "Title *a*\n=\n\nnext",
        "[x]: /u\nsee [x] *y*\n\ntail",
        "> quote **a\nlazy b**\n\n- item\n  more\n",
        "a\n- b\n10. c\n",
        "x `y\n\nz` w\n",
    };
    for (rows) |text| {
        try std.testing.expect(try streamAgreesParts(arena, "kinds", try split(arena, text, 1)));
        try std.testing.expect(try streamAgreesParts(arena, "kinds", try split(arena, text, 3)));
    }
}

test "Markdown commits: a block with an unresolved label commits once closed (N1 (a), P4')" {
    var f: Fixture = undefined;
    try f.init(.{});
    defer f.deinit();
    const chunks = [_][]const u8{ "p [1] and a[i]\n\n", "q\n\n", "r\n", "\ns", "" };
    const committed = [_]u32{ 1, 2, 2, 3, 4 };
    for (chunks, committed) |chunk, expected| {
        if (chunk.len == 0) try f.doc.finish() else try f.doc.append(chunk);
        try std.testing.expectEqual(expected, f.doc.committed_top_level_count);
    }
    try std.testing.expect(f.doc.blocks.items[0].flags.unresolved);
}
