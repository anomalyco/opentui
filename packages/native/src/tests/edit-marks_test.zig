//! Edit marks against a reference model (tracks/c5-native-marks.md, invariants 1-4). The model
//! keeps the text as byte cells, each with the set of marks that cover it: an insert strictly
//! inside a mark's cells is covered by it (or drops it when atomic), a delete removes cells and
//! drops a mark left without cells or an atomic mark it touched. Its history copies whole states
//! and reuses nodes exactly as `rope.zig` does, so undo and redo must restore the paired marks.
//! Cursor moves under the atomic rules must end on a stop that no atomic mark surrounds
//! (invariant 7), and the atomic deletes must delete what the model's rule picks.
const std = @import("std");
const model = @import("model.zig");
const TestPools = @import("test-pools.zig").TestPools;
const edit_buffer = @import("../edit-buffer.zig");
const iter = @import("../text-buffer-iterators.zig");
const work = @import("../text-work.zig");
const ss = @import("../syntax-style.zig");
const c = @import("context_abi_c");
const abi = @import("../context-abi.zig");
const editor_abi = @import("../context-editor-abi.zig");
const context_mod = @import("../context.zig");

const EditBuffer = edit_buffer.EditBuffer;
const Mark = @import("../edit-marks.zig").Mark;

/// Strings that edits insert; none joins a grapheme with its neighbours, so mark edges stay on
/// cursor stops and offsets convert exactly.
const strings = [_][]const u8{ "a", "ab", "\u{65e5}", "\n", "a\nb", "\u{65e5}a" };
/// The differential's pieces add ones that join a grapheme with the text before them (a ZWJ
/// sequence, a flag), which can leave a mark's start inside a grapheme.
const pieces = strings ++ [_][]const u8{ "\u{1f468}", "\u{200d}\u{1f469}", "\u{1f1fa}", "\u{1f1f8}" };

const Op = union(enum) {
    insert: struct { at: u32, text: u8 },
    delete: struct { at: u32, len: u32 },
    replace: struct { at: u32, len: u32, text: u8 },
    undo,
    redo,
    set_text: u8,
    replace_text: u8,
    clear,
    add: struct { at: u32, len: u32, atomic: bool },
    remove: u32,
    clear_marks,
    /// Raw, so the cursor can start inside an atomic mark.
    cursor: u32,
    /// The cursor rules (C5.3, invariant 7); `keep` and `set` take the edge or the offset.
    move: union(enum) { left, right, up, down, set: u32, keep: EditBuffer.Toward },
    delete_atomic: bool,
};

const Cell = struct { byte: u8, cover: u64 };
const ModelMark = struct { id: u32, atomic: bool };

const State = struct {
    cells: []const Cell = &.{},
    /// Live marks by slot (bit index in `Cell.cover`); a dropped mark's slot is null.
    marks: []const ?ModelMark = &.{},
};

const Node = struct { state: State, root: u32 };

const Model = struct {
    arena: std.mem.Allocator,
    live: State = .{},
    root: u32 = 0,
    roots: u32 = 0,
    undo: std.ArrayListUnmanaged(*Node) = .empty,
    redo: std.ArrayListUnmanaged(*Node) = .empty,
    current: ?*Node = null,
    next_id: u32 = 1,

    fn publish(self: *Model, state: State) void {
        self.live = state;
        self.roots += 1;
        self.root = self.roots;
    }

    fn storeUndo(self: *Model) !void {
        const node = try self.arena.create(Node);
        node.* = .{ .state = self.live, .root = self.root };
        try self.undo.append(self.arena, node);
        self.current = null;
        self.redo.clearRetainingCapacity();
    }

    fn canUndo(self: *const Model) bool {
        return self.undo.items.len > 0;
    }

    fn canRedo(self: *const Model) bool {
        const current = self.current orelse return false;
        return self.redo.items.len > 0 and current.root == self.root;
    }

    fn undoStep(self: *Model) !void {
        const r = self.current orelse r: {
            const node = try self.arena.create(Node);
            node.* = .{ .state = self.live, .root = self.root };
            break :r node;
        };
        if (r.root == self.root) r.state = self.live;
        const h = self.undo.pop().?;
        self.current = h;
        self.live = h.state;
        self.root = h.root;
        try self.redo.append(self.arena, r);
    }

    fn redoStep(self: *Model) !void {
        const u = self.current.?;
        u.state = self.live;
        const h = self.redo.pop().?;
        self.current = h;
        self.live = h.state;
        self.root = h.root;
        try self.undo.append(self.arena, u);
    }

    fn insertCells(self: *Model, at: usize, bytes: []const u8) !State {
        const old = self.live.cells;
        const marks = try self.arena.dupe(?ModelMark, self.live.marks);
        const before: u64 = if (at > 0) old[at - 1].cover else 0;
        const after: u64 = if (at < old.len) old[at].cover else 0;
        var inside = before & after;
        for (marks, 0..) |*slot, index| {
            const bit = @as(u64, 1) << @intCast(index);
            if (slot.* != null and slot.*.?.atomic and inside & bit != 0) {
                slot.* = null;
                inside &= ~bit;
            }
        }
        const cells = try self.arena.alloc(Cell, old.len + bytes.len);
        @memcpy(cells[0..at], old[0..at]);
        for (bytes, 0..) |byte, index| cells[at + index] = .{ .byte = byte, .cover = inside };
        @memcpy(cells[at + bytes.len ..], old[at..]);
        return dropped(.{ .cells = cells, .marks = marks });
    }

    fn deleteCells(self: *Model, start: usize, end: usize) !State {
        const old = self.live.cells;
        const marks = try self.arena.dupe(?ModelMark, self.live.marks);
        var touched: u64 = 0;
        for (old[start..end]) |cell| touched |= cell.cover;
        for (marks, 0..) |*slot, index| {
            if (slot.* != null and slot.*.?.atomic and touched & (@as(u64, 1) << @intCast(index)) != 0) slot.* = null;
        }
        const cells = try self.arena.alloc(Cell, old.len - (end - start));
        @memcpy(cells[0..start], old[0..start]);
        @memcpy(cells[start..], old[end..]);
        return dropped(.{ .cells = cells, .marks = marks });
    }

    /// Clears the bits of dropped marks and drops marks left without cells.
    fn dropped(state: State) State {
        const marks = @constCast(state.marks);
        var live: u64 = 0;
        for (marks, 0..) |slot, index| {
            if (slot != null) live |= @as(u64, 1) << @intCast(index);
        }
        var covered: u64 = 0;
        for (@constCast(state.cells)) |*cell| {
            cell.cover &= live;
            covered |= cell.cover;
        }
        for (marks, 0..) |*slot, index| {
            if (covered & (@as(u64, 1) << @intCast(index)) == 0) slot.* = null;
        }
        return state;
    }

    fn text(self: *const Model, out: []u8) []const u8 {
        for (self.live.cells, 0..) |cell, index| out[index] = cell.byte;
        return out[0..self.live.cells.len];
    }

    /// Code point boundaries as (byte, cursor offset), the text's end included.
    fn stops(self: *const Model, arena: std.mem.Allocator) ![]const [2]u32 {
        var list: std.ArrayListUnmanaged([2]u32) = .empty;
        var offset: u32 = 0;
        for (self.live.cells, 0..) |cell, index| {
            if (cell.byte & 0xC0 == 0x80) continue;
            try list.append(arena, .{ @intCast(index), offset });
            offset += if (cell.byte < 0x80) 1 else 2;
        }
        try list.append(arena, .{ @intCast(self.live.cells.len), offset });
        return list.items;
    }

    fn offsetAt(stop_list: []const [2]u32, byte: u32) u32 {
        for (stop_list) |stop| if (stop[0] == byte) return stop[1];
        unreachable;
    }
};

const Harness = struct {
    pools: *TestPools,

    pub const Command = Op;

    pub fn generate(_: *Harness, arena: std.mem.Allocator, random: std.Random, steps: usize) ![]Op {
        const commands = try arena.alloc(Op, steps);
        for (commands) |*command| {
            const text = random.uintLessThan(u8, strings.len);
            const at = random.int(u32);
            const len = random.uintLessThan(u32, 6);
            command.* = switch (random.uintLessThan(u8, 26)) {
                20, 21 => .{ .cursor = at },
                22...24 => .{ .move = switch (random.uintLessThan(u8, 6)) {
                    0 => .left,
                    1 => .right,
                    2 => .up,
                    3 => .down,
                    4 => .{ .set = at },
                    else => .{ .keep = random.enumValue(EditBuffer.Toward) },
                } },
                25 => .{ .delete_atomic = random.boolean() },
                0...3 => .{ .insert = .{ .at = at, .text = text } },
                4...6 => .{ .delete = .{ .at = at, .len = len } },
                7 => .{ .replace = .{ .at = at, .len = len, .text = text } },
                8...9 => .undo,
                10...11 => .redo,
                12 => .{ .set_text = text },
                13 => .{ .replace_text = text },
                14 => .clear,
                15...17 => .{ .add = .{ .at = at, .len = len + 1, .atomic = random.boolean() } },
                18 => .{ .remove = random.uintLessThan(u32, 16) },
                else => .clear_marks,
            };
        }
        return commands;
    }

    pub fn simplify(_: *Harness, arena: std.mem.Allocator, command: Op) ![]const Op {
        return switch (command) {
            .insert => |value| if (value.at != 0) try arena.dupe(Op, &.{.{ .insert = .{ .at = 0, .text = value.text } }}) else &.{},
            .add => |value| if (value.atomic) try arena.dupe(Op, &.{.{ .add = .{ .at = value.at, .len = value.len, .atomic = false } }}) else &.{},
            else => &.{},
        };
    }

    pub fn format(_: *Harness, command: Op, writer: *std.Io.Writer) void {
        writer.print("{any}", .{command}) catch {};
    }

    pub fn run(self: *Harness, arena: std.mem.Allocator, commands: []const Op) !?model.Failure {
        const eb = try EditBuffer.init(std.testing.allocator, &self.pools.graphemes, &self.pools.links, .unicode, null);
        defer eb.deinit();
        var m: Model = .{ .arena = arena };
        for (commands, 0..) |command, step| {
            const plain = eb.tb.marks().len == 0;
            _ = work.take();
            if (try apply(eb, &m, arena, command)) |property| return .{ .property = property, .step = step };
            if (plain and work.take().mark_preparations != 0) return .{ .property = "empty mark work", .step = step };
            if (try check(eb, &m, arena)) |property| return .{ .property = property, .step = step };
        }
        return null;
    }

    fn apply(eb: *EditBuffer, m: *Model, arena: std.mem.Allocator, command: Op) !?[]const u8 {
        const stops = try m.stops(arena);
        const range = struct {
            fn of(list: []const [2]u32, at: u32, len: u32) [2][2]u32 {
                const first = @as(usize, at) % list.len;
                return .{ list[first], list[@min(first + len, list.len - 1)] };
            }
        }.of;
        switch (command) {
            .insert => |value| {
                const at = range(stops, value.at, 0)[0];
                try eb.setCursorByOffset(at[1]);
                try eb.insertText(strings[value.text]);
                try m.storeUndo();
                m.publish(try m.insertCells(at[0], strings[value.text]));
            },
            .delete => |value| {
                const ends = range(stops, value.at, value.len);
                if (ends[0][0] == ends[1][0]) return null;
                const start = iter.offsetToCoords(eb.tb.rope(), ends[0][1]).?;
                const end = iter.offsetToCoords(eb.tb.rope(), ends[1][1]).?;
                try eb.deleteRange(.{ .row = start.row, .col = start.col }, .{ .row = end.row, .col = end.col });
                try m.storeUndo();
                m.publish(try m.deleteCells(ends[0][0], ends[1][0]));
            },
            .replace => |value| {
                const ends = range(stops, value.at, value.len);
                try eb.setCursorByOffset(ends[0][1]);
                const noop = struct {
                    fn handle(_: *anyopaque) void {}
                };
                try eb.replaceRange(ends[0][1], ends[1][1], strings[value.text], .{ .ctx = eb, .handle = noop.handle });
                if (ends[0][0] != ends[1][0]) {
                    try m.storeUndo();
                    m.publish(try m.deleteCells(ends[0][0], ends[1][0]));
                }
                try m.storeUndo();
                m.publish(try m.insertCells(ends[0][0], strings[value.text]));
            },
            .undo, .redo => {
                const redo = command == .redo;
                const can = if (redo) m.canRedo() else m.canUndo();
                if (can != (if (redo) eb.canRedo() else eb.canUndo())) return "history";
                if (!can) return null;
                if (redo) {
                    _ = try eb.redo();
                    try m.redoStep();
                } else {
                    _ = try eb.undo();
                    try m.undoStep();
                }
            },
            .set_text, .replace_text => |index| {
                const bytes = strings[index];
                if (command == .set_text) try eb.setText(bytes) else try eb.replaceText(bytes);
                if (command == .set_text) {
                    m.undo.clearRetainingCapacity();
                    m.redo.clearRetainingCapacity();
                    m.current = null;
                } else try m.storeUndo();
                const cells = try arena.alloc(Cell, bytes.len);
                for (bytes, cells) |byte, *cell| cell.* = .{ .byte = byte, .cover = 0 };
                m.publish(.{ .cells = cells });
            },
            .clear => {
                try eb.clear();
                m.publish(.{});
            },
            .add => |value| {
                const ends = range(stops, value.at, value.len);
                if (ends[0][0] == ends[1][0] or m.live.marks.len == 64) return null;
                const id = try eb.addMark(.{ .start = ends[0][1], .end = ends[1][1], .atomic = value.atomic });
                if (id != m.next_id) return "ids";
                m.next_id += 1;
                const marks = try std.mem.concat(arena, ?ModelMark, &.{ m.live.marks, &.{ModelMark{ .id = id, .atomic = value.atomic }} });
                const cells = try arena.dupe(Cell, m.live.cells);
                for (cells[ends[0][0]..ends[1][0]]) |*cell| cell.cover |= @as(u64, 1) << @intCast(marks.len - 1);
                m.live = .{ .cells = cells, .marks = marks };
            },
            .remove => |id| {
                const marks = try arena.dupe(?ModelMark, m.live.marks);
                var found = false;
                for (marks) |*slot| if (slot.* != null and slot.*.?.id == id) {
                    slot.* = null;
                    found = true;
                };
                if (found != try eb.removeMark(id)) return "remove";
                m.live = Model.dropped(.{ .cells = try arena.dupe(Cell, m.live.cells), .marks = marks });
            },
            .clear_marks => {
                eb.clearMarks();
                const marks = try arena.alloc(?ModelMark, m.live.marks.len);
                @memset(marks, null);
                m.live = Model.dropped(.{ .cells = try arena.dupe(Cell, m.live.cells), .marks = marks });
            },
            // An odd `at` is any cell offset, a stop or not, as the raw setter allows.
            .cursor => |at| try eb.setCursorByOffset(if (at & 1 == 1) (at >> 1) % (stops[stops.len - 1][1] + 1) else range(stops, at, 0)[0][1]),
            .move => |move| {
                const before = eb.getPrimaryCursor().offset;
                const surrounded = surrounds(eb, before);
                const on_stop = for (stops) |stop| {
                    if (stop[1] == before) break true;
                } else false;
                switch (move) {
                    .left, .right => try eb.moveAtomic(move == .right),
                    .up, .down => {
                        if (move == .up) eb.moveUp() else eb.moveDown();
                        try eb.leaveAtomic(before, move == .down);
                    },
                    .set => |at| try eb.setCursorByOffsetAtomic(range(stops, at, 0)[0][1]),
                    .keep => |toward| try eb.keepOutside(toward),
                }
                const after = eb.getPrimaryCursor().offset;
                for (stops) |stop| {
                    if (stop[1] == after) break;
                } else return "stop";
                if (surrounds(eb, after)) return "inside";
                if (on_stop and (((move == .left or move == .up) and after > before) or ((move == .right or move == .down) and after < before))) return "direction";
                if (move == .keep and on_stop and !surrounded and after != before) return "keep";
            },
            .delete_atomic => |forward| {
                // Of the atomic marks on the cell before the cursor (Backspace) or at it (Delete), the oldest
                // that ends (starts) at the cursor goes whole; with none, one code point.
                const cursor = eb.getPrimaryCursor().offset;
                const b = for (stops) |stop| {
                    if (stop[1] == cursor) break stop[0];
                } else return null;
                const cells = m.live.cells;
                if (if (forward) b == cells.len else b == 0) {
                    try eb.deleteAtomic(forward);
                    return null;
                }
                const cell = if (forward) b else b - 1;
                var start = cell;
                while (start > 0 and cells[start].byte & 0xC0 == 0x80) start -= 1;
                var end = cell + 1;
                while (end < cells.len and cells[end].byte & 0xC0 == 0x80) end += 1;
                var oldest: u32 = std.math.maxInt(u32);
                for (m.live.marks, 0..) |slot, index| {
                    const mark = slot orelse continue;
                    const bit = @as(u64, 1) << @intCast(index);
                    if (!mark.atomic or cells[cell].cover & bit == 0 or mark.id > oldest) continue;
                    var first = cell;
                    while (first > 0 and cells[first - 1].cover & bit != 0) first -= 1;
                    var last = cell + 1;
                    while (last < cells.len and cells[last].cover & bit != 0) last += 1;
                    if ((if (forward) first else last) != b) continue;
                    oldest = mark.id;
                    start = first;
                    end = last;
                }
                try eb.deleteAtomic(forward);
                try m.storeUndo();
                m.publish(try m.deleteCells(start, end));
            },
        }
        return null;
    }

    /// Text, marks in (start, id) order with their bytes and cursor offsets, and history.
    fn check(eb: *EditBuffer, m: *const Model, arena: std.mem.Allocator) !?[]const u8 {
        var expected_text: [4096]u8 = undefined;
        var actual_text: [4096]u8 = undefined;
        if (!std.mem.eql(u8, m.text(&expected_text), actual_text[0..eb.getText(&actual_text)])) return "text";
        if (m.canUndo() != eb.canUndo() or m.canRedo() != eb.canRedo()) return "history";
        const Expected = struct { start: u32, id: u32, end: u32, atomic: bool };
        var expected: std.ArrayListUnmanaged(Expected) = .empty;
        for (m.live.marks, 0..) |slot, index| {
            const mark = slot orelse continue;
            const bit = @as(u64, 1) << @intCast(index);
            var first: ?u32 = null;
            var last: u32 = 0;
            for (m.live.cells, 0..) |cell, at| if (cell.cover & bit != 0) {
                if (first == null) first = @intCast(at);
                last = @intCast(at + 1);
            };
            try expected.append(arena, .{ .start = first.?, .id = mark.id, .end = last, .atomic = mark.atomic });
        }
        std.mem.sort(Expected, expected.items, {}, struct {
            fn lessThan(_: void, a: Expected, b: Expected) bool {
                return a.start < b.start or (a.start == b.start and a.id < b.id);
            }
        }.lessThan);
        const actual = eb.tb.marks();
        if (actual.len != expected.items.len) return "marks";
        const stops = try m.stops(arena);
        for (actual, expected.items) |mark, want| {
            if (mark.id != want.id or mark.start_byte != want.start or mark.end_byte != want.end or mark.atomic != want.atomic) return "marks";
            const offsets = eb.markOffsets(mark);
            if (offsets.start != Model.offsetAt(stops, want.start) or offsets.end != Model.offsetAt(stops, want.end)) return "offsets";
        }
        return null;
    }
};

test "edit marks follow edits, undo and redo as the reference model does" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    var harness: Harness = .{ .pools = &pools };
    try model.check(Harness, &harness, .{ .seeds = 256, .steps = 64 });
    // The design's invariant-3 sequence (x, xA, xAB, undo, clear, undo, redo): the redo node that a
    // history-less clear left behind keeps the marks of its own root.
    const trace = [_]Op{
        .{ .insert = .{ .at = 0, .text = 0 } },
        .{ .add = .{ .at = 0, .len = 1, .atomic = false } },
        .{ .insert = .{ .at = 1, .text = 1 } },
        .undo,
        .clear,
        .undo,
        .redo,
    };
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    try std.testing.expectEqual(null, try harness.run(arena.allocator(), &trace));
}

// Mark operations that no history holds edit the live set in place: N adds keep O(N) bytes, and
// adding and clearing the same marks again keeps none more.
test "edit marks: mark operations without history keep linear memory" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    const eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode, null);
    defer eb.deinit();
    try eb.setText("abcdefghij");
    const base = eb.tb.arena.queryCapacity();
    const count = 2000;
    for (0..count) |_| _ = try eb.addMark(.{ .start = 0, .end = 1 });
    // Doubling buffers plus the arena's own growth: 270 KB here, where a copy per add took 48 MB.
    try std.testing.expect(eb.tb.arena.queryCapacity() - base <= 16 * count * @sizeOf(Mark));
    eb.clearMarks();
    const settled = eb.tb.arena.queryCapacity();
    for (0..16) |_| {
        for (0..256) |_| _ = try eb.addMark(.{ .start = 1, .end = 2 });
        eb.clearMarks();
    }
    try std.testing.expectEqual(settled, eb.tb.arena.queryCapacity());
}

// Invariant 6: styled marks paint and report what one legacy range highlight per mark, added in
// id order after the app's own highlights, paints and reports; by id or by value.
test "styled edit marks paint and report as legacy range highlights do" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();
    const style = try ss.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    var style_ids: [3]u32 = undefined;
    for (&style_ids, 0..) |*id, index| id.* = try style.registerStyle(&.{@as(u8, 'a') + @as(u8, @intCast(index))}, .{ @intCast(index * 1000), 0, 0, 0xFFFF }, null, @intCast(index));
    var prng = std.Random.DefaultPrng.init(7);
    const random = prng.random();
    for (0..64) |_| {
        const marked = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode, null);
        defer marked.deinit();
        const legacy = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .unicode, null);
        defer legacy.deinit();
        var text: std.ArrayListUnmanaged(u8) = .empty;
        defer text.deinit(std.testing.allocator);
        for (0..random.uintLessThan(usize, 12) + 1) |_| try text.appendSlice(std.testing.allocator, pieces[random.uintLessThan(usize, pieces.len)]);
        for ([_]*EditBuffer{ marked, legacy }) |eb| {
            try eb.setText(text.items);
            eb.tb.setSyntaxStyle(style);
            // An app highlight under the marks, which both keep.
            try eb.tb.addHighlight(0, 0, 1, style_ids[0], 1, 7);
        }
        const end = marked.tb.textEndOffset();
        for (0..random.uintLessThan(usize, 5)) |_| {
            const a = random.uintAtMost(u32, end);
            const b = random.uintAtMost(u32, end);
            const which = random.uintLessThan(usize, style_ids.len);
            _ = try marked.addMark(.{
                .start = @min(a, b),
                .end = @max(a, b),
                .style = if (random.boolean()) style_ids[which] else 0,
                .style_value = if (random.boolean()) style.resolveById(style_ids[which]).? else null,
                .priority = random.uintLessThan(u8, 3),
            });
        }
        for (0..3) |round| {
            if (round > 0) {
                try marked.setCursorByOffset(random.uintAtMost(u32, marked.tb.textEndOffset()));
                try marked.insertText(pieces[random.uintLessThan(usize, pieces.len)]);
                var bytes: [512]u8 = undefined;
                try legacy.setText(bytes[0..marked.getText(&bytes)]);
                try legacy.tb.addHighlight(0, 0, 1, style_ids[0], 1, 7);
            }
            // The legacy twin: one range highlight per styled mark, in id order.
            const by_id = try std.testing.allocator.dupe(Mark, marked.tb.marks());
            defer std.testing.allocator.free(by_id);
            std.mem.sort(Mark, by_id, {}, struct {
                fn lessThan(_: void, a: Mark, b: Mark) bool {
                    return a.id < b.id;
                }
            }.lessThan);
            for (by_id) |mark| {
                if (!mark.styled()) continue;
                const offsets = marked.markOffsets(mark);
                // A value mark's definition is one of the registered ones; the twin names it.
                const id = if (mark.style_value) for (style_ids) |candidate| {
                    if (std.meta.eql(style.resolveById(candidate).?, marked.tb.mark_styles.keys()[mark.style])) break candidate;
                } else unreachable else mark.style;
                const start_row = iter.offsetToCoords(legacy.tb.rope(), offsets.start).?.row;
                const end_row = iter.offsetToCoords(legacy.tb.rope(), offsets.end).?.row;
                try legacy.tb.addHighlightByCharRange(offsets.start - start_row, offsets.end - end_row, id, @intCast(mark.priority), @truncate(mark.id));
            }
            try expectSameLines(marked, legacy);
            legacy.tb.clearAllHighlights();
        }
    }
}

// The C ABI: malformed records reject and change nothing; marks round-trip in cursor offsets and
// bytes with their style value; queries filter by id and kind; REMOVE and CLEAR report.
test "edit marks through the C ABI reject malformed records and round-trip" {
    var owner: abi.ContextHandle = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = undefined, .owner_thread = std.Thread.getCurrentId() };
    defer owner.io_threaded.deinit();
    owner.core = try context_mod.Context.init(std.testing.allocator, owner.io_threaded.io(), .{});
    defer owner.core.deinit() catch unreachable;
    const id = abi.handleToC(try owner.core.createEditBuffer(.unicode));
    // "ab日c": the wide character is cells 2..4 and bytes 2..5.
    try std.testing.expectEqual(c.OT_OK, abi.ot_edit_buffer_set_text(&owner, &id, "ab\u{65e5}c", 6, 0));
    const value: c.ot_editor_style = .{ .struct_size = @sizeOf(c.ot_editor_style), .abi_version = c.OT_CONTEXT_ABI_VERSION, .flags = c.OT_EDITOR_STYLE_FOREGROUND | c.OT_EDITOR_STYLE_ATTRIBUTES | c.OT_EDITOR_STYLE_ATTRIBUTE_MASK, .attributes = 1 | 1 << 16, .foreground = .{ 1, 2, 3, 4 }, .background = @splat(0) };
    var good = std.mem.zeroes(c.ot_edit_mark);
    good.struct_size = @sizeOf(c.ot_edit_mark);
    good.abi_version = c.OT_CONTEXT_ABI_VERSION;
    good.kind = 3;
    good.flags = c.OT_EDIT_MARK_ATOMIC | c.OT_EDIT_MARK_STYLE_VALUE;
    good.value = value;
    good.priority = 2;
    good.start = 1;
    good.end = 4;
    var out: u32 = 99;
    const Field = enum { size, id, byte, priority, reversed, flags, run_style, style_and_value, value_without_flag };
    for (std.enums.values(Field)) |field| {
        var bad = good;
        switch (field) {
            .size => bad.struct_size -= 4,
            .id => bad.id = 1,
            .byte => bad.end_byte = 5,
            .priority => bad.priority = 256,
            .reversed => bad.start = 5,
            .flags => bad.flags |= 4,
            .run_style => bad.style = c.OT_STYLE_RUN_FLAG,
            .style_and_value => bad.style = 1,
            .value_without_flag => bad.flags = 0,
        }
        try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, editor_abi.ot_edit_buffer_mark(&owner, &id, c.OT_EDIT_MARK_ADD, &bad, &out));
        try std.testing.expectEqual(@as(u32, 99), out);
    }
    for ([_]struct { u32, ?*const c.ot_edit_mark, ?*u32 }{
        .{ c.OT_EDIT_MARK_ADD, null, &out },
        .{ c.OT_EDIT_MARK_ADD, &good, null },
        .{ c.OT_EDIT_MARK_CLEAR, &good, null },
        .{ c.OT_EDIT_MARK_CLEAR + 1, &good, &out },
    }) |row| try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, editor_abi.ot_edit_buffer_mark(&owner, &id, row[0], row[1], row[2]));
    var count: u32 = 99;
    try std.testing.expectEqual(c.OT_OK, editor_abi.ot_edit_buffer_get_marks(&owner, &id, 0, c.OT_EDIT_MARK_ANY_KIND, null, 0, &count));
    try std.testing.expectEqual(@as(u32, 0), count);

    try std.testing.expectEqual(c.OT_OK, editor_abi.ot_edit_buffer_mark(&owner, &id, c.OT_EDIT_MARK_ADD, &good, &out));
    try std.testing.expectEqual(@as(u32, 1), out);
    var plain = good;
    plain.flags = 0;
    plain.value = std.mem.zeroes(c.ot_editor_style);
    plain.kind = 4;
    plain.start = 0;
    plain.end = 9;
    // Only a styled mark paints at its priority, so only a styled one is limited to 255.
    plain.priority = 300;
    try std.testing.expectEqual(c.OT_OK, editor_abi.ot_edit_buffer_mark(&owner, &id, c.OT_EDIT_MARK_ADD, &plain, &out));
    try std.testing.expectEqual(@as(u32, 2), out);
    var marks: [2]c.ot_edit_mark = undefined;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, editor_abi.ot_edit_buffer_get_marks(&owner, &id, 0, c.OT_EDIT_MARK_ANY_KIND, &marks, 1, &count));
    try std.testing.expectEqual(c.OT_OK, editor_abi.ot_edit_buffer_get_marks(&owner, &id, 0, c.OT_EDIT_MARK_ANY_KIND, &marks, 2, &count));
    try std.testing.expectEqual(@as(u32, 2), count);
    // (start, id) order; the second mark's end past the text clamps to it.
    var expected = good;
    expected.id = 1;
    expected.start_byte = 1;
    expected.end_byte = 5;
    try std.testing.expectEqual(@as(u32, 2), marks[0].id);
    try std.testing.expectEqual([2]u32{ 5, 300 }, [2]u32{ marks[0].end, marks[0].priority });
    try std.testing.expectEqualDeep(expected, marks[1]);
    try std.testing.expectEqual(c.OT_OK, editor_abi.ot_edit_buffer_get_marks(&owner, &id, 1, 4, &marks, 2, &count));
    try std.testing.expectEqual(@as(u32, 0), count);
    try std.testing.expectEqual(c.OT_OK, editor_abi.ot_edit_buffer_get_marks(&owner, &id, 0, 4, &marks, 2, &count));
    try std.testing.expectEqual(@as(u32, 1), count);
    // The styled mark reads as one highlight with style id 0 and ref = id.
    var highlights: [2]c.ot_edit_highlight = undefined;
    try std.testing.expectEqual(c.OT_OK, editor_abi.ot_edit_buffer_get_highlights(&owner, &id, 0, &highlights, 2, &count));
    try std.testing.expectEqual(@as(u32, 1), count);
    try std.testing.expectEqualDeep(c.ot_edit_highlight{ .start = 1, .end = 4, .style_id = 0, .priority = 2, .ref = 1 }, highlights[0]);

    var remove = std.mem.zeroes(c.ot_edit_mark);
    remove.struct_size = @sizeOf(c.ot_edit_mark);
    remove.abi_version = c.OT_CONTEXT_ABI_VERSION;
    remove.id = 2;
    remove.kind = 4;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, editor_abi.ot_edit_buffer_mark(&owner, &id, c.OT_EDIT_MARK_REMOVE, &remove, &out));
    remove.kind = 0;
    for ([_][2]u32{ .{ 2, 2 }, .{ 2, 0 } }) |row| {
        try std.testing.expectEqual(c.OT_OK, editor_abi.ot_edit_buffer_mark(&owner, &id, c.OT_EDIT_MARK_REMOVE, &remove, &out));
        try std.testing.expectEqual(row[1], out);
    }
    try std.testing.expectEqual(c.OT_OK, editor_abi.ot_edit_buffer_mark(&owner, &id, c.OT_EDIT_MARK_CLEAR, null, null));
    try std.testing.expectEqual(c.OT_OK, editor_abi.ot_edit_buffer_get_marks(&owner, &id, 0, c.OT_EDIT_MARK_ANY_KIND, null, 0, &count));
    try std.testing.expectEqual(@as(u32, 0), count);

    // A ZWJ typed at a mark's start shifts the mark and joins it into the emoji before: its start
    // byte is inside one grapheme now, and its offsets round out to cover all of it.
    try std.testing.expectEqual(c.OT_OK, abi.ot_edit_buffer_set_text(&owner, &id, "\u{1f468}\u{1f469}", 8, 0));
    plain.start = 2;
    plain.end = 4;
    plain.flags = c.OT_EDIT_MARK_STYLE_VALUE;
    plain.value = value;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, editor_abi.ot_edit_buffer_mark(&owner, &id, c.OT_EDIT_MARK_ADD, &plain, &out));
    plain.priority = 2;
    try std.testing.expectEqual(c.OT_OK, editor_abi.ot_edit_buffer_mark(&owner, &id, c.OT_EDIT_MARK_ADD, &plain, &out));
    try std.testing.expectEqual(c.OT_OK, editor_abi.ot_edit_buffer_command(&owner, &id, c.OT_EDIT_CURSOR_OFFSET, 2));
    try std.testing.expectEqual(c.OT_OK, abi.ot_edit_buffer_insert_text(&owner, &id, "\u{200d}", 3));
    try std.testing.expectEqual(c.OT_OK, editor_abi.ot_edit_buffer_get_marks(&owner, &id, 0, c.OT_EDIT_MARK_ANY_KIND, &marks, 2, &count));
    try std.testing.expectEqual([4]u32{ 0, 2, 7, 11 }, [4]u32{ marks[0].start, marks[0].end, marks[0].start_byte, marks[0].end_byte });
    // It still paints and reads as a highlight over the whole grapheme.
    try std.testing.expectEqual(c.OT_OK, editor_abi.ot_edit_buffer_get_highlights(&owner, &id, 0, &highlights, 2, &count));
    try std.testing.expectEqual(@as(u32, 1), count);
    try std.testing.expectEqual([2]u32{ 0, 2 }, [2]u32{ highlights[0].start, highlights[0].end });
}

// The cursor rules around atomic marks (C5.3): the vectors of Core's `extmarks*.test.ts` and Rust's
// `tests/widgets.rs`, and record 636's in both insertion orders. Marks are listed in creation order.
// `set` is the hosts' offset setter (raw, then KEEP_OUTSIDE toward the move), `atomic_set` Core's
// buffer setter, `keep` a pointer or wheel landing at `from` (KEEP_OUTSIDE toward the edge given).
test "atomic marks: cursor rules match the hosts' tables" {
    var owner: abi.ContextHandle = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = undefined, .owner_thread = std.Thread.getCurrentId() };
    defer owner.io_threaded.deinit();
    owner.core = try context_mod.Context.init(std.testing.allocator, owner.io_threaded.io(), .{});
    defer owner.core.deinit() catch unreachable;
    const buffer_handle = try owner.core.createEditBuffer(.unicode);
    const view_handle = try owner.core.createEditorView(buffer_handle, 40, 4);
    try owner.core.editorCommand(view_handle, .{ .wrap_mode = .word });
    const id = abi.handleToC(buffer_handle);
    const view = abi.handleToC(view_handle);
    const eb = (try owner.core.raw().getEditBuffer(buffer_handle)).buffer;
    const Move = union(enum) { left, right, up, down, word, backspace, delete, set: u32, atomic_set: u32, keep: EditBuffer.Toward };
    const Row = struct { text: []const u8, marks: []const [2]u32, from: u32, move: Move, to: u32, after: ?[]const u8 = null, width: u32 = 40 };
    var rows: std.ArrayListUnmanaged(Row) = .empty;
    defer rows.deinit(std.testing.allocator);
    // 607: before the mark is a unit, even a wide one or a tab, or with none the end of the line above.
    var texts: [5][40]u8 = undefined;
    var marks: [5][1][2]u32 = undefined;
    for ([_][]const u8{ "a", "\u{65e5}", "\u{1f44d}", "\t", "" }, &texts, &marks) |char, *buffer, *mark| {
        const text = try std.fmt.bufPrint(buffer, "0123456789\n{s}@main.rs\nxxxxxxxxxx", .{char});
        const w = try owner.core.editMeasureText(buffer_handle, char);
        mark.* = .{.{ 11 + w, 19 + w }};
        const at: u32 = if (w == 0) 10 else 11;
        for ([_]struct { Move, u32, u32 }{
            .{ .left, 19 + w, at },   .{ .word, 19 + w, at },    .{ .down, w + 1, at },
            .{ .up, 21 + 2 * w, at }, .{ .down, w + 4, 19 + w }, .{ .down, w + 6, 19 + w },
        }) |move| try rows.append(std.testing.allocator, .{ .text = text, .marks = mark, .from = move[1], .move = move[0], .to = move[2] });
    }
    const wrapped = "\u{65e5}@mainrsxyzuvwABCDEFGHIJKL";
    const file = "x @file y";
    try rows.appendSlice(std.testing.allocator, &.{
        // Down never goes back, and past marks that overlap the end, not one that starts there.
        .{ .text = wrapped, .width = 6, .marks = &.{.{ 2, 15 }}, .from = 0, .move = .down, .to = 15 },
        .{ .text = wrapped, .width = 6, .marks = &.{ .{ 2, 15 }, .{ 14, 19 } }, .from = 0, .move = .down, .to = 19 },
        .{ .text = wrapped, .width = 6, .marks = &.{ .{ 2, 15 }, .{ 14, 19 }, .{ 18, 23 }, .{ 22, 27 } }, .from = 0, .move = .down, .to = 27 },
        .{ .text = wrapped, .width = 6, .marks = &.{ .{ 2, 15 }, .{ 15, 17 } }, .from = 0, .move = .down, .to = 15 },
        .{ .text = "a\n\n@main.rs\nb", .marks = &.{.{ 3, 11 }}, .from = 2, .move = .down, .to = 11 },
        // Down leaving nearer the start goes past the mark it is in, toward the move; Up never goes forward.
        .{ .text = "0123456789\nabcdefghij\nxyz", .marks = &.{ .{ 14, 20 }, .{ 12, 15 } }, .from = 4, .move = .down, .to = 20 },
        .{ .text = wrapped, .width = 6, .marks = &.{.{ 2, 15 }}, .from = 15, .move = .up, .to = 0 },
        // Overlapping marks: Up and Backspace take the mark added first, in either order.
        .{ .text = "0123456789\n0123456789\n0123456789", .marks = &.{ .{ 14, 20 }, .{ 11, 16 } }, .from = 26, .move = .up, .to = 11 },
        .{ .text = "0123456789\n0123456789\n0123456789", .marks = &.{ .{ 11, 16 }, .{ 14, 20 } }, .from = 26, .move = .up, .to = 20 },
        .{ .text = "abcd", .marks = &.{ .{ 1, 4 }, .{ 0, 4 } }, .from = 4, .move = .backspace, .to = 1, .after = "a" },
        .{ .text = "abcd", .marks = &.{ .{ 0, 4 }, .{ 1, 4 } }, .from = 4, .move = .backspace, .to = 0, .after = "" },
        // Left and Right jump over a mark, and Left over marks that overlap it; a touching one stops it at the edge.
        .{ .text = "abcdefgh", .marks = &.{.{ 3, 6 }}, .from = 2, .move = .right, .to = 6 },
        .{ .text = "abcdefgh", .marks = &.{.{ 3, 6 }}, .from = 0, .move = .right, .to = 1 },
        .{ .text = "abcdefgh", .marks = &.{.{ 3, 6 }}, .from = 7, .move = .left, .to = 6 },
        .{ .text = "abcdefgh", .marks = &.{.{ 3, 6 }}, .from = 6, .move = .left, .to = 2 },
        .{ .text = "abcdefgh", .marks = &.{.{ 3, 6 }}, .from = 2, .move = .left, .to = 1 },
        .{ .text = "abcdefghij", .marks = &.{ .{ 2, 4 }, .{ 5, 7 } }, .from = 1, .move = .right, .to = 4 },
        .{ .text = "abcdefghij", .marks = &.{ .{ 2, 4 }, .{ 5, 7 } }, .from = 4, .move = .right, .to = 7 },
        // Chips that touch (a prompt whose separator spaces were deleted) are stepped over and deleted one at a time.
        .{ .text = "abcdefghij", .marks = &.{ .{ 1, 3 }, .{ 3, 5 } }, .from = 0, .move = .right, .to = 3 },
        .{ .text = "xx @a@b@c yy", .marks = &.{ .{ 3, 5 }, .{ 5, 7 }, .{ 7, 9 } }, .from = 2, .move = .right, .to = 5 },
        .{ .text = "xx @a@b@c yy", .marks = &.{ .{ 3, 5 }, .{ 5, 7 }, .{ 7, 9 } }, .from = 9, .move = .left, .to = 7 },
        .{ .text = "xx @a@b@c yy", .marks = &.{ .{ 3, 5 }, .{ 5, 7 }, .{ 7, 9 } }, .from = 5, .move = .backspace, .to = 3, .after = "xx @b@c yy" },
        .{ .text = "xx @a@b@c yy", .marks = &.{ .{ 3, 5 }, .{ 5, 7 }, .{ 7, 9 } }, .from = 5, .move = .delete, .to = 5, .after = "xx @a@c yy" },
        // Of overlapping marks, Delete and Backspace take the oldest with that edge at the cursor.
        .{ .text = "abcdefghijklmno", .marks = &.{ .{ 1, 8 }, .{ 3, 6 } }, .from = 3, .move = .delete, .to = 3, .after = "abcghijklmno" },
        .{ .text = "abcdefghijklmno", .marks = &.{ .{ 1, 8 }, .{ 3, 6 } }, .from = 6, .move = .backspace, .to = 3, .after = "abcghijklmno" },
        // Backspace over `x` joins the wave and the skin tone, so the mark on `🏻Z` grows back over the cursor: it leaves.
        .{ .text = "\u{1f44b}x\u{1f3fb}Z", .marks = &.{.{ 3, 6 }}, .from = 3, .move = .backspace, .to = 3, .after = "\u{1f44b}\u{1f3fb}Z" },
        // A cell inside a wide unit is not a stop: the atomic setter and KEEP_OUTSIDE go to the unit's start.
        .{ .text = "a\u{65e5}b", .marks = &.{.{ 0, 1 }}, .from = 0, .move = .{ .atomic_set = 2 }, .to = 1 },
        .{ .text = "a\u{65e5}b", .marks = &.{}, .from = 2, .move = .{ .keep = .nearer }, .to = 1 },
        .{ .text = "ab@x@y", .marks = &.{ .{ 2, 4 }, .{ 4, 6 } }, .from = 6, .move = .left, .to = 4 },
        .{ .text = "ab@x@y", .marks = &.{ .{ 2, 5 }, .{ 4, 6 } }, .from = 6, .move = .left, .to = 1 },
        .{ .text = "\u{65e5}\u{65e5}\u{65e5}\u{65e5}@ab", .marks = &.{.{ 8, 11 }}, .from = 8, .move = .right, .to = 11 },
        .{ .text = "\u{65e5}\u{65e5}\u{65e5}\u{65e5}@ab", .marks = &.{.{ 8, 11 }}, .from = 11, .move = .right, .to = 11 },
        .{ .text = "see @main.rs now", .marks = &.{.{ 4, 12 }}, .from = 12, .move = .left, .to = 3 },
        .{ .text = "see @main.rs now", .marks = &.{.{ 4, 12 }}, .from = 3, .move = .right, .to = 12 },
        .{ .text = "see @main.rs now", .marks = &.{.{ 4, 12 }}, .from = 4, .move = .right, .to = 12 },
        // The hosts' setter goes to the nearer edge the way it moved (4, not 3); Core's buffer setter steps as Left.
        .{ .text = "see @main.rs now", .marks = &.{.{ 4, 12 }}, .from = 12, .move = .{ .set = 5 }, .to = 4 },
        .{ .text = "see @main.rs now", .marks = &.{.{ 4, 12 }}, .from = 12, .move = .{ .atomic_set = 5 }, .to = 3 },
        .{ .text = "see @main.rs now", .marks = &.{.{ 4, 12 }}, .from = 0, .move = .{ .atomic_set = 5 }, .to = 12 },
        // Backspace at the end and Delete at the start delete the whole mark; elsewhere one character.
        .{ .text = "abc[LINK]def", .marks = &.{.{ 3, 9 }}, .from = 9, .move = .backspace, .to = 3, .after = "abcdef" },
        .{ .text = "abc[LINK]def", .marks = &.{.{ 3, 9 }}, .from = 2, .move = .backspace, .to = 1, .after = "ac[LINK]def" },
        .{ .text = "abc[LINK]def", .marks = &.{.{ 3, 9 }}, .from = 5, .move = .backspace, .to = 4, .after = "abc[INK]def" },
        .{ .text = "abc[LINK]def", .marks = &.{.{ 3, 9 }}, .from = 3, .move = .delete, .to = 3, .after = "abcdef" },
        // 634, 635, 636: a pointer, the wheel and the setter leave the cursor at the outer edge of all marks.
        .{ .text = file, .marks = &.{.{ 2, 7 }}, .from = 3, .move = .{ .keep = .nearer }, .to = 2 },
        .{ .text = file, .marks = &.{.{ 2, 7 }}, .from = 5, .move = .{ .keep = .nearer }, .to = 7 },
        .{ .text = file, .marks = &.{.{ 2, 7 }}, .from = 2, .move = .{ .keep = .nearer }, .to = 2 },
        .{ .text = "x [Pasted ~20 lines] y", .marks = &.{.{ 2, 20 }}, .from = 15, .move = .{ .keep = .nearer }, .to = 20 },
        .{ .text = "ab\n@file\nc", .marks = &.{.{ 3, 8 }}, .from = 4, .move = .{ .keep = .end }, .to = 8 },
        .{ .text = "ab\n@file\nc", .marks = &.{.{ 3, 8 }}, .from = 7, .move = .{ .keep = .start }, .to = 3 },
        .{ .text = "b ca", .marks = &.{ .{ 0, 3 }, .{ 0, 4 } }, .from = 2, .move = .{ .keep = .nearer }, .to = 4 },
        .{ .text = "b ca", .marks = &.{ .{ 0, 4 }, .{ 0, 3 } }, .from = 2, .move = .{ .keep = .nearer }, .to = 4 },
        .{ .text = "b ca", .marks = &.{ .{ 0, 3 }, .{ 0, 4 } }, .from = 0, .move = .{ .set = 2 }, .to = 4 },
        .{ .text = "b ca", .marks = &.{ .{ 0, 4 }, .{ 0, 3 } }, .from = 0, .move = .{ .set = 2 }, .to = 4 },
        .{ .text = "b ca", .marks = &.{ .{ 0, 3 }, .{ 0, 4 } }, .from = 4, .move = .{ .set = 2 }, .to = 0 },
        .{ .text = "b ca", .marks = &.{ .{ 0, 4 }, .{ 0, 3 } }, .from = 4, .move = .{ .set = 2 }, .to = 0 },
        .{ .text = "b ca", .marks = &.{ .{ 0, 3 }, .{ 0, 4 } }, .from = 0, .move = .right, .to = 4 },
        .{ .text = "b ca", .marks = &.{ .{ 0, 4 }, .{ 0, 3 } }, .from = 0, .move = .right, .to = 4 },
        .{ .text = "b ca", .marks = &.{ .{ 0, 3 }, .{ 0, 4 } }, .from = 4, .move = .left, .to = 0 },
        .{ .text = "b ca", .marks = &.{ .{ 0, 4 }, .{ 0, 3 } }, .from = 4, .move = .left, .to = 0 },
        .{ .text = "abcdefgh", .marks = &.{ .{ 0, 6 }, .{ 2, 8 } }, .from = 3, .move = .{ .keep = .nearer }, .to = 0 },
        .{ .text = "abcdefgh", .marks = &.{ .{ 2, 8 }, .{ 0, 6 } }, .from = 3, .move = .{ .keep = .nearer }, .to = 0 },
        .{ .text = "abcd", .marks = &.{ .{ 2, 4 }, .{ 1, 3 }, .{ 0, 2 } }, .from = 0, .move = .{ .set = 1 }, .to = 4 },
        // Touching edges are stops.
        .{ .text = "ab@x@y", .marks = &.{ .{ 2, 4 }, .{ 4, 6 } }, .from = 4, .move = .{ .keep = .nearer }, .to = 4 },
    });
    for (rows.items) |row| {
        try std.testing.expectEqual(c.OT_OK, abi.ot_edit_buffer_set_text(&owner, &id, row.text.ptr, @intCast(row.text.len), 0));
        try owner.core.editorSetViewport(view_handle, .{ .x = 0, .y = 0, .width = row.width, .height = 4 }, true, false);
        for (row.marks) |mark| _ = try eb.addMark(.{ .start = mark[0], .end = mark[1], .atomic = true });
        try eb.setCursorByOffset(row.from);
        const command: [3]u32 = switch (row.move) {
            .left => .{ 0, c.OT_EDIT_MOVE_LEFT, c.OT_EDIT_ATOMIC },
            .right => .{ 0, c.OT_EDIT_MOVE_RIGHT, c.OT_EDIT_ATOMIC },
            .backspace => .{ 0, c.OT_EDIT_BACKSPACE, c.OT_EDIT_ATOMIC },
            .delete => .{ 0, c.OT_EDIT_DELETE_FORWARD, c.OT_EDIT_ATOMIC },
            .word => .{ 0, c.OT_EDIT_CURSOR_OFFSET_ATOMIC, eb.getPrevWordBoundary().offset },
            .atomic_set => |x| .{ 0, c.OT_EDIT_CURSOR_OFFSET_ATOMIC, x },
            .set => |x| set: {
                try std.testing.expectEqual(c.OT_OK, editor_abi.ot_edit_buffer_command(&owner, &id, c.OT_EDIT_CURSOR_OFFSET, x));
                break :set .{ 0, c.OT_EDIT_KEEP_OUTSIDE, if (x > row.from) 1 else 2 };
            },
            .keep => |toward| .{ 0, c.OT_EDIT_KEEP_OUTSIDE, @backingInt(toward) },
            .up => .{ 1, c.OT_EDITOR_MOVE_UP, c.OT_EDIT_ATOMIC },
            .down => .{ 1, c.OT_EDITOR_MOVE_DOWN, c.OT_EDIT_ATOMIC },
        };
        const status = if (command[0] == 1) editor_abi.ot_editor_view_command(&owner, &view, command[1], command[2]) else editor_abi.ot_edit_buffer_command(&owner, &id, command[1], command[2]);
        try std.testing.expectEqual(c.OT_OK, status);
        std.testing.expectEqual(row.to, eb.getPrimaryCursor().offset) catch |err| {
            std.debug.print("{s} {any} from {d} with {any}\n", .{ row.text, row.move, row.from, row.marks });
            return err;
        };
        var text: [64]u8 = undefined;
        try std.testing.expectEqualStrings(row.after orelse row.text, text[0..eb.getText(&text)]);
    }
    // The flag is only for the commands that take it, and KEEP_OUTSIDE has three edges.
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, editor_abi.ot_edit_buffer_command(&owner, &id, c.OT_EDIT_KEEP_OUTSIDE, 3));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, editor_abi.ot_edit_buffer_command(&owner, &id, c.OT_EDIT_MOVE_UP, c.OT_EDIT_ATOMIC));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, editor_abi.ot_editor_view_command(&owner, &view, c.OT_EDITOR_GOTO_LINE_END, c.OT_EDIT_ATOMIC));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, editor_abi.ot_editor_view_command(&owner, &view, c.OT_EDITOR_MOVE_UP, c.OT_EDIT_ATOMIC + 1));
}

/// Whether an atomic mark strictly contains cursor offset `offset`.
fn surrounds(eb: *const EditBuffer, offset: u32) bool {
    for (eb.tb.marks()) |mark| {
        const span = eb.markOffsets(mark);
        if (mark.atomic and span.start < offset and offset < span.end) return true;
    }
    return false;
}

fn expectSameLines(marked: *EditBuffer, legacy: *EditBuffer) !void {
    for (0..marked.tb.lineCount()) |line| {
        // Paint: the resolved style of every column.
        const width = marked.tb.lineWidthAt(@intCast(line));
        const marked_spans = try std.testing.allocator.dupe(@TypeOf((try marked.tb.getLineSpans(line))[0]), try marked.tb.getLineSpans(line));
        defer std.testing.allocator.free(marked_spans);
        const legacy_spans = try legacy.tb.getLineSpans(line);
        for (0..width) |col| {
            try std.testing.expectEqualDeep(styleAt(marked, marked_spans, @intCast(col)), styleAt(legacy, legacy_spans, @intCast(col)));
        }
        // Reports: the records, then the marks' projection, against the twin's records.
        var reported: std.ArrayListUnmanaged([4]u32) = .empty;
        defer reported.deinit(std.testing.allocator);
        for (marked.tb.getLineHighlights(line)) |h| try reported.append(std.testing.allocator, .{ h.col_start, h.col_end, h.priority, h.hl_ref });
        for (try marked.tb.lineMarks(@intCast(line))) |entry| try reported.append(std.testing.allocator, .{ entry.col_start, entry.col_end, entry.mark.priority, @as(u16, @truncate(entry.mark.id)) });
        var expected: std.ArrayListUnmanaged([4]u32) = .empty;
        defer expected.deinit(std.testing.allocator);
        for (legacy.tb.getLineHighlights(line)) |h| try expected.append(std.testing.allocator, .{ h.col_start, h.col_end, h.priority, h.hl_ref });
        try std.testing.expectEqualSlices([4]u32, expected.items, reported.items);
    }
}

fn styleAt(eb: *EditBuffer, spans: anytype, col: u32) ?ss.StyleDefinition {
    for (spans) |span| if (col < span.end_col_exclusive) return eb.tb.resolveSpan(span);
    return null;
}
