//! The marks of an edit buffer: ranges of its text, in bytes of the text as `getPlainText` returns
//! it, that move with edits. A set is an immutable version that the rope pairs with each root
//! (`Rope.aux`), so undo and redo restore the marks of the text they restore. A change builds a
//! new version in the rope's arena, which outlives every history node that can hold it.
const std = @import("std");
const Allocator = std.mem.Allocator;

/// At most this many marks per buffer (`OT_OBJECT_LIMIT` past it).
pub const count_max = 65536;

pub const Mark = struct {
    /// Never reused within a buffer, so a mark that undo restores keeps its identity.
    id: u32,
    kind: u32,
    /// A SyntaxStyle id, or with `style_value` an index into the buffer's mark style table; a mark
    /// with style 0 and no `style_value` paints nothing.
    style: u32,
    start_byte: u32,
    end_byte: u32,
    /// At most 255 for a styled mark, which paints at it; any value for an unstyled one.
    priority: u32,
    /// The text is one unit: an edit that changes part of it drops the mark.
    atomic: bool,
    style_value: bool,

    pub fn styled(mark: Mark) bool {
        return mark.style != 0 or mark.style_value;
    }

    /// Moves the mark for `end - start` bytes deleted at `start`. Returns whether it survives:
    /// a delete over all of it, or into an atomic one, drops it.
    fn deleted(mark: *Mark, start: u32, end: u32) bool {
        if (start == end or mark.end_byte <= start) return true;
        const count = end - start;
        if (mark.start_byte >= end) {
            mark.start_byte -= count;
            mark.end_byte -= count;
            return true;
        }
        if (mark.atomic or (mark.start_byte >= start and mark.end_byte <= end)) return false;
        mark.end_byte = if (mark.end_byte > end) mark.end_byte - count else start;
        mark.start_byte = @min(mark.start_byte, start);
        return true;
    }

    /// Moves the mark for `count` bytes inserted at `at`: at or before its start shifts it, at its
    /// end leaves it, strictly inside grows it or drops an atomic one. Returns whether it survives.
    fn inserted(mark: *Mark, at: u32, count: u32) bool {
        if (count == 0 or mark.end_byte <= at) return true;
        if (mark.start_byte >= at) {
            mark.start_byte += count;
            mark.end_byte += count;
            return true;
        }
        if (mark.atomic) return false;
        mark.end_byte += count;
        return true;
    }
};

/// `marks` is the set; `buffer` holds it with room to grow when no history holds the version.
const Version = struct { marks: []Mark, buffer: []Mark };

/// The marks of a rope's `aux`: 0 is the empty set.
pub fn live(aux: usize) []const Mark {
    if (aux == 0) return &.{};
    const version: *const Version = @ptrFromInt(aux);
    return version.marks;
}

/// The `aux` of `marks`, which `allocator` owns from now on.
fn publish(allocator: Allocator, marks: []Mark) Allocator.Error!usize {
    if (marks.len == 0) return 0;
    std.mem.sort(Mark, marks, {}, lessThan);
    const version = try allocator.create(Version);
    version.* = .{ .marks = marks, .buffer = marks };
    return @intFromPtr(version);
}

fn lessThan(_: void, a: Mark, b: Mark) bool {
    if (a.start_byte != b.start_byte) return a.start_byte < b.start_byte;
    return a.id < b.id;
}

/// The marks after `deleted` bytes at `start` go and `inserted` bytes take their place, in that
/// order, or null when no mark changes and the version is shared.
pub fn splice(allocator: Allocator, aux: usize, start: u32, deleted: u32, inserted: u32) Allocator.Error!?usize {
    const marks = live(aux);
    for (marks) |mark| {
        if (mark.end_byte > start) break;
    } else return null;
    const next = try allocator.alloc(Mark, marks.len);
    var count: usize = 0;
    for (marks) |mark| {
        next[count] = mark;
        if (next[count].deleted(start, start + deleted) and next[count].inserted(start, inserted)) count += 1;
    }
    return try publish(allocator, next[0..count]);
}

/// A version that a mark operation may change: `aux` itself when `owned` (no history holds it),
/// else a copy. Either has room for one more mark, doubling, so N operations cost O(N) bytes.
fn writable(allocator: Allocator, aux: usize, owned: bool) Allocator.Error!*Version {
    const marks = live(aux);
    if (owned and aux != 0) {
        const version: *Version = @ptrFromInt(aux);
        if (marks.len < version.buffer.len) return version;
        const buffer = try allocator.alloc(Mark, 2 * version.buffer.len);
        @memcpy(buffer[0..marks.len], marks);
        version.* = .{ .marks = buffer[0..marks.len], .buffer = buffer };
        return version;
    }
    const version = try allocator.create(Version);
    const buffer = try allocator.alloc(Mark, @max(4, 2 * marks.len));
    @memcpy(buffer[0..marks.len], marks);
    version.* = .{ .marks = buffer[0..marks.len], .buffer = buffer };
    return version;
}

/// The set with `mark` added, in place when `owned`.
pub fn add(allocator: Allocator, aux: usize, owned: bool, mark: Mark) Allocator.Error!usize {
    std.debug.assert(live(aux).len < count_max);
    const version = try writable(allocator, aux, owned);
    const index = std.sort.upperBound(Mark, version.marks, mark, struct {
        fn order(context: Mark, item: Mark) std.math.Order {
            return if (lessThan({}, context, item)) .lt else .gt;
        }
    }.order);
    version.marks = version.buffer[0 .. version.marks.len + 1];
    std.mem.copyBackwards(Mark, version.marks[index + 1 ..], version.marks[index .. version.marks.len - 1]);
    version.marks[index] = mark;
    return @intFromPtr(version);
}

/// The set without mark `id`, in place when `owned`, or null when it has no such mark.
pub fn remove(allocator: Allocator, aux: usize, owned: bool, id: u32) Allocator.Error!?usize {
    const index = for (live(aux), 0..) |mark, index| {
        if (mark.id == id) break index;
    } else return null;
    const version = try writable(allocator, aux, owned);
    std.mem.copyForwards(Mark, version.marks[index..], version.marks[index + 1 ..]);
    version.marks.len -= 1;
    return @intFromPtr(version);
}

/// The empty set: `aux` emptied in place when `owned`, so adding marks again reuses its room.
pub fn clear(aux: usize, owned: bool) usize {
    if (!owned or aux == 0) return 0;
    const version: *Version = @ptrFromInt(aux);
    version.marks.len = 0;
    return aux;
}

/// Every mark lies in `[0, byte_count]` with ordered edges, sorted by start then id, and each id
/// once. Edges on code point boundaries are checked by the buffer, which can read its text.
pub fn assertValid(aux: usize, byte_count: u32) void {
    if (!std.debug.runtime_safety) return;
    const marks = live(aux);
    for (marks, 0..) |mark, index| {
        std.debug.assert(mark.start_byte <= mark.end_byte and mark.end_byte <= byte_count);
        if (index > 0) std.debug.assert(lessThan({}, marks[index - 1], mark));
    }
}
