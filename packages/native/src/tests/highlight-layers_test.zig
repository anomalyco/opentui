//! Highlight layers and group sets (track step C3.1): bounds, composition, layer edits, links,
//! and paint parity with legacy highlight records.
const std = @import("std");
const testing = std.testing;
const gpa = testing.allocator;
const TestPools = @import("test-pools.zig").TestPools;
const hl = @import("../highlight-layers.zig");
const text_buffer = @import("../text-buffer.zig");
const TextBuffer = text_buffer.UnifiedTextBuffer;
const LayerRun = text_buffer.LayerRun;
const text_buffer_view = @import("../text-buffer-view.zig");
const TextBufferView = text_buffer_view.UnifiedTextBufferView;
const EditBuffer = @import("../edit-buffer.zig").EditBuffer;
const Cursor = @import("../edit-buffer.zig").Cursor;
const iter_mod = @import("../text-buffer-iterators.zig");
const OptimizedBuffer = @import("../buffer.zig").OptimizedBuffer;
const ss = @import("../syntax-style.zig");
const link = @import("../link.zig");
const ansi = @import("../ansi.zig");
const utf8 = @import("../utf8.zig");
const text_work = @import("../text-work.zig");
const owned_styled = @import("owned-styled-text.zig");
const Value = std.json.Value;

const red = ansi.rgbColor(255, 0, 0, 255);
const green = ansi.rgbColor(0, 255, 0, 255);
const blue = ansi.rgbColor(0, 0, 255, 255);

fn nameOf(buffer: []u8, prefix: []const u8, index: usize, length: usize) []const u8 {
    @memset(buffer[0..length], '-');
    const head = std.fmt.bufPrint(buffer, "{s}{d}", .{ prefix, index }) catch unreachable;
    return buffer[0..@max(head.len, length)];
}

test "group sets: each name bound rejects without interning" {
    var sets = hl.GroupSets.init(gpa);
    defer sets.deinit();
    const long_bytes: [hl.group_set_name_byte_count_max + 1]u8 = @splat('x');
    const long: []const u8 = &long_bytes;
    const nine: [hl.group_set_name_count_max + 1][]const u8 = @splat("a");
    const eight: [hl.group_set_name_count_max][]const u8 = @splat("a");
    for ([_][]const []const u8{ &.{}, &nine, &.{""}, &.{ "a", "" }, &.{long} }) |names| {
        try testing.expectError(error.InvalidIndex, sets.intern(names));
        try testing.expectEqual(@as(u32, 0), sets.count());
        try testing.expectEqual(@as(usize, 0), sets.name_bytes.items.len);
    }
    // Exactly at each name bound is accepted, and equal lists share an id.
    const id = try sets.intern(&eight);
    try testing.expectEqual(id, try sets.intern(&eight));
    try testing.expectEqual(try sets.intern(&.{long[1..]}), try sets.intern(&.{long[1..]}));
    try testing.expectEqual(@as(u32, 2), sets.count());
    try testing.expect(id != try sets.intern(&.{ "a", "b" }));
    try testing.expectEqual(@as(u32, hl.group_set_name_count_max), sets.nameCount(id));
}

test "group sets: the set count and the name pool bound new sets only" {
    var name_buffer: [hl.group_set_name_byte_count_max]u8 = undefined;
    {
        var sets = hl.GroupSets.init(gpa);
        defer sets.deinit();
        for (0..hl.group_set_count_max) |index| {
            const id = try sets.intern(&.{nameOf(&name_buffer, "s", index, 1)});
            try testing.expectEqual(@as(u32, @intCast(index + 1)), id);
        }
        const pool_bytes = sets.name_bytes.items.len;
        try testing.expectError(error.GroupSetLimit, sets.intern(&.{"new"}));
        try testing.expectEqual(@as(u32, hl.group_set_count_max), sets.count());
        try testing.expectEqual(pool_bytes, sets.name_bytes.items.len);
        try testing.expectEqual(@as(u32, 7), try sets.intern(&.{"s6"}));
    }
    {
        var sets = hl.GroupSets.init(gpa);
        defer sets.deinit();
        // Sets of eight 64-byte names fill the 64 KiB pool exactly.
        const per_set = hl.group_set_name_count_max * hl.group_set_name_byte_count_max;
        const set_count = hl.group_set_pool_byte_count_max / per_set;
        var storage: [hl.group_set_name_count_max][hl.group_set_name_byte_count_max]u8 = undefined;
        var names: [hl.group_set_name_count_max][]const u8 = undefined;
        for (0..set_count) |set_index| {
            for (&names, &storage, 0..) |*value, *bytes, name_index| value.* = nameOf(bytes, "p", set_index * 8 + name_index, bytes.len);
            _ = try sets.intern(&names);
        }
        try testing.expectEqual(@as(usize, hl.group_set_pool_byte_count_max), sets.name_bytes.items.len);
        try testing.expectError(error.GroupSetLimit, sets.intern(&.{"z"}));
        try testing.expectEqual(@as(u32, set_count), sets.count());
        try testing.expectEqual(@as(u32, set_count), try sets.intern(&names));
    }
}

test "group sets: interning without memory changes nothing" {
    var succeeded = false;
    for (0..8) |fail_index| {
        var failing = std.testing.FailingAllocator.init(gpa, .{ .fail_index = fail_index });
        var sets = hl.GroupSets.init(failing.allocator());
        defer sets.deinit();
        const first = sets.intern(&.{"keyword"}) catch {
            try testing.expectEqual(@as(u32, 0), sets.count());
            continue;
        };
        const count = sets.count();
        const byte_count = sets.name_bytes.items.len;
        const name_count = sets.name_end_bytes.items.len;
        if (sets.intern(&.{ "markup", "markup.bold" })) |second| {
            try testing.expectEqual(first + 1, second);
            succeeded = true;
            break;
        } else |err| {
            try testing.expectEqual(error.OutOfMemory, err);
            try testing.expectEqual(count, sets.count());
            try testing.expectEqual(byte_count, sets.name_bytes.items.len);
            try testing.expectEqual(name_count, sets.name_end_bytes.items.len);
            try testing.expectEqualStrings("keyword", sets.name(first, 0));
        }
    }
    try testing.expect(succeeded);
}

test "group sets: later names win per field, a missing name falls back to its first component" {
    var sets = hl.GroupSets.init(gpa);
    defer sets.deinit();
    const style = try ss.SyntaxStyle.init(gpa);
    defer style.deinit();
    _ = try style.registerStyle("keyword", red, null, 1);
    _ = try style.registerStyle("markup", green, null, 2);
    _ = try style.registerStyle("string", null, blue, 0);
    const D = ss.StyleDefinition;
    for ([_]struct { []const []const u8, D }{
        .{ &.{"keyword"}, .{ .fg = red, .bg = null, .attributes = 1 } },
        .{ &.{ "keyword", "markup.bold" }, .{ .fg = green, .bg = null, .attributes = 3 } },
        .{ &.{ "markup", "keyword" }, .{ .fg = red, .bg = null, .attributes = 3 } },
        .{ &.{ "string", "keyword" }, .{ .fg = red, .bg = blue, .attributes = 1 } },
        // Only the first dotted component is a fallback; an undotted miss adds nothing.
        .{ &.{ "keyword", "missing", "missing.keyword", "other.markup" }, .{ .fg = red, .bg = null, .attributes = 1 } },
        .{ &.{"keyword.control.flow"}, .{ .fg = red, .bg = null, .attributes = 1 } },
        .{ &.{"missing"}, .{ .fg = null, .bg = null, .attributes = 0 } },
    }) |row| {
        const id = try sets.intern(row[0]);
        try testing.expectEqualDeep(row[1], hl.compose(style, &sets, id));
        try testing.expectEqualDeep(row[1], style.resolveGroupSet(&sets, id));
    }
}

test "group sets: every registration clears the composition cache" {
    var sets = hl.GroupSets.init(gpa);
    defer sets.deinit();
    const style = try ss.SyntaxStyle.init(gpa);
    defer style.deinit();
    _ = try style.registerStyle("markup", green, null, 0);
    const id = try sets.intern(&.{"markup.bold"});
    try testing.expectEqual(green, style.resolveGroupSet(&sets, id).fg.?);
    // A redefinition, then a new exact name that replaces the fallback.
    _ = try style.registerStyle("markup", blue, null, 0);
    try testing.expectEqual(blue, style.resolveGroupSet(&sets, id).fg.?);
    _ = try style.registerStyle("markup.bold", red, null, 0);
    try testing.expectEqual(red, style.resolveGroupSet(&sets, id).fg.?);
    // A set interned after the cache grew resolves too.
    const later = try sets.intern(&.{"markup"});
    try testing.expectEqual(blue, style.resolveGroupSet(&sets, later).fg.?);
    try testing.expectEqual(red, style.resolveGroupSet(&sets, id).fg.?);
}

const RunSpec = struct { u32, u32, u32 };

fn runsOf(layers: *const hl.Layers, layer_id: u32) []const LayerRun {
    for (layers.slice()) |layer| if (layer.layer_id == layer_id) return layer.runs.items;
    return &.{};
}

fn expectRuns(expected: []const RunSpec, actual: []const LayerRun) !void {
    var specs: [16]RunSpec = undefined;
    for (actual, 0..) |run, index| specs[index] = .{ run.start_byte, run.end_byte, run.group_set };
    try testing.expectEqualSlices(RunSpec, expected, specs[0..actual.len]);
}

fn toRuns(buffer: []LayerRun, specs: []const RunSpec) []const LayerRun {
    for (specs, 0..) |spec, index| buffer[index] = .{ .start_byte = spec[0], .end_byte = spec[1], .group_set = spec[2] };
    return buffer[0..specs.len];
}

test "layers: a set replaces its range and keeps the outside parts of crossing runs" {
    var links = link.LinkPool.init(gpa);
    defer links.deinit();
    // Each row: old runs, the replaced range, new runs, and the runs that result.
    for ([_]struct { []const RunSpec, u32, u32, []const RunSpec, []const RunSpec }{
        .{ &.{}, 0, 10, &.{.{ 2, 4, 1 }}, &.{.{ 2, 4, 1 }} },
        .{ &.{.{ 0, 10, 1 }}, 3, 6, &.{}, &.{ .{ 0, 3, 1 }, .{ 6, 10, 1 } } },
        .{ &.{.{ 0, 10, 1 }}, 3, 6, &.{.{ 4, 5, 2 }}, &.{ .{ 0, 3, 1 }, .{ 4, 5, 2 }, .{ 6, 10, 1 } } },
        .{ &.{ .{ 0, 4, 1 }, .{ 6, 10, 2 } }, 2, 8, &.{.{ 3, 5, 3 }}, &.{ .{ 0, 2, 1 }, .{ 3, 5, 3 }, .{ 8, 10, 2 } } },
        // Runs that only touch the range edges stay whole.
        .{ &.{ .{ 0, 2, 1 }, .{ 6, 8, 2 } }, 2, 6, &.{.{ 2, 6, 3 }}, &.{ .{ 0, 2, 1 }, .{ 2, 6, 3 }, .{ 6, 8, 2 } } },
        .{ &.{ .{ 0, 2, 1 }, .{ 3, 4, 2 }, .{ 6, 8, 3 } }, 2, 6, &.{}, &.{ .{ 0, 2, 1 }, .{ 6, 8, 3 } } },
        // An empty range is no change, even inside a run.
        .{ &.{.{ 0, 10, 1 }}, 5, 5, &.{}, &.{.{ 0, 10, 1 }} },
        .{ &.{.{ 2, 4, 1 }}, 0, 10, &.{}, &.{} },
    }) |row| {
        var layers: hl.Layers = .{};
        defer layers.reset(gpa, &links);
        var buffer: [8]LayerRun = undefined;
        try layers.set(gpa, &links, 1, 0, 10, toRuns(&buffer, row[0]));
        try layers.set(gpa, &links, 1, row[1], row[2], toRuns(&buffer, row[3]));
        try expectRuns(row[4], runsOf(&layers, 1));
        // An emptied layer is dropped.
        try testing.expectEqual(@as(u8, @intFromBool(row[4].len > 0)), layers.count);
    }
}

test "layers: invalid runs and a fifth layer reject without a change" {
    var links = link.LinkPool.init(gpa);
    defer links.deinit();
    var layers: hl.Layers = .{};
    defer layers.reset(gpa, &links);
    var buffer: [8]LayerRun = undefined;
    for ([_]u32{ 4, 1, 3, 2 }) |layer_id| try layers.set(gpa, &links, layer_id, 0, 10, toRuns(&buffer, &.{.{ layer_id, layer_id + 1, layer_id }}));
    for ([_]struct { u32, u32, []const RunSpec }{
        .{ 6, 5, &.{} },
        .{ 0, 10, &.{.{ 3, 3, 1 }} },
        .{ 0, 10, &.{ .{ 2, 5, 1 }, .{ 4, 6, 1 } } },
        .{ 0, 10, &.{ .{ 5, 6, 1 }, .{ 2, 3, 1 } } },
        .{ 2, 6, &.{.{ 1, 3, 1 }} },
        .{ 2, 6, &.{.{ 5, 7, 1 }} },
    }) |row| {
        try testing.expectError(error.InvalidIndex, layers.set(gpa, &links, 2, row[0], row[1], toRuns(&buffer, row[2])));
        try expectRuns(&.{.{ 2, 3, 2 }}, runsOf(&layers, 2));
    }
    try testing.expectEqual(@as(u8, hl.layer_count_max), layers.count);
    try testing.expectError(error.LayerLimit, layers.set(gpa, &links, 5, 0, 10, toRuns(&buffer, &.{.{ 0, 1, 5 }})));
    // Clearing a missing layer and replacing a present one are not new layers.
    try layers.set(gpa, &links, 5, 0, 10, &.{});
    try layers.set(gpa, &links, 2, 0, 10, toRuns(&buffer, &.{.{ 7, 8, 9 }}));
    try testing.expectEqual(@as(u8, hl.layer_count_max), layers.count);
    for (layers.slice(), [_]u32{ 1, 2, 3, 4 }) |layer, layer_id| try testing.expectEqual(layer_id, layer.layer_id);
    try layers.set(gpa, &links, 3, 0, 10, &.{});
    try layers.set(gpa, &links, 5, 0, 10, toRuns(&buffer, &.{.{ 0, 1, 5 }}));
    for (layers.slice(), [_]u32{ 1, 2, 4, 5 }) |layer, layer_id| try testing.expectEqual(layer_id, layer.layer_id);
}

/// Per-byte model of one buffer's layers. Each run piece has its own label, so a run split by a
/// set stays two pieces in the model as in the layers.
const LayerModel = struct {
    const byte_count_max = 512;
    const Piece = struct { group_set: u32, link_id: u32 };

    byte_count: u32,
    labels: [hl.layer_count_max + 2][byte_count_max]u16 = @splat(@splat(0)),
    pieces: std.ArrayListUnmanaged(Piece) = .empty,

    fn deinit(self: *LayerModel) void {
        self.pieces.deinit(gpa);
    }

    fn label(self: *LayerModel, group_set: u32, link_id: u32) !u16 {
        try self.pieces.append(gpa, .{ .group_set = group_set, .link_id = link_id });
        return @intCast(self.pieces.items.len);
    }

    fn layerCount(self: *const LayerModel) usize {
        var count: usize = 0;
        for (self.labels) |layer| count += @intFromBool(std.mem.indexOfNone(u16, layer[0..self.byte_count], &.{0}) != null);
        return count;
    }

    fn present(self: *const LayerModel, layer: usize) bool {
        return std.mem.indexOfNone(u16, self.labels[layer][0..self.byte_count], &.{0}) != null;
    }

    /// Mirrors `Layers.set`; returns whether it would make a new layer past the limit.
    fn set(self: *LayerModel, layer: usize, start: u32, end: u32, runs: []const LayerRun) !bool {
        const row = &self.labels[layer];
        if (start == end) return false;
        const was_present = self.present(layer);
        if (!was_present and runs.len > 0 and self.layerCount() >= hl.layer_count_max) return true;
        if (start > 0 and end < self.byte_count and row[start - 1] != 0 and row[start - 1] == row[end]) {
            const piece = self.pieces.items[row[end] - 1];
            const tail = try self.label(piece.group_set, piece.link_id);
            var index = end;
            const old = row[end];
            while (index < self.byte_count and row[index] == old) : (index += 1) row[index] = tail;
        }
        @memset(row[start..end], 0);
        for (runs) |run| @memset(row[run.start_byte..run.end_byte], try self.label(run.group_set, run.link_id));
        return false;
    }

    fn insert(self: *LayerModel, at: u32, count: u32) void {
        std.debug.assert(self.byte_count + count <= byte_count_max);
        for (&self.labels) |*row| {
            const inside = at > 0 and at < self.byte_count and row[at - 1] == row[at];
            const fill = if (inside) row[at] else 0;
            std.mem.copyBackwards(u16, row[at + count .. self.byte_count + count], row[at..self.byte_count]);
            @memset(row[at .. at + count], fill);
        }
        self.byte_count += count;
    }

    fn delete(self: *LayerModel, start: u32, end: u32) void {
        for (&self.labels) |*row| std.mem.copyForwards(u16, row[start .. self.byte_count - (end - start)], row[end..self.byte_count]);
        self.byte_count -= end - start;
    }

    fn reset(self: *LayerModel) void {
        for (&self.labels) |*row| @memset(row, 0);
    }

    fn linkedPieces(self: *const LayerModel, link_id: u32) u32 {
        var count: u32 = 0;
        for (self.labels) |row| {
            var index: u32 = 0;
            while (index < self.byte_count) : (index += 1) {
                const value = row[index];
                if (value == 0 or (index > 0 and row[index - 1] == value)) continue;
                count += @intFromBool(self.pieces.items[value - 1].link_id == link_id);
            }
        }
        return count;
    }

    fn expectEqual(self: *const LayerModel, layers: *const hl.Layers, layer_ids: []const u32) !void {
        try testing.expectEqual(self.layerCount(), layers.count);
        for (layer_ids, 0..) |layer_id, layer| {
            const actual = runsOf(layers, layer_id);
            const row = self.labels[layer][0..self.byte_count];
            var index: u32 = 0;
            var run_index: usize = 0;
            while (index < row.len) {
                const value = row[index];
                var end = index;
                while (end < row.len and row[end] == value) end += 1;
                if (value != 0) {
                    try testing.expect(run_index < actual.len);
                    const piece = self.pieces.items[value - 1];
                    try testing.expectEqual(LayerRun{ .start_byte = index, .end_byte = end, .group_set = piece.group_set, .link_id = piece.link_id }, actual[run_index]);
                    run_index += 1;
                }
                index = end;
            }
            try testing.expectEqual(actual.len, run_index);
        }
    }
};

fn randomRuns(random: std.Random, buffer: []LayerRun, start: u32, end: u32, link_ids: []const u32) []const LayerRun {
    var count: usize = 0;
    var at = start;
    while (count < buffer.len) {
        at += random.uintAtMost(u32, 3);
        const length = 1 + random.uintAtMost(u32, 5);
        if (at + length > end) break;
        buffer[count] = .{ .start_byte = at, .end_byte = at + length, .group_set = 1 + random.uintLessThan(u32, 3), .link_id = link_ids[random.uintLessThan(usize, link_ids.len)] };
        count += 1;
        at += length;
    }
    return buffer[0..count];
}

test "layers: random sets, edits and resets match a byte model and hold one link reference per linked run" {
    var links = link.LinkPool.init(gpa);
    defer links.deinit();
    const link_ids = [_]u32{ 0, try links.acquire("https://a.example"), try links.acquire("https://b.example") };
    const layer_ids = [_]u32{ 3, 9, 1, 12, 7, 2 };
    for (0..24) |seed| {
        var prng = std.Random.DefaultPrng.init(seed);
        const random = prng.random();
        var layers: hl.Layers = .{};
        defer layers.reset(gpa, &links);
        var model: LayerModel = .{ .byte_count = 64 };
        defer model.deinit();
        for (0..200) |_| {
            switch (random.uintLessThan(u8, 10)) {
                0...4 => {
                    const layer = random.uintLessThan(usize, layer_ids.len);
                    const start = random.uintAtMost(u32, model.byte_count);
                    const end = start + random.uintAtMost(u32, model.byte_count - start);
                    var buffer: [8]LayerRun = undefined;
                    const runs = if (random.uintLessThan(u8, 4) == 0) &.{} else randomRuns(random, &buffer, start, end, &link_ids);
                    // A failing allocation leaves the layers and the references as they were.
                    var failing = std.testing.FailingAllocator.init(gpa, .{ .fail_index = random.uintAtMost(usize, 2) });
                    const allocator = if (random.boolean()) failing.allocator() else gpa;
                    if (layers.set(allocator, &links, layer_ids[layer], start, end, runs)) |_| {
                        try testing.expect(!try model.set(layer, start, end, runs));
                    } else |err| switch (err) {
                        error.OutOfMemory => try testing.expect(failing.has_induced_failure),
                        error.LayerLimit => try testing.expect(try model.set(layer, start, end, runs)),
                        else => return err,
                    }
                },
                5, 6 => if (model.byte_count < LayerModel.byte_count_max - 8) {
                    const at = random.uintAtMost(u32, model.byte_count);
                    const count = 1 + random.uintAtMost(u32, 7);
                    layers.insertBytes(at, count);
                    model.insert(at, count);
                },
                7, 8 => {
                    const start = random.uintAtMost(u32, model.byte_count);
                    const end = start + random.uintAtMost(u32, @min(model.byte_count - start, 12));
                    layers.deleteBytes(gpa, &links, start, end);
                    model.delete(start, end);
                },
                else => if (random.uintLessThan(u8, 4) == 0) {
                    layers.reset(gpa, &links);
                    model.reset();
                },
            }
            try model.expectEqual(&layers, &layer_ids);
            for (link_ids[1..]) |id| try testing.expectEqual(1 + model.linkedPieces(id), try links.getRefcount(id));
        }
    }
    for (link_ids[1..]) |id| try testing.expectEqual(@as(u32, 1), try links.getRefcount(id));
}

test "layers: a run with a dead link rejects the set and returns the references it took" {
    var links = link.LinkPool.init(gpa);
    defer links.deinit();
    const live = try links.acquire("https://live.example");
    const dead = try links.acquire("https://dead.example");
    try links.decref(dead);
    var layers: hl.Layers = .{};
    defer layers.reset(gpa, &links);
    try layers.set(gpa, &links, 1, 0, 10, &.{.{ .start_byte = 0, .end_byte = 10, .group_set = 1, .link_id = live }});
    try testing.expectEqual(@as(u32, 2), try links.getRefcount(live));
    try testing.expectError(error.InvalidId, layers.set(gpa, &links, 1, 2, 8, &.{
        .{ .start_byte = 2, .end_byte = 3, .group_set = 1, .link_id = live },
        .{ .start_byte = 4, .end_byte = 5, .group_set = 1, .link_id = dead },
    }));
    try testing.expectEqual(@as(u32, 2), try links.getRefcount(live));
    try expectRuns(&.{.{ 0, 10, 1 }}, runsOf(&layers, 1));
    // The split keeps both outside parts, each holding a reference.
    try layers.set(gpa, &links, 1, 2, 8, &.{});
    try testing.expectEqual(@as(u32, 3), try links.getRefcount(live));
    layers.reset(gpa, &links);
    try testing.expectEqual(@as(u32, 1), try links.getRefcount(live));
}

/// A buffer with a style that defines `s1`..`s3` and a group set per name (ids 1..3).
const Setup = struct {
    pools: TestPools,
    sets: hl.GroupSets,
    style: *ss.SyntaxStyle,

    fn init(self: *Setup) !void {
        self.pools = TestPools.init(gpa);
        self.sets = hl.GroupSets.init(gpa);
        self.style = try ss.SyntaxStyle.init(gpa);
        for ([_][]const u8{ "s1", "s2", "s3" }, [_]ansi.RGBA{ red, green, blue }, 1..) |name, color, id| {
            try testing.expectEqual(@as(u32, @intCast(id)), try self.style.registerStyle(name, color, null, @intCast(id)));
            try testing.expectEqual(@as(u32, @intCast(id)), try self.sets.intern(&.{name}));
        }
    }

    fn deinit(self: *Setup) void {
        self.style.deinit();
        self.sets.deinit();
        self.pools.deinit();
    }

    fn buffer(self: *Setup, method: utf8.WidthMethod) !*TextBuffer {
        const tb = try TextBuffer.initWithOptions(gpa, &self.pools.graphemes, &self.pools.links, method, .{ .group_sets = &self.sets });
        tb.setSyntaxStyle(self.style);
        return tb;
    }

    fn screen(self: *Setup, width: u32, height: u32) !*OptimizedBuffer {
        return OptimizedBuffer.init(gpa, width, height, .{ .pool = &self.pools.graphemes, .link_pool = &self.pools.links });
    }
};

fn paint(setup: *Setup, tb: *TextBuffer, width: u32, height: u32) !*OptimizedBuffer {
    const view = try TextBufferView.init(gpa, tb);
    defer view.deinit();
    view.setViewport(.{ .x = 0, .y = 0, .width = width, .height = height });
    const screen = try setup.screen(width, height);
    errdefer screen.deinit();
    try screen.drawTextBufferChecked(view, 0, 0);
    return screen;
}

fn expectSameCells(expected: *const OptimizedBuffer, actual: *const OptimizedBuffer, id: []const u8) !void {
    var y: u32 = 0;
    while (y < expected.height) : (y += 1) {
        var x: u32 = 0;
        while (x < expected.width) : (x += 1) {
            const want = expected.get(x, y).?;
            const got = actual.get(x, y).?;
            if (std.meta.eql(want, got)) continue;
            std.debug.print("row {s}: cell {d},{d} differs\n", .{ id, x, y });
            return testing.expectEqualDeep(want, got);
        }
    }
}

// Invariant 2: on the text corpus, a layer and per-record adds over the same in-bounds,
// disjoint ranges draw the same cells.
test "layers: corpus lines draw the same cells from a layer as from legacy records" {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const corpus = try std.json.parseFromSliceLeaky(Value, arena, @embedFile("fixtures/text-corpus.json"), .{});
    var setup: Setup = undefined;
    try setup.init();
    defer setup.deinit();
    var compared: usize = 0;
    for (corpus.object.get("rows").?.array.items) |row| {
        const text = (row.object.get("text") orelse continue).string;
        for ([_]utf8.WidthMethod{ .unicode, .wcwidth }) |method| {
            const legacy = try setup.buffer(method);
            defer legacy.deinit();
            const layered = try setup.buffer(method);
            defer layered.deinit();
            const tab: u8 = if (row.object.get("tab")) |value| @intCast(value.integer) else 4;
            const control: utf8.ControlDisplay = if (row.object.get("control")) |value| std.meta.stringToEnum(utf8.ControlDisplay, value.string).? else .hidden;
            for ([_]*TextBuffer{ legacy, layered }) |tb| {
                tb.setTabWidth(tab);
                tb.control_display = control;
                try tb.setText(text);
            }
            const plain = try arena.alloc(u8, legacy.getByteSize() + 1);
            const plain_len = legacy.getPlainTextIntoBuffer(plain);
            try testing.expectEqual(legacy.getByteSize(), @as(u32, @intCast(plain_len)));
            var runs: std.ArrayListUnmanaged(LayerRun) = .empty;
            var lines = std.mem.splitScalar(u8, plain[0..plain_len], '\n');
            var line_start: u32 = 0;
            var row_index: usize = 0;
            var width: u32 = 1;
            while (lines.next()) |line| : (row_index += 1) {
                var cursor: utf8.TextWidthCursor = .{ .text = line, .tab_width = legacy.tab_width, .control_display = control, .width_method = method };
                var token: u32 = 0;
                while (cursor.byte_offset < line.len) : (token += 1) {
                    const start_byte = cursor.byte_offset;
                    const start_col = cursor.columns;
                    for (0..1 + token % 3) |_| if (cursor.byte_offset < line.len) {
                        _ = cursor.advanceTo(cursor.byte_offset + 1);
                    };
                    if (token % 2 == 1 or cursor.columns == start_col) continue;
                    const group_set = 1 + (token / 2) % 3;
                    try legacy.addHighlight(row_index, start_col, cursor.columns, group_set, 0, 0);
                    try runs.append(arena, .{ .start_byte = line_start + @as(u32, @intCast(start_byte)), .end_byte = line_start + @as(u32, @intCast(cursor.byte_offset)), .group_set = group_set });
                }
                width = @max(width, cursor.columns + 1);
                line_start += @as(u32, @intCast(line.len)) + 1;
            }
            try layered.setLayer(1, 0, layered.getByteSize(), runs.items);
            const height: u32 = @intCast(@min(row_index, 64));
            width = @min(width, 256);
            const expected = try paint(&setup, legacy, width, height);
            defer expected.deinit();
            const actual = try paint(&setup, layered, width, height);
            defer actual.deinit();
            try expectSameCells(expected, actual, row.object.get("id").?.string);
            compared += 1;
        }
    }
    try testing.expect(compared > 500);
}

fn ignore(_: *anyopaque) void {}

fn plainText(tb: *TextBuffer, buffer: []u8) []const u8 {
    return buffer[0..tb.getPlainTextIntoBuffer(buffer)];
}

/// Row and display column of text byte `byte`; `text` holds one-column and two-column characters,
/// tabs `tab` columns wide, and line breaks only.
fn coordsOf(text: []const u8, byte: u32, tab: u32) Cursor {
    var cursor: Cursor = .{ .row = 0, .col = 0 };
    var index: usize = 0;
    while (index < byte) {
        const length = std.unicode.utf8ByteSequenceLength(text[index]) catch unreachable;
        if (text[index] == '\n') {
            cursor.row += 1;
            cursor.col = 0;
        } else cursor.col += charCols(text[index], length, tab);
        index += length;
    }
    return cursor;
}

/// A character boundary of `text` in `[start, start + length_max]`, or the next one after it.
fn charCols(first: u8, length: u32, tab: u32) u32 {
    if (first == '\t') return tab;
    return if (length == 3) 2 else 1;
}

fn randomBoundary(random: std.Random, text: []const u8, start: u32, length_max: u32) u32 {
    var byte = start + random.uintAtMost(u32, @min(length_max, @as(u32, @intCast(text.len)) - start));
    while (byte < text.len and text[byte] & 0xC0 == 0x80) byte += 1;
    return byte;
}

// Invariant 5: editor inserts, deletes and replacements move layer runs as the byte model says.
test "layers: editor edits move runs like the byte model" {
    var setup: Setup = undefined;
    try setup.init();
    defer setup.deinit();
    const inserts = [_][]const u8{ "a", "\u{e9}", "\u{4e16}", "\n", "xy", "b\nc" };
    for (0..16) |seed| {
        var prng = std.Random.DefaultPrng.init(seed);
        const random = prng.random();
        const eb = try EditBuffer.initWithOptions(gpa, &setup.pools.graphemes, &setup.pools.links, .unicode, null, .{ .group_sets = &setup.sets });
        defer eb.deinit();
        try eb.setText("alpha \u{4e16}\u{754c}\nbeta \u{e9}t\u{e9}\n\ngamma");
        var model_text: std.ArrayListUnmanaged(u8) = .empty;
        defer model_text.deinit(gpa);
        var text_buffer_bytes: [LayerModel.byte_count_max + 64]u8 = undefined;
        try model_text.appendSlice(gpa, plainText(eb.tb, &text_buffer_bytes));
        var model: LayerModel = .{ .byte_count = @intCast(model_text.items.len) };
        defer model.deinit();
        const layer_ids = [_]u32{ 1, 2 };
        const max = std.math.maxInt(u32);
        const model_tab: u32 = 2;
        for (0..120) |_| {
            const text = model_text.items;
            switch (random.uintLessThan(u8, 8)) {
                0, 1 => {
                    const layer = random.uintLessThan(usize, layer_ids.len);
                    const start = randomBoundary(random, text, 0, max);
                    const end = randomBoundary(random, text, start, max);
                    var buffer: [8]LayerRun = undefined;
                    var runs = randomRuns(random, &buffer, start, end, &.{0});
                    // Runs end on character boundaries.
                    var kept: usize = 0;
                    for (runs) |run| {
                        if (run.start_byte < text.len and text[run.start_byte] & 0xC0 == 0x80) continue;
                        if (run.end_byte < text.len and text[run.end_byte] & 0xC0 == 0x80) continue;
                        buffer[kept] = run;
                        kept += 1;
                    }
                    runs = buffer[0..kept];
                    try eb.tb.setLayer(layer_ids[layer], start, end, runs);
                    try testing.expect(!try model.set(layer, start, end, runs));
                },
                2, 3, 4 => if (text.len < LayerModel.byte_count_max - 8) {
                    const at = randomBoundary(random, text, 0, max);
                    const bytes = inserts[random.uintLessThan(usize, inserts.len)];
                    const cursor = coordsOf(text, at, model_tab);
                    try eb.setCursor(cursor.row, cursor.col);
                    try eb.insertText(bytes);
                    model.insert(at, @intCast(bytes.len));
                    try model_text.insertSlice(gpa, at, bytes);
                },
                5, 6 => {
                    const start = randomBoundary(random, text, 0, max);
                    const end = randomBoundary(random, text, start, 10);
                    try eb.deleteRange(coordsOf(text, start, model_tab), coordsOf(text, end, model_tab));
                    model.delete(start, end);
                    try model_text.replaceRange(gpa, start, end - start, "");
                },
                else => {
                    const start = randomBoundary(random, text, 0, max);
                    const end = randomBoundary(random, text, start, 6);
                    const bytes = inserts[random.uintLessThan(usize, inserts.len)];
                    const start_cursor = coordsOf(text, start, model_tab);
                    const end_cursor = coordsOf(text, end, model_tab);
                    const rope = eb.tb.rope();
                    const start_offset = iter_mod.coordsToOffset(rope, start_cursor.row, start_cursor.col).?;
                    const end_offset = iter_mod.coordsToOffset(rope, end_cursor.row, end_cursor.col).?;
                    try eb.setCursor(start_cursor.row, start_cursor.col);
                    try eb.replaceRange(start_offset, end_offset, bytes, .{ .ctx = eb, .handle = ignore });
                    model.delete(start, end);
                    model.insert(start, @intCast(bytes.len));
                    try model_text.replaceRange(gpa, start, end - start, bytes);
                },
            }
            try testing.expectEqualStrings(model_text.items, plainText(eb.tb, &text_buffer_bytes));
            try model.expectEqual(&eb.tb.layers, &layer_ids);
        }
    }
}

// Zero-width text takes no cells, so a cell position next to it names two byte positions. Runs
// must follow the characters they cover wherever the editor puts the edit.
test "layers: edits beside zero-width text keep runs on their characters" {
    var setup: Setup = undefined;
    try setup.init();
    defer setup.deinit();
    const zwsp = "\u{200b}";
    // Each row: the text, where an edit puts the zero-width character (null: the text has it),
    // the edit column, and whether the edit deletes the next character instead of inserting "x".
    for ([_]struct { []const u8, ?u32, u32, bool }{
        .{ "abc", 0, 0, false },
        .{ "abc", 0, 0, true },
        .{ "abc", 1, 1, false },
        .{ "abc", 1, 1, true },
        .{ "abc", 3, 3, false },
        .{ "abc", 2, 1, true },
        .{ "z\nabc", null, 0, false },
        .{ "z\nabc", null, 0, true },
        .{ "a\u{200b}bc", null, 1, false },
        .{ "a\u{200b}bc", null, 1, true },
        .{ "\u{200b}abc", null, 0, false },
        .{ "\u{200b}abc", null, 0, true },
    }, 0..) |row, index| {
        errdefer std.debug.print("zero-width row {d}\n", .{index});
        const eb = try EditBuffer.initWithOptions(gpa, &setup.pools.graphemes, &setup.pools.links, .unicode, null, .{ .group_sets = &setup.sets });
        defer eb.deinit();
        try eb.setText(row[0]);
        if (row[1]) |col| {
            try eb.setCursor(0, col);
            try eb.insertText(zwsp);
        } else if (std.mem.indexOf(u8, row[0], zwsp) == null) {
            try eb.setCursor(1, 0);
            try eb.insertText(zwsp);
        }
        const edit_row: u32 = if (std.mem.indexOfScalar(u8, row[0], '\n') != null) 1 else 0;
        var bytes: [64]u8 = undefined;
        const before = plainText(eb.tb, &bytes);
        const zero_at: u32 = @intCast(std.mem.indexOf(u8, before, zwsp).?);
        // One run per character, the zero-width one included, each with its own group set.
        var runs: [8]LayerRun = undefined;
        var count: usize = 0;
        var byte: u32 = 0;
        while (byte < before.len) : (count += 1) {
            const length: u32 = if (byte == zero_at) 3 else std.unicode.utf8ByteSequenceLength(before[byte]) catch unreachable;
            runs[count] = .{ .start_byte = byte, .end_byte = byte + length, .group_set = if (byte == zero_at) 2 else 1 };
            byte += length;
        }
        try eb.tb.setLayer(1, 0, byte, runs[0..count]);
        try eb.setCursor(edit_row, row[2]);
        if (row[3]) try eb.deleteForward() else try eb.insertText("x");
        var after_bytes: [64]u8 = undefined;
        const after = plainText(eb.tb, &after_bytes);
        // Every surviving run still covers one character of its kind.
        const actual = runsOf(&eb.tb.layers, 1);
        var covered: usize = 0;
        for (actual) |run| {
            const slice = after[run.start_byte..run.end_byte];
            if (run.group_set == 2) {
                try testing.expectEqualStrings(zwsp, slice);
            } else {
                try testing.expectEqual(@as(usize, 1), slice.len);
                try testing.expect(slice[0] != 'x');
            }
            covered += slice.len;
        }
        // Runs cover every character but an inserted "x".
        try testing.expectEqual(after.len - @intFromBool(!row[3]), covered);
    }
}

// Invariant 5, second half: every whole-text change and CLEAR_ALL empties the layers and gives
// back their link references; legacy records follow their own rules.
test "layers: whole-text changes, history and clear all empty the layers" {
    var setup: Setup = undefined;
    try setup.init();
    defer setup.deinit();
    const url = try setup.pools.links.acquire("https://example.com");
    const Change = enum { set_text, clear, reset, styled_text, undo, redo, clear_all, edit_set_text, edit_clear };
    for (std.enums.values(Change)) |change| {
        const eb = try EditBuffer.initWithOptions(gpa, &setup.pools.graphemes, &setup.pools.links, .unicode, null, .{ .group_sets = &setup.sets });
        defer eb.deinit();
        const tb = eb.tb;
        try eb.setText("one\ntwo");
        try eb.setCursor(0, 3);
        try eb.insertText("!");
        if (change == .redo) _ = try eb.undo();
        try tb.setLayer(1, 0, 7, &.{.{ .start_byte = 0, .end_byte = 3, .group_set = 1, .link_id = url }});
        try tb.setLayer(4, 0, 7, &.{.{ .start_byte = 5, .end_byte = 7, .group_set = 2 }});
        try testing.expectEqual(@as(u32, 2), try setup.pools.links.getRefcount(url));
        switch (change) {
            .set_text => try tb.setText("other"),
            .clear => try tb.clear(),
            .reset => try tb.reset(),
            .styled_text => _ = try owned_styled.replace(tb, null, &.{.{ .text = "styled", .fg = red }}),
            .undo => _ = try eb.undo(),
            .redo => _ = try eb.redo(),
            .clear_all => tb.clearAllHighlights(),
            .edit_set_text => try eb.setText("other"),
            .edit_clear => try eb.clear(),
        }
        try testing.expect(tb.layers.isEmpty());
        try testing.expectEqual(@as(u32, 1), try setup.pools.links.getRefcount(url));
    }
}

test "layers: setLayer rejects bad ids, ranges and boundaries, and failed memory, without a change" {
    var setup: Setup = undefined;
    try setup.init();
    defer setup.deinit();
    const tb = try setup.buffer(.unicode);
    defer tb.deinit();
    try tb.setText("a\u{4e16}b\ncd");
    // Bytes: a=0, the CJK character 1..4, b=4, break=5, c=6, d=7; 8 in all.
    try tb.setLayer(2, 0, 8, &.{.{ .start_byte = 6, .end_byte = 8, .group_set = 3 }});
    for ([_]struct { anyerror, LayerRun }{
        .{ error.InvalidId, .{ .start_byte = 0, .end_byte = 1, .group_set = 0 } },
        .{ error.InvalidId, .{ .start_byte = 0, .end_byte = 1, .group_set = 4 } },
        .{ error.InvalidIndex, .{ .start_byte = 7, .end_byte = 9, .group_set = 1 } },
        .{ error.InvalidIndex, .{ .start_byte = 2, .end_byte = 4, .group_set = 1 } },
        .{ error.InvalidIndex, .{ .start_byte = 1, .end_byte = 3, .group_set = 1 } },
    }) |row| {
        try testing.expectError(row[0], tb.setLayer(2, 0, 8, &.{row[1]}));
        try expectRuns(&.{.{ 6, 8, 3 }}, runsOf(&tb.layers, 2));
    }
    // Boundaries: the CJK character's ends, the break, and the text end.
    try tb.setLayer(2, 0, 8, &.{ .{ .start_byte = 1, .end_byte = 4, .group_set = 1 }, .{ .start_byte = 5, .end_byte = 8, .group_set = 2 } });
    try expectRuns(&.{ .{ 1, 4, 1 }, .{ 5, 8, 2 } }, runsOf(&tb.layers, 2));
    // Without a Context's group sets, no layer can be set.
    const bare = try TextBuffer.init(gpa, &setup.pools.graphemes, &setup.pools.links, .unicode);
    defer bare.deinit();
    try bare.setText("ab");
    try testing.expectError(error.InvalidId, bare.setLayer(1, 0, 2, &.{.{ .start_byte = 0, .end_byte = 1, .group_set = 1 }}));
    var succeeded = false;
    for (0..8) |fail_index| {
        const generation = tb.span_generation;
        var failing = std.testing.FailingAllocator.init(gpa, .{ .fail_index = fail_index });
        tb.global_allocator = failing.allocator();
        const result = tb.setLayer(3, 0, 8, &.{.{ .start_byte = 0, .end_byte = 1, .group_set = 1 }});
        tb.global_allocator = gpa;
        if (result) |_| {
            succeeded = true;
            break;
        } else |err| try testing.expectEqual(error.OutOfMemory, err);
        try testing.expectEqual(generation, tb.span_generation);
        try testing.expectEqual(@as(u8, 1), tb.layers.count);
    }
    try testing.expect(succeeded);
    try testing.expectEqual(@as(u8, 2), tb.layers.count);
}

// Invariant 3: one layer of k runs, or k mutually overlapping records, on one line costs one
// span build whose heap work grows as k log k; the paint draws the winning style.
test "layers: span work for k runs or k overlapping records on one line is O(k log k)" {
    var setup: Setup = undefined;
    try setup.init();
    defer setup.deinit();
    for ([_]u32{ 1_000, 4_000 }) |k| {
        const text = try gpa.alloc(u8, 4 * k);
        defer gpa.free(text);
        for (0..k) |index| @memcpy(text[4 * index ..][0..4], "abc ");
        const log_k = std.math.log2_int_ceil(u32, k);
        for ([_]bool{ false, true }) |overlapping| {
            const tb = try setup.buffer(.unicode);
            defer tb.deinit();
            try tb.setText(text);
            const view = try TextBufferView.init(gpa, tb);
            defer view.deinit();
            view.setViewport(.{ .x = 0, .y = 0, .width = 80, .height = 1 });
            const screen = try setup.screen(80, 1);
            defer screen.deinit();
            try screen.drawTextBufferChecked(view, 0, 0);
            if (overlapping) {
                // Nested ranges [i, 4k - i); the highest priority covers column 0.
                for (0..k) |index| {
                    const i: u32 = @intCast(index);
                    try tb.addHighlight(0, i, 4 * k - i, 1 + i % 3, @intCast((k - i) % 200), 0);
                }
            } else {
                const runs = try gpa.alloc(LayerRun, k);
                defer gpa.free(runs);
                for (runs, 0..) |*run, index| {
                    const start: u32 = @intCast(4 * index);
                    run.* = .{ .start_byte = start, .end_byte = start + 3, .group_set = 1 + @as(u32, @intCast(index % 3)) };
                }
                try tb.setLayer(1, 0, tb.getByteSize(), runs);
            }
            _ = text_work.take();
            try screen.drawTextBufferChecked(view, 0, 0);
            const work = text_work.take();
            try testing.expectEqual(@as(u64, 1), work.line_span_builds);
            try testing.expectEqual(@as(u64, k), work.line_span_highlights);
            try testing.expect(work.span_heap_steps <= 2 * k * log_k);
            // Column 0: the first run, or the only record there. Column 5: the second run (s2), or
            // of records 0..5 the one with priority 199, record 1 (s2).
            try testing.expectEqual(red, screen.get(0, 0).?.fg);
            try testing.expectEqual(green, screen.get(5, 0).?.fg);
            try testing.expectEqual(@as(u32, 'a'), screen.get(0, 0).?.char);
        }
    }
}

// Highest priority wins a column; on a tie the later input wins: records in the order added,
// then layers in layer_id order (priority 0, above records of priority 0, below priority 1).
test "layers: priority and ties order records and layers" {
    var setup: Setup = undefined;
    try setup.init();
    defer setup.deinit();
    const Record = struct { u32, u32, u32, u8 };
    const Layer = struct { u32, u32, u32, u32 };
    for ([_]struct { []const Record, []const Layer, ansi.RGBA }{
        .{ &.{ .{ 0, 6, 1, 0 }, .{ 0, 6, 2, 0 }, .{ 0, 6, 3, 0 } }, &.{}, blue },
        .{ &.{ .{ 0, 6, 3, 0 }, .{ 0, 6, 2, 0 }, .{ 0, 6, 1, 0 } }, &.{}, red },
        .{ &.{ .{ 0, 6, 3, 0 }, .{ 0, 6, 1, 0 }, .{ 0, 6, 2, 0 } }, &.{}, green },
        .{ &.{ .{ 0, 6, 3, 1 }, .{ 0, 6, 1, 0 }, .{ 0, 6, 2, 0 } }, &.{}, blue },
        .{ &.{.{ 0, 6, 2, 0 }}, &.{.{ 1, 0, 6, 1 }}, red },
        .{ &.{.{ 0, 6, 2, 1 }}, &.{.{ 1, 0, 6, 1 }}, green },
        .{ &.{}, &.{ .{ 2, 0, 6, 3 }, .{ 1, 0, 6, 1 } }, blue },
        .{ &.{}, &.{ .{ 1, 0, 6, 3 }, .{ 2, 0, 6, 1 } }, red },
    }) |row| {
        const tb = try setup.buffer(.unicode);
        defer tb.deinit();
        try tb.setText("abcdefgh");
        for (row[0]) |record| try tb.addHighlight(0, record[0], record[1], record[2], record[3], 0);
        for (row[1]) |layer| try tb.setLayer(layer[0], 0, 8, &.{.{ .start_byte = layer[1], .end_byte = layer[2], .group_set = layer[3] }});
        const screen = try paint(&setup, tb, 8, 1);
        defer screen.deinit();
        try testing.expectEqual(row[2], screen.get(2, 0).?.fg);
    }
}

// A span build that runs out of memory fails the checked paint and leaves the line stale, so
// the next read builds it again and gets what a clean build gets.
test "layers: a span build without memory fails and leaves the line to rebuild" {
    var setup: Setup = undefined;
    try setup.init();
    defer setup.deinit();
    var expected: [8]text_buffer.StyleSpan = undefined;
    var expected_len: usize = 0;
    var succeeded = false;
    for (0..16) |fail_index| {
        const tb = try setup.buffer(.unicode);
        defer tb.deinit();
        try tb.setText("abcdef\nghij");
        try tb.addHighlight(0, 0, 3, 2, 1, 0);
        try tb.setLayer(1, 0, 11, &.{ .{ .start_byte = 1, .end_byte = 5, .group_set = 1 }, .{ .start_byte = 7, .end_byte = 9, .group_set = 3 } });
        if (fail_index == 0) {
            const clean = try setup.buffer(.unicode);
            defer clean.deinit();
            try clean.setText("abcdef\nghij");
            try clean.addHighlight(0, 0, 3, 2, 1, 0);
            try clean.setLayer(1, 0, 11, &.{ .{ .start_byte = 1, .end_byte = 5, .group_set = 1 }, .{ .start_byte = 7, .end_byte = 9, .group_set = 3 } });
            const spans = try clean.getLineSpans(0);
            @memcpy(expected[0..spans.len], spans);
            expected_len = spans.len;
        }
        var failing = std.testing.FailingAllocator.init(gpa, .{ .fail_index = fail_index });
        tb.global_allocator = failing.allocator();
        const result = tb.getLineSpans(0);
        tb.global_allocator = gpa;
        if (result) |spans| {
            try testing.expectEqualSlices(text_buffer.StyleSpan, expected[0..expected_len], spans);
            succeeded = true;
            break;
        } else |err| try testing.expectEqual(error.OutOfMemory, err);
        if (tb.line_spans.items.len > 0) try testing.expect(tb.line_spans.items[0].generation != tb.span_generation);
        try testing.expectEqualSlices(text_buffer.StyleSpan, expected[0..expected_len], try tb.getLineSpans(0));
    }
    try testing.expect(succeeded);
}

// Invariants 6 and 11: a redefinition or a style swap repaints group-set runs without a span
// rebuild; after a layer change, painted lines carry the current stamp and the rest build nothing.
test "layers: theme changes rebuild no spans and unpainted lines stay unbuilt" {
    var setup: Setup = undefined;
    try setup.init();
    defer setup.deinit();
    const tb = try setup.buffer(.unicode);
    defer tb.deinit();
    var text: [100 * 4]u8 = undefined;
    for (0..100) |index| @memcpy(text[4 * index ..][0..4], "abc\n");
    try tb.setText(text[0 .. text.len - 1]);
    const view = try TextBufferView.init(gpa, tb);
    defer view.deinit();
    view.setViewport(.{ .x = 0, .y = 0, .width = 8, .height = 10 });
    const screen = try setup.screen(8, 10);
    defer screen.deinit();
    try screen.drawTextBufferChecked(view, 0, 0);
    try tb.setLayer(1, 0, tb.getByteSize(), &.{ .{ .start_byte = 0, .end_byte = 2, .group_set = 1 }, .{ .start_byte = 200, .end_byte = 202, .group_set = 2 } });
    _ = text_work.take();
    try screen.drawTextBufferChecked(view, 0, 0);
    try testing.expectEqual(@as(u64, 10), text_work.take().line_span_builds);
    for (tb.line_spans.items, 0..) |entry, line| try testing.expectEqual(line < 10, entry.generation == tb.span_generation);
    try testing.expectEqual(red, screen.get(0, 0).?.fg);

    _ = try setup.style.registerStyle("s1", blue, null, 0);
    try screen.drawTextBufferChecked(view, 0, 0);
    try testing.expectEqual(blue, screen.get(0, 0).?.fg);
    const other = try ss.SyntaxStyle.init(gpa);
    defer other.deinit();
    _ = try other.registerStyle("s1", green, null, 0);
    tb.setSyntaxStyle(other);
    try screen.drawTextBufferChecked(view, 0, 0);
    try testing.expectEqual(green, screen.get(0, 0).?.fg);
    try testing.expectEqual(@as(u64, 0), text_work.take().line_span_builds);
    tb.setSyntaxStyle(setup.style);
}

// A tab width change moves the columns under byte runs, so painted lines rebuild.
test "layers: a tab width change moves runs to their new columns" {
    var setup: Setup = undefined;
    try setup.init();
    defer setup.deinit();
    const tb = try setup.buffer(.unicode);
    defer tb.deinit();
    tb.setTabWidth(2);
    try tb.setText("\tab");
    try tb.setLayer(1, 0, 3, &.{.{ .start_byte = 1, .end_byte = 2, .group_set = 1 }});
    const view = try TextBufferView.init(gpa, tb);
    defer view.deinit();
    view.setViewport(.{ .x = 0, .y = 0, .width = 8, .height = 1 });
    for ([_]struct { u8, u32 }{ .{ 2, 2 }, .{ 4, 4 }, .{ 2, 2 } }) |row| {
        tb.setTabWidth(row[0]);
        const screen = try setup.screen(8, 1);
        defer screen.deinit();
        try screen.drawTextBufferChecked(view, 0, 0);
        for (0..6) |x| try testing.expectEqual(x == row[1], std.meta.eql(red, screen.get(@intCast(x), 0).?.fg));
    }
}

// Invariant 10: group set 1 in a layer, SyntaxStyle id 1 in a record, and a styled-text value
// style share one line and each paints its own style.
test "layers: span kinds keep group sets, style ids and run styles apart" {
    var setup: Setup = undefined;
    try setup.init();
    defer setup.deinit();
    const tb = try setup.buffer(.unicode);
    defer tb.deinit();
    // Styled text covers its parts with priority 1, so the rest comes as plain appended text.
    _ = try owned_styled.replace(tb, null, &.{.{ .text = "abc", .fg = blue }});
    try tb.append("defghi");
    const swapped = try setup.sets.intern(&.{ "s3", "s2" });
    try testing.expectEqual(@as(u32, 4), swapped);
    try tb.addHighlight(0, 3, 6, 1, 0, 0);
    // Group set 2 is ["s2"] (green); SyntaxStyle id 2 is the same name, so use set 4 ["s3", "s2"].
    try tb.setLayer(1, 0, 9, &.{.{ .start_byte = 6, .end_byte = 9, .group_set = swapped }});
    const screen = try paint(&setup, tb, 10, 1);
    defer screen.deinit();
    for ([_]ansi.RGBA{ blue, blue, blue, red, red, red, green, green, green }, 0..) |want, x| {
        try testing.expectEqual(want, screen.get(@intCast(x), 0).?.fg);
    }
    // Attributes OR across a set: s3 is 3, s2 is 2.
    try testing.expectEqual(@as(u32, 3), screen.get(6, 0).?.attributes & ansi.TextAttributes.ATTRIBUTE_BASE_MASK);
}

// Invariant 8 at paint: a run's link reaches the drawn cell. A run across a line break paints
// on both lines.
test "layers: a linked run paints its link id, and a run crosses lines" {
    var setup: Setup = undefined;
    try setup.init();
    defer setup.deinit();
    const tb = try setup.buffer(.unicode);
    defer tb.deinit();
    try tb.setText("link here\nnext");
    const url = try setup.pools.links.acquire("https://example.com");
    defer setup.pools.links.decref(url) catch unreachable;
    try tb.setLayer(1, 0, 14, &.{
        .{ .start_byte = 0, .end_byte = 4, .group_set = 1, .link_id = url },
        .{ .start_byte = 7, .end_byte = 12, .group_set = 2 },
    });
    const screen = try paint(&setup, tb, 10, 2);
    defer screen.deinit();
    try testing.expectEqual(url, ansi.TextAttributes.getLinkId(screen.get(0, 0).?.attributes));
    try testing.expectEqual(@as(u32, 0), ansi.TextAttributes.getLinkId(screen.get(5, 0).?.attributes));
    for ([_]struct { u32, u32, bool }{ .{ 6, 0, false }, .{ 7, 0, true }, .{ 8, 0, true }, .{ 0, 1, true }, .{ 1, 1, true }, .{ 2, 1, false } }) |cell| {
        try testing.expectEqual(cell[2], std.meta.eql(green, screen.get(cell[0], cell[1]).?.fg));
    }
}

/// Reference for the span model test: the legacy records per line in add order, the layers as
/// a byte model, the text, and the colors each style gives each name. Paint is recomputed from
/// scratch per character: the highest priority wins, ties go to the later input (records in add
/// order, then layers by id, priority 0).
const SpanModel = struct {
    const line_count_max = 16;
    const names = [_][]const u8{ "s1", "s2", "s3" };
    /// Group sets 1..3 are one name each; 4 is ["s3", "s2"]; 5 falls back to s1.
    const sets = [_][]const []const u8{ &.{"s1"}, &.{"s2"}, &.{"s3"}, &.{ "s3", "s2" }, &.{"s1.extra"} };
    const palette = [_]ansi.RGBA{ red, green, blue, ansi.rgbColor(9, 9, 9, 255), ansi.rgbColor(200, 100, 0, 255) };
    const Record = struct { col_start: u32, col_end: u32, style_id: u32, priority: u8, ref: u16 };

    records: [line_count_max * 4][32]Record = undefined,
    record_counts: [line_count_max * 4]usize = @splat(0),
    layers: LayerModel,
    text: std.ArrayListUnmanaged(u8) = .empty,
    /// Per style (A, B), per name: its color.
    colors: [2][names.len]ansi.RGBA = .{ .{ red, green, blue }, .{ blue, red, green } },
    bound: usize = 0,
    tab_width: u32 = 2,

    fn deinit(self: *SpanModel) void {
        self.text.deinit(gpa);
        self.layers.deinit();
    }

    fn lineCount(self: *const SpanModel) u32 {
        return @intCast(std.mem.count(u8, self.text.items, "\n") + 1);
    }

    fn nameColor(self: *const SpanModel, name: []const u8) ?ansi.RGBA {
        for (names, 0..) |known, index| if (std.mem.eql(u8, known, name)) return self.colors[self.bound][index];
        return null;
    }

    fn setColor(self: *const SpanModel, group_set: u32) ?ansi.RGBA {
        var result: ?ansi.RGBA = null;
        for (sets[group_set - 1]) |name| {
            const color = self.nameColor(name) orelse self.nameColor(name[0 .. std.mem.indexOfScalar(u8, name, '.') orelse continue]) orelse continue;
            result = color;
        }
        return result;
    }

    /// The color a character at `byte`, column `col` of line `row` paints in, or null for the default.
    fn expected(self: *const SpanModel, row: u32, col: u32, byte: u32, layer_count: usize) ?ansi.RGBA {
        var best_priority: i16 = -1;
        var best: ?ansi.RGBA = null;
        for (self.records[row][0..self.record_counts[row]]) |record| {
            if (col < record.col_start or col >= record.col_end or record.priority < best_priority) continue;
            best_priority = record.priority;
            best = if (record.style_id >= 1 and record.style_id <= names.len) self.colors[self.bound][record.style_id - 1] else null;
        }
        for (self.layers.labels[0..layer_count]) |labels| {
            const label = labels[byte];
            if (label == 0 or best_priority > 0) continue;
            best_priority = 0;
            best = self.setColor(self.layers.pieces.items[label - 1].group_set);
        }
        return best;
    }
};

// The span model (work file `tracks/c3-1-highlight-layers.md`): random legacy adds, removals and
// clears, layer sets, edits, whole-text replacement, CLEAR_ALL, theme redefinitions and rebinds,
// checked at every paint against cells recomputed from scratch, with get_highlights equal to the
// records, spans equal to a fresh build, and layer runs equal to the byte model. 24 seeds of 160
// events: about 130 ms and 11 MB in a debug build.
test "layers: seeded span model of records, layers, edits and themes matches every paint" {
    var setup: Setup = undefined;
    try setup.init();
    defer setup.deinit();
    for (SpanModel.sets[3..]) |names| _ = try setup.sets.intern(names);
    const other = try ss.SyntaxStyle.init(gpa);
    defer other.deinit();
    for (SpanModel.names, [_]ansi.RGBA{ blue, red, green }) |name, color| _ = try other.registerStyle(name, color, null, 0);
    const styles = [_]*ss.SyntaxStyle{ setup.style, other };
    const gray = ansi.rgbColor(128, 128, 128, 255);
    const layer_ids = [_]u32{ 1, 2, 3, 4, 5, 6 };
    const inserts = [_][]const u8{ "a", "\u{e9}", "\u{4e16}", "\n", "xyz", "b\nc", "\t" };
    for (0..24) |seed| {
        var prng = std.Random.DefaultPrng.init(seed);
        const random = prng.random();
        // Each seed starts from the first theme again.
        for (SpanModel.names, [_]ansi.RGBA{ red, green, blue }) |name, color| _ = try setup.style.registerStyle(name, color, null, 0);
        for (SpanModel.names, [_]ansi.RGBA{ blue, red, green }) |name, color| _ = try other.registerStyle(name, color, null, 0);
        const eb = try EditBuffer.initWithOptions(gpa, &setup.pools.graphemes, &setup.pools.links, .unicode, null, .{ .group_sets = &setup.sets });
        defer eb.deinit();
        const tb = eb.tb;
        tb.setSyntaxStyle(setup.style);
        tb.setDefaultFg(gray);
        tb.setTabWidth(2);
        try eb.setText("al\tpha \u{4e16}\n\tbeta \u{e9}t\u{e9}\n\ngamma");
        const view = try TextBufferView.init(gpa, tb);
        defer view.deinit();
        view.setViewport(.{ .x = 0, .y = 0, .width = 64, .height = SpanModel.line_count_max });
        var model: SpanModel = .{ .layers = .{ .byte_count = 0 } };
        defer model.deinit();
        var bytes: [LayerModel.byte_count_max + 64]u8 = undefined;
        try model.text.appendSlice(gpa, plainText(tb, &bytes));
        model.layers.byte_count = @intCast(model.text.items.len);
        const max = std.math.maxInt(u32);
        for (0..160) |_| {
            const text = model.text.items;
            const model_tab = model.tab_width;
            const room = text.len < 160 and model.lineCount() < SpanModel.line_count_max - 2;
            switch (random.uintLessThan(u8, 16)) {
                0, 1, 2 => {
                    const row = random.uintAtMost(u32, model.lineCount());
                    const start = random.uintAtMost(u32, 16);
                    const record: SpanModel.Record = .{ .col_start = start, .col_end = start + 1 + random.uintAtMost(u32, 7), .style_id = 1 + random.uintAtMost(u32, 3), .priority = random.uintAtMost(u8, 2), .ref = random.uintAtMost(u16, 3) };
                    // The model holds 32 records a line; a full line takes no more.
                    if (row < model.lineCount() and model.record_counts[row] == 32) continue;
                    const result = tb.addHighlight(row, record.col_start, record.col_end, record.style_id, record.priority, record.ref);
                    if (row >= model.lineCount()) {
                        try testing.expectError(error.InvalidIndex, result);
                    } else {
                        try result;
                        model.records[row][model.record_counts[row]] = record;
                        model.record_counts[row] += 1;
                    }
                },
                3 => {
                    const ref = random.uintAtMost(u16, 3);
                    tb.removeHighlightsByRef(ref);
                    for (&model.records, &model.record_counts) |*list, *count| {
                        var kept: usize = 0;
                        for (list[0..count.*]) |record| if (record.ref != ref) {
                            list[kept] = record;
                            kept += 1;
                        };
                        count.* = kept;
                    }
                },
                4 => {
                    const row = random.uintAtMost(u32, model.lineCount());
                    tb.clearLineHighlights(row);
                    model.record_counts[row] = 0;
                },
                5, 6, 7 => {
                    const layer = random.uintLessThan(usize, layer_ids.len);
                    const start = randomBoundary(random, text, 0, max);
                    const end = randomBoundary(random, text, start, max);
                    var buffer: [8]LayerRun = undefined;
                    var kept: usize = 0;
                    for (randomRuns(random, &buffer, start, end, &.{0})) |run| {
                        if (run.start_byte < text.len and text[run.start_byte] & 0xC0 == 0x80) continue;
                        if (run.end_byte < text.len and text[run.end_byte] & 0xC0 == 0x80) continue;
                        buffer[kept] = run;
                        buffer[kept].group_set = 1 + random.uintLessThan(u32, SpanModel.sets.len);
                        kept += 1;
                    }
                    const result = tb.setLayer(layer_ids[layer], start, end, buffer[0..kept]);
                    if (try model.layers.set(layer, start, end, buffer[0..kept])) try testing.expectError(error.LayerLimit, result) else try result;
                },
                8, 9 => if (room) {
                    const at = randomBoundary(random, text, 0, max);
                    const insert = inserts[random.uintLessThan(usize, inserts.len)];
                    const cursor = coordsOf(text, at, model_tab);
                    try eb.setCursor(cursor.row, cursor.col);
                    try eb.insertText(insert);
                    model.layers.insert(at, @intCast(insert.len));
                    try model.text.insertSlice(gpa, at, insert);
                },
                10 => {
                    const start = randomBoundary(random, text, 0, max);
                    const end = randomBoundary(random, text, start, 8);
                    try eb.deleteRange(coordsOf(text, start, model_tab), coordsOf(text, end, model_tab));
                    model.layers.delete(start, end);
                    try model.text.replaceRange(gpa, start, end - start, "");
                },
                11 => if (random.uintLessThan(u8, 3) == 0) {
                    // Records stay on lines the new text still has; layers empty.
                    const replacement = if (random.boolean()) "one\ntwo" else "a\nb\nc\nd\ne";
                    try eb.setText(replacement);
                    model.text.clearRetainingCapacity();
                    try model.text.appendSlice(gpa, replacement);
                    for (model.record_counts[model.lineCount()..]) |*count| count.* = 0;
                    model.layers.reset();
                    model.layers.byte_count = @intCast(replacement.len);
                },
                12 => if (random.uintLessThan(u8, 3) == 0) {
                    tb.clearAllHighlights();
                    model.record_counts = @splat(0);
                    model.layers.reset();
                },
                13 => {
                    // A theme change touches neither records, runs nor the span stamp.
                    const generation = tb.span_generation;
                    const style = random.uintLessThan(usize, 2);
                    const name = random.uintLessThan(usize, SpanModel.names.len);
                    const color = SpanModel.palette[random.uintLessThan(usize, SpanModel.palette.len)];
                    _ = try styles[style].registerStyle(SpanModel.names[name], color, null, 0);
                    model.colors[style][name] = color;
                    try testing.expectEqual(generation, tb.span_generation);
                    try expectPaint(&setup, &model, tb, view, gray);
                },
                14 => if (random.boolean()) {
                    model.bound = 1 - model.bound;
                    tb.setSyntaxStyle(styles[model.bound]);
                    try expectPaint(&setup, &model, tb, view, gray);
                } else {
                    // Tab cells move under byte runs without a byte changing.
                    model.tab_width = if (model.tab_width == 2) 4 else 2;
                    tb.setTabWidth(@intCast(model.tab_width));
                    try expectPaint(&setup, &model, tb, view, gray);
                },
                else => try expectPaint(&setup, &model, tb, view, gray),
            }
            try testing.expectEqualStrings(model.text.items, plainText(tb, &bytes));
            try model.layers.expectEqual(&tb.layers, &layer_ids);
        }
        try expectPaint(&setup, &model, tb, view, gray);
    }
}

fn expectPaint(setup: *Setup, model: *const SpanModel, tb: *TextBuffer, view: *TextBufferView, default_fg: ansi.RGBA) !void {
    const screen = try setup.screen(64, SpanModel.line_count_max);
    defer screen.deinit();
    try screen.drawTextBufferChecked(view, 0, 0);
    var lines = std.mem.splitScalar(u8, model.text.items, '\n');
    var row: u32 = 0;
    var line_start: u32 = 0;
    while (lines.next()) |line| : (row += 1) {
        // get_highlights reports exactly the records, in add order.
        const actual = tb.getLineHighlights(row);
        try testing.expectEqual(model.record_counts[row], actual.len);
        for (model.records[row][0..model.record_counts[row]], actual) |want, got| {
            try testing.expectEqual(want, SpanModel.Record{ .col_start = got.col_start, .col_end = got.col_end, .style_id = got.style_id, .priority = got.priority, .ref = got.hl_ref });
        }
        // Cached spans equal a fresh build of the same inputs. The stamps go back after, so the
        // next paint still sees only what the events invalidated.
        const cached = try gpa.dupe(text_buffer.StyleSpan, try tb.getLineSpans(row));
        defer gpa.free(cached);
        const generation = tb.span_generation;
        tb.span_generation += 1;
        try testing.expectEqualSlices(text_buffer.StyleSpan, cached, try tb.getLineSpans(row));
        tb.span_generation = generation;
        if (row < tb.line_spans.items.len) tb.line_spans.items[row].generation = generation;
        var byte: u32 = 0;
        var col: u32 = 0;
        while (byte < line.len) {
            const length: u32 = std.unicode.utf8ByteSequenceLength(line[byte]) catch unreachable;
            const want = model.expected(row, col, line_start + byte, model.layers.labels.len) orelse default_fg;
            const cell = screen.get(col, row).?;
            if (!std.meta.eql(want, cell.fg)) {
                std.debug.print("row {d} col {d} byte {d}\n", .{ row, col, line_start + byte });
                try testing.expectEqual(want, cell.fg);
            }
            col += charCols(line[byte], length, model.tab_width);
            byte += length;
        }
        line_start += @as(u32, @intCast(line.len)) + 1;
    }
}
