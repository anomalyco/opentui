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
const c = @import("context_abi_c");
const abi = @import("../context-abi.zig");
const editor_abi = @import("../context-editor-abi.zig");
const text_abi = @import("../context-text-abi.zig");
const context_mod = @import("../context.zig");
const Value = std.json.Value;

const red = ansi.rgbColor(255, 0, 0, 255);
const green = ansi.rgbColor(0, 255, 0, 255);
const blue = ansi.rgbColor(0, 0, 255, 255);

fn nameOf(buffer: []u8, prefix: []const u8, index: usize, length: usize) []const u8 {
    @memset(buffer[0..length], '-');
    const head = std.fmt.bufPrint(buffer, "{s}{d}", .{ prefix, index }) catch unreachable;
    return buffer[0..@max(head.len, length)];
}

test "group sets: malformed lists and each name bound reject without interning" {
    var sets = hl.GroupSets.init(gpa);
    defer sets.deinit();
    const long_bytes: [hl.group_set_name_byte_count_max + 1]u8 = @splat('x');
    const long: []const u8 = &long_bytes;
    const too_many: [hl.group_set_name_count_max + 1][]const u8 = @splat("a");
    const most: [hl.group_set_name_count_max][]const u8 = @splat("a");
    // No names or an empty name is malformed; past a name bound is a limit.
    for ([_]struct { []const []const u8, anyerror }{
        .{ &.{}, error.InvalidIndex },
        .{ &.{""}, error.InvalidIndex },
        .{ &.{ "a", "" }, error.InvalidIndex },
        .{ &too_many, error.GroupSetLimit },
        .{ &.{long}, error.GroupSetLimit },
        .{ &.{ "a", long }, error.GroupSetLimit },
    }) |row| {
        try testing.expectError(row[1], sets.intern(row[0]));
        try testing.expectEqual(@as(u32, 0), sets.count());
        try testing.expectEqual(@as(usize, 0), sets.name_bytes.items.len);
    }
    // Exactly at each name bound is accepted, and equal lists share an id.
    const id = try sets.intern(&most);
    try testing.expectEqual(id, try sets.intern(&most));
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

/// What a registration supplies to composition, decoded by the ABI's rule, not by its code.
const Supplied = struct { fg: ?ss.RGBA = null, bg: ?ss.RGBA = null, value: u8 = 0, mask: u8 = 0 };

/// Fills a random registration record. Returns what it supplies, or null when the ABI must reject
/// it: a mask without attributes, an unknown flag, a set bit outside the mask, or a bit outside
/// both bytes.
fn randomStyleRecord(random: std.Random, record: *c.ot_editor_style) ?Supplied {
    const colors = [_]ss.RGBA{ red, green, blue };
    const attributes_flag = c.OT_EDITOR_STYLE_ATTRIBUTES;
    const mask_flag = c.OT_EDITOR_STYLE_ATTRIBUTE_MASK;
    record.* = .{ .struct_size = @sizeOf(c.ot_editor_style), .abi_version = c.OT_CONTEXT_ABI_VERSION, .flags = 0, .attributes = 0, .foreground = @splat(0), .background = @splat(0) };
    var supplied: Supplied = .{};
    if (random.boolean()) {
        supplied.fg = colors[random.uintLessThan(usize, colors.len)];
        record.flags |= c.OT_EDITOR_STYLE_FOREGROUND;
        record.foreground = supplied.fg.?;
    }
    if (random.boolean()) {
        supplied.bg = colors[random.uintLessThan(usize, colors.len)];
        record.flags |= c.OT_EDITOR_STYLE_BACKGROUND;
        record.background = supplied.bg.?;
    }
    switch (random.uintLessThan(u32, 3)) {
        0 => {},
        // An old caller: no mask, so all eight bits are supplied.
        1 => {
            supplied.mask = 0xFF;
            supplied.value = random.int(u8);
            record.flags |= attributes_flag;
            record.attributes = supplied.value;
        },
        else => {
            supplied.mask = random.int(u8);
            supplied.value = random.int(u8) & supplied.mask;
            record.flags |= attributes_flag | mask_flag;
            record.attributes = supplied.value | (@as(u32, supplied.mask) << 16);
        },
    }
    if (random.uintLessThan(u32, 8) != 0) return supplied;
    switch (random.uintLessThan(u32, 4)) {
        0 => record.flags = (record.flags & ~@as(u32, attributes_flag)) | mask_flag,
        1 => record.flags |= @as(u32, 1) << random.intRangeAtMost(u5, 4, 31),
        2 => {
            const bit = @as(u32, 1) << random.int(u3);
            record.flags |= attributes_flag | mask_flag;
            record.attributes = bit | ((random.int(u32) & ~bit & 0xFF) << 16);
        },
        else => {
            var shift = random.intRangeAtMost(u5, 8, 31);
            if (record.flags & mask_flag != 0 and shift >= 16 and shift < 24) shift += 8;
            record.attributes |= @as(u32, 1) << shift;
        },
    }
    return null;
}

const FoldCounts = struct { kept: u32 = 0, cleared: u32 = 0 };

/// Design rule: later names win per supplied field; a missing name falls back to its first
/// dotted component; a name without either adds nothing.
fn foldGroupSet(names: []const []const u8, model: []const ?Supplied, set: []const []const u8, counts: *FoldCounts) Supplied {
    var out: Supplied = .{};
    for (set) |name| {
        const first = name[0 .. std.mem.indexOfScalar(u8, name, '.') orelse name.len];
        const definition = findSupplied(names, model, name) orelse findSupplied(names, model, first) orelse continue;
        if (definition.fg) |fg| out.fg = fg;
        if (definition.bg) |bg| out.bg = bg;
        for (0..8) |bit| {
            const flag = @as(u8, 1) << @intCast(bit);
            if (definition.mask & flag == 0) {
                counts.kept += @intFromBool(out.value & flag != 0);
                continue;
            }
            counts.cleared += @intFromBool(out.value & flag != 0 and definition.value & flag == 0);
            out.value = (out.value & ~flag) | (definition.value & flag);
        }
    }
    return out;
}

fn findSupplied(names: []const []const u8, model: []const ?Supplied, name: []const u8) ?Supplied {
    for (names, model) |candidate, definition| if (std.mem.eql(u8, candidate, name)) return definition;
    return null;
}

// Invariant 7: random themes of partial definitions, registered through the C ABI by masked and
// old callers, compose every group set of up to eight names like the fold, over all eight bits.
test "group sets: composition equals a per-field fold over random themes and callers" {
    var owner: abi.ContextHandle = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = undefined, .owner_thread = std.Thread.getCurrentId() };
    defer owner.io_threaded.deinit();
    owner.core = try context_mod.Context.init(gpa, owner.io_threaded.io(), .{});
    defer owner.core.deinit() catch unreachable;
    const names = [_][]const u8{ "a", "b", "b.x", "c", "a.x" };
    // "b.x.q" falls back to "b", not to the longer "b.x"; "m" and "m.a" never resolve.
    const lookups = names ++ [_][]const u8{ "a.q", "b.x.q", "c.r.s", "m", "m.a" };
    var counts: FoldCounts = .{};
    var rejected: u32 = 0;
    for (0..1_250) |seed| {
        var prng = std.Random.DefaultPrng.init(seed);
        const random = prng.random();
        const handle = try owner.core.createSyntaxStyle();
        defer owner.core.destroy(handle) catch unreachable;
        const id = abi.handleToC(handle);
        var model: [names.len]?Supplied = @splat(null);
        for (0..random.uintAtMost(usize, 2 * names.len)) |_| {
            const index = random.uintLessThan(usize, names.len);
            var record: c.ot_editor_style = undefined;
            const supplied = randomStyleRecord(random, &record);
            var style_id: u32 = 0;
            const status = editor_abi.ot_syntax_style_register(&owner, &id, names[index].ptr, @intCast(names[index].len), &record, &style_id);
            try testing.expectEqual(if (supplied == null) c.OT_INVALID_ARGUMENT else c.OT_OK, status);
            if (supplied) |value| model[index] = value else rejected += 1;
        }
        // Stored definitions are what each caller sent, so legacy paint by style id is unchanged.
        const style = try owner.core.raw().getSyntaxStyle(handle);
        for (names, model) |name, expected| {
            const stored = style.getStyleByName(name) orelse {
                try testing.expectEqual(null, expected);
                continue;
            };
            try testing.expectEqualDeep(ss.StyleDefinition{ .fg = expected.?.fg, .bg = expected.?.bg, .attributes = expected.?.value, .supplied_attributes = expected.?.mask }, stored);
        }
        // Eight sets per theme: 10,000 compositions in all.
        var sets = hl.GroupSets.init(gpa);
        defer sets.deinit();
        for (0..8) |_| {
            var set: [hl.group_set_name_count_max][]const u8 = undefined;
            const set_names = set[0 .. 1 + random.uintLessThan(usize, set.len)];
            for (set_names) |*name| name.* = lookups[random.uintLessThan(usize, lookups.len)];
            const set_id = try sets.intern(set_names);
            const expected = foldGroupSet(&names, &model, set_names, &counts);
            // The first resolution of a set composes; later ones read the cache.
            for (0..2) |_| {
                const composed = style.resolveGroupSet(&sets, set_id);
                try testing.expectEqualDeep(.{ expected.fg, expected.bg, @as(u32, expected.value) }, .{ composed.fg, composed.bg, composed.attributes });
            }
        }
    }
    try testing.expect(counts.kept >= 1000 and counts.cleared >= 1000 and rejected >= 500);
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

test "group sets: markup.strikethrough strikes unless its definition supplies the bit" {
    var sets = hl.GroupSets.init(gpa);
    defer sets.deinit();
    const style = try ss.SyntaxStyle.init(gpa);
    defer style.deinit();
    const strike = ansi.TextAttributes.STRIKETHROUGH;
    const bold = ansi.TextAttributes.BOLD;
    const struck = try sets.intern(&.{"markup.strikethrough"});
    const under_bold = try sets.intern(&.{ "markup.strikethrough", "markup.strong" });
    // No definition, then the fallback's color with the strike (Core supplies only the attributes a theme names),
    // then a name after it, then a definition that clears it.
    try testing.expectEqual(@as(u32, strike), style.resolveGroupSet(&sets, struck).attributes);
    _ = try style.registerStyleDefinition("markup", .{ .fg = green, .bg = null, .attributes = bold, .supplied_attributes = bold });
    const fallback = style.resolveGroupSet(&sets, struck);
    try testing.expectEqualDeep(.{ green, @as(u32, bold | strike) }, .{ fallback.fg.?, fallback.attributes });
    _ = try style.registerStyleDefinition("markup.strong", .{ .fg = null, .bg = null, .attributes = 0, .supplied_attributes = bold });
    try testing.expectEqual(@as(u32, strike), style.resolveGroupSet(&sets, under_bold).attributes);
    _ = try style.registerStyleDefinition("markup.strikethrough", .{ .fg = red, .bg = null, .attributes = 0, .supplied_attributes = strike });
    try testing.expectEqual(@as(u32, 0), style.resolveGroupSet(&sets, struck).attributes);
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
        _ = try layers.set(gpa, &links, 1, 0, 10, toRuns(&buffer, row[0]));
        _ = try layers.set(gpa, &links, 1, row[1], row[2], toRuns(&buffer, row[3]));
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
    for ([_]u32{ 4, 1, 3, 2 }) |layer_id| _ = try layers.set(gpa, &links, layer_id, 0, 10, toRuns(&buffer, &.{.{ layer_id, layer_id + 1, layer_id }}));
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
    _ = try layers.set(gpa, &links, 5, 0, 10, &.{});
    _ = try layers.set(gpa, &links, 2, 0, 10, toRuns(&buffer, &.{.{ 7, 8, 9 }}));
    try testing.expectEqual(@as(u8, hl.layer_count_max), layers.count);
    for (layers.slice(), [_]u32{ 1, 2, 3, 4 }) |layer, layer_id| try testing.expectEqual(layer_id, layer.layer_id);
    _ = try layers.set(gpa, &links, 3, 0, 10, &.{});
    _ = try layers.set(gpa, &links, 5, 0, 10, toRuns(&buffer, &.{.{ 0, 1, 5 }}));
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
    _ = try layers.set(gpa, &links, 1, 0, 10, &.{.{ .start_byte = 0, .end_byte = 10, .group_set = 1, .link_id = live }});
    try testing.expectEqual(@as(u32, 2), try links.getRefcount(live));
    try testing.expectError(error.InvalidId, layers.set(gpa, &links, 1, 2, 8, &.{
        .{ .start_byte = 2, .end_byte = 3, .group_set = 1, .link_id = live },
        .{ .start_byte = 4, .end_byte = 5, .group_set = 1, .link_id = dead },
    }));
    try testing.expectEqual(@as(u32, 2), try links.getRefcount(live));
    try expectRuns(&.{.{ 0, 10, 1 }}, runsOf(&layers, 1));
    // The split keeps both outside parts, each holding a reference.
    _ = try layers.set(gpa, &links, 1, 2, 8, &.{});
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

// A replacement deletes, then inserts at the same byte. Seeking the cell again in the deleted
// text lands after a combining mark the deletion joined to the line before.
test "layers: a replacement inserts at the byte it deleted from" {
    var setup: Setup = undefined;
    try setup.init();
    defer setup.deinit();
    // Each row: text, the run, the replaced cell range, the bytes, the text and run after.
    for ([_]struct { []const u8, [2]u32, [2]u32, []const u8, []const u8, [2]u32 }{
        .{ "a\n\u{301}b", .{ 2, 4 }, .{ 1, 2 }, "x", "ax\u{301}b", .{ 2, 4 } },
        .{ "ab\u{301}c", .{ 1, 4 }, .{ 0, 1 }, "xy", "xyb\u{301}c", .{ 2, 5 } },
        .{ "a\nb", .{ 2, 3 }, .{ 1, 2 }, "\u{4e16}", "a\u{4e16}b", .{ 4, 5 } },
    }) |row| {
        const eb = try EditBuffer.initWithOptions(gpa, &setup.pools.graphemes, &setup.pools.links, .unicode, null, .{ .group_sets = &setup.sets });
        defer eb.deinit();
        try eb.setText(row[0]);
        try eb.tb.setLayer(1, 0, eb.tb.getByteSize(), &.{.{ .start_byte = row[1][0], .end_byte = row[1][1], .group_set = 1 }});
        try eb.replaceRange(row[2][0], row[2][1], row[3], .{ .ctx = eb, .handle = ignore });
        var bytes: [32]u8 = undefined;
        try testing.expectEqualStrings(row[4], plainText(eb.tb, &bytes));
        try expectRuns(&.{.{ row[5][0], row[5][1], 1 }}, runsOf(&eb.tb.layers, 1));
    }
}

// One painted row deep in a long document stores one span entry, not one per line before it.
test "layers: a deep viewport stores spans for the painted rows only" {
    var setup: Setup = undefined;
    try setup.init();
    defer setup.deinit();
    const tb = try setup.buffer(.unicode);
    defer tb.deinit();
    const line_count = 20_000;
    const text = try gpa.alloc(u8, 2 * line_count - 1);
    defer gpa.free(text);
    for (0..line_count) |row| {
        text[2 * row] = 'a';
        if (row + 1 < line_count) text[2 * row + 1] = '\n';
    }
    try tb.setText(text);
    try tb.setLayer(1, 0, tb.getByteSize(), &.{.{ .start_byte = 0, .end_byte = 1, .group_set = 1 }});
    const view = try TextBufferView.init(gpa, tb);
    defer view.deinit();
    view.setViewport(.{ .x = 0, .y = line_count - 1, .width = 8, .height = 1 });
    const screen = try setup.screen(8, 1);
    defer screen.deinit();
    _ = text_work.take();
    try screen.drawTextBufferChecked(view, 0, 0);
    try testing.expectEqual(@as(u64, 1), text_work.take().line_span_builds);
    try testing.expectEqual(@as(u32, 1), tb.line_spans.count());
    // A layer call that changes nothing builds nothing at the next paint.
    try tb.setLayer(1, 0, 0, &.{});
    try screen.drawTextBufferChecked(view, 0, 0);
    try testing.expectEqual(@as(u64, 0), text_work.take().line_span_builds);
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
    // Boundaries: the CJK character's ends, the break, and the text end. The C ABI fuzz below
    // covers rejected runs and ranges.
    try tb.setLayer(2, 0, 8, &.{ .{ .start_byte = 1, .end_byte = 4, .group_set = 1 }, .{ .start_byte = 5, .end_byte = 8, .group_set = 2 } });
    try expectRuns(&.{ .{ 1, 4, 1 }, .{ 5, 8, 2 } }, runsOf(&tb.layers, 2));
    // An end past the text clears to the end; a range that changes nothing keeps the stamp.
    const unchanged = tb.span_generation;
    try tb.setLayer(2, 0, 0, &.{});
    try tb.setLayer(2, 4, 5, &.{});
    try tb.setLayer(3, 0, 8, &.{});
    try testing.expectEqual(unchanged, tb.span_generation);
    try tb.setLayer(2, 4, std.math.maxInt(u32), &.{});
    try expectRuns(&.{.{ 1, 4, 1 }}, runsOf(&tb.layers, 2));
    try tb.setLayer(2, 0, 8, &.{ .{ .start_byte = 1, .end_byte = 4, .group_set = 1 }, .{ .start_byte = 5, .end_byte = 8, .group_set = 2 } });
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

const Fault = enum { none, reversed, unsorted, overlapping, empty, past_range, past_text, inside_char, group_set, null_runs };

fn isBoundary(text: []const u8, byte: u32) bool {
    return byte == text.len or (byte < text.len and text[byte] & 0xC0 != 0x80);
}

/// The header's rules for one set_layer call, written apart from the implementation.
fn validLayerCall(text: []const u8, start: u32, end: u32, runs: ?[]const c.ot_highlight_run, set_count: u32) bool {
    if (start > end) return false;
    if (start < text.len and !isBoundary(text, start)) return false;
    if (end < text.len and !isBoundary(text, end)) return false;
    var previous = start;
    for (runs orelse return false) |run| {
        if (run.start_byte < previous or run.start_byte >= run.end_byte or run.end_byte > end or run.end_byte > text.len) return false;
        if (!isBoundary(text, run.start_byte) or !isBoundary(text, run.end_byte)) return false;
        if (run.group_set == 0 or run.group_set > set_count) return false;
        previous = run.end_byte;
    }
    return true;
}

fn faultyLayerCall(random: std.Random, text: []const u8, fault: Fault, range: *[2]u32, runs: []c.ot_highlight_run) void {
    const last = runs.len -| 1;
    const index = random.uintAtMost(usize, last);
    switch (fault) {
        .none, .null_runs => {},
        .reversed => {
            const start = range[0];
            range[0] = range[1] +| 1;
            range[1] = start;
        },
        .unsorted => if (runs.len > 1) std.mem.swap(c.ot_highlight_run, &runs[0], &runs[last]),
        .overlapping => if (runs.len > 1) {
            runs[index].end_byte = runs[(index + 1) % runs.len].start_byte + 1;
        },
        .empty => if (runs.len > 0) {
            runs[index].end_byte = runs[index].start_byte;
        },
        .past_range => if (runs.len > 0) {
            runs[last].end_byte = range[1] +| 1;
        },
        .past_text => if (runs.len > 0) {
            runs[last].end_byte = @intCast(text.len + 1);
        },
        .inside_char => for (text, 0..) |byte, at| if (byte & 0xC0 == 0x80 and random.boolean()) {
            const run_edges: [2]*u32 = if (runs.len > 0) .{ &runs[index].start_byte, &runs[index].end_byte } else .{ &range[0], &range[1] };
            const edges = [_]*u32{ &range[0], &range[1], run_edges[0], run_edges[1] };
            edges[random.uintLessThan(usize, edges.len)].* = @intCast(at);
            break;
        },
        .group_set => if (runs.len > 0) {
            runs[index].group_set = if (random.boolean()) 0 else 4;
        },
    }
}

/// The layer calls on an edit buffer or, `on_text`, a text buffer.
const Calls = struct {
    fn setText(o: *abi.ContextHandle, on_text: bool, id: *const c.ot_handle, bytes: []const u8) c.ot_status {
        if (on_text) return text_abi.ot_text_buffer_set_text(o, id, bytes.ptr, @intCast(bytes.len));
        return abi.ot_edit_buffer_set_text(o, id, bytes.ptr, @intCast(bytes.len), 0);
    }
    fn getText(o: *abi.ContextHandle, on_text: bool, id: *const c.ot_handle, bytes: []u8, out: *u32) c.ot_status {
        if (on_text) return text_abi.ot_text_buffer_get_text(o, id, bytes.ptr, @intCast(bytes.len), out);
        return abi.ot_edit_buffer_get_text(o, id, bytes.ptr, @intCast(bytes.len), out);
    }
    fn highlight(o: *abi.ContextHandle, on_text: bool, id: *const c.ot_handle, operation: u32) c.ot_status {
        if (on_text) return text_abi.ot_text_buffer_highlight(o, id, operation, 0, null);
        return editor_abi.ot_edit_buffer_highlight(o, id, operation, 0, null);
    }
    fn setLayer(o: *abi.ContextHandle, on_text: bool, id: *const c.ot_handle, layer: u32, start: u32, end: u32, runs: ?[*]const c.ot_highlight_run, count: u32) c.ot_status {
        if (on_text) return text_abi.ot_text_buffer_set_layer(o, id, layer, start, end, runs, count);
        return editor_abi.ot_edit_buffer_set_layer(o, id, layer, start, end, runs, count);
    }
};

// P14 through the C ABI: a malformed range or run list rejects with no change to the layers or
// the span stamp, a fifth layer fails with OT_OBJECT_LIMIT, NULL with no runs clears, CLEAR_ALL
// empties every layer, REMOVE_REF and CLEAR_LINE keep them, and accepted calls match the byte
// model. Offsets are bytes of the text as get_text returns it, CRLF included.
test "layers: seeded C ABI calls reject malformed runs atomically and match the byte model" {
    var owner: abi.ContextHandle = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = undefined, .owner_thread = std.Thread.getCurrentId() };
    defer owner.io_threaded.deinit();
    owner.core = try context_mod.Context.init(gpa, owner.io_threaded.io(), .{});
    defer owner.core.deinit() catch unreachable;
    var group_set: u32 = 0;
    for ([_][]const u8{ "a", "b", "ab", "a" }, [_][]const u32{ &.{1}, &.{1}, &.{ 1, 2 }, &.{1} }, [_]u32{ 1, 2, 3, 1 }) |names, ends, expected| {
        try testing.expectEqual(c.OT_OK, abi.ot_context_group_set(&owner, names.ptr, @intCast(names.len), ends.ptr, @intCast(ends.len), &group_set));
        try testing.expectEqual(expected, group_set);
    }
    const long: [hl.group_set_name_byte_count_max + 1]u8 = @splat('x');
    // Over the length bound and not UTF-8: the bound is checked first, without a scan.
    var long_invalid = long;
    long_invalid[long.len - 1] = 0xff;
    const one_too_many: [hl.group_set_name_count_max + 1]u8 = @splat('a');
    const one_too_many_ends = comptime ends: {
        var ends: [one_too_many.len]u32 = undefined;
        for (&ends, 1..) |*end, index| end.* = index;
        break :ends ends;
    };
    for ([_]struct { c.ot_status, []const u8, []const u32 }{
        .{ c.OT_OBJECT_LIMIT, &one_too_many, &one_too_many_ends },
        .{ c.OT_OBJECT_LIMIT, &long, &.{long.len} },
        .{ c.OT_OBJECT_LIMIT, &long_invalid, &.{long.len} },
        .{ c.OT_INVALID_ARGUMENT, "ab", &.{1} },
        .{ c.OT_INVALID_ARGUMENT, "ab", &.{ 2, 1 } },
        .{ c.OT_INVALID_ARGUMENT, "ab", &.{ 0, 2 } },
        .{ c.OT_INVALID_ARGUMENT, "ab", &.{3} },
        .{ c.OT_INVALID_ARGUMENT, "", &.{} },
        .{ c.OT_INVALID_ARGUMENT, "\xff", &.{1} },
    }) |row| {
        group_set = 99;
        try testing.expectEqual(row[0], abi.ot_context_group_set(&owner, row[1].ptr, @intCast(row[1].len), row[2].ptr, @intCast(row[2].len), &group_set));
        try testing.expectEqual(@as(u32, 99), group_set);
    }
    try testing.expectEqual(@as(u32, 3), owner.core.group_sets.count());
    // Odd seeds run on a text buffer: both handles share one validator (C4 invariant 7).
    const edit_handle = try owner.core.createEditBuffer(.unicode);
    const text_handle = try owner.core.createTextBuffer(.unicode);
    const ids = [_]c.ot_handle{ abi.handleToC(edit_handle), abi.handleToC(text_handle) };
    const tbs = [_]*text_buffer.UnifiedTextBuffer{ (try owner.core.raw().getEditBuffer(edit_handle)).buffer.tb, (try owner.core.raw().getTextBuffer(text_handle)).buffer };
    const pieces = [_][]const u8{ "ab", "c", " ", "\t", "\n", "\r\n", "\u{e9}", "\u{4e16}", "\u{1f642}" };
    const layer_ids = [_]u32{ 7, 1, 4, 2, 9, 3 };
    var rejected: std.EnumArray(Fault, u32) = .initFill(0);
    var accepted: u32 = 0;
    var limited: u32 = 0;
    var null_clears: u32 = 0;
    for (0..64) |seed| {
        var prng = std.Random.DefaultPrng.init(seed);
        const random = prng.random();
        const on_text = seed % 2 == 1;
        const id = &ids[seed % 2];
        const tb = tbs[seed % 2];
        var source: std.ArrayListUnmanaged(u8) = .empty;
        defer source.deinit(gpa);
        for (0..random.uintAtMost(usize, 60)) |_| try source.appendSlice(gpa, pieces[random.uintLessThan(usize, pieces.len)]);
        try testing.expectEqual(c.OT_OK, Calls.setText(&owner, on_text, id, source.items));
        var text_bytes: [LayerModel.byte_count_max]u8 = undefined;
        var byte_count: u32 = 0;
        try testing.expectEqual(c.OT_OK, Calls.getText(&owner, on_text, id, &text_bytes, &byte_count));
        const text = text_bytes[0..byte_count];
        var model: LayerModel = .{ .byte_count = byte_count };
        defer model.deinit();
        for (0..64) |_| {
            const generation = tb.span_generation;
            const roll = random.uintLessThan(u32, 16);
            if (roll < 2) {
                const operation: u32 = if (roll == 0) c.OT_EDIT_HIGHLIGHT_CLEAR_ALL else if (random.boolean()) c.OT_EDIT_HIGHLIGHT_REMOVE_REF else c.OT_EDIT_HIGHLIGHT_CLEAR_LINE;
                try testing.expectEqual(c.OT_OK, Calls.highlight(&owner, on_text, id, operation));
                if (operation == c.OT_EDIT_HIGHLIGHT_CLEAR_ALL) model.reset();
                try model.expectEqual(&tb.layers, &layer_ids);
                continue;
            }
            const layer = random.uintLessThan(usize, layer_ids.len);
            var range: [2]u32 = undefined;
            range[0] = randomBoundary(random, text, 0, byte_count);
            range[1] = switch (random.uintLessThan(u32, 4)) {
                0 => std.math.maxInt(u32),
                1 => byte_count + random.uintAtMost(u32, 3),
                else => randomBoundary(random, text, range[0], byte_count),
            };
            var runs: [24]c.ot_highlight_run = undefined;
            var run_count: usize = 0;
            var at = range[0];
            const limit = @min(range[1], byte_count);
            while (run_count < runs.len) : (run_count += 1) {
                at = randomBoundary(random, text, at, 3);
                if (at >= limit) break;
                const run_end = randomBoundary(random, text, at + 1, 6);
                if (run_end > limit) break;
                runs[run_count] = .{ .start_byte = at, .end_byte = run_end, .group_set = 1 + random.uintLessThan(u32, 3) };
                at = run_end;
            }
            const fault: Fault = if (random.boolean()) .none else random.enumValue(Fault);
            if (fault == .null_runs and random.boolean()) run_count = 0;
            faultyLayerCall(random, text, fault, &range, runs[0..run_count]);
            // NULL is valid only with no runs.
            const pointer: ?[*]const c.ot_highlight_run = if (fault == .null_runs) null else &runs;
            const passed: ?[]const c.ot_highlight_run = if (pointer == null and run_count > 0) null else runs[0..run_count];
            const status = Calls.setLayer(&owner, on_text, id, layer_ids[layer], range[0], range[1], pointer, @intCast(run_count));
            if (validLayerCall(text, range[0], range[1], passed, 3)) {
                var model_runs: [24]LayerRun = undefined;
                for (runs[0..run_count], model_runs[0..run_count]) |run, *target| target.* = .{ .start_byte = run.start_byte, .end_byte = run.end_byte, .group_set = run.group_set };
                const over_limit = try model.set(layer, @min(range[0], limit), limit, model_runs[0..run_count]);
                try testing.expectEqual(if (over_limit) c.OT_OBJECT_LIMIT else c.OT_OK, status);
                if (over_limit) {
                    try testing.expectEqual(generation, tb.span_generation);
                    limited += 1;
                } else accepted += 1;
                null_clears += @intFromBool(pointer == null);
            } else {
                rejected.getPtr(fault).* += 1;
                try testing.expectEqual(c.OT_INVALID_ARGUMENT, status);
                try testing.expectEqual(generation, tb.span_generation);
            }
            try model.expectEqual(&tb.layers, &layer_ids);
        }
    }
    // Every fault class rejected often, and most clean calls passed.
    var iterator = rejected.iterator();
    while (iterator.next()) |entry| if (entry.key != .none) try testing.expect(entry.value.* >= 64);
    try testing.expectEqual(@as(u32, 0), rejected.get(.none));
    try testing.expect(accepted >= 1000 and limited >= 16 and null_clears >= 16);

    // Directed edges on 界 (bytes 0..3): a run end or a range end inside it rejects, and NULL with
    // no runs over the whole character clears.
    for (&ids, tbs, [_]bool{ false, true }) |*id, tb, on_text| {
        try testing.expectEqual(c.OT_OK, Calls.setText(&owner, on_text, id, "\u{754c}"));
        try testing.expectEqual(c.OT_OK, Calls.setLayer(&owner, on_text, id, 2, 0, 3, &.{.{ .start_byte = 0, .end_byte = 3, .group_set = 1 }}, 1));
        for ([_]struct { u32, u32, ?[*]const c.ot_highlight_run, u32 }{
            .{ 0, 3, &.{.{ .start_byte = 0, .end_byte = 2, .group_set = 1 }}, 1 },
            .{ 0, 2, null, 0 },
            .{ 2, 3, null, 0 },
        }) |row| {
            try testing.expectEqual(c.OT_INVALID_ARGUMENT, Calls.setLayer(&owner, on_text, id, 2, row[0], row[1], row[2], row[3]));
            try expectRuns(&.{.{ 0, 3, 1 }}, runsOf(&tb.layers, 2));
        }
        try testing.expectEqual(c.OT_OK, Calls.setLayer(&owner, on_text, id, 2, 0, 3, null, 0));
        try testing.expect(tb.layers.isEmpty());
    }

    // More runs than text bytes reject before the copy: with the next allocation failing, both handles still
    // answer OT_INVALID_ARGUMENT, not OT_OUT_OF_MEMORY.
    var failing = std.testing.FailingAllocator.init(gpa, .{});
    var bounded: abi.ContextHandle = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = undefined, .owner_thread = std.Thread.getCurrentId() };
    defer bounded.io_threaded.deinit();
    bounded.core = try context_mod.Context.init(failing.allocator(), bounded.io_threaded.io(), .{});
    defer bounded.core.deinit() catch unreachable;
    const empty = [_]c.ot_handle{ abi.handleToC(try bounded.core.createEditBuffer(.unicode)), abi.handleToC(try bounded.core.createTextBuffer(.unicode)) };
    for (&empty, [_]bool{ false, true }) |*id, on_text| {
        failing.fail_index = failing.alloc_index;
        try testing.expectEqual(c.OT_INVALID_ARGUMENT, Calls.setLayer(&bounded, on_text, id, 2, 0, 0, &.{.{ .start_byte = 0, .end_byte = 1, .group_set = 1 }}, 1));
        try testing.expect(!failing.has_induced_failure);
    }
    failing.fail_index = std.math.maxInt(usize);
}

// C4 invariant 7 in the frame protocol: a layer set while a frame waits for its UPDATE reply costs a text buffer
// the same layout rounds as an edit buffer.
test "layers: a layer set during an update reply takes the same rounds on text and edit buffers" {
    var statuses: [2]c.ot_status = undefined;
    for (&statuses, [_]bool{ false, true }) |*status, on_text| {
        const handle = try abi.createTestContext(.{ .object_capacity = 8, .render_cells_max = 18 });
        defer testing.expectEqual(c.OT_OK, abi.ot_context_destroy(handle)) catch unreachable;
        const session = try handle.core.createSession(.{});
        try handle.core.attachSessionRenderer(session, 6, 3, .{ .remote_mode = .remote });
        const id = abi.handleToC(session);
        var root: c.ot_handle = undefined;
        var node: c.ot_handle = undefined;
        try testing.expectEqual(c.OT_OK, abi.ot_scene_create_node(handle, &id, c.OT_SCENE_ROOT, 1, &root));
        try testing.expectEqual(c.OT_OK, abi.ot_scene_create_node(handle, &id, if (on_text) c.OT_SCENE_TEXT_VIEW else c.OT_SCENE_EDITOR, 2, &node));
        try testing.expectEqual(c.OT_OK, abi.ot_scene_move_node(handle, &node, &root, 0));
        const hooks: c.ot_scene_hooks = .{ .struct_size = @sizeOf(c.ot_scene_hooks), .abi_version = c.OT_CONTEXT_ABI_VERSION, .flags = 1, .reserved = 0, .generation = 1, .initial_width = 0, .initial_height = 0 };
        try testing.expectEqual(c.OT_OK, abi.ot_scene_set_hooks(handle, &node, &hooks));
        var buffer: c.ot_handle = undefined;
        if (on_text) {
            buffer = abi.handleToC(try handle.core.createTextBuffer(.unicode));
            const view = abi.handleToC(try handle.core.createTextBufferView(abi.handleFromC(buffer)));
            try testing.expectEqual(c.OT_OK, text_abi.ot_scene_set_text_view(handle, &node, &view));
            try testing.expectEqual(c.OT_OK, text_abi.ot_text_buffer_set_text(handle, &buffer, "let", 3));
        } else {
            buffer = abi.handleToC(try handle.core.createEditBuffer(.unicode));
            const view = abi.handleToC(try handle.core.createEditorView(abi.handleFromC(buffer), 6, 3));
            try testing.expectEqual(c.OT_OK, abi.ot_scene_set_editor_view(handle, &node, &view));
            try testing.expectEqual(c.OT_OK, abi.ot_edit_buffer_set_text(handle, &buffer, "let", 3, 0));
        }
        var group_set: u32 = 0;
        try testing.expectEqual(c.OT_OK, abi.ot_context_group_set(handle, "a", 1, &.{1}, 1, &group_set));
        const options: c.ot_scene_frame_options = .{ .struct_size = @sizeOf(c.ot_scene_frame_options), .abi_version = c.OT_CONTEXT_ABI_VERSION, .background = .{ 0, 0, 0, 255 }, .use_mouse = 1, .excluded_hit_num = 0, .max_layout_rounds = 1, .max_host_requests = 8, .preserve_unwritten = 0 };
        var output = std.mem.zeroes(c.ot_scene_frame_request);
        output.struct_size = @sizeOf(c.ot_scene_frame_request);
        output.abi_version = c.OT_CONTEXT_ABI_VERSION;
        var geometry = std.mem.zeroes(c.ot_scene_frame_geometry);
        geometry.struct_size = @sizeOf(c.ot_scene_frame_geometry);
        geometry.abi_version = c.OT_CONTEXT_ABI_VERSION;
        try testing.expectEqual(c.OT_OK, abi.ot_scene_frame_step_with_geometry(handle, &id, null, &options, null, 0, &output, &geometry));
        try testing.expectEqual(c.OT_SCENE_FRAME_UPDATE, output.kind);
        try testing.expectEqual(c.OT_OK, Calls.setLayer(handle, on_text, &buffer, 1, 0, 3, &.{.{ .start_byte = 0, .end_byte = 3, .group_set = group_set }}, 1));
        status.* = abi.ot_scene_frame_step_with_geometry(handle, &id, &output, &options, null, 0, &output, &geometry);
    }
    try testing.expectEqual(statuses[0], statuses[1]);
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
        // A record elsewhere on the line does not change which of two tied records wins (main's
        // hash order did).
        .{ &.{ .{ 4, 5, 1, 0 }, .{ 0, 3, 2, 0 }, .{ 0, 3, 3, 0 } }, &.{}, blue },
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

// A layer run whose set supplies no field is absent: the priority-0 record under it shows, through
// redefinitions and a style swap. A linked run and an empty legacy record still win.
test "layers: a run whose set supplies nothing shows what lies under it" {
    var setup: Setup = undefined;
    try setup.init();
    defer setup.deinit();
    const tb = try setup.buffer(.unicode);
    defer tb.deinit();
    try tb.setText("abcdefgh");
    const nothing: ss.StyleDefinition = .{ .fg = null, .bg = null, .attributes = 0, .supplied_attributes = 0 };
    const blue_fg: ss.StyleDefinition = .{ .fg = blue, .bg = null, .attributes = 0, .supplied_attributes = 0 };
    const empty = try setup.sets.intern(&.{ "e", "unknown" });
    try tb.addHighlight(0, 0, 7, 2, 0, 0);
    const url = try setup.pools.links.acquire("https://example.com");
    defer setup.pools.links.decref(url) catch unreachable;
    try tb.setLayer(1, 0, 8, &.{ .{ .start_byte = 0, .end_byte = 4, .group_set = empty }, .{ .start_byte = 5, .end_byte = 6, .group_set = empty, .link_id = url } });
    const other = try ss.SyntaxStyle.init(gpa);
    defer other.deinit();
    // Column 1 under the empty run, against column 7 (no input); a null color is column 7's.
    for ([_]struct { *ss.SyntaxStyle, ss.StyleDefinition, ?ansi.RGBA }{
        .{ setup.style, nothing, green },
        .{ setup.style, blue_fg, blue },
        // A supplied attribute bit, even one set to 0, is a field: the run wins.
        .{ setup.style, .{ .fg = null, .bg = null, .attributes = 0, .supplied_attributes = 1 }, null },
        .{ setup.style, nothing, green },
        .{ other, blue_fg, blue },
        .{ setup.style, nothing, green },
    }) |row| {
        _ = try row[0].registerStyleDefinition("e", row[1]);
        tb.setSyntaxStyle(row[0]);
        const screen = try paint(&setup, tb, 8, 1);
        defer screen.deinit();
        try testing.expectEqual(row[2] orelse screen.get(7, 0).?.fg, screen.get(1, 0).?.fg);
        try testing.expectEqual(url, ansi.TextAttributes.getLinkId(screen.get(5, 0).?.attributes));
    }
    // Spans built without a style rebuild once one is bound.
    tb.setSyntaxStyle(null);
    for ([_]?*ss.SyntaxStyle{ null, setup.style }, [_]?ansi.RGBA{ null, blue }) |style, want| {
        if (style) |bound| _ = try bound.registerStyleDefinition("e", blue_fg);
        tb.setSyntaxStyle(style);
        const screen = try paint(&setup, tb, 8, 1);
        defer screen.deinit();
        try testing.expectEqual(want orelse screen.get(7, 0).?.fg, screen.get(1, 0).?.fg);
    }
    _ = try setup.style.registerStyleDefinition("e", nothing);
    const blank = try setup.style.registerStyleDefinition("z", nothing);
    try tb.addHighlight(0, 0, 7, blank, 0, 0);
    const screen = try paint(&setup, tb, 8, 1);
    defer screen.deinit();
    try testing.expectEqual(screen.get(7, 0).?.fg, screen.get(1, 0).?.fg);
    // Without records: a higher layer's run shows the lower layer's while it supplies nothing.
    const layered = try setup.buffer(.unicode);
    defer layered.deinit();
    try layered.setText("abcdefgh");
    try layered.setLayer(1, 0, 8, &.{.{ .start_byte = 0, .end_byte = 4, .group_set = 1 }});
    try layered.setLayer(2, 0, 8, &.{.{ .start_byte = 0, .end_byte = 4, .group_set = empty }});
    for ([_]struct { ss.StyleDefinition, ansi.RGBA }{ .{ nothing, red }, .{ blue_fg, blue }, .{ nothing, red } }) |row| {
        _ = try setup.style.registerStyleDefinition("e", row[0]);
        const top = try paint(&setup, layered, 8, 1);
        defer top.deinit();
        try testing.expectEqual(row[1], top.get(1, 0).?.fg);
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
        if (tb.line_spans.get(0)) |entry| try testing.expect(entry.generation != tb.span_generation);
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
    // A second layer off the painted lines makes no painted line depend on definitions.
    try tb.setLayer(2, 0, tb.getByteSize(), &.{.{ .start_byte = 204, .end_byte = 206, .group_set = 3 }});
    _ = text_work.take();
    try screen.drawTextBufferChecked(view, 0, 0);
    try testing.expectEqual(@as(u64, 10), text_work.take().line_span_builds);
    // Only the ten painted lines have entries, all current.
    try testing.expectEqual(@as(u32, 10), tb.line_spans.count());
    var entries = tb.line_spans.iterator();
    while (entries.next()) |entry| {
        try testing.expect(entry.key_ptr.* < 10);
        try testing.expectEqual(tb.span_generation, entry.value_ptr.generation);
    }
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
    // s2 (2) supplies all attribute bits, so it replaces s3's (3).
    try testing.expectEqual(@as(u32, 2), screen.get(6, 0).?.attributes & ansi.TextAttributes.ATTRIBUTE_BASE_MASK);
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

/// Reference for the span model test (work file `tracks/c3-1-highlight-layers.md`, "Span model"):
/// the legacy records per line in add order (styled-text records carry their value), the layers as a
/// byte model, the text, and what each style defines for each name. A character's paint is
/// recomputed from scratch: the highest priority wins, ties go to the later input (records in add
/// order, then layers by id, priority 0).
const SpanModel = struct {
    const line_count_max = 24;
    const record_count_max = 40;
    const names = [_][]const u8{ "s1", "s2", "s3" };
    /// Group sets 1..3 are one name each; 4 is ["s3", "s2"]; 5 falls back to s1.
    const sets = [_][]const []const u8{ &.{"s1"}, &.{"s2"}, &.{"s3"}, &.{ "s3", "s2" }, &.{"s1.extra"} };
    const palette = [_]?ansi.RGBA{ red, green, blue, ansi.rgbColor(9, 9, 9, 255), ansi.rgbColor(200, 100, 0, 255), null };
    const attribute_choices = [_]u32{ 0, 1, 2, 4, 8, 16, 3 };
    const Def = struct { fg: ?ansi.RGBA = null, bg: ?ansi.RGBA = null, attributes: u32 = 0 };
    /// A record's style: a SyntaxStyle id, or for styled text the value of its part.
    const Record = struct { col_start: u32, col_end: u32, priority: u8, ref: u16, style_id: u32, value: ?Def = null };
    const Cell = struct { fg: ansi.RGBA, bg: ansi.RGBA, attributes: u32 };

    records: [line_count_max * 4][record_count_max]Record = undefined,
    record_counts: [line_count_max * 4]usize = @splat(0),
    layers: LayerModel,
    text: std.ArrayListUnmanaged(u8) = .empty,
    /// Per style (A, B), per name.
    defs: [2][names.len]Def,
    bound: usize = 0,
    tab_width: u32 = 2,
    /// Lines some paint drew: the only lines that may hold span entries.
    painted: std.AutoHashMapUnmanaged(u32, void) = .empty,

    fn deinit(self: *SpanModel) void {
        self.text.deinit(gpa);
        self.layers.deinit();
        self.painted.deinit(gpa);
    }

    fn lineCount(self: *const SpanModel) u32 {
        return @intCast(std.mem.count(u8, self.text.items, "\n") + 1);
    }

    fn add(self: *SpanModel, row: u32, record: Record) void {
        self.records[row][self.record_counts[row]] = record;
        self.record_counts[row] += 1;
    }

    fn nameDef(self: *const SpanModel, name: []const u8) ?Def {
        for (names, 0..) |known, index| if (std.mem.eql(u8, known, name)) return self.defs[self.bound][index];
        return null;
    }

    fn setDef(self: *const SpanModel, group_set: u32) Def {
        var result: Def = .{};
        for (sets[group_set - 1]) |name| {
            const def = self.nameDef(name) orelse self.nameDef(name[0 .. std.mem.indexOfScalar(u8, name, '.') orelse continue]) orelse continue;
            if (def.fg) |fg| result.fg = fg;
            if (def.bg) |bg| result.bg = bg;
            // Registered without a mask, a definition supplies all eight attribute bits.
            result.attributes = def.attributes;
        }
        return result;
    }

    /// What the character at `byte`, column `col` of line `row` paints.
    fn expected(self: *const SpanModel, row: u32, col: u32, byte: u32, defaults: Cell) Cell {
        var best_priority: i16 = -1;
        var best: Def = .{};
        var link_id: u32 = 0;
        for (self.records[row][0..self.record_counts[row]]) |record| {
            if (col < record.col_start or col >= record.col_end or record.priority < best_priority) continue;
            best_priority = record.priority;
            best = record.value orelse if (record.style_id >= 1 and record.style_id <= names.len) self.defs[self.bound][record.style_id - 1] else .{};
            link_id = 0;
        }
        for (self.layers.labels) |labels| {
            const label = labels[byte];
            if (label == 0 or best_priority > 0) continue;
            best_priority = 0;
            const piece = self.layers.pieces.items[label - 1];
            best = self.setDef(piece.group_set);
            link_id = piece.link_id;
        }
        var attributes = defaults.attributes | best.attributes;
        if (link_id != 0) attributes = ansi.TextAttributes.setLinkId(attributes, link_id);
        return .{ .fg = best.fg orelse defaults.fg, .bg = best.bg orelse defaults.bg, .attributes = attributes };
    }

    fn randomDef(random: std.Random) Def {
        return .{
            .fg = palette[random.uintLessThan(usize, palette.len)],
            .bg = palette[random.uintLessThan(usize, palette.len)],
            .attributes = attribute_choices[random.uintLessThan(usize, attribute_choices.len)],
        };
    }
};

/// The buffer under test: an editor (edits) or a text buffer (styled text and appends).
const ModelTarget = struct {
    eb: ?*EditBuffer,
    tb: *TextBuffer,
    view: *TextBufferView,
    wrap_width: ?u32 = null,
    viewport: text_buffer_view.Viewport = .{ .x = 0, .y = 0, .width = 64, .height = SpanModel.line_count_max },

    fn configure(self: *const ModelTarget, view: *TextBufferView) void {
        view.setWrapMode(if (self.wrap_width == null) .none else .char);
        view.setWrapWidth(self.wrap_width);
        view.setViewport(self.viewport);
    }
};

const model_defaults: SpanModel.Cell = .{ .fg = ansi.rgbColor(128, 128, 128, 255), .bg = ansi.rgbColor(10, 10, 30, 255), .attributes = 0 };

// The span model (P13 path independence): random legacy adds, removals and clears, layer sets with
// links, editor inserts, deletes and replacements, styled text and appends, whole-text replacement,
// CLEAR_ALL, theme redefinitions and rebinds, tab width, wrapping and scrolling. At every paint:
// each character's fg, bg, attributes and link equal the from-scratch model; get_highlights equals
// the records; only painted lines hold span entries and only they are built; and the retained paint
// equals a forced full repaint (new view, stale spans, empty composition caches) byte for byte.
// Even seeds drive an editor, odd seeds a text buffer. 64 seeds of 256 events: about 1 s and
// 11 MB in a debug build.
test "layers: seeded span model, from-scratch cells and a forced full repaint agree at every paint" {
    var setup: Setup = undefined;
    try setup.init();
    defer setup.deinit();
    for (SpanModel.sets[3..]) |names| _ = try setup.sets.intern(names);
    const other = try ss.SyntaxStyle.init(gpa);
    defer other.deinit();
    const styles = [_]*ss.SyntaxStyle{ setup.style, other };
    const urls = [_]u32{ 0, try setup.pools.links.acquire("https://a.example"), try setup.pools.links.acquire("https://b.example") };
    defer for (urls[1..]) |id| setup.pools.links.decref(id) catch unreachable;
    const layer_ids = [_]u32{ 1, 2, 3, 4, 5, 6 };
    const inserts = [_][]const u8{ "a", "\u{e9}", "\u{4e16}", "\n", "xyz", "b\nc", "\t" };
    const replacements = [_][]const u8{ "one\ntwo", "a\nb\nc\nd\ne", "\tx\u{4e16}y" };
    const max = std.math.maxInt(u32);
    for (0..64) |seed| {
        var prng = std.Random.DefaultPrng.init(seed);
        const random = prng.random();
        const editor = seed % 2 == 0;
        var model: SpanModel = .{ .layers = .{ .byte_count = 0 }, .defs = undefined };
        defer model.deinit();
        for (&model.defs) |*defs| for (defs) |*def| {
            def.* = SpanModel.randomDef(random);
        };
        for (styles, model.defs) |style, defs| for (SpanModel.names, defs) |name, def| {
            _ = try style.registerStyle(name, def.fg, def.bg, def.attributes);
        };
        const eb: ?*EditBuffer = if (editor) try EditBuffer.initWithOptions(gpa, &setup.pools.graphemes, &setup.pools.links, .unicode, null, .{ .group_sets = &setup.sets }) else null;
        defer if (eb) |value| value.deinit();
        const tb = if (eb) |value| value.tb else try setup.buffer(.unicode);
        defer if (eb == null) tb.deinit();
        tb.setSyntaxStyle(setup.style);
        tb.setDefaultFg(model_defaults.fg);
        tb.setDefaultBg(model_defaults.bg);
        tb.setTabWidth(2);
        const initial = "al\tpha \u{4e16}\n\tbeta \u{e9}t\u{e9}\n\ngamma";
        if (eb) |value| try value.setText(initial) else try tb.setText(initial);
        var target: ModelTarget = .{ .eb = eb, .tb = tb, .view = try TextBufferView.init(gpa, tb) };
        defer target.view.deinit();
        target.configure(target.view);
        var bytes: [LayerModel.byte_count_max + 64]u8 = undefined;
        try model.text.appendSlice(gpa, plainText(tb, &bytes));
        model.layers.byte_count = @intCast(model.text.items.len);
        for (0..256) |_| {
            const text = model.text.items;
            const model_tab = model.tab_width;
            const room = text.len < 160 and model.lineCount() < SpanModel.line_count_max - 2;
            switch (random.uintLessThan(u8, 20)) {
                0, 1, 2 => {
                    const row = random.uintAtMost(u32, model.lineCount());
                    const start = random.uintAtMost(u32, 16);
                    const record: SpanModel.Record = .{ .col_start = start, .col_end = start + 1 + random.uintAtMost(u32, 7), .style_id = 1 + random.uintAtMost(u32, 3), .priority = random.uintAtMost(u8, 2), .ref = random.uintAtMost(u16, 3) };
                    if (row < model.lineCount() and model.record_counts[row] == SpanModel.record_count_max) continue;
                    const result = tb.addHighlight(row, record.col_start, record.col_end, record.style_id, record.priority, record.ref);
                    if (row >= model.lineCount()) {
                        try testing.expectError(error.InvalidIndex, result);
                    } else {
                        try result;
                        model.add(row, record);
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
                    for (randomRuns(random, &buffer, start, end, &urls)) |run| {
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
                    const insert = inserts[random.uintLessThan(usize, inserts.len)];
                    if (eb) |value| {
                        const at = randomBoundary(random, text, 0, max);
                        const cursor = coordsOf(text, at, model_tab);
                        try value.setCursor(cursor.row, cursor.col);
                        try value.insertText(insert);
                        model.layers.insert(at, @intCast(insert.len));
                        try model.text.insertSlice(gpa, at, insert);
                    } else {
                        // Appended text joins no run: a run ending at the old end does not grow.
                        try tb.append(insert);
                        model.layers.insert(@intCast(text.len), @intCast(insert.len));
                        try model.text.appendSlice(gpa, insert);
                    }
                },
                10, 17 => if (eb) |value| {
                    const start = randomBoundary(random, text, 0, max);
                    const end = randomBoundary(random, text, start, 8);
                    if (random.boolean() or !room) {
                        try value.deleteRange(coordsOf(text, start, model_tab), coordsOf(text, end, model_tab));
                        model.layers.delete(start, end);
                        try model.text.replaceRange(gpa, start, end - start, "");
                    } else {
                        const insert = inserts[random.uintLessThan(usize, inserts.len)];
                        const start_cursor = coordsOf(text, start, model_tab);
                        const end_cursor = coordsOf(text, end, model_tab);
                        const start_offset = iter_mod.coordsToOffset(tb.rope(), start_cursor.row, start_cursor.col).?;
                        const end_offset = iter_mod.coordsToOffset(tb.rope(), end_cursor.row, end_cursor.col).?;
                        try value.setCursor(start_cursor.row, start_cursor.col);
                        try value.replaceRange(start_offset, end_offset, insert, .{ .ctx = value, .handle = ignore });
                        model.layers.delete(start, end);
                        model.layers.insert(start, @intCast(insert.len));
                        try model.text.replaceRange(gpa, start, end - start, insert);
                    }
                } else {
                    // Styled text replaces the text, every record, and empties the layers.
                    var parts: [5]owned_styled.Part = undefined;
                    const part_count = 1 + random.uintLessThan(usize, parts.len);
                    model.text.clearRetainingCapacity();
                    model.record_counts = @splat(0);
                    var row: u32 = 0;
                    var col: u32 = 0;
                    for (parts[0..part_count]) |*part| {
                        const def = SpanModel.randomDef(random);
                        part.* = .{ .text = inserts[random.uintLessThan(usize, inserts.len)], .fg = def.fg, .bg = def.bg, .attributes = def.attributes };
                        try model.text.appendSlice(gpa, part.text);
                        var start_col = col;
                        var index: usize = 0;
                        while (index < part.text.len) {
                            const length: u32 = std.unicode.utf8ByteSequenceLength(part.text[index]) catch unreachable;
                            if (part.text[index] == '\n') {
                                if (col > start_col) model.add(row, .{ .col_start = start_col, .col_end = col, .priority = 1, .ref = 0, .style_id = 0, .value = def });
                                row += 1;
                                col = 0;
                                start_col = 0;
                            } else col += charCols(part.text[index], length, model.tab_width);
                            index += length;
                        }
                        if (col > start_col) model.add(row, .{ .col_start = start_col, .col_end = col, .priority = 1, .ref = 0, .style_id = 0, .value = def });
                    }
                    _ = try owned_styled.replace(tb, null, parts[0..part_count]);
                    model.layers.reset();
                    model.layers.byte_count = @intCast(model.text.items.len);
                },
                11 => if (random.uintLessThan(u8, 3) == 0) {
                    // User records stay on lines the new text still has; styled-text records and
                    // layers go.
                    const replacement = replacements[random.uintLessThan(usize, replacements.len)];
                    if (eb) |value| try value.setText(replacement) else try tb.setText(replacement);
                    model.text.clearRetainingCapacity();
                    try model.text.appendSlice(gpa, replacement);
                    for (&model.records, &model.record_counts, 0..) |*list, *count, row| {
                        var kept: usize = 0;
                        if (row < model.lineCount()) for (list[0..count.*]) |record| if (record.value == null) {
                            list[kept] = record;
                            kept += 1;
                        };
                        count.* = kept;
                    }
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
                    const def = SpanModel.randomDef(random);
                    _ = try styles[style].registerStyle(SpanModel.names[name], def.fg, def.bg, def.attributes);
                    model.defs[style][name] = def;
                    try testing.expectEqual(generation, tb.span_generation);
                    try expectModelPaint(&setup, &model, &target, styles[0..]);
                },
                14 => {
                    if (random.boolean()) {
                        model.bound = 1 - model.bound;
                        tb.setSyntaxStyle(styles[model.bound]);
                    } else {
                        // Tab cells move under byte runs without a byte changing.
                        model.tab_width = if (model.tab_width == 2) 4 else 2;
                        tb.setTabWidth(@intCast(model.tab_width));
                    }
                    try expectModelPaint(&setup, &model, &target, styles[0..]);
                },
                15 => {
                    target.wrap_width = if (random.boolean()) null else 4 + random.uintLessThan(u32, 16);
                    target.configure(target.view);
                },
                16 => {
                    // A viewport shorter than the text, scrolled anywhere.
                    target.viewport.height = 4 + random.uintLessThan(u32, SpanModel.line_count_max - 4);
                    target.viewport.y = random.uintLessThan(u32, SpanModel.line_count_max);
                    target.configure(target.view);
                },
                else => try expectModelPaint(&setup, &model, &target, styles[0..]),
            }
            try testing.expectEqualStrings(model.text.items, plainText(tb, &bytes));
            try model.layers.expectEqual(&tb.layers, &layer_ids);
            for (urls[1..]) |id| try testing.expectEqual(1 + model.layers.linkedPieces(id), try setup.pools.links.getRefcount(id));
        }
        try expectModelPaint(&setup, &model, &target, styles[0..]);
    }
}

fn expectModelPaint(setup: *Setup, model: *SpanModel, target: *const ModelTarget, styles: []const *ss.SyntaxStyle) !void {
    const tb = target.tb;
    const width = target.viewport.width;
    const height = target.viewport.height;
    const retained = try setup.screen(width, height);
    defer retained.deinit();
    _ = text_work.take();
    try retained.drawTextBufferChecked(target.view, 0, 0);
    const builds = text_work.take().line_span_builds;

    // The rows the viewport shows, by virtual line (the view returns the viewport's slice).
    const shown = target.view.getVirtualLines();
    var painted_lines: u32 = 0;
    for (shown, 0..) |vline, index| {
        const row: u32 = @intCast(vline.source_line);
        if (index == 0 or shown[index - 1].source_line != vline.source_line) painted_lines += 1;
        try model.painted.put(gpa, row, {});
    }
    // Only painted lines are built, and only painted lines hold entries.
    try testing.expect(builds <= painted_lines);
    var keys = tb.line_spans.keyIterator();
    while (keys.next()) |row| try testing.expect(model.painted.contains(row.*));

    // get_highlights reports exactly the records, in add order.
    for (0..model.lineCount()) |row| {
        const actual = tb.getLineHighlights(row);
        try testing.expectEqual(model.record_counts[row], actual.len);
        for (model.records[row][0..model.record_counts[row]], actual) |want, got| {
            try testing.expectEqual([4]u32{ want.col_start, want.col_end, want.priority, want.ref }, [4]u32{ got.col_start, got.col_end, got.priority, got.hl_ref });
            if (want.value == null) try testing.expectEqual(want.style_id, got.style_id);
        }
    }

    // Each shown character against the model.
    var line_starts: [SpanModel.line_count_max + 1]u32 = undefined;
    var lines = std.mem.splitScalar(u8, model.text.items, '\n');
    var line_count: usize = 0;
    var byte: u32 = 0;
    while (lines.next()) |line| : (line_count += 1) {
        line_starts[line_count] = byte;
        byte += @as(u32, @intCast(line.len)) + 1;
    }
    for (shown, 0..) |vline, y| {
        const row: u32 = @intCast(vline.source_line);
        const start = line_starts[row];
        const end = if (row + 1 < line_count) line_starts[row + 1] - 1 else @as(u32, @intCast(model.text.items.len));
        const line = model.text.items[start..end];
        var index: u32 = 0;
        var col: u32 = 0;
        while (index < line.len) {
            const length: u32 = std.unicode.utf8ByteSequenceLength(line[index]) catch unreachable;
            if (col >= vline.source_col_start and col < vline.source_col_start + vline.width_cols and col - vline.source_col_start < width) {
                const want = model.expected(row, col, start + index, model_defaults);
                const cell = retained.get(col - vline.source_col_start, @intCast(y)).?;
                const got: SpanModel.Cell = .{ .fg = cell.fg, .bg = cell.bg, .attributes = cell.attributes };
                if (!std.meta.eql(want, got)) {
                    std.debug.print("line {d} col {d} byte {d} y {d} vp {any} wrap {any} vlines {d} char {d}\n", .{ row, col, start + index, y, target.viewport, target.wrap_width, shown.len, retained.get(col - vline.source_col_start, @intCast(y)).?.char });
                    try testing.expectEqualDeep(want, got);
                }
            }
            col += charCols(line[index], length, model.tab_width);
            index += length;
        }
    }

    // A forced full repaint: a new view, every span stale, the composition caches empty. The
    // stamps go back after, so the next paint still sees only what the events invalidated.
    const generation = tb.span_generation;
    tb.span_generation += 1;
    for (styles) |style| style.group_set_cache.clearRetainingCapacity();
    const fresh_view = try TextBufferView.init(gpa, tb);
    defer fresh_view.deinit();
    target.configure(fresh_view);
    const fresh = try setup.screen(width, height);
    defer fresh.deinit();
    try fresh.drawTextBufferChecked(fresh_view, 0, 0);
    var y: u32 = 0;
    while (y < height) : (y += 1) {
        var x: u32 = 0;
        while (x < width) : (x += 1) try testing.expectEqualDeep(retained.get(x, y).?, fresh.get(x, y).?);
    }
    tb.span_generation = generation;
    var entries = tb.line_spans.valueIterator();
    while (entries.next()) |entry| {
        if (entry.generation == generation + 1) entry.generation = generation;
    }
}
