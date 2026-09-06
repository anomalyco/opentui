const std = @import("std");
const testing = std.testing;
const EditorView = @import("../editor-view.zig").EditorView;
const EditBuffer = @import("../edit-buffer.zig").EditBuffer;
const text_buffer = @import("../text-buffer.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");
const logger = @import("../logger.zig");

test "EditorView - styled placeholder inherits owner I/O and logger" {
    try expectPlaceholderOwner(false);
}

test "EditorView - owned placeholder inherits owner I/O and logger" {
    try expectPlaceholderOwner(true);
}

fn expectPlaceholderOwner(owned: bool) !void {
    const LegacyProbe = struct {
        var calls: u32 = 0;

        fn callback(_: u8, _: [*]const u8, _: u32) callconv(.c) void {
            calls += 1;
        }
    };
    LegacyProbe.calls = 0;
    logger.setLogCallback(LegacyProbe.callback);
    defer logger.setLogCallback(null);

    var diagnostics = try logger.Diagnostics.init(testing.allocator, 8);
    defer diagnostics.deinit();
    const owner_logger: logger.Logger = .{ .diagnostics = &diagnostics };
    var pool = gp.GraphemePool.init(testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(testing.allocator);
    defer links.deinit();
    const eb = try EditBuffer.initWithOptions(testing.allocator, &pool, &links, .unicode, null, .{
        .io = std.Io.failing,
        .logger = &owner_logger,
    });
    defer eb.deinit();
    const ev = try EditorView.init(testing.allocator, eb, 10, 2);
    defer ev.deinit();

    if (owned) {
        const style = try text_buffer.SyntaxStyle.init(testing.allocator);
        errdefer style.deinit();
        const style_id = try style.registerStyle("hint", null, null, 0);
        const bytes = try testing.allocator.dupe(u8, "hint");
        errdefer testing.allocator.free(bytes);
        try ev.setPlaceholderOwnedStyledText(bytes, style, &.{.{
            .byte_count = @intCast(bytes.len),
            .style_id = style_id,
        }}, null);
    } else {
        try ev.setPlaceholderStyledText(&.{.{
            .text_ptr = "hint",
            .text_len = 4,
            .fg_ptr = null,
            .bg_ptr = null,
            .attributes = 0,
        }});
    }

    const placeholder = ev.placeholder_buffer.?;
    placeholder.debugLogRope();
    try testing.expectEqual(@as(u32, 6), diagnostics.count);
    try testing.expectEqual(@as(u32, 0), LegacyProbe.calls);
    try testing.expectEqual(&owner_logger, placeholder.logger);
    try testing.expectEqual(eb.tb.io.userdata, placeholder.io.userdata);
    try testing.expectEqual(eb.tb.io.vtable, placeholder.io.vtable);
    try testing.expectEqual(placeholder, ev.getTextBuffer());
}

test "EditorView - logical line queries reuse prepared storage until content or view changes" {
    var pool = gp.GraphemePool.init(testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(testing.allocator);
    defer links.deinit();
    const eb = try EditBuffer.init(testing.allocator, &pool, &links, .unicode, null);
    defer eb.deinit();
    const ev = try EditorView.init(testing.allocator, eb, 4, 2);
    defer ev.deinit();
    const peer = try EditorView.init(testing.allocator, eb, 8, 2);
    defer peer.deinit();
    ev.setWrapMode(.char);
    try eb.setText("a\xe4\xb8\xadb\nc");
    const before = ev.getLogicalLineInfo();
    try testing.expectEqualSlices(u32, &.{ 4, 1 }, before.line_width_cols);
    _ = peer.getLogicalLineInfo();

    const arena = ev.text_buffer_view.virtual_lines_arena;
    const allocator = arena.child_allocator;
    var failing = testing.FailingAllocator.init(allocator, .{ .fail_index = 0 });
    arena.child_allocator = failing.allocator();
    defer arena.child_allocator = allocator;
    const cached = ev.getLogicalLineInfo();
    try testing.expect(!failing.has_induced_failure);
    try testing.expectEqual(before.line_width_cols.ptr, cached.line_width_cols.ptr);
    try testing.expectEqualSlices(u32, &.{ 4, 1 }, cached.line_width_cols);

    arena.child_allocator = allocator;
    try eb.setText("abcdef");
    try testing.expectEqualSlices(u32, &.{ 4, 2 }, ev.getLogicalLineInfo().line_width_cols);
    try testing.expectEqualSlices(u32, &.{6}, peer.getLogicalLineInfo().line_width_cols);
    ev.setViewportSize(3, 2);
    try testing.expectEqualSlices(u32, &.{ 3, 3 }, ev.getLogicalLineInfo().line_width_cols);
    try eb.setText("");
    try ev.setPlaceholderStyledText(&.{.{ .text_ptr = "hint", .text_len = 4, .fg_ptr = null, .bg_ptr = null, .attributes = 0 }});
    try testing.expectEqualSlices(u32, &.{ 3, 1 }, ev.getLogicalLineInfo().line_width_cols);
    try eb.setText("x");
    try testing.expectEqualSlices(u32, &.{1}, ev.getLogicalLineInfo().line_width_cols);
    try eb.setText("");
    try testing.expectEqualSlices(u32, &.{ 3, 1 }, ev.getLogicalLineInfo().line_width_cols);
}

test "EditorView - rejected selected deletion preserves selection and local endpoints" {
    var pool = gp.GraphemePool.init(testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(testing.allocator);
    defer links.deinit();
    for ([_]bool{ false, true }) |local| {
        const eb = try EditBuffer.init(testing.allocator, &pool, &links, .unicode, null);
        defer eb.deinit();
        try eb.setText("hello world");
        const ev = try EditorView.init(testing.allocator, eb, 20, 2);
        defer ev.deinit();
        ev.setSelectionOccupancy(.boundary);
        if (local) {
            _ = ev.setLocalSelection(1, 0, 4, 0, null, null, true);
        } else {
            ev.setSelection(1, 4, null, null);
        }
        const selection = ev.getSelection();
        const endpoints = ev.text_buffer_view.selection_endpoints;
        const cursor = eb.getPrimaryCursor();
        const viewport = ev.getViewport();
        const allocator = eb.tb.rope().allocator;
        var failing = testing.FailingAllocator.init(allocator, .{ .fail_index = 0 });
        eb.tb.rope().allocator = failing.allocator();
        const result = ev.deleteSelectedText();
        eb.tb.rope().allocator = allocator;

        try testing.expectError(error.OutOfMemory, result);
        try testing.expect(failing.has_induced_failure);
        try testing.expectEqualDeep(selection, ev.getSelection());
        try testing.expectEqualDeep(endpoints, ev.text_buffer_view.selection_endpoints);
        try testing.expectEqual(local, ev.selection_updates_cursor);
        try testing.expectEqualDeep(cursor, eb.getPrimaryCursor());
        try testing.expectEqualDeep(viewport, ev.getViewport());
        var actual: [32]u8 = undefined;
        try testing.expectEqualStrings("hello world", actual[0..ev.getText(&actual)]);
        try testing.expectEqualStrings("ell", actual[0..ev.getSelectedTextIntoBuffer(&actual)]);

        try ev.deleteSelectedText();
        try testing.expectEqualStrings("ho world", actual[0..ev.getText(&actual)]);
        try testing.expect(ev.getSelection() == null);
        try testing.expect(ev.text_buffer_view.selection_endpoints == null);
        try testing.expect(!ev.selection_updates_cursor);
    }
}

test "EditorView - failed active legacy placeholder replacement refreshes logical lines" {
    var fail_offset: usize = 0;
    while (true) : (fail_offset += 1) {
        var failing = testing.FailingAllocator.init(testing.allocator, .{});
        const allocator = failing.allocator();
        var pool = gp.GraphemePool.init(allocator);
        defer pool.deinit();
        var links = link.LinkPool.init(allocator);
        defer links.deinit();
        const eb = try EditBuffer.init(allocator, &pool, &links, .unicode, null);
        defer eb.deinit();
        const ev = try EditorView.init(allocator, eb, 20, 2);
        defer ev.deinit();
        try ev.setPlaceholderStyledText(&.{.{
            .text_ptr = "hint",
            .text_len = 4,
            .fg_ptr = null,
            .bg_ptr = null,
            .attributes = 0,
        }});
        try testing.expectEqualSlices(u32, &.{4}, ev.getLogicalLineInfo().line_width_cols);
        try testing.expect(ev.placeholder_active);
        try testing.expect(!ev.text_buffer_view.virtual_lines_dirty);

        failing.fail_index = failing.alloc_index + fail_offset;
        failing.resize_fail_index = failing.resize_index;
        const result = ev.setPlaceholderStyledText(&.{.{
            .text_ptr = "replacement\nsecond",
            .text_len = 18,
            .fg_ptr = null,
            .bg_ptr = null,
            .attributes = 0,
        }});
        failing.fail_index = std.math.maxInt(usize);
        failing.resize_fail_index = std.math.maxInt(usize);
        if (result) |_| {
            break;
        } else |err| {
            try testing.expectEqual(error.OutOfMemory, err);
            try testing.expect(failing.has_induced_failure);
        }

        const queried = try testing.allocator.dupe(u32, ev.getLogicalLineInfo().line_width_cols);
        defer testing.allocator.free(queried);
        ev.text_buffer_view.virtual_lines_dirty = true;
        const rebuilt = ev.getLogicalLineInfo().line_width_cols;
        if (!std.mem.eql(u32, queried, rebuilt)) {
            std.debug.print("placeholder failure offset {d}: queried={any}, rebuilt={any}\n", .{
                fail_offset, queried, rebuilt,
            });
        }
        try testing.expectEqualSlices(u32, rebuilt, queried);
    }
}
