const std = @import("std");
const edit_buffer = @import("../edit-buffer.zig");
const event_bus = @import("../event-bus.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");

const EditBuffer = edit_buffer.EditBuffer;
const EditorView = @import("../editor-view.zig").EditorView;

const Events = struct {
    var order: [3]u8 = undefined;
    var count: usize = 0;

    fn typed(_: *anyopaque) void {
        if (count < order.len) order[count] = 'T';
        count += 1;
    }

    fn native(name: [*]const u8, name_len: u32, _: [*]const u8, _: u32) callconv(.c) void {
        if (count < order.len) {
            order[count] = if (std.mem.eql(u8, name[0..name_len], "eb_cursor-changed")) 'C' else 'X';
        }
        count += 1;
    }
};

pub const EditState = struct {
    text: [64]u8 = @splat(0),
    cursor: edit_buffer.Cursor,
    add: @FieldType(EditBuffer, "add_buffer"),
    epoch: u64,
    slots: usize,
    undo_depth: usize,
    redo: bool,

    pub fn capture(eb: *EditBuffer) EditState {
        var result: EditState = .{
            .cursor = eb.getPrimaryCursor(),
            .add = eb.add_buffer,
            .epoch = eb.tb.getContentEpoch(),
            .slots = eb.tb.memRegistry().getUsedSlots(),
            .undo_depth = eb.tb.rope().undo_depth,
            .redo = eb.canRedo(),
        };
        std.debug.assert(eb.getText(&result.text) < result.text.len);
        return result;
    }
};

test "EditBuffer atomicity - rejected mutations preserve history content cursor and events" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    inline for (.{ .insert, .selected, .delete, .delete_all, .forward, .backspace }) |operation| {
        for ([_]bool{ false, true }) |fail_rope| {
            var succeeded = false;
            for (0..128) |offset| {
                var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
                var sink: event_bus.EventSink = .{ .callback = null };
                const eb = try EditBuffer.init(failing.allocator(), &pool, &links, .unicode, &sink);
                defer eb.deinit();
                const ev = try EditorView.init(failing.allocator(), eb, 10, 2);
                defer ev.deinit();
                try eb.setText("old\nabcdef");
                try eb.setCursor(1, 6);
                try eb.insertText("X");
                _ = try eb.undo();
                try eb.setCursor(1, 3);
                if (operation == .selected) {
                    ev.setSelectionOccupancy(.boundary);
                    _ = ev.setLocalSelection(2, 0, 3, 1, null, null, true);
                }
                const selection = ev.getSelection();
                const endpoints = ev.text_buffer_view.selection_endpoints;
                const before = EditState.capture(eb);
                try eb.events.on(.cursorChanged, .{ .ctx = eb, .handle = Events.typed });
                sink.callback = Events.native;
                Events.count = 0;
                const allocator = eb.tb.rope().allocator;
                var rope_failing = std.testing.FailingAllocator.init(allocator, .{});
                eb.tb.rope().allocator = rope_failing.allocator();
                const fault = if (fail_rope) &rope_failing else &failing;
                fault.fail_index = fault.alloc_index + offset;
                fault.resize_fail_index = fault.resize_index;
                const input = "replacement" ** 512 ++ "\n";
                const result = switch (operation) {
                    .insert => eb.insertText(input),
                    .selected => ev.replaceSelectedText(input),
                    .delete => eb.deleteRange(.{ .row = 0, .col = 2 }, .{ .row = 1, .col = 3 }),
                    .delete_all => eb.deleteRange(.{ .row = 0, .col = 0 }, .{ .row = 1, .col = 6 }),
                    .forward => eb.deleteForward(),
                    .backspace => eb.backspace(),
                    else => unreachable,
                };
                eb.tb.rope().allocator = allocator;
                fault.fail_index = std.math.maxInt(usize);
                fault.resize_fail_index = std.math.maxInt(usize);
                var actual: [8192]u8 = undefined;
                if (result) |_| {
                    const expected = switch (operation) {
                        .insert => "old\nabc" ++ input ++ "def",
                        .selected => "ol" ++ input ++ "def",
                        .delete => "oldef",
                        .delete_all => "",
                        .forward => "old\nabcef",
                        .backspace => "old\nabdef",
                        else => unreachable,
                    };
                    try std.testing.expectEqualStrings(expected, actual[0..eb.getText(&actual)]);
                    try std.testing.expectEqual(@as(usize, if (operation == .selected) 6 else 3), Events.count);
                    try std.testing.expect(!eb.canRedo());
                    _ = try eb.undo();
                    if (operation == .selected) _ = try eb.undo();
                    try std.testing.expectEqualStrings("old\nabcdef", actual[0..eb.getText(&actual)]);
                    try std.testing.expectEqualDeep(before.cursor, eb.getPrimaryCursor());
                    succeeded = !fault.has_induced_failure;
                    if (succeeded) break;
                } else |err| {
                    try std.testing.expectEqual(error.OutOfMemory, err);
                    try std.testing.expect(fault.has_induced_failure);
                    try std.testing.expectEqual(@as(usize, 0), Events.count);
                    try std.testing.expectEqualDeep(before, EditState.capture(eb));
                    try std.testing.expectEqualDeep(selection, ev.getSelection());
                    try std.testing.expectEqualDeep(endpoints, ev.text_buffer_view.selection_endpoints);
                    _ = try eb.redo();
                    try std.testing.expectEqualStrings("old\nabcdefX", actual[0..eb.getText(&actual)]);
                }
            }
            try std.testing.expect(succeeded);
        }
    }
}

test "EditBuffer atomicity - invalid and empty edits preserve redo history" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const eb = try EditBuffer.init(std.testing.allocator, &pool, &links, .wcwidth, null);
    defer eb.deinit();
    try eb.insertText("old");
    try eb.insertText("X");
    _ = try eb.undo();
    const before = eb.tb.rope().*;
    const cursor = eb.getPrimaryCursor();
    const add = eb.add_buffer;
    try eb.deleteForward();
    try eb.insertText("");
    try eb.deleteRange(cursor, cursor);
    try std.testing.expectError(error.InvalidCursor, eb.deleteRange(cursor, .{ .row = 1, .col = 0 }));
    eb.cursors.items[0].row = 1;
    try std.testing.expectError(error.InvalidCursor, eb.insertText("!"));
    try std.testing.expectEqual(@as(u32, 1), eb.getPrimaryCursor().row);
    eb.cursors.items[0] = cursor;
    try std.testing.expectEqual(before.root, eb.tb.rope().root);
    try std.testing.expectEqual(before.version, eb.tb.rope().version);
    try std.testing.expectEqual(before.undo_history, eb.tb.rope().undo_history);
    try std.testing.expectEqual(before.redo_history, eb.tb.rope().redo_history);
    try std.testing.expectEqual(before.curr_history, eb.tb.rope().curr_history);
    try std.testing.expectEqual(before.undo_depth, eb.tb.rope().undo_depth);
    try std.testing.expectEqualDeep(add, eb.add_buffer);
    var actual: [32]u8 = undefined;
    try std.testing.expectEqualStrings("old", actual[0..eb.getText(&actual)]);
    _ = try eb.redo();
    try std.testing.expectEqualStrings("oldX", actual[0..eb.getText(&actual)]);
}

const ReplacementEvents = struct {
    var view: *EditorView = undefined;
    var count: usize = 0;
    const Snapshot = struct {
        event: u8,
        text: [128]u8 = @splat(0),
        cursor: edit_buffer.Cursor,
        selected: bool,
        undo_depth: usize,
    };
    var snapshots: [6]Snapshot = undefined;

    fn record(event: u8) void {
        if (count < snapshots.len) {
            const snapshot = &snapshots[count];
            snapshot.* = .{
                .event = event,
                .cursor = view.getPrimaryCursor(),
                .selected = view.getSelection() != null,
                .undo_depth = view.edit_buffer.tb.rope().undo_depth,
            };
            _ = view.edit_buffer.getText(&snapshot.text);
        }
        count += 1;
    }

    fn typed(_: *anyopaque) void {
        record('T');
    }

    fn native(name: [*]const u8, name_len: u32, _: [*]const u8, _: u32) callconv(.c) void {
        record(if (std.mem.eql(u8, name[0..name_len], "eb_cursor-changed")) 'C' else 'X');
    }
};

test "selected replacement - empty selection resolves cursor after tab width changes" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    var sink: event_bus.EventSink = .{ .callback = null };
    const eb = try EditBuffer.init(std.testing.allocator, &pool, &links, .unicode, &sink);
    defer eb.deinit();
    const ev = try EditorView.init(std.testing.allocator, eb, 20, 3);
    defer ev.deinit();
    try eb.setText("\t\nabc");
    eb.tb.setTabWidth(4);
    try eb.setCursor(1, 1);
    eb.tb.setTabWidth(8);
    ev.setSelection(0, 0, null, null);
    _ = try ev.replaceSelectedText("X");
    var text: [32]u8 = undefined;
    try std.testing.expectEqualStrings("\t\naXbc", text[0..eb.getText(&text)]);
    try std.testing.expectEqual(@as(u32, 1), eb.getPrimaryCursor().row);
    try std.testing.expectEqual(@as(u32, 2), eb.getPrimaryCursor().col);
    try std.testing.expectEqual(@as(u32, 11), eb.getPrimaryCursor().offset);

    try eb.setText("\tabc");
    try eb.setCursor(0, 11);
    eb.tb.setTabWidth(4);
    ev.setSelection(0, 0, null, null);
    _ = try ev.replaceSelectedText("");
    try std.testing.expect(ev.getSelection() == null);
    try std.testing.expectEqualStrings("\tabc", text[0..eb.getText(&text)]);
}

test "selected replacement - matches sequential text history cursor selection and event ordering" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const Case = struct {
        initial: []const u8,
        replacement: ?[]const u8 = null,
        ranges: []const [2]u32 = &.{ .{ 2, 7 }, .{ 0, 10 }, .{ 4, 4 }, .{ 10, 10 }, .{ 9, 3 } },
    };
    for ([_]Case{
        .{ .initial = "old\nabcdef" },
        .{ .initial = "\t\u{754c}abc\nx\u{1f600}y\n" },
        .{ .initial = "", .ranges = &.{.{ 0, 0 }} },
        .{ .initial = "aba\nbcd", .replacement = "\u{754c}a\nbcd", .ranges = &.{.{ 1, 4 }} },
        .{ .initial = "abcd", .replacement = "\u{754c}\u{754c}", .ranges = &.{.{ 1, 3 }} },
    }) |case| {
        for ([_]?usize{ null, 1, 3 }) |max_depth| {
            for ([_][]const u8{ "", "new", "\u{754c}\r\n\t!", "\n\n" }) |text| {
                for (case.ranges) |range| {
                    var expected_events: [6]ReplacementEvents.Snapshot = undefined;
                    var expected_count: usize = 0;
                    var expected_text: [128]u8 = @splat(0);
                    var expected_cursor: edit_buffer.Cursor = undefined;
                    var expected_depth: usize = 0;
                    inline for (.{ false, true }) |atomic| {
                        var sink: event_bus.EventSink = .{ .callback = null };
                        const eb = try EditBuffer.init(std.testing.allocator, &pool, &links, .unicode, &sink);
                        defer eb.deinit();
                        const ev = try EditorView.init(std.testing.allocator, eb, 10, 2);
                        defer ev.deinit();
                        try eb.setText(case.initial);
                        try eb.replaceText(case.initial);
                        try eb.replaceText(case.initial);
                        try eb.insertText("X");
                        try eb.insertText("Y");
                        _ = try eb.undo();
                        _ = try eb.undo();
                        eb.tb.rope().config.max_undo_depth = max_depth;
                        try eb.setCursor(1, 3);
                        ev.setSelection(range[0], range[1], null, null);
                        if (case.replacement) |replacement| try eb.setText(replacement);
                        try eb.events.on(.cursorChanged, .{ .ctx = eb, .handle = ReplacementEvents.typed });
                        ReplacementEvents.view = ev;
                        ReplacementEvents.count = 0;
                        sink.callback = ReplacementEvents.native;
                        if (atomic) {
                            _ = try ev.replaceSelectedText(text);
                            try std.testing.expectEqual(expected_count, ReplacementEvents.count);
                            try std.testing.expectEqualDeep(expected_events[0..expected_count], ReplacementEvents.snapshots[0..expected_count]);
                            var actual: [128]u8 = @splat(0);
                            _ = eb.getText(&actual);
                            try std.testing.expectEqualSlices(u8, &expected_text, &actual);
                            try std.testing.expectEqualDeep(expected_cursor, eb.getPrimaryCursor());
                            try std.testing.expectEqual(expected_depth, eb.tb.rope().undo_depth);
                        } else {
                            try ev.deleteSelectedText();
                            try eb.insertText(text);
                            expected_count = ReplacementEvents.count;
                            expected_events = ReplacementEvents.snapshots;
                            _ = eb.getText(&expected_text);
                            expected_cursor = eb.getPrimaryCursor();
                            expected_depth = eb.tb.rope().undo_depth;
                        }
                        try std.testing.expect(ev.getSelection() == null);
                        if (expected_count > 0 and eb.canUndo()) {
                            _ = try eb.undo();
                            _ = try eb.redo();
                            try std.testing.expectEqualDeep(expected_cursor, eb.getPrimaryCursor());
                        }
                    }
                }
            }
        }
    }
}

test "selected replacement - full add registry rejects without clearing selection" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const eb = try EditBuffer.init(std.testing.allocator, &pool, &links, .wcwidth, null);
    defer eb.deinit();
    const ev = try EditorView.init(std.testing.allocator, eb, 10, 2);
    defer ev.deinit();
    try eb.insertText("old");
    ev.setSelection(0, 3, null, null);
    while (eb.tb.mem_registry.buffers.items.len < 255) {
        _ = try eb.tb.registerMemBuffer("", false);
    }
    const text = try std.testing.allocator.alloc(u8, eb.add_buffer.cap);
    defer std.testing.allocator.free(text);
    @memset(text, 'x');
    const before = eb.tb.rope().*;
    const add = eb.add_buffer;
    const cursor = eb.getPrimaryCursor();
    const selection = ev.getSelection();
    try std.testing.expectError(error.OutOfMemory, ev.replaceSelectedText(text));
    try std.testing.expectEqual(before.root, eb.tb.rope().root);
    try std.testing.expectEqual(before.undo_history, eb.tb.rope().undo_history);
    try std.testing.expectEqualDeep(add, eb.add_buffer);
    try std.testing.expectEqualDeep(cursor, eb.getPrimaryCursor());
    try std.testing.expectEqualDeep(selection, ev.getSelection());
    var actual: [32]u8 = undefined;
    try std.testing.expectEqualStrings("old", actual[0..eb.getText(&actual)]);
}
