const std = @import("std");
const testing = std.testing;
const seg_mod = @import("../text-buffer-segment.zig");
const MemRegistry = @import("../mem-registry.zig").MemRegistry;
const utf8 = @import("../utf8.zig");

const Segment = seg_mod.Segment;
const UnifiedRope = seg_mod.UnifiedRope;
const TextChunk = seg_mod.TextChunk;

test "TextChunk keeps cold cache state out of rope leaves" {
    try testing.expect(@sizeOf(TextChunk) <= 24);
}

test "TextChunk layout cache retries and releases partial allocations" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var registry = MemRegistry.init(testing.allocator);
    defer registry.deinit();
    const text = "\u{65e5}\u{672c} " ** 512;
    const mem_id = try registry.register(text, false);

    for (0..3) |fail_index| {
        var failing = testing.FailingAllocator.init(testing.allocator, .{
            .fail_index = fail_index,
            .resize_fail_index = 0,
        });
        var cache: seg_mod.ChunkLayoutCache = .{ .allocator = failing.allocator() };
        defer cache.clear();
        var chunk: TextChunk = .{ .mem_id = mem_id, .byte_start = 0, .byte_end = text.len, .width_cols = 2560 };

        try testing.expectError(error.OutOfMemory, chunk.getLayoutInfo(arena.allocator(), &cache, &registry, 2, .unicode));
        try testing.expect(chunk.getCachedLayoutInfo(2, .unicode) == null);
        failing.fail_index = std.math.maxInt(usize);
        const retried = try chunk.getLayoutInfo(arena.allocator(), &cache, &registry, 2, .unicode);
        try testing.expectEqual(@as(usize, 512), retried.wrap_breaks.len);
        try testing.expectEqual(@as(usize, 512), retried.cjk_breaks.len);
        try testing.expectEqual(retried.cjk_breaks.ptr, chunk.getCachedLayoutInfo(2, .unicode).?.cjk_breaks.ptr);
        cache.clear();
        try testing.expect(chunk.getCachedLayoutInfo(2, .unicode) == null);
        try testing.expectEqual(failing.allocated_bytes, failing.freed_bytes);

        failing.fail_index = failing.alloc_index + fail_index;
        try testing.expectError(error.OutOfMemory, chunk.getLayoutInfo(arena.allocator(), &cache, &registry, 2, .unicode));
        cache.clear();
        try testing.expectEqual(failing.allocated_bytes, failing.freed_bytes);
    }
}

test "TextChunk static ellipsis keeps byte ranges separate from registered text" {
    var registry = MemRegistry.init(testing.allocator);
    defer registry.deinit();

    var ellipsis: Segment = .{ .text = .{
        .mem_id = 0,
        .byte_start = 0,
        .byte_end = 3,
        .width_cols = 3,
        .flags = TextChunk.Flags.ASCII_ONLY | TextChunk.Flags.STATIC_ELLIPSIS,
    } };
    var ordinary = ellipsis;
    ordinary.text.flags = TextChunk.Flags.ASCII_ONLY;
    try testing.expectEqualStrings("...", ellipsis.getBytes(&registry));
    try testing.expectEqualStrings("", ordinary.getBytes(&registry));

    try testing.expectEqual(@as(u8, 0), try registry.register("abcdef", false));
    try testing.expectEqualStrings("...", ellipsis.getBytes(&registry));
    try testing.expectEqualStrings("abc", ordinary.getBytes(&registry));
    ordinary.text.byte_start = 3;
    ordinary.text.byte_end = 6;
    try testing.expect(!Segment.canMerge(&ellipsis, &ordinary));

    ellipsis.text.byte_start = 1;
    try testing.expectEqualStrings("..", ellipsis.getBytes(&registry));
    registry.clear();
    try testing.expectEqualStrings("..", ellipsis.getBytes(&registry));
    try testing.expectEqualStrings("", ordinary.getBytes(&registry));
}

test "TextChunk.getLayoutInfo returns direct byte and column metadata" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var cache: seg_mod.ChunkLayoutCache = .{ .allocator = testing.allocator };
    defer cache.clear();

    var registry = MemRegistry.init(testing.allocator);
    defer registry.deinit();

    const text = "AB🌟 CD";
    const mem_id = try registry.register(text, false);
    var chunk: TextChunk = .{
        .mem_id = mem_id,
        .byte_start = 0,
        .byte_end = @intCast(text.len),
        .width_cols = @intCast(utf8.calculateTextWidth(text, 2, false, .unicode)),
    };

    const layout = try chunk.getLayoutInfo(arena.allocator(), &cache, &registry, 2, .unicode);
    try testing.expectEqual(@as(usize, 1), layout.wrap_breaks.len);
    try testing.expectEqual(@as(u32, 6), layout.wrap_breaks[0].byte_start);
    try testing.expectEqual(@as(u32, 4), layout.wrap_breaks[0].col_start);
    try testing.expectEqual(@as(u32, 7), layout.wrap_breaks[0].byteEnd());
    try testing.expectEqual(@as(u32, 5), layout.wrap_breaks[0].colEnd());

    const cached = try chunk.getLayoutInfo(arena.allocator(), &cache, &registry, 2, .unicode);
    try testing.expectEqual(@intFromPtr(layout.wrap_breaks.ptr), @intFromPtr(cached.wrap_breaks.ptr));

    const zero_width_text = "a\u{200B}b";
    const zero_width_mem_id = try registry.register(zero_width_text, false);
    var zero_width_chunk: TextChunk = .{
        .mem_id = zero_width_mem_id,
        .byte_start = 0,
        .byte_end = @intCast(zero_width_text.len),
        .width_cols = @intCast(utf8.calculateTextWidth(zero_width_text, 2, false, .unicode)),
    };
    const zero_width_layout = try zero_width_chunk.getLayoutInfo(arena.allocator(), &cache, &registry, 2, .unicode);
    try testing.expectEqual(@as(usize, 1), zero_width_layout.wrap_breaks.len);
    try testing.expectEqual(@as(u32, 1), zero_width_layout.wrap_breaks[0].byte_start);
    try testing.expectEqual(@as(u32, 3), zero_width_layout.wrap_breaks[0].byte_len);
    try testing.expectEqual(@as(u32, 1), zero_width_layout.wrap_breaks[0].col_start);
    try testing.expectEqual(@as(u32, 0), zero_width_layout.wrap_breaks[0].width_cols);
}

test "TextChunk keeps CJK line opportunities out of the word cache" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var cache: seg_mod.ChunkLayoutCache = .{ .allocator = testing.allocator };
    defer cache.clear();
    var registry = MemRegistry.init(testing.allocator);
    defer registry.deinit();
    const text = "\u{65e5}\u{672c}\t\u{8a9e}\u{6587}";
    const mem_id = try registry.register(text, false);
    var chunk: TextChunk = .{ .mem_id = mem_id, .byte_start = 0, .byte_end = text.len, .width_cols = 10 };
    const initial_words = try chunk.getWordLayoutInfo(arena.allocator(), &cache, &registry, 2, .unicode);
    try testing.expect(@sizeOf(@TypeOf(initial_words)) < @sizeOf(utf8.ChunkLayoutInfo));
    try testing.expectEqual(utf8.WordClass.cjk_word, initial_words.word_classes.first);
    try testing.expectEqual(utf8.WordClass.cjk_word, initial_words.word_classes.last);
    try testing.expectEqual(@as(usize, 1), initial_words.wrap_breaks.len);
    try testing.expectEqual(@as(usize, 0), chunk.cold.?.cjk_breaks.capacity);
    _ = try chunk.getLayoutInfo(arena.allocator(), &cache, &registry, 2, .unicode);
    try testing.expect(chunk.cold.?.wrap_breaks != null);
    for ([_]utf8.WidthMethod{ .unicode, .wcwidth }) |method| {
        for ([_]u8{ 2, 8 }) |tab_width| {
            const words = try chunk.getWordLayoutInfo(arena.allocator(), &cache, &registry, tab_width, method);
            try testing.expectEqual(@as(usize, 1), words.wrap_breaks.len);
            try testing.expectEqual(utf8.LayoutWrapBreakKind.whitespace, words.wrap_breaks[0].kind);
            try testing.expectEqual(@as(u32, tab_width), words.wrap_breaks[0].width_cols);
            const lines = try chunk.getLayoutInfo(arena.allocator(), &cache, &registry, tab_width, method);
            try testing.expectEqual(@as(usize, 1), lines.wrap_breaks.len);
            try testing.expectEqual(@as(usize, 2), lines.cjk_breaks.len);
            const cached_words = try chunk.getWordLayoutInfo(arena.allocator(), &cache, &registry, tab_width, method);
            try testing.expectEqual(utf8.WordClass.cjk_word, cached_words.word_classes.first);
            try testing.expectEqual(utf8.WordClass.cjk_word, cached_words.word_classes.last);
            try testing.expectEqual(@intFromPtr(words.wrap_breaks.ptr), @intFromPtr(cached_words.wrap_breaks.ptr));
            try testing.expectEqual(@as(usize, 1), cached_words.wrap_breaks.len);
            try testing.expectEqual(@as(usize, 2), chunk.getCachedLayoutInfo(tab_width, method).?.cjk_breaks.len);
        }
    }
    const greek = "\u{3bb}-\u{3bb}";
    const greek_id = try registry.register(greek, false);
    var greek_chunk: TextChunk = .{ .mem_id = greek_id, .byte_start = 0, .byte_end = greek.len, .width_cols = 3 };
    _ = try greek_chunk.getWordLayoutInfo(arena.allocator(), &cache, &registry, 2, .unicode);
    try testing.expect(greek_chunk.getCachedLayoutInfo(2, .unicode) != null);
}

test "findChunkLayoutInfo classifies direct byte and column break metadata" {
    const Case = struct {
        text: []const u8,
        tab_width: u8 = 2,
        expected: []const utf8.LayoutWrapBreak,
    };

    const cases = [_]Case{
        .{ .text = "AB🌟 CD", .expected = &.{.{ .byte_start = 6, .col_start = 4, .byte_len = 1, .width_cols = 1, .kind = .whitespace }} },
        .{ .text = "中A", .expected = &.{.{ .byte_start = 0, .col_start = 0, .byte_len = 3, .width_cols = 2, .kind = .script_transition }} },
        .{ .text = "A中", .expected = &.{.{ .byte_start = 0, .col_start = 0, .byte_len = 1, .width_cols = 1, .kind = .script_transition }} },
        .{ .text = "a\u{0301}中", .expected = &.{.{ .byte_start = 0, .col_start = 0, .byte_len = 3, .width_cols = 1, .kind = .script_transition }} },
        .{ .text = "0123456789abcdef中", .expected = &.{.{ .byte_start = 15, .col_start = 15, .byte_len = 1, .width_cols = 1, .kind = .script_transition }} },
        .{ .text = "a\u{200B}b", .expected = &.{.{ .byte_start = 1, .col_start = 1, .byte_len = 3, .width_cols = 0, .kind = .whitespace }} },
        .{ .text = "a\tb", .tab_width = 2, .expected = &.{.{ .byte_start = 1, .col_start = 1, .byte_len = 1, .width_cols = 2, .kind = .whitespace }} },
        .{ .text = "a\tb", .tab_width = 4, .expected = &.{.{ .byte_start = 1, .col_start = 1, .byte_len = 1, .width_cols = 4, .kind = .whitespace }} },
        .{ .text = "ab,cd", .expected = &.{.{ .byte_start = 2, .col_start = 2, .byte_len = 1, .width_cols = 1, .kind = .punctuation }} },
        .{ .text = "中文", .expected = &.{.{ .byte_start = 0, .col_start = 0, .byte_len = 3, .width_cols = 2, .kind = .cjk_intercharacter }} },
        .{ .text = "中文A", .expected = &.{
            .{ .byte_start = 0, .col_start = 0, .byte_len = 3, .width_cols = 2, .kind = .cjk_intercharacter },
            .{ .byte_start = 3, .col_start = 2, .byte_len = 3, .width_cols = 2, .kind = .script_transition },
        } },
        // Break after ideographic punctuation only; 。 must never start a line.
        .{ .text = "字。", .expected = &.{.{ .byte_start = 3, .col_start = 2, .byte_len = 3, .width_cols = 2, .kind = .punctuation }} },
        .{ .text = "\u{30ab}\u{30fb}\u{30ca}", .expected = &.{.{ .byte_start = 3, .col_start = 2, .byte_len = 3, .width_cols = 2, .kind = .cjk_intercharacter }} },
        .{ .text = "\u{30ab}\u{30a0}\u{30ca}", .expected = &.{.{ .byte_start = 3, .col_start = 2, .byte_len = 3, .width_cols = 2, .kind = .cjk_intercharacter }} },
        .{ .text = "\u{304b}\u{3099}\u{304f}", .expected = &.{.{ .byte_start = 0, .col_start = 0, .byte_len = 6, .width_cols = 2, .kind = .cjk_intercharacter }} },
        .{ .text = "\u{3099}\u{304f}", .expected = &.{} },
    };

    var breaks: std.ArrayListUnmanaged(utf8.LayoutWrapBreak) = .empty;
    defer breaks.deinit(testing.allocator);

    for (cases) |case| {
        _ = try utf8.findChunkLayoutInfo(testing.allocator, case.text, case.tab_width, false, .unicode, &breaks);
        try testing.expectEqualDeep(case.expected, breaks.items);
    }
}

test "walkChunkLayoutInfo keeps Prepend joined to an ASCII vector" {
    const text = "\u{0600} 0123456789abcdef";
    var breaks: std.ArrayListUnmanaged(utf8.LayoutWrapBreak) = .empty;
    defer breaks.deinit(testing.allocator);

    _ = try utf8.findChunkLayoutInfo(testing.allocator, text, 2, false, .unicode, &breaks);
    try testing.expectEqual(@as(usize, 1), breaks.items.len);
    try testing.expectEqual(@as(u32, 0), breaks.items[0].byte_start);
    try testing.expectEqual(@as(u32, 3), breaks.items[0].byte_len);
    try testing.expectEqual(@as(u32, 0), breaks.items[0].col_start);
    try testing.expectEqual(@as(u32, 1), breaks.items[0].width_cols);
    try testing.expectEqual(utf8.LayoutWrapBreakKind.preserved_whitespace, breaks.items[0].kind);
}

test "walkChunkLayoutInfo ASCII prefixes keep their final grapheme intact" {
    var breaks: std.ArrayListUnmanaged(utf8.LayoutWrapBreak) = .empty;
    defer breaks.deinit(testing.allocator);
    for (0..32) |prefix_len| {
        const text = try std.fmt.allocPrint(testing.allocator, "{s} \u{301} \u{754c}abc", .{("a" ** 32)[0..prefix_len]});
        defer testing.allocator.free(text);
        _ = try utf8.findChunkLayoutInfo(testing.allocator, text, 2, false, .unicode, &breaks);
        try testing.expectEqual(@as(usize, 3), breaks.items.len);
        try testing.expectEqual(@as(u32, @intCast(prefix_len)), breaks.items[0].byte_start);
        try testing.expectEqual(@as(u32, 3), breaks.items[0].byte_len);
        try testing.expectEqual(@as(u32, 1), breaks.items[0].width_cols);
        try testing.expectEqual(utf8.LayoutWrapBreakKind.preserved_whitespace, breaks.items[0].kind);
        try testing.expectEqual(utf8.LayoutWrapBreakKind.whitespace, breaks.items[1].kind);
        try testing.expectEqual(utf8.LayoutWrapBreakKind.script_transition, breaks.items[2].kind);
    }
}

test "walkChunkLayoutInfo preserves mixed-content whitespace graphemes" {
    const cases = [_][]const u8{
        "\u{0D4E} ", // U+0D4E MALAYALAM LETTER DOT REPH
        "\u{0600} ", // U+0600 ARABIC NUMBER SIGN
        " \u{301}", // Non-whitespace after whitespace in the same grapheme
        "\u{0600} \u{301}", // Mixed content on both sides of whitespace
    };
    var breaks: std.ArrayListUnmanaged(utf8.LayoutWrapBreak) = .empty;
    defer breaks.deinit(testing.allocator);

    for (cases) |text| {
        _ = try utf8.findChunkLayoutInfo(testing.allocator, text, 2, false, .unicode, &breaks);
        try testing.expectEqual(@as(usize, 1), breaks.items.len);
        try testing.expectEqual(@as(u32, 0), breaks.items[0].byte_start);
        try testing.expectEqual(@as(u32, @intCast(text.len)), breaks.items[0].byte_len);
        try testing.expectEqual(@as(u32, 0), breaks.items[0].col_start);
        try testing.expectEqual(@as(u32, 1), breaks.items[0].width_cols);
        try testing.expectEqual(utf8.LayoutWrapBreakKind.preserved_whitespace, breaks.items[0].kind);
    }
}

test "walkChunkLayoutInfo stops streaming after visitor allocation failure" {
    const text = try testing.allocator.alloc(u8, 70_000);
    defer testing.allocator.free(text);
    @memset(text, ' ');

    var failing = testing.FailingAllocator.init(testing.allocator, .{ .fail_index = 0 });
    const Context = struct {
        allocator: std.mem.Allocator,
        breaks: std.ArrayListUnmanaged(utf8.LayoutWrapBreak) = .empty,
        callback_count: usize = 0,
        failed: bool = false,

        fn visit(ctx_ptr: *anyopaque, wrap_break: utf8.LayoutWrapBreak) !bool {
            const ctx = @as(*@This(), @ptrCast(@alignCast(ctx_ptr)));
            ctx.callback_count += 1;
            ctx.breaks.append(ctx.allocator, wrap_break) catch {
                ctx.failed = true;
                return false;
            };
            return true;
        }
    };
    var ctx: Context = .{ .allocator = failing.allocator() };
    defer ctx.breaks.deinit(ctx.allocator);
    _ = try utf8.walkChunkLayoutInfoComptime(text, 2, true, .unicode, &ctx, Context.visit);
    try testing.expect(failing.has_induced_failure);
    try testing.expect(ctx.failed);
    try testing.expectEqual(@as(usize, 1), ctx.callback_count);
}

test "TextChunk.getLayoutInfo refreshes tab-dependent metadata" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var cache: seg_mod.ChunkLayoutCache = .{ .allocator = testing.allocator };
    defer cache.clear();

    var registry = MemRegistry.init(testing.allocator);
    defer registry.deinit();
    const text = "a\tb";
    const mem_id = try registry.register(text, false);
    var chunk: TextChunk = .{
        .mem_id = mem_id,
        .byte_start = 0,
        .byte_end = @intCast(text.len),
        .width_cols = 4,
    };

    const first = try chunk.getLayoutInfo(arena.allocator(), &cache, &registry, 2, .unicode);
    try testing.expectEqual(@as(u32, 2), first.wrap_breaks[0].width_cols);
    const capacity_after_first = arena.queryCapacity();

    const second = try chunk.getLayoutInfo(arena.allocator(), &cache, &registry, 8, .unicode);
    try testing.expectEqual(@as(u32, 8), second.wrap_breaks[0].width_cols);
    try testing.expectEqual(@intFromPtr(first.wrap_breaks.ptr), @intFromPtr(second.wrap_breaks.ptr));
    try testing.expectEqual(capacity_after_first, arena.queryCapacity());
}

test "TextChunk.getRenderClusters reuses tab-dependent cache storage" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();

    var registry = MemRegistry.init(testing.allocator);
    defer registry.deinit();
    const text = "a\tb";
    const mem_id = try registry.register(text, false);
    var chunk: TextChunk = .{
        .mem_id = mem_id,
        .byte_start = 0,
        .byte_end = @intCast(text.len),
        .width_cols = 4,
    };

    const first = try chunk.getRenderClusters(arena.allocator(), &registry, 2, .unicode);
    try testing.expectEqual(@as(u32, 2), first[0].width_cols);
    const capacity_after_first = arena.queryCapacity();

    const wider = try chunk.getRenderClusters(arena.allocator(), &registry, 8, .unicode);
    try testing.expectEqual(@as(u32, 8), wider[0].width_cols);
    try testing.expectEqual(@intFromPtr(first.ptr), @intFromPtr(wider.ptr));

    const narrower = try chunk.getRenderClusters(arena.allocator(), &registry, 4, .unicode);
    try testing.expectEqual(@as(u32, 4), narrower[0].width_cols);
    try testing.expectEqual(@intFromPtr(first.ptr), @intFromPtr(narrower.ptr));
    try testing.expectEqual(capacity_after_first, arena.queryCapacity());
}

test "Segment.measure - text chunk" {
    const chunk: TextChunk = .{
        .mem_id = 0,
        .byte_start = 0,
        .byte_end = 10,
        .width_cols = 10,
        .flags = TextChunk.Flags.ASCII_ONLY,
    };
    const seg: Segment = .{ .text = chunk };
    const metrics = seg.measure();

    try testing.expectEqual(@as(u32, 10), metrics.total_width_cols);
    try testing.expectEqual(@as(u32, 10), metrics.max_line_width_cols);
    try testing.expect(metrics.ascii_only);
}

test "Segment.measure - propagates tab presence" {
    const without_tab = Segment{ .text = .{
        .mem_id = 0,
        .byte_start = 0,
        .byte_end = 1,
        .width_cols = 1,
        .flags = TextChunk.Flags.ASCII_ONLY,
    } };
    const with_tab = Segment{ .text = .{
        .mem_id = 0,
        .byte_start = 1,
        .byte_end = 2,
        .width_cols = 2,
        .flags = TextChunk.Flags.HAS_TAB,
    } };

    var metrics = without_tab.measure();
    try std.testing.expect(!metrics.has_tabs);
    metrics.add(with_tab.measure());
    try std.testing.expect(metrics.has_tabs);
}

test "Segment.measure - break" {
    const seg: Segment = .{ .brk = {} };
    const metrics = seg.measure();

    try testing.expectEqual(@as(u32, 0), metrics.total_width_cols);
    try testing.expectEqual(@as(u32, 0), metrics.max_line_width_cols);
    try testing.expect(metrics.ascii_only);
}

test "Segment.empty and is_empty" {
    const seg = Segment.empty();
    try testing.expect(seg.is_empty());
}

test "Segment.isBreak and isText" {
    const text_seg: Segment = .{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 0,
            .byte_end = 10,
            .width_cols = 10,
            .flags = 0,
        },
    };
    try testing.expect(text_seg.isText());
    try testing.expect(!text_seg.isBreak());

    const brk_seg: Segment = .{ .brk = {} };
    try testing.expect(brk_seg.isBreak());
    try testing.expect(!brk_seg.isText());
}

test "Segment.asText" {
    const chunk: TextChunk = .{
        .mem_id = 0,
        .byte_start = 0,
        .byte_end = 10,
        .width_cols = 10,
        .flags = 0,
    };
    const text_seg: Segment = .{ .text = chunk };
    const retrieved = text_seg.asText();
    try testing.expect(retrieved != null);
    try testing.expectEqual(@as(u32, 10), retrieved.?.width_cols);

    const brk_seg: Segment = .{ .brk = {} };
    try testing.expect(brk_seg.asText() == null);
}

test "Metrics.add - two text segments" {
    var left: Segment.Metrics = .{
        .total_width_cols = 10,
        .max_line_width_cols = 10,
        .ascii_only = true,
    };

    const right: Segment.Metrics = .{
        .total_width_cols = 5,
        .max_line_width_cols = 5,
        .ascii_only = true,
    };

    left.add(right);

    try testing.expectEqual(@as(u32, 15), left.total_width_cols);
    try testing.expectEqual(@as(u32, 10), left.max_line_width_cols);
    try testing.expect(left.ascii_only);
}

test "Metrics.add - text, break, text" {
    var left: Segment.Metrics = .{
        .total_width_cols = 10,
        .max_line_width_cols = 10,
        .ascii_only = true,
    };

    const middle: Segment.Metrics = .{
        .total_width_cols = 0,
        .max_line_width_cols = 0,
        .ascii_only = true,
    };

    left.add(middle);

    try testing.expectEqual(@as(u32, 10), left.total_width_cols);
    try testing.expectEqual(@as(u32, 10), left.max_line_width_cols);

    const right: Segment.Metrics = .{
        .total_width_cols = 5,
        .max_line_width_cols = 5,
        .ascii_only = true,
    };

    left.add(right);

    try testing.expectEqual(@as(u32, 15), left.total_width_cols);
    try testing.expectEqual(@as(u32, 10), left.max_line_width_cols);
}

test "Metrics.add - multiple breaks" {
    var metrics: Segment.Metrics = .{
        .total_width_cols = 10,
        .max_line_width_cols = 10,
        .ascii_only = true,
    };

    metrics.add(.{
        .total_width_cols = 0,
        .max_line_width_cols = 0,
        .ascii_only = true,
    });

    metrics.add(.{
        .total_width_cols = 20,
        .max_line_width_cols = 20,
        .ascii_only = true,
    });

    try testing.expectEqual(@as(u32, 30), metrics.total_width_cols);
    try testing.expectEqual(@as(u32, 20), metrics.max_line_width_cols);

    metrics.add(.{
        .total_width_cols = 0,
        .max_line_width_cols = 0,
        .ascii_only = true,
    });

    metrics.add(.{
        .total_width_cols = 5,
        .max_line_width_cols = 5,
        .ascii_only = true,
    });

    try testing.expectEqual(@as(u32, 35), metrics.total_width_cols);
    try testing.expectEqual(@as(u32, 20), metrics.max_line_width_cols);
}

test "Metrics.add - non-ASCII propagation" {
    var left: Segment.Metrics = .{
        .total_width_cols = 10,
        .max_line_width_cols = 10,
        .ascii_only = true,
    };

    const right: Segment.Metrics = .{
        .total_width_cols = 5,
        .max_line_width_cols = 5,
        .ascii_only = false,
    };

    left.add(right);
    try testing.expect(!left.ascii_only);
}

test "UnifiedRope - basic operations" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var rope = try UnifiedRope.init(allocator);

    const text1: Segment = .{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 0,
            .byte_end = 10,
            .width_cols = 10,
            .flags = TextChunk.Flags.ASCII_ONLY,
        },
    };
    try rope.append(text1);

    const brk: Segment = .{ .brk = {} };
    try rope.append(brk);

    const text2: Segment = .{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 10,
            .byte_end = 15,
            .width_cols = 5,
            .flags = TextChunk.Flags.ASCII_ONLY,
        },
    };
    try rope.append(text2);

    const metrics = rope.root.metrics();
    try testing.expectEqual(@as(u32, 5), rope.count());
    try testing.expectEqual(@as(u32, 15), metrics.custom.total_width_cols);
    try testing.expectEqual(@as(u32, 10), metrics.custom.max_line_width_cols);
}

test "UnifiedRope - empty rope metrics" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const rope = try UnifiedRope.init(allocator);
    const metrics = rope.root.metrics();

    try testing.expectEqual(@as(u32, 1), rope.count());
    try testing.expectEqual(@as(u32, 0), metrics.custom.total_width_cols);
}

test "UnifiedRope - single text segment" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var rope = try UnifiedRope.init(allocator);
    try rope.append(.{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 0,
            .byte_end = 20,
            .width_cols = 20,
            .flags = 0,
        },
    });

    const metrics = rope.root.metrics();
    try testing.expectEqual(@as(u32, 2), rope.count());
    try testing.expectEqual(@as(u32, 20), metrics.custom.total_width_cols);
    try testing.expectEqual(@as(u32, 20), metrics.custom.max_line_width_cols);
}

test "UnifiedRope - multiple lines with varying widths" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var rope = try UnifiedRope.init(allocator);

    try rope.append(.{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 0,
            .byte_end = 10,
            .width_cols = 10,
            .flags = 0,
        },
    });
    try rope.append(.{ .brk = {} });

    try rope.append(.{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 10,
            .byte_end = 40,
            .width_cols = 30,
            .flags = 0,
        },
    });
    try rope.append(.{ .brk = {} });

    try rope.append(.{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 40,
            .byte_end = 55,
            .width_cols = 15,
            .flags = 0,
        },
    });

    const metrics = rope.root.metrics();
    try testing.expectEqual(@as(u32, 8), rope.count());
    try testing.expectEqual(@as(u32, 55), metrics.custom.total_width_cols);
    try testing.expectEqual(@as(u32, 30), metrics.custom.max_line_width_cols);
}

fn combineMetrics(left: Segment.Metrics, right: Segment.Metrics) Segment.Metrics {
    var result = left;
    result.add(right);
    return result;
}

test "combineMetrics helper function" {
    const left: Segment.Metrics = .{
        .total_width_cols = 10,
        .max_line_width_cols = 10,
        .ascii_only = true,
    };

    const right: Segment.Metrics = .{
        .total_width_cols = 5,
        .max_line_width_cols = 5,
        .ascii_only = true,
    };

    const combined = combineMetrics(left, right);

    try testing.expectEqual(@as(u32, 15), combined.total_width_cols);
    try testing.expectEqual(@as(u32, 10), combined.max_line_width_cols);
    try testing.expect(combined.ascii_only);
}
