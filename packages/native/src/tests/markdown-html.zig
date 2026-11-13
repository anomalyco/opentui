//! Test-only HTML emitter for the Markdown engine (design invariant 8): writes CommonMark's
//! reference HTML for a document so the shared corpus can check the engine against the spec.
//! The corpus compares after `normalize`, so block-tag whitespace here is free.
const std = @import("std");
const Allocator = std.mem.Allocator;
const markdown = @import("../markdown.zig");
const inline_parser = @import("../markdown-inline.zig");
const Doc = markdown.Doc;
const none = markdown.none;

pub fn render(arena: Allocator, doc: *const Doc) ![]u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    var w = Writer{ .arena = arena, .out = &out, .doc = doc };
    var stack: std.ArrayListUnmanaged(u32) = .empty;
    const blocks = doc.blocks.items;
    for (blocks, 0..) |b, i| {
        while (stack.items.len > 0 and stack.items[stack.items.len - 1] != b.parent_index) {
            try w.close(stack.pop().?);
        }
        try w.open(@intCast(i));
        try stack.append(arena, @intCast(i));
    }
    while (stack.pop()) |index| try w.close(index);
    return out.items;
}

const Writer = struct {
    arena: Allocator,
    out: *std.ArrayListUnmanaged(u8),
    doc: *const Doc,

    fn put(self: *Writer, bytes: []const u8) !void {
        try self.out.appendSlice(self.arena, bytes);
    }

    fn print(self: *Writer, comptime format: []const u8, args: anytype) !void {
        try self.out.print(self.arena, format, args);
    }

    fn tightParagraph(self: *Writer, index: u32) bool {
        const b = self.doc.blocks.items[index];
        if (b.kind != .paragraph or b.parent_index == none) return false;
        const parent = self.doc.blocks.items[b.parent_index];
        if (parent.kind != .item) return false;
        return self.doc.blocks.items[parent.parent_index].flags.tight;
    }

    fn open(self: *Writer, index: u32) !void {
        const doc = self.doc;
        const b = doc.blocks.items[index];
        switch (b.kind) {
            .paragraph => {
                const tight = self.tightParagraph(index);
                if (!tight) try self.put("<p>");
                try self.taskBox(index);
                try self.leaf(index);
                if (!tight) try self.put("</p>\n");
            },
            .heading => {
                try self.print("<h{d}>", .{b.payload[0]});
                try self.leaf(index);
                try self.print("</h{d}>\n", .{b.payload[0]});
            },
            .code => {
                const content = try doc.leafContent(self.arena, index);
                try self.put("<pre><code");
                if (b.flags.math) {
                    try self.put(" class=\"language-math\"");
                } else if (b.flags.fenced and b.payload[1] > b.payload[0]) {
                    const info = try unescapeText(self.arena, doc.source.items[b.payload[0]..b.payload[1]]);
                    const word_end = std.mem.indexOfAny(u8, info, " \t") orelse info.len;
                    if (word_end > 0) {
                        try self.put(" class=\"language-");
                        try self.escape(info[0..word_end]);
                        try self.put("\"");
                    }
                }
                try self.put(">");
                var text = content.bytes;
                if (!b.flags.fenced and !b.flags.math) {
                    // Indented code drops trailing blank lines.
                    while (text.len > 0 and (text[text.len - 1] == ' ' or text[text.len - 1] == '\n')) {
                        const line_start = if (std.mem.lastIndexOfScalar(u8, text, '\n')) |n| n + 1 else 0;
                        if (std.mem.trim(u8, text[line_start..], " ").len != 0) break;
                        text = text[0..if (line_start > 0) line_start - 1 else 0];
                    }
                }
                try self.escape(text);
                if (text.len > 0 or contentHasLine(doc, b)) try self.put("\n");
                try self.put("</code></pre>\n");
            },
            .html => {
                const content = try doc.leafContent(self.arena, index);
                try self.put(content.bytes);
                try self.put("\n");
            },
            .rule => try self.put("<hr />\n"),
            .quote => try self.put("<blockquote>\n"),
            .list => {
                if (b.flags.ordered) {
                    if (b.payload[0] != 1) try self.print("<ol start=\"{d}\">\n", .{b.payload[0]}) else try self.put("<ol>\n");
                } else try self.put("<ul>\n");
            },
            .item => {
                try self.put("<li>");
                // A task box with no paragraph after it (the paragraph renders it otherwise).
                if (b.flags.task and !(index + 1 < doc.blocks.items.len and doc.blocks.items[index + 1].parent_index == index and doc.blocks.items[index + 1].kind == .paragraph)) {
                    try self.box(b.flags.checked);
                }
            },
            .table => try self.put("<table>\n"),
            .table_row => {
                const header = b.flags.header;
                const table = doc.blocks.items[b.parent_index];
                if (header) try self.put("<thead>\n");
                if (!header and index == firstBodyRow(doc, b.parent_index)) try self.put("<tbody>\n");
                try self.put("<tr>\n");
                _ = table;
            },
            .table_cell => {
                const row = doc.blocks.items[b.parent_index];
                const tag = if (row.flags.header) "th" else "td";
                try self.print("<{s}", .{tag});
                try self.alignment(b.payload[1]);
                try self.put(">");
                try self.leaf(index);
                try self.print("</{s}>\n", .{tag});
            },
        }
    }

    fn close(self: *Writer, index: u32) !void {
        const doc = self.doc;
        const b = doc.blocks.items[index];
        switch (b.kind) {
            .quote => try self.put("</blockquote>\n"),
            .list => try self.put(if (b.flags.ordered) "</ol>\n" else "</ul>\n"),
            .item => try self.put("</li>\n"),
            .table_row => {
                // Padding cells: readers derive them from the column count (invariant 11).
                const table = doc.blocks.items[b.parent_index];
                var cells: u32 = 0;
                var i = index + 1;
                while (i < doc.blocks.items.len and doc.blocks.items[i].parent_index == index) : (i += 1) cells += 1;
                while (cells < table.payload[0]) : (cells += 1) {
                    const tag = if (b.flags.header) "th" else "td";
                    try self.print("<{s}", .{tag});
                    // The header row has every column: its cells follow the table and the row.
                    try self.alignment(doc.blocks.items[b.parent_index + 2 + cells].payload[1]);
                    try self.print("></{s}>\n", .{tag});
                }
                try self.put("</tr>\n");
                if (b.flags.header) try self.put("</thead>\n");
            },
            .table => {
                if (firstBodyRow(doc, index) != none) try self.put("</tbody>\n");
                try self.put("</table>\n");
            },
            else => {},
        }
    }

    fn alignment(self: *Writer, cell_alignment: u32) !void {
        try self.put(switch (@as(markdown.Alignment, @fromBackingInt(@intCast(cell_alignment)))) {
            .none => "",
            .left => " align=\"left\"",
            .center => " align=\"center\"",
            .right => " align=\"right\"",
        });
    }

    fn taskBox(self: *Writer, index: u32) !void {
        const doc = self.doc;
        const b = doc.blocks.items[index];
        if (b.parent_index == none) return;
        const parent = doc.blocks.items[b.parent_index];
        if (parent.kind != .item or !parent.flags.task or b.parent_index + 1 != index) return;
        try self.box(parent.flags.checked);
    }

    fn box(self: *Writer, checked: bool) !void {
        try self.put(if (checked) "<input checked=\"\" disabled=\"\" type=\"checkbox\"> " else "<input disabled=\"\" type=\"checkbox\"> ");
    }

    fn escape(self: *Writer, text: []const u8) !void {
        for (text) |c| {
            switch (c) {
                '&' => try self.put("&amp;"),
                '<' => try self.put("&lt;"),
                '>' => try self.put("&gt;"),
                '"' => try self.put("&quot;"),
                else => try self.out.append(self.arena, c),
            }
        }
    }

    fn url(self: *Writer, raw: []const u8) !void {
        try self.encodedUrl(try unescapeText(self.arena, raw));
    }

    /// Percent-encodes what mdurl's encode does (keeping existing %XX escapes), then escapes `&`.
    fn encodedUrl(self: *Writer, text: []const u8) !void {
        var i: usize = 0;
        while (i < text.len) : (i += 1) {
            const c = text[i];
            if (c == '%' and i + 2 < text.len and std.ascii.isHex(text[i + 1]) and std.ascii.isHex(text[i + 2])) {
                try self.out.append(self.arena, '%');
                continue;
            }
            if (std.ascii.isAlphanumeric(c) or std.mem.indexOfScalar(u8, ";/?:@&=+$,-_.!~*'()#", c) != null) {
                if (c == '&') try self.put("&amp;") else if (c == '\'') try self.put("'") else try self.out.append(self.arena, c);
            } else {
                try self.print("%{X:0>2}", .{c});
            }
        }
    }

    // ---- Inline content ----

    fn leaf(self: *Writer, index: u32) !void {
        const result = try self.doc.parseLeaf(self.arena, index);
        var inline_writer = Inline{ .w = self, .r = result };
        try inline_writer.run();
    }
};

fn contentHasLine(doc: *const Doc, b: markdown.Block) bool {
    const opener_end = markdown.lineContentEnd(doc.source.items, b.source_start_byte);
    return b.content_start_byte != opener_end;
}

fn firstBodyRow(doc: *const Doc, table: u32) u32 {
    var i = table + 1;
    while (i < doc.blocks.items.len) : (i += 1) {
        const b = doc.blocks.items[i];
        if (b.parent_index == table and !b.flags.header) return i;
        if (b.parent_index != table and doc.blocks.items[i].kind != .table_cell) return none;
    }
    return none;
}

const Inline = struct {
    w: *Writer,
    r: inline_parser.Result,
    /// Inside an image's alt text: only text is written.
    plain_depth: u32 = 0,
    email: usize = 0,
    in_email: bool = false,

    fn run(self: *Inline) !void {
        const r = self.r;
        // Per delimiter token: its stack entry, to find its matches.
        var delimiter_of = try self.w.arena.alloc(u32, r.tokens.len);
        @memset(delimiter_of, none);
        for (r.delimiters, 0..) |d, i| delimiter_of[d.token_index] = @intCast(i);
        for (r.tokens, 0..) |token, i| {
            switch (token.kind) {
                .text => try self.literal(token.start, token.end()),
                .escape => try self.textOut(r.content[token.start + 1 .. token.end()]),
                .entity => {
                    const cps = inline_parser.decodeEntity(r.content[token.start..token.end()]);
                    var buffer: [8]u8 = undefined;
                    var n = std.unicode.utf8Encode(cps[0], &buffer) catch 0;
                    if (cps[1] != 0) n += std.unicode.utf8Encode(cps[1], buffer[n..]) catch 0;
                    try self.textOut(buffer[0..n]);
                },
                .soft_break => try self.textOut("\n"),
                .hard_break => if (self.plain_depth == 0) try self.w.put("<br />\n") else try self.textOut("\n"),
                .code => {
                    const n = token.aux;
                    const body = try codeSpanText(self.w.arena, r.content[token.start + n .. token.end() - n]);
                    try self.tag("<code>");
                    try self.textOut(body);
                    try self.tag("</code>");
                },
                .autolink, .autolink_email => {
                    const target = r.content[token.start + 1 .. token.end() - 1];
                    if (self.plain_depth == 0) {
                        try self.w.put("<a href=\"");
                        if (token.kind == .autolink_email) try self.w.put("mailto:");
                        try self.w.encodedUrl(target);
                        try self.w.put("\">");
                    }
                    try self.textOut(target);
                    try self.tag("</a>");
                },
                .extended_autolink => {
                    const target = r.content[token.start..token.end()];
                    if (self.plain_depth == 0) {
                        try self.w.put("<a href=\"");
                        if (token.aux == @backingInt(inline_parser.ExtendedKind.www)) try self.w.put("http://");
                        try self.w.encodedUrl(target);
                        try self.w.put("\">");
                    }
                    try self.textOut(target);
                    try self.tag("</a>");
                },
                .html => if (self.plain_depth == 0) try self.w.put(r.content[token.start..token.end()]),
                .math => {
                    const n = token.aux;
                    try self.tag("<span class=\"math\">");
                    try self.textOut(r.content[token.start + n .. token.end() - n]);
                    try self.tag("</span>");
                },
                .delimiter => try self.delimiter(token, delimiter_of[i]),
                .bracket_open => {
                    if (token.aux == 0) {
                        try self.literal(token.start, token.end());
                        continue;
                    }
                    const link = r.links[token.aux - 1];
                    if (link.image) {
                        if (self.plain_depth == 0) {
                            try self.w.put("<img src=\"");
                            try self.w.url(link.destination);
                            try self.w.put("\" alt=\"");
                        }
                        self.plain_depth += 1;
                    } else if (self.plain_depth == 0) {
                        try self.w.put("<a href=\"");
                        try self.w.url(link.destination);
                        try self.w.put("\"");
                        if (link.title) |title| {
                            try self.w.put(" title=\"");
                            try self.w.escape(try unescapeText(self.w.arena, title));
                            try self.w.put("\"");
                        }
                        try self.w.put(">");
                    }
                },
                .bracket_close => {
                    if (token.aux == 0) {
                        try self.literal(token.start, token.start + 1);
                        continue;
                    }
                    const link = r.links[token.aux - 1];
                    if (link.image) {
                        self.plain_depth -= 1;
                        if (self.plain_depth == 0) {
                            try self.w.put("\"");
                            if (link.title) |title| {
                                try self.w.put(" title=\"");
                                try self.w.escape(try unescapeText(self.w.arena, title));
                                try self.w.put("\"");
                            }
                            try self.w.put(" />");
                        }
                    } else try self.tag("</a>");
                },
            }
        }
    }

    fn tag(self: *Inline, text: []const u8) !void {
        if (self.plain_depth == 0) try self.w.put(text);
    }

    fn textOut(self: *Inline, text: []const u8) !void {
        try self.w.escape(text);
    }

    /// Literal content bytes, with GFM email autolinks inside them.
    fn literal(self: *Inline, start: u32, end: u32) !void {
        const r = self.r;
        var at = start;
        while (at < end) {
            while (self.email < r.emails.len and r.emails[self.email][1] <= at) : (self.email += 1) {}
            if (self.email >= r.emails.len or r.emails[self.email][0] >= end) {
                try self.textOut(r.content[at..end]);
                return;
            }
            const email = r.emails[self.email];
            if (at < email[0]) {
                try self.textOut(r.content[at..email[0]]);
                at = email[0];
            }
            if (at == email[0]) {
                if (self.plain_depth == 0) {
                    try self.w.put("<a href=\"mailto:");
                    try self.w.encodedUrl(r.content[email[0]..email[1]]);
                    try self.w.put("\">");
                }
            }
            const stop = @min(end, email[1]);
            try self.textOut(r.content[at..stop]);
            at = stop;
            if (at == email[1]) try self.tag("</a>");
        }
    }

    fn delimiter(self: *Inline, token: inline_parser.Token, delimiter_index: u32) !void {
        const r = self.r;
        if (delimiter_index == none) return self.literal(token.start, token.end());
        const d = r.delimiters[delimiter_index];
        // A run may close spans and open others (CommonMark 6.2: `*a***b**`): its closing
        // matches take its first characters, its opening matches its last, and what neither
        // took is literal in between.
        var closed: u32 = 0;
        var m = d.closer_first_match;
        while (m < d.closer_first_match + d.closer_match_count) : (m += 1) {
            try self.tag(closeTag(r.matches[m].kind));
            closed += r.matches[m].count;
        }
        var opened: u32 = 0;
        var o = d.opener_matches;
        while (o) |index| : (o = r.matches[index].next_for_opener) opened += r.matches[index].count;
        try self.literal(token.start + closed, token.end() - opened);
        o = d.opener_matches;
        while (o) |index| : (o = r.matches[index].next_for_opener) try self.tag(openTag(r.matches[index].kind));
    }
};

fn openTag(kind: inline_parser.MatchKind) []const u8 {
    return switch (kind) {
        .emphasis => "<em>",
        .strong => "<strong>",
        .strikethrough => "<del>",
    };
}

fn closeTag(kind: inline_parser.MatchKind) []const u8 {
    return switch (kind) {
        .emphasis => "</em>",
        .strong => "</strong>",
        .strikethrough => "</del>",
    };
}

/// Code span content: line endings become spaces; one space is stripped from both ends when
/// both are spaces and the content is not all spaces.
fn codeSpanText(arena: Allocator, raw: []const u8) ![]const u8 {
    const text = try arena.dupe(u8, raw);
    for (text) |*c| {
        if (c.* == '\n') c.* = ' ';
    }
    if (text.len >= 2 and text[0] == ' ' and text[text.len - 1] == ' ' and std.mem.trim(u8, text, " ").len > 0) {
        return text[1 .. text.len - 1];
    }
    return text;
}

const unescapeText = inline_parser.unescapeText;

/// The subset of the specs' normalize.py the corpus names (its "format" entry).
pub fn normalize(arena: Allocator, html: []const u8) ![]const u8 {
    const block_tags = [_][]const u8{ "p", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "ul", "ol", "li", "blockquote", "hr", "table", "thead", "tbody", "tr", "th", "td" };
    var out: std.ArrayListUnmanaged(u8) = .empty;
    var i: usize = 0;
    while (i < html.len) {
        if (html[i] == '<') {
            const close = std.mem.indexOfScalarPos(u8, html, i, '>') orelse html.len - 1;
            const tag = html[i .. close + 1];
            const name_start: usize = if (tag.len > 1 and tag[1] == '/') 2 else 1;
            var name_end = name_start;
            while (name_end < tag.len and std.ascii.isAlphanumeric(tag[name_end])) name_end += 1;
            const name = tag[name_start..name_end];
            var is_block = false;
            for (block_tags) |b| {
                if (std.mem.eql(u8, b, name)) is_block = true;
            }
            const is_void = std.mem.eql(u8, name, "br") or std.mem.eql(u8, name, "hr") or std.mem.eql(u8, name, "img") or std.mem.eql(u8, name, "input");
            if (is_block) {
                while (out.items.len > 0 and out.items[out.items.len - 1] == '\n') out.items.len -= 1;
            }
            if (is_void and std.mem.endsWith(u8, tag, " />")) {
                try out.appendSlice(arena, tag[0 .. tag.len - 3]);
                try out.append(arena, '>');
            } else {
                try out.appendSlice(arena, tag);
            }
            i = close + 1;
            if (is_block) {
                while (i < html.len and html[i] == '\n') i += 1;
            } else if (std.mem.eql(u8, name, "br") and name_start == 1 and i < html.len and html[i] == '\n') {
                i += 1;
            }
            continue;
        }
        if (std.mem.startsWith(u8, html[i..], "&#39;")) {
            try out.append(arena, '\'');
            i += 5;
            continue;
        }
        try out.append(arena, html[i]);
        i += 1;
    }
    return out.items;
}
