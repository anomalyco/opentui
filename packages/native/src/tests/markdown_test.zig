//! The Markdown engine against the shared corpus (packages/core/src/renderables/
//! markdown.conformance.json; Core and Rust run the same rows) and its streaming properties.
//!
//! Corpus checks, listed per row in `fails` like the bindings' checks:
//! - engine-html: one append of the whole document plus finish, through the test HTML emitter,
//!   equals the row's HTML after the corpus normalization (invariant 8).
//! - engine-stream: the row streamed in its chunks (or 32 pieces of equal code point count) equals
//!   a fresh doc of the same complete lines after every append, and one append of the whole after
//!   finish (invariant 1).
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

fn rowOptions(name: []const u8) markdown.Options {
    return .{ .math = std.mem.startsWith(u8, name, "math") };
}

fn wholeHtml(arena: std.mem.Allocator, name: []const u8, text: []const u8) ![]const u8 {
    var f: Fixture = undefined;
    try f.init(rowOptions(name));
    defer f.deinit();
    try f.doc.append(text);
    try f.doc.finish();
    return html.render(arena, &f.doc);
}

fn streamAgrees(arena: std.mem.Allocator, name: []const u8, chunks: []const std.json.Value) !bool {
    const parts = try pieces(arena, chunks);
    var streamed: Fixture = undefined;
    try streamed.init(rowOptions(name));
    defer streamed.deinit();
    for (parts) |part| {
        try streamed.doc.append(part);
        var fresh: Fixture = undefined;
        try fresh.init(rowOptions(name));
        defer fresh.deinit();
        try fresh.doc.append(streamed.doc.source.items[0..streamed.doc.line_start_byte]);
        if (!try sameDocs(arena, &streamed.doc, &fresh.doc)) return false;
    }
    try streamed.doc.finish();
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
