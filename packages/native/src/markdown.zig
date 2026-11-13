//! The native Markdown engine (tracks/native-markdown-parser.md): one streaming CommonMark 0.31.2
//! and GFM parser whose state is the appended source plus a preorder block table. Nothing in the
//! bindings reaches it yet (step M1); M2 adds the ABI.
//!
//! The block parser consumes complete lines only; the bytes after the last line ending are the
//! pending line. A leaf's content (its lines without container prefixes) is never stored: it is
//! derived again from `source` and the leaf's ancestors whenever a reader needs it.
const std = @import("std");
const assert = std.debug.assert;
const Allocator = std.mem.Allocator;
const inline_parser = @import("markdown-inline.zig");
const tables = @import("markdown-tables.zig");

/// Static limits (design, memory model). `Limits` may lower them for one document.
pub const source_byte_count_max: u32 = 64 << 20;
pub const block_count_max: u32 = 1 << 20;
pub const depth_max: u32 = 32;
pub const definition_count_max: u32 = 4096;
pub const table_column_count_max: u32 = 128;
/// B holds a paragraph line with a pipe (it may become a table header) only while it has at most
/// this many bytes (from its content start to its end): a longer line shows as text, so the hold
/// keeps at most this many bytes' tokens. The finished parse has no such limit (GFM).
pub const held_line_byte_count_max: u32 = 4096;
pub const hook_filter_byte_count_max: u32 = 256;
pub const hook_filter_item_byte_count_max: u32 = 64;
/// Filter items at most: each is searched in every new byte (the filter's work bound).
pub const hook_filter_item_count_max: u32 = 16;
/// Retained capacity of the per-call scratch arena.
pub const scratch_retained_byte_count_max: usize = 1 << 20;

pub const none: u32 = std.math.maxInt(u32);

pub const Kind = enum(u8) { paragraph, heading, code, html, rule, table, table_row, table_cell, quote, list, item };

pub const Flags = packed struct(u16) {
    open: bool = false,
    /// The closing delimiter arrived (fences and math blocks; rule 3).
    closed: bool = false,
    unresolved: bool = false,
    hooked: bool = false,
    unreported: bool = false,
    setext: bool = false,
    ordered: bool = false,
    tight: bool = false,
    task: bool = false,
    checked: bool = false,
    blank_after: bool = false,
    fenced: bool = false,
    math: bool = false,
    /// A table's header row.
    header: bool = false,
    /// The pending line's layout ends this open paragraph (it is shown as closed).
    ending: bool = false,
    _unused: u1 = 0,
};

/// One block, 32 bytes. `small` holds a fence's or math block's opener indent and an HTML
/// block's type; `payload` is per kind: heading [level, -], fence [info start, info end], list
/// [start number, marker byte], item [content indent, -], table [column count, delimiter row
/// start], table cell [column, its `Alignment`].
pub const Block = extern struct {
    parent_index: u32,
    kind: Kind,
    small: u8 = 0,
    flags: Flags = .{},
    source_start_byte: u32,
    source_end_byte: u32,
    content_start_byte: u32,
    content_end_byte: u32,
    payload: [2]u32 = .{ 0, 0 },
};

comptime {
    assert(@sizeOf(Block) == 32);
}

/// A link reference definition: offsets into `source`, 32 bytes. Its label and title may span
/// lines, so `parent_index` names the container whose prefixes they carry.
pub const Definition = extern struct {
    label_hash: u32,
    label_start_byte: u32,
    label_end_byte: u32,
    destination_start_byte: u32,
    destination_end_byte: u32,
    title_start_byte: u32,
    title_end_byte: u32,
    parent_index: u32,
};

comptime {
    assert(@sizeOf(Definition) == 32);
}

pub const Limits = struct {
    source_byte_count: u32 = source_byte_count_max,
    block_count: u32 = block_count_max,
    definition_count: u32 = definition_count_max,
    depth: u32 = depth_max,

    fn assertValid(self: Limits) void {
        assert(self.source_byte_count <= source_byte_count_max);
        assert(self.block_count <= block_count_max);
        assert(self.definition_count <= definition_count_max);
        assert(self.depth >= 1 and self.depth <= depth_max);
    }
};

pub const Options = struct {
    math: bool = false,
    limits: Limits = .{},
    /// NUL-separated substrings; a leaf whose source holds one latches `HOOKED`.
    hook_filter: []const u8 = "",
    hook: bool = false,
    /// read_leaf hides markers. Off, a leaf shows its source, styled (M2 writes such leaves
    /// from the host; the live display always conceals).
    conceal: bool = true,
    /// The terminal shows OSC 8 links. Off, read_leaf follows a link whose label is not its URL
    /// with ` (url)`.
    hyperlinks: bool = true,

    /// The live display is what read_leaf shows: bound leaves can be written natively.
    pub fn liveShown(self: Options) bool {
        return self.conceal and self.hyperlinks;
    }
};

pub const Error = error{ OutOfMemory, SourceLimit, BlockLimit, InvalidOptions };

/// Work counters (design invariant 4 and the gates), each counted where its bytes are read.
/// Deterministic; tests read them.
pub const Counters = struct {
    /// Source bytes the line scanner visited looking for line endings.
    line_byte_visits: u64 = 0,
    /// Bytes of lines the block parser took (complete lines, and the pending line each time it
    /// is laid out provisionally).
    block_byte_visits: u64 = 0,
    /// Source bytes the hook filter search read, the overlap included.
    hook_byte_visits: u64 = 0,
    /// Leaf content bytes the inline parser read: tokens, searches and retried constructs.
    inline_byte_visits: u64 = 0,
    /// Display bytes assembled or compared to find where a tail write starts.
    display_byte_visits: u64 = 0,
    /// Display bytes copied into a buffer (tail writes, comparisons, holds), counted where
    /// they are copied, with or without a test sink.
    display_assembled_bytes: u64 = 0,
    /// Leaf content bytes inline-parsed again because a definition arrived.
    bytes_reinlined: u64 = 0,
    /// Allocations the doc made (capacity growth); the scratch arena is not counted here.
    capacity_growth_count: u64 = 0,
    /// Display bytes the live leaf's tail writes would carry: from the first changed display
    /// byte to the end, summed over appends (invariant 4).
    tail_write_bytes: u64 = 0,
    /// The live leaf's guess about the pending line disagreed with the parsed line (must stay 0).
    live_mismatch_count: u64 = 0,
    /// Live tokens walked to style a tail write's runs (and the styles a fold or retire keeps).
    run_token_visits: u64 = 0,
    /// The match kinds a tail write restyled for, one bit per kind: a walk passes a token once
    /// when it is new and once more for each kind it gains, so it bounds the run token visits.
    restyled_kinds: u64 = 0,
    /// Match records the restyle walk read (an opener's or a closer's matches as it passes the
    /// token, and this call's): each is read when its token is passed, so they are bounded as
    /// token visits are.
    match_reads: u64 = 0,
    /// The most delimiter runs that waited at once in a live leaf (its parse's or its pending
    /// word's, at most `delimiter_count_max`): a byte is written again at most once for each
    /// that waited before it when it came.
    waiting_runs_max: u64 = 0,

    pub fn plus(a: Counters, b: Counters) Counters {
        var sum: Counters = .{};
        inline for (@typeInfo(Counters).@"struct".field_names) |name| {
            const x = @field(a, name);
            const y = @field(b, name);
            @field(sum, name) = if (comptime std.mem.eql(u8, name, "restyled_kinds")) x | y else if (comptime std.mem.endsWith(u8, name, "_max")) @max(x, y) else x + y;
        }
        return sum;
    }
};

/// The open paragraph's inline state, kept across appends so that each append tokenizes only
/// new bytes (design: open-leaf token tail). It holds the leaf's content from the first token
/// that may still change; settled tokens are folded away.
/// What the pending line's layout needs to grow with the line (no line ending arrived): the
/// blocks that end at its end, and per kind the state that decides the new bytes' effect.
const Extension = struct {
    kind: enum { none, plain, heading, html, row } = .none,
    /// The line end the layout used.
    end: u32 = 0,
    /// Blocks that end at `end`, from the deepest up.
    path: [depth_max + 3]u32 = undefined,
    path_len: u32 = 0,
    html_kind: u8 = 0,
    heading: Heading = .{},
    row: Row = .{},

    /// An ATX heading's closing sequence, read left to right: the end of its last non-space
    /// byte, and the trailing run of `#` that may close it.
    const Heading = struct {
        block: u32 = none,
        content_start: u32 = 0,
        last_end: u32 = 0,
        run_start: u32 = none,
        run_after_space: bool = false,
        before_run_end: u32 = 0,

        fn scan(self: *Heading, s: []const u8, from: u32, to: u32) void {
            var i = from;
            while (i < to) : (i += 1) self.step(s, i);
        }

        fn step(self: *Heading, s: []const u8, i: u32) void {
            const c = s[i];
            if (isSpaceOrTab(c)) {
                // Leading white space is not content (an empty heading starts at the line end).
                if (self.last_end == self.content_start and self.run_start == none) {
                    self.content_start = i + 1;
                    self.last_end = i + 1;
                }
                return;
            }
            if (c == '#') {
                if (self.run_start != none and i == self.last_end) {
                    self.last_end = i + 1;
                    return;
                }
                self.run_start = i;
                self.run_after_space = i == self.content_start or isSpaceOrTab(s[i - 1]);
                self.before_run_end = self.last_end;
                self.last_end = i + 1;
                return;
            }
            self.run_start = none;
            self.last_end = i + 1;
        }

        /// The content's end: before a closing sequence (spaces then `#`s at the end, or only
        /// `#`s), trailing spaces trimmed.
        fn contentEnd(self: *const Heading) u32 {
            if (self.run_start == none or !self.run_after_space) return self.last_end;
            if (self.run_start == self.content_start) return self.content_start;
            return self.before_run_end;
        }
    };

    /// A pending table row's scan: the cell still open at the line end (or where the next one
    /// starts), its column and the delimiter row's cell of the next one, a trailing backslash,
    /// and whether every column is taken.
    const Row = struct {
        table: u32 = none,
        row: u32 = none,
        columns: u32 = 0,
        column: u32 = 0,
        delimiter: u32 = 0,
        open_cell: u32 = none,
        cell_start: u32 = 0,
        full: bool = false,
        escape: bool = false,
    };
};

const CutDraw = struct {
    at: u32 = none,
    from: u32 = 0,
    code: ?u32 = null,
    scan: inline_parser.PendingScan = .{},
    drawn: u32 = 0,
};

const HoldCut = struct {
    at: u32 = none,
    display: u32 = 0,
    partial_token: u32 = none,
    partial_at: u32 = 0,
    partial_from: u32 = none,
    partial_byte_count: u32 = 0,
};

/// The styles in force before a live token; its link is the bracket's that opened it (or the
/// base link, carried across a fold or retire).
const TokenStyle = struct {
    strong: i32,
    italic: i32,
    strikethrough: i32,
    link: u32,
    /// The parser's matches when these were noted: a later one may cover the token too.
    matches: u32,

    const base_link = none - 1;
};

const Live = struct {
    parser: inline_parser.Parser,
    /// The leaf's content (lines joined by '\n', each complete line followed by one) from the
    /// first byte a token may still need; `content_base` bytes before it were folded away.
    content: std.ArrayListUnmanaged(u8) = .empty,
    content_base: u32 = 0,
    /// The leaf (a provisional index while it is only the pending line's).
    block: u32 = none,
    /// Source offset where the content copy starts: the leaf's start, or the first byte after
    /// its leading definitions once they are decided.
    prose_start: u32 = none,
    /// Where the definition scan resumes (the start of the last definition it parsed).
    definition_scan: u32 = 0,
    /// An open definition title's opening delimiter (none: none) and where its scan resumes.
    title_at: u32 = none,
    title_scanned: u32 = 0,
    /// Source offset of the leaf's first content byte: names the leaf.
    start_byte: u32 = none,
    /// The line being fed before it is complete: its content start and the end fed so far.
    line_start_byte: u32 = none,
    line_fed_end_byte: u32 = 0,
    /// Display end offset of each token, counting the folded display before them.
    display_ends: std.ArrayListUnmanaged(u32) = .empty,
    folded_display_byte_count: u32 = 0,
    /// What B draws of the untokenized bytes, and where drawing stopped.
    pending_display: std.ArrayListUnmanaged(u8) = .empty,
    /// The runs B drew concealed in it, which style the spans they close, and those spans.
    pending_runs: std.ArrayListUnmanaged(inline_parser.PendingRun) = .empty,
    pending_spans: inline_parser.PendingSpans = .{},
    /// The previous drawing, kept (not copied) while a feed compares the new display with it.
    previous_pending: std.ArrayListUnmanaged(u8) = .empty,
    pending_scan: inline_parser.PendingScan = .{},
    /// The backtick opener whose closer search the drawing assumed (drawn as code), if any.
    pending_code_opener: ?u32 = null,
    /// Display bytes the leaf shows now (B's holds cut the full display).
    shown_byte_count: u32 = 0,
    /// The leaf may still be only link reference definitions: it shows nothing yet.
    definition_possible: bool = false,
    /// Content offset of the first pipe in the last complete line (none otherwise).
    pipe_line_start: u32 = none,
    /// Content offset of the first pipe in the line being fed (none otherwise).
    line_pipe: u32 = none,
    /// A hold inside token `partial_token` at content offset `partial_at`: the token's display
    /// starts at `partial_from` and B drew `partial_byte_count` bytes of it (none: no such hold).
    partial_token: u32 = none,
    partial_at: u32 = 0,
    partial_from: u32 = none,
    partial_byte_count: u32 = 0,
    /// The last hold cut (content offset `at`, none: none) and its display, valid while a feed
    /// only adds pending bytes after it.
    hold: HoldCut = .{},
    /// How B drew the untokenized bytes up to the last cut computed in them, so a later cut
    /// draws on from there (valid while the tokens end at `from` and the code opener stands).
    cut_draw: CutDraw = .{},
    /// The last token display assembled (scratch memory: valid within one feed).
    token_display: struct { index: u32 = none, before: u32 = none, bytes: []const u8 = "" } = .{},
    /// The display offset of the first expired opener whose tokens were folded away (none: no
    /// such opener).
    expired_display: u32 = none,
    /// The doc's definition count when the leaf was parsed against them.
    definition_count: u32 = 0,
    /// The span styles and link in force before the first live token (folded or retired tokens
    /// may leave a span open across the cut), and that link's URL.
    base_styles: Styles = .{},
    base_link: std.ArrayListUnmanaged(u8) = .empty,
    /// The styles in force before each live token, valid for the first `styled_count` tokens:
    /// a write restyles from the first token whose style may have changed, not from the first.
    token_styles: std.ArrayListUnmanaged(TokenStyle) = .empty,
    styled_count: u32 = 0,
    /// The parser's matches the writes have seen.
    matches_seen: u32 = 0,
    /// The content held an `@`: a GFM email autolink may link text once the leaf is final.
    email_possible: bool = false,
};

/// A node's Markdown runs from byte `from` to `end` (none: the text's end) become `chunks`
/// (styles of those bytes, links into `urls`).
pub const RunRange = struct { from: u32, end: u32 = none, chunks: []const Chunk, urls: []const u8 };

/// One write to a bound leaf's node: its text from byte `from` on becomes `bytes`, and its runs
/// over each of `ranges` (in order, the first from at most `from`; the runs between them stay).
pub const NodeWrite = struct {
    block: u32,
    from: u32,
    bytes: []const u8,
    ranges: []const RunRange,
    /// The leaf's whole display, for a node just bound or one a failed write left behind; the
    /// doc would take over a node the host wrote with it (`handoff`).
    resync: bool = false,
};

/// Where the engine writes bound leaves (M2: the Context's binding of scene text nodes).
pub const Writer = struct {
    context: *anyopaque,
    write_fn: *const fn (context: *anyopaque, doc: *const Doc, write: NodeWrite) Error!void,
    /// A removal in this call unbound the nodes of blocks from this index on (none: none):
    /// writes to them are dropped, and the owner forgets their bindings after the call.
    unbound_from: u32 = none,
};

/// Test instrument: applies every write the engine makes to a bound leaf (Doc.isBound) to a
/// mirror of that leaf's display and styles, one per block, as bound text nodes would receive
/// them, and checks a leaf's mirror against read_leaf.
pub const TailSink = struct {
    allocator: Allocator,
    mirrors: std.AutoHashMapUnmanaged(u32, Mirror) = .empty,
    checked_leaf_count: u32 = 0,
    mismatch_count: u32 = 0,
    /// The first block index a removal shifted since the last call ended (none: none).
    rebind_from: u32 = none,
    /// The blocks whose nodes were written since the test last cleared it.
    written: std.ArrayListUnmanaged(u32) = .empty,

    /// A node's bytes and, per byte, its style: scope and span bits and a hash of its URL.
    pub const Mirror = struct {
        bytes: std.ArrayListUnmanaged(u8) = .empty,
        styles: std.ArrayListUnmanaged(u64) = .empty,

        fn deinit(self: *Mirror, allocator: Allocator) void {
            self.bytes.deinit(allocator);
            self.styles.deinit(allocator);
        }
    };

    pub fn deinit(self: *TailSink) void {
        var it = self.mirrors.valueIterator();
        while (it.next()) |m| m.deinit(self.allocator);
        self.mirrors.deinit(self.allocator);
        self.written.deinit(self.allocator);
    }

    pub fn mirror(self: *TailSink, block: u32) Allocator.Error!*Mirror {
        try self.written.append(self.allocator, block);
        const entry = try self.mirrors.getOrPut(self.allocator, block);
        if (!entry.found_existing) entry.value_ptr.* = .{};
        return entry.value_ptr;
    }

    /// What block `block`'s node shows ("" before any write).
    pub fn shown(self: *const TailSink, block: u32) []const u8 {
        return if (self.mirrors.getPtr(block)) |m| m.bytes.items else "";
    }

    /// The per-byte styles of block `block`'s node.
    pub fn shownStyles(self: *const TailSink, block: u32) []const u64 {
        return if (self.mirrors.getPtr(block)) |m| m.styles.items else &.{};
    }

    /// Applies one write.
    fn write(self: *TailSink, w: NodeWrite) Allocator.Error!void {
        // A removal earlier in the call unbound the nodes from its index on (rebound after it).
        if (w.block >= self.rebind_from) return;
        const m = try self.mirror(w.block);
        // A write past the node's end is a defect the checks report (the gap shows as '?').
        while (m.bytes.items.len < w.from) try m.bytes.append(self.allocator, '?');
        m.bytes.shrinkRetainingCapacity(w.from);
        try m.bytes.appendSlice(self.allocator, w.bytes);
        // New bytes have no style until a run covers them (a key no chunk makes).
        m.styles.shrinkRetainingCapacity(@min(m.styles.items.len, w.from));
        try m.styles.appendNTimes(self.allocator, std.math.maxInt(u64), m.bytes.items.len - m.styles.items.len);
        assert(w.ranges.len == 0 or w.ranges[0].from <= w.from);
        for (w.ranges) |range| {
            var at = range.from;
            for (range.chunks) |chunk| {
                const key = styleKey(chunk, range.urls);
                for (m.styles.items[at..@min(at + chunk.byte_count, m.styles.items.len)]) |*style| style.* = key;
                at += chunk.byte_count;
            }
        }
    }

    pub fn styleKey(chunk: Chunk, urls: []const u8) u64 {
        const url = urls[chunk.link_offset..][0..chunk.link_byte_count];
        const link: u64 = if (chunk.link_byte_count == 0) 0 else @as(u32, @truncate(std.hash.Wyhash.hash(0, url))) | 1;
        return @as(u64, @as(u16, @bitCast(chunk.scope))) | @as(u64, @as(u2, @truncate(@as(u32, @bitCast(chunk.span))))) << 16 | link << 32;
    }
};

pub const Doc = struct {
    allocator: Allocator,
    /// Per-call temporary memory (the Context's mutation scratch in M2); reset after each call.
    scratch: *std.heap.ArenaAllocator,
    options: Options,
    source: std.ArrayListUnmanaged(u8) = .empty,
    blocks: std.ArrayListUnmanaged(Block) = .empty,
    definitions: std.ArrayListUnmanaged(Definition) = .empty,
    /// The open path from the top level down; equals the parent chain of the deepest open block.
    open: [depth_max]u32 = undefined,
    open_count: u32 = 0,
    /// Start of the pending line.
    line_start_byte: u32 = 0,
    /// End of the previous complete line's content, where blocks closed by this line end.
    previous_line_end_byte: u32 = 0,
    finished: bool = false,
    removed_from_index: u32 = none,
    committed_top_level_count: u32 = 0,
    /// Index of the first top-level block not yet committed (none when there is none).
    commit_cursor: u32 = 0,
    live: Live,
    tail_sink: ?*TailSink = null,
    writer: ?*Writer = null,
    counters: Counters = .{},
    /// Undo log of the current mutation (scratch memory): records the first change of each block
    /// that existed before the call, so a rejected call restores them.
    undo: std.ArrayListUnmanaged(UndoEntry) = .empty,
    undo_base_block_count: u32 = 0,
    /// Block count at the last successful read: a removal at or past it was never reported.
    read_block_count: u32 = 0,
    /// The provisional layout of the pending line: blocks at index >= `provisional_from` (none:
    /// no layout), and the real blocks it extended with their values before.
    provisional_from: u32 = none,
    provisional_undo: std.ArrayListUnmanaged(UndoEntry) = .empty,
    /// While the layout runs: closing work waits and writes to real blocks are logged.
    provisional: bool = false,
    /// The last layout ran into the block limit and was dropped.
    provisional_limited: bool = false,
    /// The layout hid the last real block (a paragraph of only definitions it ends).
    provisional_removed: bool = false,
    /// A paragraph the live parse finished when the pending line's layout ended it, and its
    /// content end then (none: no such paragraph).
    finished_block: u32 = none,
    finished_end_byte: u32 = 0,
    finished_unresolved: ?bool = null,
    finished_definition_count: u32 = 0,
    /// The previous layout's blocks and their first index, compared after the next call.
    provisional_previous: std.ArrayListUnmanaged(Block) = .empty,
    provisional_previous_from: u32 = none,
    /// The prose leaf that takes the pending line in the layout, and where its line starts.
    pending_leaf: u32 = none,
    pending_content_start: u32 = 0,
    /// Whether the pending line may be a delimiter row: its line, how far it read, the state.
    pending_row_line: u32 = none,
    pending_row_scanned: u32 = 0,
    pending_row: enum { prefix, row, not } = .prefix,
    /// A pending line read as only spaces and tabs up to `pending_blank_end` (none: not so).
    pending_blank_line: u32 = none,
    pending_blank_end: u32 = 0,
    /// The pending line's layout's state for growing with the line.
    extension: Extension = .{},
    /// The pending line's last hold decision and the end it was made at.
    pending_hold: struct { line: u32 = none, end: u32 = 0, hold: Hold = Hold.not, in_table: bool = false } = .{},
    filter_pool: [hook_filter_byte_count_max]u8 = undefined,
    filter_byte_count: u32 = 0,
    /// A filter match in the pending line, latched once its line is parsed; none otherwise.
    hook_pending_byte: u32 = none,

    const UndoEntry = struct { index: u32, block: Block };

    pub fn init(allocator: Allocator, scratch: *std.heap.ArenaAllocator, options: Options) Error!Doc {
        options.limits.assertValid();
        try validateFilter(options.hook_filter);
        var doc: Doc = .{
            .allocator = allocator,
            .scratch = scratch,
            .options = options,
            .live = .{ .parser = .{ .allocator = allocator, .references = undefined, .options = .{ .math = options.math } } },
        };
        doc.takeFilter(options.hook_filter);
        return doc;
    }

    /// Copies the filter into the doc's pool; the doc keeps no pointer into the caller's buffer.
    fn takeFilter(self: *Doc, items: []const u8) void {
        assert(items.len <= hook_filter_byte_count_max);
        @memcpy(self.filter_pool[0..items.len], items);
        self.filter_byte_count = @intCast(items.len);
        self.options.hook_filter = "";
    }

    pub fn deinit(self: *Doc) void {
        self.live.parser.deinit();
        self.live.base_link.deinit(self.allocator);
        self.live.content.deinit(self.allocator);
        self.live.display_ends.deinit(self.allocator);
        self.live.token_styles.deinit(self.allocator);
        self.live.pending_display.deinit(self.allocator);
        self.live.pending_runs.deinit(self.allocator);
        self.live.pending_spans.deinit(self.allocator);
        self.live.previous_pending.deinit(self.allocator);
        self.provisional_undo.deinit(self.allocator);
        self.provisional_previous.deinit(self.allocator);
        self.source.deinit(self.allocator);
        self.blocks.deinit(self.allocator);
        self.definitions.deinit(self.allocator);
        self.* = undefined;
    }

    // ---- Mutations ----

    /// Appends bytes (valid UTF-8 per call). A rejected append changes nothing.
    pub fn append(self: *Doc, bytes: []const u8) Error!void {
        defer self.resetScratch();
        if (self.source.items.len + bytes.len > self.options.limits.source_byte_count) return error.SourceLimit;
        if (try self.appendToLine(bytes)) return;
        if (self.finished) {
            // N2: re-opening is a fresh parse of the whole resulting source.
            const whole = try self.scratch.allocator().alloc(u8, self.source.items.len + bytes.len);
            @memcpy(whole[0..self.source.items.len], self.source.items);
            @memcpy(whole[self.source.items.len..], bytes);
            return self.setInternal(whole);
        }
        const source_len: u32 = @intCast(self.source.items.len);
        var snapshot = try self.beginMutation(true);
        errdefer self.rollback(&snapshot);
        try self.reserveSource(@intCast(source_len + bytes.len));
        self.source.appendSliceAssumeCapacity(bytes);
        try self.scanLines(false, source_len -| 1);
        try self.afterScan(source_len);
    }

    /// An append that only grows the pending line, whose layout can grow with it: no line is
    /// laid out again (reading the line once per append would make a long line quadratic).
    /// False, with nothing changed, when the line needs a new layout.
    fn appendToLine(self: *Doc, bytes: []const u8) Error!bool {
        if (self.finished or self.extension.kind == .none) return false;
        const old_len: u32 = @intCast(self.source.items.len);
        // A carriage return ends a line unless "\n" follows; the layout left it out.
        if (old_len > 0 and self.source.items[old_len - 1] == '\r') return false;
        if (std.mem.indexOfAny(u8, bytes, "\n\r") != null) return false;
        // As before the call, if a new layout takes the bytes after all, or the call is rejected
        // (every block write is logged, and the layout's state is in the snapshot).
        var snapshot = try self.beginMutation(false);
        const counters = self.counters;
        self.counters.line_byte_visits += bytes.len;
        errdefer self.rollback(&snapshot);
        try self.reserveSource(@intCast(old_len + bytes.len));
        self.source.appendSliceAssumeCapacity(bytes);
        const end: u32 = @intCast(self.source.items.len);
        if (!try self.extendProvisional(end)) {
            self.source.shrinkRetainingCapacity(old_len);
            self.counters = counters;
            return false;
        }
        // New matches in the line latch its layout's leaves too (latchMatch).
        try self.latchHooks(old_len);
        try self.liveCheckLeaf();
        try self.livePending();
        self.updateCommits();
        try self.rebindSink();
        return true;
    }

    /// After the complete lines: the pending line's live text, the filter latch, commits.
    fn afterScan(self: *Doc, new_from_byte: u32) Error!void {
        try self.latchHooks(new_from_byte);
        try self.addProvisional();
        try self.liveCheckLeaf();
        try self.livePending();
        self.updateCommits();
        self.reconcileProvisional();
        try self.rebindSink();
    }

    /// Ends the document: the pending line is complete and every block closes.
    pub fn finish(self: *Doc) Error!void {
        defer self.resetScratch();
        return self.finishInternal();
    }

    fn finishInternal(self: *Doc) Error!void {
        if (self.finished) return;
        var snapshot = try self.beginMutation(true);
        errdefer self.rollback(&snapshot);
        try self.scanLines(true, @as(u32, @intCast(self.source.items.len)) -| 1);
        while (self.open_count > 0) try self.closeBlock(self.open[self.open_count - 1], self.previous_line_end_byte);
        try self.latchHooks(@intCast(self.source.items.len));
        self.finished = true;
        self.updateCommits();
        self.reconcileProvisional();
        try self.rebindSink();
    }

    /// Replaces the whole source with a fresh parse. Leading blocks equal to the old ones keep
    /// their index and report nothing; `removed_from_index` is the first that differs.
    pub fn set(self: *Doc, bytes: []const u8) Error!void {
        defer self.resetScratch();
        return self.setInternal(bytes);
    }

    /// New options take effect as a fresh parse of the source (a math change changes the block
    /// tree; a filter change latches again), built aside and adopted only when it succeeded: a
    /// rejected call changes nothing. A finished doc stays finished.
    pub fn setOptions(self: *Doc, options: Options) Error!void {
        defer self.resetScratch();
        options.limits.assertValid();
        try validateFilter(options.hook_filter);
        var fresh = try self.buildFresh(self.source.items, options, options.hook_filter, self.finished);
        errdefer fresh.deinit();
        try self.adopt(&fresh);
    }

    fn setInternal(self: *Doc, bytes: []const u8) Error!void {
        var fresh = try self.buildFresh(bytes, self.options, self.filter(), false);
        errdefer fresh.deinit();
        try self.adopt(&fresh);
    }

    /// A fresh parse of `bytes` under `options` and `filter_items`, finished when `finish`.
    fn buildFresh(self: *const Doc, bytes: []const u8, options: Options, filter_items: []const u8, finished: bool) Error!Doc {
        if (bytes.len > options.limits.source_byte_count) return error.SourceLimit;
        var fresh = try Doc.init(self.allocator, self.scratch, options);
        fresh.takeFilter(filter_items);
        errdefer fresh.deinit();
        try fresh.reserveSource(@intCast(bytes.len));
        fresh.source.appendSliceAssumeCapacity(bytes);
        try fresh.scanLines(false, 0);
        try fresh.afterScan(0);
        if (finished) try fresh.finishInternal();
        return fresh;
    }

    /// Takes `fresh`'s state. Leading blocks equal to this doc's keep their change bits; a leaf
    /// whose output changed because a definition did is listed again.
    fn adopt(self: *Doc, fresh: *Doc) Error!void {
        var equal: u32 = 0;
        const count = @min(self.blocks.items.len, fresh.blocks.items.len);
        while (equal < count and self.sameBlock(fresh, equal)) equal += 1;
        // A leaf with the same bytes shows otherwise when a definition or an option did.
        const outputs_may_change = fresh.options.math != self.options.math or fresh.options.conceal != self.options.conceal or
            fresh.options.hyperlinks != self.options.hyperlinks or !try self.sameDefinitions(fresh);
        // Nodes bound while the display was not live hold the host's text: the doc writes them.
        // (A leaf whose hook changes is not equal: the host binds it again.)
        const turned_live = fresh.options.liveShown() and !self.options.liveShown();
        var rewrite: std.ArrayListUnmanaged(u32) = .empty;
        for (fresh.blocks.items[0..equal], self.blocks.items[0..equal], 0..) |*new, old, i| {
            new.flags.unreported = old.flags.unreported;
            // An open leaf's display also depends on whether its last line is complete (B holds
            // a trailing `]` only in the pending line).
            const changed = (outputs_may_change or old.flags.open) and isInlineLeaf(old) and !try self.sameLeafOutput(fresh, @intCast(i));
            if (changed) new.flags.unreported = true;
            if ((changed or turned_live) and isBound(old)) try rewrite.append(self.scratch.allocator(), @intCast(i));
        }
        const removed = if (equal < self.read_block_count) @min(self.removed_from_index, equal) else self.removed_from_index;
        fresh.removed_from_index = removed;
        fresh.counters = self.counters.plus(fresh.counters);
        fresh.read_block_count = @min(self.read_block_count, equal);
        fresh.tail_sink = self.tail_sink;
        fresh.writer = self.writer;
        // The new state is this doc's while the nodes are written; a failed write takes the old
        // state back (and `fresh`, the caller's to free, the new one).
        std.mem.swap(Doc, self, fresh);
        errdefer std.mem.swap(Doc, self, fresh);
        // The equal leading blocks keep their nodes, rewritten where their output changed; the
        // host binds the blocks after them again.
        if (self.writer) |w| {
            w.unbound_from = @min(w.unbound_from, equal);
            for (rewrite.items) |i| try self.writeLeafNode(i);
        }
        // A host rebinds after a replace: each node shows its leaf's display (test sink).
        if (self.tail_sink) |sink| {
            sink.rebind_from = 0;
            try self.rebindSink();
        }
        fresh.deinit();
    }

    /// The two docs' definitions resolve the same labels to the same targets.
    fn sameDefinitions(self: *const Doc, fresh: *const Doc) Error!bool {
        if (self.definitions.items.len != fresh.definitions.items.len) return false;
        const arena = self.scratch.allocator();
        for (self.definitions.items, fresh.definitions.items) |a, b| {
            const parts_a = try self.definitionText(arena, a);
            const parts_b = try fresh.definitionText(arena, b);
            for (parts_a, parts_b) |x, y| {
                if (!std.mem.eql(u8, x, y)) return false;
            }
        }
        return true;
    }

    fn definitionText(self: *const Doc, arena: Allocator, d: Definition) Error![3][]const u8 {
        const s = self.source.items;
        return .{
            try self.spanText(arena, d.parent_index, d.label_start_byte, d.label_end_byte),
            s[d.destination_start_byte..d.destination_end_byte],
            if (d.title_start_byte == none) "" else try self.spanText(arena, d.parent_index, d.title_start_byte, d.title_end_byte),
        };
    }

    fn sameLeafOutput(self: *const Doc, fresh: *const Doc, index: u32) Error!bool {
        const arena = self.scratch.allocator();
        const a = try self.readLeaf(arena, index);
        const b = try fresh.readLeaf(arena, index);
        if (!std.mem.eql(u8, a.bytes.items, b.bytes.items) or !std.mem.eql(u8, a.urls.items, b.urls.items)) return false;
        // The same URL pool can serve other links: compare each chunk's style, spans and target.
        if (a.chunks.items.len != b.chunks.items.len) return false;
        for (a.chunks.items, b.chunks.items) |x, y| {
            if (!std.meta.eql(x, y)) return false;
        }
        return true;
    }

    fn sameBlock(self: *const Doc, fresh: *const Doc, index: u32) bool {
        const a = self.blocks.items[index];
        const b = fresh.blocks.items[index];
        if (a.kind != b.kind or a.parent_index != b.parent_index) return false;
        if (a.source_start_byte != b.source_start_byte or a.source_end_byte != b.source_end_byte) return false;
        if (a.content_start_byte != b.content_start_byte or a.content_end_byte != b.content_end_byte) return false;
        if (a.small != b.small or !std.mem.eql(u32, &a.payload, &b.payload)) return false;
        var fa = a.flags;
        var fb = b.flags;
        fa.unreported = false;
        fb.unreported = false;
        if (@as(u16, @bitCast(fa)) != @as(u16, @bitCast(fb))) return false;
        return std.mem.eql(u8, self.source.items[a.source_start_byte..a.source_end_byte], fresh.source.items[b.source_start_byte..b.source_end_byte]);
    }

    pub const Change = struct { index: u32, block: Block };

    /// Lists the blocks changed since the last successful read, in document order, and clears
    /// the pending state. A capacity below the count reports the count and acknowledges nothing.
    /// The blocks the next read lists.
    pub fn changeCount(self: *const Doc) u32 {
        var count: u32 = 0;
        for (self.blocks.items) |b| count += @intFromBool(b.flags.unreported);
        return count;
    }

    pub fn readChanges(self: *Doc, out: []Change) struct { count: u32, removed_from_index: u32 } {
        const count = self.changeCount();
        const removed = self.removed_from_index;
        // A zero or short capacity reports the count and acknowledges nothing.
        if (out.len == 0 or out.len < count) return .{ .count = count, .removed_from_index = removed };
        var i: u32 = 0;
        for (self.blocks.items, 0..) |*b, index| {
            if (!b.flags.unreported) continue;
            b.flags.unreported = false;
            out[i] = .{ .index = @intCast(index), .block = b.* };
            i += 1;
        }
        self.removed_from_index = none;
        self.read_block_count = @intCast(self.blocks.items.len);
        return .{ .count = count, .removed_from_index = removed };
    }

    // ---- Transactions ----

    /// The doc as a call found it (its lists' lengths and its fields), and the provisional
    /// layout's log when the call dropped the layout (`beginMutation(true)`).
    const Snapshot = struct { doc: Doc, kept_undo: ?[]const UndoEntry = null };

    /// Starts a call. With `drop`, the pending line's layout goes, kept so a rollback puts it
    /// back without memory: room for its blocks (`provisional_previous`), its log in the
    /// scratch, and the values it wrote to real blocks as the oldest undo entries, which a
    /// rollback applies last. A failure here changes nothing.
    fn beginMutation(self: *Doc, drop: bool) Error!Snapshot {
        self.undo = .empty;
        var snapshot: Snapshot = .{ .doc = self.* };
        if (drop and self.provisional_from != none) {
            const arena = self.scratch.allocator();
            const kept = try arena.dupe(UndoEntry, self.provisional_undo.items);
            try self.provisional_previous.ensureTotalCapacity(self.allocator, self.blocks.items.len - self.provisional_from);
            try self.undo.ensureTotalCapacity(arena, kept.len);
            for (kept) |entry| self.undo.appendAssumeCapacity(.{ .index = entry.index, .block = self.blocks.items[entry.index] });
            snapshot.kept_undo = kept;
            self.dropProvisional(true);
        }
        self.undo_base_block_count = @intCast(self.blocks.items.len);
        return snapshot;
    }

    /// Puts the doc back as `snapshot` found it, without memory: logged blocks get their values
    /// back, the lists their lengths (a dropped layout its blocks and log), the fields theirs.
    fn rollback(self: *Doc, snapshot: *const Snapshot) void {
        const was = &snapshot.doc;
        // Every logged index is below the base the log was taken at (the slots are in capacity).
        self.blocks.items.len = @max(self.blocks.items.len, self.undo_base_block_count);
        var i = self.undo.items.len;
        while (i > 0) {
            i -= 1;
            const entry = self.undo.items[i];
            self.blocks.items[entry.index] = entry.block;
        }
        self.blocks.items.len = was.blocks.items.len;
        self.provisional_undo.items.len = was.provisional_undo.items.len;
        if (snapshot.kept_undo) |kept| {
            @memcpy(self.blocks.items[was.provisional_from..], self.provisional_previous.items);
            @memcpy(self.provisional_undo.items, kept);
        }
        self.source.items.len = was.source.items.len;
        self.definitions.items.len = was.definitions.items.len;
        inline for (.{
            "open",                "open_count",                "line_start_byte",           "previous_line_end_byte",
            "removed_from_index",  "committed_top_level_count", "commit_cursor",             "counters",
            "read_block_count",    "hook_pending_byte",         "finished",                  "provisional_from",
            "provisional_removed", "provisional_limited",       "provisional_previous_from", "extension",
            "pending_leaf",        "pending_content_start",     "pending_row_line",          "pending_row_scanned",
            "pending_row",         "pending_blank_line",        "pending_blank_end",         "pending_hold",
        }) |name| @field(self, name) = @field(was, name);
        // The live leaf may have taken bytes of the rejected call: drop it; the open paragraph
        // is parsed whole when it closes.
        self.liveReset(none, none);
        self.finished_block = none;
    }

    /// The block for writing; the first write in a call to a block that existed before it is
    /// logged so a rejected call can restore it.
    fn blockMut(self: *Doc, index: u32) Error!*Block {
        if (self.provisional and index < self.provisional_from) {
            // The provisional layout undoes its writes to real blocks before the next call; each
            // is saved once per layout (the log holds at most the open path and what the line
            // closes, so the search is short).
            for (self.provisional_undo.items) |entry| {
                if (entry.index == index) break;
            } else try self.provisional_undo.append(self.allocator, .{ .index = index, .block = self.blocks.items[index] });
        }
        if (index < self.undo_base_block_count) {
            // Duplicates are harmless: rollback restores in reverse, so the oldest copy wins.
            try self.undo.append(self.scratch.allocator(), .{ .index = index, .block = self.blocks.items[index] });
        }
        // Every write is a change the next read lists.
        self.blocks.items[index].flags.unreported = true;
        return &self.blocks.items[index];
    }

    /// With a writer, its owner resets the scratch after the call: the writes wait in it.
    fn resetScratch(self: *Doc) void {
        self.undo = .empty;
        if (self.writer == null) _ = self.scratch.reset(.{ .retain_with_limit = scratch_retained_byte_count_max });
    }

    fn reserveSource(self: *Doc, byte_count: u32) Error!void {
        if (byte_count <= self.source.capacity) return;
        // Geometric growth, clamped to the limit.
        const grown = @max(byte_count, @min(self.options.limits.source_byte_count, self.source.capacity * 2 + 64));
        try self.source.ensureTotalCapacityPrecise(self.allocator, grown);
        self.counters.capacity_growth_count += 1;
    }

    // ---- Line scanning ----

    /// Feeds every complete line after `line_start_byte` to the block parser; with `final`, the
    /// pending line is complete too.
    fn scanLines(self: *Doc, final: bool, scan_from_byte: u32) Error!void {
        const s = self.source.items;
        var start = self.line_start_byte;
        // Bytes before `scan_from_byte` were searched for line endings by an earlier call.
        var i = @max(start, scan_from_byte);
        self.counters.line_byte_visits += s.len - i;
        while (i < s.len) {
            const c = s[i];
            if (c != '\n' and c != '\r') {
                i += 1;
                continue;
            }
            // A '\r' at the end of the source may be the first half of "\r\n".
            if (c == '\r' and i + 1 == s.len and !final) break;
            const content_end = i;
            const next = if (c == '\r' and i + 1 < s.len and s[i + 1] == '\n') i + 2 else i + 1;
            try self.processLine(start, content_end);
            start = next;
            i = next;
        }
        if (final and start < s.len) {
            try self.processLine(start, @intCast(s.len));
            start = @intCast(s.len);
        }
        self.line_start_byte = start;
    }

    /// Latches `HOOKED` on prose leaves whose source holds a filter substring. Only matches that
    /// start from `from_byte` on are looked for, less the overlap a match can reach back
    /// (invariant 4); a match in the pending line waits for its line.
    fn latchHooks(self: *Doc, from_byte: u32) Error!void {
        if (!self.options.hook) return;
        // An empty filter hooks every prose leaf when it is created (addChild).
        if (self.filterLength() == 0) return;
        if (self.hook_pending_byte != none and self.hook_pending_byte < self.line_start_byte) {
            const pending = self.hook_pending_byte;
            self.hook_pending_byte = none;
            try self.latchRange(pending, self.line_start_byte);
        }
        // Matches that start in the new bytes, or straddle the last call's end: each item is
        // searched from a filter's length back (the stated bound: items x (bytes + overlap)).
        try self.latchRange(from_byte -| self.filterOverlap(), @intCast(self.source.items.len));
    }

    fn latchMatch(self: *Doc, position: u32) Error!void {
        if (position >= self.line_start_byte) {
            self.hook_pending_byte = @min(self.hook_pending_byte, position);
            // The pending line's layout shows it: its leaf latches now, undone with the layout.
            if (self.provisional_from != none) {
                const was_provisional = self.provisional;
                self.provisional = true;
                defer self.provisional = was_provisional;
                try self.latchAt(position);
            }
        } else {
            try self.latchAt(position);
        }
    }

    /// Latches the leaves holding a filter match that starts in [start, end); a match in the
    /// pending line is kept for later.
    fn latchRange(self: *Doc, start: u32, end: u32) Error!void {
        // With the hook off a filter latches nothing (the model's option sets found a table
        // header's cell latched).
        if (!self.options.hook or self.filterLength() == 0) return;
        var matches = self.filterMatches(start, end);
        while (matches.next()) |position| try self.latchMatch(position);
    }

    /// Whether a filter match starts in [start, end).
    fn filterHolds(self: *Doc, start: u32, end: u32) bool {
        if (!self.options.hook) return false;
        if (self.filterLength() == 0) return true;
        var matches = self.filterMatches(start, end);
        return matches.next() != null;
    }

    const FilterMatches = struct {
        doc: *Doc,
        items: std.mem.SplitIterator(u8, .scalar),
        item: []const u8 = "",
        at: usize = 0,
        start: u32,
        end: u32,

        /// The next start of a filter item in [start, end), item by item.
        fn next(self: *FilterMatches) ?u32 {
            const s = self.doc.source.items;
            while (true) {
                if (self.item.len > 0) {
                    const limit = @min(s.len, @as(usize, self.end) + self.item.len - 1);
                    if (std.mem.indexOfPos(u8, s[0..limit], self.at, self.item)) |found| {
                        self.doc.counters.hook_byte_visits += found + 1 - self.at;
                        self.at = found + 1;
                        return @intCast(found);
                    }
                    self.doc.counters.hook_byte_visits += limit -| self.at;
                }
                self.item = self.items.next() orelse return null;
                self.at = self.start;
            }
        }
    };

    fn filterMatches(self: *Doc, start: u32, end: u32) FilterMatches {
        return .{ .doc = self, .items = std.mem.splitScalar(u8, self.filter(), 0), .start = start, .end = end };
    }

    /// The doc's own copy of the hook filter (never the caller's buffer).
    pub fn filter(self: *const Doc) []const u8 {
        return self.filter_pool[0..self.filter_byte_count];
    }

    fn filterLength(self: *const Doc) u32 {
        return self.filter_byte_count;
    }

    fn filterOverlap(self: *const Doc) u32 {
        var longest: usize = 1;
        var it = std.mem.splitScalar(u8, self.filter(), 0);
        while (it.next()) |item| longest = @max(longest, item.len);
        return @intCast(longest - 1);
    }

    /// Latches the prose leaf whose source range holds `position`.
    fn latchAt(self: *Doc, position: u32) Error!void {
        var i = self.blocks.items.len;
        while (i > 0) {
            i -= 1;
            const b = self.blocks.items[i];
            if (!Doc.isInlineLeaf(b)) continue;
            if (b.source_end_byte < position) return;
            if (b.source_start_byte <= position and position < b.source_end_byte) {
                if (!b.flags.hooked) (try self.blockMut(@intCast(i))).flags.hooked = true;
                return;
            }
        }
    }

    // ---- Commit ----

    /// Commits the closed top-level blocks after the cursor. A container closes after its
    /// children, so a closed top-level block's subtree is closed: final under N1 (a).
    fn updateCommits(self: *Doc) void {
        var index = self.commit_cursor;
        const count: u32 = @intCast(self.blocks.items.len);
        while (index < count) {
            const b = self.blocks.items[index];
            assert(b.parent_index == none);
            if (b.flags.open) break;
            const end = self.subtreeEnd(index);
            if (std.debug.runtime_safety) assert(self.subtreeClosed(index, end));
            self.committed_top_level_count += 1;
            index = end;
        }
        self.commit_cursor = index;
    }

    /// One past the last block of `index`'s subtree (preorder).
    pub fn subtreeEnd(self: *const Doc, index: u32) u32 {
        var end = index + 1;
        while (end < self.blocks.items.len and self.isDescendant(end, index)) end += 1;
        return end;
    }

    fn isDescendant(self: *const Doc, index: u32, ancestor: u32) bool {
        var p = self.blocks.items[index].parent_index;
        while (p != none) {
            if (p == ancestor) return true;
            if (p < ancestor) return false;
            p = self.blocks.items[p].parent_index;
        }
        return false;
    }

    fn subtreeClosed(self: *const Doc, start: u32, end: u32) bool {
        for (self.blocks.items[start..end]) |b| {
            if (b.flags.open) return false;
        }
        return true;
    }

    // ---- Block parser (CommonMark appendix "A parsing strategy") ----

    fn processLine(self: *Doc, start: u32, end: u32) Error!void {
        var line = Line{ .s = self.source.items, .start = start, .end = end, .offset = start };
        defer self.counters.block_byte_visits += @max(line.read_end, line.offset) -| start;
        // Phase 1: match the open containers.
        var matched: u32 = 0;
        var fence_closed = false;
        while (matched < self.open_count) {
            const index = self.open[matched];
            const b = self.blocks.items[index];
            line.findNextNonspace();
            const result = self.continues(&line, index, b);
            if (result == .closes) {
                fence_closed = true;
                break;
            }
            if (result == .fails) break;
            matched += 1;
        }
        if (fence_closed) {
            // The closing fence ends the fence and its line.
            const index = self.open[matched];
            const fence = try self.blockMut(index);
            fence.flags.closed = true;
            fence.source_end_byte = end;
            try self.closeAbove(matched + 1, self.previous_line_end_byte);
            try self.closeBlock(index, end);
            self.previous_line_end_byte = end;
            return;
        }
        const old_open_count = self.open_count;
        var all_closed = matched == old_open_count;
        // The container the line continues: the deepest matched block.
        var container: u32 = if (matched > 0) self.open[matched - 1] else none;
        const container_kind: ?Kind = if (container != none) self.blocks.items[container].kind else null;
        var matched_leaf = container_kind != null and acceptsLines(self.blocks.items[container]);
        // Phase 2: new block starts.
        while (!matched_leaf) {
            line.findNextNonspace();
            if (!line.indented and !maybeSpecial(line.peek(line.next_nonspace))) {
                line.advanceNextNonspace();
                break;
            }
            const started = try self.tryStarts(&line, &container, &matched, &all_closed);
            switch (started) {
                .none => {
                    line.advanceNextNonspace();
                    break;
                },
                .container => {},
                .leaf => matched_leaf = true,
            }
            if (started == .leaf) break;
        }
        // Phase 3: what remains is text.
        if (line.consumed) {
            self.previous_line_end_byte = end;
            if (std.debug.runtime_safety) self.assertOpenStack();
            return;
        }
        const tip = self.tipIndex();
        if (!all_closed and !line.blank and tip != none and self.blocks.items[tip].kind == .paragraph) {
            // Lazy paragraph continuation.
            try self.extendLeaf(tip, end);
            try self.liveLine(tip, line.offset, end);
        } else {
            if (!all_closed) try self.closeAbove(matched, self.previous_line_end_byte);
            all_closed = true;
            const target = self.tipIndex();
            if (target != none and self.blocks.items[target].kind != .paragraph and acceptsLines(self.blocks.items[target])) {
                try self.addCodeLine(target, &line);
            } else if (target != none and self.blocks.items[target].kind == .table) {
                if (!line.blank) try self.addTableRow(target, &line, false);
            } else if (line.offset < end and !line.blank) {
                line.advanceNextNonspace();
                if (target != none and self.blocks.items[target].kind == .paragraph) {
                    try self.extendLeaf(target, end);
                    try self.liveLine(target, line.offset, end);
                } else {
                    // New blocks start with their content range equal to their source range.
                    const p = try self.addChild(.paragraph, line.offset, end);
                    try self.liveLine(p, line.offset, end);
                }
            }
        }
        self.previous_line_end_byte = end;
        if (std.debug.runtime_safety) self.assertOpenStack();
    }

    const Continue = enum { matches, fails, closes };

    fn continues(self: *const Doc, line: *Line, index: u32, b: Block) Continue {
        switch (b.kind) {
            .quote => {
                if (!line.indented and line.peek(line.next_nonspace) == '>') {
                    line.advanceNextNonspace();
                    line.advanceOffset(1, false);
                    if (isSpaceOrTab(line.peek(line.offset))) line.advanceOffset(1, true);
                    return .matches;
                }
                return .fails;
            },
            .item => {
                if (line.blank) {
                    if (!self.hasChild(index)) return .fails;
                    line.advanceNextNonspace();
                    return .matches;
                }
                if (line.indent >= b.payload[0]) {
                    line.advanceOffset(b.payload[0], true);
                    return .matches;
                }
                return .fails;
            },
            .list => return .matches,
            .code => {
                if (b.flags.math) {
                    if (line.indent <= 3 and isMathCloser(self.source.items, line.next_nonspace, line.end, self.source.items[b.source_start_byte])) return .closes;
                    var remaining: u32 = b.small;
                    while (remaining > 0 and isSpaceOrTab(line.peek(line.offset))) : (remaining -= 1) line.advanceOffset(1, true);
                    return .matches;
                }
                if (b.flags.fenced) {
                    const fence_char = self.source.items[b.source_start_byte];
                    const fence_len = inline_parser.runLength(self.source.items, b.source_start_byte, fence_char);
                    if (line.indent <= 3 and line.peek(line.next_nonspace) == fence_char) {
                        const run = inline_parser.runLength(self.source.items[0..line.end], line.next_nonspace, fence_char);
                        if (run >= fence_len and isBlankRange(self.source.items, line.next_nonspace + run, line.end)) return .closes;
                    }
                    var remaining: u32 = b.small;
                    while (remaining > 0 and isSpaceOrTab(line.peek(line.offset))) : (remaining -= 1) line.advanceOffset(1, true);
                    return .matches;
                }
                if (line.indent >= 4) {
                    line.advanceOffset(4, true);
                    return .matches;
                }
                if (line.blank) {
                    line.advanceNextNonspace();
                    return .matches;
                }
                return .fails;
            },
            .html => return if (line.blank and (b.small == 6 or b.small == 7)) .fails else .matches,
            .paragraph, .table => return if (line.blank) .fails else .matches,
            .heading, .rule, .table_row, .table_cell => return .fails,
        }
    }

    const Started = enum { none, container, leaf };

    fn tryStarts(self: *Doc, line: *Line, container: *u32, matched: *u32, all_closed: *bool) Error!Started {
        const s = self.source.items;
        const at = line.next_nonspace;
        const c = line.peek(at);
        const container_kind: ?Kind = if (container.* != none) self.blocks.items[container.*].kind else null;
        const tip = self.tipIndex();
        const tip_is_paragraph = tip != none and self.blocks.items[tip].kind == .paragraph;
        // Depth limit: deeper nesting is text in the innermost leaf.
        // Depth limit: a container opens only with room for what it needs below it (a quote: a
        // leaf; an item: its list and a leaf; a table: a row and a cell); deeper markers are
        // text in the innermost leaf.
        const depth = self.depthOf(container.*);
        const limit = self.options.limits.depth;
        if (!line.indented) {
            // Block quote.
            if (c == '>' and depth + 2 <= limit) {
                line.advanceNextNonspace();
                line.advanceOffset(1, false);
                if (isSpaceOrTab(line.peek(line.offset))) line.advanceOffset(1, true);
                try self.closeAbove(matched.*, self.previous_line_end_byte);
                all_closed.* = true;
                const q = try self.addChild(.quote, at, line.end);
                container.* = q;
                matched.* = self.open_count;
                return .container;
            }
            // ATX heading.
            if (c == '#') {
                const hashes = inline_parser.runLength(s[0..line.end], at, '#');
                const after = at + hashes;
                if (hashes <= 6 and (after == line.end or isSpaceOrTab(s[after]))) {
                    try self.closeAbove(matched.*, self.previous_line_end_byte);
                    all_closed.* = true;
                    line.readAll();
                    const h = try self.addChild(.heading, at, line.end);
                    // The same scan grows a pending heading (extendProvisional).
                    var scan: Extension.Heading = .{ .block = h, .content_start = trimRange(s, after, line.end)[0] };
                    scan.last_end = scan.content_start;
                    scan.scan(s, scan.content_start, line.end);
                    const block = try self.blockMut(h);
                    block.payload[0] = hashes;
                    block.content_start_byte = scan.content_start;
                    block.content_end_byte = scan.contentEnd();
                    try self.closeBlock(h, line.end);
                    if (self.provisional) {
                        self.pending_leaf = h;
                        self.pending_content_start = scan.content_start;
                        self.extension.heading = scan;
                    }
                    line.offset = line.end;
                    line.consumed = true;
                    return .leaf;
                }
            }
            // Fenced code.
            if (c == '`' or c == '~') {
                const run = inline_parser.runLength(s[0..line.end], at, c);
                if (run >= 3) line.readAll();
                if (run >= 3 and (c == '~' or std.mem.indexOfScalar(u8, s[at + run .. line.end], '`') == null)) {
                    try self.closeAbove(matched.*, self.previous_line_end_byte);
                    all_closed.* = true;
                    const info = trimRange(s, at + run, line.end);
                    const f = try self.addChild(.code, at, line.end);
                    const block = try self.blockMut(f);
                    block.flags.fenced = true;
                    block.small = @intCast(line.indent);
                    block.payload = .{ info[0], info[1] };
                    block.content_start_byte = line.end;
                    block.content_end_byte = line.end;
                    line.offset = line.end;
                    line.consumed = true;
                    return .leaf;
                }
            }
            // Display math.
            if (self.options.math and (c == '$' or c == '\\')) {
                line.readAll();
                // A math block is decided by the line's ending (D102, D93: the pending line shows
                // as text or a row until then, and never reverts).
                const decided = if (self.provisional) null else mathOpener(s, at, line.end);
                if (decided) |opener| {
                    try self.closeAbove(matched.*, self.previous_line_end_byte);
                    all_closed.* = true;
                    const m = try self.addChild(.code, at, line.end);
                    const block = try self.blockMut(m);
                    block.flags.math = true;
                    block.small = @intCast(line.indent);
                    if (opener.one_line) |body| {
                        block.content_start_byte = body[0];
                        block.content_end_byte = body[1];
                        block.flags.closed = true;
                        try self.closeBlock(m, line.end);
                    } else {
                        block.content_start_byte = line.end;
                        block.content_end_byte = line.end;
                    }
                    line.offset = line.end;
                    line.consumed = true;
                    return .leaf;
                }
            }
            // HTML block.
            if (c == '<') {
                line.readAll();
                if (htmlBlockStart(s, at, line.end)) |kind| {
                    const interrupts = container_kind == .paragraph or (!all_closed.* and !line.blank and tip_is_paragraph);
                    if (kind < 7 or !interrupts) {
                        try self.closeAbove(matched.*, self.previous_line_end_byte);
                        all_closed.* = true;
                        const h = try self.addChild(.html, line.offset, line.end);
                        (try self.blockMut(h)).small = kind;
                        (try self.blockMut(h)).content_start_byte = line.offset;
                        (try self.blockMut(h)).content_end_byte = line.offset;
                        return .leaf;
                    }
                }
            }
            // Setext heading underline.
            if (c == '=' or c == '-' or c == '*' or c == '_') line.touch(markerRunEnd(s, at, line.end, c) + 1);
            if (container_kind == .paragraph and (c == '=' or c == '-') and isSetextUnderline(s, at, line.end)) {
                try self.closeAbove(matched.*, self.previous_line_end_byte);
                all_closed.* = true;
                const p = container.*;
                try self.extractDefinitions(p);
                if (!self.paragraphEmpty(p)) {
                    const block = try self.blockMut(p);
                    block.kind = .heading;
                    block.flags.setext = true;
                    block.payload[0] = if (c == '=') 1 else 2;
                    block.source_end_byte = line.end;
                    try self.closeBlock(p, line.end);
                    line.offset = line.end;
                    line.consumed = true;
                    return .leaf;
                }
                // Only definitions: the paragraph goes on with this line as its first.
                (try self.blockMut(p)).content_start_byte = at;
            }
            // GFM table delimiter row under a paragraph's last line.
            if (container_kind == .paragraph and (c == '|' or c == '-' or c == ':') and depth + 2 <= limit) {
                if (try self.tryTable(container.*, line)) |t| {
                    container.* = t;
                    matched.* = self.open_count;
                    all_closed.* = true;
                    return .leaf;
                }
            }
            // Thematic break.
            if ((c == '*' or c == '-' or c == '_') and isThematicBreak(s, at, line.end)) {
                try self.closeAbove(matched.*, self.previous_line_end_byte);
                all_closed.* = true;
                const r = try self.addChild(.rule, at, line.end);
                try self.closeBlock(r, line.end);
                line.offset = line.end;
                line.consumed = true;
                return .leaf;
            }
        }
        // List item.
        if ((!line.indented or container_kind == .list) and depth + 3 <= limit) {
            if (self.listMarker(line, container_kind)) |marker| {
                try self.closeAbove(matched.*, self.previous_line_end_byte);
                all_closed.* = true;
                const tip_now = self.tipIndex();
                const same_list = tip_now != none and self.blocks.items[tip_now].kind == .list and
                    self.blocks.items[tip_now].payload[1] == marker.marker and
                    self.blocks.items[tip_now].flags.ordered == marker.ordered;
                if (!same_list) {
                    const l = try self.addChild(.list, marker.start_byte, line.end);
                    const block = try self.blockMut(l);
                    block.flags.ordered = marker.ordered;
                    block.payload = .{ marker.number, marker.marker };
                } else {
                    // The previous item is closed; a blank line before this one loosens the list.
                    try self.markBlankAfterLastChild(tip_now, marker.start_byte);
                }
                const item = try self.addChild(.item, marker.start_byte, line.end);
                const block = try self.blockMut(item);
                block.payload = .{ marker.indent, marker.number };
                block.content_start_byte = line.offset;
                block.content_end_byte = line.end;
                container.* = item;
                matched.* = self.open_count;
                // GFM: a task marker starts the item's paragraph; the rest of the line is its text.
                if (!try self.detectTask(item, line)) return .container;
                line.findNextNonspace();
                return .leaf;
            }
        }
        // Indented code.
        if (line.indented and !tip_is_paragraph and !line.blank) {
            line.advanceOffset(4, true);
            try self.closeAbove(matched.*, self.previous_line_end_byte);
            all_closed.* = true;
            const code = try self.addChild(.code, line.offset, line.end);
            const block = try self.blockMut(code);
            block.content_start_byte = line.offset;
            block.content_end_byte = line.end;
            // `small` records the columns of a partly consumed tab at the content start.
            block.small = if (line.partially_consumed_tab) @intCast(4 - line.column % 4) else 0;
            line.offset = line.end;
            line.consumed = true;
            return .leaf;
        }
        return .none;
    }

    fn depthOf(self: *const Doc, index: u32) u32 {
        var depth: u32 = 0;
        var p = index;
        while (p != none) : (depth += 1) p = self.blocks.items[p].parent_index;
        return depth;
    }

    fn hasChild(self: *const Doc, index: u32) bool {
        return index + 1 < self.blocks.items.len and self.blocks.items[index + 1].parent_index == index;
    }

    fn tipIndex(self: *const Doc) u32 {
        return if (self.open_count > 0) self.open[self.open_count - 1] else none;
    }

    /// Closes the open blocks at stack positions >= `keep` (deepest first).
    fn closeAbove(self: *Doc, keep: u32, end: u32) Error!void {
        while (self.open_count > keep) try self.closeBlock(self.open[self.open_count - 1], end);
    }

    fn addChild(self: *Doc, kind: Kind, start: u32, end: u32) Error!u32 {
        // Close tips that cannot contain the new block.
        while (self.open_count > 0) {
            const tip = self.blocks.items[self.tipIndex()];
            if (canContain(tip.kind, kind)) break;
            try self.closeBlock(self.tipIndex(), self.previous_line_end_byte);
        }
        if (self.blocks.items.len >= self.options.limits.block_count) return error.BlockLimit;
        const parent = self.tipIndex();
        const index: u32 = @intCast(self.blocks.items.len);
        if (self.blocks.items.len == self.blocks.capacity) self.counters.capacity_growth_count += 1;
        try self.blocks.append(self.allocator, .{
            .parent_index = parent,
            .kind = kind,
            .flags = .{ .open = true, .unreported = true, .hooked = self.options.hook and self.filter_byte_count == 0 and isInlineKind(kind) },
            .source_start_byte = start,
            .source_end_byte = end,
            .content_start_byte = start,
            .content_end_byte = end,
        });
        assert(self.open_count < depth_max);
        self.open[self.open_count] = index;
        self.open_count += 1;
        return index;
    }

    fn extendLeaf(self: *Doc, index: u32, end: u32) Error!void {
        const block = try self.blockMut(index);
        block.source_end_byte = end;
        block.content_end_byte = end;
        block.flags.unreported = true;
        try self.markAncestorsChanged(index, end);
    }

    /// Containers grow with their last line.
    fn markAncestorsChanged(self: *Doc, index: u32, end: u32) Error!void {
        var p = self.blocks.items[index].parent_index;
        while (p != none) {
            const block = try self.blockMut(p);
            if (block.source_end_byte < end) block.source_end_byte = end;
            p = block.parent_index;
        }
    }

    fn addCodeLine(self: *Doc, index: u32, line: *Line) Error!void {
        const block = try self.blockMut(index);
        if (block.kind == .html) {
            block.content_end_byte = line.end;
            block.source_end_byte = line.end;
            block.flags.unreported = true;
            try self.markAncestorsChanged(index, line.end);
            if (block.small >= 1 and block.small <= 5 and htmlBlockEnds(self.source.items[line.offset..line.end], block.small)) {
                try self.closeAbove(self.positionOf(index) + 1, self.previous_line_end_byte);
                try self.closeBlock(index, line.end);
            }
            return;
        }
        // A fence's first content line: until then its content starts at the opener's line end.
        if ((block.flags.fenced or block.flags.math) and block.content_start_byte == openerLineEnd(self.source.items, block.*)) {
            block.content_start_byte = line.start;
        }
        block.content_end_byte = line.end;
        block.source_end_byte = line.end;
        block.flags.unreported = true;
        if (!line.blank or block.flags.fenced or block.flags.math) {
            try self.markAncestorsChanged(index, line.end);
        }
    }

    fn positionOf(self: *const Doc, index: u32) u32 {
        var i: u32 = 0;
        while (i < self.open_count) : (i += 1) {
            if (self.open[i] == index) return i;
        }
        unreachable;
    }

    fn closeBlock(self: *Doc, index: u32, end: u32) Error!void {
        assert(self.open_count > 0 and self.open[self.open_count - 1] == index);
        self.open_count -= 1;
        var block = try self.blockMut(index);
        // A provisional layout only shows what the pending line opens; closing work (definitions,
        // the last inline pass, list tightness) waits for the line's end.
        if (self.provisional) {
            if (block.kind != .paragraph) return;
            block.flags.ending = true;
            // Only definitions: the exact parse removes it (below), so the layout hides it until
            // the layout is undone (it is the last real block).
            if (index + 1 == self.blocks.items.len and index + 1 == self.provisional_from and
                self.source.items[block.content_start_byte] == '[' and
                (try self.leafSubject(self.scratch.allocator(), index)).len == 0)
            {
                self.blocks.items.len = index;
                self.provisional_from = index;
                self.provisional_removed = true;
                self.noteRemoved(index);
                if (self.live.block == index) self.liveReset(none, none);
            }
            return;
        }
        block.flags.open = false;
        switch (block.kind) {
            .paragraph => {
                if (block.source_end_byte > end) block.source_end_byte = end;
                try self.extractDefinitions(index);
                if (index < self.blocks.items.len and self.paragraphEmpty(index)) {
                    // Only definitions: the paragraph is the last block, so its removal is a suffix.
                    assert(index + 1 == self.blocks.items.len);
                    self.blocks.items.len -= 1;
                    self.noteRemoved(index);
                    if (self.live.block == index) self.liveReset(none, none);
                    return;
                }
                try self.closeLeaf(index);
            },
            .code => {
                if (!block.flags.fenced and !block.flags.math) {
                    // Trailing blank lines are not part of an indented code block.
                    const last = lastNonBlankLineEnd(self.source.items, block.content_start_byte, block.content_end_byte);
                    block.content_end_byte = last;
                    block.source_end_byte = last;
                } else if (!block.flags.closed) {
                    block.source_end_byte = @max(block.source_end_byte, @min(end, block.content_end_byte));
                }
            },
            .item => {
                if (self.hasChild(index)) {
                    block.source_end_byte = self.blocks.items[self.lastChild(index)].source_end_byte;
                } else {
                    block.source_end_byte = lineContentEnd(self.source.items, block.source_start_byte);
                }
            },
            .list => {
                const last = self.lastChild(index);
                block.source_end_byte = self.blocks.items[last].source_end_byte;
                block.flags.tight = self.listIsTight(index);
            },
            .quote => {
                if (end > block.source_start_byte) block.source_end_byte = end;
            },
            .heading => try self.closeLeaf(index),
            // A row's cells close with it (addTableRow); they are never on the open stack.
            .table_cell => unreachable,
            .table, .table_row, .rule, .html => {},
        }
    }

    fn noteRemoved(self: *Doc, index: u32) void {
        if (self.tail_sink) |sink| sink.rebind_from = @min(sink.rebind_from, index);
        if (self.writer) |w| w.unbound_from = @min(w.unbound_from, index);
        // A block no read listed yet leaves nothing behind.
        if (index < self.read_block_count) {
            self.removed_from_index = @min(self.removed_from_index, index);
            self.read_block_count = index;
        }
    }

    /// The last child of `index`, a block whose subtree ends the table (it is open, or it
    /// closes now): walking back from the end reads only that last child's subtree.
    fn lastChild(self: *const Doc, index: u32) u32 {
        var i = self.blocks.items.len;
        while (i > index + 1) {
            i -= 1;
            if (self.blocks.items[i].parent_index == index) return @intCast(i);
        }
        unreachable;
    }

    fn markBlankAfterLastChild(self: *Doc, list: u32, next_start: u32) Error!void {
        const last = self.lastChild(list);
        if (endsWithBlankLine(self.source.items, self.blocks.items[last].source_end_byte, next_start)) {
            (try self.blockMut(last)).flags.blank_after = true;
        }
    }

    fn listIsTight(self: *const Doc, list: u32) bool {
        var i = list + 1;
        const end = self.subtreeEnd(list);
        while (i < end) : (i += 1) {
            const b = self.blocks.items[i];
            if (b.parent_index == list) {
                if (b.flags.blank_after) return false;
                // Children of the item: a gap between two of them loosens the list.
                var previous: u32 = none;
                var j = i + 1;
                const item_end = self.subtreeEnd(i);
                while (j < item_end) : (j += 1) {
                    if (self.blocks.items[j].parent_index != i) continue;
                    if (previous != none and endsWithBlankLine(self.source.items, self.blocks.items[previous].source_end_byte, self.blocks.items[j].source_start_byte)) return false;
                    previous = j;
                }
            }
        }
        return true;
    }

    fn assertOpenStack(self: *const Doc) void {
        if (self.open_count == 0) return;
        var i = self.open_count;
        var expected_parent: u32 = self.blocks.items[self.open[self.open_count - 1]].parent_index;
        while (i > 1) {
            i -= 1;
            assert(self.open[i - 1] == expected_parent);
            expected_parent = self.blocks.items[self.open[i - 1]].parent_index;
        }
        assert(expected_parent == none);
    }

    // ---- Lists ----

    const Marker = struct { ordered: bool, marker: u8, number: u32, indent: u32, start_byte: u32 };

    fn listMarker(self: *Doc, line: *Line, container_kind: ?Kind) ?Marker {
        const s = self.source.items;
        if (line.indent >= 4) return null;
        const at = line.next_nonspace;
        const c = line.peek(at);
        var marker_len: u32 = 0;
        var ordered = false;
        var number: u32 = 0;
        var marker: u8 = 0;
        if (c == '*' or c == '+' or c == '-') {
            marker_len = 1;
            marker = c;
        } else if (std.ascii.isDigit(c)) {
            var i = at;
            while (i < line.end and std.ascii.isDigit(s[i]) and i - at < 10) i += 1;
            const digits = i - at;
            if (digits > 9 or i >= line.end or (s[i] != '.' and s[i] != ')')) return null;
            number = std.fmt.parseInt(u32, s[at..i], 10) catch return null;
            if (container_kind == .paragraph and number != 1) return null;
            ordered = true;
            marker = s[i];
            marker_len = digits + 1;
        } else return null;
        const after = at + marker_len;
        if (after < line.end and !isSpaceOrTab(s[after])) return null;
        if (container_kind == .paragraph and isBlankRange(s, after, line.end)) return null;
        const marker_offset = line.indent;
        line.advanceNextNonspace();
        line.advanceOffset(marker_len, true);
        const spaces_start_column = line.column;
        const spaces_start_offset = line.offset;
        const spaces_start_partial = line.partially_consumed_tab;
        while (true) {
            line.advanceOffset(1, true);
            if (!(line.column - spaces_start_column < 5 and isSpaceOrTab(line.peek(line.offset)))) break;
        }
        const blank_item = line.offset >= line.end;
        const spaces = line.column - spaces_start_column;
        var padding: u32 = undefined;
        if (spaces >= 5 or spaces < 1 or blank_item) {
            padding = marker_len + 1;
            line.column = spaces_start_column;
            line.offset = spaces_start_offset;
            line.partially_consumed_tab = spaces_start_partial;
            if (isSpaceOrTab(line.peek(line.offset))) line.advanceOffset(1, true);
        } else {
            padding = marker_len + spaces;
        }
        return .{ .ordered = ordered, .marker = marker, .number = number, .indent = marker_offset + padding, .start_byte = at };
    }

    fn detectTask(self: *Doc, item: u32, line: *Line) Error!bool {
        const s = self.source.items;
        var i = line.offset;
        // A partly consumed tab still counts as the space after the marker.
        while (i < line.end and isSpaceOrTab(s[i])) i += 1;
        if (i + 3 > line.end or s[i] != '[' or s[i + 2] != ']') return false;
        const mark = s[i + 1];
        if (mark != ' ' and mark != 'x' and mark != 'X') return false;
        if (i + 3 >= line.end or !isSpaceOrTab(s[i + 3])) return false;
        if (isBlankRange(s, i + 3, line.end)) return false;
        const block = try self.blockMut(item);
        block.flags.task = true;
        block.flags.checked = mark != ' ';
        line.offset = i + 3;
        line.column = 0;
        line.partially_consumed_tab = false;
        return true;
    }

    // ---- Tables ----

    fn tryTable(self: *Doc, paragraph: u32, line: *Line) Error!?u32 {
        const s = self.source.items;
        line.readAll();
        const delimiter = delimiterRow(s, line.next_nonspace, line.end) orelse return null;
        const p = self.blocks.items[paragraph];
        // The header is the paragraph's last line.
        const header_start = lastLineContentStart(self, paragraph);
        const header_end = p.content_end_byte;
        const header_cells = countCells(s, header_start, header_end);
        if (header_cells != delimiter or delimiter > table_column_count_max) return null;
        // The live leaf followed the paragraph's lines; the paragraph now loses its last one.
        if (self.live.block == paragraph) self.liveReset(none, none);
        // Leave the paragraph with its earlier lines, or remove it if the header was its only line.
        if (header_start == p.content_start_byte) {
            // The paragraph becomes the table: same index (a kind change).
            const block = try self.blockMut(paragraph);
            block.kind = .table;
            block.flags.hooked = false;
            try self.finishTable(paragraph, header_start, header_end, line, delimiter);
            try self.latchRange(header_start, header_end);
            return paragraph;
        }
        const block = try self.blockMut(paragraph);
        block.content_end_byte = previousLineEnd(s, header_start);
        block.source_end_byte = block.content_end_byte;
        try self.closeBlock(paragraph, block.content_end_byte);
        if (self.blocks.items.len >= self.options.limits.block_count) return error.BlockLimit;
        const t = try self.addChild(.table, header_start, line.end);
        try self.finishTable(t, header_start, header_end, line, delimiter);
        // The filter latch follows the split: the paragraph's own lines, and the header's cells.
        const kept = self.blocks.items[paragraph];
        const hooked = self.filterHolds(kept.source_start_byte, kept.source_end_byte);
        if (kept.flags.hooked != hooked) (try self.blockMut(paragraph)).flags.hooked = hooked;
        // Unhooked, its node holds what the host wrote: the doc writes it now.
        if (kept.flags.hooked and !hooked) try self.writeLeafNode(paragraph);
        try self.latchRange(header_start, header_end);
        return t;
    }

    fn finishTable(self: *Doc, t: u32, header_start: u32, header_end: u32, line: *Line, columns: u32) Error!void {
        const block = try self.blockMut(t);
        block.payload = .{ columns, line.next_nonspace };
        block.content_start_byte = header_start;
        block.content_end_byte = line.end;
        block.source_end_byte = line.end;
        var header = Line{ .s = self.source.items, .start = header_start, .end = header_end, .offset = header_start };
        try self.addTableRow(t, &header, true);
        line.offset = line.end;
        line.consumed = true;
    }

    fn addTableRow(self: *Doc, t: u32, line: *Line, header: bool) Error!void {
        const s = self.source.items;
        line.findNextNonspace();
        const start = line.next_nonspace;
        const row = try self.addChild(.table_row, start, line.end);
        (try self.blockMut(row)).flags.header = header;
        var cell_start = start;
        if (cell_start < line.end and s[cell_start] == '|') cell_start += 1;
        // The same scan grows a pending row (extendProvisional); it starts from the row's state.
        const columns, const delimiter = self.blocks.items[t].payload;
        var r: Extension.Row = .{ .table = t, .row = row, .columns = columns, .delimiter = delimiter + @intFromBool(s[delimiter] == '|'), .cell_start = cell_start };
        try self.scanRow(&r, cell_start, line.end);
        if (self.provisional) {
            self.extension.row = r;
        } else {
            for (row + 1..self.blocks.items.len) |cell| {
                self.blocks.items[cell].flags.open = false;
                try self.computeUnresolved(@intCast(cell));
            }
        }
        try self.closeBlock(row, line.end);
        const table = try self.blockMut(t);
        table.source_end_byte = line.end;
        table.content_end_byte = line.end;
        try self.markAncestorsChanged(t, line.end);
        line.offset = line.end;
        line.consumed = true;
    }

    // ---- Definitions and inline state of leaves ----

    fn paragraphEmpty(self: *const Doc, index: u32) bool {
        const b = self.blocks.items[index];
        return b.content_start_byte >= b.content_end_byte or isBlankRange(self.source.items, b.content_start_byte, b.content_end_byte);
    }

    /// Moves leading link reference definitions of paragraph `index` into `definitions`.
    fn extractDefinitions(self: *Doc, index: u32) Error!void {
        const b = self.blocks.items[index];
        if (b.content_start_byte >= b.content_end_byte or self.source.items[b.content_start_byte] != '[') return;
        const arena = self.scratch.allocator();
        const content = try self.leafContent(arena, index);
        var position: u32 = 0;
        var consumed_any = false;
        while (position < content.bytes.len and content.bytes[position] == '[') {
            const parsed = parseDefinition(content.bytes, position) orelse break;
            try self.storeDefinition(content, parsed, b.parent_index);
            position = parsed.end;
            consumed_any = true;
        }
        if (!consumed_any) return;
        const block = try self.blockMut(index);
        if (position >= content.bytes.len) {
            block.content_start_byte = block.content_end_byte;
        } else {
            block.content_start_byte = content.sourceOffset(position);
        }
        block.flags.unreported = true;
    }

    fn storeDefinition(self: *Doc, content: LeafContent, parsed: ParsedDefinition, parent: u32) Error!void {
        const label = content.bytes[parsed.label[0]..parsed.label[1]];
        const arena = self.scratch.allocator();
        const normalized = try normalizeLabel(arena, label);
        if (normalized.len == 0) return;
        const hash: u32 = @truncate(std.hash.Wyhash.hash(0, normalized));
        if (self.findDefinition(arena, normalized, hash) != null) return;
        if (self.definitions.items.len >= self.options.limits.definition_count) return;
        if (self.definitions.items.len == self.definitions.capacity) self.counters.capacity_growth_count += 1;
        try self.definitions.append(self.allocator, .{
            .label_hash = hash,
            .label_start_byte = content.sourceOffset(parsed.label[0]),
            .label_end_byte = content.sourceOffset(parsed.label[1]),
            .destination_start_byte = content.sourceOffset(parsed.destination[0]),
            .destination_end_byte = content.sourceOffset(parsed.destination[1]),
            .title_start_byte = if (parsed.title) |t| content.sourceOffset(t[0]) else none,
            .title_end_byte = if (parsed.title) |t| content.sourceOffset(t[1]) else none,
            .parent_index = parent,
        });
        try self.definitionArrived(@intCast(self.definitions.items.len - 1));
    }

    fn findDefinition(self: *const Doc, arena: Allocator, normalized: []const u8, hash: u32) ?u32 {
        for (self.definitions.items, 0..) |d, i| {
            if (d.label_hash != hash) continue;
            const label = self.spanText(arena, d.parent_index, d.label_start_byte, d.label_end_byte) catch return null;
            const other = normalizeLabel(arena, label) catch return null;
            if (std.mem.eql(u8, other, normalized)) return @intCast(i);
        }
        return null;
    }

    /// Re-inlines every closed leaf whose inline pass found a reference without a definition;
    /// a leaf that resolves a reference through the new definition changed.
    fn definitionArrived(self: *Doc, definition: u32) Error!void {
        var i: u32 = 0;
        while (i < self.blocks.items.len) : (i += 1) {
            const b = self.blocks.items[i];
            if (!b.flags.unresolved or b.flags.open) continue;
            self.counters.bytes_reinlined += b.content_end_byte - b.content_start_byte;
            var watch: Watch = .{ .doc = self, .definition = definition };
            const arena = self.scratch.allocator();
            const result = try inline_parser.parse(arena, try self.leafSubject(arena, i), .{ .context = &watch, .lookup_fn = Watch.lookup }, .{ .math = self.options.math });
            if (b.flags.unresolved != result.unresolved) (try self.blockMut(i)).flags.unresolved = result.unresolved;
            if (watch.hit) {
                (try self.blockMut(i)).flags.unreported = true;
                if (isBound(b)) try self.writeLeaf(i);
            }
        }
    }

    /// The doc's references, noting whether a lookup found `definition`.
    const Watch = struct {
        doc: *const Doc,
        definition: u32,
        hit: bool = false,

        fn lookup(context: *const anyopaque, label: []const u8) ?inline_parser.Link {
            // The context is this call's own `Watch` (a mutable local), passed as the parser's
            // const context.
            const watch: *Watch = @ptrCast(@alignCast(@constCast(context)));
            const index = watch.doc.lookupIndex(label) orelse return null;
            if (index == watch.definition) watch.hit = true;
            return watch.doc.definitionLink(index);
        }
    };

    // ---- The pending line's provisional layout (D93 Q4 B) ----

    /// Lays out the pending line as if it were complete, unless its kind can still change; the
    /// layout is undone at the start of the next call. Real blocks it extends are logged; the
    /// blocks it adds sit after every real block.
    fn addProvisional(self: *Doc) Error!void {
        assert(self.provisional_from == none);
        self.pending_leaf = none;
        self.provisional_limited = false;
        if (self.finished) return;
        const s = self.source.items;
        var end: u32 = @intCast(s.len);
        if (end > self.line_start_byte and s[end - 1] == '\r') end -= 1;
        if (end == self.line_start_byte or self.pendingHeld(end)) return;
        const saved_open = self.open;
        const saved_open_count = self.open_count;
        const saved_previous_end = self.previous_line_end_byte;
        self.provisional_from = @intCast(self.blocks.items.len);
        self.provisional = true;
        defer {
            self.provisional = false;
            self.open = saved_open;
            self.open_count = saved_open_count;
            self.previous_line_end_byte = saved_previous_end;
        }
        self.extension = .{};
        self.processLine(self.line_start_byte, end) catch |err| switch (err) {
            // No room for the pending line's blocks: it waits for its line end.
            error.BlockLimit => {
                self.provisional_limited = true;
                self.provisional = false;
                self.dropProvisional(false);
                self.pending_leaf = none;
                return;
            },
            else => return err,
        };
        self.noteExtension(end);
        // Filter matches in the pending line hook the leaves that show them (its cells too).
        if (self.hook_pending_byte != none) try self.latchPending(self.hook_pending_byte, end);
    }

    /// Latches the provisional leaves holding a filter match that starts in [start, end).
    fn latchPending(self: *Doc, start: u32, end: u32) Error!void {
        var matches = self.filterMatches(start, end);
        while (matches.next()) |position| try self.latchAt(position);
    }

    /// Records how the layout just made can grow with its line: the deepest block that ends
    /// at the line end and its ancestors that do, and the state its kind needs.
    fn noteExtension(self: *Doc, end: u32) void {
        var ext = &self.extension;
        ext.end = end;
        const tip = self.tipIndex();
        var deepest: u32 = none;
        if (self.pending_leaf != none) {
            deepest = self.pending_leaf;
            const b = self.blocks.items[deepest];
            if (b.kind == .heading) {
                // Its scan state is the layout's (the ATX branch).
                ext.kind = .heading;
            } else {
                ext.kind = .plain;
            }
        } else if (ext.row.row != none and ext.row.row + 1 >= self.provisional_from) {
            ext.kind = .row;
            // The row's cells follow its scan state (scanRow), not the line end.
            deepest = ext.row.row;
        } else if (tip != none and self.blocks.items[tip].source_end_byte == end) {
            deepest = tip;
            const b = self.blocks.items[tip];
            if (b.kind == .code) ext.kind = .plain;
            if (b.kind == .html) {
                ext.kind = .html;
                ext.html_kind = b.small;
            }
        }
        if (ext.kind == .none) return;
        var p = deepest;
        while (p != none) : (p = self.blocks.items[p].parent_index) {
            if (self.blocks.items[p].source_end_byte != end and p != deepest) continue;
            ext.path[ext.path_len] = p;
            ext.path_len += 1;
        }
    }

    /// Grows the pending line's layout over the new bytes [extension.end, end) when they
    /// cannot change it; false (nothing changed) when the line needs a new layout.
    fn extendProvisional(self: *Doc, end: u32) Error!bool {
        const ext = &self.extension;
        const s = self.source.items;
        const old = ext.end;
        const new = s[old..end];
        switch (ext.kind) {
            .none => return false,
            .plain, .heading => {},
            .html => {
                // A closing marker may end the block: a new layout decides (it reads the line).
                const window = s[@max(self.line_start_byte, old -| 10)..end];
                self.counters.block_byte_visits += window.len;
                if (htmlBlockEnds(window, ext.html_kind)) return false;
            },
            .row => {
                // Each new byte may open a cell: room for them first.
                if (!ext.row.full and self.blocks.items.len + new.len > self.options.limits.block_count) return false;
            },
        }
        // A fence opener's info string is the rest of its line: a new layout reads it.
        for (ext.path[0..ext.path_len]) |index| {
            const block = self.blocks.items[index];
            if (block.kind == .code and block.flags.fenced and block.source_start_byte >= self.line_start_byte) return false;
        }
        self.counters.block_byte_visits += new.len;
        self.provisional = true;
        defer self.provisional = false;
        // The layout wrote (and saved) each block on the path: it ends at the line's end.
        for (ext.path[0..ext.path_len]) |index| {
            const block = try self.blockMut(index);
            if (block.content_end_byte == old and !(ext.kind == .heading and index == ext.heading.block)) block.content_end_byte = end;
            if (block.source_end_byte == old) block.source_end_byte = end;
        }
        switch (ext.kind) {
            .heading => {
                ext.heading.scan(s, old, end);
                const heading = try self.blockMut(ext.heading.block);
                heading.content_start_byte = ext.heading.content_start;
                heading.content_end_byte = ext.heading.contentEnd();
                self.pending_content_start = ext.heading.content_start;
            },
            .row => try self.scanRow(&ext.row, old, end),
            else => {},
        }
        ext.end = end;
        return true;
    }

    /// A table row's cells over [from, to), byte by byte: a complete row is scanned from its
    /// start, a pending one resumed where its last layout stopped. A cell ends at an unescaped
    /// pipe; its range is trimmed; cells past the table's columns are dropped; a row with no cell
    /// yet has an empty one at its end.
    fn scanRow(self: *Doc, r: *Extension.Row, from: u32, to: u32) Error!void {
        const s = self.source.items;
        var i = from;
        while (i < to and !r.full) : (i += 1) {
            const c = s[i];
            // An escaped byte is no cell boundary; spaces trim as any.
            const escaped = r.escape;
            r.escape = false;
            if (escaped and !isSpaceOrTab(c)) {
                try self.rowContent(r, i);
                continue;
            }
            if (c == '\\' and !escaped) {
                r.escape = true;
                try self.rowContent(r, i);
                continue;
            }
            if (c == '|' and !escaped) {
                if (r.open_cell == none) {
                    const range = trimRange(s, r.cell_start, i);
                    _ = try self.rowCell(r, range[0], range[1]);
                } else if (self.blocks.items[r.open_cell].content_start_byte == self.blocks.items[r.open_cell].content_end_byte) {
                    try self.moveCell(r.open_cell, i);
                }
                r.open_cell = none;
                if (r.column == r.columns) r.full = true;
                r.cell_start = i + 1;
                continue;
            }
            if (isSpaceOrTab(c)) continue;
            try self.rowContent(r, i);
        }
        if (r.column == 0) r.open_cell = try self.rowCell(r, to, to);
        // An empty cell sits at the line end (trimRange of blanks).
        if (r.open_cell != none and self.blocks.items[r.open_cell].content_start_byte == self.blocks.items[r.open_cell].content_end_byte) try self.moveCell(r.open_cell, to);
    }

    fn moveCell(self: *Doc, index: u32, at: u32) Error!void {
        const cell = try self.blockMut(index);
        cell.source_start_byte = at;
        cell.source_end_byte = at;
        cell.content_start_byte = at;
        cell.content_end_byte = at;
    }

    fn rowContent(self: *Doc, r: *Extension.Row, i: u32) Error!void {
        if (r.open_cell == none) {
            r.open_cell = try self.rowCell(r, i, i + 1);
            return;
        }
        const cell = try self.blockMut(r.open_cell);
        if (cell.content_start_byte == cell.content_end_byte) {
            cell.content_start_byte = i;
            cell.source_start_byte = i;
        }
        cell.content_end_byte = i + 1;
        cell.source_end_byte = i + 1;
    }

    fn rowCell(self: *Doc, r: *Extension.Row, start: u32, end: u32) Error!u32 {
        if (self.blocks.items.len >= self.options.limits.block_count) return error.BlockLimit;
        const index: u32 = @intCast(self.blocks.items.len);
        if (self.blocks.items.len == self.blocks.capacity) self.counters.capacity_growth_count += 1;
        const alignment, const next = delimiterCell(self.source.items, r.delimiter);
        try self.blocks.append(self.allocator, .{
            .parent_index = r.row,
            .kind = .table_cell,
            .flags = .{ .open = true, .unreported = true, .hooked = self.options.hook and self.filter_byte_count == 0 },
            .source_start_byte = start,
            .source_end_byte = end,
            .content_start_byte = start,
            .content_end_byte = end,
            .payload = .{ r.column, @backingInt(alignment) },
        });
        r.column += 1;
        r.delimiter = next;
        return index;
    }

    /// Undoes the provisional layout: real blocks get their values back, provisional blocks go
    /// (kept aside, `keep`, to compare with the next layout and to put back).
    fn dropProvisional(self: *Doc, keep: bool) void {
        if (self.provisional_from == none) return;
        const from = self.provisional_from;
        if (keep) {
            // beginMutation made the room.
            self.provisional_previous.clearRetainingCapacity();
            self.provisional_previous.appendSliceAssumeCapacity(self.blocks.items[from..]);
            self.provisional_previous_from = from;
        }
        // A real block the layout hid comes back (its slot is in capacity; the undo log holds
        // its value).
        self.blocks.items.len = from + @intFromBool(self.provisional_removed);
        self.provisional_removed = false;
        var i = self.provisional_undo.items.len;
        while (i > 0) {
            i -= 1;
            const entry = self.provisional_undo.items[i];
            self.blocks.items[entry.index] = entry.block;
        }
        self.provisional_undo.clearRetainingCapacity();
        self.provisional_from = none;
        self.extension = .{};
    }

    /// After a call: a block of the previous provisional layout that the host read and that no
    /// block of the same identity replaced is reported removed.
    fn reconcileProvisional(self: *Doc) void {
        const from = self.provisional_previous_from;
        if (from == none) return;
        self.provisional_previous_from = none;
        for (self.provisional_previous.items, from..) |old, index| {
            if (index >= self.read_block_count) break;
            const same = index < self.blocks.items.len and self.blocks.items[index].kind == old.kind and
                self.blocks.items[index].parent_index == old.parent_index and
                self.blocks.items[index].source_start_byte == old.source_start_byte;
            if (!same) {
                self.noteRemoved(@intCast(index));
                break;
            }
        }
    }

    /// Whether the pending line [line_start_byte, end) can still change kind (D93 Q4 B): it is
    /// then held until a byte decides it or its line ends.
    fn pendingHeld(self: *Doc, end: u32) bool {
        // A pending line of only spaces and tabs is held; read each of its bytes once.
        if (self.pending_blank_line == self.line_start_byte) {
            const new = self.source.items[self.pending_blank_end..end];
            self.counters.block_byte_visits += new.len;
            if (onlyBytesOf(new, " \t")) {
                self.pending_blank_end = end;
                return true;
            }
            self.pending_blank_line = none;
        } else if (onlyBytesOf(self.source.items[self.line_start_byte..end], " \t")) {
            self.counters.block_byte_visits += end - self.line_start_byte;
            self.pending_blank_line = self.line_start_byte;
            self.pending_blank_end = end;
            return true;
        }
        var line = Line{ .s = self.source.items, .start = self.line_start_byte, .end = end, .offset = self.line_start_byte };
        defer self.counters.block_byte_visits += line.read_end -| line.start;
        // Whether the line may still be a table's delimiter row: quote markers and spaces, then
        // only pipes, dashes, colons and spaces. Read once per byte across appends; once another
        // byte arrives it never is.
        if (self.pending_row_line != self.line_start_byte) {
            self.pending_row_line = self.line_start_byte;
            self.pending_row_scanned = self.line_start_byte;
            self.pending_row = .prefix;
        }
        if (self.pending_row_scanned < end) {
            self.counters.block_byte_visits += end - self.pending_row_scanned;
            for (self.source.items[self.pending_row_scanned..end]) |c| {
                self.pending_row = switch (self.pending_row) {
                    .prefix => if (c == ' ' or c == '\t' or c == '>') .prefix else if (c == ':' or c == '-' or c == '|') .row else .not,
                    .row => if (c == ' ' or c == '\t' or c == ':' or c == '-' or c == '|') .row else .not,
                    .not => break,
                };
            }
            self.pending_row_scanned = end;
        }
        if (self.pending_hold.line == self.line_start_byte) {
            const cached = self.pending_hold;
            if (!cached.hold.held) return false;
            if (cached.hold.any) return true;
            if (cached.hold.keep.len > 0) {
                const new = self.source.items[cached.end..end];
                self.counters.block_byte_visits += new.len;
                if (onlyBytesOf(new, cached.hold.keep)) {
                    self.pending_hold.end = end;
                    return true;
                }
            }
            // The containers matched and the markers read stay: read on from the last marker.
            if (cached.hold.resume_at != none) {
                self.counters.block_byte_visits += end - cached.hold.resume_at;
                const hold = heldPrefix(self.source.items, cached.hold.resume_at, end, cached.hold.state, self.pending_row == .row and !cached.in_table, cached.in_table);
                return self.cacheHold(hold, end, cached.in_table);
            }
        }
        var matched: u32 = 0;
        while (matched < self.open_count) : (matched += 1) {
            const index = self.open[matched];
            const b = self.blocks.items[index];
            line.findNextNonspace();
            if (b.kind == .code and (b.flags.fenced or b.flags.math)) {
                // A fence takes the line unless it may still be the closer.
                if (line.blank) return self.cacheHold(Hold.again, end, false);
                if (line.indent > 3 or !closerPrefix(self.source.items[line.next_nonspace..end], self.source.items[b.source_start_byte], b.flags.math)) return self.cacheHold(Hold.not, end, false);
                // Fence characters, then spaces: after a space only spaces keep it a closer.
                const spaced = isSpaceOrTab(self.source.items[end - 1]);
                return self.cacheHold(if (b.flags.math) Hold.again else Hold.keeping(if (spaced) " \t" else if (self.source.items[b.source_start_byte] == '`') "`" else "~"), end, false);
            }
            if (b.kind == .html) return self.cacheHold(if (line.blank) Hold.again else Hold.not, end, false);
            if (b.kind == .table) matched += 1;
            if (b.kind == .paragraph or b.kind == .table or b.kind == .code) break;
            if (self.continues(&line, index, b) != .matches) break;
        }
        line.findNextNonspace();
        if (line.blank) return self.cacheHold(Hold.again, end, false);
        if (line.indented) return self.cacheHold(Hold.not, end, false);
        const tip = self.tipIndex();
        const in_table = tip != none and self.blocks.items[tip].kind == .table and matched == self.open_count;
        const hold = heldPrefix(self.source.items, line.next_nonspace, end, .{}, self.pending_row == .row and !in_table, in_table);
        // heldPrefix reads at most the markers and a run it keeps (charged here).
        self.counters.block_byte_visits += end - line.next_nonspace;
        return self.cacheHold(hold, end, in_table);
    }

    /// Records the pending line's hold, so the next call reads only its new bytes: a decided
    /// line stays decided (no later byte holds it again), and a held one stays held while the
    /// new bytes are ones that keep it.
    fn cacheHold(self: *Doc, hold: Hold, end: u32, in_table: bool) bool {
        self.pending_hold = .{ .line = self.line_start_byte, .end = end, .hold = hold, .in_table = in_table };
        return hold.held;
    }

    // ---- The live leaf ----

    /// A closing prose leaf's last inline pass: the live leaf's when it followed this leaf to
    /// its end (now, or when the pending line's layout ended it), else a whole parse.
    fn closeLeaf(self: *Doc, index: u32) Error!void {
        const b = self.blocks.items[index];
        if (self.finished_block == index) {
            self.finished_block = none;
            // Finished from the live parse when the pending line's layout ended it; that line
            // is the one that ends it now, so its content is what was finished.
            if (b.content_end_byte == self.finished_end_byte) {
                if (self.finished_definition_count != self.definitions.items.len) {
                    // Its own definitions arrived as it closed: parse it again with them.
                    try self.writeLeaf(index);
                    try self.computeUnresolved(index);
                } else if (self.finished_unresolved) |unresolved| {
                    if (b.flags.unresolved != unresolved) (try self.blockMut(index)).flags.unresolved = unresolved;
                } else {
                    try self.computeUnresolved(index);
                }
                if (self.tail_sink) |sink| try self.checkSink(sink, index);
                return;
            }
        }
        if (self.live.block == index and try self.liveFinish(index)) return;
        // A leaf the live parse does not follow to its end (a heading complete in one call, a
        // paragraph whose live state no longer applies) is written whole, so its node shows its
        // final display.
        if (self.live.block == index) self.liveReset(none, none);
        try self.writeLeaf(index);
        if (self.tail_sink) |sink| try self.checkSink(sink, index);
        try self.computeUnresolved(index);
    }

    /// The live leaf's last pass over leaf `index`: the final feed, its tail write, the
    /// UNRESOLVED bit. False when the live state does not apply (the caller parses it whole).
    fn liveFinish(self: *Doc, index: u32) Error!bool {
        const unresolved = (try self.liveFinishShown(index)) orelse return false;
        const b = self.blocks.items[index];
        if (b.flags.unresolved != unresolved) (try self.blockMut(index)).flags.unresolved = unresolved;
        return true;
    }

    /// liveFinish's pass without the block write: the UNRESOLVED bit it found, or null.
    fn liveFinishShown(self: *Doc, index: u32) Error!?bool {
        const live = &self.live;
        const b = self.blocks.items[index];
        self.liveCheckDefinitions(b.content_start_byte);
        if (live.block != index or (live.start_byte != b.content_start_byte and live.prose_start != b.content_start_byte)) return null;
        // A line fed as this paragraph's that the exact parse gave another block (a lazy line that
        // became display math): the live content holds bytes past the leaf, so it is written whole.
        if (b.kind == .paragraph and live.line_start_byte != none and live.line_start_byte >= b.content_end_byte) return null;
        // An ATX heading closes with its line: take its bytes not fed yet; its content ends
        // before a closing sequence.
        const atx = b.kind == .heading and !b.flags.setext;
        if (live.line_start_byte != none and live.line_fed_end_byte < b.content_end_byte) {
            try self.liveAppend(self.source.items[live.line_fed_end_byte..b.content_end_byte]);
        }
        const content_byte_count = b.content_end_byte - b.content_start_byte;
        var end: u32 = if (atx) content_byte_count -| live.content_base else @intCast(live.content.items.len);
        while (end > live.parser.position and isAsciiWhitespaceByte(live.content.items[end - 1])) end -= 1;
        if (end < live.parser.position or (atx and content_byte_count < live.content_base)) return null;
        // Undecided definitions at the start: the whole parse decides them.
        if (live.definition_possible) return null;
        live.pipe_line_start = none;
        live.line_pipe = none;
        try self.liveFeed(live.content.items[0..end], true);
        if (b.flags.setext) try self.liveWriteExtra(try self.setextUnderline(self.scratch.allocator(), index));
        if (live.expired_display != none) try self.liveRewrite(index, @min(live.expired_display, live.shown_byte_count));
        // Styles the final parse gives bytes before the live tokens: a setext heading's, and
        // an email autolink's (found only once the leaf is final).
        if (b.flags.setext or live.email_possible) try self.liveRestyle(index);
        const unresolved = live.parser.unresolved;
        if (self.tail_sink) |sink| try self.checkSink(sink, index);
        self.liveReset(none, none);
        return unresolved;
    }

    /// Test sink: blocks from a removed index on are new blocks; the host binds their nodes when
    /// it reads them, and they show read_leaf then.
    fn rebindSink(self: *Doc) Error!void {
        const sink = self.tail_sink orelse return;
        if (sink.rebind_from == none) return;
        var i = sink.rebind_from;
        sink.rebind_from = none;
        var it = sink.mirrors.iterator();
        while (it.next()) |entry| {
            if (entry.key_ptr.* >= i) {
                entry.value_ptr.bytes.clearRetainingCapacity();
                entry.value_ptr.styles.clearRetainingCapacity();
            }
        }
        while (i < self.blocks.items.len) : (i += 1) {
            if (isBound(self.blocks.items[i])) try sink.write(try self.wholeWrite(i));
        }
    }

    /// Leaf `index`'s whole display and styles, as one write.
    pub fn wholeWrite(self: *const Doc, index: u32) Error!NodeWrite {
        const arena = self.scratch.allocator();
        const leaf = try self.readLeaf(arena, index);
        const ranges = try arena.dupe(RunRange, &.{.{ .from = 0, .chunks = leaf.chunks.items, .urls = leaf.urls.items }});
        return .{ .block = index, .from = 0, .bytes = leaf.bytes.items, .ranges = ranges };
    }

    /// Sends one write to the test sink and to the node writer.
    fn emit(self: *Doc, w: NodeWrite) Error!void {
        if (self.tail_sink) |sink| try sink.write(w);
        if (self.writer) |writer| if (w.block < writer.unbound_from) try writer.write_fn(writer.context, self, w);
    }

    /// Writes leaf `index` whole to its node only (the test sink rebinds on its own).
    fn writeLeafNode(self: *Doc, index: u32) Error!void {
        const writer = self.writer orelse return;
        var whole = try self.wholeWrite(index);
        whole.resync = true;
        if (index < writer.unbound_from) try writer.write_fn(writer.context, self, whole);
    }

    /// After a style swap: the leaves whose read_leaf styles a host copied (every leaf the doc
    /// does not write itself) are listed again.
    pub fn relistHostWritten(self: *Doc) void {
        for (self.blocks.items) |*b| {
            switch (b.kind) {
                .paragraph, .heading, .code, .html, .table_cell => {},
                else => continue,
            }
            if (isBound(b.*) and self.options.liveShown() and !b.flags.hooked) continue;
            b.flags.unreported = true;
        }
    }

    /// The prose leaves bound to a text node, which the engine writes: paragraphs and headings
    /// (an HTML block's node shows its source). A host reads a table cell with read_leaf.
    pub fn isBound(b: Block) bool {
        return b.kind == .paragraph or b.kind == .heading;
    }

    /// Writes leaf `index`'s whole display to its node (a whole parse).
    fn writeLeaf(self: *Doc, index: u32) Error!void {
        const whole = try self.wholeWrite(index);
        self.counters.display_byte_visits += whole.bytes.len;
        self.counters.tail_write_bytes += whole.bytes.len;
        try self.emit(whole);
    }

    fn checkSink(self: *const Doc, sink: *TailSink, index: u32) Error!void {
        if (index >= sink.rebind_from) return;
        const leaf = try self.readLeaf(self.scratch.allocator(), index);
        const expected = leaf.bytes.items;
        sink.checked_leaf_count += 1;
        if (!std.mem.eql(u8, expected, sink.shown(index)) or !sameStyles(leaf, sink.shownStyles(index))) {
            sink.mismatch_count += 1;
            if (std.debug.runtime_safety) {
                std.debug.print("live display mismatch at block {d}: expected '{s}' mirror '{s}'\n", .{ index, expected, sink.shown(index) });
                var at: usize = 0;
                for (leaf.chunks.items) |chunk| {
                    const key = TailSink.styleKey(chunk, leaf.urls.items);
                    for (at..at + chunk.byte_count) |byte| {
                        const shown_key = if (byte < sink.shownStyles(index).len) sink.shownStyles(index)[byte] else 0;
                        if (shown_key != key) std.debug.print("  byte {d}: style {x} shown {x}\n", .{ byte, key, shown_key });
                    }
                    at += chunk.byte_count;
                }
            }
        }
    }

    /// Whether `styles` gives each byte of `leaf` its chunk's style.
    pub fn sameStyles(leaf: Leaf, styles: []const u64) bool {
        if (styles.len != leaf.bytes.items.len) return false;
        var at: usize = 0;
        for (leaf.chunks.items) |chunk| {
            const key = TailSink.styleKey(chunk, leaf.urls.items);
            for (styles[at..][0..chunk.byte_count]) |style| if (style != key) return false;
            at += chunk.byte_count;
        }
        return at == styles.len;
    }

    /// Drops the live leaf when its block is no open prose leaf starting where it does any more
    /// (a line ended that turned the pending paragraph into another kind).
    fn liveCheckLeaf(self: *Doc) Error!void {
        const live = &self.live;
        if (live.block == none) return;
        if (live.block < self.blocks.items.len) {
            const b = self.blocks.items[live.block];
            if (b.flags.open and !b.flags.ending and (b.kind == .paragraph or b.kind == .heading) and b.content_start_byte == live.start_byte) return;
            // The pending line's layout ends the paragraph: its content is complete, so the live
            // parse finishes it now (its node gets its final display in this call).
            if (b.flags.ending and live.block < self.provisional_from) {
                const index = live.block;
                const end = b.content_end_byte;
                // The block's UNRESOLVED bit is written when it really closes (the layout's
                // writes are undone at the next call).
                self.finished_unresolved = try self.liveFinishShown(index);
                if (self.finished_unresolved == null) {
                    self.liveReset(none, none);
                    try self.writeLeaf(index);
                }
                self.finished_block = index;
                self.finished_end_byte = end;
                self.finished_definition_count = @intCast(self.definitions.items.len);
                return;
            }
        }
        self.liveReset(none, none);
    }

    /// A leaf that started on the pending line while the paragraph before it was still open
    /// was parsed without that paragraph's definitions: when they arrived and it used a label,
    /// it starts again (it holds one line; the definitions came with the line that ended it).
    fn liveCheckDefinitions(self: *Doc, leaf_start: u32) void {
        const live = &self.live;
        if (live.start_byte != leaf_start and live.prose_start != leaf_start) return;
        if (live.definition_count == self.definitions.items.len) return;
        live.definition_count = @intCast(self.definitions.items.len);
        if (!live.parser.unresolved) return;
        self.counters.bytes_reinlined += live.content.items.len;
        self.liveReset(none, none);
    }

    fn liveReset(self: *Doc, start_byte: u32, block: u32) void {
        const live = &self.live;
        live.parser.reset();
        live.content.clearRetainingCapacity();
        live.block = block;
        live.start_byte = start_byte;
        live.prose_start = start_byte;
        live.definition_scan = 0;
        live.title_at = none;
        live.line_start_byte = none;
        live.line_fed_end_byte = 0;
        live.display_ends.clearRetainingCapacity();
        live.styled_count = 0;
        live.matches_seen = 0;
        live.folded_display_byte_count = 0;
        live.content_base = 0;
        live.pending_display.clearRetainingCapacity();
        live.pending_runs.clearRetainingCapacity();
        live.pending_spans.clear();
        live.pending_scan = .{};
        live.pending_code_opener = null;
        live.shown_byte_count = 0;
        live.definition_possible = false;
        live.pipe_line_start = none;
        live.line_pipe = none;
        live.partial_token = none;
        live.partial_from = none;
        live.hold = .{};
        live.cut_draw = .{};
        live.token_display = .{};
        live.expired_display = none;
        live.definition_count = @intCast(self.definitions.items.len);
        live.base_styles = .{};
        live.base_link.clearRetainingCapacity();
        live.email_possible = false;
        self.releaseLiveCapacity();
    }

    /// Retained capacity of the live leaf's stores stays proportional to what they last held.
    fn releaseLiveCapacity(self: *Doc) void {
        const live = &self.live;
        if (live.content.capacity > live_retained_byte_count_max) {
            live.content.clearAndFree(self.allocator);
        }
        if (live.display_ends.capacity > inline_parser.token_count_max) live.display_ends.clearAndFree(self.allocator);
        if (live.token_styles.capacity > inline_parser.token_count_max) live.token_styles.clearAndFree(self.allocator);
        if (live.pending_display.capacity > live_retained_byte_count_max) live.pending_display.clearAndFree(self.allocator);
        if (live.pending_runs.capacity > inline_parser.token_count_max) live.pending_runs.clearAndFree(self.allocator);
        if (live.pending_spans.kinds.capacity > live_retained_byte_count_max) {
            live.pending_spans.deinit(self.allocator);
            live.pending_spans = .{};
        }
        if (live.previous_pending.capacity > live_retained_byte_count_max) live.previous_pending.clearAndFree(self.allocator);
        live.parser.releaseCapacity();
    }

    /// A complete line of paragraph `index`, its content from `content_start` to `end`.
    fn liveLine(self: *Doc, index: u32, content_start: u32, end: u32) Error!void {
        if (self.provisional) {
            self.pending_leaf = index;
            self.pending_content_start = content_start;
            return;
        }
        const live = &self.live;
        const s = self.source.items;
        const leaf_start = self.blocks.items[index].content_start_byte;
        self.liveCheckDefinitions(leaf_start);
        if (live.start_byte != leaf_start) {
            // A new paragraph starts here; any other paragraph the live leaf does not follow (its
            // state was dropped) is parsed whole when it closes.
            if (leaf_start != content_start) {
                if (live.block == index) self.liveReset(none, none);
                return;
            }
            self.liveReset(content_start, index);
            live.definition_possible = s[content_start] == '[';
        }
        live.block = index;
        var from = content_start;
        if (live.line_start_byte != none) {
            if (live.line_start_byte == content_start) {
                from = live.line_fed_end_byte;
            } else {
                // The pending line was fed as this leaf's but parsed otherwise.
                self.counters.live_mismatch_count += 1;
                self.liveReset(none, none);
                return;
            }
            live.line_start_byte = none;
        }
        if (from < end) try self.liveAppendLine(s[from..end]);
        // B holds the line from its first pipe while the next line may make it a table header.
        live.pipe_line_start = if (end - content_start > held_line_byte_count_max) none else live.line_pipe;
        live.line_pipe = none;
        try self.liveAppend("\n");
        if (live.definition_possible) try self.liveDecideDefinitions(index);
        try self.liveFeed(live.content.items, false);
    }

    /// A paragraph that starts with `[` shows nothing until its complete lines decide where
    /// its leading definitions end (at most one line after them); then the content copy starts
    /// at its prose, which the display shows from then on.
    fn liveDecideDefinitions(self: *Doc, index: u32) Error!void {
        const live = &self.live;
        const c = live.content.items;
        // An open title: only its new bytes are read until it closes or fails.
        if (live.title_at != none) {
            const from = live.title_scanned;
            const stop = titleScan(c, live.title_at, from);
            self.counters.block_byte_visits += (stop orelse @as(u32, @intCast(c.len))) - from;
            if (stop) |at| {
                live.title_scanned = at;
                return;
            }
            live.title_at = none;
        }
        const scan = definitionProse(c, live.definition_scan, false);
        self.counters.block_byte_visits += c.len - live.definition_scan;
        live.definition_scan = scan.last_start;
        if (scan.title != none) {
            live.title_at = scan.title;
            live.title_scanned = titleScan(c, scan.title, scan.title).?;
        }
        const prose = scan.prose orelse return;
        live.definition_possible = false;
        if (prose == 0) return;
        const content = try self.leafContent(self.scratch.allocator(), index);
        live.prose_start = content.sourceOffset(prose);
        const rest = live.content.items.len - prose;
        std.mem.copyForwards(u8, live.content.items[0..rest], live.content.items[prose..]);
        live.content.items.len = rest;
        live.content_base += prose;
        live.pipe_line_start = if (live.pipe_line_start != none and live.pipe_line_start >= prose) live.pipe_line_start - prose else none;
        live.parser.reset();
        live.display_ends.clearRetainingCapacity();
        live.styled_count = 0;
        live.matches_seen = 0;
        live.folded_display_byte_count = 0;
        live.base_styles = .{};
        live.base_link.clearRetainingCapacity();
        live.pending_display.clearRetainingCapacity();
        live.pending_runs.clearRetainingCapacity();
        live.pending_spans.clear();
        live.pending_scan = .{ .visits = live.pending_scan.visits };
        live.pending_code_opener = null;
        live.partial_token = none;
        live.partial_from = none;
        live.hold = .{};
        live.cut_draw = .{};
        live.token_display = .{};
        assert(live.shown_byte_count == 0);
    }

    /// Feeds the pending line when the provisional layout gave it a prose leaf: the open
    /// paragraph it continues, or the paragraph or heading it starts.
    fn livePending(self: *Doc) Error!void {
        const live = &self.live;
        const s = self.source.items;
        const leaf = self.pending_leaf;
        if (leaf == none) {
            // A line fed is never held again (heldPrefix); only a block limit drops its layout.
            if (live.line_start_byte != none and !self.provisional_limited) self.counters.live_mismatch_count += 1;
            return;
        }
        const content_start = self.pending_content_start;
        var end: u32 = @intCast(s.len);
        if (end > self.line_start_byte and s[end - 1] == '\r') end -= 1;
        const b = self.blocks.items[leaf];
        if (b.kind == .heading) end = @max(content_start, b.content_end_byte);
        const leaf_start = b.content_start_byte;
        self.liveCheckDefinitions(leaf_start);
        if (live.start_byte != leaf_start) {
            if (leaf_start != content_start) return;
            self.liveReset(content_start, leaf);
            live.definition_possible = b.kind == .paragraph and s[content_start] == '[';
        }
        live.block = leaf;
        if (live.line_start_byte != content_start) {
            if (live.line_start_byte != none) {
                self.counters.live_mismatch_count += 1;
                self.liveReset(none, none);
                return;
            }
            live.line_start_byte = content_start;
            live.line_fed_end_byte = content_start;
        }
        if (live.line_fed_end_byte < end) {
            try self.liveAppendLine(s[live.line_fed_end_byte..end]);
            live.line_fed_end_byte = end;
        }
        try self.liveFeed(live.content.items, false);
    }

    /// Appends bytes of the line being fed, noting its first pipe.
    fn liveAppendLine(self: *Doc, bytes: []const u8) Error!void {
        const live = &self.live;
        if (live.line_pipe == none) {
            self.counters.block_byte_visits += bytes.len;
            if (std.mem.indexOfScalar(u8, bytes, '|')) |at| live.line_pipe = @intCast(live.content.items.len + at);
        }
        try self.liveAppend(bytes);
    }

    fn liveAppend(self: *Doc, bytes: []const u8) Error!void {
        if (std.mem.indexOfScalar(u8, bytes, '@') != null) self.live.email_possible = true;
        const content = &self.live.content;
        if (content.items.len + bytes.len > content.capacity) self.counters.capacity_growth_count += 1;
        try content.appendSlice(self.allocator, bytes);
    }

    /// Runs the live parser over its content and writes the display's changed tail (counted; the
    /// test sink applies it): from the first display byte that differs to the end of what B
    /// shows.
    fn liveFeed(self: *Doc, content: []const u8, final: bool) Error!void {
        const live = &self.live;
        // Possible definitions show nothing and build no tokens: the prose is parsed once
        // decided (liveDecideDefinitions).
        if (live.definition_possible) return;
        live.token_display = .{};
        const parser = &live.parser;
        parser.references = self.references();
        parser.options.math_blocks = self.options.math and self.blocks.items[live.block].kind == .paragraph;
        const tokens_before: u32 = @intCast(parser.tokens.items.len);
        const position_before = parser.position;
        const visits_before = parser.byte_visits;
        try parser.feed(content, final);
        self.counters.inline_byte_visits += parser.byte_visits - visits_before;
        const changes = parser.takeChanged();
        const r = parser.result();
        const old_tokens_end = self.liveTokensEnd(tokens_before);
        // Display ends of the tokens from the first changed one on.
        const grown_last = changes.extended != none and changes.extended + 1 == tokens_before and changes.extended < changes.token;
        const changed = if (grown_last) changes.token else @min(changes.token, changes.extended);
        const first: u32 = if (grown_last) changes.extended else if (changed == none) @intCast(r.tokens.len) else @min(changed, tokens_before);
        const ends = &live.display_ends;
        if (r.tokens.len > ends.capacity) self.counters.capacity_growth_count += 1;
        try ends.resize(self.allocator, r.tokens.len);
        // The styles before the first changed token, or before the first opener a new match
        // took, stand (tokens before it decide them).
        live.styled_count = @min(live.styled_count, @min(first, changes.matched) +| 1);
        var offset = self.liveTokensEnd(first);
        var i = first;
        while (i < r.tokens.len) : (i += 1) {
            offset += inline_parser.tokenDisplayLength(r, i);
            ends.items[i] = offset;
        }
        const tokens_end = offset;
        // The untokenized bytes: drawing continues where it stopped while they only grew.
        const code: ?u32 = if (!final and parser.search_opener == parser.position and parser.position < content.len and content[parser.position] == '`') parser.position else null;
        const pending_only = parser.position == position_before and changes.token == none and changes.extended == none and !final and
            std.meta.eql(code, live.pending_code_opener);
        live.pending_code_opener = code;
        var old_pending: []const u8 = "";
        // A hold cut moves when the tokens or drawn bytes up to it change.
        if (!pending_only) {
            const changed_from = if (first < r.tokens.len) @min(r.tokens[first].start, position_before) else position_before;
            if (live.hold.at == none or live.hold.at >= changed_from) live.hold = .{};
        }
        if (!pending_only) {
            // The old drawing stays in the other buffer for the comparison below (no copy).
            std.mem.swap(std.ArrayListUnmanaged(u8), &live.pending_display, &live.previous_pending);
            live.pending_display.clearRetainingCapacity();
            live.pending_runs.clearRetainingCapacity();
            live.pending_spans.clear();
            old_pending = live.previous_pending.items;
            live.pending_scan = .{ .stop = parser.position, .word_start = parser.position, .link_scanned = parser.position, .visits = live.pending_scan.visits };
        }
        const drawn_before = live.pending_display.items.len;
        if (!final) {
            const read_before = live.pending_scan.visits;
            try inline_parser.renderPendingRuns(content, live.pending_scan.stop, code, &live.pending_scan, self.allocator, &live.pending_display, &live.pending_runs);
            self.counters.display_byte_visits += live.pending_scan.visits - read_before;
            self.counters.display_assembled_bytes += live.pending_display.items.len - drawn_before;
        }
        const full_end = tokens_end + @as(u32, @intCast(live.pending_display.items.len));
        // Where the full display first differs from what it was.
        var write_full: u32 = undefined;
        if (pending_only) {
            write_full = old_tokens_end + @as(u32, @intCast(drawn_before));
        } else if (first < tokens_before and !grown_last) {
            write_full = self.liveTokensEnd(first);
        } else {
            // Only new tokens (or a grown last text token) replaced old pending bytes: compare
            // the new display with the old, piece by piece, up to the first difference. A grown
            // text token's old bytes are the same source bytes: known equal, not compared.
            const known: u32 = if (grown_last) position_before - r.tokens[first].start else 0;
            var old: []const u8 = old_pending;
            var same: u32 = known;
            i = first;
            while (i < r.tokens.len and old.len > 0) : (i += 1) {
                const t = r.tokens[i];
                var piece: []const u8 = undefined;
                if (t.kind == .text or t.kind == .html or t.kind == .extended_autolink) {
                    piece = content[t.start + if (i == first) known else 0 .. t.end()];
                } else {
                    piece = try self.liveTokenDisplay(i, none);
                }
                const matched = matchPrefix(&old, piece);
                same += matched;
                self.counters.display_byte_visits += 2 * matched + 1;
                if (matched < piece.len) break;
            } else if (i == r.tokens.len) {
                const matched = matchPrefix(&old, live.pending_display.items);
                same += matched;
                self.counters.display_byte_visits += 2 * matched;
            }
            write_full = self.liveTokensEnd(first) + same;
        }
        // Styles change from the first changed token, or the first opener a new match took.
        try self.liveShow(write_full, full_end, final, @min(first, changes.matched));
        self.counters.waiting_runs_max = @max(self.counters.waiting_runs_max, live.parser.delimiter_stack_max, live.pending_spans.openers_max);
        if (!final) {
            self.liveFold();
            try self.liveRetire();
        }
    }

    /// Display offset where token `index` starts.
    fn liveTokensEnd(self: *const Doc, index: u32) u32 {
        return if (index == 0) self.live.folded_display_byte_count else self.live.display_ends.items[index - 1];
    }

    /// Applies B's holds to the full display and writes what changed: the display shown now is
    /// the full display up to the hold cut.
    fn liveShow(self: *Doc, write_full: u32, full_end: u32, final: bool, first: u32) Error!void {
        const live = &self.live;
        // A hold inside a token shows what B drew of it, which the token's whole display need
        // not start with: the bytes from that token on are written again once it shows whole
        // (while the same hold stands, they stay).
        const partial_before = live.partial_from;
        live.partial_token = none;
        live.partial_from = none;
        // A leaf that closes with an expired opener folded away is written again whole.
        if (final and live.expired_display != none) return;
        const cut = if (final) none else self.liveHoldCut();
        const shown_end = @min(full_end, cut);
        const rewrite_from = if (live.partial_from == partial_before) none else partial_before;
        var write_start = @min(@min(write_full, live.shown_byte_count), rewrite_from);
        write_start = @min(write_start, shown_end);
        self.counters.tail_write_bytes += shown_end - write_start;
        // The tail write's bytes, and the runs from the first token whose style may have changed:
        // the first changed token (a closer marks the opener it matches changed), and no later
        // than the written bytes.
        if (self.tail_sink != null or self.writer != null) {
            const arena = self.scratch.allocator();
            var tail: std.ArrayListUnmanaged(u8) = .empty;
            if (shown_end > write_start) try self.liveRender(write_start, shown_end, arena, &tail);
            var start = @min(first, live.styled_count -| 1);
            while (start > 0 and self.liveTokensEnd(start) > write_start) start -= 1;
            const runs_from = @min(self.liveTokensEnd(start), shown_end);
            // The matches the parser made in this call are the ones past those the writes saw.
            if (live.matches_seen > live.parser.result().matches.len) live.matches_seen = 0;
            for (live.parser.result().matches[live.matches_seen..]) |m| self.counters.restyled_kinds |= @as(u64, 1) << @intCast(@backingInt(m.kind));
            const ranges = try self.liveChunks(arena, start, runs_from, shown_end, live.matches_seen, write_start);
            try self.emit(.{ .block = live.block, .from = write_start, .bytes = tail.items, .ranges = ranges });
        }
        live.matches_seen = @intCast(live.parser.result().matches.len);
        live.shown_byte_count = shown_end;
    }

    /// The live leaf's chunks for display bytes [from, to), from live token `start` on (`from`
    /// is where it starts, or `to`): the styles read_leaf gives those bytes, counted, not copied.
    /// Matches from `old_matches` on are this call's (the earlier ones were written with their
    /// styles), and bytes from `written` on are written now. Notes the styles before each token
    /// it passes. The walk jumps over an interior whose styles this call cannot change, so the
    /// chunks come in segments: from inside earlier calls' matches (`open_old`, outermost first),
    /// it jumps to the closer of the outermost, or of the outermost of a kind this call's matches
    /// add there (`new_active`) when that one ends sooner. Matches nest and do not cross links,
    /// and the matches this call made have their closers in the written bytes, so none starts or
    /// ends in the gap, and every token there has the kinds those matches add already.
    fn liveChunks(self: *Doc, arena: Allocator, start: u32, from: u32, to: u32, old_matches: u32, written: u32) Error![]const RunRange {
        const live = &self.live;
        var segments: std.ArrayListUnmanaged(RunRange) = .empty;
        var leaf = try arena.create(Leaf);
        leaf.* = .{};
        if (from >= to) {
            try segments.append(arena, .{ .from = from, .chunks = &.{}, .urls = "" });
            return segments.items;
        }
        assert(from == self.liveTokensEnd(start) and (start == 0 or start < live.styled_count));
        var writer: LeafWriter = .{ .arena = arena, .leaf = leaf, .count_only = true };
        const b = self.blocks.items[live.block];
        writer.base.heading_level = if (b.kind == .heading) @intCast(b.payload[0]) else 0;
        const r = live.parser.result();
        var styler: TokenStyler = .{ .writer = &writer, .arena = arena, .r = r, .styles = live.base_styles, .references = self.references() };
        var segment_from = from;
        // This call's matches: how many of each kind cover the token the walk is past. The
        // earlier matches the walk is inside, and per kind how many and the closer of the
        // outermost.
        var new_active: [3]u32 = .{ 0, 0, 0 };
        const OldMatch = struct { kind: inline_parser.MatchKind, closer: u32 };
        var open_old: std.ArrayListUnmanaged(OldMatch) = .empty;
        var old_count: [3]u32 = .{ 0, 0, 0 };
        var old_end: [3]u32 = .{ 0, 0, 0 };
        var link: u32 = if (live.base_styles.link != null) TokenStyle.base_link else none;
        if (start > 0) {
            const before = live.token_styles.items[start];
            styler.styles = .{ .strong = before.strong, .italic = before.italic, .strikethrough = before.strikethrough };
            link = before.link;
            // The walk may start past an opener (at the last closer of a kind it matched): the
            // matches made since the styles before `start` were noted that cover it, newest
            // (outermost) first, as closers come in order.
            var j = r.matches.len;
            while (j > @min(before.matches, old_matches)) {
                j -= 1;
                self.counters.match_reads += 1;
                const m = r.matches[j];
                if (m.opener_token >= start or m.closer_token < start) continue;
                styler.styles.apply(m.kind, 1);
                const k = @backingInt(m.kind);
                if (j >= old_matches) {
                    new_active[k] += 1;
                    continue;
                }
                if (old_count[k] == 0) old_end[k] = m.closer_token;
                old_count[k] += 1;
                try open_old.append(arena, .{ .kind = m.kind, .closer = m.closer_token });
            }
        }
        if (link == TokenStyle.base_link) {
            styler.styles.link = try writer.url("", live.base_link.items);
            styler.styles.link_owner = live.base_styles.link_owner;
        } else if (link != none) {
            styler.styles.link = try writer.url("", try styler.destination(link));
            styler.styles.link_owner = r.tokens[link].aux;
        }
        try live.token_styles.resize(self.allocator, r.tokens.len);
        var at = from;
        var i: u32 = start;
        while (i < r.tokens.len and at < to) : (i += 1) {
            self.counters.run_token_visits += 1;
            live.token_styles.items[i] = .{ .strong = styler.styles.strong, .italic = styler.styles.italic, .strikethrough = styler.styles.strikethrough, .link = link, .matches = @intCast(r.matches.len) };
            live.styled_count = i + 1;
            if (live.display_ends.items[i] > to) {
                // A hold inside this token: B drew its start, styled as read_leaf styles a token
                // the cut reaches (no autolink of its own; a cut math span is literal).
                const t = r.tokens[i];
                styler.sync();
                writer.base.raw = t.kind == .code;
                try writer.writeLength(to - at, .{ .code = t.kind == .code });
                at = to;
                break;
            }
            try styler.token(i);
            if (r.tokens[i].kind == .delimiter) if (inline_parser.delimiterOf(r, i)) |di| {
                const d = r.delimiters[di];
                self.counters.match_reads += d.closer_match_count;
                for (d.closer_first_match..d.closer_first_match + d.closer_match_count) |m| {
                    if (m >= old_matches) new_active[@backingInt(r.matches[m].kind)] -= 1;
                }
                while (open_old.items.len > 0 and open_old.items[open_old.items.len - 1].closer == i) {
                    old_count[@backingInt(open_old.pop().?.kind)] -= 1;
                }
                // Newest first: an opener's later matches enclose its earlier ones.
                var m = d.opener_matches;
                while (m) |mi| : (m = r.matches[mi].next_for_opener) {
                    self.counters.match_reads += 1;
                    const match = r.matches[mi];
                    const k = @backingInt(match.kind);
                    if (mi >= old_matches) {
                        new_active[k] += 1;
                        continue;
                    }
                    if (old_count[k] == 0) old_end[k] = match.closer_token;
                    old_count[k] += 1;
                    try open_old.append(arena, .{ .kind = match.kind, .closer = match.closer_token });
                }
            };
            if (styler.styles.link == null) {
                link = none;
            } else if (link == none) {
                // The link's owner opened here (a link or image inside it keeps its target).
                link = i;
            }
            at = live.display_ends.items[i];
            var closer: u32 = if (open_old.items.len > 0) open_old.items[0].closer else 0;
            for (new_active, old_count, old_end) |count, old, end| {
                if (count > 0) closer = if (old == 0) 0 else @min(closer, end);
            }
            if (closer > i + 1 and live.display_ends.items[closer] <= written) {
                try segments.append(arena, .{ .from = segment_from, .end = at, .chunks = leaf.chunks.items, .urls = leaf.urls.items });
                const next = try arena.create(Leaf);
                next.* = .{};
                // A link open across the gap: its URL in the next segment's URLs.
                const url: ?[]const u8 = if (styler.styles.link) |l| leaf.urls.items[l[0]..][0..l[1]] else null;
                writer.leaf = next;
                writer.byte_count = 0;
                if (url) |u| styler.styles.link = try writer.url("", u);
                leaf = next;
                at = self.liveTokensEnd(closer);
                segment_from = at;
                // Before the closer: the matches the walk is inside that end in the gap are gone,
                // and the closer's own matches whose openers lie in the gap are on.
                while (open_old.items[open_old.items.len - 1].closer < closer) {
                    const gone = open_old.pop().?;
                    old_count[@backingInt(gone.kind)] -= 1;
                    styler.styles.apply(gone.kind, -1);
                }
                const d = r.delimiters[inline_parser.delimiterOf(r, closer).?];
                for (r.matches[d.closer_first_match..][0..d.closer_match_count]) |match| {
                    if (match.opener_token > i) styler.styles.apply(match.kind, 1);
                }
                i = closer - 1;
            }
        }
        if (at < to) {
            // The drawn pending bytes: a backtick opener's content is drawn as code, and the
            // runs that close one another style the spans between them.
            const code = live.pending_code_opener != null;
            writer.link = null;
            writer.base = .{ .heading_level = writer.base.heading_level, .raw = code };
            const pending_start = self.liveTokensEnd(@intCast(r.tokens.len));
            // Under a held pipe, only the runs before it: a run that reaches it waits for the
            // byte after it, as read_leaf's does.
            var shown_runs = live.pending_runs.items;
            const pipe = if (b.kind == .paragraph) self.liveHoldPipe() else none;
            while (pipe != none and shown_runs.len > 0 and shown_runs[shown_runs.len - 1].end >= pipe) shown_runs.len -= 1;
            // The runs' spans so far, and this call's: the bytes before the first byte this call
            // marked, and before the written bytes, keep their styles (a span only adds its kind).
            const spans = &live.pending_spans;
            if (spans.resolved > shown_runs.len) spans.clear();
            // Not cleared since an earlier call: the drawing only grew since.
            const extends = !spans.fresh;
            spans.fresh = false;
            self.counters.run_token_visits += shown_runs.len - spans.resolved;
            const first_span = try spans.add(shown_runs, self.allocator, &self.counters.run_token_visits);
            const keep_end = pending_start + @min(first_span, written -| pending_start);
            if (extends and keep_end > at) {
                try segments.append(arena, .{ .from = segment_from, .end = at, .chunks = leaf.chunks.items, .urls = leaf.urls.items });
                leaf = try arena.create(Leaf);
                leaf.* = .{};
                writer.leaf = leaf;
                writer.byte_count = 0;
                at = @min(keep_end, to);
                segment_from = at;
            }
            self.counters.run_token_visits += to - at;
            try writer.writePending(null, at - pending_start, to - pending_start, spans.kinds.items, .{ .code = code });
        }
        assert(writer.byte_count == to - segment_from);
        try segments.append(arena, .{ .from = segment_from, .chunks = leaf.chunks.items, .urls = leaf.urls.items });
        return segments.items;
    }

    /// The styles in force after the first `count` live tokens, from the base styles: what the
    /// tokens left after them carry when those tokens go (fold, retire).
    fn liveStylesAfter(self: *Doc, count: u32) Error!void {
        const live = &self.live;
        const arena = self.scratch.allocator();
        var leaf: Leaf = .{};
        var writer: LeafWriter = .{ .arena = arena, .leaf = &leaf, .count_only = true };
        var styler: TokenStyler = .{ .writer = &writer, .arena = arena, .r = live.parser.result(), .styles = live.base_styles, .references = self.references() };
        if (live.base_styles.link != null) styler.styles.link = try writer.url("", live.base_link.items);
        var i: u32 = 0;
        while (i < count) : (i += 1) {
            self.counters.run_token_visits += 1;
            try styler.token(i);
        }
        live.base_styles = styler.styles;
        live.base_link.clearRetainingCapacity();
        if (styler.styles.link) |link| {
            try live.base_link.appendSlice(self.allocator, leaf.urls.items[link[0]..][0..link[1]]);
            live.base_styles.link = .{ 0, link[1] };
        }
    }

    /// Appends the full display's bytes [from, to): only the tokens that reach into the range
    /// (a text token by slicing its bytes; another rendered aside, counted as assembled) and the
    /// slice of the drawn pending bytes.
    fn liveRender(self: *Doc, from: u32, to: u32, allocator: Allocator, out: *std.ArrayListUnmanaged(u8)) Error!void {
        if (from >= to) return;
        const live = &self.live;
        const r = live.parser.result();
        assert(from >= live.folded_display_byte_count);
        const out_start = out.items.len;
        // The first token that ends after `from`.
        var low: usize = 0;
        var high: usize = r.tokens.len;
        while (low < high) {
            const mid = (low + high) / 2;
            if (live.display_ends.items[mid] <= from) low = mid + 1 else high = mid;
        }
        const partial = live.partial_token != none and to == live.partial_from + live.partial_byte_count;
        const last: usize = if (partial) live.partial_token else r.tokens.len;
        var at = from;
        var i: u32 = @intCast(low);
        while (i < last and at < to) : (i += 1) {
            const start = self.liveTokensEnd(i);
            const end = live.display_ends.items[i];
            const t = r.tokens[i];
            const a = at - start;
            const b = @min(end, to) - start;
            if (t.kind == .text or t.kind == .html or t.kind == .extended_autolink) {
                try out.appendSlice(allocator, r.content[t.start + a .. t.start + b]);
            } else {
                try out.appendSlice(allocator, (try self.liveTokenDisplay(i, none))[a..b]);
            }
            at = start + b;
        }
        if (partial and at < to) {
            // Up to a hold inside a token: what B drew of it.
            const display = try self.liveTokenDisplay(live.partial_token, live.partial_at);
            try out.appendSlice(allocator, display[at - live.partial_from .. to - live.partial_from]);
        } else if (at < to) {
            const tokens_end = self.liveTokensEnd(@intCast(r.tokens.len));
            try out.appendSlice(allocator, live.pending_display.items[at - tokens_end .. to - tokens_end]);
        }
        // The bytes themselves are the tail write (counted as sent bytes).
        assert(out.items.len - out_start == to - from);
    }

    /// The display offset where B's holds start: a paragraph that may still be only link
    /// definitions shows nothing; a last line with a pipe waits for the next line.
    fn liveHoldCut(self: *Doc) u32 {
        const live = &self.live;
        if (live.definition_possible) return 0;
        // The paragraph's last line, complete or pending, is held from its first pipe: with
        // the next line it may be a table's header. (Held from the pipe, not from the line's
        // start: a pipe that arrives after the line's first bytes were shown takes nothing back.)
        if (self.blocks.items[live.block].kind != .paragraph) return none;
        const pipe = self.liveHoldPipe();
        if (pipe == none) return none;
        // While only pending bytes after the cut were added, the cut's display stands.
        if (live.hold.at == pipe) {
            live.partial_token = live.hold.partial_token;
            live.partial_at = live.hold.partial_at;
            live.partial_from = live.hold.partial_from;
            live.partial_byte_count = live.hold.partial_byte_count;
            return live.hold.display;
        }
        const display = self.liveDisplayAt(pipe);
        live.hold = .{ .at = pipe, .display = display, .partial_token = live.partial_token, .partial_at = live.partial_at, .partial_from = live.partial_from, .partial_byte_count = live.partial_byte_count };
        return display;
    }

    /// The content offset of the pipe the paragraph's last line is held from (none: none). A
    /// line longer than a table header can be is not held.
    fn liveHoldPipe(self: *const Doc) u32 {
        const live = &self.live;
        if (live.line_start_byte == none) return live.pipe_line_start;
        if (live.line_fed_end_byte - live.line_start_byte > held_line_byte_count_max) return none;
        return live.line_pipe;
    }

    /// The display offset of content offset `at`: from the tokens (with what B drew of a token
    /// that reaches it) or, in the untokenized bytes, from what B draws before it.
    fn liveDisplayAt(self: *Doc, at: u32) u32 {
        const live = &self.live;
        const r = live.parser.result();
        if (at >= live.parser.position) {
            // Draw on from the last cut while the drawing it continues stands.
            var cut = live.cut_draw;
            if (cut.at == none or cut.at > at or cut.from != live.parser.position or !std.meta.eql(cut.code, live.pending_code_opener)) {
                cut = .{ .from = live.parser.position, .code = live.pending_code_opener, .scan = .{ .stop = live.parser.position, .word_start = live.parser.position, .link_scanned = live.parser.position } };
            }
            var drawn: std.ArrayListUnmanaged(u8) = .empty;
            inline_parser.renderPending(live.content.items[0..at], cut.scan.stop, cut.code, &cut.scan, self.scratch.allocator(), &drawn) catch return live.folded_display_byte_count;
            self.counters.display_byte_visits += drawn.items.len;
            self.counters.display_assembled_bytes += drawn.items.len;
            cut.at = at;
            cut.drawn += @intCast(drawn.items.len);
            live.cut_draw = cut;
            return self.liveTokensEnd(@intCast(r.tokens.len)) + cut.drawn;
        }
        // The first token that ends after `at`.
        var low: usize = 0;
        var high: usize = r.tokens.len;
        while (low < high) {
            const mid = (low + high) / 2;
            if (r.tokens[mid].end() <= at) low = mid + 1 else high = mid;
        }
        const start = self.liveTokensEnd(@intCast(low));
        if (low == r.tokens.len or r.tokens[low].start >= at) return start;
        // A text token's display is its bytes: the cut's prefix of it is a prefix of the whole.
        const kind = r.tokens[low].kind;
        if (kind == .text or kind == .extended_autolink) return start + (at - r.tokens[low].start);
        const before = self.liveTokenDisplay(@intCast(low), at) catch return start;
        self.counters.display_byte_visits += before.len;
        live.partial_token = @intCast(low);
        live.partial_at = at;
        live.partial_from = start;
        live.partial_byte_count = @intCast(before.len);
        return start + live.partial_byte_count;
    }

    /// Token `index`'s display (up to content offset `before`, none: whole), assembled once per
    /// feed: the comparison, a hold's cut and the tail write share it.
    fn liveTokenDisplay(self: *Doc, index: u32, before: u32) Error![]const u8 {
        const live = &self.live;
        if (live.token_display.index == index and live.token_display.before == before) return live.token_display.bytes;
        const r = live.parser.result();
        var display: std.ArrayListUnmanaged(u8) = .empty;
        if (before == none) {
            try inline_parser.appendTokenDisplay(r, index, self.scratch.allocator(), &display);
        } else {
            try inline_parser.appendTokenDisplayBefore(r, index, before, self.scratch.allocator(), &display);
        }
        self.counters.display_assembled_bytes += display.items.len;
        live.token_display = .{ .index = index, .before = before, .bytes = display.items };
        return display.items;
    }

    /// Writes the closed leaf's display again from display offset `from`, from a whole parse:
    /// an expired opener whose tokens were folded away shows literal now, or the live parse no
    /// longer applies.
    fn liveRewrite(self: *Doc, index: u32, from: u32) Error!void {
        const live = &self.live;
        var whole = try self.wholeWrite(index);
        self.counters.display_byte_visits += whole.bytes.len;
        self.counters.tail_write_bytes += whole.bytes.len - from;
        live.shown_byte_count = @intCast(whole.bytes.len);
        whole.bytes = whole.bytes[from..];
        whole.from = from;
        try self.emit(whole);
    }

    /// Writes the closing leaf's runs again from its start, from a whole parse.
    fn liveRestyle(self: *Doc, index: u32) Error!void {
        // Host-written modes: read_leaf is not the live display, and no node takes the runs.
        if (!self.options.liveShown()) return;
        var whole = try self.wholeWrite(index);
        assert(whole.bytes.len == self.live.shown_byte_count);
        self.counters.display_byte_visits += whole.bytes.len;
        whole.from = @intCast(whole.bytes.len);
        whole.bytes = "";
        try self.emit(whole);
    }

    /// Writes bytes after the leaf's display (a setext underline when the heading closes),
    /// styled as the heading.
    fn liveWriteExtra(self: *Doc, bytes: []const u8) Error!void {
        self.counters.tail_write_bytes += bytes.len;
        const b = self.blocks.items[self.live.block];
        const chunk: Chunk = .{ .byte_count = @intCast(bytes.len), .scope = .{ .heading_level = @intCast(b.payload[0]) }, .span = .{} };
        const at = self.live.shown_byte_count;
        const arena = self.scratch.allocator();
        const ranges = try arena.dupe(RunRange, &.{.{ .from = at, .chunks = if (bytes.len > 0) try arena.dupe(Chunk, &.{chunk}) else &.{}, .urls = "" }});
        try self.emit(.{ .block = self.live.block, .from = at, .bytes = bytes, .ranges = ranges });
        self.live.shown_byte_count += @intCast(bytes.len);
    }

    /// Drops the settled tokens and the content before them, keeping one code point of look
    /// behind; only at a word start, where no construct can reach back across the cut, and only
    /// when nothing is held back.
    fn liveFold(self: *Doc) void {
        const live = &self.live;
        const parser = &live.parser;
        const position = parser.position;
        if (!parser.settled() or position != parser.limit or position >= live.content.items.len) return;
        if (position <= 2 * look_behind_byte_count) return;
        if (live.definition_possible or live.pipe_line_start != none or live.line_pipe != none) return;
        // At a word's start or end only (the `$` read-ahead can stop inside a word).
        const c = live.content.items;
        if (!isAsciiWhitespaceByte(c[position - 1]) and !isAsciiWhitespaceByte(c[position])) return;
        const drop = position - look_behind_byte_count;
        const rest = live.content.items.len - drop;
        // Settled: every span the dropped tokens opened, or a retire left open, closed among
        // them, so no style carries past the cut.
        live.base_styles = .{};
        live.base_link.clearRetainingCapacity();
        self.liveNoteExpired(@intCast(parser.tokens.items.len));
        if (live.display_ends.items.len > 0) live.folded_display_byte_count = live.display_ends.items[live.display_ends.items.len - 1];
        live.display_ends.clearRetainingCapacity();
        live.styled_count = 0;
        live.matches_seen = 0;
        std.mem.copyForwards(u8, live.content.items[0..rest], live.content.items[drop..]);
        live.content.items.len = rest;
        live.content_base += drop;
        live.pending_scan.stop -= drop;
        for (live.pending_runs.items) |*run| run.end -= drop;
        live.pending_scan.scanned -|= drop;
        live.pending_scan.word_start -|= drop;
        live.pending_scan.link_scanned -|= drop;
        live.pending_scan.run_end -|= drop;
        if (live.pending_scan.code) |opener| live.pending_scan.code = opener - drop;
        if (live.pending_code_opener) |opener| live.pending_code_opener = opener - drop;
        parser.rebase(drop);
        live.hold = .{};
        live.cut_draw = .{};
        live.token_display = .{};
        self.liveClampContent();
    }

    /// Tokens before `dropped` go: an expired opener among them is drawn concealed, and turns
    /// literal only when the leaf closes, from a whole parse (one tail write from there).
    fn liveNoteExpired(self: *Doc, dropped: u32) void {
        const live = &self.live;
        const expired = live.parser.expired_from;
        if (expired < dropped) live.expired_display = @min(live.expired_display, self.liveTokensEnd(expired));
    }

    /// The content copy's capacity follows what it holds once it is past the retained maximum.
    fn liveClampContent(self: *Doc) void {
        const content = &self.live.content;
        if (content.capacity > live_retained_byte_count_max and content.capacity > 4 * content.items.len) {
            // shrinkAndFree sets the length too: keep the bytes, free the rest.
            content.shrinkAndFree(self.allocator, content.items.len);
        }
    }

    /// Bounds the live leaf's stores when an opener keeps the stack from emptying (the token
    /// limit makes an opener literal once it is `token_count_max` tokens back, so the first
    /// unresolved token is never further back than that): at twice the limit, the settled
    /// tokens before the first unresolved one and their content go, and the parser parses the
    /// rest again. Each byte is parsed again at most twice.
    fn liveRetire(self: *Doc) Error!void {
        const live = &self.live;
        const parser = &live.parser;
        if (parser.tokens.items.len < 2 * inline_parser.token_count_max) return;
        // A held line keeps its tokens from the pipe on: at most a table header's bytes.
        const held_pipe = self.liveHoldPipe();
        var first = parser.firstUnresolvedToken();
        const r = parser.result();
        if (held_pipe != none) first = @min(first, tokenAt(r.tokens, held_pipe));
        const at = if (first < r.tokens.len) r.tokens[first].start else parser.position;
        if (at <= look_behind_byte_count) return;
        // One code point of look behind stays (flanking reads it).
        var drop = at - look_behind_byte_count;
        while (drop > 0 and (live.content.items[drop] & 0xc0) == 0x80) drop -= 1;
        const folded = self.liveTokensEnd(first);
        // A span can stay open across the cut when a held pipe sits inside it.
        try self.liveStylesAfter(first);
        self.liveNoteExpired(first);
        // A pipe that goes is on a line too long to hold (liveHoldPipe).
        live.line_pipe = if (live.line_pipe != none and live.line_pipe >= drop) live.line_pipe - drop else none;
        live.pipe_line_start = if (live.pipe_line_start != none and live.pipe_line_start >= drop) live.pipe_line_start - drop else none;
        const rest = live.content.items.len - drop;
        std.mem.copyForwards(u8, live.content.items[0..rest], live.content.items[drop..]);
        live.content.items.len = rest;
        live.content_base += drop;
        live.pending_scan.stop -= drop;
        for (live.pending_runs.items) |*run| run.end -= drop;
        live.pending_scan.scanned -|= drop;
        live.pending_scan.word_start -|= drop;
        live.pending_scan.link_scanned -|= drop;
        live.pending_scan.run_end -|= drop;
        if (live.pending_scan.code) |opener| live.pending_scan.code = opener - drop;
        if (live.pending_code_opener) |opener| live.pending_code_opener = opener - drop;
        const visits_before = parser.byte_visits;
        try parser.restart(live.content.items, at - drop);
        live.hold = .{};
        live.cut_draw = .{};
        live.token_display = .{};
        self.counters.inline_byte_visits += parser.byte_visits - visits_before;
        _ = parser.takeChanged();
        // The same tokens from `first` on, so the same display offsets.
        const tokens = parser.result().tokens;
        live.folded_display_byte_count = folded;
        try live.display_ends.resize(self.allocator, tokens.len);
        live.styled_count = 0;
        live.matches_seen = 0;
        var offset = folded;
        for (0..tokens.len) |i| {
            offset += inline_parser.tokenDisplayLength(parser.result(), @intCast(i));
            live.display_ends.items[i] = offset;
        }
        // Capacity follows what the stores hold now.
        const keep = 2 * inline_parser.token_count_max;
        if (parser.tokens.capacity > 2 * keep) parser.tokens.shrinkAndFree(self.allocator, parser.tokens.items.len);
        if (live.display_ends.capacity > 2 * keep) live.display_ends.shrinkAndFree(self.allocator, live.display_ends.items.len);
        self.liveClampContent();
    }

    /// The display bytes of leaf `index` (read_leaf's text): its inline content with markers
    /// concealed.
    pub fn leafDisplay(self: *const Doc, arena: Allocator, index: u32) Error![]const u8 {
        return (try self.readLeaf(arena, index)).bytes.items;
    }

    /// "\n" and a setext heading's underline line, as the display shows it.
    fn setextUnderline(self: *const Doc, arena: Allocator, index: u32) Error![]const u8 {
        const b = self.blocks.items[index];
        const s = self.source.items;
        const line = std.mem.trim(u8, s[lineStart(s, b.source_end_byte)..b.source_end_byte], " \t");
        const start = std.mem.indexOfAny(u8, line, "=-") orelse 0;
        return std.mem.concat(arena, u8, &.{ "\n", line[start..] });
    }

    /// Parser output for leaf `index` (read_leaf, design "What the engine writes"): display bytes,
    /// chunks of one style each with span flags, and the URL pool the chunks' links point into.
    /// Prose leaves get their inline styles; a fence or math block gives its normalized code, an
    /// HTML block its source text. Styles are Markdown scopes; M2 resolves them through the
    /// document's SyntaxStyle into `ot_styled_text_chunk` values.
    pub fn readLeaf(self: *const Doc, arena: Allocator, index: u32) Error!Leaf {
        const b = self.blocks.items[index];
        var leaf: Leaf = .{};
        var writer: LeafWriter = .{ .arena = arena, .leaf = &leaf };
        writer.base.heading_level = if (b.kind == .heading) @intCast(b.payload[0]) else 0;
        if (!isInlineLeaf(b)) {
            const content = try self.leafContent(arena, index);
            writer.base.raw = b.kind == .code;
            writer.base.math = b.flags.math;
            try writer.write(content.bytes, .{});
            return leaf;
        }
        // An open prose leaf shows what B shows of it: its tokens so far (an opener that waits is
        // concealed as if closed), the untokenized bytes it may draw, minus what B holds back.
        var parser: inline_parser.Parser = .{ .allocator = arena, .references = self.references(), .options = .{ .math = self.options.math, .math_blocks = self.options.math and b.kind == .paragraph } };
        var cut: u32 = none;
        // A table cell of the pending row is drawn the same way.
        // (A cell of a row that ended is closed; one of the pending row stays open.)
        const pending_cell = b.kind == .table_cell and b.flags.open;
        // A paragraph the pending line's layout ends shows its final display.
        const open = (b.flags.open and !b.flags.ending and (b.kind == .paragraph or b.kind == .heading)) or pending_cell;
        if (open) {
            // As the live leaf holds it: each complete line ends in '\n'.
            var body = (try self.leafContent(arena, index)).bytes;
            if (pending_cell) body = try unescapePipes(arena, body);
            const complete = b.content_end_byte <= self.line_start_byte;
            var content = if (complete and b.kind == .paragraph) try std.mem.concat(arena, u8, &.{ body, "\n" }) else body;
            if (b.kind == .paragraph and content.len > 0 and content[0] == '[') {
                // Leading definitions are not shown; the prose after them once that is decided.
                const complete_end: usize = if (complete) content.len else if (std.mem.lastIndexOfScalar(u8, content, '\n')) |n| n + 1 else 0;
                const prose = definitionProse(content[0..complete_end], 0, false).prose orelse return leaf;
                content = content[prose..];
                body = body[prose..];
            }
            try parser.feed(content, false);
            // The last line, complete or pending, waits from its first pipe: with the next line
            // it may be a table's header (unless it is longer than a header can be).
            if (b.kind == .paragraph) {
                const last_start: usize = if (std.mem.lastIndexOfScalar(u8, body, '\n')) |n| n + 1 else 0;
                if (body.len - last_start <= held_line_byte_count_max) {
                    if (std.mem.indexOfScalar(u8, body[last_start..], '|')) |at| cut = @intCast(last_start + at);
                }
            }
        } else {
            try parser.feed(try self.leafSubject(arena, index), true);
        }
        const r = parser.result();
        var styler: TokenStyler = .{ .writer = &writer, .arena = arena, .r = r, .conceal = self.options.conceal, .hyperlinks = self.options.hyperlinks };
        if (!self.options.conceal and b.kind == .heading and !b.flags.setext) {
            // Without conceal an ATX heading shows its marker.
            var marker: [7]u8 = @splat('#');
            marker[writer.base.heading_level] = ' ';
            try writer.write(marker[0 .. writer.base.heading_level + 1], .{});
        }
        var i: u32 = 0;
        while (i < r.tokens.len) : (i += 1) {
            const t = r.tokens[i];
            // A token that reaches the held pipe shows what B drew of it before the pipe.
            if (cut != none and t.end() > cut) {
                if (t.start < cut) try styler.partial(i, cut);
                break;
            }
            try styler.token(i);
        }
        writer.link = null;
        writer.base.strong = false;
        writer.base.italic = false;
        writer.base.strikethrough = false;
        if (open and i == r.tokens.len and parser.position < cut) {
            const content = r.content[0..@min(cut, r.content.len)];
            const code = parser.search_opener == parser.position and parser.position < content.len and content[parser.position] == '`';
            if (!self.options.conceal) {
                try writer.write(content[parser.position..], .{});
            } else {
                var pending: std.ArrayListUnmanaged(u8) = .empty;
                var scan: inline_parser.PendingScan = .{};
                var runs: std.ArrayListUnmanaged(inline_parser.PendingRun) = .empty;
                try inline_parser.renderPendingRuns(content, parser.position, if (code) parser.position else null, &scan, arena, &pending, &runs);
                var spans: inline_parser.PendingSpans = .{};
                var marked: u64 = 0;
                _ = try spans.add(runs.items, arena, &marked);
                writer.base.raw = code;
                try writer.writePending(pending.items, 0, @intCast(pending.items.len), spans.kinds.items, .{ .code = code });
                writer.base.raw = false;
            }
        }
        if (b.flags.setext) try writer.write(try self.setextUnderline(arena, index), .{});
        return leaf;
    }

    fn computeUnresolved(self: *Doc, index: u32) Error!void {
        const arena = self.scratch.allocator();
        const result = try self.parseLeaf(arena, index);
        if (self.blocks.items[index].flags.unresolved != result.unresolved) {
            (try self.blockMut(index)).flags.unresolved = result.unresolved;
        }
    }

    pub fn isInlineLeaf(b: Block) bool {
        return isInlineKind(b.kind);
    }

    fn isInlineKind(kind: Kind) bool {
        return kind == .paragraph or kind == .heading or kind == .table_cell;
    }

    /// The inline parse of a leaf (paragraph, heading, table cell).
    /// A leaf's inline content as the parser takes it: trailing whitespace and a table cell's
    /// escaped pipes removed.
    pub fn leafSubject(self: *const Doc, arena: Allocator, index: u32) Error![]const u8 {
        const content = try self.leafContent(arena, index);
        var bytes = content.bytes;
        var end = bytes.len;
        while (end > 0 and (bytes[end - 1] == ' ' or bytes[end - 1] == '\t' or bytes[end - 1] == '\n')) end -= 1;
        bytes = bytes[0..end];
        const kind = self.blocks.items[index].kind;
        if (kind == .table_cell) bytes = try unescapePipes(arena, bytes);
        // A paragraph's leading definitions are not prose (an ending paragraph still holds them).
        if (kind == .paragraph) bytes = bytes[definitionProse(bytes, 0, true).prose.?..];
        return bytes;
    }

    pub fn parseLeaf(self: *const Doc, arena: Allocator, index: u32) Error!inline_parser.Result {
        return inline_parser.parse(arena, try self.leafSubject(arena, index), self.references(), .{ .math = self.options.math });
    }

    pub fn references(self: *const Doc) inline_parser.References {
        return .{ .context = self, .lookup_fn = lookupReference };
    }

    fn lookupReference(context: *const anyopaque, label: []const u8) ?inline_parser.Link {
        const self: *const Doc = @ptrCast(@alignCast(context));
        return self.definitionLink(self.lookupIndex(label) orelse return null);
    }

    fn lookupIndex(self: *const Doc, label: []const u8) ?u32 {
        const arena = self.scratch.allocator();
        const normalized = normalizeLabel(arena, label) catch return null;
        if (normalized.len == 0) return null;
        const hash: u32 = @truncate(std.hash.Wyhash.hash(0, normalized));
        return self.findDefinition(arena, normalized, hash);
    }

    fn definitionLink(self: *const Doc, index: u32) ?inline_parser.Link {
        const arena = self.scratch.allocator();
        const d = self.definitions.items[index];
        const s = self.source.items;
        const title = if (d.title_start_byte == none) null else self.spanText(arena, d.parent_index, d.title_start_byte, d.title_end_byte) catch return null;
        return .{ .image = false, .destination = s[d.destination_start_byte..d.destination_end_byte], .title = title };
    }

    /// Source bytes [start, end) with the line prefixes of `parent`'s containers removed.
    fn spanText(self: *const Doc, arena: Allocator, parent: u32, start: u32, end: u32) Error![]const u8 {
        const s = self.source.items;
        if (std.mem.indexOfAny(u8, s[start..end], "\r\n") == null) return s[start..end];
        var out: std.ArrayListUnmanaged(u8) = .empty;
        var ancestors_buffer: [depth_max + 1]u32 = undefined;
        const ancestors = self.ancestorChain(parent, &ancestors_buffer);
        var at = start;
        var first = true;
        while (at < end) {
            const line_end = @min(lineContentEnd(s, at), end);
            var from = at;
            if (!first) {
                var line = Line{ .s = s, .start = at, .end = lineContentEnd(s, at), .offset = at };
                _ = self.matchContainers(&line, ancestors);
                line.findNextNonspace();
                from = line.next_nonspace;
            }
            try out.appendSlice(arena, s[from..@max(from, line_end)]);
            if (line_end >= end) break;
            try out.append(arena, '\n');
            at = nextLineStart(s, line_end);
            first = false;
        }
        return out.items;
    }

    // ---- Leaf content ----

    pub const LeafContent = struct {
        bytes: []const u8,
        /// For each content line: its offset in `bytes` and the source offset it came from.
        lines: []const [2]u32,

        pub fn sourceOffset(self: LeafContent, offset: u32) u32 {
            var low: usize = 0;
            var high: usize = self.lines.len;
            while (high - low > 1) {
                const mid = (low + high) / 2;
                if (self.lines[mid][0] <= offset) low = mid else high = mid;
            }
            const line = self.lines[low];
            return line[1] + (offset - line[0]);
        }
    };

    /// The content of leaf `index`: lines joined by '\n'. Paragraph lines lose their leading
    /// whitespace; code lines keep theirs past the code indent (a partly consumed tab becomes
    /// spaces).
    pub fn leafContent(self: *const Doc, arena: Allocator, index: u32) Error!LeafContent {
        const s = self.source.items;
        const b = self.blocks.items[index];
        var out: std.ArrayListUnmanaged(u8) = .empty;
        var lines: std.ArrayListUnmanaged([2]u32) = .empty;
        if (b.kind == .table_cell or (b.kind == .heading and !b.flags.setext)) {
            try lines.append(arena, .{ 0, b.content_start_byte });
            try out.appendSlice(arena, s[b.content_start_byte..b.content_end_byte]);
            return .{ .bytes = out.items, .lines = lines.items };
        }
        if (b.kind == .code and (b.flags.fenced or b.flags.math)) {
            const opener_end = openerLineEnd(s, b);
            if (b.content_start_byte == opener_end) return .{ .bytes = "", .lines = &.{.{ 0, b.content_start_byte }} };
            if (b.content_start_byte < opener_end) {
                // A one-line math block: its body.
                try lines.append(arena, .{ 0, b.content_start_byte });
                return .{ .bytes = s[b.content_start_byte..b.content_end_byte], .lines = lines.items };
            }
        } else if (b.content_start_byte >= b.content_end_byte and b.kind != .code) {
            return .{ .bytes = "", .lines = &.{.{ 0, b.content_start_byte }} };
        }
        var ancestors_buffer: [depth_max + 1]u32 = undefined;
        const ancestors = self.ancestorChain(b.parent_index, &ancestors_buffer);
        const prose = b.kind == .paragraph or b.kind == .heading;
        var at = b.content_start_byte;
        var first = true;
        while (true) {
            const line_end = lineContentEnd(s, at);
            var line = Line{ .s = s, .start = lineStart(s, at), .end = line_end, .offset = at };
            if (!first or (b.kind == .code and (b.flags.fenced or b.flags.math))) {
                line.offset = line.start;
                _ = self.matchContainers(&line, ancestors);
            }
            if (prose) {
                line.findNextNonspace();
                line.advanceNextNonspace();
            } else if (b.kind == .code) {
                if (b.flags.fenced or b.flags.math) {
                    var remaining: u32 = b.small;
                    while (remaining > 0 and isSpaceOrTab(line.peek(line.offset))) : (remaining -= 1) line.advanceOffset(1, true);
                } else if (first) {
                    line.column = 0;
                    if (b.small > 0) {
                        line.partially_consumed_tab = true;
                        line.column = 4 - b.small;
                    }
                } else {
                    line.findNextNonspace();
                    if (line.indent >= 4) line.advanceOffset(4, true) else line.advanceNextNonspace();
                }
            }
            if (line.partially_consumed_tab) {
                const columns = 4 - line.column % 4;
                try out.appendNTimes(arena, ' ', columns);
                line.offset += 1;
            }
            try lines.append(arena, .{ @intCast(out.items.len), line.offset });
            if (line.offset < line_end) try out.appendSlice(arena, s[line.offset..line_end]);
            if (line_end >= b.content_end_byte) break;
            try out.append(arena, '\n');
            at = nextLineStart(s, line_end);
            first = false;
            if (at > b.content_end_byte) break;
        }
        return .{ .bytes = out.items, .lines = lines.items };
    }

    fn ancestorChain(self: *const Doc, parent: u32, buffer: *[depth_max + 1]u32) []const u32 {
        var count: usize = 0;
        var p = parent;
        while (p != none) : (p = self.blocks.items[p].parent_index) {
            buffer[count] = p;
            count += 1;
        }
        std.mem.reverse(u32, buffer[0..count]);
        return buffer[0..count];
    }

    /// Consumes the continuation markers of `ancestors` on `line`; false when one fails (a lazy
    /// paragraph line).
    fn matchContainers(self: *const Doc, line: *Line, ancestors: []const u32) bool {
        for (ancestors) |ancestor| {
            const b = self.blocks.items[ancestor];
            line.findNextNonspace();
            if (b.kind != .quote and b.kind != .item) continue;
            if (self.continues(line, ancestor, b) != .matches) return false;
        }
        return true;
    }
};

// ---- Line state (commonmark.js's parser fields) ----

const Line = struct {
    s: []const u8,
    start: u32,
    end: u32,
    offset: u32,
    column: u32 = 0,
    next_nonspace: u32 = 0,
    next_nonspace_column: u32 = 0,
    indent: u32 = 0,
    indented: bool = false,
    blank: bool = false,
    partially_consumed_tab: bool = false,
    /// A block start took the whole line (heading, fence opener, rule, table row).
    consumed: bool = false,
    /// One past the last byte read (the block parser's work counter).
    read_end: u32 = 0,

    fn peek(self: *Line, at: u32) u8 {
        self.read_end = @max(self.read_end, @min(at + 1, self.end));
        return if (at < self.end) self.s[at] else 0;
    }

    /// A check that reads the rest of the line.
    fn readAll(self: *Line) void {
        self.read_end = self.end;
    }

    fn touch(self: *Line, at: u32) void {
        self.read_end = @max(self.read_end, @min(at, self.end));
    }

    fn findNextNonspace(self: *Line) void {
        var i = self.offset;
        var columns = self.column;
        while (i < self.end) {
            const c = self.s[i];
            if (c == ' ') {
                i += 1;
                columns += 1;
            } else if (c == '\t') {
                i += 1;
                columns += 4 - columns % 4;
            } else break;
        }
        self.blank = i >= self.end;
        self.read_end = @max(self.read_end, @min(i + 1, self.end));
        self.next_nonspace = i;
        self.next_nonspace_column = columns;
        self.indent = columns - self.column;
        self.indented = self.indent >= 4;
    }

    fn advanceNextNonspace(self: *Line) void {
        self.offset = self.next_nonspace;
        self.column = self.next_nonspace_column;
        self.partially_consumed_tab = false;
    }

    fn advanceOffset(self: *Line, count_initial: u32, columns: bool) void {
        var count = count_initial;
        while (count > 0 and self.offset < self.end) {
            const c = self.s[self.offset];
            if (c == '\t') {
                const to_tab = 4 - self.column % 4;
                if (columns) {
                    self.partially_consumed_tab = to_tab > count;
                    const advance = @min(to_tab, count);
                    self.column += advance;
                    if (!self.partially_consumed_tab) self.offset += 1;
                    count -= advance;
                } else {
                    self.partially_consumed_tab = false;
                    self.column += to_tab;
                    self.offset += 1;
                    count -= 1;
                }
            } else {
                self.partially_consumed_tab = false;
                self.offset += 1;
                self.column += 1;
                count -= 1;
            }
        }
    }
};

// ---- Helpers over source bytes ----

/// Markdown scopes of one chunk (the names Core styles prose with today: markup.heading.N,
/// markup.strong, markup.italic, markup.strikethrough, markup.raw, markup.link, markup.math,
/// string.escape).
pub const Scope = packed struct(u16) {
    heading_level: u3 = 0,
    strong: bool = false,
    italic: bool = false,
    strikethrough: bool = false,
    raw: bool = false,
    link: bool = false,
    math: bool = false,
    escape: bool = false,
    /// A link's brackets and parentheses: `markup.link` without `markup.link.label`.
    link_gap: bool = false,
    /// A link's URL as text: `markup.link.url`.
    link_url: bool = false,
    _unused: u4 = 0,
};

/// Span flags per chunk (design: OT_MD_SPAN_CODE, OT_MD_SPAN_MATH).
pub const Span = packed struct(u32) {
    code: bool = false,
    math: bool = false,
    _unused: u30 = 0,
};

pub const Chunk = struct {
    byte_count: u32,
    scope: Scope,
    span: Span,
    /// The link target in `Leaf.urls`; zero length without a link.
    link_offset: u32 = 0,
    link_byte_count: u32 = 0,
};

pub const Alignment = enum { none, left, center, right };

pub const Leaf = struct {
    bytes: std.ArrayListUnmanaged(u8) = .empty,
    chunks: std.ArrayListUnmanaged(Chunk) = .empty,
    urls: std.ArrayListUnmanaged(u8) = .empty,
};

const Styles = struct {
    strong: i32 = 0,
    italic: i32 = 0,
    strikethrough: i32 = 0,
    /// The outermost link's or image's target and its link index + 1 (an image inside a link
    /// keeps the link's target).
    link: ?[2]u32 = null,
    link_owner: u16 = 0,

    fn apply(self: *Styles, kind: inline_parser.MatchKind, delta: i32) void {
        switch (kind) {
            .strong => self.strong += delta,
            .emphasis => self.italic += delta,
            .strikethrough => self.strikethrough += delta,
        }
    }
};

const LeafWriter = struct {
    arena: Allocator,
    leaf: *Leaf,
    base: Scope = .{},
    link: ?[2]u32 = null,
    /// Only chunks (and URLs): the bytes are the caller's (the live leaf's runs).
    count_only: bool = false,
    /// Display bytes written so far (`leaf.bytes.items.len` unless count_only).
    byte_count: usize = 0,

    /// Appends bytes with the current style, merging into the previous chunk when equal.
    fn write(self: *LeafWriter, bytes: []const u8, span: Span) Error!void {
        if (bytes.len == 0) return;
        if (!self.count_only) try self.leaf.bytes.appendSlice(self.arena, bytes);
        return self.writeLength(@intCast(bytes.len), span);
    }

    fn writeLength(self: *LeafWriter, byte_count: u32, span: Span) Error!void {
        if (byte_count == 0) return;
        self.byte_count += byte_count;
        var scope = self.base;
        scope.link = self.link != null;
        const link = self.link orelse [2]u32{ 0, 0 };
        const chunks = &self.leaf.chunks;
        if (chunks.items.len > 0) {
            const last = &chunks.items[chunks.items.len - 1];
            if (@as(u16, @bitCast(last.scope)) == @as(u16, @bitCast(scope)) and @as(u32, @bitCast(last.span)) == @as(u32, @bitCast(span)) and
                last.link_offset == link[0] and last.link_byte_count == link[1] and !span.code and !span.math)
            {
                last.byte_count += byte_count;
                return;
            }
        }
        try chunks.append(self.arena, .{ .byte_count = byte_count, .scope = scope, .span = span, .link_offset = link[0], .link_byte_count = link[1] });
    }

    /// Plain content bytes [start, end), with GFM email autolinks inside them linked.
    fn plain(self: *LeafWriter, r: inline_parser.Result, start: u32, end: u32) Error!void {
        var at = start;
        for (r.emails) |email| {
            if (email[1] <= at or email[0] >= end) continue;
            if (at < email[0]) try self.write(r.content[at..email[0]], .{});
            const saved = self.link;
            // Inside a link or image its target stays.
            self.link = saved orelse try self.url("mailto:", r.content[email[0]..email[1]]);
            const stop = @min(end, email[1]);
            try self.write(r.content[@max(at, email[0])..stop], .{});
            self.link = saved;
            at = stop;
        }
        if (at < end) try self.write(r.content[at..end], .{});
    }

    /// Writes a link's brackets and parentheses (`gap`), its URL as text, or a byte of it drawn
    /// as plain text, styled as OpenCode's frames show them.
    fn linkPart(self: *LeafWriter, bytes: []const u8, part: enum { gap, url, text }) Error!void {
        const saved = self.base;
        const link = self.link;
        defer {
            self.base = saved;
            self.link = link;
        }
        switch (part) {
            .gap => self.base.link_gap = true,
            .url => self.base.link_url = true,
            .text => self.link = null,
        }
        return self.write(bytes, .{});
    }

    /// B's drawn bytes [start, end) (`bytes`, or only their count), styled by the kinds of the
    /// spans over each (`kinds`, a bit per MatchKind per drawn byte; none past its end).
    fn writePending(self: *LeafWriter, bytes: ?[]const u8, start: u32, end: u32, kinds: []const u8, span: Span) Error!void {
        const saved = self.base;
        defer self.base = saved;
        var at = start;
        while (at < end) {
            const bits = if (at < kinds.len) kinds[at] else 0;
            var next = at + 1;
            while (next < end and (if (next < kinds.len) kinds[next] else 0) == bits) next += 1;
            self.base.italic = saved.italic or bits & inline_parser.kindBit(.emphasis) != 0;
            self.base.strong = saved.strong or bits & inline_parser.kindBit(.strong) != 0;
            self.base.strikethrough = saved.strikethrough or bits & inline_parser.kindBit(.strikethrough) != 0;
            if (bytes) |b| try self.write(b[at - start .. next - start], span) else try self.writeLength(next - at, span);
            at = next;
        }
    }

    fn url(self: *LeafWriter, prefix: []const u8, target: []const u8) Error![2]u32 {
        const offset: u32 = @intCast(self.leaf.urls.items.len);
        try self.leaf.urls.appendSlice(self.arena, prefix);
        try self.leaf.urls.appendSlice(self.arena, target);
        return .{ offset, @intCast(prefix.len + target.len) };
    }
};

/// Writes an inline result's tokens with their styles: read_leaf over a parse of the whole
/// leaf, and the live leaf's runs over its tokens (a count-only writer; conceal and hyperlinks
/// on, as the live display is drawn). `styles` carries span and link state across tokens.
const TokenStyler = struct {
    writer: *LeafWriter,
    arena: Allocator,
    r: inline_parser.Result,
    styles: Styles = .{},
    conceal: bool = true,
    hyperlinks: bool = true,
    /// Where the open link's label starts in the leaf's bytes, and its URL (URL suffixes).
    label_start: usize = 0,
    label_url: []const u8 = "",
    image: bool = false,
    /// Set for the live leaf, whose parser keeps links' bytes as slices that later appends
    /// move: a link's destination is found again from the current bytes.
    references: ?inline_parser.References = null,

    fn sync(self: *TokenStyler) void {
        self.writer.base.strong = self.styles.strong > 0;
        self.writer.base.italic = self.styles.italic > 0;
        self.writer.base.strikethrough = self.styles.strikethrough > 0;
        self.writer.link = self.styles.link;
    }

    fn token(self: *TokenStyler, i: u32) Error!void {
        const r = self.r;
        const w = self.writer;
        const t = r.tokens[i];
        const raw = r.content[t.start..t.end()];
        self.sync();
        switch (t.kind) {
            .delimiter => {
                const d_index = inline_parser.delimiterOf(r, i);
                const d = if (d_index) |di| r.delimiters[di] else null;
                const length = inline_parser.tokenDisplayLength(r, i);
                // A run may close spans and open others (CommonMark 6.2: `*a***b**`): the
                // closing matches end their styles, the literal rest shows, then the opening
                // matches start theirs. Shown, a marker takes the style of what it marks.
                var closed: u32 = 0;
                if (d) |dd| {
                    var m = dd.closer_first_match;
                    while (m < dd.closer_first_match + dd.closer_match_count) : (m += 1) closed += r.matches[m].count;
                    if (!self.conceal) try w.write(raw[0..closed], .{});
                    m = dd.closer_first_match;
                    while (m < dd.closer_first_match + dd.closer_match_count) : (m += 1) self.styles.apply(r.matches[m].kind, -1);
                }
                self.sync();
                const literal = if (self.conceal) length else if (d) |dd| dd.count else @as(u32, @intCast(raw.len)) - closed;
                try w.plain(r, t.start + closed, t.start + closed + literal);
                if (d) |dd| {
                    var m = dd.opener_matches;
                    while (m) |mi| : (m = r.matches[mi].next_for_opener) self.styles.apply(r.matches[mi].kind, 1);
                    self.sync();
                    if (!self.conceal) try w.write(raw[closed + literal ..], .{});
                }
            },
            .bracket_open => {
                if (t.aux == 0) return w.write(raw, .{});
                // The outermost link or image owns the target until its own `]` (an image inside a
                // link keeps the link's).
                if (self.styles.link == null) {
                    const url = try self.destination(i);
                    self.styles.link = try w.url("", url);
                    self.styles.link_owner = t.aux;
                    self.label_start = w.byte_count;
                    self.label_url = url;
                    self.image = r.links[t.aux - 1].image;
                    self.sync();
                }
                if (!self.conceal) try w.linkPart(raw, .gap);
            },
            .bracket_close => {
                if (t.aux == 0) return w.write(raw[0..1], .{});
                const owner = t.aux == self.styles.link_owner;
                if (!self.conceal) {
                    // An inline link's destination (and title) between `](` and `)`.
                    // As OpenCode's frames show it: `]` is text, `(` and `)` are the link's.
                    if (raw.len >= 3 and std.mem.startsWith(u8, raw, "](") and raw[raw.len - 1] == ')') {
                        try w.linkPart(raw[0..1], .text);
                        try w.linkPart(raw[1..2], .gap);
                        try w.linkPart(raw[2 .. raw.len - 1], .url);
                        try w.linkPart(raw[raw.len - 1 ..], .gap);
                    } else try w.linkPart(raw, .gap);
                }
                if (!owner) return;
                // Without hyperlinks a label that is not its URL shows where the link goes.
                if (self.conceal and !self.hyperlinks and !self.image and !std.mem.eql(u8, w.leaf.bytes.items[self.label_start..], self.label_url)) {
                    assert(!w.count_only);
                    try w.linkPart(" ", .text);
                    try w.linkPart("(", .gap);
                    try w.linkPart(self.label_url, .url);
                    try w.linkPart(")", .gap);
                }
                self.styles.link = null;
                self.styles.link_owner = 0;
            },
            .autolink, .autolink_email, .extended_autolink => {
                const target = if (t.kind == .extended_autolink) raw else raw[1 .. raw.len - 1];
                const prefix: []const u8 = if (t.kind == .autolink_email) "mailto:" else if (t.kind == .extended_autolink and t.aux == @backingInt(inline_parser.ExtendedKind.www)) "http://" else "";
                // Inside a link or image its target stays.
                if (w.link == null) w.link = try w.url(prefix, target);
                const angled = !self.conceal and t.kind != .extended_autolink;
                if (angled) try w.linkPart(raw[0..1], .gap);
                try w.write(target, .{});
                if (angled) try w.linkPart(raw[raw.len - 1 ..], .gap);
            },
            .code => {
                w.base.raw = true;
                defer w.base.raw = false;
                if (!self.conceal) return w.write(raw, .{ .code = true });
                if (w.count_only) return w.writeLength(inline_parser.tokenDisplayLength(r, i), .{ .code = true });
                var display: std.ArrayListUnmanaged(u8) = .empty;
                try inline_parser.appendTokenDisplay(r, i, self.arena, &display);
                try w.write(display.items, .{ .code = true });
            },
            .math => {
                w.base.math = true;
                defer w.base.math = false;
                try w.write(if (self.conceal) raw[t.aux .. raw.len - t.aux] else raw, .{ .math = true });
            },
            .escape => {
                w.base.escape = true;
                defer w.base.escape = false;
                try w.write(if (self.conceal) raw[1..] else raw, .{});
            },
            .text => try w.plain(r, t.start, t.end()),
            else => {
                if (!self.conceal) return w.write(raw, .{});
                if (w.count_only) return w.writeLength(inline_parser.tokenDisplayLength(r, i), .{});
                var display: std.ArrayListUnmanaged(u8) = .empty;
                try inline_parser.appendTokenDisplay(r, i, self.arena, &display);
                try w.write(display.items, .{});
            },
        }
    }

    /// The destination of the link token `open` opens, from its closing token: the tail of an
    /// inline link, or the label of a reference.
    /// Link `open`'s destination, unescaped.
    fn destination(self: *TokenStyler, open: u32) Error![]const u8 {
        const link = self.r.links[self.r.tokens[open].aux - 1];
        return inline_parser.unescapeText(self.arena, if (self.references != null) self.liveDestination(open) else link.destination);
    }

    fn liveDestination(self: *TokenStyler, open: u32) []const u8 {
        const r = self.r;
        const aux = r.tokens[open].aux;
        var j = open + 1;
        while (j < r.tokens.len and !(r.tokens[j].kind == .bracket_close and r.tokens[j].aux == aux)) j += 1;
        assert(j < r.tokens.len);
        const close = r.tokens[j];
        const raw = r.content[close.start..close.end()];
        if (raw.len > 1 and raw[1] == '(') {
            var at: u32 = 2;
            while (at < raw.len and (raw[at] == ' ' or raw[at] == '\t' or raw[at] == '\n')) at += 1;
            const scanned = (inline_parser.scanDestination(raw, at, true) catch null) orelse return "";
            return scanned.value;
        }
        const label = if (raw.len > 3 and raw[1] == '[') raw[2 .. raw.len - 1] else r.content[r.tokens[open].end()..close.start];
        const found = self.references.?.lookup(label) orelse return "";
        return found.destination;
    }

    /// Token `i` cut by a hold at content offset `cut`: what B drew of it before the cut (a cut
    /// math span is literal).
    fn partial(self: *TokenStyler, i: u32, cut: u32) Error!void {
        const w = self.writer;
        const t = self.r.tokens[i];
        self.sync();
        w.base.raw = t.kind == .code;
        defer w.base.raw = false;
        const span: Span = .{ .code = t.kind == .code };
        if (!self.conceal) return w.write(self.r.content[t.start..cut], span);
        var before: std.ArrayListUnmanaged(u8) = .empty;
        try inline_parser.appendTokenDisplayBefore(self.r, i, cut, self.arena, &before);
        try w.write(before.items, span);
    }
};

/// Capacity the live leaf keeps between leaves; a larger store is released when its leaf ends.
const live_retained_byte_count_max: usize = 64 << 10;

/// Whether a fence line can still become the fence's closer: fence characters, then spaces.
fn closerPrefix(rest: []const u8, opener: u8, math: bool) bool {
    var trimmed = rest;
    while (trimmed.len > 0 and isSpaceOrTab(trimmed[trimmed.len - 1])) trimmed.len -= 1;
    if (math) {
        const closer: []const u8 = if (opener == '$') "$$" else "\\]";
        return trimmed.len <= closer.len and std.mem.startsWith(u8, closer, trimmed);
    }
    for (trimmed) |c| {
        if (c != opener) return false;
    }
    return true;
}

/// Whether a pending line, from its first byte after the container markers, can still change
/// kind (D93 Q4 B): a marker that is not complete yet, a line that may be a thematic break,
/// setext underline, fence, HTML block or display math opener, a table's delimiter row
/// (`delimiter_row`: the line has no other bytes yet), or a line that starts with a pipe. A list
/// item or quote marker that is complete is decided; what follows it is judged the same way.
/// Once a line is not held, no later byte holds it again (its first bytes decided it), so a
/// line shown is never withdrawn; another line with a pipe shows up to its first pipe.
/// A held pending line, and the bytes that keep it held as more arrive (so the next call reads
/// only the new bytes): `any` holds it until its line ends.
const Hold = struct {
    held: bool,
    keep: []const u8 = "",
    any: bool = false,
    /// Where a held line's last marker starts, and the scan's state there: the next call
    /// resumes from it instead of reading the line again (none: from the line start).
    resume_at: u32 = none,
    state: MarkerScan = .{},

    const not: Hold = .{ .held = false };
    const again: Hold = .{ .held = true };
    const to_line_end: Hold = .{ .held = true, .any = true };

    fn keeping(keep: []const u8) Hold {
        return .{ .held = true, .keep = keep };
    }
};

/// The block markers heldPrefix has read: whether the last was a list item's, and how many.
const MarkerScan = struct { after_item: bool = false, markers: u32 = 0 };

/// Whether the pending line's kind can still change, reading its markers from `from` (a
/// marker's start, or the line's first non-space byte) with the scan state there. A held line
/// records where its last marker starts, so the next call reads on from there.
fn heldPrefix(s: []const u8, from: u32, end: u32, state: MarkerScan, delimiter_row: bool, in_table: bool) Hold {
    if (delimiter_row) return Hold.keeping(" \t:-|");
    var at = from;
    var scan = state;
    // Markers past the nesting limit are text, so the line is decided after that many.
    while (scan.markers <= depth_max) : (scan.markers += 1) {
        while (at < end and isSpaceOrTab(s[at])) at += 1;
        switch (heldMarker(s[at..end], scan.after_item, in_table)) {
            .decided => |hold| {
                var held = hold;
                if (held.held) {
                    held.resume_at = at;
                    held.state = scan;
                }
                return held;
            },
            .container => |length| {
                if (s[at] != '>') scan.after_item = true;
                at += length;
            },
        }
    }
    return Hold.not;
}

const HeldMarker = union(enum) {
    /// The line's hold is decided at this marker (held: it is undecided here).
    decided: Hold,
    /// A whole container marker of this many bytes; the scan reads on after it.
    container: u32,
};

fn heldMarker(rest: []const u8, after_item: bool, in_table: bool) HeldMarker {
    // Nothing after the markers yet: spaces keep it so.
    if (rest.len == 0) return .{ .decided = Hold.keeping(" \t") };
    const c = rest[0];
    // A task marker after a list item marker: `[`, `[x`, `[x]` and spaces may still be one.
    if (after_item and c == '[') {
        if (!taskPrefix(rest)) return .{ .decided = Hold.not };
        return .{ .decided = if (rest.len >= 3) Hold.keeping(" \t") else Hold.again };
    }
    return switch (c) {
        '>' => .{ .container = 1 },
        '-', '*', '+', '_', '=' => {
            if (onlyBytes(rest, c)) return .{ .decided = Hold.keeping(switch (c) {
                '-' => "- \t",
                '*' => "* \t",
                '+' => "+ \t",
                '_' => "_ \t",
                else => "= \t",
            }) };
            if (c == '_' or c == '=') return .{ .decided = Hold.not };
            if (rest.len < 2) return .{ .decided = Hold.again };
            if (!isSpaceOrTab(rest[1])) return .{ .decided = Hold.not };
            return .{ .container = 1 };
        },
        '0'...'9' => {
            // An ordered list marker has at most nine digits: read ten at most.
            var i: u32 = 0;
            while (i < rest.len and i < 10 and std.ascii.isDigit(rest[i])) i += 1;
            if (i >= rest.len) return .{ .decided = if (i <= 9) Hold.again else Hold.not };
            if (i > 9 or (rest[i] != '.' and rest[i] != ')')) return .{ .decided = Hold.not };
            if (i + 1 >= rest.len) return .{ .decided = Hold.again };
            if (!isSpaceOrTab(rest[i + 1])) return .{ .decided = Hold.not };
            return .{ .container = i + 1 };
        },
        '#' => {
            var i: usize = 0;
            while (i < rest.len and i <= 6 and rest[i] == '#') i += 1;
            if (i > 6) return .{ .decided = Hold.not };
            if (i >= rest.len) return .{ .decided = Hold.again };
            if (!isSpaceOrTab(rest[i])) return .{ .decided = Hold.not };
            return .{ .decided = if (onlyBytesOf(rest[i..], " \t")) Hold.keeping(" \t") else Hold.not };
        },
        '`', '~' => {
            const run = inline_parser.runLength(rest, 0, c);
            if (run >= 3) return .{ .decided = Hold.to_line_end };
            return .{ .decided = if (run == rest.len) Hold.again else Hold.not };
        },
        '<' => .{ .decided = Hold.to_line_end },
        '|' => .{ .decided = if (in_table) Hold.not else Hold.to_line_end },
        ':' => .{ .decided = if (onlyBytesOf(rest, ":-| \t")) Hold.keeping(" \t:-|") else Hold.not },
        else => .{ .decided = Hold.not },
    };
}

fn taskPrefix(rest: []const u8) bool {
    if (rest.len >= 2 and rest[1] != ' ' and rest[1] != 'x' and rest[1] != 'X') return false;
    if (rest.len >= 3 and rest[2] != ']') return false;
    return rest.len <= 3 or onlyBytesOf(rest[3..], " \t");
}

fn onlyBytes(rest: []const u8, c: u8) bool {
    for (rest) |x| {
        if (x != c and !isSpaceOrTab(x)) return false;
    }
    return true;
}

fn onlyBytesOf(rest: []const u8, set: []const u8) bool {
    for (rest) |x| {
        if (std.mem.indexOfScalar(u8, set, x) == null) return false;
    }
    return true;
}

pub const DefinitionScan = struct {
    /// Content offset where the prose starts; null while that is not decided.
    prose: ?u32,
    /// Start of the last definition parsed (a later scan starts there: its title may grow).
    last_start: u32,
    /// While undecided only because a title is open: its opening delimiter's offset.
    title: u32 = none,
};

/// Where a paragraph's prose starts after its leading link reference definitions (CommonMark
/// 4.7), over its complete lines `c` (each ending in '\n' unless `closed`), parsing from `from`
/// (the start of a definition a scan parsed before). Undecided while the last complete line may
/// still belong to a definition (its title, its destination, a label that goes on), so a
/// paragraph waits at most one line. With `closed`, every line is there.
pub fn definitionProse(c: []const u8, from: u32, closed: bool) DefinitionScan {
    if (c.len == 0) return .{ .prose = if (closed) 0 else null, .last_start = 0 };
    if (c[0] != '[') return .{ .prose = 0, .last_start = 0 };
    var position = from;
    var last = from;
    while (position < c.len and c[position] == '[') {
        const parsed = parseDefinition(c, position) orelse break;
        last = position;
        position = parsed.end;
    }
    if (closed) return .{ .prose = position, .last_start = last };
    var undecided: DefinitionScan = .{ .prose = null, .last_start = last };
    if (position >= c.len) return undecided;
    // A title the last definition may still take (it spans lines until it closes).
    if (position > 0 and titleOpen(c, position)) {
        undecided.title = position;
        return undecided;
    }
    // An attempt whose label, destination or title is still open waits for the next line.
    if (c[position] == '[') switch (definitionWait(c, position)) {
        .decided => {},
        .lines => return undecided,
        .title => |at| {
            undecided.title = at;
            return undecided;
        },
    };
    return .{ .prose = position, .last_start = last };
}

fn titleOpen(c: []const u8, at: u32) bool {
    _ = inline_parser.scanTitle(c, at, false) catch return true;
    return false;
}

/// Whether the definition attempt at `at` may still succeed with more lines: its label or
/// destination runs to the end of `c`, or its title (from the given offset) is still open.
fn definitionWait(c: []const u8, at: u32) union(enum) { decided, lines, title: u32 } {
    const label_len = inline_parser.scanLinkLabel(c, at, false) catch return .lines;
    if (label_len < 3) return .decided;
    var i = at + label_len;
    if (i >= c.len) return .lines;
    if (c[i] != ':') return .decided;
    i = skipSpacesOneNewline(c, i + 1) orelse return .lines;
    const d = (inline_parser.scanDestination(c, i, false) catch return .lines) orelse return .decided;
    const j = skipSpacesOneNewline(c, d.end) orelse return .lines;
    if (j >= c.len) return .lines;
    return if (j > d.end and titleOpen(c, j)) .{ .title = j } else .decided;
}

/// An open title's scan from `from` on (scanTitle's rules for the title opened at `at`): the
/// offset to resume at while it stays open, or null once it closes or fails.
fn titleScan(c: []const u8, at: u32, from: u32) ?u32 {
    return switch (inline_parser.titleFrom(c, at, from)) {
        .open => |i| i,
        else => null,
    };
}

/// The first of `tokens` that ends after content offset `at` (tokens.len: none).
fn tokenAt(tokens: []const inline_parser.Token, at: u32) u32 {
    var low: usize = 0;
    var high: usize = tokens.len;
    while (low < high) {
        const mid = (low + high) / 2;
        if (tokens[mid].end() <= at) low = mid + 1 else high = mid;
    }
    return @intCast(low);
}

/// How many leading bytes of `piece` equal the next bytes of `old`; those are consumed.
fn matchPrefix(old: *[]const u8, piece: []const u8) u32 {
    const count = @min(old.len, piece.len);
    const equal = std.mem.indexOfDiff(u8, old.*[0..count], piece[0..count]) orelse count;
    old.* = old.*[equal..];
    return @intCast(equal);
}

/// Bytes a live leaf keeps before its first token: one code point, for emphasis flanking.
const look_behind_byte_count: u32 = 4;

fn isAsciiWhitespaceByte(c: u8) bool {
    return c == ' ' or c == '\t' or c == '\n';
}

fn openerLineEnd(s: []const u8, b: Block) u32 {
    return lineContentEnd(s, b.source_start_byte);
}

fn isSpaceOrTab(c: u8) bool {
    return c == ' ' or c == '\t';
}

fn maybeSpecial(c: u8) bool {
    return switch (c) {
        '#', '`', '~', '*', '+', '_', '=', '<', '>', '-', '|', ':', '$', '\\' => true,
        '0'...'9' => true,
        else => false,
    };
}

fn canContain(parent: Kind, child: Kind) bool {
    return switch (parent) {
        .quote, .item => child != .item and child != .table_row and child != .table_cell,
        .list => child == .item,
        .table => child == .table_row,
        .table_row => child == .table_cell,
        else => false,
    };
}

fn acceptsLines(b: Block) bool {
    return b.kind == .code or b.kind == .html;
}

fn isBlankRange(s: []const u8, start: u32, end: u32) bool {
    var i = start;
    while (i < end) : (i += 1) {
        if (!isSpaceOrTab(s[i])) return false;
    }
    return true;
}

fn trimRange(s: []const u8, start: u32, end: u32) [2]u32 {
    var a = start;
    var b = end;
    while (a < b and isSpaceOrTab(s[a])) a += 1;
    while (b > a and isSpaceOrTab(s[b - 1])) b -= 1;
    return .{ a, b };
}

pub fn lineContentEnd(s: []const u8, at: u32) u32 {
    var i = at;
    while (i < s.len and s[i] != '\n' and s[i] != '\r') i += 1;
    return i;
}

fn nextLineStart(s: []const u8, content_end: u32) u32 {
    if (content_end >= s.len) return @intCast(s.len);
    if (s[content_end] == '\r' and content_end + 1 < s.len and s[content_end + 1] == '\n') return content_end + 2;
    return content_end + 1;
}

fn lineStart(s: []const u8, at: u32) u32 {
    var i = at;
    while (i > 0 and s[i - 1] != '\n' and s[i - 1] != '\r') i -= 1;
    return i;
}

fn previousLineEnd(s: []const u8, line_start_at: u32) u32 {
    var i = lineStart(s, line_start_at);
    if (i > 0 and s[i - 1] == '\n') i -= 1;
    if (i > 0 and s[i - 1] == '\r') i -= 1;
    return i;
}

fn lastLineContentStart(doc: *const Doc, paragraph: u32) u32 {
    const s = doc.source.items;
    const b = doc.blocks.items[paragraph];
    const start = lineStart(s, b.content_end_byte);
    if (start <= b.content_start_byte) return b.content_start_byte;
    // Re-derive the last line's content start through the paragraph's containers.
    var ancestors_buffer: [depth_max + 1]u32 = undefined;
    const ancestors = doc.ancestorChain(b.parent_index, &ancestors_buffer);
    var line = Line{ .s = s, .start = start, .end = b.content_end_byte, .offset = start };
    _ = doc.matchContainers(&line, ancestors);
    line.findNextNonspace();
    return line.next_nonspace;
}

/// True when a blank line lies between the line ending at `end` and the line holding `next`.
fn endsWithBlankLine(s: []const u8, end: u32, next: u32) bool {
    const after = nextLineStart(s, lineContentEnd(s, end));
    return lineStart(s, next) > after;
}

fn lastNonBlankLineEnd(s: []const u8, start: u32, end: u32) u32 {
    var line_end = end;
    while (true) {
        const ls = lineStart(s, line_end);
        if (!isBlankRange(s, ls, line_end) or ls <= start) return line_end;
        line_end = previousLineEnd(s, ls);
    }
}

/// The first byte from `at` that is neither `c` nor a space or tab.
fn markerRunEnd(s: []const u8, at: u32, end: u32, c: u8) u32 {
    var i = at;
    while (i < end and (s[i] == c or isSpaceOrTab(s[i]))) i += 1;
    return i;
}

fn isSetextUnderline(s: []const u8, at: u32, end: u32) bool {
    const c = s[at];
    var i = at;
    while (i < end and s[i] == c) i += 1;
    return isBlankRange(s, i, end);
}

fn isThematicBreak(s: []const u8, at: u32, end: u32) bool {
    const c = s[at];
    var count: u32 = 0;
    var i = at;
    while (i < end) : (i += 1) {
        if (s[i] == c) {
            count += 1;
        } else if (!isSpaceOrTab(s[i])) return false;
    }
    return count >= 3;
}

const MathOpener = struct { one_line: ?[2]u32 };

/// A display math opener line: only `$$` or `\[`, or a whole one-line block `$$x$$` / `\[x\]`.
fn mathOpener(s: []const u8, at: u32, end: u32) ?MathOpener {
    const range = trimRange(s, at, end);
    const line = s[range[0]..range[1]];
    const open, const close = if (std.mem.startsWith(u8, line, "$$")) .{ "$$", "$$" } else if (std.mem.startsWith(u8, line, "\\[")) .{ "\\[", "\\]" } else return null;
    if (line.len == 2) return .{ .one_line = null };
    if (line.len > 4 and std.mem.endsWith(u8, line, close)) {
        const body = line[2 .. line.len - 2];
        if (std.mem.indexOf(u8, body, open) == null and std.mem.indexOf(u8, body, close) == null) {
            return .{ .one_line = .{ range[0] + 2, range[1] - 2 } };
        }
    }
    return null;
}

fn isMathCloser(s: []const u8, at: u32, end: u32, opener_char: u8) bool {
    const range = trimRange(s, at, end);
    const line = s[range[0]..range[1]];
    return if (opener_char == '$') std.mem.eql(u8, line, "$$") else std.mem.eql(u8, line, "\\]");
}

const html_block_names = [_][]const u8{
    "address",  "article",  "aside",    "base",       "basefont", "blockquote", "body",   "caption",
    "center",   "col",      "colgroup", "dd",         "details",  "dialog",     "dir",    "div",
    "dl",       "dt",       "fieldset", "figcaption", "figure",   "footer",     "form",   "frame",
    "frameset", "h1",       "h2",       "h3",         "h4",       "h5",         "h6",     "head",
    "header",   "hr",       "html",     "iframe",     "legend",   "li",         "link",   "main",
    "menu",     "menuitem", "nav",      "noframes",   "ol",       "optgroup",   "option", "p",
    "param",    "search",   "section",  "summary",    "table",    "tbody",      "td",     "tfoot",
    "th",       "thead",    "title",    "tr",         "track",    "ul",
};

fn startsWithIgnoreCase(haystack: []const u8, needle: []const u8) bool {
    return haystack.len >= needle.len and std.ascii.eqlIgnoreCase(haystack[0..needle.len], needle);
}

/// The HTML block type (1-7) a line starting with '<' at `at` opens, or null.
fn htmlBlockStart(s: []const u8, at: u32, end: u32) ?u8 {
    const line = s[at..end];
    inline for (.{ "script", "pre", "style", "textarea" }) |name| {
        if (startsWithIgnoreCase(line[1..], name)) {
            const after = 1 + name.len;
            if (after == line.len or isSpaceOrTab(line[after]) or line[after] == '>') return 1;
        }
    }
    if (std.mem.startsWith(u8, line, "<!--")) return 2;
    if (std.mem.startsWith(u8, line, "<?")) return 3;
    if (line.len > 2 and line[1] == '!' and std.ascii.isAlphabetic(line[2])) return 4;
    if (std.mem.startsWith(u8, line, "<![CDATA[")) return 5;
    var i: usize = 1;
    if (i < line.len and line[i] == '/') i += 1;
    var name_end = i;
    while (name_end < line.len and std.ascii.isAlphanumeric(line[name_end])) name_end += 1;
    const name = line[i..name_end];
    for (html_block_names) |block_name| {
        if (std.ascii.eqlIgnoreCase(name, block_name)) {
            if (name_end == line.len or isSpaceOrTab(line[name_end]) or line[name_end] == '>' or std.mem.startsWith(u8, line[name_end..], "/>")) return 6;
        }
    }
    // Type 7: one complete open or closing tag, then only whitespace.
    if (line.len > 1 and line[1] == '/') {
        var j: usize = 2;
        if (j >= line.len or !std.ascii.isAlphabetic(line[j])) return null;
        while (j < line.len and (std.ascii.isAlphanumeric(line[j]) or line[j] == '-')) j += 1;
        while (j < line.len and isSpaceOrTab(line[j])) j += 1;
        if (j < line.len and line[j] == '>' and isBlankRange(line, @intCast(j + 1), @intCast(line.len))) return 7;
        return null;
    }
    const tag_end = (inline_parser.scanOpenTag(line, 0, true) catch unreachable) orelse return null;
    const tag_name_end = blk: {
        var j: usize = 1;
        while (j < line.len and (std.ascii.isAlphanumeric(line[j]) or line[j] == '-')) j += 1;
        break :blk j;
    };
    const tag_name = line[1..tag_name_end];
    inline for (.{ "script", "pre", "style", "textarea" }) |excluded| {
        if (std.ascii.eqlIgnoreCase(tag_name, excluded)) return null;
    }
    if (std.mem.indexOfAny(u8, line[0..tag_end], "\n") != null) return null;
    if (isBlankRange(line, tag_end, @intCast(line.len))) return 7;
    return null;
}

fn htmlBlockEnds(line: []const u8, kind: u8) bool {
    return switch (kind) {
        1 => containsIgnoreCase(line, "</script>") or containsIgnoreCase(line, "</pre>") or
            containsIgnoreCase(line, "</style>") or containsIgnoreCase(line, "</textarea>"),
        2 => std.mem.indexOf(u8, line, "-->") != null,
        3 => std.mem.indexOf(u8, line, "?>") != null,
        4 => std.mem.indexOfScalar(u8, line, '>') != null,
        5 => std.mem.indexOf(u8, line, "]]>") != null,
        else => false,
    };
}

fn containsIgnoreCase(haystack: []const u8, needle: []const u8) bool {
    if (haystack.len < needle.len) return false;
    var i: usize = 0;
    while (i + needle.len <= haystack.len) : (i += 1) {
        if (std.ascii.eqlIgnoreCase(haystack[i .. i + needle.len], needle)) return true;
    }
    return false;
}

/// Column count of a GFM delimiter row at [at, end), or null (cmark-gfm's `table_start`).
fn delimiterRow(s: []const u8, at: u32, end: u32) ?u32 {
    var i = at;
    var cells: u32 = 0;
    var pipes: u32 = 0;
    if (i < end and s[i] == '|') {
        i += 1;
        pipes += 1;
    }
    while (true) {
        while (i < end and isSpaceOrTab(s[i])) i += 1;
        if (i >= end) break;
        if (s[i] == ':') i += 1;
        const dashes = i;
        while (i < end and s[i] == '-') i += 1;
        if (i == dashes) return null;
        if (i < end and s[i] == ':') i += 1;
        while (i < end and isSpaceOrTab(s[i])) i += 1;
        cells += 1;
        if (i >= end) break;
        if (s[i] != '|') return null;
        i += 1;
        pipes += 1;
    }
    if (pipes == 0) return null;
    // A single cell needs a pipe after it (cmark-gfm requires at least one marker-pipe pair).
    if (cells == 1 and pipes == 1 and s[at] == '|' and !std.mem.endsWith(u8, std.mem.trimEnd(u8, s[at..end], " \t"), "|")) return null;
    return cells;
}

/// The alignment of a delimiter row's cell from `at` (after its pipe), and where the next cell
/// starts. delimiterRow checked the row, and a table has no more columns than it has cells.
fn delimiterCell(s: []const u8, at: u32) struct { Alignment, u32 } {
    var i = at;
    while (isSpaceOrTab(s[i])) i += 1;
    assert(s[i] == ':' or s[i] == '-');
    const left = s[i] == ':';
    i += @intFromBool(left);
    while (i < s.len and s[i] == '-') i += 1;
    const right = i < s.len and s[i] == ':';
    i += @intFromBool(right);
    while (i < s.len and isSpaceOrTab(s[i])) i += 1;
    i += @intFromBool(i < s.len and s[i] == '|');
    const alignment: Alignment = if (left and right) .center else if (left) .left else if (right) .right else .none;
    return .{ alignment, i };
}

/// Cells of a header row (pipes at the ends do not start cells; `\|` is not a separator).
fn countCells(s: []const u8, start: u32, end: u32) u32 {
    const range = trimRange(s, start, end);
    var i = range[0];
    var e = range[1];
    if (i < e and s[i] == '|') i += 1;
    if (e > i and s[e - 1] == '|' and !(e >= 2 and s[e - 2] == '\\')) e -= 1;
    var cells: u32 = 1;
    while (i < e) : (i += 1) {
        if (s[i] == '\\') {
            i += 1;
            continue;
        }
        if (s[i] == '|') cells += 1;
    }
    return cells;
}

fn unescapePipes(arena: Allocator, bytes: []const u8) Allocator.Error![]const u8 {
    if (std.mem.indexOf(u8, bytes, "\\|") == null) return bytes;
    const out = try arena.alloc(u8, bytes.len);
    var n: usize = 0;
    var i: usize = 0;
    while (i < bytes.len) : (i += 1) {
        if (bytes[i] == '\\' and i + 1 < bytes.len and bytes[i + 1] == '|') continue;
        out[n] = bytes[i];
        n += 1;
    }
    return out[0..n];
}

// ---- Link reference definitions ----

const ParsedDefinition = struct { label: [2]u32, destination: [2]u32, title: ?[2]u32, end: u32 };

/// One definition at `at` in paragraph content, ending at a line end, or null.
fn parseDefinition(c: []const u8, at: u32) ?ParsedDefinition {
    const label_len = inline_parser.scanLinkLabel(c, at, true) catch unreachable;
    if (label_len < 3) return null;
    const label = [2]u32{ at + 1, at + label_len - 1 };
    if (!inline_parser.isValidLabel(c[label[0]..label[1]])) return null;
    var i = at + label_len;
    if (i >= c.len or c[i] != ':') return null;
    i += 1;
    i = skipSpacesOneNewline(c, i) orelse return null;
    const d = (inline_parser.scanDestination(c, i, true) catch unreachable) orelse return null;
    const destination_start: u32 = if (c[i] == '<') i + 1 else i;
    const destination = [2]u32{ destination_start, destination_start + @as(u32, @intCast(d.value.len)) };
    i = d.end;
    const before_title = i;
    // A title must follow whitespace; the definition may also end at the line end.
    var j = skipSpacesOneNewline(c, i) orelse c.len;
    if (j > before_title) {
        if (inline_parser.scanTitle(c, @intCast(j), true) catch unreachable) |t| {
            const title_end = t.end;
            var k = title_end;
            while (k < c.len and isSpaceOrTab(c[k])) k += 1;
            if (k >= c.len or c[k] == '\n') {
                const title_start: u32 = @intCast(j + 1);
                return .{ .label = label, .destination = destination, .title = .{ title_start, title_start + @as(u32, @intCast(t.value.len)) }, .end = if (k < c.len) k + 1 else k };
            }
        }
    }
    // No title: the rest of the destination's line must be blank.
    j = i;
    while (j < c.len and isSpaceOrTab(c[j])) j += 1;
    if (j < c.len and c[j] != '\n') return null;
    return .{ .label = label, .destination = destination, .title = null, .end = if (j < c.len) @intCast(j + 1) else @intCast(j) };
}

fn skipSpacesOneNewline(c: []const u8, at: u32) ?u32 {
    var i = at;
    var newline = false;
    while (i < c.len) : (i += 1) {
        if (isSpaceOrTab(c[i])) continue;
        if (c[i] == '\n' and !newline) {
            newline = true;
            continue;
        }
        break;
    }
    return i;
}

/// CommonMark label matching: Unicode case fold, inner whitespace collapsed to one space, ends
/// trimmed.
pub fn normalizeLabel(arena: Allocator, label: []const u8) Allocator.Error![]const u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    var space = false;
    var view = std.unicode.Utf8View.initUnchecked(label).iterator();
    while (view.nextCodepoint()) |cp| {
        if (cp == ' ' or cp == '\t' or cp == '\n' or cp == '\r' or inline_parser.isUnicodeWhitespace(cp)) {
            space = out.items.len > 0;
            continue;
        }
        if (space) try out.append(arena, ' ');
        space = false;
        var buffer: [4]u8 = undefined;
        for (caseFold(cp)) |folded| {
            if (folded == 0) break;
            const n = std.unicode.utf8Encode(folded, &buffer) catch continue;
            try out.appendSlice(arena, buffer[0..n]);
        }
    }
    return out.items;
}

fn caseFold(cp: u21) [3]u21 {
    if (cp < 0x80) return .{ std.ascii.toLower(@intCast(cp)), 0, 0 };
    for (tables.fold_multi) |entry| {
        if (entry[0] == cp) return entry[1];
    }
    for (tables.fold_runs) |run| {
        const first, const last, const stride, const delta = run;
        if (cp < first or cp > last) continue;
        if ((cp - first) % stride != 0) continue;
        return .{ @intCast(@as(i32, cp) + delta), 0, 0 };
    }
    return .{ cp, 0, 0 };
}

fn validateFilter(filter: []const u8) Error!void {
    if (filter.len > hook_filter_byte_count_max) return error.InvalidOptions;
    var it = std.mem.splitScalar(u8, filter, 0);
    if (filter.len == 0) return;
    var count: u32 = 0;
    while (it.next()) |item| {
        if (item.len == 0 or item.len > hook_filter_item_byte_count_max) return error.InvalidOptions;
        count += 1;
    }
    if (count > hook_filter_item_count_max) return error.InvalidOptions;
}

test {
    _ = inline_parser;
}
