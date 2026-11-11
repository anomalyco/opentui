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
pub const hook_filter_byte_count_max: u32 = 256;
pub const hook_filter_item_byte_count_max: u32 = 64;
/// Retained capacity of the per-call scratch arena.
pub const scratch_retained_byte_count_max: usize = 1 << 20;

pub const none: u32 = std.math.maxInt(u32);

pub const Kind = enum(u8) { paragraph, heading, code, html, rule, table, table_row, table_cell, quote, list, item };

pub const Flags = packed struct(u16) {
    open: bool = false,
    /// The closing delimiter arrived (fences and math blocks; rule 3).
    closed: bool = false,
    final: bool = false,
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
    _unused: bool = false,
};

/// One block, 32 bytes. `small` holds a fence's or math block's opener indent and an HTML
/// block's type; `payload` is per kind: heading [level, -], fence [info start, info end], list
/// [start number, marker byte], item [content indent, -], table [column count, delimiter row
/// start], table cell [column, -].
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
    /// Leaf content bytes inline-parsed again because a definition arrived.
    bytes_reinlined: u64 = 0,
    /// Allocations the doc made (capacity growth); the scratch arena is not counted here.
    capacity_growth_count: u64 = 0,
    /// Display bytes the live leaf's tail writes would carry: from the first changed display
    /// byte to the end, summed over appends (invariant 4).
    tail_write_bytes: u64 = 0,
    /// The live leaf's guess about the pending line disagreed with the parsed line (must stay 0).
    live_mismatch_count: u64 = 0,

    pub fn plus(a: Counters, b: Counters) Counters {
        var sum: Counters = .{};
        inline for (@typeInfo(Counters).@"struct".field_names) |name| @field(sum, name) = @field(a, name) + @field(b, name);
        return sum;
    }
};

/// The open paragraph's inline state, kept across appends so that each append tokenizes only
/// new bytes (design: open-leaf token tail). It holds the leaf's content from the first token
/// that may still change; settled tokens are folded away.
const Live = struct {
    parser: inline_parser.Parser,
    /// The leaf's content (lines joined by '\n', each complete line followed by one) from the
    /// first byte a token may still need; `content_base` bytes before it were folded away.
    content: std.ArrayListUnmanaged(u8) = .empty,
    content_base: u32 = 0,
    /// The leaf (a provisional index while it is only the pending line's).
    block: u32 = none,
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
    /// The display offset of the first expired opener whose tokens were folded away (none: no
    /// such opener).
    expired_display: u32 = none,
    /// The doc's definition count when the leaf was parsed against them.
    definition_count: u32 = 0,
};

/// Test instrument: applies every live tail write to a mirror of the leaf's display, as a bound
/// text node would receive them, and checks the mirror against a whole parse when the leaf
/// closes.
pub const TailSink = struct {
    allocator: Allocator,
    mirror: std.ArrayListUnmanaged(u8) = .empty,
    checked_leaf_count: u32 = 0,
    mismatch_count: u32 = 0,
    /// False after a replace adopted a fresh parse whose live leaf started without the sink;
    /// the next leaf starts it again.
    valid: bool = true,

    pub fn deinit(self: *TailSink) void {
        self.mirror.deinit(self.allocator);
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
    counters: Counters = .{},
    /// Undo log of the current mutation (scratch memory): records the first change of each block
    /// that existed before the call, so a rejected call restores them.
    undo: std.ArrayListUnmanaged(UndoEntry) = .empty,
    undo_base_block_count: u32 = 0,
    /// Block count at the last successful read: a removal at or past it was never reported.
    read_block_count: u32 = 0,
    /// The definition whose arrival is being applied, and whether a re-inline used it.
    watch_definition: u32 = none,
    watch_hit: bool = false,
    /// The provisional layout of the pending line: blocks at index >= `provisional_from` (none:
    /// no layout), and the real blocks it extended with their values before.
    provisional_from: u32 = none,
    provisional_undo: std.ArrayListUnmanaged(UndoEntry) = .empty,
    /// While the layout runs: closing work waits and writes to real blocks are logged.
    provisional: bool = false,
    /// The last layout ran into the block limit and was dropped.
    provisional_limited: bool = false,
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
        self.live.content.deinit(self.allocator);
        self.live.display_ends.deinit(self.allocator);
        self.live.pending_display.deinit(self.allocator);
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
        self.dropProvisional();
        if (self.finished) {
            // N2: re-opening is a fresh parse of the whole resulting source.
            const whole = try self.scratch.allocator().alloc(u8, self.source.items.len + bytes.len);
            @memcpy(whole[0..self.source.items.len], self.source.items);
            @memcpy(whole[self.source.items.len..], bytes);
            return self.setInternal(whole);
        }
        var snapshot = self.beginMutation();
        errdefer {
            self.rollback(&snapshot);
            // The pending line's layout as it was before the call.
            self.addProvisional() catch {};
        }
        try self.reserveSource(@intCast(self.source.items.len + bytes.len));
        self.source.appendSliceAssumeCapacity(bytes);
        try self.scanLines(false, snapshot.source_len -| 1);
        try self.afterScan(snapshot.source_len);
    }

    /// After the complete lines: the pending line's live text, the filter latch, commits.
    fn afterScan(self: *Doc, new_from_byte: u32) Error!void {
        try self.latchHooks(new_from_byte);
        try self.addProvisional();
        self.liveCheckLeaf();
        try self.livePending();
        self.updateCommits();
        self.reconcileProvisional();
    }

    /// Ends the document: the pending line is complete and every block closes.
    pub fn finish(self: *Doc) Error!void {
        defer self.resetScratch();
        return self.finishInternal();
    }

    fn finishInternal(self: *Doc) Error!void {
        if (self.finished) return;
        self.dropProvisional();
        var snapshot = self.beginMutation();
        errdefer {
            self.rollback(&snapshot);
            self.addProvisional() catch {};
        }
        try self.scanLines(true, @as(u32, @intCast(self.source.items.len)) -| 1);
        while (self.open_count > 0) try self.closeBlock(self.open[self.open_count - 1], self.previous_line_end_byte);
        try self.latchHooks(@intCast(self.source.items.len));
        self.finished = true;
        self.updateCommits();
        self.reconcileProvisional();
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
        const definitions_changed = !try self.sameDefinitions(fresh);
        for (fresh.blocks.items[0..equal], self.blocks.items[0..equal], 0..) |*new, old, i| {
            new.flags.unreported = old.flags.unreported;
            if (definitions_changed and isInlineLeaf(old) and !try self.sameLeafOutput(fresh, @intCast(i))) new.flags.unreported = true;
        }
        const removed = if (equal < self.read_block_count) @min(self.removed_from_index, equal) else self.removed_from_index;
        fresh.removed_from_index = removed;
        fresh.counters = self.counters.plus(fresh.counters);
        fresh.read_block_count = @min(self.read_block_count, equal);
        fresh.tail_sink = self.tail_sink;
        if (self.tail_sink) |sink| sink.valid = fresh.live.block == none;
        self.deinit();
        self.* = fresh.*;
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
        return std.mem.eql(u8, a.bytes.items, b.bytes.items) and std.mem.eql(u8, a.urls.items, b.urls.items);
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
    pub fn readChanges(self: *Doc, out: []Change) struct { count: u32, removed_from_index: u32 } {
        var count: u32 = 0;
        for (self.blocks.items) |b| count += @intFromBool(b.flags.unreported);
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

    const Snapshot = struct {
        source_len: u32,
        block_count: u32,
        definition_count: u32,
        open: [depth_max]u32,
        open_count: u32,
        line_start_byte: u32,
        previous_line_end_byte: u32,
        removed_from_index: u32,
        committed_top_level_count: u32,
        commit_cursor: u32,
        counters: Counters,
        read_block_count: u32,
        hook_pending_byte: u32,
    };

    fn beginMutation(self: *Doc) Snapshot {
        self.undo = .empty;
        self.undo_base_block_count = @intCast(self.blocks.items.len);
        return .{
            .source_len = @intCast(self.source.items.len),
            .block_count = @intCast(self.blocks.items.len),
            .definition_count = @intCast(self.definitions.items.len),
            .open = self.open,
            .open_count = self.open_count,
            .line_start_byte = self.line_start_byte,
            .previous_line_end_byte = self.previous_line_end_byte,
            .removed_from_index = self.removed_from_index,
            .committed_top_level_count = self.committed_top_level_count,
            .commit_cursor = self.commit_cursor,
            .counters = self.counters,
            .read_block_count = self.read_block_count,
            .hook_pending_byte = self.hook_pending_byte,
        };
    }

    fn rollback(self: *Doc, snapshot: *const Snapshot) void {
        var i = self.undo.items.len;
        while (i > 0) {
            i -= 1;
            const entry = self.undo.items[i];
            self.blocks.items[entry.index] = entry.block;
        }
        self.source.shrinkRetainingCapacity(snapshot.source_len);
        self.blocks.shrinkRetainingCapacity(snapshot.block_count);
        self.definitions.shrinkRetainingCapacity(snapshot.definition_count);
        self.open = snapshot.open;
        self.open_count = snapshot.open_count;
        self.line_start_byte = snapshot.line_start_byte;
        self.previous_line_end_byte = snapshot.previous_line_end_byte;
        self.removed_from_index = snapshot.removed_from_index;
        self.committed_top_level_count = snapshot.committed_top_level_count;
        self.commit_cursor = snapshot.commit_cursor;
        self.counters = snapshot.counters;
        self.read_block_count = snapshot.read_block_count;
        self.hook_pending_byte = snapshot.hook_pending_byte;
        // The live leaf may have taken bytes of the rejected call: drop it; the open paragraph
        // is parsed whole when it closes.
        self.liveReset(none, none);
        self.pending_row_line = none;
        self.pending_blank_line = none;
    }

    /// The block for writing; the first write in a call to a block that existed before it is
    /// logged so a rejected call can restore it.
    fn blockMut(self: *Doc, index: u32) Error!*Block {
        if (self.provisional and index < self.provisional_from) {
            // The provisional layout undoes its writes to real blocks before the next call.
            try self.provisional_undo.append(self.allocator, .{ .index = index, .block = self.blocks.items[index] });
        } else if (index < self.undo_base_block_count) {
            // Duplicates are harmless: rollback restores in reverse, so the oldest copy wins.
            try self.undo.append(self.scratch.allocator(), .{ .index = index, .block = self.blocks.items[index] });
        }
        // Every write is a change the next read lists.
        self.blocks.items[index].flags.unreported = true;
        return &self.blocks.items[index];
    }

    fn resetScratch(self: *Doc) void {
        self.undo = .empty;
        _ = self.scratch.reset(.{ .retain_with_limit = scratch_retained_byte_count_max });
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
        const overlap = self.filterOverlap();
        try self.latchRange(from_byte -| overlap, @intCast(self.source.items.len));
    }

    /// Latches the leaves holding a filter match that starts in [start, end); a match in the
    /// pending line is kept for later.
    fn latchRange(self: *Doc, start: u32, end: u32) Error!void {
        var matches = self.filterMatches(start, end);
        while (matches.next()) |position| {
            if (position >= self.line_start_byte) {
                self.hook_pending_byte = @min(self.hook_pending_byte, position);
            } else {
                try self.latchAt(position);
            }
        }
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
            self.blocks.items[index].flags.final = true;
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
                    const range = atxContent(s, after, line.end);
                    const h = try self.addChild(.heading, at, line.end);
                    const block = try self.blockMut(h);
                    block.payload[0] = hashes;
                    block.content_start_byte = range[0];
                    block.content_end_byte = range[1];
                    try self.closeBlock(h, line.end);
                    if (self.provisional) {
                        self.pending_leaf = h;
                        self.pending_content_start = range[0];
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
                if (mathOpener(s, at, line.end)) |opener| {
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
                try self.detectTask(item, line);
                return .container;
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
        if (self.provisional) return;
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
            .table_cell => try self.computeUnresolved(index),
            .table, .table_row, .rule, .html => {},
        }
    }

    fn noteRemoved(self: *Doc, index: u32) void {
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

    fn detectTask(self: *Doc, item: u32, line: *Line) Error!void {
        const s = self.source.items;
        var i = line.offset;
        // A partly consumed tab still counts as the space after the marker.
        while (i < line.end and isSpaceOrTab(s[i])) i += 1;
        if (i + 3 > line.end or s[i] != '[' or s[i + 2] != ']') return;
        const mark = s[i + 1];
        if (mark != ' ' and mark != 'x' and mark != 'X') return;
        if (i + 3 >= line.end or !isSpaceOrTab(s[i + 3])) return;
        if (isBlankRange(s, i + 3, line.end)) return;
        const block = try self.blockMut(item);
        block.flags.task = true;
        block.flags.checked = mark != ' ';
        line.offset = i + 3;
        line.column = 0;
        line.partially_consumed_tab = false;
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
        const columns = self.blocks.items[t].payload[0];
        const row = try self.addChild(.table_row, start, line.end);
        (try self.blockMut(row)).flags.header = header;
        var cell_start = start;
        if (cell_start < line.end and s[cell_start] == '|') cell_start += 1;
        var column: u32 = 0;
        var i = cell_start;
        while (column < columns) {
            // A cell ends at an unescaped pipe or the line end.
            while (i < line.end and s[i] != '|') : (i += 1) {
                if (s[i] == '\\' and i + 1 < line.end) i += 1;
            }
            if (i >= line.end and isBlankRange(s, cell_start, line.end) and column > 0) break;
            const range = trimRange(s, cell_start, @min(i, line.end));
            const cell = try self.addChild(.table_cell, range[0], range[1]);
            (try self.blockMut(cell)).payload[0] = column;
            try self.closeBlock(cell, range[1]);
            column += 1;
            if (i >= line.end) break;
            i += 1;
            cell_start = i;
            if (isBlankRange(s, cell_start, line.end)) break;
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
            self.watch_definition = definition;
            self.watch_hit = false;
            defer self.watch_definition = none;
            try self.computeUnresolved(i);
            if (self.watch_hit) (try self.blockMut(i)).flags.unreported = true;
        }
    }

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
        self.processLine(self.line_start_byte, end) catch |err| switch (err) {
            // No room for the pending line's blocks: it waits for its line end.
            error.BlockLimit => {
                self.provisional_limited = true;
                self.provisional = false;
                self.dropProvisional();
                self.pending_leaf = none;
                return;
            },
            else => return err,
        };
        if (self.hook_pending_byte != none and self.pending_leaf != none and !self.blocks.items[self.pending_leaf].flags.hooked) {
            (try self.blockMut(self.pending_leaf)).flags.hooked = true;
        }
    }

    /// Undoes the provisional layout: real blocks get their values back, provisional blocks go
    /// (kept aside to compare with the next layout).
    fn dropProvisional(self: *Doc) void {
        if (self.provisional_from == none) return;
        var i = self.provisional_undo.items.len;
        while (i > 0) {
            i -= 1;
            const entry = self.provisional_undo.items[i];
            self.blocks.items[entry.index] = entry.block;
        }
        self.provisional_undo.clearRetainingCapacity();
        const from = self.provisional_from;
        self.provisional_previous.clearRetainingCapacity();
        self.provisional_previous.appendSlice(self.allocator, self.blocks.items[from..]) catch {
            // Without the copy, a provisional block the host read is reported removed.
            self.noteRemoved(from);
        };
        self.provisional_previous_from = from;
        self.blocks.items.len = from;
        self.provisional_from = none;
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
        var matched: u32 = 0;
        while (matched < self.open_count) : (matched += 1) {
            const index = self.open[matched];
            const b = self.blocks.items[index];
            line.findNextNonspace();
            if (b.kind == .code and (b.flags.fenced or b.flags.math)) {
                // A fence takes the line unless it may still be the closer.
                return line.blank or (line.indent <= 3 and closerPrefix(self.source.items[line.next_nonspace..end], self.source.items[b.source_start_byte], b.flags.math));
            }
            if (b.kind == .html) return line.blank;
            if (b.kind == .table) matched += 1;
            if (b.kind == .paragraph or b.kind == .table or b.kind == .code) break;
            if (self.continues(&line, index, b) != .matches) break;
        }
        line.findNextNonspace();
        if (line.blank) return true;
        if (line.indented) return false;
        const tip = self.tipIndex();
        const in_table = tip != none and self.blocks.items[tip].kind == .table and matched == self.open_count;
        return heldPrefix(self.source.items[line.next_nonspace..end], self.pending_row == .row and !in_table, in_table, self.options.math);
    }

    // ---- The live leaf ----

    /// A closing prose leaf's last inline pass: the live leaf's when it followed this leaf to
    /// its end, else a whole parse.
    fn closeLeaf(self: *Doc, index: u32) Error!void {
        const live = &self.live;
        const b = self.blocks.items[index];
        if (live.block == index) self.liveCheckDefinitions(b.content_start_byte);
        if (live.block == index and live.start_byte == b.content_start_byte) {
            // An ATX heading closes with its line: take its bytes not fed yet; its content ends
            // before a closing sequence.
            const atx = b.kind == .heading and !b.flags.setext;
            if (live.line_start_byte != none and live.line_fed_end_byte < b.content_end_byte) {
                try self.liveAppend(self.source.items[live.line_fed_end_byte..b.content_end_byte]);
            }
            const content_byte_count = b.content_end_byte - b.content_start_byte;
            var end: u32 = if (atx) content_byte_count -| live.content_base else @intCast(live.content.items.len);
            while (end > live.parser.position and isAsciiWhitespaceByte(live.content.items[end - 1])) end -= 1;
            if (end >= live.parser.position and (!atx or content_byte_count >= live.content_base)) {
                live.definition_possible = false;
                live.pipe_line_start = none;
                live.line_pipe = none;
                try self.liveFeed(live.content.items[0..end], true);
                if (b.flags.setext) try self.liveWriteExtra(try self.setextUnderline(self.scratch.allocator(), index));
                if (live.expired_display != none) try self.liveRewriteExpired(index);
                const unresolved = live.parser.unresolved;
                if (self.tail_sink) |sink| try self.checkSink(sink, index);
                self.liveReset(none, none);
                if (b.flags.unresolved != unresolved) (try self.blockMut(index)).flags.unresolved = unresolved;
                return;
            }
        }
        if (live.block == index) self.liveReset(none, none);
        try self.computeUnresolved(index);
    }

    fn checkSink(self: *const Doc, sink: *TailSink, index: u32) Error!void {
        if (!sink.valid) return;
        const expected = (try self.readLeaf(self.scratch.allocator(), index)).bytes.items;
        sink.checked_leaf_count += 1;
        if (!std.mem.eql(u8, expected, sink.mirror.items)) {
            sink.mismatch_count += 1;
            if (std.debug.runtime_safety) std.debug.print("live display mismatch at block {d}: expected '{s}' mirror '{s}'\n", .{ index, expected, sink.mirror.items });
        }
    }

    /// Drops the live leaf when its block is no open prose leaf starting where it does any more
    /// (a line ended that turned the pending paragraph into another kind).
    fn liveCheckLeaf(self: *Doc) void {
        const live = &self.live;
        if (live.block == none) return;
        if (live.block < self.blocks.items.len) {
            const b = self.blocks.items[live.block];
            if (b.flags.open and (b.kind == .paragraph or b.kind == .heading) and b.content_start_byte == live.start_byte) return;
        }
        self.liveReset(none, none);
    }

    /// A leaf that started on the pending line while the paragraph before it was still open
    /// was parsed without that paragraph's definitions: when they arrived and it used a label,
    /// it starts again (it holds one line; the definitions came with the line that ended it).
    fn liveCheckDefinitions(self: *Doc, leaf_start: u32) void {
        const live = &self.live;
        if (live.start_byte != leaf_start or live.definition_count == self.definitions.items.len) return;
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
        live.line_start_byte = none;
        live.line_fed_end_byte = 0;
        live.display_ends.clearRetainingCapacity();
        live.folded_display_byte_count = 0;
        live.content_base = 0;
        live.pending_display.clearRetainingCapacity();
        live.pending_scan = .{};
        live.pending_code_opener = null;
        live.shown_byte_count = 0;
        live.definition_possible = false;
        live.pipe_line_start = none;
        live.line_pipe = none;
        live.partial_token = none;
        live.partial_from = none;
        live.expired_display = none;
        live.definition_count = @intCast(self.definitions.items.len);
        if (self.tail_sink) |sink| {
            sink.mirror.clearRetainingCapacity();
            sink.valid = true;
        }
        self.releaseLiveCapacity();
    }

    /// Retained capacity of the live leaf's stores stays proportional to what they last held.
    fn releaseLiveCapacity(self: *Doc) void {
        const live = &self.live;
        if (live.content.capacity > live_retained_byte_count_max) {
            live.content.clearAndFree(self.allocator);
        }
        if (live.display_ends.capacity > inline_parser.token_count_max) live.display_ends.clearAndFree(self.allocator);
        if (live.pending_display.capacity > live_retained_byte_count_max) live.pending_display.clearAndFree(self.allocator);
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
        live.pipe_line_start = live.line_pipe;
        live.line_pipe = none;
        try self.liveAppend("\n");
        try self.liveFeed(live.content.items, false);
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
        const content = &self.live.content;
        if (content.items.len + bytes.len > content.capacity) self.counters.capacity_growth_count += 1;
        try content.appendSlice(self.allocator, bytes);
    }

    /// Runs the live parser over its content and writes the display's changed tail (counted; the
    /// test sink applies it): from the first display byte that differs to the end of what B
    /// shows.
    fn liveFeed(self: *Doc, content: []const u8, final: bool) Error!void {
        const live = &self.live;
        const parser = &live.parser;
        parser.references = self.references();
        const arena = self.scratch.allocator();
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
        if (!pending_only) {
            old_pending = try arena.dupe(u8, live.pending_display.items);
            live.pending_display.clearRetainingCapacity();
            live.pending_scan = .{ .stop = parser.position };
        }
        const drawn_before = live.pending_display.items.len;
        if (!final) {
            // Bytes read: from where the last call stopped reading to where this one did.
            const read_from = @max(live.pending_scan.stop, live.pending_scan.scanned);
            try inline_parser.renderPending(content, live.pending_scan.stop, code, &live.pending_scan, self.allocator, &live.pending_display);
            self.counters.display_byte_visits += @max(live.pending_scan.stop, live.pending_scan.scanned) -| read_from;
        }
        const full_end = tokens_end + @as(u32, @intCast(live.pending_display.items.len));
        // Where the full display first differs from what it was.
        var write_full: u32 = undefined;
        if (pending_only) {
            write_full = old_tokens_end + @as(u32, @intCast(drawn_before));
        } else if (first < tokens_before and !grown_last) {
            write_full = self.liveTokensEnd(first);
        } else {
            // Only new tokens (or a grown last text token) replaced old pending bytes: compare.
            var fresh: std.ArrayListUnmanaged(u8) = .empty;
            i = first;
            while (i < r.tokens.len) : (i += 1) try inline_parser.appendTokenDisplay(r, i, arena, &fresh);
            try fresh.appendSlice(arena, live.pending_display.items);
            var old: []const u8 = old_pending;
            if (grown_last) old = try std.mem.concat(arena, u8, &.{ content[r.tokens[first].start..position_before], old_pending });
            const same: u32 = @intCast(std.mem.indexOfDiff(u8, old, fresh.items) orelse @min(old.len, fresh.items.len));
            self.counters.display_byte_visits += @min(old.len, fresh.items.len) + fresh.items.len;
            write_full = self.liveTokensEnd(first) + same;
        }
        try self.liveShow(write_full, full_end, final);
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
    fn liveShow(self: *Doc, write_full: u32, full_end: u32, final: bool) Error!void {
        const live = &self.live;
        // A hold inside a token shows what B drew of it, which the token's whole display need
        // not start with: the bytes from that token on are written again once it shows whole.
        const partial_before = live.partial_from;
        live.partial_token = none;
        live.partial_from = none;
        // A leaf that closes with an expired opener folded away is written again whole.
        if (final and live.expired_display != none) return;
        const cut = if (final) none else self.liveHoldCut();
        const shown_end = @min(full_end, cut);
        var write_start = @min(@min(write_full, live.shown_byte_count), partial_before);
        write_start = @min(write_start, shown_end);
        self.counters.tail_write_bytes += shown_end - write_start;
        if (self.tail_sink) |sink| {
            if (sink.valid) {
                sink.mirror.shrinkRetainingCapacity(write_start);
                try self.liveRender(write_start, shown_end, sink.allocator, &sink.mirror);
            }
        }
        live.shown_byte_count = shown_end;
    }

    /// Appends the full display's bytes [from, to).
    fn liveRender(self: *Doc, from: u32, to: u32, allocator: Allocator, out: *std.ArrayListUnmanaged(u8)) Error!void {
        if (from >= to) return;
        const live = &self.live;
        const r = live.parser.result();
        assert(from >= live.folded_display_byte_count);
        var buffer: std.ArrayListUnmanaged(u8) = .empty;
        const arena = self.scratch.allocator();
        // The first token that ends after `from`.
        var low: usize = 0;
        var high: usize = r.tokens.len;
        while (low < high) {
            const mid = (low + high) / 2;
            if (live.display_ends.items[mid] <= from) low = mid + 1 else high = mid;
        }
        var i: u32 = @intCast(low);
        const start_offset = self.liveTokensEnd(i);
        if (live.partial_token != none and to == live.partial_from + live.partial_byte_count) {
            // Up to a hold inside a token: the tokens before it, then what B drew of it.
            while (i < live.partial_token) : (i += 1) try inline_parser.appendTokenDisplay(r, i, arena, &buffer);
            try inline_parser.appendTokenDisplayBefore(r, live.partial_token, live.partial_at, arena, &buffer);
        } else {
            while (i < r.tokens.len) : (i += 1) try inline_parser.appendTokenDisplay(r, i, arena, &buffer);
            try buffer.appendSlice(arena, live.pending_display.items);
        }
        self.counters.display_byte_visits += to - from;
        try out.appendSlice(allocator, buffer.items[from - start_offset .. to - start_offset]);
    }

    /// The display offset where B's holds start: a paragraph that may still be only link
    /// definitions shows nothing; a last line with a pipe waits for the next line.
    fn liveHoldCut(self: *Doc) u32 {
        const live = &self.live;
        if (live.definition_possible) {
            const status = definitionStatus(live.content.items);
            if (status == .possible) return 0;
            live.definition_possible = false;
        }
        // The paragraph's last line, complete or pending, is held from its first pipe: with
        // the next line it may be a table's header. (Held from the pipe, not from the line's
        // start: a pipe that arrives after the line's first bytes were shown takes nothing back.)
        if (self.blocks.items[live.block].kind != .paragraph) return none;
        const pipe = if (live.line_start_byte != none) live.line_pipe else live.pipe_line_start;
        if (pipe == none) return none;
        return self.liveDisplayAt(pipe);
    }

    /// The display offset of content offset `at`: from the tokens (with what B drew of a token
    /// that reaches it) or, in the untokenized bytes, from what B draws before it.
    fn liveDisplayAt(self: *Doc, at: u32) u32 {
        const live = &self.live;
        const r = live.parser.result();
        if (at >= live.parser.position) {
            var drawn: std.ArrayListUnmanaged(u8) = .empty;
            var scan: inline_parser.PendingScan = .{};
            inline_parser.renderPending(live.content.items[0..at], live.parser.position, live.pending_code_opener, &scan, self.scratch.allocator(), &drawn) catch return live.folded_display_byte_count;
            self.counters.display_byte_visits += drawn.items.len;
            return self.liveTokensEnd(@intCast(r.tokens.len)) + @as(u32, @intCast(drawn.items.len));
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
        var before: std.ArrayListUnmanaged(u8) = .empty;
        inline_parser.appendTokenDisplayBefore(r, @intCast(low), at, self.scratch.allocator(), &before) catch return start;
        self.counters.display_byte_visits += before.items.len;
        live.partial_token = @intCast(low);
        live.partial_at = at;
        live.partial_from = start;
        live.partial_byte_count = @intCast(before.items.len);
        return start + live.partial_byte_count;
    }

    /// An expired opener whose tokens were folded away shows literal now: the display from it
    /// on is written again from a whole parse of the closed leaf.
    fn liveRewriteExpired(self: *Doc, index: u32) Error!void {
        const live = &self.live;
        const from = live.expired_display;
        const whole = (try self.readLeaf(self.scratch.allocator(), index)).bytes.items;
        self.counters.display_byte_visits += whole.len;
        self.counters.tail_write_bytes += whole.len - from;
        if (self.tail_sink) |sink| {
            if (sink.valid) {
                sink.mirror.shrinkRetainingCapacity(from);
                try sink.mirror.appendSlice(sink.allocator, whole[from..]);
            }
        }
        live.shown_byte_count = @intCast(whole.len);
    }

    /// Writes bytes after the leaf's display (a setext underline when the heading closes).
    fn liveWriteExtra(self: *Doc, bytes: []const u8) Error!void {
        self.counters.tail_write_bytes += bytes.len;
        if (self.tail_sink) |sink| if (sink.valid) try sink.mirror.appendSlice(sink.allocator, bytes);
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
        // The limit is a word start: whitespace precedes it.
        assert(isAsciiWhitespaceByte(live.content.items[position - 1]));
        const drop = position - look_behind_byte_count;
        const rest = live.content.items.len - drop;
        self.liveNoteExpired(@intCast(parser.tokens.items.len));
        if (live.display_ends.items.len > 0) live.folded_display_byte_count = live.display_ends.items[live.display_ends.items.len - 1];
        live.display_ends.clearRetainingCapacity();
        std.mem.copyForwards(u8, live.content.items[0..rest], live.content.items[drop..]);
        live.content.items.len = rest;
        live.content_base += drop;
        live.pending_scan.stop -= drop;
        live.pending_scan.scanned -|= drop;
        if (live.pending_scan.code) |opener| live.pending_scan.code = opener - drop;
        if (live.pending_code_opener) |opener| live.pending_code_opener = opener - drop;
        parser.rebase(drop);
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
            content.shrinkAndFree(self.allocator, @max(content.items.len, live_retained_byte_count_max / 2));
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
        if (live.definition_possible or live.pipe_line_start != none or live.line_pipe != none) return;
        const first = parser.firstUnresolvedToken();
        const r = parser.result();
        const at = if (first < r.tokens.len) r.tokens[first].start else parser.position;
        if (at <= look_behind_byte_count) return;
        // One code point of look behind stays (flanking reads it).
        var drop = at - look_behind_byte_count;
        while (drop > 0 and (live.content.items[drop] & 0xc0) == 0x80) drop -= 1;
        const folded = self.liveTokensEnd(first);
        self.liveNoteExpired(first);
        const rest = live.content.items.len - drop;
        std.mem.copyForwards(u8, live.content.items[0..rest], live.content.items[drop..]);
        live.content.items.len = rest;
        live.content_base += drop;
        live.pending_scan.stop -= drop;
        live.pending_scan.scanned -|= drop;
        if (live.pending_scan.code) |opener| live.pending_scan.code = opener - drop;
        if (live.pending_code_opener) |opener| live.pending_code_opener = opener - drop;
        const visits_before = parser.byte_visits;
        try parser.restart(live.content.items, at - drop);
        self.counters.inline_byte_visits += parser.byte_visits - visits_before;
        _ = parser.takeChanged();
        // The same tokens from `first` on, so the same display offsets.
        const tokens = parser.result().tokens;
        live.folded_display_byte_count = folded;
        try live.display_ends.resize(self.allocator, tokens.len);
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
        var parser: inline_parser.Parser = .{ .allocator = arena, .references = self.references(), .options = .{ .math = self.options.math } };
        var cut: u32 = none;
        // A table cell of the pending row is drawn the same way.
        const pending_cell = b.kind == .table_cell and !self.finished and b.source_start_byte >= self.line_start_byte;
        const open = (b.flags.open and (b.kind == .paragraph or b.kind == .heading)) or pending_cell;
        if (open) {
            // As the live leaf holds it: each complete line ends in '\n'.
            var body = (try self.leafContent(arena, index)).bytes;
            if (pending_cell) body = try unescapePipes(arena, body);
            const complete = b.content_end_byte <= self.line_start_byte;
            const content = if (complete and b.kind == .paragraph) try std.mem.concat(arena, u8, &.{ body, "\n" }) else body;
            if (b.kind == .paragraph and definitionStatus(content) == .possible) return leaf;
            try parser.feed(content, false);
            // The last line, complete or pending, waits from its first pipe: with the next line
            // it may be a table's header.
            if (b.kind == .paragraph) {
                const last_start: usize = if (std.mem.lastIndexOfScalar(u8, body, '\n')) |n| n + 1 else 0;
                if (std.mem.indexOfScalar(u8, body[last_start..], '|')) |at| cut = @intCast(last_start + at);
            }
        } else {
            try parser.feed(try self.leafSubject(arena, index), true);
        }
        const r = parser.result();
        var styles: Styles = .{};
        var i: u32 = 0;
        while (i < r.tokens.len) : (i += 1) {
            const t = r.tokens[i];
            const raw = r.content[t.start..t.end()];
            writer.base.strong = styles.strong > 0;
            writer.base.italic = styles.italic > 0;
            writer.base.strikethrough = styles.strikethrough > 0;
            writer.link = styles.link;
            // A token that reaches the held pipe shows what B drew of it before the pipe.
            if (cut != none and t.end() > cut) {
                if (t.start < cut) {
                    var before: std.ArrayListUnmanaged(u8) = .empty;
                    try inline_parser.appendTokenDisplayBefore(r, i, cut, arena, &before);
                    const span: Span = .{ .code = t.kind == .code, .math = t.kind == .math };
                    writer.base.raw = t.kind == .code;
                    writer.base.math = t.kind == .math;
                    try writer.write(before.items, span);
                    writer.base.raw = false;
                    writer.base.math = false;
                }
                break;
            }
            switch (t.kind) {
                .delimiter => {
                    const d_index = inline_parser.delimiterOf(r, i);
                    const d = if (d_index) |di| r.delimiters[di] else null;
                    const length = inline_parser.tokenDisplayLength(r, i);
                    if (d != null and d.?.closer_match_count > 0) {
                        var m = d.?.closer_first_match;
                        while (m < d.?.closer_first_match + d.?.closer_match_count) : (m += 1) styles.apply(r.matches[m].kind, -1);
                        writer.base.strong = styles.strong > 0;
                        writer.base.italic = styles.italic > 0;
                        writer.base.strikethrough = styles.strikethrough > 0;
                        try writer.plain(r, t.end() - length, t.end());
                    } else {
                        try writer.plain(r, t.start, t.start + length);
                        if (d) |dd| {
                            var m = dd.opener_matches;
                            while (m) |mi| : (m = r.matches[mi].next_for_opener) styles.apply(r.matches[mi].kind, 1);
                        }
                    }
                },
                .bracket_open => {
                    if (t.aux == 0) {
                        try writer.write(raw, .{});
                        continue;
                    }
                    const link = r.links[t.aux - 1];
                    styles.link = try writer.url("", try inline_parser.unescapeText(arena, link.destination));
                },
                .bracket_close => {
                    if (t.aux == 0) try writer.write(raw[0..1], .{}) else styles.link = null;
                },
                .autolink, .autolink_email, .extended_autolink => {
                    const target = if (t.kind == .extended_autolink) raw else raw[1 .. raw.len - 1];
                    const prefix: []const u8 = if (t.kind == .autolink_email) "mailto:" else if (t.kind == .extended_autolink and t.aux == @backingInt(inline_parser.ExtendedKind.www)) "http://" else "";
                    writer.link = try writer.url(prefix, target);
                    try writer.write(target, .{});
                },
                .code => {
                    var display: std.ArrayListUnmanaged(u8) = .empty;
                    try inline_parser.appendTokenDisplay(r, i, arena, &display);
                    writer.base.raw = true;
                    try writer.write(display.items, .{ .code = true });
                    writer.base.raw = false;
                },
                .math => {
                    writer.base.math = true;
                    try writer.write(raw[t.aux .. raw.len - t.aux], .{ .math = true });
                    writer.base.math = false;
                },
                .escape => {
                    writer.base.escape = true;
                    try writer.write(raw[1..], .{});
                    writer.base.escape = false;
                },
                .text => try writer.plain(r, t.start, t.end()),
                else => {
                    var display: std.ArrayListUnmanaged(u8) = .empty;
                    try inline_parser.appendTokenDisplay(r, i, arena, &display);
                    try writer.write(display.items, .{});
                },
            }
        }
        writer.link = null;
        writer.base.strong = false;
        writer.base.italic = false;
        writer.base.strikethrough = false;
        if (open and i == r.tokens.len and parser.position < cut) {
            const content = r.content[0..@min(cut, r.content.len)];
            const code = parser.search_opener == parser.position and parser.position < content.len and content[parser.position] == '`';
            var pending: std.ArrayListUnmanaged(u8) = .empty;
            var scan: inline_parser.PendingScan = .{};
            try inline_parser.renderPending(content, parser.position, if (code) parser.position else null, &scan, arena, &pending);
            writer.base.raw = code;
            try writer.write(pending.items, .{ .code = code });
            writer.base.raw = false;
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
    fn leafSubject(self: *const Doc, arena: Allocator, index: u32) Error![]const u8 {
        const content = try self.leafContent(arena, index);
        var bytes = content.bytes;
        var end = bytes.len;
        while (end > 0 and (bytes[end - 1] == ' ' or bytes[end - 1] == '\t' or bytes[end - 1] == '\n')) end -= 1;
        bytes = bytes[0..end];
        if (self.blocks.items[index].kind == .table_cell) bytes = try unescapePipes(arena, bytes);
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
        const arena = self.scratch.allocator();
        const normalized = normalizeLabel(arena, label) catch return null;
        if (normalized.len == 0) return null;
        const hash: u32 = @truncate(std.hash.Wyhash.hash(0, normalized));
        const index = self.findDefinition(arena, normalized, hash) orelse return null;
        // The inline parser sees the doc as const; the watch flag is the one write it causes.
        if (index == self.watch_definition) @constCast(self).watch_hit = true;
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
        for (ancestors) |a| {
            const b = self.blocks.items[a];
            line.findNextNonspace();
            switch (b.kind) {
                .quote => {
                    if (line.indented or line.peek(line.next_nonspace) != '>') return false;
                    line.advanceNextNonspace();
                    line.advanceOffset(1, false);
                    if (isSpaceOrTab(line.peek(line.offset))) line.advanceOffset(1, true);
                },
                .item => {
                    if (line.blank) {
                        line.advanceNextNonspace();
                    } else if (line.indent >= b.payload[0]) {
                        line.advanceOffset(b.payload[0], true);
                    } else return false;
                },
                else => {},
            }
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
    _unused: u6 = 0,
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

pub const Leaf = struct {
    bytes: std.ArrayListUnmanaged(u8) = .empty,
    chunks: std.ArrayListUnmanaged(Chunk) = .empty,
    urls: std.ArrayListUnmanaged(u8) = .empty,
};

const Styles = struct {
    strong: i32 = 0,
    italic: i32 = 0,
    strikethrough: i32 = 0,
    link: ?[2]u32 = null,

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

    /// Appends bytes with the current style, merging into the previous chunk when equal.
    fn write(self: *LeafWriter, bytes: []const u8, span: Span) Error!void {
        if (bytes.len == 0) return;
        var scope = self.base;
        scope.link = self.link != null;
        const link = self.link orelse [2]u32{ 0, 0 };
        try self.leaf.bytes.appendSlice(self.arena, bytes);
        const chunks = &self.leaf.chunks;
        if (chunks.items.len > 0) {
            const last = &chunks.items[chunks.items.len - 1];
            if (@as(u16, @bitCast(last.scope)) == @as(u16, @bitCast(scope)) and @as(u32, @bitCast(last.span)) == @as(u32, @bitCast(span)) and
                last.link_offset == link[0] and last.link_byte_count == link[1] and !span.code and !span.math)
            {
                last.byte_count += @intCast(bytes.len);
                return;
            }
        }
        try chunks.append(self.arena, .{ .byte_count = @intCast(bytes.len), .scope = scope, .span = span, .link_offset = link[0], .link_byte_count = link[1] });
    }

    /// Plain content bytes [start, end), with GFM email autolinks inside them linked.
    fn plain(self: *LeafWriter, r: inline_parser.Result, start: u32, end: u32) Error!void {
        var at = start;
        for (r.emails) |email| {
            if (email[1] <= at or email[0] >= end) continue;
            if (at < email[0]) try self.write(r.content[at..email[0]], .{});
            const saved = self.link;
            self.link = try self.url("mailto:", r.content[email[0]..email[1]]);
            const stop = @min(end, email[1]);
            try self.write(r.content[@max(at, email[0])..stop], .{});
            self.link = saved;
            at = stop;
        }
        if (at < end) try self.write(r.content[at..end], .{});
    }

    fn url(self: *LeafWriter, prefix: []const u8, target: []const u8) Error![2]u32 {
        const offset: u32 = @intCast(self.leaf.urls.items.len);
        try self.leaf.urls.appendSlice(self.arena, prefix);
        try self.leaf.urls.appendSlice(self.arena, target);
        return .{ offset, @intCast(prefix.len + target.len) };
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
fn heldPrefix(rest_initial: []const u8, delimiter_row: bool, in_table: bool, math: bool) bool {
    var rest = rest_initial;
    if (delimiter_row) return true;
    var after_item = false;
    while (true) {
        if (rest.len == 0) return true;
        const c = rest[0];
        // A task marker after a list item marker: `[`, `[x`, `[x]` and spaces may still be one.
        if (after_item and c == '[') return taskPrefix(rest);
        switch (c) {
            '>' => {
                rest = rest[1..];
                if (rest.len > 0 and isSpaceOrTab(rest[0])) rest = rest[1..];
                rest = std.mem.trimStart(u8, rest, " \t");
                continue;
            },
            '-', '*', '+', '_', '=' => {
                if (onlyBytes(rest, c)) return true;
                if (c == '_' or c == '=') return false;
                if (rest.len < 2) return true;
                if (!isSpaceOrTab(rest[1])) return false;
                rest = std.mem.trimStart(u8, rest[1..], " \t");
                after_item = true;
                continue;
            },
            '0'...'9' => {
                var i: usize = 0;
                while (i < rest.len and std.ascii.isDigit(rest[i])) i += 1;
                if (i >= rest.len) return i <= 9;
                if (i > 9 or (rest[i] != '.' and rest[i] != ')')) return false;
                if (i + 1 >= rest.len) return true;
                if (!isSpaceOrTab(rest[i + 1])) return false;
                rest = std.mem.trimStart(u8, rest[i + 1 ..], " \t");
                after_item = true;
                continue;
            },
            '#' => {
                var i: usize = 0;
                while (i < rest.len and rest[i] == '#') i += 1;
                if (i > 6) return false;
                if (i >= rest.len) return true;
                if (!isSpaceOrTab(rest[i])) return false;
                return std.mem.trim(u8, rest[i..], " \t").len == 0;
            },
            '`', '~' => {
                const run = inline_parser.runLength(rest, 0, c);
                return run >= 3 or run == rest.len;
            },
            '<' => return true,
            '|' => return !in_table,
            ':' => return onlyBytesOf(rest, ":-| \t"),
            '$' => return math and std.mem.trimEnd(u8, rest, " \t").len <= 2 and std.mem.startsWith(u8, "$$", std.mem.trimEnd(u8, rest, " \t")),
            '\\' => return math and std.mem.trimEnd(u8, rest, " \t").len <= 2 and std.mem.startsWith(u8, "\\[", std.mem.trimEnd(u8, rest, " \t")),
            else => return false,
        }
    }
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

pub const DefinitionStatus = enum { not, possible };

/// Whether paragraph content (lines joined by '\n') may still be only link reference
/// definitions: it starts with a label that is not closed yet, or a closed label followed by
/// ':' or by nothing yet. Bytes after a complete definition may still be its title.
pub fn definitionStatus(content: []const u8) DefinitionStatus {
    if (content.len == 0 or content[0] != '[') return .not;
    const length = inline_parser.scanLinkLabel(content, 0, false) catch return .possible;
    if (length < 3) return .not;
    if (length >= content.len) return .possible;
    return if (content[length] == ':') .possible else .not;
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

fn atxContent(s: []const u8, after_hashes: u32, end: u32) [2]u32 {
    var range = trimRange(s, after_hashes, end);
    // An optional closing sequence: spaces then '#'s at the end, or only '#'s.
    var i = range[1];
    while (i > range[0] and s[i - 1] == '#') i -= 1;
    if (i == range[0]) return .{ range[0], range[0] };
    if (i < range[1] and isSpaceOrTab(s[i - 1])) {
        range[1] = i;
        range = trimRange(s, range[0], range[1]);
    }
    return range;
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
    while (it.next()) |item| {
        if (item.len == 0 or item.len > hook_filter_item_byte_count_max) return error.InvalidOptions;
    }
}

test {
    _ = inline_parser;
}
