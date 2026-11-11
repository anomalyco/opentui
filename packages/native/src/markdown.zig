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

/// Work counters (design invariant 4 and the gates). Deterministic; tests read them.
pub const Counters = struct {
    /// Source bytes the line scanner and block parser read, including rescans of a pending line.
    bytes_scanned: u64 = 0,
    /// Leaf content bytes inline-parsed again because a definition arrived.
    bytes_reinlined: u64 = 0,
    /// Allocations the doc made (capacity growth); the scratch arena is not counted here.
    capacity_growth_count: u64 = 0,
    /// Display bytes the live leaf's tail writes would carry: from the first changed display
    /// byte to the end, summed over appends (invariant 4).
    tail_write_bytes: u64 = 0,
    /// The live leaf's guess about the pending line disagreed with the parsed line (must stay 0).
    live_mismatch_count: u64 = 0,
};

/// The open paragraph's inline state, kept across appends so that each append tokenizes only
/// new bytes (design: open-leaf token tail). It holds the leaf's content from the first token
/// that may still change; settled tokens are folded away.
const Live = struct {
    parser: inline_parser.Parser,
    content: std.ArrayListUnmanaged(u8) = .empty,
    /// The paragraph, or none while the leaf is only the pending line's.
    block: u32 = none,
    /// Source offset of the leaf's first content byte: names the leaf.
    start_byte: u32 = none,
    /// The line being fed before it is complete: its content start and the end fed so far.
    line_start_byte: u32 = none,
    line_fed_end_byte: u32 = 0,
    /// Display end offset of each token, counting the folded display before them.
    display_ends: std.ArrayListUnmanaged(u32) = .empty,
    folded_display_byte_count: u32 = 0,
};

/// Test instrument: applies every live tail write to a mirror of the leaf's display, as a bound
/// text node would receive them, and checks the mirror against a whole parse when the leaf
/// closes.
pub const TailSink = struct {
    allocator: Allocator,
    mirror: std.ArrayListUnmanaged(u8) = .empty,
    checked_leaf_count: u32 = 0,
    mismatch_count: u32 = 0,

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
    /// A filter match in the pending line, latched once its line is parsed; none otherwise.
    hook_pending_byte: u32 = none,
    /// Blocks already latched under an empty filter (every prose leaf).
    hook_scan_block_count: u32 = 0,

    const UndoEntry = struct { index: u32, block: Block };

    pub fn init(allocator: Allocator, scratch: *std.heap.ArenaAllocator, options: Options) Error!Doc {
        options.limits.assertValid();
        try validateFilter(options.hook_filter);
        return .{
            .allocator = allocator,
            .scratch = scratch,
            .options = options,
            .live = .{ .parser = .{ .allocator = allocator, .references = undefined, .options = .{ .math = options.math } } },
        };
    }

    pub fn deinit(self: *Doc) void {
        self.live.parser.deinit();
        self.live.content.deinit(self.allocator);
        self.live.display_ends.deinit(self.allocator);
        self.source.deinit(self.allocator);
        self.blocks.deinit(self.allocator);
        self.definitions.deinit(self.allocator);
        self.* = undefined;
    }

    // ---- Mutations ----

    /// Appends bytes (valid UTF-8 per call). A rejected append changes nothing.
    pub fn append(self: *Doc, bytes: []const u8) Error!void {
        defer self.resetScratch();
        if (self.finished) {
            // N2: re-opening is a fresh parse of the whole resulting source.
            const whole = try self.scratch.allocator().alloc(u8, self.source.items.len + bytes.len);
            @memcpy(whole[0..self.source.items.len], self.source.items);
            @memcpy(whole[self.source.items.len..], bytes);
            return self.setInternal(whole);
        }
        if (self.source.items.len + bytes.len > self.options.limits.source_byte_count) return error.SourceLimit;
        var snapshot = self.beginMutation();
        errdefer self.rollback(&snapshot);
        try self.reserveSource(@intCast(self.source.items.len + bytes.len));
        self.source.appendSliceAssumeCapacity(bytes);
        try self.scanLines(false);
        try self.livePending();
        try self.latchHooks(snapshot.source_len);
        self.updateCommits();
    }

    /// Ends the document: the pending line is complete and every block closes.
    pub fn finish(self: *Doc) Error!void {
        defer self.resetScratch();
        return self.finishInternal();
    }

    fn finishInternal(self: *Doc) Error!void {
        if (self.finished) return;
        var snapshot = self.beginMutation();
        errdefer self.rollback(&snapshot);
        try self.scanLines(true);
        while (self.open_count > 0) try self.closeBlock(self.open[self.open_count - 1], self.previous_line_end_byte);
        try self.latchHooks(@intCast(self.source.items.len));
        self.finished = true;
        self.updateCommits();
    }

    /// Replaces the whole source with a fresh parse. Leading blocks equal to the old ones keep
    /// their index and report nothing; `removed_from_index` is the first that differs.
    pub fn set(self: *Doc, bytes: []const u8) Error!void {
        defer self.resetScratch();
        return self.setInternal(bytes);
    }

    /// A math change is a fresh parse (it changes the block tree); a hook change latches again.
    pub fn setOptions(self: *Doc, options: Options) Error!void {
        defer self.resetScratch();
        options.limits.assertValid();
        try validateFilter(options.hook_filter);
        if (options.math != self.options.math or !std.meta.eql(options.limits, self.options.limits)) {
            const old = self.options;
            self.options = options;
            const finished = self.finished;
            const source = try self.scratch.allocator().dupe(u8, self.source.items);
            self.setInternal(source) catch |err| {
                self.options = old;
                return err;
            };
            if (finished) try self.finishInternal();
            return;
        }
        self.options = options;
        for (self.blocks.items, 0..) |b, i| {
            if (b.flags.hooked) (try self.blockMut(@intCast(i))).flags.hooked = false;
        }
        self.hook_pending_byte = none;
        self.hook_scan_block_count = 0;
        try self.latchHooks(0);
    }

    fn setInternal(self: *Doc, bytes: []const u8) Error!void {
        if (bytes.len > self.options.limits.source_byte_count) return error.SourceLimit;
        var fresh = try Doc.init(self.allocator, self.scratch, self.options);
        errdefer fresh.deinit();
        try fresh.reserveSource(@intCast(bytes.len));
        fresh.source.appendSliceAssumeCapacity(bytes);
        try fresh.scanLines(false);
        try fresh.latchHooks(0);
        fresh.updateCommits();
        // The leading equal blocks keep the old doc's change bits.
        var equal: u32 = 0;
        const count = @min(self.blocks.items.len, fresh.blocks.items.len);
        while (equal < count and self.sameBlock(&fresh, equal)) equal += 1;
        for (fresh.blocks.items[0..equal], self.blocks.items[0..equal]) |*new, old| {
            new.flags.unreported = old.flags.unreported;
        }
        const removed = if (equal < self.read_block_count) @min(self.removed_from_index, equal) else self.removed_from_index;
        fresh.removed_from_index = removed;
        fresh.counters = self.counters;
        fresh.counters.bytes_scanned += fresh.source.items.len;
        fresh.read_block_count = @min(self.read_block_count, equal);
        self.deinit();
        self.* = fresh;
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
        if (out.len < count) return .{ .count = count, .removed_from_index = removed };
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
        hook_scan_block_count: u32,
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
            .hook_scan_block_count = self.hook_scan_block_count,
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
        self.hook_scan_block_count = snapshot.hook_scan_block_count;
        // The live leaf may have taken bytes of the rejected call: drop it; the open paragraph
        // is parsed whole when it closes.
        self.liveReset(none, none);
    }

    /// The block for writing; the first write in a call to a block that existed before it is
    /// logged so a rejected call can restore it.
    fn blockMut(self: *Doc, index: u32) Error!*Block {
        if (index < self.undo_base_block_count) {
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
    fn scanLines(self: *Doc, final: bool) Error!void {
        const s = self.source.items;
        var start = self.line_start_byte;
        var i = start;
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
            self.counters.bytes_scanned += next - start;
            try self.processLine(start, content_end);
            start = next;
            i = next;
        }
        if (final and start < s.len) {
            self.counters.bytes_scanned += s.len - start;
            try self.processLine(start, @intCast(s.len));
            start = @intCast(s.len);
        }
        self.line_start_byte = start;
    }

    /// Latches `HOOKED` on prose leaves whose source holds a filter substring. Only bytes from
    /// `from_byte` on are searched, plus the overlap a match can reach back (invariant 4); a match
    /// in the pending line waits for its leaf.
    fn latchHooks(self: *Doc, from_byte: u32) Error!void {
        if (!self.options.hook) return;
        const s = self.source.items;
        if (self.options.hook_filter.len == 0) {
            for (self.blocks.items[self.hook_scan_block_count..], self.hook_scan_block_count..) |b, i| {
                if (Doc.isInlineLeaf(b) and !b.flags.hooked) (try self.blockMut(@intCast(i))).flags.hooked = true;
            }
            self.hook_scan_block_count = @intCast(self.blocks.items.len);
            return;
        }
        if (self.hook_pending_byte != none and self.hook_pending_byte < self.line_start_byte) {
            try self.latchAt(self.hook_pending_byte);
            self.hook_pending_byte = none;
        }
        var it = std.mem.splitScalar(u8, self.options.hook_filter, 0);
        while (it.next()) |item| {
            const overlap: u32 = @intCast(item.len - 1);
            var at: usize = from_byte -| overlap;
            self.counters.bytes_scanned += s.len - at;
            while (std.mem.indexOfPos(u8, s, at, item)) |found| : (at = found + 1) {
                const position: u32 = @intCast(found);
                if (position + item.len <= from_byte) continue;
                if (position >= self.line_start_byte) {
                    self.hook_pending_byte = @min(self.hook_pending_byte, position);
                } else {
                    try self.latchAt(position);
                }
            }
        }
    }

    /// Latches the leaves holding a filter match that starts in [start, end).
    fn latchRange(self: *Doc, start: u32, end: u32) Error!void {
        if (!self.options.hook or self.options.hook_filter.len == 0) return;
        var it = std.mem.splitScalar(u8, self.options.hook_filter, 0);
        while (it.next()) |item| {
            var at: usize = start;
            self.counters.bytes_scanned += end - start;
            while (std.mem.indexOfPos(u8, self.source.items, at, item)) |found| : (at = found + 1) {
                if (found >= end) break;
                try self.latchAt(@intCast(found));
            }
        }
    }

    /// Whether a filter match starts in [start, end).
    fn filterHolds(self: *Doc, start: u32, end: u32) Error!bool {
        if (!self.options.hook) return false;
        if (self.options.hook_filter.len == 0) return true;
        self.counters.bytes_scanned += end - start;
        var it = std.mem.splitScalar(u8, self.options.hook_filter, 0);
        while (it.next()) |item| {
            if (std.mem.indexOfPos(u8, self.source.items, start, item)) |found| {
                if (found < end) return true;
            }
        }
        return false;
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

    fn continues(self: *Doc, line: *Line, index: u32, b: Block) Continue {
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
                    const range = atxContent(s, after, line.end);
                    const h = try self.addChild(.heading, at, line.end);
                    const block = try self.blockMut(h);
                    block.payload[0] = hashes;
                    block.content_start_byte = range[0];
                    block.content_end_byte = range[1];
                    try self.closeBlock(h, line.end);
                    line.offset = line.end;
                    line.consumed = true;
                    return .leaf;
                }
            }
            // Fenced code.
            if (c == '`' or c == '~') {
                const run = inline_parser.runLength(s[0..line.end], at, c);
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
            .flags = .{ .open = true, .unreported = true },
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
        block.flags.open = false;
        block.flags.unreported = true;
        switch (block.kind) {
            .paragraph => {
                if (block.source_end_byte > end) block.source_end_byte = end;
                try self.extractDefinitions(index);
                if (index < self.blocks.items.len and self.paragraphEmpty(index)) {
                    // Only definitions: the paragraph is the last block, so its removal is a suffix.
                    assert(index + 1 == self.blocks.items.len);
                    self.blocks.items.len -= 1;
                    self.noteRemoved(index);
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

    fn lastChild(self: *const Doc, index: u32) u32 {
        var last = none;
        var i = index + 1;
        while (i < self.blocks.items.len) : (i += 1) {
            const p = self.blocks.items[i].parent_index;
            if (p == index) last = i else if (!self.isDescendant(i, index)) break;
        }
        assert(last != none);
        return last;
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
        const hooked = try self.filterHolds(kept.source_start_byte, kept.source_end_byte);
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

    /// A closing prose leaf's last inline pass: the live leaf's when it followed this leaf to
    /// its end, else a whole parse.
    fn closeLeaf(self: *Doc, index: u32) Error!void {
        const live = &self.live;
        const b = self.blocks.items[index];
        if (live.block == index and live.start_byte == b.content_start_byte and live.line_start_byte == none) {
            var end = live.content.items.len;
            while (end > live.parser.position and isAsciiWhitespaceByte(live.content.items[end - 1])) end -= 1;
            try self.liveFeed(live.content.items[0..end], true);
            const unresolved = live.parser.unresolved;
            if (self.tail_sink) |sink| {
                const expected = try self.leafDisplay(self.scratch.allocator(), index);
                sink.checked_leaf_count += 1;
                if (!std.mem.eql(u8, expected, sink.mirror.items)) {
                    sink.mismatch_count += 1;
                    if (std.debug.runtime_safety) std.debug.print("live display mismatch: expected '{s}' mirror '{s}'\n", .{ expected, sink.mirror.items });
                }
            }
            self.liveReset(none, none);
            if (b.flags.unresolved != unresolved) (try self.blockMut(index)).flags.unresolved = unresolved;
            return;
        }
        if (live.block == index) self.liveReset(none, none);
        try self.computeUnresolved(index);
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
        if (self.tail_sink) |sink| sink.mirror.clearRetainingCapacity();
    }

    /// A complete line of paragraph `index`, its content from `content_start` to `end`.
    fn liveLine(self: *Doc, index: u32, content_start: u32, end: u32) Error!void {
        const live = &self.live;
        const s = self.source.items;
        if (live.block != index) {
            const new_paragraph = self.blocks.items[index].content_start_byte == content_start;
            if (live.block == none and live.start_byte == content_start and new_paragraph) {
                live.block = index;
            } else if (new_paragraph) {
                if (live.start_byte != none) self.counters.live_mismatch_count += @intFromBool(live.line_start_byte != none and live.line_start_byte != content_start);
                self.liveReset(content_start, index);
            } else {
                // A paragraph the live leaf does not follow (its state was dropped): its close
                // parses it whole.
                return;
            }
        }
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
        if (from < end) try self.liveAppend(s[from..end]);
        try self.liveAppend("\n");
        try self.liveFeed(live.content.items, false);
    }

    /// Feeds the pending line once its first bytes show that it can only continue the open
    /// paragraph or start one: a byte that no block start, setext underline or delimiter row
    /// begins with. Anything else waits for the line's end.
    fn livePending(self: *Doc) Error!void {
        const live = &self.live;
        const s = self.source.items;
        var end: u32 = @intCast(s.len);
        if (end > self.line_start_byte and s[end - 1] == '\r') end -= 1;
        if (live.line_start_byte != none) {
            if (live.line_fed_end_byte < end) {
                try self.liveAppend(s[live.line_fed_end_byte..end]);
                live.line_fed_end_byte = end;
                try self.liveFeed(live.content.items, false);
            }
            return;
        }
        const content_start = self.pendingParagraphLine(end) orelse return;
        const tip = self.tipIndex();
        const continues_tip = tip != none and self.blocks.items[tip].kind == .paragraph;
        if (continues_tip) {
            if (live.block != tip) return;
        } else if (live.block != none or live.start_byte != content_start) {
            self.liveReset(content_start, none);
        }
        live.line_start_byte = content_start;
        live.line_fed_end_byte = end;
        try self.liveAppend(s[content_start..end]);
        try self.liveFeed(live.content.items, false);
    }

    /// The content start of the pending line when its kind is decided as paragraph text.
    fn pendingParagraphLine(self: *Doc, end: u32) ?u32 {
        var line = Line{ .s = self.source.items, .start = self.line_start_byte, .end = end, .offset = self.line_start_byte };
        var matched: u32 = 0;
        while (matched < self.open_count) : (matched += 1) {
            const index = self.open[matched];
            const b = self.blocks.items[index];
            if (b.kind == .paragraph) break;
            if (b.kind != .quote and b.kind != .item and b.kind != .list) return null;
            line.findNextNonspace();
            if (line.blank) return null;
            if (self.continues(&line, index, b) != .matches) break;
        }
        line.findNextNonspace();
        if (line.blank) return null;
        const tip = self.tipIndex();
        const tip_is_paragraph = tip != none and self.blocks.items[tip].kind == .paragraph;
        if (line.indented) return if (tip_is_paragraph) line.next_nonspace else null;
        if (maybeSpecial(line.peek(line.next_nonspace))) return null;
        // An open table, fence or HTML block whose containers all match takes the line itself.
        if (!tip_is_paragraph and tip != none and matched == self.open_count) {
            const kind = self.blocks.items[tip].kind;
            if (kind == .table or kind == .code or kind == .html) return null;
        }
        return line.next_nonspace;
    }

    fn liveAppend(self: *Doc, bytes: []const u8) Error!void {
        const content = &self.live.content;
        if (content.items.len + bytes.len > content.capacity) self.counters.capacity_growth_count += 1;
        try content.appendSlice(self.allocator, bytes);
    }

    /// Runs the live parser over its content and counts the display bytes a tail write would
    /// carry: from the first token whose display changed (or the pending bytes' start) to the end.
    fn liveFeed(self: *Doc, content: []const u8, final: bool) Error!void {
        const live = &self.live;
        const parser = &live.parser;
        parser.references = self.references();
        const tokens_before: u32 = @intCast(parser.tokens.items.len);
        const position_before = parser.position;
        const pending_before: u32 = @intCast(parser.subject.len - position_before);
        const scanned_before = parser.bytes_scanned;
        try parser.feed(content, final);
        self.counters.bytes_scanned += parser.bytes_scanned - scanned_before;
        const changes = parser.takeChanged();
        const pending: u32 = @intCast(content.len - parser.position);
        const r = parser.result();
        // A text token that only grew is compared byte by byte below, like pending bytes; any
        // other change rewrites from its token.
        const grown_last = changes.extended != none and changes.extended + 1 == tokens_before and changes.extended < changes.token;
        const changed = if (grown_last) changes.token else @min(changes.token, changes.extended);
        // Display offsets of the tokens from the first changed one on.
        const first: u32 = if (grown_last) changes.extended else if (changed == none) @intCast(r.tokens.len) else @min(changed, tokens_before);
        const ends = &live.display_ends;
        if (r.tokens.len > ends.capacity) self.counters.capacity_growth_count += 1;
        try ends.resize(self.allocator, r.tokens.len);
        const first_offset: u32 = if (first == 0) live.folded_display_byte_count else ends.items[first - 1];
        var offset = first_offset;
        var i = first;
        while (i < r.tokens.len) : (i += 1) {
            offset += inline_parser.tokenDisplayLength(r, i);
            ends.items[i] = offset;
        }
        const display_end = offset + pending;
        // The new display from `first_offset` on. When no old token changed, the old display
        // there was the old pending bytes, shown as they are: the write starts where the two
        // first differ (a word that becomes plain text rewrites nothing).
        const arena = self.scratch.allocator();
        var fresh: std.ArrayListUnmanaged(u8) = .empty;
        i = first;
        while (i < r.tokens.len) : (i += 1) try inline_parser.appendTokenDisplay(r, i, arena, &fresh);
        try fresh.appendSlice(arena, content[parser.position..]);
        var same: u32 = 0;
        if (first >= tokens_before or grown_last) {
            // The old display here: the grown token's old bytes (text shows as it is), then the
            // old pending bytes.
            const old_start = if (grown_last) r.tokens[first].start else position_before;
            const old = content[old_start..@min(content.len, position_before + pending_before)];
            same = @intCast(std.mem.indexOfDiff(u8, old, fresh.items) orelse old.len);
            same = @min(same, @as(u32, @intCast(@min(old.len, fresh.items.len))));
        }
        const write_start = first_offset + same;
        self.counters.tail_write_bytes += display_end - write_start;
        if (self.tail_sink) |sink| {
            // The tail write: drop the old display from its first changed byte, write the new.
            sink.mirror.shrinkRetainingCapacity(write_start);
            try sink.mirror.appendSlice(sink.allocator, fresh.items[same..]);
        }
        if (!final) self.liveFold();
    }

    /// Drops the settled tokens and the content before them, keeping one code point of look
    /// behind; only at a word start, where no construct can reach back across the cut.
    fn liveFold(self: *Doc) void {
        const live = &self.live;
        const parser = &live.parser;
        const position = parser.position;
        if (!parser.settled() or position != parser.limit or position >= live.content.items.len) return;
        if (position <= 2 * look_behind_byte_count or !isAsciiWhitespaceByte(live.content.items[position - 1])) return;
        const drop = position - look_behind_byte_count;
        const rest = live.content.items.len - drop;
        if (live.display_ends.items.len > 0) live.folded_display_byte_count = live.display_ends.items[live.display_ends.items.len - 1];
        live.display_ends.clearRetainingCapacity();
        std.mem.copyForwards(u8, live.content.items[0..rest], live.content.items[drop..]);
        live.content.items.len = rest;
        parser.rebase(drop);
    }

    /// The display bytes of leaf `index` (read_leaf's text): its inline content with markers
    /// concealed.
    pub fn leafDisplay(self: *const Doc, arena: Allocator, index: u32) Error![]const u8 {
        const r = try self.parseLeaf(arena, index);
        var out: std.ArrayListUnmanaged(u8) = .empty;
        var i: u32 = 0;
        while (i < r.tokens.len) : (i += 1) try inline_parser.appendTokenDisplay(r, i, arena, &out);
        return out.items;
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
        const r = try self.parseLeaf(arena, index);
        var styles: Styles = .{};
        var i: u32 = 0;
        while (i < r.tokens.len) : (i += 1) {
            const t = r.tokens[i];
            const raw = r.content[t.start..t.end()];
            writer.base.strong = styles.strong > 0;
            writer.base.italic = styles.italic > 0;
            writer.base.strikethrough = styles.strikethrough > 0;
            writer.link = styles.link;
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
        return b.kind == .paragraph or b.kind == .heading or b.kind == .table_cell;
    }

    /// The inline parse of a leaf (paragraph, heading, table cell).
    pub fn parseLeaf(self: *const Doc, arena: Allocator, index: u32) Error!inline_parser.Result {
        const content = try self.leafContent(arena, index);
        var bytes = content.bytes;
        // Trailing whitespace of the last line is not content.
        var end = bytes.len;
        while (end > 0 and (bytes[end - 1] == ' ' or bytes[end - 1] == '\t' or bytes[end - 1] == '\n')) end -= 1;
        bytes = bytes[0..end];
        if (self.blocks.items[index].kind == .table_cell) bytes = try unescapePipes(arena, bytes);
        return inline_parser.parse(arena, bytes, self.references(), .{ .math = self.options.math });
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

    fn peek(self: *const Line, at: u32) u8 {
        return if (at < self.end) self.s[at] else 0;
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
