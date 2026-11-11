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
//! The model tests (properties named as in markdown-highlight-ssot-models.md) run 384 seeds of
//! 64 commands and 4 random splits of every corpus row in CI, about 5 s in a debug build. Longer
//! runs: MODEL_SEEDS=20000 for the command model, MARKDOWN_SPLITS=64 for the splits; MODEL_SEED
//! replays one seed, MARKDOWN_ROW runs one corpus row and prints its HTML.
const std = @import("std");
const markdown = @import("../markdown.zig");
const html = @import("markdown-html.zig");
const Doc = markdown.Doc;
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
    }
    return html.render(arena, &f.doc);
}

fn streamAgrees(arena: std.mem.Allocator, name: []const u8, chunks: []const std.json.Value) !bool {
    return streamAgreesParts(arena, name, try pieces(arena, chunks));
}

/// Rows longer than this skip the per-append fresh parse (quadratic in the row); the final
/// comparison and the live tail check still run.
const fresh_compare_byte_count_max = 4096;

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
        var fresh: Fixture = undefined;
        try fresh.init(rowOptions(name));
        defer fresh.deinit();
        try fresh.doc.append(try completeLines(arena, &streamed.doc));
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
    }
    if (unexpected.items.len > 0) {
        std.debug.print("rows {d}, engine-html {d}, engine-stream {d}; checks that differ from their listing:\n{s}", .{ rows, passes[0], passes[1], unexpected.items });
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
};

const Engine = struct {
    corpus_texts: []const []const u8,
    hook: bool = true,
    filter: []const u8 = "ses_",

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
            } else {
                try commands.append(arena, .toggle_math);
            }
        }
        return commands.items;
    }

    pub fn simplify(_: *Engine, _: std.mem.Allocator, command: Command) !?Command {
        return switch (command) {
            .append => |text| if (text.len > 1) .{ .append = text[0 .. text.len / 2] } else null,
            .set => |s| if (s.shared) .{ .set = .{ .text = s.text, .shared = false } } else null,
            else => null,
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
        for (commands, 0..) |command, step| {
            const was_finished = f.doc.finished;
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
                    const capacity: u32 = switch (capacity_kind) {
                        0 => 0,
                        1 => count -| 1,
                        else => count,
                    };
                    const out = try arena.alloc(markdown.Doc.Change, capacity);
                    const read = f.doc.readChanges(out);
                    if (read.count != count) return .{ .property = "P5 change count", .step = step };
                    if (capacity >= count) {
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
                try fresh.doc.append(try completeLines(arena, &f.doc));
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
                    const found = std.mem.indexOfPos(u8, f.doc.source.items, b.source_start_byte, self.filter);
                    const holds = found != null and found.? < b.source_end_byte;
                    if (holds != b.flags.hooked) return .{ .property = "P18 filter latch equals substring", .step = step };
                }
            }
            if (sink.mismatch_count > 0) return .{ .property = "live tail writes equal the leaf's display", .step = step };
            if (f.doc.counters.live_mismatch_count > 0) return .{ .property = "live pending line guessed its leaf", .step = step };
        }
        return null;
    }
};

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
    try model.check(Engine, &engine, .{ .seeds = 384, .steps = 64 });
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
