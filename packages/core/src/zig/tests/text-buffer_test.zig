const std = @import("std");
const text_buffer = @import("../text-buffer.zig");
const gp = @import("../grapheme.zig");
const iter_mod = @import("../text-buffer-iterators.zig");

const TextBuffer = text_buffer.UnifiedTextBuffer;

test "TextBuffer init - creates empty buffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try std.testing.expectEqual(@as(u32, 0), tb.getLength());
    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount()); // Empty buffer has 1 empty line (invariant)
}

test "TextBuffer line info - empty buffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("");

    try std.testing.expectEqual(@as(u32, 0), tb.getLength());
    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 1), tb.rope.count());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(&tb.rope, 0, 0).?);
    try std.testing.expectEqual(@as(u32, 0), iter_mod.lineWidthAt(&tb.rope, 0));
}

test "TextBuffer line info - simple text without newlines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const text = "Hello World";
    try tb.setText(text);

    try std.testing.expectEqual(@as(u32, 11), tb.getLength());
    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 2), tb.rope.count());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(&tb.rope, 0, 0).?);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 0) > 0);

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqual(@as(usize, 11), written);
    try std.testing.expectEqualStrings(text, out_buffer[0..written]);
}

test "TextBuffer line info - single newline" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello\nWorld");

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(&tb.rope, 0, 0).?);
    try std.testing.expectEqual(@as(u32, 6), iter_mod.coordsToOffset(&tb.rope, 1, 0).?);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 0) > 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 1) > 0);
}

test "TextBuffer line info - multiple lines separated by newlines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const text = "Line 1\nLine 2\nLine 3";
    try tb.setText(text);

    try std.testing.expectEqual(@as(u32, 18), tb.getLength());
    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 8), tb.rope.count());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(&tb.rope, 0, 0).?);
    try std.testing.expectEqual(@as(u32, 7), iter_mod.coordsToOffset(&tb.rope, 1, 0).?);
    try std.testing.expectEqual(@as(u32, 14), iter_mod.coordsToOffset(&tb.rope, 2, 0).?);

    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 0) > 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 1) > 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 2) > 0);

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqual(@as(usize, 20), written);
    try std.testing.expectEqualStrings(text, out_buffer[0..written]);
}

test "TextBuffer line info - text ending with newline" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const text = "Line 1\nLine 2\n";
    try tb.setText(text);

    // Trailing newline creates an empty 3rd line (matches editor semantics)
    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 7), tb.rope.count());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(&tb.rope, 0, 0).?);
    try std.testing.expectEqual(@as(u32, 7), iter_mod.coordsToOffset(&tb.rope, 1, 0).?);
    try std.testing.expectEqual(@as(u32, 14), iter_mod.coordsToOffset(&tb.rope, 2, 0).?);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 0) > 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 1) > 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 2) >= 0); // Empty line
}

test "TextBuffer line info - consecutive newlines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("Line 1\n\nLine 3");

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(&tb.rope, 0, 0).?);
    try std.testing.expectEqual(@as(u32, 7), iter_mod.coordsToOffset(&tb.rope, 1, 0).?);
    try std.testing.expectEqual(@as(u32, 8), iter_mod.coordsToOffset(&tb.rope, 2, 0).?);
}

test "TextBuffer line info - text starting with newline" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("\nHello World");

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(&tb.rope, 0, 0).?);
    try std.testing.expectEqual(@as(u32, 1), iter_mod.coordsToOffset(&tb.rope, 1, 0).?);
}

test "TextBuffer line info - only newlines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("\n\n\n");

    try std.testing.expectEqual(@as(u32, 4), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(&tb.rope, 0, 0).?);
    try std.testing.expectEqual(@as(u32, 1), iter_mod.coordsToOffset(&tb.rope, 1, 0).?);
    try std.testing.expectEqual(@as(u32, 2), iter_mod.coordsToOffset(&tb.rope, 2, 0).?);
    try std.testing.expectEqual(@as(u32, 3), iter_mod.coordsToOffset(&tb.rope, 3, 0).?);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 0) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 1) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 2) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 3) >= 0);
}

test "TextBuffer line info - wide characters (Unicode)" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const text = "Hello 世界 🌟";
    try tb.setText(text);

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(&tb.rope, 0, 0).?);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 0) > 0);

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings(text, out_buffer[0..written]);
}

test "TextBuffer line info - empty lines between content" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("First\n\nThird");

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(&tb.rope, 0, 0).?);
    try std.testing.expectEqual(@as(u32, 6), iter_mod.coordsToOffset(&tb.rope, 1, 0).?);
    try std.testing.expectEqual(@as(u32, 7), iter_mod.coordsToOffset(&tb.rope, 2, 0).?);
}

test "TextBuffer line info - very long lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    // Create a long text with 1000 'A' characters
    const longText = [_]u8{'A'} ** 1000;
    try tb.setText(&longText);

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(&tb.rope, 0, 0).?);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 0) > 0);
}

test "TextBuffer line info - lines with different widths" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    // Create text with different line lengths
    var text_builder: std.ArrayListUnmanaged(u8) = .{};
    defer text_builder.deinit(std.testing.allocator);
    try text_builder.appendSlice(std.testing.allocator, "Short\n");
    try text_builder.appendNTimes(std.testing.allocator, 'A', 50);
    try text_builder.appendSlice(std.testing.allocator, "\nMedium");
    const text = text_builder.items;
    try tb.setText(text);

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 0) < iter_mod.lineWidthAt(&tb.rope, 1));
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 1) > iter_mod.lineWidthAt(&tb.rope, 2));
}

test "TextBuffer line info - text without styling" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    // setText now handles all text at once without styling
    try tb.setText("Red\nBlue");

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(&tb.rope, 0, 0).?);
    try std.testing.expectEqual(@as(u32, 4), iter_mod.coordsToOffset(&tb.rope, 1, 0).?);
}

test "TextBuffer line info - buffer with only whitespace" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("   \n \n ");

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(&tb.rope, 0, 0).?);
    try std.testing.expectEqual(@as(u32, 4), iter_mod.coordsToOffset(&tb.rope, 1, 0).?);
    try std.testing.expectEqual(@as(u32, 6), iter_mod.coordsToOffset(&tb.rope, 2, 0).?);

    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 0) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 1) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 2) >= 0);
}

test "TextBuffer line info - single character lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("A\nB\nC");

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(&tb.rope, 0, 0).?);
    try std.testing.expectEqual(@as(u32, 2), iter_mod.coordsToOffset(&tb.rope, 1, 0).?);
    try std.testing.expectEqual(@as(u32, 4), iter_mod.coordsToOffset(&tb.rope, 2, 0).?);

    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 0) > 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 1) > 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 2) > 0);
}

test "TextBuffer line info - mixed content with special characters" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("Normal\n123\n!@#\n测试\n");

    try std.testing.expectEqual(@as(u32, 5), tb.getLineCount()); // line_count (4 lines + empty line at end)
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 0) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 1) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 2) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 3) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 4) >= 0);
}

test "TextBuffer line info - buffer resize operations" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    // Create a small buffer that will need to resize

    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    // Add text that will cause multiple resizes
    var text_builder: std.ArrayListUnmanaged(u8) = .{};
    defer text_builder.deinit(std.testing.allocator);
    try text_builder.appendNTimes(std.testing.allocator, 'A', 100);
    try text_builder.appendSlice(std.testing.allocator, "\n");
    try text_builder.appendNTimes(std.testing.allocator, 'B', 100);
    const longText = text_builder.items;
    try tb.setText(longText);

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());
}

test "TextBuffer line info - thousands of lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    // Create text with 1000 lines
    var text_builder: std.ArrayListUnmanaged(u8) = .{};
    defer text_builder.deinit(std.testing.allocator);

    var i: u32 = 0;
    while (i < 999) : (i += 1) {
        try text_builder.writer(std.testing.allocator).print("Line {}\n", .{i});
    }
    // Last line without newline
    try text_builder.writer(std.testing.allocator).print("Line {}", .{i});

    try tb.setText(text_builder.items);

    try std.testing.expectEqual(@as(u32, 1000), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(&tb.rope, 0, 0).?);

    // Check that line starts are monotonically increasing
    var line_idx: u32 = 1;
    while (line_idx < 1000) : (line_idx += 1) {
        try std.testing.expect(iter_mod.coordsToOffset(&tb.rope, line_idx, 0).? > iter_mod.coordsToOffset(&tb.rope, line_idx - 1, 0).?);
    }
}

test "TextBuffer line info - alternating empty and content lines" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("\nContent\n\nMore\n\n");

    try std.testing.expectEqual(@as(u32, 6), tb.getLineCount());
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 0) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 1) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 2) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 3) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 4) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 5) >= 0);
}

test "TextBuffer line info - complex Unicode combining characters" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("café\nnaïve\nrésumé");

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 0) > 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 1) > 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 2) > 0);
}

test "TextBuffer line info - simple multi-line text" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("Test\nText");

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(&tb.rope, 0, 0).?);
    try std.testing.expectEqual(@as(u32, 5), iter_mod.coordsToOffset(&tb.rope, 1, 0).?);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 0) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 1) >= 0);
}

test "TextBuffer line info - unicode width method" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello 世界 🌟");

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(&tb.rope, 0, 0).?);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 0) > 0);
}

test "TextBuffer line info - unicode mixed content with special characters" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("Normal\n123\n!@#\n测试\n");

    try std.testing.expectEqual(@as(u32, 5), tb.getLineCount()); // line_count (4 lines + empty line at end)
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 0) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 1) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 2) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 3) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 4) >= 0);
}

test "TextBuffer line info - unicode text without styling" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    // setText now handles all text at once without styling
    try tb.setText("Red\nBlue");

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(&tb.rope, 0, 0).?);
    try std.testing.expectEqual(@as(u32, 4), iter_mod.coordsToOffset(&tb.rope, 1, 0).?);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 0) >= 0);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 1) >= 0);
}

test "TextBuffer line info - extremely long single line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    // Create extremely long text with 10000 'A' characters
    const extremelyLongText = [_]u8{'A'} ** 10000;
    try tb.setText(&extremelyLongText);

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(&tb.rope, 0, 0).?);
    try std.testing.expect(iter_mod.lineWidthAt(&tb.rope, 0) > 0);
}

test "TextBuffer unicode - multi-line with extraction" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const text = "Hello 世界\n🚀 Emoji\nΑλφα";
    try tb.setText(text);

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings(text, out_buffer[0..written]);
}

test "TextBuffer reset - clears all content" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("Some text\nMore text");
    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());

    tb.reset();
    try std.testing.expectEqual(@as(u32, 0), tb.getLength());
    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
}

test "TextBuffer line iteration - walkLines callback" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const text = "First\nSecond\nThird";
    try tb.setText(text);

    const Context = struct {
        lines: std.ArrayListUnmanaged(iter_mod.LineInfo),
        allocator: std.mem.Allocator,

        fn callback(ctx_ptr: *anyopaque, line_info: iter_mod.LineInfo) void {
            const ctx = @as(*@This(), @ptrCast(@alignCast(ctx_ptr)));
            ctx.lines.append(ctx.allocator, line_info) catch {};
        }
    };

    var ctx = Context{ .lines = .{}, .allocator = std.testing.allocator };
    defer ctx.lines.deinit(std.testing.allocator);

    iter_mod.walkLines(&tb.rope, &ctx, Context.callback, true);

    try std.testing.expectEqual(@as(usize, 3), ctx.lines.items.len);
    try std.testing.expectEqual(@as(u32, 0), ctx.lines.items[0].line_idx);
    try std.testing.expectEqual(@as(u32, 5), ctx.lines.items[0].width);

    try std.testing.expectEqual(@as(u32, 1), ctx.lines.items[1].line_idx);
    try std.testing.expectEqual(@as(u32, 6), ctx.lines.items[1].width);

    try std.testing.expectEqual(@as(u32, 2), ctx.lines.items[2].line_idx);
    try std.testing.expectEqual(@as(u32, 5), ctx.lines.items[2].width);
}

test "TextBuffer line queries - comprehensive rope coordinate checks" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("First\nSecond\nThird");

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());

    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(&tb.rope, 0, 0).?);
    try std.testing.expectEqual(@as(u32, 5), iter_mod.lineWidthAt(&tb.rope, 0));

    try std.testing.expectEqual(@as(u32, 6), iter_mod.coordsToOffset(&tb.rope, 1, 0).?);
    try std.testing.expectEqual(@as(u32, 6), iter_mod.lineWidthAt(&tb.rope, 1));

    try std.testing.expectEqual(@as(u32, 13), iter_mod.coordsToOffset(&tb.rope, 2, 0).?);
    try std.testing.expectEqual(@as(u32, 5), iter_mod.lineWidthAt(&tb.rope, 2));

    try std.testing.expectEqual(@as(u32, 6), iter_mod.getMaxLineWidth(&tb.rope));
}

// ===== View Registration Tests =====

test "TextBuffer view registration - multiple views can be created" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const id1 = try tb.registerView();
    const id2 = try tb.registerView();
    const id3 = try tb.registerView();

    try std.testing.expect(id1 != id2);
    try std.testing.expect(id2 != id3);
    try std.testing.expect(id1 != id3);

    tb.unregisterView(id1);
    tb.unregisterView(id2);
    tb.unregisterView(id3);
}

test "TextBuffer view registration - views marked dirty on setText" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const id1 = try tb.registerView();
    defer tb.unregisterView(id1);

    try std.testing.expect(tb.isViewDirty(id1));

    tb.clearViewDirty(id1);
    try std.testing.expect(!tb.isViewDirty(id1));

    try tb.setText("Hello World");
    try std.testing.expect(tb.isViewDirty(id1));

    tb.clearViewDirty(id1);
    try std.testing.expect(!tb.isViewDirty(id1));

    try tb.setText("New text");
    try std.testing.expect(tb.isViewDirty(id1));
}

test "TextBuffer view registration - views marked dirty on reset" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const id1 = try tb.registerView();
    defer tb.unregisterView(id1);

    tb.clearViewDirty(id1);
    try std.testing.expect(!tb.isViewDirty(id1));

    tb.reset();
    try std.testing.expect(tb.isViewDirty(id1));
}

test "TextBuffer view registration - ID reuse after unregister" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const id1 = try tb.registerView();
    tb.unregisterView(id1);

    const id2 = try tb.registerView();
    defer tb.unregisterView(id2);

    try std.testing.expectEqual(id1, id2);

    try std.testing.expect(tb.isViewDirty(id2));
}

test "TextBuffer view registration - multiple views all marked dirty on setText" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const id1 = try tb.registerView();
    defer tb.unregisterView(id1);

    const id2 = try tb.registerView();
    defer tb.unregisterView(id2);

    const id3 = try tb.registerView();
    defer tb.unregisterView(id3);

    tb.clearViewDirty(id1);
    tb.clearViewDirty(id2);
    tb.clearViewDirty(id3);

    try std.testing.expect(!tb.isViewDirty(id1));
    try std.testing.expect(!tb.isViewDirty(id2));
    try std.testing.expect(!tb.isViewDirty(id3));

    try tb.setText("Test");

    try std.testing.expect(tb.isViewDirty(id1));
    try std.testing.expect(tb.isViewDirty(id2));
    try std.testing.expect(tb.isViewDirty(id3));
}

// ===== Memory Registry Tests =====

test "TextBuffer memory registry - register and get buffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const text = "Hello World";
    const mem_id = try tb.registerMemBuffer(text, false);

    const retrieved = tb.getMemBuffer(mem_id);
    try std.testing.expect(retrieved != null);
    try std.testing.expectEqualStrings(text, retrieved.?);
}

test "TextBuffer memory registry - multiple buffers" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const text1 = "First buffer";
    const text2 = "Second buffer";
    const text3 = "Third buffer";

    const id1 = try tb.registerMemBuffer(text1, false);
    const id2 = try tb.registerMemBuffer(text2, false);
    const id3 = try tb.registerMemBuffer(text3, false);

    try std.testing.expect(id1 != id2);
    try std.testing.expect(id2 != id3);
    try std.testing.expect(id1 != id3);

    try std.testing.expectEqualStrings(text1, tb.getMemBuffer(id1).?);
    try std.testing.expectEqualStrings(text2, tb.getMemBuffer(id2).?);
    try std.testing.expectEqualStrings(text3, tb.getMemBuffer(id3).?);
}

test "TextBuffer memory registry - invalid ID returns null" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    // Try to get buffer with ID that doesn't exist
    const result = tb.getMemBuffer(99);
    try std.testing.expect(result == null);
}

test "TextBuffer memory registry - addLine from single buffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const text = "Hello World";
    const mem_id = try tb.registerMemBuffer(text, false);

    // Add line from buffer
    try tb.addLine(mem_id, 0, 5); // "Hello"

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 5), tb.getLength());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Hello", out_buffer[0..written]);
}

test "TextBuffer memory registry - addLine from multiple buffers" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const text1 = "First line";
    const text2 = "Second line";
    const text3 = "Third line";

    const id1 = try tb.registerMemBuffer(text1, false);
    const id2 = try tb.registerMemBuffer(text2, false);
    const id3 = try tb.registerMemBuffer(text3, false);

    try tb.addLine(id1, 0, 10);
    try tb.addLine(id2, 0, 11);
    try tb.addLine(id3, 0, 10);

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("First line\nSecond line\nThird line", out_buffer[0..written]);
}

test "TextBuffer memory registry - addLine with invalid mem_id" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    // Try to add line with invalid mem_id
    const result = tb.addLine(99, 0, 5);
    try std.testing.expectError(text_buffer.TextBufferError.InvalidMemId, result);
}

test "TextBuffer memory registry - mixed with setText" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("Initial text");
    try std.testing.expectEqual(@as(u32, 12), tb.getLength());

    const text = "New text";
    const mem_id = try tb.registerMemBuffer(text, false);
    try tb.addLine(mem_id, 0, 8);

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());
}

test "TextBuffer memory registry - reset clears memory buffers" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const text = "Hello";
    const mem_id = try tb.registerMemBuffer(text, false);
    try tb.addLine(mem_id, 0, 5);

    tb.reset();

    // Old mem_id should no longer be valid
    try std.testing.expect(tb.getMemBuffer(mem_id) == null);
    try std.testing.expectEqual(@as(u32, 0), tb.getLength());
}

test "TextBuffer clear - preserves memory buffers" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const text = "Hello World";
    const mem_id = try tb.registerMemBuffer(text, false);
    try tb.addLine(mem_id, 0, 5); // "Hello"

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 5), tb.getLength());

    // Clear should empty the buffer but preserve memory registry
    tb.clear();

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount()); // Empty buffer has 1 empty line
    try std.testing.expectEqual(@as(u32, 0), tb.getLength());

    // mem_id should still be valid
    const retrieved = tb.getMemBuffer(mem_id);
    try std.testing.expect(retrieved != null);
    try std.testing.expectEqualStrings(text, retrieved.?);

    // We can re-use the same mem_id after clear
    try tb.addLine(mem_id, 6, 11); // "World"
    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 5), tb.getLength());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("World", out_buffer[0..written]);
}

test "TextBuffer setText - preserves previously registered memory buffers" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    // Register a memory buffer
    const old_text = "Previous content";
    const old_mem_id = try tb.registerMemBuffer(old_text, false);

    // Set some text using setText (which now calls clear() not reset())
    try tb.setText("New text content");

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());

    // The old mem_id should still be valid after setText
    const retrieved = tb.getMemBuffer(old_mem_id);
    try std.testing.expect(retrieved != null);
    try std.testing.expectEqualStrings(old_text, retrieved.?);

    // We can still use the old mem_id
    tb.clear();
    try tb.addLine(old_mem_id, 0, 8); // "Previous"
    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Previous", out_buffer[0..written]);
}

test "TextBuffer setStyledText - preserves previously registered memory buffers" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    // Register a memory buffer before setStyledText
    const preserved_text = "Preserved data";
    const preserved_mem_id = try tb.registerMemBuffer(preserved_text, false);

    // Use setStyledText (which now calls clear() not reset())
    const chunk1_text = "Styled ";
    const chunk2_text = "Text";
    const chunks = [_]text_buffer.StyledChunk{
        .{
            .text_ptr = chunk1_text.ptr,
            .text_len = chunk1_text.len,
            .fg_ptr = null,
            .bg_ptr = null,
            .attributes = 0,
        },
        .{
            .text_ptr = chunk2_text.ptr,
            .text_len = chunk2_text.len,
            .fg_ptr = null,
            .bg_ptr = null,
            .attributes = 0,
        },
    };
    try tb.setStyledText(&chunks);

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());

    // The preserved mem_id should still be valid
    const retrieved = tb.getMemBuffer(preserved_mem_id);
    try std.testing.expect(retrieved != null);
    try std.testing.expectEqualStrings(preserved_text, retrieved.?);

    // We can use the preserved buffer
    tb.clear();
    try tb.addLine(preserved_mem_id, 0, 9); // "Preserved"
    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Preserved", out_buffer[0..written]);
}

test "TextBuffer clear vs reset - memory registry behavior" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const text = "Test buffer";
    const mem_id = try tb.registerMemBuffer(text, false);
    try tb.addLine(mem_id, 0, 4); // "Test"

    // clear() preserves memory buffers
    tb.clear();
    try std.testing.expect(tb.getMemBuffer(mem_id) != null);
    try std.testing.expectEqual(@as(u32, 0), tb.getLength());

    // Restore content
    try tb.addLine(mem_id, 5, 11); // "buffer"
    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());

    // reset() clears memory buffers
    tb.reset();
    try std.testing.expect(tb.getMemBuffer(mem_id) == null);
    try std.testing.expectEqual(@as(u32, 0), tb.getLength());
}

test "TextBuffer memory registry - partial buffer slices" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const full_text = "0123456789ABCDEFGHIJ";
    const mem_id = try tb.registerMemBuffer(full_text, false);

    try tb.addLine(mem_id, 0, 5); // "01234"
    try tb.addLine(mem_id, 5, 10); // "56789"
    try tb.addLine(mem_id, 10, 20); // "ABCDEFGHIJ"

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("01234\n56789\nABCDEFGHIJ", out_buffer[0..written]);
}

test "TextBuffer memory registry - unicode text from buffers" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const text1 = "Hello 世界";
    const text2 = "🌟 Test";

    const id1 = try tb.registerMemBuffer(text1, false);
    const id2 = try tb.registerMemBuffer(text2, false);

    try tb.addLine(id1, 0, @intCast(text1.len));
    try tb.addLine(id2, 0, @intCast(text2.len));

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    const expected = "Hello 世界\n🌟 Test";
    try std.testing.expectEqualStrings(expected, out_buffer[0..written]);
}

test "TextBuffer memory registry - getByteSize with multiple buffers" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const text1 = "Hello"; // 5 bytes
    const text2 = "World"; // 5 bytes

    const id1 = try tb.registerMemBuffer(text1, false);
    const id2 = try tb.registerMemBuffer(text2, false);

    try tb.addLine(id1, 0, 5);
    try tb.addLine(id2, 0, 5);

    const byte_size = tb.getByteSize();
    try std.testing.expectEqual(@as(u32, 11), byte_size);
}

test "TextBuffer memory registry - views marked dirty on addLine" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const view_id = try tb.registerView();
    defer tb.unregisterView(view_id);

    tb.clearViewDirty(view_id);
    try std.testing.expect(!tb.isViewDirty(view_id));

    const text = "Hello";
    const mem_id = try tb.registerMemBuffer(text, false);
    try tb.addLine(mem_id, 0, 5);

    try std.testing.expect(tb.isViewDirty(view_id));
}

test "TextBuffer memory registry - empty chunk handling" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const text = "Hello World";
    const mem_id = try tb.registerMemBuffer(text, false);

    // Add line with empty slice (start == end)
    try tb.addLine(mem_id, 5, 5);

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), tb.getLength());
}

test "TextBuffer memory registry - buffer limit of 255" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    // Register 255 buffers (the maximum for u8)
    var i: u32 = 0;
    while (i < 255) : (i += 1) {
        const text = "Buffer";
        _ = try tb.registerMemBuffer(text, false);
    }

    // Try to register 256th buffer - should fail
    const result = tb.registerMemBuffer("One more", false);
    try std.testing.expectError(text_buffer.TextBufferError.OutOfMemory, result);
}

test "TextBuffer memory registry - owned buffer memory management" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    // Allocate a buffer that the TextBuffer should own and free
    const owned_text = try std.testing.allocator.dupe(u8, "Owned text");
    const mem_id = try tb.registerMemBuffer(owned_text, true);

    try tb.addLine(mem_id, 0, 10);

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());

    // tb.deinit() should free the owned buffer
    // If there's a memory leak, the test allocator will catch it
}

test "TextBuffer memory registry - byte range out of bounds" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const text = "Hello"; // Only 5 bytes
    const mem_id = try tb.registerMemBuffer(text, false);

    // This should panic in debug mode or cause undefined behavior
    // We can't easily test this without catching panics, but we can document it
    // try tb.addLine(mem_id, 0, 100); // Would access out of bounds

    // Test that valid range works
    try tb.addLine(mem_id, 0, 5);
    try std.testing.expectEqual(@as(u32, 5), tb.getLength());
}

test "TextBuffer memory registry - character range highlights across buffers" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const text1 = "Line One";
    const text2 = "Line Two";

    const id1 = try tb.registerMemBuffer(text1, false);
    const id2 = try tb.registerMemBuffer(text2, false);

    try tb.addLine(id1, 0, 8);
    try tb.addLine(id2, 0, 8);

    // Add highlight spanning both lines (from different buffers)
    try tb.addHighlightByCharRange(3, 11, 1, 1, 0);

    const line0_highlights = tb.getLineHighlights(0);
    const line1_highlights = tb.getLineHighlights(1);

    try std.testing.expectEqual(@as(usize, 1), line0_highlights.len);
    try std.testing.expectEqual(@as(usize, 1), line1_highlights.len);
}

test "TextBuffer memory registry - empty buffer registration" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const empty_text = "";
    const mem_id = try tb.registerMemBuffer(empty_text, false);

    const retrieved = tb.getMemBuffer(mem_id);
    try std.testing.expect(retrieved != null);
    try std.testing.expectEqual(@as(usize, 0), retrieved.?.len);
}

test "TextBuffer memory registry - same buffer registered multiple times" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const text = "Shared buffer";

    // Register the same buffer multiple times (different IDs)
    const id1 = try tb.registerMemBuffer(text, false);
    const id2 = try tb.registerMemBuffer(text, false);
    const id3 = try tb.registerMemBuffer(text, false);

    // IDs should be different
    try std.testing.expect(id1 != id2);
    try std.testing.expect(id2 != id3);

    // Use different slices of the same registered buffer
    try tb.addLine(id1, 0, 6); // "Shared"
    try tb.addLine(id2, 7, 13); // "buffer"
    try tb.addLine(id3, 0, 13); // "Shared buffer"

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Shared\nbuffer\nShared buffer", out_buffer[0..written]);
}

// ===== setText SIMD Line Break Tests =====

test "TextBuffer setText - CRLF line endings (Windows)" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("Line1\r\nLine2\r\nLine3");

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(&tb.rope, 0, 0).?);
    try std.testing.expectEqual(@as(u32, 6), iter_mod.coordsToOffset(&tb.rope, 1, 0).?);
    try std.testing.expectEqual(@as(u32, 12), iter_mod.coordsToOffset(&tb.rope, 2, 0).?);

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Line1\nLine2\nLine3", out_buffer[0..written]);
}

test "TextBuffer setText - mixed line endings (LF, CRLF, CR)" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("Unix\nWindows\r\nOldMac\rEnd");

    try std.testing.expectEqual(@as(u32, 4), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Unix\nWindows\nOldMac\nEnd", out_buffer[0..written]);
}

test "TextBuffer setText - text ending with CRLF" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello World\r\n");

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(&tb.rope, 0, 0).?);
    try std.testing.expectEqual(@as(u32, 12), iter_mod.coordsToOffset(&tb.rope, 1, 0).?);
    try std.testing.expectEqual(@as(u32, 0), iter_mod.lineWidthAt(&tb.rope, 1)); // Empty line
}

test "TextBuffer setText - consecutive CRLF sequences" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("Line1\r\n\r\nLine3");

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(&tb.rope, 0, 0).?);
    try std.testing.expectEqual(@as(u32, 6), iter_mod.coordsToOffset(&tb.rope, 1, 0).?);
    try std.testing.expectEqual(@as(u32, 7), iter_mod.coordsToOffset(&tb.rope, 2, 0).?);
}

test "TextBuffer setText - only CRLF sequences" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("\r\n\r\n\r\n");

    try std.testing.expectEqual(@as(u32, 4), tb.getLineCount());

    // All lines should be empty
    for (0..4) |i| {
        try std.testing.expectEqual(@as(u32, 0), iter_mod.lineWidthAt(&tb.rope, @intCast(i)));
    }
}

test "TextBuffer setText - text starting with CRLF" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("\r\nHello World");

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(&tb.rope, 0, 0).?); // Empty first line
    try std.testing.expectEqual(@as(u32, 1), iter_mod.coordsToOffset(&tb.rope, 1, 0).?);
}

test "TextBuffer setText - CR without LF" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("Line1\rLine2\rLine3");

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Line1\nLine2\nLine3", out_buffer[0..written]);
}

test "TextBuffer setText - very long line with SIMD processing" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    // Create a text longer than 16 bytes (SIMD vector size) to test SIMD path
    var text_builder: std.ArrayListUnmanaged(u8) = .{};
    defer text_builder.deinit(std.testing.allocator);

    try text_builder.appendNTimes(std.testing.allocator, 'A', 100);
    try text_builder.appendSlice(std.testing.allocator, "\r\n");
    try text_builder.appendNTimes(std.testing.allocator, 'B', 100);
    try text_builder.appendSlice(std.testing.allocator, "\n");
    try text_builder.appendNTimes(std.testing.allocator, 'C', 100);

    try tb.setText(text_builder.items);

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 100), iter_mod.lineWidthAt(&tb.rope, 0));
    try std.testing.expectEqual(@as(u32, 100), iter_mod.lineWidthAt(&tb.rope, 1));
    try std.testing.expectEqual(@as(u32, 100), iter_mod.lineWidthAt(&tb.rope, 2));
}

test "TextBuffer setText - unicode content with various line endings" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello 世界\r\n🌟 Test\nEnd");

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Hello 世界\n🌟 Test\nEnd", out_buffer[0..written]);
}

test "TextBuffer setText - multiple consecutive different line endings" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    // Mix of \n, \r\n, \r in sequence
    try tb.setText("A\n\r\n\rB");

    // "A", "", "", "B"
    try std.testing.expectEqual(@as(u32, 4), tb.getLineCount());
}

test "TextBuffer setText - SIMD boundary conditions" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    // Create text with newlines at SIMD vector boundaries (16 bytes)
    var text_builder: std.ArrayListUnmanaged(u8) = .{};
    defer text_builder.deinit(std.testing.allocator);

    // 15 chars + \n = exactly 16 bytes
    try text_builder.appendNTimes(std.testing.allocator, 'X', 15);
    try text_builder.appendSlice(std.testing.allocator, "\n");
    // 15 more chars + \n
    try text_builder.appendNTimes(std.testing.allocator, 'Y', 15);
    try text_builder.appendSlice(std.testing.allocator, "\n");
    // Final line
    try text_builder.appendNTimes(std.testing.allocator, 'Z', 10);

    try tb.setText(text_builder.items);

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 15), iter_mod.lineWidthAt(&tb.rope, 0));
    try std.testing.expectEqual(@as(u32, 15), iter_mod.lineWidthAt(&tb.rope, 1));
    try std.testing.expectEqual(@as(u32, 10), iter_mod.lineWidthAt(&tb.rope, 2));
}

test "TextBuffer setText - CRLF at SIMD boundary" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    // Create text where \r is at end of SIMD vector and \n is at start of next
    var text_builder: std.ArrayListUnmanaged(u8) = .{};
    defer text_builder.deinit(std.testing.allocator);

    // 15 chars + \r = 16 bytes, then \n at position 16
    try text_builder.appendNTimes(std.testing.allocator, 'A', 15);
    try text_builder.appendSlice(std.testing.allocator, "\r\n");
    try text_builder.appendSlice(std.testing.allocator, "Next line");

    try tb.setText(text_builder.items);

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 15), iter_mod.lineWidthAt(&tb.rope, 0));

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    const expected_len = 15 + 1 + 9;
    try std.testing.expectEqual(expected_len, written);
}

test "TextBuffer setText - line with multiple u16-sized chunks (SKIPPED)" {
    return error.SkipZigTest;
}

test "TextBuffer setText - validate rope structure is correct" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try text_buffer.UnifiedTextBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer tb.deinit();

    try tb.setText("Line 1\nLine 2\nLine 3");

    const line_count = tb.lineCount();
    try std.testing.expectEqual(@as(u32, 3), line_count);

    const break_count = tb.rope.markerCount(.brk);
    try std.testing.expectEqual(@as(u32, 2), break_count);

    const linestart_count = tb.rope.markerCount(.linestart);
    try std.testing.expectEqual(@as(u32, 3), linestart_count);

    try std.testing.expectEqual(@as(u32, 6), iter_mod.lineWidthAt(&tb.rope, 0));
    try std.testing.expectEqual(@as(u32, 6), iter_mod.lineWidthAt(&tb.rope, 1));
    try std.testing.expectEqual(@as(u32, 6), iter_mod.lineWidthAt(&tb.rope, 2));

    const total_weight = tb.rope.totalWeight();
    try std.testing.expectEqual(@as(u32, 20), total_weight);
}

test "TextBuffer setText - then deleteRange via EditBuffer - validate markers" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    const edit_buffer = @import("../edit-buffer.zig");
    var eb = try edit_buffer.EditBuffer.init(std.testing.allocator, pool, .wcwidth);
    defer eb.deinit();

    try eb.setText("Line 1\nLine 2\nLine 3");

    try eb.deleteRange(.{ .row = 2, .col = 0 }, .{ .row = 2, .col = 6 });

    try std.testing.expectEqual(@as(u32, 2), eb.getTextBuffer().lineCount());
    try std.testing.expectEqual(@as(u32, 2), eb.getTextBuffer().rope.markerCount(.brk));
    try std.testing.expectEqual(@as(u32, 2), eb.getTextBuffer().rope.markerCount(.linestart));
}

test "TextBuffer setStyledText - repeated calls with SyntaxStyle (crash reproduction)" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    // Create a SyntaxStyle (similar to what Text.ts does)
    const ss = @import("../syntax-style.zig");
    const style = try ss.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();

    tb.setSyntaxStyle(style);

    const iterations = 10000;
    const initial_arena = tb.getArenaAllocatedBytes();

    // Simulate what styled-text-demo does - call setStyledText repeatedly
    var iteration: u32 = 0;
    while (iteration < iterations) : (iteration += 1) {
        // Create styled chunks similar to the demo
        const text1 = "System Stats: ";
        const text2 = "Frame: ";
        var frame_buf: [32]u8 = undefined;
        const frame_text = try std.fmt.bufPrint(&frame_buf, "{}", .{iteration});

        const chunks = [_]text_buffer.StyledChunk{
            .{
                .text_ptr = text1.ptr,
                .text_len = text1.len,
                .fg_ptr = null,
                .bg_ptr = null,
                .attributes = 1, // bold
            },
            .{
                .text_ptr = text2.ptr,
                .text_len = text2.len,
                .fg_ptr = null,
                .bg_ptr = null,
                .attributes = 0,
            },
            .{
                .text_ptr = frame_text.ptr,
                .text_len = frame_text.len,
                .fg_ptr = null,
                .bg_ptr = null,
                .attributes = 0,
            },
        };

        try tb.setStyledText(&chunks);
        try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    }

    const final_arena = tb.getArenaAllocatedBytes();
    const arena_growth = final_arena - initial_arena;

    // Arena should not grow significantly - setStyledText should reuse memory
    // Max 50KB growth is reasonable for rope structure
    const max_expected_growth = 50000;
    try std.testing.expect(arena_growth < max_expected_growth);
}

test "addHighlightByCharRange - single line highlight should not extend to EOL" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const text = "Try moving your cursor through the [VIRTUAL] markers below:";
    try tb.setText(text);

    try tb.addHighlightByCharRange(35, 44, 1, 1, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 1), highlights.len);
    try std.testing.expectEqual(@as(u32, 35), highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 44), highlights[0].col_end);

    try std.testing.expect(highlights[0].col_end < 59);
    try std.testing.expect(highlights[0].col_end == 44);
}

test "addHighlightByCharRange - multiple highlights on same line should have correct bounds" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const text = "Text [MARK1] and [MARK2] here";
    try tb.setText(text);

    try tb.addHighlightByCharRange(5, 12, 1, 1, 0);
    try tb.addHighlightByCharRange(17, 24, 1, 2, 0);

    const highlights = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 2), highlights.len);

    try std.testing.expectEqual(@as(u32, 5), highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 12), highlights[0].col_end);

    try std.testing.expectEqual(@as(u32, 17), highlights[1].col_start);
    try std.testing.expectEqual(@as(u32, 24), highlights[1].col_end);
}

test "addHighlightByCharRange - highlight after newline should not span to EOL" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const text = "Line1\nLine2 with [MARK] text\nLine3";
    try tb.setText(text);

    const line1_char_offset: u32 = 5;
    const mark_start = line1_char_offset + 11;
    const mark_end = line1_char_offset + 17;

    try tb.addHighlightByCharRange(mark_start, mark_end, 1, 1, 0);

    const hl0 = tb.getLineHighlights(0);
    try std.testing.expectEqual(@as(usize, 0), hl0.len);

    const hl1 = tb.getLineHighlights(1);
    try std.testing.expectEqual(@as(usize, 1), hl1.len);

    try std.testing.expectEqual(@as(u32, 11), hl1[0].col_start);
    try std.testing.expectEqual(@as(u32, 17), hl1[0].col_end);

    const line1_text = "Line2 with [MARK] text";
    try std.testing.expect(hl1[0].col_end < line1_text.len);
}

test "addHighlightByCharRange - extmarks demo scenario reproduction" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const full_text =
        \\Welcome to the Extmarks Demo!
        \\
        \\This demo showcases virtual extmarks - text ranges that the cursor jumps over.
        \\
        \\Try moving your cursor through the [VIRTUAL] markers below:
        \\- Use arrow keys to navigate
    ;
    try tb.setText(full_text);

    const line4_char_offset: u32 = 107;
    const virtual_start = line4_char_offset + 35;
    const virtual_end = line4_char_offset + 44;

    try tb.addHighlightByCharRange(virtual_start, virtual_end, 1, 1, 0);

    const line4_highlights = tb.getLineHighlights(4);
    try std.testing.expectEqual(@as(usize, 1), line4_highlights.len);
    try std.testing.expectEqual(@as(u32, 35), line4_highlights[0].col_start);
    try std.testing.expectEqual(@as(u32, 44), line4_highlights[0].col_end);

    const line4_text = "Try moving your cursor through the [VIRTUAL] markers below:";
    try std.testing.expect(line4_highlights[0].col_end == 44);
    try std.testing.expect(line4_highlights[0].col_end < line4_text.len);
}

// ===== TextBuffer.append() Tests =====

test "TextBuffer append - to empty buffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.append("Hello");

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 5), tb.getLength());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Hello", out_buffer[0..written]);
}

test "TextBuffer append - to non-empty buffer, no newline" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello");
    try tb.append(" World");

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());
    try std.testing.expectEqual(@as(u32, 11), tb.getLength());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Hello World", out_buffer[0..written]);
}

test "TextBuffer append - creating new line with LF" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello");
    try tb.append("\nWorld");

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Hello\nWorld", out_buffer[0..written]);
}

test "TextBuffer append - multiple lines with various endings" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("A\nB");
    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());

    try tb.append("\nC\nD\n");

    try std.testing.expectEqual(@as(u32, 5), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("A\nB\nC\nD\n", out_buffer[0..written]);
}

test "TextBuffer append - CRLF line endings" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.append("Line1\r\nLine2\r\nLine3");

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    // CRLF should be normalized to LF
    try std.testing.expectEqualStrings("Line1\nLine2\nLine3", out_buffer[0..written]);
}

test "TextBuffer append - mixed line endings" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("Unix\n");
    try tb.append("Windows\r\nOldMac\rEnd");

    try std.testing.expectEqual(@as(u32, 4), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Unix\nWindows\nOldMac\nEnd", out_buffer[0..written]);
}

test "TextBuffer append - empty string is no-op" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello");
    const initial_length = tb.getLength();
    const initial_line_count = tb.getLineCount();

    try tb.append("");

    try std.testing.expectEqual(initial_length, tb.getLength());
    try std.testing.expectEqual(initial_line_count, tb.getLineCount());
}

test "TextBuffer append - unicode content" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello ");
    try tb.append("世界 🌟");

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Hello 世界 🌟", out_buffer[0..written]);
}

test "TextBuffer append - streaming/chunked append vs ground truth" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    // Append in chunks
    try tb.append("First");
    try tb.append("\nLine2");
    try tb.append("\n");
    try tb.append("Line3");
    try tb.append(" end");

    // Build expected ground truth
    var expected: std.ArrayListUnmanaged(u8) = .{};
    defer expected.deinit(std.testing.allocator);
    try expected.appendSlice(std.testing.allocator, "First");
    try expected.appendSlice(std.testing.allocator, "\nLine2");
    try expected.appendSlice(std.testing.allocator, "\n");
    try expected.appendSlice(std.testing.allocator, "Line3");
    try expected.appendSlice(std.testing.allocator, " end");

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings(expected.items, out_buffer[0..written]);

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());
}

test "TextBuffer append - large streaming append" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    // Simulate streaming large content
    var i: u32 = 0;
    while (i < 100) : (i += 1) {
        var buf: [32]u8 = undefined;
        const line = try std.fmt.bufPrint(&buf, "Line {}\n", .{i});
        try tb.append(line);
    }

    try std.testing.expectEqual(@as(u32, 101), tb.getLineCount()); // 100 lines + empty final line

    // Verify first and last lines can be extracted correctly
    try std.testing.expectEqual(@as(u32, 0), iter_mod.coordsToOffset(&tb.rope, 0, 0).?);
    try std.testing.expect(iter_mod.coordsToOffset(&tb.rope, 99, 0).? > 0);
}

test "TextBuffer appendFromMemId - basic functionality" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const text = "Alpha\nBeta";
    const mem_id = try tb.registerMemBuffer(text, false);

    try tb.appendFromMemId(mem_id);

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Alpha\nBeta", out_buffer[0..written]);
}

test "TextBuffer appendFromMemId - append to existing content" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const text = "Gamma";
    const mem_id = try tb.registerMemBuffer(text, false);

    try tb.setText("Alpha\nBeta");
    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());

    try tb.appendFromMemId(mem_id);

    try std.testing.expectEqual(@as(u32, 2), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Alpha\nBetaGamma", out_buffer[0..written]);
}

test "TextBuffer appendFromMemId - invalid mem_id" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const result = tb.appendFromMemId(99);
    try std.testing.expectError(text_buffer.TextBufferError.InvalidMemId, result);
}

test "TextBuffer append - marker invariants maintained" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.append("Line1\n");
    try tb.append("Line2\n");
    try tb.append("Line3");

    const line_count = tb.getLineCount();
    try std.testing.expectEqual(@as(u32, 3), line_count);

    // Verify marker counts
    const linestart_count = tb.rope.markerCount(.linestart);
    try std.testing.expectEqual(line_count, linestart_count);

    const break_count = tb.rope.markerCount(.brk);
    try std.testing.expectEqual(@as(u32, 2), break_count); // 2 newlines
}

test "TextBuffer append - memory registry preserved" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const preserved_text = "Preserved";
    const preserved_id = try tb.registerMemBuffer(preserved_text, false);

    try tb.append("First\n");
    try tb.append("Second\n");
    try tb.append("Third");

    // Preserved buffer should still be accessible
    const retrieved = tb.getMemBuffer(preserved_id);
    try std.testing.expect(retrieved != null);
    try std.testing.expectEqualStrings(preserved_text, retrieved.?);
}

test "TextBuffer append - views marked dirty" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    const view_id = try tb.registerView();
    defer tb.unregisterView(view_id);

    tb.clearViewDirty(view_id);
    try std.testing.expect(!tb.isViewDirty(view_id));

    try tb.append("New content");

    try std.testing.expect(tb.isViewDirty(view_id));
}

test "TextBuffer append - append after clear" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("Initial content");
    tb.clear();

    try tb.append("After clear");

    try std.testing.expectEqual(@as(u32, 1), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("After clear", out_buffer[0..written]);
}

test "TextBuffer append - consecutive empty line handling" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("Line1\n");
    try tb.append("\n");
    try tb.append("Line3");

    try std.testing.expectEqual(@as(u32, 3), tb.getLineCount());

    var out_buffer: [100]u8 = undefined;
    const written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Line1\n\nLine3", out_buffer[0..written]);
}

test "TextBuffer append - mixed append and setText" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();


    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    try tb.setText("First");
    try tb.append(" appended");

    var out_buffer: [100]u8 = undefined;
    var written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("First appended", out_buffer[0..written]);

    try tb.setText("Reset");
    try tb.append(" again");

    written = tb.getPlainTextIntoBuffer(&out_buffer);
    try std.testing.expectEqualStrings("Reset again", out_buffer[0..written]);
}
