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
    /// Still on the delimiter stack (it may match a later closer).
    on_stack: bool = true,
    /// Already processed as a closer: processing it again would find nothing new.
    processed: bool = false,
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
    /// The returned slices live until the caller's per-call scratch resets.
    lookup_fn: *const fn (context: *const anyopaque, label: []const u8) ?Link,

    pub fn lookup(self: References, label: []const u8) ?Link {
        return self.lookup_fn(self.context, label);
    }
};

pub const Options = struct {
    math: bool = false,
};

pub const Result = struct {
    content: []const u8,
    tokens: []const Token,
    delimiters: []const Delimiter,
    matches: []const Match,
    links: []const Link,
    /// Text ranges (content offsets) that GFM email autolinks take inside plain text runs.
    emails: []const [2]u32,
    /// A reference candidate found no definition: a later definition may change this leaf.
    unresolved: bool,
};

/// Parses a whole leaf's content. `content` must not end in whitespace the leaf strips (the
/// caller trims it).
pub fn parse(arena: std.mem.Allocator, content: []const u8, references: References, options: Options) error{OutOfMemory}!Result {
    var parser: Parser = .{ .allocator = arena, .references = references, .options = options };
    try parser.feed(content, true);
    return parser.result();
}

pub const Error = error{OutOfMemory};
const StepError = error{ OutOfMemory, NeedMore };

/// CommonMark's inline algorithm, fed a leaf's content as it grows. A construct whose decision
/// needs bytes that have not arrived stops the parse at its start ("need more"), and the next
/// feed starts there again; so the tokens depend on the bytes, never on how they were split.
/// Word-local constructs only run before the trailing word, whose end is not known yet.
pub const Parser = struct {
    allocator: std.mem.Allocator,
    references: References,
    options: Options,
    subject: []const u8 = "",
    final: bool = false,
    /// Tokenizing stops here: the start of the trailing word (and the whitespace after it) until
    /// the content is final.
    limit: u32 = 0,
    /// Start of the subject's trailing run of non-whitespace bytes; its length when it ends in
    /// whitespace.
    tail_run_start: u32 = 0,
    position: u32 = 0,
    tokens: std.ArrayListUnmanaged(Token) = .empty,
    delimiters: std.ArrayListUnmanaged(Delimiter) = .empty,
    matches: std.ArrayListUnmanaged(Match) = .empty,
    links: std.ArrayListUnmanaged(Link) = .empty,
    brackets: std.ArrayListUnmanaged(Bracket) = .empty,
    emails: std.ArrayListUnmanaged([2]u32) = .empty,
    /// Top of the delimiter stack.
    delimiter_top: ?u32 = null,
    delimiter_stack_count: u32 = 0,
    unresolved: bool = false,
    /// After one failed backtick search, the last start of each run length (cmark's rule), so
    /// later openers fail without searching again. Only a final parse fails a search.
    backticks_scanned: bool = false,
    backtick_last_start: [backtick_run_tracked_max + 1]u32 = @splat(0),
    /// A linear search (backtick closer, math closer) that ran out of input: the opener it
    /// belongs to and where it stopped, so the next feed continues instead of starting over.
    search_opener: u32 = std.math.maxInt(u32),
    search_position: u32 = 0,
    /// The first token whose display changed since `takeChanged` (none: nothing changed).
    changed_from: u32 = std.math.maxInt(u32),
    /// Bytes the tokenizer examined (counters; a construct retried after "need more" counts again).
    bytes_scanned: u64 = 0,

    pub fn deinit(self: *Parser) void {
        self.tokens.deinit(self.allocator);
        self.delimiters.deinit(self.allocator);
        self.matches.deinit(self.allocator);
        self.links.deinit(self.allocator);
        self.brackets.deinit(self.allocator);
        self.emails.deinit(self.allocator);
    }

    /// Back to an empty leaf, keeping capacity.
    pub fn reset(self: *Parser) void {
        const kept = Parser{ .allocator = self.allocator, .references = self.references, .options = self.options, .tokens = self.tokens, .delimiters = self.delimiters, .matches = self.matches, .links = self.links, .brackets = self.brackets, .emails = self.emails, .bytes_scanned = self.bytes_scanned };
        self.* = kept;
        self.tokens.clearRetainingCapacity();
        self.delimiters.clearRetainingCapacity();
        self.matches.clearRetainingCapacity();
        self.links.clearRetainingCapacity();
        self.brackets.clearRetainingCapacity();
        self.emails.clearRetainingCapacity();
    }

    /// Continues with `subject`, which extends the previous one. With `final`, the leaf ends:
    /// unmatched openers become literal and emails are found.
    pub fn feed(self: *Parser, subject: []const u8, final: bool) Error!void {
        assert(!self.final);
        // A final feed may drop trailing whitespace that was never tokenized.
        assert(subject.len >= self.position and (final or subject.len >= self.subject.len));
        const previous_len: u32 = @intCast(self.subject.len);
        self.subject = subject;
        self.final = final;
        if (final) {
            self.limit = @intCast(subject.len);
        } else {
            self.updateLimit(previous_len);
        }
        while (self.position < self.limit) {
            const before = self.position;
            self.step() catch |err| switch (err) {
                error.NeedMore => {
                    // A construct that is not a resumable search reads again from its start.
                    if (self.search_opener != self.position) self.bytes_scanned += subject.len - self.position;
                    break;
                },
                error.OutOfMemory => return error.OutOfMemory,
            };
            assert(self.position > before);
        }
        if (!final) return;
        // Brackets still open are literal; closers they held back resolve now; openers left are
        // literal.
        self.brackets.clearRetainingCapacity();
        try self.catchUp();
        while (self.delimiter_top) |top| self.removeDelimiter(top);
        try self.findEmails();
    }

    /// The limit moves to the start of the trailing word; only the bytes added since
    /// `previous_len` are read (a long word arriving byte by byte stays linear).
    fn updateLimit(self: *Parser, previous_len: u32) void {
        const s = self.subject;
        const n: u32 = @intCast(s.len);
        const previous_ended_in_word = self.tail_run_start < previous_len;
        var i = n;
        while (i > previous_len and isAsciiWhitespace(s[i - 1])) i -= 1;
        if (i == previous_len) {
            if (n > previous_len and previous_ended_in_word) self.limit = self.tail_run_start;
            if (n > previous_len) self.tail_run_start = n;
            return;
        }
        var j = i;
        while (j > previous_len and !isAsciiWhitespace(s[j - 1])) j -= 1;
        const word_start = if (j > previous_len or !previous_ended_in_word) j else self.tail_run_start;
        self.limit = word_start;
        self.tail_run_start = if (i == n) word_start else n;
    }

    /// Forgets the first `drop` bytes of the content, which the caller removed; only when
    /// `settled`, so no token or stack entry refers to them.
    pub fn rebase(self: *Parser, drop: u32) void {
        assert(self.settled() and drop <= self.position);
        self.position -= drop;
        self.limit -= drop;
        self.tail_run_start -= drop;
        self.subject = self.subject[0 .. self.subject.len - drop];
        self.tokens.clearRetainingCapacity();
        self.delimiters.clearRetainingCapacity();
        self.matches.clearRetainingCapacity();
        self.links.clearRetainingCapacity();
        self.changed_from = std.math.maxInt(u32);
    }

    pub fn result(self: *const Parser) Result {
        return .{
            .content = self.subject,
            .tokens = self.tokens.items,
            .delimiters = self.delimiters.items,
            .matches = self.matches.items,
            .links = self.links.items,
            .emails = self.emails.items,
            .unresolved = self.unresolved,
        };
    }

    /// The first token whose display changed since the last call, and forgets it.
    pub fn takeChanged(self: *Parser) u32 {
        const changed = self.changed_from;
        self.changed_from = std.math.maxInt(u32);
        return changed;
    }

    /// True when nothing before the next token can change any more: no opener waits on a stack
    /// and no search is pending. A live leaf can then forget its tokens.
    pub fn settled(self: *const Parser) bool {
        return self.delimiter_top == null and self.brackets.items.len == 0 and self.search_opener == std.math.maxInt(u32);
    }

    fn markChanged(self: *Parser, token_index: u32) void {
        self.changed_from = @min(self.changed_from, token_index);
    }

    fn step(self: *Parser) StepError!void {
        const c = self.subject[self.position];
        self.bytes_scanned += 1;
        switch (c) {
            '\n' => try self.newline(),
            '\\' => try self.backslash(),
            '`' => try self.backticks(),
            '*', '_', '~' => try self.delimiter(c),
            '[' => try self.openBracket(1),
            '!' => {
                if (self.position + 1 < self.subject.len and self.subject[self.position + 1] == '[') {
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
            else => try self.plainFrom(self.position),
        }
    }

    fn isSpecial(self: *const Parser, c: u8) bool {
        return switch (c) {
            '\n', '\\', '`', '*', '_', '~', '[', '!', ']', '<', '&', ':', 'w' => true,
            '$' => self.options.math,
            else => false,
        };
    }

    fn plainFrom(self: *Parser, at: u32) Error!void {
        var i = at + 1;
        while (i < self.limit and !self.isSpecial(self.subject[i])) i += 1;
        self.bytes_scanned += i - at - 1;
        try self.text(at, i);
    }

    /// Appends literal text, merging with an adjacent text token.
    fn text(self: *Parser, start: u32, end: u32) Error!void {
        self.position = end;
        if (start == end) return;
        if (self.tokens.items.len > 0) {
            const last_index: u32 = @intCast(self.tokens.items.len - 1);
            const last = &self.tokens.items[last_index];
            if (last.kind == .text and last.end() == start) {
                last.len += end - start;
                self.markChanged(last_index);
                return;
            }
        }
        try self.push(.{ .start = start, .len = end - start, .kind = .text });
    }

    fn push(self: *Parser, token: Token) Error!void {
        self.markChanged(@intCast(self.tokens.items.len));
        try self.tokens.append(self.allocator, token);
        self.enforceTokenLimit();
    }

    /// The token tail is bounded (design, memory model): when the oldest opener still waiting is
    /// `token_count_max` tokens back, it becomes literal text. Whole parses run the same rule.
    fn enforceTokenLimit(self: *Parser) void {
        const count: u32 = @intCast(self.tokens.items.len);
        if (count <= token_count_max) return;
        const oldest_allowed = count - token_count_max;
        while (self.brackets.items.len > 0 and self.brackets.items[0].token_index < oldest_allowed) {
            self.markChanged(self.brackets.items[0].token_index);
            _ = self.brackets.orderedRemove(0);
        }
        while (self.bottomDelimiter()) |bottom| {
            const token_index = self.delimiters.items[bottom].token_index;
            if (token_index >= oldest_allowed) break;
            self.markChanged(token_index);
            self.removeDelimiter(bottom);
        }
    }

    fn bottomDelimiter(self: *const Parser) ?u32 {
        var current = self.delimiter_top orelse return null;
        while (self.delimiters.items[current].previous) |previous| current = previous;
        return current;
    }

    fn newline(self: *Parser) StepError!void {
        const at = self.position;
        // Spaces before the newline: two or more make a hard break; the text loses them.
        var spaces: u32 = 0;
        if (self.tokens.items.len > 0) {
            const last_index: u32 = @intCast(self.tokens.items.len - 1);
            const last = &self.tokens.items[last_index];
            if (last.kind == .text and last.end() == at) {
                while (spaces < last.len and self.subject[at - spaces - 1] == ' ') spaces += 1;
                if (spaces > 0) {
                    last.len -= spaces;
                    self.markChanged(last_index);
                    if (last.len == 0) _ = self.tokens.pop();
                }
            }
        }
        var next = at + 1;
        while (next < self.subject.len and (self.subject[next] == ' ' or self.subject[next] == '\t')) next += 1;
        const kind: TokenKind = if (spaces >= 2) .hard_break else .soft_break;
        try self.push(.{ .start = at - spaces, .len = next - (at - spaces), .kind = kind });
        self.position = next;
    }

    fn backslash(self: *Parser) StepError!void {
        const at = self.position;
        const s = self.subject;
        const n = s.len;
        // Before the limit a backslash has its next byte; at the end of a final leaf it is text.
        if (at + 1 >= n) {
            assert(self.final);
            return self.text(at, at + 1);
        }
        if (s[at + 1] == '\n') {
            var next = at + 2;
            while (next < n and (s[next] == ' ' or s[next] == '\t')) next += 1;
            try self.push(.{ .start = at, .len = next - at, .kind = .hard_break });
            self.position = next;
            return;
        }
        if (self.options.math and s[at + 1] == '(') {
            if (try self.findParenMathClose(at)) |close| {
                try self.push(.{ .start = at, .len = close + 2 - at, .kind = .math, .aux = 2 });
                self.position = close + 2;
                return;
            }
        }
        if (isAsciiPunctuation(s[at + 1])) {
            try self.push(.{ .start = at, .len = 2, .kind = .escape });
            self.position = at + 2;
            return;
        }
        try self.text(at, at + 1);
    }

    /// The `\)` that closes the `\(` at `opener`, null when the content holds none.
    fn findParenMathClose(self: *Parser, opener: u32) StepError!?u32 {
        const s = self.subject;
        const from = opener + 2;
        var i = self.resumeSearch(opener, from);
        while (i + 1 < s.len) : (i += 1) {
            const c = s[i];
            if (c == '\\' and s[i + 1] == ')') {
                self.endSearch();
                return if (i > from) i else null;
            }
            if (c == '\\') i += 1;
        }
        return self.searchRanOut(opener, @min(i, @as(u32, @intCast(s.len -| 1))));
    }

    fn resumeSearch(self: *Parser, opener: u32, from: u32) u32 {
        const start = if (self.search_opener == opener) self.search_position else from;
        self.bytes_scanned += self.subject.len -| start;
        return start;
    }

    fn endSearch(self: *Parser) void {
        self.search_opener = std.math.maxInt(u32);
    }

    /// A search reached the end of the content: final, it failed; otherwise wait for more.
    fn searchRanOut(self: *Parser, opener: u32, position: u32) StepError!?u32 {
        if (self.final) {
            self.endSearch();
            return null;
        }
        self.search_opener = opener;
        self.search_position = position;
        return error.NeedMore;
    }

    fn backticks(self: *Parser) StepError!void {
        const start = self.position;
        const count = runLength(self.subject, start, '`');
        const after = start + count;
        if (try self.findBacktickCloser(start, after, count)) |closer| {
            try self.push(.{ .start = start, .len = closer + count - start, .kind = .code, .aux = @intCast(@min(count, std.math.maxInt(u16))) });
            self.position = closer + count;
            return;
        }
        try self.text(start, after);
    }

    fn findBacktickCloser(self: *Parser, opener: u32, from: u32, count: u32) StepError!?u32 {
        if (self.backticks_scanned and count <= backtick_run_tracked_max and self.backtick_last_start[count] < from) return null;
        const s = self.subject;
        var i = self.resumeSearch(opener, from);
        const n: u32 = @intCast(s.len);
        while (i < n) {
            if (s[i] != '`') {
                i += 1;
                continue;
            }
            const run_length = runLength(s, i, '`');
            // A run that touches the end may still grow.
            if (i + run_length == n and !self.final) return self.searchRanOut(opener, i);
            if (run_length <= backtick_run_tracked_max) self.backtick_last_start[run_length] = i;
            if (run_length == count) {
                self.endSearch();
                return i;
            }
            i += run_length;
        }
        const failed = try self.searchRanOut(opener, i);
        self.backticks_scanned = true;
        return failed;
    }

    fn delimiter(self: *Parser, c: u8) StepError!void {
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
        try self.delimiters.append(self.allocator, .{
            .token_index = token_index,
            .char = c,
            .original_count = count,
            .count = count,
            .can_open = can_open,
            .can_close = can_close,
            .previous = self.delimiter_top,
            .processed = !can_close,
        });
        if (self.delimiter_top) |top| self.delimiters.items[top].next = index;
        self.delimiter_top = index;
        self.delimiter_stack_count += 1;
        // A closer resolves as it arrives unless a bracket that may become a link holds it back:
        // the same matches as processing every closer at the end, in the same order.
        if (can_close and !self.activeBracket()) try self.processEmphasisFrom(index, null);
    }

    fn activeBracket(self: *const Parser) bool {
        for (self.brackets.items) |b| {
            if (b.active) return true;
        }
        return false;
    }

    fn removeDelimiter(self: *Parser, index: u32) void {
        const d = &self.delimiters.items[index];
        // Brackets keep the delimiter below them as their emphasis floor.
        for (self.brackets.items) |*b| {
            if (sameIndex(b.previous_delimiter, index)) b.previous_delimiter = d.previous;
        }
        if (d.previous) |p| self.delimiters.items[p].next = d.next;
        if (d.next) |nx| {
            self.delimiters.items[nx].previous = d.previous;
        } else {
            self.delimiter_top = d.previous;
        }
        d.previous = null;
        d.next = null;
        d.on_stack = false;
        self.delimiter_stack_count -= 1;
        // An opener the display concealed (it could still match) is literal now.
        if (d.can_open and d.count > 0) self.markChanged(d.token_index);
    }

    /// CommonMark's "process emphasis" over the delimiters above `bottom`.
    fn processEmphasis(self: *Parser, bottom: ?u32) Error!void {
        var first: ?u32 = if (sameIndex(self.delimiter_top, bottom)) null else self.delimiter_top;
        while (first) |c| {
            const previous = self.delimiters.items[c].previous;
            if (previous == null or sameIndex(previous, bottom)) break;
            first = previous;
        }
        if (first) |f| try self.processEmphasisFrom(f, bottom);
    }

    /// "Process emphasis" for the closers from `first` up; earlier closers were processed.
    fn processEmphasisFrom(self: *Parser, first: u32, bottom: ?u32) Error!void {
        var closer_option: ?u32 = first;
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
                // The display showed the opener as closed by this kind already (optimistic) only
                // when this match uses all of it with the kind its length implied.
                if (opener.count != used or opener.opener_matches != null or kind != optimisticKind(opener.char, opener.original_count)) {
                    self.markChanged(opener.token_index);
                }
                opener.count -= used;
                closer.count -= used;
                self.markChanged(closer.token_index);
                try self.addMatch(opener_index, closer_index, kind, used);
                // Delimiters between opener and closer become literal.
                var between = self.delimiters.items[closer_index].previous;
                while (between) |b| {
                    if (b == opener_index) break;
                    const previous = self.delimiters.items[b].previous;
                    self.removeDelimiter(b);
                    between = previous;
                }
                if (self.delimiters.items[opener_index].count == 0) self.removeDelimiter(opener_index);
                if (self.delimiters.items[closer_index].count == 0) {
                    const next = self.delimiters.items[closer_index].next;
                    self.removeDelimiter(closer_index);
                    closer_option = next;
                }
            } else {
                const next = closer.next;
                closer.processed = true;
                if (!closer.can_open) self.removeDelimiter(closer_index);
                closer_option = next;
            }
        }
    }

    fn addMatch(self: *Parser, opener_index: u32, closer_index: u32, kind: MatchKind, count: u32) Error!void {
        const index: u32 = @intCast(self.matches.items.len);
        try self.matches.append(self.allocator, .{ .kind = kind, .count = count, .next_for_opener = self.delimiters.items[opener_index].opener_matches });
        self.delimiters.items[opener_index].opener_matches = index;
        const closer = &self.delimiters.items[closer_index];
        if (closer.closer_match_count == 0) closer.closer_first_match = index;
        assert(closer.closer_first_match + closer.closer_match_count == index);
        closer.closer_match_count += 1;
    }

    fn openBracket(self: *Parser, len: u32) Error!void {
        const start = self.position;
        const token_index: u32 = @intCast(self.tokens.items.len);
        try self.push(.{ .start = start, .len = len, .kind = .bracket_open });
        self.position = start + len;
        if (self.brackets.items.len >= bracket_count_max) return;
        if (self.brackets.items.len > 0) self.brackets.items[self.brackets.items.len - 1].bracket_after = true;
        try self.brackets.append(self.allocator, .{
            .token_index = token_index,
            .image = len == 2,
            .active = true,
            .bracket_after = false,
            .previous_delimiter = self.delimiter_top,
        });
    }

    fn closeBracket(self: *Parser) StepError!void {
        const start = self.position;
        const after = start + 1;
        if (self.brackets.items.len == 0) return self.literalClose(start);
        const bracket = self.brackets.items[self.brackets.items.len - 1];
        if (!bracket.active) {
            _ = self.brackets.pop();
            return self.literalClose(start);
        }
        // Decide before changing anything: a tail that runs out of input retries this `]`.
        var link: ?Link = null;
        var end = after;
        if (try self.inlineTail(after)) |tail| {
            link = .{ .image = bracket.image, .destination = tail.destination, .title = tail.title };
            end = tail.end;
        } else {
            const opener_token = self.tokens.items[bracket.token_index];
            const inner = self.subject[opener_token.end()..start];
            var label: ?[]const u8 = null;
            const label_len = try scanLinkLabel(self.subject, after, self.final);
            if (label_len > 2) {
                label = self.subject[after + 1 .. after + label_len - 1];
                end = after + label_len;
            } else if (!bracket.bracket_after) {
                label = inner;
                if (label_len == 2) end = after + 2;
            }
            if (label) |l| {
                if (isValidLabel(l)) {
                    if (self.references.lookup(l)) |found| {
                        link = .{ .image = bracket.image, .destination = found.destination, .title = found.title };
                    } else {
                        self.unresolved = true;
                    }
                }
            }
            if (link == null) end = after;
        }
        _ = self.brackets.pop();
        const l = link orelse return self.literalClose(start);
        const link_index: u32 = @intCast(self.links.items.len);
        try self.links.append(self.allocator, l);
        self.tokens.items[bracket.token_index].aux = @intCast(link_index + 1);
        self.markChanged(bracket.token_index);
        try self.push(.{ .start = start, .len = end - start, .kind = .bracket_close, .aux = @intCast(link_index + 1) });
        self.position = end;
        try self.processEmphasis(bracket.previous_delimiter);
        // processEmphasis(bottom) drops the delimiters inside the link text.
        while (self.delimiter_top) |top| {
            if (sameIndex(top, bracket.previous_delimiter)) break;
            self.removeDelimiter(top);
        }
        if (!bracket.image) {
            for (self.brackets.items) |*b| {
                if (!b.image) b.active = false;
            }
        }
        try self.catchUp();
    }

    fn literalClose(self: *Parser, start: u32) Error!void {
        try self.push(.{ .start = start, .len = 1, .kind = .bracket_close });
        self.position = start + 1;
        try self.catchUp();
    }

    /// Closers held back by a bracket that turned out literal resolve once no active bracket is
    /// left, before any later closer.
    fn catchUp(self: *Parser) Error!void {
        if (self.activeBracket()) return;
        var first: ?u32 = self.delimiter_top;
        var pending: ?u32 = null;
        while (first) |c| {
            if (!self.delimiters.items[c].processed) pending = c;
            first = self.delimiters.items[c].previous;
        }
        if (pending) |p| try self.processEmphasisFrom(p, null);
    }

    const Tail = struct { destination: []const u8, title: ?[]const u8, end: u32 };

    /// `(destination "title")` right after `]`.
    fn inlineTail(self: *Parser, at: u32) StepError!?Tail {
        const s = self.subject;
        const final = self.final;
        if (at >= s.len) return if (final) null else error.NeedMore;
        if (s[at] != '(') return null;
        var i = (try skipSpaceNewline(s, at + 1, final)) orelse return null;
        var destination: []const u8 = "";
        if (i < s.len and s[i] != ')') {
            const d = (try scanDestination(s, i, final)) orelse return null;
            destination = d.value;
            i = d.end;
        }
        var title: ?[]const u8 = null;
        const before_title = i;
        i = (try skipSpaceNewline(s, i, final)) orelse return null;
        if (i > before_title and i < s.len) {
            if (try scanTitle(s, i, final)) |t| {
                title = t.value;
                i = (try skipSpaceNewline(s, t.end, final)) orelse return null;
            }
        }
        if (i >= s.len) return if (final) null else error.NeedMore;
        if (s[i] == ')') return .{ .destination = destination, .title = title, .end = i + 1 };
        return null;
    }

    fn lessThan(self: *Parser) StepError!void {
        const start = self.position;
        if (scanAutolink(self.subject, start)) |a| {
            try self.push(.{ .start = start, .len = a.end - start, .kind = if (a.email) .autolink_email else .autolink });
            self.position = a.end;
            return;
        }
        if (try scanHtmlTag(self.subject, start, self.final)) |end| {
            try self.push(.{ .start = start, .len = end - start, .kind = .html });
            self.position = end;
            return;
        }
        try self.text(start, start + 1);
    }

    fn entity(self: *Parser) Error!void {
        const start = self.position;
        if (scanEntity(self.subject, start)) |e| {
            try self.push(.{ .start = start, .len = e.end - start, .kind = .entity });
            self.position = e.end;
            return;
        }
        try self.text(start, start + 1);
    }

    fn dollar(self: *Parser) StepError!void {
        const s = self.subject;
        const start = self.position;
        if (!self.options.math) return self.text(start, start + 1);
        const dollars = runLength(s, start, '$');
        if (dollars != 1) return self.text(start, start + dollars);
        const before_digit = start > 0 and std.ascii.isDigit(s[start - 1]);
        const next = start + 1;
        if (before_digit or next >= s.len or isAsciiWhitespace(s[next])) return self.text(start, next);
        // The closer is the next unescaped `$` that has a non-space before it and no digit after
        // it; a `$` that cannot close, a backtick or a blank line gives the opener up.
        var i = self.resumeSearch(start, next);
        while (true) {
            if (i >= s.len) {
                _ = try self.searchRanOut(start, i);
                break;
            }
            const c = s[i];
            if (c == '\\') {
                if (i + 1 >= s.len) {
                    _ = try self.searchRanOut(start, i);
                    break;
                }
                i += 2;
                continue;
            }
            if (c == '`' or (c == '\n' and i + 1 < s.len and s[i + 1] == '\n')) {
                self.endSearch();
                break;
            }
            if (c != '$') {
                i += 1;
                continue;
            }
            if (i + 1 >= s.len and !self.final) {
                _ = try self.searchRanOut(start, i);
                unreachable;
            }
            self.endSearch();
            const closes = !isAsciiWhitespace(s[i - 1]) and (i + 1 >= s.len or (!std.ascii.isDigit(s[i + 1]) and s[i + 1] != '$'));
            if (!closes) break;
            try self.push(.{ .start = start, .len = i + 1 - start, .kind = .math, .aux = 1 });
            self.position = i + 1;
            return;
        }
        try self.text(start, next);
    }

    /// GFM extended URL autolinks: at ':' the scheme is the end of the text before it.
    fn scheme(self: *Parser) Error!void {
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
        return scanExtendedUrl(s, at + 3);
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

    fn www(self: *Parser) Error!void {
        const at = self.position;
        const s = self.subject;
        const boundary = at == 0 or isExtendedBoundary(s[at - 1]);
        if (boundary and at + 4 <= s.len and std.mem.eql(u8, s[at .. at + 4], "www.")) {
            if (scanExtendedUrl(s, at)) |end| return self.extended(at, end, .www);
        }
        try self.plainFrom(at);
    }

    fn extended(self: *Parser, start: u32, end: u32, kind: ExtendedKind) Error!void {
        // The scheme letters were text: take them back.
        if (self.tokens.items.len > 0) {
            const last_index: u32 = @intCast(self.tokens.items.len - 1);
            const last = &self.tokens.items[last_index];
            if (last.kind == .text and last.end() > start) {
                last.len = start - last.start;
                self.markChanged(last_index);
                if (last.len == 0) _ = self.tokens.pop();
            }
        }
        try self.push(.{ .start = start, .len = end - start, .kind = .extended_autolink, .aux = @backingInt(kind) });
        self.position = end;
    }

    /// GFM email autolinks inside plain text runs (cmark-gfm finds them after inline parsing).
    fn findEmails(self: *Parser) Error!void {
        const s = self.subject;
        var i: u32 = 0;
        const count: u32 = @intCast(self.tokens.items.len);
        while (i < count) {
            if (!self.isPlain(i)) {
                i += 1;
                continue;
            }
            var j = i;
            while (j + 1 < count and self.isPlain(j + 1) and self.tokens.items[j + 1].start == self.tokens.items[j].end()) j += 1;
            const run_start = self.tokens.items[i].start;
            const run_end = self.tokens.items[j].end();
            var k = run_start;
            while (k < run_end) : (k += 1) {
                if (s[k] != '@') continue;
                if (scanEmail(s, run_start, run_end, k)) |email| {
                    if (email[0] > run_start and s[email[0] - 1] == ':') continue;
                    try self.emails.append(self.allocator, email);
                    k = email[1];
                }
            }
            i = j + 1;
        }
    }

    /// Text, or a delimiter run that matched nothing (final: the stacks are empty).
    fn isPlain(self: *const Parser, index: u32) bool {
        const token = self.tokens.items[index];
        return switch (token.kind) {
            .text => true,
            .delimiter => if (delimiterOf(self.result(), index)) |d| self.delimiters.items[d].opener_matches == null and self.delimiters.items[d].closer_match_count == 0 else true,
            else => false,
        };
    }
};

/// The delimiter-stack entry of token `index`, if it ever had one (entries are in token order).
pub fn delimiterOf(r: Result, index: u32) ?u32 {
    var low: usize = 0;
    var high: usize = r.delimiters.len;
    while (low < high) {
        const mid = (low + high) / 2;
        const t = r.delimiters[mid].token_index;
        if (t == index) return @intCast(mid);
        if (t < index) low = mid + 1 else high = mid;
    }
    return null;
}

fn optimisticKind(c: u8, count: u32) MatchKind {
    if (c == '~') return .strikethrough;
    return if (count >= 2) .strong else .emphasis;
}

/// The start of the trailing word and the whitespace after it: constructs that cannot cross
/// whitespace are decided for every byte before it.
fn trailingWordStart(s: []const u8) u32 {
    var i: usize = s.len;
    while (i > 0 and isAsciiWhitespace(s[i - 1])) i -= 1;
    while (i > 0 and !isAsciiWhitespace(s[i - 1])) i -= 1;
    return @intCast(i);
}

/// Display bytes of token `index` (read_leaf's text; the live display conceals an opener that
/// still waits on the stack, as if it were closed: D93 Q4 B).
pub fn tokenDisplayLength(r: Result, index: u32) u32 {
    const t = r.tokens[index];
    return switch (t.kind) {
        .text, .html, .extended_autolink => t.len,
        .escape => 1,
        .entity => blk: {
            const cps = decodeEntity(r.content[t.start..t.end()]);
            var n: u32 = std.unicode.utf8CodepointSequenceLength(cps[0]) catch 3;
            if (cps[1] != 0) n += std.unicode.utf8CodepointSequenceLength(cps[1]) catch 3;
            break :blk n;
        },
        .soft_break, .hard_break => 1,
        .code => @intCast(codeSpanBody(r.content[t.start + t.aux .. t.end() - t.aux]).len),
        .autolink, .autolink_email => t.len - 2,
        .math => t.len - 2 * t.aux,
        .bracket_open => if (t.aux != 0) 0 else t.len,
        .bracket_close => if (t.aux != 0) 0 else 1,
        .delimiter => blk: {
            const d = r.delimiters[delimiterOf(r, index) orelse break :blk t.len];
            if (d.on_stack and d.can_open) break :blk 0;
            break :blk d.count;
        },
    };
}

/// Appends the display bytes of token `index` (the bytes `tokenDisplayLength` counts).
pub fn appendTokenDisplay(r: Result, index: u32, allocator: std.mem.Allocator, out: *std.ArrayListUnmanaged(u8)) error{OutOfMemory}!void {
    const t = r.tokens[index];
    const raw = r.content[t.start..t.end()];
    switch (t.kind) {
        .text, .html, .extended_autolink => try out.appendSlice(allocator, raw),
        .escape => try out.append(allocator, raw[1]),
        .entity => {
            const cps = decodeEntity(raw);
            var buffer: [8]u8 = undefined;
            var n = std.unicode.utf8Encode(cps[0], &buffer) catch 0;
            if (cps[1] != 0) n += std.unicode.utf8Encode(cps[1], buffer[n..]) catch 0;
            try out.appendSlice(allocator, buffer[0..n]);
        },
        .soft_break, .hard_break => try out.append(allocator, '\n'),
        .code => {
            const body = codeSpanBody(raw[t.aux .. raw.len - t.aux]);
            const start = out.items.len;
            try out.appendSlice(allocator, body);
            for (out.items[start..]) |*c| {
                if (c.* == '\n') c.* = ' ';
            }
        },
        .autolink, .autolink_email => try out.appendSlice(allocator, raw[1 .. raw.len - 1]),
        .math => try out.appendSlice(allocator, raw[t.aux .. raw.len - t.aux]),
        .bracket_open, .bracket_close => if (t.aux == 0) try out.appendSlice(allocator, raw[0..@min(raw.len, if (t.kind == .bracket_close) 1 else raw.len)]),
        .delimiter => {
            const length = tokenDisplayLength(r, index);
            // Unmatched characters are the outer ones: an opener's first, a closer's last.
            const d = delimiterOf(r, index);
            const closer = if (d) |i| r.delimiters[i].closer_match_count > 0 else false;
            try out.appendSlice(allocator, if (closer) raw[raw.len - length ..] else raw[0..length]);
        },
    }
}

/// Backslash escapes and entity references resolved (link destinations, titles, info strings).
pub fn unescapeText(arena: std.mem.Allocator, raw: []const u8) error{OutOfMemory}![]const u8 {
    if (std.mem.indexOfAny(u8, raw, "\\&") == null) return raw;
    var out: std.ArrayListUnmanaged(u8) = .empty;
    var i: u32 = 0;
    while (i < raw.len) {
        const c = raw[i];
        if (c == '\\' and i + 1 < raw.len and isAsciiPunctuation(raw[i + 1])) {
            try out.append(arena, raw[i + 1]);
            i += 2;
            continue;
        }
        if (c == '&') {
            if (scanEntity(raw, i)) |e| {
                const cps = decodeEntity(raw[i..e.end]);
                var buffer: [8]u8 = undefined;
                var n = std.unicode.utf8Encode(cps[0], &buffer) catch 0;
                if (cps[1] != 0) n += std.unicode.utf8Encode(cps[1], buffer[n..]) catch 0;
                try out.appendSlice(arena, buffer[0..n]);
                i = e.end;
                continue;
            }
        }
        try out.append(arena, c);
        i += 1;
    }
    return out.items;
}

/// A code span's content without the one space stripped from each end (line endings count as
/// spaces, so the length is the same).
pub fn codeSpanBody(raw: []const u8) []const u8 {
    if (raw.len >= 2 and (raw[0] == ' ' or raw[0] == '\n') and (raw[raw.len - 1] == ' ' or raw[raw.len - 1] == '\n')) {
        for (raw) |c| {
            if (c != ' ' and c != '\n') return raw[1 .. raw.len - 1];
        }
    }
    return raw;
}

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

/// Where a scan ran out of content: a final content fails it, a growing one asks for more.
fn ranOut(comptime T: type, final: bool) error{NeedMore}!?T {
    if (final) return null;
    return error.NeedMore;
}

/// Spaces and tabs with at most one line ending among them.
fn skipSpaceNewline(s: []const u8, at: u32, final: bool) error{NeedMore}!?u32 {
    var i = at;
    var newlines: u32 = 0;
    while (i < s.len) : (i += 1) {
        switch (s[i]) {
            ' ', '\t' => {},
            '\n' => {
                newlines += 1;
                if (newlines > 1) return null;
            },
            else => return i,
        }
    }
    if (!final) return error.NeedMore;
    return i;
}

pub const Scanned = struct { value: []const u8, end: u32 };

pub fn scanDestination(s: []const u8, at: u32, final: bool) error{NeedMore}!?Scanned {
    if (at >= s.len) return ranOut(Scanned, final);
    if (s[at] == '<') {
        var i = at + 1;
        while (i < s.len) : (i += 1) {
            switch (s[i]) {
                '\\' => {
                    if (i + 1 >= s.len) return ranOut(Scanned, final);
                    if (isAsciiPunctuation(s[i + 1])) i += 1;
                },
                '\n', '<' => return null,
                '>' => return .{ .value = s[at + 1 .. i], .end = i + 1 },
                else => {},
            }
        }
        return ranOut(Scanned, final);
    }
    var i = at;
    var depth: u32 = 0;
    while (i < s.len) : (i += 1) {
        const c = s[i];
        if (c == '\\') {
            if (i + 1 >= s.len) return ranOut(Scanned, final);
            if (isAsciiPunctuation(s[i + 1])) {
                i += 1;
                continue;
            }
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
    } else {
        // A destination that reaches the end may still grow.
        if (!final) return error.NeedMore;
    }
    if (i == at or depth != 0) return null;
    return .{ .value = s[at..i], .end = i };
}

pub fn scanTitle(s: []const u8, at: u32, final: bool) error{NeedMore}!?Scanned {
    if (at >= s.len) return ranOut(Scanned, final);
    const close: u8 = switch (s[at]) {
        '"' => '"',
        '\'' => '\'',
        '(' => ')',
        else => return null,
    };
    var i = at + 1;
    while (i < s.len) : (i += 1) {
        const c = s[i];
        if (c == '\\') {
            if (i + 1 >= s.len) return ranOut(Scanned, final);
            if (isAsciiPunctuation(s[i + 1])) {
                i += 1;
                continue;
            }
        }
        if (c == close) return .{ .value = s[at + 1 .. i], .end = i + 1 };
        if (close == ')' and c == '(') return null;
        if (c == '\n' and i + 1 < s.len and s[i + 1] == '\n') return null;
    }
    return ranOut(Scanned, final);
}

/// Length of `[label]` at `at` (2 for `[]`), or 0.
pub fn scanLinkLabel(s: []const u8, at: u32, final: bool) error{NeedMore}!u32 {
    if (at >= s.len) return if (final) 0 else error.NeedMore;
    if (s[at] != '[') return 0;
    var i = at + 1;
    while (i < s.len) : (i += 1) {
        const c = s[i];
        if (i - at - 1 > label_byte_count_max) return 0;
        if (c == '\\') {
            if (i + 1 >= s.len) break;
            if (isAsciiPunctuation(s[i + 1])) {
                i += 1;
                continue;
            }
        }
        if (c == '[') return 0;
        if (c == ']') return i + 1 - at;
    }
    return if (final) 0 else error.NeedMore;
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
pub fn scanHtmlTag(s: []const u8, at: u32, final: bool) error{NeedMore}!?u32 {
    var i = at + 1;
    if (i >= s.len) return ranOut(u32, final);
    const c = s[i];
    if (std.ascii.isAlphabetic(c)) return scanOpenTag(s, at, final);
    if (c == '/') {
        i += 1;
        if (i >= s.len) return ranOut(u32, final);
        if (!std.ascii.isAlphabetic(s[i])) return null;
        while (i < s.len and isTagNameChar(s[i])) i += 1;
        while (i < s.len and isAsciiWhitespace(s[i])) i += 1;
        if (i >= s.len) return ranOut(u32, final);
        if (s[i] == '>') return i + 1;
        return null;
    }
    if (c == '?') return findAfter(s, i + 1, "?>", final);
    if (c == '!') {
        i += 1;
        const rest = s[i..];
        if (startsOrPrefix(rest, "--")) |complete| {
            if (!complete) return ranOut(u32, final);
            const body = i + 2;
            if (body >= s.len) return ranOut(u32, final);
            if (s[body] == '>') return body + 1;
            if (s[body] == '-') {
                if (body + 1 >= s.len) return ranOut(u32, final);
                if (s[body + 1] == '>') return body + 2;
            }
            return findAfter(s, body, "-->", final);
        }
        if (startsOrPrefix(rest, "[CDATA[")) |complete| {
            if (!complete) return ranOut(u32, final);
            return findAfter(s, i + 7, "]]>", final);
        }
        if (rest.len == 0) return ranOut(u32, final);
        if (std.ascii.isAlphabetic(rest[0])) return findAfter(s, i, ">", final);
    }
    return null;
}

/// True when `rest` starts with `needle`, false when it is a shorter prefix of it, null otherwise.
fn startsOrPrefix(rest: []const u8, needle: []const u8) ?bool {
    if (rest.len >= needle.len) return if (std.mem.startsWith(u8, rest, needle)) true else null;
    return if (std.mem.startsWith(u8, needle, rest)) false else null;
}

/// The end of the first `needle` at or after `from`.
fn findAfter(s: []const u8, from: u32, needle: []const u8, final: bool) error{NeedMore}!?u32 {
    const close = std.mem.indexOfPos(u8, s, from, needle) orelse return ranOut(u32, final);
    return @intCast(close + needle.len);
}

/// `<tag attr="v"... />`; also used by HTML block type 7 (whole-line check by the caller).
pub fn scanOpenTag(s: []const u8, at: u32, final: bool) error{NeedMore}!?u32 {
    var i = at + 1;
    if (i >= s.len) return ranOut(u32, final);
    if (!std.ascii.isAlphabetic(s[i])) return null;
    while (i < s.len and isTagNameChar(s[i])) i += 1;
    while (true) {
        const space_start = i;
        while (i < s.len and isAsciiWhitespace(s[i])) i += 1;
        if (i >= s.len) return ranOut(u32, final);
        if (s[i] == '>') return i + 1;
        if (s[i] == '/') {
            if (i + 1 >= s.len) return ranOut(u32, final);
            if (s[i + 1] == '>') return i + 2;
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
        if (j >= s.len) return ranOut(u32, final);
        if (s[j] == '=') {
            j += 1;
            while (j < s.len and isAsciiWhitespace(s[j])) j += 1;
            if (j >= s.len) return ranOut(u32, final);
            const q = s[j];
            if (q == '"' or q == '\'') {
                const close = std.mem.indexOfScalarPos(u8, s, j + 1, q) orelse return ranOut(u32, final);
                i = @intCast(close + 1);
            } else {
                const value_start = j;
                while (j < s.len and !isAsciiWhitespace(s[j]) and std.mem.indexOfScalar(u8, "\"'=<>`", s[j]) == null) j += 1;
                if (j == value_start) return null;
                if (j >= s.len) return ranOut(u32, final);
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
