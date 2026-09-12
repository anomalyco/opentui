const std = @import("std");
const syntax_style = @import("../syntax-style.zig");
const ansi = @import("../ansi.zig");

const SyntaxStyle = syntax_style.SyntaxStyle;
const StyleDefinition = syntax_style.StyleDefinition;
const RGBA = syntax_style.RGBA;

test "SyntaxStyle - init and deinit" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    try std.testing.expectEqual(@as(usize, 0), style.getStyleCount());
}

test "SyntaxStyle - multiple independent instances" {
    const style1 = try SyntaxStyle.init(std.testing.allocator);
    defer style1.deinit();

    const style2 = try SyntaxStyle.init(std.testing.allocator);
    defer style2.deinit();

    const fg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    _ = try style1.registerStyle("test", fg, null, 0);

    try std.testing.expectEqual(@as(usize, 1), style1.getStyleCount());
    try std.testing.expectEqual(@as(usize, 0), style2.getStyleCount());
}

test "SyntaxStyle - register simple style" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const fg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const id = try style.registerStyle("keyword", fg, null, 0);

    try std.testing.expect(id > 0);
    try std.testing.expectEqual(@as(usize, 1), style.getStyleCount());
}

test "SyntaxStyle - register style with fg and bg" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const fg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const id = try style.registerStyle("string", fg, bg, 0);

    try std.testing.expect(id > 0);
    try std.testing.expectEqual(@as(usize, 1), style.getStyleCount());
}

test "SyntaxStyle - register style with attributes" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const fg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const attributes: u32 = 0b0001; // Bold
    const id = try style.registerStyle("bold-keyword", fg, null, attributes);

    try std.testing.expect(id > 0);

    const resolved = style.resolveById(id).?;
    try std.testing.expectEqual(attributes, resolved.attributes);
}

test "SyntaxStyle - register style with all attributes" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const fg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const attributes: u32 = 0b1111; // Bold, italic, underline, dim
    const id = try style.registerStyle("all-attrs", fg, null, attributes);

    try std.testing.expect(id > 0);

    const resolved = style.resolveById(id).?;
    try std.testing.expectEqual(attributes, resolved.attributes);
}

test "SyntaxStyle - register style without colors" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const id = try style.registerStyle("plain", null, null, 0);

    try std.testing.expect(id > 0);

    const resolved = style.resolveById(id).?;
    try std.testing.expect(resolved.fg == null);
    try std.testing.expect(resolved.bg == null);
}

test "SyntaxStyle - register multiple styles" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const fg1 = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const fg2 = ansi.rgbaFromFloats(0.0, 1.0, 0.0, 1.0);
    const fg3 = ansi.rgbaFromFloats(0.0, 0.0, 1.0, 1.0);

    const id1 = try style.registerStyle("keyword", fg1, null, 0);
    const id2 = try style.registerStyle("string", fg2, null, 0);
    const id3 = try style.registerStyle("comment", fg3, null, 0);

    try std.testing.expect(id1 != id2);
    try std.testing.expect(id2 != id3);
    try std.testing.expect(id1 != id3);
    try std.testing.expectEqual(@as(usize, 3), style.getStyleCount());
}

test "SyntaxStyle - register same name returns same ID" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const fg1 = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const fg2 = ansi.rgbaFromFloats(0.0, 1.0, 0.0, 1.0);

    const id1 = try style.registerStyle("keyword", fg1, null, 0);
    const id2 = try style.registerStyle("keyword", fg2, null, 0);

    try std.testing.expectEqual(id1, id2);
    try std.testing.expectEqual(@as(usize, 1), style.getStyleCount());

    const resolved = style.resolveById(id2).?;
    try std.testing.expectEqual(fg2[0], resolved.fg.?[0]);
    try std.testing.expectEqual(fg2[1], resolved.fg.?[1]);
}

test "SyntaxStyle - register style with special characters" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const fg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    _ = try style.registerStyle("keyword.control", fg, null, 0);
    _ = try style.registerStyle("variable.parameter", fg, null, 0);
    _ = try style.registerStyle("meta.tag.xml", fg, null, 0);

    try std.testing.expectEqual(@as(usize, 3), style.getStyleCount());
}

test "SyntaxStyle - register many styles" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const count = 100;
    var ids: [count]u32 = undefined;

    for (0..count) |i| {
        var name_buffer: [32]u8 = undefined;
        const name = try std.fmt.bufPrint(&name_buffer, "style-{d}", .{i});

        const fg = ansi.rgbaFromFloats(@as(f32, @floatFromInt(i)) / 100.0, 0.0, 0.0, 1.0);
        ids[i] = try style.registerStyle(name, fg, null, 0);
    }

    try std.testing.expectEqual(@as(usize, count), style.getStyleCount());

    for (ids, 0..count) |id1, i| {
        for (ids[i + 1 ..]) |id2| {
            try std.testing.expect(id1 != id2);
        }
    }
}

test "SyntaxStyle - resolveById returns correct style" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const fg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const attributes: u32 = 0b0011; // Bold + italic

    const id = try style.registerStyle("test", fg, bg, attributes);
    const resolved = style.resolveById(id).?;

    try std.testing.expectEqual(fg[0], resolved.fg.?[0]);
    try std.testing.expectEqual(bg[0], resolved.bg.?[0]);
    try std.testing.expectEqual(attributes, resolved.attributes);
}

test "SyntaxStyle - resolveById invalid ID returns null" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const resolved = style.resolveById(9999);
    try std.testing.expect(resolved == null);
}

test "SyntaxStyle - resolveById zero returns null" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const resolved = style.resolveById(0);
    try std.testing.expect(resolved == null);
}

test "SyntaxStyle - resolveByName returns correct ID" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const fg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const registered_id = try style.registerStyle("keyword", fg, null, 0);

    const resolved_id = style.resolveByName("keyword").?;
    try std.testing.expectEqual(registered_id, resolved_id);
}

test "SyntaxStyle - resolveByName non-existent returns null" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const resolved = style.resolveByName("nonexistent");
    try std.testing.expect(resolved == null);
}

test "SyntaxStyle - resolveByName is case-sensitive" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const fg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    _ = try style.registerStyle("keyword", fg, null, 0);

    try std.testing.expect(style.resolveByName("keyword") != null);
    try std.testing.expect(style.resolveByName("Keyword") == null);
    try std.testing.expect(style.resolveByName("KEYWORD") == null);
}

test "SyntaxStyle - resolve multiple styles" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const fg1 = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const fg2 = ansi.rgbaFromFloats(0.0, 1.0, 0.0, 1.0);

    const id1 = try style.registerStyle("keyword", fg1, null, 0);
    const id2 = try style.registerStyle("string", fg2, null, 0);

    try std.testing.expectEqual(id1, style.resolveByName("keyword").?);
    try std.testing.expectEqual(id2, style.resolveByName("string").?);
}

test "SyntaxStyle - merge single style" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const fg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const attributes: u32 = 0b0001;

    const id = try style.registerStyle("keyword", fg, null, attributes);

    const ids = [_]u32{id};
    const merged = try style.mergeStyles(&ids);

    try std.testing.expectEqual(fg[0], merged.fg.?[0]);
    try std.testing.expectEqual(attributes, merged.attributes);
}

test "SyntaxStyle - merge two styles" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const fg1 = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const fg2 = ansi.rgbaFromFloats(0.0, 1.0, 0.0, 1.0);
    const bg2 = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);

    const id1 = try style.registerStyle("base", fg1, null, 0b0001); // Bold
    const id2 = try style.registerStyle("modifier", fg2, bg2, 0b0010); // Italic

    const ids = [_]u32{ id1, id2 };
    const merged = try style.mergeStyles(&ids);

    try std.testing.expectEqual(fg2[0], merged.fg.?[0]);
    try std.testing.expectEqual(bg2[0], merged.bg.?[0]);
    try std.testing.expectEqual(@as(u32, 0b0011), merged.attributes);
}

test "SyntaxStyle - merge three styles" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const fg1 = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const fg2 = ansi.rgbaFromFloats(0.0, 1.0, 0.0, 1.0);
    const fg3 = ansi.rgbaFromFloats(0.0, 0.0, 1.0, 1.0);

    const id1 = try style.registerStyle("s1", fg1, null, 0b0001); // Bold
    const id2 = try style.registerStyle("s2", fg2, null, 0b0010); // Italic
    const id3 = try style.registerStyle("s3", fg3, null, 0b0100); // Underline

    const ids = [_]u32{ id1, id2, id3 };
    const merged = try style.mergeStyles(&ids);

    try std.testing.expectEqual(fg3[0], merged.fg.?[0]);
    try std.testing.expectEqual(@as(u32, 0b0111), merged.attributes);
}

test "SyntaxStyle - merge empty array" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const ids: []const u32 = &[_]u32{};
    const merged = try style.mergeStyles(ids);

    try std.testing.expect(merged.fg == null);
    try std.testing.expect(merged.bg == null);
    try std.testing.expectEqual(@as(u32, 0), merged.attributes);
}

test "SyntaxStyle - merge with invalid ID skips it" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const fg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const id1 = try style.registerStyle("valid", fg, null, 0b0001);

    const ids = [_]u32{ id1, 9999 }; // 9999 is invalid
    const merged = try style.mergeStyles(&ids);

    try std.testing.expectEqual(fg[0], merged.fg.?[0]);
    try std.testing.expectEqual(@as(u32, 0b0001), merged.attributes);
}

test "SyntaxStyle - merge caches results" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const fg1 = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const fg2 = ansi.rgbaFromFloats(0.0, 1.0, 0.0, 1.0);

    const id1 = try style.registerStyle("s1", fg1, null, 0);
    const id2 = try style.registerStyle("s2", fg2, null, 0);

    const ids = [_]u32{ id1, id2 };

    const merged1 = try style.mergeStyles(&ids);
    const merged2 = try style.mergeStyles(&ids);

    try std.testing.expectEqual(merged1.fg.?[0], merged2.fg.?[0]);
    try std.testing.expect(style.getCacheSize() > 0);
}

test "SyntaxStyle - merge different order produces different results" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const fg1 = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const fg2 = ansi.rgbaFromFloats(0.0, 1.0, 0.0, 1.0);

    const id1 = try style.registerStyle("s1", fg1, null, 0);
    const id2 = try style.registerStyle("s2", fg2, null, 0);

    const ids1 = [_]u32{ id1, id2 };
    const ids2 = [_]u32{ id2, id1 };

    const merged1 = try style.mergeStyles(&ids1);
    const merged2 = try style.mergeStyles(&ids2);

    try std.testing.expect(merged1.fg.?[0] != merged2.fg.?[0]);
}

test "SyntaxStyle - clearCache empties cache" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const fg1 = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const fg2 = ansi.rgbaFromFloats(0.0, 1.0, 0.0, 1.0);

    const id1 = try style.registerStyle("s1", fg1, null, 0);
    const id2 = try style.registerStyle("s2", fg2, null, 0);

    const ids = [_]u32{ id1, id2 };
    _ = try style.mergeStyles(&ids);

    try std.testing.expect(style.getCacheSize() > 0);

    style.clearCache();

    try std.testing.expectEqual(@as(usize, 0), style.getCacheSize());
}

test "SyntaxStyle - clearCache preserves styles" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const fg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    _ = try style.registerStyle("keyword", fg, null, 0);
    _ = try style.registerStyle("string", fg, null, 0);

    const count_before = style.getStyleCount();
    style.clearCache();
    const count_after = style.getStyleCount();

    try std.testing.expectEqual(count_before, count_after);
}

test "SyntaxStyle - getCacheSize returns correct count" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    try std.testing.expectEqual(@as(usize, 0), style.getCacheSize());

    const fg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const id1 = try style.registerStyle("s1", fg, null, 0);
    const id2 = try style.registerStyle("s2", fg, null, 0);

    const ids1 = [_]u32{id1};
    const ids2 = [_]u32{id2};
    const ids_both = [_]u32{ id1, id2 };

    _ = try style.mergeStyles(&ids1);
    try std.testing.expectEqual(@as(usize, 1), style.getCacheSize());

    _ = try style.mergeStyles(&ids2);
    try std.testing.expectEqual(@as(usize, 2), style.getCacheSize());

    _ = try style.mergeStyles(&ids_both);
    try std.testing.expectEqual(@as(usize, 3), style.getCacheSize());
}

test "SyntaxStyle - very long style name" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    var long_name: [1000]u8 = undefined;
    @memset(&long_name, 'a');

    const fg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const id = try style.registerStyle(&long_name, fg, null, 0);

    try std.testing.expect(id > 0);
    try std.testing.expectEqual(id, style.resolveByName(&long_name).?);
}

test "SyntaxStyle - empty string style name" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const fg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const id = try style.registerStyle("", fg, null, 0);

    try std.testing.expect(id > 0);
    try std.testing.expectEqual(id, style.resolveByName("").?);
}

test "SyntaxStyle - unicode style names" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const fg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    const id1 = try style.registerStyle("关键字", fg, null, 0);
    const id2 = try style.registerStyle("キーワード", fg, null, 0);
    const id3 = try style.registerStyle("🔑", fg, null, 0);

    try std.testing.expectEqual(@as(usize, 3), style.getStyleCount());
    try std.testing.expect(id1 != id2);
    try std.testing.expect(id2 != id3);
}

test "SyntaxStyle - all color channels" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const fg = ansi.rgbaFromFloats(0.1, 0.2, 0.3, 0.4);
    const bg = ansi.rgbaFromFloats(0.5, 0.6, 0.7, 0.8);

    const id = try style.registerStyle("test", fg, bg, 0);
    const resolved = style.resolveById(id).?;

    try std.testing.expectEqual(fg[0], resolved.fg.?[0]);
    try std.testing.expectEqual(fg[1], resolved.fg.?[1]);
    try std.testing.expectEqual(fg[2], resolved.fg.?[2]);
    try std.testing.expectEqual(fg[3], resolved.fg.?[3]);

    try std.testing.expectEqual(bg[0], resolved.bg.?[0]);
    try std.testing.expectEqual(bg[1], resolved.bg.?[1]);
    try std.testing.expectEqual(bg[2], resolved.bg.?[2]);
    try std.testing.expectEqual(bg[3], resolved.bg.?[3]);
}

test "SyntaxStyle - stress test many registrations" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const count = 1000;
    for (0..count) |i| {
        var name_buffer: [32]u8 = undefined;
        const name = try std.fmt.bufPrint(&name_buffer, "style-{d}", .{i});

        const fg = ansi.rgbaFromFloats(@as(f32, @floatFromInt(i % 256)) / 255.0, 0.0, 0.0, 1.0);
        _ = try style.registerStyle(name, fg, null, 0);
    }

    try std.testing.expectEqual(@as(usize, count), style.getStyleCount());
}

test "SyntaxStyle - stress test many merges" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const fg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const id1 = try style.registerStyle("s1", fg, null, 0);
    const id2 = try style.registerStyle("s2", fg, null, 0);
    const id3 = try style.registerStyle("s3", fg, null, 0);

    for (0..100) |_| {
        const ids = [_]u32{ id1, id2, id3 };
        _ = try style.mergeStyles(&ids);
    }

    try std.testing.expectEqual(@as(usize, 1), style.getCacheSize());
}

test "SyntaxStyle - merge many styles at once" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const count = 50;
    var ids: [count]u32 = undefined;

    const fg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    for (0..count) |i| {
        var name_buffer: [32]u8 = undefined;
        const name = try std.fmt.bufPrint(&name_buffer, "s{d}", .{i});
        ids[i] = try style.registerStyle(name, fg, null, @as(u8, @intCast(i % 4)));
    }

    const merged = try style.mergeStyles(&ids);

    try std.testing.expect(merged.attributes != 0);
}

test "SyntaxStyle - multiple init/deinit cycles" {
    for (0..10) |_| {
        const style = try SyntaxStyle.init(std.testing.allocator);
        const fg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
        _ = try style.registerStyle("test", fg, null, 0);
        style.deinit();
    }
}

test "SyntaxStyle - register and resolve after clear cache" {
    const style = try SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    const fg = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const id = try style.registerStyle("keyword", fg, null, 0);

    const ids = [_]u32{id};
    _ = try style.mergeStyles(&ids);

    style.clearCache();

    try std.testing.expectEqual(id, style.resolveByName("keyword").?);
    const merged = try style.mergeStyles(&ids);
    try std.testing.expectEqual(fg[0], merged.fg.?[0]);
}
