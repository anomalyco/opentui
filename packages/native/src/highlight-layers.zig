//! Highlight layers in UTF-8 bytes and the group sets their runs name (track step C3).
//!
//! A byte producer owns one layer of a text buffer: sorted, disjoint, nonempty runs over the bytes
//! of the text as `ot_text_buffer_get_text` returns it (one byte per line break). Runs move with
//! edits; whole-text changes empty the layers. Every run names a group set: an ordered list of
//! SyntaxStyle names that paint composes against the buffer's bound style, so a theme change or
//! swap re-highlights nothing.
const std = @import("std");
const Allocator = std.mem.Allocator;
const ss = @import("syntax-style.zig");
const link = @import("link.zig");
const text_work = @import("text-work.zig");

/// Two producers exist (Rust editor syntax, the Markdown engine); two more fit.
pub const layer_count_max = 4;
/// Group sets live as long as their Context; the limit is the only bound.
pub const group_set_count_max = 4096;
/// Core's Markdown queries stack up to 10 names on one piece.
pub const group_set_name_count_max = 16;
pub const group_set_name_byte_count_max = 64;
pub const group_set_pool_byte_count_max = 64 * 1024;

pub const Error = error{ OutOfMemory, InvalidIndex, InvalidId, LayerLimit, GroupSetLimit };

const strike: u8 = @import("ansi.zig").TextAttributes.STRIKETHROUGH;

/// The Context's interned group sets. Id = index + 1, so 0 names no set.
pub const GroupSets = struct {
    allocator: Allocator,
    name_bytes: std.ArrayListUnmanaged(u8) = .empty,
    /// Exclusive end of each name in `name_bytes`.
    name_end_bytes: std.ArrayListUnmanaged(u32) = .empty,
    /// Exclusive end of each set in `name_end_bytes`.
    set_name_ends: std.ArrayListUnmanaged(u32) = .empty,

    pub fn init(allocator: Allocator) GroupSets {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *GroupSets) void {
        self.name_bytes.deinit(self.allocator);
        self.name_end_bytes.deinit(self.allocator);
        self.set_name_ends.deinit(self.allocator);
        self.* = undefined;
    }

    pub fn count(self: *const GroupSets) u32 {
        return @intCast(self.set_name_ends.items.len);
    }

    /// Names of set `id`, in order; `id` must be live.
    pub fn nameCount(self: *const GroupSets, id: u32) u32 {
        std.debug.assert(id != 0 and id <= self.count());
        const first = if (id == 1) 0 else self.set_name_ends.items[id - 2];
        return self.set_name_ends.items[id - 1] - first;
    }

    pub fn name(self: *const GroupSets, id: u32, index: u32) []const u8 {
        std.debug.assert(index < self.nameCount(id));
        const first_name = (if (id == 1) 0 else self.set_name_ends.items[id - 2]) + index;
        const start = if (first_name == 0) 0 else self.name_end_bytes.items[first_name - 1];
        return self.name_bytes.items[start..self.name_end_bytes.items[first_name]];
    }

    /// Equal lists give equal ids. No names, or a name that is empty or not UTF-8, is
    /// `InvalidIndex`; a list past a name bound, or a new set past the count or pool bound, is
    /// `GroupSetLimit`. Rejection changes nothing.
    pub fn intern(self: *GroupSets, names: []const []const u8) Error!u32 {
        if (names.len == 0) return Error.InvalidIndex;
        if (names.len > group_set_name_count_max) return Error.GroupSetLimit;
        var byte_count: usize = 0;
        for (names) |value| {
            if (value.len == 0) return Error.InvalidIndex;
            if (value.len > group_set_name_byte_count_max) return Error.GroupSetLimit;
            if (!std.unicode.utf8ValidateSlice(value)) return Error.InvalidIndex;
            byte_count += value.len;
        }
        if (self.find(names)) |id| return id;
        if (self.count() >= group_set_count_max) return Error.GroupSetLimit;
        if (self.name_bytes.items.len + byte_count > group_set_pool_byte_count_max) return Error.GroupSetLimit;

        try self.name_bytes.ensureUnusedCapacity(self.allocator, byte_count);
        try self.name_end_bytes.ensureUnusedCapacity(self.allocator, names.len);
        try self.set_name_ends.ensureUnusedCapacity(self.allocator, 1);
        for (names) |value| {
            self.name_bytes.appendSliceAssumeCapacity(value);
            self.name_end_bytes.appendAssumeCapacity(@intCast(self.name_bytes.items.len));
        }
        self.set_name_ends.appendAssumeCapacity(@intCast(self.name_end_bytes.items.len));
        std.debug.assert(self.count() <= group_set_count_max);
        std.debug.assert(self.name_bytes.items.len <= group_set_pool_byte_count_max);
        return self.count();
    }

    /// Interning is rare (producers cache ids) and the table is bounded, so a scan suffices.
    fn find(self: *const GroupSets, names: []const []const u8) ?u32 {
        var id: u32 = 1;
        while (id <= self.count()) : (id += 1) {
            if (self.nameCount(id) != names.len) continue;
            for (names, 0..) |value, index| {
                if (!std.mem.eql(u8, value, self.name(id, @intCast(index)))) break;
            } else return id;
        }
        return null;
    }
};

/// Later names win per field: fg and bg when set, and each attribute bit the definition supplies.
/// A missing name falls back to its first dotted component, as Core's `SyntaxStyle.getStyle` does.
/// `markup.strikethrough` strikes through unless its definition says otherwise, as in Core and Rust.
/// The result supplies the bits any name supplied; one that supplies no field paints as no run.
pub fn compose(style: *const ss.SyntaxStyle, sets: *const GroupSets, id: u32) ss.StyleDefinition {
    var result: ss.StyleDefinition = .{ .fg = null, .bg = null, .attributes = 0, .supplied_attributes = 0 };
    var index: u32 = 0;
    while (index < sets.nameCount(id)) : (index += 1) {
        const value = sets.name(id, index);
        const none: ss.StyleDefinition = .{ .fg = null, .bg = null, .attributes = 0, .supplied_attributes = 0 };
        var definition = style.getStyleByName(value) orelse fallback: {
            const dot = std.mem.indexOfScalar(u8, value, '.') orelse break :fallback none;
            break :fallback style.getStyleByName(value[0..dot]) orelse none;
        };
        if (std.mem.eql(u8, value, "markup.strikethrough") and definition.supplied_attributes & strike == 0) {
            definition.attributes |= strike;
            definition.supplied_attributes |= strike;
        }
        if (definition.fg) |fg| result.fg = fg;
        if (definition.bg) |bg| result.bg = bg;
        result.attributes = (result.attributes & ~@as(u32, definition.supplied_attributes)) | definition.attributes;
        result.supplied_attributes |= definition.supplied_attributes;
    }
    return result;
}

/// Whether a composition supplies no field, so its run lets what lies under it show.
pub fn suppliesNothing(definition: ss.StyleDefinition) bool {
    return definition.fg == null and definition.bg == null and definition.supplied_attributes == 0;
}

pub const LayerRun = extern struct {
    start_byte: u32,
    end_byte: u32,
    group_set: u32,
    /// 0, or a `LinkPool` id that this run holds one reference to.
    link_id: u32 = 0,

    comptime {
        std.debug.assert(@sizeOf(LayerRun) == 16);
    }
};

/// What a set puts where the old runs meeting its range were: the outside part of a run crossing
/// its start, the new runs, then the outside part of a run crossing its end.
const Middle = struct {
    head: ?LayerRun,
    runs: []const LayerRun,
    tail: ?LayerRun,

    fn len(self: Middle) usize {
        return @intFromBool(self.head != null) + self.runs.len + @intFromBool(self.tail != null);
    }

    fn get(self: Middle, index: usize) LayerRun {
        if (self.head) |run| if (index == 0) return run;
        const at = index - @intFromBool(self.head != null);
        return if (at < self.runs.len) self.runs[at] else self.tail.?;
    }
};

fn withBytes(run: LayerRun, start_byte: u32, end_byte: u32) LayerRun {
    return .{ .start_byte = start_byte, .end_byte = end_byte, .group_set = run.group_set, .link_id = run.link_id };
}

pub const Layer = struct {
    layer_id: u32,
    runs: std.ArrayListUnmanaged(LayerRun) = .empty,
};

/// A buffer's layers, sorted by `layer_id`, none empty.
pub const Layers = struct {
    items: [layer_count_max]Layer = undefined,
    count: u8 = 0,

    pub fn slice(self: *const Layers) []const Layer {
        return self.items[0..self.count];
    }

    pub fn isEmpty(self: *const Layers) bool {
        return self.count == 0;
    }

    /// Replaces layer `layer_id` inside `[start_byte, end_byte)` with `runs`: absolute, sorted,
    /// disjoint, nonempty and inside the range. Runs that cross the range edges keep their outside
    /// parts. One transaction: rejection changes nothing. Returns whether any run changed: a set
    /// equal to what the layer holds changes nothing.
    pub fn set(
        self: *Layers,
        allocator: Allocator,
        link_pool: *link.LinkPool,
        layer_id: u32,
        start_byte: u32,
        end_byte: u32,
        runs: []const LayerRun,
    ) Error!bool {
        return self.setWithSpare(allocator, link_pool, layer_id, start_byte, end_byte, runs, null);
    }

    /// Runs of layer `layer_id` now (none when it has none).
    pub fn runsOf(self: *const Layers, layer_id: u32) []const LayerRun {
        const found = self.position(layer_id);
        return if (found.exists) self.items[found.index].runs.items else &.{};
    }

    /// `set`, taking the new runs' storage from `spare` when it has room (then `spare` is the
    /// layer's and empty after), so a caller that reserved it beforehand cannot see this fail
    /// for memory.
    pub fn setWithSpare(
        self: *Layers,
        allocator: Allocator,
        link_pool: *link.LinkPool,
        layer_id: u32,
        start_byte: u32,
        end_byte: u32,
        runs: []const LayerRun,
        spare: ?*std.ArrayListUnmanaged(LayerRun),
    ) Error!bool {
        if (start_byte > end_byte) return Error.InvalidIndex;
        var previous_end = start_byte;
        for (runs) |run| {
            if (run.start_byte < previous_end or run.start_byte >= run.end_byte or run.end_byte > end_byte) return Error.InvalidIndex;
            previous_end = run.end_byte;
        }
        // An empty range holds no runs; splitting a run at it would only add a seam.
        if (start_byte == end_byte) return false;

        const found = self.position(layer_id);
        var old: []const LayerRun = if (found.exists) self.items[found.index].runs.items else &.{};
        // Old runs that cross the range keep their outside parts; one crossing both edges splits.
        const first = firstEndingAfter(old, start_byte);
        var last = first;
        while (last < old.len and old[last].start_byte < end_byte) last += 1;
        const keep_head = first < old.len and old[first].start_byte < start_byte;
        const keep_tail = last > first and old[last - 1].end_byte > end_byte;
        const split = keep_head and keep_tail and last - first == 1;
        const middle: Middle = .{
            .head = if (keep_head) withBytes(old[first], old[first].start_byte, start_byte) else null,
            .runs = runs,
            .tail = if (keep_tail) withBytes(old[last - 1], end_byte, old[last - 1].end_byte) else null,
        };

        // Runs that old and new share at either end of the range stay; equal runs change nothing.
        const shared = @min(last - first, middle.len());
        var same_head: usize = 0;
        while (same_head < shared and std.meta.eql(old[first + same_head], middle.get(same_head))) same_head += 1;
        var same_tail: usize = 0;
        while (same_head + same_tail < shared and std.meta.eql(old[last - 1 - same_tail], middle.get(middle.len() - 1 - same_tail))) same_tail += 1;
        const removed = last - first - same_head - same_tail;
        const added = middle.len() - same_head - same_tail;
        if (removed == 0 and added == 0) return false;
        const result_len = old.len - removed + added;
        if (result_len > 0 and !found.exists and self.count >= layer_count_max) return Error.LayerLimit;

        // A plain set of a layer splices it in place; its storage only grows (amortized). Runs
        // read from the layer itself are rebuilt instead, since the splice would move them.
        const aliased = @intFromPtr(runs.ptr) < @intFromPtr(old.ptr + old.len) and @intFromPtr(old.ptr) < @intFromPtr(runs.ptr + runs.len);
        const in_place = spare == null and found.exists and !aliased;

        // Take the new references, then storage, so a rejection changes nothing and a failure
        // releases only what it took.
        var acquired: usize = 0;
        errdefer for (runs[0..acquired]) |run| if (run.link_id != 0) link_pool.decref(run.link_id) catch unreachable;
        for (runs) |run| {
            if (run.link_id != 0) link_pool.incref(run.link_id) catch return Error.InvalidId;
            acquired += 1;
        }
        const split_link = if (split) old[first].link_id else 0;
        if (split_link != 0) link_pool.incref(split_link) catch return Error.InvalidId;
        errdefer if (split_link != 0) link_pool.decref(split_link) catch unreachable;

        var next: std.ArrayListUnmanaged(LayerRun) = .empty;
        errdefer next.deinit(allocator);
        if (in_place) {
            const list = &self.items[found.index].runs;
            if (list.capacity < result_len) text_work.add(.layer_runs_copied, old.len);
            try list.ensureTotalCapacity(allocator, result_len);
            old = list.items;
        } else {
            if (spare) |list| if (list.capacity >= result_len) {
                next = list.*;
                next.clearRetainingCapacity();
                list.* = .empty;
            };
            try next.ensureTotalCapacity(allocator, result_len);
        }

        // Runs wholly inside the range give their references back.
        for (old[first..last], first..) |run, index| {
            const kept = (index == first and keep_head) or (index == last - 1 and keep_tail);
            if (!kept and run.link_id != 0) link_pool.decref(run.link_id) catch unreachable;
        }

        if (in_place) {
            const list = &self.items[found.index].runs;
            const at = first + same_head;
            if (added != removed) {
                const after = old.len - at - removed;
                list.items.len = @max(old.len, result_len);
                @memmove(list.items[at + added ..][0..after], list.items[at + removed ..][0..after]);
                list.items.len = result_len;
                text_work.add(.layer_runs_copied, after);
            }
            for (list.items[at..][0..added], same_head..) |*slot, index| slot.* = middle.get(index);
            text_work.add(.layer_runs_copied, added);
            assertRuns(list.items);
            if (result_len == 0) self.remove(allocator, found.index);
            return true;
        }

        next.appendSliceAssumeCapacity(old[0..first]);
        for (0..middle.len()) |index| next.appendAssumeCapacity(middle.get(index));
        next.appendSliceAssumeCapacity(old[last..]);
        std.debug.assert(next.items.len == result_len);
        assertRuns(next.items);
        text_work.add(.layer_runs_copied, result_len);

        if (found.exists) {
            // The old storage goes back in an empty spare (the caller frees it or sets with it).
            var old_runs = self.items[found.index].runs;
            if (spare != null and spare.?.capacity == 0) {
                old_runs.clearRetainingCapacity();
                spare.?.* = old_runs;
            } else old_runs.deinit(allocator);
            self.items[found.index].runs = next;
            if (result_len == 0) self.remove(allocator, found.index);
        } else {
            std.mem.copyBackwards(Layer, self.items[found.index + 1 .. self.count + 1], self.items[found.index..self.count]);
            self.items[found.index] = .{ .layer_id = layer_id, .runs = next };
            self.count += 1;
        }
        std.debug.assert(self.count <= layer_count_max);
        return true;
    }

    /// Bytes inserted at `at_byte`: runs at or after it shift, a run strictly containing it grows,
    /// a run ending at it does not.
    pub fn insertBytes(self: *Layers, at_byte: u32, byte_count: u32) void {
        std.debug.assert(byte_count > 0);
        for (self.items[0..self.count]) |*layer| {
            for (layer.runs.items) |*run| {
                if (run.start_byte >= at_byte) {
                    run.start_byte += byte_count;
                    run.end_byte += byte_count;
                } else if (run.end_byte > at_byte) {
                    run.end_byte += byte_count;
                }
            }
        }
    }

    /// Bytes `[start_byte, end_byte)` deleted: runs clip, empty runs go with their references,
    /// and so do empty layers.
    pub fn deleteBytes(self: *Layers, allocator: Allocator, link_pool: *link.LinkPool, start_byte: u32, end_byte: u32) void {
        std.debug.assert(start_byte <= end_byte);
        if (start_byte == end_byte) return;
        const byte_count = end_byte - start_byte;
        var index: usize = self.count;
        while (index > 0) {
            index -= 1;
            const runs = &self.items[index].runs;
            var kept: usize = 0;
            for (runs.items) |run| {
                const clipped_start = clip(run.start_byte, start_byte, end_byte, byte_count);
                const clipped_end = clip(run.end_byte, start_byte, end_byte, byte_count);
                if (clipped_start >= clipped_end) {
                    if (run.link_id != 0) link_pool.decref(run.link_id) catch unreachable;
                    continue;
                }
                runs.items[kept] = .{ .start_byte = clipped_start, .end_byte = clipped_end, .group_set = run.group_set, .link_id = run.link_id };
                kept += 1;
            }
            runs.items.len = kept;
            assertRuns(runs.items);
            if (kept == 0) self.remove(allocator, index);
        }
    }

    /// Empties every layer, giving back every run's reference.
    pub fn reset(self: *Layers, allocator: Allocator, link_pool: *link.LinkPool) void {
        for (self.items[0..self.count]) |*layer| {
            for (layer.runs.items) |run| if (run.link_id != 0) link_pool.decref(run.link_id) catch unreachable;
            layer.runs.deinit(allocator);
        }
        self.count = 0;
    }

    /// Index of the first run of `runs` that ends after `byte`.
    pub fn firstEndingAfter(runs: []const LayerRun, byte: u32) usize {
        var low: usize = 0;
        var high: usize = runs.len;
        while (low < high) {
            const middle = low + (high - low) / 2;
            if (runs[middle].end_byte <= byte) low = middle + 1 else high = middle;
        }
        return low;
    }

    fn position(self: *const Layers, layer_id: u32) struct { index: usize, exists: bool } {
        for (self.items[0..self.count], 0..) |layer, index| {
            if (layer.layer_id == layer_id) return .{ .index = index, .exists = true };
            if (layer.layer_id > layer_id) return .{ .index = index, .exists = false };
        }
        return .{ .index = self.count, .exists = false };
    }

    fn remove(self: *Layers, allocator: Allocator, index: usize) void {
        std.debug.assert(self.items[index].runs.items.len == 0);
        self.items[index].runs.deinit(allocator);
        std.mem.copyForwards(Layer, self.items[index .. self.count - 1], self.items[index + 1 .. self.count]);
        self.count -= 1;
    }

    /// Sorted, disjoint and nonempty: what every layer holds between calls.
    fn assertRuns(runs: []const LayerRun) void {
        for (runs, 0..) |run, index| {
            std.debug.assert(run.start_byte < run.end_byte);
            std.debug.assert(index == 0 or runs[index - 1].end_byte <= run.start_byte);
        }
    }

    fn clip(byte: u32, start_byte: u32, end_byte: u32, byte_count: u32) u32 {
        if (byte <= start_byte) return byte;
        if (byte >= end_byte) return byte - byte_count;
        return start_byte;
    }
};
