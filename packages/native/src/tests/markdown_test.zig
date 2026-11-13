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
//! The CI budget (B3, F6): the command model runs 64 seeds of 64 commands, 16 more with an
//! empty hook filter and 16 with the hook off and math on (set_options switches math and the
//! filter mid-stream in every run); the repeated-construct model 8 streams; the depth-2 sweep
//! every pair of 16 pieces under 5 option sets; the prefix differential 48 documents; with the
//! corpus and the fixed rows about 9.4 s of CPU in a debug build. Every mutant of the work file's
//! tables is caught at this budget by a fixed row or a model, except the stated equivalents. Opt
//! in, at the end of each round: MARKDOWN_SPLITS=4 (or 64) splits every corpus row at random code
//! points; MODEL_SEEDS=2000 (or 20000) widens both models; MARKDOWN_DIFFERENTIAL=<n> the
//! differential. MODEL_SEED replays one seed, MARKDOWN_ROW runs one corpus row and prints its HTML.
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
    if (std.mem.startsWith(u8, name, "hook")) return .{ .hook = true, .hook_filter = "ses_" };
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

/// P5 for the writes: every bound leaf's node (the sink's mirror of the engine's writes to it)
/// shows what read_leaf shows of that leaf now (B), at every append and at finish. Table cells
/// have no node: a host reads them with read_leaf.
pub fn liveShowsReadLeaf(arena: std.mem.Allocator, doc: *const Doc, sink: *const markdown.TailSink) !bool {
    for (0..doc.blocks.items.len) |i| {
        if (!try nodeShowsReadLeaf(arena, doc, sink, @intCast(i))) return false;
    }
    return true;
}

/// liveShowsReadLeaf after one call, over the nodes it wrote, the blocks a host would read
/// (with `unreported`: those still unreported) and the live leaf; then clears the written list. A node
/// that changes otherwise is caught at finish, where every node is checked.
pub fn writtenShowReadLeaf(arena: std.mem.Allocator, doc: *const Doc, sink: *markdown.TailSink, unreported: bool) !bool {
    defer sink.written.clearRetainingCapacity();
    for (sink.written.items) |i| {
        if (i < doc.blocks.items.len and !try nodeShowsReadLeaf(arena, doc, sink, i)) return false;
    }
    if (doc.live.block < doc.blocks.items.len and !try nodeShowsReadLeaf(arena, doc, sink, doc.live.block)) return false;
    if (unreported) {
        for (doc.blocks.items, 0..) |b, i| {
            if (b.flags.unreported and !try nodeShowsReadLeaf(arena, doc, sink, @intCast(i))) return false;
        }
    }
    return true;
}

fn nodeShowsReadLeaf(arena: std.mem.Allocator, doc: *const Doc, sink: *const markdown.TailSink, index: u32) !bool {
    const b = doc.blocks.items[index];
    if (!markdown.Doc.isBound(b)) return true;
    const expected = (try doc.readLeaf(arena, index)).bytes.items;
    if (std.mem.eql(u8, expected, sink.shown(index))) return true;
    std.debug.print("leaf {d} shows '{s}', read_leaf '{s}'\n", .{ index, sink.shown(index), expected });
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
    var frame: ?[]const u8 = null;
    var math_once: MathOnce = .{};
    for (parts) |part| {
        const exempt = p7Exempt(&streamed.doc);
        try streamed.doc.append(part);
        if (!math_once.check(&streamed.doc)) {
            std.debug.print("  {s}: a math block reverted to text after {d} bytes\n", .{ name, streamed.doc.source.items.len });
            return false;
        }
        if (total > fresh_compare_byte_count_max) continue;
        // P7: no frame loses drawn text (B's exceptions aside).
        const next = try renderFrame(arena, &streamed.doc);
        if (frame) |previous| {
            if (!exempt.exempt(&streamed.doc) and !framesGrow(previous, next, streamed.doc.options.math)) {
                std.debug.print("  {s}: frame '{s}' then '{s}'\n", .{ name, previous, next });
                return false;
            }
        }
        frame = next;
        if (!try writtenShowReadLeaf(arena, &streamed.doc, &sink, false)) {
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
    const exempt = p7Exempt(&streamed.doc);
    try streamed.doc.finish();
    if (frame) |previous| {
        const next = try renderFrame(arena, &streamed.doc);
        if (!exempt.exempt(&streamed.doc) and !framesGrow(previous, next, streamed.doc.options.math)) {
            std.debug.print("  {s}: frame '{s}' then '{s}' at finish\n", .{ name, previous, next });
            return false;
        }
    }
    // Each live leaf's tail writes rebuilt the display a whole parse gives the leaf.
    if (sink.mismatch_count > 0 or streamed.doc.counters.live_mismatch_count > 0) return false;
    if (!try liveShowsReadLeaf(arena, &streamed.doc, &sink)) return false;
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
    "- ",        "> ",  "```",      "```\n", "|",     " | ",      "| --- | --- |\n", "[x]",
    "[x]: /u\n", "**",  "*",        "_",     "`",     "$",        "10. ",            "1. ",
    "===",       "---", "\t",       "\r\n",  "\n",    "\n\n",     "word",            " ",
    "ses_",      "se",  "s_",       "# ",    "<div>", "&amp;",    "](/u)",           "\\",
    "    code",  "~~",  "www.a.b ", "$$\n",  "x",     "[",        "]",               "  \n",
    // The bytes of the tear prototype's repros (an email's `@`, an unfinished entity, setext
    // underlines after a link, a math opener before a word).
    "@",         "@\n", "$$_",      "&mp;",  "\n=\n", "[x](/u) ", "\n===\n",
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
    /// set of the same source with every `/u` and `/w` swapped: definitions change their
    /// targets while their users' bytes stay.
    redefine,
};

const Engine = struct {
    corpus_texts: []const []const u8,
    hook: bool = true,
    math: bool = false,
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
            } else if (roll < 78) {
                const text = soup[random.uintLessThan(usize, soup.len)];
                try commands.append(arena, .{ .set = .{ .text = text, .shared = random.boolean() } });
            } else if (roll < 82) {
                try commands.append(arena, .redefine);
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
            .redefine => writer.writeAll("set source with /u and /w swapped") catch {},
        }
    }

    pub fn run(self: *Engine, arena: std.mem.Allocator, commands: []const Command) !?model.Failure {
        var options: markdown.Options = .{ .hook = self.hook, .hook_filter = self.filter, .math = self.math };
        var f: Fixture = undefined;
        try f.init(options);
        defer f.deinit();
        var sink: markdown.TailSink = .{ .allocator = gpa };
        defer sink.deinit();
        f.doc.tail_sink = &sink;
        var mirror: std.ArrayListUnmanaged(markdown.Block) = .empty;
        // The read_leaf output the host read for each listed prose leaf (null: none read).
        var outputs: std.ArrayListUnmanaged(?[]const u8) = .empty;
        var committed: u32 = 0;
        var closed: std.ArrayListUnmanaged(markdown.Block) = .empty;
        // P7: the frame drawn after the last append or finish (null after a replace).
        var frame: ?[]const u8 = null;
        var fed: Fed = .{};
        var math_once: MathOnce = .{};
        for (commands, 0..) |command, step| {
            const was_finished = f.doc.finished;
            switch (command) {
                // An append after finish parses the whole document again (N2).
                .append => |text| fed.add(text.len + if (f.doc.finished) f.doc.source.items.len else 0),
                .set => |s| fed.add(s.text.len + if (s.shared) f.doc.source.items.len else 0),
                .finish, .redefine, .toggle_math, .swap_filter => fed.add(f.doc.source.items.len),
                .read => {},
            }
            // B's last exception to P7: a backtick opener drawn as a code span that never closes
            // reverts to text (its content's escapes and entities then decode).
            const p7 = p7Exempt(&f.doc);
            const read_before = f.doc.read_block_count;
            const before_blocks = try arena.dupe(markdown.Block, f.doc.blocks.items);
            switch (command) {
                .append => |text| try f.doc.append(text),
                .finish => try f.doc.finish(),
                .set, .redefine => {
                    const text = switch (command) {
                        .set => |s| if (s.shared) try std.mem.concat(arena, u8, &.{ f.doc.source.items, s.text }) else s.text,
                        else => try swapTargets(arena, f.doc.source.items),
                    };
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
                        // The host reads each listed prose leaf; a closed leaf it read must not
                        // change its output without being listed again.
                        if (outputs.items.len > mirror.items.len) outputs.items.len = mirror.items.len;
                        while (outputs.items.len < mirror.items.len) try outputs.append(arena, null);
                        for (out[0..count]) |change| {
                            outputs.items[change.index] = if (markdown.Doc.isInlineLeaf(change.block)) try leafOutput(arena, &f.doc, change.index) else null;
                        }
                        for (outputs.items, 0..) |output, index| {
                            const known = output orelse continue;
                            if (f.doc.blocks.items[index].flags.open) continue;
                            if (!std.mem.eql(u8, known, try leafOutput(arena, &f.doc, @intCast(index)))) return .{ .property = "P5 host mirror of leaf output", .step = step };
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
            if (reopened or command == .set or command == .redefine or command == .toggle_math) {
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
            if (reopened or command == .set or command == .redefine or command == .toggle_math or command == .swap_filter) frame = null;
            if (command == .append or command == .finish) {
                const next = try renderFrame(arena, &f.doc);
                if (frame) |previous| {
                    if (!p7.exempt(&f.doc) and !framesGrow(previous, next, options.math)) {
                        if (std.debug.runtime_safety and model.environment(arena, "MODEL_SEED") != null) std.debug.print("frame '{s}' then '{s}'\n", .{ previous, next });
                        return .{ .property = "P7 no frame loses drawn text", .step = step };
                    }
                }
                frame = next;
            }
            if (sink.mismatch_count > 0) return .{ .property = "live tail writes equal the leaf's display", .step = step };
            // Every node at finish; after another call, the ones it wrote or listed.
            const nodes_ok = if (command == .finish) try liveShowsReadLeaf(arena, &f.doc, &sink) else try writtenShowReadLeaf(arena, &f.doc, &sink, true);
            if (!nodes_ok) return .{ .property = "every node shows read_leaf (P5, B)", .step = step };
            if (f.doc.counters.live_mismatch_count > 0) return .{ .property = "live pending line guessed its leaf", .step = step };
            // (c) after appends: other commands lay the pending line out as an append would.
            if (try genericProperties(arena, &f.doc, fed, options, command == .append)) |property| return .{ .property = property, .step = step };
            if (command != .append and command != .read) math_once = .{};
            if (!math_once.check(&f.doc)) return .{ .property = "(c) a math block never reverts to text", .step = step };
        }
        // Every node once more at the end (a call checks only the nodes it wrote or listed).
        if (!try liveShowsReadLeaf(arena, &f.doc, &sink)) return .{ .property = "every node shows read_leaf (P5, B)", .step = commands.len -| 1 };
        return null;
    }
};

/// Bytes the caller has handed the doc so far: appended and set bytes, and the whole source
/// once more for each call that parses the whole document again (finish, an option change, a
/// replace). Property (a) bounds every work counter by a multiple of it.
const Fed = struct {
    byte_count: u64 = 0,
    call_count: u64 = 0,

    fn add(self: *Fed, byte_count: usize) void {
        self.byte_count += byte_count;
        self.call_count += 1;
    }
};

/// The three generic properties (D97), checked after every call: (a) every work counter stays
/// within k x the bytes fed so far, k per counter; (b) every store stays within its limit; (c)
/// the pending line's provisional layout is one the exact parse of the completed line extends.
/// Returns the failing property's name.
fn genericProperties(arena: std.mem.Allocator, doc: *const Doc, fed: Fed, options: markdown.Options, layout: bool) !?[]const u8 {
    // (a) Work. k per counter, with a per-call term where a counter reads the pending line's
    // first bytes or the filter overlap again on each call.
    const c = doc.counters;
    const n = fed.byte_count;
    const calls = fed.call_count;
    const bounds = [_]struct { []const u8, u64, u64 }{
        .{ "(a) work: line visits <= 1n + calls", c.line_byte_visits, n + calls + 1 },
        // A line is read by the scanner's block pass, its paragraph checks, the pipe scan, a
        // definition scan and once more at close: k = 6.
        .{ "(a) work: block visits <= 6n + 8 calls", c.block_byte_visits, 6 * n + 8 * calls + 64 },
        // Each filter item searches the new bytes and the filter's overlap (its longest item less
        // one), plus the pending line again wherever a new layout reads it (the block counter's
        // term): k = 6 per item, as the block counter.
        .{ "(a) work: hook visits <= items x (6n + overlap x calls)", c.hook_byte_visits, filterItems(options) * (6 * n + (filterOverlap(options) + 1) * calls) + 64 },
        .{ "(a) work: inline visits <= 4n", c.inline_byte_visits, 4 * n + 64 },
        .{ "(a) work: display visits <= 6n", c.display_byte_visits, 6 * n + 64 },
        // A display byte is assembled when it is drawn pending, drawn up to a hold's cut, and
        // (once in a token) for the comparison and the cut: k = 4.
        .{ "(a) work: assembled bytes <= 4n", c.display_assembled_bytes, 4 * n + 64 },
        .{ "(a) work: sent bytes <= 3n", c.tail_write_bytes, 3 * n + 64 },
    };
    for (bounds) |bound| {
        if (bound[1] > bound[2]) {
            if (std.debug.runtime_safety and model.environment(arena, "MODEL_SEED") != null) std.debug.print("{s}: {d} > {d}\n", .{ bound[0], bound[1], bound[2] });
            return bound[0];
        }
    }
    // (b) Storage. The documented limits, and the live leaf's stores (twice the token limit,
    // capacity twice that); the provisional undo log keeps each changed block once.
    const limits = options.limits;
    if (doc.source.items.len > limits.source_byte_count) return "(b) storage: source";
    if (doc.blocks.items.len > limits.block_count) return "(b) storage: blocks";
    if (doc.definitions.items.len > limits.definition_count) return "(b) storage: definitions";
    const live = &doc.live;
    const p = &live.parser;
    const bound = 2 * inline_parser.token_count_max + 64;
    inline for (.{ "tokens", "delimiters", "matches" }) |name| {
        const list = @field(p, name);
        if (list.items.len > bound or list.capacity > 2 * bound) return "(b) storage: live " ++ name;
    }
    if (live.display_ends.items.len > bound or live.display_ends.capacity > 2 * bound) return "(b) storage: live display ends";
    if (p.brackets.items.len > inline_parser.bracket_count_max) return "(b) storage: live brackets";
    // Each block a provisional layout changed is saved once (at most the open path and the
    // blocks the line closes).
    const undo = doc.provisional_undo.items;
    if (undo.len > 2 * (markdown.depth_max + 8) or doc.provisional_undo.capacity > 4 * (markdown.depth_max + 8)) return "(b) storage: provisional undo";
    for (undo, 0..) |entry, i| {
        for (undo[0..i]) |other| if (other.index == entry.index) return "(b) storage: provisional undo";
    }
    if (doc.scratch.queryCapacity() > markdown.scratch_retained_byte_count_max) return "(b) storage: scratch arena";
    // (c) Layout agreement, below a size where a fresh parse per call stays cheap.
    if (layout and doc.source.items.len <= fresh_compare_byte_count_max and !try layoutAgrees(arena, doc, options)) return "(c) pending layout equals the completed line's";
    return null;
}

fn filterItems(options: markdown.Options) u64 {
    if (!options.hook or options.hook_filter.len == 0) return 1;
    return std.mem.count(u8, options.hook_filter, "\x00") + 1;
}

/// The filter's overlap: its longest item less one (0 with no filter).
fn filterOverlap(options: markdown.Options) u64 {
    if (!options.hook) return 0;
    var longest: u64 = 1;
    var it = std.mem.splitScalar(u8, options.hook_filter, 0);
    while (it.next()) |item| longest = @max(longest, item.len);
    return longest - 1;
}

/// (c) across calls for display math (D102: shown as it streams, never hidden): a math block
/// may appear once on a line and never reverts to text. Remembers the last math block that
/// started on the pending line or after the last complete line, by source offset.
const MathOnce = struct {
    start: u32 = markdown.none,

    /// False when the math block seen last is gone (its line is text or a row again).
    fn check(self: *MathOnce, doc: *const Doc) bool {
        if (self.start != markdown.none) {
            var found = false;
            for (doc.blocks.items) |b| {
                if (b.kind == .code and b.flags.math and b.source_start_byte == self.start) found = true;
            }
            if (!found and self.start < doc.source.items.len) return false;
        }
        self.start = markdown.none;
        for (doc.blocks.items) |b| {
            if (b.kind == .code and b.flags.math and b.source_start_byte >= doc.line_start_byte) self.start = b.source_start_byte;
        }
        return true;
    }
};

/// (c): the provisional layout of the pending line against the exact parse of the same bytes
/// with the line completed. Every block shown has the completed parse's kind and parent, and
/// the completed parse only extends each leaf's display (P7's comparison) except for B's four
/// accepted exceptions, and D102's one switch of a line to display math at its end: link
/// brackets and inline math delimiters (framesGrow skips them), an opener
/// drawn as closed that reverts (its marks are extra bytes), and a backtick opener's or inline
/// math's content decoding when it reverts or closes (a leaf that holds a backtick, or with math
/// a `$` or `\(`, is not compared), and a definition the
/// completed line adds (displays are not compared then). A held line (no layout) shows nothing new
/// and passes.
fn layoutAgrees(arena: std.mem.Allocator, doc: *const Doc, options: markdown.Options) !bool {
    const s = doc.source.items;
    if (doc.finished or s.len == doc.line_start_byte or doc.provisional_from == markdown.none) return true;
    if (s[s.len - 1] == '\r') return true;
    var whole: Fixture = undefined;
    try whole.init(options);
    defer whole.deinit();
    try whole.doc.append(s);
    try whole.doc.append("\n");
    const shown = doc.blocks.items;
    const exact = whole.doc.blocks.items;
    // D102: a line that starts a math block once complete shows as text or a row until then and
    // switches once, at its line ending (MathOnce: never back).
    for (exact) |b| {
        if (b.kind == .code and b.flags.math and b.source_start_byte >= doc.line_start_byte) return true;
    }
    var agrees = shown.len == exact.len;
    if (agrees) {
        for (shown, exact, 0..) |a, b, i| {
            if (a.kind != b.kind or a.parent_index != b.parent_index) {
                agrees = false;
                break;
            }
            if (!markdown.Doc.isInlineLeaf(a) or whole.doc.definitions.items.len != doc.definitions.items.len) continue;
            const leaf_source = s[a.source_start_byte..@min(s.len, a.source_end_byte)];
            if (std.mem.indexOfScalar(u8, leaf_source, '`') != null) continue;
            // Inline math that closes conceals its delimiters and shows its content raw (B's
            // math exception): such a leaf is not compared either.
            if (options.math and (std.mem.indexOfScalar(u8, leaf_source, '$') != null or std.mem.indexOf(u8, leaf_source, "\\(") != null)) continue;
            const x = (try doc.readLeaf(arena, @intCast(i))).bytes.items;
            const y = (try whole.doc.readLeaf(arena, @intCast(i))).bytes.items;
            if (!framesGrow(x, y, options.math)) {
                agrees = false;
                break;
            }
        }
    }
    if (!agrees and std.debug.runtime_safety and model.environment(arena, "MODEL_SEED") != null) {
        std.debug.print("pending layout:\n", .{});
        for (shown, 0..) |b, i| std.debug.print("  {d} {s} p{d} '{s}'\n", .{ i, @tagName(b.kind), b.parent_index, if (markdown.Doc.isInlineLeaf(b)) (try doc.readLeaf(arena, @intCast(i))).bytes.items else "" });
        std.debug.print("completed line:\n", .{});
        for (exact, 0..) |b, i| std.debug.print("  {d} {s} p{d} '{s}'\n", .{ i, @tagName(b.kind), b.parent_index, if (markdown.Doc.isInlineLeaf(b)) (try whole.doc.readLeaf(arena, @intCast(i))).bytes.items else "" });
    }
    return agrees;
}

/// Streams of one construct repeated many times (D97: the classes, not their instances):
/// definition titles over many lines, nested containers with a growing pending line, pipes in
/// code spans and holds before token runs, open emphasis, long headings and table rows, deep
/// nesting, every line kind after a table, and a math opener that keeps receiving bytes.
const Family = enum {
    title_lines,
    title_markup,
    nested_pending,
    code_pipes,
    code_span_pipe,
    open_emphasis,
    heading,
    table_rows,
    wide_rows,
    deep_nesting,
    after_table,
    math_candidate,
    inline_html,
    html_block,
};

const FamilyCommand = union(enum) {
    append: []const u8,
    finish,
    math,
    /// The hook on, with this filter.
    filter: []const u8,
};

const Families = struct {
    pub const Command = FamilyCommand;

    fn pick(random: std.Random, items: []const []const u8) []const u8 {
        return items[random.uintLessThan(usize, items.len)];
    }

    pub fn document(arena: std.mem.Allocator, random: std.Random, family: Family, count: usize) ![]const u8 {
        var out: std.ArrayListUnmanaged(u8) = .empty;
        const containers = [_][]const u8{ "> ", "- ", "1. ", "* ", "> - " };
        switch (family) {
            .title_lines => {
                // A definition's title, or an inline link's (one title scanner serves both).
                try out.appendSlice(arena, pick(random, &.{ "[x]: /u '", "[x]: /u\n\"", "intro\n\n[x]: /u (", "> see [ref](url \"", "see [r](u '", "a [b](c\n(" }));
                for (0..count) |_| try out.appendSlice(arena, pick(random, &.{ "bb\n", "c d\n", "*e* [f]\n" }));
                // The closer, white space as long as the title (bigboi round 5: the tail read the
                // closed title again while its `)` had not arrived), then what follows.
                try out.appendSlice(arena, pick(random, &.{ "'", "\"", ")" }));
                if (random.boolean()) for (0..count) |_| try out.append(arena, ' ');
                try out.appendSlice(arena, pick(random, &.{ "\n\n[x]\n", "\n[x] after\n", ") done\n" }));
            },
            .title_markup => {
                try out.appendSlice(arena, pick(random, &.{ "[x]: /u '", "[x]: /u \"`|` ", "text `a | b` ", "text | " }));
                for (0..count) |_| try out.appendSlice(arena, pick(random, &.{ "*a ", "[b ", "`c` ", "_d " }));
            },
            .nested_pending => {
                const depth = 1 + random.uintLessThan(usize, 30);
                for (0..depth) |_| try out.appendSlice(arena, pick(random, &containers));
                try out.appendSlice(arena, "a\n");
                if (random.boolean()) for (0..depth) |_| try out.appendSlice(arena, "> ");
                for (0..count) |_| try out.appendSlice(arena, pick(random, &.{ "w", " ", "x|", "*" }));
            },
            .code_pipes => {
                for (0..count) |_| try out.appendSlice(arena, pick(random, &.{ "`a | b` ", "*a ", "[b ", "x ", "`|`" }));
            },
            .code_span_pipe => {
                // A long code span with a pipe in it, then words on the same line.
                try out.appendSlice(arena, pick(random, &.{ "x `", "x ``", "`" }));
                for (0..count) |_| try out.appendSlice(arena, pick(random, &.{ "a", " ", "|", "a\n" }));
                try out.appendSlice(arena, pick(random, &.{ "` ", "`` ", "`" }));
                for (0..count) |_| try out.appendSlice(arena, pick(random, &.{ "c ", "*d ", "|" }));
            },
            .open_emphasis => {
                try out.appendSlice(arena, pick(random, &.{ "*", "**", "_", "text | *", "~~" }));
                for (0..count) |_| try out.appendSlice(arena, pick(random, &.{ "ab ", "cd ", "e" }));
                try out.appendSlice(arena, "end");
            },
            .heading => {
                try out.appendSlice(arena, pick(random, &.{ "# ", "###### ", "> ## " }));
                for (0..count) |_| try out.appendSlice(arena, pick(random, &.{ "word ", "#", " ", "x", "\\#" }));
            },
            .table_rows, .wide_rows => {
                const columns: usize = if (family == .wide_rows) 128 else 2;
                for ([_][]const u8{ "a", "-" }) |cell| {
                    for (0..columns) |_| try out.appendSlice(arena, try std.mem.concat(arena, u8, &.{ "|", cell }));
                    try out.appendSlice(arena, "|\n");
                }
                for (0..count) |_| try out.appendSlice(arena, pick(random, &.{ "c", "|", " ", "\\", "`", "\n", "\\|" }));
            },
            .deep_nesting => {
                for (0..count) |_| {
                    const depth = 1 + random.uintLessThan(usize, 40);
                    for (0..depth) |_| try out.appendSlice(arena, pick(random, &containers));
                    try out.appendSlice(arena, pick(random, &.{ "text\n", "\n", "| a |\n", "```\n" }));
                }
            },
            .after_table => {
                try out.appendSlice(arena, "|a|b|\n|-|-|\n");
                for (0..count) |_| try out.appendSlice(arena, pick(random, &.{ "\\[x\\]\n", "$$x$$\n", "# h\n", "- i\n", "> q\n", "```\n", "|c|d|\n", "text\n", "$$\n", "<div>\n", "    code\n", "[x]: /u\n", "***\n", "===\n", "\\[\n" }));
            },
            .inline_html => {
                // An unfinished tag, comment or declaration in a paragraph.
                try out.appendSlice(arena, pick(random, &.{ "x <!--", "x <a b=\"", "x <a ", "x <?", "x <![CDATA[", "x <!X " }));
                for (0..count) |_| try out.appendSlice(arena, pick(random, &.{ "a", " ", "-" }));
            },
            .html_block => {
                try out.appendSlice(arena, pick(random, &.{ "<!-- x -->", "<div>", "<?x ?>", "<!--", "<pre>" }));
                for (0..count) |_| try out.appendSlice(arena, pick(random, &.{ "a", " ", "-->", ">", "</pre>" }));
            },
            .math_candidate => {
                try out.appendSlice(arena, pick(random, &.{ "$$", "\\[", "> $$" }));
                for (0..count) |_| try out.appendSlice(arena, pick(random, &.{ "]x", " ", "$", "x" }));
            },
        }
        return out.items;
    }

    pub fn generate(_: *Families, arena: std.mem.Allocator, random: std.Random, _: usize) ![]Command {
        var commands: std.ArrayListUnmanaged(Command) = .empty;
        if (random.boolean()) try commands.append(arena, .math);
        // A filter as long as one may be (its overlap is read at every call), or short ones.
        if (random.uintLessThan(u32, 4) == 0) try commands.append(arena, .{ .filter = pick(random, &.{ "q\x00r\x00s\x00t\x00u\x00v\x00w\x00x\x00y\x00z\x00b\x00c\x00d\x00e\x00f\x00g", "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", "ses_", "a\x00bb\x00ccc" }) });
        const family = random.enumValue(Family);
        // From a few repeats to a document past the token limit (log-uniform); nesting lines
        // are long, so fewer.
        const shift_max: u6 = switch (family) {
            .title_markup, .code_pipes => 12,
            .deep_nesting => 7,
            else => 10,
        };
        const count = @as(usize, 4) << random.uintLessThan(u6, shift_max);
        const text = try document(arena, random, family, count);
        // Mostly one byte at a time; larger pieces for large documents.
        const piece_max: usize = if (text.len > fresh_compare_byte_count_max) 64 else pick(random, &.{ "\x01", "\x04", "\x1e" })[0];
        var at: usize = 0;
        while (at < text.len) {
            var end = @min(text.len, at + 1 + random.uintLessThan(usize, piece_max));
            while (end < text.len and (text[end] & 0xc0) == 0x80) end += 1;
            try commands.append(arena, .{ .append = text[at..end] });
            at = end;
        }
        try commands.append(arena, .finish);
        return commands.items;
    }

    pub fn simplify(_: *Families, arena: std.mem.Allocator, command: Command) ![]const Command {
        return switch (command) {
            .append => |text| if (text.len > 1) try arena.dupe(Command, &.{ .{ .append = text[0 .. text.len / 2] }, .{ .append = text[text.len / 2 ..] } }) else &.{},
            else => &.{},
        };
    }

    pub fn format(_: *Families, command: Command, writer: *std.Io.Writer) void {
        switch (command) {
            .append => |text| writer.print("append \"{f}\"", .{std.zig.fmtString(text[0..@min(text.len, 200)])}) catch {},
            .finish => writer.writeAll("finish") catch {},
            .math => writer.writeAll("math on") catch {},
            .filter => |f| writer.print("hook filter \"{f}\"", .{std.zig.fmtString(f)}) catch {},
        }
    }

    pub fn run(_: *Families, arena: std.mem.Allocator, commands: []const Command) !?model.Failure {
        var options: markdown.Options = .{};
        var f: Fixture = undefined;
        try f.init(options);
        defer f.deinit();
        // Node writes on, so their run work counts.
        var sink: markdown.TailSink = .{ .allocator = gpa };
        defer sink.deinit();
        f.doc.tail_sink = &sink;
        var fed: Fed = .{};
        var step_arena = std.heap.ArenaAllocator.init(gpa);
        defer step_arena.deinit();
        _ = arena;
        var math_once: MathOnce = .{};
        for (commands, 0..) |command, step| {
            _ = step_arena.reset(.retain_capacity);
            switch (command) {
                .append => |text| {
                    fed.add(text.len);
                    try f.doc.append(text);
                },
                .finish => {
                    fed.add(f.doc.source.items.len);
                    try f.doc.finish();
                },
                .math => {
                    options.math = true;
                    fed.add(f.doc.source.items.len);
                    try f.doc.setOptions(options);
                },
                .filter => |filter| {
                    options.hook = true;
                    options.hook_filter = filter;
                    fed.add(f.doc.source.items.len);
                    try f.doc.setOptions(options);
                },
            }
            if (try genericProperties(step_arena.allocator(), &f.doc, fed, options, true)) |property| return .{ .property = property, .step = step };
            if (sink.mismatch_count > 0) return .{ .property = "every node shows read_leaf (P5)", .step = step };
            if (command == .math or command == .filter) math_once = .{};
            if (!math_once.check(&f.doc)) return .{ .property = "(c) a math block never reverts to text", .step = step };
        }
        return null;
    }
};

test "Markdown tables: a header line of any length is a header; only a line of 4,096 bytes is held" {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    // One cell scanner for complete and pending rows: an escaped space trims like any space.
    {
        var f: Fixture = undefined;
        try f.init(.{});
        defer f.deinit();
        try f.doc.append("|a|b|\n|-|-|\n| c\\ | d |\n");
        try std.testing.expectEqualStrings("c\\", f.doc.source.items[f.doc.blocks.items[5].content_start_byte..f.doc.blocks.items[5].content_end_byte]);
    }
    for ([_]u32{ markdown.held_line_byte_count_max, markdown.held_line_byte_count_max + 1, 8192 }) |length| {
        // The finished parse is GFM's at any length: cmark-gfm makes these one- and two-column
        // tables (a header with no pipe, and one with a pipe at its second byte).
        const header = try arena.alloc(u8, length);
        @memset(header, 'a');
        const expected = try std.mem.concat(arena, u8, &.{ "<table>\n<thead>\n<tr>\n<th>", header, "</th>\n</tr>\n</thead>\n</table>\n" });
        try std.testing.expectEqualStrings(try html.normalize(arena, expected), try html.normalize(arena, try wholeHtml(arena, "kinds", try std.mem.concat(arena, u8, &.{ header, "\n|-|\n" }))));
        const line = try arena.alloc(u8, length);
        @memset(line, 'x');
        line[1] = '|';
        var whole: Fixture = undefined;
        try whole.init(.{});
        defer whole.deinit();
        try whole.doc.append(try std.mem.concat(arena, u8, &.{ line, "\n|-|-|\n" }));
        try std.testing.expectEqual(markdown.Kind.table, whole.doc.blocks.items[0].kind);
        // Streamed: the pending line shows past its pipe only once it is too long to hold; such a
        // line's frame then changes once, when the delimiter row makes it a header (accepted).
        var f: Fixture = undefined;
        try f.init(.{});
        defer f.deinit();
        var at: usize = 0;
        while (at < line.len) : (at += 30) try f.doc.append(line[at..@min(line.len, at + 30)]);
        const shown = (try f.doc.readLeaf(arena, 0)).bytes.items;
        try std.testing.expectEqual(length > markdown.held_line_byte_count_max, shown.len > 1);
        try f.doc.append("\n|-|-|\n");
        try std.testing.expectEqual(markdown.Kind.table, f.doc.blocks.items[0].kind);
        try std.testing.expect(try streamAgreesParts(arena, "kinds", &.{ line, "\n", "|-|-|\n" }));
    }
}

/// The tear prototype's alphabet for the depth-2 sweep: every soup piece would be 2,000 pairs per
/// option set; these are the pieces its exhaustive search and repros used.
const sweep_pieces = [_][]const u8{ "@\n", "$$_", "$$\n", "&mp;", "&amp;", "\n=\n", "\n===\n", "[x](/u) ", "`", "|", "- ", "> ", "*", "[x]: /u\n", "ses_", "\n" };

test "Markdown sweep: every pair of appends, then finish, under every option set" {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    // GFM (cmark-gfm): a task marker starts the item's paragraph; the rest of its line is that
    // paragraph's text, not another block start (bigboi-1).
    for ([_][2][]const u8{ .{ "- [x] - [x] word\n", "- [x] word" }, .{ "- [x] # hi\n", "# hi" } }) |row| {
        const arena = arena_state.allocator();
        const expected = try std.mem.concat(arena, u8, &.{ "<ul>\n<li><input checked=\"\" disabled=\"\" type=\"checkbox\"> ", row[1], "</li>\n</ul>\n" });
        try std.testing.expectEqualStrings(try html.normalize(arena, expected), try html.normalize(arena, try wholeHtml(arena, "kinds", row[0])));
    }
    // The tear prototype's repros (math on): A aborted in M2 before fd4ab4e19; B and D pass.
    // Then a task marker before more text (M3-a, M2 F9), an escaped backslash that ends an
    // append inside `\(` and a lone one (bigboi-2), a `$` run that ends an append and a span decided after a prefix (bigboi-3, -5), and a held display
    // math line after a fold, when its line ends, after its closer and closing a code span (bigboi-4).
    for ([_][]const []const u8{ &.{ "@\n$$_", "$$\n" }, &.{"&amp;\n===\n"}, &.{ "&amp;", "\n===\n" }, &.{ "- [x] - [x] ", "**" }, &.{ "- [x] ", "- [x] ", "word " }, &.{ "\\(a b\\\\", ")", " now" }, &.{ "a \\(\u{e9} x\\", ")", " now" }, &.{ "$ $$", "$x$" }, &.{ "pay ($2", "$", ")." }, &.{ "some text\n\\[a $b$", " z\\]", "\n" }, &.{ "$$_s_s_ ", "\n" }, &.{ "$$a $b$ c$$", " " }, &.{ "] ```\n$", "$_```- [x]", "(" } }) |parts| {
        try std.testing.expect(try streamAgreesParts(arena_state.allocator(), "math tear", parts));
    }
    // E and F's inputs with the options M1 has (conceal and hyperlinks are M2's).
    for ([_][]const u8{ "&mp;\n=\n", "[x](/u) \n===\n" }) |text| {
        try std.testing.expect(try streamAgreesParts(arena_state.allocator(), "hook tear", &.{text}));
        try std.testing.expect(try streamAgreesParts(arena_state.allocator(), "math tear", try split(arena_state.allocator(), text, 1)));
    }
    // A filter with the hook off latches nothing, a table header's cells included (the model
    // over every option set found the cell latched).
    {
        const options: markdown.Options = .{ .math = true, .hook_filter = "ses_" };
        var f: Fixture = undefined;
        try f.init(options);
        defer f.deinit();
        try f.doc.set("ses_");
        for ([_][]const u8{ "bc | defg", "\n", ":-: |", "-", "\n" }) |part| try f.doc.append(part);
        for (f.doc.blocks.items) |b| try std.testing.expect(!b.flags.hooked);
    }
    for ([_]markdown.Options{ .{}, .{ .math = true }, .{ .hook_filter = "ses_" }, .{ .hook = true, .hook_filter = "ses_" }, .{ .math = true, .hook = true, .hook_filter = "" } }) |options| {
        for (sweep_pieces) |a| for (sweep_pieces) |b| {
            _ = arena_state.reset(.retain_capacity);
            const arena = arena_state.allocator();
            var f: Fixture = undefined;
            try f.init(options);
            defer f.deinit();
            var sink: markdown.TailSink = .{ .allocator = gpa };
            defer sink.deinit();
            f.doc.tail_sink = &sink;
            var fed: Fed = .{};
            for ([_][]const u8{ a, b }) |part| {
                fed.add(part.len);
                try f.doc.append(part);
                var fresh: Fixture = undefined;
                try fresh.init(options);
                defer fresh.deinit();
                try fresh.doc.append(f.doc.source.items);
                const property: ?[]const u8 = if (!try sameDocs(arena, &f.doc, &fresh.doc)) "P1" else if (!try liveShowsReadLeaf(arena, &f.doc, &sink)) "nodes" else try genericProperties(arena, &f.doc, fed, options, true);
                if (property) |name| {
                    std.debug.print("sweep: \"{f}\" then \"{f}\" fails {s}\n", .{ std.zig.fmtString(a), std.zig.fmtString(b), name });
                    return error.SweepFailure;
                }
            }
            try f.doc.finish();
            if (sink.mismatch_count > 0 or !try liveShowsReadLeaf(arena, &f.doc, &sink)) return error.SweepFailure;
        };
    }
}

/// bigboi's prefix differential (round 4) as a row family: documents of mixed fragments, each
/// streamed byte by byte and in 4-byte pieces, every prefix against a fresh doc of the same
/// prefix and every written node against read_leaf (streamAgreesParts). The fragments are the
/// shapes the differential found or exercised: tags and CDATA cut anywhere, entities, split
/// attributes and escapes, titles over lines, pipes in code, nested markers, both display math
/// syntaxes after prose, rows and blank lines, escaped cells, closing hashes, all wrapped in
/// quotes and lists.
const differential_fragments = [_][]const u8{
    "<!A",             "`",               " x &",    "<a b=\"c", "\">",        "<![CDATA[x]]>", "&amp;",   "&#x26",
    "[r](u \"t\nu\")", "[x]: /u '\nt'\n", "`a | b`", "> - 1. ",  "$$E=mc^2$$", "\\[y\\]",       "$$x$$ y", "| a \\| b |",
    "|---|",           "# h #",           "\n",      "\n\n",     "para",       "\\",            "*e*",
};

test "Markdown stream: every prefix of mixed fragments equals a fresh doc of it, nodes included" {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const count: u64 = if (environment(arena_state.allocator(), "MARKDOWN_DIFFERENTIAL")) |t| try std.fmt.parseInt(u64, t, 10) else 48;
    for (0..count) |seed| {
        _ = arena_state.reset(.retain_capacity);
        const arena = arena_state.allocator();
        var prng = std.Random.DefaultPrng.init(seed);
        const random = prng.random();
        var text: std.ArrayListUnmanaged(u8) = .empty;
        const wrap = random.uintLessThan(u32, 4);
        for (0..2 + random.uintLessThan(usize, 6)) |_| {
            const fragment = differential_fragments[random.uintLessThan(usize, differential_fragments.len)];
            if (wrap > 0 and (text.items.len == 0 or text.items[text.items.len - 1] == '\n')) try text.appendSlice(arena, (&[_][]const u8{ "", "> ", "- ", "> - " })[wrap]);
            try text.appendSlice(arena, fragment);
        }
        // Math on for every other document (the name selects the options).
        const name = if (seed % 2 == 0) "math differential" else "differential";
        for ([_]usize{ 1, 4 }) |width| {
            if (!try streamAgreesParts(arena, name, try split(arena, text.items, width))) {
                std.debug.print("differential seed {d}, width {d}: \"{f}\"\n", .{ seed, width, std.zig.fmtString(text.items) });
                return error.StreamMismatch;
            }
        }
    }
}

test "Markdown model: repeated constructs keep work linear, stores within limits and the pending layout exact" {
    var families: Families = .{};
    try model.check(Families, &families, .{ .seeds = 8, .steps = 0 });
}

/// B's last two exceptions to P7, taken before a step: a backtick opener drawn as a code span
/// (or, with math, inline math that closes and shows its content raw)
/// that never closes reverts to text (its content's escapes and entities then decode), and a
/// definition that arrives turns `[a][b]` into `a`. The check skips a step that starts with an
/// open prose leaf holding a backtick, and a step that adds a definition.
const P7Exempt = struct {
    code_drawn: bool,
    definition_count: usize,
    line_start: u32,

    /// Also exempt (D102): a line shown as text or a row that starts a display math block when
    /// its line ends (it switches once, and never back).
    fn exempt(self: P7Exempt, doc: *const Doc) bool {
        for (doc.blocks.items) |b| {
            if (b.kind == .code and b.flags.math and b.source_start_byte >= self.line_start) return true;
        }
        return self.code_drawn or doc.definitions.items.len != self.definition_count;
    }
};

fn p7Exempt(doc: *const Doc) P7Exempt {
    var code_drawn = false;
    for (doc.blocks.items) |b| {
        const prose = b.kind == .paragraph or b.kind == .heading or b.kind == .table_cell;
        if (!prose or !(b.flags.open or b.source_end_byte > doc.line_start_byte)) continue;
        const source = doc.source.items[b.source_start_byte..@min(doc.source.items.len, b.source_end_byte)];
        if (std.mem.indexOfScalar(u8, source, '`') != null) code_drawn = true;
        // Inline math that closes shows its content raw (entities and escapes undecoded): the
        // same exception as a code span's (the model over every option set found it).
        if (doc.options.math and (std.mem.indexOfScalar(u8, source, '$') != null or std.mem.indexOf(u8, source, "\\(") != null)) code_drawn = true;
    }
    return .{ .code_drawn = code_drawn, .definition_count = doc.definitions.items.len, .line_start = doc.line_start_byte };
}

/// Whether every non-white-space byte `previous` drew is in `next`, in order (P7). B's
/// exceptions are left out of both: link brackets and an image's `!` (concealed when the link
/// resolves) and math delimiters (`$`, and with math on `\(` and `\)`, concealed when math
/// closes).
fn framesGrow(previous: []const u8, next: []const u8, math: bool) bool {
    var at: usize = 0;
    for (previous, 0..) |c, i| {
        if (frameIgnored(previous, i, math)) continue;
        while (at < next.len and next[at] != c) at += 1;
        if (at == next.len) return false;
        at += 1;
    }
    return true;
}

fn frameIgnored(s: []const u8, i: usize, math: bool) bool {
    return switch (s[i]) {
        ' ', '\t', '\n', '[', ']', '!', '$' => true,
        // With math on, `\(` and `\)` are math delimiters (B draws them as escapes, `(` and
        // `)`, until the span closes).
        '(', ')' => math,
        else => false,
    };
}

/// A prose leaf's read_leaf bytes and URLs, as a host keeps them.
fn leafOutput(arena: std.mem.Allocator, doc: *const Doc, index: u32) ![]const u8 {
    const leaf = try doc.readLeaf(arena, index);
    var out: std.ArrayListUnmanaged(u8) = .empty;
    try out.appendSlice(arena, leaf.bytes.items);
    try out.append(arena, 0);
    try out.appendSlice(arena, leaf.urls.items);
    // Each chunk's record: which bytes, how styled, which target.
    for (leaf.chunks.items) |chunk| try out.print(arena, "|{d},{d},{d},{d},{d}", .{ chunk.byte_count, @as(u16, @bitCast(chunk.scope)), @as(u32, @bitCast(chunk.span)), chunk.link_offset, chunk.link_byte_count });
    return out.items;
}

/// `source` with `/u` and `/w` swapped.
fn swapTargets(arena: std.mem.Allocator, source: []const u8) ![]const u8 {
    const copy = try arena.dupe(u8, source);
    for (copy[0..copy.len -| 1], 0..) |c, i| {
        if (c != '/') continue;
        if (copy[i + 1] == 'u') {
            copy[i + 1] = 'w';
        } else if (copy[i + 1] == 'w') {
            copy[i + 1] = 'u';
        }
    }
    return copy;
}

/// The fields a host sees (internal bits excluded).
fn sameRecord(a: markdown.Block, b: markdown.Block) bool {
    var fa = a.flags;
    var fb = b.flags;
    inline for (.{"unreported"}) |name| {
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
    try model.check(Engine, &engine, .{ .seeds = 64, .steps = 64 });
    // An empty filter hooks every prose leaf.
    var hook_all: Engine = .{ .corpus_texts = engine.corpus_texts, .filter = "", .other_filter = "ses_" };
    try model.check(Engine, &hook_all, .{ .seeds = 16, .steps = 64 });
    // The other option sets: the hook off and math on from the start (set_options switches
    // math and the filter mid-stream in every run).
    var plain_math: Engine = .{ .corpus_texts = engine.corpus_texts, .hook = false, .math = true };
    try model.check(Engine, &plain_math, .{ .seeds = 16, .steps = 64 });
}

test "Markdown model: corpus rows split at random code points stream like one append" {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const corpus = try std.json.parseFromSliceLeaky(std.json.Value, arena, @embedFile("markdown_conformance"), .{});
    // Opt in (not in the CI budget): MARKDOWN_SPLITS=<n>.
    const seeds: u64 = if (model.environment(arena, "MARKDOWN_SPLITS")) |t| try std.fmt.parseInt(u64, t, 10) else 0;
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
    // A pending row reads the leaf while the stream is still open.
    const Row = struct { source: []const u8, math: bool = false, pending: bool = false, block: u32, chunks: []const struct { []const u8, []const u8, []const u8 } };
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
        // An image inside a link keeps the link's target, its autolinks and emails too (M3-b).
        .{ .source = "[![<https://e.co> a@b.co](https://e/image) docs](https://e/outer)", .block = 0, .chunks = &.{.{ "https://e.co a@b.co docs", "link", "https://e/outer" }} },
        // A math span the held pipe cuts shows as B drew it, literal (opus-2).
        .{ .source = "\\(a|b\\) c", .math = true, .pending = true, .block = 0, .chunks = &.{.{ "(a", "", "" }} },
        // A word is tokenized once white space follows it (M3-d).
        .{ .source = "See [Updated](https://target)\n", .pending = true, .block = 0, .chunks = &.{ .{ "See ", "", "" }, .{ "Updated", "link", "https://target" } } },
        // A `$` span that starts the last word shows once the byte after it decides it (bigboi-3).
        .{ .source = "see $x$.", .math = true, .pending = true, .block = 0, .chunks = &.{ .{ "see ", "", "" }, .{ "x", "math", "" }, .{ ".", "", "" } } },
        // ... after a decided prefix, each span (bigboi-5; a digit inside the TeX is not after it).
        .{ .source = "pay ($2$).", .math = true, .pending = true, .block = 0, .chunks = &.{ .{ "pay (", "", "" }, .{ "2", "math", "" }, .{ ").", "", "" } } },
        .{ .source = "A $x$!$y$.", .math = true, .pending = true, .block = 0, .chunks = &.{ .{ "A ", "", "" }, .{ "x", "math", "" }, .{ "!", "", "" }, .{ "y", "math", "" }, .{ ".", "", "" } } },
        // A line that may still be a one-line display math block shows literal, the first or a
        // later one, until a byte after its closer rules that out (bigboi-4).
        .{ .source = "\\[b $c$ d\\]", .math = true, .pending = true, .block = 0, .chunks = &.{.{ "[b $c$ d]", "", "" }} },
        .{ .source = "a\n\\[b $c$ d\\]", .math = true, .pending = true, .block = 0, .chunks = &.{.{ "a\n[b $c$ d]", "", "" }} },
        .{ .source = "$$$$ $c$ d", .math = true, .pending = true, .block = 0, .chunks = &.{ .{ "$$$$ ", "", "" }, .{ "c", "math", "" }, .{ " d", "", "" } } },
        // A `$$` closer may take one more `$` (the body ends in it); no span from an earlier line
        // reads into the held line; a heading cannot become a block, so it is not held (bigboi-3).
        .{ .source = "$$cost$ $b$ z$$$", .math = true, .pending = true, .block = 0, .chunks = &.{.{ "$$cost$ $b$ z$$$", "", "" }} },
        .{ .source = "a $x\n\\[a$ b\\]", .math = true, .pending = true, .block = 0, .chunks = &.{.{ "a $x\n[a$ b]", "", "" }} },
        .{ .source = "# \\[x $b$ y", .math = true, .pending = true, .block = 0, .chunks = &.{ .{ "[", "heading escape", "" }, .{ "x ", "heading", "" }, .{ "b", "headingmath", "" }, .{ " y", "heading", "" } } },
    };
    for (rows) |row| {
        var f: Fixture = undefined;
        try f.init(.{ .math = row.math });
        defer f.deinit();
        try f.doc.append(row.source);
        if (!row.pending) try f.doc.finish();
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
    // tail writes still rebuild the leaf's display. With a held pipe before them too (bigboi
    // round 2: the hold kept every token), a definition title that holds them (round 3: tokens
    // were built while the title was open) and a pipe in a code span before them (round 3: the
    // hold pinned every later token). After a 70,000-byte word the content copy outgrows 64 KiB,
    // so a retire clamps its capacity (round 3: the clamp asked for more bytes than it held).
    const long_word = try arena.alloc(u8, 70000);
    @memset(long_word, 'x');
    const clamp_prefix = try std.mem.concat(arena, u8, &.{ "*", long_word, " " });
    for ([_]struct { []const u8, usize }{ .{ "", 6000 }, .{ "text | ", 6000 }, .{ "[x]: /u '", 6000 }, .{ "text `a | b` ", 6000 }, .{ clamp_prefix, 6000 } }) |row| {
        const prefix = row[0];
        var f: Fixture = undefined;
        try f.init(.{});
        defer f.deinit();
        var sink: markdown.TailSink = .{ .allocator = gpa };
        defer sink.deinit();
        f.doc.tail_sink = &sink;
        const bound = 2 * inline_parser.token_count_max + 64;
        var high: usize = 0;
        try f.doc.append(prefix);
        for (0..row[1]) |n| {
            try f.doc.append(if (n % 2 == 0) "*a " else "[b ");
            const p = &f.doc.live.parser;
            high = @max(high, p.tokens.items.len);
            try std.testing.expect(p.tokens.items.len <= bound and p.tokens.capacity <= 2 * bound);
            try std.testing.expect(p.delimiters.items.len <= bound and p.delimiters.capacity <= 2 * bound);
            try std.testing.expect(p.matches.items.len <= bound and p.brackets.items.len <= inline_parser.bracket_count_max);
            try std.testing.expect(f.doc.live.display_ends.items.len <= bound and f.doc.live.display_ends.capacity <= 2 * bound);
            try std.testing.expect(f.doc.live.content.items.len <= 8 * bound + prefix.len);
        }
        // A possible definition builds no tokens.
        if (prefix.len == 0 or prefix[0] != '[') try std.testing.expect(high > inline_parser.token_count_max);
        try std.testing.expect(try liveShowsReadLeaf(arena, &f.doc, &sink));
        try f.doc.finish();
        try std.testing.expectEqual(@as(u32, 0), sink.mismatch_count);
        try std.testing.expect(try liveShowsReadLeaf(arena, &f.doc, &sink));
    }
    // Filter: at most 256 bytes of items of 1 to 64 bytes.
    {
        var scratch = std.heap.ArenaAllocator.init(gpa);
        defer scratch.deinit();
        const long_item = repeat("x", 65);
        try std.testing.expectError(error.InvalidOptions, Doc.init(gpa, &scratch, .{ .hook = true, .hook_filter = long_item }));
        try std.testing.expectError(error.InvalidOptions, Doc.init(gpa, &scratch, .{ .hook = true, .hook_filter = "a\x00\x00b" }));
        // At most 16 items.
        try std.testing.expectError(error.InvalidOptions, Doc.init(gpa, &scratch, .{ .hook = true, .hook_filter = repeat("a\x00", 16) ++ "b" }));
        var at_limit = try Doc.init(gpa, &scratch, .{ .hook = true, .hook_filter = repeat("a\x00", 15) ++ "b" });
        at_limit.deinit();
        const items = repeat("x" ++ repeat("x", 62) ++ "\x00", 4) ++ "y";
        try std.testing.expectError(error.InvalidOptions, Doc.init(gpa, &scratch, .{ .hook = true, .hook_filter = items }));
        var doc = try Doc.init(gpa, &scratch, .{ .hook = true, .hook_filter = items[0 .. items.len - 2] });
        doc.deinit();
        // Exactly 64 and 256 bytes are accepted and match; the doc keeps its own copy of the
        // filter, so the caller's buffer may change after the call.
        const pool = repeat("q", 64) ++ "\x00" ++ repeat("r", 64) ++ "\x00" ++ repeat("s", 64) ++ "\x00" ++ repeat("k", 61);
        comptime std.debug.assert(pool.len == 256);
        var buffer: [256]u8 = pool.*;
        var f: Fixture = undefined;
        try f.init(.{ .hook = true, .hook_filter = &buffer });
        defer f.deinit();
        @memset(&buffer, 'w');
        try f.doc.append("a " ++ repeat("q", 64) ++ "\n\n" ++ repeat("k", 61) ++ "\n\nw\n\n");
        try f.doc.finish();
        const hooked = [_]bool{ f.doc.blocks.items[0].flags.hooked, f.doc.blocks.items[1].flags.hooked, f.doc.blocks.items[2].flags.hooked };
        try std.testing.expectEqual([3]bool{ true, true, false }, hooked);
    }
    // Options: a rejected set_options changes nothing (blocks, finished, options, changes).
    {
        var f: Fixture = undefined;
        try f.init(.{});
        defer f.deinit();
        try f.doc.append("# one\n\nsecond");
        try f.doc.finish();
        var out: [4]Doc.Change = undefined;
        _ = f.doc.readChanges(&out);
        const blocks = try arena.dupe(markdown.Block, f.doc.blocks.items);
        try std.testing.expectError(error.BlockLimit, f.doc.setOptions(.{ .limits = .{ .block_count = 1 } }));
        try expectUnchanged("# one\n\nsecond", blocks, &f.doc);
        try std.testing.expect(f.doc.finished);
        try std.testing.expectEqual(markdown.block_count_max, f.doc.options.limits.block_count);
        try std.testing.expectEqual(@as(u32, 0), f.doc.readChanges(&out).count);
        var g: Fixture = undefined;
        try g.init(.{ .limits = .{ .block_count = 1 } });
        defer g.deinit();
        try g.doc.append("x\n$$");
        try g.doc.finish();
        try std.testing.expectError(error.BlockLimit, g.doc.setOptions(.{ .math = true, .limits = .{ .block_count = 1 } }));
        try std.testing.expect(g.doc.finished and !g.doc.options.math);
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

const Work = struct { byte_count: usize, append_count: usize, counters: markdown.Counters, hooked: bool, held_max: usize };

/// Streams `parts` into a fresh doc (with finish) and returns its work counters and the most
/// content the live leaf held after an append.
fn work(options: markdown.Options, parts: []const []const u8) !Work {
    var f: Fixture = undefined;
    try f.init(options);
    defer f.deinit();
    var byte_count: usize = 0;
    var held_max: usize = 0;
    for (parts) |part| {
        try f.doc.append(part);
        byte_count += part.len;
        held_max = @max(held_max, f.doc.live.content.items.len);
    }
    try f.doc.finish();
    var hooked = false;
    for (f.doc.blocks.items) |b| hooked = hooked or b.flags.hooked;
    return .{ .byte_count = byte_count, .append_count = parts.len, .counters = f.doc.counters, .hooked = hooked, .held_max = held_max };
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
    // bigboi's rows (round 2): one 64 KiB word; a pipe between two words; a line of digits; a
    // held pipe before openers that never close; 128-column table rows; varied backtick runs.
    const word = try arena.alloc(u8, 65536);
    @memset(word, 'w');
    const piped = try std.mem.concat(arena, u8, &.{ xs[0..1024], "|", xs[0..1024] });
    const digits = try arena.alloc(u8, 8192);
    @memset(digits, '7');
    // A held line: its decision is kept while the bytes that keep it arrive.
    const dashes = try arena.alloc(u8, 8192);
    @memset(dashes, '-');
    const held_openers = try std.mem.concat(arena, u8, &.{ "text | ", openers.items });
    var table: std.ArrayListUnmanaged(u8) = .empty;
    for ([_][]const u8{ "a", "-", "b", "c" }) |cell| {
        try table.append(arena, '|');
        for (0..128) |_| try table.appendSlice(arena, try std.mem.concat(arena, u8, &.{ cell, "|" }));
        try table.append(arena, '\n');
    }
    var runs: std.ArrayListUnmanaged(u8) = .empty;
    for (1..32) |k| {
        for (0..k) |_| try runs.append(arena, '`');
        try runs.appendSlice(arena, "x ");
    }
    // bigboi's rows (round 3): a title over 1,024 lines; 30 quotes and a 2,048-byte pending
    // continuation; one open `*` before 1,024 words; a 64 KiB heading and two-column table;
    // 64-byte cells in 128 columns; a long code span with a pipe; a long HTML comment.
    var title: std.ArrayListUnmanaged(u8) = .empty;
    try title.appendSlice(arena, "[x]: /u '");
    for (0..1024) |_| try title.appendSlice(arena, "bb\n");
    try title.appendSlice(arena, "'\n[x]\n");
    var quotes: std.ArrayListUnmanaged(u8) = .empty;
    for (0..30) |_| try quotes.appendSlice(arena, "> ");
    try quotes.appendSlice(arena, "a\n");
    for (0..1024) |_| try quotes.appendSlice(arena, "w ");
    var emphasis: std.ArrayListUnmanaged(u8) = .empty;
    try emphasis.append(arena, '*');
    for (0..1024) |_| try emphasis.appendSlice(arena, "ab ");
    try emphasis.appendSlice(arena, "end");
    const heading = try std.mem.concat(arena, u8, &.{ "# ", word[0..65534] });
    var two_columns: std.ArrayListUnmanaged(u8) = .empty;
    try two_columns.appendSlice(arena, "|a|b|\n|-|-|\n|");
    try two_columns.appendSlice(arena, word[0 .. 65536 - 13]);
    var wide: std.ArrayListUnmanaged(u8) = .empty;
    for ([_][]const u8{ "a", "-" }) |cell| {
        for (0..128) |_| try wide.appendSlice(arena, try std.mem.concat(arena, u8, &.{ "|", cell }));
        try wide.appendSlice(arena, "|\n");
    }
    for (0..128) |_| try wide.appendSlice(arena, try std.mem.concat(arena, u8, &.{ "|", xs[0..64] }));
    const code_pipe = try std.mem.concat(arena, u8, &.{ "x `", xs[0..1500], " | b` ", line[0..2000] });
    const comment = try std.mem.concat(arena, u8, &.{ "x <!--", line[0..4096] });
    // An open code span over lines with a pipe in each (each line's hold cut is drawn on from
    // the last); lines of nested block markers (a held line reads on from its last marker).
    var open_code: std.ArrayListUnmanaged(u8) = .empty;
    try open_code.appendSlice(arena, "x `");
    for (0..512) |_| try open_code.appendSlice(arena, "a | c\n");
    var markers: std.ArrayListUnmanaged(u8) = .empty;
    for (0..64) |_| {
        for (0..30) |_| try markers.appendSlice(arena, "> 1. ");
        try markers.appendSlice(arena, "x\n");
    }
    // opus round 4: f4-12's shrunk trace (a code span over lines with pipes, closed at the end).
    // Eight times, so the per-document constant does not hide the per-byte factor.
    const code_trace = [_][]const u8{ "x ` |a\na|| a ", " |a\na aa\naa|a\na a|a\na|a\na|", "a a|| aa ", "|a| aaa a\n| aaaa|aa\na\naaa|", " |a\n a\naa\n aa a\na\na\na a aaa", "| aa\n|| |a\n|a\naa\naa\n|", "|  |aa a\na|a|", "|a  || a\naa |aaa` |||c", "\n\n" };
    const code_lines = try std.mem.concat(arena, []const u8, &.{ &code_trace, &code_trace, &code_trace, &code_trace, &code_trace, &code_trace, &code_trace, &code_trace });
    const verbose = environment(arena, "MARKDOWN_GATES") != null;
    const Row = struct {
        name: []const u8,
        options: markdown.Options = .{},
        parts: []const []const u8,
        block_factor: u64 = 2,
        inline_factor: u64 = 2,
        /// Display visits: a pending word is drawn, then compared with its tokens' display
        /// (assembled once) when the word ends; the fixtures stay within 2x.
        display_factor: u64 = 3,
        /// Sent bytes: an opener drawn as closed (B) that never closes is drawn again, literal,
        /// when its leaf closes (the design's gate: at most 2x on this row).
        sent_factor: u64 = 1,
        /// Display bytes copied into buffers (tail writes, comparisons, holds): at most 2x.
        assembled_factor: u64 = 2,
        /// The live leaf's content copy after any append, where settled words fold away.
        held_max: u64 = std.math.maxInt(u64),
    };
    const rows = [_]Row{
        .{ .name = "list.md, 30-byte appends", .parts = try split(arena, try fixture(arena, "fixture list"), 30), .display_factor = 2 },
        .{ .name = "prose.md, 30-byte appends", .parts = try split(arena, try fixture(arena, "fixture prose"), 30), .display_factor = 2 },
        .{ .name = "an 8,192-byte line, 1-byte appends", .parts = try split(arena, line, 1) },
        // A line that may become a display math block is held whole, drawn by B and parsed at
        // finish: the worst per-byte series of the review round (512 to 16,384 bytes: inline 2.0,
        // display 3.2, assembled 1.0 a byte; the copy holds the line).
        .{ .name = "a held display math line, 3-byte appends", .options = .{ .math = true }, .parts = try split(arena, try std.mem.concat(arena, u8, &.{ "$$", line[0..4096] }), 3), .display_factor = 4, .held_max = 4098 },
        // Settled words fold away at word ends too (bigboi-2: the copy kept the whole paragraph).
        .{ .name = "an 8,192-byte line, word-sized appends", .parts = try split(arena, line, 5), .held_max = 16 },
        .{ .name = "some **x + 8,192 one-byte appends", .parts = try std.mem.concat(arena, []const u8, &.{ &.{"some **x"}, try split(arena, xs, 1) }), .sent_factor = 2 },
        .{ .name = "a stray backtick, 1-byte appends", .parts = try std.mem.concat(arena, []const u8, &.{ &.{"a `b "}, try split(arena, line, 1) }), .sent_factor = 2 },
        .{ .name = "a pending line of spaces, 1-byte appends", .parts = try std.mem.concat(arena, []const u8, &.{ &.{"text\n"}, try split(arena, spaces, 1), &.{"x\n"} }) },
        .{ .name = "a growing reference label, 1-byte appends", .parts = try split(arena, label.items, 1) },
        // B's holds read on where they stopped: trailing spaces, an entity, an autolink and a
        // code span's trailing spaces that stay undecided for 4,096 bytes. A hold that resolves
        // as text draws its bytes once more (display 4x on those rows).
        .{ .name = "spaces inside a paragraph, 1-byte appends", .parts = try std.mem.concat(arena, []const u8, &.{ &.{"a"}, try split(arena, spaces, 1), &.{"b\n"} }) },
        .{ .name = "a long unfinished entity, 1-byte appends", .parts = try std.mem.concat(arena, []const u8, &.{ &.{"&"}, try split(arena, xs[0..4096], 1), &.{";\n"} }), .display_factor = 4 },
        .{ .name = "a long unfinished autolink, 1-byte appends", .parts = try std.mem.concat(arena, []const u8, &.{ &.{"a <"}, try split(arena, xs[0..4096], 1), &.{">\n"} }), .display_factor = 4 },
        .{ .name = "spaces in a code span, 1-byte appends", .parts = try std.mem.concat(arena, []const u8, &.{ &.{"`a"}, try split(arena, spaces, 1), &.{"`\n"} }) },
        // The leaf's close writes it again from a whole parse (expired openers show literal).
        .{ .name = "openers that never close, 3-byte appends", .parts = try split(arena, openers.items, 3), .display_factor = 4, .sent_factor = 2 },
        .{ .name = "a 64 KiB word, 1-byte appends", .parts = try split(arena, word, 1) },
        .{ .name = "a 64 KiB word, 30-byte appends", .parts = try split(arena, word, 30) },
        // The cut at a held pipe is drawn once more when the pipe arrives.
        .{ .name = "a pipe between two words, 1-byte appends", .parts = try split(arena, piped, 1), .display_factor = 4 },
        .{ .name = "8,192 digits, 1-byte appends", .parts = try split(arena, digits, 1) },
        .{ .name = "8,192 digits, 30-byte appends", .parts = try split(arena, digits, 30) },
        .{ .name = "8,192 dashes, 1-byte appends", .parts = try split(arena, dashes, 1) },
        .{ .name = "a held pipe before openers that never close, 30-byte appends", .parts = try split(arena, held_openers, 30), .display_factor = 4, .sent_factor = 2 },
        .{ .name = "128-column table rows, 1-byte appends", .parts = try split(arena, table.items, 1) },
        // No run closes: each opener drawn as a code span reverts when the leaf closes.
        .{ .name = "31 different backtick runs, 1-byte appends", .parts = try split(arena, runs.items, 1), .sent_factor = 2 },
        // A title line is read by the layout, the line, the pipe scan and the title scan.
        .{ .name = "a title over 1,024 lines, 1-byte appends", .parts = try split(arena, title.items, 1), .block_factor = 4 },
        .{ .name = "a title over 1,024 lines, 30-byte appends", .parts = try split(arena, title.items, 30), .block_factor = 4 },
        .{ .name = "30 quotes and a pending continuation, 1-byte appends", .parts = try split(arena, quotes.items, 1) },
        // The opener drawn as closed never closes: the leaf is written again, literal, at finish.
        .{ .name = "an open * before 1,024 words, 1-byte appends", .parts = try split(arena, emphasis.items, 1), .sent_factor = 2 },
        .{ .name = "a 64 KiB heading, 1-byte appends", .parts = try split(arena, heading, 1) },
        .{ .name = "a 64 KiB two-column row, 1-byte appends", .parts = try split(arena, two_columns.items, 1) },
        .{ .name = "128 columns of 64-byte cells, 1-byte appends", .parts = try split(arena, wide.items, 1) },
        // The words after a cut inside a code span are drawn pending and compared, not shown;
        // the span is written again whole when the hold ends.
        .{ .name = "a long code span with a pipe, then words, 1-byte appends", .parts = try split(arena, code_pipe, 1), .display_factor = 6, .assembled_factor = 4, .sent_factor = 2 },
        // The end marker's search reads its last two bytes again per append.
        .{ .name = "a long unfinished HTML comment, 1-byte appends", .parts = try split(arena, comment, 1), .inline_factor = 4, .display_factor = 4 },
        // The span never closes: the leaf is written again, literal, at finish.
        .{ .name = "an open code span over lines with pipes, 1-byte appends", .parts = try split(arena, open_code.items, 1), .sent_factor = 2, .assembled_factor = 3 },
        .{ .name = "lines of 30 nested markers, 1-byte appends", .parts = try split(arena, markers.items, 1) },
        // A closed code span's display is assembled once per feed, whatever reads it (the hold's
        // cut, the comparison and the tail write); finish writes the leaf again.
        .{ .name = "a code span over lines with pipes, closed (8 appends, 8 times)", .parts = code_lines, .assembled_factor = 5, .sent_factor = 3, .display_factor = 3 },
        // A 64-byte filter, and 16 items (the limit; bigboi round 5: the bound left out the item
        // count): each item reads the new bytes and the overlap.
        .{ .name = "a 64-byte filter, 1-byte appends", .options = .{ .hook = true, .hook_filter = "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq" }, .parts = try split(arena, try std.mem.concat(arena, u8, &.{ xs[0..1024], "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq" }), 1) },
        // An inline link's title over 1,024 words, resumed (bigboi round 4: 2.1M inline visits).
        .{ .name = "16 filter items, 1-byte appends", .options = .{ .hook = true, .hook_filter = "q\x00r\x00s\x00t\x00u\x00v\x00w\x00x\x00y\x00z\x00b\x00c\x00d\x00e\x00f\x00g" }, .parts = try split(arena, try std.mem.concat(arena, u8, &.{ digits[0..1024], " g" }), 1) },
        // bigboi round 6: a match early on a long line, which then completes (32,816 visits; the
        // bound without the completing pass allowed 16,408).
        .{ .name = "16 filter items, an early match, then the line ends", .options = .{ .hook = true, .hook_filter = "a\x00b\x00c\x00d\x00e\x00f\x00g\x00h\x00i\x00j\x00k\x00l\x00m\x00n\x00o\x00w" }, .parts = try std.mem.concat(arena, []const u8, &.{ try split(arena, word[0..1024], 1), &.{"\n"} }) },
        .{ .name = "an inline link title, 1-byte appends", .parts = try split(arena, try std.mem.concat(arena, u8, &.{ "> see [ref](url \"", line[0..2048], "\") done" }), 1) },
        // ... and 1,024 spaces between the closed title and its `)` (bigboi round 5: 661,783
        // inline visits at half this length).
        .{ .name = "an inline link title, then spaces, 1-byte appends", .parts = try split(arena, try std.mem.concat(arena, u8, &.{ "> p [r](u \"", line[0..2048], "t\"", spaces[0..1024], ") next" }), 1) },
        .{ .name = "se + s_ with the filter", .options = .{ .hook = true, .hook_filter = "ses_" }, .parts = &.{ "see se", "s_abc now\n" } },
    };
    var over = false;
    for (rows) |row| {
        const w = try work(row.options, row.parts);
        const c = w.counters;
        const n = w.byte_count;
        if (verbose) std.debug.print("{s}: {d} bytes in {d} appends; line {d}, block {d}, hook {d}, inline {d}, display {d}, assembled {d}, sent {d}\n", .{ row.name, n, w.append_count, c.line_byte_visits, c.block_byte_visits, c.hook_byte_visits, c.inline_byte_visits, c.display_byte_visits, c.display_assembled_bytes, c.tail_write_bytes });
        // Each counter, where its bytes are read: the line scanner reads each byte once (and the
        // last byte again per append, a pending carriage return); the filter search reads new
        // bytes plus its overlap per append.
        const bounds = [_]struct { []const u8, u64, u64 }{
            .{ "line", c.line_byte_visits, n + w.append_count + 1 },
            // A pending line's first byte is read again per append (its kind, its layout).
            .{ "block", c.block_byte_visits, row.block_factor * n + 4 * w.append_count + 64 },
            // Each item reads the new bytes and the filter's overlap (its longest item less one),
            // and a line that held a pending match once more from it when the line completes (its
            // layout may then put the match in other leaves): items x (2(n + 1) + overlap x
            // appends) + 8, the design's bound.
            .{ "hook", c.hook_byte_visits, filterItems(row.options) * (2 * (n + 1) + filterOverlap(row.options) * w.append_count) + 8 },
            .{ "inline", c.inline_byte_visits, row.inline_factor * n + 64 },
            .{ "display", c.display_byte_visits, row.display_factor * n + 64 },
            .{ "sent", c.tail_write_bytes, row.sent_factor * n + 64 },
            .{ "assembled", c.display_assembled_bytes, row.assembled_factor * n + 64 },
            .{ "held", w.held_max, row.held_max },
        };
        for (bounds) |bound| {
            if (bound[1] <= bound[2]) continue;
            std.debug.print("{s}: {s} counter {d} above {d}\n", .{ row.name, bound[0], bound[1], bound[2] });
            over = true;
        }
        if (row.options.hook) try std.testing.expect(w.hooked);
    }
    try std.testing.expect(!over);
    // Each counter counts: a small document's exact work.
    const small = try work(.{}, &.{ "ab *c", "d* e\n" });
    // Each byte once, and the first append's last byte again (it may be a carriage return).
    try std.testing.expectEqual(@as(u64, 11), small.counters.line_byte_visits);
    try std.testing.expect(small.counters.inline_byte_visits >= 9);
    try std.testing.expect(small.counters.block_byte_visits >= 2);
    // "ab c" (the opener drawn as closed), then "d e": each display byte sent once.
    try std.testing.expectEqual(@as(u64, 7), small.counters.tail_write_bytes);
}

/// Counts the allocator calls that obtain memory: an alloc, or a resize or remap that succeeded.
/// A growth is one such call whether it grows in place (Linux) or falls back to alloc and copy
/// (macOS, Windows), so the count does not depend on the backing allocator.
const CountingAllocator = struct {
    backing: std.mem.Allocator,
    count: u64 = 0,
    /// False: resize and remap never succeed (the fallback macOS and Windows take).
    in_place: bool = true,

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
        if (!self.in_place or !self.backing.rawResize(memory, alignment, len, ret)) return false;
        self.count += 1;
        return true;
    }

    fn remap(context: *anyopaque, memory: []u8, alignment: std.mem.Alignment, len: usize, ret: usize) ?[*]u8 {
        const self: *CountingAllocator = @ptrCast(@alignCast(context));
        if (!self.in_place) return null;
        const moved = self.backing.rawRemap(memory, alignment, len, ret) orelse return null;
        self.count += 1;
        return moved;
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
    const parts = try split(arena, long, 30);
    const warm_up = parts.len / 2;
    // With an allocator that grows in place and with one that never does.
    for ([_]bool{ true, false }) |in_place| {
        var counting: CountingAllocator = .{ .backing = gpa, .in_place = in_place };
        var scratch = std.heap.ArenaAllocator.init(counting.allocator());
        defer scratch.deinit();
        var doc = try Doc.init(counting.allocator(), &scratch, .{});
        defer doc.deinit();
        for (parts[0..warm_up]) |part| try doc.append(part);
        const calls_before = counting.count;
        const growth_before = doc.counters.capacity_growth_count;
        for (parts[warm_up..]) |part| try doc.append(part);
        const calls = counting.count - calls_before;
        const growth = doc.counters.capacity_growth_count - growth_before;
        if (environment(arena, "MARKDOWN_GATES") != null) std.debug.print("steady state, in place {}: {d} appends, {d} allocations, {d} capacity growths\n", .{ in_place, parts.len - warm_up, calls, growth });
        try std.testing.expect(calls <= growth);
    }
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
        "a\\\nb\n",
        "[x]: /\n---",
        "[x]: /u\n'a\nb'\n[x]\n",
    };
    for (rows) |text| {
        try std.testing.expect(try streamAgreesParts(arena, "kinds", try split(arena, text, 1)));
        try std.testing.expect(try streamAgreesParts(arena, "kinds", try split(arena, text, 3)));
    }
    // An open math span leaves a backslash before a line break untokenized: B draws the break.
    try std.testing.expect(try streamAgreesParts(arena, "math kinds", try split(arena, "x $\\\n]", 1)));
    // opus-7: the live leaf leaves a paragraph the pending line ends; that paragraph's node
    // gets its final display (every node is checked against read_leaf after each append).
    try std.testing.expect(try streamAgreesParts(arena, "kinds", &.{ "- 2*3 = 6\n", "- next", "\n" }));
    try std.testing.expect(try streamAgreesParts(arena, "kinds", &.{ "- run `ls | grep x` now\n", "- next", "\n" }));
    try std.testing.expect(try streamAgreesParts(arena, "kinds", &.{ "- next\n", "Para with a | pipe\n", "# Heading", "\n" }));
    // opus-9: a cell of the pending row that shows a filter match is hooked in that frame.
    {
        var f: Fixture = undefined;
        try f.init(.{ .hook = true, .hook_filter = "ses_" });
        defer f.deinit();
        for ([_][]const u8{ "| a | b |\n| --- | --- |\n", "| ses", "_1 | x |" }) |part| try f.doc.append(part);
        var hooked: [2]bool = undefined;
        var n: usize = 0;
        for (f.doc.blocks.items) |b| {
            if (b.kind != .table_cell or !b.flags.open) continue;
            hooked[n] = b.flags.hooked;
            n += 1;
        }
        try std.testing.expectEqual(@as(usize, 2), n);
        try std.testing.expectEqual([2]bool{ true, false }, hooked);
    }
    // bigboi round 2: closing a code span takes back no drawn space (its leading space is not
    // drawn while it may be stripped): each display starts with the one before.
    {
        var f: Fixture = undefined;
        try f.init(.{});
        defer f.deinit();
        var previous: []const u8 = "";
        for ([_][]const u8{ "z `", " foo", " `", " end" }) |part| {
            try f.doc.append(part);
            const shown = try arena.dupe(u8, (try f.doc.readLeaf(arena, 0)).bytes.items);
            try std.testing.expect(std.mem.startsWith(u8, shown, previous));
            previous = shown;
        }
        try std.testing.expectEqualStrings("z foo end", previous);
    }
    // opus-8, bigboi: a paragraph after its definitions shows once a line decides them.
    for ([_]struct { []const []const u8, []const u8 }{
        .{ &.{ "[k]: /u\n", "normal\n" }, "normal" },
        .{ &.{ "intro\n\n[x]: /u\n", "more text", " that goes on\n", "and on" }, "more text that goes on\nand on" },
        .{ &.{ "[Note]: this is not a definition\n", "more\n" }, "[Note]: this is not a definition\nmore" },
    }) |row| {
        var f: Fixture = undefined;
        try f.init(.{});
        defer f.deinit();
        for (row[0]) |part| try f.doc.append(part);
        const last: u32 = @intCast(f.doc.blocks.items.len - 1);
        try std.testing.expect(f.doc.blocks.items[last].flags.open);
        try std.testing.expectEqualStrings(row[1], (try f.doc.readLeaf(arena, last)).bytes.items);
        try std.testing.expect(try streamAgreesParts(arena, "kinds", row[0]));
    }
    // Shrunk model traces: a pending row's escaped space trims; a paragraph's own definition
    // arrives as the paragraph the layout ended closes.
    try std.testing.expect(try streamAgreesParts(arena, "kinds", &.{ "-", "|", "-", "\n", "- | -", "\n", "\\", " " }));
    try std.testing.expect(try streamAgreesParts(arena, "kinds", &.{ "[x]: /u\n", " [x]\n*", "\r", "#", " ", "]", "\n" }));
    // A backtick search that ran out after plain bytes does not count on from an older run.
    try std.testing.expect(try streamAgreesParts(arena, "kinds", &.{ "ses_```\nwww.", ". s_===\t```", "\ns_`s", "- ww", "`\n", "\n" }));
    // bigboi round 3: a row's growth decides display math as a new layout does (a `\[x\]`
    // line after a table is a one-line math block, not a cell).
    // (The row becomes a math block when its closer arrives: the frame loses the row, so these
    // compare the layouts only.)
    for ([_][]const u8{ "|a|b|\n|-|-|\n\\[x\\]\n", "> |a|b|\n> |-|-|\n> $$x$$ y\n" }) |text| {
        var f: Fixture = undefined;
        try f.init(.{ .math = true });
        defer f.deinit();
        for (0..text.len) |i| {
            try f.doc.append(text[i .. i + 1]);
            var fresh: Fixture = undefined;
            try fresh.init(.{ .math = true });
            defer fresh.deinit();
            try fresh.doc.append(text[0 .. i + 1]);
            try std.testing.expect(try sameDocs(arena, &f.doc, &fresh.doc));
        }
    }
    // A paragraph of only definitions that a `===` line continues starts at that line (spec
    // 216): its display has no empty first line.
    {
        var f: Fixture = undefined;
        try f.init(.{});
        defer f.deinit();
        try f.doc.append("[foo]: /url\n===\n[foo]\n");
        try f.doc.finish();
        try std.testing.expectEqualStrings("===\nfoo", (try f.doc.readLeaf(arena, 0)).bytes.items);
    }
    // bigboi round 5 (D102, D93: math is plain until decided): an opener alone, and with spaces,
    // shows as text, or as a row, at its two-byte prefix; its line ending makes it math once.
    for ([_][]const u8{ "", "p\n", "| r |\n|---|\n" }) |context| {
        for ([_][]const u8{ "$$", "\\[" }) |opener| {
            var f: Fixture = undefined;
            try f.init(.{ .math = true });
            defer f.deinit();
            try f.doc.append(context);
            for ([_][]const u8{ opener, "   " }) |part| {
                try f.doc.append(part);
                const frame = try renderFrame(arena, &f.doc);
                try std.testing.expect(std.mem.indexOf(u8, frame, opener[opener.len - 1 ..]) != null);
            }
            try f.doc.append("\n");
            var math = false;
            for (f.doc.blocks.items) |b| math = math or (b.kind == .code and b.flags.math);
            try std.testing.expect(math);
            try std.testing.expect(try streamAgreesParts(arena, "math kinds", &.{ context, opener, "   ", "\nx\n", opener, "\n" }));
        }
    }
    // opus-14, bigboi round 4: a lazy line that becomes a math block leaves the paragraph's node
    // as read_leaf shows it (the node kept `para\n$$E=mc^2$`); `$$x$$ y` never shows a math block
    // that reverts to text.
    // bigboi round 4: a heading with a tag and a backtick cut anywhere ends as read_leaf does.
    for ([_]usize{ 1, 2, 3 }) |width| try std.testing.expect(try streamAgreesParts(arena, "kinds", try split(arena, "# <!A` x &", width)));
    for ([_][]const u8{ "para\n$$E=mc^2$$\nafter", "p\n\\[y\\]\n", "$$x$$ y\n", "| r |\n|---|\n$$x$$ y\n", "| r |\n|---|\n$$E=mc^2$$\nafter" }) |text| {
        for ([_]usize{ 1, 4, 30 }) |width| try std.testing.expect(try streamAgreesParts(arena, "math kinds", try split(arena, text, width)));
    }
    // A pending ATX heading's content starts after the white space that follows `#`, as a fresh
    // parse starts it (the command model over every option set found it after a task marker).
    for ([_][]const u8{ "# ", "0. [x] # " }) |text| try std.testing.expect(try streamAgreesParts(arena, "kinds", try std.mem.concat(arena, []const u8, &.{ try split(arena, text, 1), &.{ " ", "\\" } })));
    // An entity or escape in a word that may be an extended autolink waits for the word's end:
    // the link shows its source raw, so drawing it decoded took text back (model seeds 4,860
    // and 63, over every option set).
    // The wait uses the parse's own start rule (bigboi round 6: after `(`, and `ftp://`): the
    // pending display never shows an entity the finished link shows raw.
    for ([_][]const u8{ "(www.a.b/&copy;x", "ftp://a.b/&copy;x", "x (https://a.b/\\*y" }) |text| {
        var f: Fixture = undefined;
        try f.init(.{});
        defer f.deinit();
        for (0..text.len) |i| {
            try f.doc.append(text[i .. i + 1]);
            try std.testing.expect(std.mem.indexOf(u8, (try f.doc.readLeaf(arena, 0)).bytes.items, "\u{a9}") == null);
        }
        try f.doc.finish();
        try std.testing.expect(std.mem.indexOf(u8, (try f.doc.readLeaf(arena, 0)).bytes.items, "\u{a9}") == null);
        for ([_]usize{ 1, 3 }) |width| try std.testing.expect(try streamAgreesParts(arena, "kinds", try split(arena, try std.mem.concat(arena, u8, &.{ text, "\n" }), width)));
    }
    for ([_][]const u8{ "www.a&mp;b\n", "www.a.b de&mp; \n", "x https://a\\.b y\n" }) |text| {
        for ([_]usize{ 1, 3 }) |width| try std.testing.expect(try streamAgreesParts(arena, "kinds", try split(arena, text, width)));
    }
    // M2's F2-c: an opener that the token limit makes literal in the finishing feed (its last
    // word is tokenized only then) is written literal, not left concealed on the node.
    for (2040..2052) |n| {
        var text: std.ArrayListUnmanaged(u8) = .empty;
        try text.appendSlice(arena, "**open ");
        for (0..n) |_| try text.appendSlice(arena, "`c` ");
        for (0..12) |_| try text.appendSlice(arena, "&amp;");
        try std.testing.expect(try streamAgreesParts(arena, "kinds", try split(arena, text.items, 30)));
    }
    // One title scanner for definitions and inline links: a parenthesized title cannot hold an
    // unescaped `(` (cmark-gfm: both stay text).
    for ([_][]const u8{ "[a](/u (b(c)))\n", "[x]: /u (b(c))\n\n[x]\n" }) |text| {
        const rendered = try html.normalize(arena, try wholeHtml(arena, "kinds", text));
        try std.testing.expect(std.mem.indexOf(u8, rendered, "<a ") == null);
    }
    // A replace after a layout that unbound nodes: every node is rebound (model trace).
    {
        var f: Fixture = undefined;
        try f.init(.{});
        defer f.deinit();
        var sink: markdown.TailSink = .{ .allocator = gpa };
        defer sink.deinit();
        f.doc.tail_sink = &sink;
        for ([_][]const u8{ "`\n", ">", "o" }) |part| try f.doc.append(part);
        try std.testing.expect(try liveShowsReadLeaf(arena, &f.doc, &sink));
        try f.doc.set("\t");
        try f.doc.append("\n[");
        try std.testing.expect(try liveShowsReadLeaf(arena, &f.doc, &sink));
    }
    // A paragraph of only definitions that the pending line ends is hidden, as the completed
    // line removes it (property (c), which the model found).
    {
        var f: Fixture = undefined;
        try f.init(.{});
        defer f.deinit();
        for ([_][]const u8{ "[x]: /u", "\n", "*", "   cod" }) |part| {
            try f.doc.append(part);
            try std.testing.expect(try layoutAgrees(arena, &f.doc, .{}));
        }
    }
    // A held line's settled tokens retired past its pipe, then the hold released (a debug
    // assertion, garbage in a release build): a line that long is no header, so not held.
    {
        var parts: std.ArrayListUnmanaged([]const u8) = .empty;
        try parts.append(arena, "text | ");
        for (0..3000) |_| try parts.append(arena, "`c` x ");
        try parts.append(arena, "\nnext\n");
        try std.testing.expect(try streamAgreesParts(arena, "kinds", parts.items));
    }
    // bigboi round 4: one feed settles 8,190 escapes when the next line arrives, and the held
    // line's pipe is among the tokens a retire would drop: the retire keeps them from the pipe on,
    // so the display folded away never passes what was drawn.
    {
        var f: Fixture = undefined;
        try f.init(.{});
        defer f.deinit();
        var first: std.ArrayListUnmanaged(u8) = .empty;
        try first.appendSlice(arena, "p ");
        for (0..8189) |_| try first.appendSlice(arena, "\\.");
        try first.append(arena, '\n');
        try f.doc.append(first.items);
        try f.doc.append("a | b end");
        try std.testing.expect(f.doc.live.folded_display_byte_count <= f.doc.live.shown_byte_count);
    }
    // A short held line that reaches the retire threshold (7,800 settled tokens before it):
    // the retire keeps the tokens from the pipe on, so the line can still be written when the
    // hold ends.
    {
        var parts: std.ArrayListUnmanaged([]const u8) = .empty;
        for (0..13) |_| {
            for (0..300) |_| try parts.append(arena, "`c` x ");
            try parts.append(arena, "\n");
        }
        try parts.append(arena, "text | ");
        for (0..300) |_| try parts.append(arena, "`c` x ");
        try parts.append(arena, "\nnext\n");
        try std.testing.expect(try streamAgreesParts(arena, "kinds", parts.items));
    }
    // opus-4 (a): definitions leave the paragraph the next one's live text would follow; (b) a
    // pending table row latches each of its cells that holds the filter.
    try std.testing.expect(try streamAgreesParts(arena, "kinds", &.{ "[x]: /u\n\nnext para\n", "more [x]" }));
    try std.testing.expect(try streamAgreesParts(arena, "hook kinds", &.{ "| a | b |\n| --- | --- |\n", "| ses_1 | ses_2 |", "\n" }));
    try std.testing.expect(try streamAgreesParts(arena, "hook kinds", try split(arena, "| a | b |\n| --- | --- |\n| ses_1 | ses_2 |\n", 1)));
}

test "Markdown changes: a late definition lists again the paragraph it changes" {
    var f: Fixture = undefined;
    try f.init(.{});
    defer f.deinit();
    // M2's F2-b: a pending fence opener's info string is the rest of its line; as it grows, the
    // code block is listed again with the fresh doc's info range (M2 012b6c347's ABI row).
    for ([_][]const []const u8{ &.{ "```", " ab" }, &.{ " 1. [x] ", "```", " ab" }, &.{ "- ", "```", " ab" } }) |parts| {
        var g: Fixture = undefined;
        try g.init(.{});
        defer g.deinit();
        var changes: [16]Doc.Change = undefined;
        for (parts) |part| {
            try g.doc.append(part);
            const read = g.doc.readChanges(&changes);
            var fresh: Fixture = undefined;
            try fresh.init(.{});
            defer fresh.deinit();
            try fresh.doc.append(g.doc.source.items);
            for (fresh.doc.blocks.items, 0..) |b, i| {
                if (b.kind != .code) continue;
                try std.testing.expect(std.mem.eql(u32, &b.payload, &g.doc.blocks.items[i].payload));
                var found = false;
                for (changes[0..read.count]) |c| found = found or (c.index == i and std.mem.eql(u32, &c.block.payload, &b.payload));
                try std.testing.expect(found);
            }
        }
    }
    // A pending row's cell and a pending paragraph that grow after a read are listed again
    // (the growth path writes them in place).
    for ([_][]const u8{ "|a|b|\n|-|-|\n| ab", "> some te" }) |text| {
        var g: Fixture = undefined;
        try g.init(.{});
        defer g.deinit();
        try g.doc.append(text);
        var changes: [16]Doc.Change = undefined;
        _ = g.doc.readChanges(&changes);
        try g.doc.append("c");
        const grown = g.doc.readChanges(&changes);
        try std.testing.expect(grown.count >= 1);
        try std.testing.expectEqual(@as(u32, @intCast(g.doc.blocks.items.len - 1)), changes[grown.count - 1].index);
    }
    // `[y]` keeps the leaf UNRESOLVED, so only the definition's use lists it (opus-10).
    try f.doc.append("see [x] [y]\n\nother\n\n");
    var out: [8]Doc.Change = undefined;
    _ = f.doc.readChanges(&out);
    try f.doc.append("[x]: /u\n\n");
    const read = f.doc.readChanges(&out);
    try std.testing.expectEqual(@as(u32, 1), read.count);
    try std.testing.expectEqual(@as(u32, 0), out[0].index);
    try std.testing.expectEqual(markdown.none, read.removed_from_index);
    // A replace that changes only a definition's target lists the leaf that uses it (bigboi-3).
    try f.doc.set("see [x] [y]\n\nother\n\n[x]: /w\n\n");
    const replaced = f.doc.readChanges(&out);
    try std.testing.expectEqual(@as(u32, 1), replaced.count);
    try std.testing.expectEqual(@as(u32, 0), out[0].index);
    // Two targets that change with the same URL pool (`/a` `/b/c` to `/a/b` `/c`): the chunks
    // pick other ranges of it (bigboi round 2).
    var g: Fixture = undefined;
    try g.init(.{});
    defer g.deinit();
    try g.doc.append("[x] [y]\n\n[x]: /a\n[y]: /b/c\n\n");
    _ = g.doc.readChanges(&out);
    try g.doc.set("[x] [y]\n\n[x]: /a/b\n[y]: /c\n\n");
    const pooled = g.doc.readChanges(&out);
    try std.testing.expectEqual(@as(u32, 1), pooled.count);
    try std.testing.expectEqual(@as(u32, 0), out[0].index);
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
