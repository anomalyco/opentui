const std = @import("std");
const syntax_style = @import("../syntax-style.zig");
const ansi = @import("../ansi.zig");

const SyntaxStyle = syntax_style.SyntaxStyle;
const StyleDefinition = syntax_style.StyleDefinition;
const RGBA = syntax_style.RGBA;

test "SyntaxStyle rejection - allocation failures preserve registrations and IDs" {
    var succeeded = false;
    for (0..16) |fail_index| {
        const style = try SyntaxStyle.init(std.testing.allocator);
        defer style.deinit();
        for (0..6) |index| {
            var name_buffer: [16]u8 = undefined;
            const name = try std.fmt.bufPrint(&name_buffer, "accepted-{d}", .{index});
            _ = try style.registerStyle(name, null, null, @intCast(index));
        }
        const allocator = style.allocator;
        var failing = std.testing.FailingAllocator.init(allocator, .{ .fail_index = fail_index, .resize_fail_index = 0 });
        style.allocator = failing.allocator();
        const result = style.registerStyle("candidate", null, null, 42);
        style.allocator = allocator;
        if (result) |id| {
            try std.testing.expect(!failing.has_induced_failure);
            try std.testing.expectEqual(@as(u32, 7), id);
            try std.testing.expectEqual(@as(u32, 42), style.getStyleByName("candidate").?.attributes);
            succeeded = true;
            break;
        } else |err| {
            try std.testing.expectEqual(error.OutOfMemory, err);
            try std.testing.expect(failing.has_induced_failure);
        }
        try std.testing.expectEqual(@as(usize, 6), style.getStyleCount());
        try std.testing.expectEqual(@as(u32, 6), style.name_to_id.count());
        try std.testing.expect(style.resolveByName("candidate") == null);
        try std.testing.expectEqual(@as(u32, 7), style.next_id);
        for (0..6) |index| {
            var name_buffer: [16]u8 = undefined;
            const name = try std.fmt.bufPrint(&name_buffer, "accepted-{d}", .{index});
            try std.testing.expectEqual(@as(u32, @intCast(index + 1)), style.resolveByName(name).?);
            try std.testing.expectEqual(@as(u32, @intCast(index)), style.getStyleByName(name).?.attributes);
        }
        try std.testing.expectEqual(@as(u32, 7), try style.registerStyle("candidate", null, null, 42));
    }
    try std.testing.expect(succeeded);
}

test "SyntaxStyle rejection - exhausted IDs preserve existing styles" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    style.next_id = std.math.maxInt(u32);
    const id = try style.registerStyle("last", null, null, 1);
    try std.testing.expectEqual(std.math.maxInt(u32), id);
    try std.testing.expectError(error.InvalidId, style.registerStyle("overflow", null, null, 2));
    try std.testing.expect(style.resolveByName("overflow") == null);
    try std.testing.expectEqual(@as(usize, 1), style.getStyleCount());

    const allocator = style.allocator;
    var failing = std.testing.FailingAllocator.init(allocator, .{ .fail_index = 0 });
    style.allocator = failing.allocator();
    defer style.allocator = allocator;
    try std.testing.expectEqual(id, try style.registerStyle("last", null, null, 3));
    try std.testing.expect(!failing.has_induced_failure);
    try std.testing.expectEqual(@as(u32, 3), style.resolveById(id).?.attributes);
}

test "SyntaxStyle - registrations match a name-to-definition model" {
    const allocator = std.testing.allocator;
    const seed = 0x5717;
    var prng = std.Random.DefaultPrng.init(seed);
    const random = prng.random();
    const style = try SyntaxStyle.init(allocator);
    defer style.deinit();
    const other = try SyntaxStyle.init(allocator);
    defer other.deinit();
    const Entry = struct { id: u32, definition: StyleDefinition };
    var model: std.StringArrayHashMapUnmanaged(Entry) = .empty;
    defer model.deinit(allocator);
    const names = [_][]const u8{ "keyword", "Keyword", "", "a.b-c_d@e#f", "\u{4e2d}\u{6587}\u{1f600}", "x" ** 1000, "string", "comment" };
    for (0..400) |step| {
        errdefer std.debug.print("style model failed: seed 0x{x} step {d}\n", .{ seed, step });
        const name = names[random.uintLessThan(usize, names.len)];
        var colors: [2]RGBA = undefined;
        for (&colors) |*color| color.* = .{ random.int(u16), random.int(u16), random.int(u16), random.int(u16) };
        const definition: StyleDefinition = .{
            .fg = if (random.boolean()) colors[0] else null,
            .bg = if (random.boolean()) colors[1] else null,
            .attributes = random.int(u32),
        };
        const id = try style.registerStyle(name, definition.fg, definition.bg, definition.attributes);
        const entry = try model.getOrPut(allocator, name);
        // A new name takes the next ID; a known name keeps its ID and replaces its definition.
        try std.testing.expectEqual(if (entry.found_existing) entry.value_ptr.id else @as(u32, @intCast(model.count())), id);
        entry.value_ptr.* = .{ .id = id, .definition = definition };
        if (step % 40 == 0) {
            // A prepared copy holds every definition and publishes under the same identity.
            const prepared = try style.prepareDefinitions();
            style.publishDefinitions(prepared);
            prepared.deinit();
        }
        try std.testing.expectEqual(model.count(), style.getStyleCount());
        for (model.keys(), model.values()) |key, value| {
            try std.testing.expectEqual(value.id, style.resolveByName(key).?);
            try std.testing.expectEqualDeep(value.definition, style.resolveById(value.id).?);
            try std.testing.expectEqualDeep(value.definition, style.getStyleByName(key).?);
        }
    }
    try std.testing.expect(style.resolveByName("KEYWORD") == null);
    try std.testing.expect(style.resolveById(0) == null);
    try std.testing.expect(style.resolveById(@intCast(model.count() + 1)) == null);
    try std.testing.expectEqual(@as(usize, 0), other.getStyleCount());
}
