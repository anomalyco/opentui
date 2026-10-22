const std = @import("std");
const testing = std.testing;
const EditorView = @import("../editor-view.zig").EditorView;
const EditBuffer = @import("../edit-buffer.zig").EditBuffer;
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");
const logger = @import("../logger.zig");
const owned_styled = @import("owned-styled-text.zig");

test "EditorView - owned placeholder inherits owner I/O and logger" {
    try expectPlaceholderOwner();
}

fn expectPlaceholderOwner() !void {
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

    try owned_styled.setPlaceholder(ev, &.{.{ .text = "hint" }});

    const placeholder = ev.placeholder_buffer.?;
    placeholder.debugLogRope();
    try testing.expectEqual(@as(u32, 6), diagnostics.count);
    try testing.expectEqual(@as(u32, 0), LegacyProbe.calls);
    try testing.expectEqual(&owner_logger, placeholder.logger);
    try testing.expectEqual(eb.tb.io.userdata, placeholder.io.userdata);
    try testing.expectEqual(eb.tb.io.vtable, placeholder.io.vtable);
    try testing.expectEqual(placeholder, ev.getTextBuffer());
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
