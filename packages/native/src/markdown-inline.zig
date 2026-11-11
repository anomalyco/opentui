//! The Markdown engine's inline parser: CommonMark 0.31.2 inlines with GFM strikethrough and
//! extended autolinks, and math when the option is on. It reads a leaf's content (its lines with
//! container prefixes and leading whitespace removed, joined by '\n') and produces tokens that
//! renderers (read_leaf, the test HTML emitter) walk in order. All memory comes from the caller's
//! arena; nothing here outlives one call.
const std = @import("std");
const assert = std.debug.assert;
const tables = @import("markdown-tables.zig");

/// Bounded stacks (design, memory model). Overflowing openers become literal text.
pub const token_count_max: u32 = 4096;
pub const delimiter_count_max: u32 = 1024;
pub const bracket_count_max: u32 = 64;
pub const label_byte_count_max: u32 = 999;
const destination_paren_depth_max: u32 = 32;
const backtick_run_tracked_max: u32 = 80;

pub const TokenKind = enum(u8) {
    text,
    /// A backslash escape: the byte after `start` is literal.
    escape,
    entity,
    soft_break,
    /// Covers the trailing spaces or backslash that made it.
    hard_break,
    /// The whole span including both backtick runs; `aux` is the run length.
    code,
    autolink,
    autolink_email,
    html,
    delimiter,
    /// `[` (len 1) or `![` (len 2); `aux` is the link index + 1, or 0 when literal.
    bracket_open,
    /// `]` plus the link tail it consumed; `aux` is the link index + 1, or 0 when literal.
    bracket_close,
    /// The whole span including delimiters; `aux` is the opener length.
    math,
    /// GFM extended autolink; `aux` is an `ExtendedKind`.
    extended_autolink,
};

pub const ExtendedKind = enum(u16) { www, url, email };

pub const Token = struct {
    start: u32,
    len: u32,
    kind: TokenKind,
    aux: u16 = 0,

    pub fn end(self: Token) u32 {
        return self.start + self.len;
    }
};

pub const MatchKind = enum(u8) { emphasis, strong, strikethrough };

pub const Delimiter = struct {
    token_index: u32,
    char: u8,
    original_count: u32,
    count: u32,
    can_open: bool,
    can_close: bool,
    /// Index in `delimiters` of the previous and next entries still on the stack.
    previous: ?u32 = null,
    next: ?u32 = null,
    /// Head of the matches where this delimiter is the opener, newest first.
    opener_matches: ?u32 = null,
    /// First match where this delimiter is the closer and how many follow it in order.
    closer_first_match: u32 = 0,
    closer_match_count: u32 = 0,
};

pub const Match = struct {
    kind: MatchKind,
    count: u32,
    /// Next older match of the same opener.
    next_for_opener: ?u32,
};

pub const Link = struct {
    image: bool,
    /// Raw destination and title: backslash escapes and entities still in them.
    destination: []const u8,
    title: ?[]const u8,
};

const Bracket = struct {
    token_index: u32,
    image: bool,
    active: bool,
    bracket_after: bool,
    /// Top of the delimiter stack when the bracket opened.
    previous_delimiter: ?u32,
};

/// What a reference label resolves to. `lookup` gets the raw label.
pub const References = struct {
    context: *const anyopaque,
    lookup_fn: *const fn (context: *const anyopaque, arena: std.mem.Allocator, label: []const u8) ?Link,

    pub fn lookup(self: References, arena: std.mem.Allocator, label: []const u8) ?Link {
        return self.lookup_fn(self.context, arena, label);
    }
};

pub const Options = struct {
    math: bool = false,
};

pub const Result = struct {
    content: []const u8,
    tokens: []Token,
    delimiters: []Delimiter,
    matches: []Match,
    links: []Link,
    /// Text ranges (content offsets) that GFM email autolinks take inside plain text runs.
    emails: [][2]u32,
    /// A reference candidate found no definition: a later definition may change this leaf.
    unresolved: bool,
};

/// Parses `content`. `content` must not end in whitespace that the leaf strips (the caller trims).
pub fn parse(arena: std.mem.Allocator, content: []const u8, references: References, options: Options) error{OutOfMemory}!Result {
    var parser: Parser = .{ .arena = arena, .subject = content, .references = references, .options = options };
    try parser.run();
    return .{
        .content = content,
        .tokens = parser.tokens.items,
        .delimiters = parser.delimiters.items,
        .matches = parser.matches.items,
        .links = parser.links.items,
        .emails = try parser.findEmails(),
        .unresolved = parser.unresolved,
    };
}

const Parser = struct {
    arena: std.mem.Allocator,
    subject: []const u8,
    references: References,
    options: Options,
    position: u32 = 0,
    tokens: std.ArrayListUnmanaged(Token) = .empty,
    delimiters: std.ArrayListUnmanaged(Delimiter) = .empty,
    matches: std.ArrayListUnmanaged(Match) = .empty,
    links: std.ArrayListUnmanaged(Link) = .empty,
    brackets: std.ArrayListUnmanaged(Bracket) = .empty,
    /// Top of the delimiter stack.
    delimiter_top: ?u32 = null,
    delimiter_stack_count: u32 = 0,
    unresolved: bool = false,
    /// After one failed backtick search, the last start of each run length (cmark's rule), so
    /// later openers fail without searching again.
    backticks_scanned: bool = false,
    backtick_last_start: [backtick_run_tracked_max + 1]u32 = @splat(0),
    matched_tokens: std.DynamicBitSetUnmanaged = .{},

    fn run(self: *Parser) !void {
        const n: u32 = @intCast(self.subject.len);
        while (self.position < n) {
            const c = self.subject[self.position];
            switch (c) {
                '\n' => try self.newline(),
                '\\' => try self.backslash(),
                '`' => try self.backticks(),
                '*', '_', '~' => try self.delimiter(c),
                '[' => try self.openBracket(1),
                '!' => {
                    if (self.position + 1 < n and self.subject[self.position + 1] == '[') {
                        try self.openBracket(2);
                    } else {
                        try self.text(self.position, self.position + 1);
                    }
                },
                ']' => try self.closeBracket(),
                '<' => try self.lessThan(),
                '&' => try self.entity(),
                '$' => try self.dollar(),
                ':' => try self.scheme(),
                'w' => try self.www(),
                else => try self.plain(),
            }
        }
        try self.processEmphasis(null);
    }

    fn isSpecial(self: *const Parser, c: u8) bool {
        return switch (c) {
            '\n', '\\', '`', '*', '_', '~', '[', '!', ']', '<', '&', ':', 'w' => true,
            '$' => self.options.math,
            else => false,
        };
    }

    fn plain(self: *Parser) !void {
        const start = self.position;
        var i = start + 1;
        while (i < self.subject.len and !self.isSpecial(self.subject[i])) i += 1;
        // Trailing spaces before a newline belong to the line break.
        try self.text(start, i);
    }

    /// Appends literal text, merging with an adjacent text token.
    fn text(self: *Parser, start: u32, end: u32) !void {
        self.position = end;
        if (start == end) return;
        if (self.tokens.items.len > 0) {
            const last = &self.tokens.items[self.tokens.items.len - 1];
            if (last.kind == .text and last.end() == start) {
                last.len += end - start;
                return;
            }
        }
        try self.push(.{ .start = start, .len = end - start, .kind = .text });
    }

    fn push(self: *Parser, token: Token) !void {
        try self.tokens.append(self.arena, token);
    }

    fn newline(self: *Parser) !void {
        const at = self.position;
        // Spaces before the newline: two or more make a hard break; the text loses them.
        var spaces: u32 = 0;
        if (self.tokens.items.len > 0) {
            const last = &self.tokens.items[self.tokens.items.len - 1];
            if (last.kind == .text and last.end() == at) {
                while (spaces < last.len and self.subject[at - spaces - 1] == ' ') spaces += 1;
                last.len -= spaces;
                if (last.len == 0) _ = self.tokens.pop();
            }
        }
        var next = at + 1;
        while (next < self.subject.len and (self.subject[next] == ' ' or self.subject[next] == '\t')) next += 1;
        if (spaces >= 2) {
            try self.push(.{ .start = at - spaces, .len = next - (at - spaces), .kind = .hard_break });
        } else {
            try self.push(.{ .start = at - spaces, .len = next - (at - spaces), .kind = .soft_break });
        }
        self.position = next;
    }

    fn backslash(self: *Parser) !void {
        const at = self.position;
        const n = self.subject.len;
        if (at + 1 < n and self.subject[at + 1] == '\n') {
            var next = at + 2;
            while (next < n and (self.subject[next] == ' ' or self.subject[next] == '\t')) next += 1;
            try self.push(.{ .start = at, .len = next - at, .kind = .hard_break });
            self.position = next;
            return;
        }
        if (self.options.math and at + 1 < n and self.subject[at + 1] == '(') {
            if (self.findParenMathClose(at + 2)) |close| {
                try self.push(.{ .start = at, .len = close + 2 - at, .kind = .math, .aux = 2 });
                self.position = close + 2;
                return;
            }
        }
        if (at + 1 < n and isAsciiPunctuation(self.subject[at + 1])) {
            try self.push(.{ .start = at, .len = 2, .kind = .escape });
            self.position = at + 2;
            return;
        }
        try self.text(at, at + 1);
    }

    fn findParenMathClose(self: *const Parser, from: u32) ?u32 {
        var i = from;
        while (i + 1 < self.subject.len) : (i += 1) {
            const c = self.subject[i];
            if (c == '\\' and self.subject[i + 1] == ')') return if (i > from) i else null;
            if (c == '\\') i += 1;
        }
        return null;
    }

    fn backticks(self: *Parser) !void {
        const start = self.position;
        const count = runLength(self.subject, start, '`');
        const after = start + count;
        if (self.findBacktickCloser(after, count)) |closer| {
            try self.push(.{ .start = start, .len = closer + count - start, .kind = .code, .aux = @intCast(@min(count, std.math.maxInt(u16))) });
            self.position = closer + count;
            return;
        }
        try self.text(start, after);
    }

    fn findBacktickCloser(self: *Parser, from: u32, count: u32) ?u32 {
        if (self.backticks_scanned and count <= backtick_run_tracked_max and self.backtick_last_start[count] < from) return null;
        var i = from;
        const n: u32 = @intCast(self.subject.len);
        while (i < n) {
            if (self.subject[i] != '`') {
                i += 1;
                continue;
            }
            const run_length = runLength(self.subject, i, '`');
            if (run_length <= backtick_run_tracked_max) self.backtick_last_start[run_length] = i;
            if (run_length == count) return i;
            i += run_length;
        }
        self.backticks_scanned = true;
        return null;
    }

    fn delimiter(self: *Parser, c: u8) !void {
        const start = self.position;
        const count = runLength(self.subject, start, c);
        const end = start + count;
        const before = previousCodePoint(self.subject, start);
        const after = nextCodePoint(self.subject, end);
        const before_space = isUnicodeWhitespace(before);
        const after_space = isUnicodeWhitespace(after);
        const before_punctuation = isUnicodePunctuation(before);
        const after_punctuation = isUnicodePunctuation(after);
        const left = !after_space and (!after_punctuation or before_space or before_punctuation);
        const right = !before_space and (!before_punctuation or after_space or after_punctuation);
        var can_open = left;
        var can_close = right;
        if (c == '_') {
            can_open = left and (!right or before_punctuation);
            can_close = right and (!left or after_punctuation);
        }
        if (c == '~' and count > 2) {
            can_open = false;
            can_close = false;
        }
        const token_index: u32 = @intCast(self.tokens.items.len);
        try self.push(.{ .start = start, .len = count, .kind = .delimiter, .aux = c });
        self.position = end;
        if (!can_open and !can_close) return;
        if (self.delimiter_stack_count >= delimiter_count_max) return;
        const index: u32 = @intCast(self.delimiters.items.len);
        try self.delimiters.append(self.arena, .{
            .token_index = token_index,
            .char = c,
            .original_count = count,
            .count = count,
            .can_open = can_open,
            .can_close = can_close,
            .previous = self.delimiter_top,
        });
        if (self.delimiter_top) |top| self.delimiters.items[top].next = index;
        self.delimiter_top = index;
        self.delimiter_stack_count += 1;
    }

    fn removeDelimiter(self: *Parser, index: u32) void {
        const d = &self.delimiters.items[index];
        if (d.previous) |p| self.delimiters.items[p].next = d.next;
        if (d.next) |nx| {
            self.delimiters.items[nx].previous = d.previous;
        } else {
            self.delimiter_top = d.previous;
        }
        d.previous = null;
        d.next = null;
        self.delimiter_stack_count -= 1;
    }

    /// CommonMark's "process emphasis" over the delimiters above `bottom`.
    fn processEmphasis(self: *Parser, bottom: ?u32) !void {
        // The first delimiter above bottom.
        var closer_option: ?u32 = if (sameIndex(self.delimiter_top, bottom)) null else self.delimiter_top;
        while (closer_option) |c| {
            const previous = self.delimiters.items[c].previous;
            if (previous == null or sameIndex(previous, bottom)) break;
            closer_option = previous;
        }
        while (closer_option) |closer_index| {
            const closer = &self.delimiters.items[closer_index];
            if (!closer.can_close) {
                closer_option = closer.next;
                continue;
            }
            var opener_option = closer.previous;
            var found: ?u32 = null;
            while (opener_option) |opener_index| {
                if (sameIndex(opener_index, bottom)) break;
                const opener = &self.delimiters.items[opener_index];
                if (opener.char == closer.char and opener.can_open) {
                    if (closer.char == '~') {
                        if (opener.count == closer.count) {
                            found = opener_index;
                            break;
                        }
                    } else {
                        const odd = (closer.can_open or opener.can_close) and closer.original_count % 3 != 0 and
                            (opener.original_count + closer.original_count) % 3 == 0;
                        if (!odd) {
                            found = opener_index;
                            break;
                        }
                    }
                }
                opener_option = opener.previous;
            }
            if (found) |opener_index| {
                const opener = &self.delimiters.items[opener_index];
                const kind: MatchKind, const used: u32 = if (closer.char == '~')
                    .{ .strikethrough, closer.count }
                else if (closer.count >= 2 and opener.count >= 2)
                    .{ .strong, 2 }
                else
                    .{ .emphasis, 1 };
                opener.count -= used;
                closer.count -= used;
                try self.addMatch(opener_index, closer_index, kind, used);
                // Delimiters between opener and closer become literal.
                var between = closer.previous;
                while (between) |b| {
                    if (b == opener_index) break;
                    const prev = self.delimiters.items[b].previous;
                    self.removeDelimiter(b);
                    between = prev;
                }
                if (self.delimiters.items[opener_index].count == 0) self.removeDelimiter(opener_index);
                if (self.delimiters.items[closer_index].count == 0) {
                    const next = self.delimiters.items[closer_index].next;
                    self.removeDelimiter(closer_index);
                    closer_option = next;
                }
            } else {
                const next = closer.next;
                if (!closer.can_open) self.removeDelimiter(closer_index);
                closer_option = next;
            }
        }
        // Remove every delimiter above bottom.
        while (self.delimiter_top) |top| {
            if (sameIndex(top, bottom)) break;
            self.removeDelimiter(top);
        }
    }

    fn addMatch(self: *Parser, opener_index: u32, closer_index: u32, kind: MatchKind, count: u32) !void {
        const index: u32 = @intCast(self.matches.items.len);
        try self.matches.append(self.arena, .{ .kind = kind, .count = count, .next_for_opener = self.delimiters.items[opener_index].opener_matches });
        self.delimiters.items[opener_index].opener_matches = index;
        const closer = &self.delimiters.items[closer_index];
        if (closer.closer_match_count == 0) closer.closer_first_match = index;
        assert(closer.closer_first_match + closer.closer_match_count == index);
        closer.closer_match_count += 1;
    }

    fn openBracket(self: *Parser, len: u32) !void {
        const start = self.position;
        const token_index: u32 = @intCast(self.tokens.items.len);
        try self.push(.{ .start = start, .len = len, .kind = .bracket_open });
        self.position = start + len;
        if (self.brackets.items.len >= bracket_count_max) return;
        if (self.brackets.items.len > 0) self.brackets.items[self.brackets.items.len - 1].bracket_after = true;
        try self.brackets.append(self.arena, .{
            .token_index = token_index,
            .image = len == 2,
            .active = true,
            .bracket_after = false,
            .previous_delimiter = self.delimiter_top,
        });
    }

    fn closeBracket(self: *Parser) !void {
        const start = self.position;
        const after = start + 1;
        const opener = if (self.brackets.items.len > 0) self.brackets.items[self.brackets.items.len - 1] else null;
        if (opener == null) {
            try self.push(.{ .start = start, .len = 1, .kind = .bracket_close });
            self.position = after;
            return;
        }
        const bracket = opener.?;
        if (!bracket.active) {
            _ = self.brackets.pop();
            try self.push(.{ .start = start, .len = 1, .kind = .bracket_close });
            self.position = after;
            return;
        }
        var link: ?Link = null;
        var end = after;
        if (self.inlineTail(after)) |tail| {
            link = .{ .image = bracket.image, .destination = tail.destination, .title = tail.title };
            end = tail.end;
        } else {
            const opener_token = self.tokens.items[bracket.token_index];
            const inner = self.subject[opener_token.end()..start];
            var label: ?[]const u8 = null;
            const label_len = scanLinkLabel(self.subject, after);
            if (label_len > 2) {
                label = self.subject[after + 1 .. after + label_len - 1];
                end = after + label_len;
            } else if (!bracket.bracket_after) {
                label = inner;
                if (label_len == 2) end = after + 2;
            }
            if (label) |l| {
                if (isValidLabel(l)) {
                    if (self.references.lookup(self.arena, l)) |found| {
                        link = .{ .image = bracket.image, .destination = found.destination, .title = found.title };
                    } else {
                        self.unresolved = true;
                    }
                }
            }
            if (link == null) end = after;
        }
        _ = self.brackets.pop();
        if (link) |l| {
            const link_index: u32 = @intCast(self.links.items.len);
            try self.links.append(self.arena, l);
            self.tokens.items[bracket.token_index].aux = @intCast(link_index + 1);
            try self.push(.{ .start = start, .len = end - start, .kind = .bracket_close, .aux = @intCast(link_index + 1) });
            self.position = end;
            try self.processEmphasis(bracket.previous_delimiter);
            if (!bracket.image) {
                for (self.brackets.items) |*b| {
                    if (!b.image) b.active = false;
                }
            }
            return;
        }
        try self.push(.{ .start = start, .len = 1, .kind = .bracket_close });
        self.position = after;
    }

    const Tail = struct { destination: []const u8, title: ?[]const u8, end: u32 };

    /// `(destination "title")` right after `]`.
    fn inlineTail(self: *const Parser, at: u32) ?Tail {
        const s = self.subject;
        if (at >= s.len or s[at] != '(') return null;
        var i = skipSpaceNewline(s, at + 1) orelse return null;
        var destination: []const u8 = "";
        if (i < s.len and s[i] != ')') {
            const d = scanDestination(s, i) orelse return null;
            destination = d.value;
            i = d.end;
        }
        var title: ?[]const u8 = null;
        const before_title = i;
        i = skipSpaceNewline(s, i) orelse return null;
        if (i > before_title and i < s.len) {
            if (scanTitle(s, i)) |t| {
                title = t.value;
                i = skipSpaceNewline(s, t.end) orelse return null;
            }
        }
        if (i < s.len and s[i] == ')') return .{ .destination = destination, .title = title, .end = i + 1 };
        return null;
    }

    fn lessThan(self: *Parser) !void {
        const start = self.position;
        if (scanAutolink(self.subject, start)) |a| {
            try self.push(.{ .start = start, .len = a.end - start, .kind = if (a.email) .autolink_email else .autolink });
            self.position = a.end;
            return;
        }
        if (scanHtmlTag(self.subject, start)) |end| {
            try self.push(.{ .start = start, .len = end - start, .kind = .html });
            self.position = end;
            return;
        }
        try self.text(start, start + 1);
    }

    fn entity(self: *Parser) !void {
        const start = self.position;
        if (scanEntity(self.subject, start)) |e| {
            try self.push(.{ .start = start, .len = e.end - start, .kind = .entity });
            self.position = e.end;
            return;
        }
        try self.text(start, start + 1);
    }

    fn dollar(self: *Parser) !void {
        const s = self.subject;
        const start = self.position;
        if (!self.options.math) return self.text(start, start + 1);
        const dollars = runLength(s, start, '$');
        if (dollars != 1) return self.text(start, start + dollars);
        const before_digit = start > 0 and std.ascii.isDigit(s[start - 1]);
        const next = start + 1;
        if (before_digit or next >= s.len or isAsciiWhitespace(s[next])) return self.text(start, next);
        var i = next;
        while (i < s.len) : (i += 1) {
            const c = s[i];
            if (c == '\\') {
                i += 1;
                continue;
            }
            if (c == '`') break;
            if (c == '\n' and i + 1 < s.len and s[i + 1] == '\n') break;
            if (c != '$') continue;
            const closes = !isAsciiWhitespace(s[i - 1]) and (i + 1 >= s.len or !std.ascii.isDigit(s[i + 1])) and
                (i + 1 >= s.len or s[i + 1] != '$');
            if (!closes) break;
            try self.push(.{ .start = start, .len = i + 1 - start, .kind = .math, .aux = 1 });
            self.position = i + 1;
            return;
        }
        try self.text(start, next);
    }

    /// GFM extended URL autolinks: at ':' the scheme is the end of the text before it.
    fn scheme(self: *Parser) !void {
        const at = self.position;
        if (self.tokens.items.len > 0) {
            const last = &self.tokens.items[self.tokens.items.len - 1];
            if (last.kind == .text and last.end() == at) {
                inline for (.{ "https", "http", "ftp" }) |name| {
                    if (self.tryUrl(last, at, name)) |end| return self.extended(at - @as(u32, @intCast(name.len)), end, .url);
                }
                inline for (.{ "mailto", "xmpp" }) |name| {
                    if (self.trySchemeEmail(last, at, name)) |end| return self.extended(at - @as(u32, @intCast(name.len)), end, .url);
                }
            }
        }
        try self.text(at, at + 1);
    }

    fn tryUrl(self: *Parser, last: *Token, at: u32, comptime name: []const u8) ?u32 {
        const s = self.subject;
        if (at - last.start < name.len) return null;
        const start = at - @as(u32, @intCast(name.len));
        if (!std.ascii.eqlIgnoreCase(s[start..at], name)) return null;
        if (start > 0 and !isExtendedBoundary(s[start - 1])) return null;
        if (at + 3 > s.len or !std.mem.eql(u8, s[at .. at + 3], "://")) return null;
        const end = scanExtendedUrl(s, at + 3) orelse return null;
        return end;
    }

    /// GFM `mailto:` and `xmpp:` autolinks: the scheme, an email address, and for xmpp one
    /// optional `/resource`.
    fn trySchemeEmail(self: *Parser, last: *Token, at: u32, comptime name: []const u8) ?u32 {
        const s = self.subject;
        if (at - last.start < name.len) return null;
        const start = at - @as(u32, @intCast(name.len));
        if (!std.ascii.eqlIgnoreCase(s[start..at], name)) return null;
        if (start > 0 and !isExtendedBoundary(s[start - 1])) return null;
        var i = at + 1;
        while (i < s.len and (std.ascii.isAlphanumeric(s[i]) or std.mem.indexOfScalar(u8, ".-_+", s[i]) != null)) i += 1;
        if (i == at + 1 or i >= s.len or s[i] != '@') return null;
        const email = scanEmail(s, at + 1, @intCast(s.len), i) orelse return null;
        if (email[0] != at + 1) return null;
        var end = email[1];
        if (comptime std.mem.eql(u8, name, "xmpp")) {
            if (end < s.len and s[end] == '/') {
                var j = end + 1;
                while (j < s.len and (std.ascii.isAlphanumeric(s[j]) or s[j] == '@' or s[j] == '.')) j += 1;
                while (j > end + 1 and s[j - 1] == '.') j -= 1;
                if (j > end + 1) end = j;
            }
        }
        return end;
    }

    fn www(self: *Parser) !void {
        const at = self.position;
        const s = self.subject;
        const boundary = at == 0 or isExtendedBoundary(s[at - 1]);
        if (boundary and at + 4 <= s.len and std.mem.eql(u8, s[at .. at + 4], "www.")) {
            if (scanExtendedUrl(s, at)) |end| return self.extended(at, end, .www);
        }
        try self.plainFrom(at);
    }

    fn plainFrom(self: *Parser, at: u32) !void {
        var i = at + 1;
        while (i < self.subject.len and !self.isSpecial(self.subject[i])) i += 1;
        try self.text(at, i);
    }

    fn extended(self: *Parser, start: u32, end: u32, kind: ExtendedKind) !void {
        // The scheme letters were text: take them back.
        if (self.tokens.items.len > 0) {
            const last = &self.tokens.items[self.tokens.items.len - 1];
            if (last.kind == .text and last.end() > start) {
                last.len = start - last.start;
                if (last.len == 0) _ = self.tokens.pop();
            }
        }
        try self.push(.{ .start = start, .len = end - start, .kind = .extended_autolink, .aux = @backingInt(kind) });
        self.position = end;
    }

    /// GFM email autolinks inside plain text runs (cmark-gfm finds them after inline parsing).
    fn findEmails(self: *Parser) ![][2]u32 {
        var result: std.ArrayListUnmanaged([2]u32) = .empty;
        self.matched_tokens = try std.DynamicBitSetUnmanaged.initEmpty(self.arena, self.tokens.items.len);
        for (self.delimiters.items) |d| {
            if (d.opener_matches != null or d.closer_match_count > 0) self.matched_tokens.set(d.token_index);
        }
        const s = self.subject;
        var i: u32 = 0;
        while (i < self.tokens.items.len) {
            if (!self.isPlain(i)) {
                i += 1;
                continue;
            }
            var j = i;
            while (j + 1 < self.tokens.items.len and self.isPlain(j + 1) and
                self.tokens.items[j + 1].start == self.tokens.items[j].end()) j += 1;
            const run_start = self.tokens.items[i].start;
            const run_end = self.tokens.items[j].end();
            var k = run_start;
            while (k < run_end) : (k += 1) {
                if (s[k] != '@') continue;
                if (scanEmail(s, run_start, run_end, k)) |email| {
                    if (email[0] > run_start and s[email[0] - 1] == ':') continue;
                    try result.append(self.arena, email);
                    k = email[1];
                }
            }
            i = j + 1;
        }
        return result.items;
    }

    fn isPlain(self: *const Parser, index: u32) bool {
        const token = self.tokens.items[index];
        return switch (token.kind) {
            .text => true,
            .delimiter => !self.matched_tokens.isSet(index),
            else => false,
        };
    }
};

fn sameIndex(a: ?u32, b: ?u32) bool {
    if (a == null or b == null) return a == null and b == null;
    return a.? == b.?;
}

// ---- Scanners over a contiguous subject. Each returns the end offset or null. ----

pub fn runLength(s: []const u8, at: u32, c: u8) u32 {
    var i = at;
    while (i < s.len and s[i] == c) i += 1;
    return i - at;
}

fn isAsciiWhitespace(c: u8) bool {
    return c == ' ' or c == '\t' or c == '\n' or c == '\r' or c == 0x0c;
}

pub fn isAsciiPunctuation(c: u8) bool {
    return switch (c) {
        '!'...'/', ':'...'@', '['...'`', '{'...'~' => true,
        else => false,
    };
}

/// Code point before `at`, or '\n' at the start (CommonMark treats both ends as whitespace).
fn previousCodePoint(s: []const u8, at: u32) u21 {
    if (at == 0) return '\n';
    var i = at - 1;
    while (i > 0 and (s[i] & 0xc0) == 0x80 and at - i < 4) i -= 1;
    return std.unicode.utf8Decode(s[i..at]) catch s[at - 1];
}

fn nextCodePoint(s: []const u8, at: u32) u21 {
    if (at >= s.len) return '\n';
    const len = std.unicode.utf8ByteSequenceLength(s[at]) catch return s[at];
    if (at + len > s.len) return s[at];
    return std.unicode.utf8Decode(s[at .. at + len]) catch s[at];
}

pub fn isUnicodeWhitespace(cp: u21) bool {
    if (cp == '\t' or cp == '\n' or cp == 0x0c or cp == '\r') return true;
    for (tables.space_separators) |space| {
        if (space == cp) return true;
    }
    return false;
}

pub fn isUnicodePunctuation(cp: u21) bool {
    if (cp < 0x80) return isAsciiPunctuation(@intCast(cp));
    var low: usize = 0;
    var high: usize = tables.punctuation_ranges.len;
    while (low < high) {
        const mid = (low + high) / 2;
        const range = tables.punctuation_ranges[mid];
        if (cp < range[0]) {
            high = mid;
        } else if (cp > range[1]) {
            low = mid + 1;
        } else {
            return true;
        }
    }
    return false;
}

/// Spaces and tabs with at most one line ending among them.
fn skipSpaceNewline(s: []const u8, at: u32) ?u32 {
    var i = at;
    var newlines: u32 = 0;
    while (i < s.len) : (i += 1) {
        switch (s[i]) {
            ' ', '\t' => {},
            '\n' => {
                newlines += 1;
                if (newlines > 1) return null;
            },
            else => break,
        }
    }
    return i;
}

pub const Scanned = struct { value: []const u8, end: u32 };

pub fn scanDestination(s: []const u8, at: u32) ?Scanned {
    if (at >= s.len) return null;
    if (s[at] == '<') {
        var i = at + 1;
        while (i < s.len) : (i += 1) {
            switch (s[i]) {
                '\\' => {
                    if (i + 1 < s.len and isAsciiPunctuation(s[i + 1])) i += 1;
                },
                '\n', '<' => return null,
                '>' => return .{ .value = s[at + 1 .. i], .end = i + 1 },
                else => {},
            }
        }
        return null;
    }
    var i = at;
    var depth: u32 = 0;
    while (i < s.len) : (i += 1) {
        const c = s[i];
        if (c == '\\' and i + 1 < s.len and isAsciiPunctuation(s[i + 1])) {
            i += 1;
            continue;
        }
        if (c == '(') {
            depth += 1;
            if (depth > destination_paren_depth_max) return null;
        } else if (c == ')') {
            if (depth == 0) break;
            depth -= 1;
        } else if (c <= 0x20 or c == 0x7f) {
            break;
        }
    }
    if (i == at or depth != 0) return null;
    return .{ .value = s[at..i], .end = i };
}

pub fn scanTitle(s: []const u8, at: u32) ?Scanned {
    if (at >= s.len) return null;
    const close: u8 = switch (s[at]) {
        '"' => '"',
        '\'' => '\'',
        '(' => ')',
        else => return null,
    };
    var i = at + 1;
    while (i < s.len) : (i += 1) {
        const c = s[i];
        if (c == '\\' and i + 1 < s.len and isAsciiPunctuation(s[i + 1])) {
            i += 1;
            continue;
        }
        if (c == close) return .{ .value = s[at + 1 .. i], .end = i + 1 };
        if (close == ')' and c == '(') return null;
        if (c == '\n' and i + 1 < s.len and s[i + 1] == '\n') return null;
    }
    return null;
}

/// Length of `[label]` at `at` (2 for `[]`), or 0.
pub fn scanLinkLabel(s: []const u8, at: u32) u32 {
    if (at >= s.len or s[at] != '[') return 0;
    var i = at + 1;
    while (i < s.len) : (i += 1) {
        const c = s[i];
        if (i - at - 1 > label_byte_count_max) return 0;
        if (c == '\\' and i + 1 < s.len and isAsciiPunctuation(s[i + 1])) {
            i += 1;
            continue;
        }
        if (c == '[') return 0;
        if (c == ']') return i + 1 - at;
    }
    return 0;
}

/// A label holds at most 999 characters and one that is not whitespace.
pub fn isValidLabel(label: []const u8) bool {
    if (label.len == 0) return false;
    const count = std.unicode.utf8CountCodepoints(label) catch label.len;
    if (count > label_byte_count_max) return false;
    for (label) |c| {
        if (!isAsciiWhitespace(c)) return true;
    }
    return false;
}

const Autolink = struct { end: u32, email: bool };

fn scanAutolink(s: []const u8, at: u32) ?Autolink {
    // Scheme autolink.
    var i = at + 1;
    if (i < s.len and std.ascii.isAlphabetic(s[i])) {
        var j = i + 1;
        while (j < s.len and (std.ascii.isAlphanumeric(s[j]) or s[j] == '+' or s[j] == '.' or s[j] == '-')) j += 1;
        const scheme_len = j - i;
        if (scheme_len >= 2 and scheme_len <= 32 and j < s.len and s[j] == ':') {
            var k = j + 1;
            while (k < s.len and s[k] != '>' and s[k] != '<' and s[k] > 0x20) k += 1;
            if (k < s.len and s[k] == '>') return .{ .end = k + 1, .email = false };
        }
    }
    // Email autolink.
    i = at + 1;
    const local_start = i;
    while (i < s.len and isEmailLocal(s[i])) i += 1;
    if (i == local_start or i >= s.len or s[i] != '@') return null;
    i += 1;
    while (true) {
        const label_start = i;
        while (i < s.len and (std.ascii.isAlphanumeric(s[i]) or s[i] == '-')) i += 1;
        const label_len = i - label_start;
        if (label_len == 0 or label_len > 63) return null;
        if (s[label_start] == '-' or s[i - 1] == '-') return null;
        if (i < s.len and s[i] == '.') {
            i += 1;
            continue;
        }
        break;
    }
    if (i < s.len and s[i] == '>') return .{ .end = i + 1, .email = true };
    return null;
}

fn isEmailLocal(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or std.mem.indexOfScalar(u8, ".!#$%&'*+/=?^_`{|}~-", c) != null;
}

fn isTagNameChar(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or c == '-';
}

/// An inline raw HTML construct at `at` (CommonMark 6.6).
pub fn scanHtmlTag(s: []const u8, at: u32) ?u32 {
    var i = at + 1;
    if (i >= s.len) return null;
    const c = s[i];
    if (std.ascii.isAlphabetic(c)) return scanOpenTag(s, at);
    if (c == '/') {
        i += 1;
        if (i >= s.len or !std.ascii.isAlphabetic(s[i])) return null;
        while (i < s.len and isTagNameChar(s[i])) i += 1;
        while (i < s.len and isAsciiWhitespace(s[i])) i += 1;
        if (i < s.len and s[i] == '>') return i + 1;
        return null;
    }
    if (c == '?') {
        const close = std.mem.indexOfPos(u8, s, i + 1, "?>") orelse return null;
        return @intCast(close + 2);
    }
    if (c == '!') {
        i += 1;
        if (std.mem.startsWith(u8, s[i..], "--")) {
            const body = i + 2;
            if (std.mem.startsWith(u8, s[body..], ">")) return body + 1;
            if (std.mem.startsWith(u8, s[body..], "->")) return body + 2;
            const close = std.mem.indexOfPos(u8, s, body, "-->") orelse return null;
            return @intCast(close + 3);
        }
        if (std.mem.startsWith(u8, s[i..], "[CDATA[")) {
            const close = std.mem.indexOfPos(u8, s, i + 7, "]]>") orelse return null;
            return @intCast(close + 3);
        }
        if (i < s.len and std.ascii.isAlphabetic(s[i])) {
            const close = std.mem.indexOfScalarPos(u8, s, i, '>') orelse return null;
            return @intCast(close + 1);
        }
    }
    return null;
}

/// `<tag attr="v"... />`; also used by HTML block type 7 (whole-line check by the caller).
pub fn scanOpenTag(s: []const u8, at: u32) ?u32 {
    var i = at + 1;
    if (i >= s.len or !std.ascii.isAlphabetic(s[i])) return null;
    while (i < s.len and isTagNameChar(s[i])) i += 1;
    while (true) {
        const space_start = i;
        while (i < s.len and isAsciiWhitespace(s[i])) i += 1;
        if (i >= s.len) return null;
        if (s[i] == '>') return i + 1;
        if (s[i] == '/') {
            if (i + 1 < s.len and s[i + 1] == '>') return i + 2;
            return null;
        }
        if (i == space_start) return null;
        // Attribute name.
        if (!(std.ascii.isAlphabetic(s[i]) or s[i] == '_' or s[i] == ':')) return null;
        i += 1;
        while (i < s.len and (std.ascii.isAlphanumeric(s[i]) or s[i] == '_' or s[i] == '.' or s[i] == ':' or s[i] == '-')) i += 1;
        // Optional value.
        var j = i;
        while (j < s.len and isAsciiWhitespace(s[j])) j += 1;
        if (j < s.len and s[j] == '=') {
            j += 1;
            while (j < s.len and isAsciiWhitespace(s[j])) j += 1;
            if (j >= s.len) return null;
            const q = s[j];
            if (q == '"' or q == '\'') {
                const close = std.mem.indexOfScalarPos(u8, s, j + 1, q) orelse return null;
                i = @intCast(close + 1);
            } else {
                const value_start = j;
                while (j < s.len and !isAsciiWhitespace(s[j]) and std.mem.indexOfScalar(u8, "\"'=<>`", s[j]) == null) j += 1;
                if (j == value_start) return null;
                i = j;
            }
        }
    }
}

pub const Entity = struct { end: u32 };

pub fn scanEntity(s: []const u8, at: u32) ?Entity {
    var i = at + 1;
    if (i >= s.len) return null;
    if (s[i] == '#') {
        i += 1;
        var digits: u32 = 0;
        if (i < s.len and (s[i] == 'x' or s[i] == 'X')) {
            i += 1;
            while (i < s.len and std.ascii.isHex(s[i]) and digits < 7) : (digits += 1) i += 1;
            if (digits == 0 or digits > 6) return null;
        } else {
            while (i < s.len and std.ascii.isDigit(s[i]) and digits < 8) : (digits += 1) i += 1;
            if (digits == 0 or digits > 7) return null;
        }
        if (i < s.len and s[i] == ';') return .{ .end = i + 1 };
        return null;
    }
    const name_start = i;
    while (i < s.len and std.ascii.isAlphanumeric(s[i]) and i - name_start < 32) i += 1;
    if (i == name_start or i >= s.len or s[i] != ';') return null;
    if (lookupEntity(s[name_start..i]) == null) return null;
    return .{ .end = i + 1 };
}

/// The code points an entity reference `&...;` stands for (the second is 0 when absent).
pub fn decodeEntity(reference: []const u8) [2]u21 {
    assert(reference.len >= 3 and reference[0] == '&' and reference[reference.len - 1] == ';');
    const body = reference[1 .. reference.len - 1];
    if (body[0] == '#') {
        const hex = body.len > 1 and (body[1] == 'x' or body[1] == 'X');
        const digits = if (hex) body[2..] else body[1..];
        const value = std.fmt.parseInt(u32, digits, if (hex) 16 else 10) catch 0;
        if (value == 0 or value > 0x10ffff or (value >= 0xd800 and value <= 0xdfff)) return .{ 0xfffd, 0 };
        return .{ @intCast(value), 0 };
    }
    return lookupEntity(body).?;
}

fn lookupEntity(name: []const u8) ?[2]u21 {
    // A linear walk: entity references are rare, and the blob has no index.
    const blob = tables.entity_names;
    var index: usize = 0;
    var start: usize = 0;
    while (start < blob.len) {
        const end = std.mem.indexOfScalarPos(u8, blob, start, 0).?;
        const entry = blob[start..end];
        if (std.mem.eql(u8, entry, name)) return tables.entity_code_points[index];
        index += 1;
        start = end + 1;
    }
    return null;
}

fn isExtendedBoundary(c: u8) bool {
    return isAsciiWhitespace(c) or c == '*' or c == '_' or c == '~' or c == '(';
}

/// The end of a GFM extended www or URL autolink starting at `at`.
fn scanExtendedUrl(s: []const u8, at: u32) ?u32 {
    // Domain: segments of alphanumerics, '_' and '-' separated by periods; at least one period
    // for www; no '_' in the last two segments.
    var i = at;
    var segments: u32 = 0;
    var underscore_last: bool = false;
    var underscore_previous: bool = false;
    while (i < s.len) {
        const segment_start = i;
        var underscore = false;
        while (i < s.len and (std.ascii.isAlphanumeric(s[i]) or s[i] == '-' or s[i] == '_' or s[i] >= 0x80)) {
            if (s[i] == '_') underscore = true;
            i += 1;
        }
        if (i == segment_start) break;
        segments += 1;
        underscore_previous = underscore_last;
        underscore_last = underscore;
        if (i < s.len and s[i] == '.' and i + 1 < s.len and (std.ascii.isAlphanumeric(s[i + 1]) or s[i + 1] == '-' or s[i + 1] == '_' or s[i + 1] >= 0x80)) {
            i += 1;
            continue;
        }
        break;
    }
    if (segments == 0 or underscore_last or underscore_previous) return null;
    if (std.mem.startsWith(u8, s[at..], "www.") and segments < 2) return null;
    // Path: until whitespace or '<'.
    while (i < s.len and !isAsciiWhitespace(s[i]) and s[i] != '<') i += 1;
    return trimExtendedEnd(s, at, i);
}

/// GFM's trailing punctuation and parenthesis rules.
fn trimExtendedEnd(s: []const u8, start: u32, end_initial: u32) u32 {
    var end = end_initial;
    while (end > start) {
        const c = s[end - 1];
        if (std.mem.indexOfScalar(u8, "?!.,:*_~'\"", c) != null) {
            end -= 1;
            continue;
        }
        if (c == ')') {
            var open: u32 = 0;
            var close: u32 = 0;
            for (s[start..end]) |x| {
                if (x == '(') open += 1;
                if (x == ')') close += 1;
            }
            if (close > open) {
                end -= 1;
                continue;
            }
            break;
        }
        if (c == ';') {
            // An entity-like `&name;` at the end is not part of the link.
            var j = end - 1;
            while (j > start and std.ascii.isAlphanumeric(s[j - 1])) j -= 1;
            if (j > start and s[j - 1] == '&' and j < end - 1) {
                end = j - 1;
                continue;
            }
            break;
        }
        break;
    }
    return end;
}

/// An email address around the '@' at `at`, inside [run_start, run_end).
fn scanEmail(s: []const u8, run_start: u32, run_end: u32, at: u32) ?[2]u32 {
    var start = at;
    while (start > run_start and (std.ascii.isAlphanumeric(s[start - 1]) or std.mem.indexOfScalar(u8, ".-_+", s[start - 1]) != null)) start -= 1;
    if (start == at) return null;
    var i = at + 1;
    var periods: u32 = 0;
    while (i < run_end and (std.ascii.isAlphanumeric(s[i]) or s[i] == '-' or s[i] == '_' or s[i] == '.')) {
        if (s[i] == '.' and i + 1 < run_end and std.ascii.isAlphanumeric(s[i + 1])) periods += 1;
        i += 1;
    }
    // The last character must not be '-' or '_'; a trailing '.' is punctuation.
    while (i > at + 1 and s[i - 1] == '.') i -= 1;
    if (i == at + 1 or periods == 0) return null;
    if (s[i - 1] == '-' or s[i - 1] == '_') return null;
    return .{ start, i };
}

test "punctuation and whitespace tables" {
    try std.testing.expect(isUnicodePunctuation('!'));
    try std.testing.expect(isUnicodePunctuation(0x2014));
    try std.testing.expect(!isUnicodePunctuation('a'));
    try std.testing.expect(isUnicodeWhitespace(0xa0));
    try std.testing.expect(isUnicodeWhitespace(0x3000));
    try std.testing.expect(lookupEntity("ouml") != null);
    try std.testing.expect(lookupEntity("nosuch") == null);
}
