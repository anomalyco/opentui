const std = @import("std");
const edit_buffer = @import("../edit-buffer.zig");
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

    fn native(_: *anyopaque, event: edit_buffer.NativeEvent) void {
        if (count < order.len) {
            order[count] = if (event == .cursor_changed) 'C' else 'X';
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
                const eb = try EditBuffer.init(failing.allocator(), &pool, &links, .unicode, null);
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
                eb.notify = .{ .userdata = eb, .callback = Events.native };
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
